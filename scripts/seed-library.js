'use strict';
// One-time import of a captured, real playlist snapshot. The default is read-only.
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {createLibraryService, trackId} = require('../src/main/library');
const hash = value => createHash('sha256').update(value).digest('hex');
async function exists(filename) {return fs.lstat(filename).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;});}
async function planSeed({snapshotPath, dataDir}) {
  snapshotPath = path.resolve(snapshotPath); dataDir = path.resolve(dataDir);
  const bytes = await fs.readFile(snapshotPath), snapshot = JSON.parse(bytes.toString('utf8'));
  if (!snapshot || !Array.isArray(snapshot.playlists) || snapshot.playlists.some(item => !item || !Array.isArray(item.items))) throw new Error('A real foobar playlist snapshot with item arrays is required');
  const playlists = snapshot.playlists.filter(item => item.ownedByStill !== true);
  const identities = new Map();
  for (const playlist of playlists) {
    for (const item of playlist.items) {
      if (typeof item.path !== 'string' || !path.isAbsolute(item.path)) throw new Error('The snapshot contains a non-local or relative item path');
      identities.set(trackId(item.path, item.subsong), item);
    }
  }
  let existingFiles = 0;
  for (const item of identities.values()) if (await fs.stat(item.path).then(value => value.isFile(), () => false)) existingFiles++;
  return {schemaVersion: 1, dryRun: true, snapshotPath, snapshotSha256: hash(bytes), dataDir,
    libraryExists: await exists(path.join(dataDir, 'library.json')), uniqueTracks: identities.size, existingFiles,
    missingFiles: identities.size - existingFiles,
    playlists: playlists.map(item => ({id: String(item.id), name: item.name, occurrences: item.items.length})),
    occurrences: playlists.reduce((sum, item) => sum + item.items.length, 0)};
}
async function seedLibrary(plan) {
  if (plan?.schemaVersion !== 1 || !plan.dataDir || !plan.snapshotPath) throw new Error('Review a seed plan first');
  const fresh = await planSeed(plan);
  if (fresh.snapshotSha256 !== plan.snapshotSha256) throw new Error('The captured snapshot changed after review');
  if (fresh.libraryExists) throw new Error('The target already has a library; it will not be overwritten');
  await fs.mkdir(fresh.dataDir, {recursive: true});
  const real = await fs.realpath(fresh.dataDir);
  if (path.resolve(real).toLowerCase() !== path.resolve(fresh.dataDir).toLowerCase()) throw new Error('The target data directory cannot be a link or junction');
  const lockPath = path.join(fresh.dataDir, '.library-seed.lock');
  const lock = await fs.open(lockPath, 'wx');
  const stage = path.join(fresh.dataDir, `.library-seed-stage-${randomUUID()}`);
  let service;
  try {
    if (await exists(path.join(fresh.dataDir, 'library.json'))) throw new Error('The target library appeared during seed; it will not be overwritten');
    await fs.mkdir(stage);
    service = createLibraryService({dataDir: stage});
    await service.initialize();
    const snapshot = JSON.parse(await fs.readFile(fresh.snapshotPath, 'utf8'));
    const result = await service.importFoobar(snapshot);
    const imported = result.playlists.filter(item => item.source === 'foobar2000');
    if (imported.length !== fresh.playlists.length || imported.reduce((sum, item) => sum + item.trackIds.length, 0) !== fresh.occurrences) throw new Error('Seed verification failed: playlist occurrences were not preserved');
    for (let index = 0; index < imported.length; index++) {
      const original = snapshot.playlists.filter(item => item.ownedByStill !== true)[index];
      const expected = original.items.map(item => trackId(item.path, item.subsong));
      if (JSON.stringify(imported[index].trackIds) !== JSON.stringify(expected)) throw new Error('Seed verification failed: playlist order or duplicate identity changed');
    }
    if (result.tracks.length !== fresh.uniqueTracks) throw new Error('Seed verification failed: unique track identities changed');
    await service.close(); service = null;
    const covers = path.join(fresh.dataDir, 'covers');
    await fs.mkdir(covers, {recursive: true});
    if (path.resolve(await fs.realpath(covers)).toLowerCase() !== path.resolve(covers).toLowerCase()) throw new Error('The cover directory cannot be a link or junction');
    for (const entry of await fs.readdir(path.join(stage, 'covers'), {withFileTypes: true})) {
      if (!entry.isFile() || !/^[a-f0-9]+\.(jpg|png|webp|gif)$/.test(entry.name)) throw new Error('Unexpected seeded cover artifact');
      const source = path.join(stage, 'covers', entry.name), destination = path.join(covers, entry.name);
      try {await fs.copyFile(source, destination, constants.COPYFILE_EXCL);}
      catch (error) {if (error.code !== 'EEXIST' || hash(await fs.readFile(source)) !== hash(await fs.readFile(destination))) throw error;}
    }
    // Same-volume hard-link creation is an atomic, exclusive commit: existing
    // libraries are never replaced, including a concurrent first-run library.
    await fs.link(path.join(stage, 'library.json'), path.join(fresh.dataDir, 'library.json'));
    const report = {...fresh, dryRun: false, completedAt: new Date().toISOString(), stage,
      validTracks: result.tracks.filter(item => item.valid).length, covers: (await fs.readdir(covers)).length};
    await fs.writeFile(path.join(fresh.dataDir, `library-seed-${randomUUID()}.json`), JSON.stringify(report, null, 2), {flag: 'wx'});
    return report;
  } finally {
    await service?.close(); await lock.close(); await fs.unlink(lockPath);
  }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  const value = flag => {const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1];};
  const snapshotPath = value('--snapshot') || path.join(__dirname, 'foobar-evidence', 'library-snapshot.json');
  const dataDir = value('--data-dir');
  if (!dataDir || !path.isAbsolute(dataDir)) {console.error('Choose an explicit absolute --data-dir. The default command only plans.'); process.exitCode = 1;}
  else planSeed({snapshotPath, dataDir}).then(plan => args.includes('--execute') ? seedLibrary(plan) : plan)
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {console.error(error.message); process.exitCode = 1;});
}
module.exports = {planSeed, seedLibrary};
