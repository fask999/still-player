'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createHandlers} = require('../src/main/main');
const renderer = path.join(__dirname, '../src/renderer');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {};
    this._text = ''; this.value = ''; this.disabled = false; this.hidden = false; this.className = ''; this.open = false;
    this.scrollTop = 0; this.clientHeight = 300; this.scrollCalls = [];
    this.style = {values: {}, setProperty: (key, value) => { this.style.values[key] = value; }};
    const tokens = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...names) => { const set = tokens(); names.forEach(name => set.add(name)); this.className = [...set].join(' '); },
      remove: (...names) => { const set = tokens(); names.forEach(name => set.delete(name)); this.className = [...set].join(' '); },
      toggle: (name, force) => { const set = tokens(), add = force === undefined ? !set.has(name) : force; if (add) set.add(name); else set.delete(name); this.className = [...set].join(' '); return add; },
      contains: name => tokens().has(name)
    };
  }
  get parentNode() { return this.parentElement || null; }
  get nextSibling() { if (!this.parentElement) return null; const index = this.parentElement.children.indexOf(this); return this.parentElement.children[index + 1] || null; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value ?? ''); }
  append(...nodes) { for (const node of nodes) { if (node.parentElement) node.parentElement.children = node.parentElement.children.filter(child => child !== node); this.children.push(node); node.parentElement = this; } }
  prepend(...nodes) { for (const node of [...nodes].reverse()) this.insertBefore(node, this.children[0] || null); }
  insertBefore(node, referenceNode) {
    if (referenceNode == null) { this.append(node); return node; }
    if (!this.children.includes(referenceNode)) throw new Error('Reference node is not a child');
    if (node === referenceNode) return node;
    if (node.parentElement) node.parentElement.children = node.parentElement.children.filter(child => child !== node);
    const index = this.children.indexOf(referenceNode); this.children.splice(index, 0, node); node.parentElement = this; return node;
  }
  replaceChildren(...nodes) { this._text = ''; for (const node of this.children) node.parentElement = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter(listener => listener !== fn); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  closest(selector = '') { const selectors = selector.split(',').map(value => value.trim()); for (let node = this; node; node = node.parentElement) if (selectors.some(value => value === node.tagName.toLowerCase() || value === '[contenteditable="true"]' && node.attributes.contenteditable === 'true')) return node; return null; }
  focus() { this.focused = true; if (this.ownerDocument) this.ownerDocument.activeElement = this; for (let node = this; node; node = node.parentElement) for (const listener of node.listeners.focusin || []) listener({target: this}); }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  getBoundingClientRect() { return {top: 0}; }
  scrollTo(value) { this.scrollCalls.push(value); this.scrollTop = value.top; }
  dispatch(name, extra = {}) {
    const event = {target: this, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra};
    for (const fn of this.listeners[name] || []) { fn(event); if (event.stopped) break; } return event;
  }
  click() { if (!this.disabled) this.dispatch('click'); }
}
const defaultSettings = {lyrics: {fontSize: 30, lineHeight: 1.75, translationSize: 18, showOriginal: true, showTranslation: true, onlineEnabled: true, cacheEnabled: true}, appearance: {reducedMotion: false}};
const offline = {available: false, state: 'unavailable', volume: null};
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return {promise, resolve, reject}; };
function walk(element) { return [element, ...element.children.flatMap(walk)]; }
function findText(element, value) { return walk(element).find(item => item.textContent === value); }
function findClass(element, name) { return walk(element).find(item => item.classList.contains(name)); }
function parseShell(html) {
  const root = new Element('document'), stack = [root], elements = {};
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const source = html.replace(/<!--[\s\S]*?-->/g, ''); let end = 0;
  for (const match of source.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    const text = source.slice(end, match.index).trim(); if (text && !text.startsWith('<!')) stack.at(-1)._text += text;
    end = match.index + match[0].length; const tag = match[1].toLowerCase();
    if (match[0].startsWith('</')) { while (stack.length > 1) { const closed = stack.pop(); if (closed.tagName.toLowerCase() === tag) break; } continue; }
    const element = new Element(tag);
    for (const attribute of match[0].matchAll(/\s([\w:-]+)(?:="([^"]*)")?/g)) {
      const name = attribute[1], value = attribute[2] ?? ''; element.setAttribute(name, value);
      if (name === 'id') { element.id = value; elements[value] = element; }
      if (name.startsWith('data-')) element.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      if (['type', 'value', 'min', 'max', 'step', 'name'].includes(name)) element[name] = value;
      if (['hidden', 'disabled', 'open'].includes(name)) element[name] = true;
    }
    stack.at(-1).append(element); if (!voidTags.has(tag) && !match[0].endsWith('/>')) stack.push(element);
  }
  return {root, elements};
}
async function setup(data, handler = async () => null, options = {}) {
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const {root: documentRoot, elements} = parseShell(html);
  const nav = ['library', 'albums', 'artists', 'playlists'].map(view => walk(documentRoot).find(el => el.dataset.view === view));
  const appleNav = ['library', 'albums', 'artists', 'playlists'].map(view => walk(documentRoot).find(el => el.dataset.appleView === view));
  const documentListeners = {}, windowListeners = {}, calls = [], events = {}, images = [];
  const document = {
    body: walk(documentRoot).find(element => element.tagName === 'BODY'),
    documentElement: walk(documentRoot).find(element => element.tagName === 'HTML'),
    getElementById: id => walk(documentRoot).find(element => element.id === id) || null,
    createElement: tag => { const element = new Element(tag); element.ownerDocument = document; if (tag === 'img') images.push(element); return element; },
    createElementNS: (_ns, tag) => { const element = new Element(tag); element.ownerDocument = document; return element; },
    querySelectorAll: selector => selector === '.nav-item[data-view]' ? nav : selector === '.nav-item[data-apple-view]' ? appleNav : selector === '[data-cover-failed]' ? walk(documentRoot).filter(element => element.dataset.coverFailed) : [],
    addEventListener(name, fn) { (documentListeners[name] ||= []).push(fn); }
  };
  for (const element of walk(documentRoot)) element.ownerDocument = document;
  let clock = 0, animationSequence = 0, timerSequence = 0; const animations = new Map(), timers = new Map(), intervals = new Map();
  const context = {
    document, console, Map, Set, Number, String, Math, Date, URL,
    innerWidth: options.width || 1280, innerHeight: options.height || 720,
    devicePixelRatio: options.devicePixelRatio || 1,
    addEventListener(name, fn) { (windowListeners[name] ||= []).push(fn); },
    setTimeout(callback, delay = 0) { const id = ++timerSequence; timers.set(id, {callback, at: clock + delay}); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay = 0) { const id = ++timerSequence, intervalDelay = Math.max(1, Number(delay) || 0); intervals.set(id, {callback, delay: intervalDelay, at: clock + intervalDelay}); return id; },
    clearInterval(id) { intervals.delete(id); },
    performance: {now: () => clock},
    matchMedia: () => options.motionMedia || ({matches: options.systemReducedMotion === true}),
    requestAnimationFrame(callback) { const id = ++animationSequence; animations.set(id, callback); return id; },
    cancelAnimationFrame(id) { animations.delete(id); },
    still: {
      invoke: async (channel, payload) => {
        calls.push({channel, payload});
        return channel === 'app:bootstrap' ? data : handler(channel, payload);
      },
      on: (channel, callback) => { events[channel] = callback; return () => {}; }
    }
  };
  context.window = context; context.globalThis = context;
  vm.createContext(context);
  const declaredModules = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map(match => match[1]).filter(file => file !== 'bootstrap.js');
  const moduleOrder = options.moduleOrder || declaredModules;
  assert.deepEqual([...moduleOrder].sort(), [...declaredModules].sort(), 'test must load the actual HTML module set');
  for (const file of [...moduleOrder, 'bootstrap.js']) vm.runInContext(fs.readFileSync(path.join(renderer, file), 'utf8'), context, {filename: file});
  for (const fn of documentListeners.DOMContentLoaded || []) fn();
  await flush(); await flush();
  // Transport and lyric tests deliberately use the song view; the startup shelf is tested separately.
  if (!options.keepStartupView) context.StillApp.setView('library');
  return {elements, nav, appleNav, calls, events, context, images, blur() { for (const fn of windowListeners.blur || []) fn(); },
    dispatchDocument(name, extra = {}) { for (const fn of documentListeners[name] || []) fn({target: document.body, preventDefault() {}, ...extra}); },
    runTimers() {
      let count = 0;
      const runReadyTimeouts = () => { for (;;) { const ready = [...timers].filter(([, timer]) => timer.at <= clock).sort((a, b) => a[1].at - b[1].at)[0]; if (!ready) break; if (++count > 1000) throw new Error('Timer loop'); timers.delete(ready[0]); ready[1].callback(); } };
      runReadyTimeouts();
      const readyIntervals = [...intervals].filter(([, interval]) => interval.at <= clock).sort((a, b) => a[1].at - b[1].at);
      for (const [id, interval] of readyIntervals) {
        if (intervals.get(id) !== interval) continue;
        interval.at = clock + interval.delay; if (++count > 1000) throw new Error('Timer loop'); interval.callback(); runReadyTimeouts();
      }
      return count;
    },
    resize(width, height) { context.innerWidth = width; context.innerHeight = height; for (const fn of windowListeners.resize || []) fn(); },
    hasAnimationFrame() { return animations.size > 0; },
    dispatchKey(extra = {}) {for (const fn of documentListeners.keydown || []) fn({target: document.body, preventDefault() {}, ...extra});},
    advance(ms) { clock += ms; const callbacks = [...animations.values()]; animations.clear(); for (const callback of callbacks) callback(clock); }};
}
function player(track, overrides = {}) {
  return {available: true, state: 'playing', position: 1.2, duration: 20, volume: 0.5, currentTrackId: track.id, currentTrack: track, ...overrides};
}

test('renderer resources exist, use the isolated bridge and contain no renderer audio engine or mixed glyph icons', () => {
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)) assert.ok(fs.existsSync(path.join(renderer, match[1])), match[1]);
  const sources = ['index.html', 'glass.js', 'app.js', 'features.js', 'desktop-controls.js', 'dac-authorization.js', 'bootstrap.js'].map(file => fs.readFileSync(path.join(renderer, file), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /<audio\b|new\s+Audio\b|AudioContext|HTMLAudio|[♪♙☷◫▦▶Ⅱ◀↻×≡⚙⌕＋←↓›]/);
  assert.match(html, /script-src 'self'/);
});

test('empty library and disconnected player render without invented content', async () => {
  const {elements, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, settings: defaultSettings});
  assert.equal(elements.connectionText.textContent, '本地播放内核不可用');
  assert.equal(elements.toggle.disabled, true);
  assert.equal(elements.itemCount.textContent, '0 首');
  assert.ok(findText(elements.viewContent, '音乐库还是空的'));
  assert.deepEqual(calls.map(call => call.channel), ['backend:setupStatus', 'app:bootstrap']);
  assert.equal(calls[0].payload, undefined);
});

test('source browsing leaves real playback unchanged and Apple shows only reported capabilities', async () => {
  const track = {id: 'a', title: 'Local track'};
  const sources = {
    local: {available: true, status: 'ready', capabilities: {library: true, playback: true}},
    apple: {available: false, status: 'unconfigured', message: '需要开发者令牌；受保护播放尚未验证。', capabilities: {authorize: false, library: false, playback: false}}
  };
  const {elements, appleNav, calls, events, context} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local'}), selectedSource: 'local', sources, settings: defaultSettings},
    async (channel, payload) => channel === 'source:select' ? {selectedSource: payload.source, sources} : null);
  elements.content.scrollTop = 270;
  elements.sourceApple.click(); await flush();
  assert.equal(context.StillApp.state.browseSource, 'apple');
  assert.equal(elements.appleContent.hidden, false); assert.equal(elements.content.hidden, true);
  assert.equal(elements.nowSource.textContent, '本地音乐'); assert.equal(elements.nowTitle.textContent, 'Local track');
  assert.equal(elements.appleStateTitle.textContent, 'Apple Music 尚未配置');
  assert.equal(elements.appleStateMessage.textContent, sources.apple.message);
  assert.equal(elements.appleConfigure.hidden, true); assert.equal(elements.appleDeveloperNote.hidden, true);
  assert.match(elements.appleCapabilities.textContent, /登录授权 · 未就绪/);
  assert.match(elements.appleCapabilities.textContent, /订阅曲库 · 未就绪/);
  appleNav[1].click(); assert.equal(elements.applePageTitle.textContent, '专辑');
  assert.deepEqual(calls.map(call => call.channel), ['backend:setupStatus', 'app:bootstrap', 'source:select']);
  elements.sourceLocal.click(); await flush();
  assert.equal(elements.content.scrollTop, 270); assert.equal(elements.nowSource.textContent, '本地音乐');
  events.player(player(track, {source: null, lastSource: 'local', state: 'stopped'}));
  assert.equal(elements.nowSource.textContent, '尚无播放来源');
  assert.equal(calls.some(call => /^(?:player:|queue:|audio:)/.test(call.channel)), false);
});

test('renderer source switching matches the real main handlers without issuing engine commands', async () => {
  const track = {id: 'a', path: 'C:\\Music\\a.wav', subsong: 0, title: 'Local track'}, library = {tracks: [track], playlists: []};
  const engineWrites = [], current = player(track, {source: 'local', generation: 2, revision: 3});
  const coordinator = {
    getState: async () => current, getEngineState: async () => ({available: true}),
    currentGeneration: () => 2, currentRevision: () => 3,
    command: async (...args) => { engineWrites.push(args); }, play: async (...args) => { engineWrites.push(args); }
  };
  let dispatch = () => {};
  const handlers = createHandlers({
    library: {list: async () => library}, foobar: {}, lyrics: {}, settings: {get: () => defaultSettings},
    dialog: {}, shell: {}, dataDir: 'C:\\Still-data', emit: (channel, value) => dispatch(channel, value),
    window: () => null, version: 'test', getRestoreInfo: () => ({}), coordinator
  });
  const boot = await handlers['app:bootstrap']({});
  const {elements, events} = await setup(boot, async (channel, payload) => handlers[channel](payload));
  dispatch = (channel, value) => events[channel]?.(value);
  elements.sourceApple.click(); await flush();
  assert.equal(elements.appleContent.hidden, false);
  assert.equal(elements.nowSource.textContent, '本地音乐');
  assert.equal(elements.nowTitle.textContent, 'Local track');
  assert.deepEqual(engineWrites, []);
});

test('a local backend becoming ready enables real library playback after startup', async () => {
  const track = {id: 'a', title: 'A'};
  const {elements, events} = await setup({library: {tracks: [track], playlists: []}, player: offline, sources: {local: {available: false, backendStatus: 'starting'}}, settings: defaultSettings});
  assert.equal(elements.connectionText.textContent, '正在启动本地播放内核');
  assert.equal(walk(elements.viewContent).find(item => item.tagName === 'BUTTON' && item.textContent === 'A').disabled, true);
  events.source({selectedSource: 'local', sources: {local: {available: true, backendStatus: 'ready'}}});
  assert.equal(elements.connectionText.textContent, '本地播放内核已连接');
  assert.equal(walk(elements.viewContent).find(item => item.tagName === 'BUTTON' && item.textContent === 'A').disabled, false);
});

test('retry is offered only when the local backend explicitly supports it', async () => {
  const local = {available: false, backendStatus: 'offline', capabilities: {retryBackend: true}};
  const {elements, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, sources: {local}, settings: defaultSettings}, async channel => channel === 'backend:retry'
    ? {selectedSource: 'local', sources: {local: {available: true, backendStatus: 'ready', capabilities: {retryBackend: true}}}} : null);
  assert.equal(elements.retryLocal.hidden, false);
  elements.retryLocal.click(); await flush();
  assert.equal(calls.filter(item => item.channel === 'backend:retry').length, 1);
  assert.equal(elements.connectionText.textContent, '本地播放内核已连接');
  assert.equal(elements.retryLocal.hidden, true);
});

test('an online backend with a disconnected DAC reports the device loss and keeps library playback disabled', async () => {
  const track = {id: 'a', title: 'A'}, outputConnection = {status: 'disconnected', endpointId: 'exact-dac', retryRequired: true};
  const local = {available: true, backendReachable: true, backendStatus: 'ready', status: 'device-disconnected', outputConnection,
    message: '原设备已断开；未切换输出。', capabilities: {playback: false, retryBackend: true}};
  const {elements, calls} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local', state: 'paused'}),
    sources: {local}, settings: defaultSettings});
  assert.equal(elements.connectionText.textContent, '音频设备已断开');
  assert.equal(elements.connection.title, local.message);
  assert.equal(elements.connection.classList.contains('online'), false);
  assert.equal(elements.retryLocal.hidden, false); assert.equal(elements.retryLocal.disabled, false);
  assert.equal(elements.toggle.disabled, true);
  const row = walk(elements.viewContent).find(item => item.tagName === 'BUTTON' && item.textContent === 'A');
  assert.equal(row.disabled, true); row.click();
  assert.equal(calls.some(call => /^(?:player:|audio:select)/.test(call.channel)), false);
});

test('reconnected DAC feedback requires an explicit retry and never changes output or resumes playback by itself', async () => {
  const track = {id: 'a', title: 'A'}, local = {available: true, backendReachable: true, backendStatus: 'ready',
    outputConnection: {status: 'disconnected', endpointId: 'exact-dac', retryRequired: true}, capabilities: {playback: false, retryBackend: true}};
  const ready = {...local, status: 'ready', outputConnection: {status: 'connected', endpointId: 'exact-dac', retryRequired: false},
    capabilities: {playback: true, retryBackend: true}};
  const f = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local', state: 'paused'}),
    sources: {local}, settings: defaultSettings}, async channel => channel === 'backend:retry' ? {sources: {local: ready}} : null);
  f.events.source({sources: {local: {...ready, status: 'device-reconnected',
    outputConnection: {...ready.outputConnection, retryRequired: true}}}});
  assert.equal(f.elements.connectionText.textContent, '音频设备已重连，待确认');
  assert.equal(f.elements.connection.classList.contains('online'), false);
  assert.equal(f.elements.retryLocal.hidden, false);
  assert.equal(f.elements.retryLocal.tagName, 'BUTTON');
  assert.equal(f.elements.retryLocal.attributes['aria-label'], '重新检查原音频设备');
  assert.notEqual(f.elements.retryLocal.attributes.tabindex, '-1');
  assert.equal(f.calls.some(call => /^(?:player:|audio:select|backend:retry)/.test(call.channel)), false);
  // Focused native buttons keep their Enter/Space activation. The document's
  // playback shortcut must leave that keyboard activation to the browser.
  f.elements.retryLocal.closest = () => f.elements.retryLocal;
  f.dispatchKey({target: f.elements.retryLocal, code: 'Space'});
  assert.equal(f.calls.some(call => call.channel === 'player:toggle'), false);
  f.elements.retryLocal.click(); await flush();
  assert.equal(f.calls.filter(call => call.channel === 'backend:retry').length, 1);
  assert.equal(f.calls.some(call => /^(?:player:|audio:select)/.test(call.channel)), false);
  assert.equal(f.elements.connectionText.textContent, '本地播放内核已连接');
  assert.equal(f.elements.nowTitle.textContent, 'A');
});

test('unknown DAC connectivity is not displayed as connected and details distinguish the reachable backend', async () => {
  const outputConnection = {status: 'unknown', endpointId: 'exact-dac', retryRequired: true, message: '设备连接尚未确认。'};
  const local = {available: true, backendReachable: true, backendStatus: 'ready', outputConnection,
    capabilities: {playback: false, retryBackend: true}};
  const {elements} = await setup({library: {tracks: [], playlists: []}, player: offline, sources: {local}, settings: defaultSettings}, async channel => {
    if (channel === 'audio:details') return {available: true, backendReachable: true, outputConnection};
    return null;
  });
  assert.equal(elements.connectionText.textContent, '音频设备状态未知');
  assert.equal(elements.connection.classList.contains('online'), false);
  elements.audioButton.click(); await flush(); await flush();
  assert.ok(findText(elements.dialogBody, '本地内核连接'));
  assert.ok(findText(elements.dialogBody, '已连接'));
  assert.ok(findText(elements.dialogBody, '原音频设备连接'));
  assert.ok(findText(elements.dialogBody, '未知'));
});

test('diagnostic export stays in the existing settings flow and runs only after the explicit save click', async () => {
  const f = await setup({library: {tracks: [], playlists: []}, player: offline, settings: defaultSettings,
    capabilities: {exportDiagnostics: true}}, async channel => channel === 'app:exportDiagnostics' ? {saved: true} : null);
  assert.equal(f.calls.some(call => call.channel === 'app:exportDiagnostics'), false);
  f.elements.audioButton.click(); await flush(); await flush();
  const save = walk(f.elements.dialogBody).find(item => item.tagName === 'BUTTON' && item.textContent === '保存诊断状态');
  assert.ok(save);
  assert.equal(f.calls.some(call => call.channel === 'app:exportDiagnostics'), false);
  save.click(); await flush();
  assert.equal(f.calls.filter(call => call.channel === 'app:exportDiagnostics').length, 1);
  const payload = f.calls.find(call => call.channel === 'app:exportDiagnostics').payload;
  assert.deepEqual(Object.keys(payload), ['layout']);
  assert.deepEqual(Object.keys(payload.layout).sort(), ['accentColor', 'appReducedMotion', 'devicePixelRatio', 'effectiveReducedMotion', 'height', 'horizontalOverflow', 'systemReducedMotion', 'width']);
  assert.equal(payload.layout.width, 1280); assert.equal(payload.layout.height, 720);
  assert.equal(payload.layout.devicePixelRatio, 1); assert.equal(payload.layout.accentColor, '#A8B9FF');
  assert.equal(payload.layout.horizontalOverflow, false);
  assert.equal(payload.layout.appReducedMotion, false); assert.equal(payload.layout.systemReducedMotion, false); assert.equal(payload.layout.effectiveReducedMotion, false);
  assert.equal(f.calls.some(call => /^(?:player:|audio:select|apple:authorize)/.test(call.channel)), false);
});

