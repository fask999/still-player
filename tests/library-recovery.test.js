'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createLibraryService } = require('../src/main/library');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(__dirname, '.tmp-library-recovery-'));
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir);
  const services = [];
  t.after(async () => {
    for (const service of services) await service.close();
    assert.equal(path.dirname(root), path.resolve(__dirname));
    assert.ok(path.basename(root).startsWith('.tmp-library-recovery-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, databasePath: path.join(dataDir, 'library.json'), create(options = {}) { const service = createLibraryService({ dataDir, ...options }); services.push(service); return service; } };
}

function failure(message) { return Object.assign(new Error(message), { code: 'EACCES' }); }

function injectedIO({ openFailure, handleFailure, renameFailure, readFailure, mkdirFailure } = {}) {
  return {
    ...fs,
    async open(target, mode) {
      if (openFailure?.(target, mode)) throw failure('Injected exclusive-open failure');
      const handle = await fs.open(target, mode);
      return new Proxy(handle, { get(object, key) {
        const value = Reflect.get(object, key, object);
        if (typeof value !== 'function') return value;
        return async (...args) => {
          if (key === 'readFile' && readFailure?.(target)) throw failure('Injected read failure');
          if (handleFailure?.(target, key, mode)) throw failure(`Injected ${String(key)} failure`);
          return value.apply(object, args);
        };
      } });
    },
    async rename(source, target) { if (renameFailure?.(source, target)) throw failure('Injected rename failure'); return fs.rename(source, target); },
    async mkdir(target, options) { if (mkdirFailure?.(target)) throw failure('Injected mkdir failure'); return fs.mkdir(target, options); },
  };
}

for (const [name, original] of [
  ['invalid JSON including non-UTF8 bytes', Buffer.from([0xff, 0x00, 0x7b, 0x62])],
  ['invalid top level', Buffer.from('null')],
  ['invalid tracks', Buffer.from('{"tracks":{},"playlists":[]}')],
  ['invalid folders', Buffer.from('{"tracks":[],"playlists":[],"folders":{}}')],
  ['unsupported version', Buffer.from('{"version":3,"tracks":[],"playlists":[]}')],
  ['invalid revision', Buffer.from('{"revision":-1,"tracks":[],"playlists":[]}')],
  ['malformed playlist entry', Buffer.from('{"tracks":[],"playlists":[null]}')],
  ['metadata normalization failure', Buffer.from(JSON.stringify({ tracks: [{ path: path.resolve(__dirname, 'synthetic.wav'), title: [{ toString: null, valueOf: null }] }], playlists: [] }))],
]) {
  test(`recovery preserves complete bytes for ${name}`, async t => {
    const { create, databasePath, dataDir } = await fixture(t);
    await fs.writeFile(databasePath, original);
    const service = create();
    const snapshot = await service.initialize();
    assert.equal(snapshot.status.status, 'recovered');
    assert.equal(snapshot.status.readOnly, false);
    assert.match(path.basename(snapshot.status.backupPath), /^library-corrupt-\d{8}T\d{9}Z-[a-f0-9-]{36}\.json$/);
    assert.deepEqual(await fs.readFile(snapshot.status.backupPath), original);
    assert.deepEqual(JSON.parse(await fs.readFile(databasePath, 'utf8')).tracks, []);
    assert.equal((await fs.readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
    await service.createPlaylist('Recovered edit');
    assert.equal(service.list().playlists[0].name, 'Recovered edit');
  });
}

for (const stage of ['backup', 'replace']) {
  test(`a substituted ${stage} temporary inode cannot be committed`, async t => {
    const { create, databasePath } = await fixture(t);
    const original = Buffer.from('{ original invalid JSON');
    await fs.writeFile(databasePath, original);
    let substituted = false;
    const io = { ...fs, async open(target, mode) {
      const handle = await fs.open(target, mode);
      const matches = stage === 'backup' ? path.basename(target).startsWith('library-corrupt-') : path.basename(target).startsWith('library.json.');
      if (mode !== 'wx' || !matches) return handle;
      return new Proxy(handle, { get(object, key) {
        if (key === 'close') return async () => {
          await object.close();
          if (substituted) return;
          substituted = true;
          const bytes = await fs.readFile(target);
          await fs.rename(target, `${target}.held`);
          // Identical bytes still must not hide an inode replacement.
          await fs.writeFile(target, bytes, { flag: 'wx' });
        };
        const value = Reflect.get(object, key, object);
        return typeof value === 'function' ? value.bind(object) : value;
      } });
    } };
    const snapshot = await create({ fileSystem: io }).initialize();
    assert.equal(substituted, true);
    assert.equal(snapshot.status.readOnly, true);
    assert.deepEqual(await fs.readFile(databasePath), original);
  });
}

for (const stage of ['backup-open', 'backup-writeFile', 'backup-sync', 'backup-rename', 'replace-open', 'replace-writeFile', 'replace-sync', 'replace-rename']) {
  test(`recovery ${stage} failure retains the bad original and rejects later writes`, async t => {
    const { create, databasePath, dataDir } = await fixture(t);
    const original = Buffer.from('{ broken original \u0000\ufffd');
    await fs.writeFile(databasePath, original);
    const backup = target => path.basename(target).startsWith('library-corrupt-');
    const replace = target => path.basename(target).startsWith('library.json.');
    const io = injectedIO({
      openFailure: (target, mode) => mode === 'wx' && ((stage === 'backup-open' && backup(target)) || (stage === 'replace-open' && replace(target))),
      handleFailure: (target, method) => stage === `backup-${String(method)}` ? backup(target) : stage === `replace-${String(method)}` && replace(target),
      renameFailure: (_source, target) => (stage === 'backup-rename' && backup(target)) || (stage === 'replace-rename' && target === databasePath),
    });
    const service = create({ fileSystem: io });
    const snapshot = await service.initialize();
    assert.equal(snapshot.status.status, 'read-only');
    assert.equal(service.getStatus().readOnly, true);
    assert.deepEqual(snapshot.tracks, []);
    assert.deepEqual(await fs.readFile(databasePath), original);
    await assert.rejects(service.createPlaylist('Cannot save'), /read-only/);
    assert.equal((await fs.readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
    if (stage.startsWith('replace-')) assert.deepEqual(await fs.readFile(snapshot.status.backupPath), original);
  });
}

test('ordinary read and covers-directory failures initialize safely without replacing the original', async t => {
  for (const stage of ['read', 'mkdir']) {
    const { create, databasePath } = await fixture(t);
    const original = Buffer.from('{"tracks":[],"playlists":[]}');
    await fs.writeFile(databasePath, original);
    const service = create({ fileSystem: injectedIO({ readFailure: target => stage === 'read' && target === databasePath, mkdirFailure: target => stage === 'mkdir' && path.basename(target) === 'covers' }) });
    assert.equal((await service.initialize()).status.readOnly, true);
    assert.deepEqual(await fs.readFile(databasePath), original);
    await assert.rejects(service.createPlaylist('No save'), /read-only/);
  }
});

test('explicit reset of a valid library backs up first and keeps every audio file', async t => {
  const { create, root, databasePath } = await fixture(t);
  const file = path.join(root, 'untouched.wav');
  const audio = Buffer.from('synthetic audio bytes');
  await fs.writeFile(file, audio);
  const original = Buffer.from(JSON.stringify({ tracks: [{ path: file }], playlists: [{ id: 'p', name: 'Saved', trackIds: [] }], revision: 7 }));
  await fs.writeFile(databasePath, original);
  const service = create();
  const snapshot = await service.initialize({ reset: true });
  assert.equal(snapshot.revision, 8);
  assert.equal(snapshot.status.recovered, true);
  assert.deepEqual(snapshot.tracks, []);
  assert.deepEqual(await fs.readFile(snapshot.status.backupPath), original);
  assert.deepEqual(await fs.readFile(file), audio);
  await service.createPlaylist('New list');
  const saved = await fs.readFile(databasePath);
  const reset = await service.reset();
  assert.deepEqual(await fs.readFile(reset.status.backupPath), saved);
  assert.deepEqual(reset.playlists, []);
});

test('reset backup failure never replaces even a valid library', async t => {
  const { create, databasePath } = await fixture(t);
  const original = Buffer.from('{"tracks":[],"playlists":[]}');
  await fs.writeFile(databasePath, original);
  const service = create({ fileSystem: injectedIO({ renameFailure: (_source, target) => path.basename(target).startsWith('library-reset-') }) });
  assert.equal((await service.initialize({ reset: true })).status.readOnly, true);
  assert.deepEqual(await fs.readFile(databasePath), original);
});

test('database hardlinks are detached by atomic replacement while directory links are refused', async t => {
  const { create, root, databasePath } = await fixture(t);
  const original = Buffer.from('{ broken');
  const external = path.join(root, 'external.json');
  await fs.writeFile(external, original);
  await fs.link(external, databasePath);
  assert.equal((await create().initialize()).status.status, 'recovered');
  assert.deepEqual(await fs.readFile(external), original);
  assert.equal((await fs.lstat(databasePath)).nlink, 1);
  assert.equal((await fs.lstat(external)).nlink, 1);
  await fs.unlink(databasePath);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  const linkedDataDir = path.join(root, 'linked-data');
  try { await fs.symlink(outside, linkedDataDir, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`Link creation unavailable: ${error.code}`); throw error; }
  assert.equal((await create({ dataDir: linkedDataDir }).initialize()).status.readOnly, true);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('backup retention only removes managed regular old backups after the newest backup is verified', async t => {
  const { create, databasePath, dataDir } = await fixture(t);
  const preserved = path.join(dataDir, 'library-corrupt-user-kept.json');
  await fs.writeFile(preserved, 'user retained');
  const service = create({ backupLimit: 2 });
  await fs.writeFile(databasePath, '{ broken');
  await service.initialize();
  for (let i = 0; i < 4; i++) await service.reset();
  const backups = (await fs.readdir(dataDir)).filter(name => /^library-(?:corrupt|reset)-\d/.test(name));
  assert.equal(backups.length, 2);
  assert.equal(await fs.readFile(preserved, 'utf8'), 'user retained');
  assert.ok(backups.includes(path.basename(service.getStatus().backupPath)));
});

test('same-byte external database inode replacement is refused before a later commit', async t => {
  const { create, databasePath } = await fixture(t);
  const notices = [];
  const service = create({ returnDeltas: true, onDelta: delta => notices.push(delta) });
  await service.createPlaylist('Saved');
  const before = service.list();
  const original = await fs.readFile(databasePath);
  await fs.rename(databasePath, `${databasePath}.external-held`);
  await fs.writeFile(databasePath, original, { flag: 'wx' });
  await assert.rejects(service.createPlaylist('Do not overwrite external change'), /changed outside this service/);
  assert.deepEqual(await fs.readFile(databasePath), original);
  assert.deepEqual(service.list().playlists, before.playlists);
  assert.equal(notices.at(-1).revision, before.revision);
  assert.equal(notices.at(-1).baseRevision, before.revision);
  assert.equal(notices.at(-1).status.readOnly, true);
});

test('a service closed before initialization cannot start recovery or create data directories', async t => {
  const { root, create } = await fixture(t);
  const dataDir = path.join(root, 'not-created');
  const service = create({ dataDir });
  await service.close();
  await assert.rejects(service.initialize({ reset: true }), /closed/);
  await assert.rejects(service.collectCovers(), /closed/);
  await assert.rejects(fs.access(dataDir), { code: 'ENOENT' });
});

test('reset with no original database does not prune existing recovery copies', async t => {
  const { create, dataDir } = await fixture(t);
  const backups = [
    'library-corrupt-20260101T000000000Z-00000000-0000-4000-8000-000000000001.json',
    'library-reset-20260102T000000000Z-00000000-0000-4000-8000-000000000002.json',
  ];
  for (const name of backups) await fs.writeFile(path.join(dataDir, name), `preserved ${name}`);
  await create({ backupLimit: 1 }).initialize({ reset: true });
  for (const name of backups) assert.equal(await fs.readFile(path.join(dataDir, name), 'utf8'), `preserved ${name}`);
});

for (const configuredLimit of [undefined, 2]) {
  test(`repeated startup replacement failures retain at most ${configuredLimit || 5} complete backups`, async t => {
    const { create, databasePath, dataDir } = await fixture(t);
    const original = Buffer.from([0xff, 0, 0x7b, 0x62, 0x61, 0x64]);
    await fs.writeFile(databasePath, original);
    const limit = configuredLimit || 5;
    const io = injectedIO({ renameFailure: (_source, target) => target === databasePath });
    for (let attempt = 0; attempt < limit + 3; attempt++) {
      const service = create({ fileSystem: io, ...(configuredLimit ? { backupLimit: configuredLimit } : {}) });
      const snapshot = await service.initialize();
      assert.equal(snapshot.status.readOnly, true);
      assert.deepEqual(await fs.readFile(databasePath), original);
      assert.deepEqual(await fs.readFile(snapshot.status.backupPath), original);
      const latestStat = await fs.lstat(snapshot.status.backupPath);
      assert.equal(latestStat.isSymbolicLink(), false);
      assert.equal(latestStat.isFile(), true);
      assert.equal(latestStat.nlink, 1);
      const backups = (await fs.readdir(dataDir)).filter(name => /^library-corrupt-\d/.test(name));
      assert.ok(backups.length <= limit, `attempt ${attempt + 1} retained ${backups.length} backups`);
      assert.ok(backups.includes(path.basename(snapshot.status.backupPath)));
      await service.close();
    }
  });
}

test('repeated explicit reset replacement failures also limit verified valid-library copies', async t => {
  const { create, databasePath, dataDir } = await fixture(t);
  const original = Buffer.from('{"version":2,"tracks":[],"playlists":[],"revision":8}');
  await fs.writeFile(databasePath, original);
  const io = injectedIO({ renameFailure: (_source, target) => target === databasePath });
  for (let attempt = 0; attempt < 5; attempt++) {
    const service = create({ fileSystem: io, backupLimit: 2 });
    await service.initialize();
    await assert.rejects(service.reset(), /Injected rename failure/);
    const status = service.getStatus();
    assert.equal(status.readOnly, true);
    assert.deepEqual(await fs.readFile(databasePath), original);
    assert.deepEqual(await fs.readFile(status.backupPath), original);
    assert.ok((await fs.readdir(dataDir)).filter(name => /^library-reset-\d/.test(name)).length <= 2);
    await service.close();
  }
});

test('retention counts the protected newest backup inside N even when old backups have future mtimes', async t => {
  const { create, databasePath, dataDir } = await fixture(t);
  const original = Buffer.from('{ invalid original');
  await fs.writeFile(databasePath, original);
  for (let index = 1; index <= 4; index++) {
    const target = path.join(dataDir, `library-corrupt-20260101T000000000Z-00000000-0000-4000-8000-${String(index).padStart(12, '0')}.json`);
    await fs.writeFile(target, `old copy ${index}`);
    const future = new Date(`2030-01-0${index}T00:00:00.000Z`);
    await fs.utimes(target, future, future);
  }
  const snapshot = await create({ backupLimit: 2, fileSystem: injectedIO({ renameFailure: (_source, target) => target === databasePath }) }).initialize();
  const backups = (await fs.readdir(dataDir)).filter(name => /^library-corrupt-\d/.test(name));
  assert.equal(backups.length, 2);
  assert.ok(backups.includes(path.basename(snapshot.status.backupPath)));
  assert.deepEqual(await fs.readFile(snapshot.status.backupPath), original);
  assert.deepEqual(await fs.readFile(databasePath), original);
});

for (const failReplacement of [false, true]) {
  test(`retention deletion failure remains a warning when replacement ${failReplacement ? 'fails' : 'succeeds'}`, async t => {
    const { create, databasePath, dataDir } = await fixture(t);
    const original = Buffer.from('{ original invalid');
    await fs.writeFile(databasePath, original);
    const oldName = 'library-corrupt-20260101T000000000Z-00000000-0000-4000-8000-000000000001.json';
    await fs.writeFile(path.join(dataDir, oldName), 'old preserved copy');
    const io = {
      ...fs,
      async unlink(target) { if (/^library-corrupt-.*\.json$/.test(path.basename(target))) throw failure('Injected retention delete failure'); return fs.unlink(target); },
      async rename(source, target) { if (failReplacement && target === databasePath) throw failure('Injected replacement failure'); return fs.rename(source, target); },
    };
    const snapshot = await create({ fileSystem: io, backupLimit: 1 }).initialize();
    assert.equal(snapshot.status.readOnly, failReplacement);
    assert.match(snapshot.status.maintenanceError, /Injected retention delete failure/);
    assert.deepEqual(await fs.readFile(snapshot.status.backupPath), original);
    assert.equal(await fs.readFile(path.join(dataDir, oldName), 'utf8'), 'old preserved copy');
    assert.equal((await fs.readdir(dataDir)).filter(name => /^library-corrupt-\d/.test(name)).length, 2, 'failed cleanup is surfaced without a false boundedness claim');
    if (failReplacement) assert.deepEqual(await fs.readFile(databasePath), original);
    else assert.deepEqual(JSON.parse(await fs.readFile(databasePath, 'utf8')).tracks, []);
  });
}

test('a corrupt completed backup is rejected before any older copies are pruned or the original replaced', async t => {
  const { create, databasePath, dataDir } = await fixture(t);
  const original = Buffer.from('{ original invalid');
  await fs.writeFile(databasePath, original);
  const oldName = 'library-corrupt-20260101T000000000Z-00000000-0000-4000-8000-000000000001.json';
  await fs.writeFile(path.join(dataDir, oldName), 'old preserved copy');
  const io = { ...fs, async rename(source, target) {
    await fs.rename(source, target);
    if (/^library-corrupt-.*\.json$/.test(path.basename(target))) await fs.writeFile(target, 'injected corrupted completed backup');
  } };
  const snapshot = await create({ fileSystem: io, backupLimit: 1 }).initialize();
  assert.equal(snapshot.status.readOnly, true);
  assert.match(snapshot.status.message, /complete original library bytes/);
  assert.deepEqual(await fs.readFile(databasePath), original);
  assert.equal(await fs.readFile(path.join(dataDir, oldName), 'utf8'), 'old preserved copy');
});
