'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {constants: FS} = require('node:fs');
const {queryObjects} = require('node:v8');

const path = require('node:path');
const { createLyricsService, createLrclibClient, createSearchingDocument } = require('../src/main/lyrics');
const { createQqLyricsClient } = require('../src/main/qq-lyrics');

const response = (value, status = 200, headers) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const record = (id, title = 'Song', extras = {}) => ({ id, trackName: title, artistName: 'Artist', albumName: 'Album', duration: 180, instrumental: false, syncedLyrics: '[00:01.00]Network one\n[00:04.00]Network two', plainLyrics: 'Network one\nNetwork two', ...extras });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture(t, fetchImpl, extra = {}) {
  const folder = await fs.mkdtemp(path.join(__dirname, '.tmp-lyrics-test-'));
  const tracks = new Map([
    ['a', { id: 'a', path: path.join(folder, 'Song.flac'), title: 'Song', artist: 'Artist', album: 'Album', duration: 180 }],
    ['b', { id: 'b', path: path.join(folder, 'Other.flac'), title: 'Other', artist: 'Artist', album: 'Album', duration: 180 }],
  ]);
  const prefs = { lyrics: { onlineEnabled: true, cacheEnabled: true, preferredSource: 'lrclib' } };
  const dataDir = path.join(folder, 'data');
  const service = createLyricsService({ dataDir, getTrack: id => tracks.get(id), getSettings: () => prefs, fetchImpl, minRequestIntervalMs: 0, timeoutMs: 1000, retryBaseMs: 1, ...extra });
  await service.initialize();
  t.after(async () => { await service.close(); const target = path.resolve(folder); assert.equal(path.dirname(target), path.resolve(__dirname)); assert.ok(path.basename(target).startsWith('.tmp-lyrics-test-')); await fs.rm(target, { recursive: true, force: true }); });
  return { service, folder, tracks, prefs, dataDir };
}

test('local sidecars beat network and translations match by timestamp', async t => {
  let calls = 0;
  const { service, folder } = await fixture(t, async () => { calls += 1; return response(record(1)); });
  await fs.writeFile(path.join(folder, 'Song.lrc'), '[00:01]Local one\n[00:04]Local two');
  await fs.writeFile(path.join(folder, 'Song.translation.lrc'), '[00:04]二\n[00:00]Unmatched\n[00:01]一');
  const document = await service.resolve({ trackId: 'a' });
  assert.equal(document.source, '本地歌词');
  assert.equal(document.local, true);
  assert.equal(document.bound, false);
  assert.equal(document.fromCache, false);
  assert.deepEqual(document.lines.map(line => line.translation), ['一', '二']);
  assert.equal(calls, 0);
  const forced = await service.resolve({ trackId: 'a', force: true });
  assert.equal(forced.local, true);
  assert.equal(calls, 0);
});

test('manual import binds a snapshot by track ID and survives deletion/restart; offset persists and resets', async t => {
  const { service, folder, dataDir, tracks, prefs } = await fixture(t, async () => { throw new Error('must stay offline'); });
  await fs.writeFile(path.join(folder, 'Song.lrc'), '[00:01]Sidecar');
  const imported = path.join(folder, 'chosen.yrc');
  await fs.writeFile(imported, '[1000,900](1000,400,0)Manual (1400,500,0)word');
  let document = await service.importFile({ trackId: 'a', path: imported });
  assert.equal(document.kind, 'word');
  assert.equal(document.local, true);
  assert.equal(document.bound, true);
  assert.equal((await service.setOffset({ trackId: 'a', offsetMs: 350 })).offsetMs, 350);
  assert.equal((await service.setOffset({ trackId: 'b', offsetMs: -200 })).offsetMs, -200);
  await fs.rm(imported);
  await service.close();
  prefs.lyrics.onlineEnabled = false;
  prefs.lyrics.cacheEnabled = false;
  const reopened = createLyricsService({ dataDir, getTrack: id => tracks.get(id), getSettings: () => prefs, fetchImpl: async () => { throw new Error('offline'); }, minRequestIntervalMs: 0 });
  t.after(() => reopened.close());
  document = await reopened.resolve({ trackId: 'a' });
  assert.equal(document.lines[0].text, 'Manual word');
  assert.equal(document.offsetMs, 350);
  assert.equal(document.bound, true);
  assert.equal(document.fromCache, false);
  assert.equal((await reopened.setOffset({ trackId: 'a', offsetMs: 0 })).offsetMs, 0);
  assert.equal((await reopened.unbind({ trackId: 'a' })).lines[0].text, 'Sidecar');
});

test('cache survives restart and is below local/binding; disabling cache skips reads/writes without removing bindings', async t => {
  let calls = 0;
  const { service, folder, prefs, dataDir, tracks } = await fixture(t, async () => { calls += 1; return response(record(17)); });
  let document = await service.resolve({ trackId: 'a' });
  assert.equal(document.fromCache, false);
  assert.equal(calls, 1);
  document = await service.resolve({ trackId: 'a' });
  assert.equal(document.fromCache, true);
  assert.equal(calls, 1);
  await service.close();
  prefs.lyrics.onlineEnabled = false;
  const reopened = createLyricsService({ dataDir, getTrack: id => tracks.get(id), getSettings: () => prefs, fetchImpl: async () => { throw new Error('no network'); }, minRequestIntervalMs: 0 });
  t.after(() => reopened.close());
  assert.equal((await reopened.resolve({ trackId: 'a' })).fromCache, true);
  prefs.lyrics.cacheEnabled = false;
  document = await reopened.resolve({ trackId: 'a' });
  assert.equal(document.status, 'not-found');
  assert.equal(document.reason, 'online-disabled');
  prefs.lyrics.cacheEnabled = true;
  await fs.writeFile(path.join(folder, 'Song.txt'), 'Local wins');
  assert.equal((await reopened.resolve({ trackId: 'a' })).plainText, 'Local wins');
  await fs.rm(path.join(folder, 'Song.txt'));
  tracks.get('a').title = 'Song (Live)';
  assert.equal((await reopened.resolve({ trackId: 'a' })).status, 'not-found');
});

test('cache disabled performs fresh requests and never creates downloaded cache', async t => {
  let calls = 0;
  const { service, prefs, dataDir } = await fixture(t, async () => { calls += 1; return response(record(calls)); });
  prefs.lyrics.cacheEnabled = false;
  await service.resolve({ trackId: 'a' });
  await service.resolve({ trackId: 'a' });
  assert.equal(calls, 2);
  await assert.rejects(fs.readFile(path.join(dataDir, 'lyrics', 'state.json')), { code: 'ENOENT' });
});

test('force refresh bypasses cache and retains usable offline copy on a network failure', async t => {
  let calls = 0;
  const { service } = await fixture(t, async () => { calls += 1; if (calls > 1) throw new Error('connection lost'); return response(record(1)); });
  await service.resolve({ trackId: 'a' });
  const document = await service.resolve({ trackId: 'a', force: true });
  assert.equal(calls, 4); // Initial success plus the bounded three-attempt refresh.
  assert.equal(document.status, 'ready');
  assert.equal(document.fromCache, true);
  assert.equal(document.refreshStatus, 'network-error');
  assert.match(document.error, /connection lost/);
});

test('missing lyrics, network failures and damaged API JSON remain distinct', async t => {
  for (const [name, fetchImpl, expected] of [
    ['missing', async url => url.includes('/get?') ? response({}, 404) : response([]), 'not-found'],
    ['network', async () => { throw new Error('unreachable'); }, 'network-error'],
    ['bad-json', async () => new Response('{bad', { status: 200 }), 'parse-error'],
    ['empty-record', async () => response(record(1, 'Song', { syncedLyrics: '', plainLyrics: '' })), 'parse-error'],
    ['server-error', async () => response({}, 503), 'network-error'],
  ]) {
    await t.test(name, async child => {
      const { service } = await fixture(child, fetchImpl);
      const document = await service.resolve({ trackId: 'a' });
      assert.equal(document.status, expected);
      assert.equal(document.kind, 'none');
    });
  }
});

test('plain and instrumental source records remain truthful even when hasWordSync claims words', async t => {
  for (const [extras, status, kind] of [
    [{ syncedLyrics: '', plainLyrics: 'Plain words', hasWordSync: true }, 'plain', 'plain'],
    [{ syncedLyrics: '', plainLyrics: '', instrumental: true }, 'instrumental', 'instrumental'],
    [{ hasWordSync: true }, 'ready', 'line'],
  ]) {
    await t.test(kind, async child => {
      const { service } = await fixture(child, async () => response(record(1, 'Song', extras)));
      const document = await service.resolve({ trackId: 'a' });
      assert.equal(document.status, status);
      assert.equal(document.kind, kind);
    });
  }
});

test('manual search forwards explicit query, exposes versions, preview does not bind, bind persists', async t => {
  const calls = [];
  const { service, tracks } = await fixture(t, async url => {
    calls.push(new URL(url));
    if (url.includes('/search?')) return response([record(1), record(2, 'Song (Live)', { albumName: 'Live Album', duration: 225 })]);
    return response(record(2, 'Song (Live)', { albumName: 'Live Album', duration: 225 }));
  });
  tracks.get('a').artist = '';
  const found = await service.search({ trackId: 'a', query: '曲名 live & version' });
  assert.equal(found.results.length, 2);
  assert.equal(calls[0].searchParams.get('q'), '曲名 live & version');
  assert.equal(found.results[1].duration, 225);
  assert.equal(found.results[1].album, 'Live Album');
  assert.equal(found.results[1].sourceUrl, 'https://lrclib.net/api/get/2');
  const preview = await service.preview({ trackId: 'a', candidate: found.results[1] });
  assert.equal(preview.bound, false);
  assert.equal(preview.preview, true);
  assert.equal((await service.resolve({ trackId: 'a' })).reason, 'missing-metadata');
  const bound = await service.bind({ trackId: 'a', candidate: found.results[1] });
  assert.equal(bound.bound, true);
  assert.equal(bound.title, 'Song (Live)');
  assert.equal((await service.resolve({ trackId: 'a' })).sourceId, 2);
});

test('automatic matching never takes the first mismatched or ambiguous version', async t => {
  const { service, tracks } = await fixture(t, async url => {
    if (url.includes('/get?')) return response(record(1, 'Song (Live)', { duration: 180 }));
    return response([record(1, 'Song (Live)'), record(2), record(3)]);
  });
  let document = await service.resolve({ trackId: 'a' });
  assert.equal(document.reason, 'selection-required');
  assert.equal(document.bound, false);
  tracks.get('a').album = '';
  tracks.get('a').duration = 225;
  document = await service.resolve({ trackId: 'a', force: true });
  assert.equal(document.reason, 'no-match');
});

test('fast switching keeps documents and persisted cache scoped to each track', async t => {
  const first = deferred();
  const started = deferred();
  const { service, dataDir } = await fixture(t, async url => {
    const title = new URL(url).searchParams.get('track_name');
    if (title === 'Song') { started.resolve(); await first.promise; }
    return response(record(title === 'Song' ? 1 : 2, title));
  });
  const a = service.resolve({ trackId: 'a' });
  await started.promise;
  const b = service.resolve({ trackId: 'b' });
  first.resolve();
  const documents = await Promise.all([a, b]);
  assert.deepEqual(documents.map(document => [document.trackId, document.sourceId]), [['a', 1], ['b', 2]]);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'lyrics', 'state.json'), 'utf8'));
  assert.equal(saved.cache.a.document.trackId, 'a');
  assert.equal(saved.cache.b.document.trackId, 'b');
});

test('in-flight automatic fetch cannot overwrite a newer manual import', async t => {
  const gate = deferred(), started = deferred();
  const { service, folder } = await fixture(t, async () => { started.resolve(); await gate.promise; return response(record(1)); });
  const old = service.resolve({ trackId: 'a' });
  await started.promise;
  const chosen = path.join(folder, 'manual.lrc');
  await fs.writeFile(chosen, '[00:01]Manually selected');
  await service.importFile({ trackId: 'a', path: chosen });
  gate.resolve();
  const result = await old;
  assert.equal(result.superseded, true); // Cancellation may settle before the import finishes saving.
  assert.equal(result.lines.some(line => line.text === 'Network one'), false);
  const current = await service.resolve({ trackId: 'a' });
  assert.equal(current.bound, true);
  assert.equal(current.lines[0].text, 'Manually selected');
});

test('new force request supersedes prior request for same track and latest offset applies', async t => {
  const gate = deferred(), started = deferred();
  let calls = 0;
  const { service } = await fixture(t, async () => {
    calls += 1;
    if (calls === 1) { started.resolve(); await gate.promise; }
    return response(record(calls));
  });
  const old = service.resolve({ trackId: 'a' });
  await started.promise;
  const latest = service.resolve({ trackId: 'a', force: true });
  gate.resolve();
  const [outdated, document] = await Promise.all([old, latest]);
  assert.equal(outdated.superseded, true);
  assert.equal(document.sourceId, 2);
  assert.equal((await service.setOffset({ trackId: 'a', offsetMs: -125 })).offsetMs, -125);
  assert.equal((await service.resolve({ trackId: 'a' })).offsetMs, -125);
});

test('pending manual binding has priority over a concurrent resolve', async t => {
  const gate = deferred(), started = deferred();
  const { service } = await fixture(t, async () => { started.resolve(); await gate.promise; return response(record(5)); });
  const binding = service.bind({ trackId: 'a', candidate: { id: 'lrclib:5' } });
  await started.promise;
  const resolve = service.resolve({ trackId: 'a' });
  gate.resolve();
  const documents = await Promise.all([binding, resolve]);
  assert.ok(documents.every(document => document.bound && document.sourceId === 5));
});

