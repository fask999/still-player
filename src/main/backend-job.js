'use strict';
// The broker is a process observer and launcher. After READY the only Job
// handle is in the actual parent process, never in this broker or its children.
const fs = require('node:fs/promises');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {spawn} = require('node:child_process');
const {createHash, randomBytes} = require('node:crypto');
const {StringDecoder} = require('node:string_decoder');

const LAUNCHER_RELATIVE_PATH = 'native/backend-job/StillBackendLauncher.exe';
const POLICY_RELATIVE_PATH = 'src/main/backend-output-policy.json';
const RUNTIME_ASSETS_RELATIVE_PATH = 'src/main/runtime-assets.json';
const creations = new WeakMap(), processes = new WeakSet(), treeExits = new WeakMap();
const canonical = value => String(value).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const failure = (code, message, extra) => Object.assign(new Error(message), {code, ...extra});
const isOwnedCreationWitness = (proof, child) => Boolean(proof && creations.get(proof) === child);
const isBackendJobProcess = child => Boolean(child && processes.has(child));
const isBackendJobTreeExit = (proof, child) => Boolean(proof && treeExits.get(proof) === child);

function exactKeys(value, names) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)));
}
async function runtimeFile(root, relativePath) {
  if (canonical(await fs.realpath(root)) !== canonical(root) || (await fs.lstat(root)).isSymbolicLink()) throw new Error('Runtime root cannot traverse a link');
  let cursor = root;
  for (const part of relativePath.split('/')) {
    cursor = path.join(cursor, part);
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Runtime asset cannot traverse a link');
  }
  if (canonical(await fs.realpath(cursor)) !== canonical(cursor) || !(await fs.stat(cursor)).isFile()) throw new Error('Runtime asset must be a regular local file');
  return fs.readFile(cursor);
}
async function readBackendRuntimeAssets(runtimeRoot = path.resolve(__dirname, '../..')) {
  const root = path.resolve(runtimeRoot);
  try {
    const registry = JSON.parse((await runtimeFile(root, RUNTIME_ASSETS_RELATIVE_PATH)).toString('utf8'));
    if (!exactKeys(registry, ['schemaVersion', 'assets']) || registry.schemaVersion !== 1 ||
        !exactKeys(registry.assets, ['backendOutputPolicy', 'backendLauncher'])) throw new Error('Invalid runtime registry');
    const values = {};
    for (const [name, relativePath] of [['backendOutputPolicy', POLICY_RELATIVE_PATH], ['backendLauncher', LAUNCHER_RELATIVE_PATH]]) {
      const row = registry.assets[name];
      if (!exactKeys(row, ['relativePath', 'sha256']) || row.relativePath !== relativePath || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Invalid runtime pin');
      const bytes = await runtimeFile(root, relativePath);
      if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new Error('Runtime SHA-256 differs');
      values[name] = {relativePath, sha256: row.sha256, bytes};
    }
    return {root, ...values};
  } catch (cause) {
    throw failure('STILL_BACKEND_RUNTIME_ASSET_UNVERIFIED', '专属运行时文件缺失、路径不安全或 SHA-256 固定值不符；未启动或探测。', {cause});
  }
}

// Kept separate so the protocol can be tested with streams, without launching
// any program, opening a socket, or exporting a way to deserialize a brand.
function bindBackendJobProcess(raw, input) {
  const {nonce, executable, profilePath, executableSha256, backendId, parentPid, onCreated} = input;
  if (!/^[a-f0-9]{64}$/.test(nonce) || !Number.isInteger(parentPid) || parentPid <= 0 ||
      !raw?.stdout?.on || !raw?.stdin?.write) throw new Error('Invalid owned launcher channel');
  const child = new EventEmitter();
  let proof = null, ready = false, exitCode = null, treeProof = null, broken = null, sequence = 0, buffered = '', total = 0;
  const decoder = new StringDecoder('utf8');
  let settleReady, rejectReady;
  const readyPromise = new Promise((resolve, reject) => {settleReady = resolve; rejectReady = reject;});
  // A process can fail before its caller reaches await. Retain the rejection
  // for that caller without producing an unrelated unhandled rejection.
  readyPromise.catch(() => {});
  processes.add(child);
  Object.defineProperties(child, {
    pid: {get: () => proof?.pid}, startTime: {get: () => proof?.startTime},
    creationWitness: {get: () => proof}, exitCode: {get: () => exitCode},
    treeExitEvidence: {get: () => treeProof}, ready: {value: readyPromise},
    controlError: {get: () => broken}, jobManaged: {value: true}
  });
  function fail(error) {
    if (broken) return;
    broken = error;
    if (!ready) {
      error.code = proof ? 'STILL_BACKEND_STARTUP_UNCERTAIN' : error.code;
      error.created = Boolean(proof); error.abnormalStartupExitRequired = Boolean(proof);
      rejectReady(error);
    }
    // Never kill the broker or close a Job in response to protocol failure.
    // IPC loss is not a child-process exit witness.
    child.emit('control-error', error);
  }
  function command(name) {
    if (broken) throw broken;
    raw.stdin.write(`${name} ${nonce}\n`, error => {if (error) fail(failure('STILL_BACKEND_JOB_CHANNEL_LOST', '专属进程观察通道已断开。'));});
  }
  child.requestExit = () => {
    if (!ready || !proof) throw failure('STILL_BACKEND_STARTUP_UNCERTAIN', '失败启动尚未准入；需要应用异常启动退出以清理本次 Job。', {created: Boolean(proof), abnormalStartupExitRequired: Boolean(proof)});
    if (exitCode !== null) return Promise.resolve();
    command('EXIT'); return Promise.resolve();
  };
  function identity(row) {
    return proof && row.pid === proof.pid && row.startTime === proof.startTime;
  }
  function accept(row) {
    if (!row || row.schemaVersion !== 1 || row.nonce !== nonce || row.sequence !== sequence + 1) throw new Error('invalid event envelope');
    sequence = row.sequence;
    if (row.type === 'created') {
      if (proof || ready || !Number.isInteger(row.pid) || row.pid <= 0 || !/^[1-9][0-9]{0,19}$/.test(row.startTime) ||
          canonical(row.executable) !== canonical(executable) || canonical(row.profilePath) !== canonical(profilePath) ||
          row.executableSha256 !== executableSha256 || row.backendId !== backendId || row.parentPid !== parentPid ||
          row.atomicJobAssignment !== true || row.jobHandleInheritable !== false || row.suspended !== true) throw new Error('invalid creation identity');
      proof = Object.freeze({pid: row.pid, startTime: row.startTime, executable, profilePath,
        executableSha256, backendId, parentPid, atomicJobAssignment: true});
      creations.set(proof, child);
      onCreated?.(proof, child);
      child.emit('created', proof);
      // Native code cannot transfer/resume before the parent has registered
      // the exact creation witness, including a startup which never reaches READY.
      command('ACK');
    } else if (row.type === 'ready') {
      if (!identity(row) || ready || exitCode !== null || row.parentOwnsJob !== true || row.brokerOwnsJob !== false ||
          row.jobHandleInheritable !== false) throw new Error('invalid ready state');
      ready = true; child.emit('ready'); settleReady(child);
    } else if (row.type === 'child-exit') {
      if (!ready || !identity(row) || exitCode !== null || row.processHandleSignaled !== true ||
          !Number.isInteger(row.exitCode) || row.exitCode < 0 || row.exitCode > 0xffffffff) throw new Error('invalid exit witness');
      exitCode = row.exitCode;
      child.emit('exit', exitCode, null);
    } else if (row.type === 'tree-empty') {
      if (!ready || !identity(row) || exitCode === null || treeProof || row.activeProcessZero !== true || row.rootHandleSignaled !== true) throw new Error('invalid tree witness');
      treeProof = Object.freeze({pid: proof.pid, startTime: proof.startTime, activeProcessZero: true, rootHandleSignaled: true});
      treeExits.set(treeProof, child); child.emit('job-tree-empty', treeProof);
    } else if (row.type === 'exit-requested') {
      if (!identity(row) || !ready || row.graceful !== true) throw new Error('invalid exit request');
    } else if (row.type === 'failure') {
      if (typeof row.code !== 'string' || !/^STILL_[A-Z0-9_]{1,80}$/.test(row.code)) throw new Error('invalid failure');
      fail(failure(row.code, '专属启动器未能完成当前操作。'));
    } else throw new Error('unknown owned launcher event');
  }
  raw.stdout.on('data', chunk => {
    if (broken) return;
    total += Buffer.byteLength(chunk);
    buffered += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
    if (total > 1024 * 1024 || Buffer.byteLength(buffered) > 65536) {fail(failure('STILL_BACKEND_JOB_PROTOCOL_INVALID', '专属进程观察数据超过上限。')); return;}
    let newline;
    while (!broken && (newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, ''); buffered = buffered.slice(newline + 1);
      try {if (!line || Buffer.byteLength(line) > 16384) throw new Error('invalid line'); accept(JSON.parse(line));}
      catch {fail(failure('STILL_BACKEND_JOB_PROTOCOL_INVALID', '专属进程观察证据无效；未采用 IPC 关闭作为退出证明。'));}
    }
  });
  raw.stdout.on('error', () => fail(failure('STILL_BACKEND_JOB_CHANNEL_LOST', '专属进程观察通道已断开。')));
  raw.stdin.on?.('error', () => fail(failure('STILL_BACKEND_JOB_CHANNEL_LOST', '专属进程控制通道已断开。')));
  raw.on('error', () => fail(failure('STILL_BACKEND_JOB_LAUNCH_FAILED', '无法创建已固定校验的专属启动器。')));
  raw.on('close', () => {
    buffered += decoder.end();
    if (!treeProof || buffered.length) fail(failure('STILL_BACKEND_JOB_CHANNEL_LOST', '专属启动器已结束，但没有完整的 child/tree 退出证明。'));
    if (!ready && !broken) fail(failure('STILL_BACKEND_JOB_LAUNCH_FAILED', '专属启动器在就绪前结束。'));
  });
  return child;
}

async function createBackendJobProcess(input) {
  if (process.platform !== 'win32') throw new Error('Windows Job launcher requires Windows');
  const assets = await readBackendRuntimeAssets();
  const launcherPath = path.join(assets.root, LAUNCHER_RELATIVE_PATH);
  const nonce = randomBytes(32).toString('hex'), parentPid = process.pid;
  const args = ['--parent-pid', String(parentPid), '--nonce', nonce, '--backend-dir', input.backendDir,
    '--exe-sha256', input.executableSha256, '--config-sha256', input.configSha256, '--backend-id', input.backendId,
    ...(input.args?.includes('/stop') ? ['--start-stopped'] : [])];
  const raw = spawn(launcherPath, args, {cwd: input.backendDir, env: input.env, windowsHide: true,
    detached: false, stdio: ['pipe', 'pipe', 'ignore']});
  return bindBackendJobProcess(raw, {...input, nonce, parentPid});
}

module.exports = {LAUNCHER_RELATIVE_PATH, POLICY_RELATIVE_PATH, RUNTIME_ASSETS_RELATIVE_PATH, readBackendRuntimeAssets,
  createBackendJobProcess, bindBackendJobProcess, isOwnedCreationWitness, isBackendJobProcess, isBackendJobTreeExit};