test('read-only or unsupported settings do not advertise diagnostic export', async () => {
  const f = await setup({library: {tracks: [], playlists: []}, player: offline, settings: defaultSettings,
    capabilities: {exportDiagnostics: false}});
  f.elements.audioButton.click(); await flush(); await flush();
  assert.equal(walk(f.elements.dialogBody).some(item => item.tagName === 'BUTTON' && item.textContent === '保存诊断状态'), false);
  assert.equal(f.calls.some(call => call.channel === 'app:exportDiagnostics'), false);
});

test('DAC settings require an explicit scope and send the exact main prepare payload and opaque confirmation token', async t => {
  const tokens = {'hardware-instance': 'A'.repeat(43), 'windows-endpoint': 'B'.repeat(43)};
  const boot = {library: {tracks: [], playlists: []}, player: offline, settings: defaultSettings, capabilities: {persistUIState: true, dacAuthorization: true}};
  const validationFormat = {sampleRate: 48000, bits: 24, channels: 2};
  const grants = [{authorizationId: '33333333-3333-4333-8333-333333333333', scope: 'unrecognized', capabilities: ['exclusive-check'], validationFormat, expiresAt: Date.now() + 60000}];
  let prepared;
  const handlers = createHandlers({foobar: {}, dacAuthorization: {
    list: () => grants,
    prepare(input) {prepared = input; return {token: tokens[input.scope], preview: input};},
    confirm({token}) {
      assert.equal(token, tokens[prepared.scope]);
      const id = prepared.scope === 'hardware-instance' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
      const grant = {...prepared, authorizationId: id, expiresAt: Date.now() + 60000}; grants.push(grant); prepared = null; return grant;
    }
  }});
  t.after(() => handlers.closePlaybackContext());
  const caller = {sender: {}, windowGeneration: 1};
  const f = await setup(boot, async (channel, payload) => channel.startsWith('dac:') ? handlers[channel](payload, caller) : null);
  f.elements.audioButton.click(); await flush();
  const section = findClass(f.elements.dialogBody, 'dac-authorization'); assert.ok(section);
  const fields = walk(section).find(node => node.tagName === 'FIELDSET'), checkbox = walk(fields).find(node => node.type === 'checkbox');
  const selects = walk(fields).filter(node => node.tagName === 'SELECT');
  const scope = selects.find(node => node.attributes['data-dac-scope'] === 'true'), format = selects.find(node => node !== scope);
  const review = findText(section, '审阅并确认授权');
  assert.deepEqual(walk(scope).filter(node => node.tagName === 'OPTION').map(node => node.value), ['', 'hardware-instance', 'windows-endpoint']);
  checkbox.checked = true; format.value = '24'; fields.dispatch('change');
  assert.equal(scope.value, ''); assert.equal(review.disabled, true); review.click(); await flush();
  assert.equal(f.calls.some(call => call.channel === 'dac:prepare'), false);
  for (const value of Object.keys(tokens)) {
    scope.value = value; fields.dispatch('change'); assert.equal(review.disabled, false);
    assert.match(section.textContent, value === 'hardware-instance' ? /唯一 USB 实例身份/ : /仅授权本机当前端点.*重新枚举/);
    review.click(); await flush(); await flush(); assert.ok(findText(section, '已保存授权。'));
  }
  const submitted = f.calls.filter(call => ['dac:prepare', 'dac:confirm'].includes(call.channel)).map(call => JSON.parse(JSON.stringify(call.payload)));
  assert.deepEqual(submitted, Object.entries(tokens).flatMap(([scope, token]) => [{scope, capabilities: ['exclusive-check'], validationFormat}, {token}]));
  assert.match(section.textContent, /USB 硬件实例 · 11111111/);
  assert.match(section.textContent, /此 Windows 端点 · 22222222/);
  assert.doesNotMatch(section.textContent, /33333333/);
  const disabled = await setup({...boot, capabilities: {persistUIState: false, dacAuthorization: true}});
  disabled.elements.audioButton.click(); await flush();
  assert.equal(findClass(disabled.elements.dialogBody, 'dac-authorization'), undefined);
  assert.equal(disabled.calls.some(call => call.channel.startsWith('dac:')), false);
});

test('rapid source selections ignore older readbacks without changing the playback source', async () => {
  const track = {id: 'a', title: 'Local track'}, apple = deferred(), local = deferred();
  const sources = {local: {available: true}, apple: {status: 'unconfigured', capabilities: {authorize: false, library: false, playback: false}}};
  const {elements, context} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local'}), sources, settings: defaultSettings},
    async (channel, payload) => channel === 'source:select' ? (payload.source === 'apple' ? apple.promise : local.promise) : null);
  elements.sourceApple.click(); elements.sourceLocal.click();
  local.resolve({selectedSource: 'local', sources}); await flush();
  apple.resolve({selectedSource: 'apple', sources}); await flush();
  assert.equal(context.StillApp.state.browseSource, 'local');
  assert.equal(elements.nowSource.textContent, '本地音乐');
  assert.equal(elements.content.hidden, false);
});

test('legacy Apple credential capabilities cannot expose setup or invoke credential IPC', async () => {
  const capabilities = {configureKey: true, importToken: true, authorize: false, library: false, playback: false};
  const sources = {local: {available: true}, apple: {status: 'unconfigured', message: '尚未配置', capabilities}};
  const {elements, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, sources, settings: defaultSettings}, async (channel, payload) => {
    if (channel === 'source:select') return {selectedSource: payload.source, sources};
    return null;
  });
  elements.sourceApple.click(); await flush();
  assert.equal(elements.appleConfigure.hidden, true); assert.equal(elements.appleConfigure.disabled, true);
  assert.equal(elements.appleAuthorize.disabled, true);
  elements.appleConfigure.click(); await flush();
  assert.equal(elements.dialog.open, false);
  assert.equal(calls.some(item => /apple:(?:configure|import-token)/.test(item.channel)), false);
});

test('legacy Apple token import capability has no reachable dialog or IPC', async () => {
  const capabilities = {configureKey: false, importToken: true, authorize: false, library: false, playback: false};
  const sources = {local: {available: true}, apple: {status: 'unconfigured', capabilities}};
  const {elements, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, sources, settings: defaultSettings}, async (channel, payload) => {
    if (channel === 'source:select') return {selectedSource: payload.source, sources};
    return null;
  });
  elements.sourceApple.click(); await flush(); elements.appleConfigure.click();
  await flush();
  assert.equal(elements.appleConfigure.hidden, true); assert.equal(elements.appleConfigure.disabled, true);
  assert.equal(walk(elements.dialogBody).some(item => /token|\.p8|Team ID|Key ID/.test(item.textContent)), false);
  assert.equal(calls.some(item => /apple:(?:configure|import-token)/.test(item.channel)), false);
  assert.equal(elements.dialog.open, false);
});

test('dialog validation errors remain visible above the modal content', async () => {
  const {elements, calls, context} = await setup({library: {tracks: [], playlists: []}, player: offline, settings: defaultSettings});
  context.StillApp.setView('playlists'); elements.createPlaylist.click();
  findText(elements.dialogBody, '新建').click(); await flush();
  assert.equal(elements.dialogAlert.hidden, false);
  assert.match(elements.dialogAlert.textContent, /请输入列表名称/);
  assert.equal(elements.dialog.open, true);
  assert.equal(calls.some(item => item.channel === 'playlist:create'), false);
});

test('Apple authorization is offered only when the host reports it and uses the explicit IPC', async () => {
  const apple = {status: 'authorization-required', capabilities: {configure: true, configureKey: true, importToken: true, authorize: true, library: false, playback: false}};
  const sources = {local: {available: true}, apple};
  const {elements, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, selectedSource: 'apple', sources, settings: defaultSettings}, async channel => channel === 'apple:authorize'
    ? {status: {id: 'apple', status: 'configured', message: '连接仍待验证。', capabilities: {...apple.capabilities, authorize: false}}} : null);
  assert.equal(elements.appleConfigure.hidden, true); assert.equal(elements.appleConfigure.disabled, true);
  assert.equal(elements.appleAuthorize.disabled, false); assert.equal(elements.appleAuthorize.hidden, false);
  elements.appleAuthorize.click(); await flush();
  assert.equal(calls.filter(item => item.channel === 'apple:authorize').length, 1);
  assert.equal(elements.appleStateTitle.textContent, '凭据已配置，连接尚未验证');
  assert.equal(elements.appleAuthorize.disabled, true);
  assert.match(elements.appleCapabilities.textContent, /播放 · 未就绪/);
  assert.equal(calls.some(item => /apple:(?:configure|import-token)/.test(item.channel)), false);
});

test('Cider pairing is identified as pairing and does not claim subscription playback', async () => {
  const apple = {id: 'apple', provider: 'cider', status: 'not-paired', message: '请在 Cider 中批准配对。', capabilities: {authorize: true, library: false, playback: false}};
  const sources = {local: {available: true}, apple};
  const {elements, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, selectedSource: 'apple', sources, settings: defaultSettings}, async channel => channel === 'apple:authorize'
    ? {status: {...apple, status: 'paired-unverified', capabilities: {...apple.capabilities, authorize: false}}} : null);
  assert.equal(elements.appleAuthorize.textContent, '连接 Cider');
  assert.equal(elements.ciderPrerequisite.hidden, false);
  assert.match(fs.readFileSync(path.join(renderer, 'index.html'), 'utf8'), /安装并打开正版 Cider/);
  assert.match(elements.appleCapabilities.textContent, /配对授权/);
  assert.equal(elements.appleConfigure.hidden, true);
  elements.appleAuthorize.click(); await flush();
  assert.equal(calls.filter(item => item.channel === 'apple:authorize').length, 1);
  assert.equal(elements.appleStateTitle.textContent, '已配对，服务能力尚未验证');
  assert.match(elements.appleCapabilities.textContent, /播放 · 未就绪/);
});

test('official Apple session does not advertise Cider or developer credentials', async () => {
  const sources = {local: {available: true}, apple: {provider: 'officialWeb', status: 'not-connected', message: '官方会话尚未连接。', capabilities: {authorize: true, library: false, playback: false}}};
  const {elements, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, selectedSource: 'apple', sources, settings: defaultSettings});
  assert.equal(elements.ciderPrerequisite.hidden, true);
  assert.equal(elements.appleConfigure.hidden, true);
  assert.equal(elements.appleDeveloperNote.hidden, true);
  assert.equal(elements.appleAuthorize.textContent, '登录 Apple Music');
  assert.equal(calls.some(item => item.channel.startsWith('apple:')), false);
});

test('Apple collection renders only returned items, pages them, and plays only on an explicit selection', async () => {
  const local = {id: 'local', title: 'Local'};
  const apple = {id: 'apple', provider: 'cider', status: 'ready', capabilities: {library: true, search: true, playback: true, playableTypes: ['songs', 'albums']}};
  const sources = {local: {available: true}, apple};
  const {elements, appleNav, calls} = await setup({library: {tracks: [local], playlists: []}, player: player(local, {source: 'local'}), selectedSource: 'apple', sources, settings: defaultSettings}, async (channel, payload) => {
    if (channel === 'apple:library' && payload.kind === 'songs') return payload.offset === 0
      ? {kind: 'songs', items: [{id: 'a.1', type: 'songs', title: 'Real song', artist: 'Singer'}], nextOffset: 1, hasMore: true, total: 2}
      : {kind: 'songs', items: [{id: 'a.2', type: 'songs', title: 'Second song', artist: 'Singer'}], hasMore: false, total: 2};
    if (channel === 'apple:library' && payload.kind === 'albums') return {kind: 'albums', items: [{id: 'album.1', type: 'albums', title: 'Real album', artist: 'Singer'}]};
    if (channel === 'player:play') return {available: true, state: 'playing', source: 'apple', currentTrack: {title: 'Real album'}, position: 0, duration: 0, volume: null};
    return null;
  });
  assert.ok(findText(elements.appleViewContent, 'Real song'));
  assert.equal(elements.nowSource.textContent, '本地音乐');
  assert.equal(calls.some(item => item.channel === 'player:play'), false);
  elements.appleShowStatus.click(); assert.equal(elements.appleStateCard.hidden, false);
  elements.appleBackCollection.click(); assert.equal(elements.appleCollection.hidden, false);
  walk(elements.appleViewContent).find(item => item.tagName === 'BUTTON' && item.textContent === '显示更多').click(); await flush();
  assert.ok(findText(elements.appleViewContent, 'Second song'));
  appleNav[1].click(); await flush();
  assert.ok(findText(elements.appleViewContent, 'Real album'));
  walk(elements.appleViewContent).find(item => item.tagName === 'BUTTON' && item.textContent === '播放专辑').click(); await flush();
  const command = calls.find(item => item.channel === 'player:play');
  assert.equal(command.payload.source, 'apple'); assert.equal(command.payload.id, 'album.1'); assert.equal(command.payload.kind, 'albums');
  assert.equal(Object.hasOwn(command.payload, 'url'), false);
  assert.equal(elements.nowSource.textContent, 'Apple Music');
});

test('Apple search results from an older query cannot replace the newest real response', async () => {
  const first = deferred(), second = deferred();
  const sources = {local: {available: true}, apple: {provider: 'cider', status: 'ready', capabilities: {library: true, search: true, playback: false}}};
  const {elements, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, selectedSource: 'apple', sources, settings: defaultSettings}, async (channel, payload) => {
    if (channel === 'apple:library') return {kind: 'songs', items: []};
    if (channel === 'apple:search') return payload.term === 'old' ? first.promise : second.promise;
    return null;
  });
  elements.appleSearch.value = 'old'; elements.appleSearchSubmit.click();
  elements.appleSearch.value = 'new'; elements.appleSearchSubmit.click();
  second.resolve({items: [{id: 'new.1', type: 'songs', title: 'New result'}]}); await flush();
  first.resolve({items: [{id: 'old.1', type: 'songs', title: 'Old result'}]}); await flush();
  assert.ok(findText(elements.appleViewContent, 'New result'));
  assert.equal(findText(elements.appleViewContent, 'Old result'), undefined);
  assert.equal(calls.filter(item => item.channel === 'apple:search').length, 2);
});

test('Apple entries with unsafe identifiers are not offered for playback', async () => {
  const sources = {local: {available: true}, apple: {status: 'ready', capabilities: {library: true, playback: true, playableTypes: ['songs']}}};
  const {elements, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, selectedSource: 'apple', sources, settings: defaultSettings}, async channel => channel === 'apple:library'
    ? {items: [{id: 'https://example.invalid/song', type: 'songs', title: 'Unsafe'}, {id: 'safe.1', type: 'songs', title: 'Safe'}]} : null);
  assert.equal(findText(elements.appleViewContent, 'Unsafe'), undefined);
  assert.ok(findText(elements.appleViewContent, 'Safe'));
  assert.match(elements.appleViewContent.textContent, /1 项标识或类型无效/);
  assert.equal(calls.some(call => call.channel === 'player:play'), false);
});

test('Apple library album and playlist details request their real IDs and preserve the parent view', async () => {
  const sources = {local: {available: true}, apple: {provider: 'cider', status: 'ready', capabilities: {library: true, search: false, playback: true, detailKinds: ['album-songs', 'playlist-songs'], playableTypes: ['library-songs', 'library-albums', 'library-playlists']}}};
  const {elements, appleNav, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, selectedSource: 'apple', sources, settings: defaultSettings}, async (channel, payload) => {
    if (channel !== 'apple:library') return null;
    if (payload.kind === 'albums') return {items: [{id: 'album.1', type: 'library-albums', title: 'Saved album'}]};
    if (payload.kind === 'album-songs') return {items: [{id: 'song.1', type: 'library-songs', title: 'Saved song', playable: true}]};
    if (payload.kind === 'playlists') return {items: [{id: 'p.1', type: 'library-playlists', title: 'Saved playlist'}]};
    if (payload.kind === 'playlist-songs') return {items: [{id: 'song.2', type: 'library-songs', title: 'Playlist song', playable: true}]};
    return {items: []};
  });
  appleNav[1].click(); await flush();
  elements.appleContent.scrollTop = 200;
  findClass(elements.appleViewContent, 'album-open').click(); await flush();
  assert.ok(findText(elements.appleViewContent, 'Saved song'));
  assert.equal(calls.find(item => item.channel === 'apple:library' && item.payload.kind === 'album-songs').payload.id, 'album.1');
  walk(elements.appleViewContent).find(item => item.tagName === 'BUTTON' && item.textContent === '返回').click();
  assert.ok(findText(elements.appleViewContent, 'Saved album'));
  assert.equal(elements.appleContent.scrollTop, 200);
  appleNav[3].click(); await flush();
  walk(elements.appleViewContent).find(item => item.tagName === 'BUTTON' && item.textContent === '查看曲目').click(); await flush();
  assert.ok(findText(elements.appleViewContent, 'Playlist song'));
  assert.equal(calls.find(item => item.channel === 'apple:library' && item.payload.kind === 'playlist-songs').payload.id, 'p.1');
});

test('official album selections retain the real page occurrence through recovery and reject stale rows', async () => {
  const apple = {provider: 'officialWeb', available: true, status: 'ready', capabilities: {library: true, playback: true, albumPlayback: true, detailKinds: ['album-songs'], playableTypes: ['songs']}};
  const f = await setup({library: {tracks: [], playlists: []}, player: offline, selectedSource: 'apple', sources: {local: {}, apple}, settings: defaultSettings}, async (channel, payload) => {
    if (channel !== 'apple:library') return null;
    if (payload.kind === 'albums') return {items: [{id: 'album.1', type: 'library-albums', title: 'Album'}]};
    if (payload.kind === 'album-songs') return payload.offset === 0
      ? {items: [{id: 'repeat', type: 'songs', title: 'First', playable: true}], nextOffset: 20, albumPlayback: true}
      : {items: [{id: 'repeat', type: 'songs', title: 'Repeat', playable: true}, {id: 'explicit', type: 'songs', index: 23, title: 'Explicit', playable: true}], albumPlayback: true};
    return {items: []};
  });
  f.appleNav[1].click(); await flush(); findClass(f.elements.appleViewContent, 'album-open').click(); await flush();
  const stale = findClass(f.elements.appleViewContent, 'track-play');
  findClass(f.elements.appleViewContent, 'apple-load-more').click(); await flush(); stale.click();
  assert.equal(f.calls.some(call => call.channel === 'player:play'), false);
  findText(f.elements.appleViewContent, 'Repeat').click(); await flush();
  findText(f.elements.appleViewContent, 'Explicit').click(); await flush();
  let plays = f.calls.filter(call => call.channel === 'player:play').map(call => JSON.parse(JSON.stringify(call.payload)));
  assert.deepEqual(plays, [{source: 'apple', id: 'repeat', kind: 'songs', album: {id: 'album.1', index: 20}}, {source: 'apple', id: 'explicit', kind: 'songs', album: {id: 'album.1', index: 23}}]);
  f.events.source({sources: {apple: {...apple, available: false, capabilities: {...apple.capabilities, library: false, playback: false, canSubmitPlayIntent: true, playIntentTypes: ['songs']}}}}); await flush();
  const recovery = findText(f.elements.appleViewContent, 'Repeat'); assert.equal(recovery.disabled, false); recovery.click(); await flush();
  plays = f.calls.filter(call => call.channel === 'player:play').map(call => JSON.parse(JSON.stringify(call.payload)));
  assert.deepEqual(plays.at(-1), {source: 'apple', id: 'repeat', kind: 'songs', album: {id: 'album.1', index: 20}});
  assert.equal(findClass(f.elements.appleViewContent, 'track-header'), undefined);
  assert.equal(findClass(f.elements.appleViewContent, 'track-number'), undefined);
});

