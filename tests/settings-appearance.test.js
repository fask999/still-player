'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {DEFAULTS, mergeSettings, createSettingsService} = require('../src/main/settings');

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'still-accent-mode-'));
  t.after(() => fs.rm(dataDir, {recursive: true, force: true}));
  return {dataDir, file: path.join(dataDir, 'settings.json')};
}

test('legacy appearance defaults to color in memory without rewriting stored preferences', async t => {
  const {dataDir, file} = await fixture(t);
  const original = JSON.stringify({appearance: {accentColor: '#123456', localView: 'artists', reducedMotion: true}, lyrics: {fontSize: 41, cacheEnabled: false}});
  await fs.writeFile(file, original);
  const service = createSettingsService({dataDir});
  await service.initialize();
  assert.equal(DEFAULTS.appearance.accentMode, 'color');
  assert.equal(service.get().appearance.accentMode, 'color');
  assert.equal(service.get().appearance.accentColor, '#123456');
  assert.equal(service.get().lyrics.fontSize, 41);
  assert.equal(service.get().lyrics.cacheEnabled, false);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await service.close();
});

test('mode-only patches preserve color, local navigation and all lyric preferences', () => {
  const original = mergeSettings(DEFAULTS, {appearance: {accentColor: '#987654', localView: 'playlists', reducedMotion: true}, lyrics: {fontSize: 44, onlineEnabled: false, cacheEnabled: false}});
  for (const accentMode of ['none', 'color']) {
    const next = mergeSettings(original, {appearance: {accentMode}});
    assert.deepEqual(next.appearance, {...original.appearance, accentMode});
    assert.deepEqual(next.lyrics, original.lyrics);
  }
  for (const accentMode of [null, true, false, 0, '', 'NONE', 'auto', [], {}]) {
    assert.throws(() => mergeSettings(original, {appearance: {accentMode}}), /Invalid setting: appearance.accentMode/);
  }
  assert.throws(() => mergeSettings(original, {appearance: {unknown: true}}), /Unknown setting/);
});

test('atomic mode and color patches persist with queued lyrics and invalid pairs write nothing', async t => {
  const {dataDir, file} = await fixture(t);
  const service = createSettingsService({dataDir}); await service.initialize();
  const patch = {appearance: {accentMode: 'none', accentColor: '#abcdef'}};
  const save = service.update(patch);
  patch.appearance.accentMode = 'color'; patch.appearance.accentColor = '#000000';
  const lyricSave = service.update({lyrics: {fontSize: 43, cacheEnabled: false}});
  assert.equal((await save).appearance.accentMode, 'none'); await lyricSave;
  const committed = service.get(), bytes = await fs.readFile(file, 'utf8');
  assert.equal(committed.appearance.accentColor, '#ABCDEF');
  for (const appearance of [{accentMode: null, accentColor: '#112233'}, {accentMode: 'color', accentColor: 'invalid'}]) {
    await assert.rejects(service.update({appearance}), /Invalid setting/);
    assert.deepEqual(service.get(), committed);
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
  }
  await service.update({appearance: {accentMode: 'color'}});
  const restored = createSettingsService({dataDir}); await restored.initialize();
  assert.deepEqual(restored.get(), {...committed, appearance: {...committed.appearance, accentMode: 'color'}});
  await service.close(); await restored.close();
});

test('disk replacement failure rolls back both appearance fields and queued writes recover without losing lyrics', async t => {
  const {dataDir, file} = await fixture(t);
  const service = createSettingsService({dataDir}); await service.initialize();
  await service.update({lyrics: {fontSize: 39, showTranslation: false}, appearance: {accentColor: '#123456', localView: 'artists'}});
  const committed = service.get();
  await fs.rename(file, `${file}.backup`); await fs.mkdir(file);
  const results = await Promise.allSettled([
    service.update({appearance: {accentMode: 'none', accentColor: '#aabbcc'}}),
    service.update({lyrics: {fontSize: 47}})
  ]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  assert.deepEqual(service.get(), committed);
  assert.equal((await fs.readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
  await fs.rmdir(file); await fs.rename(`${file}.backup`, file);
  await Promise.all([service.update({appearance: {accentMode: 'none', accentColor: '#aabbcc'}}), service.update({lyrics: {translationSize: 25}})]);
  const restored = createSettingsService({dataDir}); await restored.initialize();
  assert.deepEqual(restored.get(), {...committed, appearance: {...committed.appearance, accentMode: 'none', accentColor: '#AABBCC'}, lyrics: {...committed.lyrics, translationSize: 25}});
  await service.close(); await restored.close();
});
