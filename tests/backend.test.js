'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const {PassThrough} = require('node:stream');
const { createHash } = require('node:crypto');
const { createBackendManager, endpointForOutput, covered, isVerifiedBackendSession, isVerifiedBackendExit, isVerifiedBackendChildExit, isVerifiedBackendTreeExit } = require('../src/main/backend');
const {writeSyntheticBackendRuntime, syntheticPolicy} = require('./helpers/synthetic-backend-runtime');
const {bindBackendJobProcess} = require('../src/main/backend-job');
const digest = data => createHash('sha256').update(data).digest('hex');
const endpoint = '{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}';

async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'still-backend-test-'));
  await writeSyntheticBackendRuntime(root, config.policy ? {policy: config.policy} : {});
  const backendDir = path.join(root, 'backend'), configPath = path.join(backendDir, 'profile/beefweb/config.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const files = [];
  for (const relativePath of ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll']) {
    const data = Buffer.from(`FAKE TEST BYTES ONLY ${relativePath}`);
    await fs.mkdir(path.dirname(path.join(backendDir, relativePath)), { recursive: true });
    await fs.writeFile(path.join(backendDir, relativePath), data);
    files.push({ relativePath, sha256: digest(data), mutable: false });
  }
  const manifest = { schemaVersion: 1, privateUseOnly: true, backendId: 'fixture-only-backend',
    sourceDir: 'C:\\Unmodified-original', executable: 'foobar2000.exe', configuration: { port: 18880 }, files };
  await fs.writeFile(path.join(backendDir, 'backend-manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(configPath, JSON.stringify({ port: 18880, allowRemote: false, musicDirs: ['C:\\Music'] }));
  const probePath = path.join(root, 'fake-probe.exe'); await fs.writeFile(probePath, 'not an executable');
  const calls = [], spawned = [], executed = [];
  let running = Boolean(config.running), listener = config.listener !== false, playerState = config.playerState || 'stopped';
  let pid = 650, fakeChild = null, inspectHook = null, fetchHook = null, probeResponses = [];
  let wrongProcess = config.wrongProcess || false, queuePresent = config.queuePresent || false, exitHook = null;
  function markExited() { running = false; if (fakeChild && fakeChild.exitCode == null) { fakeChild.exitCode = 0; fakeChild.emit('exit', 0); } }
  const inspectSystem = async args => {
    calls.push({ type: 'inspect', ...args });
    if (inspectHook) await inspectHook(args);
    return { processes: running ? [{ pid, executablePath: wrongProcess ? 'C:\\Original\\foobar2000.exe' : path.join(backendDir, 'foobar2000.exe') }] : [],
      listeners: running && listener ? [{ pid, address: config.remoteListener ? '0.0.0.0' : '127.0.0.1' }] : [],
      pidCheck: args.pid ? { pid: args.pid, present: running, executablePath: running ? (wrongProcess ? 'C:\\Original\\foobar2000.exe' : path.join(backendDir, 'foobar2000.exe')) : null } : null };
  };
  const fetcher = async (url, init) => {
    const route = new URL(url).pathname.replace('/api/', ''); calls.push({ type: 'http', route, method: init.method });
    if (fetchHook) await fetchHook({ route, init });
    const loaded = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const body = route === 'player' ? { player: { info: { name: 'foobar2000', pluginVersion: '0.10' }, playbackState: playerState } }
      : route === 'playqueue' ? { playQueue: queuePresent ? [{ playlistId: 'protected', itemIndex: 0 }] : [] }
      : { roots: loaded.musicDirs.map(directory => ({ path: directory })) };
    return { ok: true, text: async () => JSON.stringify(body) };
  };
  const spawn = (file, args, settings) => {
    spawned.push({ file, args, settings }); running = true; ++pid;
    fakeChild = new EventEmitter(); fakeChild.pid = pid; fakeChild.exitCode = null;
    return fakeChild;
  };
  const execute = async (file, args, settings) => {
    executed.push({ file, args, settings });
    if (args[0] === '/exit') {
      if (exitHook) return exitHook({ markExited, setRunning: value => { running = value; } });
      markExited(); return { stdout: '' };
    }
    const result = probeResponses.shift() || { endpoint, operation: 'Initialize', mode: 'shared', initialized: true, hresult: '0x00000000' };
    if (result.testExitCode) throw Object.assign(new Error('fixture nonzero probe exit'), { code: result.testExitCode, stdout: JSON.stringify(result) });
    return { stdout: JSON.stringify(result) };
  };
  const managerOptions = { backendDir, runtimeRoot: root, probePath, fetch: fetcher, inspectSystem, spawn, execFile: execute,
    platform: 'win32', pollMs: 5, startupTimeoutMs: 100, shutdownTimeoutMs: 100 };
  if (config.launchOwned) managerOptions.launchOwned = input => config.launchOwned(input, {begin: () => {running = true; return ++pid;}, setRunning: value => {running = value;}});
  const manager = createBackendManager(managerOptions);
  t.after(async () => { await manager.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return { root, backendDir, configPath, manager, calls, spawned, executed, manifest,
    markExited, getChild: () => fakeChild,
    setState: value => { playerState = value; }, setWrongProcess: value => { wrongProcess = value; },
    setExitHook: value => { exitHook = value; }, createManager: () => createBackendManager(managerOptions),
    setInspectHook: value => { inspectHook = value; }, setFetchHook: value => { fetchHook = value; },
    setProbe: value => { probeResponses = value; }, readConfig: async () => JSON.parse(await fs.readFile(configPath, 'utf8')) };
}

test('read-only smoke inspects without spawning, writing config, stopping or exiting', async t => {
  const f = await fixture(t), before = await fs.readFile(f.configPath);
  const info = await f.manager.initialize({ start: false });
  assert.equal(info.available, false); assert.equal(info.status, 'offline');
  assert.equal(f.spawned.length, 0); assert.equal(f.executed.length, 0);
  assert.deepEqual(await fs.readFile(f.configPath), before);
});

test('normal initialize coalesces startup and owns only the exact private executable', async t => {
  const f = await fixture(t);
  const first = f.manager.initialize(), second = f.manager.initialize(); assert.equal(first, second);
  const info = await first;
  assert.equal(info.available, true); assert.equal(info.owned, true); assert.equal(info.baseUrl, 'http://127.0.0.1:18880/api/');
  assert.equal(f.spawned.length, 1); assert.deepEqual(f.spawned[0].args, ['/hide']);
  assert.equal(f.spawned[0].settings.env.BEEFWEB_CONFIG_FILE, f.configPath);
  assert.equal(f.spawned[0].settings.windowsHide, true);
  await f.manager.close();
  assert.deepEqual(f.executed.map(item => item.args), [['/exit']]);
  assert.equal(f.executed[0].file, path.join(f.backendDir, 'foobar2000.exe'));
});

test('fixed incomplete spectrum migration marker rejects both manifest inspection and a late launch', async t => {
  const first = await fixture(t), marker = path.join(first.backendDir, '.spectrum-component-install-incomplete.json');
  await fs.writeFile(marker, 'synthetic incomplete marker');
  await assert.rejects(first.manager.initialize(), {code: 'STILL_BACKEND_COMPONENT_INSTALL_INCOMPLETE'});
  assert.equal(first.spawned.length, 0); assert.equal(first.executed.length, 0);
  const late = await fixture(t);
  late.setInspectHook(async () => {await fs.writeFile(path.join(late.backendDir, '.spectrum-component-install-incomplete.json'), 'synthetic late marker');});
  await assert.rejects(late.manager.initialize(), {code: 'STILL_BACKEND_COMPONENT_INSTALL_INCOMPLETE'});
  assert.equal(late.spawned.length, 0); assert.equal(late.executed.length, 0);
});

test('verified existing private instance is reused but never exited by this manager', async t => {
  const f = await fixture(t, { running: true });
  assert.equal((await f.manager.initialize()).available, true);
  assert.equal(f.manager.getInfo().owned, false);
  assert.equal(f.manager.getInfo().pid, 650);
  await f.manager.close(); assert.equal(f.spawned.length, 0); assert.equal(f.executed.length, 0);
});

test('an explicit owned reconnect retains exact old exit evidence and binds a fresh live session', async t => {
  const f = await fixture(t);
  await f.manager.initialize();
  const first = f.manager.getSession();
  const result = await f.manager.initialize({restartOwned: true});
  const second = f.manager.getSession(), evidence = f.manager.getExitEvidence(first);
  assert.equal(result.available, true); assert.notEqual(first, second); assert.notEqual(first.pid, second.pid);
  assert.equal(isVerifiedBackendExit(evidence, first), true);
  assert.equal(isVerifiedBackendExit(evidence, second), false);
  assert.equal(f.manager.getExitEvidence({...first}), null);
  assert.equal(f.spawned.length, 2);
  assert.deepEqual(f.executed.map(call => call.args), [['/exit']]);
});

test('an explicit reconnect of a reused unowned process never exits or adopts it', async t => {
  const f = await fixture(t, {running: true});
  await f.manager.initialize();
  await f.manager.initialize({restartOwned: true});
  assert.equal(f.manager.getSession(), null);
  assert.equal(f.manager.getInfo().owned, false);
  assert.equal(f.executed.length, 0); assert.equal(f.spawned.length, 0);
});

test('an unrelated listener, non-loopback listener or modified executable is rejected before launch', async t => {
  const wrong = await fixture(t, { running: true, wrongProcess: true });
  await assert.rejects(wrong.manager.initialize(), /其他进程占用/); assert.equal(wrong.spawned.length, 0);
  const remote = await fixture(t, { running: true, remoteListener: true });
  await assert.rejects(remote.manager.initialize(), /loopback/); assert.equal(remote.spawned.length, 0);
  const tampered = await fixture(t);
  await fs.writeFile(path.join(tampered.backendDir, 'foobar2000.exe'), 'different bytes');
  await assert.rejects(tampered.manager.initialize(), /校验失败/); assert.equal(tampered.spawned.length, 0);
});

test('a private process without a listener is not duplicated', async t => {
  const f = await fixture(t, { running: true, listener: false });
  await assert.rejects(f.manager.initialize(), /重复实例/); assert.equal(f.spawned.length, 0);
});

test('close during startup cancels before any eventual spawn', async t => {
  const f = await fixture(t);
  const starting = f.manager.initialize().catch(error => error);
  await f.manager.close(); assert.equal((await starting).code, 'STILL_CANCELLED');
  assert.equal(f.spawned.length, 0);
});

test('native import records pending roots without interrupting playback or writing config', async t => {
  const f = await fixture(t, { playerState: 'playing' }); await f.manager.initialize();
  const before = await fs.readFile(f.configPath), callCount = f.calls.length;
  const report = await f.manager.preparePaths({ paths: ['D:\\Chosen\\one.flac'], deferRestart: true });
  assert.equal(report.pending, true); assert.equal(report.restartRequired, true);
  assert.deepEqual(report.pendingRoots, ['D:\\Chosen']);
  assert.equal(f.calls.length, callCount); assert.deepEqual(await fs.readFile(f.configPath), before);
  await assert.rejects(f.manager.ensureStarted({ paths: ['D:\\Chosen\\one.flac'], allowRestart: true }), /先取消旧请求并确认 stop/);
  assert.equal(f.executed.length, 0); assert.deepEqual(await fs.readFile(f.configPath), before);
  f.setState('stopped');
  assert.equal((await f.manager.ensureStarted({ paths: ['D:\\Chosen\\one.flac'], allowRestart: true })).available, true);
  assert.deepEqual((await f.readConfig()).musicDirs, ['C:\\Music', 'D:\\Chosen']);
  assert.equal(f.spawned.length, 2); assert.deepEqual(f.executed.map(item => item.args), [['/exit']]);
});

test('reloading an unowned existing instance fails without changing its profile', async t => {
  const f = await fixture(t, { running: true }); await f.manager.initialize();
  const before = await fs.readFile(f.configPath);
  await assert.rejects(f.manager.ensureStarted({ paths: ['D:\\New\\a.wav'], allowRestart: true }), /本次 STILL 启动/);
  assert.deepEqual(await fs.readFile(f.configPath), before); assert.equal(f.executed.length, 0);
});

test('pending root added while configuration is awaiting write remains pending', async t => {
  const f = await fixture(t);
  await f.manager.preparePaths({ paths: ['D:\\First\\a.wav'] });
  const originalWrite = fs.writeFile;
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  fs.writeFile = async (filename, ...args) => {
    if (String(filename).startsWith(f.configPath) && String(filename).endsWith('.tmp')) { entered(); await held; }
    return originalWrite(filename, ...args);
  };
  try {
    const starting = f.manager.ensureStarted(); await waiting;
    await f.manager.preparePaths({ paths: ['E:\\Second\\b.wav'] }); release(); await starting;
    assert.deepEqual((await f.readConfig()).musicDirs, ['C:\\Music', 'D:\\First']);
    assert.deepEqual(f.manager.getInfo().pendingRoots, ['E:\\Second']);
  } finally { release?.(); fs.writeFile = originalWrite; }
});

test('paths supplied during an existing startup are handled after that startup', async t => {
  const f = await fixture(t);
  let release, entered, first = true;
  const waiting = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  f.setInspectHook(async () => { if (first) { first = false; entered(); await held; } });
  const starting = f.manager.initialize(); await waiting;
  const next = f.manager.ensureStarted({ paths: ['E:\\Later\\b.wav'] });
  release(); await starting; await next;
  assert.deepEqual(f.manager.getInfo().pendingRoots, ['E:\\Later']);
});

test('an aborted restart never writes roots, exits the backend or starts a new process', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const controller = new AbortController();
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  f.setFetchHook(async ({ route }) => { if (route === 'player') { entered(); await held; } });
  const before = await fs.readFile(f.configPath);
  const restarting = f.manager.ensureStarted({ paths: ['D:\\Cancelled\\a.wav'], allowRestart: true, signal: controller.signal }).catch(error => error);
  await waiting; controller.abort(); release();
  assert.equal((await restarting).code, 'STILL_CANCELLED');
  assert.equal(f.spawned.length, 1); assert.equal(f.executed.length, 0);
  assert.deepEqual(await fs.readFile(f.configPath), before);
});

test('endpoint release uses same-device shared Initialize and only succeeds after probe process exit', async t => {
  const f = await fixture(t);
  f.setProbe([{ endpoint, operation: 'Initialize', mode: 'shared', initialized: false, deviceInUse: true, hresult: '0x8889000A' },
    { endpoint, operation: 'Initialize', mode: 'shared', initialized: true, hresult: '0x00000000' }]);
  const proof = await f.manager.waitForOutputRelease({ output: { deviceId: '0DD9B977-765B-4804-BF2D-B28EBF0C510D:016F9F0C-AFE4-4072-9018-CCEBB576B4CB', name: 'DX1 II [exclusive]' } });
  assert.equal(proof.released, true); assert.equal(proof.evidence.processExited, true); assert.equal(proof.evidence.startCalled, false);
  assert.deepEqual(f.executed.map(item => item.args), [[endpoint, 'shared'], [endpoint, 'shared']]);
  assert.equal(f.spawned.length, 0);
});

test('ambiguous or ASIO output does not claim physical release; path coverage respects boundaries', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.waitForOutputRelease({ output: { deviceId: 'unknown', name: 'ASIO : Example' } }), /精确映射/);
  assert.equal(endpointForOutput({ deviceId: 'x:00000000-0000-0000-0000-000000000000' }), null);
  assert.equal(covered('C:\\Music\\a.wav', ['C:\\Music']), true);
  assert.equal(covered('C:\\MusicElsewhere\\a.wav', ['C:\\Music']), false);
  assert.equal(f.executed.length, 0);
});

test('exclusive handoff uses supported 48k/32-bit validation only and strictly checks matching format and release', async t => {
  const f = await fixture(t);
  const ready = { endpoint, operation: 'Initialize', mode: 'exclusive-check', initialized: true, ready: true,
    released: true, hresult: '0x00000000', formatSupported: true, formatSupportHresult: '0x00000000',
    requestedRate: 48000, requestedBits: 32, channels: 2, startCalled: false, actualDacRate: null };
  f.setProbe([{ ...ready, initialized: false, ready: false, hresult: '0x8889000A', testExitCode: 2 }, ready]);
  const result = await f.manager.waitForExclusiveAccess({ endpointId: endpoint });
  assert.equal(result.released, true); assert.equal(result.evidence.probe, 'IAudioClient.Initialize/exclusive');
  assert.deepEqual(result.evidence.validationFormat, { sampleRate: 48000, bits: 32, channels: 2 });
  assert.equal(result.evidence.actualDacRate, null);
  assert.deepEqual(f.executed.map(item => item.args), [[endpoint, 'exclusive-check', '48000', '32'], [endpoint, 'exclusive-check', '48000', '32']]);
  for (const wrong of [{ ...ready, released: false }, { ...ready, ready: false }, { ...ready, formatSupported: false },
    { ...ready, requestedRate: 44100 }, { ...ready, requestedBits: 16 }, { ...ready, requestedBits: 24 }, { ...ready, channels: 1 },
    { ...ready, initialized: false }, { ...ready, formatSupportHresult: '0x88890008' },
    { ...ready, initialized: false, ready: false, formatSupported: false, formatSupportHresult: '0x88890008', hresult: '0x88890008', testExitCode: 2 },
    { ...ready, initialized: false, formatSupported: false, hresult: '0x8889000A', testExitCode: 2 },
    { ...ready, startCalled: true }, { ...ready, testExitCode: 2 }]) {
    const before = f.executed.length;
    f.setProbe([wrong]); await assert.rejects(f.manager.waitForExclusiveAccess({ endpointId: endpoint }), /未确认|未回读/);
    assert.equal(f.executed.length, before + 1, 'invalid/unsupported format never triggers fallback or a second attempt');
  }
  assert.equal(f.spawned.length, 0);
  assert.equal(f.calls.length, 0, 'validation never reads/writes foobar state, volume, DSP or output');
});

test('a directory reload preserves a nonempty backend queue by refusing to restart', async t => {
  const f = await fixture(t, { queuePresent: true }); await f.manager.initialize();
  const before = await fs.readFile(f.configPath);
  await assert.rejects(f.manager.ensureStarted({ paths: ['D:\\New\\a.wav'], allowRestart: true }), /保留现有队列/);
  assert.equal(f.executed.length, 0); assert.equal(f.spawned.length, 1);
  assert.deepEqual(await fs.readFile(f.configPath), before);
});

test('a linked config cannot redirect managed writes into another profile', async t => {
  const f = await fixture(t), external = path.join(f.root, 'original-config.json');
  const bytes = await fs.readFile(f.configPath); await fs.writeFile(external, bytes); await fs.rm(f.configPath);
  try { await fs.symlink(external, f.configPath, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) { t.skip(`File links unavailable: ${error.code}`); return; } throw error; }
  await assert.rejects(f.manager.initialize(), /不能是链接/);
  assert.equal(f.spawned.length, 0); assert.deepEqual(await fs.readFile(external), bytes);
});

test('verified owned exit is session-bound and cannot be forged by copying JSON fields', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const session = f.manager.getSession();
  assert.equal(isVerifiedBackendSession(session, { foobarDir: f.backendDir, baseUrl: f.manager.getInfo().baseUrl }), true);
  const result = await f.manager.close();
  assert.equal(result.exitEvidence.pid, session.pid);
  assert.equal(result.exitEvidence.sessionId, session.sessionId);
  assert.equal(result.exitEvidence.exited, true);
  assert.equal(isVerifiedBackendExit(result.exitEvidence, session), true);
  assert.equal(isVerifiedBackendExit({ ...result.exitEvidence }, session), false);
  assert.equal(isVerifiedBackendExit(result.exitEvidence, { ...session }), false);
});

