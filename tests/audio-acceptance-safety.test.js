'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
// Memory-only transport/process fixtures. No HTTP server, application launch,
// audio probe, real process inspection or device access is performed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pinSession, createAcceptanceTransport, disconnectFeedback, completePhysicalHotplug, closeAcceptance, parseArgs, main } = require('../scripts/foobar-audio-acceptance');
const { createFoobarService } = require('../src/main/foobar');
const endpoint = '{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() { let release; return { promise: new Promise(resolve => { release = resolve; }), release: () => release() }; }
function response(value) { return value == null ? new Response(null, { status: 204 }) : Response.json(value); }
function processFixture(pid = 49321) {
  const backendDir = path.resolve('fixture-backend'), executable = path.join(backendDir, 'foobar2000.exe');
  return { backendDir, baseUrl: 'http://127.0.0.1:18880/api/',
    system: { processes: [{ pid, executablePath: executable }], listeners: [{ pid, address: '127.0.0.1' }, { pid, address: '::1' }] },
    process: { pid, executablePath: executable, createdAt: '2026-10-31T03:07:32.607Z' } };
}
test('session pin captures arbitrary live PID and exact creation time instead of a historical constant', () => {
  const f = processFixture(), session = pinSession(f);
  assert.equal(session.pid, 49321); assert.equal(session.createdAt, '2026-10-31T03:07:32.607Z');
  assert.deepEqual(pinSession({ ...f, expected: { ...session, createdAt: '/Date(1793416052607)/' } }), session);
  const next = processFixture(58217); assert.equal(pinSession(next).pid, 58217);
  assert.throws(() => pinSession({ ...next, expected: session }), /session changed/);
});
test('PID reuse, executable replacement, remote/mixed listeners and missing creation evidence reject before a write', () => {
  const f = processFixture(), session = pinSession(f);
  assert.throws(() => pinSession({ ...f, expected: session, process: { ...f.process, createdAt: '2026-10-31T04:07:32.607Z' } }), /session changed/);
  assert.throws(() => pinSession({ ...f, process: { ...f.process, executablePath: path.resolve('other/foobar2000.exe') } }), /exact executable/);
  assert.throws(() => pinSession({ ...f, process: { ...f.process, createdAt: null } }), /creation time/);
  assert.throws(() => pinSession({ ...f, system: { ...f.system, listeners: [{ pid: 49321, address: '0.0.0.0' }] } }), /identity\/address/);
  assert.throws(() => pinSession({ ...f, system: { ...f.system, listeners: [{ pid: 49321, address: '127.0.0.1' }, { pid: 1, address: '::1' }] } }), /identity\/address/);
});

