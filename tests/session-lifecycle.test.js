'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createFoobarSessionService} = require('../src/main/foobar-session');

function fixture() {
  let session = {sessionId: 'first', pid: 101}, proof = null;
  const services = [], updates = [], outputEvents = [];
  const backend = {getSession: () => session, getExitEvidence: token => proof?.token === token ? proof : null};
  const service = createFoobarSessionService({backend, onUpdate: value => updates.push(value),
    onOutputConnection: value => outputEvents.push(value), createService(options) {
      const events = new EventEmitter(), calls = [];
      const bridge = {calls, events, options, closed: false, bound: null,
        on: events.on.bind(events),
        bindBackendSession(value) {this.bound = value; calls.push(['bind', value.sessionId]);},
        markBackendExited(value) {
          assert.equal(value.token, this.bound); this.closed = true; calls.push(['exit', value.token.sessionId]);
        },
        initialize: async () => {calls.push(['initialize']); return {available: true, state: 'stopped'};},
        getState: async () => ({available: !bridge.closed, state: bridge.closed ? 'unavailable' : 'stopped'}),
        play: async value => {calls.push(['play', value]); return value;},
        transportStatus: () => ({closed: bridge.closed, controlUncertain: false, pendingControlRequests: 0}),
        close: async () => {calls.push(['close']); bridge.closed = true;},
      };
      services.push(bridge); return bridge;
    }});
  return {service, services, updates, outputEvents,
    setSession: value => {session = value;}, exit: token => {proof = {token};}, firstSession: session};
}

test('a new owned session replaces a bridge only after the old exact session proof and drain', async () => {
  const f = fixture();
  await f.service.connect({available: true, pid: 101});
  const old = f.services[0], second = {sessionId: 'second', pid: 102};
  f.setSession(second);
  await assert.rejects(f.service.connect({available: true, pid: 102}), /退出证据/);
  assert.equal(f.services.length, 1);
  f.exit(f.firstSession);
  await f.service.connect({available: true, pid: 102});
  assert.equal(f.services.length, 2);
  assert.deepEqual(old.calls.slice(-2), [['exit', 'first'], ['close']]);
  assert.equal(f.services[1].bound, second);
  await f.service.play('new intent');
  assert.equal(old.calls.some(call => call[0] === 'play'), false);
  assert.deepEqual(f.services[1].calls.at(-1), ['play', 'new intent']);
  await f.service.close();
});

test('a retry on the same live session keeps its bridge and transport lifetime', async () => {
  const f = fixture();
  await f.service.connect({available: true, pid: 101});
  f.services[0].transportStatus = () => ({closed: false, controlUncertain: true, pendingControlRequests: 1});
  await f.service.connect({available: true, pid: 101});
  assert.equal(f.services.length, 1);
  assert.equal(f.service.transportStatus().controlUncertain, true);
  await f.service.close();
});

test('late state and device events from a retired bridge cannot replace the current session state', async () => {
  const f = fixture();
  await f.service.connect({available: true, pid: 101});
  const old = f.services[0];
  f.exit(f.firstSession); f.setSession({sessionId: 'second', pid: 102});
  await f.service.connect({available: true, pid: 102});
  old.options.onUpdate({state: 'playing', stale: true}); old.events.emit('output-connection', {status: 'disconnected', stale: true});
  f.services[1].options.onUpdate({state: 'stopped'});
  f.services[1].events.emit('output-connection', {status: 'connected'});
  assert.deepEqual(f.updates, [{state: 'stopped'}]);
  assert.deepEqual(f.outputEvents, [{status: 'connected'}]);
  await f.service.close();
});

test('an unowned observed process cannot be replaced using an unrelated new PID or proof', async () => {
  const f = fixture(); f.setSession(null);
  await f.service.connect({available: true, pid: 201});
  f.exit(f.firstSession); f.setSession({sessionId: 'other', pid: 202});
  await assert.rejects(f.service.connect({available: true, pid: 202}), /退出证据/);
  assert.equal(f.services.length, 1); assert.equal(f.services[0].calls.some(call => call[0] === 'close'), false);
  await f.service.close();
});

test('bridge drain timeout keeps the old closed bridge and refuses a new transport', async () => {
  let resolveClose;
  const oldClose = new Promise(resolve => {resolveClose = resolve;});
  const first = {sessionId: 'first', pid: 301}, second = {sessionId: 'second', pid: 302};
  let session = first, exited = false, count = 0;
  const bridge = {bindBackendSession() {}, initialize: async () => ({available: true}), markBackendExited() {}, close: () => oldClose};
  const service = createFoobarSessionService({drainTimeoutMs: 15,
    backend: {getSession: () => session, getExitEvidence: token => exited && token === first ? {token} : null},
    createService: () => {count++; return bridge;}});
  await service.connect({available: true, pid: 301}); session = second; exited = true;
  await assert.rejects(service.connect({available: true, pid: 302}), /尚未排空/);
  assert.equal(count, 1);
  resolveClose(); await service.close();
});