test('a hung exit CLI does not block proof after the exact owned child actually exits', async t => {
  const f = await fixture(t); await f.manager.initialize();
  f.setExitHook(({ markExited }) => { setTimeout(markExited, 10); return new Promise(() => {}); });
  const result = await f.manager.close();
  assert.equal(result.exitEvidence.verifiedBy, 'owned-child-process-exit');
  assert.equal(result.status, 'closed'); assert.equal(result.owned, false);
  assert.equal(f.executed.length, 1);
});

test('a live owned process times out without evidence and a later user quit can retry', async t => {
  const f = await fixture(t, { playerState: 'playing' }); await f.manager.initialize();
  f.setExitHook(async () => ({ stdout: '' }));
  const session = f.manager.getSession();
  await assert.rejects(f.manager.close(), /未确认退出/);
  assert.equal(f.manager.getInfo().status, 'shutdown-failed');
  assert.equal(f.manager.getInfo().owned, true);
  assert.equal(f.manager.getSession(), session);
  f.setExitHook(null);
  const result = await f.manager.close();
  assert.equal(isVerifiedBackendExit(result.exitEvidence, session), true);
  assert.equal(f.executed.length, 2, 'only the explicit second quit retries a settled /exit');
});

test('neither filtered disappearance nor exact PID absence manufactures a child exit witness', async t => {
  const f = await fixture(t); await f.manager.initialize();
  f.setWrongProcess(true);
  await assert.rejects(f.manager.close(), /无法核验仍存活/);
  assert.equal(f.manager.getInfo().owned, true);
  assert.equal(f.executed.length, 0);
  f.setWrongProcess(false); f.setExitHook(async ({ setRunning }) => { setRunning(false); return { stdout: '' }; });
  const session = f.manager.getSession();
  await assert.rejects(f.manager.close(), /未确认|退出事件/);
  assert.equal(f.manager.getExitEvidence(session), null);
  assert.equal(f.manager.getInfo().owned, true);
  f.markExited();
  const result = await f.manager.close();
  assert.equal(result.exitEvidence.verifiedBy, 'owned-child-process-exit');
  assert.equal(isVerifiedBackendChildExit(result.exitEvidence, session), true);
});