test('direct restore deadline keeps actual play pending and permanently prevents a following pause/stop from being reported complete', async () => {
  const held = gate(), applied = []; let suppliedSignal;
  const transport = createAcceptanceTransport({ fetchImpl: async (url, init) => {
    suppliedSignal = init.signal; await held.promise; applied.push(new URL(url).pathname); return response(null);
  } });
  const old = transport.directPost('http://127.0.0.1/api/player/play/p1/0', {}, { timeoutMs: 15 });
  await assert.rejects(() => old, { code: 'ACCEPTANCE_POST_UNCERTAIN' });
  assert.equal(suppliedSignal, undefined); assert.equal(transport.status().pendingPosts, 1);
  await assert.rejects(() => transport.directPost('http://127.0.0.1/api/player/stop', {}), { code: 'ACCEPTANCE_POST_UNCERTAIN' });
  assert.deepEqual(applied, []); held.release(); await sleep(5);
  assert.deepEqual(applied, ['/api/player/play/p1/0']); assert.equal(transport.status().pendingPosts, 0);
  assert.equal(transport.status().uncertain, true);
  await assert.rejects(() => transport.directPost('http://127.0.0.1/api/player/pause', {}), { code: 'ACCEPTANCE_POST_UNCERTAIN' });
});
test('response headers do not count as settlement while a POST response body is still held', async () => {
  let complete;
  const stream = new ReadableStream({ start(controller) { complete = () => { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); }; } });
  const transport = createAcceptanceTransport({ fetchImpl: async () => new Response(stream) });
  await assert.rejects(() => transport.directPost('http://127.0.0.1/api/player/play/p1/0', {}, { timeoutMs: 15 }), { code: 'ACCEPTANCE_POST_UNCERTAIN' });
  assert.equal(transport.status().pendingPosts, 1); complete(); await sleep(5);
  assert.equal(transport.status().pendingPosts, 0); assert.equal(transport.status().uncertain, true);
});
test('a deadline during process preflight prevents the old direct write from dispatching after preflight later returns', async () => {
  const held = gate(); let posts = 0;
  const transport = createAcceptanceTransport({ beforePost: () => held.promise,
    fetchImpl: async () => { posts++; return response(null); } });
  await assert.rejects(() => transport.directPost('http://127.0.0.1/api/player/play/p1/0', {}, { timeoutMs: 15 }), { code: 'ACCEPTANCE_POST_UNCERTAIN' });
  held.release(); await sleep(5); assert.equal(posts, 0); assert.equal(transport.status().uncertain, true);
});
test('session guard rejection dispatches no POST and does not fabricate an actual sent request', async () => {
  let requests = 0;
  const transport = createAcceptanceTransport({ beforePost: async () => { throw new Error('session changed'); },
    fetchImpl: async () => { requests++; return response(null); } });
  await assert.rejects(() => transport.directPost('http://127.0.0.1/api/player/stop', {}), /session changed/);
  assert.equal(requests, 0); assert.equal(transport.status().pendingPosts, 0); assert.equal(transport.status().uncertain, false);
});
test('normal direct play and immediate pause await actual successful settlement and preserve exact order', async () => {
  const calls = [], transport = createAcceptanceTransport({ fetchImpl: async url => { calls.push(new URL(url).pathname); return response(null); } });
  await transport.directPost('http://127.0.0.1/api/player/play/original/50', {});
  await transport.directPost('http://127.0.0.1/api/player/pause', {});
  assert.deepEqual(calls, ['/api/player/play/original/50', '/api/player/pause']);
  assert.equal(transport.status().uncertain, false); assert.equal(transport.status().pendingPosts, 0);
});
test('actual socket loss is sticky even when later diagnostic GET succeeds', async () => {
  let writes = 0;
  const transport = createAcceptanceTransport({ fetchImpl: async (url, init) => {
    if (init.method === 'POST') { writes++; throw new Error('connection lost'); } return response({ available: true });
  } });
  await assert.rejects(() => transport.directPost('http://127.0.0.1/api/player/play/p1/0', {}), { code: 'ACCEPTANCE_POST_UNCERTAIN' });
  assert.equal((await (await transport.request('http://127.0.0.1/api/query')).json()).available, true);
  await assert.rejects(() => transport.request('http://127.0.0.1/api/player/stop', { method: 'POST', body: '{}' }), { code: 'ACCEPTANCE_POST_UNCERTAIN' });
  assert.equal(writes, 1);
});
test('real service stop cannot bypass a timed-out direct restoration play, and no stopped success is fabricated', async () => {
  const held = gate(), posts = []; let playing = false;
  const transport = createAcceptanceTransport({ fetchImpl: async (url, init) => {
    const route = new URL(url).pathname;
    if (init.method === 'POST') { posts.push(route); await held.promise; playing = true; return response(null); }
    return response({ player: { info: { name: 'foobar2000', pluginVersion: '0.10' }, playbackState: playing ? 'playing' : 'stopped',
      activeItem: {}, volume: { type: 'db', min: -100, max: 0, value: 0 } },
    outputs: { active: { typeId: 'output', deviceId: 'fixture' }, types: [{ id: 'output', name: 'Fixture', devices: [{ id: 'fixture', name: 'Fixture' }] }] } });
  } });
  const service = createFoobarService({ fetch: transport.request, baseUrl: 'http://127.0.0.1/api/', dataDir: path.join(__dirname, '.audio-acceptance-no-files'),
    pollIntervalMs: 0, persistOutputSelection: false, cleanupDelayMs: 60000 });
  try {
    await assert.rejects(() => transport.directPost('http://127.0.0.1/api/player/play/p1/0', {}, { timeoutMs: 15 }), { code: 'ACCEPTANCE_POST_UNCERTAIN' });
    await assert.rejects(() => service.stop(), { code: 'STILL_TRANSPORT_UNCERTAIN' });
    assert.deepEqual(posts, ['/api/player/play/p1/0']);
    assert.equal(transport.status().pendingPosts, 1);
    held.release(); await sleep(5);
    assert.equal(playing, true); assert.equal((await service.getState()).state, 'playing');
    assert.equal(transport.status().pendingPosts, 0); assert.equal(transport.status().uncertain, true);
    await assert.rejects(() => service.pause(), { code: 'STILL_TRANSPORT_UNCERTAIN' });
    assert.deepEqual(posts, ['/api/player/play/p1/0'], 'Late play settlement and diagnostic GET cannot authorize another write');
  } finally { held.release(); await service.close(); }
});
test('timed-out service POST is noticed by the harness catch path and cannot trigger an unbounded cleanup stop', async () => {
  const held = gate(); let posts = 0;
  const transport = createAcceptanceTransport({ fetchImpl: async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/player/stop'); assert.equal(init.method, 'POST');
    assert.equal(init.signal, undefined, 'Caller timeout must not pretend to revoke the actual POST');
    posts++; await held.promise; return response(null);
  } });
  const service = createFoobarService({ fetch: transport.request, baseUrl: 'http://127.0.0.1/api/', dataDir: path.join(__dirname, '.audio-acceptance-no-files'),
    pollIntervalMs: 0, timeoutMs: 15, cleanupDelayMs: 60000 });
  try {
    const error = await service.stop().catch(error => error); assert.equal(error.code, 'STILL_TRANSPORT_UNCERTAIN');
    assert.equal(transport.noteCallerFailure(error), true); assert.equal(transport.status().uncertain, true); assert.equal(posts, 1);
    assert.equal(transport.status().pendingPosts, 1);
    assert.throws(() => transport.assertMutable(), { code: 'ACCEPTANCE_POST_UNCERTAIN' });
    const evidence = { passed: false }, saves = [];
    const cleanup = await closeAcceptance({ service, transport, evidence, save: async () => { saves.push(JSON.stringify(evidence)); }, record: () => {}, timeoutMs: 15 });
    assert.equal(cleanup.closeSettled, false); assert.equal(cleanup.clientExitRequired, true); assert.ok(saves.length >= 2);
    assert.equal(posts, 1, 'Uncertain cleanup cannot dispatch a second stop');
    assert.equal(transport.status().pendingPosts, 1); assert.equal(transport.status().uncertain, true);
  } finally { held.release(); await service.close(); }
});

