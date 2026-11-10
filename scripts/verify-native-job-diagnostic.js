'use strict';
// Native-only fixture diagnostic. No foobar/Beefweb, audio, UI or installers.
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID, createHash} = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createRequire} = require('node:module');
const common = require('./verify-public-backend');
const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), {code});
const ensure = (value, code) => {if (!value) throw fail(code);};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROOT = path.join(common.POLICY.evidenceRoot, 'native-job-diagnostic');
const COMPILER = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const STUB_SOURCE = 'using System.Threading;\ninternal static class StillNaturalExitFixture {\n  private static int Main(string[] args) { Thread.Sleep(1000); return 0; }\n}\n';
const CONFIG = Buffer.from('{"schemaVersion":1,"purpose":"native-job-natural-exit-fixture"}\n');

function parseArguments(argv) {
  const input = {prepare: false, execute: false, id: null, expected: null}; let plan = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--plan' && !plan) plan = true;
    else if (arg === '--prepare' && !input.prepare) input.prepare = true;
    else if (arg === '--execute' && !input.execute) input.execute = true;
    else if (arg === '--prepared-id' && input.id === null) input.id = argv[++index];
    else if (arg === '--prepared-sha256' && input.expected === null) input.expected = argv[++index];
    else throw fail('VERIFY_DIAGNOSTIC_ARGUMENT');
  }
  ensure(!(input.prepare && input.execute) && !(plan && (input.prepare || input.execute)), 'VERIFY_DIAGNOSTIC_ARGUMENT');
  if (input.execute) ensure(UUID.test(input.id || '') && /^[a-f0-9]{64}$/.test(input.expected || ''), 'VERIFY_PREPARED_PIN_REQUIRED');
  else ensure(input.id === null && input.expected === null, 'VERIFY_DIAGNOSTIC_ARGUMENT');
  return input;
}
function scopePaths(id) {
  ensure(UUID.test(id || ''), 'VERIFY_DIAGNOSTIC_SCOPE');
  const directory = path.join(ROOT, id), backendDir = path.join(directory, 'root');
  ensure(common.inside(ROOT, directory), 'VERIFY_DIAGNOSTIC_SCOPE');
  return {id, directory, backendDir, source: path.join(directory, 'NaturalExit.cs'), executable: path.join(backendDir, 'foobar2000.exe'),
    profilePath: path.join(backendDir, 'profile/beefweb/config.json'), marker: path.join(backendDir, 'portable_mode_enabled'),
    prepared: path.join(directory, 'prepared.json')};
}
function x64(bytes) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') return false;
  const offset = bytes.readUInt32LE(60);
  return offset + 26 <= bytes.length && bytes.readUInt32LE(offset) === 0x00004550 &&
    bytes.readUInt16LE(offset + 4) === 0x8664 && bytes.readUInt16LE(offset + 24) === 0x20b;
}
function validatePrepared(record, id) {
  ensure(record?.schemaVersion === 1 && record.runId === id && UUID.test(record.backendId || '') &&
    record.buildInfoSha256 === common.POLICY.buildSha256 && record.sourceSha256 === sha256(Buffer.from(STUB_SOURCE)) &&
    record.compiler === COMPILER && record.compilerExitCode === 0 && Array.isArray(record.files) && record.files.length === 4,
  'VERIFY_PREPARED_RECORD');
  const names = ['NaturalExit.cs', 'root/foobar2000.exe', 'root/portable_mode_enabled', 'root/profile/beefweb/config.json'];
  const seen = new Set();
  for (const row of record.files) {
    ensure(names.includes(row.relativePath) && !seen.has(row.relativePath) && Number.isSafeInteger(row.bytes) && row.bytes >= 0 &&
      row.bytes < 1024 * 1024 && /^[a-f0-9]{64}$/.test(row.sha256), 'VERIFY_PREPARED_RECORD');
    seen.add(row.relativePath);
  }
  for (const [relativePath, bytes] of [['NaturalExit.cs', Buffer.from(STUB_SOURCE)], ['root/portable_mode_enabled', Buffer.alloc(0)],
    ['root/profile/beefweb/config.json', CONFIG]]) {
    const row = record.files.find(value => value.relativePath === relativePath);
    ensure(row.bytes === bytes.length && row.sha256 === sha256(bytes), 'VERIFY_PREPARED_RECORD');
  }
  return record;
}
async function assertNamespace(scope, prepared) {
  const files = new Set(['NaturalExit.cs', 'root/foobar2000.exe', 'root/portable_mode_enabled', 'root/profile/beefweb/config.json', ...(prepared ? ['prepared.json'] : [])]);
  const directories = new Set(['root', 'root/profile', 'root/profile/beefweb']); let count = 0;
  async function walk(relative = '') {
    const directory = path.join(scope.directory, relative); await common.noLinks(directory);
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      ensure(++count <= 10, 'VERIFY_DIAGNOSTIC_NAMESPACE');
      const child = relative ? relative + '/' + entry.name : entry.name; await common.noLinks(path.join(scope.directory, child));
      if (entry.isDirectory() && directories.has(child)) await walk(child);
      else ensure(entry.isFile() && files.has(child), 'VERIFY_DIAGNOSTIC_NAMESPACE');
    }
  }
  await walk();
}
async function prepare() {
  await common.verifyRuntime();
  await common.noLinks(ROOT); await fs.mkdir(ROOT, {recursive: true}); await common.noLinks(ROOT);
  const scope = scopePaths(randomUUID()); await fs.mkdir(scope.directory); await common.noLinks(scope.directory);
  await fs.mkdir(path.dirname(scope.profilePath), {recursive: true});
  await fs.writeFile(scope.source, STUB_SOURCE, {flag: 'wx'});
  await fs.writeFile(scope.profilePath, CONFIG, {flag: 'wx'}); await fs.writeFile(scope.marker, Buffer.alloc(0), {flag: 'wx'});
  try {
    await execute(COMPILER, ['/nologo', '/target:exe', '/platform:x64', `/out:${scope.executable}`, scope.source],
      {windowsHide: true, shell: false, timeout: 30000, maxBuffer: 65536});
  } catch {throw fail('VERIFY_DIAGNOSTIC_COMPILE_FAILED');}
  const files = [];
  for (const relativePath of ['NaturalExit.cs', 'root/foobar2000.exe', 'root/portable_mode_enabled', 'root/profile/beefweb/config.json']) {
    const filename = path.join(scope.directory, relativePath); await common.noLinks(filename);
    const bytes = await fs.readFile(filename);
    if (relativePath.endsWith('.exe')) ensure(x64(bytes), 'VERIFY_DIAGNOSTIC_X64_REQUIRED');
    files.push({relativePath, bytes: bytes.length, sha256: sha256(bytes)});
  }
  const record = {schemaVersion: 1, runId: scope.id, backendId: randomUUID(), buildInfoSha256: common.POLICY.buildSha256,
    sourceSha256: sha256(Buffer.from(STUB_SOURCE)), compiler: COMPILER, compilerExitCode: 0, files};
  validatePrepared(record, scope.id);
  await assertNamespace(scope, false);
  const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n'); await fs.writeFile(scope.prepared, bytes, {flag: 'wx'});
  return {stage: 'prepared-only-not-executed', runId: scope.id, preparedSha256: sha256(bytes), files};
}
async function deadline(promise, milliseconds, code) {
  let timer;
  try {return await Promise.race([promise, new Promise((_resolve, reject) => {timer = setTimeout(() => reject(fail(code)), milliseconds);})]);}
  finally {clearTimeout(timer);}
}