test('an old owned exit proof does not authenticate a newer same-directory session', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const old = await f.manager.close(), next = f.createManager();
  await next.initialize(); const session = next.getSession();
  assert.equal(isVerifiedBackendExit(old.exitEvidence, session), false);
  assert.equal(isVerifiedBackendExit((await next.close()).exitEvidence, session), true);
});

test('root exit alone cannot complete normal shutdown while its owned tree is still live', async t => {
  const f = await fixture(t); await f.manager.initialize(); const session = f.manager.getSession();
  f.getChild().jobTreePending = true;
  await assert.rejects(f.manager.close(), {code: 'STILL_BACKEND_EXIT_UNVERIFIED'});
  const proof = f.manager.getExitEvidence(session);
  assert.equal(isVerifiedBackendChildExit(proof, session), true);
  assert.equal(isVerifiedBackendTreeExit(proof, session), false);
  assert.equal(f.manager.getInfo().owned, true);
  f.getChild().emit('job-tree-empty');
  const result = await f.manager.close();
  assert.equal(isVerifiedBackendTreeExit(result.exitEvidence, session), true);
  assert.equal(f.executed.length, 1, 'waiting for tree completion never dispatches another /exit or kills a job');
});

test('safe owned exit uses only a stable current-manager selection token and consumes it once', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const session = f.manager.getSession();
  const selected = f.manager.getSafeOwnedExitTarget();
  assert.equal(selected.available, true); assert.equal(f.manager.getSafeOwnedExitTarget().selectionToken, selected.selectionToken);
  assert.equal((await f.manager.requestSafeOwnedExit({pid: selected.target.pid, ...selected.target})).code, 'STILL_BACKEND_OWNERSHIP_UNVERIFIED');
  assert.equal((await f.manager.requestSafeOwnedExit({selectionToken: 'forged'})).code, 'STILL_BACKEND_OWNERSHIP_UNVERIFIED');
  const result = await f.manager.requestSafeOwnedExit({selectionToken: selected.selectionToken});
  assert.equal(result.exited, true); assert.equal(isVerifiedBackendTreeExit(result.exitEvidence, session), true);
  assert.equal((await f.manager.requestSafeOwnedExit({selectionToken: selected.selectionToken})).code, 'STILL_BACKEND_OWNERSHIP_UNVERIFIED');
  assert.equal(f.executed.length, 1);
});