test('older manual searches cannot publish stale results for the same track', async t => {
  const gate = deferred(), started = deferred();
  const { service } = await fixture(t, async url => {
    const query = new URL(url).searchParams.get('q');
    if (query === 'old query') { started.resolve(); await gate.promise; }
    return response([record(query === 'old query' ? 1 : 2)]);
  });
  const old = service.search({ trackId: 'a', query: 'old query' });
  await started.promise;
  const fresh = service.search({ trackId: 'a', query: 'new query' });
  gate.resolve();
  assert.equal((await old).superseded, true);
  assert.equal((await fresh).results[0].sourceId, 2);
});

test('downloaded cache is bounded and a corrupt state file is preserved for recovery', async t => {
  const { service, dataDir, tracks } = await fixture(t, async url => response(record(new URL(url).searchParams.get('track_name') === 'Song' ? 1 : 2, new URL(url).searchParams.get('track_name'))), { maxCacheEntries: 1 });
  await service.resolve({ trackId: 'a' });
  await service.resolve({ trackId: 'b' });
  assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(dataDir, 'lyrics', 'state.json'), 'utf8')).cache).length, 1);
  await service.close();
  await fs.writeFile(path.join(dataDir, 'lyrics', 'state.json'), '{broken');
  const reopened = createLyricsService({ dataDir, getTrack: id => tracks.get(id), getSettings: () => ({ lyrics: { onlineEnabled: false } }) });
  t.after(() => reopened.close());
  const initialized = await reopened.initialize();
  assert.match(initialized.warning, /损坏/);
  assert.ok((await fs.readdir(path.join(dataDir, 'lyrics'))).some(name => name.startsWith('state-corrupt-')));
});

test('network timeout, response bounds and Retry-After are enforced', async () => {
  const timeoutClient = createLrclibClient({ fetchImpl: async () => new Promise(() => {}), timeoutMs: 20, minRequestIntervalMs: 0 });
  await assert.rejects(timeoutClient.request('get', {}), error => error.status === 'network-error' && error.code === 'TIMEOUT');
  timeoutClient.close();
  const bounded = createLrclibClient({ fetchImpl: async () => response({ lyrics: 'x'.repeat(1000) }), maxResponseBytes: 40, minRequestIntervalMs: 0 });
  await assert.rejects(bounded.request('get'), /上限/);
  bounded.close();
  const invalidUtf8 = createLrclibClient({ fetchImpl: async () => new Response(Buffer.concat([Buffer.from('{"trackName":"'), Buffer.from([0xD6, 0xD0]), Buffer.from('"}')])), minRequestIntervalMs: 0 });
  await assert.rejects(invalidUtf8.request('get'), error => error.status === 'parse-error');
  invalidUtf8.close();
  let calls = 0;
  const rate = createLrclibClient({ fetchImpl: async () => { calls += 1; return response({}, 429, { 'retry-after': '60' }); }, minRequestIntervalMs: 0 });
  await assert.rejects(rate.request('search'), error => error.code === 'RATE_LIMITED');
  await assert.rejects(rate.request('search'), error => error.code === 'RATE_LIMITED');
  assert.equal(calls, 1);
  rate.close();
});

test('network requests identify the app and run sequentially; source IDs cannot become arbitrary URLs', async t => {
  let active = 0, maximum = 0;
  const client = createLrclibClient({ fetchImpl: async (url, options) => {
    assert.match(options.headers['User-Agent'], /^STILL\//);
    active += 1; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active -= 1;
    return response([]);
  }, minRequestIntervalMs: 0 });
  await Promise.all([client.request('search', { q: 'a' }), client.request('search', { q: 'b' })]);
  assert.equal(maximum, 1);
  client.close();
  const { service } = await fixture(t, async () => response(record(1)));
  await assert.rejects(service.preview({ trackId: 'a', candidate: { id: 'https://bad.test/lyrics' } }), /LRCLIB/);
  assert.equal(createSearchingDocument('a').status, 'searching');
});

test('new preview invalidates the previous preview; reading a preview does not cancel a binding', async t => {
  const gate = deferred(), started = deferred();
  const { service } = await fixture(t, async url => {
    if (url.endsWith('/get/1')) { started.resolve(); await gate.promise; }
    return response(record(Number(url.split('/').at(-1)) || 2));
  });
  const old = service.preview({ trackId: 'a', candidate: { sourceId: 1 } });
  await started.promise;
  const latest = service.preview({ trackId: 'a', candidate: { sourceId: 2 } });
  gate.resolve();
  assert.equal((await old).superseded, true);
  assert.equal((await latest).sourceId, 2);
  const binding = service.bind({ trackId: 'a', candidate: { sourceId: 3 } });
  const preview = service.preview({ trackId: 'a', candidate: { sourceId: 4 } });
  assert.equal((await binding).sourceId, 3);
  assert.equal((await preview).sourceId, 4);
  assert.equal((await service.resolve({ trackId: 'a' })).sourceId, 3);
});

test('obsolete search errors and previews cannot publish after a newer search', async t => {
  const gate = deferred(), started = deferred();
  const { service } = await fixture(t, async url => {
    const parsed = new URL(url);
    if (parsed.searchParams.get('q') === 'old') { started.resolve(); await gate.promise; throw new Error('old connection failed'); }
    if (parsed.pathname.endsWith('/search')) return response([record(2)]);
    return response(record(3));
  });
  const old = service.search({ trackId: 'a', query: 'old' });
  await started.promise;
  const latest = service.search({ trackId: 'a', query: 'new' });
  gate.resolve();
  assert.equal((await old).superseded, true);
  assert.equal((await latest).status, 'ready');

  const previewGate = deferred(), previewStarted = deferred();
  const other = await fixture(t, async url => {
    if (url.endsWith('/get/8')) { previewStarted.resolve(); await previewGate.promise; return response(record(8)); }
    if (url.includes('/search?')) return response([record(1)]);
    return response(record(1));
  });
  const preview = other.service.preview({ trackId: 'a', candidate: { sourceId: 8 } });
  await previewStarted.promise;
  const search = other.service.search({ trackId: 'a', query: 'fresh' });
  previewGate.resolve();
  assert.equal((await preview).superseded, true);
  assert.equal((await search).status, 'ready');
});

test('unbind supersedes a pending bind and a concurrent resolve waits for the unbound document', async t => {
  const gate = deferred(), started = deferred();
  const { service } = await fixture(t, async url => {
    if (url.endsWith('/get/9')) { started.resolve(); await gate.promise; return response(record(9)); }
    return response(record(1));
  });
  const binding = service.bind({ trackId: 'a', candidate: { sourceId: 9 } });
  await started.promise;
  const unbinding = service.unbind({ trackId: 'a' });
  // Allow unbind's track validation to begin its revision before scheduling the read.
  await new Promise(resolve => setImmediate(resolve));
  const resolving = service.resolve({ trackId: 'a' });
  gate.resolve();
  assert.equal((await binding).superseded, true);
  for (const document of await Promise.all([unbinding, resolving])) {
    assert.equal(document.bound, false);
    assert.equal(document.sourceId, 1);
  }
});

test('metadata changed during a fetch cannot relabel old lyrics or persist them for the new track version', async t => {
  const gate = deferred(), started = deferred();
  const { service, tracks, dataDir } = await fixture(t, async () => { started.resolve(); await gate.promise; return response(record(1)); });
  const resolving = service.resolve({ trackId: 'a' });
  await started.promise;
  tracks.get('a').title = 'Song (Live)';
  tracks.get('a').subsong = 1;
  gate.resolve();
  const document = await resolving;
  assert.equal(document.superseded, true);
  assert.equal(document.reason, 'track-changed');
  assert.equal(document.lines.length, 0);
  await assert.rejects(fs.readFile(path.join(dataDir, 'lyrics', 'state.json')), { code: 'ENOENT' });
});

test('cache reads and offset changes cannot reuse the old version after an asynchronous metadata change', async t => {
  const gate = deferred(), started = deferred();
  let holdSettings = false;
  const preferences = { lyrics: { onlineEnabled: true, cacheEnabled: true } };
  const { service, tracks } = await fixture(t, async () => response(record(1)), {
    getSettings: async () => {
      if (holdSettings) { holdSettings = false; started.resolve(); await gate.promise; }
      return preferences;
    },
  });
  await service.resolve({ trackId: 'a' });
  holdSettings = true;
  const cached = service.resolve({ trackId: 'a' });
  await started.promise;
  tracks.get('a').title = 'Song (Live)';
  gate.resolve();
  const stale = await cached;
  assert.equal(stale.superseded, true);
  assert.equal(stale.reason, 'track-changed');
  assert.equal(stale.lines.length, 0);
  preferences.lyrics.onlineEnabled = false;
  const offset = await service.setOffset({ trackId: 'a', offsetMs: 250 });
  assert.equal(offset.status, 'not-found');
  assert.equal(offset.offsetMs, 250);
  assert.equal(offset.lines.length, 0);
});

test('plain sidecar translations and Chinese GBK local files survive binding and offline restart', async t => {
  const { service, folder, dataDir, tracks } = await fixture(t, async () => { throw new Error('offline'); });
  const imported = path.join(folder, 'chosen.lrc');
  await fs.writeFile(imported, Buffer.concat([Buffer.from('[00:01]'), Buffer.from([0xD6, 0xD0, 0xCE, 0xC4])]));
  await fs.writeFile(path.join(folder, 'chosen.translation.txt'), 'Chinese text');
  let document = await service.importFile({ trackId: 'a', path: imported });
  assert.equal(document.lines[0].text, '中文');
  assert.equal(document.plainTranslation, 'Chinese text');
  assert.equal(document.lines[0].translation, undefined);
  document = await service.setOffset({ trackId: 'a', offsetMs: 350 });
  // Renderer compares audioMs - offsetMs to the unchanged source timestamp: positive delays by 350 ms.
  assert.equal(document.lines[0].startMs + document.offsetMs, 1350);
  await service.close();
  const reopened = createLyricsService({ dataDir, getTrack: id => tracks.get(id), getSettings: () => ({ lyrics: { onlineEnabled: false, cacheEnabled: false } }) });
  t.after(() => reopened.close());
  document = await reopened.resolve({ trackId: 'a' });
  assert.equal(document.offsetMs, 350);
  assert.equal(document.lines[0].startMs, 1000);
  assert.equal(document.plainTranslation, 'Chinese text');
});

test('failed persistent edits roll back and cannot leak through a later successful edit on another track', async t => {
  const gate = deferred(), started = deferred();
  const { service, folder, dataDir, tracks } = await fixture(t, async url => {
    if (url.endsWith('/get/2')) { started.resolve(); await gate.promise; }
    return response(record(2, url.includes('/get?') && new URL(url).searchParams.get('track_name') === 'Other' ? 'Other' : 'Song'));
  });
  const first = path.join(folder, 'first.lrc'), second = path.join(folder, 'second.lrc');
  await fs.writeFile(first, '[00:01]Original binding');
  await fs.writeFile(second, '[00:01]Uncommitted import');
  const otherSidecar = path.join(folder, 'Other.txt');
  await fs.writeFile(otherSidecar, 'Other local lyrics');
  await service.resolve({ trackId: 'b' });
  await service.importFile({ trackId: 'a', path: first });
  await service.setOffset({ trackId: 'a', offsetMs: 120 });
  const pendingBinding = service.bind({ trackId: 'a', candidate: { sourceId: 2 } });
  await started.promise;
  await service.setOffset({ trackId: 'b', offsetMs: -25 }); // B commits successfully while A is still fetching.
  const statePath = path.join(dataDir, 'lyrics', 'state.json'), backup = path.join(dataDir, 'lyrics', 'last-good.json');
  await fs.rename(statePath, backup);
  await fs.mkdir(statePath); // A directory at the destination makes atomic replacement fail on all supported platforms.
  const failedBinding = assert.rejects(pendingBinding);
  gate.resolve();
  await failedBinding;
  await assert.rejects(service.importFile({ trackId: 'a', path: second }));
  await assert.rejects(service.setOffset({ trackId: 'a', offsetMs: 999 }));
  await assert.rejects(service.unbind({ trackId: 'a' }));
  let document = await service.resolve({ trackId: 'a' });
  assert.equal(document.lines[0].text, 'Original binding');
  assert.equal(document.offsetMs, 120);
  await fs.rm(otherSidecar);
  const downloaded = await service.resolve({ trackId: 'b' });
  assert.equal(downloaded.status, 'ready');
  assert.match(downloaded.cacheWarning, /保存失败/);
  await fs.rmdir(statePath);
  await fs.rename(backup, statePath);
  await service.setOffset({ trackId: 'b', offsetMs: -25 });
  await service.close();
  const reopened = createLyricsService({ dataDir, getTrack: id => tracks.get(id), getSettings: () => ({ lyrics: { onlineEnabled: false } }) });
  t.after(() => reopened.close());
  document = await reopened.resolve({ trackId: 'a' });
  assert.equal(document.lines[0].text, 'Original binding');
  assert.equal(document.offsetMs, 120);
  document = await reopened.resolve({ trackId: 'b' });
  assert.equal(document.status, 'not-found'); // A failed cache save did not become an in-memory or later persisted cache.
  assert.equal(document.offsetMs, -25);
});

test('forced refresh preserves good cache when a valid API record contains damaged lyric syntax', async t => {
  let calls = 0;
  const { service } = await fixture(t, async () => response(record(++calls, 'Song', calls === 1 ? {} : { syncedLyrics: '[00:99]Damaged' })));
  await service.resolve({ trackId: 'a' });
  const document = await service.resolve({ trackId: 'a', force: true });
  assert.equal(document.status, 'ready');
  assert.equal(document.fromCache, true);
  assert.equal(document.refreshStatus, 'parse-error');
  assert.equal(document.lines[0].text, 'Network one');
});

test('restored cache rejects wrong-track documents and invalid word timestamps', async t => {
  const { service, dataDir, tracks } = await fixture(t, async url => response(record(1, new URL(url).searchParams.get('track_name'))));
  await service.resolve({ trackId: 'a' });
  await service.resolve({ trackId: 'b' });
  await service.close();
  const statePath = path.join(dataDir, 'lyrics', 'state.json');
  const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
  saved.cache.a.document.trackId = 'b';
  saved.cache.b.document.kind = 'word';
  saved.cache.b.document.lines[0].words = [{ startMs: null, endMs: 1000, text: 'Invalid' }];
  await fs.writeFile(statePath, JSON.stringify(saved));
  const reopened = createLyricsService({ dataDir, getTrack: id => tracks.get(id), getSettings: () => ({ lyrics: { onlineEnabled: false } }) });
  t.after(() => reopened.close());
  assert.equal((await reopened.resolve({ trackId: 'a' })).status, 'not-found');
  assert.equal((await reopened.resolve({ trackId: 'b' })).status, 'not-found');
});

test('transient HTTP failures retry with bounded exponential delay and stop after three attempts', async () => {
  const starts = [];
  const client = createLrclibClient({ fetchImpl: async () => { starts.push(Date.now()); return response({}, 502); }, retryBaseMs: 15, minRequestIntervalMs: 0 });
  try {
    await assert.rejects(client.request('search'), { code: 'HTTP_502' });
    assert.equal(starts.length, 3);
    assert.ok(starts[1] - starts[0] >= 13);
    assert.ok(starts[2] - starts[1] >= 28);
  } finally { client.close(); }
});

test('retry recovers 503 and broken connections but never retries permanent or malformed responses', async () => {
  for (const first of [() => response({}, 503), () => { throw new TypeError('connection reset'); }]) {
    let calls = 0;
    const client = createLrclibClient({ fetchImpl: async () => ++calls === 1 ? first() : response({ id: 7 }), retryBaseMs: 0, minRequestIntervalMs: 0 });
    assert.deepEqual(await client.request('get'), { id: 7 });
    assert.equal(calls, 2); client.close();
  }
  for (const value of [() => response({}, 400), () => new Response('{bad json')]) {
    let calls = 0;
    const client = createLrclibClient({ fetchImpl: async () => { calls++; return value(); }, retryBaseMs: 0, minRequestIntervalMs: 0 });
    await assert.rejects(client.request('search'));
    assert.equal(calls, 1); client.close();
  }
});

test('retry budget bounds timeout attempts including a fetch that ignores abort', async () => {
  let calls = 0;
  const client = createLrclibClient({ fetchImpl: async () => { calls++; return new Promise(() => {}); }, timeoutMs: 1000, retryBudgetMs: 35, retryBaseMs: 0, minRequestIntervalMs: 0 });
  const started = Date.now();
  await assert.rejects(client.request('search'), { code: 'TIMEOUT' });
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 500);
  client.close();
});