const connection = () => ({ status: 'disconnected', endpointId: endpoint, retryRequired: true, lastCheckedAt: '2026-10-31T03:12:30Z' });
const native = () => ({ endpoint, active: false, state: 4, hresult: '0x00000000' });
test('normalized disconnect requires exact structured endpoint/status/retry fields independently of backend reachability', () => {
  for (const available of [true, false]) {
    const state = { available, backendReachable: available, outputConnection: connection() };
    const details = { available, backendReachable: available, outputConnection: connection() };
    assert.equal(disconnectFeedback({ native: native(), state, details }).hasExplicitDeviceDisconnectFeedback, true);
  }
});
test('HTTP errors, vague unavailable text, wrong endpoint, missing retry and native query error never masquerade as disconnect feedback', () => {
  const state = { available: false, backendReachable: false, error: 'DAC disconnected unavailable', outputConnection: connection() };
  const details = { available: false, backendReachable: false, error: 'disconnected', outputConnection: connection() };
  for (const patch of [{ outputConnection: undefined }, { outputConnection: { ...connection(), status: 'unknown' } },
    { outputConnection: { ...connection(), endpointId: 'different' } }, { outputConnection: { ...connection(), retryRequired: false } },
    { backendReachable: undefined }, { backendReachable: true }])
    assert.equal(disconnectFeedback({ native: native(), state: { ...state, ...patch }, details }).hasExplicitDeviceDisconnectFeedback, false);
  assert.equal(disconnectFeedback({ native: { ...native(), state: null, hresult: '0x80004005' }, state, details }).hasExplicitDeviceDisconnectFeedback, false);
});
test('a witnessed physical cycle and successful retry cannot pass physical acceptance when normalized feedback is false or absent', () => {
  const facts = { disconnectedAt: '2026-10-31T03:30:00Z', reconnectedAt: '2026-10-31T03:30:05Z', endpoint };
  const complete = { disconnectedAt: 1000, reconnectedAt: 6000, sameEndpoint: true, explicitRetryVerified: true };
  for (const highLevelDisconnectFeedbackCovered of [false, undefined, 'true']) {
    const result = completePhysicalHotplug({ ...facts, highLevelDisconnectFeedbackCovered }, complete);
    assert.equal(result.tested, false); assert.equal(result.passed, false); assert.equal(result.physicalCycleObserved, true);
    assert.equal(result.explicitRetryVerified, true); assert.equal(result.normalizedDisconnectFeedbackVerified, false);
    assert.equal(result.status, 'physical-cycle-observed-normalized-feedback-unverified');
    assert.equal(result.disconnectedAt, facts.disconnectedAt); assert.equal(result.reconnectedAt, facts.reconnectedAt);
    assert.equal(result.nativeDisconnectedDurationMs, 5000);
  }
  const success = completePhysicalHotplug({ ...facts, highLevelDisconnectFeedbackCovered: true }, complete);
  assert.equal(success.tested, true); assert.equal(success.passed, true);
  assert.equal(success.status, 'physical-disconnect-reconnect-and-explicit-retry-verified');
  for (const patch of [{ sameEndpoint: false }, { explicitRetryVerified: false }, { reconnectedAt: null }]) {
    const rejected = completePhysicalHotplug({ ...facts, highLevelDisconnectFeedbackCovered: true }, { ...complete, ...patch });
    assert.equal(rejected.tested, false); assert.equal(rejected.passed, false); assert.doesNotMatch(rejected.status, /^physical-disconnect-reconnect-and-explicit-retry-verified$/);
  }
});
test('bounded close durably saves evidence before waiting and reports unknown instead of exiting a user app', async () => {
  const transport = createAcceptanceTransport(), events = [], evidence = { passed: true };
  const cleanup = await closeAcceptance({ transport, evidence, timeoutMs: 15,
    save: async () => { events.push('save'); }, record: () => { events.push('record'); },
    service: { close: () => { events.push('close'); return new Promise(() => {}); } } });
  assert.equal(events[0], 'save'); assert.equal(events[1], 'close'); assert.equal(evidence.passed, false);
  assert.equal(cleanup.closeSettled, false); assert.equal(cleanup.clientExitRequired, true);
  assert.match(cleanup.meaning, /never exited\/restarted/);
});
test('execute requires a reviewed session baseline and explicit released audio window acknowledgement', () => {
  const args = ['--execute', '--backend-dir', path.resolve('fixture-backend'), '--base-url', 'http://127.0.0.1:18880/api/'];
  assert.throws(() => parseArgs(args), /audio-window-ack/);
  assert.throws(() => parseArgs([...args, '--audio-window-ack']), /session-baseline/);
  const result = parseArgs([...args, '--audio-window-ack', '--session-baseline', 'owner-summary.json', '--probe-bits', '32']);
  assert.equal(result.audioWindowAck, true); assert.equal(result.probeBits, 32);
});
test('default and hotplug plan-only invocations execute no fetch or real inspection', async () => {
  const previous = globalThis.fetch, log = console.log, output = [];
  globalThis.fetch = () => { throw new Error('Plan contacted backend'); }; console.log = text => output.push(JSON.parse(text));
  try { await main([]); await main(['--hotplug', '--probe-bits', '32']); }
  finally { globalThis.fetch = previous; console.log = log; }
  assert.equal(output.length, 2); assert.ok(output.every(item => item.executed === false && item.target.pinsPidExecutableAndCreationTime === true));
});
