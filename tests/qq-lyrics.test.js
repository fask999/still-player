'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createQqLyricsClient } = require('../src/main/qq-lyrics');
const track = { title: '黑色蝴蝶', artist: '汪苏泷', album: '传世乐章', duration: 227.036 };
const song = { songmid: '004CAUsM4ZX5x5', songname: track.title, singer: [{ name: track.artist }], albumname: track.album, interval: 227 };
const searchBody = { code: 0, data: { song: { list: [song] } } };
const response = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
const lyricBody = text => ({ code: 0, lyric: Buffer.from(text).toString('base64') });
const make = options => createQqLyricsClient({ minRequestIntervalMs: 0, ...options });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const flush = () => new Promise(resolve => setImmediate(resolve));

test('public guest adapter uses only verified GET paths, parameters and public headers', async () => {
  const calls = [];
  const client = make({ fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); return response(calls.length === 1 ? searchBody : { ...lyricBody('[00:01]One'), qrc: 'ignored', trans: 'ignored' }); } });
  try {
    const records = await client.search(track);
    assert.equal(records[0].id, 'qq:004CAUsM4ZX5x5'); assert.equal(records[0].provider, 'qq');
    const record = await client.get(records[0]);
    assert.equal(record.syncedLyrics, '[00:01]One'); assert.equal(record.qrc, undefined);
    assert.equal(calls[0].url.pathname, '/soso/fcgi-bin/client_search_cp');
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { format: 'json', n: '10', p: '0', w: '黑色蝴蝶 汪苏泷', cr: '1', g_tk: '5381' });
    assert.equal(calls[1].url.pathname, '/lyric/fcgi-bin/fcg_query_lyric_new.fcg');
    assert.deepEqual([...calls[1].url.searchParams.keys()].sort(), ['songmid', 'pcachetime', 'g_tk', 'loginUin', 'hostUin', 'inCharset', 'outCharset', 'notice', 'platform', 'needNewCode', 'format'].sort());
    assert.equal(calls[1].url.searchParams.get('songmid'), song.songmid);
    assert.equal(calls[1].url.searchParams.get('loginUin'), '0'); assert.equal(calls[1].url.searchParams.get('hostUin'), '0');
    for (const { url, init } of calls) {
      assert.equal(url.origin, 'https://c.y.qq.com'); assert.equal(url.username, ''); assert.equal(url.password, '');
      assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
      assert.equal(init.referrer, 'https://y.qq.com/'); assert.equal(init.headers.Referer, 'https://y.qq.com/');
      assert.deepEqual(Object.keys(init.headers).sort(), ['Accept', 'Referer', 'User-Agent']); assert.ok(init.signal instanceof AbortSignal);
    }
  } finally { client.close(); }
});

test('adapter bounds search results and rejects invalid records without arbitrary URLs', async () => {
  const client = make({ fetchImpl: async () => response({ code: 0, data: { song: { list: Array.from({ length: 30 }, () => song) } } }) });
  assert.equal((await client.search(track)).length, 10);
  await assert.rejects(client.get({ provider: 'qq', songmid: 'https://evil.example', id: 'qq:https://evil.example' }), { code: 'INVALID_QQ_RESPONSE' });
  client.close();
  for (const body of [{ code: 1 }, { code: 0, data: {} }, { code: 0, data: { song: { list: [{ ...song, interval: '227' }] } } }, { code: 0, data: { song: { list: [{ ...song, singer: [{}] }] } } }]) {
    const bad = make({ fetchImpl: async () => response(body) });
    await assert.rejects(bad.search(track), { code: 'INVALID_QQ_RESPONSE' }); bad.close();
  }
});

test('JSON and ordinary LRC require strict UTF-8 and canonical Base64', async () => {
  for (const body of [new Response('{bad'), new Response(Buffer.from([123, 0xFF, 125]))]) {
    const client = make({ fetchImpl: async () => body }); await assert.rejects(client.search(track), { status: 'parse-error' }); client.close();
  }
  const record = { provider: 'qq', id: `qq:${song.songmid}`, songmid: song.songmid, trackName: track.title, artistName: track.artist, albumName: track.album, duration: 227 };
  for (const lyric of ['', 'abc', '!!!!', 'Zh==', Buffer.from([0xFF]).toString('base64')]) {
    const client = make({ fetchImpl: async () => response({ code: 0, lyric }) }); await assert.rejects(client.get(record), { status: 'parse-error' }); client.close();
  }
});

