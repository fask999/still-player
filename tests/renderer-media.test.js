'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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

const sampleTrack = {id: 'a', title: 'A', artist: 'Artist', coverUrl: 'still-cover://art/original', coverThumbnailUrl: 'still-cover://art/thumb', coverLargeUrl: 'still-cover://art/large'};
const doc = (id, offsetMs = 0) => ({trackId: id, status: 'ready', kind: 'line', source: 'LRCLIB', offsetMs, lines: [{startMs: 1000, text: 'first'}, {startMs: 1200, text: 'second'}]});
const dataFor = track => ({library: {tracks: [track], playlists: []}, player: player(track, {source: 'local', state: 'paused', position: 1.15}), settings: defaultSettings});

test('offset controls immediately repaint, serialize rapid edits and recover a failed save', async () => {
  const saves = [], first = deferred(), second = deferred();
  const ui = await setup(dataFor(sampleTrack), async (channel, payload) => {
    if (channel === 'lyrics:resolve') return doc(payload.trackId);
    if (channel === 'lyrics:offset') { saves.push(payload); return saves.length === 1 ? first.promise : second.promise; }
    return null;
  });
  ui.elements.nowTitle.click(); await flush(); await flush();
  const control = findClass(ui.elements.lyricsColumn, 'lyric-timing-controls');
  const [minus, value, plus, reset] = control.children;
  assert.equal(value.textContent, '偏移 0 ms');
  assert.ok(findClass(ui.elements.lyricsBody, 'active'));
  plus.click(); assert.equal(value.textContent, '偏移 +100 ms');
  plus.click(); assert.equal(value.textContent, '偏移 +200 ms');
  assert.equal(findClass(ui.elements.lyricsBody, 'active'), undefined, 'the new offset immediately changes the active lyric');
  assert.deepEqual(saves.map(item => item.offsetMs), [100]);
  first.resolve(doc('a', 100)); await flush(); assert.deepEqual(saves.map(item => item.offsetMs), [100, 200]);
  second.reject(new Error('disk failure')); await flush();
  assert.equal(value.textContent, '偏移 +100 ms'); assert.match(ui.elements.toast.textContent, /保存失败/);
  assert.equal(reset.disabled, false); assert.equal(minus.disabled, false);
});

test('switching tracks isolates pending saves and preserves pending intent across a stale reload', async () => {
  const first = deferred(), reload = deferred(); let readsA = 0;
  const a = sampleTrack, b = {id: 'b', title: 'B', artist: 'Artist'};
  const data = dataFor(a); data.library.tracks.push(b);
  const ui = await setup(data, async (channel, payload) => {
    if (channel === 'lyrics:resolve') { if (payload.trackId === 'a' && ++readsA === 2) return reload.promise; return doc(payload.trackId); }
    if (channel === 'lyrics:offset') return first.promise;
    return null;
  });
  ui.elements.nowTitle.click(); await flush(); await flush();
  const control = findClass(ui.elements.lyricsColumn, 'lyric-timing-controls'), value = control.children[1];
  control.children[2].click();
  ui.events.player(player(b, {source: 'local', state: 'paused', position: 1.15})); await flush();
  assert.equal(value.textContent, '偏移 0 ms');
  ui.events.player(player(a, {source: 'local', state: 'paused', position: 1.15})); await flush();
  first.resolve(doc('a', 100)); await flush(); reload.resolve(doc('a', 0)); await flush();
  assert.equal(value.textContent, '偏移 +100 ms');
});

