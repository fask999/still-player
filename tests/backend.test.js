'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');
const { EventEmitter } = require('node:events');
const {PassThrough} = require('node:stream');
const { createHash } = require('node:crypto');
const { createBackendManager, endpointForOutput, covered, isVerifiedBackendSession, isVerifiedBackendExit, isVerifiedBackendChildExit, isVerifiedBackendTreeExit } = require('../src/main/backend');
const {writeSyntheticBackendRuntime, syntheticPolicy} = require('./helpers/synthetic-backend-runtime');
const {bindBackendJobProcess} = require('../src/main/backend-job');
const {DAC_IDENTITY_PROBE_SHA256} = require('../src/main/dac-identity');
const digest = data => createHash('sha256').update(data).digest('hex');
const endpoint = '{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}';

async function fixture(t, config = {}) {
  const {root, parent: tempParent} = createCanonicalTemp('still-backend-test-');
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
  if (config.publicDac) {
    manifest.provenance = {kind: 'official-installer-local', version: config.publicVersion || '2.26.2', architecture: 'x64',
      installerSha256: 'ffa739f87d9c374cb030426a2ab4bfb37959d0dbb892fdc742654c14d127f795'};
    if (config.mutableDacComponent) files.at(-1).mutable = true;
  }
  await fs.writeFile(path.join(backendDir, 'backend-manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(configPath, JSON.stringify({ port: 18880, allowRemote: false, musicDirs: ['C:\\Music'] }));
  const probePath = path.join(root, 'fake-probe.exe'); await fs.writeFile(probePath, 'not an executable');
  if (config.publicDac) await fs.copyFile(path.join(__dirname, '../scripts/foobar-coreaudio-probe.exe'), probePath);
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
    platform: 'win32', pollMs: 5, startupTimeoutMs: 100, shutdownTimeoutMs: 100,
    ...(config.publicDac ? {requireOwnedSession: true, requirePublicProvenance: true, publicFiles: files, dacProbeSha256: DAC_IDENTITY_PROBE_SHA256} : {}),
    ...config.managerOptions };
  if (config.launchOwned) managerOptions.launchOwned = input => config.launchOwned(input, {begin: () => {running = true; return ++pid;}, setRunning: value => {running = value;}});
  const manager = createBackendManager(managerOptions);
  t.after(async () => { await manager.close().catch(() => {}); assert.equal(path.dirname(root), tempParent); assert.ok(path.basename(root).startsWith('still-backend-test-')); await fs.rm(root, { recursive: true, force: true }); });
  return { root, backendDir, configPath, probePath, manager, calls, spawned, executed, manifest,
    markExited, getChild: () => fakeChild,
    setState: value => { playerState = value; }, setWrongProcess: value => { wrongProcess = value; },
    setExitHook: value => { exitHook = value; }, createManager: overrides => createBackendManager({...managerOptions, ...overrides}),
    setInspectHook: value => { inspectHook = value; }, setFetchHook: value => { fetchHook = value; },
    setProbe: value => { probeResponses = value; }, readConfig: async () => JSON.parse(await fs.readFile(configPath, 'utf8')) };
}

// A stream-only lifetime with the same creation/READY/tree brands as the
// native binder. It never launches a program, opens a socket or uses a device.
function nativeLifetime(input, state) {
  const raw = new EventEmitter(); raw.stdin = new PassThrough(); raw.stdout = new PassThrough();
  const pid = state.begin(), nonce = 'c'.repeat(64), commands = []; let sequence = 0;
  const send = (type, fields = {}) => raw.stdout.write(JSON.stringify({schemaVersion: 1, nonce, sequence: ++sequence,
    type, pid, startTime: '133700000000000009', ...fields}) + '\n');
  const child = bindBackendJobProcess(raw, {...input, nonce, parentPid: process.pid});
  const rootExit = () => {state.setRunning(false); send('child-exit', {processHandleSignaled: true, exitCode: 0});};
  const treeExit = () => send('tree-empty', {activeProcessZero: true, rootHandleSignaled: true});
  const lifetime = {child, raw, commands, rootExit, treeExit, autoExit: false};
  raw.stdin.on('data', bytes => {if (String(bytes).startsWith('EXIT ')) {commands.push('EXIT'); if (lifetime.autoExit) {rootExit(); treeExit();}}});
  setImmediate(() => {
    send('created', {executable: input.executable, profilePath: input.profilePath, executableSha256: input.executableSha256,
      backendId: input.backendId, parentPid: process.pid, atomicJobAssignment: true, jobHandleInheritable: false, suspended: true});
    send('ready', {parentOwnsJob: true, brokerOwnsJob: false, jobHandleInheritable: false});
  });
  return lifetime;
}

const dacOutput = {typeId: 'output', deviceId: syntheticPolicy().outputs[0].deviceId, endpoint};
const dacFormat = {sampleRate: 48000, bits: 24, channels: 2};
const dacScope = (capability, checkCurrent = () => true) => ({...dacOutput, policy: 'user-dac-authorization-v1',
  exclusiveValidationFormat: dacFormat, ownedExitRelease: capability === 'owned-exit-fallback', checkCurrent});
const dacPublicPolicy = {...syntheticPolicy(), outputs: []};

async function dacFixture(t, authorizeDacOutput, config = {}) {
  let lifetime;
  const f = await fixture(t, {publicDac: true, policy: dacPublicPolicy, ...config,
    managerOptions: {quietRestartPolicy: 'stopped-owned-exit', authorizeDacOutput, ...config.managerOptions},
    launchOwned(input, state) {lifetime = nativeLifetime(input, state); lifetime.autoExit = true; return lifetime.child;}});
  return {...f, getLifetime: () => lifetime};
}

test('dynamic DAC exclusive probe is gated by exact current native session, immutable inventory and pinned probe bytes', async t => {
  const observed = [];
  const f = await dacFixture(t, async input => {observed.push(input); return dacScope(input.capability);});
  await f.manager.initialize();
  const session = f.manager.getSession(), version = f.manager.getDacVersionScope(session), context = {};
  assert.deepEqual(version, {backendId: f.manifest.backendId, coreSha256: session.executableSha256,
    componentsSha256: digest(JSON.stringify(f.manifest.files)), probeSha256: DAC_IDENTITY_PROBE_SHA256, providerPolicyVersion: 1});
  assert.equal(Object.isFrozen(version), true); assert.equal(f.manager.getDacVersionScope({...session}), null);
  const input = {session, output: dacOutput, context};
  await assert.rejects(f.manager.waitForExclusiveAccess({...input, session: {...session}}), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'});
  await assert.rejects(f.manager.waitForExclusiveAccess({...input, endpointId: endpoint.replace('016F9F0C', '116F9F0C')}), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'});
  await assert.rejects(f.manager.waitForExclusiveAccess({...input, output: {...dacOutput, typeId: 'asio'}}), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'});
  assert.equal(observed.length, 0); assert.equal(f.executed.length, 0);
  f.setProbe([{endpoint, operation: 'Initialize', mode: 'exclusive-check', startCalled: false, initialized: true, ready: true, released: true,
    formatSupported: true, formatSupportHresult: '0x00000000', hresult: '0x00000000', requestedRate: 48000, requestedBits: 24, channels: 2}]);
  const proof = await f.manager.waitForExclusiveAccess(input);
  assert.deepEqual(proof.evidence.validationFormat, dacFormat); assert.equal(observed[0].context, context);
  assert.deepEqual(f.executed[0].args, [endpoint, 'exclusive-check', '48000', '24']);
  await fs.writeFile(f.probePath, 'changed fixture probe bytes');
  await assert.rejects(f.manager.waitForExclusiveAccess(input), {code: 'STILL_DAC_IDENTITY_UNVERIFIED'});
  assert.equal(f.executed.length, 1);
});

test('dynamic DAC scope changes after async authorization prevent every physical exclusive probe attempt', async t => {
  let checks = 0;
  const f = await dacFixture(t, async input => dacScope(input.capability, () => ++checks === 1));
  await f.manager.initialize();
  await assert.rejects(f.manager.waitForExclusiveAccess({session: f.manager.getSession(), output: dacOutput, context: {}}), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'});
  assert.equal(checks, 2); assert.equal(f.executed.length, 0);
});

test('dynamic owned-exit is exact-context and rechecks revocation in the reserved physical dispatch microtask', async t => {
  let allowed = true, inspected = false, queued = false, useCount = 0;
  const f = await dacFixture(t, async input => {useCount++; return dacScope(input.capability, () => {
    if (inspected && !queued) {queued = true; queueMicrotask(() => {allowed = false;});}
    return allowed;
  });});
  await f.manager.initialize(); const session = f.manager.getSession(), context = {};
  const scope = await f.manager.prepareOwnedOutputScope(session, dacOutput, context);
  await assert.rejects(f.manager.retireForOutputHandoff(session, {outputScope: scope, context: {}}), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'});
  f.setInspectHook(async () => {inspected = true;});
  await assert.rejects(f.manager.retireForOutputHandoff(session, {outputScope: scope, context}), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'});
  assert.equal(queued, true); assert.equal(f.getLifetime().commands.length, 0); assert.equal(f.manager.getVerifiedOwnedTreeExit(session), null);
  assert.deepEqual(f.manager.getOutputRetirementState(session), {exitRequested: false, exitDispatched: false, childExitObserved: false});
  allowed = true; f.setInspectHook(null);
  await assert.rejects(f.manager.retireForOutputHandoff(session, {outputScope: scope, context}), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'});
  const fresh = await f.manager.prepareOwnedOutputScope(session, dacOutput, context);
  const proof = await f.manager.retireForOutputHandoff(session, {outputScope: fresh, context});
  assert.equal(useCount, 2); assert.equal(f.getLifetime().commands.length, 1);
  assert.equal(isVerifiedBackendTreeExit(proof, session), true); assert.equal(f.manager.getDacVersionScope(session), null);
});

test('a mutable public component inventory or unsupported official version cannot admit dynamic DAC authority', async t => {
  let calls = 0; const authorize = async () => {calls++; return dacScope('owned-exit-fallback');};
  const mutable = await dacFixture(t, authorize, {mutableDacComponent: true}); await mutable.manager.initialize();
  assert.equal(mutable.manager.getDacVersionScope(mutable.manager.getSession()), null);
  await assert.rejects(mutable.manager.prepareOwnedOutputScope(mutable.manager.getSession(), dacOutput, {}), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'});
  const unsupported = await dacFixture(t, authorize, {publicVersion: '2.26.3'});
  await assert.rejects(unsupported.manager.initialize(), /官方隔离内核/);
  assert.equal(unsupported.getLifetime(), undefined); assert.equal(unsupported.manager.getDacVersionScope(null), null); assert.equal(calls, 0);
});

test('isolated failed startup cleanup requires a normally closed native-created READY child and its real tree witness', async t => {
  let lifetime, observed = 0;
  const f = await fixture(t, {launchOwned(input, state) {lifetime = nativeLifetime(input, state); return lifetime.child;},
    managerOptions: {onVerifiedOwnedTreeExit() {observed++;}}});
  const target = {foobarDir: f.backendDir};
  f.setFetchHook(async () => {throw new Error('Synthetic HTTP readiness failed');});
  await assert.rejects(f.manager.initialize(), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN'});
  assert.equal(f.manager.getInfo().nativeReadySeen, true); assert.equal(f.manager.getSession(), null);
  assert.equal(f.manager.hasClosedUnverifiedStartupTree(target), false);
  lifetime.rootExit(); lifetime.child.emit('job-tree-empty');
  await assert.rejects(f.manager.close(), {code: 'STILL_BACKEND_EXIT_UNVERIFIED'});
  assert.equal(f.manager.hasClosedUnverifiedStartupTree(target), false);
  lifetime.treeExit();
  assert.equal(f.manager.hasClosedUnverifiedStartupTree(target), false, 'successful close must observe the tree');
  const result = await f.manager.close();
  assert.equal(result.status, 'closed'); assert.equal(result.exitEvidence, null);
  assert.equal(f.manager.hasClosedUnverifiedStartupTree(target), true);
  assert.equal(f.manager.hasClosedUnverifiedStartupTree({foobarDir: f.root}), false);
  assert.equal(f.manager.getVerifiedOwnedTreeExit(null), null); assert.equal(observed, 0);
  lifetime.raw.stdout.write('{}\n');
  assert.equal(f.manager.hasClosedUnverifiedStartupTree(target), false, 'a protocol control error removes cleanup admission');
});

for (const source of ['no-created', 'synthetic-child', 'verified-session']) test(`isolated startup cleanup rejects ${source} even after close resolves`, async t => {
  const launchOwned = source === 'no-created' ? () => {throw new Error('No creation notification');} : source === 'verified-session' ? (input, state) => {
    const lifetime = nativeLifetime(input, state); lifetime.autoExit = true; return lifetime.child;
  } : undefined;
  const f = await fixture(t, {launchOwned});
  if (source === 'synthetic-child') f.setFetchHook(async () => {throw new Error('Synthetic HTTP readiness failed');});
  if (source === 'verified-session') await f.manager.initialize();
  else await assert.rejects(f.manager.initialize());
  assert.equal((await f.manager.close()).status, 'closed');
  assert.equal(f.manager.hasClosedUnverifiedStartupTree({foobarDir: f.backendDir}), false);
});

test('a public backend cannot adopt even a healthy matching unowned port owner or claim readiness', async t => {
  const f = await fixture(t, {running: true});
  const manager = f.createManager({requireOwnedSession: true});
  await assert.rejects(manager.initialize(), /没有接管/);
  assert.equal(manager.getInfo().available, false); assert.equal(manager.getSession(), null);
  assert.equal(f.calls.filter(row => row.type === 'http').length, 0); assert.equal(f.spawned.length, 0);
  await manager.close();
});
test('product startup diagnostics distinguish a descriptor read failure from an invoked launcher without treating missing witness as no process', async t => {
  const f = await fixture(t, {launchOwned() {throw new Error('Descriptor failure must prevent this invocation');}}); const retained = `${f.configPath}.retained`;
  f.setInspectHook(async () => {await fs.rename(f.configPath, retained);});
  await assert.rejects(f.manager.initialize(), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN'});
  const diagnostic = f.manager.getInfo().startupDiagnostic;
  assert.equal(diagnostic.phase, 'build-launch-descriptor'); assert.equal(diagnostic.launchRequested, true);
  assert.equal(diagnostic.launcherInvoked, false); assert.equal(diagnostic.creationObservation, 'unconfirmed');
  assert.equal(diagnostic.causes[1].code, 'ENOENT'); assert.equal(f.spawned.length, 0);
});
test('product startup diagnostics preserve the original cause while exposing only bounded typed path-free fields', async t => {
  const inner = Object.assign(new Error('SECRET_PARENT_PATH'), {code: 'EACCES'});
  const original = Object.assign(new TypeError('SECRET_PROFILE_PATH'), {code: 'EPERM', cause: inner});
  const f = await fixture(t, {launchOwned() {throw original;}});
  await assert.rejects(f.manager.initialize(), error => {assert.equal(error.cause, original); return error.code === 'STILL_BACKEND_STARTUP_UNCERTAIN';});
  const diagnostic = f.manager.getInfo().startupDiagnostic;
  assert.equal(diagnostic.phase, 'invoke-owned-launcher'); assert.equal(diagnostic.launcherInvoked, true);
  assert.equal(diagnostic.bindingReturned, false); assert.equal(diagnostic.creationObservation, 'unconfirmed');
  assert.deepEqual(diagnostic.causes.map(row => [row.name, row.code]), [['Error', 'STILL_BACKEND_STARTUP_UNCERTAIN'], ['TypeError', 'EPERM'], ['Error', 'EACCES']]);
  assert.equal(JSON.stringify(diagnostic).includes('SECRET'), false);
  diagnostic.causes[0].code = 'mutated'; assert.equal(f.manager.getInfo().startupDiagnostic.causes[0].code, 'STILL_BACKEND_STARTUP_UNCERTAIN');
});
test('startup diagnostic getters are not evaluated and cause cycles are bounded', async t => {
  let reads = 0; const original = new Error('synthetic');
  for (const field of ['code', 'name', 'cause', 'nativeFailure']) Object.defineProperty(original, field, {get() {reads++; throw new Error('SECRET_GETTER');}});
  const f = await fixture(t, {launchOwned() {throw original;}});
  await assert.rejects(f.manager.initialize(), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN'});
  assert.equal(reads, 0); assert.equal(JSON.stringify(f.manager.getInfo().startupDiagnostic).includes('SECRET'), false);
  const cycle = new Error('SECRET_CYCLE'); cycle.cause = cycle;
  const other = await fixture(t, {launchOwned() {throw cycle;}});
  await assert.rejects(other.manager.initialize()); assert.equal(other.manager.getInfo().startupDiagnostic.causes.length, 2);
});
for (const created of [false, true]) test(`product getInfo preserves native failure metadata without granting session or exit authority, created=${created}`, async t => {
  const nativeFailure = {schemaVersion: 1, phase: created ? 'child-resume' : 'child-create', checkLine: 220, domain: 'win32', status: 5};
  const f = await fixture(t, {launchOwned(input, state) {
    const raw = new EventEmitter(); raw.stdin = new PassThrough(); raw.stdout = new PassThrough();
    const nonce = 'd'.repeat(64), child = bindBackendJobProcess(raw, {...input, nonce, parentPid: process.pid});
    setImmediate(() => {
      let sequence = 0;
      if (created) raw.stdout.write(JSON.stringify({schemaVersion: 1, nonce, sequence: ++sequence, type: 'created', pid: state.begin(), startTime: '133700000000000007',
        executable: input.executable, profilePath: input.profilePath, executableSha256: input.executableSha256, backendId: input.backendId,
        parentPid: process.pid, atomicJobAssignment: true, jobHandleInheritable: false, suspended: true}) + '\n');
      raw.stdout.write(JSON.stringify({schemaVersion: 1, nonce, sequence: ++sequence, type: 'failure', code: 'STILL_BACKEND_JOB_LAUNCH_FAILED', nativeFailure}) + '\n');
    });
    return child;
  }});
  await assert.rejects(f.manager.initialize(), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN'});
  const info = f.manager.getInfo(), cause = info.startupDiagnostic.causes.find(row => row.nativeFailure);
  assert.deepEqual(cause.nativeFailure, nativeFailure); assert.equal(info.startupCreated, created);
  assert.equal(info.startupDiagnostic.creationObservation, created ? 'accepted' : 'unconfirmed');
  assert.equal(f.manager.getSession(), null); assert.equal(f.manager.getExitEvidence(null), null);
  assert.equal(info.startupDiagnostic.capturedFlags.jobTreeEmptyWitnessVerified, false);
  cause.nativeFailure.status = 999;
  assert.equal(f.manager.getInfo().startupDiagnostic.causes.find(row => row.nativeFailure).nativeFailure.status, 5);
  await assert.rejects(f.manager.ensureStarted(), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN'});
});
test('untrusted native failure metadata never copies secrets or invokes nested getters in product diagnostics', async t => {
  let reads = 0; const nativeFailure = {schemaVersion: 1, phase: 'child-create', checkLine: 220, domain: 'win32'};
  Object.defineProperty(nativeFailure, 'status', {enumerable: true, get() {reads++; throw new Error('SECRET_STATUS');}});
  const f = await fixture(t, {launchOwned() {throw Object.assign(new Error('SECRET_MESSAGE'), {nativeFailure});}});
  await assert.rejects(f.manager.initialize()); assert.equal(reads, 0);
  assert.equal(f.manager.getInfo().startupDiagnostic.causes.every(row => row.nativeFailure === null), true);
  assert.equal(JSON.stringify(f.manager.getInfo().startupDiagnostic).includes('SECRET'), false);
});
test('rejected unbranded onCreated is typed as registration failure and never creates accepted ownership', async t => {
  const f = await fixture(t, {launchOwned(input) {const child = new EventEmitter(); input.onCreated({pid: 12345, startTime: '1'}, child); return child;}});
  await assert.rejects(f.manager.initialize(), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN'});
  const info = f.manager.getInfo(), diagnostic = info.startupDiagnostic;
  assert.equal(diagnostic.phase, 'register-created-witness'); assert.equal(diagnostic.capturedFlags.creationCallbackEntered, true);
  assert.equal(diagnostic.capturedFlags.createdWitnessAccepted, false); assert.equal(diagnostic.creationObservation, 'unconfirmed');
  assert.equal(info.owned, false); assert.equal(f.manager.getSession(), null);
});
for (const relative of ['components/foreign.dll', 'foreign.dll']) test(`public startup rejects unlisted loadable code before process/HTTP access: ${relative}`, async t => {
  const f = await fixture(t);
  const manifest = {...f.manifest, provenance: {kind: 'official-installer-local', version: '2.26.2', architecture: 'x64',
    installerSha256: 'ffa739f87d9c374cb030426a2ab4bfb37959d0dbb892fdc742654c14d127f795'}};
  await fs.writeFile(path.join(f.backendDir, 'backend-manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(f.backendDir, relative), 'SYNTHETIC FOREIGN CODE');
  const manager = f.createManager({requirePublicProvenance: true, publicFiles: manifest.files});
  await assert.rejects(manager.initialize(), /未声明|来源清单之外/);
  assert.equal(f.calls.length, 0); assert.equal(f.spawned.length, 0); await manager.close();
});

test('read-only smoke inspects without spawning, writing config, stopping or exiting', async t => {
  const f = await fixture(t), before = await fs.readFile(f.configPath);
  const info = await f.manager.initialize({ start: false });
  assert.equal(info.available, false); assert.equal(info.status, 'offline');
  assert.equal(f.spawned.length, 0); assert.equal(f.executed.length, 0);
  assert.deepEqual(await fs.readFile(f.configPath), before);
});

test('an unchanged backend-root junction path is rejected before HTTP, inspection or spawn', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'backend-alias');
  await fs.symlink(f.backendDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await fs.realpath(alias), await fs.realpath(f.backendDir));
  const effects = {http: 0, inspect: 0, spawn: 0, exec: 0};
  const manager = createBackendManager({backendDir: alias, runtimeRoot: f.root, platform: 'win32',
    fetch: async () => {effects.http++; throw new Error('Unexpected fixture HTTP');},
    inspectSystem: async () => {effects.inspect++; throw new Error('Unexpected fixture inspection');},
    spawn: () => {effects.spawn++; throw new Error('Unexpected fixture spawn');},
    execFile: async () => {effects.exec++; throw new Error('Unexpected fixture exec');}});
  t.after(() => manager.close().catch(() => {}));
  await assert.rejects(manager.initialize(), error => {
    assert.match(error.message, /专属后端目录不能是链接或 junction/);
    assert.match(error.stack, /at readManifest .*backend\.js:\d+:\d+/);
    return true;
  });
  assert.deepEqual(effects, {http: 0, inspect: 0, spawn: 0, exec: 0});
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

for (const cancellation of ['signal', 'context']) test(`a reserved output retirement remains cancellable before its dispatch microtask: ${cancellation}`, async t => {
  const policy = syntheticPolicy(), controller = new AbortController();
  const f = await fixture(t, {managerOptions: {quietRestartPolicy: 'stopped-owned-exit', ownedExitOutputPolicy: policy.policyId}});
  await f.manager.initialize(); const session = f.manager.getSession();
  const scope = f.manager.verifyOwnedOutputScope(session, policy.outputs[0]);
  let inspected = false, queued = false, valid = true;
  f.setInspectHook(async () => {inspected = true;});
  const result = await f.manager.retireForOutputHandoff(session, {outputScope: scope, signal: controller.signal, check() {
    if (!valid) throw Object.assign(new Error('Synthetic context cancelled'), {code: 'STILL_CANCELLED'});
    if (inspected && !queued) {queued = true; queueMicrotask(() => {if (cancellation === 'signal') controller.abort(); else valid = false;});}
  }}).catch(error => error);
  assert.equal(queued, true); assert.equal(result.code, 'STILL_CANCELLED');
  assert.equal(f.executed.length, 0, 'reserving a Promise must not authorize an obsolete physical /exit');
  assert.equal(f.manager.getExitEvidence(session), null); assert.equal(f.manager.getInfo().owned, true);
  // A fresh explicit retirement can retry after cancellation of the reservation.
  f.setInspectHook(null);
  const evidence = await f.manager.retireForOutputHandoff(session, {outputScope: scope});
  assert.equal(isVerifiedBackendTreeExit(evidence, session), true); assert.equal(f.executed.length, 1);
});

test('native stream retirement checks cancellation before the physical EXIT channel write and permits a fresh retry', async t => {
  const policy = syntheticPolicy(), controller = new AbortController(); let lifetime;
  const f = await fixture(t, {managerOptions: {quietRestartPolicy: 'stopped-owned-exit', ownedExitOutputPolicy: policy.policyId},
    launchOwned(input, state) {lifetime = nativeLifetime(input, state); lifetime.autoExit = true; return lifetime.child;}});
  await f.manager.initialize(); const token = f.manager.getSession(), scope = f.manager.verifyOwnedOutputScope(token, policy.outputs[0]);
  let inspected = false, queued = false;
  f.setInspectHook(async () => {inspected = true;});
  await assert.rejects(f.manager.retireForOutputHandoff(token, {outputScope: scope, signal: controller.signal, check() {
    if (inspected && !queued) {queued = true; queueMicrotask(() => controller.abort());}
  }}), {code: 'STILL_CANCELLED'});
  assert.equal(queued, true); assert.equal(lifetime.commands.length, 0); assert.equal(f.manager.getVerifiedOwnedTreeExit(token), null);
  f.setInspectHook(null);
  const evidence = await f.manager.retireForOutputHandoff(token, {outputScope: scope});
  assert.equal(lifetime.commands.length, 1); assert.equal(f.executed.length, 0);
  assert.equal(f.manager.getVerifiedOwnedTreeExit(token), evidence); assert.equal(isVerifiedBackendTreeExit(evidence, token), true);
});

test('native tree notifications reject unbranded emitter events and require the exact accepted protocol tree witness', async t => {
  let lifetime; const notices = [];
  const f = await fixture(t, {launchOwned(input, state) {lifetime = nativeLifetime(input, state); return lifetime.child;},
    managerOptions: {onVerifiedOwnedTreeExit: (evidence, token) => notices.push({evidence, token})}});
  await f.manager.initialize(); const token = f.manager.getSession();
  lifetime.child.emit('job-tree-empty'); assert.equal(notices.length, 0);
  lifetime.rootExit(); assert.equal(f.manager.getVerifiedOwnedTreeExit(token), null); assert.equal(notices.length, 0);
  lifetime.child.emit('job-tree-empty'); assert.equal(f.manager.getVerifiedOwnedTreeExit(token), null); assert.equal(notices.length, 0);
  lifetime.treeExit(); assert.equal(notices.length, 1);
  assert.equal(notices[0].token, token); assert.equal(f.manager.getVerifiedOwnedTreeExit(token), notices[0].evidence);
  lifetime.child.emit('job-tree-empty'); assert.equal(notices.length, 1);
  assert.equal(isVerifiedBackendTreeExit(notices[0].evidence, token), true); assert.equal(lifetime.commands.length, 0);
});

test('cancellation after the real exit invocation still waits for the original child and complete tree', async t => {
  const policy = syntheticPolicy(), controller = new AbortController(); let entered;
  const dispatched = new Promise(resolve => {entered = resolve;});
  const f = await fixture(t, {managerOptions: {quietRestartPolicy: 'stopped-owned-exit', ownedExitOutputPolicy: policy.policyId, shutdownTimeoutMs: 500}});
  await f.manager.initialize(); const session = f.manager.getSession(), child = f.getChild();
  child.jobTreePending = true;
  const scope = f.manager.verifyOwnedOutputScope(session, policy.outputs[0]);
  f.setExitHook(() => {entered(); return new Promise(() => {});});
  let settled = false;
  const retiring = f.manager.retireForOutputHandoff(session, {outputScope: scope, signal: controller.signal}).catch(error => error).finally(() => {settled = true;});
  await dispatched; controller.abort(); await new Promise(setImmediate);
  assert.equal(settled, false); assert.equal(f.executed.length, 1);
  f.markExited(); await new Promise(setImmediate);
  assert.equal(settled, false); assert.equal(f.manager.getVerifiedOwnedTreeExit(session), null);
  child.emit('job-tree-empty');
  assert.equal((await retiring).code, 'STILL_CANCELLED');
  assert.equal(isVerifiedBackendTreeExit(f.manager.getVerifiedOwnedTreeExit(session), session), true);
  assert.equal(f.executed.length, 1, 'a cancelled caller neither abandons observation nor sends another exit');
});

test('verified tree exit observer and query use exact historical brands, once per session and only after the tree', async t => {
  let f; const notices = [];
  f = await fixture(t, {managerOptions: {onVerifiedOwnedTreeExit(evidence, token) {
    assert.equal(f.manager.getVerifiedOwnedTreeExit(token), evidence); assert.equal(isVerifiedBackendTreeExit(evidence, token), true);
    notices.push({evidence, token}); f.getChild().emit('job-tree-empty');
  }}});
  await f.manager.initialize(); const token = f.manager.getSession(), child = f.getChild();
  assert.equal(f.manager.getVerifiedOwnedTreeExit(token), null);
  child.jobTreePending = true; f.markExited();
  assert.equal(notices.length, 0); assert.equal(f.manager.getVerifiedOwnedTreeExit(token), null);
  child.emit('job-tree-empty'); child.emit('job-tree-empty');
  assert.equal(notices.length, 1); const evidence = notices[0].evidence;
  assert.equal(notices[0].token, token); assert.equal(f.manager.getVerifiedOwnedTreeExit(token), evidence);
  assert.equal(f.manager.getVerifiedOwnedTreeExit({...token}), null); assert.equal(f.manager.getVerifiedOwnedTreeExit(JSON.parse(JSON.stringify(token))), null);
  assert.equal(f.manager.getVerifiedOwnedTreeExit(evidence), null); assert.equal(f.createManager().getVerifiedOwnedTreeExit(token), null);
  await f.manager.initialize(); const next = f.manager.getSession();
  assert.notEqual(next, token); assert.equal(f.manager.getVerifiedOwnedTreeExit(next), null);
  assert.equal(f.manager.getVerifiedOwnedTreeExit(token), evidence, 'old proof remains available without authenticating the new session');
  f.markExited(); assert.equal(notices.length, 2); assert.equal(notices[1].token, next);
});

for (const fault of ['throw', 'reject']) test(`tree observers isolate ${fault} and subscriptions remain read-only and removable`, async t => {
  const notices = [], bad = () => {if (fault === 'throw') throw new Error('Synthetic observer throw'); return Promise.reject(new Error('Synthetic observer reject'));};
  const f = await fixture(t, {managerOptions: {onVerifiedOwnedTreeExit: bad}});
  const unsubscribe = f.manager.subscribeVerifiedOwnedTreeExit(bad);
  const removed = f.manager.subscribeVerifiedOwnedTreeExit(() => {assert.fail('unsubscribed observer must not run');}); removed(); removed();
  const good = f.manager.subscribeVerifiedOwnedTreeExit((evidence, token) => notices.push({evidence, token}));
  assert.throws(() => f.manager.subscribeVerifiedOwnedTreeExit({}), TypeError);
  await f.manager.initialize(); const token = f.manager.getSession();
  assert.equal(notices.length, 0); f.markExited(); await new Promise(setImmediate);
  assert.equal(notices.length, 1); assert.equal(notices[0].token, token);
  const evidence = f.manager.getVerifiedOwnedTreeExit(token);
  assert.equal(notices[0].evidence, evidence); assert.equal(isVerifiedBackendTreeExit(evidence, token), true);
  assert.equal((await f.manager.close()).exitEvidence, evidence);
  unsubscribe(); good(); assert.equal(notices.length, 1);
  let replay = false; const late = f.manager.subscribeVerifiedOwnedTreeExit(() => {replay = true;});
  assert.equal(replay, false); late();
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
