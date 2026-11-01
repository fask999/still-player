'use strict';
// Private local assembly only. The default command is a read-only manifest.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const ROOT_FILES = Object.freeze(['foobar2000.exe', 'fooHelper.exe', 'portable_mode_enabled',
  'avcodec-fb2k-62.dll', 'avformat-fb2k-62.dll', 'avutil-fb2k-60.dll', 'concrt140.dll',
  'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll',
  'PP-UWP-Interop.dll', 'shared.dll', 'sqlite3.dll', 'vccorlib140.dll', 'vcruntime140.dll',
  'vcruntime140_1.dll', 'vcruntime140_threads.dll', 'zlib1.dll', 'doc/license.html']);
const STANDARD_COMPONENTS = Object.freeze(['foo_dsp_eq', 'foo_dsp_std', 'foo_input_std', 'foo_ui_std', 'foo_unpack']);
const USER_COMPONENTS = Object.freeze(['foo_beefweb', 'foo_dsd_converter', 'foo_dsd_processor',
  'foo_input_dvda', 'foo_input_sacd', 'foo_input_tak', 'foo_input_tta', 'foo_out_asio', 'foo_out_asio+dsd']);
const COMPONENT_SETTINGS = Object.freeze(['foo_dsd_processor', 'foo_input_dvda', 'foo_out_asio+dsd', 'foo_out_asio']);
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
function resolveInside(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Manifest relative path is invalid.');
  const candidate = path.resolve(root, relative);
  if (!within(root, candidate)) throw new Error('Manifest path escapes its root.');
  return candidate;
}
async function regularFile(root, relative) {
  const filename = resolveInside(root, relative);
  let cursor = root;
  for (const segment of relative.split('/')) {
    cursor = path.join(cursor, segment);
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error(`Refusing link or junction: ${cursor}`);
  }
  const real = await fs.realpath(filename), rootReal = await fs.realpath(root);
  if (!within(rootReal, real) || !(await fs.stat(real)).isFile()) throw new Error(`Not an in-root regular file: ${filename}`);
  return filename;
}
function musicDirectories(input) {
  if (!Array.isArray(input) || !input.length) throw new Error('Specify the private backend music directories explicitly.');
  return [...new Map(input.map(value => {
    if (typeof value !== 'string' || !path.win32.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('Music directories must be absolute Windows paths.');
    const normalized = path.win32.normalize(value);
    return [normalized.toLowerCase().replace(/\\+$/, ''), normalized];
  })).values()];
}
async function planBackend({ sourceDir, destinationDir, musicDirs, port = 18880 } = {}) {
  if (!sourceDir || !destinationDir) throw new Error('sourceDir and destinationDir are required.');
  sourceDir = path.resolve(sourceDir); destinationDir = path.resolve(destinationDir);
  if (sourceDir === destinationDir || within(destinationDir, sourceDir)) throw new Error('Destination must not replace or contain the original installation.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8880) throw new Error('Use a dedicated non-original port between 1024 and 65535.');
  const paths = ROOT_FILES.map(relativePath => ({ relativePath, mutable: false, mode: 'copy' }));
  async function allowedTree(relative) {
    const directory = path.join(sourceDir, relative);
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error(`Refusing linked directory: ${relative}`);
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error(`Refusing link: ${relative}/${entry.name}`);
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await allowedTree(child);
      else paths.push({ relativePath: child, mutable: false, mode: 'copy' });
    }
  }
  await allowedTree('runtime');
  for (const name of STANDARD_COMPONENTS) paths.push({ relativePath: `components/${name}.dll`, mutable: false, mode: 'copy' });
  for (const name of USER_COMPONENTS) await allowedTree(`profile/user-components-x64/${name}`);
  for (const name of COMPONENT_SETTINGS) paths.push({ relativePath: `profile/configuration/${name}.dll.cfg`, mutable: true, mode: 'copy' });
  paths.push({ relativePath: 'profile/config.sqlite', mutable: true, mode: 'sqlite-readonly-backup' },
    { relativePath: 'profile/version.txt', mutable: true, mode: 'copy' });
  for (const item of paths) {
    const filename = await regularFile(sourceDir, item.relativePath);
    const before = await fs.stat(filename), data = await fs.readFile(filename), after = await fs.stat(filename);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || data.length !== after.size) throw new Error(`Source changed during dry run: ${item.relativePath}`);
    item.bytes = data.length; item.sha256 = hash(data);
  }
  return { schemaVersion: 1, dryRun: true, privateUseOnly: true, sourceDir, destinationDir,
    executable: 'foobar2000.exe', totalFiles: paths.length, totalBytes: paths.reduce((sum, item) => sum + item.bytes, 0),
    files: paths, configuration: { port, allowRemote: false, musicDirs: musicDirectories(musicDirs),
      permissions: { changePlaylists: true, changeOutput: true, changeClientConfig: false } },
    excluded: ['Still/**', 'Still-backup-*/**', 'profile/playlists-*/**', 'profile/library-*/**',
      'profile/metadb*', 'profile/running', 'profile/beefweb/**', 'profile/eslyric-data/**',
      'profile/user-components-x64/foo_uie_eslyric/**', 'profile/user-components-x64/foo_playcount/**',
      'encoders/**', 'themes/**', 'music/media files', 'shell association tools', 'uninstaller'],
    profileConsistency: 'Copy only while original foobar is closed; SQLite backup uses a read-only source connection. Persisted settings are not a promise of unflushed live preferences.',
    redistribution: 'This assembled backend is for this user on this machine. Only the unmodified official installer is redistributable under the included foobar license.' };
}
async function sourceIsRunning(sourceDir) {
  if (process.platform !== 'win32') return false;
  const escaped = path.join(sourceDir, 'foobar2000.exe').replace(/'/g, "''");
  const command = `$p = @(Get-CimInstance Win32_Process -Filter \"Name='foobar2000.exe'\" -ErrorAction Stop | Where-Object { $_.ExecutablePath -eq '${escaped}' }); [Console]::Write($p.Count)`;
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 5000 });
  if (!/^\d+$/.test(stdout.trim())) throw new Error('Unable to verify whether the original foobar2000 is running.');
  return Number(stdout.trim()) > 0;
}
async function materializeBackend(plan, { privateUse = false, isSourceRunning = sourceIsRunning } = {}) {
  if (!privateUse || plan?.privateUseOnly !== true || plan?.schemaVersion !== 1) throw new Error('Explicit private local assembly is required.');
  // Re-plan rather than trusting caller-supplied arbitrary source files/paths.
  const fresh = await planBackend({ sourceDir: plan.sourceDir, destinationDir: plan.destinationDir,
    musicDirs: plan.configuration.musicDirs, port: plan.configuration.port });
  if (JSON.stringify(fresh.files) !== JSON.stringify(plan.files)) throw new Error('Source manifest changed after review; review a fresh dry run.');
  if (await isSourceRunning(fresh.sourceDir)) throw new Error('Close the original foobar2000 before creating a consistent private profile. No source files were changed.');
  async function absentSqliteAuxiliary() {
    for (const suffix of ['-wal', '-shm']) {
      const filename = path.join(fresh.sourceDir, `profile/config.sqlite${suffix}`);
      if (await fs.lstat(filename).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
        throw new Error(`Source SQLite ${suffix} still exists; require a cleanly stopped source profile. No SQLite connection was opened.`);
      }
    }
  }
  await absentSqliteAuxiliary();
  const target = fresh.destinationDir;
  if (await fs.lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Private backend target already exists; never overwrite its profile.');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const parentReal = await fs.realpath(path.dirname(target));
  if (path.resolve(parentReal).toLowerCase() !== path.resolve(path.dirname(target)).toLowerCase()) throw new Error('Destination parent is a junction or symlink.');
  const stage = path.join(path.dirname(target), `.still-backend-stage-${randomUUID()}`);
  await fs.mkdir(stage);
  // Keep a failed stage for review; no recursive deletion and no hidden retry.
  try {
    const manifestFiles = [];
    let profileSnapshotEvidence = null;
    for (const item of fresh.files) {
      const source = await regularFile(fresh.sourceDir, item.relativePath), destination = resolveInside(stage, item.relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      if (item.mode === 'sqlite-readonly-backup') {
        await absentSqliteAuxiliary();
        const sourceBeforeHash = hash(await fs.readFile(source));
        if (sourceBeforeHash !== item.sha256) throw new Error('Source SQLite changed after the reviewed manifest.');
        const { DatabaseSync, backup } = require('node:sqlite');
        const database = new DatabaseSync(source, { readOnly: true });
        try { await backup(database, destination); } finally { database.close(); }
        const check = new DatabaseSync(destination, { readOnly: true });
        try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('SQLite snapshot integrity_check failed.'); }
        finally { check.close(); }
        const sourceAfterHash = hash(await fs.readFile(source));
        await absentSqliteAuxiliary();
        if (sourceAfterHash !== sourceBeforeHash) throw new Error('Source SQLite changed during the read-only backup.');
        profileSnapshotEvidence = { sourceReadOnly: true, sourceStopped: true, walAbsentBeforeAndAfter: true,
          shmAbsentBeforeAndAfter: true, sourceBeforeHash, sourceAfterHash, destinationIntegrityCheck: 'ok' };
      } else {
        const data = await fs.readFile(source);
        if (hash(data) !== item.sha256) throw new Error(`Source changed during assembly: ${item.relativePath}`);
        await fs.writeFile(destination, data, { flag: 'wx' });
      }
      const written = await fs.readFile(destination);
      manifestFiles.push({ ...item, sourceSha256: item.sha256, bytes: written.length, sha256: hash(written) });
    }
    if (await isSourceRunning(fresh.sourceDir)) throw new Error('Original foobar started during assembly; stage retained and not activated.');
    await absentSqliteAuxiliary();
    for (const item of fresh.files) {
      if (hash(await fs.readFile(await regularFile(fresh.sourceDir, item.relativePath))) !== item.sha256) throw new Error(`Source changed before activation: ${item.relativePath}`);
    }
    const configurationPath = path.join(stage, 'profile', 'beefweb', 'config.json');
    await fs.mkdir(path.dirname(configurationPath), { recursive: true });
    await fs.writeFile(configurationPath, JSON.stringify(fresh.configuration, null, 2), { flag: 'wx' });
    const descriptor = { ...fresh, dryRun: false, backendId: randomUUID(), createdAt: new Date().toISOString(), files: manifestFiles, profileSnapshotEvidence };
    await fs.writeFile(path.join(stage, 'backend-manifest.json'), JSON.stringify(descriptor, null, 2), { flag: 'wx' });
    await fs.rename(stage, target);
    return descriptor;
  } catch (error) { error.message += ` Stage retained at ${stage}.`; throw error; }
}
if (require.main === module) {
  const args = process.argv.slice(2), copy = args.includes('--copy-private');
  const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const dirs = args.flatMap((item, index) => item === '--music-dir' ? [args[index + 1]] : []);
  planBackend({ sourceDir: value('--source') || 'D:\\foobar2000',
    destinationDir: value('--destination') || path.resolve(__dirname, '..', 'backend', 'foobar2000'), musicDirs: dirs,
    port: value('--port') ? Number(value('--port')) : 18880 })
    .then(plan => copy ? materializeBackend(plan, { privateUse: true }) : plan)
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
module.exports = { planBackend, materializeBackend, ROOT_FILES, STANDARD_COMPONENTS, USER_COMPONENTS, COMPONENT_SETTINGS,
  resolveInside, regularFile, musicDirectories, sourceIsRunning };