test('search source carries provider identity through preview and binding and reports unavailable sources', async () => {
  const candidate = {id: 'qq:mid', sourceId: 'mid', sourceKey: 'qq:mid', provider: 'qq', source: 'QQ 音乐', title: 'A', artist: 'Artist', kind: 'none'};
  let unavailable = false;
  const ui = await setup(dataFor(sampleTrack), async (channel, payload) => {
    if (channel === 'lyrics:resolve') return doc(payload.trackId);
    if (channel === 'lyrics:search') return payload.source === 'qq' ? unavailable ? {status: 'not-found', reason: 'source-unavailable', results: []} : {status: 'ready', results: [candidate]} : {status: 'not-found', reason: 'online-disabled', results: []};
    if (channel === 'lyrics:preview' || channel === 'lyrics:bind') return doc(payload.trackId);
    return null;
  });
  ui.elements.nowTitle.click(); await flush(); ui.elements.findLyrics.click(); await flush();
  assert.match(ui.elements.dialogBody.textContent, /在线歌词已关闭/);
  const select = walk(ui.elements.dialogBody).find(el => el.tagName === 'SELECT');
  select.value = 'qq'; select.dispatch('change'); await flush();
  assert.equal(ui.calls.filter(call => call.channel === 'lyrics:search').at(-1).payload.source, 'qq');
  assert.match(ui.elements.dialogBody.textContent, /类型待预览/);
  findText(ui.elements.dialogBody, '预览').click(); await flush();
  assert.equal(ui.calls.filter(call => call.channel === 'lyrics:preview').at(-1).payload.candidate.sourceKey, 'qq:mid');
  findText(ui.elements.dialogBody, '绑定此版本').click(); await flush();
  assert.equal(ui.calls.filter(call => call.channel === 'lyrics:bind').at(-1).payload.candidate.provider, 'qq');
  unavailable = true; ui.elements.findLyrics.click(); await flush();
  const again = walk(ui.elements.dialogBody).find(el => el.tagName === 'SELECT'); again.value = 'qq'; again.dispatch('change'); await flush();
  assert.match(ui.elements.dialogBody.textContent, /QQ 音乐：该来源当前不可用/);
});

test('thumbnail and large cover tiers update independently through library deltas', async () => {
  const data = dataFor(sampleTrack);
  data.library.revision = 0; data.library.eventCursors = {library: {streamId: 'library', sequence: 0}, metadata: {streamId: 'metadata', sequence: 0}};
  const ui = await setup(data);
  assert.equal(ui.elements.miniCover.dataset.coverUrl, sampleTrack.coverThumbnailUrl);
  assert.equal(findClass(ui.elements.viewContent, 'track-cover').dataset.coverUrl, sampleTrack.coverThumbnailUrl);
  ui.context.StillApp.setView('albums');
  assert.equal(findClass(ui.elements.viewContent, 'tile-cover').dataset.coverUrl, sampleTrack.coverLargeUrl);
  ui.elements.nowTitle.click(); await flush();
  assert.equal(ui.elements.largeCover.dataset.coverUrl, sampleTrack.coverLargeUrl);
  const changed = {...sampleTrack, coverThumbnailUrl: 'still-cover://art/thumb2', coverLargeUrl: 'still-cover://art/large2'};
  ui.events.library({kind: 'library-delta', eventId: 'metadata:metadata:1', baseRevision: 0, revision: 0, tracks: [changed], removedTrackIds: []}); await flush();
  assert.equal(ui.elements.miniCover.dataset.coverUrl, changed.coverThumbnailUrl);
  assert.equal(ui.elements.largeCover.dataset.coverUrl, changed.coverLargeUrl);
});

test('settings sections isolate renderer errors and reject duplicate registrations', async () => {
  const ui = await setup(dataFor(sampleTrack));
  const f = ui.context.StillFeatures;
  f.registerSettingsSection('fixture', ({app}) => app.node('section', '', 'fixture section'));
  f.registerSettingsSection('broken', () => { throw Error('fixture'); });
  assert.throws(() => f.registerSettingsSection('fixture', () => null));
  ui.elements.audioButton.click(); await flush(); await flush();
  assert.match(ui.elements.dialogBody.textContent, /fixture section/);
  assert.match(ui.elements.dialogBody.textContent, /设置区块 broken 暂不可用/);
});
for (const operation of ['bind', 'import', 'unbind']) {
  test(`a pending ${operation} response cannot roll back a newer saved offset`, async () => {
    const command = deferred();
    const ui = await setup(dataFor(sampleTrack), async (channel, payload) => {
      if (channel === 'lyrics:resolve') return {...doc(payload.trackId), bound: true};
      if (channel === 'lyrics:search') return {status: 'ready', results: [{id: 1, provider: 'lrclib', sourceId: 1, source: 'LRCLIB', title: 'A', artist: 'Artist', kind: 'line'}]};
      if (channel === `lyrics:${operation}`) return command.promise;
      if (channel === 'lyrics:offset') return doc(payload.trackId, payload.offsetMs);
      return null;
    });
    ui.elements.nowTitle.click(); await flush(); await flush();
    if (operation === 'bind') { ui.elements.findLyrics.click(); await flush(); findText(ui.elements.dialogBody, '绑定此版本').click(); }
    if (operation === 'import') ui.elements.importLyrics.click();
    if (operation === 'unbind') { ui.elements.lyricsTools.click(); await flush(); findText(ui.elements.dialogBody, '解除此曲目绑定').click(); }
    await flush();
    const controls = findClass(ui.elements.lyricsColumn, 'lyric-timing-controls');
    controls.children[2].click(); await flush();
    assert.equal(controls.children[1].textContent, '偏移 +100 ms');
    command.resolve(doc('a', 0)); await flush();
    assert.equal(controls.children[1].textContent, '偏移 +100 ms');
  });
}
test('numeric settings outside listening view rolls back on failed persistence', async () => {
  const ui = await setup(dataFor(sampleTrack), async (channel, payload) => {
    if (channel === 'lyrics:resolve') return doc(payload.trackId, 50);
    if (channel === 'lyrics:offset') throw Error('disk failure');
    return null;
  });
  ui.elements.lyricsTools.click(); await flush(); await flush();
  const input = walk(ui.elements.dialogBody).find(el => el.id === 'lyricOffset');
  assert.equal(input.value, '50'); input.value = '300';
  findText(ui.elements.dialogBody, '应用').click(); await flush();
  assert.equal(input.value, '50'); assert.match(ui.elements.dialogAlert.textContent, /保存失败/);
});

