'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/backend-setup.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(initial) {
  const nodes = [], events = new Map(), listeners = new Map(), calls = [];
  let value = initial, action = async () => {}, readStatus = async () => value;
  const create = tag => {
    const node = {tag, hidden: false, disabled: false, textContent: '', children: [], attributes: new Map(), listeners: new Map(),
      setAttribute(key, v) {this.attributes.set(key, v);}, append(...children) {this.children.push(...children);},
      addEventListener(key, fn) {this.listeners.set(key, fn);}, click() {this.listeners.get('click')?.({target: this});}, focus() {}, select() {}};
    nodes.push(node); return node;
  };
  const home = create('div'), audio = create('button');
  const document = {createElement: create, getElementById: id => id === 'settingsControlsHome' ? home : id === 'audioButton' ? audio : null,
    addEventListener: (name, listener) => listeners.set(name, listener), execCommand() {}};
  audio.closest = selector => selector.split(', ').includes('#audioButton') ? audio : null;
  const still = {invoke: async (channel, payload) => {calls.push({channel, payload}); return channel === 'backend:setupStatus' ? readStatus() : action(channel);},
    on: (channel, callback) => {events.set(channel, callback);}};
  vm.runInNewContext(source, {document, still, setInterval: () => 1});
  return {nodes, calls, update(next) {value = next; events.get('backend-setup')(next);}, setAction: fn => {action = fn;},
    setReadStatus: fn => {readStatus = fn;}, openSettings: () => listeners.get('click')({target: audio}),
    panel: () => home.children.find(node => node.id === 'backendSetupControls'),
    status: () => nodes.find(node => node.attributes.get('role') === 'status'), title: () => nodes.find(node => node.tag === 'h3')};
}
test('automatic main events replace busy text with the actual ready action without requiring a renderer setup click', async () => {
  const f = fixture({public: true, automatic: true, ready: false, busy: true, state: 'extracting-core', progress: {completed: 1, total: 21}});
  await flush(); assert.match(f.status().textContent, /正在/);
  const ready = {public: true, automatic: true, ready: true, prepared: true, busy: false, state: 'ready', code: null};
  f.update(ready);
  assert.match(f.status().textContent, /已完成.*具体共享输出/); assert.doesNotMatch(f.status().textContent, /正在/);
  f.nodes.find(node => node.textContent === '收起设置').click(); await flush();
  f.update(ready);
  assert.equal(f.panel().hidden, true);
  f.setReadStatus(async () => {throw new Error('Status unavailable');});
  f.openSettings();
  assert.equal(f.panel().hidden, false);
  await flush();
  assert.equal(f.panel().hidden, false);
  assert.equal(f.calls.some(call => call.channel === 'backend:setupBegin'), false);
});
test('an automatic failure/retry/ready transition clears stale errors and does not keep a preparing title', async () => {
  const f = fixture({public: true, automatic: true, ready: false, busy: false, state: 'retry-required', code: 'STILL_BACKEND_SETUP_FAILED'});
  await flush(); assert.match(f.title().textContent, /未完成/); assert.doesNotMatch(f.title().textContent, /正在/);
  assert.match(f.status().textContent, /未完成/);
  let release; const gate = new Promise(resolve => {release = resolve;}); f.setAction(() => gate);
  f.nodes.find(node => node.textContent === '重试自动准备').click();
  f.update({public: true, automatic: true, ready: false, busy: true, state: 'preparing-profile', code: null});
  assert.match(f.status().textContent, /正在/);
  f.update({public: true, automatic: true, ready: true, prepared: true, busy: false, state: 'ready', code: null});
  release(); await flush(); await flush();
  assert.match(f.status().textContent, /已完成/); assert.doesNotMatch(f.status().textContent, /未完成|正在/);
  assert.equal(f.nodes.find(node => node.textContent === '打开官方安装器').hidden, true);
});
test('managed automatic polling stops on ready or stalled failure and resumes only during active automatic setup', async () => {
  const intervals = new Map(); let nextId = 0; const events = new Map();
  const create = tag => ({tag, hidden: false, disabled: false, textContent: '', children: [], attributes: new Map(), listeners: new Map(),
    setAttribute(key, v) {this.attributes.set(key, v);}, append(...children) {this.children.push(...children);},
    addEventListener(key, fn) {this.listeners.set(key, fn);}, click() {this.listeners.get('click')?.({target: this});}, focus() {}, select() {}});
  const home = create('div');
  const document = {createElement: create, getElementById: id => id === 'settingsControlsHome' ? home : null, addEventListener() {}, execCommand() {}};
  const still = {invoke: async () => ({public: true, automatic: true, ready: false, busy: true, state: 'extracting-core', code: null}),
    on: (channel, callback) => {events.set(channel, callback);}};
  vm.runInNewContext(source, {document, still,
    setInterval: (fn, ms) => {const id = ++nextId; intervals.set(id, {fn, ms}); return id;},
    clearInterval: id => {intervals.delete(id);}});
  await flush();
  assert.equal(intervals.size, 1);
  events.get('backend-setup')({public: true, automatic: true, ready: false, busy: false, connecting: false, state: 'retry-required', code: 'STILL_BACKEND_SETUP_FAILED'});
  assert.equal(intervals.size, 0);
  events.get('backend-setup')({public: true, automatic: true, ready: false, busy: true, state: 'preparing-profile', code: null});
  assert.equal(intervals.size, 1);
  events.get('backend-setup')({public: true, automatic: true, ready: true, prepared: true, busy: false, state: 'ready', code: null});
  assert.equal(intervals.size, 0);
});