test('declared and streamed responses cannot exceed the configured byte bound', async () => {
  for (const declared of [true, false]) {
    const client = make({ maxResponseBytes: 16, fetchImpl: async () => response(searchBody, 200, declared ? { 'content-length': '1000' } : {}) });
    await assert.rejects(client.search(track), { status: 'parse-error' }); client.close();
  }
});

test('requests are serial and paced, without automatic retry on HTTP failure', async () => {
  const starts = []; let active = 0, maximum = 0;
  const client = make({ minRequestIntervalMs: 20, fetchImpl: async () => { starts.push(Date.now()); active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return response(searchBody); } });
  await Promise.all([client.search(track), client.search(track)]);
  assert.equal(maximum, 1); assert.ok(starts[1] - starts[0] >= 22); client.close();
  let calls = 0;
  const failed = make({ fetchImpl: async () => { calls++; return response({}, 502); } });
  await assert.rejects(failed.search(track), { code: 'HTTP_502' }); assert.equal(calls, 1); failed.close();
});

test('429 cooldown stops queued requests and never retries', async () => {
  let calls = 0;
  const client = make({ fetchImpl: async () => { calls++; return response({}, 429, { 'retry-after': '60' }); } });
  const results = await Promise.allSettled([client.search(track), client.search(track)]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'RATE_LIMITED')); assert.equal(calls, 1); client.close();
});