test('429 seconds and HTTP-date Retry-After block queued requests without automatic retry', async () => {
  for (const retry of ['60', new Date(Date.now() + 60000).toUTCString()]) {
    let calls = 0;
    const client = createLrclibClient({ fetchImpl: async () => { calls++; return response({}, 429, { 'retry-after': retry }); }, retryBaseMs: 0, minRequestIntervalMs: 0 });
    const results = await Promise.allSettled([client.request('search'), client.request('search')]);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'RATE_LIMITED'));
    assert.equal(calls, 1); client.close();
  }
});

test('close and explicit cancellation interrupt backoff without issuing a retry', async () => {
  for (const close of [true, false]) {
    let calls = 0;
    const first = deferred();
    const controller = new AbortController();
    const client = createLrclibClient({ fetchImpl: async () => { calls++; first.resolve(); return response({}, 504); }, retryBaseMs: 1000, minRequestIntervalMs: 0 });
    const request = client.request('search', {}, { signal: controller.signal });
    await first.promise;
    await new Promise(resolve => setTimeout(resolve, 10));
    const started = Date.now();
    if (close) client.close(); else controller.abort();
    await assert.rejects(request, { code: close ? 'CLOSED' : 'CANCELLED' });
    assert.ok(Date.now() - started < 300);
    assert.equal(calls, 1); client.close();
  }
});

test('close interrupts a fetch that ignores abort and drops queued requests', async () => {
  const started = deferred(); let calls = 0;
  const client = createLrclibClient({ fetchImpl: async () => { calls++; started.resolve(); return new Promise(() => {}); }, minRequestIntervalMs: 0 });
  const first = client.request('search');
  const second = client.request('search');
  const rejected = Promise.all([assert.rejects(first, { code: 'CLOSED' }), assert.rejects(second, { code: 'CLOSED' })]);
  await started.promise; client.close(); await rejected;
  assert.equal(calls, 1);
});

test('forced refresh retains persisted good cache and error code when all 502 attempts fail', async t => {
  let calls = 0;
  const { service, dataDir } = await fixture(t, async () => ++calls === 1 ? response(record(1)) : response({}, 502));
  await service.resolve({ trackId: 'a' });
  const before = await fs.readFile(path.join(dataDir, 'lyrics', 'state.json'), 'utf8');
  const refreshed = await service.resolve({ trackId: 'a', force: true });
  assert.equal(calls, 4);
  assert.equal(refreshed.status, 'ready'); assert.equal(refreshed.fromCache, true);
  assert.equal(refreshed.refreshStatus, 'network-error'); assert.equal(refreshed.errorCode, 'HTTP_502');
  assert.equal(refreshed.lines[0].text, 'Network one');
  assert.equal(await fs.readFile(path.join(dataDir, 'lyrics', 'state.json'), 'utf8'), before);
});

test('a new resolve cancels the old generation before it retries', async t => {
  let calls = 0; const first = deferred();
  const { service } = await fixture(t, async () => {
    calls++; if (calls === 1) { first.resolve(); return response({}, 502); }
    return response(record(2));
  }, { retryBaseMs: 1000 });
  const old = service.resolve({ trackId: 'a' });
  await first.promise;
  const fresh = service.resolve({ trackId: 'a', force: true });
  assert.equal((await old).superseded, true);
  assert.equal((await fresh).sourceId, 2);
  assert.equal(calls, 2);
});

test('metadata changes during backoff prevent the next attempt and persistence', async t => {
  let calls = 0; const first = deferred();
  const { service, tracks, dataDir } = await fixture(t, async () => { calls++; first.resolve(); return response({}, 502); }, { retryBaseMs: 60 });
  const pending = service.resolve({ trackId: 'a' });
  await first.promise;
  await new Promise(resolve => setTimeout(resolve, 10));
  tracks.get('a').title = 'Different version';
  assert.equal((await pending).reason, 'track-changed');
  assert.equal(calls, 1);
  await assert.rejects(fs.readFile(path.join(dataDir, 'lyrics', 'state.json')), { code: 'ENOENT' });
});


test('superseding a search interrupts its backoff and leaves only the fresh search result', async t => {
  const first = deferred(); const queries = [];
  const { service } = await fixture(t, async url => {
    const q = new URL(url).searchParams.get('q'); queries.push(q);
    if (q === 'old') { first.resolve(); return response({}, 503); }
    return response([record(5)]);
  }, { retryBaseMs: 1000 });
  const old = service.search({ trackId: 'a', query: 'old' });
  await first.promise;
  await new Promise(resolve => setTimeout(resolve, 10));
  const fresh = service.search({ trackId: 'a', query: 'fresh' });
  assert.equal((await old).superseded, true);
  assert.equal((await fresh).results[0].sourceId, 5);
  assert.deepEqual(queries, ['old', 'fresh']);
});

test('the bounded queue rejects overflow and close settles every pending operation', async () => {
  let calls = 0;
  const started = deferred();
  const client = createLrclibClient({ fetchImpl: async () => { calls++; started.resolve(); return new Promise(() => {}); }, minRequestIntervalMs: 0 });
  const pending = Array.from({ length: 16 }, () => client.request('search'));
  const settled = Promise.allSettled(pending);
  await started.promise;
  await assert.rejects(client.request('search'), { code: 'BUSY' });
  client.close();
  const results = await settled;
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'CLOSED'));
  assert.equal(calls, 1);
});

function qqFixture(fetchImpl) {
  const calls = [];
  const fallbackClient = createQqLyricsClient({ minRequestIntervalMs: 0, timeoutMs: 1000, fetchImpl: async (url, init) => {
    const parsed = new URL(url); calls.push(parsed);
    if (fetchImpl) return fetchImpl(parsed, init);
    return response(parsed.pathname.includes('client_search') ? qqSearch() : qqLyric());
  } });
  return { fallbackClient, calls };
}
function qqSearch(extras = {}) {
  return { code: 0, data: { song: { list: [{ songmid: '004CAUsM4ZX5x5', songname: 'Song', singer: [{ name: 'Artist' }], albumname: 'Album', interval: 180, ...extras }] } } };
}
function qqLyric(text = '[00:01]Fallback one\n[00:04]Fallback two') { return { code: 0, lyric: Buffer.from(text).toString('base64') }; }

test('QQ fallback runs only after exhausted primary failure and keeps provider identity across fresh offline restart', async t => {
  let primaryCalls = 0;
  const qq = qqFixture();
  const { service, dataDir, tracks } = await fixture(t, async () => { primaryCalls++; return response({}, 502); }, qq);
  const document = await service.resolve({ trackId: 'a' });
  assert.equal(primaryCalls, 3); assert.equal(qq.calls.length, 2);
  assert.equal(document.status, 'ready'); assert.equal(document.kind, 'line'); assert.equal(document.source, 'QQ Music');
  assert.equal(document.provider, 'qq'); assert.equal(document.sourceId, 'qq:004CAUsM4ZX5x5'); assert.equal(document.sourceKey, document.sourceId);
  assert.equal(document.sourceUrl, 'https://y.qq.com/n/ryqq/songDetail/004CAUsM4ZX5x5');
  assert.equal(document.primaryStatus, 'network-error'); assert.equal(document.primaryErrorCode, 'HTTP_502');
  assert.equal(document.lines.reduce((n, line) => n + (line.words?.length || 0), 0), 0);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'lyrics', 'state.json'), 'utf8'));
  assert.equal(saved.cache.a.document.source, 'QQ Music');
  await service.close();
  const reopened = createLyricsService({ dataDir, getTrack: id => tracks.get(id), getSettings: () => ({ lyrics: { onlineEnabled: false } }), fetchImpl: async () => { throw new Error('offline should not fetch'); } });
  t.after(() => reopened.close());
  const offline = await reopened.resolve({ trackId: 'a' });
  assert.equal(offline.status, 'ready'); assert.equal(offline.fromCache, true); assert.equal(offline.source, 'QQ Music');
  assert.equal(offline.sourceId, document.sourceId); assert.deepEqual(offline.lines, document.lines);
});

test('primary success, local files, manual binding and valid cache prevent QQ requests', async t => {
  const qq = qqFixture();
  const { service, folder } = await fixture(t, async () => response(record(7)), qq);
  const primary = await service.resolve({ trackId: 'a' });
  assert.equal(primary.provider, 'lrclib'); assert.equal(primary.sourceId, 7); assert.equal(primary.sourceKey, 'lrclib:7');
  await service.resolve({ trackId: 'a' });
  await fs.writeFile(path.join(folder, 'Song.lrc'), '[00:01]Local'); await service.resolve({ trackId: 'a', force: true });
  const imported = path.join(folder, 'imported.lrc'); await fs.writeFile(imported, '[00:01]Bound');
  await service.importFile({ trackId: 'a', path: imported }); await service.resolve({ trackId: 'a', force: true });
  assert.equal(qq.calls.length, 0);
});

test('fallback is opt-in and respects online/source preferences including force', async t => {
  const plain = await fixture(t, async () => response({}, 502));
  assert.equal((await plain.service.resolve({ trackId: 'a' })).source, 'LRCLIB');
  const qq = qqFixture(); const f = await fixture(t, async () => { throw new Error('disabled'); }, qq);
  f.prefs.lyrics.onlineEnabled = false;
  assert.equal((await f.service.resolve({ trackId: 'a', force: true })).reason, 'online-disabled');
  f.prefs.lyrics.onlineEnabled = true; f.prefs.lyrics.preferredSource = 'local';
  assert.equal((await f.service.resolve({ trackId: 'a', force: true })).reason, 'source-disabled');
  assert.equal(qq.calls.length, 0);
});

