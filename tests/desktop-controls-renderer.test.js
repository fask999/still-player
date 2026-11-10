'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/desktop-controls.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../src/renderer/desktop-controls.css'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
function snapshot(overrides = {}) {
  return {available: true, readOnly: false,
    preferences: {preventSleep: true, systemMediaControls: true, globalShortcutsEnabled: false,
      hotkeyToggle: '', hotkeyPrevious: '', hotkeyNext: '', hotkeyShowWindow: ''},
    power: {enabled: true, active: false, status: 'idle'}, sleepTimer: {status: 'idle', remainingSeconds: 0},
    media: {status: 'idle'}, shortcuts: {enabled: false, registrations: []}, ...overrides};
}
function fixture(initial = snapshot()) {
  const calls = [], listeners = new Set(), intervals = new Map(), errors = [];
  let nextInterval = 0, nextStatus = initial, action = async () => ({}), subscriptions = 0, unsubscriptions = 0;
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.events = {}; this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = false; this.parent = null; }
    append(...items) { for (const item of items) {item.parent = this; this.children.push(item);} }
    replaceChildren(...items) { for (const item of this.children) item.parent = null; this.children = []; this.append(...items); }
    remove() { if (this.parent) {this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null;} }
    setAttribute(key, value) {this.attributes[key] = value;}
    addEventListener(type, callback) {this.events[type] = callback;}
    removeEventListener(type, callback) {if (this.events[type] === callback) delete this.events[type];}
    fire(type) { if (!this.disabled) this.events[type]?.({target: this}); }
  }
  const document = {createElement: tag => new Node(tag), activeElement: null};
  const bridge = {invoke: async (channel, payload) => {calls.push({channel, payload: plain(payload)}); return channel === 'desktop:status' ? await nextStatus : await action(channel, payload);},
    on: (channel, fn) => {assert.equal(channel, 'desktop'); subscriptions++; listeners.add(fn); return () => {unsubscriptions++; listeners.delete(fn);};}};
  const window = {still: bridge};
  vm.runInNewContext(source, {window, document, Date, setInterval: fn => {const id = ++nextInterval; intervals.set(id, fn); return id;}, clearInterval: id => intervals.delete(id)});
  const controller = window.STILLDesktopControls.create({onError: error => errors.push(error)});
  const host = () => new Node('host');
  const all = (node) => [node, ...node.children.flatMap(all)];
  const byText = (node, text) => all(node).find(item => item.textContent === text);
  const byLabel = (node, text) => byText(node, text)?.children.find(item => ['input', 'select'].includes(item.tag));
  return {calls, errors, controller, host, all, byText, byLabel, listeners, intervals, api: window.STILLDesktopControls, bridge,
    counts: () => ({subscriptions, unsubscriptions}), setStatus: v => {nextStatus = v;}, setAction: fn => {action = fn;},
    emit: value => {for (const listener of listeners) listener(value);}};
}
test('desktop controls send exact settings and timer commands, validate input, and show registration errors as text', async () => {
  const f = fixture(), host = f.host(); f.controller.mount(host); await flush();
  const checkbox = f.all(host).find(n => n.tag === 'input' && n.type === 'checkbox'); checkbox.checked = false; checkbox.fire('change'); await flush(); await flush();
  assert.deepEqual(f.calls.find(c => c.channel === 'settings:update').payload, {patch: {desktop: {preventSleep: false}}});
  const minutes = f.byLabel(host, '分钟（1–1440）'); minutes.value = '30.5'; f.byText(host, '设置定时停止').fire('click');
  assert.equal(f.calls.filter(c => c.channel === 'desktop:sleepTimer:set').length, 0);
  assert.ok(f.byText(host, '请输入 1 到 1440 之间的整数分钟。'));
  minutes.value = '90'; f.byText(host, '设置定时停止').fire('click'); await flush(); await flush();
  assert.deepEqual(f.calls.find(c => c.channel === 'desktop:sleepTimer:set').payload, {minutes: 90});
  f.emit(snapshot({sleepTimer: {status: 'armed', remainingSeconds: 125}}));
  assert.match(f.all(host).map(n => n.textContent).join(' '), /2 分 05 秒/);
  f.byText(host, '取消定时').fire('click'); await flush(); await flush();
  assert.deepEqual(f.calls.find(c => c.channel === 'desktop:sleepTimer:cancel').payload, {});
  const hotkey = f.byLabel(host, '播放／暂停'), save = f.all(host).find(n => n.attributes['aria-label'] === '保存播放／暂停快捷键');
  hotkey.value = 'MediaPlayPause'; hotkey.fire('input'); save.fire('click');
  assert.equal(f.calls.filter(c => c.channel === 'settings:update').length, 1);
  hotkey.value = 'Shift+P'; hotkey.fire('input'); save.fire('click');
  assert.equal(f.calls.filter(c => c.channel === 'settings:update').length, 1);
  hotkey.value = 'Control+Alt+P'; hotkey.fire('input'); save.fire('click'); await flush(); await flush();
  assert.deepEqual(f.calls.filter(c => c.channel === 'settings:update')[1].payload, {patch: {desktop: {hotkeyToggle: 'Control+Alt+P'}}});
  f.emit(snapshot({shortcuts: {enabled: true, registrations: [{action: 'toggle', accelerator: 'Control+Alt+P', registered: false, error: '<occupied>'}]}}));
  assert.ok(f.byText(host, '未能启用。 <occupied>'));
  f.controller.dispose();
});
test('read-only and unavailable states suppress writes, while errors are visible and reported', async () => {
  const f = fixture(snapshot({readOnly: true})), host = f.host(); f.controller.mount(host); await flush();
  assert.ok(f.byText(host, '当前为只读状态，不能更改桌面控制。'));
  assert.equal(f.byText(host, '设置定时停止').disabled, true);
  f.emit(snapshot({available: false})); assert.ok(f.byText(host, '桌面控制当前不可用。'));
  const before = f.calls.length; f.byText(host, '设置定时停止').fire('click'); assert.equal(f.calls.length, before);
  f.emit(snapshot()); f.setAction(async () => {throw new Error('暂时失败');});
  f.byText(host, '设置定时停止').fire('click'); await flush();
  assert.ok(f.byText(host, '操作未完成，请重试。 暂时失败')); assert.equal(f.errors.length, 1);
  f.controller.dispose();
});
test('remount and dispose unsubscribe once, clean timers, and ignore stale asynchronous results', async () => {
  let resolveOld; const old = new Promise(resolve => {resolveOld = resolve;});
  const f = fixture(old), first = f.host(), second = f.host(); f.controller.mount(first);
  f.setStatus(snapshot()); f.controller.mount(second); await flush();
  assert.deepEqual(f.counts(), {subscriptions: 1, unsubscriptions: 0}); assert.equal(first.children.length, 0); assert.equal(f.listeners.size, 1);
  resolveOld(snapshot({available: false})); await flush();
  assert.equal(f.byText(second, '桌面控制当前不可用。'), undefined);
  let resolveWrite; f.setAction(() => new Promise(resolve => {resolveWrite = resolve;}));
  f.byText(second, '设置定时停止').fire('click'); f.controller.dispose(); resolveWrite({}); await flush(); await flush();
  assert.equal(second.children.length, 0); assert.equal(f.listeners.size, 0); assert.equal(f.intervals.size, 0);
  assert.deepEqual(f.counts(), {subscriptions: 1, unsubscriptions: 1});
  assert.equal(f.calls.filter(c => c.channel === 'desktop:status').length, 2);
});
test('a failed write from an old mount cannot affect its replacement', async () => {
  let rejectWrite; const f = fixture(), first = f.host(), second = f.host();
  f.controller.mount(first); await flush();
  f.setAction(() => new Promise((resolve, reject) => {rejectWrite = reject;}));
  f.byText(first, '设置定时停止').fire('click');
  f.controller.mount(second); await flush(); rejectWrite(new Error('旧操作失败')); await flush();
  assert.equal(f.errors.length, 0); assert.equal(f.byText(second, '操作未完成，请重试。 旧操作失败'), undefined);
  assert.equal(f.byText(second, '设置定时停止').disabled, false); f.controller.dispose();
});
test('a newer desktop event takes precedence over an earlier status response', async () => {
  let resolveStatus; const f = fixture(new Promise(resolve => {resolveStatus = resolve;})), host = f.host();
  f.controller.mount(host); f.emit(snapshot({available: false})); resolveStatus(snapshot()); await flush();
  assert.ok(f.byText(host, '桌面控制当前不可用。')); f.controller.dispose();
});
test('settings slot replacement isolates old controls and events; close ignores pending replies', async () => {
  const f = fixture();
  const dialog = f.host(), module = f.api.createModule({app: {$: id => {assert.equal(id, 'dialog'); return dialog;}}, bridge: f.bridge, onError: error => f.errors.push(error)});
  let firstCurrent = true, secondCurrent = true;
  const first = module.render({current: () => firstCurrent}); await flush();
  const oldListener = [...f.listeners][0], oldButton = f.byText(first, '设置定时停止');
  f.setStatus(snapshot()); firstCurrent = false;
  const second = module.render({current: () => secondCurrent}); await flush();
  assert.equal(first.children.length, 0); assert.equal(f.listeners.size, 1); assert.equal(f.intervals.size, 1);
  assert.deepEqual(f.counts(), {subscriptions: 2, unsubscriptions: 1});
  const before = f.calls.length; oldButton.fire('click'); oldListener(snapshot({available: false}));
  assert.equal(f.calls.length, before); assert.equal(f.byText(second, '桌面控制当前不可用。'), undefined);
  assert.equal(f.byText(second, '设置定时停止').disabled, false);
  dialog.fire('close'); assert.equal(f.listeners.size, 1); // A delayed old close must not remove the current dialog.
  let rejectWrite; f.setAction(() => new Promise((resolve, reject) => {rejectWrite = reject;}));
  f.byText(second, '设置定时停止').fire('click');
  secondCurrent = false; dialog.fire('close');
  assert.equal(second.children.length, 0); assert.equal(f.listeners.size, 0); assert.equal(f.intervals.size, 0);
  rejectWrite(new Error('旧操作失败')); await flush(); assert.equal(f.errors.length, 0);
  module.dispose(); module.dispose(); assert.equal(dialog.events.close, undefined);
});
test('an invalidated slot cleans up on pending completion or interval without a close event', async () => {
  let resolveStatus; const f = fixture(new Promise(resolve => {resolveStatus = resolve;}));
  const dialog = f.host(), module = f.api.createModule({app: {$: () => dialog}, bridge: f.bridge});
  let current = true; const first = module.render({current: () => current}); current = false;
  resolveStatus(snapshot()); await flush();
  assert.equal(first.children.length, 0); assert.equal(f.listeners.size, 0); assert.equal(f.intervals.size, 0);
  current = true; f.setStatus(snapshot()); const second = module.render({current: () => current}); await flush();
  current = false; [...f.intervals.values()][0]();
  assert.equal(second.children.length, 0); assert.equal(f.listeners.size, 0); assert.equal(f.intervals.size, 0);
  module.dispose(); assert.equal(dialog.events.close, undefined);
});
test('disposing an active settings module cleans all resources and ignores pending status', async () => {
  let resolveStatus; const f = fixture(new Promise(resolve => {resolveStatus = resolve;}));
  const dialog = f.host(), module = f.api.createModule({app: {$: () => dialog}, bridge: f.bridge});
  const host = module.render({current: () => true});
  assert.equal(f.listeners.size, 1); assert.equal(f.intervals.size, 1);
  module.dispose(); resolveStatus(snapshot()); await flush();
  assert.equal(host.children.length, 0); assert.equal(f.listeners.size, 0); assert.equal(f.intervals.size, 0);
  assert.equal(dialog.events.close, undefined); assert.throws(() => module.render({current: () => true}), /disposed/);
});
test('narrow layout can wrap controls and constrain inputs', () => {
  assert.match(css, /@media\s*\(max-width:\s*500px\)/);
  assert.match(css, /\.desktop-controls__timer-row\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.desktop-controls__shortcut-row\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.desktop-controls__field input,\s*\.desktop-controls__field select\s*\{[^}]*min-width:\s*0/s);
  assert.doesNotMatch(source, /innerHTML|HTMLAudioElement|AudioContext|mediaSession/);
});
