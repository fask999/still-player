'use strict';
// Lifecycle of the explicitly assembled private portable backend, never the
// user's original installation. Merely importing this module has no effects.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {parseOutputReleaseEvidence} = require('./output-release-evidence');
const {assertPublicBackendCode} = require('./public-installation');
const {stockDacOutput, verifyDacProbe, dataFields, DAC_IDENTITY_PROBE_SHA256} = require('./dac-identity');
const {PROVIDER_POLICY_VERSION} = require('./dac-authorization');
const {isExplicitAppleHandoffContext} = require('./playback-coordinator');
const {createBackendJobProcess, readBackendRuntimeAssets, isOwnedCreationWitness,
  isBackendJobProcess, isBackendJobTreeExit, parseNativeFailureDiagnostic} = require('./backend-job');
const executeFile = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = value => String(value).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const errorMessage = error => error instanceof Error ? error.message : String(error);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const abortError = () => Object.assign(new Error('后端操作已取消。'), { code: 'STILL_CANCELLED' });
const startupErrorNames = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AbortError', 'TimeoutError', 'SystemError']);
const startupErrorCodes = new Set(['STILL_BACKEND_STARTUP_UNCERTAIN', 'STILL_BACKEND_JOB_LAUNCH_FAILED',
  'STILL_BACKEND_JOB_CHANNEL_LOST', 'STILL_BACKEND_JOB_PROTOCOL_INVALID', 'STILL_BACKEND_RUNTIME_ASSET_UNVERIFIED',
  'STILL_BACKEND_OUTPUT_POLICY_UNVERIFIED', 'STILL_BACKEND_COMPONENT_INSTALL_INCOMPLETE', 'STILL_BACKEND_EXIT_UNVERIFIED',
  'STILL_CANCELLED', 'ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'EIO', 'EPIPE', 'ETIMEDOUT', 'ABORT_ERR',
  'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE']);