test('timeouts and close settle an uncooperative fetch, queued work and stalled body', async () => {
  const timed = make({ timeoutMs: 25, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(timed.search(track), { code: 'TIMEOUT' }); timed.close();
  for (const stalledBody of [false, true]) {
    let started; const start = new Promise(resolve => { started = resolve; }); let calls = 0;
    const client = make({ fetchImpl: async () => { calls++; started(); return stalledBody ? new Response(new ReadableStream({ start() {} })) : new Promise(() => {}); } });
    const first = client.search(track), queued = client.search(track);
    const settled = Promise.all([assert.rejects(first, { code: 'CLOSED' }), assert.rejects(queued, { code: 'CLOSED' })]);
    await start; client.close(); await settled; assert.equal(calls, 1);
  }
});

test('explicit abort interrupts active and queued work and metadata guard stops sending', async () => {
  let started; const start = new Promise(resolve => { started = resolve; });
  const client = make({ fetchImpl: async () => { started(); return new Promise(() => {}); } });
  const active = new AbortController(), queued = new AbortController();
  const first = client.search(track, { signal: active.signal }), second = client.search(track, { signal: queued.signal });
  const stopped = Promise.all([assert.rejects(first, { code: 'CANCELLED' }), assert.rejects(second, { code: 'CANCELLED' })]);
  await start; queued.abort(); active.abort(); await stopped; client.close();
  let calls = 0;
  const guarded = make({ fetchImpl: async () => { calls++; return response(searchBody); } });
  await assert.rejects(guarded.search(track, { isCurrent: () => false }), { code: 'CANCELLED' }); assert.equal(calls, 0); guarded.close();
});

test('bounded queue rejects overflow and close cancels all sixteen admitted requests', async () => {
  let started; const start = new Promise(resolve => { started = resolve; });
  const client = make({ fetchImpl: async () => { started(); return new Promise(() => {}); } });
  const admitted = Array.from({ length: 16 }, () => client.search(track)); const settled = Promise.allSettled(admitted);
  await start; await assert.rejects(client.search(track), { code: 'BUSY' }); client.close();
  assert.ok((await settled).every(result => result.status === 'rejected' && result.reason.code === 'CLOSED'));
});

test('close during pacing cancels its timer and never sends the next request', async () => {
  let calls = 0;
  const client = make({ minRequestIntervalMs: 1000, fetchImpl: async () => { calls++; return response(searchBody); } });
  await client.search(track);
  const paced = client.search(track); const stopped = assert.rejects(paced, { code: 'CLOSED' });
  await new Promise(resolve => setTimeout(resolve, 10)); client.close(); await stopped; assert.equal(calls, 1);
});

test('logical timeouts retain the one physical fetch slot across queued and continued pressure', async () => {
  const gate = deferred(); const signals = []; let calls = 0, lateCancelled = 0;
  const client = make({ timeoutMs: 15, fetchImpl: async (_url, init) => { calls++; signals.push(init.signal); return gate.promise; } });
  const first = await Promise.allSettled(Array.from({ length: 3 }, () => client.search(track)));
  assert.ok(first.every(result => result.status === 'rejected' && result.reason.code === 'TIMEOUT'));
  assert.equal(calls, 1); assert.ok(signals.every(signal => signal.aborted));
  const further = await Promise.allSettled(Array.from({ length: 13 }, () => client.search(track)));
  assert.ok(further.every(result => result.status === 'rejected' && result.reason.code === 'TIMEOUT'));
  assert.equal(calls, 1);
  // Expired waiting jobs leave the queue; the original physical fetch keeps its slot.
  await assert.rejects(client.search(track), { code: 'TIMEOUT' });
  assert.equal(calls, 1);
  client.close();
  await assert.rejects(client.search(track), { code: 'CLOSED' });
  gate.resolve({ body: { async cancel() { lateCancelled++; } } });
  await flush(); await flush();
  assert.equal(lateCancelled, 1); assert.equal(calls, 1);
});

test('late fetch completion cannot free its slot before response cancellation settles', async () => {
  const gate = deferred(), cancelGate = deferred(), cancelStarted = deferred(), started = deferred(); let calls = 0;
  const client = make({ timeoutMs: 500, fetchImpl: async () => {
    calls++; if (calls === 1) { started.resolve(); return gate.promise; }
    return response(searchBody);
  } });
  const controller = new AbortController(); const first = client.search(track, { signal: controller.signal });
  const cancelled = assert.rejects(first, { code: 'CANCELLED' }); await started.promise; controller.abort(); await cancelled;
  const next = client.search(track);
  gate.resolve({ body: { cancel() { cancelStarted.resolve(); return cancelGate.promise; } } });
  await cancelStarted.promise; await flush(); assert.equal(calls, 1);
  cancelGate.resolve(); assert.equal((await next)[0].id, 'qq:004CAUsM4ZX5x5'); assert.equal(calls, 2);
  client.close();
});

test('ignored read and cancel both retain the physical body slot after timeout and close', async () => {
  const read = deferred(), cancel = deferred(), cancelStarted = deferred(); let calls = 0, cancels = 0, released = 0;
  const signals = [];
  const client = make({ timeoutMs: 15, fetchImpl: async (_url, init) => {
    calls++; signals.push(init.signal);
    return { status: 200, ok: true, headers: new Headers(), body: { getReader: () => ({
      read: () => read.promise, cancel() { cancels++; cancelStarted.resolve(); return cancel.promise; }, releaseLock() { released++; },
    }) } };
  } });
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => client.search(track)));
  await cancelStarted.promise;
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'TIMEOUT'));
  assert.equal(calls, 1); assert.equal(cancels, 1); assert.equal(released, 0);
  read.resolve({ done: true }); await flush();
  assert.equal(calls, 1); assert.equal(released, 0); // An ended read does not finish a pending cancel.
  const queued = client.search(track); const stopped = assert.rejects(queued, { code: 'CLOSED' });
  client.close(); await stopped; assert.equal(calls, 1); assert.ok(signals.every(signal => signal.aborted));
  cancel.resolve(); await flush(); await flush(); assert.equal(released, 1); assert.equal(cancels, 1); assert.equal(calls, 1);
});

test('pending HTTP error body cancellation keeps the slot while queued deadlines and close remain prompt', async () => {
  const cleanup = deferred(); let calls = 0, cancels = 0;
  const client = make({ timeoutMs: 15, fetchImpl: async () => {
    calls++; return { status: 503, ok: false, body: { cancel() { cancels++; return cleanup.promise; } } };
  } });
  const results = await Promise.allSettled([client.search(track), client.search(track), client.search(track)]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'TIMEOUT'));
  assert.equal(calls, 1); assert.equal(cancels, 1);
  client.close(); cleanup.resolve(); await flush(); await flush(); assert.equal(calls, 1);
});