test('QQ exact matching rejects versions, punctuation, artist/album/duration gaps and ambiguity', async t => {
  for (const extras of [{ songname: 'Song (Live)' }, { songname: 'Song (Remaster)' }, { songname: 'Song (Cover)' }, { songname: 'Song!' }, { singer: [{ name: 'Other' }] }, { albumname: 'Other' }, { albumname: '' }, { interval: 183 }]) {
    const qq = qqFixture(async () => response(qqSearch(extras)));
    const f = await fixture(t, async url => response(url.includes('/search?') ? [] : null, url.includes('/search?') ? 200 : 404), qq);
    // Exact get 404, then LRCLIB search [] before fallback.
    const result = await f.service.resolve({ trackId: 'a' });
    assert.equal(result.status, 'not-found'); assert.equal(qq.calls.length, 1); assert.equal(result.source, 'QQ Music');
    await assert.rejects(fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json')), { code: 'ENOENT' });
  }
  const body = qqSearch(); body.data.song.list.push({ ...body.data.song.list[0], songmid: '001OtherMid000' });
  const qq = qqFixture(async () => response(body)); const f = await fixture(t, async url => response(url.includes('/search?') ? [] : null, url.includes('/search?') ? 200 : 404), qq);
  const ambiguous = await f.service.resolve({ trackId: 'a' });
  assert.equal(ambiguous.reason, 'selection-required'); assert.equal(qq.calls.length, 1);
  f.tracks.get('b').album = '';
  await f.service.resolve({ trackId: 'b' }); assert.equal(qq.calls.length, 1);
});

test('primary not-found and damaged lyric records can recover with truthful plain QQ lyrics', async t => {
  for (const damaged of [false, true]) {
    const qq = qqFixture(async url => response(url.pathname.includes('client_search') ? qqSearch() : qqLyric('Plain source text')));
    const f = await fixture(t, async url => damaged ? response(record(1, 'Song', { syncedLyrics: '[00:99]Broken' })) : response(url.includes('/search?') ? [] : null, url.includes('/search?') ? 200 : 404), qq);
    const document = await f.service.resolve({ trackId: 'a' });
    assert.equal(document.status, 'plain'); assert.equal(document.kind, 'plain'); assert.equal(document.source, 'QQ Music');
    assert.equal(document.primaryStatus, damaged ? 'parse-error' : 'not-found'); assert.equal(document.lines.length, 0);
    assert.equal(document.timingEvidence.wordTimestamps, 0); assert.equal(document.timingEvidence.lineTimestamps, 0);
  }
});

test('QQ failure during forced refresh preserves good cache and cannot write a failure record', async t => {
  let primaryOk = true;
  const qq = qqFixture(async () => response({}, 503));
  const f = await fixture(t, async () => primaryOk ? response(record(1)) : response({}, 502), qq);
  await f.service.resolve({ trackId: 'a' }); primaryOk = false;
  const before = await fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json'), 'utf8');
  const failed = await f.service.resolve({ trackId: 'a', force: true });
  assert.equal(failed.status, 'ready'); assert.equal(failed.source, 'LRCLIB'); assert.equal(failed.fromCache, true);
  assert.equal(failed.refreshStatus, 'network-error'); assert.equal(failed.errorCode, 'HTTP_503'); assert.equal(qq.calls.length, 1);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json'), 'utf8'), before);
});

test('disabled cache does fresh QQ fallback without persistence and force refresh skips cached download', async t => {
  const qq = qqFixture(); const f = await fixture(t, async () => response({}, 502), qq);
  f.prefs.lyrics.cacheEnabled = false;
  await f.service.resolve({ trackId: 'a' }); await f.service.resolve({ trackId: 'a' }); assert.equal(qq.calls.length, 4);
  await assert.rejects(fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json')), { code: 'ENOENT' });
  f.prefs.lyrics.cacheEnabled = true;
  await f.service.resolve({ trackId: 'a' }); await f.service.resolve({ trackId: 'a' }); assert.equal(qq.calls.length, 6);
  await f.service.resolve({ trackId: 'a', force: true }); assert.equal(qq.calls.length, 8);
});

test('fast same-track switch aborts stale QQ response and never caches old lyrics', async t => {
  const gate = deferred(), started = deferred(); let gets = 0;
  const qq = qqFixture(async url => {
    if (url.pathname.includes('client_search')) return response(qqSearch());
    gets++; if (gets === 1) { started.resolve(); await gate.promise; return response(qqLyric('[00:01]Stale')); }
    return response(qqLyric('[00:01]Fresh'));
  });
  const f = await fixture(t, async () => response({}, 502), qq);
  const old = f.service.resolve({ trackId: 'a' }); await started.promise;
  const fresh = f.service.resolve({ trackId: 'a', force: true });
  assert.equal((await old).superseded, true); gate.resolve();
  assert.equal((await fresh).lines[0].text, 'Fresh');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json'), 'utf8')).cache.a.document.lines[0].text, 'Fresh');
});

test('metadata change during QQ fetch prevents publication and persistence; close cancels fallback', async t => {
  const gate = deferred(), started = deferred();
  const qq = qqFixture(async url => {
    if (url.pathname.includes('client_search')) return response(qqSearch());
    started.resolve(); await gate.promise; return response(qqLyric());
  });
  const f = await fixture(t, async () => response({}, 502), qq);
  const old = f.service.resolve({ trackId: 'a' }); await started.promise;
  f.tracks.get('a').title = 'Song (Live)'; gate.resolve();
  const changed = await old; assert.equal(changed.reason, 'track-changed'); assert.equal(changed.lines.length, 0);
  await assert.rejects(fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json')), { code: 'ENOENT' });
  const active = deferred(); const closingQq = qqFixture(async () => { active.resolve(); return new Promise(() => {}); });
  const closing = await fixture(t, async () => response({}, 502), closingQq);
  const pending = closing.service.resolve({ trackId: 'a' }); await active.promise; await closing.service.close();
  assert.equal((await pending).superseded, true);
});

test('legacy numeric LRCLIB binding still works and qualified QQ identities cannot alias LRCLIB', async t => {
  const f = await fixture(t, async url => response(record(Number(url.split('/').at(-1)) || 1)));
  const legacy = await f.service.bind({ trackId: 'a', candidate: { sourceId: 42 } }); assert.equal(legacy.sourceId, 42); assert.equal(legacy.source, 'LRCLIB');
  await assert.rejects(f.service.preview({ trackId: 'b', candidate: { id: 'qq:42', sourceId: 42 } }), /LRCLIB/);
  await assert.rejects(f.service.preview({ trackId: 'b', candidate: { sourceId: 42, provider: 'qq' } }), /LRCLIB/);
  await f.service.close();
  const statePath = path.join(f.dataDir, 'lyrics', 'state.json'); const saved = JSON.parse(await fs.readFile(statePath));
  delete saved.bindings.a.document.provider; delete saved.bindings.a.document.sourceKey; await fs.writeFile(statePath, JSON.stringify(saved));
  const reopened = createLyricsService({ dataDir: f.dataDir, getTrack: id => f.tracks.get(id), getSettings: () => ({ lyrics: { onlineEnabled: false } }) });
  t.after(() => reopened.close()); assert.equal((await reopened.resolve({ trackId: 'a' })).sourceId, 42);
});

test('ambiguous primary results do not bypass user version selection through QQ', async t => {
  const qq = qqFixture();
  const f = await fixture(t, async url => response(url.includes('/search?') ? [record(1), record(2)] : null, url.includes('/search?') ? 200 : 404), qq);
  assert.equal((await f.service.resolve({ trackId: 'a' })).reason, 'selection-required'); assert.equal(qq.calls.length, 0);
});

test('QQ match normalizes width/case/space and accepts only the two-second duration boundary', async t => {
  const qq = qqFixture(async url => response(url.pathname.includes('client_search') ? qqSearch({ songname: ' Ｓｏｎｇ ', singer: [{ name: ' ARTIST ' }], albumname: ' album ', interval: 182 }) : qqLyric()));
  const f = await fixture(t, async () => response({}, 502), qq);
  const document = await f.service.resolve({ trackId: 'a' }); assert.equal(document.status, 'ready'); assert.equal(document.source, 'QQ Music');
  // Preserve the real provider metadata, even though comparison normalized it.
  assert.equal(document.title, ' Ｓｏｎｇ '); assert.equal(document.duration, 182);
});

test('injected QQ adapter cannot substitute song ID or version after exact selection', async t => {
  let gets = 0;
  const record = { provider: 'qq', id: 'qq:004CAUsM4ZX5x5', songmid: '004CAUsM4ZX5x5', trackName: 'Song', artistName: 'Artist', albumName: 'Album', duration: 180 };
  const fallbackClient = { async search() { return [record]; }, async get() { gets++; return { ...record, albumName: 'Other', syncedLyrics: '[00:01]Wrong version' }; }, close() {} };
  const f = await fixture(t, async () => response({}, 502), { fallbackClient });
  assert.equal((await f.service.resolve({ trackId: 'a' })).status, 'parse-error'); assert.equal(gets, 1);
  await assert.rejects(fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json')), { code: 'ENOENT' });
});

test('restored source identity mismatch is rejected without altering legacy cache support', async t => {
  const qq = qqFixture(); const f = await fixture(t, async () => response({}, 502), qq);
  await f.service.resolve({ trackId: 'a' }); await f.service.close();
  const statePath = path.join(f.dataDir, 'lyrics', 'state.json'); const saved = JSON.parse(await fs.readFile(statePath));
  saved.cache.a.document.source = 'LRCLIB'; await fs.writeFile(statePath, JSON.stringify(saved));
  const reopened = createLyricsService({ dataDir: f.dataDir, getTrack: id => f.tracks.get(id), getSettings: () => ({ lyrics: { onlineEnabled: false } }) });
  t.after(() => reopened.close()); assert.equal((await reopened.resolve({ trackId: 'a' })).status, 'not-found');
});

test('late ignored-abort QQ lyrics cannot publish or persist after timeout and continued resolve pressure', async t => {
  const lyricGate = deferred(); let calls = 0;
  const fallbackClient = createQqLyricsClient({ timeoutMs: 20, minRequestIntervalMs: 0, fetchImpl: async url => {
    calls++; return new URL(url).pathname.includes('client_search') ? response(qqSearch()) : lyricGate.promise;
  } });
  const f = await fixture(t, async () => response({}, 502), { fallbackClient });
  const old = await f.service.resolve({ trackId: 'a' }); assert.equal(old.status, 'network-error'); assert.equal(old.errorCode, 'TIMEOUT');
  const next = await f.service.resolve({ trackId: 'a', force: true }); assert.equal(next.status, 'network-error'); assert.equal(next.errorCode, 'TIMEOUT');
  assert.equal(calls, 2); // One completed search, one still-unsettled lyric fetch.
  await f.service.close(); lyricGate.resolve(response(qqLyric('[00:01]Late source lyric')));
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(old.lines.length, 0); assert.equal(next.lines.length, 0); assert.equal(calls, 2);
  await assert.rejects(fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json')), { code: 'ENOENT' });
});

test('LRCLIB ignored-abort fetch and pending late body cancellation cannot start a retry or another physical request', async () => {
  const fetchGate = deferred(), cancelGate = deferred(), cancelling = deferred(); let calls = 0;
  const client = createLrclibClient({timeoutMs: 15, retryBudgetMs: 100, retryBaseMs: 0, minRequestIntervalMs: 0,
    fetchImpl: async () => {calls++; return fetchGate.promise;}});
  try {
    await assert.rejects(client.request('search'), {code: 'TIMEOUT'});
    assert.equal(calls, 1);
    fetchGate.resolve({body: {cancel() {cancelling.resolve(); return cancelGate.promise;}}});
    await cancelling.promise;
    await assert.rejects(client.request('search'), {code: 'TIMEOUT'}); assert.equal(calls, 1);
  } finally {client.close(); cancelGate.resolve();}
});

test('LRCLIB stalled read and cancellation remain one physical task while logical retries expire', async () => {
  const read = deferred(), cancel = deferred(), cancelling = deferred(); let calls = 0, cancels = 0, released = 0;
  const client = createLrclibClient({timeoutMs: 15, retryBudgetMs: 100, retryBaseMs: 0, minRequestIntervalMs: 0,
    fetchImpl: async () => {calls++; return {status: 200, ok: true, headers: new Headers(), body: {getReader: () => ({
      read: () => read.promise, cancel() {cancels++; cancelling.resolve(); return cancel.promise;}, releaseLock() {released++;}
    })}};}});
  await assert.rejects(client.request('search'), {code: 'TIMEOUT'}); await cancelling.promise;
  read.resolve({done: true}); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(client.request('search'), {code: 'TIMEOUT'});
  assert.equal(calls, 1); assert.equal(cancels, 1); assert.equal(released, 0);
  client.close(); cancel.resolve(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, 1);
});

test('late ignored-abort primary response cannot publish, persist or start retries after timeout', async t => {
  const gate = deferred(); let calls = 0;
  const f = await fixture(t, async () => {calls++; return gate.promise;}, {timeoutMs: 15, retryBudgetMs: 80, retryBaseMs: 0});
  const old = await f.service.resolve({trackId: 'a'});
  assert.equal(old.status, 'network-error'); assert.equal(old.errorCode, 'TIMEOUT');
  const next = await f.service.resolve({trackId: 'a', force: true}); assert.equal(next.errorCode, 'TIMEOUT'); assert.equal(calls, 1);
  gate.resolve(response(record(7)));
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(old.lines.length, 0); assert.equal(next.lines.length, 0); assert.equal(calls, 1);
  await assert.rejects(fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json')), {code: 'ENOENT'});
});

function ioFailure(operation) {return Object.assign(new Error(`injected ${operation} failure`), {code: 'EACCES'});}
function failTemporaryIO(operation, enabled = () => true) {
  return {...fs,
    async open(file, ...args) {
      const temporary = /state-[a-f0-9-]{36}\.tmp$/.test(String(file));
      if (temporary && operation === 'open' && enabled()) throw ioFailure(operation);
      const handle = await fs.open(file, ...args);
      return new Proxy(handle, {get(target, key) {
        if (temporary && key === operation && enabled()) return async () => {throw ioFailure(operation);};
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }});
    },
    async rename(from, to) {if (operation === 'rename' && enabled()) throw ioFailure(operation); return fs.rename(from, to);}
  };
}
function reopened(t, f, extra = {}) {
  const service = createLyricsService({dataDir: f.dataDir, getTrack: id => f.tracks.get(id), getSettings: () => f.prefs,
    fetchImpl: async url => response(record(18, new URL(url).searchParams.get('track_name') || 'Song')), minRequestIntervalMs: 0, ...extra});
  t.after(() => service.close()); return service;
}

test('mkdir failure leaves a usable read-only lyrics service with explicit mutation errors and cache warnings', async t => {
  const f = await fixture(t, async () => response(record(1))); await f.service.close();
  await fs.writeFile(path.join(f.folder, 'Song.lrc'), '[00:01]Read-only local');
  const service = reopened(t, f, {fsImpl: {...fs, async mkdir() {throw ioFailure('mkdir');}}});
  assert.match((await service.initialize()).warning, /不可写/);
  assert.equal((await service.resolve({trackId: 'a'})).lines[0].text, 'Read-only local');
  const online = await service.resolve({trackId: 'b'}); assert.equal(online.status, 'ready'); assert.match(online.cacheWarning, /保存失败/);
  for (const mutate of [() => service.setOffset({trackId: 'a', offsetMs: 120}), () => service.unbind({trackId: 'a'}),
    () => service.bind({trackId: 'a', candidate: {id: 18}}), () => service.importFile({trackId: 'a', path: path.join(f.folder, 'Song.lrc')})]) {
    await assert.rejects(mutate(), {code: 'LYRICS_STORAGE_READ_ONLY'});
  }
  await assert.rejects(fs.readFile(path.join(f.dataDir, 'lyrics', 'state.json')), {code: 'ENOENT'});
});

for (const operation of ['open', 'writeFile', 'sync', 'rename']) {
  test(`corrupt state recovery ${operation} failure preserves original bytes and makes storage read-only`, async t => {
    const f = await fixture(t, async () => response(record(1))); await f.service.close();
    const statePath = path.join(f.dataDir, 'lyrics', 'state.json'), corrupt = Buffer.from('{broken\xff', 'latin1');
    await fs.writeFile(statePath, corrupt);
    const service = reopened(t, f, {fsImpl: failTemporaryIO(operation)});
    assert.match((await service.initialize()).warning, /不可写/);
    assert.deepEqual(await fs.readFile(statePath), corrupt);
    await assert.rejects(service.setOffset({trackId: 'a', offsetMs: 30}), {code: 'LYRICS_STORAGE_READ_ONLY'});
    const online = await service.resolve({trackId: 'a'}); assert.equal(online.status, 'ready'); assert.ok(online.cacheWarning);
    assert.deepEqual(await fs.readFile(statePath), corrupt);
    assert.ok((await fs.readdir(path.dirname(statePath))).every(file => !file.endsWith('.tmp')));
  });
}

test('corrupt state replacement failure retains the completed recovery copy and the original', async t => {
  const f = await fixture(t, async () => response(record(1))); await f.service.close();
  const folder = path.join(f.dataDir, 'lyrics'), statePath = path.join(folder, 'state.json');
  const corrupt = '{not-json'; await fs.writeFile(statePath, corrupt);
  const service = reopened(t, f, {fsImpl: {...fs, async rename(from, to) {
    if (to === statePath) throw ioFailure('state replacement'); return fs.rename(from, to);
  }}});
  assert.match((await service.initialize()).warning, /不可写/); assert.equal(await fs.readFile(statePath, 'utf8'), corrupt);
  const copies = (await fs.readdir(folder)).filter(name => name.startsWith('state-corrupt-'));
  assert.equal(copies.length, 1); assert.equal(await fs.readFile(path.join(folder, copies[0]), 'utf8'), corrupt);
  await assert.rejects(service.setOffset({trackId: 'a', offsetMs: 30}), {code: 'LYRICS_STORAGE_READ_ONLY'});
});

test('five repeated state replacement failures retain at most three complete recovery copies and preserve the original every time', async t => {
  const f = await fixture(t, async () => response(record(1))); await f.service.close();
  const folder = path.join(f.dataDir, 'lyrics'), statePath = path.join(folder, 'state.json');
  const corrupt = Buffer.from('{original-corrupt\xff', 'latin1'); await fs.writeFile(statePath, corrupt);
  const seen = new Set();
  for (let attempt = 0; attempt < 5; attempt++) {
    const service = reopened(t, f, {fsImpl: {...fs, async rename(from, to) {
      if (to === statePath) throw ioFailure('state replacement'); return fs.rename(from, to);
    }}});
    assert.match((await service.initialize()).warning, /不可写/);
    assert.deepEqual(await fs.readFile(statePath), corrupt);
    const copies = (await fs.readdir(folder)).filter(name => name.startsWith('state-corrupt-'));
    assert.equal(copies.length, Math.min(attempt + 1, 3));
    const newest = copies.filter(file => !seen.has(file)); assert.equal(newest.length, 1);
    assert.deepEqual(await fs.readFile(path.join(folder, newest[0])), corrupt);
    copies.forEach(file => seen.add(file));
    await service.close();
  }
});

test('recovery retention failure explicitly warns that the copy count is not bounded while preserving the newest copy', async t => {
  const f = await fixture(t, async () => response(record(1))); await f.service.close();
  const folder = path.join(f.dataDir, 'lyrics'), statePath = path.join(folder, 'state.json'), corrupt = '{corrupt-for-retention';
  for (let index = 1; index <= 3; index++) await fs.writeFile(path.join(folder, `state-corrupt-${index}.json`), `old ${index}`);
  await fs.writeFile(statePath, corrupt);
  const service = reopened(t, f, {fsImpl: {...fs, async unlink(file) {
    if (path.basename(file).startsWith('state-corrupt-')) throw ioFailure('retention'); return fs.unlink(file);
  }}});
  const initialized = await service.initialize(); assert.match(initialized.warning, /数量可能超过 3/);
  const copies = (await fs.readdir(folder)).filter(file => file.startsWith('state-corrupt-')); assert.equal(copies.length, 4);
  const newest = copies.find(file => !/^state-corrupt-[123]\.json$/.test(file));
  assert.equal(await fs.readFile(path.join(folder, newest), 'utf8'), corrupt);
  assert.equal(JSON.parse(await fs.readFile(statePath)).version, 1);
});

for (const operation of ['open', 'writeFile', 'sync', 'rename']) {
  test(`atomic state ${operation} failure neither changes the saved file nor leaks failed edits`, async t => {
    const f = await fixture(t, async () => response(record(1))); await f.service.close();
    let failing = false;
    const service = reopened(t, f, {fsImpl: failTemporaryIO(operation, () => failing)});
    await service.initialize(); await service.setOffset({trackId: 'a', offsetMs: 100});
    const statePath = path.join(f.dataDir, 'lyrics', 'state.json'), before = await fs.readFile(statePath);
    failing = true;
    await assert.rejects(service.setOffset({trackId: 'b', offsetMs: 999}), {code: 'EACCES'});
    assert.deepEqual(await fs.readFile(statePath), before);
    assert.ok((await fs.readdir(path.dirname(statePath))).every(file => !file.endsWith('.tmp')));
    failing = false; await service.setOffset({trackId: 'a', offsetMs: 101});
    const saved = JSON.parse(await fs.readFile(statePath)); assert.equal(saved.offsets.a, 101); assert.equal(saved.offsets.b, undefined);
  });
}

test('corrupt state recovery keeps the newest complete bytes and bounds recovery copies after successful replacement', async t => {
  const f = await fixture(t, async () => response(record(1))); await f.service.close();
  const folder = path.join(f.dataDir, 'lyrics'), statePath = path.join(folder, 'state.json');
  for (let index = 1; index <= 5; index++) {
    const file = path.join(folder, `state-corrupt-${index}.json`); await fs.writeFile(file, `old ${index}`);
    await fs.utimes(file, new Date(index * 1000), new Date(index * 1000));
  }
  const corrupt = '{latest-corrupt'; await fs.writeFile(statePath, corrupt);
  const service = reopened(t, f); assert.match((await service.initialize()).warning, /已保留副本/);
  const copies = (await fs.readdir(folder)).filter(name => name.startsWith('state-corrupt-'));
  assert.equal(copies.length, 3);
  const contents = await Promise.all(copies.map(file => fs.readFile(path.join(folder, file), 'utf8')));
  assert.ok(contents.includes(corrupt)); assert.ok(contents.includes('old 5')); assert.ok(contents.includes('old 4'));
  assert.deepEqual(JSON.parse(await fs.readFile(statePath)).bindings, {});
  await service.setOffset({trackId: 'a', offsetMs: 50}); assert.equal(JSON.parse(await fs.readFile(statePath)).offsets.a, 50);
});

test('an unsupported state shape is backed up and replaced without replaying invalid fields', async t => {
  const f = await fixture(t, async () => response(record(1))); await f.service.close();
  const statePath = path.join(f.dataDir, 'lyrics', 'state.json');
  await fs.writeFile(statePath, JSON.stringify({version: 2, bindings: {}, offsets: {a: 999}, cache: {}}));
  const service = reopened(t, f); assert.match((await service.initialize()).warning, /已保留副本/);
  const document = await service.resolve({trackId: 'a'}); assert.equal(document.offsetMs, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath)).offsets, {});
});

test('manual bindings and offsets survive automatic cache pressure without an LRU eviction policy', async t => {
  const f = await fixture(t, async () => response(record(1)), {maxCacheEntries: 1});
  const imported = path.join(f.folder, 'manual.lrc'); await fs.writeFile(imported, '[00:01]Manual snapshot');
  await f.service.importFile({trackId: 'a', path: imported}); await f.service.setOffset({trackId: 'a', offsetMs: 111});
  await f.service.close();
  const statePath = path.join(f.dataDir, 'lyrics', 'state.json'), saved = JSON.parse(await fs.readFile(statePath));
  for (let index = 0; index < 140; index++) {
    const id = `manual-${index}`;
    saved.bindings[id] = {...saved.bindings.a, document: {...saved.bindings.a.document, trackId: id}}; saved.offsets[id] = index;
  }
  await fs.writeFile(statePath, JSON.stringify(saved));
  const service = reopened(t, f, {maxCacheEntries: 1}); await service.initialize();
  await service.resolve({trackId: 'b'}); await service.setOffset({trackId: 'b', offsetMs: 222});
  const after = JSON.parse(await fs.readFile(statePath));
  assert.equal(Object.keys(after.bindings).length, 141); assert.equal(Object.keys(after.offsets).length, 142);
  assert.equal(after.bindings['manual-139'].document.lines[0].text, 'Manual snapshot'); assert.equal(after.offsets['manual-139'], 139);
  assert.ok(Object.keys(after.cache).length <= 1);
});

function replaceTemporaryAfterClose(selectedWrite, sameBytes) {
  let writes = 0;
  return {...fs, async open(file, flags, ...args) {
    const handle = await fs.open(file, flags, ...args);
    const target = /state-[a-f0-9-]{36}\.tmp$/.test(String(file)) && (flags & 1) && ++writes === selectedWrite;
    if (!target) return handle;
    return new Proxy(handle, {get(current, key) {
      if (key === 'close') return async () => {
        await current.close();
        const bytes = await fs.readFile(file);
        await fs.rename(file, `${file}.held-original`);
        await fs.writeFile(file, sameBytes ? bytes : Buffer.alloc(bytes.length, 88));
      };
      const value = Reflect.get(current, key, current);
      return typeof value === 'function' ? value.bind(current) : value;
    }});
  }};
}

for (const sameBytes of [false, true]) for (const selectedWrite of [1, 2]) {
  test(`recovery refuses ${sameBytes ? 'same bytes with a different inode' : 'changed bytes'} in the ${selectedWrite === 1 ? 'backup' : 'state replacement'} temporary file`, async t => {
    const f = await fixture(t, async () => response(record(1))); await f.service.close();
    const statePath = path.join(f.dataDir, 'lyrics', 'state.json'), corrupt = '{corrupt-original';
    await fs.writeFile(statePath, corrupt);
    const service = reopened(t, f, {fsImpl: replaceTemporaryAfterClose(selectedWrite, sameBytes)});
    assert.match((await service.initialize()).warning, /不可写/);
    assert.equal(await fs.readFile(statePath, 'utf8'), corrupt);
    const backups = (await fs.readdir(path.dirname(statePath))).filter(file => file.startsWith('state-corrupt-'));
    assert.equal(backups.length, selectedWrite - 1);
    if (backups.length) assert.equal(await fs.readFile(path.join(path.dirname(statePath), backups[0]), 'utf8'), corrupt);
    await assert.rejects(service.setOffset({trackId: 'a', offsetMs: 10}), {code: 'LYRICS_STORAGE_READ_ONLY'});
  });
}

test('state loading rejects a named file replaced while its original handle is being read', async t => {
  const f = await fixture(t, async () => response(record(1))); await f.service.close();
  const statePath = path.join(f.dataDir, 'lyrics', 'state.json');
  await fs.writeFile(statePath, JSON.stringify({version: 1, bindings: {}, offsets: {a: 777}, cache: {}}));
  let replaced = false;
  const io = {...fs, async open(file, ...args) {
    const handle = await fs.open(file, ...args);
    if (file !== statePath) return handle;
    return new Proxy(handle, {get(current, key) {
      if (key === 'read') return async (...readArgs) => {
        const result = await current.read(...readArgs);
        if (!replaced) {
          replaced = true; await fs.rename(file, `${file}.held-original`);
          await fs.writeFile(file, JSON.stringify({version: 1, bindings: {}, offsets: {a: 888}, cache: {}}));
        }
        return result;
      };
      const value = Reflect.get(current, key, current);
      return typeof value === 'function' ? value.bind(current) : value;
    }});
  }};
  const service = reopened(t, f, {fsImpl: io}); assert.match((await service.initialize()).warning, /不可写/);
  const document = await service.resolve({trackId: 'a'}); assert.equal(document.offsetMs, 0); assert.ok(document.cacheWarning);
  assert.equal(JSON.parse(await fs.readFile(statePath)).offsets.a, 888);
  await assert.rejects(service.setOffset({trackId: 'a', offsetMs: 5}), {code: 'LYRICS_STORAGE_READ_ONLY'});
});

for (const directory of [false, true]) test(`initialization refuses a symbolic-link ${directory ? 'storage directory' : 'state file'} without writing`, async t => {
  const f = await fixture(t, async () => response(record(1))); await f.service.close();
  const statePath = path.join(f.dataDir, 'lyrics', 'state.json'), target = directory ? path.dirname(statePath) : statePath;
  const original = JSON.stringify({version: 1, bindings: {}, offsets: {a: 123}, cache: {}}); await fs.writeFile(statePath, original);
  let writes = 0;
  const io = {...fs, async lstat(file, options) {
    const info = await fs.lstat(file, options);
    if (file !== target) return info;
    return new Proxy(info, {get(current, key) {if (key === 'isSymbolicLink') return () => true; const value = Reflect.get(current, key, current); return typeof value === 'function' ? value.bind(current) : value;}});
  }, async rename(...args) {writes++; return fs.rename(...args);}};
  const service = reopened(t, f, {fsImpl: io}); assert.match((await service.initialize()).warning, /不可写/);
  await assert.rejects(service.setOffset({trackId: 'a', offsetMs: 7}), {code: 'LYRICS_STORAGE_READ_ONLY'});
  assert.equal(writes, 0); assert.equal(await fs.readFile(statePath, 'utf8'), original);
});

test('unsafe constructor limits cannot remove LRCLIB response or persistent state byte bounds', async t => {
  const client = createLrclibClient({maxResponseBytes: Infinity, maxAttempts: 1, minRequestIntervalMs: 0,
    fetchImpl: async () => response({}, 200, {'content-length': String(4 * 1024 * 1024 + 1)})});
  try {await assert.rejects(client.request('search'), {status: 'parse-error'});} finally {client.close();}
  const f = await fixture(t, async () => response(record(1)), {maxCacheEntries: Infinity, maxCacheBytes: Infinity});
  const document = await f.service.resolve({trackId: 'a'}); assert.equal(document.status, 'ready');
  await f.service.close();
  const statePath = path.join(f.dataDir, 'lyrics', 'state.json'), saved = JSON.parse(await fs.readFile(statePath));
  for (let index = 0; index < 260; index++) {
    const id = `automatic-${index}`; saved.cache[id] = {...saved.cache.a, document: {...saved.cache.a.document, trackId: id}};
  }
  await fs.writeFile(statePath, JSON.stringify(saved));
  const service = reopened(t, f, {maxCacheEntries: Infinity, maxCacheBytes: Infinity});
  await service.initialize(); await service.setOffset({trackId: 'a', offsetMs: 7});
  assert.equal(Object.keys(JSON.parse(await fs.readFile(statePath)).cache).length, 256);
});

function manualSnapshot(id, text = `Manual ${id}`) {
  return {savedAt: 100, wrapperExtra: {preserve: id}, document: {trackId: id, status: 'ready', kind: 'line', format: 'lrc',
    source: '手动导入', sourceUrl: null, local: true, bound: true, fromCache: false, offsetMs: 0,
    lines: [{startMs: 1000, text}], metadata: {title: id}}};
}

// Preserve exact native keys inside the adapter, but expose two neighboring
// synthetic FileIDs as the same default Number. Every stat option is forwarded.
function exactLyricIdentityIo(field, {afterClose, unsafeNumbers = false} = {}) {
  const identities = new Map(), first = 9007199254740992n, second = first + 1n;
  const key = info => `${info.dev}:${info.ino}`;
  function present(info, native, options) {
    const id = identities.get(key(native));
    if (id === undefined) return info;
    return new Proxy(info, {get(target, member) {
      if (member === 'ino' || member === 'dev') {
        const value = member === field ? id : 17n;
        return options?.bigint && !unsafeNumbers ? value : Number(value);
      }
      if (member === 'mtimeMs') return options?.bigint ? 1000n : 1000;
      if (member === 'mtimeNs') return options?.bigint ? 1000000000n : undefined;
      const value = Reflect.get(target, member, target); return typeof value === 'function' ? value.bind(target) : value;
    }});
  }
  const assign = async (file, id) => identities.set(key(await fs.lstat(file, {bigint: true})), id);
  const io = {...fs,
    async lstat(file, options) {return present(await fs.lstat(file, options), await fs.lstat(file, {bigint: true}), options);},
    async open(file, flags, ...args) {
      const handle = await fs.open(file, flags, ...args);
      if ((flags & FS.O_WRONLY) && /state-[a-f0-9-]{36}\.tmp$/.test(String(file))) await assign(file, first);
      let didClose = false;
      return new Proxy(handle, {get(target, member) {
        if (member === 'stat') return async options => present(await target.stat(options), await target.stat({bigint: true}), options);
        if (member === 'close') return async () => {
          await target.close();
          if (!didClose) {didClose = true; await afterClose?.(file, flags, {assign, first, second});}
        };
        const value = Reflect.get(target, member, target); return typeof value === 'function' ? value.bind(target) : value;
      }});
    }
  };
  assert.notEqual(first, second); assert.equal(Number(first), Number(second));
  return {io, assign, first, second};
}

for (const field of ['ino', 'dev']) for (const warm of [false, true]) test(`exact lyric ${field} identity rejects same-byte replacement of a ${warm ? 'warm' : 'cold'} manual binding despite Number collision`, async t => {
  const f = await fixture(t, async () => {throw new Error('offline');}); await f.service.close(); f.prefs.lyrics.onlineEnabled = false;
  const statePath = path.join(f.dataDir, 'lyrics', 'state.json');
  const bytes = JSON.stringify({version: 1, bindings: {a: manualSnapshot('a'), b: manualSnapshot('b')}, offsets: {a: 10, b: 20}, cache: {}});
  await fs.writeFile(statePath, bytes);
  const mapped = exactLyricIdentityIo(field); await mapped.assign(statePath, mapped.first);
  let calls = 0;
  const service = reopened(t, f, {fsImpl: mapped.io, fetchImpl: async () => {calls++; throw new Error('offline');}});
  assert.equal((await service.initialize()).warning, undefined);
  if (warm) assert.equal((await service.resolve({trackId: 'a'})).lines[0].text, 'Manual a');
  const nativeBefore = await fs.lstat(statePath, {bigint: true});
  await fs.rename(statePath, `${statePath}.held`); await fs.writeFile(statePath, bytes); await mapped.assign(statePath, mapped.second);
  assert.notEqual((await fs.lstat(statePath, {bigint: true})).ino, nativeBefore.ino, 'the original inode remains held');
  await assert.rejects(service.resolve({trackId: 'a'}), {code: 'LYRICS_STORAGE_READ_ONLY'});
  await assert.rejects(service.setOffset({trackId: 'b', offsetMs: 77}), {code: 'LYRICS_STORAGE_READ_ONLY'});
  assert.equal(await fs.readFile(statePath, 'utf8'), bytes); assert.equal(calls, 0);
});

for (const field of ['ino', 'dev']) test(`exact lyric ${field} ownership rejects and preserves a same-byte foreign temporary file despite Number collision`, async t => {
  const f = await fixture(t, async () => {throw new Error('offline');}); await f.service.close();
  const statePath = path.join(f.dataDir, 'lyrics', 'state.json'), corrupt = '{ original corrupt lyrics';
  await fs.writeFile(statePath, corrupt);
  let replaced;
  const mapped = exactLyricIdentityIo(field, {async afterClose(file, flags, control) {
    if (replaced || !(flags & FS.O_WRONLY) || !/state-[a-f0-9-]{36}\.tmp$/.test(String(file))) return;
    const bytes = await fs.readFile(file); await fs.rename(file, `${file}.held`); await fs.writeFile(file, bytes);
    await control.assign(file, control.second); replaced = {file, bytes};
  }});
  const service = reopened(t, f, {fsImpl: mapped.io});
  assert.match((await service.initialize()).warning, /不可写/);
  assert.ok(replaced); assert.deepEqual(await fs.readFile(replaced.file), replaced.bytes, 'foreign temporary belongs to its replacement owner');
  assert.equal(await fs.readFile(statePath, 'utf8'), corrupt);
});

for (const field of ['ino', 'dev']) test(`exact lyric ${field} above Number precision supports cold and warm reads, v1 commits and public JSON`, async t => {
  const f = await fixture(t, async () => {throw new Error('offline');}); await f.service.close(); f.prefs.lyrics.onlineEnabled = false;
  const statePath = path.join(f.dataDir, 'lyrics', 'state.json');
  const seed = {version: 1, bindings: {a: manualSnapshot('a'), b: manualSnapshot('b')}, offsets: {a: 10, b: 20}, cache: {}, extra: {preserved: true}};
  await fs.writeFile(statePath, JSON.stringify(seed));
  const mapped = exactLyricIdentityIo(field); await mapped.assign(statePath, mapped.first);
  const service = reopened(t, f, {fsImpl: mapped.io, maxBindingCacheEntries: 1, fetchImpl: async () => assert.fail('manual fixture remains offline')});
  assert.equal((await service.initialize()).warning, undefined);
  for (const id of ['a', 'a', 'b', 'a']) {
    const document = await service.resolve({trackId: id});
    assert.equal(document.lines[0].text, `Manual ${id}`); assert.doesNotThrow(() => JSON.stringify(document));
  }
  const updated = await service.setOffset({trackId: 'a', offsetMs: 77});
  assert.equal(updated.offsetMs, 77); assert.doesNotThrow(() => JSON.stringify(updated));
  const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(saved.version, 1); assert.deepEqual(saved.bindings, seed.bindings); assert.deepEqual(saved.extra, seed.extra);
  assert.deepEqual(saved.offsets, {a: 77, b: 20}); assert.deepEqual(saved.cache, {});
  await service.close();
  const cold = reopened(t, f, {fsImpl: mapped.io, fetchImpl: async () => assert.fail('reopened manual fixture remains offline')});
  const result = await cold.resolve({trackId: 'a'}); assert.equal(result.offsetMs, 77); assert.equal(result.lines[0].text, 'Manual a');
  assert.doesNotThrow(() => JSON.stringify(result));
});

for (const field of ['ino', 'dev']) test(`unsafe Number-only lyric ${field} adapter fails closed instead of fabricating an exact witness`, async t => {
  const f = await fixture(t, async () => {throw new Error('offline');}); await f.service.close(); f.prefs.lyrics.onlineEnabled = false;
  const statePath = path.join(f.dataDir, 'lyrics', 'state.json'), bytes = JSON.stringify({version: 1, bindings: {a: manualSnapshot('a')}, offsets: {a: 10}, cache: {}});
  await fs.writeFile(statePath, bytes);
  const mapped = exactLyricIdentityIo(field, {unsafeNumbers: true}); await mapped.assign(statePath, mapped.first);
  const service = reopened(t, f, {fsImpl: mapped.io, fetchImpl: async () => assert.fail('unsafe storage fixture remains offline')});
  assert.match((await service.initialize()).warning, /不可写/);
  await assert.rejects(service.setOffset({trackId: 'a', offsetMs: 77}), {code: 'LYRICS_STORAGE_READ_ONLY'});
  assert.equal(await fs.readFile(statePath, 'utf8'), bytes);
});
async function bindingFixture(t, ids = ['a', 'b', 'd'], options = {}, editSeed = () => {}) {
  const f = await fixture(t, async () => {throw new Error('fixture remains offline');}); await f.service.close();
  const statePath = path.join(f.dataDir, 'lyrics', 'state.json');
  const seed = {version: 1, bindings: {}, offsets: {}, cache: {}, preservedRoot: {format: 'original v1'}};
  for (const id of ids) {
    f.tracks.set(id, {id, path: path.join(f.folder, `${id}.flac`), title: 'Song', artist: 'Artist', album: 'Album', duration: 180});
    seed.bindings[id] = manualSnapshot(id); seed.offsets[id] = 10;
  }
  editSeed(seed); await fs.writeFile(statePath, JSON.stringify(seed));
  const initialStat = await fs.lstat(statePath, {bigint: true}), events = [];
  const control = {reads: 0, activeReads: 0, maxActiveReads: 0, failOperation: null, unavailable: false, hideMtime: false, readGate: null, syncGate: null, tempReadGate: null, statGate: null};
  const statView = info => control.hideMtime ? new Proxy(info, {get(target, key) {
    if (key === 'mtimeMs') return initialStat.mtimeMs;
    if (key === 'mtimeNs') return initialStat.mtimeNs;
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  }}) : info;
  const io = {...fs,
    async lstat(file, options) {
      if (file === statePath && control.statGate) {
        const gate = control.statGate; control.statGate = null; gate.started.resolve(); await gate.allow.promise;
      }
      if (file === statePath && control.unavailable) throw ioFailure('state access');
      const info = await fs.lstat(file, options); return file === statePath ? statView(info) : info;
    },
    async open(file, flags, ...args) {
      const writing = !!(flags & FS.O_WRONLY), temporary = /state-[a-f0-9-]{36}\.tmp$/.test(String(file));
      if (temporary && writing && control.failOperation === 'open') throw ioFailure('open');
      const handle = await fs.open(file, flags, ...args), stateRead = file === statePath && !writing;
      if (stateRead) {control.reads++; control.activeReads++; control.maxActiveReads = Math.max(control.maxActiveReads, control.activeReads);}
      let didClose = false;
      return new Proxy(handle, {get(target, key) {
        if (key === 'stat' && stateRead) return async (...statArgs) => statView(await target.stat(...statArgs));
        if (key === 'read' && stateRead) return async (...readArgs) => {
          const gate = control.readGate;
          if (gate) {control.readGate = null; gate.started.resolve(); await gate.allow.promise;}
          return target.read(...readArgs);
        };
        if (key === 'read' && temporary && !writing) return async (...readArgs) => {
          const gate = control.tempReadGate;
          if (gate) {control.tempReadGate = null; gate.started.resolve(); await gate.allow.promise;}
          return target.read(...readArgs);
        };
        if (temporary && writing && ['writeFile', 'sync'].includes(key)) return async (...writeArgs) => {
          if (control.failOperation === key) throw ioFailure(key);
          const gate = key === 'sync' && control.syncGate;
          if (gate) {control.syncGate = null; gate.started.resolve(); await gate.allow.promise;}
          return target[key](...writeArgs);
        };
        if (key === 'close') return async () => {
          try {return await target.close();}
          finally {if (stateRead && !didClose) {didClose = true; control.activeReads--;}}
        };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      }});
    },
    async rename(from, to) {if (to === statePath && control.failOperation === 'rename') throw ioFailure('rename'); return fs.rename(from, to);}
  };
  f.prefs.lyrics.onlineEnabled = false;
  let networkCalls = 0;
  const suppliedObserver = options.onBindingCacheState;
  const service = createLyricsService({dataDir: f.dataDir, getTrack: id => f.tracks.get(id), getSettings: () => f.prefs,
    fetchImpl: async url => {networkCalls++; return response(record(Number(/\/get\/(\d+)$/.exec(new URL(url).pathname)?.[1]) || 18));},
    minRequestIntervalMs: 0, fsImpl: io, ...options,
    onBindingCacheState(event) {events.push(event); suppliedObserver?.(event);}});
  t.after(() => service.close());
  function block(key) {const gate = {started: deferred(), allow: deferred()}; control[key] = gate; return gate;}
  return {...f, service, statePath, seed, events, control, networkCalls: () => networkCalls,
    blockRead: () => block('readGate'), blockSync: () => block('syncGate'), blockTempRead: () => block('tempReadGate'), latest: () => events.at(-1)};
}

test('141 manual bindings initialize as a small index and a true 128-entry LRU evicts only resident bodies', async t => {
  const ids = Array.from({length: 141}, (_, index) => `m${index}`), f = await bindingFixture(t, ids);
  const initial = await f.service.initialize(), original = await fs.readFile(f.statePath);
  assert.deepEqual(Object.keys(initial), ['supportedFormats']); assert.equal(JSON.stringify(initial).includes('Manual'), false);
  assert.equal(f.latest().indexEntries, 141); assert.equal(f.latest().indexedBodies, 0); assert.equal(f.latest().bodyEntries, 0);
  for (const id of ids.slice(0, 128)) assert.equal((await f.service.resolve({trackId: id})).lines[0].text, `Manual ${id}`);
  assert.equal(f.latest().bodyEntries, 128); const beforeHit = f.control.reads;
  const exposed = await f.service.resolve({trackId: 'm0'}); exposed.lines[0].text = 'caller mutation';
  assert.equal((await f.service.resolve({trackId: 'm0'})).lines[0].text, 'Manual m0'); assert.equal(f.control.reads, beforeHit);
  await f.service.resolve({trackId: 'm128'});
  assert.equal(f.latest().bodyEntries, 128); assert.equal(f.latest().bodyKeys.includes('m1'), false); assert.equal(f.latest().bodyKeys.includes('m0'), true);
  const beforeReload = f.control.reads;
  assert.equal((await f.service.resolve({trackId: 'm1'})).lines[0].text, 'Manual m1');
  assert.equal(f.control.reads, beforeReload + 1); assert.equal(f.latest().indexEntries, 141);
  assert.ok(f.events.every(event => event.indexedBodies === 0 && event.bodyEntries <= 128 && event.bodyBytes <= 8 * 1024 * 1024));
  assert.deepEqual(await fs.readFile(f.statePath), original); assert.equal(f.networkCalls(), 0);
});

test('manual LRU byte eviction and oversize bypass cold-reload offline without a resolved-cache copy', async t => {
  const text = '正文'.repeat(400), sample = manualSnapshot('a', text).document, bytes = Buffer.byteLength(JSON.stringify(sample));
  const f = await bindingFixture(t, ['a', 'b', 'd'], {maxBindingCacheEntries: 128, maxBindingCacheBytes: bytes * 2 - 1}, seed => {
    for (const id of Object.keys(seed.bindings)) seed.bindings[id] = manualSnapshot(id, text);
  });
  await f.service.initialize(); const original = await fs.readFile(f.statePath);
  await f.service.resolve({trackId: 'a'}); await f.service.resolve({trackId: 'b'});
  assert.deepEqual(f.latest().bodyKeys, ['b']); assert.equal(f.latest().bodyEntries, 1);
  const before = f.control.reads; assert.equal((await f.service.resolve({trackId: 'a'})).lines[0].text, text);
  assert.equal(f.control.reads, before + 1); assert.deepEqual(f.latest().bodyKeys, ['a']);
  assert.ok(f.events.every(event => event.bodyBytes <= bytes * 2 - 1)); assert.deepEqual(await fs.readFile(f.statePath), original);
  const uncached = await bindingFixture(t, ['a'], {maxBindingCacheBytes: bytes - 1}, seed => {seed.bindings.a = manualSnapshot('a', text);});
  await uncached.service.initialize(); await uncached.service.resolve({trackId: 'a'});
  const first = uncached.control.reads; await uncached.service.resolve({trackId: 'a'});
  assert.equal(uncached.control.reads, first + 1); assert.equal(uncached.latest().bodyEntries, 0); assert.equal(uncached.latest().indexEntries, 1);
});

test('cold B wrapper, body and every offset survive imports, binds, cache writes, offsets and another unbind in original v1 format', async t => {
  const f = await bindingFixture(t, ['a', 'b', 'd'], {maxBindingCacheEntries: 1}, seed => {
    seed.bindings.b.document.lines[0].translation = 'Preserved translation'; seed.bindings.b.wrapperExtra.history = ['untouched'];
    seed.offsets = {a: 11, b: 222, d: -333, other: 444};
  });
  f.tracks.set('c', {id: 'c', path: path.join(f.folder, 'c.flac'), title: 'Song', artist: 'Artist', album: 'Album', duration: 180});
  await f.service.initialize(); f.prefs.lyrics.onlineEnabled = true;
  const imported = path.join(f.folder, 'replacement.lrc'); await fs.writeFile(imported, '[00:01]Replacement A');
  const assertPreserved = async () => {
    const saved = JSON.parse(await fs.readFile(f.statePath));
    assert.equal(saved.version, 1); assert.deepEqual(saved.bindings.b, f.seed.bindings.b); assert.deepEqual(saved.preservedRoot, f.seed.preservedRoot);
    assert.equal(saved.offsets.b, 222); assert.equal(saved.offsets.d, -333); assert.equal(saved.offsets.other, 444);
    assert.ok(f.events.every(event => !event.bodyKeys.includes('b')));
  };
  await f.service.importFile({trackId: 'a', path: imported}); await assertPreserved();
  await f.service.bind({trackId: 'a', candidate: {sourceId: 7}}); await assertPreserved();
  await f.service.setOffset({trackId: 'a', offsetMs: 99}); await assertPreserved();
  await f.service.resolve({trackId: 'c'}); await assertPreserved();
  await f.service.unbind({trackId: 'd'}); await assertPreserved();
  const saved = JSON.parse(await fs.readFile(f.statePath)); assert.equal(saved.bindings.d, undefined); assert.ok(saved.cache.c);
  assert.deepEqual(saved.offsets, {a: 99, b: 222, d: -333, other: 444});
  f.prefs.lyrics.onlineEnabled = false;
  const cold = await f.service.resolve({trackId: 'b'}); assert.equal(cold.lines[0].text, 'Manual b'); assert.equal(cold.lines[0].translation, 'Preserved translation'); assert.equal(cold.offsetMs, 222);
});

test('initialization and the idle I/O tail retain neither temporary full graphs nor raw manual children and never clone the full graph', async t => {
  const roots = [], children = []; let fullClones = 0;
  const realClone = globalThis.structuredClone;
  t.mock.method(globalThis, 'structuredClone', value => {
    if (value?.version === 1 && Object.values(value.bindings || {}).some(binding => binding?.document)) fullClones++;
    return realClone(value);
  });
  const f = await bindingFixture(t, ['a', 'b', 'd'], {maxBindingCacheEntries: 1, onBindingCacheState(event) {
    if (!event.temporaryGraph) return;
    roots.push(event.temporaryGraph);
    const temporary = event.temporaryGraph.deref();
    for (const id of ['a', 'b']) if (temporary?.bindings[id]?.document) children.push(new WeakRef(temporary.bindings[id].document));
  }});
  const initialized = f.service.initialize(); assert.deepEqual(Object.keys(await initialized), ['supportedFormats']);
  const selected = await f.service.resolve({trackId: 'a'});
  await f.service.setOffset({trackId: 'd', offsetMs: 80});
  assert.equal(selected.lines[0].text, 'Manual a'); assert.equal(fullClones, 0); assert.ok(roots.length >= 3); assert.ok(children.length >= 6);
  // MockTracker itself records raw clone arguments. Drop that test-owned strong
  // history before measuring service retention; keep the independent counter.
  globalThis.structuredClone.mock.resetCalls();
  await new Promise(resolve => setImmediate(resolve));
  // One explicit test-only GC request, never a retry loop or production effect.
  assert.equal(typeof queryObjects(Object, {format: 'count'}), 'number');
  assert.ok(roots.every(reference => reference.deref() === undefined), 'a full temporary state graph is retained');
  assert.ok(children.every(reference => reference.deref() === undefined), 'a raw manual child is retained instead of its detached body clone');
  assert.equal(f.latest().activeGraphs, 0); assert.equal(f.latest().activeStorageTasks, 0); assert.equal(f.latest().indexedBodies, 0);
});

for (const commitFirst of [false, true]) test(`${commitFirst ? 'commit then cold read' : 'cold read then commit'} shares one full-state I/O lane without a rename race`, async t => {
  const queued = deferred(); let watchQueue = false;
  const f = await bindingFixture(t, ['a', 'b'], {onBindingCacheState(event) {
    if (watchQueue && event.event === 'io-queued' && event.activeStorageTasks === 1) queued.resolve();
  }});
  await f.service.initialize();
  const gate = commitFirst ? f.blockSync() : f.blockRead(); let cold, write;
  try {
    if (commitFirst) write = f.service.setOffset({trackId: 'b', offsetMs: 77});
    else cold = f.service.resolve({trackId: 'a'});
    await gate.started.promise; watchQueue = true;
    if (commitFirst) cold = f.service.resolve({trackId: 'a'});
    else write = f.service.setOffset({trackId: 'b', offsetMs: 77});
    await queued.promise;
    assert.equal(f.latest().activeStorageTasks, 1); assert.equal(f.latest().queuedStorageTasks, 1);
    gate.allow.resolve();
    assert.equal((await cold).lines[0].text, 'Manual a'); assert.equal((await write).offsetMs, 77);
    assert.ok(f.events.every(event => event.activeStorageTasks <= 1 && event.activeGraphs <= 1));
    assert.equal(f.control.maxActiveReads, 1); assert.deepEqual(JSON.parse(await fs.readFile(f.statePath)).bindings, f.seed.bindings);
    assert.equal(JSON.parse(await fs.readFile(f.statePath)).offsets.b, 77); assert.equal(f.latest().activeGraphs, 0);
  } finally {gate.allow.resolve(); await f.service.close(); await Promise.allSettled([cold, write].filter(Boolean));}
});

test('a same-bytes replacement inode invalidates warm and cold manual reads and cannot overwrite any persisted binding', async t => {
  const f = await bindingFixture(t, ['a', 'b']); await f.service.initialize(); await f.service.resolve({trackId: 'a'});
  f.prefs.lyrics.onlineEnabled = true;
  const original = await fs.readFile(f.statePath), before = await fs.lstat(f.statePath, {bigint: true});
  await fs.rename(f.statePath, `${f.statePath}.original`); await fs.writeFile(f.statePath, original);
  assert.notEqual((await fs.lstat(f.statePath, {bigint: true})).ino, before.ino);
  await assert.rejects(f.service.resolve({trackId: 'b'}), {code: 'LYRICS_STORAGE_READ_ONLY'});
  await assert.rejects(f.service.resolve({trackId: 'a'}), {code: 'LYRICS_STORAGE_READ_ONLY'});
  await assert.rejects(f.service.setOffset({trackId: 'a', offsetMs: 999}), {code: 'LYRICS_STORAGE_READ_ONLY'});
  assert.deepEqual(await fs.readFile(f.statePath), original); assert.equal(f.networkCalls(), 0);
  assert.equal(f.latest().indexEntries, 2); assert.equal(f.latest().bodyEntries, 0); assert.ok(f.events.some(event => event.event === 'identity-invalid'));
});

test('an external state replacement during final temporary verification cannot be overwritten by an older commit graph', async t => {
  const f = await bindingFixture(t, ['a', 'b']); await f.service.initialize();
  const gate = f.blockTempRead(), write = f.service.setOffset({trackId: 'a', offsetMs: 999});
  try {
    await gate.started.promise;
    const external = JSON.parse(await fs.readFile(f.statePath)); external.bindings.b.document.lines[0].text = 'External manual B';
    await fs.rename(f.statePath, `${f.statePath}.original`); await fs.writeFile(f.statePath, JSON.stringify(external));
    const externallySaved = await fs.readFile(f.statePath);
    const rejected = assert.rejects(write, {code: 'LYRICS_STORAGE_READ_ONLY'}); gate.allow.resolve(); await rejected;
    assert.deepEqual(await fs.readFile(f.statePath), externallySaved);
    assert.equal(JSON.parse(externallySaved).offsets.a, 10); assert.equal(JSON.parse(externallySaved).bindings.b.document.lines[0].text, 'External manual B');
    await assert.rejects(f.service.resolve({trackId: 'b'}), {code: 'LYRICS_STORAGE_READ_ONLY'});
    assert.equal(f.latest().indexEntries, 2); assert.equal(f.latest().bodyEntries, 0);
  } finally {gate.allow.resolve(); await f.service.close(); await Promise.allSettled([write]);}
});

test('a confirmed corrupt cold graph fails closed even if its byte count and reported identity stay unchanged', async t => {
  const f = await bindingFixture(t, ['a', 'b']); await f.service.initialize(); await f.service.resolve({trackId: 'a'});
  const corrupt = Buffer.alloc((await fs.stat(f.statePath)).size, 32); corrupt.write('{bad-json');
  await fs.writeFile(f.statePath, corrupt); f.control.hideMtime = true; f.prefs.lyrics.onlineEnabled = true;
  await assert.rejects(f.service.resolve({trackId: 'b'}), {code: 'LYRICS_STORAGE_READ_ONLY'});
  await assert.rejects(f.service.resolve({trackId: 'a'}), {code: 'LYRICS_STORAGE_READ_ONLY'});
  await assert.rejects(f.service.unbind({trackId: 'b'}), {code: 'LYRICS_STORAGE_READ_ONLY'});
  assert.deepEqual(await fs.readFile(f.statePath), corrupt); assert.equal(f.networkCalls(), 0);
  assert.deepEqual(await fs.readdir(path.dirname(f.statePath)), ['state.json']); assert.equal(f.latest().indexEntries, 2); assert.equal(f.latest().bodyEntries, 0);
});

for (const missing of [false, true]) test(`${missing ? 'missing state' : 'transient access failure'} serves only a warm manual snapshot and cold binding failures remain indexed and retryable`, async t => {
  const f = await bindingFixture(t, ['a', 'b']); await f.service.initialize(); await f.service.resolve({trackId: 'a'});
  f.prefs.lyrics.onlineEnabled = true;
  const original = await fs.readFile(f.statePath);
  if (missing) await fs.rename(f.statePath, `${f.statePath}.original`); else f.control.unavailable = true;
  try {
    const warm = await f.service.resolve({trackId: 'a'}); assert.equal(warm.lines[0].text, 'Manual a'); assert.ok(warm.cacheWarning);
    await assert.rejects(f.service.resolve({trackId: 'b'}));
    await assert.rejects(f.service.setOffset({trackId: 'a', offsetMs: 999}));
    assert.equal(f.latest().indexEntries, 2); assert.deepEqual(f.latest().bodyKeys, ['a']); assert.equal(f.networkCalls(), 0);
  } finally {if (missing) await fs.rename(`${f.statePath}.original`, f.statePath); f.control.unavailable = false;}
  assert.deepEqual(await fs.readFile(f.statePath), original);
  assert.equal((await f.service.resolve({trackId: 'b'})).lines[0].text, 'Manual b');
  await f.service.setOffset({trackId: 'a', offsetMs: 33}); assert.equal(JSON.parse(await fs.readFile(f.statePath)).offsets.a, 33);
  assert.deepEqual(JSON.parse(await fs.readFile(f.statePath)).bindings.b, f.seed.bindings.b);
});

for (const operation of ['open', 'writeFile', 'sync', 'rename']) test(`manual-body index, LRU, offsets and cold B roll back after ${operation} failure and the next write can succeed`, async t => {
  const f = await bindingFixture(t, ['a', 'b'], {maxBindingCacheEntries: 1}); await f.service.initialize(); await f.service.resolve({trackId: 'a'});
  const original = await fs.readFile(f.statePath), imported = path.join(f.folder, 'changed.lrc'); await fs.writeFile(imported, '[00:01]New manual A');
  const published = f.events.filter(event => event.event === 'index-publish').length;
  f.control.failOperation = operation;
  await assert.rejects(f.service.importFile({trackId: 'a', path: imported}), {code: 'EACCES'});
  assert.deepEqual(await fs.readFile(f.statePath), original); assert.equal(f.events.filter(event => event.event === 'index-publish').length, published);
  assert.deepEqual(f.latest().bodyKeys, ['a']); assert.equal((await f.service.resolve({trackId: 'a'})).lines[0].text, 'Manual a');
  assert.equal((await f.service.resolve({trackId: 'a'})).offsetMs, 10);
  assert.ok((await fs.readdir(path.dirname(f.statePath))).every(file => !file.endsWith('.tmp')));
  f.control.failOperation = null;
  assert.equal((await f.service.importFile({trackId: 'a', path: imported})).lines[0].text, 'New manual A');
  const saved = JSON.parse(await fs.readFile(f.statePath)); assert.deepEqual(saved.bindings.b, f.seed.bindings.b); assert.deepEqual(saved.offsets, f.seed.offsets);
  assert.equal((await f.service.resolve({trackId: 'b'})).lines[0].text, 'Manual b');
});

for (const change of ['force', 'unbind', 'rebind', 'metadata', 'close']) test(`a cold manual read rechecks ${change} before publishing or reinserting an obsolete body`, async t => {
  const queued = deferred(); let watchQueue = false;
  const f = await bindingFixture(t, ['a', 'b'], {onBindingCacheState(event) {
    if (watchQueue && event.event === 'io-queued' && event.activeStorageTasks === 1) queued.resolve();
  }});
  await f.service.initialize(); const original = await fs.readFile(f.statePath), marker = f.events.length, beforeReads = f.control.reads;
  const gate = f.blockRead(), first = f.service.resolve({trackId: 'a'}); let second, closing;
  try {
    await gate.started.promise; watchQueue = true;
    if (change === 'force') second = f.service.resolve({trackId: 'a', force: true});
    else if (change === 'unbind') second = f.service.unbind({trackId: 'a'});
    else if (change === 'rebind') {
      const imported = path.join(f.folder, 'new-a.lrc'); await fs.writeFile(imported, '[00:01]New binding generation');
      second = f.service.importFile({trackId: 'a', path: imported});
    } else if (change === 'metadata') f.tracks.get('a').title = 'Changed during cold read';
    else closing = f.service.close();
    if (second) await queued.promise;
    gate.allow.resolve();
    const old = await first;
    assert.equal(old.superseded, true);
    const firstClosedGraph = f.events.slice(marker).find(event => event.event === 'graph-close');
    assert.equal(firstClosedGraph.bodyEntries, 0, 'the cancelled cold read inserted its old body');
    if (change === 'force') assert.equal((await second).lines[0].text, 'Manual a');
    else if (change === 'unbind') {
      assert.equal((await second).status, 'not-found'); assert.equal(old.bound, false);
      assert.equal(JSON.parse(await fs.readFile(f.statePath)).bindings.a, undefined);
    } else if (change === 'rebind') {
      assert.equal((await second).lines[0].text, 'New binding generation'); assert.equal(old.lines[0].text, 'New binding generation');
    } else if (change === 'metadata') {
      assert.equal(old.reason, 'track-changed'); assert.equal(f.latest().bodyEntries, 0);
      assert.deepEqual(await fs.readFile(f.statePath), original);
      assert.equal((await f.service.resolve({trackId: 'a'})).lines[0].text, 'Manual a');
    } else {
      await closing; assert.equal(f.latest().bodyEntries, 0); assert.equal(f.control.reads, beforeReads + 1);
      assert.deepEqual(await fs.readFile(f.statePath), original);
    }
    assert.equal(f.networkCalls(), 0); assert.ok(f.events.every(event => event.activeGraphs <= 1 && event.indexedBodies === 0));
  } finally {gate.allow.resolve(); await f.service.close(); await Promise.allSettled([first, second, closing].filter(Boolean));}
});

test('invalid automatic rows cannot hide valid manual bindings or poison a cold v1 commit', async t => {
  const automatic = (id, storedAt) => ({storedAt, metadataKey: 'unrelated', document: {...manualSnapshot(id).document,
    source: 'LRCLIB', provider: 'lrclib', sourceId: 1, sourceKey: 'lrclib:1', sourceUrl: 'https://lrclib.net/api/get/1', local: false, bound: false}});
  const f = await bindingFixture(t, ['a', 'b'], {maxCacheEntries: 1}, seed => {
    seed.offsets = {a: 123, b: 456, unknown: 789};
    seed.cache = {bad: null, primitive: 5, other: {storedAt: 1, document: {trackId: 'other'}},
      throwingDocument: {storedAt: 100, document: {...manualSnapshot('throwingDocument').document, sourceId: {toString: 0, valueOf: 0}}},
      noncoerciveTime: automatic('noncoerciveTime', {toString: 0, valueOf: 0}), valid: automatic('valid', 1)};
  });
  const original = await fs.readFile(f.statePath), initialized = await f.service.initialize();
  assert.equal(initialized.warning, undefined); const manual = await f.service.resolve({trackId: 'a'});
  assert.equal(manual.bound, true); assert.equal(manual.lines[0].text, 'Manual a'); assert.equal(manual.offsetMs, 123);
  assert.deepEqual(await fs.readFile(f.statePath), original); assert.equal(f.latest().indexEntries, 2);
  assert.equal((await f.service.setOffset({trackId: 'a', offsetMs: 77})).offsetMs, 77);
  let saved = JSON.parse(await fs.readFile(f.statePath)); assert.deepEqual(Object.keys(saved.cache), ['valid']);
  const imported = path.join(f.folder, 'after-invalid-cache.lrc'); await fs.writeFile(imported, '[00:01]New manual after invalid auto cache');
  assert.equal((await f.service.importFile({trackId: 'a', path: imported})).bound, true);
  f.tracks.set('c', {id: 'c', path: path.join(f.folder, 'c.flac'), title: 'Song', artist: 'Artist', album: 'Album', duration: 180});
  f.prefs.lyrics.onlineEnabled = true; assert.equal((await f.service.resolve({trackId: 'c'})).status, 'ready');
  saved = JSON.parse(await fs.readFile(f.statePath));
  assert.deepEqual(saved.bindings.b, f.seed.bindings.b); assert.deepEqual(saved.offsets, {a: 77, b: 456, unknown: 789});
  assert.deepEqual(saved.preservedRoot, f.seed.preservedRoot); assert.deepEqual(Object.keys(saved.cache), ['c']);
});

for (const change of ['metadata', 'force', 'manual']) test(`an offset response rechecks ${change} after its asynchronous manual lookup without returning an old automatic body`, async t => {
  const lookup = {started: deferred(), allow: deferred()}, manualQueued = deferred(), nextFetchStarted = deferred(), nextFetch = deferred();
  let f, armLookup = false, watchManual = false, calls = 0, offsetDone = false;
  const oldRecord = record(1, 'Song', {syncedLyrics: '[00:01]Old automatic version'});
  const newRecord = record(2, 'Song', {syncedLyrics: '[00:01]New automatic version'});
  f = await bindingFixture(t, [], {fetchImpl: async () => {
    if (++calls === 1) return response(oldRecord); nextFetchStarted.resolve(); return nextFetch.promise;
  }, onBindingCacheState(event) {
    if (armLookup && event.event === 'index-publish') {armLookup = false; f.control.statGate = lookup;}
    if (watchManual && event.event === 'io-queued' && event.activeStorageTasks === 1) manualQueued.resolve();
  }});
  let offsetRequest, changing;
  try {
    f.prefs.lyrics.onlineEnabled = true;
    assert.equal((await f.service.resolve({trackId: 'a'})).lines[0].text, 'Old automatic version');
    if (change === 'metadata') f.prefs.lyrics.onlineEnabled = false;
    armLookup = true; offsetRequest = f.service.setOffset({trackId: 'a', offsetMs: 77}); offsetRequest.then(() => {offsetDone = true;});
    await lookup.started.promise;
    if (change === 'metadata') f.tracks.get('a').title = 'Song (Live)';
    else if (change === 'force') changing = f.service.resolve({trackId: 'a', force: true});
    else {
      const imported = path.join(f.folder, 'offset-new-manual.lrc'); await fs.writeFile(imported, '[00:01]New manual wins');
      watchManual = true; changing = f.service.importFile({trackId: 'a', path: imported}); await manualQueued.promise;
    }
    lookup.allow.resolve();
    if (change === 'force') {await nextFetchStarted.promise; assert.equal(offsetDone, false); nextFetch.resolve(response(newRecord));}
    const result = await offsetRequest;
    assert.equal(result.offsetMs, 77); assert.equal(JSON.parse(await fs.readFile(f.statePath)).offsets.a, 77);
    if (change === 'metadata') {assert.equal(result.lines.length, 0); assert.equal(calls, 1);}
    else if (change === 'force') {
      assert.equal(result.lines[0].text, 'New automatic version'); assert.equal((await changing).superseded, undefined); assert.equal(calls, 2);
    } else {
      assert.equal(result.bound, true); assert.equal(result.lines[0].text, 'New manual wins');
      assert.equal((await changing).lines[0].text, 'New manual wins'); assert.equal(calls, 1);
    }
  } finally {lookup.allow.resolve(); nextFetch.resolve(response(newRecord)); await f.service.close(); await Promise.allSettled([offsetRequest, changing].filter(Boolean));}
});