test('legacy external/adopted instances and persisted receipt fields never gain safe-exit authority', async t => {
  const f = await fixture(t, {running: true}); await f.manager.initialize();
  assert.equal(f.manager.getSafeOwnedExitTarget().code, 'STILL_BACKEND_OWNERSHIP_UNVERIFIED');
  await fs.writeFile(path.join(f.root, 'owned-receipt.json'), JSON.stringify({owned: true, pid: 650, executable: path.join(f.backendDir, 'foobar2000.exe')}));
  const result = await f.manager.requestSafeOwnedExit({selectionToken: 'persisted-receipt'});
  assert.equal(result.exited, false); assert.equal(result.refused, true); assert.equal(f.spawned.length, 0); assert.equal(f.executed.length, 0);
});

test('runtime assets require their exact pinned schema, paths and bytes before any process or HTTP', async t => {
  for (const mutation of ['hash', 'extra-key', 'path', 'missing']) {
    const f = await fixture(t), registryPath = path.join(f.root, 'src/main/runtime-assets.json');
    const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    if (mutation === 'hash') registry.assets.backendOutputPolicy.sha256 = '0'.repeat(64);
    if (mutation === 'extra-key') registry.assets.backendLauncher.bytes = 123;
    if (mutation === 'path') registry.assets.backendLauncher.relativePath = '../somewhere.exe';
    if (mutation === 'missing') delete registry.assets.backendLauncher;
    await fs.writeFile(registryPath, JSON.stringify(registry));
    await assert.rejects(f.manager.initialize(), {code: 'STILL_BACKEND_RUNTIME_ASSET_UNVERIFIED'});
    assert.equal(f.spawned.length, 0); assert.equal(f.executed.length, 0); assert.equal(f.calls.length, 0);
  }
});