const ownData = (value, key) => {
  try {return value && (typeof value === 'object' || typeof value === 'function') ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;}
  catch {return undefined;}
};
function startupCauseChain(error) {
  const rows = [], seen = new Set(); let value = error;
  while (value && typeof value === 'object' && !seen.has(value) && rows.length < 5) {
    seen.add(value);
    let name = ownData(value, 'name'), prototype;
    try {prototype = Object.getPrototypeOf(value);} catch {prototype = null;}
    if (!startupErrorNames.has(name)) name = ownData(prototype, 'name');
    const code = ownData(value, 'code'), created = ownData(value, 'created'), abnormal = ownData(value, 'abnormalStartupExitRequired');
    let nativeFailure = null;
    const diagnostic = ownData(value, 'nativeFailure');
    if (diagnostic !== undefined) {try {nativeFailure = parseNativeFailureDiagnostic(diagnostic);} catch { /* Untrusted error metadata is never copied. */ }}
    rows.push({name: startupErrorNames.has(name) ? name : 'Error', code: startupErrorCodes.has(code) ? code : null,
      numericCode: Number.isInteger(code) && code >= -0x80000000 && code <= 0xffffffff ? code : null,
      createdClaim: typeof created === 'boolean' ? created : null,
      abnormalStartupExitRequiredClaim: typeof abnormal === 'boolean' ? abnormal : null, nativeFailure});
    value = ownData(value, 'cause');
  }
  return rows;
}
const verifiedSessions = new WeakSet(), verifiedExits = new WeakSet();
const verifiedChildExits = new WeakSet();
const verifiedTreeExits = new WeakSet();
const verifiedOutputScopes = new WeakMap();
const endpointPattern = /^\{0\.0\.0\.00000000\}\.\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/i;
const exactKeys = (value, names) => Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)));
function parseBackendOutputPolicy(value) {
  if (!exactKeys(value, ['schemaVersion', 'policyId', 'outputs']) || value.schemaVersion !== 1 ||
      typeof value.policyId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(value.policyId) ||
      !Array.isArray(value.outputs) || value.outputs.length > 32) throw new Error('Invalid backend output policy');
  const tuples = new Set();
  for (const row of value.outputs) {
    const format = row?.exclusiveValidationFormat;
    if (!exactKeys(row, ['typeId', 'deviceId', 'endpoint', 'exclusiveValidationFormat', 'ownedExitRelease']) ||
        typeof row.typeId !== 'string' || !row.typeId || row.typeId.length > 200 || typeof row.deviceId !== 'string' || row.deviceId.length > 500 ||
        !endpointPattern.test(row.endpoint) || endpointForOutput(row)?.toLowerCase() !== row.endpoint.toLowerCase() ||
        /asio|dsd|sacd|external|外部/i.test(`${row.typeId} ${row.deviceId}`) || typeof row.ownedExitRelease !== 'boolean' ||
        !exactKeys(format, ['sampleRate', 'bits', 'channels']) || !Number.isInteger(format.sampleRate) || format.sampleRate < 8000 || format.sampleRate > 384000 ||
        ![16, 24, 32].includes(format.bits) || format.channels !== 2) throw new Error('Invalid backend output tuple or validation format');
    const key = `${row.typeId}\0${row.deviceId.toLowerCase()}`;
    if (tuples.has(key)) throw new Error('Duplicate backend output tuple'); tuples.add(key);
  }
  return Object.freeze({...value, outputs: Object.freeze(value.outputs.map(row => Object.freeze({...row,
    exclusiveValidationFormat: Object.freeze({...row.exclusiveValidationFormat})})))});
}
function isVerifiedBackendSession(session, expected = {}) {
  return Boolean(session && verifiedSessions.has(session) &&
    (!expected.foobarDir || canonical(session.foobarDir) === canonical(expected.foobarDir)) &&
    (!expected.baseUrl || session.baseUrl === expected.baseUrl));
}
function isVerifiedBackendExit(evidence, session, expected = {}) {
  return Boolean(evidence && verifiedExits.has(evidence) && isVerifiedBackendSession(session, expected) &&
    evidence.sessionId === session.sessionId && evidence.pid === session.pid &&
    evidence.backendId === session.backendId && canonical(evidence.executable) === canonical(session.executable));
}
function isVerifiedBackendChildExit(evidence, session, expected = {}) {
  return isVerifiedBackendExit(evidence, session, expected) && verifiedChildExits.has(evidence);
}
function isVerifiedBackendTreeExit(evidence, session, expected = {}) {
  return isVerifiedBackendChildExit(evidence, session, expected) && verifiedTreeExits.has(evidence);
}
function isVerifiedInProcessOutputScope(scope, session) {return Boolean(scope && verifiedOutputScopes.get(scope) === session && isVerifiedBackendSession(session));}
function localPath(value) {
  if (typeof value !== 'string' || !path.win32.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('后端只接受主进程已授权的本地绝对路径。');
  return path.win32.normalize(value);
}
const covered = (filename, directories) => directories.some(directory => canonical(filename) === canonical(directory) || canonical(filename).startsWith(`${canonical(directory)}\\`));
function endpointForOutput(output) {
  if (!output || /asio/i.test(`${output.name || ''} ${output.typeName || ''}`)) return null;
  const match = String(output.deviceId || '').match(/:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
  if (!match || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(match[1])) return null;
  return `{0.0.0.00000000}.{${match[1].toUpperCase()}}`;
}
async function inspectWindows({ executable, port, pid, signal }) {
  const escaped = executable.replace(/'/g, "''");
  const checkPid = Number.isInteger(pid) && pid > 0;
  const exact = checkPid ? `$q = @(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction Stop); $c = @{ pid=${pid}; present=($q.Count -gt 0); executablePath=($q | Select-Object -First 1 -ExpandProperty ExecutablePath) };` : '$c = $null;';
  const command = `$p = @(Get-CimInstance Win32_Process -Filter \"Name='foobar2000.exe'\" -ErrorAction Stop | Where-Object { $_.ExecutablePath -eq '${escaped}' } | ForEach-Object { @{ pid=$_.ProcessId; executablePath=$_.ExecutablePath } }); $l = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { @{ pid=$_.OwningProcess; address=$_.LocalAddress } }); ${exact} @{ processes=$p; listeners=$l; pidCheck=$c } | ConvertTo-Json -Depth 4 -Compress`;
  const { stdout } = await executeFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 5000, signal });
  const result = JSON.parse(stdout);
  if (!Array.isArray(result.processes) || !Array.isArray(result.listeners)) throw new Error('无法核验专属后端进程和端口所有者。');
  return result;
}

function createBackendManager(options = {}) {
  if (!options.backendDir) throw new Error('专属 backendDir 必须显式指定。');
  const backendDir = path.resolve(options.backendDir), executable = path.join(backendDir, 'foobar2000.exe');
  const manifestPath = path.join(backendDir, 'backend-manifest.json');
  const configPath = path.join(backendDir, 'profile', 'beefweb', 'config.json');
  const probePath = options.probePath || path.join(backendDir, 'tools', 'foobar-coreaudio-probe.exe');
  const fetcher = options.fetch || globalThis.fetch;
  const expectedPublicFiles = options.publicFiles ? JSON.stringify(options.publicFiles) : null;
  const inspect = options.inspectSystem || inspectWindows, execute = options.execFile || executeFile;
  const platform = options.platform || process.platform;
  const completeFixtureDI = options.platform === 'win32' && ['spawn', 'fetch', 'inspectSystem', 'execFile'].every(name => typeof options[name] === 'function');
  if (options.runtimeRoot !== undefined && !completeFixtureDI) throw new Error('runtimeRoot 仅允许完整显式 synthetic process/fetch DI；生产固定随包运行时根。');
  const runtimeRoot = options.runtimeRoot === undefined ? path.resolve(__dirname, '../..') : path.resolve(options.runtimeRoot);
  let manifest = null, configuration = null, child = null, ownedPid = null, observedPid = null, starting = null, closing = null, closed = false;
  let normalCloseCompleted = false;
  let outputPolicy = null, startupFailure = null, launchAttempt = null;
  let startupTrace = null, startupDiagnostic = null;
  let ownedSession = null, retiring = null, handoffStandby = false, savedHandoffBackendId = null, closedProfileFingerprint = null, handoffRestoreEligible = true;
  const quietRestartPolicy = options.quietRestartPolicy === 'stopped-owned-exit' ? 'stopped-owned-exit' : null;
  // Retain exact object identities until this manager is disposed. A replacement
  // bridge must drain the old session using its own branded exit proof, never a
  // new PID, a successful GET, or a serialized copy of an old proof.
  const sessions = new Map();
  const safeSelections = new Map();
  const treeExitListeners = new Set();
  const dynamicOutputScopes = new WeakMap();
  let status = 'unprepared', available = false, lastError = null, startController = null, callerSignal = null;
  const pendingRoots = new Map();
  const clone = value => JSON.parse(JSON.stringify(value));
  function getInfo() {
    return { available, managed: true, owned: Boolean(ownedSession && !treeComplete(ownedSession)), pid: ownedPid || observedPid || (ownedSession && !treeComplete(ownedSession) ? ownedSession.pid : null),
      foobarDir: backendDir, baseUrl: configuration ? `http://127.0.0.1:${configuration.port}/api/` : null,
      status, error: lastError, backendId: manifest?.backendId || null,
      abnormalStartupExitRequired: Boolean(startupFailure && ownedSession && !ownedSession.nativeReadySeen && !ownedSession.verified && !treeComplete(ownedSession)),
      startupCreated: Boolean(launchAttempt?.created),
      nativeReadySeen: Boolean(ownedSession?.nativeReadySeen),
      startupDiagnostic: startupDiagnostic && clone(startupDiagnostic),
      pendingHandoff: handoffStandby, canStartOnDemand: !closed && handoffStandby && handoffRestoreEligible && quietRestartPolicy === 'stopped-owned-exit' && Boolean(manifest) && Boolean(closedProfileFingerprint),
      quietRestartPolicy,
      sessionId: ownedSession?.verified ? ownedSession.token.sessionId : null,
      musicDirs: [...(configuration?.musicDirs || [])], pendingRoots: [...pendingRoots.values()], restartRequired: pendingRoots.size > 0,
      privateUseOnly: true, originalProfileModified: false };
  }
  function checkOpen(signal) { if (closed || signal?.aborted) throw abortError(); }
  async function rejectIncompleteComponentInstall() {
    const marker = path.join(backendDir, '.spectrum-component-install-incomplete.json');
    if (await fs.lstat(marker).catch(error => {if (error.code !== 'ENOENT') throw error; return null;})) {
      throw Object.assign(new Error('专属组件迁移尚未完成或回滚未确认；未启动内核。'), {code: 'STILL_BACKEND_COMPONENT_INSTALL_INCOMPLETE'});
    }
  }
  async function privateFile(filename) {
    const relative = path.relative(backendDir, filename);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('专属后端文件越过目录边界。');
    let cursor = backendDir;
    for (const part of relative.split(path.sep)) {
      cursor = path.join(cursor, part);
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('专属后端配置/manifest 不能是链接或 junction。');
    }
    const real = await fs.realpath(filename), fromRoot = path.relative(backendDir, real);
    if (!fromRoot || fromRoot.startsWith('..') || path.isAbsolute(fromRoot) || !(await fs.stat(real)).isFile()) throw new Error('专属后端文件不在自身目录内。');
  }
  async function readManifest(signal) {
    checkOpen(signal);
    const rootReal = await fs.realpath(backendDir);
    if (canonical(rootReal) !== canonical(backendDir)) throw new Error('专属后端目录不能是链接或 junction。');
    await rejectIncompleteComponentInstall();
    await privateFile(manifestPath); checkOpen(signal);
    const value = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (value.schemaVersion !== 1 || value.privateUseOnly !== true || value.executable !== 'foobar2000.exe' || typeof value.backendId !== 'string' || !Array.isArray(value.files)) throw new Error('专属后端 manifest 无效；不会启动其他 foobar2000。');
    if (value.sourceDir && canonical(value.sourceDir) === canonical(backendDir)) throw new Error('不能把用户原安装视作专属后端。');
    if (options.requirePublicProvenance === true && (value.provenance?.kind !== 'official-installer-local' ||
        value.provenance.version !== '2.26.2' || value.provenance.architecture !== 'x64' ||
        value.provenance.installerSha256 !== 'ffa739f87d9c374cb030426a2ab4bfb37959d0dbb892fdc742654c14d127f795')) {
      throw new Error('公开安装必须使用首次设置验证的官方隔离内核。');
    }
    if (options.requirePublicProvenance === true && (!expectedPublicFiles || JSON.stringify(value.files) !== expectedPublicFiles)) throw new Error('公开内核文件清单与固定来源不一致。');
    for (const required of ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll']) {
      if (!value.files.some(item => item.relativePath === required)) throw new Error(`专属后端缺少必要 manifest 项：${required}`);
    }
    const seen = new Set();
    for (const item of value.files) {
      checkOpen(signal);
      if (typeof item.relativePath !== 'string' || item.relativePath.includes('\\') || item.relativePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('专属后端 manifest 含越界路径。');
      if (seen.has(item.relativePath.toLowerCase())) throw new Error('专属后端 manifest 含重复路径。'); seen.add(item.relativePath.toLowerCase());
      if (!item.mutable && !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('专属后端 manifest 缺少固定 SHA-256。');
      const file = path.resolve(backendDir, item.relativePath), relative = path.relative(backendDir, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('专属后端文件越过目录边界。');
      let cursor = backendDir;
      for (const part of item.relativePath.split('/')) { cursor = path.join(cursor, part); if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('专属后端文件不能是链接。'); }
      if (!(await fs.stat(file)).isFile()) throw new Error(`专属后端文件无效：${item.relativePath}`);
      if (!item.mutable && sha256(await fs.readFile(file)) !== item.sha256) throw new Error(`专属后端文件校验失败：${item.relativePath}`);
    }
    if (value.files.find(row => row.relativePath === 'foobar2000.exe')?.mutable !== false) throw new Error('专属可执行文件必须由不可变 SHA-256 校验。');
    if (options.requirePublicProvenance === true) {await assertPublicBackendCode(backendDir, value.files); checkOpen(signal);}
    await privateFile(configPath); checkOpen(signal);
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || config.port === 8880 || config.allowRemote !== false ||
        !Array.isArray(config.musicDirs) || !config.musicDirs.length) throw new Error('专属 Beefweb 配置必须使用独立端口、仅本机连接和明确的音乐目录。');
    config.musicDirs.forEach(localPath);
    if (config.port !== value.configuration?.port) throw new Error('专属后端端口与 manifest 不一致。');
    const assets = await readBackendRuntimeAssets(runtimeRoot); checkOpen(signal);
    try { outputPolicy = parseBackendOutputPolicy(JSON.parse(assets.backendOutputPolicy.bytes.toString('utf8'))); }
    catch (cause) { throw Object.assign(new Error('随包输出 policy 未通过严格 schema/tuple 校验。'), {code: 'STILL_BACKEND_OUTPUT_POLICY_UNVERIFIED', cause}); }
    checkOpen(signal); manifest = value; configuration = config;
  }
  async function request(route, body, signal) {
    const response = await fetcher(new URL(route, getInfo().baseUrl), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs || 1500)]) : AbortSignal.timeout(options.requestTimeoutMs || 1500) });
    const raw = await response.text();
    if (!response.ok) throw new Error(`专属 Beefweb ${response.status}: ${raw.slice(0, 300)}`);
    return raw ? JSON.parse(raw) : null;
  }
  function exactProcess(system, pid) { return system.processes.find(item => item.pid === pid && canonical(item.executablePath) === canonical(executable)); }
  async function systemState(signal) {
    const result = await inspect({ executable, port: configuration.port, pid: ownedSession?.pid, signal });
    if (!Array.isArray(result.processes) || !Array.isArray(result.listeners)) throw new Error('专属后端进程信息无效。');
    return result;
  }
  function endpointOwner(system) {
    if (!system.listeners.length) return null;
    if (system.listeners.some(item => !['127.0.0.1', '::1'].includes(item.address))) throw new Error('专属端口未限制为 loopback；不会连接或修改该服务。');
    const owners = new Set(system.listeners.map(item => item.pid));
    if (owners.size !== 1) throw new Error('专属端口有多个所有者，无法安全管理。');
    const pid = [...owners][0];
    if (!exactProcess(system, pid)) throw new Error('专属端口被其他进程占用；不会连接、退出或改动原 foobar2000。');
    return pid;
  }
  async function ready(signal) {
    const system = await systemState(signal), pid = endpointOwner(system); checkOpen(signal);
    if (!pid) throw new Error('专属 Beefweb 尚未监听。');
    const player = (await request('player', undefined, signal))?.player; checkOpen(signal);
    if (player?.info?.name !== 'foobar2000' || !/^0\.10(?:\D|$)/.test(player.info.pluginVersion || '') || !['stopped', 'playing', 'paused'].includes(player.playbackState)) throw new Error('专属服务版本或播放器状态未核验。');
    const roots = (await request('browser/roots', undefined, signal))?.roots; checkOpen(signal);
    if (!Array.isArray(roots) || !configuration.musicDirs.every(directory => roots.some(item => canonical(item.path) === canonical(directory)))) throw new Error('专属 Beefweb 未读回所配置的音乐目录；未宣称导入可用。');
    if (ownedSession?.pid === pid && ownedSession.child === child) {
      if (ownedSession.exited || ownedSession.child.exitCode != null) throw new Error('专属后端在就绪读回期间已退出。');
      ownedSession.verified = true; verifiedSessions.add(ownedSession.token);
    }
    observedPid = pid; available = true; status = 'ready'; lastError = null;
    return getInfo();
  }
  function environment() { return { ...process.env, BEEFWEB_CONFIG_FILE: configPath }; }
  async function profileFingerprint() {
    // Fixed foobar configuration database only, after owned-child exit and
    // immediately before reopening. No profile tree or authentication access.
    const result = [];
    for (const relativePath of ['profile/config.sqlite', 'profile/config.sqlite-wal', 'profile/config.sqlite-shm']) {
      const filename = path.join(backendDir, relativePath), stat = await fs.lstat(filename).catch(error => {if (error.code !== 'ENOENT') throw error; return null;});
      if (!stat) {result.push({relativePath, sha256: null}); continue;}
      await privateFile(filename);
      if (stat.size > 64 * 1024 * 1024) throw new Error('专属配置指纹超过固定上限；未重启。');
      result.push({relativePath, sha256: sha256(await fs.readFile(filename))});
    }
    return result;
  }
  function treeComplete(session) {
    return Boolean(session && session.childExitObserved === true && (session.injectedSingleProcess
      ? session.treeExited === true : isBackendJobTreeExit(session.child.treeExitEvidence, session.child)));
  }
  function registerCreated(witness, started, injected = false) {
    if (!started || !Number.isInteger(witness?.pid) || witness.pid <= 0 ||
        (!injected && !isOwnedCreationWitness(witness, started))) throw new Error('缺少本次自建进程的精确创建见证。');
    if (ownedSession && !treeComplete(ownedSession)) throw new Error('上一自建进程仍未确认完整退出；未覆盖所有权。');
    child = started; ownedPid = witness.pid;
    const session = {pid: witness.pid, child: started, verified: false, exited: false, evidence: null,
      injectedSingleProcess: injected, treeExited: false, nativeReadySeen: injected, createdWitness: witness, selectionToken: null,
      token: Object.freeze({sessionId: randomUUID(), pid: witness.pid, startTime: witness.startTime,
        executable, profilePath: configPath, executableSha256: witness.executableSha256,
        foobarDir: backendDir, backendId: manifest.backendId, baseUrl: getInfo().baseUrl})};
    if (!injected && options.requirePublicProvenance === true && expectedPublicFiles && options.dacProbeSha256 === DAC_IDENTITY_PROBE_SHA256 &&
        manifest.files.every(row => row.mutable === false) && manifest.files.find(row => row.relativePath === 'foobar2000.exe')?.sha256 === witness.executableSha256) {
      // readManifest already verified the exact public inventory, file bytes,
      // component namespace and official-installer provenance before launch.
      session.dacVersionScope = Object.freeze({backendId: manifest.backendId, coreSha256: witness.executableSha256,
        componentsSha256: sha256(expectedPublicFiles), probeSha256: options.dacProbeSha256, providerPolicyVersion: PROVIDER_POLICY_VERSION});
    }
    ownedSession = session; sessions.set(session.token, session);
    if (launchAttempt) {launchAttempt.created = true; launchAttempt.session = session;}
    if (startupFailure) {startupFailure.created = true; startupFailure.abnormalStartupExitRequired = !session.nativeReadySeen;}
    started.once?.('ready', () => {session.nativeReadySeen = true; if (startupFailure) startupFailure.abnormalStartupExitRequired = false;});
    started.on?.('control-error', error => {
      session.controlError = error; available = false; lastError = errorMessage(error); status = 'failed';
    });
    started.once?.('error', error => {session.launchError = error; lastError = error.message; available = false; status = 'failed';});
    started.once?.('exit', () => {
      session.childExitObserved = true;
      if (injected && started.jobTreePending !== true) session.treeExited = true;
      recordOwnedExit(session);
      if (ownedSession === session) status = closed ? 'closed' : 'offline';
    });
    started.on?.('job-tree-empty', () => {
      if (!session.childExitObserved || (!injected && !isBackendJobTreeExit(started.treeExitEvidence, started))) return;
      session.treeExited = true; recordOwnedExit(session);
    });
    return session;
  }
  function recordOwnedExit(session) {
    if (!session.childExitObserved) return null;
    session.exited = true;
    if (ownedSession === session) {
      if (ownedPid === session.pid) { ownedPid = null; child = null; }
      if (observedPid === session.pid) observedPid = null;
      available = false;
    }
    if (!session.verified) return null;
    if (!session.evidence) {
      session.evidence = Object.freeze({ ...session.token, owned: true, exited: true, verified: true,
        verifiedBy: 'owned-child-process-exit', verifiedAt: new Date().toISOString() });
      verifiedExits.add(session.evidence);
    }
    verifiedChildExits.add(session.evidence);
    if (treeComplete(session)) {
      verifiedTreeExits.add(session.evidence);
      if (session.selectionToken) safeSelections.delete(session.selectionToken);
      session.selectionToken = null;
      if (!session.treeExitNotified && isVerifiedBackendTreeExit(session.evidence, session.token)) {
        // Mark first: an observer may re-enter lifecycle/read APIs. Neither a
        // synchronous throw nor a rejected observer can undo real exit proof.
        session.treeExitNotified = true;
        const listeners = [...treeExitListeners].map(entry => entry.listener);
        try {if (typeof options.onVerifiedOwnedTreeExit === 'function') listeners.unshift(options.onVerifiedOwnedTreeExit);}
        catch { /* An observer accessor cannot affect lifecycle evidence. */ }
        for (const listener of listeners) {
          try {Promise.resolve(listener(session.evidence, session.token)).catch(() => {});}
          catch { /* Lifecycle evidence does not depend on an observer. */ }
        }
      }
    }
    return session.evidence;
  }
  function getVerifiedOwnedTreeExit(token) {
    const session = sessions.get(token);
    return session && isVerifiedBackendTreeExit(session.evidence, token) ? session.evidence : null;
  }
  function subscribeVerifiedOwnedTreeExit(listener) {
    if (typeof listener !== 'function') throw new TypeError('A verified tree exit listener must be a function.');
    const entry = {listener}; treeExitListeners.add(entry);
    // Registration never replays or manufactures evidence. Late subscribers
    // can query an exact retained token through getVerifiedOwnedTreeExit.
    return () => {treeExitListeners.delete(entry);};
  }
  function inspectOwnedExit(session) {
    if (session.childExitObserved) return { exited: true, evidence: recordOwnedExit(session) };
    return { exited: false, evidence: null };
  }
  async function exitOwned({expectedSession, requireChildWitness = true, signal, check} = {}) {
    const session = ownedSession;
    if (!session) return null;
    const verifyIntent = () => {
      // Once the graceful command was sent, keep observing this exact child
      // to an actual exit or timeout. A cancelled caller cannot make that
      // already-dispatched resource transition disappear.
      if (!requireChildWitness || !session.exitCommandDispatched) {
        if (signal?.aborted) throw abortError();
        check?.();
        if (signal?.aborted) throw abortError();
      }
      if (expectedSession && (session.token !== expectedSession || ownedSession !== session)) throw new Error('交接会话已改变；未退出新的后端进程。');
    };
    const accepted = proof => proof.exited && treeComplete(session) &&
      (!session.verified || isVerifiedBackendTreeExit(proof.evidence, session.token));
    verifyIntent();
    let proof = inspectOwnedExit(session);
    if (accepted(proof)) return proof.evidence;
    const system = await systemState();
    verifyIntent();
    proof = inspectOwnedExit(session);
    if (accepted(proof)) return proof.evidence;
    if (!proof.exited && !exactProcess(system, session.pid)) throw new Error('无法核验仍存活的专属 PID/可执行文件；没有匹配 owned child 的实际退出事件，未采用 PID 缺席作为证明。');
    // Dispatch once, then observe the actual child independently of the CLI's
    // response. A hung forwarding helper must not hide a verified process exit.
    // Never abort/kill it on the deadline; timeout is only an explicit failure.
    if (!session.exitCommand && !proof.exited) {
      if (session.controlError) throw session.controlError;
      session.exitCommandSettled = false; session.exitCommandError = null;
      const command = Promise.resolve().then(() => {
        const native = isBackendJobProcess(session.child);
        const settings = native ? null : {cwd: backendDir, env: environment(), windowsHide: true};
        // Reservation is not dispatch. This last synchronous gate runs after
        // queued cancellation and immediately before the physical invocation.
        verifyIntent();
        if (session.controlError) throw session.controlError;
        if (session.childExitObserved) return;
        session.exitCommandDispatched = true;
        return native ? session.child.requestExit() : execute(executable, ['/exit'], settings);
      });
      session.exitCommand = command;
      command.then(() => {if (session.exitCommand === command) session.exitCommandSettled = true;}, error => {
        if (session.exitCommand !== command) return;
        session.exitCommandSettled = true; session.exitCommandError = error;
        // Only an uninvoked reservation is reusable. An actual dispatch keeps
        // its lifetime and must still reach the original child/tree proof.
        if (!session.exitCommandDispatched) session.exitCommand = null;
      });
    }
    const deadline = Date.now() + (options.shutdownTimeoutMs || 4000);
    while (Date.now() < deadline) {
      verifyIntent();
      proof = inspectOwnedExit(session);
      if (accepted(proof)) return proof.evidence;
      const current = await systemState();
      verifyIntent();
      proof = inspectOwnedExit(session);
      if (accepted(proof)) return proof.evidence;
      if (!proof.exited && !exactProcess(current, session.pid)) throw new Error('专属 PID 的进程身份无法继续核验；没有实际退出事件，未宣称已退出。');
      if (session.exitCommandError) throw session.exitCommandError;
      await wait(options.pollMs || 80);
    }
    throw Object.assign(new Error('专属后端未确认退出或 Job tree 尚未确认清空；不会用关 Job 句柄强制结束进程。'), {code: 'STILL_BACKEND_EXIT_UNVERIFIED'});
  }
  async function writeConfiguration(next, signal) {
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    checkOpen(signal);
    await privateFile(configPath); checkOpen(signal);
    try { await fs.writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx' }); await privateFile(configPath); checkOpen(signal); await fs.rename(temporary, configPath); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    configuration = next;
  }
  async function preparePaths({ paths, deferRestart = true } = {}) {
    if (!Array.isArray(paths)) throw new Error('preparePaths 需要已由原生选择器授权的 paths 数组。');
    if (!configuration) await readManifest();
    checkOpen();
    for (const file of paths) {
      const value = localPath(typeof file === 'string' ? file : file?.path);
      if (!covered(value, configuration.musicDirs)) {
        const directory = path.win32.dirname(value);
        pendingRoots.set(canonical(directory), directory);
      }
    }
    if (!deferRestart && pendingRoots.size) throw new Error('目录变更需要在明确开始播放时调用 ensureStarted({allowRestart:true})；库导入不会停曲。');
    return { prepared: pendingRoots.size === 0, pending: pendingRoots.size > 0, restartRequired: pendingRoots.size > 0,
      configuredRoots: [...configuration.musicDirs], pendingRoots: [...pendingRoots.values()] };
  }
  async function doInitialize({ start = true, allowRestart = false, restartOwned = false, explicitLocalPlay = false, explicitHandoffRestore, paths, signal } = {}) {
    if (startupFailure) throw startupFailure;
    startupTrace.phase = 'validate-backend';
    checkOpen(signal); status = 'checking'; await readManifest(signal); checkOpen(signal);
    if (savedHandoffBackendId && savedHandoffBackendId !== manifest.backendId) throw new Error('交接快照不属于当前专属内核；未自动启动或覆盖上下文。');
    if (paths) await preparePaths({ paths, deferRestart: true });
    checkOpen(signal); startupTrace.phase = 'inspect-system'; let system = await systemState(signal); checkOpen(signal);
    if (ownedSession) inspectOwnedExit(ownedSession, system);
    if (restartOwned && start && ownedSession) {
      // An explicit reconnect may retire an uncertain HTTP lifetime without
      // waiting behind that lifetime's unresolved writes. It only exits the
      // process personally spawned and verified by this manager; it never
      // adopts or exits a replacement/reused process.
      status = 'restarting';
      await exitOwned(); checkOpen(signal);
      system = await systemState(signal); checkOpen(signal);
    }
    const owner = endpointOwner(system);
    if (options.requireOwnedSession === true && owner && (!ownedSession || ownedSession.pid !== owner)) {
      throw new Error('请先正常关闭安装器启动的隔离 foobar2000，再由 STILL 连接；没有接管或退出该既存进程。');
    }
    if (handoffStandby && owner) throw new Error('待机交接后发现另一个既存进程；未采用旧退出证明或接管新实例。');
    if (handoffStandby && (!start || !explicitLocalPlay && !isExplicitAppleHandoffContext(explicitHandoffRestore))) {
      available = false; status = 'standby'; return getInfo();
    }
    if (owner && pendingRoots.size && start && allowRestart) {
      if (!ownedPid || owner !== ownedPid) throw new Error('目录重载只能退出本次 STILL 启动的专属后端；既存实例保持运行。');
      const current = (await request('player', undefined, signal))?.player; checkOpen(signal);
      if (current?.playbackState !== 'stopped') throw new Error('请在明确播放流程中先取消旧请求并确认 stop，再重载专属后端。');
      const queue = (await request('playqueue', undefined, signal))?.playQueue; checkOpen(signal);
      if (!Array.isArray(queue) || queue.length) throw new Error('播放队列非空或无法核验；保留现有队列和后端，新目录继续等待重载。');
      status = 'restarting'; checkOpen(signal); await exitOwned(); checkOpen(signal); system = await systemState(signal); checkOpen(signal);
    } else if (owner) {
      startupTrace.phase = 'verify-http-ready';
      return ready(signal);
    }
    if (!start) {
      available = false; status = 'offline'; lastError = '专属后端尚未运行；只读模式不会启动它。'; return getInfo();
    }
    if (platform !== 'win32') throw new Error('此专属 foobar2000 后端只支持 Windows。');
    if (system.processes.length) throw new Error('专属后端进程已存在但端口不可用；不会启动重复实例。');
    if (pendingRoots.size) {
      const applyingRoots = new Map(pendingRoots);
      const next = clone(configuration);
      next.musicDirs = [...new Map([...next.musicDirs, ...applyingRoots.values()].map(item => [canonical(item), item])).values()];
      await writeConfiguration(next, signal);
      for (const [key, value] of applyingRoots) if (pendingRoots.get(key) === value) pendingRoots.delete(key);
      checkOpen(signal);
    }
    if (handoffStandby) {
      if (!handoffRestoreEligible) throw Object.assign(new Error('交接记录并非完整 awaiting-local/stopped 状态；未启动。'), {code: 'STILL_HANDOFF_RESTORE_UNVERIFIED'});
      if (quietRestartPolicy !== 'stopped-owned-exit' || !closedProfileFingerprint) throw new Error('交接后的 stopped/正常退出/closed 指纹前提未满足；未启动或恢复旧曲。');
      if (JSON.stringify(await profileFingerprint()) !== JSON.stringify(closedProfileFingerprint)) throw new Error('关闭期间专属配置已改变；未覆盖新选择或自动恢复旧曲。');
      checkOpen(signal);
    }
    status = 'starting';
    await rejectIncompleteComponentInstall();
    if (explicitHandoffRestore !== undefined && !isExplicitAppleHandoffContext(explicitHandoffRestore)) throw abortError();
    checkOpen(signal);
    const launchArgs = handoffStandby || options.startStopped === true ? ['/hide', '/stop'] : ['/hide'];
    launchAttempt = {created: false, session: null};
    const trace = startupTrace; trace.launchRequested = true; trace.phase = 'prepare-launch';
    let started;
    if (options.spawn && !options.launchOwned) {
      // Backward-compatible, explicitly complete synthetic DI only. Production
      // never falls back to Node's ordinary unsuspended spawn for a backend.
      if (!completeFixtureDI) throw new Error('旧 spawn 仅支持完整显式 synthetic process/fetch DI。');
      trace.phase = 'invoke-synthetic-launcher'; trace.launcherInvoked = true;
      started = options.spawn(executable, launchArgs, {cwd: backendDir, env: environment(), windowsHide: true, stdio: 'ignore', detached: false});
      if (!started || !Number.isInteger(started.pid)) throw new Error('专属后端没有返回进程标识。');
      registerCreated(Object.freeze({pid: started.pid, startTime: started.startTime || `fixture:${randomUUID()}`,
        executable, profilePath: configPath, executableSha256: manifest.files.find(row => row.relativePath === 'foobar2000.exe').sha256}), started, true);
      trace.bindingReturned = true; trace.createdWitnessAccepted = true;
    } else {
      if (options.launchOwned && !completeFixtureDI) throw new Error('launchOwned 仅支持完整显式 synthetic process/fetch DI。');
      trace.phase = 'build-launch-descriptor';
      const descriptor = {executable, backendDir, profilePath: configPath,
        executableSha256: manifest.files.find(row => row.relativePath === 'foobar2000.exe').sha256,
        configSha256: sha256(await fs.readFile(configPath)), backendId: manifest.backendId, args: launchArgs, env: environment(),
        onCreated: (witness, process) => {
          trace.phase = 'register-created-witness';
          trace.creationCallbackEntered = true;
          try {
            registerCreated(witness, process);
            trace.createdWitnessAccepted = true;
            if (closed || launchAttempt.failed) throw abortError();
            trace.phase = 'await-native-ready';
          } catch (error) {trace.failurePhase = 'register-created-witness'; throw error;}
        }};
      trace.phase = 'invoke-owned-launcher'; trace.launcherInvoked = true;
      started = await (options.launchOwned || createBackendJobProcess)(descriptor);
      trace.bindingReturned = true; trace.phase = 'await-native-ready';
      let timer;
      try {await Promise.race([started.ready, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('专属 Job 启动未确认；禁止自动重试。'), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN'})), options.startupTimeoutMs || 10000);
      })]);} finally {clearTimeout(timer);}
      if (!ownedSession || ownedSession.child !== started) throw new Error('专属启动器没有给出本次真实创建见证。');
    }
    const session = ownedSession;
    trace.phase = 'verify-http-ready';
    handoffStandby = false; savedHandoffBackendId = null;
    const deadline = Date.now() + (options.startupTimeoutMs || 10000);
    let prior;
    do {
      checkOpen(signal);
      if (session.launchError || session.controlError) throw session.launchError || session.controlError;
      if (started.exitCode != null) throw new Error(`专属后端在就绪前退出（${started.exitCode}）。`);
      try { return await ready(signal); } catch (error) { checkOpen(signal); prior = error; }
      await wait(options.pollMs || 80);
    } while (Date.now() < deadline);
    throw new Error(`专属后端未就绪：${errorMessage(prior)}`);
  }
  function initialize(input = {}) {
    if (input.explicitHandoffRestore !== undefined && !isExplicitAppleHandoffContext(input.explicitHandoffRestore)) return Promise.reject(Object.assign(new Error('缺少当前 coordinator 显式 Apple 恢复许可。'), {code: 'STILL_HANDOFF_RESTORE_UNVERIFIED'}));
    if (retiring) {
      const previous = ownedSession;
      return retiring.catch(error => {
        if (!previous || !isVerifiedBackendChildExit(previous.evidence, previous.token) || !closedProfileFingerprint) throw error;
      }).then(() => initialize(input));
    }
    if (starting) {
      if (input.signal && input.signal !== callerSignal) {
        startController.abort();
        return starting.catch(() => {}).then(() => initialize(input));
      }
      if (input.paths) return starting.then(() => initialize(input));
      return starting;
    }
    const start = input.start !== false;
    if (!startupFailure) {startupTrace = {phase: 'initialize', launchRequested: false, launcherInvoked: false, bindingReturned: false, creationCallbackEntered: false, createdWitnessAccepted: false}; startupDiagnostic = null;}
    startController = new AbortController(); callerSignal = input.signal;
    const signal = input.signal ? AbortSignal.any([input.signal, startController.signal]) : startController.signal;
    starting = doInitialize({ ...input, start, signal }).catch(error => {
      if (launchAttempt && !launchAttempt.session?.verified && !treeComplete(launchAttempt.session)) {
        launchAttempt.failed = true;
        if (!startupFailure) startupFailure = Object.assign(new Error(errorMessage(error)), {cause: error,
          code: 'STILL_BACKEND_STARTUP_UNCERTAIN', created: launchAttempt.created,
          abnormalStartupExitRequired: Boolean(launchAttempt.created && !launchAttempt.session?.nativeReadySeen)});
        error = startupFailure;
      }
      available = false; lastError = errorMessage(error); status = closed ? 'closed' : 'failed';
      if (!startupDiagnostic) {
        // Observation only: no accepted creation witness remains unconfirmed,
        // never a claim that the OS created no process or that a tree exited.
        const childCode = ownedSession?.childExitObserved === true ? ownedSession.child.exitCode : null;
        startupDiagnostic = Object.freeze({schemaVersion: 1, phase: startupTrace?.failurePhase || startupTrace?.phase || 'initialize',
          launchRequested: startupTrace?.launchRequested === true, launcherInvoked: startupTrace?.launcherInvoked === true,
          bindingReturned: startupTrace?.bindingReturned === true,
          creationObservation: startupTrace?.createdWitnessAccepted ? 'accepted' : startupTrace?.launchRequested ? 'unconfirmed' : 'not-requested-this-call',
          capturedFlags: Object.freeze({creationCallbackEntered: startupTrace?.creationCallbackEntered === true,
            createdWitnessAccepted: startupTrace?.createdWitnessAccepted === true,
            nativeReadySeen: ownedSession?.nativeReadySeen === true, sessionVerified: ownedSession?.verified === true,
            childExitObserved: ownedSession?.childExitObserved === true, jobTreeEmptyWitnessVerified: treeComplete(ownedSession),
            childExitCode: Number.isInteger(childCode) && childCode >= 0 && childCode <= 0xffffffff ? childCode : null}),
          causes: startupCauseChain(error)});
      }
      if (start) throw error;
      return getInfo();
    }).finally(() => { starting = null; startController = null; callerSignal = null; });
    return starting;
  }
  async function waitForOutputRelease({ output, endpointId, timeoutMs = 2500, signal } = {}) {
    const endpoint = endpointId || endpointForOutput(output);
    if (typeof endpoint !== 'string' || !/^\{0\.0\.0\.00000000\}\.\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/i.test(endpoint)) throw new Error('无法把当前输出精确映射到 Windows CoreAudio 端点；未确认独占释放。');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new Error('独占释放探测时限无效。');
    if (!(await fs.stat(probePath).catch(() => null))?.isFile()) throw new Error('缺少 CoreAudio 释放探测工具；stopped 不等于已实测释放。');
    const deadline = Date.now() + timeoutMs;
    let last;
    do {
      checkOpen(signal);
      let stdout, exitCode = 0, processExited = true, timedOut = false;
      try {({stdout} = await execute(probePath, [endpoint, 'shared'], { windowsHide: true, timeout: Math.min(2000, timeoutMs), signal }));}
      catch (failure) {
        checkOpen(signal);
        stdout = failure.stdout; exitCode = Number.isInteger(failure.code) ? failure.code : null;
        timedOut = failure.killed === true || failure.code === 'ETIMEDOUT';
        processExited = Number.isInteger(exitCode) && !failure.signal && !timedOut;
      }
      checkOpen(signal);
      const parsed = parseOutputReleaseEvidence(stdout, {expectedEndpoint: endpoint, processExited, exitCode, timedOut, aborted: false});
      const evidence = {classification: parsed.classification, trustedEndpoint: parsed.trustedEndpoint, ...parsed.evidence};
      last = evidence;
      if (parsed.classification === 'released') return {released: true, evidence: {probe: 'IAudioClient.Initialize/shared', endpoint,
        processExited: true, startCalled: false, ...evidence, result: parsed.evidence}};
      if (parsed.classification !== 'busy') throw Object.assign(new Error(`CoreAudio 释放探测结果未确认（${evidence.hresult || 'unknown'}）；没有将其视为占用或可用。`),
        {code: 'STILL_OUTPUT_RELEASE_UNKNOWN', releaseEvidence: evidence});
      await wait(Math.min(options.pollMs || 80, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw Object.assign(new Error(`同端点仍被占用，未确认独占释放（${last?.hresult || '未知'}）。`), {code: 'STILL_OUTPUT_RELEASE_BUSY', releaseEvidence: last});
  }
  async function waitForExclusiveAccess({ session, output, endpointId, timeoutMs = 2500, signal, context, check } = {}) {
    if (!outputPolicy) {
      const assets = await readBackendRuntimeAssets(runtimeRoot);
      try {outputPolicy = parseBackendOutputPolicy(JSON.parse(assets.backendOutputPolicy.bytes.toString('utf8')));}
      catch (cause) {throw Object.assign(new Error('随包输出 policy 未通过严格校验。'), {code: 'STILL_BACKEND_OUTPUT_POLICY_UNVERIFIED', cause});}
    }
    const endpoint = endpointId || endpointForOutput(output);
    if (typeof endpoint !== 'string' || !/^\{0\.0\.0\.00000000\}\.\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/i.test(endpoint)) throw new Error('无法精确映射待使用的 CoreAudio 端点；未确认独占可用。');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new Error('独占可用性探测时限无效。');
    const policy = matchingOutput(output, endpoint);
    const dynamic = !policy && await authorizeDacScope({session, output, endpoint, context, capability: 'exclusive-check', signal, check});
    const probeSignal = dynamic ? signal || context.signal : signal;
    const format = (policy || dynamic).exclusiveValidationFormat;
    if (!(await fs.stat(probePath).catch(() => null))?.isFile()) throw new Error('缺少 CoreAudio exclusive-check 探测工具。');
    const deadline = Date.now() + timeoutMs;
    let last;
    do {
      checkOpen(probeSignal);
      let stdout, exitCode = 0;
      if (dynamic) {
        await verifyDacProbe(probePath, options.dacProbeSha256);
        dynamic.checkCurrent();
      } else {check?.(); checkOpen(probeSignal);}
      try { ({ stdout } = await execute(probePath, [endpoint, 'exclusive-check', String(format.sampleRate), String(format.bits)], { windowsHide: true, timeout: Math.min(2000, timeoutMs), signal: probeSignal })); }
      catch (error) {
        checkOpen(probeSignal);
        if (!Number.isInteger(error.code) || !error.stdout) throw error;
        exitCode = error.code; stdout = error.stdout;
      }
      checkOpen(probeSignal);
      const result = JSON.parse(String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1));
      if (canonical(result.endpoint) !== canonical(endpoint) || result.operation !== 'Initialize' || result.mode !== 'exclusive-check' || result.startCalled !== false) throw new Error('工具未回读同端点且未启动音频的 exclusive-check；未确认可用。');
      if (result.formatSupported !== true || result.formatSupportHresult !== '0x00000000' ||
          result.requestedRate !== format.sampleRate || result.requestedBits !== format.bits || result.channels !== format.channels) {
        throw new Error(`未确认独占可用：同端点的 ${format.sampleRate} Hz / ${format.bits} 位 / ${format.channels} 声道验证格式必须先获 IsFormatSupported S_OK；不改设备或尝试其他格式。`);
      }
      last = result;
      if (exitCode === 0 && result.initialized === true && result.ready === true && result.released === true && result.hresult === '0x00000000') {
        return { released: true, evidence: { probe: 'IAudioClient.Initialize/exclusive', endpoint, processExited: true, startCalled: false,
          validationFormat: { ...format }, actualDacRate: null,
          meaning: 'exclusive availability at this measurement, followed by immediate release; validation container is not the source/output/DAC format and does not identify a previous owner', result } };
      }
      if (result.hresult !== '0x8889000A') throw new Error(`未确认独占可用：${result.error || result.hresult || '探测格式/释放证据不完整'}`);
      await wait(Math.min(options.pollMs || 80, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw new Error(`端点仍不能独占初始化，未确认其他音频已释放（${last?.hresult || '未知'}）。`);
  }
  async function close() {
    if (closing) return closing;
    closed = true;
    startController?.abort();
    if (ownedSession?.exitCommandSettled && !ownedSession.exited) ownedSession.exitCommand = null;
    closing = (async () => {
      if (starting) await starting.catch(() => {});
      if (startupFailure && ownedSession && !ownedSession.nativeReadySeen && !ownedSession.verified && !treeComplete(ownedSession)) throw startupFailure;
      const exitEvidence = ownedSession && configuration ? await exitOwned() : null;
      available = false; status = 'closed'; lastError = null;
      normalCloseCompleted = true;
      return { ...getInfo(), exitEvidence };
    })().catch(error => {
      normalCloseCompleted = false;
      status = 'shutdown-failed'; lastError = errorMessage(error); closing = null;
      throw error;
    });
    return closing;
  }
  function hasClosedUnverifiedStartupTree({foobarDir} = {}) {
    const session = ownedSession;
    // Private cleanup gate for a failed isolated startup. Keep this separate
    // from the evidence brands granted to a verified playback session.
    return Boolean(normalCloseCompleted && closed && status === 'closed' && session && launchAttempt?.session === session &&
      session.verified === false && typeof foobarDir === 'string' && canonical(foobarDir) === canonical(backendDir) &&
      session.injectedSingleProcess === false && isBackendJobProcess(session.child) && isOwnedCreationWitness(session.createdWitness, session.child) &&
      session.nativeReadySeen === true && !session.controlError && treeComplete(session));
  }
  function matchingOutput(output, endpoint = endpointForOutput(output)) {
    if (!outputPolicy || !endpoint || /asio|dsd|sacd|external|外部/i.test(`${output?.name || ''} ${output?.typeName || ''}`)) return null;
    return outputPolicy.outputs.find(row => row.endpoint.toLowerCase() === endpoint.toLowerCase() &&
      (!output || output.typeId === row.typeId && typeof output.deviceId === 'string' && output.deviceId.toLowerCase() === row.deviceId.toLowerCase())) || null;
  }
  function getSession() {
    return ownedSession?.verified && !ownedSession.exited && ownedPid === ownedSession.pid && observedPid === ownedSession.pid && available ? ownedSession.token : null;
  }
  function getDacVersionScope(session) {
    if (!session || closed || starting || getSession() !== session || !isVerifiedBackendSession(session) ||
        !ownedSession.nativeReadySeen || !isBackendJobProcess(ownedSession.child)) return null;
    return ownedSession.dacVersionScope || null;
  }
  function outputScopeError() {
    return Object.assign(new Error('当前输出没有已核验的进程内 WASAPI 授权范围。'), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'});
  }
  async function authorizeDacScope({session, output, endpoint, context, capability, signal, check}) {
    const tuple = stockDacOutput(output), versionScope = getDacVersionScope(session);
    if (!tuple || !endpoint || canonical(tuple.endpoint) !== canonical(endpoint) || !versionScope || !context || typeof context !== 'object' ||
        typeof options.authorizeDacOutput !== 'function') throw outputScopeError();
    const operationSignal = signal || context.signal;
    const checkIntent = () => {
      checkOpen(operationSignal);
      context.check?.();
      if (check !== context.check) check?.();
      checkOpen(operationSignal);
      if (context.signal?.aborted) throw abortError();
    };
    checkIntent();
    const authorized = await options.authorizeDacOutput({session, output, context, capability, signal: operationSignal});
    const scope = dataFields(authorized, ['typeId', 'deviceId', 'endpoint', 'policy', 'exclusiveValidationFormat', 'ownedExitRelease', 'checkCurrent']);
    const format = dataFields(scope?.exclusiveValidationFormat, ['sampleRate', 'bits', 'channels']);
    if (!scope || scope.typeId !== tuple.typeId || scope.deviceId !== tuple.deviceId || scope.endpoint !== tuple.endpoint ||
        scope.policy !== 'user-dac-authorization-v1' || scope.ownedExitRelease !== (capability === 'owned-exit-fallback') ||
        typeof scope.checkCurrent !== 'function' || format?.sampleRate !== 48000 || ![16, 24, 32].includes(format.bits) || format.channels !== 2) throw outputScopeError();
    function checkCurrent() {
      checkIntent();
      let authorizedNow;
      try {authorizedNow = scope.checkCurrent() === true;} catch {throw outputScopeError();}
      checkOpen(operationSignal);
      if (context.signal?.aborted) throw abortError();
      const current = stockDacOutput(output);
      if (!authorizedNow || getDacVersionScope(session) !== versionScope || current?.typeId !== tuple.typeId || current.deviceId !== tuple.deviceId) throw outputScopeError();
    }
    checkCurrent();
    return {...tuple, policy: scope.policy, exclusiveValidationFormat: Object.freeze(format), ownedExitRelease: scope.ownedExitRelease, checkCurrent};
  }
  function verifyOwnedOutputScope(session, output) {
    const coreFiles = ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll'];
    const policy = matchingOutput(output);
    if (!outputPolicy || options.ownedExitOutputPolicy !== outputPolicy.policyId || !policy || policy.ownedExitRelease !== true || !isVerifiedBackendSession(session) || ownedSession?.token !== session ||
        !ownedSession.verified || !available || manifest?.privateUseOnly !== true || !coreFiles.every(name => manifest.files.some(row => row.relativePath === name && !row.mutable)) ||
        /asio|dsd|sacd|external|外部/i.test(`${output.name || ''} ${output.typeName || ''}`)) {
      throw Object.assign(new Error('当前输出不属于随包 policy 已批准的进程内 WASAPI tuple；进程退出不能证明外部音频宿主释放。'), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'});
    }
    const scope = Object.freeze({policy: outputPolicy.policyId, family: 'in-process-wasapi-exclusive', ...policy, sourceSessionId: session.sessionId});
    verifiedOutputScopes.set(scope, session); return scope;
  }
  async function prepareOwnedOutputScope(session, output, context) {
    if (options.ownedExitOutputPolicy === outputPolicy?.policyId && matchingOutput(output)?.ownedExitRelease === true) return verifyOwnedOutputScope(session, output);
    const {checkCurrent, ...authorized} = await authorizeDacScope({session, output, endpoint: endpointForOutput(output), context, capability: 'owned-exit-fallback'});
    checkCurrent();
    const scope = Object.freeze({...authorized, family: 'in-process-wasapi-exclusive', sourceSessionId: session.sessionId});
    dynamicOutputScopes.set(scope, {context, checkCurrent, used: false});
    verifiedOutputScopes.set(scope, session);
    return scope;
  }
  function getSafeOwnedExitTarget() {
    const session = ownedSession;
    const refused = (code, reason) => ({available: false, refused: true, code, reason, selectionToken: null, target: null});
    if (!session || !sessions.has(session.token)) return refused('STILL_BACKEND_OWNERSHIP_UNVERIFIED', 'no-trusted-created-witness');
    if (!session.verified && !session.nativeReadySeen) return refused('STILL_BACKEND_STARTUP_UNCERTAIN', 'created-startup-never-native-ready; abnormal startup exit required');
    if (treeComplete(session)) return refused('STILL_BACKEND_ALREADY_EXITED', 'owned-child-and-tree-already-exited');
    if (session.controlError) return refused('STILL_BACKEND_OWNERSHIP_UNVERIFIED', 'trusted-observer-or-control-unavailable');
    if (!session.selectionToken) {session.selectionToken = randomUUID(); safeSelections.set(session.selectionToken, session);}
    return {available: true, refused: false, code: null, reason: 'verified-current-manager-created-process', selectionToken: session.selectionToken,
      target: {pid: session.pid, startTime: session.token.startTime, executable: session.token.executable, profilePath: session.token.profilePath}};
  }
  async function requestSafeOwnedExit(input) {
    const refuse = (code, reason, extra = {}) => ({exited: false, refused: true, code, reason, ...extra});
    if (!exactKeys(input, ['selectionToken']) || typeof input.selectionToken !== 'string') return refuse('STILL_BACKEND_OWNERSHIP_UNVERIFIED', 'selection-token-required');
    const session = safeSelections.get(input.selectionToken);
    if (!session || session !== ownedSession || session.selectionToken !== input.selectionToken || !sessions.has(session.token)) return refuse('STILL_BACKEND_OWNERSHIP_UNVERIFIED', 'no-trusted-created-witness-for-selection');
    safeSelections.delete(input.selectionToken); session.selectionToken = null;
    if (!session.verified && !session.nativeReadySeen) return refuse('STILL_BACKEND_STARTUP_UNCERTAIN', 'created-startup-never-native-ready', {abnormalStartupExitRequired: true});
    try {
      await privateFile(executable); await privateFile(configPath);
      const row = manifest.files.find(file => file.relativePath === 'foobar2000.exe');
      if (row?.mutable !== false || row.sha256 !== session.token.executableSha256 || sha256(await fs.readFile(executable)) !== row.sha256 ||
          canonical(session.token.executable) !== canonical(executable) || canonical(session.token.profilePath) !== canonical(configPath) ||
          session.pid !== session.child.pid || session.token.startTime !== (session.injectedSingleProcess ? session.createdWitness.startTime : session.child.startTime)) {
        return refuse('STILL_BACKEND_OWNERSHIP_UNVERIFIED', 'created-identity-or-private-image-changed');
      }
      if (session.exitCommandSettled && !session.exited) session.exitCommand = null;
      const exitEvidence = await exitOwned({expectedSession: session.token});
      return {exited: true, refused: false, code: null, reason: 'actual-owned-child-exit-and-tree-empty', exitEvidence};
    } catch (error) {return refuse(error.code || 'STILL_BACKEND_EXIT_UNVERIFIED', errorMessage(error));}
  }
  return { initialize, ensureStarted: input => initialize({ ...input, start: true }), getInfo, getStatus: getInfo,
    getSession, getDacVersionScope, hasClosedUnverifiedStartupTree,
    getExitEvidence: session => sessions.get(session)?.evidence || null, getVerifiedOwnedTreeExit, subscribeVerifiedOwnedTreeExit,
    getSafeOwnedExitTarget, requestSafeOwnedExit,
    isOwnedTreeExited: session => {const entry = sessions.get(session); return Boolean(entry && treeComplete(entry));},
    getOutputRetirementState(session) {
      const entry = sessions.get(session);
      return entry ? {exitRequested: Boolean(entry.exitCommand), exitDispatched: entry.exitCommandDispatched === true, childExitObserved: entry.childExitObserved === true} : null;
    },
    verifyOwnedOutputScope, prepareOwnedOutputScope,
    deferForSavedOutputHandoff(backendId, fingerprint, {awaitingLocalRestore = false} = {}) {
      if (typeof backendId !== 'string' || !backendId || backendId.length > 200 || ownedPid || observedPid || starting || available) throw new Error('只能在连接前设置待恢复交接；未改动活动内核。');
      if (fingerprint !== undefined && (!Array.isArray(fingerprint) || fingerprint.length !== 3 || fingerprint.some((row, index) => row.relativePath !== ['profile/config.sqlite', 'profile/config.sqlite-wal', 'profile/config.sqlite-shm'][index] || row.sha256 !== null && !/^[a-f0-9]{64}$/.test(row.sha256)))) throw new Error('closed 配置指纹格式未核验。');
      savedHandoffBackendId = backendId; closedProfileFingerprint = fingerprint || null; handoffRestoreEligible = awaitingLocalRestore === true;
      handoffStandby = true; status = 'standby';
      return getInfo();
    },
    retireForOutputHandoff(session, {signal, check, outputScope, context} = {}) {
      if (!isVerifiedBackendSession(session) || ownedSession?.token !== session || !ownedSession.verified || closed || starting) {
        return Promise.reject(new Error('交接只允许本应用已核验的当前 owned session；未退出既存或不明进程。'));
      }
      if (!isVerifiedInProcessOutputScope(outputScope, session)) return Promise.reject(Object.assign(new Error('没有同一会话的进程内输出范围证明；未退出后端。'), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'}));
      const dynamic = dynamicOutputScopes.get(outputScope);
      if (dynamic && (dynamic.used || dynamic.context !== context || retiring)) return Promise.reject(outputScopeError());
      if (retiring) return retiring;
      if (quietRestartPolicy !== 'stopped-owned-exit') return Promise.reject(new Error('未启用 stopped-owned-exit 工程策略；未退出后端。'));
      const checkBeforeDispatch = dynamic ? dynamic.checkCurrent : check;
      if (dynamic) dynamic.used = true;
      retiring = Promise.resolve().then(async () => {
        for (let count = 0; count < 2; count++) {
          if (signal?.aborted) throw abortError(); checkBeforeDispatch?.();
          const player = (await request('player', undefined, signal))?.player;
          if (player?.info?.name !== 'foobar2000' || !/^0\.10(?:\D|$)/.test(player.info?.pluginVersion || '') || player.playbackState !== 'stopped') throw new Error('退出前没有双次真实 stopped 读回；未退出专属内核。');
        }
        return exitOwned({expectedSession: session, requireChildWitness: true, signal, check: checkBeforeDispatch});
      }).then(async evidence => {
        if (!isVerifiedBackendTreeExit(evidence, session)) throw new Error('缺少同一 owned child 及完整 Job tree 的品牌退出证明；未确认释放。');
        handoffStandby = true; handoffRestoreEligible = true; status = closed ? 'closed' : 'standby';
        closedProfileFingerprint = await profileFingerprint();
        check?.(); if (closed || signal?.aborted) throw abortError(); return evidence;
      }).finally(() => {retiring = null;});
      return retiring;
    },
    getClosedProfileFingerprint: () => closedProfileFingerprint ? structuredClone(closedProfileFingerprint) : null,
    preparePaths, waitForOutputRelease, waitForExclusiveAccess, close };
}
module.exports = { createBackendManager, inspectWindows, endpointForOutput, covered, parseBackendOutputPolicy, isVerifiedBackendSession, isVerifiedBackendExit, isVerifiedBackendChildExit, isVerifiedBackendTreeExit, isVerifiedInProcessOutputScope };
