'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createFoobarSessionService} = require('../src/main/foobar-session');
const {isVerifiedBackendChildExit} = require('../src/main/backend');
const {createSyntheticOwnedBackend} = require('./helpers/synthetic-owned-backend');

async function fixture(t, options = {}) {
  const first = await createSyntheticOwnedBackend(t, {port: options.port || 19341});
  const second = await createSyntheticOwnedBackend(t, {root: first.root, port: options.port || 19341});
  let selected = first, suppliedProof = null;
  const proofs = new Map(), services = [], updates = [], outputEvents = [], http = [];
  const backend = {getSession: () => selected.session, getInfo: () => selected.info,
    getExitEvidence: token => suppliedProof || proofs.get(token) || null};
  const service = createFoobarSessionService({backend, drainTimeoutMs: options.drainTimeoutMs || 100,
    serviceOptions: {foobarDir: first.backendDir, baseUrl: options.initialUrl || first.info.baseUrl},
    onUpdate: value => updates.push(value), onOutputConnection: value => outputEvents.push(value), createService(settings) {
      const events = new EventEmitter(), calls = [];
      const bridge = {calls, events, options: settings, closed: false, bound: null,
        on: events.on.bind(events), bindBackendSession(value) {this.bound = value; calls.push(['bind', value.sessionId]);},
        markBackendExited(value) {assert.equal(isVerifiedBackendChildExit(value, this.bound), true); this.closed = true; calls.push(['exit', value.sessionId]);},
        initialize: async () => {http.push(settings.baseUrl); calls.push(['initialize']); return {available: true, state: 'stopped'};},
        getState: async () => {http.push(settings.baseUrl); return {available: !bridge.closed, state: bridge.closed ? 'unavailable' : 'stopped'};},
        outputs: async () => {http.push(settings.baseUrl); return {};},
        play: async value => {calls.push(['play', value]); http.push(settings.baseUrl); return value;},
        capabilities: () => ({playback: false}), restoreInfo: () => ({baseUrl: settings.baseUrl}),
        outputConnection: async () => ({status: 'unknown'}), audioDetails: async value => {if (value?.readBackend !== false) http.push(settings.baseUrl); return {available: false};},
        cancelPending: async () => {},
        beginShutdownWrites() {calls.push(['quiesce']); return Object.freeze({stop: async () => {calls.push(['shutdown-stop']);}});},
        transportStatus: () => ({closed: bridge.closed, controlUncertain: false, pendingControlRequests: 0}),
        close: async () => {calls.push(['close']); bridge.closed = true;},
      };
      services.push(bridge); return bridge;
    }});
  t.after(() => service.close());
  return {service, services, updates, outputEvents, first, second, http,
    select: value => {selected = value;}, setProof: value => {suppliedProof = value;},
    exit: async entry => {const result = await entry.manager.close(); proofs.set(entry.session, result.exitEvidence); return result.exitEvidence;}};
}

test('a new owned session replaces a bridge only after the exact branded child proof and drain', async t => {
  const f = await fixture(t); await f.service.connect(f.first.info);
  const old = f.services[0]; f.select(f.second);
  await assert.rejects(f.service.connect(f.second.info), /退出证据/); assert.equal(f.services.length, 1);
  await f.exit(f.first); await f.service.connect(f.second.info);
  assert.equal(f.services.length, 2); assert.deepEqual(old.calls.slice(-2), [['exit', f.first.session.sessionId], ['close']]);
  assert.equal(f.services[1].bound, f.second.session);
  await f.service.play('new intent'); assert.equal(old.calls.some(call => call[0] === 'play'), false);
  assert.deepEqual(f.services[1].calls.at(-1), ['play', 'new intent']);
});

test('same live session retry preserves its bridge and sticky transport lifetime', async t => {
  const f = await fixture(t); await f.service.connect(f.first.info);
  f.services[0].transportStatus = () => ({closed: false, controlUncertain: true, pendingControlRequests: 1});
  await f.service.connect(f.first.info); assert.equal(f.services.length, 1); assert.equal(f.service.transportStatus().controlUncertain, true);
});

test('read recovery admission belongs only to the connected current branded session and closes on retirement or shutdown', async t => {
  const f = await fixture(t);
  assert.equal(f.service.canReadSession(f.first.session), false);
  await f.service.connect(f.first.info);
  assert.equal(f.service.canReadSession(f.first.session), true);
  assert.equal(f.service.canReadSession({...f.first.session}), false);
  f.select(f.second); assert.equal(f.service.canReadSession(f.first.session), false);
  assert.equal(f.service.canReadSession(f.second.session), false);
  await f.exit(f.first); assert.equal(f.service.canReadSession(f.first.session), false);
  await f.service.connect(f.second.info); assert.equal(f.service.canReadSession(f.second.session), true);
  f.service.beginShutdownWrites(); assert.equal(f.service.canReadSession(f.second.session), false);
});

test('an in-flight connect cannot admit read recovery before its binding and initial read finish', async t => {
  const f = await fixture(t); let finish;
  const gate = new Promise(resolve => {finish = resolve;});
  f.services[0].initialize = async () => {await gate; return {available: false};};
  const connecting = f.service.connect(f.first.info);
  assert.equal(f.service.canReadSession(f.first.session), false);
  finish(); await connecting;
  assert.equal(f.service.canReadSession(f.first.session), true);
});