test('policy validation format follows the pinned matching device, with no default format for an unknown endpoint', async t => {
  const policy = syntheticPolicy(); policy.outputs[0].exclusiveValidationFormat = {sampleRate: 44100, bits: 16, channels: 2};
  const f = await fixture(t, {policy});
  f.setProbe([{endpoint, operation: 'Initialize', mode: 'exclusive-check', initialized: true, ready: true, released: true,
    hresult: '0x00000000', formatSupported: true, formatSupportHresult: '0x00000000', requestedRate: 44100, requestedBits: 16, channels: 2, startCalled: false}]);
  const result = await f.manager.waitForExclusiveAccess({endpointId: endpoint});
  assert.deepEqual(result.evidence.validationFormat, {sampleRate: 44100, bits: 16, channels: 2});
  assert.deepEqual(f.executed[0].args, [endpoint, 'exclusive-check', '44100', '16']);
  await assert.rejects(f.manager.waitForExclusiveAccess({endpointId: endpoint.replace('016F9F0C', '116F9F0C')}), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'});
  await assert.rejects(f.manager.waitForExclusiveAccess({endpointId: endpoint, output: {typeId: 'output', deviceId: 'unapproved'}}), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'});
  assert.equal(f.executed.length, 1);
});

test('a linked runtime policy cannot bypass the pinned local asset path', async t => {
  const f = await fixture(t), target = path.join(f.root, 'src/main/backend-output-policy.json'), outside = path.join(f.root, 'copied-policy.json');
  await fs.copyFile(target, outside); await fs.rm(target);
  try {await fs.symlink(outside, target, 'file');}
  catch (error) {if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {t.skip(`File links unavailable: ${error.code}`); return;} throw error;}
  await assert.rejects(f.manager.initialize(), {code: 'STILL_BACKEND_RUNTIME_ASSET_UNVERIFIED'});
  assert.equal(f.spawned.length, 0); assert.equal(f.executed.length, 0); assert.equal(f.calls.length, 0);
});

test('created but never READY startup retains exact ownership, prohibits retry, and requires abnormal startup exit', async t => {
  let launches = 0;
  const f = await fixture(t, {launchOwned(input, state) {
    launches++; const pid = state.begin(), raw = new EventEmitter(); raw.stdin = new PassThrough(); raw.stdout = new PassThrough();
    const nonce = 'd'.repeat(64), child = bindBackendJobProcess(raw, {...input, nonce, parentPid: process.pid});
    setImmediate(() => {
      raw.stdout.write(JSON.stringify({schemaVersion: 1, nonce, sequence: 1, type: 'created', pid, startTime: '133700000000000003',
        executable: input.executable, profilePath: input.profilePath, executableSha256: input.executableSha256, backendId: input.backendId,
        parentPid: process.pid, atomicJobAssignment: true, jobHandleInheritable: false, suspended: true}) + '\n');
      raw.emit('close', 1);
    });
    return child;
  }});
  await assert.rejects(f.manager.initialize(), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN', created: true, abnormalStartupExitRequired: true});
  const info = f.manager.getInfo();
  assert.equal(info.owned, true); assert.equal(info.available, false); assert.equal(info.startupCreated, true); assert.equal(info.abnormalStartupExitRequired, true);
  assert.equal(f.manager.getSession(), null); assert.equal(f.manager.getSafeOwnedExitTarget().code, 'STILL_BACKEND_STARTUP_UNCERTAIN');
  await assert.rejects(f.manager.ensureStarted(), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN'}); assert.equal(launches, 1);
  await assert.rejects(f.manager.close(), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN'});
  assert.equal(f.executed.length, 0); assert.equal(f.spawned.length, 0);
});

test('broker IPC death after admitted READY cannot manufacture exit proof or a normal-close fallback', async t => {
  let raw;
  const f = await fixture(t, {launchOwned(input, state) {
    const pid = state.begin(); raw = new EventEmitter(); raw.stdin = new PassThrough(); raw.stdout = new PassThrough();
    const nonce = 'e'.repeat(64), child = bindBackendJobProcess(raw, {...input, nonce, parentPid: process.pid});
    setImmediate(() => {
      const common = {schemaVersion: 1, nonce, pid, startTime: '133700000000000004'};
      raw.stdout.write(JSON.stringify({...common, sequence: 1, type: 'created', executable: input.executable,
        profilePath: input.profilePath, executableSha256: input.executableSha256, backendId: input.backendId, parentPid: process.pid,
        atomicJobAssignment: true, jobHandleInheritable: false, suspended: true}) + '\n');
      raw.stdout.write(JSON.stringify({...common, sequence: 2, type: 'ready', parentOwnsJob: true, brokerOwnsJob: false, jobHandleInheritable: false}) + '\n');
    });
    return child;
  }});
  await f.manager.initialize(); const session = f.manager.getSession(); assert.ok(session);
  raw.emit('exit', 0); raw.emit('close', 0);
  assert.equal(f.manager.getExitEvidence(session), null); assert.equal(f.manager.getInfo().owned, true);
  assert.equal(f.manager.getInfo().abnormalStartupExitRequired, false);
  await assert.rejects(f.manager.close(), {code: 'STILL_BACKEND_JOB_CHANNEL_LOST'});
  assert.equal(f.executed.length, 0); assert.equal(f.spawned.length, 0);
});

for (const kind of ['http-failure', 'channel-loss']) test(`native READY before ${kind} never grants abnormal-startup Job cleanup authority`, async t => {
  let raw, send, stateRef;
  const f = await fixture(t, {launchOwned(input, state) {
    stateRef = state; const pid = state.begin(); raw = new EventEmitter(); raw.stdin = new PassThrough(); raw.stdout = new PassThrough();
    const nonce = 'f'.repeat(64), common = {schemaVersion: 1, nonce, pid, startTime: '133700000000000005'};
    let sequence = 0;
    send = (type, fields) => raw.stdout.write(JSON.stringify({...common, sequence: ++sequence, type, ...fields}) + '\n');
    const child = bindBackendJobProcess(raw, {...input, nonce, parentPid: process.pid});
    raw.stdin.on('data', data => {if (String(data).startsWith('EXIT ')) setImmediate(() => {
      state.setRunning(false); send('child-exit', {processHandleSignaled: true, exitCode: 0}); send('tree-empty', {activeProcessZero: true, rootHandleSignaled: true});
    });});
    setImmediate(() => {
      send('created', {executable: input.executable, profilePath: input.profilePath, executableSha256: input.executableSha256,
        backendId: input.backendId, parentPid: process.pid, atomicJobAssignment: true, jobHandleInheritable: false, suspended: true});
      send('ready', {parentOwnsJob: true, brokerOwnsJob: false, jobHandleInheritable: false});
    });
    return child;
  }});
  f.setFetchHook(async () => {if (kind === 'channel-loss') raw.emit('close', 1); throw new Error('synthetic HTTP readiness failed');});
  await assert.rejects(f.manager.initialize(), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN', abnormalStartupExitRequired: false});
  assert.equal(f.manager.getInfo().nativeReadySeen, true); assert.equal(f.manager.getInfo().abnormalStartupExitRequired, false);
  assert.equal(f.manager.getSession(), null);
  if (kind === 'http-failure') {
    assert.equal(f.manager.getSafeOwnedExitTarget().available, true);
    const result = await f.manager.close(); assert.equal(result.owned, false); assert.equal(result.exitEvidence, null);
  } else {
    await assert.rejects(f.manager.close(), {code: 'STILL_BACKEND_JOB_CHANNEL_LOST'});
    stateRef.setRunning(false);
  }
  assert.equal(f.executed.length, 0); assert.equal(f.spawned.length, 0);
});