test('official album capability or explicit unmapped response disables album selections while other providers keep their path', async () => {
  for (const sample of [{capability: false}, {capability: true, mapped: false, mixed: true}, {capability: true}, {mapped: false}, {}, {legacy: true}]) {
    const capabilities = {library: true, playback: true, detailKinds: ['album-songs'], playableTypes: ['songs']};
    if (sample.capability !== undefined) capabilities.albumPlayback = sample.capability;
    const apple = {provider: sample.legacy ? 'cider' : 'officialWeb', available: true, capabilities};
    const f = await setup({library: {tracks: [], playlists: []}, player: offline, selectedSource: 'apple', sources: {local: {}, apple}, settings: defaultSettings}, async (channel, payload) => {
      if (channel !== 'apple:library') return null;
      if (payload.kind === 'albums') return {items: [{id: 'album', type: 'library-albums', title: 'Album'}]};
      if (payload.kind === 'album-songs') return {items: [{id: 'song', type: 'songs', title: 'Song', playable: true},
        ...(sample.mixed ? [{id: 'video', type: 'music-videos', title: 'Video', playable: false}] : [])], albumPlayback: sample.mapped};
      return {items: []};
    });
    f.appleNav[1].click(); await flush(); findClass(f.elements.appleViewContent, 'album-open').click(); await flush();
    const song = findText(f.elements.appleViewContent, 'Song'); assert.equal(song.disabled, !sample.legacy); song.click(); await flush();
    const play = f.calls.find(call => call.channel === 'player:play');
    if (sample.legacy) assert.deepEqual(JSON.parse(JSON.stringify(play.payload)), {source: 'apple', id: 'song', kind: 'songs'});
    else { assert.equal(play, undefined); assert.match(f.elements.appleViewContent.textContent, /专辑.*(?:不可用|无法完整播放)/); }
    if (sample.mixed) assert.equal(findText(f.elements.appleViewContent, 'Video').disabled, true);
  }
});

test('an Apple identity never resolves to a similarly named local track or its lyrics', async () => {
  const track = {id: 'same-id', title: 'Local only'};
  const active = {available: true, state: 'playing', source: 'apple', currentTrackId: 'same-id', currentTrack: null, position: 0, duration: 20, volume: 0.5};
  const {elements, calls} = await setup({library: {tracks: [track], playlists: []}, player: active, sources: {local: {available: true}, apple: {status: 'ready'}}, settings: defaultSettings});
  assert.equal(elements.nowSource.textContent, 'Apple Music');
  assert.equal(elements.nowTitle.textContent, '没有正在播放的音乐');
  const row = findClass(elements.viewContent, 'track-row');
  assert.equal(row.classList.contains('current'), false);
  elements.miniCover.click(); await flush();
  assert.equal(calls.some(call => call.channel === 'lyrics:resolve'), false);
});

test('Apple playback controls follow reported capabilities and never use local-only order', async () => {
  const active = {available: true, state: 'playing', source: 'apple', currentTrack: {title: 'Apple track'}, position: 0, duration: 20, volume: 0.5, playbackOrders: [{id: 3, name: 'Repeat'}], playbackOrder: {id: 3, name: 'Repeat'}};
  const {elements, calls, events} = await setup({library: {tracks: [], playlists: []}, player: active, sources: {local: {available: true}, apple: {status: 'ready'}}, settings: defaultSettings});
  assert.equal(elements.nowSource.textContent, 'Apple Music');
  assert.equal(elements.seek.disabled, true);
  assert.equal(elements.volume.disabled, true);
  assert.equal(elements.playbackOrder.disabled, true);
  assert.equal(elements.toggle.disabled, true);
  assert.equal(elements.previous.disabled, true);
  assert.equal(elements.next.disabled, true);
  elements.seek.dispatch('change'); elements.volume.dispatch('change'); elements.playbackOrder.dispatch('change'); await flush();
  assert.equal(calls.some(item => ['player:seek', 'player:volume', 'player:order'].includes(item.channel)), false);
  events.source({sources: {apple: {status: 'ready', capabilities: {seek: true, volume: true, controls: {toggle: true, previous: true, next: false}}}}});
  assert.equal(elements.seek.disabled, false);
  assert.equal(elements.toggle.disabled, false);
  assert.equal(elements.previous.disabled, false);
  assert.equal(elements.next.disabled, true);
  assert.equal(elements.volume.disabled, false);
  assert.equal(elements.playbackOrder.disabled, true);
});

test('older player generations and revisions cannot restore stale playback state', async () => {
  const a = {id: 'a', title: 'A'}, b = {id: 'b', title: 'B'};
  const {elements, events} = await setup({library: {tracks: [a, b], playlists: []}, player: player(a, {source: 'local', generation: 4, revision: 2}), settings: defaultSettings});
  events.player(player(b, {source: 'local', state: 'paused', generation: 5, revision: 3}));
  assert.equal(elements.nowTitle.textContent, 'B');
  events.player(player(a, {source: 'local', generation: 4, revision: 99}));
  events.player(player(a, {source: 'local', generation: 5, revision: 2}));
  events.player(player(a, {source: 'local'}));
  assert.equal(elements.nowTitle.textContent, 'B');
  events.player(player(a, {source: 'local', generation: 5, revision: 4}));
  assert.equal(elements.nowTitle.textContent, 'A');
});

test('metadata remains text and unavailable tracks cannot start playback', async () => {
  const title = '<img src=x onerror=alert(1)>';
  const {elements, calls} = await setup({library: {tracks: [{id: 'one', title, artist: '艺术家', album: '专辑', valid: false}], playlists: []}, player: {available: true, state: 'stopped', volume: 0.5}, settings: defaultSettings});
  const item = findText(elements.viewContent, title);
  assert.equal(item.tagName, 'BUTTON'); assert.equal(item.disabled, true); assert.equal(item.children.length, 0);
  assert.ok(findText(elements.viewContent, '文件不可用'));
  assert.deepEqual(calls.map(call => call.channel), ['backend:setupStatus', 'app:bootstrap']);
});

test('library events replace the empty state and album navigation uses real metadata', async () => {
  const {elements, nav, events} = await setup({library: {tracks: [], playlists: []}, player: offline, settings: defaultSettings});
  events.library({tracks: [{id: 'one', title: '曲目', album: '真实专辑', artist: '艺术家'}], playlists: []});
  nav[1].click();
  assert.equal(elements.pageTitle.textContent, '专辑'); assert.equal(elements.itemCount.textContent, '1 张');
  assert.ok(findText(elements.viewContent, '真实专辑'));
});

test('playback order uses IDs supplied by the backend and import warnings remain visible', async () => {
  const p = {...offline, available: true, state: 'stopped', playbackOrders: [{id: 4, name: 'Repeat'}, {id: 7, name: 'Shuffle'}], playbackOrder: {id: 7, name: 'Shuffle'}};
  const snapshot = {tracks: [], playlists: [], importReport: {indexedCount: 3, backendPrepared: false, warnings: ['请在 Beefweb Music directories 中添加所在目录。']}};
  const {elements, calls} = await setup({library: {tracks: [], playlists: []}, player: p, settings: defaultSettings}, async channel => channel === 'library:import' ? snapshot : p);
  assert.equal(elements.playbackOrder.value, '7');
  elements.playbackOrder.value = '4'; elements.playbackOrder.dispatch('change'); await flush();
  assert.equal(calls.find(call => call.channel === 'player:order').payload.id, 4);
  elements.importFiles.click(); await flush();
  assert.equal(elements.dialog.open, true);
  assert.ok(findText(elements.dialogBody, '已索引 3 首。'));
  assert.ok(findText(elements.dialogBody, '请在 Beefweb Music directories 中添加所在目录。'));
});

test('footer order follows the active player, its readiness and backend readback independently of browsing', async () => {
  const track = {id: 'a', title: 'A'}, orders = [{id: 4, name: 'Repeat'}, {id: 7, name: 'Shuffle'}];
  const local = player(track, {source: 'local', generation: 1, revision: 1, playbackOrders: orders, playbackOrder: orders[0]});
  const sources = {local: {available: true, capabilities: {playback: true}}, apple: {available: true, capabilities: {library: false, order: false}}};
  const f = await setup({library: {tracks: [track], playlists: []}, player: local, sources, selectedSource: 'local', settings: defaultSettings}, async (channel, payload) => {
    if (channel === 'source:select') return {selectedSource: payload.source, sources};
    if (channel === 'player:order') return {...local, revision: 2, playbackOrder: orders[0]};
    return null;
  });
  assert.equal(f.elements.playbackOrder.disabled, false); assert.match(f.elements.playbackOrder.title, /Repeat/);
  f.elements.sourceApple.click(); await flush(); assert.equal(f.elements.playbackOrder.disabled, false);
  f.elements.playbackOrder.focus(); assert.equal(f.context.document.activeElement, f.elements.playbackOrder);
  f.elements.playbackOrder.value = '7'; f.elements.playbackOrder.dispatch('change'); await flush();
  assert.equal(f.calls.find(call => call.channel === 'player:order').payload.id, 7); assert.equal(f.elements.playbackOrder.value, '4');
  f.events.player({...local, source: 'apple', generation: 2, revision: 1}); assert.equal(f.elements.playbackOrder.disabled, true);
  f.elements.playbackOrder.value = '7'; f.elements.playbackOrder.dispatch('change'); await flush();
  assert.equal(f.calls.filter(call => call.channel === 'player:order').length, 1);
  f.events.player({...local, generation: 3, revision: 1, playbackOrder: orders[1]}); assert.equal(f.elements.playbackOrder.value, '7'); assert.equal(f.elements.playbackOrder.disabled, false);
  f.events.source({sources: {...sources, local: {available: false, capabilities: {playback: false}}}}); assert.equal(f.elements.playbackOrder.disabled, true);
});

test('Apple order requires a ready active player and capability and reflects actual readback while browsing local', async () => {
  const track = {id: 'apple', title: 'Apple'}, orders = [{id: 0, name: '顺序'}, {id: 1, name: '随机'}];
  const apple = player(track, {source: 'apple', generation: 3, revision: 1, controlsReady: true, playbackOrders: orders, playbackOrder: orders[0]});
  const sources = {local: {available: true}, apple: {available: true, capabilities: {order: true}}};
  const f = await setup({library: {tracks: [], playlists: []}, player: apple, sources, selectedSource: 'local', settings: defaultSettings}, async channel =>
    channel === 'player:order' ? {...apple, revision: 2, playbackOrder: orders[1]} : null);
  assert.equal(f.context.StillApp.state.browseSource, 'local'); assert.equal(f.elements.playbackOrder.disabled, false);
  f.elements.playbackOrder.value = '1'; f.elements.playbackOrder.dispatch('change'); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(call => call.channel === 'player:order').payload)), {id: 1, source: 'apple', generation: 3});
  assert.equal(f.elements.playbackOrder.value, '1');
  assert.match(f.elements.playbackOrder.title, /随机/);
  f.events.player({...apple, revision: 3, controlsReady: false}); assert.equal(f.elements.playbackOrder.disabled, true);
  f.events.player({...apple, revision: 4, controlsReady: true}); assert.equal(f.elements.playbackOrder.disabled, false);
  f.events.source({sources: {...sources, apple: {...sources.apple, capabilities: {order: false}}}}); assert.equal(f.elements.playbackOrder.disabled, true);
});

test('late Apple order readback cannot overwrite a newer local player', async () => {
  const track = {id: 'track', title: 'Track'}, pending = deferred(), orders = [{id: 0, name: '顺序'}, {id: 1, name: '随机'}];
  const apple = player(track, {source: 'apple', generation: 3, revision: 1, controlsReady: true, playbackOrders: orders, playbackOrder: orders[0]});
  const f = await setup({library: {tracks: [track], playlists: []}, player: apple, sources: {local: {available: true}, apple: {capabilities: {order: true}}}, settings: defaultSettings}, async channel => channel === 'player:order' ? pending.promise : null);
  f.elements.playbackOrder.value = '1'; f.elements.playbackOrder.dispatch('change');
  f.events.player(player(track, {source: 'local', generation: 4, revision: 1, playbackOrders: orders, playbackOrder: orders[0]}));
  pending.resolve({...apple, revision: 2, playbackOrder: orders[1]}); await flush();
  assert.equal(f.context.StillApp.state.player.source, 'local'); assert.equal(f.elements.playbackOrder.value, '0');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(call => call.channel === 'player:order').payload)), {id: 1, source: 'apple', generation: 3});
});

test('a footer mode menu opened for one source cannot change the other source', async () => {
  const track = {id: 'track', title: 'Track'}, orders = [{id: 0, name: '顺序'}, {id: 1, name: '循环'}];
  const local = player(track, {source: 'local', generation: 1, revision: 1, playbackOrders: orders, playbackOrder: orders[0]});
  const f = await setup({library: {tracks: [track], playlists: []}, player: local,
    sources: {local: {available: true}, apple: {capabilities: {order: true}}}, settings: defaultSettings});
  const select = f.elements.playbackOrder;
  select.dispatch('pointerdown');
  f.events.player({...local, source: 'apple', generation: 2, controlsReady: true});
  assert.equal(select.disabled, false);
  select.value = '1'; select.dispatch('change'); await flush();
  assert.equal(f.calls.some(call => call.channel === 'player:order'), false);
  assert.equal(select.value, '0');
});

test('a newer playback request is sent immediately and an older completion cannot unlock or replace it', async () => {
  const a = {id: 'a', title: 'A'}, b = {id: 'b', title: 'B'}, pendingA = deferred(), pendingB = deferred();
  const {elements, calls} = await setup({library: {tracks: [a, b], playlists: []}, player: {available: true, state: 'stopped', volume: 0.5}, settings: defaultSettings}, async (channel, payload) => {
    if (channel === 'player:play') return payload.trackId === 'a' ? pendingA.promise : pendingB.promise;
    return null;
  });
  const rows = walk(elements.viewContent).filter(item => item.classList.contains('track-row'));
  walk(rows[0]).find(item => item.tagName === 'BUTTON' && item.textContent === 'A').click();
  walk(rows[1]).find(item => item.tagName === 'BUTTON' && item.textContent === 'B').click();
  assert.deepEqual(calls.filter(call => call.channel === 'player:play').map(call => call.payload.trackId), ['a', 'b']);
  assert.equal(rows[1].classList.contains('preparing'), true);
  pendingA.resolve(player(a)); await flush();
  assert.equal(rows[1].classList.contains('preparing'), true);
  assert.notEqual(elements.nowTitle.textContent, 'A');
  pendingB.resolve(player(b)); await flush();
  assert.equal(rows[1].classList.contains('preparing'), false);
  assert.equal(elements.nowTitle.textContent, 'B');
});

test('an explicit Apple play can supersede a pending local request without source browsing stopping playback', async () => {
  const local = {id: 'a', title: 'Local A'}, pendingLocal = deferred(), pendingApple = deferred();
  const sources = {local: {available: true}, apple: {provider: 'cider', status: 'ready', capabilities: {library: true, playback: true, playableTypes: ['songs']}}};
  const {elements, calls} = await setup({library: {tracks: [local], playlists: []}, player: {available: true, state: 'stopped', volume: 0.5}, sources, settings: defaultSettings}, async (channel, payload) => {
    if (channel === 'source:select') return {selectedSource: payload.source, sources};
    if (channel === 'apple:library') return {items: [{id: 'apple.1', type: 'songs', title: 'Apple B', playable: true}]};
    if (channel === 'player:play') return payload.source === 'local' ? pendingLocal.promise : pendingApple.promise;
    return null;
  });
  walk(elements.viewContent).find(item => item.tagName === 'BUTTON' && item.textContent === 'Local A').click();
  elements.sourceApple.click(); await flush();
  assert.equal(calls.filter(item => item.channel === 'player:play').length, 1);
  const appleRow = findClass(elements.appleViewContent, 'track-row');
  walk(appleRow).find(item => item.tagName === 'BUTTON' && item.textContent === 'Apple B').click();
  assert.equal(calls.filter(item => item.channel === 'player:play').length, 2);
  pendingLocal.resolve(player(local, {source: 'local'})); await flush();
  assert.equal(appleRow.classList.contains('preparing'), true);
  pendingApple.resolve({available: true, state: 'playing', source: 'apple', currentTrack: {title: 'Apple B'}, position: 0, duration: 0, volume: null}); await flush();
  assert.equal(elements.nowSource.textContent, 'Apple Music');
  assert.equal(elements.nowTitle.textContent, 'Apple B');
});

test('a superseded playback request is treated as normal cancellation', async () => {
  const track = {id: 'a', title: 'A'};
  const {elements} = await setup({library: {tracks: [track], playlists: []}, player: {available: true, state: 'stopped', volume: 0.5}, settings: defaultSettings}, async channel => {
    if (channel === 'player:play') throw new Error('播放请求已被较新的播放或控制操作取消。');
    return null;
  });
  elements.toast.hidden = true;
  walk(elements.viewContent).find(item => item.tagName === 'BUTTON' && item.textContent === 'A').click(); await flush();
  assert.equal(elements.toast.hidden, true);
});

test('an obsolete playback error cannot surface over a newer selection', async () => {
  const a = {id: 'a', title: 'A'}, b = {id: 'b', title: 'B'}, pendingA = deferred(), pendingB = deferred();
  const {elements} = await setup({library: {tracks: [a, b], playlists: []}, player: {available: true, state: 'stopped', volume: 0.5}, settings: defaultSettings},
    async (channel, payload) => channel === 'player:play' ? (payload.trackId === 'a' ? pendingA.promise : pendingB.promise) : null);
  elements.toast.hidden = true;
  const rows = walk(elements.viewContent).filter(item => item.classList.contains('track-row'));
  walk(rows[0]).find(item => item.tagName === 'BUTTON' && item.textContent === 'A').click();
  walk(rows[1]).find(item => item.tagName === 'BUTTON' && item.textContent === 'B').click();
  pendingA.reject(new Error('旧请求错误')); await flush();
  assert.equal(elements.toast.hidden, true);
  pendingB.resolve(player(b)); await flush();
  assert.equal(elements.nowTitle.textContent, 'B');
});

test('a searched playlist opens all entries and moves a duplicate by its real occurrence index', async () => {
  const a = {id: 'a', title: 'A', artist: 'Artist'}, b = {id: 'b', title: 'B', artist: 'Artist'};
  const library = {tracks: [a, b], playlists: [{id: 'list', name: 'My list', trackIds: ['a', 'b', 'a']}]};
  const {elements, nav, calls} = await setup({library, player: {available: true, state: 'stopped', volume: 0.5}, settings: defaultSettings}, async channel => channel === 'playlist:moveItem' ? library : null);
  nav[3].click(); elements.search.value = 'My list'; elements.search.dispatch('input');
  const open = walk(elements.viewContent).find(item => item.classList.contains('list-open'));
  open.click();
  assert.equal(elements.search.value, '');
  assert.equal(elements.itemCount.textContent, '3 首');
  elements.sortSelect.value = 'title'; elements.sortSelect.dispatch('change');
  const rows = walk(elements.viewContent).filter(item => item.classList.contains('track-row'));
  const menu = walk(rows[1]).find(item => item.classList.contains('row-action'));
  menu.click();
  const move = walk(elements.dialogBody).find(item => item.tagName === 'BUTTON' && item.textContent === '在原列表中上移');
  move.click(); await flush();
  const call = calls.find(item => item.channel === 'playlist:moveItem');
  assert.equal(call.payload.id, 'list'); assert.equal(call.payload.fromIndex, 2); assert.equal(call.payload.toIndex, 1);
});

test('a changed queue is refreshed instead of deleting a stale index', async () => {
  const first = {items: [{index: 0, trackId: 'a', title: 'A', artist: 'Artist'}]};
  const changed = {items: [{index: 0, trackId: 'b', title: 'B', artist: 'Artist'}]};
  let reads = 0;
  const {elements, calls} = await setup({library: {tracks: [], playlists: []}, player: {available: true, state: 'stopped', volume: 0.5}, settings: defaultSettings}, async channel => {
    if (channel === 'queue:list') return ++reads === 1 ? first : changed;
    return null;
  });
  elements.queueButton.click(); await flush();
  const remove = walk(elements.dialogBody).find(item => item.attributes['aria-label'] === '从队列移除 A');
  remove.click(); await flush();
  assert.equal(calls.some(call => call.channel === 'queue:remove'), false);
  assert.ok(findText(elements.dialogBody, 'B'));
  assert.match(elements.dialogAlert.textContent, /队列已改变/);
});

test('offline queue and audio dialogs show a concise state while retaining detailed diagnostics', async () => {
  const {elements} = await setup({library: {tracks: [], playlists: []}, player: {...offline, error: '原始后端诊断'}, sources: {local: {available: false, backendDiagnostic: '原始后端诊断'}}, settings: defaultSettings}, async channel => {
    if (channel === 'queue:list' || channel === 'audio:outputs' || channel === 'audio:details') throw new Error('原始后端诊断');
    return null;
  });
  elements.queueButton.click(); await flush();
  assert.equal(elements.dialogAlert.hidden, true);
  assert.match(elements.dialogBody.textContent, /无法读取队列/);
  elements.closeDialog.click(); elements.audioButton.click(); await flush();
  assert.equal(elements.dialogAlert.hidden, true);
  assert.ok(findText(elements.dialogBody, '查看详细诊断'));
  assert.ok(findText(elements.dialogBody, '原始后端诊断'));
});

test('a stale playlist menu cannot move a changed occurrence', async () => {
  const a = {id: 'a', title: 'A'}, b = {id: 'b', title: 'B'};
  const original = {tracks: [a, b], playlists: [{id: 'list', name: 'List', trackIds: ['a', 'b', 'a']}]};
  const changed = {tracks: [a, b], playlists: [{id: 'list', name: 'List', trackIds: ['b', 'a', 'a']}]};
  const {elements, nav, events, calls} = await setup({library: original, player: {available: true, state: 'stopped', volume: 0.5}, settings: defaultSettings});
  nav[3].click(); walk(elements.viewContent).find(item => item.classList.contains('list-open')).click();
  const rows = walk(elements.viewContent).filter(item => item.classList.contains('track-row'));
  walk(rows[2]).find(item => item.classList.contains('row-action')).click();
  const move = walk(elements.dialogBody).find(item => item.tagName === 'BUTTON' && item.textContent === '在原列表中上移');
  events.library(changed); move.click(); await flush();
  assert.equal(calls.some(call => call.channel === 'playlist:moveItem'), false);
  assert.match(elements.toast.textContent, /播放列表已改变/);
});

