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
  const nodes = [], events = new Map(), calls = []; let value = initial, action = async () => {};
  const create = tag => {
    const node = {tag, hidden: false, disabled: false, textContent: '', children: [], attributes: new Map(), listeners: new Map(),
      setAttribute(key, v) {this.attributes.set(key, v);}, append(...children) {this.children.push(...children);},
      addEventListener(key, fn) {this.listeners.set(key, fn);}, click() {this.listeners.get('click')?.({target: this});}, focus() {}, select() {}};
    nodes.push(node); return node;
  };
  const anchor = {parentNode: {insertBefore() {}}}, audio = create('button');
  const document = {createElement: create, getElementById: id => id === 'connectionStrip' ? anchor : id === 'audioButton' ? audio : null,
    body: {prepend() {}}, addEventListener() {}, execCommand() {}};
  const still = {invoke: async (channel, payload) => {calls.push({channel, payload}); return channel === 'backend:setupStatus' ? value : action(channel);},
    on: (channel, callback) => {events.set(channel, callback);}};
  vm.runInNewContext(source, {document, still, setInterval: () => 1});
  return {nodes, calls, update(next) {value = next; events.get('backend-setup')(next);}, setAction: fn => {action = fn;},
    status: () => nodes.find(node => node.attributes.get('role') === 'status'), title: () => nodes.find(node => node.tag === 'h2')};
}
test('automatic main events replace busy text with the actual ready action without requiring a renderer setup click', async () => {
  const f = fixture({public: true, automatic: true, ready: false, busy: true, state: 'extracting-core', progress: {completed: 1, total: 21}});
  await flush(); assert.match(f.status().textContent, /正在/);
  f.update({public: true, automatic: true, ready: true, prepared: true, busy: false, state: 'ready', code: null});
  assert.match(f.status().textContent, /已完成.*具体共享输出/); assert.doesNotMatch(f.status().textContent, /正在/);
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
