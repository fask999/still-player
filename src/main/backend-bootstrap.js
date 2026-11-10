'use strict';
// Public first-run preparation only. Never discovers/imports another foobar
// installation or profile; never kills an installer or an unowned core.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const {createHash, randomUUID} = require('node:crypto');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {isVerifiedBackendSession} = require('./backend');
const {assertPublicBackendCode} = require('./public-installation');
const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const failure = (code, message) => Object.assign(new Error(message), {code});
const cancelled = () => failure('STILL_SETUP_CANCELLED', '本次准备已取消；没有启动播放内核。');
const canonical = value => path.resolve(value).toLowerCase();
const directoryIdentity = async filename => {
  const stat = await fs.lstat(filename, {bigint: true});
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('准备目标不是独立目录。');
  return {dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs)};
};
const inside = (root, filename) => {const relative = path.relative(root, filename); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);};
function relativeFile(value) {
  if (typeof value !== 'string' || !value || /[\\:\0-\x1f]/.test(value) || value.split('/').some(part =>
    !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('准备清单含不安全路径。');
  return value;
}
async function noLinks(filename) {
  for (let cursor = path.resolve(filename); ; cursor = path.dirname(cursor)) {
    const stat = await fs.lstat(cursor).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
    if (stat && (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1)) throw new Error('准备目录或文件不能是链接。');
    if (path.dirname(cursor) === cursor) break;
  }
}
async function checkedBytes(root, relative, expected) {
  const filename = path.join(root, relativeFile(relative));
  if (!inside(root, filename)) throw new Error('准备文件越界。');
  await noLinks(filename);
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.size > 128 * 1024 * 1024 || expected && before.size !== expected.bytes) throw new Error('准备文件大小不符。');
  const bytes = await fs.readFile(filename), after = await fs.lstat(filename);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size ||
      expected && hash(bytes) !== expected.sha256) throw new Error('准备文件校验失败。');
  await noLinks(filename); return bytes;
}
function x64(bytes) {
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : bytes.length;
  return bytes.subarray(0, 2).toString() === 'MZ' && offset + 26 <= bytes.length &&
    bytes.subarray(offset, offset + 4).equals(Buffer.from([80, 69, 0, 0])) && bytes.readUInt16LE(offset + 4) === 0x8664 && bytes.readUInt16LE(offset + 24) === 0x20b;
}
function validateBootstrapManifest(value) {
  const automatic = value?.schemaVersion === 2;
  if (!exact(value, ['schemaVersion', 'foobarVersion', 'architecture', 'installer', 'coreFiles', 'components', ...(automatic ? ['deployment', 'extractor'] : [])]) ||
      ![1, 2].includes(value.schemaVersion) || value.foobarVersion !== '2.26.2' || value.architecture !== 'x64' ||
      !exact(value.installer, ['relativePath', 'bytes', 'sha256', 'signerSubject', 'signerThumbprint']) ||
      value.installer.relativePath !== 'bootstrap/foobar2000-x64_v2.26.2.exe' || value.installer.bytes !== 7954936 ||
      value.installer.sha256 !== 'ffa739f87d9c374cb030426a2ab4bfb37959d0dbb892fdc742654c14d127f795' ||
      value.installer.signerSubject !== 'CN=Illustrate Ltd, O=Illustrate Ltd, L=Bury, C=GB' ||
      value.installer.signerThumbprint !== '5A4BA9241AD6B108B5E189A3A5043F5B73FCB868' ||
      !Array.isArray(value.coreFiles) || !value.coreFiles.length || value.coreFiles.length > 300 ||
      !Array.isArray(value.components) || !value.components.length || value.components.length > 100) throw new Error('公开播放内核来源清单无效。');
  const seen = new Set(); let total = 0;
  for (const row of value.coreFiles) {
    if (!exact(row, ['relativePath', 'bytes', 'sha256'])) throw new Error('官方文件清单无效。');
    relativeFile(row.relativePath);
    if (row.relativePath.toLowerCase().startsWith('profile/')) throw new Error('不能把已有资料作为官方内核来源。');
    if (automatic && (/\$|[*?]/.test(row.relativePath) || /(?:^|\/)(?:uninstall|setup)\.exe$/i.test(row.relativePath) || /^[+-]/.test(row.relativePath))) throw new Error('不是允许部署的普通内核成员。');
  }
  for (const row of value.components) {
    if (!exact(row, ['sourcePath', 'targetPath', 'bytes', 'sha256']) || !relativeFile(row.sourcePath).startsWith('bootstrap/') ||
        !/^profile\/user-components-x64\/(?:foo_beefweb|foo_still_spectrum)\//.test(relativeFile(row.targetPath))) throw new Error('组件清单越界。');
  }
  for (const row of [...value.coreFiles, ...value.components]) {
    const destination = row.relativePath || row.targetPath;
    if (seen.has(destination.toLowerCase()) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 64 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('文件清单重复或校验字段无效。');
    seen.add(destination.toLowerCase()); total += row.bytes;
  }
  if (total > 512 * 1024 * 1024 || !['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'components/foo_input_std.dll'].every(name => seen.has(name)) ||
      !['profile/user-components-x64/foo_beefweb/foo_beefweb.dll', 'profile/user-components-x64/foo_still_spectrum/foo_still_spectrum.dll'].every(name => seen.has(name))) throw new Error('播放内核必要文件不完整。');
  if (automatic) {
    const names = ['7z.exe', '7z.dll', 'License.txt', 'COPYING.txt', '7z2606-src.7z', 'Source-Info.txt'].map(name => `bootstrap/7zip/${name}`);
    if (value.deployment !== 'extract-original-installer' || !exact(value.extractor, ['executable', 'files']) ||
        value.extractor.executable !== names[0] || !Array.isArray(value.extractor.files) || value.extractor.files.length !== names.length) throw new Error('自动部署工具清单无效。');
    const toolNames = new Set();
    for (const row of value.extractor.files) {
      if (!exact(row, ['relativePath', 'bytes', 'sha256']) || !names.includes(row.relativePath) || toolNames.has(row.relativePath) ||
          !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 32 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('自动部署工具文件无效。');
      toolNames.add(row.relativePath);
    }
    const required = [
      [names[0], 574464, 'dc0493429fe28136fcb177a0e77c9875cbb3b0bff5f2f8eeba4df302e98cef76'],
      [names[1], 1897984, '500db9eb17f3c21b729ba41dd02ecfe1823da05028c7e4ba129084cc74cc364e'],
      [names[4], 1554409, 'e0364d39e8208557d939472c9a12d02ed1c12f45ca402e3b408bcaa63b36dd93']];
    if (required.some(([name, bytes, sha256]) => !value.extractor.files.some(row => row.relativePath === name && row.bytes === bytes && row.sha256 === sha256))) throw new Error('部署工具或对应源码不是固定审核版本。');
    const marker = value.coreFiles.find(row => row.relativePath === 'portable_mode_enabled');
    if (marker.bytes !== 0 || marker.sha256 !== hash(Buffer.alloc(0))) throw new Error('便携标记必须为全新零字节文件。');
  }
  return value;
}
async function verifyExtractionAssets(appRoot, manifest) {
  validateBootstrapManifest(manifest);
  if (manifest.schemaVersion !== 2) throw new Error('此来源未启用自动部署。');
  await assertExtractorNamespace(appRoot, manifest);
  await checkedBytes(appRoot, manifest.installer.relativePath, manifest.installer);
  for (const row of manifest.extractor.files) {
    const bytes = await checkedBytes(appRoot, row.relativePath, row);
    if (/\.(?:exe|dll)$/.test(row.relativePath) && !x64(bytes)) throw new Error('部署工具架构无效。');
  }
}
async function assertExtractorNamespace(appRoot, manifest) {
  const directory = path.join(appRoot, 'bootstrap/7zip'); await noLinks(directory);
  const expected = new Set(manifest.extractor.files.map(row => path.posix.basename(row.relativePath).toLowerCase()));
  const entries = await fs.readdir(directory, {withFileTypes: true}), seen = new Set();
  if (entries.length !== expected.size) throw new Error('部署工具目录不是闭合文件集。');
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (!entry.isFile() || entry.isSymbolicLink() || !expected.has(key) || seen.has(key)) throw new Error('发现未声明的部署工具或旁加载组件。');
    seen.add(key); await noLinks(path.join(directory, entry.name));
  }
}
// Only the exact, personally-created extractor child is cancellable. Its close
// event, not the caller deadline/error event, ends the physical output fence.
function captureExtractorEntry({executable, archivePath, member, expectedBytes, expectedSha256, cwd, signal},
  {spawnProcess = spawn, timeoutMs = 20000} = {}) {
  relativeFile(member);
  if (/\$|[*?]/.test(member) || /^[+-]/.test(member) || /(?:^|\/)(?:uninstall|setup)\.exe$/i.test(member) ||
      member.toLowerCase().startsWith('profile/') || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > 64 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(expectedSha256)) return Promise.reject(new Error('不能提取该成员。'));
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    let child, timer, stopped = false, done = false, error = null, size = 0, stderrSize = 0;
    const chunks = [];
    const stop = reason => {
      error ||= reason;
      if (!stopped) {stopped = true; try {child?.kill();} catch { /* Keep the close fence. */ }}
    };
    const abort = () => stop(cancelled());
    try {child = spawnProcess(executable, ['x', '-so', '-spd', '--', archivePath, member],
      {cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});}
    catch {reject(failure('STILL_CORE_EXTRACT_FAILED', '内置内核解包工具未能启动。')); return;}
    child.once('error', () => {error ||= failure('STILL_CORE_EXTRACT_FAILED', '内置内核解包工具未能完成。');});
    child.once('close', (exitCode, exitSignal) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const bytes = Buffer.concat(chunks, size);
      if (error) reject(error);
      else if (exitCode !== 0 || exitSignal || size !== expectedBytes || hash(bytes) !== expectedSha256) reject(failure('STILL_CORE_EXTRACT_FAILED', '内置内核成员校验失败；没有启动播放。'));
      else resolve(bytes);
    });
    if (!child.stdout?.on || !child.stderr?.on) {stop(failure('STILL_CORE_EXTRACT_FAILED', '解包输出通道无效。'));}
    else {
      child.stdout.on('error', () => stop(failure('STILL_CORE_EXTRACT_FAILED', '内核成员读取中断。')));
      child.stderr.on('error', () => stop(failure('STILL_CORE_EXTRACT_FAILED', '解包诊断通道中断。')));
      child.stdout.on('data', chunk => {
        if (done || error) return;
        if (!Buffer.isBuffer(chunk) || size + chunk.length > expectedBytes) {stop(failure('STILL_CORE_EXTRACT_FAILED', '内核成员输出超过声明上限。')); return;}
        size += chunk.length; chunks.push(chunk);
      });
      child.stderr.on('data', chunk => {stderrSize += chunk.length; if (stderrSize > 65536) stop(failure('STILL_CORE_EXTRACT_FAILED', '解包诊断输出超过上限。'));});
    }
    const limit = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(30000, Math.floor(timeoutMs))) : 20000;
    timer = setTimeout(() => stop(failure('STILL_CORE_EXTRACT_TIMEOUT', '准备内置内核超时；等待本次解包进程退出后可重试。')), limit);
    signal?.addEventListener('abort', abort, {once: true}); if (signal?.aborted) abort();
  });
}
async function extractEntry({appRoot, manifest, entry, signal}) {
  if (!manifest.coreFiles.includes(entry) || entry.relativePath === 'portable_mode_enabled') throw new Error('成员未在固定来源清单内。');
  await verifyExtractionAssets(appRoot, manifest);
  if (signal?.aborted) throw cancelled();
  return captureExtractorEntry({executable: path.join(appRoot, manifest.extractor.executable),
    archivePath: path.join(appRoot, manifest.installer.relativePath), member: entry.relativePath,
    expectedBytes: entry.bytes, expectedSha256: entry.sha256, cwd: path.dirname(path.join(appRoot, manifest.extractor.executable)), signal});
}
async function verifyWindowsSignature(filename) {
  const escaped = filename.replaceAll("'", "''");
  const command = `Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; ` +
    `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}' -ErrorAction Stop; @{status=[string]$s.Status;subject=$s.SignerCertificate.Subject;thumbprint=$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress`;
  const {stdout} = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {windowsHide: true, timeout: 10000});
  return JSON.parse(stdout);
}
function signatureMatches(value, expected) {
  return Boolean(value && value.status === 'Valid' && value.subject === expected.signerSubject &&
    typeof value.thumbprint === 'string' && value.thumbprint.toUpperCase() === expected.signerThumbprint);
}
async function inspectPrivateProcess(executable) {
  const escaped = executable.replaceAll("'", "''");
  const command = `$p=@(Get-CimInstance Win32_Process -Filter "Name='foobar2000.exe'" -ErrorAction Stop | Where-Object { -not $_.ExecutablePath -or $_.ExecutablePath -eq '${escaped}' }); [Console]::Write($p.Count)`;
  const {stdout} = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {windowsHide: true, timeout: 5000});
  if (!/^\d+$/.test(stdout.trim())) throw new Error('无法核验安装后内核是否关闭。');
  return Number(stdout.trim()) > 0;
}
async function choosePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen({host: '127.0.0.1', port: 0, exclusive: true}, resolve);});
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
function createBackendBootstrap({appRoot, dataDir, backendDir, manifestPath = 'manifests/public-backend.json',
  verifySignature = verifyWindowsSignature, isRunning = inspectPrivateProcess, allocatePort = choosePort,
  verifyInstaller, verifyExtractor = verifyExtractionAssets, extractCoreEntry = extractEntry,
  launchInstaller = filename => spawn(filename, [], {cwd: appRoot, shell: false, windowsHide: false, stdio: 'ignore'}), onUpdate = () => {}}) {
  if (canonical(backendDir) !== canonical(path.join(dataDir, 'backend', 'foobar2000'))) throw new Error('准备目标必须位于当前用户的 STILL 数据目录。');
  const statePath = path.join(dataDir, 'backend-setup.json');
  let manifest, receipt = null, busy = false, epoch = 0, closed = false, installerActive = false, inFlight = null, activeController = null;
  let progress = null;
  let state = 'setup-required', code = null;
  const check = token => {if (closed || token !== epoch) throw cancelled();};
  const automatic = () => manifest?.schemaVersion === 2;
  const snapshot = () => ({required: state !== 'ready', ready: state === 'ready', prepared: ['prepared', 'ready'].includes(receipt?.phase), state, busy, installerActive,
    automatic: automatic(), progress: progress && {...progress},
    code, targetDirectory: backendDir, version: '2.26.2', architecture: 'x64'});
  const publish = () => {try {const result = onUpdate(snapshot()); if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});} catch { /* UI observation cannot change setup. */ }};
  async function writeReceipt(value, token) {
    check(token); await noLinks(dataDir); await fs.mkdir(dataDir, {recursive: true}); check(token);
    await noLinks(statePath);
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value), {flag: 'wx'}); check(token); await noLinks(statePath); check(token);
      await fs.rename(temporary, statePath);
      // A submitted atomic receipt write may finish as cancellation arrives.
      // Retain that exact committed ownership before rejecting the old caller.
      receipt = value; check(token);
    }
    finally {await fs.rm(temporary, {force: true}).catch(() => {});}
    receipt = value;
  }
  function run(action) {
    if (busy || closed) throw failure('STILL_SETUP_BUSY', '播放内核准备正在进行。');
    busy = true; code = null; const token = ++epoch, controller = new AbortController(); activeController = controller; publish();
    const work = (async () => {try {await action(token, controller.signal); return snapshot();} catch (error) {
      code = error.code === 'STILL_SETUP_CANCELLED' ? error.code : 'STILL_BACKEND_SETUP_FAILED';
      state = ['prepared', 'ready'].includes(receipt?.phase) ? 'prepared' : automatic() ? 'retry-required' : receipt ? 'waiting-official-install' : 'setup-required';
      throw failure(code, error.code === 'STILL_SETUP_CANCELLED' ? error.message : automatic() ?
        '内置播放内核自动准备未完成；没有启动播放。请重试；若提示目录或文件冲突，请保留已有资料并查看诊断。' :
        '播放内核准备尚未完成。请确认官方 Portable 安装目标正确、安装后的 foobar2000 已正常关闭，再重试检测。');
    } finally {busy = false; if (activeController === controller) activeController = null; publish();}})();
    inFlight = work; return work.finally(() => {if (inFlight === work) inFlight = null;});
  }
  async function assertTarget(token) {
    check(token); await noLinks(backendDir);
    if (JSON.stringify(await directoryIdentity(backendDir)) !== JSON.stringify(receipt.targetIdentity)) throw new Error('本次生成的目标目录已被替换。');
    check(token);
  }
  async function verifyCore(token) {
    await assertTarget(token);
    if (await isRunning(path.join(backendDir, 'foobar2000.exe'))) throw new Error('安装后的播放程序仍在运行。');
    await assertTarget(token);
    for (const row of manifest.coreFiles) {
      const bytes = await checkedBytes(backendDir, row.relativePath, row); check(token);
      if ((row.relativePath === 'foobar2000.exe' || /^components\/.*\.dll$/i.test(row.relativePath)) && !x64(bytes)) throw new Error('官方内核架构不是 x64。');
    }
    await assertPublicBackendCode(backendDir, expectedFiles()); check(token);
    await verifyComponentNamespace(token);
    await assertTarget(token);
  }
  const expectedFiles = () => [...manifest.coreFiles.map(row => ({...row, mutable: false})), ...manifest.components.map(row =>
    ({relativePath: row.targetPath, bytes: row.bytes, sha256: row.sha256, mutable: false}))];
  async function verifyInstallerSource(token) {
    const installer = path.join(appRoot, manifest.installer.relativePath);
    if (verifyInstaller) {await verifyInstaller(installer, manifest.installer); check(token);}
    else {
      await checkedBytes(appRoot, manifest.installer.relativePath, manifest.installer); check(token);
      const signature = await verifySignature(installer); check(token);
      if (!signatureMatches(signature, manifest.installer)) throw new Error('官方安装器签名不符。');
      await checkedBytes(appRoot, manifest.installer.relativePath, manifest.installer); check(token);
    }
    return installer;
  }
  async function ensureTarget(token) {
    await noLinks(backendDir); check(token);
    if (!receipt) {
      if (await fs.lstat(backendDir).catch(error => {if (error.code === 'ENOENT') return null; throw error;})) throw new Error('目标不是本次生成的新空目录。');
      await fs.mkdir(path.dirname(backendDir), {recursive: true}); check(token); await noLinks(backendDir); check(token);
      const transactionId = randomUUID(), staging = path.join(path.dirname(backendDir), `.still-new-target-${transactionId}`);
      await noLinks(staging); check(token); await fs.mkdir(staging); check(token);
      const targetIdentity = await directoryIdentity(staging); check(token);
      await writeReceipt({schemaVersion: 1, transactionId, phase: 'creating-target',
        backendId: null, manifestSha256: null, targetIdentity}, token);
    }
    if (receipt.phase === 'creating-target') {
      state = 'creating-target'; publish(); check(token);
      const staging = path.join(path.dirname(backendDir), `.still-new-target-${receipt.transactionId}`);
      await noLinks(staging); await noLinks(backendDir); check(token);
      const target = await fs.lstat(backendDir).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
      if (!target) {
        if (JSON.stringify(await directoryIdentity(staging)) !== JSON.stringify(receipt.targetIdentity) || (await fs.readdir(staging)).length) throw new Error('新目标暂存目录已改变。');
        const appeared = await fs.lstat(backendDir).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
        if (appeared) throw new Error('目标在准备期间出现；没有覆盖该目录。');
        check(token); await fs.rename(staging, backendDir); check(token);
      }
      if (JSON.stringify(await directoryIdentity(backendDir)) !== JSON.stringify(receipt.targetIdentity)) throw new Error('新目标提交不属于本次准备。');
      check(token); state = 'target-created'; publish(); check(token);
      await writeReceipt({...receipt, phase: automatic() ? 'extracting' : 'waiting-official-install'}, token);
    }
    if (JSON.stringify(await directoryIdentity(backendDir)) !== JSON.stringify(receipt.targetIdentity)) throw new Error('准备目标目录已改变。');
    check(token);
  }
  async function deployCore(token, signal) {
    state = 'verifying-source'; progress = {completed: 0, total: manifest.coreFiles.length}; publish();
    await verifyExtractor(appRoot, manifest); check(token);
    await ensureTarget(token);
    if (await isRunning(path.join(backendDir, 'foobar2000.exe'))) throw new Error('已有程序仍在使用准备目标；没有接管或终止它。');
    check(token); await assertPublicBackendCode(backendDir, expectedFiles()); check(token); await verifyComponentNamespace(token);
    const entries = [];
    state = 'extracting-core'; publish();
    // Capture and verify every approved member before publishing any core byte.
    for (const row of manifest.coreFiles) {
      check(token);
      const bytes = row.relativePath === 'portable_mode_enabled' ? Buffer.alloc(0) :
        await extractCoreEntry({appRoot, manifest, entry: row, signal});
      check(token);
      if (!Buffer.isBuffer(bytes) || bytes.length !== row.bytes || hash(bytes) !== row.sha256 ||
          (row.relativePath === 'foobar2000.exe' || /^components\/.*\.dll$/i.test(row.relativePath)) && !x64(bytes)) throw new Error('内核成员未通过固定校验。');
      entries.push({row, bytes}); progress = {completed: entries.length, total: manifest.coreFiles.length}; publish();
    }
    check(token); await noLinks(backendDir);
    if (JSON.stringify(await directoryIdentity(backendDir)) !== JSON.stringify(receipt.targetIdentity) ||
        await isRunning(path.join(backendDir, 'foobar2000.exe'))) throw new Error('提交前目标被替换或正在运行。');
    check(token); await assertPublicBackendCode(backendDir, expectedFiles()); check(token); state = 'committing-core'; publish();
    for (const {row, bytes} of entries) {
      await assertTarget(token);
      const destination = path.join(backendDir, row.relativePath); await noLinks(destination); check(token);
      await fs.mkdir(path.dirname(destination), {recursive: true}); check(token); await noLinks(destination); check(token);
      const existing = await fs.lstat(destination).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
      await assertTarget(token);
      if (existing) await checkedBytes(backendDir, row.relativePath, row);
      else await fs.writeFile(destination, bytes, {flag: 'wx'});
      check(token);
    }
    await verifyCore(token); state = 'core-prepared'; publish();
  }
  async function verifyComponentNamespace(token) {
    const prefix = 'profile/user-components-x64', expected = new Map(manifest.components.map(row => [row.targetPath.toLowerCase(), row]));
    const directories = new Set([prefix]);
    for (const row of manifest.components) {
      let parent = path.posix.dirname(row.targetPath);
      while (parent.startsWith(`${prefix}/`)) {directories.add(parent.toLowerCase()); parent = path.posix.dirname(parent);}
    }
    let count = 0; const seen = new Set();
    async function walk(relative) {
      const target = path.join(backendDir, relative); await noLinks(target); check(token);
      const entries = await fs.readdir(target, {withFileTypes: true}).catch(error => {if (error.code === 'ENOENT') return []; throw error;});
      for (const entry of entries) {
        if (++count > 250) throw new Error('组件目录超过准备上限。');
        const child = `${relative}/${entry.name}`, key = child.toLowerCase();
        if (seen.has(key) || entry.isSymbolicLink()) throw new Error('组件目录包含链接或重复路径。');
        seen.add(key);
        if (entry.isDirectory() && directories.has(key)) await walk(child);
        else if (entry.isFile() && expected.has(key)) await checkedBytes(backendDir, child, expected.get(key));
        else throw new Error('发现来源清单之外的组件；没有载入或改动它。');
        check(token);
      }
    }
    await walk(prefix);
    const legacy = path.join(backendDir, 'profile/user-components'); await noLinks(legacy); check(token);
    if ((await fs.readdir(legacy).catch(error => {if (error.code === 'ENOENT') return []; throw error;})).length) throw new Error('不能导入其他组件目录。');
  }
  return {
    getStatus: snapshot,
    getExpectedFiles: () => expectedFiles(),
    async initialize() {
      manifest = validateBootstrapManifest(JSON.parse((await checkedBytes(appRoot, manifestPath)).toString('utf8')));
      await noLinks(statePath);
      try {
        const bytes = await checkedBytes(dataDir, 'backend-setup.json');
        if (bytes.length > 16384) throw new Error('准备记录过大。');
        receipt = JSON.parse(bytes.toString('utf8'));
      } catch (error) {if (error.code !== 'ENOENT') throw error;}
      if (receipt) {
        if (!exact(receipt, ['schemaVersion', 'transactionId', 'phase', 'backendId', 'manifestSha256', 'targetIdentity']) || receipt.schemaVersion !== 1 ||
            !/^[a-f0-9-]{36}$/.test(receipt.transactionId) || !['creating-target', 'waiting-official-install', 'extracting', 'preparing', 'prepared', 'ready'].includes(receipt.phase) ||
            receipt.backendId !== null && !/^[a-f0-9-]{36}$/.test(receipt.backendId) ||
            receipt.manifestSha256 !== null && !/^[a-f0-9]{64}$/.test(receipt.manifestSha256) ||
            !exact(receipt.targetIdentity, ['dev', 'ino', 'birthtimeNs']) || !Object.values(receipt.targetIdentity).every(value => typeof value === 'string' && /^\d{1,30}$/.test(value))) throw new Error('播放内核准备记录无效。');
        state = ['prepared', 'ready'].includes(receipt.phase) ? 'prepared' : automatic() ? 'retry-required' : 'waiting-official-install';
        if (state === 'prepared') {
          await noLinks(backendDir);
          if (JSON.stringify(await directoryIdentity(backendDir)) !== JSON.stringify(receipt.targetIdentity)) throw new Error('已准备的目标目录被替换。');
          const bytes = await checkedBytes(backendDir, 'backend-manifest.json');
          const local = JSON.parse(bytes);
          const expected = expectedFiles();
          if (hash(bytes) !== receipt.manifestSha256 || local.backendId !== receipt.backendId ||
              JSON.stringify(local.files) !== JSON.stringify(expected)) throw new Error('准备完成记录与官方文件清单不符。');
          await assertPublicBackendCode(backendDir, expected);
          await verifyComponentNamespace(epoch);
        }
      }
      return snapshot();
    },
    begin() {return run(async (token, signal) => {
      if (!manifest) throw new Error('来源尚未验证。');
      if (snapshot().prepared) return snapshot();
      const installer = await verifyInstallerSource(token);
      if (automatic()) {await deployCore(token, signal); return snapshot();}
      if (installerActive) throw new Error('官方安装器仍在运行。');
      await ensureTarget(token);
      const child = launchInstaller(installer);
      if (!child?.once) throw new Error('未能打开官方安装器。');
      // Spawn can return no PID and emit error on the next turn. Always install
      // its observers before rejecting; do not turn a denied launch into a fatal
      // unhandled event or try another process/installer.
      const ended = () => {installerActive = false; publish();}; child.once('exit', ended); child.once('error', ended);
      if (!Number.isInteger(child.pid) || child.pid < 1) throw new Error('未能打开官方安装器。');
      installerActive = true; state = 'waiting-official-install'; child.unref?.();
      return snapshot();
    });},
    complete({musicDirs = []} = {}) {return run(async token => {
      if (!manifest || !receipt) throw new Error('请先打开官方安装向导。');
      if (snapshot().prepared) return snapshot();
      if (installerActive) throw new Error('请先完成并关闭官方安装器。');
      state = 'validating-installation'; publish(); await verifyCore(token);
      const entries = [];
      for (const row of manifest.components) {
        const bytes = await checkedBytes(appRoot, row.sourcePath, row); check(token);
        if (/\.dll$/i.test(row.targetPath) && !x64(bytes)) throw new Error('组件架构不是 x64。');
        entries.push({row, bytes});
      }
      state = 'preparing-profile'; publish();
      const stage = path.join(path.dirname(backendDir), `.still-components-${receipt.transactionId}`);
      await noLinks(stage); check(token); await fs.mkdir(stage, {recursive: true});
      for (const {row, bytes} of entries) {
        const target = path.join(stage, row.targetPath); check(token); await noLinks(target);
        await fs.mkdir(path.dirname(target), {recursive: true}); check(token);
        // A retained partial stage is reusable only when its bytes match.
        const existing = await fs.lstat(target).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
        if (existing) await checkedBytes(stage, row.targetPath, row);
        else await fs.writeFile(target, bytes, {flag: 'wx'});
      }
      await verifyCore(token);
      const directories = [...new Set(entries.map(({row}) => row.targetPath.split('/').slice(0, 3).join('/')))];
      for (const relative of directories) {
        await assertTarget(token); const destination = path.join(backendDir, relative); await noLinks(destination);
        const existing = await fs.lstat(destination).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
        if (existing) {
          for (const {row} of entries.filter(entry => entry.row.targetPath.startsWith(`${relative}/`))) await checkedBytes(backendDir, row.targetPath, row);
        } else {
          await fs.mkdir(path.dirname(destination), {recursive: true}); check(token); await noLinks(destination); check(token);
          await assertTarget(token);
          await fs.rename(path.join(stage, relative), destination);
        }
      }
      await verifyComponentNamespace(token);
      const roots = [...new Set(musicDirs.map(value => {
        if (typeof value !== 'string' || !path.win32.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('音乐目录未经核验。');
        return path.win32.normalize(value);
      }))];
      if (!roots.length) {
        const empty = path.join(dataDir, 'empty-music'); await noLinks(empty); check(token); await fs.mkdir(empty, {recursive: true}); roots.push(empty);
      }
      let configuration, backendId, manifestBytes;
      if (receipt.phase === 'preparing') {
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt.backendId || '')) throw new Error('未完成准备的后台标识无效。');
        const named = `backend-manifest-${receipt.backendId}.json`;
        const anchored = await fs.lstat(path.join(stage, named)).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
        // Legacy fixed-name files are readable only when an existing preparing
        // receipt already anchors their ID/hash. Unanchored leftovers are never
        // used as configuration or overwritten by a subsequent attempt.
        manifestBytes = await checkedBytes(stage, anchored ? named : 'backend-manifest.json'); check(token);
        if (hash(manifestBytes) !== receipt.manifestSha256) throw new Error('未完成准备记录不一致。');
        const saved = JSON.parse(manifestBytes); configuration = saved.configuration; backendId = saved.backendId;
        if (backendId !== receipt.backendId || !exact(configuration, ['port', 'allowRemote', 'musicDirs', 'permissions']) || configuration.allowRemote !== false ||
            !Number.isInteger(configuration.port) || configuration.port < 1024 || configuration.port > 65535 || configuration.port === 8880 ||
            JSON.stringify(configuration.musicDirs) !== JSON.stringify(roots) ||
            !exact(configuration.permissions, ['changePlaylists', 'changeOutput', 'changeClientConfig']) ||
            configuration.permissions.changePlaylists !== true || configuration.permissions.changeOutput !== true ||
            configuration.permissions.changeClientConfig !== false) throw new Error('未完成准备的目录、端口或权限不一致。');
      } else {
        const port = await allocatePort(); check(token);
        if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8880) throw new Error('未能分配安全的独立端口。');
        configuration = {port, allowRemote: false, musicDirs: roots, permissions: {changePlaylists: true, changeOutput: true, changeClientConfig: false}};
        backendId = randomUUID();
      }
      const configRelative = 'profile/beefweb/config.json';
      const localManifest = {schemaVersion: 1, privateUseOnly: true, backendId,
        executable: 'foobar2000.exe', configuration,
        provenance: {kind: 'official-installer-local', version: manifest.foobarVersion, architecture: 'x64', installerSha256: manifest.installer.sha256,
          ...(automatic() ? {deployment: 'extract-original-installer'} : {})},
        files: [...manifest.coreFiles.map(row => ({...row, mutable: false})), ...manifest.components.map(row =>
          ({relativePath: row.targetPath, bytes: row.bytes, sha256: row.sha256, mutable: false}))]};
      const expectedManifest = Buffer.from(JSON.stringify(localManifest, null, 2));
      if (manifestBytes && !manifestBytes.equals(expectedManifest)) throw new Error('未完成准备的文件清单不一致。');
      manifestBytes = expectedManifest;
      if (receipt.phase !== 'preparing') {
        const pending = path.join(stage, `backend-manifest-${backendId}.json`);
        await noLinks(pending); check(token);
        await fs.writeFile(pending, manifestBytes, {flag: 'wx'}); check(token);
        await writeReceipt({...receipt, phase: 'preparing', backendId, manifestSha256: hash(manifestBytes)}, token);
      }
      for (const [relative, bytes] of [[configRelative, Buffer.from(JSON.stringify(configuration, null, 2))], ['backend-manifest.json', manifestBytes]]) {
        await assertTarget(token);
        const target = path.join(backendDir, relative); await noLinks(target); check(token);
        await fs.mkdir(path.dirname(target), {recursive: true}); check(token);
        const existing = await fs.lstat(target).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
        await assertTarget(token);
        if (existing) {
          if (!(await checkedBytes(backendDir, relative)).equals(bytes)) throw new Error('已有配置或清单未被覆盖。');
        } else await fs.writeFile(target, bytes, {flag: 'wx'});
        check(token);
      }
      await writeReceipt({...receipt, phase: 'prepared', backendId, manifestSha256: hash(manifestBytes)}, token);
      state = 'prepared'; return snapshot();
    });},
    markReady(session, info) {
      if (closed || !snapshot().prepared || !isVerifiedBackendSession(session, {foobarDir: backendDir, baseUrl: info?.baseUrl}) ||
          info?.available !== true || info.owned !== true || info.pid !== session.pid || receipt.backendId !== session.backendId) {
        throw new Error('首启尚缺同一 owned Job 会话与真实连接证明。');
      }
      state = 'ready'; code = null; publish(); return snapshot();
    },
    cancel() {epoch++; activeController?.abort(); if (!busy && state !== 'ready') state = snapshot().prepared ? 'prepared' : automatic() ? 'retry-required' : receipt ? 'waiting-official-install' : 'setup-required'; publish(); return snapshot();},
    close() {closed = true; epoch++; activeController?.abort(); return inFlight?.catch(() => {});}
  };
}
module.exports = {createBackendBootstrap, validateBootstrapManifest, relativeFile, checkedBytes, x64, verifyWindowsSignature, signatureMatches,
  verifyExtractionAssets, assertExtractorNamespace, extractEntry, captureExtractorEntry};