test('lyrics requests are isolated across a fast track switch', async () => {
  const a = {id: 'a', title: 'A', artist: 'Artist'}, b = {id: 'b', title: 'B', artist: 'Artist'};
  const pendingA = deferred(), pendingB = deferred();
  const {elements, events} = await setup({library: {tracks: [a, b], playlists: []}, player: player(a), settings: defaultSettings}, async (channel, payload) => {
    if (channel === 'lyrics:resolve') return payload.trackId === 'a' ? pendingA.promise : pendingB.promise;
    return null;
  });
  elements.nowTitle.click();
  events.player(player(b));
  pendingB.resolve({trackId: 'b', status: 'ready', kind: 'line', lines: [{startMs: 1000, endMs: 3000, text: 'B 的歌词'}], offsetMs: 0});
  await flush();
  assert.ok(findText(elements.lyricsBody, 'B 的歌词'));
  pendingA.resolve({trackId: 'a', status: 'ready', kind: 'line', lines: [{startMs: 1000, text: 'A 的旧歌词'}], offsetMs: 0});
  await flush();
  assert.ok(findText(elements.lyricsBody, 'B 的歌词'));
  assert.equal(findText(elements.lyricsBody, 'A 的旧歌词'), undefined);
});

test('a stale lyric request failure cannot display an error for the new track', async () => {
  const a = {id: 'a', title: 'A'}, b = {id: 'b', title: 'B'}, first = deferred(), second = deferred();
  const {elements, events} = await setup({library: {tracks: [a, b], playlists: []}, player: player(a), settings: defaultSettings},
    async (channel, payload) => channel === 'lyrics:resolve' ? (payload.trackId === 'a' ? first.promise : second.promise) : null);
  elements.toast.hidden = true; elements.nowTitle.click(); events.player(player(b));
  second.resolve({trackId: 'b', status: 'plain', kind: 'plain', plainText: 'B', lines: []}); await flush();
  first.reject(new Error('旧歌词网络错误')); await flush();
  assert.equal(elements.toast.hidden, true);
  assert.ok(findText(elements.lyricsBody, 'B'));
});

test('returning from lyrics restores library scroll after track and library updates', async () => {
  const a = {id: 'a', title: 'A'}, b = {id: 'b', title: 'B'};
  const library = {tracks: [a, b], playlists: []};
  const {elements, events} = await setup({library, player: player(a), settings: defaultSettings}, async (channel, payload) => channel === 'lyrics:resolve'
    ? {trackId: payload.trackId, status: 'not-found', kind: 'none', lines: []} : null);
  elements.content.scrollTop = 420; elements.nowTitle.click(); await flush();
  events.player(player(b)); events.library(library); await flush();
  elements.content.scrollTop = 0;
  elements.leaveImmersive.click();
  assert.equal(elements.content.scrollTop, 420);
  assert.equal(elements.immersive.hidden, true);
});

test('returning from lyrics also restores Apple collection scroll', async () => {
  const track = {id: 'a', title: 'Local'};
  const sources = {local: {available: true}, apple: {provider: 'cider', status: 'ready', capabilities: {library: true, playback: false}}};
  const {elements, events} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local'}), selectedSource: 'apple', sources, settings: defaultSettings}, async (channel, payload) => {
    if (channel === 'apple:library') return {items: [{id: 'a.1', type: 'songs', title: 'Song'}]};
    if (channel === 'lyrics:resolve') return {trackId: payload.trackId, status: 'not-found', kind: 'none', lines: []};
    return null;
  });
  elements.appleContent.scrollTop = 240; elements.miniCover.click(); await flush();
  events.source({selectedSource: 'apple', sources}); elements.appleContent.scrollTop = 0;
  elements.leaveImmersive.click();
  assert.equal(elements.appleContent.scrollTop, 240);
  assert.equal(elements.appleContent.hidden, false);
});

test('word timing freezes on pause, lyric seek includes offset, and manual scrolling pauses follow', async () => {
  const track = {id: 'a', title: 'Song', artist: 'Artist'}, initial = player(track);
  const document = {trackId: 'a', status: 'ready', kind: 'word', offsetMs: 250, lines: [{startMs: 1000, endMs: 3000, text: 'Hello', words: [{startMs: 1000, endMs: 2000, text: 'Hello'}], translation: '你好'}]};
  const {elements, events, calls, advance} = await setup({library: {tracks: [track], playlists: []}, player: initial, settings: defaultSettings}, async (channel, payload) => {
    if (channel === 'lyrics:resolve') return document;
    if (channel === 'player:seek') return player(track, {state: 'paused', position: payload.position});
    return null;
  });
  elements.nowTitle.click(); await flush();
  advance(300);
  const line = findClass(elements.lyricsBody, 'lyric-line'), word = findClass(line, 'lyric-word');
  assert.equal(word.style.values['--word-progress'], '25%');
  elements.lyricsScroll.dispatch('wheel');
  assert.equal(elements.resumeFollow.hidden, false);
  events.player(player(track, {state: 'paused', position: 1.5}));
  advance(5000);
  assert.equal(word.style.values['--word-progress'], '25%');
  assert.equal(findClass(elements.lyricsBody, 'lyric-line'), line);
  elements.resumeFollow.click(); assert.equal(elements.resumeFollow.hidden, true);
  line.click(); await flush();
  assert.equal(calls.find(call => call.channel === 'player:seek').payload.position, 1.25);
});

test('lyric following respects the operating-system reduced-motion preference', async () => {
  const track = {id: 'a', title: 'Song'};
  const {elements, context} = await setup({library: {tracks: [track], playlists: []}, player: player(track), settings: defaultSettings}, async channel => channel === 'lyrics:resolve'
    ? {trackId: 'a', status: 'ready', kind: 'line', lines: [{startMs: 1000, endMs: 3000, text: 'Line'}], offsetMs: 0} : null);
  context.matchMedia = () => ({matches: true});
  elements.nowTitle.click(); await flush();
  assert.equal(elements.lyricsScroll.scrollCalls.at(-1).behavior, 'auto');
});

test('plain originals and translations remain independent with no fabricated active line', async () => {
  const track = {id: 'a', title: 'Song'};
  const {elements} = await setup({library: {tracks: [track], playlists: []}, player: player(track), settings: defaultSettings}, async channel => channel === 'lyrics:resolve'
    ? {trackId: 'a', status: 'plain', kind: 'plain', plainText: 'Original one\nOriginal two', plainTranslation: '译文全文', lines: []} : null);
  elements.nowTitle.click(); await flush();
  assert.ok(findText(elements.lyricsBody, 'Original one\nOriginal two'));
  assert.ok(findText(elements.lyricsBody, '译文全文'));
  assert.equal(findClass(elements.lyricsBody, 'lyric-line'), undefined);
  assert.match(elements.lyricsStatus.textContent, /无时间轴/);
});

test('timed lyrics show an untimed full translation independently and obey its visibility setting', async () => {
  const track = {id: 'a', title: 'Song'};
  const document = {trackId: 'a', status: 'ready', kind: 'line', lines: [{startMs: 1000, endMs: 3000, text: 'Timed original'}], plainTranslation: '完整译文\n不是逐行匹配'};
  const {elements, events} = await setup({library: {tracks: [track], playlists: []}, player: player(track), settings: defaultSettings}, async channel => channel === 'lyrics:resolve' ? document : null);
  elements.nowTitle.click(); await flush();
  assert.ok(findText(elements.lyricsBody, 'Timed original'));
  assert.ok(findText(elements.lyricsBody, '完整译文\n不是逐行匹配'));
  assert.ok(findText(elements.lyricsBody, '完整译文 · 无时间轴'));
  assert.equal(walk(elements.lyricsBody).filter(item => item.classList.contains('lyric-line')).length, 1);
  events.settings({...defaultSettings, lyrics: {...defaultSettings.lyrics, showTranslation: false}});
  assert.equal(findText(elements.lyricsBody, '完整译文\n不是逐行匹配'), undefined);
});

test('search results expose real versions and previews without turning plain text into timed lyrics', async () => {
  const track = {id: 'a', title: 'Song'};
  const candidates = [
    {id: 'lrclib:1', source: 'LRCLIB', title: 'Song', artist: 'Singer', album: 'Studio', duration: 244, kind: 'plain', format: 'txt'},
    {id: 'lrclib:2', source: 'LRCLIB', title: 'Song live', artist: 'Singer', album: 'Live', duration: 399, kind: 'line', format: 'lrc'}
  ];
  const {elements} = await setup({library: {tracks: [track], playlists: []}, player: player(track), settings: defaultSettings}, async channel => {
    if (channel === 'lyrics:resolve') return {trackId: 'a', status: 'not-found', kind: 'none', lines: []};
    if (channel === 'lyrics:search') return {status: 'ready', source: 'LRCLIB', results: candidates};
    if (channel === 'lyrics:preview') return {trackId: 'a', status: 'plain', kind: 'plain', plainText: 'Preview only', plainTranslation: '译文预览'};
    return null;
  });
  elements.nowTitle.click(); await flush(); elements.findLyrics.click(); await flush();
  const text = elements.dialogBody.textContent;
  assert.match(text, /4:04/); assert.match(text, /6:39/); assert.match(text, /LRCLIB/); assert.match(text, /纯文本/); assert.match(text, /逐行/);
  const preview = walk(elements.dialogBody).find(item => item.tagName === 'BUTTON' && item.textContent === '预览');
  preview.click(); await flush();
  assert.match(elements.dialogBody.textContent, /Preview only/);
  assert.match(elements.dialogBody.textContent, /译文预览/);
  assert.equal(findClass(elements.dialogBody, 'lyric-line'), undefined);
});

test('switching tracks closes the prior lyric search and prevents a stale binding command', async () => {
  const a = {id: 'a', title: 'A'}, b = {id: 'b', title: 'B'};
  const {elements, events, calls} = await setup({library: {tracks: [a, b], playlists: []}, player: player(a), settings: defaultSettings}, async (channel, payload) => {
    if (channel === 'lyrics:resolve') return {trackId: payload.trackId, status: 'not-found', kind: 'none', lines: []};
    if (channel === 'lyrics:search') return {status: 'ready', results: [{id: 'lrclib:1', title: 'A', source: 'LRCLIB', kind: 'plain'}]};
    return null;
  });
  elements.nowTitle.click(); await flush(); elements.findLyrics.click(); await flush();
  const bind = walk(elements.dialogBody).find(item => item.tagName === 'BUTTON' && item.textContent === '绑定此版本');
  events.player(player(b));
  assert.equal(elements.dialog.open, false);
  bind.click(); await flush();
  assert.equal(calls.some(call => call.channel === 'lyrics:bind'), false);
});

test('the marked smoke lyric fixture is labeled in both listening surfaces and clears for real playback', async () => {
  const track = {id: 'fixture-track', title: 'Existing library track'};
  const {elements, events, calls} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {
    source: 'local', state: 'paused', simulatedUIFixture: true, fixtureLabel: '测试歌词 / 非真实匹配'
  }), settings: defaultSettings}, async channel => channel === 'lyrics:resolve'
    ? {trackId: track.id, status: 'plain', kind: 'plain', plainText: '测试文本', source: 'smoke-fixture'} : null);
  assert.equal(elements.nowFixture.hidden, false);
  assert.equal(elements.nowFixture.textContent, '测试歌词 / 非真实匹配');
  elements.miniCover.click(); await flush();
  assert.equal(elements.lyricsFixture.hidden, false);
  assert.equal(elements.lyricsFixture.textContent, '测试歌词 / 非真实匹配');
  assert.equal(calls.some(call => /^(?:player:(?!context$)|queue:|audio:)/.test(call.channel)), false);
  events.player(player(track, {source: 'local', state: 'paused'}));
  assert.equal(elements.nowFixture.hidden, true);
  assert.equal(elements.lyricsFixture.hidden, true);
});

test('compact artist browsing and its detail cover are built only from library metadata', async () => {
  const tracks = [{id: 'a', title: 'One', artist: 'Artist A', album: 'Album'}, {id: 'b', title: 'Two', artist: 'Artist B', album: 'Another'}];
  const {elements, nav, calls} = await setup({library: {tracks, playlists: []}, player: offline, settings: defaultSettings});
  nav[2].click();
  assert.ok(findClass(elements.viewContent, 'artist-grid'));
  const open = findClass(elements.viewContent, 'list-open'); open.click();
  assert.ok(findClass(elements.viewContent, 'collection-detail'));
  assert.ok(findText(elements.viewContent, 'Artist A'));
  assert.ok(findText(elements.viewContent, 'One'));
  assert.equal(findText(elements.viewContent, 'Two'), undefined);
  assert.equal(calls.some(call => /^(?:player:|queue:|audio:)/.test(call.channel)), false);
});

test('thin progress and volume rails represent readback values and local drag previews', async () => {
  const track = {id: 'a', title: 'One'};
  const {elements, calls} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {position: 5, duration: 20, volume: 0.4}), settings: defaultSettings});
  assert.equal(elements.seek.style.values['--range-fill'], '25%');
  assert.equal(elements.volume.style.values['--range-fill'], '40%');
  elements.seek.value = '10'; elements.seek.dispatch('input');
  assert.equal(elements.seek.style.values['--range-fill'], '50%');
  assert.equal(elements.elapsed.textContent, '0:10');
  assert.equal(calls.some(call => call.channel === 'player:seek'), false);
});

test('official web session states use the reported opening action and never expose developer configuration', async () => {
  const sources = {local: {available: false}, apple: {provider: 'officialWeb', status: 'session-closed', actionLabel: '打开 Apple Music 会话', capabilities: {authorize: true, configureKey: true, library: false, playback: false}}};
  const {elements, events, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, selectedSource: 'apple', sources, settings: defaultSettings});
  assert.equal(elements.appleStateTitle.textContent, '打开 Apple Music 官方会话');
  assert.equal(elements.connectionText.textContent, '官方会话尚未打开');
  assert.equal(elements.appleAuthorize.textContent, '打开 Apple Music 会话');
  assert.equal(elements.appleConfigure.hidden, true);
  assert.equal(elements.appleDeveloperNote.hidden, true);
  assert.equal(elements.ciderPrerequisite.hidden, true);
  events.source({sources: {apple: {...sources.apple, status: 'session-unverified'}}});
  assert.equal(elements.appleStateTitle.textContent, '官方会话已登录');
  assert.equal(elements.appleCollection.hidden, true);
  assert.equal(calls.some(call => /^(?:player:|queue:|audio:)/.test(call.channel)), false);
});

test('startup opens the real record shelf and places missing artwork and unclassified albums last', async () => {
  const tracks = [
    {id: 'unknown', title: 'Loose recording', album: '', coverUrl: 'data:image/png;base64,AA=='},
    {id: 'no-art', title: 'One', album: 'A without artwork', artist: 'Artist'},
    {id: 'covered', title: 'Two', album: 'Z with artwork', artist: 'Artist', coverUrl: 'data:image/png;base64,AA=='},
    {id: 'covered-2', title: 'Three', album: 'Z with artwork', artist: 'Artist'}
  ];
  const {elements, calls, context} = await setup({library: {tracks, playlists: []}, player: offline, settings: defaultSettings}, undefined, {keepStartupView: true});
  assert.equal(context.StillApp.state.view, 'albums');
  assert.equal(elements.itemCount.textContent, '3 张');
  const tiles = walk(elements.viewContent).filter(item => item.classList.contains('tile'));
  assert.deepEqual(tiles.map(tile => findClass(tile, 'tile-title').textContent), ['Z with artwork', 'A without artwork', '未知专辑']);
  assert.equal(findClass(tiles[0], 'tile-count').textContent, '2 首');
  assert.equal(findClass(tiles[0], 'tile-cover').children[0].tagName, 'IMG');
  assert.deepEqual(calls.map(call => call.channel), ['backend:setupStatus', 'app:bootstrap']);
});

test('record detail browsing is silent and its explicit play action keeps the actual album order', async () => {
  const tracks = [
    {id: 'second', title: 'Second', album: 'Record', artist: 'Artist', trackNumber: 2},
    {id: 'first', title: 'First', album: 'Record', artist: 'Artist', trackNumber: 1}
  ];
  const {elements, calls} = await setup({library: {tracks, playlists: []}, sources: {local: {available: true}}, player: offline, settings: defaultSettings}, async () => null, {keepStartupView: true});
  findClass(elements.viewContent, 'tile').click();
  assert.ok(findClass(elements.viewContent, 'detail-layout'));
  assert.deepEqual(calls.map(call => call.channel), ['backend:setupStatus', 'app:bootstrap']);
  findClass(elements.viewContent, 'detail-play').click(); await flush();
  const command = calls.find(call => call.channel === 'player:play');
  assert.equal(command.payload.source, 'local');
  assert.equal(command.payload.trackId, 'first');
  assert.deepEqual(Array.from(command.payload.trackIds), ['first', 'second']);
  assert.equal(command.payload.startIndex, 0);
});

test('the saved local view is restored without writes and only explicit permitted navigation persists it', async () => {
  const settings = {...defaultSettings, appearance: {reducedMotion: true, localView: 'artists'}};
  const {context, nav, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, settings, capabilities: {persistUIState: true}}, async () => null, {keepStartupView: true});
  assert.equal(context.StillApp.state.view, 'artists');
  assert.deepEqual(calls.map(call => call.channel), ['backend:setupStatus', 'app:bootstrap']);
  nav[3].click(); await flush();
  const saved = calls.filter(call => call.channel === 'settings:update');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].payload.patch.appearance.localView, 'playlists');
  assert.deepEqual(Object.keys(saved[0].payload.patch.appearance), ['localView']);
  context.StillApp.setView('albums'); await flush();
  assert.equal(calls.filter(call => call.channel === 'settings:update').length, 1);
});

test('read-only smoke can navigate the shelf without persisting a preference', async () => {
  const {context, nav, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, settings: defaultSettings, capabilities: {persistUIState: false}}, async () => null, {keepStartupView: true});
  nav[0].click(); nav[1].click(); await flush();
  assert.equal(context.StillApp.state.view, 'albums');
  assert.deepEqual(calls.map(call => call.channel), ['backend:setupStatus', 'app:bootstrap']);
});

test('cover continuity is purely visual and both user and OS motion preferences suppress it', async () => {
  const track = {id: 'one', title: 'Record', coverUrl: 'data:image/png;base64,AA=='};
  const {context, elements, calls} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local'}), settings: defaultSettings});
  const motions = []; let canceled = 0;
  elements.miniCover.getBoundingClientRect = () => ({left: 20, top: 540, width: 50, height: 50});
  elements.largeCover.getBoundingClientRect = () => ({left: 800, top: 120, width: 250, height: 250});
  for (const target of [elements.miniCover, elements.largeCover]) target.animate = (frames, options) => {
    const pending = deferred();
    const animation = {finished: pending.promise, cancel() { canceled++; pending.reject(new Error('canceled')); }};
    motions.push({target, frames, options}); return animation;
  };
  elements.nowTitle.click(); await flush();
  assert.equal(motions.length, 1);
  assert.equal(motions[0].target, elements.largeCover);
  assert.match(motions[0].frames[0].transform, /scale\(0\.2\)/);
  assert.equal(motions[0].options.duration, 340);
  elements.leaveImmersive.click(); await flush();
  assert.equal(motions.length, 2); assert.equal(canceled, 1);
  context.StillApp.applySettings({...defaultSettings, appearance: {reducedMotion: true}});
  elements.nowTitle.click(); await flush();
  assert.equal(motions.length, 2); assert.equal(canceled, 2);
  context.StillApp.applySettings(defaultSettings);
  context.matchMedia = () => ({matches: true});
  elements.leaveImmersive.click(); elements.nowTitle.click(); await flush();
  assert.equal(motions.length, 2);
  assert.equal(calls.some(call => /^(?:player:(?!context$)|queue:|audio:)/.test(call.channel)), false);
});

test('album grid opens real records directly without starting playback or showing an oversized stage', async () => {
  const tracks = Array.from({length: 6}, (_, i) => ({id: 'song-'+i, title: 'Track '+i, album: 'Record '+i, artist: 'Artist '+i, coverUrl: 'data:image/png;base64,'+i+'A=='}));
  const {elements, calls} = await setup({library: {tracks, playlists: []}, player: offline, settings: defaultSettings}, undefined, {keepStartupView: true});
  assert.equal(elements.recordStage, undefined);
  const cards = walk(elements.viewContent).filter(element => element.classList.contains('tile'));
  assert.equal(cards.length, 6);
  assert.equal(cards[2].tagName, 'BUTTON'); assert.equal(cards[2].type, 'button');
  assert.match(cards[2].attributes['aria-label'], /Record 2/);
  cards[2].click(); await flush();
  assert.ok(findClass(elements.viewContent, 'collection-detail'));
  assert.ok(findText(elements.viewContent, 'Track 2'));
  assert.deepEqual(calls.map(call => call.channel), ['backend:setupStatus', 'app:bootstrap']);
});

