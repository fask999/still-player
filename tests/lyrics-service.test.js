'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLyricsService, createLrclibClient, createSearchingDocument } = require('../src/main/lyrics');
const { createQqLyricsClient } = require('../src/main/qq-lyrics');

const response = (value, status = 200, headers) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const record = (id, title = 'Song', extras = {}) => ({ id, trackName: title, artistName: 'Artist', albumName: 'Album', duration: 180, instrumental: false, syncedLyrics: '[00:01.00]Network one\n[00:04.00]Network two', plainLyrics: 'Network one\nNetwork two', ...extras });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture(t, fetchImpl, extra = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'still-lyrics-test-'));
  const tracks = new Map([
    ['a', { id: 'a', path: path.join(folder, 'Song.flac'), title: 'Song', artist: 'Artist', album: 'Album', duration: 180 }],
    ['b', { id: 'b', path: path.join(folder, 'Other.flac'), title: 'Other', artist: 'Artist', album: 'Album', duration: 180 }],
  ]);
  const prefs = { lyrics: { onlineEnabled: true, cacheEnabled: true, preferredSource: 'lrclib' } };
  const dataDir = path.join(folder, 'data');
  const service = createLyricsService({ dataDir, getTrack: id => tracks.get(id), getSettings: () => prefs, fetchImpl, minRequestIntervalMs: 0, timeoutMs: 1000, retryBaseMs: 1, ...extra });
  await service.initialize();
  t.after(async () => { await service.close(); const target = path.resolve(folder); assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(target, { recursive: true, force: true }); });
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