// Fake API is accepted only by this unit-testable protocol observer. Actual CLI
// constructs the fixed r6 API below and never calls bindBackendJobProcess/DI.
async function runDiagnostic({api, input, emit = () => {}, lifetime = {}, timeoutMs = 10000}) {
  const result = {schemaVersion: 1, stage: 'native-job-natural-exit-diagnostic', ownFixture: true,
    buildInfoSha256: common.POLICY.buildSha256, bindingObjectVerified: false, createdObserved: false, creationWitnessVerified: false,
    nativeReadyObserved: false, transferClaimValidatedAtReady: false, childExitObserved: false, childExitCode: null,
    treeEmptyObserved: false, treeProofVerified: false, observerFailed: false};
  let job, attached = null, firstCode = null, resolveExit, resolveTree, rejectControl;
  const exit = new Promise(resolve => {resolveExit = resolve;}), tree = new Promise(resolve => {resolveTree = resolve;});
  const control = new Promise((_resolve, reject) => {rejectControl = reject;}); control.catch(() => {});
  const observers = [];
  const observerFailure = () => {result.observerFailed = true;};
  const observe = (phase, fields = {}) => {
    try {const pending = emit(phase, fields); if (pending && typeof pending.then === 'function') observers.push(Promise.resolve(pending).catch(observerFailure));}
    catch {observerFailure();}
  };
  const attach = child => {
    if (attached) {ensure(attached === child, 'VERIFY_NATIVE_OBJECT_CHANGED'); return;}
    attached = child;
    child.once('ready', () => {result.nativeReadyObserved = true; result.transferClaimValidatedAtReady = true; observe('native-ready');});
    child.once('exit', code => {result.childExitObserved = true; result.childExitCode = Number.isInteger(code) ? code : null;
      observe('native-child-exit', {exitCode: result.childExitCode}); resolveExit();});
    child.once('job-tree-empty', () => {
      result.treeEmptyObserved = true;
      result.treeProofVerified = api.isTreeExit(child.treeExitEvidence, child) === true;
      if (result.treeProofVerified) lifetime.treeProofVerified = true;
      observe('native-tree-empty', {verified: result.treeProofVerified}); resolveTree();
    });
    child.on('control-error', error => {firstCode ||= common.safeCode(error); observe('native-control-error', {code: firstCode}); rejectControl(fail(firstCode));});
  };
  try {
    ensure(!result.observerFailed, 'VERIFY_OBSERVER_FAILED'); lifetime.nativeAttempted = true;
    job = await api.create({...input, onCreated: (witness, child) => {
      ensure(api.isCreationWitness(witness, child) === true, 'VERIFY_NATIVE_CREATION_WITNESS_REQUIRED');
      attach(child); result.createdObserved = true; result.creationWitnessVerified = true;
      result.pid = witness.pid; observe('native-created', {pid: witness.pid, suspended: true, atomicJobAssignment: true});
    }});
    attach(job); result.bindingObjectVerified = api.isProcess(job) === true;
    ensure(result.bindingObjectVerified, 'VERIFY_NATIVE_OBJECT_BRAND_REQUIRED');
    if (job.controlError) throw job.controlError;
    await deadline(Promise.race([job.ready, control]), timeoutMs, 'VERIFY_NATIVE_READY_TIMEOUT');
    result.nativeReadyObserved = true; result.transferClaimValidatedAtReady = true;
    ensure(result.creationWitnessVerified, 'VERIFY_NATIVE_CREATION_WITNESS_REQUIRED');
    await deadline(Promise.race([Promise.all([exit, tree]), control]), timeoutMs, 'VERIFY_NATIVE_EXIT_TIMEOUT');
    ensure(result.childExitObserved && result.treeProofVerified, 'VERIFY_NATIVE_TREE_PROOF_REQUIRED');
    ensure(result.childExitCode === 0, 'VERIFY_STUB_EXIT_STATUS');
  } catch (error) {firstCode ||= common.safeCode(error); observe('native-failed', {code: firstCode});}
  if (observers.length) {
    try {await deadline(Promise.all(observers), 100, 'VERIFY_OBSERVER_FAILED');} catch {observerFailure();}
  }
  result.status = firstCode || result.observerFailed ? 'failed' : 'passed-native-fixture-only';
  result.code = firstCode || (result.observerFailed ? 'VERIFY_OBSERVER_FAILED' : null);
  result.nativeAttempted = lifetime.nativeAttempted === true;
  result.requiresExecutorRetention = result.nativeAttempted && lifetime.treeProofVerified !== true;
  return result;
}