test('album detail explicit playback preserves actual disc order and skips unsupported start candidates', async () => {
  const tracks = [{id: 'b', title: 'Second', album: 'Record', discNumber: 1, trackNumber: 2}, {id: 'x', title: 'Unsupported', album: 'Record', discNumber: 1, trackNumber: 1, supported: false}, {id: 'c', title: 'Third', album: 'Record', discNumber: 2, trackNumber: 1}];
  const {elements, calls} = await setup({library: {tracks, playlists: []}, sources: {local: {available: true}}, player: offline, settings: defaultSettings}, undefined, {keepStartupView: true});
  findClass(elements.viewContent, 'tile').click(); await flush();
  findClass(elements.viewContent, 'detail-play').click(); await flush();
  const command = calls.find(call => call.channel === 'player:play');
  assert.equal(command.payload.source, 'local'); assert.equal(command.payload.trackId, 'b'); assert.equal(command.payload.startIndex, 1);
  assert.deepEqual(Array.from(command.payload.trackIds), ['x', 'b', 'c']);
});

test('glass surface tracks accepted actual playback state and ignores a stale playing revision', async () => {
  const track = {id: 'one', title: 'Song'};
  const {context, elements, events} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {generation: 2, revision: 1, position: 5, duration: 20}), settings: defaultSettings});
  assert.equal(context.document.body.classList.contains('is-playing'), true);
  assert.equal(context.document.body.style.values['--playback-fraction'], '0.25');
  events.player(player(track, {generation: 2, revision: 3, state: 'paused', position: 5, duration: 20}));
  assert.equal(context.document.body.classList.contains('is-playing'), false); assert.match(elements.listeningState.textContent, /已暂停/);
  events.player(player(track, {generation: 2, revision: 2, state: 'playing'}));
  assert.equal(context.document.body.classList.contains('is-playing'), false);
});

test('appearance picker previews without writes, saves one confirmed change, and rejects CSS input', async () => {
  const {elements, calls, context, nav, events} = await setup({library: {tracks: [], playlists: []}, player: offline, settings: defaultSettings, capabilities: {persistUIState: true}}, async (channel, payload) => channel === 'settings:update' ? {...defaultSettings, appearance: {...defaultSettings.appearance, ...payload.patch.appearance}} : null);
  elements.audioButton.click(); await flush(); findText(elements.dialogBody, '光线与外观').click(); await flush();
  const picker = findClass(elements.dialogBody, 'accent-picker'), text = findClass(elements.dialogBody, 'accent-text');
  assert.equal(walk(elements.dialogBody).filter(element => element.classList.contains('accent-swatch')).length, 8);
  picker.value = '#000000'; picker.dispatch('input'); picker.value = '#FFFFFF'; picker.dispatch('input');
  assert.equal(context.document.body.style.values['--accent'], '#FFFFFF');
  assert.equal(calls.some(call => call.channel === 'settings:update'), false);
  picker.dispatch('change'); await flush();
  assert.equal(calls.filter(call => call.channel === 'settings:update').length, 1);
  const update = calls.find(call => call.channel === 'settings:update');
  assert.deepEqual(Object.keys(update.payload.patch.appearance), ['accentColor', 'accentMode']);
  assert.equal(update.payload.patch.appearance.accentColor, '#FFFFFF');
  text.value = 'var(--accent)'; text.dispatch('input'); text.dispatch('keydown', {key: 'Enter'}); await flush();
  assert.equal(calls.filter(call => call.channel === 'settings:update').length, 1);
  assert.equal(text.attributes['aria-invalid'], 'true');
  elements.closeDialog.click(); nav[2].click(); await flush();
  assert.equal(context.document.body.style.values['--accent'], '#FFFFFF');
  events.settings({...defaultSettings, appearance: {accentColor: '#92D5BC', reducedMotion: true}});
  assert.equal(context.document.body.style.values['--accent'], '#92D5BC');
  assert.equal(context.document.body.classList.contains('reduced-motion'), true);
});

test('appearance save failures restore the committed colour and remain visible above the dialog', async () => {
  const {elements, context} = await setup({library: {tracks: [], playlists: []}, player: offline, settings: {...defaultSettings, appearance: {accentColor: '#92D5BC'}}, capabilities: {persistUIState: true}}, async channel => { if (channel === 'settings:update') throw new Error('disk full'); return null; });
  elements.audioButton.click(); await flush(); findText(elements.dialogBody, '光线与外观').click(); await flush();
  const picker = findClass(elements.dialogBody, 'accent-picker'); picker.value = '#000000'; picker.dispatch('input'); picker.dispatch('change'); await flush();
  assert.equal(context.document.body.style.values['--accent'], '#92D5BC');
  assert.equal(picker.value, '#92D5BC');
  assert.equal(elements.dialogAlert.hidden, false); assert.match(elements.dialogAlert.textContent, /未保存/);
});

test('read-only appearance controls never dispatch writes or preview mutating events', async () => {
  const {elements, calls, context} = await setup({library: {tracks: [], playlists: []}, player: offline, settings: defaultSettings, capabilities: {persistUIState: false}});
  elements.audioButton.click(); await flush(); findText(elements.dialogBody, '光线与外观').click(); await flush();
  const picker = findClass(elements.dialogBody, 'accent-picker'); assert.equal(picker.disabled, true);
  picker.value = '#000000'; picker.dispatch('input'); picker.dispatch('change');
  for (const swatch of walk(elements.dialogBody).filter(element => element.classList.contains('accent-swatch'))) swatch.click();
  await flush();
  assert.equal(context.document.body.style.values['--accent'], '#A8B9FF');
  assert.deepEqual(calls.map(call => call.channel), ['backend:setupStatus', 'app:bootstrap', 'audio:outputs', 'audio:details', 'app:restoreInfo', 'desktop:status']);
});

test('current playback list uses the actual source and occurrence, stays read-only, and ignores late hidden results', async () => {
  const track = {id: 'a', title: 'Same song'}, pending = deferred(); let reads = 0;
  const ready = {source: 'local', status: 'ready', contextId: 'native-A', currentIndex: 1, playlist: {id: 'native', name: 'Actual playlist'}, capabilities: {select: false, predictNeighbors: true}, items: [0, 1].map(index => ({key: 'native-A:'+index, index, trackId: 'a', title: 'Same song', playable: true}))};
  const {elements, calls} = await setup({library: {tracks: [track], playlists: []}, selectedSource: 'apple', player: player(track, {source: 'local'}), settings: defaultSettings}, async (channel, payload) => {
    if (channel === 'lyrics:resolve') return {trackId: payload.trackId, status: 'not-found', kind: 'none', lines: []};
    if (channel === 'player:context') return ++reads <= 2 ? ready : pending.promise;
    return null;
  });
  elements.miniCover.click(); await flush(); elements.cabinQueue.click(); await flush();
  const rows = walk(elements.cabinQueueBody).filter(row => row.classList.contains('context-row'));
  assert.equal(rows.length, 2); assert.equal(rows[0].attributes['aria-current'], undefined); assert.equal(rows[1].attributes['aria-current'], 'true');
  assert.notEqual(rows[0].dataset.key, rows[1].dataset.key); assert.equal(rows[1].tagName, 'DIV'); rows[1].click(); await flush();
  assert.ok(calls.filter(call => call.channel === 'player:context').every(call => call.payload.source === 'local'));
  assert.equal(calls.some(call => call.channel.startsWith('queue:') || /player:(play|select)/.test(call.channel)), false);
  elements.cabinQueue.click(); await flush(); elements.cabinLyrics.click(); elements.leaveImmersive.click();
  pending.resolve({...ready, items: [{key: 'late:0', index: 0, title: 'Late list'}]}); await flush();
  assert.equal(findText(elements.cabinQueueBody, 'Late list'), undefined);
});

test('local current list selects duplicate occurrences by token and generation and follows real readback', async () => {
  const track = {id: 'a', title: 'Same song'}, pending = deferred(); let currentIndex = 0, generation = 7;
  const f = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local', generation, revision: 1}), settings: defaultSettings}, async channel => {
    if (channel === 'player:context') return {source: 'local', status: 'ready', contextId: 'actual', selectionToken: 'token', generation, currentIndex,
      capabilities: {select: true}, items: [0, 1].map(index => ({key: `actual:${index}`, index, trackId: 'a', title: 'Same song', playable: true}))};
    if (channel === 'player:play') return pending.promise;
    return null;
  });
  f.elements.miniCover.click(); await flush(); f.elements.cabinQueue.click(); await flush();
  let rows = walk(f.elements.cabinQueueBody).filter(row => row.classList.contains('context-row'));
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.tagName === 'BUTTON')); assert.equal(rows[0].attributes['aria-current'], 'true');
  assert.equal(findClass(f.elements.cabinQueueBody, 'context-index'), undefined);
  rows[1].focus(); assert.equal(f.context.document.activeElement, rows[1]); rows[1].click(); rows[0].click(); await flush();
  assert.equal(rows[1].attributes['aria-busy'], 'true'); assert.equal(rows[0].attributes['aria-current'], 'true');
  assert.deepEqual(f.calls.filter(call => call.channel === 'player:play').map(call => JSON.parse(JSON.stringify(call.payload))),
    [{source: 'local', selectionToken: 'token', itemIndex: 1, generation: 7}]);
  currentIndex = 1; generation = 8; pending.resolve(player(track, {source: 'local', generation, revision: 1})); await flush(); await flush();
  rows = walk(f.elements.cabinQueueBody).filter(row => row.classList.contains('context-row'));
  assert.equal(rows[0].attributes['aria-current'], undefined); assert.equal(rows[1].attributes['aria-current'], 'true');
  assert.ok(findClass(rows[1], 'context-status')); assert.equal(f.context.document.activeElement, rows[1]);
  f.elements.cabinLyrics.click(); rows[0].click(); await flush(); assert.equal(f.calls.filter(call => call.channel === 'player:play').length, 1);
});

test('Apple current list is unnumbered and display-only', async () => {
  const track = {id: 'apple-song', title: 'Song'};
  const f = await setup({library: {tracks: [], playlists: []}, player: player(track, {source: 'apple', generation: 1}), settings: defaultSettings}, async channel => channel === 'player:context'
    ? {source: 'apple', status: 'ready', contextId: 'apple-list', generation: 1, currentIndex: 1, capabilities: {select: true}, items: [0, 1].map(index => ({key: `apple:${index}`, index, title: 'Song', playable: true}))} : null);
  f.elements.miniCover.click(); await flush(); f.elements.cabinQueue.click(); await flush();
  const rows = walk(f.elements.cabinQueueBody).filter(row => row.classList.contains('context-row'));
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.tagName === 'DIV')); assert.equal(rows[1].attributes['aria-current'], 'true');
  assert.equal(findClass(f.elements.cabinQueueBody, 'context-index'), undefined); rows[0].click(); await flush();
  assert.equal(f.calls.some(call => call.channel === 'player:play'), false);
});

test('song lists and details omit numbered columns and headers at every layout breakpoint', async () => {
  const track = {id: 'a', title: 'Song', artist: 'Artist', album: 'Album', duration: 123};
  const f = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local'}), settings: defaultSettings});
  for (const open of [() => {}, () => f.context.StillApp.openDetail({type: 'album', key: 'Album\u0000Artist', title: 'Album'})]) {
    open();
    assert.equal(findClass(f.elements.viewContent, 'track-header'), undefined); assert.equal(findClass(f.elements.viewContent, 'track-number'), undefined);
    const row = findClass(f.elements.viewContent, 'track-row');
    assert.ok(row); assert.ok(findClass(row, 'track-artist')); assert.ok(findClass(row, 'track-album')); assert.ok(findClass(row, 'track-duration'));
  }
  const css = ['styles.css', 'room.css'].map(file => fs.readFileSync(path.join(renderer, file), 'utf8')).join('\n');
  assert.doesNotMatch(css, /track-header|track-number|context-index|track-row[^{}]*>\s*:nth-child/);
  for (const match of css.matchAll(/(?:\.detail-tracks\s+)?\.track-row\s*\{([^}]*grid-template-columns[^}]*)\}/g)) assert.doesNotMatch(match[1], /(?:5ch|24px)\s+minmax/);
});

test('lyric refresh frames stop on pause, cabin switch, and leaving the listening scene', async () => {
  const track = {id: 'a', title: 'Song'};
  const {elements, events, hasAnimationFrame} = await setup({library: {tracks: [track], playlists: []}, player: player(track), settings: defaultSettings}, async channel => channel === 'lyrics:resolve' ? {trackId: 'a', status: 'ready', kind: 'line', lines: [{startMs: 1000, text: 'Line'}]} : {items: []});
  elements.miniCover.click(); await flush(); assert.equal(hasAnimationFrame(), true);
  events.player(player(track, {state: 'paused'})); assert.equal(hasAnimationFrame(), false);
  events.player(player(track)); assert.equal(hasAnimationFrame(), true);
  elements.cabinQueue.click(); await flush(); assert.equal(hasAnimationFrame(), false);
  elements.cabinLyrics.click(); assert.equal(hasAnimationFrame(), true);
  elements.leaveImmersive.click(); assert.equal(hasAnimationFrame(), false);
});

test('portrait resizing preserves long lyric content, text preferences, follow state and playback ownership', async () => {
  const track = {id: 'portrait', title: '这是一个很长的中文曲名'.repeat(6), artist: '艺术家'.repeat(8)};
  const original = '这是很长的逐行歌词，需要自然折行。'.repeat(12), translation = 'This is a long translation that must remain readable. '.repeat(16);
  const settings = {...defaultSettings, lyrics: {...defaultSettings.lyrics, fontSize: 72, translationSize: 48, lineHeight: 3}, appearance: {accentColor: '#000000', reducedMotion: true}};
  const {elements, context, resize, calls} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local'}), settings}, async channel => channel === 'lyrics:resolve' ? {trackId: track.id, status: 'ready', kind: 'line', lines: [{startMs: 0, text: original, translation}]} : null, {width: 600, height: 1000});
  assert.equal(context.document.body.dataset.layout, 'portrait');
  elements.miniCover.click(); await flush();
  const line = findClass(elements.lyricsBody, 'lyric-line');
  assert.ok(findText(line, original)); assert.ok(findText(line, translation));
  assert.equal(elements.lyricsBody.style.values['--lyric-font-size'], '72px');
  assert.equal(elements.lyricsBody.style.values['--translation-size'], '48px');
  elements.lyricsScroll.dispatch('wheel'); assert.equal(elements.resumeFollow.hidden, false);
  const before = calls.length;
  for (const [width, height] of [[464, 560], [480, 1000], [768, 1280], [900, 1440], [1080, 1920], [1440, 2560], [1064, 1889], [1424, 2529]]) {
    resize(width, height); assert.equal(context.document.body.dataset.layout, 'portrait');
    assert.equal(elements.resumeFollow.hidden, false); assert.equal(findClass(elements.lyricsBody, 'lyric-line'), line);
  }
  resize(1173, 601); assert.equal(context.document.body.dataset.layout, 'wide');
  assert.equal(calls.length, before); assert.equal(elements.nowSource.textContent, '本地音乐');
  assert.equal(context.document.body.style.values['--accent'], '#000000');
  assert.equal(calls.some(call => /^(?:player:(?!context$)|audio:|source:)/.test(call.channel)), false);
});

test('explicit diagnostic export captures only the approved layout scalars and the effective motion preference', async () => {
  const {elements, context, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, settings: {...defaultSettings, appearance: {accentColor: '#aabbcc', reducedMotion: false}}, capabilities: {exportDiagnostics: true}}, async channel => channel === 'app:exportDiagnostics' ? {saved: true} : null, {width: 600, height: 1000, devicePixelRatio: 3.25, systemReducedMotion: true});
  context.document.body.scrollWidth = 610;
  context.document.body.append(context.StillApp.node('p', '', 'private content must not be serialized'));
  elements.audioButton.click(); await flush();
  findText(elements.dialogBody, '保存诊断状态').click(); await flush();
  const exported = calls.find(call => call.channel === 'app:exportDiagnostics').payload;
  assert.deepEqual(JSON.parse(JSON.stringify(exported)), {layout: {width: 600, height: 1000, devicePixelRatio: 3.25, horizontalOverflow: true, appReducedMotion: false, systemReducedMotion: true, effectiveReducedMotion: true, accentColor: '#AABBCC'}});
  assert.doesNotMatch(JSON.stringify(exported), /private content/);
  context.innerWidth = 0; assert.equal(context.StillGlass.diagnosticsLayout(), null);
});

for (const panel of ['dialog']) test(`${panel} queue refuses a stale deletion when identical track metadata belongs to a changed backend occurrence`, async () => {
  const track = {id: 'a', title: 'Identical song', artist: 'Same artist'};
  const common = {index: 0, trackId: 'a', title: track.title, artist: track.artist, path: 'C:\\Music\\same.flac', subsong: 0};
  let reads = 0;
  const {elements, calls} = await setup({library: {tracks: [track], playlists: []}, player: player(track), settings: defaultSettings}, async channel => {
    if (channel === 'queue:list') return {items: [{...common, playlistId: ++reads === 1 ? 'deck-A' : 'deck-B', itemIndex: reads === 1 ? 0 : 4}]};
    if (channel === 'lyrics:resolve') return {trackId: track.id, status: 'not-found', kind: 'none', lines: []};
    return null;
  });
  if (panel === 'dialog') { elements.queueButton.click(); await flush(); }
  else { elements.miniCover.click(); await flush(); elements.cabinQueue.click(); await flush(); }
  const body = panel === 'dialog' ? elements.dialogBody : elements.cabinQueueBody;
  const oldRemove = findClass(body, 'row-action'); assert.ok(oldRemove);
  oldRemove.click(); await flush();
  assert.equal(reads, 2);
  assert.equal(calls.some(call => call.channel === 'queue:remove'), false);
  assert.notEqual(findClass(body, 'row-action'), oldRemove);
  assert.match((panel === 'dialog' ? elements.dialogAlert : elements.toast).textContent, /队列已改变/);
});

for (const reduced of ['app', 'system', 'neither']) test(`paused lyric follow realigns once after a portrait reflow and respects ${reduced} reduced motion`, async () => {
  const track = {id: 'paused', title: 'Long portrait lyric'};
  const settings = {...defaultSettings, appearance: {reducedMotion: reduced === 'app'}};
  const {elements, context, resize, hasAnimationFrame} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {state: 'paused', position: 5}), settings}, async channel => channel === 'lyrics:resolve' ? {trackId: track.id, status: 'ready', kind: 'line', lines: [{startMs: 0, text: '长中文歌词'.repeat(30)}]} : null);
  context.matchMedia = () => ({matches: reduced === 'system'});
  elements.miniCover.click(); await flush();
  const line = findClass(elements.lyricsBody, 'lyric-line'), scroll = elements.lyricsScroll;
  let rowTop = 100;
  line.getBoundingClientRect = () => ({top: rowTop});
  scroll.getBoundingClientRect = () => ({top: 20}); scroll.clientHeight = 300;
  elements.resumeFollow.click(); const count = scroll.scrollCalls.length, oldTop = scroll.scrollTop;
  rowTop = 1000; scroll.clientHeight = 500;
  resize(600, 1000); resize(768, 1280); await flush();
  assert.equal(scroll.scrollCalls.length - count, 1);
  assert.equal(scroll.scrollTop, oldTop + 1000 - 20 - 500 * .34);
  assert.equal(scroll.scrollTop, 810);
  assert.equal(scroll.scrollCalls.at(-1).behavior, reduced === 'neither' ? 'smooth' : 'auto');
  assert.equal(findClass(elements.lyricsBody, 'lyric-line'), line);
  assert.equal(hasAnimationFrame(), false);
});

test('resize alignment does not override manual follow, a newly scrolled pane, queue view or the hidden scene', async () => {
  const track = {id: 'paused', title: 'Long portrait lyric'};
  const {elements, resize} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {state: 'paused', position: 5}), settings: defaultSettings}, async channel => channel === 'lyrics:resolve' ? {trackId: track.id, status: 'ready', kind: 'line', lines: [{startMs: 0, text: 'Long lyric'}]} : {items: []});
  elements.miniCover.click(); await flush();
  const scroll = elements.lyricsScroll, line = findClass(elements.lyricsBody, 'lyric-line');
  line.getBoundingClientRect = () => ({top: 1000}); scroll.getBoundingClientRect = () => ({top: 20}); scroll.clientHeight = 500;
  scroll.dispatch('wheel'); const manualCount = scroll.scrollCalls.length;
  resize(600, 1000); await flush();
  assert.equal(scroll.scrollCalls.length, manualCount); assert.equal(elements.resumeFollow.hidden, false);
  elements.resumeFollow.click(); const beforeRace = scroll.scrollCalls.length;
  resize(768, 1280); scroll.dispatch('wheel'); await flush();
  assert.equal(scroll.scrollCalls.length, beforeRace);
  elements.resumeFollow.click(); const beforeQueue = scroll.scrollCalls.length;
  elements.cabinQueue.click(); await flush(); resize(900, 1440); await flush();
  assert.equal(scroll.scrollCalls.length, beforeQueue);
  elements.cabinLyrics.click(); elements.leaveImmersive.click(); const beforeHidden = scroll.scrollCalls.length;
  resize(480, 1000); await flush(); assert.equal(scroll.scrollCalls.length, beforeHidden);
});

