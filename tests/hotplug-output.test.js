'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
// All transport and CoreAudio observations in this file are injected fixtures.
// No application, device, native probe or audio stream is started by these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFoobarService } = require('../src/main/foobar');
const DEVICE = '0DD9B977-765B-4804-BF2D-B28EBF0C510D:016F9F0C-AFE4-4072-9018-CCEBB576B4CB';
const OTHER = '0DD9B977-765B-4804-BF2D-B28EBF0C510D:11111111-2222-3333-4444-555555555555';
const ENDPOINT = '{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}';
const outputId = deviceId => JSON.stringify(['output', deviceId]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() {
  let release, entered;
  return { promise: new Promise(resolve => { release = resolve; }), entered: new Promise(resolve => { entered = resolve; }),
    release: () => release(), enter: () => entered() };
}
const columns = ['C:\\Music\\fixture.wav', '0', 'Fixture', '', '', '100', 'PCM', '48000', '16', '2'];
function stateEvidence(endpoint, state = 1) {
  return { at: new Date().toISOString(), endpoint, operation: 'GetState', mode: 'state', deviceFound: true,
    deviceNotFound: false, state, active: Boolean(state & 1), disabled: Boolean(state & 2),
    notPresent: Boolean(state & 4), unplugged: Boolean(state & 8), hresult: '0x00000000',
    clientActivated: false, initializeCalled: false, startCalled: false, actualDacRate: null };
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'still-hotplug-test-'));
  const calls = [], probes = [], services = [], holds = [], lists = [{ id: 'user', title: 'User', items: [columns] }];
  let online = true, nativeState = 1, probeFailure = null, evidencePatch = null, active = DEVICE;
  let listed = true, noActive = false, playback = 'stopped', position = 0, volume = 0, order = 0, hook = null;
  const outputs = () => ({ active: noActive ? null : { typeId: 'output', deviceId: active }, types: [{ id: 'output', name: 'Output',
    devices: [...(listed ? [{ id: DEVICE, name: 'DX1 II [exclusive]' }] : []), { id: OTHER, name: 'Other speaker' }] }] });
  const player = () => ({ info: { name: 'foobar2000', pluginVersion: '0.10' }, playbackState: playback,
    activeItem: { playlistId: 'user', index: 0, position: playback === 'playing' ? (position += 0.2) : position, duration: 100, columns },
    volume: { type: 'db', min: -100, max: 0, value: volume },
    options: [{ id: 'playbackOrder', type: 'enum', value: order, enumNames: ['Default', 'Repeat'] }] });
  const fetch = async (url, init) => {
    const route = new URL(url).pathname.replace('/api/', ''), body = init.body ? JSON.parse(init.body) : null;
    const call = { route, method: init.method, body }; calls.push(call);
    if (!online) throw new Error('fixture backend unreachable');
    if (hook) await hook(call);
    const send = value => ({ ok: true, text: async () => value == null ? '' : JSON.stringify(value) });
    if (route === 'query') return send({ player: player(), outputs: outputs(), playQueue: [] });
    if (route === 'outputs') return send({ outputs: outputs() });
    if (route === 'outputs/active') { active = body.deviceId; return send(null); }
    if (route === 'player') { if (body.volume != null) volume = body.volume; if (body.options) order = body.options[0].value; return send(null); }
    if (route === 'player/play' || /^player\/play\//.test(route)) { playback = 'playing'; return send(null); }
    if (route === 'player/stop') { playback = 'stopped'; return send(null); }
    if (route === 'player/pause') { playback = 'paused'; return send(null); }
    if (route === 'player/next' || route === 'player/previous') { playback = 'playing'; return send(null); }
    if (route === 'playlists') return send({ playlists: lists.map(item => ({ id: item.id, title: item.title, itemCount: item.items.length })) });
    if (route === 'playlists/add') { const list = { id: `deck${lists.length}`, title: body.title, items: [] }; lists.push(list); return send(list); }
    let match;
    if ((match = route.match(/^playlists\/([^/]+)\/items\/(\d+):(\d+)$/))) {
      const list = lists.find(item => item.id === match[1]), offset = Number(match[2]);
      return send({ playlistItems: { offset, totalCount: list.items.length, items: list.items.slice(offset, offset + Number(match[3])).map(columns => ({ columns })) } });
    }
    if ((match = route.match(/^playlists\/([^/]+)\/([^/]+)\/items\/copy$/))) {
      const from = lists.find(item => item.id === match[1]), to = lists.find(item => item.id === match[2]);
      to.items.push(...body.items.map(index => from.items[index])); return send(null);
    }
    throw new Error(`unhandled fixture route ${route}`);
  };
  const probeOutputState = async ({ endpointId }) => {
    probes.push(endpointId);
    if (probeFailure) throw probeFailure;
    return { ...stateEvidence(endpointId, nativeState), ...evidencePatch };
  };
  function create(extra = {}) {
    const service = createFoobarService({ dataDir: directory, baseUrl: 'http://127.0.0.1:18999/api/', pollIntervalMs: 0,
      timeoutMs: 25, outputProbeTtlMs: 0, verifyTimeoutMs: 200, verifyPollMs: 2, cleanupDelayMs: 60000, fetch, probeOutputState, ...options, ...extra });
    services.push(service); return service;
  }
  const service = create();
  t.after(async () => {
    for (const hold of holds) hold.release();
    await Promise.all(services.map(item => item.close()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { service, create, directory, calls, probes,
    setNative: value => { nativeState = value; }, setOnline: value => { online = value; }, setActive: value => { active = value; },
    setListed: value => { listed = value; }, setNoActive: value => { noActive = value; },
    setPlayback: value => { playback = value; }, setProbeFailure: value => { probeFailure = value; }, setEvidencePatch: value => { evidencePatch = value; },
    hold(predicate) { const hold = gate(); holds.push(hold); let used = false;
      hook = async call => { if (!used && predicate(call)) { used = true; hold.enter(); await hold.promise; } }; return hold; },
    setHook: value => { hook = value; }, active: () => active,
  };
}

test('disconnected selected DAC remains distinct from reachable playing backend and blocks starts, while stop/read stay usable', async t => {
  const f = await fixture(t); f.setPlayback('playing');
  const seen = []; f.service.on('player', value => seen.push(value));
  await f.service.initialize(); f.setNative(4);
  const state = await f.service.getState();
  assert.equal(state.available, true); assert.equal(state.backendReachable, true); assert.equal(state.state, 'playing');
  assert.equal(state.outputConnection.status, 'disconnected'); assert.equal(state.outputConnection.endpointId, ENDPOINT);
  assert.equal(state.outputConnection.retryRequired, true); assert.equal(f.service.capabilities().playback, false);
  const before = f.calls.length;
  for (const action of [() => f.service.play({ paths: [columns[0]] }), () => f.service.next(), () => f.service.previous()])
    await assert.rejects(action, error => error.code === 'STILL_OUTPUT_DISCONNECTED');
  f.setPlayback('paused');
  await assert.rejects(() => f.service.toggle(), error => error.code === 'STILL_OUTPUT_DISCONNECTED');
  assert.equal(f.calls.slice(before).filter(item => item.method === 'POST').length, 0);
  assert.equal(seen.some(item => item.state === 'stopped'), false);
  const stopped = await f.service.stop(); assert.equal(stopped.state, 'stopped');
  const details = await f.service.audioDetails();
  assert.equal(details.backendReachable, true); assert.equal(details.outputConnection.status, stopped.outputConnection.status);
  assert.equal(details.outputConnection.endpointId, stopped.outputConnection.endpointId);
  assert.equal(details.actualDacRate, null); assert.equal(details.measured.sampleRate, null);
});

test('offline diagnostics lazily recover exact cached output without HTTP, including before initialize', async t => {
  const f = await fixture(t); await f.service.initialize(); await f.service.close();
  const saved = JSON.parse(await fs.readFile(path.join(f.directory, 'foobar-output-selection.json'), 'utf8'));
  assert.equal(saved.version, 1); assert.equal(saved.output.deviceId, DEVICE);
  f.setOnline(false); f.setNative(8);
  const second = f.create(); const before = f.calls.length;
  const connection = await second.outputConnection();
  const details = await second.audioDetails({ readBackend: false });
  assert.equal(f.calls.length, before); assert.equal(connection.status, 'disconnected');
  assert.equal(connection.endpointId, ENDPOINT); assert.equal(details.selection.deviceId, DEVICE);
  assert.equal(details.backendReachable, false); assert.equal(details.capabilities.playback, false);
  const state = await second.getState();
  assert.equal(state.state, 'unavailable'); assert.equal(state.backendReachable, false); assert.equal(state.outputConnection.status, 'disconnected');
  f.setNative(1);
  assert.equal((await second.outputConnection()).status, 'connected');
  await assert.rejects(() => second.retryOutput(), /连接中断/);
  assert.equal(f.calls.slice(before).filter(item => item.method === 'POST').length, 0);
});

test('reconnection reports explicit retry requirement, never starts playback, and explicit retry does not play', async t => {
  const f = await fixture(t); const events = [];
  f.service.on('output-connection', value => events.push(value));
  assert.equal((await f.service.initialize()).outputConnection.retryRequired, false);
  f.setNative(4); await f.service.outputConnection();
  const before = f.calls.length;
  f.setNative(1); const reconnected = await f.service.outputConnection();
  assert.equal(reconnected.status, 'connected'); assert.equal(reconnected.retryRequired, true);
  const retry = await f.service.retryOutput();
  assert.equal(retry.ready, true); assert.equal(retry.outputConnection.retryRequired, false);
  assert.equal(f.calls.slice(before).filter(item => item.method === 'POST').length, 0);
  assert.equal(events.some(item => item.status === 'disconnected'), true);
  assert.equal(events.some(item => item.status === 'connected' && item.retryRequired), true);
  assert.equal((await f.service.play({ paths: [columns[0]] })).state, 'playing');
  assert.equal(f.active(), DEVICE);
});

test('cold startup keeps exact active GUID when device listing omits it and refuses a completely missing selection', async t => {
  const f = await fixture(t); f.setListed(false); f.setNative(4);
  await assert.rejects(() => f.service.play({ paths: [columns[0]] }), error => error.code === 'STILL_OUTPUT_DISCONNECTED');
  assert.ok(f.probes.every(item => item === ENDPOINT)); assert.ok(f.probes.length > 0);
  assert.equal(f.calls.filter(item => item.method === 'POST').length, 0);
  const other = await fixture(t); other.setNoActive(true);
  await assert.rejects(() => other.service.play({ paths: [columns[0]] }), error => error.code === 'STILL_OUTPUT_UNKNOWN');
  assert.equal(other.calls.filter(item => item.method === 'POST').length, 0);
});

test('probe failure or invalid evidence remains unknown, blocks exact CoreAudio playback, and never fabricates a disconnect', async t => {
  const f = await fixture(t); await f.service.initialize();
  f.setProbeFailure(new Error('fixture missing probe'));
  assert.equal((await f.service.getState()).outputConnection.status, 'unknown');
  await assert.rejects(() => f.service.play({ paths: [columns[0]] }), error => error.code === 'STILL_OUTPUT_UNKNOWN');
  assert.equal(f.service.capabilities().playback, false); f.setProbeFailure(null);
  for (const patch of [{ endpoint: '{0.0.0.00000000}.{11111111-2222-3333-4444-555555555555}' }, { initializeCalled: true }, { startCalled: true }, { actualDacRate: 48000 }]) {
    f.setEvidencePatch(patch); assert.equal((await f.service.outputConnection()).status, 'unknown');
  }
  assert.equal(f.calls.filter(item => item.method === 'POST').length, 0);
});

test('missing native probe executable produces unknown diagnostics and rejects playback without activating a device', async t => {
  const f = await fixture(t);
  const service = f.create({probeOutputState: async () => {throw Object.assign(new Error('fixture missing helper'), {code: 'ENOENT'});},
    probePath: path.join(f.directory, 'missing-probe.exe')});
  const state = await service.initialize();
  assert.equal(state.backendReachable, true); assert.equal(state.outputConnection.status, 'unknown');
  assert.match(state.outputConnection.probeError, /ENOENT/);
  await assert.rejects(() => service.play({ paths: [columns[0]] }), error => error.code === 'STILL_OUTPUT_UNKNOWN');
  assert.equal(f.calls.some(item => item.method === 'POST'), false);
});

test('a confirmed but unmappable output reports unknown without inventing a DAC disconnection', async t => {
  const f = await fixture(t); f.setActive('explicit-unmapped-output');
  const state = await f.service.initialize();
  assert.equal(state.outputConnection.status, 'unknown'); assert.equal(state.outputConnection.endpointId, null);
  assert.equal(f.probes.length, 0); assert.equal(f.service.capabilities().playback, true);
  assert.equal((await f.service.play({ paths: [columns[0]] })).state, 'playing');
  assert.equal(f.probes.length, 0);
});

test('an actual output mismatch cannot silently redefine the remembered DAC, and requires an explicit selection', async t => {
  const f = await fixture(t); await f.service.initialize(); f.setActive(OTHER);
  const state = await f.service.getState();
  assert.equal(state.outputConnection.status, 'connected'); assert.equal(state.outputConnection.selectionMatches, false);
  assert.equal(state.outputConnection.output.deviceId, DEVICE);
  await assert.rejects(() => f.service.play({ paths: [columns[0]] }), error => error.code === 'STILL_OUTPUT_CHANGED');
  assert.equal(f.calls.filter(item => item.method === 'POST').length, 0);
  const result = await f.service.selectOutput(outputId(OTHER));
  assert.equal(result.outputConnection.output.deviceId, OTHER); assert.equal(result.outputConnection.selectionMatches, true);
  assert.equal((await f.service.audioDetails()).selection.deviceId, OTHER);
});

test('observed unplug cancels pending preparation even if reconnect occurs before its old copy completes', async t => {
  const f = await fixture(t); await f.service.initialize();
  const hold = f.hold(item => /items\/copy$/.test(item.route));
  const playing = f.service.play({ paths: [columns[0]] }).catch(error => error);
  await hold.entered; f.setNative(4); await f.service.outputConnection();
  assert.equal((await playing).code, 'STILL_OUTPUT_DISCONNECTED');
  f.setNative(1); await f.service.outputConnection(); hold.release();
  await sleep(15); await f.service.cancelPending();
  assert.equal(f.calls.some(item => /^player\/play/.test(item.route)), false);
});

for (const kind of ['output', 'volume', 'order']) test(`timed-out ${kind} POST retains the shared control fence, orders the newer operation last, and delays disposal`, async t => {
  const f = await fixture(t); await f.service.initialize();
  const predicate = kind === 'output' ? item => item.route === 'outputs/active' : kind === 'volume' ? item => item.route === 'player' && item.body.volume != null : item => item.route === 'player' && item.body.options;
  const hold = f.hold(predicate);
  const invoke = value => kind === 'output' ? f.service.selectOutput(outputId(value ? OTHER : DEVICE)) : kind === 'volume' ? f.service.setVolume(value ? 0.5 : 0.8) : f.service.setOrder(value ? 1 : 0);
  const old = invoke(true).catch(error => error); await hold.entered;
  assert.equal((await old).code, 'STILL_TRANSPORT_UNCERTAIN');
  assert.equal(f.service.transportStatus().pendingControlRequests, 1);
  await assert.rejects(f.service.cancelPending(), {code: 'STILL_TRANSPORT_UNCERTAIN'});
  await assert.rejects(invoke(false), {code: 'STILL_TRANSPORT_UNCERTAIN'});
  assert.equal(f.calls.filter(predicate).length, 1);
  // Diagnostic GETs stay usable while the old POST is held.
  assert.equal((await f.service.getState()).backendReachable, true);
  hold.release(); await sleep(8); const latest = await invoke(false);
  if (kind === 'output') assert.equal(latest.selected.deviceId, DEVICE);
  else if (kind === 'volume') assert.equal(latest.volume, 0.8);
  else assert.equal(latest.playbackOrder.id, 0);
  assert.equal(f.service.transportStatus().pendingControlRequests, 0);
  const secondHold = f.hold(predicate); const last = invoke(true).catch(error => error);
  await secondHold.entered; assert.equal((await last).code, 'STILL_TRANSPORT_UNCERTAIN');
  let disposed = false; const closing = f.service.close().then(() => { disposed = true; });
  await sleep(8); assert.equal(disposed, false);
  secondHold.release(); await closing; assert.equal(disposed, true);
});

test('lost output mutation connection remains uncertain despite live GET and explicit retry', async t => {
  const f = await fixture(t); await f.service.initialize();
  f.setHook(async item => { if (item.route === 'outputs/active') throw new Error('fixture connection lost before response'); });
  await assert.rejects(() => f.service.selectOutput(outputId(OTHER)), /连接中断/);
  await assert.rejects(() => f.service.cancelPending(), error => error.code === 'STILL_TRANSPORT_UNCERTAIN');
  assert.equal(f.service.transportStatus().controlUncertain, true);
  assert.equal((await f.service.getState()).controlUncertain, true);
  assert.equal(f.service.capabilities().playback, false);
  await assert.rejects(() => f.service.retryOutput(), error => error.code === 'STILL_TRANSPORT_UNCERTAIN');
  const before = f.calls.filter(item => item.method === 'POST').length;
  await assert.rejects(() => f.service.selectOutput(outputId(DEVICE)), error => error.code === 'STILL_TRANSPORT_UNCERTAIN');
  await assert.rejects(() => f.service.play({ paths: [columns[0]] }), error => error.code === 'STILL_TRANSPORT_UNCERTAIN');
  assert.equal(f.calls.filter(item => item.method === 'POST').length, before);
});

test('cancel barrier prevents old output preparation and queued serial mutations from dispatching later', async t => {
  const f = await fixture(t); await f.service.initialize();
  const hold = f.hold(item => item.method === 'GET' && item.route === 'outputs');
  const selecting = f.service.selectOutput(outputId(OTHER)).catch(error => error);
  await hold.entered;
  const volume = f.service.setVolume(0.5).catch(error => error);
  await f.service.cancelPending();
  assert.equal(f.calls.some(item => item.method === 'POST'), false);
  hold.release();
  assert.equal((await selecting).code, 'STILL_CANCELLED'); assert.equal((await volume).code, 'STILL_CANCELLED');
  assert.equal(f.calls.some(item => item.method === 'POST'), false);
});

test('a newer play invalidates old output preparation without waiting for its GET or later changing the device', async t => {
  const f = await fixture(t); await f.service.initialize();
  const hold = f.hold(item => item.method === 'GET' && item.route === 'outputs');
  const selecting = f.service.selectOutput(outputId(OTHER)).catch(error => error);
  await hold.entered;
  assert.equal((await f.service.play({ paths: [columns[0]] })).state, 'playing');
  hold.release(); assert.equal((await selecting).code, 'STILL_CANCELLED');
  assert.equal(f.calls.some(item => item.route === 'outputs/active'), false);
  assert.equal(f.active(), DEVICE);
});

test('read-only output inspection does not create a selection cache or change backend audio configuration', async t => {
  const f = await fixture(t, { persistOutputSelection: false });
  await f.service.initialize(); await f.service.audioDetails(); await f.service.close();
  await assert.rejects(() => fs.stat(path.join(f.directory, 'foobar-output-selection.json')), { code: 'ENOENT' });
  assert.equal(f.calls.some(item => item.method === 'POST'), false);
  assert.equal(f.probes.every(item => item === ENDPOINT), true);
});