async function executePrepared(input, output) {
  const runtime = await common.verifyRuntime(), scope = scopePaths(input.id);
  await common.noLinks(scope.directory); const stat = await fs.lstat(scope.prepared);
  ensure(stat.isFile() && stat.size < 16384, 'VERIFY_PREPARED_RECORD');
  const bytes = await common.checkedFile(scope.prepared, {bytes: stat.size, sha256: input.expected}, {read: true});
  const record = validatePrepared(JSON.parse(bytes.toString('utf8')), input.id);
  for (const row of record.files) await common.checkedFile(path.join(scope.directory, row.relativePath), row);
  await assertNamespace(scope, true);
  const executable = await fs.readFile(scope.executable); ensure(x64(executable), 'VERIFY_DIAGNOSTIC_X64_REQUIRED');
  const requireFrozen = createRequire(path.join(runtime.appRoot, 'package.json'));
  const module = requireFrozen('./src/main/backend-job');
  const api = {create: module.createBackendJobProcess, isCreationWitness: module.isOwnedCreationWitness,
    isProcess: module.isBackendJobProcess, isTreeExit: module.isBackendJobTreeExit};
  await fs.writeFile(path.join(scope.directory, 'native-attempt.json'), JSON.stringify({preparedSha256: input.expected}), {flag: 'wx'});
  const log = await fs.open(path.join(scope.directory, 'events.jsonl'), 'wx'); let writes = Promise.resolve();
  const emit = (phase, fields) => {
    const line = JSON.stringify({at: new Date().toISOString(), phase, ...fields}) + '\n'; output.write('stdout', line);
    writes = writes.then(() => log.write(line)); writes.catch(() => {}); return writes;
  };
  const lifetime = {}, handle = setInterval(() => {}, 1000), keepAlive = () => {};
  process.on('SIGINT', keepAlive); process.on('SIGTERM', keepAlive);
  let result;
  try {
    const image = record.files.find(row => row.relativePath === 'root/foobar2000.exe');
    result = await runDiagnostic({api, input: {backendDir: scope.backendDir, executable: scope.executable, profilePath: scope.profilePath,
      executableSha256: image.sha256, configSha256: sha256(CONFIG), backendId: record.backendId, args: ['/hide', '/stop']}, emit, lifetime});
    await output.flush(); if (output.failed()) common.markObserverFailure(result);
    try {await writes;} catch {common.markObserverFailure(result);}
    await log.close(); await common.noLinks(scope.directory);
    await fs.writeFile(path.join(scope.directory, 'result.json'), JSON.stringify({...result, runId: scope.id, simulated: false}, null, 2) + '\n', {flag: 'wx'});
  } finally {
    if (!lifetime.nativeAttempted || lifetime.treeProofVerified === true) {
      clearInterval(handle); process.off('SIGINT', keepAlive); process.off('SIGTERM', keepAlive);
    } else {process.exitCode = 1; output.write('stderr', 'VERIFY_NATIVE_UNKNOWN_LIFETIME_RETAINED\n');}
  }
  if (result.status !== 'passed-native-fixture-only') process.exitCode = 1;
}
async function main(argv, output) {
  const input = parseArguments(argv);
  if (!input.prepare && !input.execute) {
    output.write('stdout', JSON.stringify({mode: 'plan-only', root: ROOT, compiler: COMPILER, stubSource: STUB_SOURCE,
      purpose: 'Only real r6 Native Job protocol with a one-second natural-exit fixture; not foobar/Beefweb or backend readiness.'}, null, 2) + '\n');
  } else {
    ensure(process.platform === 'win32' && process.arch === 'x64', 'VERIFY_WINDOWS_X64_REQUIRED');
    if (input.prepare) output.write('stdout', JSON.stringify(await prepare()) + '\n');
    else await executePrepared(input, output);
  }
  await output.flush(); if (output.failed()) throw fail('VERIFY_OBSERVER_FAILED');
}
module.exports = {STUB_SOURCE, CONFIG, ROOT, COMPILER, parseArguments, scopePaths, x64, validatePrepared, runDiagnostic};
if (require.main === module) {
  const output = common.createOutputGuard(process.stdout, process.stderr, () => {process.exitCode = 1;});
  main(process.argv.slice(2), output).catch(error => {output.write('stderr', common.safeCode(error) + '\n'); process.exitCode = 1;});
}