test('legacy accent tokens resolve on the body with every raw colour while danger and warning remain independent', async () => {
  const {elements, context} = await setup({library: {tracks: [], playlists: []}, player: offline, settings: defaultSettings, capabilities: {persistUIState: true}});
  elements.audioButton.click(); await flush(); findText(elements.dialogBody, '光线与外观').click(); await flush();
  const picker = findClass(elements.dialogBody, 'accent-picker');
  for (const color of ['#000000', '#FFFFFF', '#123456', '#F2A89D']) {
    picker.value = color; picker.dispatch('input');
    const expected = context.StillGlass.deriveAccent(color).readable, variables = context.document.body.style.values;
    assert.equal(variables['--accent'], color);
    assert.equal(variables['--accent-readable'], expected);
    assert.equal(variables['--amber'], expected);
    assert.equal(variables['--amber-soft'], expected);
    assert.equal(Object.hasOwn(variables, '--danger'), false);
    assert.equal(Object.hasOwn(variables, '--warning'), false);
  }
  const css = fs.readFileSync(path.join(renderer, 'room.css'), 'utf8');
  assert.match(css, /\.button\.danger\s*\{\s*color:#ffb8ae;/);
  assert.match(css, /\.dialog-alert\s*\{[^}]*color:#ffdbab;/);
});

test('listening sleeves use real playback-context neighbors and native next without rebuilding a playlist', async () => {
  const tracks = Array.from({length: 7}, (_, i) => ({id: 'n'+i, title: 'Song '+i, coverUrl: 'data:image/png;base64,'+i+'A=='}));
  const pending = deferred(); let index = 3;
  const {elements, calls, events} = await setup({library: {tracks: [{id: 'unrelated', title: 'Wrong library preview'}], playlists: []}, player: player(tracks[index], {source: 'local'}), settings: defaultSettings}, async (channel, payload) => {
    if (channel === 'player:next') return pending.promise;
    if (channel === 'player:context') return {source: 'local', status: 'ready', contextId: 'actual:'+index, currentIndex: index, capabilities: {select: false, predictNeighbors: true}, items: tracks.map((track, i) => ({...track, trackId: track.id, index: i, key: 'actual:'+index+':'+i, playable: true}))};
    if (channel === 'lyrics:resolve') return {trackId: payload.trackId, status: 'not-found', kind: 'none', lines: []};
    return null;
  });
  elements.nowTitle.click(); await flush();
  const cards = walk(elements.sleeveNeighbors).filter(item => item.classList.contains('sleeve-neighbor'));
  assert.equal(cards.length, 4); assert.deepEqual(cards.map(card => card.title).sort(), [1,2,4,5].map(i => 'Song '+i));
  const far = cards.find(card => card.classList.contains('sleeve-outer')); assert.equal(far.tagName, 'DIV'); far.click();
  const next = cards.find(card => card.classList.contains('sleeve-next') && !card.classList.contains('sleeve-outer'));
  next.click(); await flush(); assert.equal(elements.immersiveTitle.textContent, 'Song 3');
  assert.equal(calls.filter(call => call.channel === 'player:next').length, 1); assert.equal(calls.some(call => call.channel === 'player:play'), false);
  index = 4; pending.resolve(player(tracks[index], {source: 'local'})); await flush();
  assert.equal(elements.immersiveTitle.textContent, 'Song 4'); next.click(); await flush();
  assert.equal(calls.filter(call => call.channel === 'player:next').length, 1);
  const localCard = walk(elements.sleeveNeighbors).find(card => card.tagName === 'BUTTON');
  events.player(player({id: 'apple-id', title: 'Apple track'}, {source: 'apple'})); localCard.click(); await flush();
  assert.equal(elements.sleeveNeighbors.children.length, 0); assert.equal(calls.filter(call => call.channel === 'player:next').length, 1);
});

test('one native wave-seek remains in the footer and polling never steals a drag or duplicates its commit', async () => {
  const track = {id: 'song', title: 'Song'}, {elements, calls, resize, events} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local'}), settings: defaultSettings});
  const original = elements.transport, handlers = elements.seek.listeners.change.length;
  elements.nowTitle.click(); await flush(); assert.equal(original.parentElement, elements.playerCenter);
  elements.seek.getBoundingClientRect = () => ({left: 20, width: 400}); elements.seek.dispatch('pointermove', {clientX: 220});
  assert.equal(elements.seek.title, '0:10'); assert.equal(calls.some(call => call.channel === 'player:seek'), false);
  elements.seek.value = '12.3'; elements.seek.dispatch('input');
  assert.equal(elements.waveSeek.style.values['--seek-progress'], '61.5%');
  resize(464, 800); events.player(player(track, {source: 'local', position: 2})); await flush();
  assert.equal(elements.seek.value, '12.3'); assert.equal(elements.waveSeek.style.values['--seek-progress'], '61.5%');
  assert.equal(original.parentElement, elements.playerCenter); elements.seek.dispatch('change'); await flush();
  assert.equal(elements.seek.listeners.change.length, handlers); assert.equal(handlers, 1);
  assert.equal(calls.filter(call => call.channel === 'player:seek').length, 1); assert.equal(calls.find(call => call.channel === 'player:seek').payload.position, 12.3);
  resize(1672, 941); elements.leaveImmersive.click(); await flush(); assert.equal(original.parentElement, elements.playerCenter);
  assert.equal(elements.immersiveTransport, undefined);
  events.player(player(track, {source: 'local', duration: 0})); assert.equal(elements.seek.disabled, true); assert.equal(elements.waveSeek.classList.contains('disabled'), true);
  elements.seek.dispatch('change'); await flush(); assert.equal(calls.filter(call => call.channel === 'player:seek').length, 1);
});

test('lyric failure exposes a small recovery state and force retry, with raw error only inside details', async () => {
  const track = {id: 'a', title: 'Song'}; let attempts = 0;
  const {elements, calls} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local'}), settings: defaultSettings}, async (channel, payload) => {
    if (channel !== 'lyrics:resolve') return null;
    attempts++;
    return attempts === 1 ? {trackId: payload.trackId, status: 'network-error', error: 'LRCLIB HTTP 502', lines: []} : {trackId: payload.trackId, status: 'ready', kind: 'line', lines: [{timeMs: 0, text: 'Recovered lyrics'}]};
  });
  elements.nowTitle.click(); await flush();
  assert.ok(findText(elements.lyricsBody, '歌词暂时无法获取'));
  const details = findClass(elements.lyricsBody, 'lyric-error-details'); assert.equal(details.tagName, 'DETAILS'); assert.equal(details.open, false);
  assert.match(details.textContent, /HTTP 502/);
  findText(elements.lyricsBody, '重试').click(); await flush();
  assert.equal(calls.filter(call => call.channel === 'lyrics:resolve').at(-1).payload.force, true);
  assert.equal(elements.lyricsBody.classList.contains('lyrics-status-body'), false);
  assert.ok(findText(elements.lyricsBody, 'Recovered lyrics'));
});

test('no-spectrum seek stays static and usable without manufactured band motion or audio calls', async () => {
  const track = {id: 'a', title: 'Song'}, {elements, events, calls, hasAnimationFrame} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local'}), settings: defaultSettings});
  assert.equal(elements.footerWave.children.length, 0); assert.equal(elements.footerWave.classList.contains('spectrum-empty'), true);
  assert.equal(elements.cabinWave, undefined); assert.equal(elements.seek.disabled, false);
  events.player(player(track, {source: 'local', state: 'paused'})); assert.equal(elements.footerWave.children.length, 0);
  assert.equal(hasAnimationFrame(), false); assert.equal(calls.some(call => /^(player:|audio:)/.test(call.channel)), false);
});

test('Apple art accepts only the registered protocol and stale image errors cannot clear a newer cover', async () => {
  const {context, elements} = await setup({library: {tracks: [], playlists: []}, player: offline, settings: defaultSettings});
  const first = 'still-apple-art://art/' + 'a'.repeat(64), second = 'still-apple-art://art/' + 'b'.repeat(64);
  context.StillApp.cover(elements.largeCover, first); const old = elements.largeCover.children[0];
  assert.equal(old.src, first);
  context.StillApp.cover(elements.largeCover, second); old.dispatch('error');
  assert.equal(elements.largeCover.children[0].src, second);
  for (const value of ['https://example.com/cover.jpg', 'still-apple-art://art/'+'a'.repeat(63), first+'?url=https://example.com', 'still-apple-art://art/'+'A'.repeat(64)]) {
    context.StillApp.cover(elements.largeCover, value); assert.equal(elements.largeCover.children[0].tagName, 'SVG');
  }
});

test('Apple external lyrics use namespaced public metadata keys and reject late results after a fast song switch', async () => {
  const first = {id: '123', title: 'First Apple', artist: 'Artist', type: 'songs'}, second = {id: 'i.second', title: 'Second Apple', artist: 'Artist', type: 'library-songs'};
  const pending = deferred();
  const {elements, events, calls} = await setup({library: {tracks: [{id: '123', title: 'Unrelated local'}], playlists: []}, player: player(first, {source: 'apple'}), settings: defaultSettings, capabilities: {externalLyrics: true}}, async (channel, payload) => {
    if (channel === 'lyrics:resolve') return payload.trackId === 'apple:songs:123' ? pending.promise : {trackId: payload.trackId, status: 'ready', kind: 'line', lines: [{startMs: 0, text: 'Second Apple lyrics'}]};
    if (channel === 'lyrics:search') return {status: 'not-found', results: []};
    return null;
  });
  elements.nowTitle.click(); await flush();
  assert.equal(calls.find(call => call.channel === 'lyrics:resolve').payload.trackId, 'apple:songs:123');
  events.player(player(second, {source: 'apple'})); await flush();
  assert.ok(findText(elements.lyricsBody, 'Second Apple lyrics'));
  pending.resolve({trackId: 'apple:songs:123', status: 'ready', kind: 'line', lines: [{startMs: 0, text: 'Old Apple lyrics'}]}); await flush();
  assert.equal(findText(elements.lyricsBody, 'Old Apple lyrics'), undefined);
  elements.findLyrics.click(); await flush();
  assert.equal(calls.find(call => call.channel === 'lyrics:search').payload.trackId, 'apple:library-songs:i.second');
  assert.equal(calls.some(call => call.channel === 'lyrics:resolve' && call.payload.trackId === '123'), false);
});

test('Apple external lyrics remain off without the application capability, independent of SDK claims', async () => {
  const track = {id: '123', title: 'Apple', artist: 'Artist'};
  const {elements, calls} = await setup({library: {tracks: [], playlists: []}, player: player(track, {source: 'apple'}), settings: defaultSettings, sources: {apple: {capabilities: {lyrics: true}}}});
  elements.nowTitle.click(); await flush();
  assert.equal(elements.findLyrics.disabled, true);
  assert.equal(calls.some(call => call.channel.startsWith('lyrics:')), false);
});




test('existing refresh can retry a failed visible cover at the identical safe URL', async () => {
  const url = 'still-apple-art://art/' + 'a'.repeat(64);
  const {context, elements, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, settings: defaultSettings});
  context.StillApp.cover(elements.largeCover, url, 'album'); elements.largeCover.children[0].dispatch('error');
  assert.equal(elements.largeCover.dataset.coverFailed, url);
  const originalQuery = context.document.querySelectorAll;
  context.document.querySelectorAll = selector => selector === '[data-cover-failed]' ? [elements.largeCover] : originalQuery(selector);
  elements.refreshButton.click(); await flush();
  const image = elements.largeCover.children[0]; assert.equal(image.tagName, 'IMG'); assert.equal(image.src, url);
  image.dispatch('load'); assert.equal(elements.largeCover.dataset.coverFailed, undefined);
  assert.equal(calls.filter(call => call.channel === 'library:refresh').length, 1);
  assert.equal(calls.some(call => call.channel.startsWith('player:')), false);
});

test('a sleeve swipe calls real next once, waits for readback, and source changes or blur cancel old gestures', async () => {
  const a = {id: 'a', title: 'A'}, b = {id: 'b', title: 'B'}, pending = deferred();
  const {elements, calls, events, blur} = await setup({library: {tracks: [a, b], playlists: []}, player: player(a, {source: 'local', generation: 1, revision: 1}), settings: defaultSettings}, async channel => channel === 'player:next' ? pending.promise : null);
  elements.miniCover.click(); await flush(); const deck = elements.listeningDeck;
  deck.getBoundingClientRect = () => ({width: 300});
  const begin = () => deck.dispatch('pointerdown', {pointerId: 1, clientX: 150, clientY: 80, isPrimary: true, button: 0});
  const move = () => deck.dispatch('pointermove', {pointerId: 1, clientX: 65, clientY: 85});
  begin(); move(); blur(); deck.dispatch('pointerup', {pointerId: 1}); assert.equal(calls.some(call => call.channel === 'player:next'), false);
  begin(); move(); deck.dispatch('pointerup', {pointerId: 1}); deck.dispatch('pointerup', {pointerId: 1}); await flush();
  assert.equal(calls.filter(call => call.channel === 'player:next').length, 1); assert.equal(elements.immersiveTitle.textContent, 'A');
  assert.equal(deck.dispatch('click', {detail: 1}).stopped, true);
  pending.resolve(player(b, {source: 'local', generation: 2, revision: 1})); await flush(); assert.equal(elements.immersiveTitle.textContent, 'B');
  begin(); move(); events.player(player({id: 'apple', title: 'Apple'}, {source: 'apple', generation: 3, revision: 1})); deck.dispatch('pointerup', {pointerId: 1}); await flush();
  assert.equal(calls.filter(call => call.channel === 'player:next').length, 1); assert.equal(calls.some(call => call.channel === 'player:play'), false);
});

test('playback order stays in the footer while lyric tools and temporary queue survive nested dialogs', async () => {
  const track = {id: 'a', title: 'A'}, {elements, calls, events, context} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local'}), settings: defaultSettings, capabilities: {persistUIState: true}});
  for (const id of ['playerLyrics', 'playerAudio', 'playerQueue', 'immersiveTransport', 'cabinWave']) { assert.equal(elements[id], undefined); assert.equal(context.document.getElementById(id), null); }
  assert.ok(walk(elements.playerFooter).includes(elements.playbackOrder));
  elements.settingsControlsHome.replaceChildren(); assert.equal(context.document.getElementById('playbackOrder'), elements.playbackOrder);
  elements.settingsControlsHome.append(elements.settingsPlaybackControls);
  elements.audioButton.click(); await flush();
  assert.ok(walk(elements.dialogBody).includes(elements.settingsPlaybackControls));
  for (const element of [elements.lyricsTools, elements.findLyrics, elements.importLyrics, elements.queueButton]) assert.ok(walk(elements.settingsPlaybackControls).includes(element));
  assert.ok(!walk(elements.settingsPlaybackControls).includes(elements.playbackOrder));
  findText(elements.dialogBody, '光线与外观').click(); await flush();
  assert.equal(elements.settingsPlaybackControls.parentElement, elements.settingsControlsHome);
  events.player(player(track, {source: 'local', playbackOrders: [{id: 0, name: '默认'}], playbackOrder: {id: 0}}));
  assert.equal(elements.playbackOrder.children[0].value, '0');
  elements.closeDialog.click(); assert.equal(elements.settingsPlaybackControls.parentElement, elements.settingsControlsHome);
  assert.equal(calls.some(call => /player:(play|toggle|next|previous)/.test(call.channel)), false);
});

test('lyric settings opened from the library load the actual current offset and reject a detached old-track apply', async () => {
  const a = {id: 'a', title: 'A'}, b = {id: 'b', title: 'B'};
  const {elements, events, calls} = await setup({library: {tracks: [a, b], playlists: []}, player: player(a, {source: 'local'}), settings: defaultSettings}, async (channel, payload) => channel === 'lyrics:resolve' ? {trackId: payload.trackId, status: 'ready', kind: 'line', offsetMs: 600, bound: true, lines: [{startMs: 0, text: 'Line'}]} : null);
  elements.audioButton.click(); await flush(); elements.lyricsTools.click(); await flush();
  const input = walk(elements.dialogBody).find(item => item.type === 'number'), apply = findText(elements.dialogBody, '应用');
  assert.equal(input.value, '600'); assert.equal(input.disabled, false);
  events.player(player(b, {source: 'local'})); input.value = '800'; apply.click(); await flush();
  assert.equal(calls.some(call => call.channel === 'lyrics:offset'), false); assert.equal(elements.dialog.open, false);
});

test('none-mode persistence keeps original image URLs and remembers the previous selected colour', async () => {
  const track = {id: 'a', title: 'A', coverUrl: 'data:image/png;base64,AA=='}, settings = {...defaultSettings, appearance: {accentColor: '#E5C49B', accentMode: 'none'}};
  const {elements, context, calls} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local'}), settings, capabilities: {persistUIState: true}}, async (channel, payload) => channel === 'settings:update' ? {...settings, appearance: {...settings.appearance, ...payload.patch.appearance}} : null);
  const original = elements.miniCover.children[0]; assert.equal(context.document.body.dataset.accentMode, 'none');
  assert.equal(context.document.body.style.values['--accent'], '#C7CDD6');
  elements.audioButton.click(); await flush(); findText(elements.dialogBody, '光线与外观').click(); await flush();
  const mode = walk(elements.dialogBody).find(item => item.dataset.mode === 'color'); mode.click(); await flush();
  assert.equal(context.document.body.dataset.accentMode, 'color'); assert.equal(context.document.body.style.values['--accent'], '#E5C49B');
  assert.equal(elements.miniCover.children[0], original); assert.equal(original.src, track.coverUrl);
  const saved = calls.find(call => call.channel === 'settings:update'); assert.deepEqual(JSON.parse(JSON.stringify(saved.payload.patch.appearance)), {accentColor: '#E5C49B', accentMode: 'color'});
});

test('the live backdrop adapter commits decoded current artwork and a late image cannot cover a newer track', async () => {
  const a = {id: 'a', title: 'A', coverUrl: 'data:image/png;base64,AA=='}, b = {id: 'b', title: 'B', coverUrl: 'data:image/png;base64,BB=='}, c = {id: 'c', title: 'C', coverUrl: 'data:image/png;base64,CC=='};
  const {images, elements, context, events} = await setup({library: {tracks: [a, b, c], playlists: []}, player: player(a, {source: 'local', generation: 1, revision: 1}), settings: defaultSettings});
  const first = images.find(image => image.classList.contains('backdrop-image') && image.src === a.coverUrl); first.decode = () => Promise.resolve(); first.dispatch('load'); await flush();
  assert.equal(context.document.body.classList.contains('has-cover-backdrop'), true); assert.equal(elements.coverBackdropB.children[0], first);
  const late = deferred(); events.player(player(b, {source: 'local', generation: 2, revision: 1})); await flush();
  const second = images.find(image => image.classList.contains('backdrop-image') && image.src === b.coverUrl); second.decode = () => late.promise; second.dispatch('load');
  events.player(player(c, {source: 'local', generation: 3, revision: 1})); await flush();
  const third = images.find(image => image.classList.contains('backdrop-image') && image.src === c.coverUrl); third.decode = () => Promise.resolve(); third.dispatch('load'); await flush();
  late.resolve(); await flush(); assert.equal(elements.coverBackdropA.children[0], third); assert.equal(elements.coverBackdropA.style.opacity, '1'); assert.equal(elements.coverBackdropB.style.opacity, '0');
});

test('interrupted backdrop fades retain visible older artwork while the newest decoded track arrives', async () => {
  const tracks = ['a', 'b', 'c', 'd'].map((id, index) => ({id, title: id, coverUrl: `data:image/png;base64,${index}A==`}));
  const {images, elements, context, events} = await setup({library: {tracks, playlists: []}, player: player(tracks[0], {source: 'local', generation: 1, revision: 1}), settings: defaultSettings});
  const show = async (track, generation) => {
    if (generation > 1) {events.player(player(track, {source: 'local', generation, revision: 1})); await flush();}
    const image = images.find(item => item.classList.contains('backdrop-image') && item.src === track.coverUrl);
    image.decode = () => Promise.resolve(); image.dispatch('load'); await flush(); return image;
  };
  const first = await show(tracks[0], 1), second = await show(tracks[1], 2);
  assert.equal(elements.coverBackdropB.children[0], first);
  assert.equal(elements.coverBackdropA.children[0], second);
  // Chromium reports the intermediate opacity rather than the final inline target.
  let opacity = new Map([[elements.coverBackdropA, '.2'], [elements.coverBackdropB, '.8'], [elements.coverBackdropC, '0']]);
  context.getComputedStyle = element => ({opacity: opacity.get(element) ?? '0'});
  const third = await show(tracks[2], 3);
  assert.equal(elements.coverBackdropC.children[0], third);
  assert.equal(elements.coverBackdropA.children[0], second);
  assert.equal(elements.coverBackdropB.children[0], first);
  opacity = new Map([[elements.coverBackdropA, '.6'], [elements.coverBackdropB, '.3'], [elements.coverBackdropC, '.1']]);
  const fourth = await show(tracks[3], 4);
  assert.equal(elements.coverBackdropB.children[0], fourth);
  assert.equal(elements.coverBackdropA.children[0], second);
  assert.equal(elements.coverBackdropC.children[0], third);
  assert.equal(context.StillApp.state.player.currentTrackId, 'd');
});

