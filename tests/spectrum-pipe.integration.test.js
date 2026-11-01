'use strict';
// Explicit opt-in ONLY. With no flag this test skips without starting processes.
// Production bytes are pinned; no foobar2000, Electron, GUI or audio is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { spawn: nativeSpawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { ROOT, sha, assertAcceptedInputs } = require('../native/foobar-spectrum/pipe-fixture/extract');

const ENABLED = process.env.STILL_SPECTRUM_REAL_PIPE_FIXTURE === '1';
const FIXTURE_ROOT = path.join(ROOT, 'native/foobar-spectrum/pipe-fixture');
const FIXTURE_EXE = path.join(FIXTURE_ROOT, 'build/bin/StillSpectrumPipeFixture.exe');
const EVIDENCE = path.join(ROOT, 'review-evidence/spectrum-20261101/real-pipe');
const TRACK = Object.freeze({ id: 'synthetic-pipe-fixture-only', path: 'C:\\__STILL_PIPE_FIXTURE__\\tone.fixture', subsong: 0 });
const CONTEXT = Object.freeze({ source: 'local', state: 'playing', generation: 1, currentTrack: TRACK, currentTrackId: TRACK.id });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function verifyCompiledInputs() {
  const accepted = assertAcceptedInputs();
  const manifest = JSON.parse(syncFs.readFileSync(path.join(FIXTURE_ROOT, 'compiled-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(manifest.fixtureOnly, true); assert.equal(manifest.compiled, true); assert.equal(manifest.executed, false);
  for (const entry of manifest.artifacts) {
    const bytes = syncFs.readFileSync(path.join(ROOT, entry.path));
    assert.equal(bytes.length, entry.bytes, `fixture artifact size changed: ${entry.path}`);
    assert.equal(sha(bytes), entry.sha256, `fixture artifact changed after review: ${entry.path}`);
  }
  assert.ok(manifest.artifacts.some(entry => path.resolve(ROOT, entry.path) === FIXTURE_EXE));
  assert.ok(manifest.artifacts.some(entry => path.resolve(ROOT, entry.path) === __filename));
  return { accepted, fixture: manifest.artifacts.find(entry => path.resolve(ROOT, entry.path) === FIXTURE_EXE) };
}

test('opt-in real Win32 pipe: production encoder → production reader → actual spectrum client', {
  skip: !ENABLED ? 'Requires explicit STILL_SPECTRUM_REAL_PIPE_FIXTURE=1 after plan review' : false,
  timeout: 40000
}, async () => {
  assert.equal(process.platform, 'win32');
  const identities = verifyCompiledInputs(); // fail closed before ANY child creation
  const { createBackendManager, isVerifiedBackendSession } = require('../src/main/backend');
  const { createSpectrumClient, DEFAULT_READER_PATH } = require('../src/main/spectrum-client');
  const report = { schemaVersion: 1, fixtureOnly: true, startedAt: new Date().toISOString(),
    boundary: 'Real OS pipe, original production encoder/pipe-loop fragments, production reader and actual client. Fixed synthetic bands, no audio/host. Backend token branding uses all-injected simulation.',
    identities, phases: [], children: [], failures: [], productionUnchanged: null };
  const owned = [], overallDeadline = Date.now() + 20000;
  let client = null, manager = null, temporaryRoot = null, primaryError = null, helper = null;
  const observe = (phase, details) => report.phases.push({ phase, elapsedMs: Date.now() - Date.parse(report.startedAt), ...details });
  const bounded = (promise, label, ms = 2800) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: deadline ${ms}ms`)), ms); })]).finally(() => clearTimeout(timer));
  };
  async function until(probe, label) {
    const deadline = Math.min(Date.now() + 2800, overallDeadline);
    while (Date.now() < deadline) {
      const result = await probe(); if (result) return result;
      await pause(15);
    }
    throw new Error(`${label}: step/overall deadline`);
  }
  function startOwned(label, executable, args, options, productionClient = false) {
    assert.ok(executable === FIXTURE_EXE || executable === DEFAULT_READER_PATH, 'only exact fixture/production reader may launch');
    assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
    const child = nativeSpawn(executable, args, options);
    assert.ok(Number.isInteger(child.pid) && child.pid > 0, 'spawn must return an exact child PID');
    const details = { label, executable, argv: args, pid: child.pid, startedAt: new Date().toISOString(), productionClient,
      options: { windowsHide: options.windowsHide, shell: options.shell, detached: options.detached || false, stdio: options.stdio },
      stdinEndCalls: 0, killCalls: [], stdoutLines: 0, stderr: '', exit: null, harnessFallback: false };
    report.children.push(details);
    const record = { child, details, lines: [], lineBuffer: '', nativeKill: child.kill.bind(child), closed: false };
    owned.push(record);
    const nativeEnd = child.stdin.end.bind(child.stdin);
    child.stdin.end = function (...values) { ++details.stdinEndCalls; return nativeEnd(...values); };
    child.kill = function (signal) {
      details.killCalls.push({ origin: productionClient ? 'unchanged-production-client-stopChild' : 'explicit-owned-harness-call', signal: signal || 'SIGTERM', at: new Date().toISOString() });
      return record.nativeKill(signal);
    };
    child.stdin.on('error', error => { details.stdinError = error.code || error.message; });
    child.on('error', error => { details.error = error.code || error.message; });
    child.stdout.on('data', chunk => {
      record.lineBuffer += chunk.toString('utf8');
      if (record.lineBuffer.length > 131072) { details.parseFailure = 'stdout-buffer-budget'; record.lineBuffer = ''; return; }
      let newline;
      while ((newline = record.lineBuffer.indexOf('\n')) >= 0) {
        const line = record.lineBuffer.slice(0, newline); record.lineBuffer = record.lineBuffer.slice(newline + 1);
        ++details.stdoutLines;
        try { record.lines.push(JSON.parse(line)); if (record.lines.length > 100) record.lines.shift(); }
        catch { details.parseFailure = 'invalid-owned-stdout-json'; }
      }
    });
    child.stderr?.on('data', chunk => { details.stderr = (details.stderr + chunk.toString('utf8')).slice(-4096); });
    record.exit = new Promise(resolve => child.once('close', (code, signal) => {
      record.closed = true; clearTimeout(record.lifetimeTimer);
      details.exit = { code, signal, at: new Date().toISOString(), lifetimeMs: Date.now() - Date.parse(details.startedAt) };
      resolve(details.exit);
    }));
    record.lifetimeTimer = setTimeout(() => {
      report.failures.push(`${label}: owned child lifetime guard fired`);
      void finishOwned(record, 'lifetime-guard').catch(error => report.failures.push(error.message));
    }, 26000);
    return record;
  }
  async function finishOwned(record, origin) {
    if (record.closed) return record.details.exit;
    if (record.finishing) return record.finishing;
    record.finishing = (async () => {
      if (record.details.executable === FIXTURE_EXE) record.child.stdin.write('quit\n');
      record.child.stdin.end();
      try { return await bounded(record.exit, `${origin}/${record.details.label}/graceful`, 1800); }
      catch {
        record.details.harnessFallback = true;
        report.failures.push(`${origin}/${record.details.label}: harness fallback owned kill required`);
        record.details.killCalls.push({ origin: 'harness-timeout-fallback-FAIL', signal: 'SIGKILL', at: new Date().toISOString() });
        record.nativeKill('SIGKILL');
        return bounded(record.exit, `${origin}/${record.details.label}/forced-exit`, 1000);
      }
    })();
    return record.finishing;
  }
  async function command(server, text, expected) {
    const before = server.lines.length;
    server.child.stdin.write(text + '\n');
    return until(() => server.lines.slice(before).find(line => line.event === expected && line.pid === server.details.pid), `server ${text} ack`);
  }
  function empty(snapshot, reason) {
    assert.equal(snapshot.available, false); assert.deepEqual(snapshot.bands, []);
    assert.equal(snapshot.sampleRate, null); assert.equal(snapshot.analyzedSampleRate, null);
    if (reason) assert.equal(snapshot.reason, reason);
  }
  async function readMatching(predicate, label) {
    return until(async () => { const snapshot = await client.read(CONTEXT); return predicate(snapshot) ? snapshot : null; }, label);
  }
  async function mintSimulatedBrand(pid) {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'still-real-pipe-brand-only-'));
    const files = [];
    for (const relativePath of ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll']) {
      const bytes = Buffer.from(`FIXTURE BYTES ONLY; NEVER EXECUTE: ${relativePath}`), filename = path.join(temporaryRoot, relativePath);
      await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, bytes);
      files.push({ relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), mutable: false });
    }
    const configFile = path.join(temporaryRoot, 'profile/beefweb/config.json');
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, JSON.stringify({ port: 18880, allowRemote: false, musicDirs: ['C:\\__STILL_PIPE_FIXTURE__'] }));
    await fs.writeFile(path.join(temporaryRoot, 'backend-manifest.json'), JSON.stringify({ schemaVersion: 1, privateUseOnly: true,
      backendId: 'real-pipe-fixture-BRANDING-SIMULATION-ONLY', executable: 'foobar2000.exe', configuration: { port: 18880 }, files }));
    let simulatedRunning = false, fakeChild;
    const fakeExecutable = path.join(temporaryRoot, 'foobar2000.exe');
    manager = createBackendManager({ backendDir: temporaryRoot, platform: 'win32', pollMs: 1, startupTimeoutMs: 1000,
      spawn: (file, args) => {
        assert.equal(file, fakeExecutable); simulatedRunning = true; fakeChild = new EventEmitter(); fakeChild.pid = pid; fakeChild.exitCode = null;
        observe('simulated-backend-spawn-NOT-EXECUTED', { executable: file, argv: args, borrowedOwnedFixturePid: pid });
        return fakeChild; // Never delegate the fake executable to nativeSpawn.
      },
      inspectSystem: async args => ({ processes: simulatedRunning ? [{ pid, executablePath: fakeExecutable }] : [],
        listeners: simulatedRunning ? [{ pid, address: '127.0.0.1' }] : [], pidCheck: args.pid ? { pid: args.pid, present: simulatedRunning } : null }),
      fetch: async url => ({ ok: true, text: async () => JSON.stringify(new URL(url).pathname.endsWith('/player')
        ? { player: { info: { name: 'foobar2000', pluginVersion: '0.10' }, playbackState: 'playing' } }
        : { roots: [{ path: 'C:\\__STILL_PIPE_FIXTURE__' }] }) }),
      execFile: async (file, args) => {
        assert.equal(file, fakeExecutable); observe('simulated-backend-exec-NOT-EXECUTED', { executable: file, argv: args });
        simulatedRunning = false; fakeChild.exitCode = 0; fakeChild.emit('exit', 0); return { stdout: '' };
      }
    });
    await bounded(manager.initialize(), 'simulated brand initialization');
    const session = manager.getSession(); assert.equal(isVerifiedBackendSession(session), true); assert.equal(session.pid, pid);
    observe('brand-simulation-only', { brandedByProductionWeakSet: true, genuineBackendValidation: false, actualBackendSpawned: false });
    return session;
  }
  try {
    const serverA = startOwned('server-A', FIXTURE_EXE, ['--self'], { windowsHide: true, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe'], cwd: FIXTURE_ROOT });
    await until(() => serverA.lines.find(line => line.event === 'started' && line.pid === serverA.details.pid && line.targetPid === serverA.details.pid), 'server A owned startup');
    const reader = startOwned('direct-production-reader', DEFAULT_READER_PATH, ['--pid', String(serverA.details.pid), '--interval-ms', '50'],
      { windowsHide: true, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe'], cwd: path.dirname(DEFAULT_READER_PATH) });
    const first = await until(() => reader.lines.find(line => line.kind === 'frame' && line.serverPid === serverA.details.pid && line.frame.status === 'running'), 'direct production reader frame');
    assert.equal(first.frame.backendPid, serverA.details.pid); assert.equal(first.frame.track.path, TRACK.path); assert.equal(first.frame.bands.length, 48);
    observe('direct-real-pipe-running', { serverPid: first.serverPid, sequence: first.frame.sequence, bands: first.frame.bands.length });
    reader.child.stdin.end(); const directExit = await bounded(reader.exit, 'direct reader stdin EOF');
    assert.equal(directExit.code, 0); assert.equal(directExit.signal, null); observe('direct-reader-EOF-exit', directExit);

    const session = await mintSimulatedBrand(serverA.details.pid);
    client = createSpectrumClient({ getBackendSession: () => session, platform: 'win32', spawn: (file, args, options) => {
      assert.equal(helper, null, 'the unchanged playing context should use one actual helper');
      assert.equal(file, DEFAULT_READER_PATH); assert.deepEqual(args, ['--pid', String(serverA.details.pid), '--interval-ms', '50']);
      helper = startOwned('actual-client-production-reader', file, args, options, true); return helper.child;
    } });
    const initial = await readMatching(snapshot => snapshot.available, 'actual client first running');
    assert.equal(initial.bands.length, 48); assert.equal(initial.backendPid, serverA.details.pid); observe('actual-client-running', { sequence: initial.sequence, bands: initial.bands.length });
    await command(serverA, 'pause', 'paused');
    empty(await readMatching(snapshot => !snapshot.available && snapshot.reason === 'paused', 'native paused clears actual client'), 'paused');
    observe('native-paused-empty', { bands: [], sampleRate: null, contextRemainedPlaying: true });
    await command(serverA, 'resume', 'resumed');
    assert.equal((await readMatching(snapshot => snapshot.available, 'resume after native pause')).bands.length, 48); observe('resume-after-pause', { running: true });
    await command(serverA, 'nodata', 'no-data');
    empty(await readMatching(snapshot => !snapshot.available && snapshot.reason === 'no-pcm', 'native no-data clears actual client'), 'no-pcm');
    observe('native-no-data-empty', { bands: [], sampleRate: null });
    await command(serverA, 'resume', 'resumed');
    assert.equal((await readMatching(snapshot => snapshot.available, 'resume after native no-data')).bands.length, 48); observe('resume-after-no-data', { running: true });

    await command(serverA, 'hold', 'held'); assert.equal(serverA.closed, false);
    const serverB = startOwned('server-B-spoof-owned-A-only', FIXTURE_EXE,
      ['--spoof-owned-fixture-pid', String(serverA.details.pid), '--expect-fixture-exe', FIXTURE_EXE],
      { windowsHide: true, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe'], cwd: FIXTURE_ROOT });
    await until(() => serverB.lines.find(line => line.event === 'started' && line.pid === serverB.details.pid && line.targetPid === serverA.details.pid && line.spoof === true), 'same-fixture-image checked B startup');
    assert.notEqual(serverA.details.pid, serverB.details.pid);
    empty(await readMatching(snapshot => !snapshot.available && snapshot.reason === 'server-pid-mismatch', 'real kernel server PID mismatch'), 'server-pid-mismatch');
    observe('kernel-PID-mismatch-rejected', { expectedOwnedPidA: serverA.details.pid, actualOwnedServerPidB: serverB.details.pid,
      forgedFixtureJsonBackendPid: serverA.details.pid, bands: [], ARemainedLive: !serverA.closed });
    await command(serverB, 'quit', 'bye'); const bExit = await bounded(serverB.exit, 'server B normal quit');
    assert.equal(bExit.code, 0); assert.equal(bExit.signal, null);
    await command(serverA, 'resume', 'resumed');
    assert.equal((await readMatching(snapshot => snapshot.available, 'recover correct server A after mismatch')).bands.length, 48);
    observe('correct-kernel-PID-recovered', { running: true });
    await command(serverA, 'quit', 'bye'); const aExit = await bounded(serverA.exit, 'server A normal quit');
    assert.equal(aExit.code, 0); assert.equal(aExit.signal, null); observe('server-A-normal-exit', aExit);
    empty(await readMatching(snapshot => !snapshot.available && snapshot.reason === 'component-not-connected', 'server normal exit clears actual client'), 'component-not-connected');
    observe('server-EOF-clears-client', { bands: [], sampleRate: null });
    client.dispose(); client = null;
    const clientExit = await bounded(helper.exit, 'actual client dispose helper exit');
    observe('production-client-dispose-helper-exit', { ...clientExit, gracefulClaimed: false, productionKillCalls: helper.details.killCalls.length });
  } catch (error) { primaryError = error; report.failures.push(error.stack || error.message); }
  finally {
    client?.dispose();
    for (const record of [...owned].reverse()) {
      try { await finishOwned(record, 'finally-cleanup'); }
      catch (error) { report.failures.push(error.message); }
    }
    if (manager) { try { await bounded(manager.close(), 'simulated manager close'); } catch (error) { report.failures.push(error.message); } }
    if (temporaryRoot) {
      try {
        const resolvedTemp = path.resolve(temporaryRoot);
        assert.equal(path.dirname(resolvedTemp), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolvedTemp).startsWith('still-real-pipe-brand-only-'));
        await fs.rm(resolvedTemp, { recursive: true, force: true });
      } catch (error) { report.failures.push(`temporary fixture cleanup: ${error.message}`); }
    }
    try { assertAcceptedInputs(); report.productionUnchanged = true; } catch (error) { report.productionUnchanged = false; report.failures.push(error.message); }
    for (const record of owned) {
      if (!record.closed) report.failures.push(`ORPHAN: exact owned child ${record.details.label}/${record.details.pid} has no observed close`);
      if (record.details.exit?.lifetimeMs >= 30000) report.failures.push(`child lifetime exceeded: ${record.details.label}`);
      if (record.details.parseFailure) report.failures.push(`${record.details.label}: ${record.details.parseFailure}`);
      if (!record.details.productionClient && record.details.exit && (record.details.exit.code !== 0 || record.details.exit.signal !== null)) report.failures.push(`unexpected owned exit: ${record.details.label}`);
    }
    report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    report.passed = !primaryError && report.failures.length === 0;
    await fs.mkdir(EVIDENCE, { recursive: true }); await fs.writeFile(path.join(EVIDENCE, 'real-pipe-result.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (primaryError) throw primaryError;
  assert.deepEqual(report.failures, []); assert.equal(report.passed, true);
});
