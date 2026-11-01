'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const BACKUP_NAME = /^library-(?:corrupt|reset)-\d{8}T\d{9}Z-[a-f0-9-]{36}\.json$/;

function samePath(left, right) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function unsafe(message) {
  const error = new Error(message);
  error.code = 'ERR_LIBRARY_UNSAFE_PATH';
  return error;
}

function createLibraryStorage({ dataDir, fileSystem = fs, backupLimit = 5 }) {
  if (!Number.isSafeInteger(backupLimit) || backupLimit < 1 || backupLimit > 100) throw new TypeError('The library backup limit must be an integer from 1 to 100.');
  const root = path.resolve(dataDir);
  const databasePath = path.join(root, 'library.json');
  const coversDir = path.join(root, 'covers');
  const io = fileSystem;
  let expectedBytes;
  let expectedIdentity;

  function inside(target) {
    const relative = path.relative(root, path.resolve(target));
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw unsafe('The library file must stay inside its data directory.');
    return path.resolve(target);
  }

  async function statOrNull(target) {
    try { return await io.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async function assertDirectories(directory = root, { create = false } = {}) {
    const absolute = path.resolve(directory);
    if (absolute !== root) inside(absolute);
    const parsed = path.parse(absolute);
    let current = parsed.root;
    const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
    for (const segment of segments) {
      current = path.join(current, segment);
      let stat = await statOrNull(current);
      if (!stat && create) {
        try { await io.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        stat = await statOrNull(current);
      }
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe(`The library directory is missing or is a link: ${current}`);
    }
    if (!samePath(await io.realpath(absolute), absolute)) throw unsafe('The library directory resolves through a link.');
  }

  function assertRegular(stat, target, { allowHardlinks = false } = {}) {
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || (!allowHardlinks && stat.nlink !== 1)) throw unsafe(`The library file is not a safe regular file: ${target}`);
  }

  async function readRegular(target, { missing = false, withIdentity = false } = {}) {
    target = inside(target);
    // Seed commits deliberately hard-link the database. Reading and replacing its
    // name atomically never writes any linked inode; images and backups stay stricter.
    const checks = { allowHardlinks: target === databasePath };
    await assertDirectories(path.dirname(target));
    const before = await statOrNull(target);
    if (!before && missing) return null;
    assertRegular(before, target, checks);
    let handle;
    try {
      handle = await io.open(target, 'r');
      const opened = await handle.stat();
      assertRegular(opened, target, checks);
      if (before.dev !== opened.dev || before.ino !== opened.ino) throw unsafe('The library file changed while being opened.');
      const bytes = await handle.readFile();
      const after = await handle.stat();
      assertRegular(after, target, checks);
      const named = await io.lstat(target);
      assertRegular(named, target, checks);
      if (after.dev !== named.dev || after.ino !== named.ino || after.size !== named.size || after.mtimeMs !== named.mtimeMs || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) throw unsafe('The library file changed while being read.');
      return withIdentity ? { bytes, stat: after } : bytes;
    } finally { if (handle) await handle.close(); }
  }

  async function writeAtomic(target, bytes, { replace = false } = {}) {
    target = inside(target);
    await assertDirectories(path.dirname(target));
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle;
    let created = false;
    let createdStat;
    try {
      handle = await io.open(temporary, 'wx');
      created = true;
      createdStat = await handle.stat();
      assertRegular(createdStat, temporary);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await assertDirectories(path.dirname(target));
      const tempStat = await io.lstat(temporary);
      assertRegular(tempStat, temporary);
      if (tempStat.dev !== createdStat.dev || tempStat.ino !== createdStat.ino || tempStat.size !== bytes.length) throw unsafe('The temporary library file was replaced before commit.');
      const written = await readRegular(temporary, { withIdentity: true });
      if (written.stat.dev !== createdStat.dev || written.stat.ino !== createdStat.ino || !written.bytes.equals(bytes)) throw unsafe('The temporary library bytes or identity changed before commit.');
      const existing = await statOrNull(target);
      if (existing) assertRegular(existing, target, { allowHardlinks: replace && target === databasePath });
      if (!replace && existing) throw unsafe('The library backup destination already exists.');
      if (replace) await assertDatabaseUnchanged();
      const finalTemporary = await io.lstat(temporary);
      assertRegular(finalTemporary, temporary);
      if (finalTemporary.dev !== createdStat.dev || finalTemporary.ino !== createdStat.ino || finalTemporary.size !== bytes.length || finalTemporary.mtimeMs !== written.stat.mtimeMs) throw unsafe('The temporary library file changed immediately before commit.');
      await io.rename(temporary, target);
      created = false;
      return tempStat;
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (created) {
        const stat = await statOrNull(temporary).catch(() => null);
        if (stat && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) await io.unlink(temporary).catch(() => {});
      }
    }
  }

  async function readDatabase() {
    await assertDirectories(root, { create: true });
    const current = await readRegular(databasePath, { missing: true, withIdentity: true });
    expectedBytes = current?.bytes ?? null;
    expectedIdentity = current?.stat ?? null;
    return expectedBytes;
  }

  async function assertDatabaseUnchanged() {
    const current = await readRegular(databasePath, { missing: true, withIdentity: true });
    if (expectedBytes === undefined || (expectedBytes === null ? current !== null : !current || !current.bytes.equals(expectedBytes) || current.stat.dev !== expectedIdentity.dev || current.stat.ino !== expectedIdentity.ino)) throw unsafe('The saved library changed outside this service; reload before writing.');
  }

  async function writeDatabase(value) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    const committed = await writeAtomic(databasePath, bytes, { replace: true });
    expectedBytes = bytes;
    expectedIdentity = committed;
  }

  async function backup(bytes, reason) {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
    const target = path.join(root, `library-${reason}-${timestamp}-${crypto.randomUUID()}.json`);
    await writeAtomic(target, bytes);
    await verifyBackup(target, bytes);
    return target;
  }

  async function verifyBackup(target, bytes) {
    if (path.dirname(path.resolve(target)) !== root || !BACKUP_NAME.test(path.basename(target))) throw unsafe('The recovery backup must be a managed file inside the library directory.');
    const saved = await readRegular(target);
    if (!saved.equals(bytes)) throw unsafe('The recovery backup does not contain the complete original library bytes.');
  }

  async function pruneBackups(keepPath, bytes) {
    await assertDirectories();
    await verifyBackup(keepPath, bytes);
    const entries = await io.readdir(root, { withFileTypes: true });
    const backups = [];
    for (const entry of entries) {
      if (!BACKUP_NAME.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
      const target = path.join(root, entry.name);
      const stat = await io.lstat(target);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) backups.push({ target, mtimeMs: stat.mtimeMs });
    }
    backups.sort((a, b) => b.mtimeMs - a.mtimeMs || b.target.localeCompare(a.target));
    const keep = new Set([keepPath, ...backups.filter(item => item.target !== keepPath).slice(0, backupLimit - 1).map(item => item.target)]);
    for (const item of backups) {
      if (keep.has(item.target)) continue;
      await assertDirectories();
      await verifyBackup(keepPath, bytes);
      const stat = await io.lstat(item.target);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) await io.unlink(item.target);
    }
  }

  return { root, databasePath, coversDir, inside, assertDirectories, assertRegular, readRegular, statOrNull, writeAtomic, readDatabase, writeDatabase, assertDatabaseUnchanged, backup, verifyBackup, pruneBackups };
}

module.exports = { createLibraryStorage, BACKUP_NAME };