test('rapid confirmed playback changes replace visual feedback and system reduced motion cancels it', async () => {
  const listeners = new Set(), media = {matches: false, addEventListener: (type, callback) => { if (type === 'change') listeners.add(callback); }, removeEventListener: (_type, callback) => listeners.delete(callback)};
  const tracks = ['a', 'b', 'c', 'd'].map(id => ({id, title: id, coverUrl: 'data:image/png;base64,AA=='}));
  const {elements, events, context} = await setup({library: {tracks, playlists: []}, player: player(tracks[0], {source: 'local', state: 'paused', generation: 1, revision: 1}), settings: defaultSettings}, undefined, {motionMedia: media});
  const created = [];
  const animate = () => {
    const pending = deferred(), record = {cancelled: false};
    record.animation = {finished: pending.promise, cancel() { record.cancelled = true; pending.reject(new Error('cancelled')); }};
    created.push(record); return record.animation;
  };
  elements.nowTitle.parentElement.animate = animate;
  elements.toggleIcon.parentElement.animate = animate;
  events.player(player(tracks[1], {source: 'local', state: 'playing', generation: 2, revision: 1}));
  assert.equal(created.length, 2);
  events.player(player(tracks[2], {source: 'local', state: 'paused', generation: 3, revision: 1}));
  assert.equal(created.length, 4);
  assert.ok(created[0].cancelled && created[1].cancelled);
  media.matches = true; for (const listener of listeners) listener({matches: true});
  assert.ok(created[2].cancelled && created[3].cancelled);
  events.player(player(tracks[3], {source: 'local', state: 'playing', generation: 4, revision: 1})); await flush();
  assert.equal(created.length, 4);
  assert.equal(context.StillApp.state.player.currentTrackId, 'd');
  assert.equal(elements.toggleIcon.attributes.href, '#i-pause');
});

test('system reduced motion immediately cancels an in-flight listening cover transition', async () => {
  const listeners = new Set(), media = {matches: false, addEventListener: (type, callback) => { if (type === 'change') listeners.add(callback); }, removeEventListener: (_type, callback) => listeners.delete(callback)};
  const a = {id: 'a', title: 'A', coverUrl: 'data:image/png;base64,AA=='}, b = {id: 'b', title: 'B', coverUrl: 'data:image/png;base64,BB=='};
  const {elements, events} = await setup({library: {tracks: [a, b], playlists: []}, player: player(a, {source: 'local', state: 'paused', generation: 1, revision: 1}), settings: defaultSettings}, undefined, {motionMedia: media});
  let starts = 0, cancels = 0;
  elements.miniCover.getBoundingClientRect = () => ({left: 20, top: 540, width: 50, height: 50});
  elements.largeCover.getBoundingClientRect = () => ({left: 800, top: 120, width: 250, height: 250});
  elements.largeCover.animate = () => {
    starts++; const pending = deferred();
    return {finished: pending.promise, cancel() { cancels++; pending.reject(new Error('cancelled')); }};
  };
  elements.nowTitle.click(); await flush(); assert.equal(starts, 1);
  media.matches = true; for (const listener of listeners) listener({matches: true});
  assert.equal(cancels, 1);
  events.player(player(b, {source: 'local', state: 'paused', generation: 2, revision: 1})); await flush();
  assert.equal(starts, 1);
  assert.equal(elements.immersiveTitle.textContent, 'B');
});

test('audio settings separate official Apple shared output from local device selection', async () => {
  const apple = {provider: 'officialWeb', audioOutput: {path: 'webview2-system', mode: 'shared', exclusiveSupported: false, bitPerfectVerified: false}};
  const outputs = {outputs: [{id: 'local-output', typeName: 'Local', name: 'Device'}], selected: {id: 'local-output'}};
  const {elements} = await setup({library: {tracks: [], playlists: []}, player: offline, sources: {local: {available: false}, apple}, settings: defaultSettings}, async channel => channel === 'audio:outputs' ? outputs : null);
  elements.audioButton.click(); await flush();
  assert.ok(findText(elements.dialogBody, 'Apple Music 输出'));
  assert.ok(findText(elements.dialogBody, '系统共享输出 · 跟随 Windows 为网页播放器分配的输出；使用 USB 设备需在 Windows 中设置。下方本地输出选择不会改变 Apple Music。'));
  assert.ok(findText(elements.dialogBody, '官方网页适配器不支持 WASAPI 独占，不能据此确认无损或 bit-perfect。'));
  assert.ok(findText(elements.dialogBody, '本地音乐输出设备'));
  assert.equal(walk(elements.dialogBody).filter(element => element.tagName === 'SELECT' && element.id === 'outputSelect').length, 1);
  assert.equal(elements.outputSelect, undefined); // This select is created when the dialog opens.
  assert.equal(walk(elements.dialogBody).find(element => element.id === 'outputSelect').value, 'local-output');
});

test('missing saved output stays readable and requires an explicit successful device selection', async () => {
  const outputs = {outputs: [{id: 'new-device', typeName: 'Output', name: 'DX1 II'}], selected: {id: 'old-device', name: 'DX1 II'}};
  let selections = 0;
  const {elements, calls} = await setup({library: {tracks: [], playlists: []}, player: offline, sources: {local: {available: false}}, settings: defaultSettings}, async channel => {
    if (channel === 'audio:outputs') return outputs;
    if (channel === 'audio:select') return ++selections === 1 ? null : {selected: {id: 'new-device'}};
    return null;
  });
  elements.audioButton.click(); await flush();
  const select = walk(elements.dialogBody).find(element => element.id === 'outputSelect');
  const placeholder = select.children.find(option => option.value === '');
  assert.equal(placeholder.textContent, '已保存设备不可用，请重新选择');
  assert.equal(placeholder.disabled, true); assert.equal(select.value, '');
  assert.equal(calls.some(call => call.channel === 'audio:select'), false);
  select.value = 'new-device'; select.dispatch('change'); await flush();
  assert.equal(select.value, '');
  select.value = 'new-device'; select.dispatch('change'); await flush();
  assert.equal(select.value, 'new-device');
  assert.equal(calls.filter(call => call.channel === 'audio:select').length, 2);
});

test('verified local standby enables only an explicit known target, without enabling stale transport controls', async () => {
  const track = {id: 'a', title: 'A'}, local = {status: 'standby', available: false, backendReachable: false, connected: false, capabilities: {playback: false, canStartOnDemand: true}};
  const {elements, calls} = await setup({library: {tracks: [track], playlists: []}, player: offline, sources: {local}, settings: defaultSettings});
  assert.equal(elements.connectionText.textContent, '本地内核待命'); assert.equal(elements.connection.classList.contains('online'), false);
  assert.equal(elements.toggle.disabled, true); assert.equal(elements.seek.disabled, true); assert.equal(elements.volume.disabled, true);
  const play = findClass(elements.viewContent, 'track-play'); assert.equal(play.disabled, false);
  assert.equal(calls.some(call => call.channel.startsWith('player:')), false); play.click(); await flush();
  const request = calls.find(call => call.channel === 'player:play'); assert.equal(request.payload.source, 'local'); assert.equal(request.payload.trackId, 'a');
  assert.equal(calls.some(call => call.channel === 'backend:retry'), false);
  const unverified = await setup({library: {tracks: [track], playlists: []}, player: offline, sources: {local: {...local, capabilities: {playback: false}}}, settings: defaultSettings});
  assert.equal(findClass(unverified.elements.viewContent, 'track-play').disabled, true);
});

test('an unknown current context clears both the list and neighbor previews instead of retaining an old playlist', async () => {
  const track = {id: 'a', title: 'A'}; let reads = 0;
  const ready = {source: 'local', status: 'ready', contextId: 'real', generation: 1, currentIndex: 0, playlist: null, capabilities: {select: false, predictNeighbors: true}, items: [{key: 'real:0', index: 0, trackId: 'a', title: 'A', playable: true}, {key: 'real:1', index: 1, trackId: 'b', title: 'B', playable: true}]};
  const {elements, events, advance} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local', generation: 1, revision: 1}), settings: defaultSettings}, async channel => channel === 'player:context' ? (++reads <= 2 ? ready : {source: 'local', status: 'unknown', currentIndex: null, items: [], capabilities: {select: false}}) : null);
  elements.miniCover.click(); await flush(); elements.cabinQueue.click(); await flush();
  assert.equal(findClass(elements.cabinQueueBody, 'context-heading'), undefined); assert.ok(findText(elements.cabinQueueBody, 'B'));
  assert.equal(elements.sleeveNeighbors.children.length, 1);
  advance(2100); events.player(player(track, {source: 'local', generation: 1, revision: 2, position: 4})); await flush();
  assert.equal(findText(elements.cabinQueueBody, 'B'), undefined); assert.ok(findText(elements.cabinQueueBody, '暂无播放列表'));
  assert.equal(elements.sleeveNeighbors.children.length, 0);
});

test('a new generation of the same track cancels the old seek and realigns lyrics to actual readback', async () => {
  const track = {id: 'a', title: 'A'}, {elements, events, calls} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local', generation: 1, revision: 1, state: 'paused', position: 5}), settings: defaultSettings}, async channel => channel === 'lyrics:resolve' ? {trackId: 'a', status: 'ready', kind: 'line', lines: [{startMs: 0, text: 'Start'}, {startMs: 4000, text: 'Later'}]} : null);
  elements.miniCover.click(); await flush(); elements.lyricsScroll.dispatch('wheel'); assert.equal(elements.resumeFollow.hidden, false);
  elements.seek.dispatch('pointerdown'); elements.seek.value = '12'; elements.seek.dispatch('input');
  events.player(player(track, {source: 'local', generation: 2, revision: 1, state: 'paused', position: .2})); await flush();
  assert.equal(elements.seek.value, '0.2'); assert.equal(elements.resumeFollow.hidden, true);
  elements.seek.dispatch('change'); await flush(); assert.equal(calls.some(call => call.channel === 'player:seek'), false);
});

test('a duplicate-track occurrence change cancels a seek without confusing identical track IDs', async () => {
  const track = {id: 'a', title: 'Repeated'}; let index = 0;
  const {elements, events, calls, advance} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local', generation: 1, revision: 1}), settings: defaultSettings}, async channel => channel === 'player:context' ? {source: 'local', status: 'ready', contextId: 'playlist', generation: 1, currentIndex: index, capabilities: {select: false, predictNeighbors: true}, items: [0, 1].map(i => ({key: 'playlist:'+i, index: i, trackId: 'a', title: 'Repeated', playable: true}))} : null);
  elements.miniCover.click(); await flush();
  elements.seek.dispatch('pointerdown'); elements.seek.value = '12'; elements.seek.dispatch('input'); index = 1;
  advance(2100); events.player(player(track, {source: 'local', generation: 1, revision: 2, position: .4})); await flush();
  assert.equal(elements.seek.value, '0.4'); elements.seek.dispatch('change'); await flush();
  assert.equal(calls.some(call => call.channel === 'player:seek'), false);
});

test('spectrum polling is capability-gated, single-flight, and stops flat on hidden, Apple or paused state', async () => {
  const packet = require('./renderer-spectrum.fixture.json'), track = {id: 'fft-track', title: 'FFT fixture'}, first = deferred(), late = deferred(); let reads = 0;
  const f = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local', generation: 7, revision: 1}), settings: defaultSettings, capabilities: {spectrum: true}}, async channel => {
    if (channel !== 'player:spectrum') return null;
    reads++; return reads === 1 ? first.promise : reads === 2 ? {...packet, sequence: 1} : late.promise;
  });
  assert.equal(f.elements.footerWave.children.length, 0, 'capability alone is not data');
  f.runTimers(); await flush(); assert.equal(reads, 1);
  f.advance(120); f.runTimers(); await flush(); assert.equal(reads, 1, 'no overlapping request');
  first.resolve({...packet, ageMs: 10}); await flush(); f.advance(16);
  assert.equal(f.elements.footerWave.children.length, 48); assert.equal(f.elements.footerWavePlayed.children.length, 48);
  const bars = [...f.elements.footerWave.children];
  f.runTimers(); await flush(); assert.equal(reads, 2);
  f.context.document.hidden = true; f.dispatchDocument('visibilitychange'); assert.deepEqual(f.elements.footerWave.children, bars);
  assert.ok(bars.every(bar => Number(bar.style.values['--band-level']) === 0));
  f.advance(500); f.runTimers(); await flush(); assert.equal(reads, 2);
  f.events.player(player(track, {source: 'apple', generation: 8, revision: 1})); f.context.document.hidden = false; f.dispatchDocument('visibilitychange'); f.runTimers(); await flush(); assert.equal(reads, 2);
  f.events.player(player(track, {source: 'local', generation: 9, revision: 1})); f.runTimers(); await flush(); assert.equal(reads, 3);
  f.events.player(player(track, {source: 'local', state: 'paused', generation: 9, revision: 2}));
  late.resolve({...packet, generation: 9, streamId: 'b'.repeat(64), sequence: 2, ageMs: 0}); await flush();
  assert.deepEqual(f.elements.footerWave.children, bars); assert.ok(bars.every(bar => Number(bar.style.values['--band-level']) === 0));
  assert.equal(f.elements.seek.disabled, false, 'paused seek still works');
  assert.ok(f.calls.filter(call => call.channel === 'player:spectrum').every(call => Object.keys(call.payload).length === 0));
  assert.equal(f.calls.some(call => /^player:(play|toggle|seek|next|previous)$/.test(call.channel)), false);
});

test('a slow spectrum IPC reply is already expired and missing capability never probes the channel', async () => {
  const packet = require('./renderer-spectrum.fixture.json'), track = {id: 'fft-track', title: 'FFT fixture'}, delayed = deferred();
  const f = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local', generation: 7, revision: 1}), settings: defaultSettings, capabilities: {spectrum: true}}, async channel => channel === 'player:spectrum' ? delayed.promise : null);
  f.runTimers(); await flush(); f.advance(260); delayed.resolve({...packet, ageMs: 0}); await flush();
  assert.equal(f.elements.footerWave.children.length, 0); assert.equal(f.elements.footerWave.classList.contains('spectrum-empty'), true);
  const absent = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local', generation: 7, revision: 1}), settings: defaultSettings});
  absent.runTimers(); absent.advance(500); absent.runTimers(); await flush();
  assert.equal(absent.calls.some(call => call.channel === 'player:spectrum'), false);
  const standby = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local', generation: 7, revision: 1}), settings: defaultSettings, capabilities: {spectrum: true}, sources: {local: {status: 'standby', available: false, backendReachable: false, capabilities: {canStartOnDemand: true}}}});
  standby.runTimers(); await flush(); assert.equal(standby.calls.some(call => call.channel === 'player:spectrum'), false);
});