test('reset saves zero and immediately restores the original highlighting', async () => {
  const ui = await setup(dataFor(sampleTrack), async (channel, payload) => {
    if (channel === 'lyrics:resolve') return doc(payload.trackId, 200);
    if (channel === 'lyrics:offset') return doc(payload.trackId, payload.offsetMs);
    return null;
  });
  ui.elements.nowTitle.click(); await flush();
  assert.equal(findClass(ui.elements.lyricsBody, 'active'), undefined);
  const controls = findClass(ui.elements.lyricsColumn, 'lyric-timing-controls');
  controls.children[3].click();
  assert.equal(controls.children[1].textContent, '偏移 0 ms');
  assert.ok(findClass(ui.elements.lyricsBody, 'active')); await flush();
  assert.equal(ui.calls.filter(call => call.channel === 'lyrics:offset').at(-1).payload.offsetMs, 0);
});
test('late search results cannot replace a newly selected provider', async () => {
  const oldSearch = deferred();
  const ui = await setup(dataFor(sampleTrack), async (channel, payload) => {
    if (channel === 'lyrics:resolve') return doc(payload.trackId);
    if (channel === 'lyrics:search') return payload.source === 'lrclib' ? oldSearch.promise : {status: 'not-found', reason: 'source-unavailable', results: []};
    return null;
  });
  ui.elements.nowTitle.click(); await flush(); ui.elements.findLyrics.click();
  const source = walk(ui.elements.dialogBody).find(el => el.tagName === 'SELECT'); source.value = 'qq'; source.dispatch('change'); await flush();
  oldSearch.resolve({status: 'ready', results: [{id: 12, title: 'Old result'}]}); await flush();
  assert.match(ui.elements.dialogBody.textContent, /QQ 音乐：该来源当前不可用/);
  assert.doesNotMatch(ui.elements.dialogBody.textContent, /Old result/);
});
test('superseded document after a successful offset commit retains the confirmed offset', async () => {
  const ui = await setup(dataFor(sampleTrack), async (channel, payload) => {
    if (channel === 'lyrics:resolve') return doc(payload.trackId);
    if (channel === 'lyrics:offset') return {trackId: payload.trackId, superseded: true};
    return null;
  });
  ui.elements.nowTitle.click(); await flush();
  const controls = findClass(ui.elements.lyricsColumn, 'lyric-timing-controls'); controls.children[2].click(); await flush();
  assert.equal(controls.children[1].textContent, '偏移 +100 ms');
  assert.doesNotMatch(ui.elements.toast.textContent, /保存失败/);
});
test('a committed offset with a postcommit read warning keeps existing lyric content', async () => {
  const ui = await setup(dataFor(sampleTrack), async (channel, payload) => {
    if (channel === 'lyrics:resolve') return doc(payload.trackId);
    if (channel === 'lyrics:offset') return {trackId: payload.trackId, status: 'not-found', kind: 'none', lines: [], offsetMs: payload.offsetMs, offsetCommitted: true, offsetWarning: 'postcommit read failed'};
    return null;
  });
  ui.elements.nowTitle.click(); await flush();
  const controls = findClass(ui.elements.lyricsColumn, 'lyric-timing-controls'); controls.children[2].click(); await flush();
  assert.equal(controls.children[1].textContent, '偏移 +100 ms');
  assert.match(ui.elements.lyricsBody.textContent, /first/);
  assert.match(ui.elements.toast.textContent, /已保存.*暂未刷新/);
});
