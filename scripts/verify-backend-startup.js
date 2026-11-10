'use strict';
// Scoped, non-UI source startup diagnostic. No main()/Electron, output change,
// playback, installer, native-media, power or keyboard operation is performed.
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const baseline = require('./verify-public-backend');
const ROOT = path.resolve(__dirname, '..');
const EVIDENCE = path.join(baseline.POLICY.evidenceRoot, 'startup-source');
const PINS = Object.freeze({
  'src/main/backend.js': '4f8ba817837dc05cccea5bc7459464a7f99b241d14d34df179bbd485dd879314',
  'src/main/backend-job.js': 'a3b40546a850e057201f2ed4942664e7e79ed299edf4ddc041ddcf22c1034a98',
  'native/backend-job/StillBackendLauncher.exe': '8267a6511f4b3bedecc90c56a9046304db1ccb52b7a2f10c6965add9a550a824',
  'manifests/public-backend.json': 'c5992d5d503bee92b6a2d6d7303070bb7a98bcf2d1bb3f4833ddaca5e483619a'
});
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = code => Object.assign(new Error(code), {code});
const assert = (value, code) => {if (!value) throw failure(code);};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function frozenSources() {
  for (const [relative, expected] of Object.entries(PINS)) {
    const filename = path.join(ROOT, relative); await baseline.noLinks(filename);
    assert(hash(await fs.readFile(filename)) === expected, 'VERIFY_SOURCE_DIAGNOSTIC_DRIFT');
  }
}
async function run() {
  assert(process.platform === 'win32' && process.arch === 'x64', 'VERIFY_WINDOWS_X64_REQUIRED');
  await frozenSources();
  const runtime = await baseline.verifyRuntime();
  const wave = await baseline.checkedFile(baseline.POLICY.wavePath,
    {bytes: baseline.POLICY.waveBytes, sha256: baseline.POLICY.waveSha256}, {read: true});
  baseline.verifyWave(wave);
  await baseline.noLinks(EVIDENCE); await fs.mkdir(EVIDENCE, {recursive: true}); await baseline.noLinks(EVIDENCE);
  const runId = randomUUID(), directory = path.join(EVIDENCE, runId);
  assert(baseline.inside(EVIDENCE, directory), 'VERIFY_SCOPE_ESCAPE');
  await fs.mkdir(directory); await baseline.noLinks(directory);
  const dataDir = path.join(directory, 'data'), mediaDir = path.join(dataDir, 'qa-media');
  await fs.mkdir(dataDir); await fs.mkdir(mediaDir);
  await fs.writeFile(path.join(mediaDir, 'silence.wav'), wave, {flag: 'wx'});
  const resources = path.join(directory, 'resources'); await fs.mkdir(resources);
  const previousManifest = JSON.parse(await fs.readFile(path.join(runtime.appRoot, 'manifests/public-backend.json'), 'utf8'));
  const resourceRows = [{relativePath: previousManifest.installer.relativePath, ...previousManifest.installer},
    ...previousManifest.extractor.files, ...previousManifest.components.map(row => ({relativePath: row.sourcePath, bytes: row.bytes, sha256: row.sha256}))];
  assert(resourceRows.length === 18, 'VERIFY_RESOURCE_COUNT');
  for (const row of resourceRows) {
    const relative = baseline.relativeFile(row.relativePath);
    const bytes = await baseline.checkedFile(path.join(runtime.appRoot, relative), row, {read: true});
    const target = path.join(resources, relative); assert(baseline.inside(resources, target), 'VERIFY_SCOPE_ESCAPE');
    await fs.mkdir(path.dirname(target), {recursive: true}); await baseline.noLinks(path.dirname(target));
    await fs.writeFile(target, bytes, {flag: 'wx'});
  }
  await fs.mkdir(path.join(resources, 'manifests'));
  const manifestBytes = await fs.readFile(path.join(ROOT, 'manifests/public-backend.json'));
  assert(hash(manifestBytes) === PINS['manifests/public-backend.json'], 'VERIFY_SOURCE_DIAGNOSTIC_DRIFT');
  await fs.writeFile(path.join(resources, 'manifests/public-backend.json'), manifestBytes, {flag: 'wx'});
  const log = await fs.open(path.join(directory, 'events.jsonl'), 'wx');
  let logFailure = false, writes = Promise.resolve();
  const sinkError = () => {logFailure = true;};
  process.stdout.on('error', sinkError); process.stderr.on('error', sinkError);
  function emit(phase, values = {}) {
    const line = JSON.stringify({at: new Date().toISOString(), phase, ...values}) + '\n';
    try {process.stdout.write(line, error => {if (error) sinkError();});} catch {sinkError();}
    writes = writes.then(() => log.write(line)); writes.catch(sinkError);
  }
  const result = {schemaVersion: 1, purpose: 'source-startup-diagnostic-not-release-acceptance', runId,
    sourcePins: PINS, coreResourcesR6BuildSha256: baseline.POLICY.buildSha256,
    originalResourceRoot: runtime.appRoot, resourceRoot: resources, sourceBackendRoot: ROOT, freshOwnedData: true,
    playCommands: 0, volumeWrites: 0, outputSelectionWrites: 0, uiOperations: 0,
    ready: false, verifiedTreeExit: false};
  let bootstrap, backend, session, attempted = false, retain = false;
  const keepAlive = setInterval(() => {}, 1000);
  const controller = new AbortController();
  const cancel = () => {result.cancelRequested = true; controller.abort(); bootstrap?.cancel();};
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const {createBackendBootstrap} = require('../src/main/backend-bootstrap');
    // Only the original 18 source/tool/component resources are copied. The new
    // recipient manifest includes the complete original SxS runtime assembly.
    const current = require('../src/main/backend');
    let observedBootstrapState;
    bootstrap = createBackendBootstrap({appRoot: resources, dataDir,
      backendDir: path.join(dataDir, 'backend/foobar2000'), onUpdate: value => {
        if (value.state !== observedBootstrapState) {
          observedBootstrapState = value.state;
          emit('bootstrap', {state: value.state});
        }
      }});
    await bootstrap.initialize(); await bootstrap.begin(); await bootstrap.complete({musicDirs: [mediaDir]});
    assert(bootstrap.getStatus().prepared === true, 'VERIFY_CORE_NOT_PREPARED');
    result.coreFilesPrepared = JSON.parse(manifestBytes).coreFiles.length;
    assert(result.coreFilesPrepared === 111, 'VERIFY_CORE_RUNTIME_CLOSURE');
    assert(!controller.signal.aborted, 'VERIFY_CANCELLED');
    await frozenSources();
    backend = current.createBackendManager({dataDir, backendDir: path.join(dataDir, 'backend/foobar2000'),
      requireOwnedSession: true, requirePublicProvenance: true, startStopped: true,
      publicFiles: bootstrap.getExpectedFiles()});
    globalThis.stillStartupDiagnosticOwner = {backend, bootstrap, directory};
    attempted = true; result.executorPid = process.pid;
    await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify({executorPid: process.pid, runId, status: 'starting'}) + '\n', {flag: 'wx'});
    const info = await backend.initialize({start: true, signal: controller.signal}); session = backend.getSession();
    result.startupDiagnostic = info.startupDiagnostic || null;
    assert(info.available === true && info.owned === true && info.nativeReadySeen === true &&
      current.isVerifiedBackendSession(session, {foobarDir: path.join(dataDir, 'backend/foobar2000'), baseUrl: info.baseUrl}), 'VERIFY_REAL_OWNED_SESSION_REQUIRED');
    result.ready = true; result.pid = info.pid; emit('backend-ready', {pid: info.pid});
    for (let index = 0; index < 2; index++) {
      const response = await fetch(new URL('player', info.baseUrl), {redirect: 'error', signal: AbortSignal.timeout(5000)});
      assert(response.ok, 'VERIFY_PLAYER_READ_FAILED');
      const text = await response.text(); assert(text.length < 65536, 'VERIFY_PLAYER_READ_LIMIT');
      const player = JSON.parse(text).player;
      assert(player?.info?.name === 'foobar2000' && /^0\.10(?:\D|$)/.test(player.info.pluginVersion || '') && player.playbackState === 'stopped', 'VERIFY_INITIAL_STOPPED_REQUIRED');
      result.stoppedReadbacks = index + 1; await delay(100);
    }
    bootstrap.markReady(session, info);
    result.bootstrapReady = bootstrap.getStatus().ready === true;
    assert(result.bootstrapReady, 'VERIFY_BOOTSTRAP_READY_REQUIRED');
    result.status = 'ready-stopped-diagnostic';
  } catch (error) {
    result.status = 'failed'; result.code = baseline.safeCode(error);
    try {result.startupDiagnostic = backend?.getInfo().startupDiagnostic || null;} catch {result.infoUnavailable = true;}
    emit('startup-failed', {code: result.code, startupDiagnostic: result.startupDiagnostic});
  } finally {
    if (backend) {
      try {
        const closed = await backend.close();
        const current = require('../src/main/backend');
        result.verifiedTreeExit = Boolean(session && current.isVerifiedBackendTreeExit(closed.exitEvidence, session));
        result.controllerClosed = closed.status === 'closed';
        emit('backend-close', {verifiedTreeExit: result.verifiedTreeExit, controllerClosed: result.controllerClosed});
      } catch (error) {result.closeCode = baseline.safeCode(error); emit('backend-close-failed', {code: result.closeCode});}
    }
    try {await bootstrap?.close();} catch {result.bootstrapCloseFailed = true;}
    retain = attempted && !result.verifiedTreeExit;
    result.requiresExecutorRetention = retain; result.logFailure = logFailure;
    await frozenSources().catch(() => {result.sourceChangedDuringRun = true; result.status = 'failed';});
    emit('diagnostic-finished', {runId, status: result.status, requiresExecutorRetention: retain});
    try {await writes; await log.close(); await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});}
    catch {result.logFailure = true;}
    if (!retain) {clearInterval(keepAlive); delete globalThis.stillStartupDiagnosticOwner; process.off('SIGINT', cancel); process.off('SIGTERM', cancel);}
  }
  if (result.status === 'failed' || !result.verifiedTreeExit || result.logFailure) process.exitCode = 1;
  return result;
}
async function main(args) {
  if (args.length === 0 || args.length === 1 && args[0] === '--plan') {
    process.stdout.write(JSON.stringify({mode: 'plan-only', sourcePins: PINS,
      effects: 'Fresh ignored profile; verified R6 resources; current diagnostic backend/Job; no main/Electron/UI/device selection/playback.'}) + '\n'); return;
  }
  assert(args.length === 1 && args[0] === '--execute', 'VERIFY_INVALID_ARGUMENT');
  await run();
}
module.exports = {PINS, main};
if (require.main === module) main(process.argv.slice(2)).catch(error => {process.stderr.write(baseline.safeCode(error) + '\n'); process.exitCode = 1;});