test('retired bridge state and output events cannot replace the current session', async t => {
  const f = await fixture(t); await f.service.connect(f.first.info); const old = f.services[0];
  await f.exit(f.first); f.select(f.second); await f.service.connect(f.second.info);
  old.options.onUpdate({state: 'playing', stale: true}); old.events.emit('output-connection', {stale: true});
  f.services[1].options.onUpdate({state: 'stopped'}); f.services[1].events.emit('output-connection', {status: 'connected'});
  assert.deepEqual(f.updates, [{state: 'stopped'}]); assert.deepEqual(f.outputEvents, [{status: 'connected'}]);
});

test('observed unowned process cannot be replaced with an unrelated new owned proof', async t => {
  const f = await fixture(t); const observed = {info: {...f.first.info, owned: false, pid: 201}, session: null};
  f.select(observed); await f.service.connect(observed.info); await f.exit(f.first); f.select(f.second);
  await assert.rejects(f.service.connect(f.second.info), /退出证据/); assert.equal(f.services.length, 1);
  assert.equal(f.services[0].calls.some(call => call[0] === 'close'), false);
});

test('bridge drain timeout keeps the retired bridge and refuses a new transport', async t => {
  const f = await fixture(t, {drainTimeoutMs: 15}); await f.service.connect(f.first.info);
  let release; const held = new Promise(resolve => {release = resolve;}); f.services[0].close = () => held;
  await f.exit(f.first); f.select(f.second); await assert.rejects(f.service.connect(f.second.info), /尚未排空/);
  assert.equal(f.services.length, 1); release();
});

test('pre-connect HTTP and writes are blocked; actual manifest port creates the bound bridge', async t => {
  const f = await fixture(t, {port: 20123, initialUrl: 'http://127.0.0.1:18880/api/'});
  assert.equal((await f.service.getState()).available, false);
  for (const name of ['initialize', 'outputs', 'play']) await assert.rejects(f.service[name](), {code: 'STILL_BACKEND_UNVERIFIED'});
  await f.service.audioDetails({readBackend: true}); await f.service.outputConnection(); f.service.capabilities(); f.service.restoreInfo();
  assert.equal(f.http.length, 0);
  await f.service.connect(f.first.info);
  assert.equal(f.services.length, 2); assert.equal(f.services[0].closed, true);
  assert.equal(f.services[1].options.baseUrl, 'http://127.0.0.1:20123/api/'); assert.equal(f.services[1].bound, f.first.session);
  assert.deepEqual(f.http, ['http://127.0.0.1:20123/api/']);
});

test('copied exit JSON and mismatched actual endpoint never authenticate a session', async t => {
  const f = await fixture(t); await f.service.connect(f.first.info);
  const proof = await f.exit(f.first); f.setProof({...proof}); f.select(f.second);
  await assert.rejects(f.service.connect(f.second.info), /退出证据/); assert.equal(f.services.length, 1);
  assert.throws(() => f.service.markBackendExited({...proof}), {code: 'STILL_BACKEND_UNVERIFIED'});
  await assert.rejects(f.service.connect({...f.second.info, baseUrl: 'http://127.0.0.1:20555/api/'}), {code: 'STILL_BACKEND_UNVERIFIED'});
  assert.equal(f.services.length, 1); f.setProof(null);
});

test('pre-connect shutdown quiesce is synchronous, stable and dispatches nothing', async t => {
  const f = await fixture(t), initialSlots = f.services.length;
  const permit = f.service.beginShutdownWrites(); assert.equal(Object.isFrozen(permit), true);
  assert.equal(f.service.beginShutdownWrites(), permit); assert.equal(f.services.length, initialSlots);
  await assert.rejects(permit.stop(), {code: 'STILL_SHUTDOWN_NOT_OWNED'});
  await assert.rejects(f.service.connect(f.first.info), {code: 'STILL_SHUTDOWN_WRITES_CLOSED'});
  await assert.rejects(f.service.play('late'), {code: 'STILL_SHUTDOWN_WRITES_CLOSED'});
  assert.equal(f.http.length, 0); assert.equal(f.services[0].calls.length, 0); assert.equal(f.service.transportStatus().writesQuiesced, true);
});

test('connected shutdown forwards exactly one current-bridge permit and permanently closes proxy writes', async t => {
  const f = await fixture(t); await f.service.connect(f.first.info);
  const permit = f.service.beginShutdownWrites(); assert.equal(f.service.beginShutdownWrites(), permit);
  assert.equal(f.services[0].calls.filter(row => row[0] === 'quiesce').length, 1);
  await assert.rejects(f.service.play('late'), {code: 'STILL_SHUTDOWN_WRITES_CLOSED'});
  await permit.stop(); assert.equal(f.services[0].calls.filter(row => row[0] === 'shutdown-stop').length, 1);
});

test('quiesce during retired bridge drain cannot construct or initialize a replacement slot', async t => {
  const f = await fixture(t); await f.service.connect(f.first.info);
  let release, entered;
  const held = new Promise(resolve => {release = resolve;}), waiting = new Promise(resolve => {entered = resolve;});
  f.services[0].close = () => {entered(); return held;};
  await f.exit(f.first); f.select(f.second);
  const connecting = f.service.connect(f.second.info); await waiting;
  const permit = f.service.beginShutdownWrites(); assert.equal(f.service.beginShutdownWrites(), permit);
  release(); await assert.rejects(connecting, {code: 'STILL_SHUTDOWN_WRITES_CLOSED'});
  assert.equal(f.services.length, 1); assert.equal(f.services[0].calls.filter(row => row[0] === 'initialize').length, 1);
  await assert.rejects(f.service.play('after drain'), {code: 'STILL_SHUTDOWN_WRITES_CLOSED'});
});
