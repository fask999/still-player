'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBeefwebHttp } = require('./helpers/fake-beefweb-http');
const { writeSyntheticBackendRuntime } = require('./helpers/synthetic-backend-runtime');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createBackendManager } = require('../src/main/backend');
const { createFoobarService } = require('../src/main/foobar');
const { createPlaybackCoordinator } = require('../src/main/playback-coordinator');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const track = { path: 'C:\\Music\\fixture.wav', subsong: 0 };
function gate() { let release; return { promise: new Promise(resolve => { release = resolve; }), release: () => release() }; }
async function within(promise, milliseconds = 500) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('fixture shutdown did not settle within its bound')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'still-verified-shutdown-'));
  const backendDir = path.join(root, 'backend'), lists = [{ id: 'user', title: 'Original', items: [track] }], calls = [];
  const held = gate(), entered = gate();
  let playing = false, running = false, pid = 91234, active = 'user', exitAllowed = true, child;
  const outputs = { active: { typeId: 'output', deviceId: 'fixture' }, types: [{ id: 'output', name: 'Output', devices: [{ id: 'fixture', name: 'Fake fixture output' }] }] };
  const player = () => ({ info: { name: 'foobar2000', pluginVersion: '0.10' }, playbackState: playing ? 'playing' : 'stopped',
    activeItem: { playlistId: active, index: 0, position: 0, duration: 100, columns: [track.path, '0', 'Fixture', '', '', '100'] },
    volume: { type: 'db', value: 0, min: -100, max: 0 } });
  const http = createFakeBeefwebHttp(async ({ route, body, call, send }) => {
    calls.push(call);
    if (route === 'player') return send({ player: player() });
    if (route === 'query') return send({ player: player(), outputs, playQueue: [] });
    if (route === 'browser/roots') return send({ roots: [{ path: 'C:\\Music' }] });
    if (route === 'playlists') return send({ playlists: lists.map(item => ({ id: item.id, title: item.title, itemCount: item.items.length })) });
    if (route === 'playlists/add') { const item = { id: `deck${lists.length}`, title: body.title, items: [] }; lists.push(item); return send({ id: item.id, title: item.title }); }
    let match;
    if ((match = route.match(/^playlists\/([^/]+)\/items\/(\d+):(\d+)$/))) {
      const list = lists.find(item => item.id === match[1]), offset = Number(match[2]);
      return send({ playlistItems: { offset, totalCount: list.items.length,
        items: list.items.slice(offset, offset + Number(match[3])).map(item => ({ columns: [item.path, String(item.subsong), 'Fixture'] })) } });
    }
    if ((match = route.match(/^playlists\/([^/]+)\/([^/]+)\/items\/copy$/))) {
      const from = lists.find(item => item.id === match[1]), to = lists.find(item => item.id === match[2]);
      to.items.push(...body.items.map(index => from.items[index])); return send(null, 204);
    }
    if ((match = route.match(/^player\/play\/([^/]+)\/0$/))) {
      active = match[1]; playing = true; entered.release();
      await held.promise; return send(null, 204);
    }
    if (route === 'player/stop') { playing = false; return send(null, 204); }
    return send({ error: route }, 404);
  });
  const port = Number(new URL(http.baseUrl).port), files = [];
  for (const relativePath of ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll']) {
    const file = path.join(backendDir, relativePath), data = Buffer.from(`FAKE NOT EXECUTABLE ${relativePath}`);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data);
    files.push({ relativePath, mutable: false, sha256: createHash('sha256').update(data).digest('hex') });
  }
  await fs.mkdir(path.join(backendDir, 'profile/beefweb'), { recursive: true });
  await fs.writeFile(path.join(backendDir, 'backend-manifest.json'), JSON.stringify({ schemaVersion: 1, privateUseOnly: true,
    executable: 'foobar2000.exe', backendId: 'owned-shutdown-fixture', files, configuration: { port } }));
  await fs.writeFile(path.join(backendDir, 'profile/beefweb/config.json'), JSON.stringify({ port, allowRemote: false, musicDirs: ['C:\\Music'] }));
  await writeSyntheticBackendRuntime(root);
  const backend = createBackendManager({ backendDir, runtimeRoot: root, fetch: http.fetch, pollMs: 5, shutdownTimeoutMs: 70,
    inspectSystem: async () => ({ processes: running ? [{ pid, executablePath: path.join(backendDir, 'foobar2000.exe') }] : [],
      listeners: running ? [{ pid, address: '127.0.0.1' }] : [], pidCheck: { pid, present: running, executablePath: running ? path.join(backendDir, 'foobar2000.exe') : null } }),
    spawn: () => { running = true; child = new EventEmitter(); child.pid = pid; child.exitCode = null; return child; },
    execFile: async (file, args) => {
      assert.deepEqual(args, ['/exit']);
      if (exitAllowed) { running = false; playing = false; child.exitCode = 0; child.emit('exit', 0); }
      return { stdout: '' };
    }, platform: 'win32' });
  const descriptor = await backend.initialize();
  const service = createFoobarService({ dataDir: path.join(root, 'data'), foobarDir: backendDir,
    baseUrl: descriptor.baseUrl, fetch: http.fetch, pollIntervalMs: 0, timeoutMs: 2000, cleanupDelayMs: 60000 });
  service.bindBackendSession(backend.getSession());
  const coordinator = createPlaybackCoordinator({ engines: { local: service } });
  t.after(async () => {
    exitAllowed = true; held.release();
    const result = await backend.close().catch(() => null);
    if (result?.exitEvidence) service.markBackendExited(result.exitEvidence);
    await coordinator.close(); await service.close();
    await http.drain();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { backend, service, coordinator, calls, entered: entered.promise, releaseHttp: held.release,
    setExitAllowed: value => { exitAllowed = value; }, isPlaying: () => playing };
}

test('held control HTTP drains only after verified owned process exit, without waiting for its response', async t => {
  const f = await fixture(t), pending = f.coordinator.play({ input: { locations: [track] } }).catch(error => error);
  await f.entered; assert.equal(f.isPlaying(), true);
  let drained = false;
  const closingCoordinator = f.coordinator.close().then(() => { drained = true; });
  let bridgeDrained = false;
  const closingBridge = f.service.close().then(() => { bridgeDrained = true; });
  await sleep(20); assert.equal(drained, false);
  assert.equal(bridgeDrained, false);
  const dispatched = f.calls.find(call => /^player\/play\//.test(call.route));
  assert.equal(dispatched.signal.aborted, false, 'ordinary close keeps the physical POST alive');
  assert.ok(f.calls.filter(call => call.method === 'POST').every(call => call.signal === dispatched.signal),
    'every POST uses the same dedicated verified-exit signal');
  const result = await within(f.backend.close());
  assert.equal(result.exitEvidence.exited, true);
  f.service.markBackendExited(result.exitEvidence);
  assert.equal(dispatched.signal.aborted, true, 'only exact branded owned child exit cancels the POST client');
  await within(Promise.all([closingCoordinator, closingBridge, pending]));
  assert.equal(bridgeDrained, true);
  assert.equal(drained, true); assert.equal(f.isPlaying(), false);
  const state = await f.service.getState();
  assert.equal(state.available, false); assert.equal(state.state, 'unavailable'); assert.equal(state.backendExited, true);
  assert.equal(f.calls.filter(item => item.route === 'player/stop').length, 0);
});

test('a backend which remains playing cannot release a held fence or claim a completed shutdown', async t => {
  const f = await fixture(t), pending = f.coordinator.play({ input: { locations: [track] } }).catch(error => error);
  await f.entered; f.setExitAllowed(false);
  let drained = false;
  const closingCoordinator = f.coordinator.close().then(() => { drained = true; });
  await assert.rejects(within(f.backend.close()), /未确认退出/);
  assert.equal(f.isPlaying(), true); assert.equal(drained, false);
  assert.equal((await f.service.getState()).state, 'playing');
  assert.throws(() => f.service.markBackendExited({ exited: true, owned: true, pid: 91234, verified: true }), /未匹配/);
  assert.equal(drained, false);
  f.setExitAllowed(true);
  f.service.markBackendExited((await f.backend.close()).exitEvidence);
  await within(Promise.all([closingCoordinator, f.service.close(), pending]));
});
