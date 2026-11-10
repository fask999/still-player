'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createLyricsService } = require('../src/main/lyrics');
const { createQqLyricsClient } = require('../src/main/qq-lyrics');
const { createEmbeddedLyricsReader, extractEmbeddedLyrics } = require('../src/main/embedded-lyrics');

const response = value => new Response(JSON.stringify(value));
const encoded = value => Buffer.from(value).toString('base64');
const original = '[offset:100]\n[00:01.100]Synthetic first\n[00:02.100]Synthetic middle\n[00:03.100]Synthetic last';
const translation = '[offset:200]\n[00:03.200]自编末行\n[00:00.200]无匹配行\n[00:01.200]自编首行';
const qqRecord = (mid = 'FixtureMid001', extras = {}) => ({ provider: 'qq', id: `qq:${mid}`, songmid: mid, trackName: 'Synthetic song', artistName: 'Synthetic author', albumName: 'Synthetic album', duration: 10, ...extras });
const lrclibRecord = () => ({ id: 1, trackName: 'Synthetic song', artistName: 'Synthetic author', albumName: 'Synthetic album', duration: 10, syncedLyrics: '[00:01]Synthetic network text' });
function qqSearch(records = [qqRecord()]) { return { code: 0, data: { song: { list: records.map(record => ({ songmid: record.songmid, songname: record.trackName, singer: [{ name: record.artistName }], albumname: record.albumName, interval: record.duration })) } } }; }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, options = {}) {
  const folder = await fs.mkdtemp(path.join(__dirname, '.tmp-lyrics-features-'));
  const tracks = new Map(['a', 'b'].map(id => [id, { id, path: path.join(folder, `${id}.flac`), subsong: 0, title: 'Synthetic song', artist: 'Synthetic author', album: 'Synthetic album', duration: 10 }]));
  const prefs = { lyrics: { onlineEnabled: true, cacheEnabled: true, preferredSource: 'lrclib' } }, calls = [];
  const fallbackClient = options.fallbackClient === null ? null : options.fallbackClient || createQqLyricsClient({ minRequestIntervalMs: 0, timeoutMs: 1000,
    fetchImpl: async input => { const url = new URL(input); calls.push(url); return response(url.pathname.includes('client_search') ? qqSearch() : { code: 0, lyric: encoded(original), trans: encoded(translation) }); } });
  const dataDir = path.join(folder, 'data');
  const service = createLyricsService({ dataDir, getTrack: id => tracks.get(id), getSettings: () => prefs, minRequestIntervalMs: 0, timeoutMs: 1000, maxAttempts: 1,
    fetchImpl: async input => { calls.push(new URL(input)); return response(String(input).includes('/search?') ? [lrclibRecord()] : lrclibRecord()); }, ...options, fallbackClient });
  await service.initialize();
  t.after(async () => { await service.close(); const target = path.resolve(folder); assert.equal(path.dirname(target), __dirname); assert.ok(path.basename(target).startsWith('.tmp-lyrics-features-')); await fs.rm(target, { recursive: true, force: true }); });
  return { folder, tracks, prefs, calls, dataDir, service };
}
function flac(text, { tag = 'LYRICS', pictureBytes = 0 } = {}) {
  const info = Buffer.alloc(34); info.writeUInt16BE(4096, 0); info.writeUInt16BE(4096, 2);
  info.writeBigUInt64BE((44100n << 44n) | (1n << 41n) | (15n << 36n) | 441000n, 10);
  const number = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
  const entries = text === undefined ? [] : [Buffer.from(`${tag}=${text}`)];
  const comments = Buffer.concat([number(7), Buffer.from('fixture'), number(entries.length), ...entries.flatMap(entry => [number(entry.length), entry])]);
  const block = (type, data) => { const header = Buffer.alloc(4); header[0] = type; header.writeUIntBE(data.length, 1, 3); return Buffer.concat([header, data]); };
  return Buffer.concat([Buffer.from('fLaC'), block(0, info), ...(pictureBytes ? [block(6, Buffer.alloc(pictureBytes))] : []), block(0x84, comments)]);
}
function wavUslt(text) {
  const body = Buffer.concat([Buffer.from([3]), Buffer.from('eng\0'), Buffer.from(text)]), frame = Buffer.alloc(10);
  frame.write('USLT'); frame.writeUInt32BE(body.length, 4);
  const payload = Buffer.concat([frame, body]), id3 = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
  for (let index = 0; index < 4; index++) id3[9 - index] = (payload.length >>> (index * 7)) & 0x7F;
  const chunk = (name, value) => { const header = Buffer.alloc(8); header.write(name); header.writeUInt32LE(value.length, 4); return Buffer.concat([header, value, ...(value.length % 2 ? [Buffer.alloc(1)] : [])]); };
  const format = Buffer.alloc(16); format.writeUInt16LE(1, 0); format.writeUInt16LE(1, 2); format.writeUInt32LE(8000, 4); format.writeUInt32LE(16000, 8); format.writeUInt16LE(2, 12); format.writeUInt16LE(16, 14);
  const contents = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', format), chunk('id3 ', Buffer.concat([id3, payload])), chunk('data', Buffer.alloc(16))]), header = Buffer.alloc(8);
  header.write('RIFF'); header.writeUInt32LE(contents.length, 4); return Buffer.concat([header, contents]);
}

