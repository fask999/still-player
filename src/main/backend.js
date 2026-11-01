'use strict';
// Lifecycle of the explicitly assembled private portable backend, never the
// user's original installation. Merely importing this module has no effects.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn: nativeSpawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {parseOutputReleaseEvidence} = require('./output-release-evidence');
const {isExplicitAppleHandoffContext} = require('./playback-coordinator');
const executeFile = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = value => String(value).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const errorMessage = error => error instanceof Error ? error.message : String(error);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const abortError = () => Object.assign(new Error('后端操作已取消。'), { code: 'STILL_CANCELLED' });
const verifiedSessions = new WeakSet(), verifiedExits = new WeakSet();
const verifiedChildExits = new WeakSet();
const verifiedOutputScopes = new WeakMap();
const DX1_WASAPI_OUTPUT = Object.freeze({typeId: 'output',
  deviceId: '0DD9B977-765B-4804-BF2D-B28EBF0C510D:016F9F0C-AFE4-4072-9018-CCEBB576B4CB',
  endpoint: '{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}'});
// No-Start availability validation only. This private DX1 build uses the
// measured supported PCM container; it never changes foobar/source/DAC format.
const EXCLUSIVE_VALIDATION_FORMAT = Object.freeze({ sampleRate: 48000, bits: 32, channels: 2 });
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
  const fetcher = options.fetch || globalThis.fetch, launch = options.spawn || nativeSpawn;
  const inspect = options.inspectSystem || inspectWindows, execute = options.execFile || executeFile;
  const platform = options.platform || process.platform;
  let manifest = null, configuration = null, child = null, ownedPid = null, observedPid = null, starting = null, closing = null, closed = false;
  let ownedSession = null, retiring = null, handoffStandby = false, savedHandoffBackendId = null, closedProfileFingerprint = null, handoffRestoreEligible = true;
  const quietRestartPolicy = options.quietRestartPolicy === 'stopped-owned-exit' ? 'stopped-owned-exit' : null;
  // Retain exact object identities until this manager is disposed. A replacement
  // bridge must drain the old session using its own branded exit proof, never a
  // new PID, a successful GET, or a serialized copy of an old proof.
  const sessions = new Map();
  let status = 'unprepared', available = false, lastError = null, startController = null, callerSignal = null;
  const pendingRoots = new Map();
  const clone = value => JSON.parse(JSON.stringify(value));
  function getInfo() {
    return { available, managed: true, owned: Boolean(ownedPid), pid: ownedPid || observedPid,
      foobarDir: backendDir, baseUrl: `http://127.0.0.1:${configuration?.port || manifest?.configuration?.port || 18880}/api/`,
      status, error: lastError, backendId: manifest?.backendId || null,
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
    for (const required of ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll']) {
      if (!value.files.some(item => item.relativePath === required)) throw new Error(`专属后端缺少必要 manifest 项：${required}`);
    }
    for (const item of value.files) {
      checkOpen(signal);
      if (typeof item.relativePath !== 'string' || item.relativePath.includes('\\') || item.relativePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('专属后端 manifest 含越界路径。');
      const file = path.resolve(backendDir, item.relativePath), relative = path.relative(backendDir, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('专属后端文件越过目录边界。');
      let cursor = backendDir;
      for (const part of item.relativePath.split('/')) { cursor = path.join(cursor, part); if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('专属后端文件不能是链接。'); }
      if (!(await fs.stat(file)).isFile()) throw new Error(`专属后端文件无效：${item.relativePath}`);
      if (!item.mutable && sha256(await fs.readFile(file)) !== item.sha256) throw new Error(`专属后端文件校验失败：${item.relativePath}`);
    }
    await privateFile(configPath); checkOpen(signal);
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || config.port === 8880 || config.allowRemote !== false ||
        !Array.isArray(config.musicDirs) || !config.musicDirs.length) throw new Error('专属 Beefweb 配置必须使用独立端口、仅本机连接和明确的音乐目录。');
    config.musicDirs.forEach(localPath);
    if (config.port !== value.configuration?.port) throw new Error('专属后端端口与 manifest 不一致。');
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
  function recordOwnedExit(session, verifiedBy) {
    session.exited = true;
    if (ownedSession === session) {
      if (ownedPid === session.pid) { ownedPid = null; child = null; }
      if (observedPid === session.pid) observedPid = null;
      available = false;
    }
    if (!session.verified) return null;
    if (!session.evidence) {
      session.evidence = Object.freeze({ ...session.token, owned: true, exited: true, verified: true,
        verifiedBy, verifiedAt: new Date().toISOString() });
      verifiedExits.add(session.evidence);
    }
    if (session.childExitObserved === true) verifiedChildExits.add(session.evidence);
    return session.evidence;
  }
  function inspectOwnedExit(session, system) {
    if (session.exited || session.child.exitCode != null) return { exited: true, evidence: recordOwnedExit(session, 'owned-child-process-exit') };
    if (system?.pidCheck?.pid === session.pid && system.pidCheck.present === false) {
      return { exited: true, evidence: recordOwnedExit(session, 'exact-owned-pid-absent') };
    }
    return { exited: false, evidence: null };
  }
  async function exitOwned({expectedSession, requireChildWitness = false, signal, check} = {}) {
    const session = ownedSession;
    if (!session) return null;
    const verifyIntent = () => {
      // Once the graceful command was sent, keep observing this exact child
      // to an actual exit or timeout. A cancelled caller cannot make that
      // already-dispatched resource transition disappear.
      if (!requireChildWitness || !session.exitCommand) {
        if (signal?.aborted) throw abortError();
        check?.();
      }
      if (expectedSession && (session.token !== expectedSession || ownedSession !== session)) throw new Error('交接会话已改变；未退出新的后端进程。');
    };
    const accepted = proof => proof.exited && (!requireChildWitness || isVerifiedBackendChildExit(proof.evidence, session.token));
    verifyIntent();
    let proof = inspectOwnedExit(session);
    if (accepted(proof)) return proof.evidence;
    const system = await systemState();
    verifyIntent();
    proof = inspectOwnedExit(session, system);
    if (accepted(proof)) return proof.evidence;
    if (proof.exited && requireChildWitness) throw new Error('没有匹配 owned child 的实际退出事件；未采用 PID 缺席作为交接证明。');
    if (!exactProcess(system, session.pid)) throw new Error('无法核验仍存活的专属 PID/可执行文件；未退出任何进程，也未宣称退出。');
    // Dispatch once, then observe the actual child independently of the CLI's
    // response. A hung forwarding helper must not hide a verified process exit.
    // Never abort/kill it on the deadline; timeout is only an explicit failure.
    if (!session.exitCommand) {
      session.exitCommandSettled = false; session.exitCommandError = null;
      session.exitCommand = Promise.resolve().then(() => execute(executable, ['/exit'], { cwd: backendDir, env: environment(), windowsHide: true }));
      session.exitCommand.then(() => { session.exitCommandSettled = true; }, error => {
        session.exitCommandSettled = true; session.exitCommandError = error;
      });
    }
    const deadline = Date.now() + (options.shutdownTimeoutMs || 4000);
    while (Date.now() < deadline) {
      verifyIntent();
      proof = inspectOwnedExit(session);
      if (accepted(proof)) return proof.evidence;
      const current = await systemState();
      verifyIntent();
      proof = inspectOwnedExit(session, current);
      if (accepted(proof)) return proof.evidence;
      if (!exactProcess(current, session.pid)) throw new Error('专属 PID 的进程身份无法继续核验；未宣称已退出。');
      if (session.exitCommandError) throw session.exitCommandError;
      await wait(options.pollMs || 80);
    }
    throw new Error('专属后端未确认退出；不会强制结束进程或退出用户原 foobar2000。');
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
    checkOpen(signal); status = 'checking'; await readManifest(signal); checkOpen(signal);
    if (savedHandoffBackendId && savedHandoffBackendId !== manifest.backendId) throw new Error('交接快照不属于当前专属内核；未自动启动或覆盖上下文。');
    if (paths) await preparePaths({ paths, deferRestart: true });
    checkOpen(signal); let system = await systemState(signal); checkOpen(signal);
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
    const started = launch(executable, handoffStandby ? ['/hide', '/stop'] : ['/hide'], { cwd: backendDir, env: environment(), windowsHide: true, stdio: 'ignore', detached: false });
    if (!started || !Number.isInteger(started.pid)) throw new Error('专属后端没有返回进程标识。');
    child = started; ownedPid = started.pid;
    handoffStandby = false; savedHandoffBackendId = null;
    const session = { pid: started.pid, child: started, verified: false, exited: false, evidence: null,
      token: Object.freeze({ sessionId: randomUUID(), pid: started.pid, executable, foobarDir: backendDir,
        backendId: manifest.backendId, baseUrl: getInfo().baseUrl }) };
    ownedSession = session;
    sessions.set(session.token, session);
    let launchError = null;
    started.once?.('error', error => { launchError = error; lastError = error.message; available = false; status = 'failed'; });
    started.once?.('exit', () => {
      session.childExitObserved = true;
      recordOwnedExit(session, 'owned-child-process-exit');
      if (ownedSession === session) status = closed ? 'closed' : 'offline';
    });
    const deadline = Date.now() + (options.startupTimeoutMs || 10000);
    let prior;
    do {
      checkOpen(signal);
      if (launchError) throw launchError;
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
    startController = new AbortController(); callerSignal = input.signal;
    const signal = input.signal ? AbortSignal.any([input.signal, startController.signal]) : startController.signal;
    starting = doInitialize({ ...input, start, signal }).catch(error => {
      available = false; lastError = errorMessage(error); status = closed ? 'closed' : 'failed';
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
  async function waitForExclusiveAccess({ output, endpointId, timeoutMs = 2500, signal } = {}) {
    const format = EXCLUSIVE_VALIDATION_FORMAT;
    const endpoint = endpointId || endpointForOutput(output);
    if (typeof endpoint !== 'string' || !/^\{0\.0\.0\.00000000\}\.\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/i.test(endpoint)) throw new Error('无法精确映射待使用的 CoreAudio 端点；未确认独占可用。');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new Error('独占可用性探测时限无效。');
    if (!(await fs.stat(probePath).catch(() => null))?.isFile()) throw new Error('缺少 CoreAudio exclusive-check 探测工具。');
    const deadline = Date.now() + timeoutMs;
    let last;
    do {
      checkOpen(signal);
      let stdout, exitCode = 0;
      try { ({ stdout } = await execute(probePath, [endpoint, 'exclusive-check', String(format.sampleRate), String(format.bits)], { windowsHide: true, timeout: Math.min(2000, timeoutMs), signal })); }
      catch (error) {
        checkOpen(signal);
        if (!Number.isInteger(error.code) || !error.stdout) throw error;
        exitCode = error.code; stdout = error.stdout;
      }
      checkOpen(signal);
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
      const exitEvidence = ownedSession && configuration ? await exitOwned() : null;
      available = false; status = 'closed'; lastError = null;
      return { ...getInfo(), exitEvidence };
    })().catch(error => {
      status = 'shutdown-failed'; lastError = errorMessage(error); closing = null;
      throw error;
    });
    return closing;
  }
  return { initialize, ensureStarted: input => initialize({ ...input, start: true }), getInfo, getStatus: getInfo,
    getSession: () => ownedSession?.verified && !ownedSession.exited && ownedPid === ownedSession.pid &&
      observedPid === ownedSession.pid && available ? ownedSession.token : null,
    getExitEvidence: session => sessions.get(session)?.evidence || null,
    getOutputRetirementState(session) {const entry = sessions.get(session); return entry ? {exitRequested: Boolean(entry.exitCommand), childExitObserved: entry.childExitObserved === true} : null;},
    verifyOwnedOutputScope(session, output) {
      const coreFiles = ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll'];
      if (options.ownedExitOutputPolicy !== 'dx1-wasapi-in-process-v1' || !isVerifiedBackendSession(session) || ownedSession?.token !== session ||
          !ownedSession.verified || !available || manifest?.privateUseOnly !== true || !coreFiles.every(name => manifest.files.some(row => row.relativePath === name && !row.mutable)) ||
          output?.typeId !== DX1_WASAPI_OUTPUT.typeId || typeof output.deviceId !== 'string' || output.deviceId.toLowerCase() !== DX1_WASAPI_OUTPUT.deviceId.toLowerCase() ||
          /asio|dsd|sacd|external|外部/i.test(`${output.name || ''} ${output.typeName || ''}`) || endpointForOutput(output)?.toLowerCase() !== DX1_WASAPI_OUTPUT.endpoint.toLowerCase()) {
        throw Object.assign(new Error('当前输出不属于已批准的 DX1 进程内 WASAPI tuple；进程退出不能证明外部音频宿主释放。'), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'});
      }
      const scope = Object.freeze({policy: 'dx1-wasapi-in-process-v1', family: 'in-process-wasapi-exclusive', ...DX1_WASAPI_OUTPUT, sourceSessionId: session.sessionId});
      verifiedOutputScopes.set(scope, session); return scope;
    },
    deferForSavedOutputHandoff(backendId, fingerprint, {awaitingLocalRestore = false} = {}) {
      if (typeof backendId !== 'string' || !backendId || backendId.length > 200 || ownedPid || observedPid || starting || available) throw new Error('只能在连接前设置待恢复交接；未改动活动内核。');
      if (fingerprint !== undefined && (!Array.isArray(fingerprint) || fingerprint.length !== 3 || fingerprint.some((row, index) => row.relativePath !== ['profile/config.sqlite', 'profile/config.sqlite-wal', 'profile/config.sqlite-shm'][index] || row.sha256 !== null && !/^[a-f0-9]{64}$/.test(row.sha256)))) throw new Error('closed 配置指纹格式未核验。');
      savedHandoffBackendId = backendId; closedProfileFingerprint = fingerprint || null; handoffRestoreEligible = awaitingLocalRestore === true;
      handoffStandby = true; status = 'standby';
      return getInfo();
    },
    retireForOutputHandoff(session, {signal, check, outputScope} = {}) {
      if (!isVerifiedBackendSession(session) || ownedSession?.token !== session || !ownedSession.verified || closed || starting) {
        return Promise.reject(new Error('交接只允许本应用已核验的当前 owned session；未退出既存或不明进程。'));
      }
      if (!isVerifiedInProcessOutputScope(outputScope, session)) return Promise.reject(Object.assign(new Error('没有同一会话的进程内输出范围证明；未退出后端。'), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'}));
      if (retiring) return retiring;
      if (quietRestartPolicy !== 'stopped-owned-exit') return Promise.reject(new Error('未启用 stopped-owned-exit 工程策略；未退出后端。'));
      retiring = Promise.resolve().then(async () => {
        for (let count = 0; count < 2; count++) {
          if (signal?.aborted) throw abortError(); check?.();
          const player = (await request('player', undefined, signal))?.player;
          if (player?.info?.name !== 'foobar2000' || !/^0\.10(?:\D|$)/.test(player.info?.pluginVersion || '') || player.playbackState !== 'stopped') throw new Error('退出前没有双次真实 stopped 读回；未退出专属内核。');
        }
        return exitOwned({expectedSession: session, requireChildWitness: true, signal, check});
      }).then(async evidence => {
        if (!isVerifiedBackendChildExit(evidence, session)) throw new Error('缺少同一 owned child 的品牌退出证明；未确认释放。');
        handoffStandby = true; handoffRestoreEligible = true; status = closed ? 'closed' : 'standby';
        closedProfileFingerprint = await profileFingerprint();
        check?.(); if (closed || signal?.aborted) throw abortError(); return evidence;
      }).finally(() => {retiring = null;});
      return retiring;
    },
    getClosedProfileFingerprint: () => closedProfileFingerprint ? structuredClone(closedProfileFingerprint) : null,
    preparePaths, waitForOutputRelease, waitForExclusiveAccess, close };
}
module.exports = { createBackendManager, inspectWindows, endpointForOutput, covered, isVerifiedBackendSession, isVerifiedBackendExit, isVerifiedBackendChildExit, isVerifiedInProcessOutputScope };