test('a volume drag from the former source cannot change the newly active backend', async () => {
  const track = {id: 'a', title: 'A'}, {elements, calls, events} = await setup({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local', generation: 1, revision: 1}), settings: defaultSettings, sources: {apple: {capabilities: {controls: {volume: true}}}}});
  elements.volume.dispatch('pointerdown'); elements.volume.value = '.9'; elements.volume.dispatch('input');
  events.player(player({id: 'apple', title: 'Apple'}, {source: 'apple', generation: 2, revision: 1, volume: .4}));
  assert.equal(elements.volume.value, '0.4'); elements.volume.dispatch('change'); await flush();
  assert.equal(calls.some(call => call.channel === 'player:volume'), false);
});

test('unknown cursor still displays real list neighbors without false selection, while dragging follows native readback', async () => {
  const tracks = Array.from({length: 5}, (_, index) => ({id: 'list-'+index, title: 'List song '+index})), pending = deferred();
  let currentIndex = 2, generation = 7;
  const {elements, calls} = await setup({library: {tracks: [{id: 'unrelated', title: 'Not the current list'}], playlists: []}, player: player(tracks[2], {source: 'local', generation, revision: 1}), settings: defaultSettings}, async channel => {
    if (channel === 'player:next') return pending.promise;
    if (channel === 'player:context') return {source: 'local', status: 'ready', contextId: 'real-'+generation, generation, currentIndex, capabilities: {select: false, predictNeighbors: false}, items: tracks.map((track, index) => ({key: 'real-'+generation+':'+index, index, trackId: track.id, title: track.title, playable: index !== 3}))};
    return null;
  });
  elements.miniCover.click(); await flush();
  const cards = walk(elements.sleeveNeighbors).filter(item => item.classList.contains('sleeve-neighbor'));
  assert.equal(cards.length, 4); assert.deepEqual(cards.map(card => card.title).sort(), [0, 1, 3, 4].map(index => 'List song '+index));
  for (const card of cards) {
    assert.equal(card.tagName, 'DIV'); assert.equal(card.attributes.tabindex, undefined);
    if (!card.classList.contains('sleeve-outer')) assert.match(card.attributes['aria-label'], /^列表相邻曲目 /);
    card.click();
  }
  await flush(); assert.equal(calls.some(call => /^player:(play|next|previous)$/.test(call.channel)), false);
  const deck = elements.listeningDeck; deck.getBoundingClientRect = () => ({width: 300});
  deck.dispatch('pointerdown', {pointerId: 1, clientX: 150, clientY: 100, isPrimary: true, button: 0});
  deck.dispatch('pointermove', {pointerId: 1, clientX: 65, clientY: 103}); deck.dispatch('pointerup', {pointerId: 1}); await flush();
  assert.equal(calls.filter(call => call.channel === 'player:next').length, 1); assert.equal(elements.immersiveTitle.textContent, 'List song 2');
  currentIndex = 4; generation = 8; pending.resolve(player(tracks[4], {source: 'local', generation, revision: 1})); await flush();
  assert.equal(elements.immersiveTitle.textContent, 'List song 4', 'native outcome is accepted even when it differs from the adjacent list item');
  assert.equal(calls.some(call => call.channel === 'player:play' || call.channel.startsWith('queue:')), false);
});

test('Apple rebuild permit keeps only already-loaded song intents usable without reopening reads or transport', async () => {
  const pendingB = deferred(), tracks = [{id: 'catalog.B', type: 'songs', title: 'B', playable: true}, {id: 'i.C', type: 'library-songs', title: 'C', playable: true}];
  const initial = {provider: 'officialWeb', status: 'ready', available: true, capabilities: {library: true, search: true, playback: true, playableTypes: ['songs', 'library-songs']}};
  let plays = 0;
  const f = await setup({library: {tracks: [], playlists: []}, selectedSource: 'apple', player: {...offline, source: 'apple'}, sources: {apple: initial}, settings: defaultSettings}, async channel => {
    if (channel === 'apple:library') return {items: tracks, nextOffset: 2, total: 4};
    if (channel === 'player:play') return ++plays === 1 ? pendingB.promise : player(tracks[1], {source: 'apple', generation: 2, revision: 1});
    return null;
  });
  const gap = {provider: 'officialWeb', status: 'session-closed', available: false, capabilities: {library: false, search: false, playback: false, canSubmitPlayIntent: true, playIntentTypes: ['songs', 'library-songs'], toggle: false, previous: false, next: false, seek: false, volume: false}};
  f.events.source({sources: {apple: gap}}); await flush();
  assert.equal(f.elements.appleCollection.hidden, false); assert.equal(f.elements.connection.classList.contains('online'), false);
  assert.equal(f.elements.appleCollectionRefresh.disabled, true); assert.equal(f.elements.appleSearchSubmit.disabled, true);
  for (const id of ['toggle', 'previous', 'next', 'seek', 'volume']) assert.equal(f.elements[id].disabled, true, id);
  const more = findText(f.elements.appleViewContent, '显示更多'); assert.equal(more.disabled, true); more.click(); f.elements.appleCollectionRefresh.click();
  const buttons = walk(f.elements.appleViewContent).filter(item => item.classList.contains('track-play'));
  assert.equal(buttons.length, 2); assert.ok(buttons.every(button => !button.disabled));
  buttons[0].click(); await flush(); buttons[1].click(); await flush();
  const commands = f.calls.filter(call => call.channel === 'player:play'); assert.equal(commands.length, 2);
  assert.deepEqual(commands.map(call => JSON.parse(JSON.stringify(call.payload))), [{source: 'apple', id: 'catalog.B', kind: 'songs'}, {source: 'apple', id: 'i.C', kind: 'library-songs'}]);
  assert.equal(f.elements.nowTitle.textContent, 'C'); pendingB.resolve(player(tracks[0], {source: 'apple', generation: 1, revision: 1})); await flush(); assert.equal(f.elements.nowTitle.textContent, 'C');
  assert.equal(f.calls.filter(call => call.channel === 'apple:library').length, 1); assert.equal(f.calls.some(call => call.channel === 'apple:search'), false);
  f.events.source({sources: {apple: {...gap, capabilities: {...gap.capabilities, canSubmitPlayIntent: false, playIntentTypes: []}}}}); await flush();
  assert.equal(f.elements.appleCollection.hidden, true); buttons[1].click(); await flush(); assert.equal(f.calls.filter(call => call.channel === 'player:play').length, 2, 'manual close/default false never reopens');
});

for (const kind of ['albums', 'playlists']) test(`Apple song-intent permit never authorizes a ${kind} container`, async () => {
  const initial = {status: 'ready', available: true, capabilities: {library: true, playback: true, playableTypes: [kind]}};
  const f = await setup({library: {tracks: [], playlists: []}, selectedSource: 'apple', player: offline, sources: {apple: initial}, settings: defaultSettings}, async (channel, payload) => channel === 'apple:library' ? {items: payload.kind === kind ? [{id: 'container.1', type: kind, title: 'Container', playable: true}] : []} : null);
  f.appleNav[kind === 'albums' ? 1 : 3].click(); await flush();
  const button = findText(f.elements.appleViewContent, kind === 'albums' ? '播放专辑' : '播放'); assert.ok(button);
  f.events.source({sources: {apple: {status: 'session-closed', available: false, capabilities: {library: false, playback: true, canSubmitPlayIntent: true, playIntentTypes: ['songs', 'library-songs', kind], playableTypes: [kind]}}}}); await flush();
  button.click(); await flush(); assert.equal(f.calls.some(call => call.channel === 'player:play'), false);
});

test('Apple song-intent helper rejects missing/false permission, unlisted types and unconfirmed playability', async () => {
  for (const sample of [{flag: undefined, types: ['songs'], type: 'songs', playable: true}, {flag: false, types: ['songs'], type: 'songs', playable: true}, {flag: true, types: [], type: 'songs', playable: true}, {flag: true, types: ['library-songs'], type: 'songs', playable: true}, {flag: true, types: ['songs'], type: 'song', playable: true}, {flag: true, types: ['songs'], type: 'songs', playable: undefined}]) {
    const apple = {status: 'session-unverified', available: false, capabilities: {library: true, playback: false, canSubmitPlayIntent: sample.flag, playIntentTypes: sample.types}};
    const f = await setup({library: {tracks: [], playlists: []}, selectedSource: 'apple', player: offline, sources: {apple}, settings: defaultSettings}, async channel => channel === 'apple:library' ? {items: [{id: 'known.1', type: sample.type, title: 'Known', playable: sample.playable}]} : null);
    const button = findClass(f.elements.appleViewContent, 'track-play'); assert.equal(button.disabled, true, JSON.stringify(sample)); button.click(); await flush();
    assert.equal(f.calls.some(call => call.channel === 'player:play'), false);
  }
});

test('renderer factories initialize independently of module declaration order and start once', async () => {
  for (const moduleOrder of [['backend-setup.js', 'features.js', 'app.js', 'desktop-controls.js', 'dac-authorization.js', 'timeline.js', 'glass.js', 'library-state.js'], ['app.js', 'desktop-controls.js', 'backend-setup.js', 'library-state.js', 'glass.js', 'features.js', 'timeline.js', 'dac-authorization.js'], ['glass.js', 'features.js', 'timeline.js', 'library-state.js', 'app.js', 'backend-setup.js', 'dac-authorization.js', 'desktop-controls.js']]) {
    const f = await setup({library: {tracks: [], playlists: []}, player: offline, settings: defaultSettings}, undefined, {moduleOrder});
    assert.equal(f.context.StillApp.state.ready, true); assert.equal(f.context.StillRuntime.app, f.context.StillApp);
    f.context.StillRuntime.start(); await f.context.StillApp.start();
    assert.deepEqual(f.calls.map(call => call.channel), ['backend:setupStatus', 'app:bootstrap']);
    assert.equal(f.calls[0].payload, undefined);
    assert.equal(f.calls.filter(call => /^backend:setup(?:Begin|Complete|Cancel)$/.test(call.channel)).length, 0);
    assert.equal(f.calls.filter(call => call.channel === 'app:bootstrap').length, 1);
    assert.equal(f.elements.toggle.listeners.click.length, 1);
  }
});

test('backend setup polling follows virtual time, skips missed interval ticks and honors clearInterval', async () => {
  const track = {id: 'a', title: 'A'}, f = await setup({library: {tracks: [track], playlists: []}, player: offline, settings: defaultSettings}, async channel =>
    channel === 'backend:setupStatus' ? {automatic: true, ready: false, state: 'extracting-core'} : null);
  const setupReads = () => f.calls.filter(call => call.channel === 'backend:setupStatus').length;
  assert.equal(setupReads(), 1);
  f.advance(749); assert.equal(f.runTimers(), 0); await flush(); assert.equal(setupReads(), 1);
  f.advance(1); assert.equal(f.runTimers(), 1); await flush(); assert.equal(setupReads(), 2);

  let intervalTicks = 0;
  const interval = f.context.setInterval(() => intervalTicks++, 100);
  f.advance(450); assert.equal(f.runTimers(), 1); assert.equal(intervalTicks, 1);
  f.context.clearInterval(interval);
  f.advance(2000); assert.equal(f.runTimers(), 1); await flush(); assert.equal(setupReads(), 3);
  assert.equal(f.runTimers(), 0); assert.equal(setupReads(), 3);
  f.advance(100); assert.equal(f.runTimers(), 0); assert.equal(intervalTicks, 1);
});

test('public renderer state is deeply read-only without cloning unchanged DTOs', async () => {
  const settings = Object.freeze({appearance: Object.freeze({accentColor: '#A8B9FF', accentMode: 'color'}), lyrics: Object.freeze({...defaultSettings.lyrics})});
  const f = await setup({library: {tracks: [{id: 'a', title: 'A'}], playlists: []}, player: offline, settings});
  const state = f.context.StillApp.state, appearance = state.settings.appearance;
  assert.equal(state.settings.appearance, appearance);
  assert.throws(() => { state.settings = {}; }, /read-only/);
  assert.throws(() => { appearance.accentColor = '#000000'; }, /read-only/);
  assert.throws(() => { state.library.tracks.push({id: 'bad'}); }, /read-only/);
  assert.equal(state.library.tracks.length, 1); assert.equal(state.settings.appearance.accentColor, '#A8B9FF');
  assert.equal(f.context.StillApp.actions.acceptAppearance({accentColor: '#ffffff', accentMode: 'none'}), true);
  assert.equal(state.settings.appearance.accentColor, '#FFFFFF'); assert.equal(state.settings.appearance.accentMode, 'none');
  const readonly = require('../src/renderer/bootstrap').createReadonlyView();
  const frozen = readonly(Object.freeze({items: Object.freeze([Object.freeze({id: 'frozen'})])}));
  assert.deepEqual(Array.from(frozen.items.map(item => item.id)), ['frozen']); assert.equal(frozen.items.filter(item => item.id).length, 1);
  assert.equal(JSON.stringify(frozen), '{"items":[{"id":"frozen"}]}'); assert.throws(() => frozen.items.splice(0, 1), /read-only/);
});

const UI_LIBRARY_STREAM = '44444444-4444-4444-8444-444444444444', UI_METADATA_STREAM = '55555555-5555-4555-8555-555555555555';
function revisionedLibrary(tracks, playlists = []) { return {revision: 0, tracks, playlists, folders: [], status: {status: 'ready', readOnly: false}, eventCursors: {library: {streamId: UI_LIBRARY_STREAM, sequence: 0}, metadata: {streamId: UI_METADATA_STREAM, sequence: 0}}}; }

test('large-library typing is one delayed search, composition waits, and a source switch cancels the old timer', async () => {
  let reads = 0; const tracks = Array.from({length: 1500}, (_, index) => ({id: 'large-'+index, get title() { reads++; return 'Track '+index; }, album: 'Album '+Math.floor(index / 20), artist: 'Artist'}));
  const sources = {local: {available: true}, apple: {status: 'unconfigured', capabilities: {library: false, playback: false}}};
  const f = await setup({library: {tracks, playlists: []}, player: offline, sources, settings: defaultSettings}, async (channel, payload) => channel === 'source:select' ? {selectedSource: payload.source, sources} : null);
  const original = f.elements.viewContent.children[0]; reads = 0;
  for (const value of ['T', 'Tr', 'Tra', 'Track', 'Track 1499']) { f.elements.search.value = value; f.elements.search.dispatch('input'); }
  assert.equal(reads, 0); assert.equal(f.elements.viewContent.children[0], original);
  f.advance(149); f.runTimers(); await flush(); assert.equal(f.elements.viewContent.children[0], original);
  f.advance(1); f.runTimers(); await flush(); assert.equal(f.elements.itemCount.textContent, '1 首');
  f.elements.search.dispatch('compositionstart'); f.elements.search.value = 'Artist'; f.elements.search.dispatch('input'); f.advance(300); f.runTimers(); assert.equal(f.elements.itemCount.textContent, '1 首');
  f.elements.search.dispatch('compositionend'); f.elements.sourceApple.click(); await flush();
  const hiddenRows = f.elements.viewContent.children[0]; f.advance(300); f.runTimers(); await flush(); assert.equal(f.elements.viewContent.children[0], hiddenRows);
  f.elements.sourceLocal.click(); await flush(); assert.equal(f.elements.itemCount.textContent, '1500 首');
});

test('same URL keeps per-position image ownership and only detached decoded images are pooled', async () => {
  const f = await setup({library: {tracks: [], playlists: []}, player: offline, settings: defaultSettings});
  const a = f.context.StillApp.node('div'), b = f.context.StillApp.node('div'), c = f.context.StillApp.node('div'), url = 'data:image/png;base64,AA==';
  f.context.StillApp.cover(a, url); f.context.StillApp.cover(b, url); const first = a.children[0], second = b.children[0];
  assert.notEqual(first, second); f.context.StillApp.cover(a, url); assert.equal(a.children[0], first); assert.equal(b.children[0], second);
  first.naturalWidth = first.naturalHeight = 512; first.dispatch('load'); f.context.StillApp.releaseCovers(a); f.context.StillApp.cover(c, url);
  assert.equal(c.children[0], first); assert.equal(first.parentElement, c); assert.equal(b.children[0], second);
  f.context.StillApp.cover(c, 'data:image/png;base64,BB=='); first.dispatch('error'); assert.equal(c.children[0].src, 'data:image/png;base64,BB==');
});

test('decoded cover pool skips oversized/unknown images and evicts to its total byte budget', async () => {
  const f = await setup({library: {tracks: [], playlists: []}, player: offline, settings: defaultSettings}), app = f.context.StillApp;
  const large = app.node('div'); app.cover(large, 'data:image/png;base64,LARGE'); const huge = large.children[0]; huge.naturalWidth = huge.naturalHeight = 6000; huge.dispatch('load'); app.releaseCovers(large);
  const next = app.node('div'); app.cover(next, 'data:image/png;base64,LARGE'); assert.notEqual(next.children[0], huge);
  const originals = [];
  for (let index = 0; index < 9; index++) { const root = app.node('div'), url = `data:image/png;base64,POOL${index}`; app.cover(root, url); const img = root.children[0]; img.naturalWidth = img.naturalHeight = 1024; img.dispatch('load'); originals.push({url, img}); app.releaseCovers(root); }
  const oldest = app.node('div'), latest = app.node('div'); app.cover(oldest, originals[0].url); app.cover(latest, originals[8].url);
  assert.notEqual(oldest.children[0], originals[0].img); assert.equal(latest.children[0], originals[8].img);
});

test('cover-only delta preserves rows, sort, query, count announcement and unrelated image nodes', async () => {
  const tracks = [{id: 'a', title: 'A', coverUrl: 'data:image/png;base64,AA=='}, {id: 'b', title: 'B', coverUrl: 'data:image/png;base64,BB=='}];
  const f = await setup({library: revisionedLibrary(tracks), player: player(tracks[0], {source: 'local'}), settings: defaultSettings});
  f.elements.sortSelect.value = 'title'; f.elements.sortSelect.dispatch('change');
  const rows = walk(f.elements.viewContent).filter(item => item.classList.contains('track-row')), secondImage = findClass(rows[1], 'track-cover').children[0], count = f.elements.localResultStatus.textContent;
  let replacements = 0; const replace = f.elements.viewContent.replaceChildren.bind(f.elements.viewContent); f.elements.viewContent.replaceChildren = (...children) => { replacements++; replace(...children); };
  const event = {kind: 'library-delta', eventId: `metadata:${UI_METADATA_STREAM}:1`, baseRevision: 0, revision: 0, tracks: [{...tracks[0], coverUrl: 'data:image/png;base64,NEW'}], removedTrackIds: [], status: {status: 'ready', readOnly: false}};
  f.events.library(event); f.events.library(event); await flush();
  assert.equal(replacements, 0); assert.equal(findClass(rows[0], 'track-cover').children[0].src, 'data:image/png;base64,NEW'); assert.equal(findClass(rows[1], 'track-cover').children[0], secondImage);
  assert.equal(f.context.StillApp.state.sort, 'title'); assert.equal(f.elements.localResultStatus.textContent, count);
  assert.equal(f.elements.viewContent.attributes['aria-live'], undefined);
});

test('status-only read-only delta disables library writes without disabling real playback', async () => {
  const track = {id: 'a', title: 'A'}, f = await setup({library: revisionedLibrary([track]), player: player(track, {source: 'local'}), settings: defaultSettings});
  f.events.library({kind: 'library-delta', eventId: `library:${UI_LIBRARY_STREAM}:1`, baseRevision: 0, revision: 0, tracks: [], removedTrackIds: [], status: {status: 'read-only', readOnly: true, message: 'store unavailable'}}); await flush();
  assert.equal(f.elements.importFiles.disabled, true); assert.equal(f.elements.refreshButton.disabled, true); assert.equal(f.elements.toggle.disabled, false); assert.equal(findClass(f.elements.viewContent, 'track-play').disabled, false);
  await f.context.StillApp.invoke('library:remove', {ids: ['a']}); assert.equal(f.calls.some(call => call.channel === 'library:remove'), false);
  assert.equal(f.elements.libraryState.textContent, '音乐库为只读状态');
});

test('roving keeps only the active row controls tabbable and consumes arrows without seeking or playing', async () => {
  const track = {id: 'a', title: 'A'}, f = await setup({library: {tracks: [track, {id: 'b', title: 'B'}, {id: 'c', title: 'C'}], playlists: [{id: 'p', name: 'Repeat', trackIds: ['a', 'a', 'b']}]}, player: player(track, {source: 'local'}), settings: defaultSettings});
  const rows = walk(f.elements.viewContent).filter(item => item.classList.contains('track-row')), controls = rows.map(row => walk(row).filter(item => item.tagName === 'BUTTON'));
  assert.ok(controls[0].every(control => control.tabIndex === 0)); assert.ok(controls[1].every(control => control.tabIndex === -1));
  controls[0][0].focus(); const event = f.elements.viewContent.dispatch('keydown', {target: controls[0][0], key: 'ArrowDown'}); f.dispatchKey({...event, key: 'ArrowDown'});
  assert.equal(event.defaultPrevented, true); assert.equal(f.context.document.activeElement, controls[1][0]); assert.ok(controls[0].every(control => control.tabIndex === -1));
  f.elements.viewContent.dispatch('keydown', {target: controls[1][0], key: 'ArrowRight'}); assert.equal(f.context.document.activeElement, controls[1][1]);
  f.elements.viewContent.dispatch('keydown', {target: controls[1][1], key: 'End'}); assert.equal(f.context.document.activeElement, controls[2][1]);
  assert.equal(f.calls.some(call => /^player:(seek|play)$/.test(call.channel)), false);
  f.context.StillApp.openDetail({type: 'playlist', id: 'p', title: 'Repeat'}); const repeated = walk(f.elements.viewContent).filter(item => item.classList.contains('track-play'));
  repeated[0].focus(); f.elements.viewContent.dispatch('keydown', {target: repeated[0], key: 'ArrowDown'}); assert.equal(f.context.document.activeElement, repeated[1]);
});

test('settings contact uses only its field and safe exit requires a fresh verified opaque token', async () => {
  const exits = [], f = await setup({library: {tracks: [], playlists: []}, player: offline, settings: {...defaultSettings, onlineCovers: {musicBrainzContact: ''}}, capabilities: {persistUIState: true}}, async (channel, payload) => {
    if (channel === 'settings:update') return {...defaultSettings, onlineCovers: payload.patch.onlineCovers};
    if (channel === 'app:safeOwnedExitStatus') return {available: true, refused: false, selectionToken: '77777777-7777-4777-8777-777777777777', target: {pid: 123, startTime: 'known', executable: 'private-app', profilePath: 'private-profile'}};
    if (channel === 'app:safeOwnedExit') { exits.push(payload); return {exited: true, refused: false}; } return null;
  });
  f.elements.audioButton.click(); await flush();
  assert.equal(f.calls.some(call => call.channel.startsWith('app:safeOwnedExit')), false);
  const contact = walk(f.elements.dialogBody).find(item => item.attributes['aria-label'] === 'MusicBrainz 联系信息');
  contact.value = 'http://invalid.example/contact'; contact.dispatch('keydown', {key: 'Enter'}); await flush(); assert.equal(f.calls.some(call => call.channel === 'settings:update'), false);
  contact.value = 'https://example.com/contact'; contact.dispatch('keydown', {key: 'Enter'}); await flush();
  const saved = f.calls.find(call => call.channel === 'settings:update'); assert.deepEqual(JSON.parse(JSON.stringify(saved.payload)), {patch: {onlineCovers: {musicBrainzContact: 'https://example.com/contact'}}});
  const exit = findText(f.elements.dialogBody, '安全退出遗留后台'); assert.equal(exit.disabled, true); findText(f.elements.dialogBody, '检查后台').click(); await flush(); assert.equal(exit.disabled, false);
  exit.click(); await flush(); assert.deepEqual(JSON.parse(JSON.stringify(exits)), [{selectionToken: '77777777-7777-4777-8777-777777777777'}]); assert.equal(exit.disabled, true);
});

test('settings rejects malformed confirmations and a late or incomplete safe-exit selection', async () => {
  const pending = deferred(); let checks = 0;
  const f = await setup({library: {tracks: [], playlists: []}, player: offline, settings: {...defaultSettings, onlineCovers: {musicBrainzContact: 'saved@example.com'}}, capabilities: {persistUIState: true}}, async channel => {
    if (channel === 'settings:update') return {onlineCovers: {musicBrainzContact: 'http://invalid.example'}};
    if (channel === 'app:safeOwnedExitStatus') return ++checks === 1 ? {available: true, refused: false, selectionToken: '77777777-7777-4777-8777-777777777777', target: {}} : pending.promise;
    return null;
  });
  f.elements.audioButton.click(); await flush();
  const contact = walk(f.elements.dialogBody).find(item => item.attributes['aria-label'] === 'MusicBrainz 联系信息');
  contact.value = 'https://example.com/contact'; contact.dispatch('keydown', {key: 'Enter'}); await flush();
  assert.equal(contact.value, 'saved@example.com'); assert.ok(findText(f.elements.dialogBody, '未保存，已保留原设置')); assert.equal(findText(f.elements.dialogBody, '已保存'), undefined);
  const exit = findText(f.elements.dialogBody, '安全退出遗留后台'), check = findText(f.elements.dialogBody, '检查后台');
  check.click(); await flush(); assert.equal(exit.disabled, true); exit.click(); assert.equal(f.calls.some(call => call.channel === 'app:safeOwnedExit'), false);
  check.click(); await flush(); f.elements.dialog.close(); f.elements.audioButton.click(); await flush();
  const freshExit = findText(f.elements.dialogBody, '安全退出遗留后台');
  pending.resolve({available: true, refused: false, selectionToken: '77777777-7777-4777-8777-777777777777', target: {pid: 123, startTime: 'known', executable: 'private-app', profilePath: 'private-profile'}}); await flush();
  assert.equal(freshExit.disabled, true); assert.equal(exit.disabled, true); assert.equal(f.calls.some(call => call.channel === 'app:safeOwnedExit'), false);
});

test('grid roving follows actual column count, keeps focus through rerender and leaves native activation untouched', async () => {
  const tracks = Array.from({length: 6}, (_, index) => ({id: 'grid-'+index, title: 'Track '+index, album: 'Album '+index, artist: 'Artist'}));
  const f = await setup({library: {tracks, playlists: []}, player: player(tracks[0], {source: 'local'}), settings: defaultSettings});
  f.context.getComputedStyle = () => ({gridTemplateColumns: '200px 200px 200px'}); f.context.StillApp.setView('albums');
  let cards = walk(f.elements.viewContent).filter(item => item.classList.contains('tile'));
  assert.equal(cards.length, 6); cards[0].focus();
  f.elements.viewContent.dispatch('keydown', {target: cards[0], key: 'ArrowDown'}); assert.equal(f.context.document.activeElement, cards[3]);
  f.context.StillApp.render(); cards = walk(f.elements.viewContent).filter(item => item.classList.contains('tile')); assert.equal(f.context.document.activeElement, cards[3]);
  const enter = f.elements.viewContent.dispatch('keydown', {target: cards[3], key: 'Enter'}), space = f.elements.viewContent.dispatch('keydown', {target: cards[3], key: ' '});
  assert.notEqual(enter.defaultPrevented, true); assert.notEqual(space.defaultPrevented, true); assert.equal(f.calls.some(call => call.channel === 'player:play'), false);
  cards[3].click(); assert.equal(f.context.StillApp.state.detail.type, 'album'); assert.equal(f.calls.some(call => call.channel === 'player:play'), false);
});