test('QQ query search, preview and bind use authoritative versions and timestamp translations; binding restores offline', async t => {
  const f = await fixture(t); f.tracks.get('a').title = ''; f.tracks.get('a').artist = '';
  const found = await f.service.search({ trackId: 'a', source: 'qq', query: '  Synthetic & fixture live  ' });
  assert.equal(found.provider, 'qq'); assert.equal(found.source, 'QQ Music'); assert.equal(found.status, 'ready');
  const candidate = found.results[0]; assert.equal(candidate.id, 'qq:FixtureMid001'); assert.equal(candidate.kind, 'none'); assert.equal(candidate.status, 'not-loaded');
  assert.equal(f.calls[0].searchParams.get('w'), 'Synthetic & fixture live');
  const preview = await f.service.preview({ trackId: 'a', candidate });
  assert.equal(preview.kind, 'line'); assert.equal(preview.bound, false); assert.equal(preview.preview, true);
  assert.deepEqual(preview.lines.map(line => line.translation), ['自编首行', undefined, '自编末行']);
  assert.deepEqual(preview.lines.map(line => line.startMs), [1000, 2000, 3000]);
  await assert.rejects(fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json')), { code: 'ENOENT' });
  const bound = await f.service.bind({ trackId: 'a', candidate }); assert.equal(bound.bound, true); assert.equal(bound.title, 'Synthetic song');
  assert.equal(bound.fromCache, false); const adjusted = await f.service.setOffset({ trackId: 'a', offsetMs: 350 }); assert.equal(adjusted.offsetMs, 350); assert.equal(adjusted.offsetCommitted, true);
  assert.ok(f.calls.every(url => url.hostname === 'c.y.qq.com')); assert.equal(f.calls.length, 2);
  await f.service.close();
  const reopened = createLyricsService({ dataDir: f.dataDir, getTrack: id => f.tracks.get(id), getSettings: () => ({ lyrics: { onlineEnabled: false, cacheEnabled: false } }), fetchImpl() { throw new Error('offline'); } });
  t.after(() => reopened.close());
  const restored = await reopened.resolve({ trackId: 'a' }); assert.equal(restored.bound, true); assert.equal(restored.offsetMs, 350); assert.equal(restored.provider, 'qq'); assert.deepEqual(restored.lines, bound.lines);
});

test('LRCLIB default and QQ have separate query/record caches and online disable rules', async t => {
  const f = await fixture(t);
  const primary = await f.service.search({ trackId: 'a', query: 'shared query' }); assert.equal(primary.provider, 'lrclib'); assert.equal(primary.results[0].sourceId, 1);
  const found = await f.service.search({ trackId: 'a', source: 'qq', query: 'shared query' });
  assert.equal(found.fromCache, false); const cached = await f.service.search({ trackId: 'a', source: 'qq', query: 'shared query' }); assert.equal(cached.fromCache, true);
  const candidate = cached.results[0]; await f.service.preview({ trackId: 'a', candidate }); const before = f.calls.length;
  f.prefs.lyrics.onlineEnabled = false;
  assert.equal((await f.service.preview({ trackId: 'a', candidate })).fromCache, true); assert.equal(f.calls.length, before);
  f.prefs.lyrics.cacheEnabled = false;
  assert.equal((await f.service.preview({ trackId: 'a', candidate })).reason, 'online-disabled');
  assert.equal((await f.service.search({ trackId: 'a', source: 'qq', query: 'shared query' })).reason, 'online-disabled'); assert.equal(f.calls.length, before);
  f.prefs.lyrics.onlineEnabled = true;
  await f.service.search({ trackId: 'a', source: 'qq', query: 'shared query' }); await f.service.search({ trackId: 'a', source: 'qq', query: 'shared query' });
  assert.equal(f.calls.length, before + 2);
});

test('QQ source unavailable and invalid source/query payloads are explicit and make no request', async t => {
  const f = await fixture(t, { fallbackClient: null });
  const result = await f.service.search({ trackId: 'a', source: 'qq', query: 'fixture' });
  assert.equal(result.status, 'not-found'); assert.equal(result.reason, 'source-unavailable'); assert.equal(result.provider, 'qq'); assert.equal(result.source, 'QQ Music'); assert.deepEqual(result.results, []);
  for (const source of ['QQ Music', 'https://evil.invalid', null]) await assert.rejects(f.service.search({ trackId: 'a', source }), /来源/);
  for (const query of [{ url: 'https://evil.invalid' }, 4, 'x'.repeat(501)]) await assert.rejects(f.service.search({ trackId: 'a', source: 'qq', query }), /搜索词/);
  assert.equal(f.calls.length, 0);
});

test('QQ cannot be forged, cross-track reused, metadata-edited or routed as a LRCLIB numeric ID', async t => {
  const f = await fixture(t), found = await f.service.search({ trackId: 'a', source: 'qq', query: 'fixture' }), candidate = found.results[0];
  for (const [key, value] of [['id', 'qq:OtherMid001'], ['sourceId', 1], ['sourceKey', 'lrclib:1'], ['provider', 'lrclib'], ['source', 'LRCLIB'], ['sourceUrl', 'https://evil.invalid/'], ['title', 'Forged'], ['artist', 'Forged'], ['album', 'Forged'], ['duration', 9]]) {
    await assert.rejects(f.service.preview({ trackId: 'a', candidate: { ...candidate, [key]: value } }), /QQ|LRCLIB/);
  }
  await assert.rejects(f.service.preview({ trackId: 'b', candidate }), /过期/);
  f.tracks.get('a').subsong = null;
  await assert.rejects(f.service.preview({ trackId: 'a', candidate }), /曲目信息已改变/);
  f.tracks.get('a').subsong = 0;
  await f.service.search({ trackId: 'a', source: 'lrclib', query: 'fixture' });
  await assert.rejects(f.service.bind({ trackId: 'a', candidate }), /过期/);
  assert.ok(f.calls.every(url => !url.pathname.includes('/get/'))); assert.equal(f.calls.length, 2);
});

test('QQ recent candidate authority expires after ten minutes and bounded LRU eviction', async t => {
  const f = await fixture(t), candidate = (await f.service.search({ trackId: 'a', source: 'qq', query: 'fixture' })).results[0];
  const originalNow = Date.now;
  try { const now = originalNow(); Date.now = () => now + 600001; await assert.rejects(f.service.bind({ trackId: 'a', candidate }), /过期/); }
  finally { Date.now = originalNow; }
  const current = (await f.service.search({ trackId: 'a', source: 'qq', query: 'fixture' })).results[0];
  for (let index = 0; index < 32; index++) { const id = `fixture${index}`; f.tracks.set(id, { ...f.tracks.get('a'), id }); await f.service.search({ trackId: id, source: 'qq', query: 'fixture' }); }
  await assert.rejects(f.service.preview({ trackId: 'a', candidate: current }), /过期/);
});

test('QQ adapter metadata substitution is rejected before binding and malformed translation does not misalign originals', async t => {
  const record = qqRecord(), f = await fixture(t, { fallbackClient: { async search() { return [record]; }, async get() { return { ...record, albumName: 'Wrong version', syncedLyrics: original }; }, close() {} } });
  const candidate = (await f.service.search({ trackId: 'a', source: 'qq', query: 'fixture' })).results[0];
  assert.equal((await f.service.bind({ trackId: 'a', candidate })).status, 'parse-error');
  await assert.rejects(fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json')), { code: 'ENOENT' });
  const bad = await fixture(t, { fallbackClient: createQqLyricsClient({ minRequestIntervalMs: 0, fetchImpl: async url => response(String(url).includes('client_search') ? qqSearch() : { code: 0, lyric: encoded(original), trans: encoded('[00:99]Broken fixture translation') }) }) });
  const choice = (await bad.service.search({ trackId: 'a', source: 'qq', query: 'fixture' })).results[0], preview = await bad.service.preview({ trackId: 'a', candidate: choice });
  assert.equal(preview.status, 'ready'); assert.ok(preview.translationWarning); assert.ok(preview.lines.every(line => line.translation === undefined));
});

test('new source search invalidates old QQ search and preview but a private bind keeps its captured server record', async t => {
  const gate = deferred(), started = deferred(); let gets = 0;
  const record = qqRecord(), f = await fixture(t, { fallbackClient: { async search() { return [record]; }, async get() { gets++; started.resolve(); await gate.promise; return { ...record, syncedLyrics: original }; }, close() {} } });
  const candidate = (await f.service.search({ trackId: 'a', source: 'qq', query: 'fixture' })).results[0];
  const preview = f.service.preview({ trackId: 'a', candidate }); await started.promise;
  await f.service.search({ trackId: 'a', source: 'lrclib', query: 'fixture' }); gate.resolve(); assert.equal((await preview).superseded, true);
  const gate2 = deferred(), started2 = deferred();
  const bindingFixture = await fixture(t, { fallbackClient: { async search() { return [record]; }, async get() { started2.resolve(); await gate2.promise; return { ...record, syncedLyrics: original }; }, close() {} } });
  const choice = (await bindingFixture.service.search({ trackId: 'a', source: 'qq', query: 'fixture' })).results[0];
  const binding = bindingFixture.service.bind({ trackId: 'a', candidate: choice }); await started2.promise;
  await bindingFixture.service.search({ trackId: 'a', source: 'lrclib', query: 'new fixture' }); gate2.resolve();
  assert.equal((await binding).bound, true); assert.equal((await bindingFixture.service.resolve({ trackId: 'a' })).provider, 'qq'); assert.equal(gets, 1);
  const lateGate = deferred(), lateStarted = deferred();
  const late = await fixture(t, { fallbackClient: { async search() { lateStarted.resolve(); await lateGate.promise; return [record]; }, async get() { throw new Error('must not fetch'); }, close() {} } });
  const oldSearch = late.service.search({ trackId: 'a', source: 'qq', query: 'old fixture' }); await lateStarted.promise;
  await late.service.search({ trackId: 'a', source: 'lrclib', query: 'new fixture' }); lateGate.resolve(); assert.equal((await oldSearch).superseded, true);
});

test('online disable during QQ candidate download prevents publication, cache admission and binding', async t => {
  const gate = deferred(), started = deferred(), record = qqRecord();
  const f = await fixture(t, { fallbackClient: { async search() { return [record]; }, async get() { started.resolve(); await gate.promise; return { ...record, syncedLyrics: original }; }, close() {} } });
  const candidate = (await f.service.search({ trackId: 'a', source: 'qq', query: 'fixture' })).results[0];
  const binding = f.service.bind({ trackId: 'a', candidate }); await started.promise; f.prefs.lyrics.onlineEnabled = false; gate.resolve();
  assert.equal((await binding).reason, 'online-disabled'); assert.equal((await f.service.preview({ trackId: 'a', candidate })).reason, 'online-disabled');
  await assert.rejects(fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json')), { code: 'ENOENT' });
});

test('a new QQ version with the same ID refreshes its old record cache and a superseded get cannot overwrite it', async t => {
  let gets = 0;
  const f = await fixture(t, { fallbackClient: { async search(_track, _context, { query }) { return [qqRecord('FixtureMid001', { albumName: query })]; },
    async get(record) { gets++; return { ...record, syncedLyrics: `[00:01]Synthetic ${record.albumName}` }; }, close() {} } });
  const first = (await f.service.search({ trackId: 'a', source: 'qq', query: 'First version' })).results[0];
  await f.service.preview({ trackId: 'a', candidate: first });
  const second = (await f.service.search({ trackId: 'a', source: 'qq', query: 'Second version' })).results[0];
  const bound = await f.service.bind({ trackId: 'a', candidate: second }); assert.equal(bound.album, 'Second version'); assert.equal(bound.lines[0].text, 'Synthetic Second version'); assert.equal(gets, 2);
  const gate = deferred(), started = deferred();
  const concurrent = await fixture(t, { fallbackClient: { async search(_track, _context, { query }) { return [qqRecord('FixtureMid001', { albumName: query })]; },
    async get(record) { if (record.albumName === 'Old version') { started.resolve(); await gate.promise; } return { ...record, syncedLyrics: `[00:01]Synthetic ${record.albumName}` }; }, close() {} } });
  const oldCandidate = (await concurrent.service.search({ trackId: 'a', source: 'qq', query: 'Old version' })).results[0];
  const oldPreview = concurrent.service.preview({ trackId: 'a', candidate: oldCandidate }); await started.promise;
  const candidate = (await concurrent.service.search({ trackId: 'a', source: 'qq', query: 'Current version' })).results[0];
  assert.equal((await concurrent.service.bind({ trackId: 'a', candidate })).album, 'Current version'); gate.resolve(); assert.equal((await oldPreview).superseded, true);
  const cached = await concurrent.service.preview({ trackId: 'a', candidate }); assert.equal(cached.fromCache, true); assert.equal(cached.lines[0].text, 'Synthetic Current version');
});

test('QQ automatic fallback persists its correctly aligned translation across an offline cache restart', async t => {
  const f = await fixture(t, { fetchImpl: async url => String(url).includes('/search?') ? response([]) : new Response(null, { status: 404 }) });
  const document = await f.service.resolve({ trackId: 'a' }); assert.equal(document.provider, 'qq'); assert.deepEqual(document.lines.map(line => line.translation), ['自编首行', undefined, '自编末行']);
  await f.service.close();
  const reopened = createLyricsService({ dataDir: f.dataDir, getTrack: id => f.tracks.get(id), getSettings: () => ({ lyrics: { onlineEnabled: false } }) });
  t.after(() => reopened.close());
  const cached = await reopened.resolve({ trackId: 'a' }); assert.equal(cached.fromCache, true); assert.deepEqual(cached.lines, document.lines);
});

test('recovery rejects non-text translation fields in a saved QQ binding', async t => {
  const f = await fixture(t), candidate = (await f.service.search({ trackId: 'a', source: 'qq', query: 'fixture' })).results[0];
  await f.service.bind({ trackId: 'a', candidate }); await f.service.close();
  const file = path.join(f.dataDir, 'lyrics', 'state.json'), originalState = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const key of ['translation', 'plainTranslation']) {
    const altered = structuredClone(originalState), document = altered.bindings.a.document;
    if (key === 'translation') document.lines[0].translation = { text: 'Invalid object' }; else document.plainTranslation = { text: 'Invalid object' };
    await fs.writeFile(file, JSON.stringify(altered));
    const reopened = createLyricsService({ dataDir: f.dataDir, getTrack: id => f.tracks.get(id), getSettings: () => ({ lyrics: { onlineEnabled: false } }) });
    try { assert.equal((await reopened.resolve({ trackId: 'a' })).status, 'not-found'); } finally { await reopened.close(); }
  }
});

test('subsong null and zero have different request/cache fingerprints', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, { fetchImpl: async () => { started.resolve(); await gate.promise; return response(lrclibRecord()); } });
  f.tracks.get('a').subsong = null; const pending = f.service.resolve({ trackId: 'a' }); await started.promise;
  f.tracks.get('a').subsong = 0; gate.resolve(); assert.equal((await pending).superseded, true);
  await assert.rejects(fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json')), { code: 'ENOENT' });
});

test('post-commit track lookup failures acknowledge the real saved offset without returning obsolete lyrics and restore after restart', async t => {
  for (const [name, failedLookup, missing] of [['lookup throws', 2, false], ['track removed', 2, true], ['later selection lookup fails', 3, false], ['resolve lookup fails', 4, false]]) {
    await t.test(name, async child => {
      let lookups = 0, track;
      const f = await fixture(child, { getTrack() { if (++lookups === failedLookup) { if (missing) return undefined; throw new Error('synthetic post-commit lookup failure'); } return track; } });
      track = f.tracks.get('a'); f.prefs.lyrics.onlineEnabled = false;
      const result = await f.service.setOffset({ trackId: 'a', offsetMs: 77 });
      assert.equal(result.trackId, 'a'); assert.equal(result.offsetCommitted, true); assert.equal(result.offsetMs, 77);
      assert.equal(result.status, 'not-found'); assert.equal(result.reason, 'offset-read-failed'); assert.ok(result.offsetWarning); assert.deepEqual(result.lines, []); assert.equal(result.plainText, undefined);
      assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json'), 'utf8')).offsets.a, 77);
      await f.service.close();
      const reopened = createLyricsService({ dataDir: f.dataDir, getTrack: () => track, getSettings: () => ({ lyrics: { onlineEnabled: false } }) });
      child.after(() => reopened.close()); assert.equal((await reopened.resolve({ trackId: 'a' })).offsetMs, 77);
    });
  }
});

test('offset save failures before commit still reject and never acknowledge a persisted value', async t => {
  const f = await fixture(t, { fsImpl: { ...fs, async rename() { throw Object.assign(new Error('synthetic save denied'), { code: 'EACCES' }); } } });
  await assert.rejects(f.service.setOffset({ trackId: 'a', offsetMs: 77 }), { code: 'EACCES' });
  await assert.rejects(fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json')), { code: 'ENOENT' });
});

test('real music-metadata reads synthetic FLAC LYRICS/UNSYNCEDLYRICS and ID3 USLT without modifying audio', async t => {
  const f = await fixture(t); f.prefs.lyrics.onlineEnabled = false;
  for (const [extension, content, expectedStatus, expectedText] of [
    ['flac', flac('[offset:100]\n[00:01.100][00:02.100]Synthetic repeated line', { pictureBytes: 3 * 1024 * 1024 }), 'ready', 'Synthetic repeated line'],
    ['flac', flac('Synthetic plain embedded body', { tag: 'UNSYNCEDLYRICS' }), 'plain', 'Synthetic plain embedded body'],
    ['wav', wavUslt('[00:01]Synthetic ID3 line'), 'ready', 'Synthetic ID3 line']
  ]) {
    f.tracks.get('a').path = path.join(f.folder, `audio.${extension}`); await fs.writeFile(f.tracks.get('a').path, content);
    const before = createHash('sha256').update(content).digest('hex'), document = await f.service.resolve({ trackId: 'a', force: true });
    assert.equal(document.status, expectedStatus); assert.equal(document.source, '内嵌歌词'); assert.equal(document.provider, 'embedded'); assert.equal(document.local, true); assert.equal(document.bound, false);
    assert.equal(document.lines[0]?.text || document.plainText, expectedText);
    if (content.length > 3 * 1024 * 1024) assert.deepEqual(document.lines.map(line => line.startMs), [1000, 2000]);
    assert.equal(createHash('sha256').update(await fs.readFile(f.tracks.get('a').path)).digest('hex'), before);
  }
  assert.equal(f.calls.length, 0); await assert.rejects(fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json')), { code: 'ENOENT' });
});

test('embedded common ILyricsTag milliseconds preserve source timing while objects and MPEG frame times are not invented text', async t => {
  let metadata = { common: { lyrics: [{ contentType: 1, timeStampFormat: 2, text: 'Normalized plain fallback', syncText: [{ timestamp: 1000, text: 'Synthetic timed first' }, { timestamp: 3000, text: 'Synthetic timed last' }] }] }, native: {} };
  const f = await fixture(t, { embeddedMetadataParser: async (_tokenizer, options) => { assert.equal(options.skipCovers, true); assert.equal(options.duration, false); assert.equal(options.maxMemoryAllocation, 2097152); return metadata; } });
  await fs.writeFile(f.tracks.get('a').path, flac()); f.prefs.lyrics.onlineEnabled = false;
  const document = await f.service.resolve({ trackId: 'a' }); assert.equal(document.kind, 'line'); assert.deepEqual(document.lines.map(line => [line.startMs, line.text]), [[1000, 'Synthetic timed first'], [3000, 'Synthetic timed last']]);
  metadata = { common: { lyrics: [{ text: 'Synthetic object plain text', language: 'eng' }] } };
  assert.equal((await f.service.resolve({ trackId: 'a' })).plainText, 'Synthetic object plain text');
  metadata = { common: { lyrics: [{ contentType: 1, timeStampFormat: 1, syncText: [{ timestamp: 40, text: 'MPEG frame fixture' }] }, { unknown: 'object' }] } };
  const unsupported = await f.service.resolve({ trackId: 'a' }); assert.equal(unsupported.status, 'not-found'); assert.equal(unsupported.plainText, undefined);
  assert.deepEqual(extractEmbeddedLyrics({ common: { lyrics: [{ unknown: 'object' }] } }), []);
});

test('manual/import and sidecars precede embedded lyrics, which precede downloaded cache and network', async t => {
  let enabled = false, reads = 0;
  const f = await fixture(t, { embeddedMetadataParser: async () => { reads++; return { common: { lyrics: enabled ? ['Synthetic embedded wins'] : [] } }; } });
  await fs.writeFile(f.tracks.get('a').path, flac());
  assert.equal((await f.service.resolve({ trackId: 'a' })).source, 'LRCLIB'); const networkCalls = f.calls.length;
  enabled = true; assert.equal((await f.service.resolve({ trackId: 'a' })).source, '内嵌歌词'); assert.equal(f.calls.length, networkCalls);
  await fs.writeFile(path.join(f.folder, 'a.lrc'), '[00:01]Synthetic sidecar wins'); const before = reads;
  assert.equal((await f.service.resolve({ trackId: 'a' })).source, '本地歌词'); assert.equal(reads, before);
  const manual = path.join(f.folder, 'manual.txt'); await fs.writeFile(manual, 'Synthetic manual wins'); await f.service.importFile({ trackId: 'a', path: manual });
  assert.equal((await f.service.resolve({ trackId: 'a' })).plainText, 'Synthetic manual wins'); assert.equal(reads, before);
});

test('automatic sidecars cannot apply whole-file lyrics to container or CUE references including subsong zero', async t => {
  const f = await fixture(t); f.prefs.lyrics.onlineEnabled = false;
  await fs.writeFile(path.join(f.folder, 'a.lrc'), '[00:01]Synthetic whole-file sidecar');
  for (const patch of [{ subsong: 1 }, { subsong: null }, { source: 'cue', subsong: 0 }, { source: 'foobar2000', cueTrack: true, subsong: 0 }, { path: path.join(f.folder, 'a.cue'), subsong: 0 }, { path: path.join(f.folder, 'a.iso'), subsong: 0 }]) {
    f.tracks.set('a', { id: 'a', path: path.join(f.folder, 'a.flac'), title: 'Synthetic song', artist: 'Synthetic author', album: 'Synthetic album', duration: 10, ...patch });
    const document = await f.service.resolve({ trackId: 'a' }); assert.equal(document.status, 'not-found'); assert.equal(document.local, false);
  }
  const imported = path.join(f.folder, 'manual.lrc'); await fs.writeFile(imported, '[00:01]Synthetic exact subtrack import');
  const manual = await f.service.importFile({ trackId: 'a', path: imported }); assert.equal(manual.bound, true); assert.equal((await f.service.resolve({ trackId: 'a' })).lines[0].text, 'Synthetic exact subtrack import');
});

test('ambiguous or malformed embedded tags are skipped with a warning before a usable lower-priority cache', async t => {
  let metadata = { common: { lyrics: [] } };
  const f = await fixture(t, { embeddedMetadataParser: async () => metadata }); await fs.writeFile(f.tracks.get('a').path, flac());
  await f.service.resolve({ trackId: 'a' }); f.prefs.lyrics.onlineEnabled = false;
  for (const lyrics of [['Synthetic first version', 'Synthetic different version'], ['[00:99]Malformed fixture']]) {
    metadata = { common: { lyrics } }; const document = await f.service.resolve({ trackId: 'a' });
    assert.equal(document.source, 'LRCLIB'); assert.equal(document.fromCache, true); assert.ok(document.embeddedWarning);
  }
});

test('embedded reader skips containers, nonzero/unknown subsongs, remote/relative paths and invalid library entries before filesystem access', async () => {
  let reads = 0; const reader = createEmbeddedLyricsReader({ fsImpl: { lstat() { reads++; throw new Error('must not inspect'); } } });
  try {
    const base = { path: path.resolve('synthetic.flac'), subsong: 0 };
    for (const track of [{ ...base, subsong: 1 }, { ...base, subsong: null }, { ...base, subsong: '0' }, { ...base, source: 'cue' }, { ...base, source: 'foobar2000', cueTrack: true }, { ...base, path: path.resolve('synthetic.cue') }, { ...base, path: path.resolve('synthetic.iso') }, { ...base, valid: false }, { path: 'relative.flac' }, { path: 'https://evil.invalid/audio.flac' }]) assert.equal(await reader.read(track), null);
    assert.equal(reads, 0);
  } finally { reader.close(); }
});

test('embedded safe-open rejects hardlinks and ancestor junctions before metadata parsing', async t => {
  let parses = 0; const f = await fixture(t, { embeddedMetadataParser: async () => { parses++; return { common: { lyrics: ['Must not use'] } }; } });
  const file = f.tracks.get('a').path; await fs.writeFile(file, flac()); f.prefs.lyrics.onlineEnabled = false;
  const hardlink = path.join(f.folder, 'linked.flac'); await fs.link(file, hardlink);
  const linked = await f.service.resolve({ trackId: 'a' }); assert.equal(linked.status, 'not-found'); assert.match(linked.embeddedWarning, /链接/); assert.equal(parses, 0); await fs.unlink(hardlink);
  const real = path.join(f.folder, 'ordinary'), alias = path.join(f.folder, 'junction'); await fs.mkdir(real); await fs.writeFile(path.join(real, 'fixture.flac'), flac());
  await t.test('ancestor link', async child => {
    try { await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { child.skip(`symlink unavailable: ${error.code}`); return; } throw error; }
    f.tracks.get('a').path = path.join(alias, 'fixture.flac');
    const result = await f.service.resolve({ trackId: 'a' }); assert.equal(result.status, 'not-found'); assert.match(result.embeddedWarning, /父目录/); assert.equal(parses, 0);
    await fs.unlink(alias);
  });
});

test('embedded file replacement and asynchronous track mutation cannot publish an old document', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, { embeddedMetadataParser: async () => { started.resolve(); await gate.promise; return { common: { lyrics: ['Synthetic stale file'] } }; } });
  await fs.writeFile(f.tracks.get('a').path, flac()); f.prefs.lyrics.onlineEnabled = false;
  const pending = f.service.resolve({ trackId: 'a' }); await started.promise;
  await fs.rename(f.tracks.get('a').path, path.join(f.folder, 'original.flac')); await fs.writeFile(f.tracks.get('a').path, flac('Synthetic replacement')); gate.resolve();
  const document = await pending; assert.equal(document.status, 'not-found'); assert.match(document.embeddedWarning, /改变/);
  const nextGate = deferred(), nextStarted = deferred();
  const other = await fixture(t, { embeddedMetadataParser: async () => { nextStarted.resolve(); await nextGate.promise; return { common: { lyrics: ['Synthetic stale track'] } }; } });
  await fs.writeFile(other.tracks.get('a').path, flac()); const old = other.service.resolve({ trackId: 'a' }); await nextStarted.promise;
  other.tracks.get('a').subsong = null; nextGate.resolve(); assert.equal((await old).superseded, true); assert.equal(other.calls.length, 0);
});

test('embedded cumulative read-byte/read-count/allocation limits close the owning file handle', async t => {
  const f = await fixture(t), track = f.tracks.get('a'); await fs.writeFile(track.path, flac());
  for (const kind of ['bytes', 'read-bytes', 'operations', 'mixed-operations', 'allocation', 'buffer-allocation']) {
    let closes = 0;
    const io = { ...fs, async open(...args) { const handle = await fs.open(...args), close = handle.close.bind(handle); handle.close = async () => { closes++; await close(); }; return handle; } };
    const reader = createEmbeddedLyricsReader({ fsImpl: io, maxReadBytes: kind.includes('bytes') ? 1 : undefined, maxReadOperations: kind.includes('operations') ? 1 : undefined,
      metadataParser: async tokenizer => {
        if (kind === 'allocation') await tokenizer.readToken({ len: 2097153, get() {} });
        else if (kind === 'buffer-allocation') await tokenizer.readBuffer(Buffer.alloc(2097153));
        else if (kind === 'read-bytes') await tokenizer.readBuffer(Buffer.alloc(2));
        else if (kind === 'mixed-operations') { await tokenizer.readBuffer(Buffer.alloc(1)); await tokenizer.peekBuffer(Buffer.alloc(1)); }
        else { await tokenizer.peekBuffer(Buffer.alloc(2)); await tokenizer.peekBuffer(Buffer.alloc(1)); }
        return {};
      } });
    try { const result = await reader.read(track); assert.ok(result.warning, kind); assert.equal(closes, 1, kind); }
    finally { reader.close(); }
  }
});

test('embedded public tokenizer subclass receives a real FileHandle and preserves normalized read/peek semantics', async t => {
  const f = await fixture(t), track = f.tracks.get('a'); await fs.writeFile(track.path, flac());
  const { FileTokenizer } = await import('strtok3'); let openedHandle, closes = 0;
  const reader = createEmbeddedLyricsReader({ maxReadBytes: 4, fsImpl: { ...fs, async open(...args) {
    openedHandle = await fs.open(...args); const close = openedHandle.close.bind(openedHandle);
    openedHandle.close = async () => { closes++; await close(); }; return openedHandle;
  } }, metadataParser: async tokenizer => {
    assert.ok(tokenizer instanceof FileTokenizer); assert.notEqual(Object.getPrototypeOf(tokenizer), FileTokenizer.prototype);
    assert.equal(typeof openedHandle.fd, 'number'); assert.ok(openedHandle.fd >= 0); assert.equal(typeof openedHandle.createReadStream, 'function');
    const peek = Buffer.alloc(2), read = Buffer.alloc(2);
    await assert.rejects(tokenizer.peekBuffer(peek, { length: 3 }), RangeError);
    assert.equal(await tokenizer.peekBuffer(peek), 2); assert.equal(peek.toString(), 'fL'); assert.equal(tokenizer.position, 0);
    assert.equal(await tokenizer.readBuffer(read), 2); assert.equal(read.toString(), 'fL'); assert.equal(tokenizer.position, 2);
    await assert.rejects(tokenizer.peekBuffer(Buffer.alloc(1)), /读取超过/);
    return { common: { lyrics: ['Synthetic inherited tokenizer fixture'] } };
  } });
  try { const result = await reader.read(track); assert.equal(result.candidates[0].text, 'Synthetic inherited tokenizer fixture'); assert.equal(closes, 1); assert.equal(openedHandle.fd, -1); }
  finally { reader.close(); }
});

test('embedded real-handle cleanup failures cannot hide the original read error or publish a false success', async t => {
  const f = await fixture(t), track = f.tracks.get('a'); await fs.writeFile(track.path, flac());
  for (const readFails of [true, false]) {
    let handle, closes = 0;
    const reader = createEmbeddedLyricsReader({ maxReadBytes: 1, fsImpl: { ...fs, async open(...args) {
      handle = await fs.open(...args); const close = handle.close.bind(handle);
      handle.close = async () => { closes++; await close(); throw Object.assign(new Error('synthetic cleanup failure'), { code: 'EIO' }); }; return handle;
    } }, metadataParser: async tokenizer => { if (readFails) await tokenizer.readBuffer(Buffer.alloc(2)); return { common: { lyrics: ['Synthetic cleanup fixture'] } }; } });
    try {
      const result = await reader.read(track); assert.ok(result.warning); assert.equal(result.candidates, undefined); assert.equal(closes, 1); assert.equal(handle.fd, -1);
      if (readFails) assert.match(result.warning, /读取超过/);
    } finally { reader.close(); }
  }
});

test('embedded lyric text cannot cause additional file or URL reads', async t => {
  const opened = [], literal = 'file:///synthetic/not-an-authorized-lyric-path.lrc';
  const f = await fixture(t, { embeddedFsImpl: { ...fs, async open(file, flags) { opened.push(file); return fs.open(file, flags); } }, embeddedMetadataParser: async () => ({ common: { lyrics: [{ text: literal }] } }) });
  await fs.writeFile(f.tracks.get('a').path, flac()); f.prefs.lyrics.onlineEnabled = false;
  const document = await f.service.resolve({ trackId: 'a' }); assert.equal(document.plainText, literal); assert.deepEqual(opened, [f.tracks.get('a').path]); assert.equal(f.calls.length, 0);
});

test('embedded logical timeout/close keep one physical parser slot until its handle is released', async t => {
  const f = await fixture(t), track = f.tracks.get('a'); await fs.writeFile(track.path, flac());
  const gate = deferred(), started = deferred(), closedHandle = deferred(); let parses = 0, closes = 0;
  const reader = createEmbeddedLyricsReader({ timeoutMs: 30, fsImpl: { ...fs, async open(...args) { const handle = await fs.open(...args), close = handle.close.bind(handle); handle.close = async () => { closes++; await close(); closedHandle.resolve(); }; return handle; } },
    metadataParser: async () => { parses++; started.resolve(); await gate.promise; return { common: { lyrics: ['Synthetic late text'] } }; } });
  try {
    const first = reader.read(track); await started.promise; assert.ok((await first).warning); assert.equal(parses, 1); assert.equal(closes, 0);
    const queued = reader.read(track); reader.close(); assert.ok((await queued).warning); assert.equal(parses, 1);
    gate.resolve(); await closedHandle.promise; assert.equal(closes, 1); assert.equal(await reader.read(track), null);
  } finally { gate.resolve(); reader.close(); }
});

test('embedded cancellation after a pending inherited read retains its real handle until physical settlement', async t => {
  const f = await fixture(t), track = f.tracks.get('a'); await fs.writeFile(track.path, flac());
  for (const method of ['readBuffer', 'peekBuffer']) {
    const gate = deferred(), started = deferred(), closedHandle = deferred(); let openedHandle, parses = 0, closes = 0;
    const reader = createEmbeddedLyricsReader({ timeoutMs: 30, fsImpl: { ...fs, async open(...args) {
      openedHandle = await fs.open(...args); const read = openedHandle.read.bind(openedHandle), close = openedHandle.close.bind(openedHandle);
      openedHandle.read = async (...values) => { started.resolve(); await gate.promise; return read(...values); };
      openedHandle.close = async () => { closes++; await close(); closedHandle.resolve(); }; return openedHandle;
    } }, metadataParser: async tokenizer => { parses++; await tokenizer[method](Buffer.alloc(1)); return { common: { lyrics: ['Synthetic late inherited read'] } }; } });
    try {
      const first = reader.read(track); await started.promise; assert.ok((await first).warning); assert.equal(closes, 0); assert.ok(openedHandle.fd >= 0);
      const queued = reader.read(track); reader.close(); assert.ok((await queued).warning); assert.equal(parses, 1); assert.equal(closes, 0);
      gate.resolve(); await closedHandle.promise; assert.equal(closes, 1); assert.equal(openedHandle.fd, -1);
    } finally { gate.resolve(); reader.close(); }
  }
});
