'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {deflateSync} = require('node:zlib');
const {createHash} = require('node:crypto');
const {createAppleArtworkService} = require('../src/main/apple-artwork');

const remote = (name = 'fixture', ending = '512x512bb.png') => `https://is1-ssl.mzstatic.com/image/thumb/Music112/v4/${name}/cover.png/${ending}`;
const localRequest = (url, options) => new Request(url, options);
function deferred() {let resolve; const promise = new Promise(yes => {resolve = yes;}); return {promise, resolve};}
const tick = () => new Promise(resolve => setImmediate(resolve));
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, payload) {
  const bytes = Buffer.alloc(payload.length + 12);
  bytes.writeUInt32BE(payload.length); bytes.write(type, 4, 'ascii'); payload.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
function png(width = 1, height = 1, extra = []) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  // Huge dimension fixtures keep a tiny, deliberately insufficient pixel body:
  // the service must reject their dimensions without invoking an image decoder.
  const pixels = Buffer.alloc(width <= 512 && height <= 512 ? (width * 4 + 1) * height : 5);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), ...extra,
    pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
}
const PNG = png();
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCDgA//2Q==', 'base64');
const upstream = (bytes = PNG, type = 'image/png', options = {}) => new Response(bytes, {headers: {'content-type': type, ...options.headers}, status: options.status || 200});
function service(t, options) {const value = createAppleArtworkService(options); t.after(() => value.close()); return value;}
async function assertImage(response, bytes = PNG, type = 'image/png') {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), type);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
}
async function folder(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'still-apple-artwork-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(resolved, {recursive: true, force: true});
  });
  return directory;
}
const idFor = url => url.split('/').at(-1);

test('registration is synchronous, normalizes Apple templates and never fetches', async t => {
  let calls = 0;
  const value = service(t, {fetchImpl: async () => {calls++; return upstream();}});
  const url = value.urlFor(remote('fixture', '{w}x{h}bb.png'));
  assert.match(url, /^still-apple-art:\/\/art\/[a-f0-9]{64}$/);
  assert.equal(url, value.urlFor(remote()));
  assert.equal(url, value.urlFor(remote().replace('.com/', '.com:443/')));
  assert.equal(calls, 0);
  assert.equal(url.includes('mzstatic'), false);
  await assertImage(await value.handleRequest(localRequest(url)));
  await assertImage(await value.handleRequest(localRequest(url)));
  assert.equal(calls, 1);
});

test('malicious remote URLs and unknown/malformed local URLs are offline rejections', async t => {
  let calls = 0;
  const value = service(t, {fetchImpl: async () => {calls++; throw new Error('must never fetch');}});
  const good = remote();
  const malicious = [undefined, null, {}, 3, '', 'x'.repeat(2049),
    good.replace('https:', 'http:'), good.replace('https:', 'file:'), good.replace('https:', 'data:'),
    good.replace('is1-ssl.mzstatic.com', 'localhost'), good.replace('is1-ssl.mzstatic.com', '127.0.0.1'),
    good.replace('is1-ssl.mzstatic.com', '[::1]'), good.replace('is1-ssl.mzstatic.com', 'is6-ssl.mzstatic.com'),
    good.replace('is1-ssl.mzstatic.com', 'is1-ssl.mzstatic.com.evil.test'), good.replace('.com/', '.com./'),
    good.replace('https://', 'https://user:secret@'), good.replace('.com/', '.com:444/'),
    good + '?token=secret', good + '?', good + '#x', good + '#', ' ' + good, good + '\n',
    good.replace('/image/thumb/', '/image/private/'), good.replace('/v4/', '/../'), good.replace('/v4/', '/./'),
    good.replace('/v4/', '/%2e%2e/'), good.replace('/v4/', '/%2f/'), good.replace('/v4/', '/\\/'),
    good.replace('/v4/', '//'), good.replace('512x512', '2048x2048'), good.replace('512x512', '{w}x512'),
    good.replace('bb.png', 'bb.svg'), good.replace('bb.png', 'bb.html'), good.replace('bb.png', 'bb.webp'),
    good.replace('/fixture/', '/a@b/'), good.replace('thumb', 'thumb%2f')];
  for (const input of malicious) assert.equal(value.urlFor(input), '', String(input));
  const valid = value.urlFor(good), unknown = `still-apple-art://art/${'0'.repeat(64)}`;
  const localBad = [unknown, valid + '?url=' + encodeURIComponent(good), valid + '?', valid + '#',
    valid.replace('://art/', '://evil/'), valid.replace('://art/', '://user@art/'), valid.replace('://art/', '://art:443/'),
    valid.replace('://art/', '://art//'), valid.replace('still-apple-art:', 'https:'), good, valid.toUpperCase(),
    valid.replace(/.$/, 'g'), valid + '/', valid.replace('://art/', '://art/../'), 'file:///C:/fixture.png'];
  for (const url of localBad) assert.equal((await value.handleRequest({url, method: 'GET'})).status, 404, url);
  assert.equal((await value.handleRequest({url: valid, method: 'POST'})).status, 405);
  assert.equal(calls, 0);
});

test('public GET sends no incoming credentials/headers and never follows redirects', async t => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const value = service(t, {fetchImpl: async (url, options) => {
      calls++; assert.equal(url, remote()); assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
      assert.equal(options.referrer, ''); assert.equal(options.referrerPolicy, 'no-referrer');
      assert.deepEqual(options.headers, {Accept: 'image/jpeg, image/png'});
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(null, {status, headers: {location: 'http://127.0.0.1:1234/secret'}});
    }});
    const result = await value.handleRequest(localRequest(value.urlFor(remote()), {headers: {cookie: 'secret', authorization: 'secret', referer: 'secret'}}));
    assert.equal(result.status, 502); assert.equal(await result.text(), 'Artwork unavailable.'); assert.equal(calls, 1);
  }
});

test('only complete bounded PNG/JPEG containers with matching MIME are returned', async t => {
  for (const [bytes, type] of [[PNG, 'image/png'], [png(512, 512), 'image/png'], [JPEG, 'image/jpeg']]) {
    const value = service(t, {fetchImpl: async () => upstream(bytes, type)});
    await assertImage(await value.handleRequest(localRequest(value.urlFor(remote()))), bytes, type);
  }
  const invalid = [[Buffer.from('<svg onload="alert(1)"/>'), 'image/png'], [Buffer.from('<html>secret</html>'), 'image/jpeg'],
    [PNG, 'image/svg+xml'], [PNG, 'text/html'], [PNG, 'image/jpeg'], [JPEG, 'image/png'],
    [PNG.subarray(0, 24), 'image/png'], [Buffer.concat([PNG, Buffer.from('trailing')]), 'image/png'],
    [Buffer.from(PNG.map((value, index) => index === 20 ? value ^ 1 : value)), 'image/png'],
    [png(2049, 1), 'image/png'], [png(2048, 2048), 'image/png'], [png(0, 1), 'image/png'],
    [png(1, 1, [pngChunk('acTL', Buffer.alloc(8))]), 'image/png'], [JPEG.subarray(0, -2), 'image/jpeg']];
  const largeJpeg = Buffer.from(JPEG), sof = largeJpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sof >= 0); largeJpeg.writeUInt16BE(4096, sof + 5); invalid.push([largeJpeg, 'image/jpeg']);
  for (const [bytes, type] of invalid) {
    const value = service(t, {fetchImpl: async () => upstream(bytes, type)});
    assert.equal((await value.handleRequest(localRequest(value.urlFor(remote())))).status, 502, `${type} ${bytes.length}`);
  }
});

test('stream/body bounds, declared length and status reject oversized or invalid responses', async t => {
  for (const fetchImpl of [
    async () => upstream(PNG, 'image/png', {headers: {'content-length': String(2 * 1024 * 1024 + 1)}}),
    async () => upstream(PNG, 'image/png', {headers: {'content-length': 'not-a-number'}}),
    async () => upstream(PNG, 'image/png', {status: 206}),
    async () => new Response(null, {status: 204}),
    async () => upstream(Buffer.alloc(2 * 1024 * 1024 + 1)),
  ]) {
    const value = service(t, {fetchImpl});
    assert.equal((await value.handleRequest(localRequest(value.urlFor(remote())))).status, 502);
  }
  let cancelled = false, pulls = 0;
  const value = service(t, {maxResponseBytes: 100, fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) {pulls++; controller.enqueue(Buffer.alloc(64));}, cancel() {cancelled = true;}
  }), {headers: {'content-type': 'image/png'}})});
  assert.equal((await value.handleRequest(localRequest(value.urlFor(remote())))).status, 502);
  assert.equal(cancelled, true); assert.ok(pulls <= 4);
});

test('four transport slots, bounded queue and duplicate subscribers are independently limited', async t => {
  const gates = [], started = [];
  const value = service(t, {maxQueued: 2, fetchImpl: async url => {
    started.push(url); const gate = deferred(); gates.push(gate); return gate.promise;
  }});
  const requests = Array.from({length: 6}, (_, index) => value.handleRequest(localRequest(value.urlFor(remote(`n${index}`)))));
  const duplicate = value.handleRequest(localRequest(value.urlFor(remote('n0'))));
  await tick(); assert.equal(started.length, 4);
  assert.equal((await value.handleRequest(localRequest(value.urlFor(remote('overflow'))))).status, 503);
  gates[0].resolve(upstream()); await assertImage(await requests[0]); await assertImage(await duplicate);
  await tick(); assert.equal(started.length, 5);
  gates[1].resolve(upstream()); await assertImage(await requests[1]);
  await tick(); assert.equal(started.length, 6);
  for (let index = 2; index < 6; index++) gates[index].resolve(upstream());
  for (const pending of requests.slice(2)) await assertImage(await pending);
  assert.equal(started.filter(url => url === remote('n0')).length, 1);
  const gate = deferred(), limited = service(t, {maxWaiters: 2, fetchImpl: () => gate.promise});
  const local = limited.urlFor(remote());
  const a = limited.handleRequest(localRequest(local)), b = limited.handleRequest(localRequest(local));
  assert.equal((await limited.handleRequest(localRequest(local))).status, 503);
  gate.resolve(upstream()); await assertImage(await a); await assertImage(await b);
});

test('caller cancellation is isolated; final subscriber cancellation aborts transport', async t => {
  let signal, calls = 0;
  const gate = deferred(), value = service(t, {fetchImpl: async (_url, options) => {calls++; signal = options.signal; return gate.promise;}});
  const local = value.urlFor(remote()), first = new AbortController(), second = new AbortController();
  const a = value.handleRequest(localRequest(local, {signal: first.signal}));
  const b = value.handleRequest(localRequest(local, {signal: second.signal}));
  await tick(); first.abort(); assert.equal((await a).status, 499); assert.equal(signal.aborted, false);
  gate.resolve(upstream()); await assertImage(await b); assert.equal(calls, 1);
  const last = new AbortController(); let lastSignal;
  const stalled = service(t, {fetchImpl: async (_url, options) => {lastSignal = options.signal; return new Promise(() => {});}});
  const pending = stalled.handleRequest(localRequest(stalled.urlFor(remote()), {signal: last.signal}));
  await tick(); last.abort(); assert.equal((await pending).status, 499); assert.equal(lastSignal.aborted, true);
  const pre = new AbortController(); pre.abort();
  assert.equal((await value.handleRequest(localRequest(local, {signal: pre.signal}))).status, 499); assert.equal(calls, 1);
});

test('timeout includes stalled body and queued jobs; ignored abort cannot free extra live transport slots', async t => {
  let cancelled = false, upstreamSignal;
  const value = service(t, {timeoutMs: 30, fetchImpl: async (_url, options) => {
    upstreamSignal = options.signal;
    return new Response(new ReadableStream({start(controller) {controller.enqueue(PNG.subarray(0, 8));}, cancel() {cancelled = true;}}), {headers: {'content-type': 'image/png'}});
  }});
  assert.equal((await value.handleRequest(localRequest(value.urlFor(remote())))).status, 504);
  assert.equal(upstreamSignal.aborted, true); assert.equal(cancelled, true);
  let calls = 0;
  const stuck = service(t, {maxConcurrent: 1, maxQueued: 1, timeoutMs: 20, fetchImpl: async () => {calls++; return new Promise(() => {});}});
  const a = stuck.handleRequest(localRequest(stuck.urlFor(remote('a'))));
  const b = stuck.handleRequest(localRequest(stuck.urlFor(remote('b'))));
  assert.equal((await a).status, 504); assert.equal((await b).status, 504); assert.equal(calls, 1);
  assert.equal((await stuck.handleRequest(localRequest(stuck.urlFor(remote('c'))))).status, 504);
  assert.equal(calls, 1);
});

test('close cancels active/queued work and late responses cannot repopulate cache', async t => {
  let calls = 0, signal, lateCancelled = false;
  const gate = deferred(), value = service(t, {maxConcurrent: 1, fetchImpl: async (_url, options) => {calls++; signal = options.signal; return gate.promise;}});
  const local = value.urlFor(remote('a'));
  const a = value.handleRequest(localRequest(local));
  const b = value.handleRequest(localRequest(value.urlFor(remote('b'))));
  await tick(); await value.close();
  assert.equal(signal.aborted, true); assert.equal((await a).status, 503); assert.equal((await b).status, 503);
  assert.equal(value.urlFor(remote()), ''); assert.equal((await value.handleRequest(localRequest(local))).status, 404);
  gate.resolve(new Response(new ReadableStream({cancel() {lateCancelled = true;}}), {headers: {'content-type': 'image/png'}}));
  await tick(); assert.equal(lateCancelled, true); assert.equal(calls, 1); await value.close();
});

test('memory cache LRU respects byte/entry bounds and registration table is bounded', async t => {
  const calls = [];
  const value = service(t, {maxCacheEntries: 2, maxCacheBytes: PNG.length * 2, fetchImpl: async url => {calls.push(url); return upstream();}});
  const [a, b, c] = ['a', 'b', 'c'].map(name => value.urlFor(remote(name)));
  for (const local of [a, b, a, c, a, b]) await assertImage(await value.handleRequest(localRequest(local)));
  assert.deepEqual(calls, [remote('a'), remote('b'), remote('c'), remote('b')]);
  let registrations = 0;
  const bounded = service(t, {maxRegisteredUrls: 2, fetchImpl: async () => {registrations++; return upstream();}});
  const old = bounded.urlFor(remote('old')), kept = bounded.urlFor(remote('kept'));
  bounded.urlFor(remote('old')); bounded.urlFor(remote('new'));
  assert.equal((await bounded.handleRequest(localRequest(kept))).status, 404);
  assert.equal(registrations, 0); await assertImage(await bounded.handleRequest(localRequest(old))); assert.equal(registrations, 1);
  const uncached = service(t, {maxCacheBytes: PNG.length - 1, fetchImpl: async () => {registrations++; return upstream();}});
  const small = uncached.urlFor(remote());
  await assertImage(await uncached.handleRequest(localRequest(small))); await assertImage(await uncached.handleRequest(localRequest(small)));
  assert.equal(registrations, 3);
});

test('security/resource maxima cannot be raised through constructor bounds', () => {
  for (const options of [{maxResponseBytes: 2 * 1024 * 1024 + 1}, {timeoutMs: 8001}, {maxConcurrent: 5}, {maxQueued: 33},
    {maxCacheBytes: 32 * 1024 * 1024 + 1}, {maxRegisteredUrls: 513}, {maxDimension: 2049}, {maxPixels: 4_000_001},
    {maxDiskBytes: 128 * 1024 * 1024 + 1}, {maxDiskEntries: 513}, {maxWaiters: 129}, {maxConcurrent: 0}, {timeoutMs: NaN},
    {cacheDirectory: 'relative/cache'}]) assert.throws(() => createAppleArtworkService(options), TypeError);
});

test('successful downloads persist atomically and a fresh offline service reads validated disk images', async t => {
  const directory = await folder(t), cacheDirectory = path.join(directory, 'cache');
  let calls = 0;
  const first = createAppleArtworkService({cacheDirectory, fetchImpl: async () => {calls++; return upstream();}});
  const local = first.urlFor(remote());
  assert.deepEqual(await fs.readdir(directory), []); // urlFor performs no disk IO.
  const response = await first.handleRequest(localRequest(local));
  assert.equal(response.headers.get('x-still-artwork-cache'), 'disk'); await assertImage(response); await first.close();
  const files = await fs.readdir(cacheDirectory);
  assert.deepEqual(files, [`${idFor(local)}.png`]); assert.equal(calls, 1);
  assert.deepEqual(await fs.readFile(path.join(cacheDirectory, files[0])), PNG);
  const second = service(t, {cacheDirectory, fetchImpl: async () => {throw new Error('offline');}});
  assert.equal((await second.handleRequest(localRequest(local))).status, 404); // Disk is never a URL registration oracle.
  assert.equal(second.urlFor(remote()), local);
  const offline = await second.handleRequest(localRequest(local));
  assert.equal(offline.headers.get('x-still-artwork-cache'), 'disk'); await assertImage(offline);
});

test('corrupted, oversize and wrong-dimension disk files are not served as valid artwork', async t => {
  for (const bytes of [Buffer.from('<html>fixture</html>'), png(4096, 1), Buffer.alloc(2 * 1024 * 1024 + 1)]) {
    const cacheDirectory = await folder(t); let calls = 0;
    const value = service(t, {cacheDirectory, fetchImpl: async () => {calls++; throw new Error('offline');}});
    const local = value.urlFor(remote());
    await fs.writeFile(path.join(cacheDirectory, `${idFor(local)}.png`), bytes);
    assert.equal((await value.handleRequest(localRequest(local))).status, 502); assert.equal(calls, 1);
    assert.deepEqual(await fs.readdir(cacheDirectory), []);
  }
});

test('disk LRU bounds total bytes and entries, and touches real offline reads', async t => {
  const cacheDirectory = await folder(t), value = createAppleArtworkService({cacheDirectory, maxCacheEntries: 0,
    maxDiskEntries: 2, maxDiskBytes: PNG.length * 2, fetchImpl: async () => upstream()});
  const [a, b, c] = ['a', 'b', 'c'].map(name => value.urlFor(remote(name)));
  for (const local of [a, b, a, c]) await assertImage(await value.handleRequest(localRequest(local)));
  await value.close();
  const files = await fs.readdir(cacheDirectory);
  assert.deepEqual(files.sort(), [`${idFor(a)}.png`, `${idFor(c)}.png`].sort());
  const stats = await Promise.all(files.map(file => fs.stat(path.join(cacheDirectory, file))));
  assert.ok(stats.reduce((total, stat) => total + stat.size, 0) <= PNG.length * 2);
  const restarted = service(t, {cacheDirectory, maxDiskBytes: PNG.length - 1, fetchImpl: async () => {throw new Error('offline');}});
  assert.equal((await restarted.handleRequest(localRequest(restarted.urlFor(remote('c'))))).status, 502);
  assert.deepEqual(await fs.readdir(cacheDirectory), []);
});

test('cache write failure stays memory-only and close leaves no partial files', async t => {
  const directory = await folder(t), notDirectory = path.join(directory, 'file'); await fs.writeFile(notDirectory, 'fixture');
  const value = service(t, {cacheDirectory: notDirectory, fetchImpl: async () => upstream()});
  const response = await value.handleRequest(localRequest(value.urlFor(remote())));
  assert.equal(response.headers.get('x-still-artwork-cache'), 'memory'); await assertImage(response);
  assert.equal(await fs.readFile(notDirectory, 'utf8'), 'fixture');
  const cacheDirectory = path.join(directory, 'cache'), gate = deferred();
  const closing = createAppleArtworkService({cacheDirectory, fetchImpl: async () => gate.promise});
  const pending = closing.handleRequest(localRequest(closing.urlFor(remote())));
  await tick(); await closing.close(); assert.equal((await pending).status, 503); gate.resolve(upstream()); await tick();
  const files = await fs.readdir(cacheDirectory).catch(error => {if (error.code === 'ENOENT') return []; throw error;});
  assert.deepEqual(files, []);
});

test('cache never follows directory links, file symlinks, or hardlinks', async t => {
  const directory = await folder(t), external = path.join(directory, 'external'); await fs.mkdir(external);
  const linked = path.join(directory, 'linked'); await fs.symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const value = service(t, {cacheDirectory: linked, fetchImpl: async () => upstream()});
  let result = await value.handleRequest(localRequest(value.urlFor(remote())));
  assert.equal(result.headers.get('x-still-artwork-cache'), 'memory'); await assertImage(result);
  assert.deepEqual(await fs.readdir(external), []);
  for (const kind of ['hardlink', 'symlink']) {
    const cacheDirectory = path.join(directory, kind); await fs.mkdir(cacheDirectory);
    const protectedFile = path.join(external, `${kind}.png`); await fs.writeFile(protectedFile, PNG);
    const cached = service(t, {cacheDirectory, fetchImpl: async () => {throw new Error('offline');}});
    const local = cached.urlFor(remote()), target = path.join(cacheDirectory, `${idFor(local)}.png`);
    if (kind === 'hardlink') await fs.link(protectedFile, target); else await fs.symlink(protectedFile, target, 'file');
    result = await cached.handleRequest(localRequest(local)); assert.equal(result.status, 502);
    assert.deepEqual(await fs.readFile(protectedFile), PNG);
    assert.equal((await fs.lstat(target)).isSymbolicLink(), kind === 'symlink');
  }
});

test('cache initialization only cleans its own bounded image/temp filenames', async t => {
  const cacheDirectory = await folder(t), value = service(t, {cacheDirectory, fetchImpl: async () => upstream()});
  const stale = `${'a'.repeat(64)}.00000000-0000-0000-0000-000000000000.tmp`;
  await fs.writeFile(path.join(cacheDirectory, stale), 'partial'); await fs.writeFile(path.join(cacheDirectory, 'keep.txt'), 'fixture');
  await assertImage(await value.handleRequest(localRequest(value.urlFor(remote()))));
  const files = await fs.readdir(cacheDirectory);
  assert.equal(files.includes(stale), false); assert.equal(await fs.readFile(path.join(cacheDirectory, 'keep.txt'), 'utf8'), 'fixture');
});

const MBID = '76df3287-6cda-33eb-8e9a-044b5e15ffdd';
const CAA = `https://coverartarchive.org/release/${MBID}/front-500`;
const caaFile = `mbid-${MBID}-829521842_thumb500.jpg`;
const archiveImage = `https://archive.org/download/mbid-${MBID}/${caaFile}`;
const storageImage = (server = 'ia800308.us.archive.org', shard = '21', file = caaFile) => `https://${server}/${shard}/items/mbid-${MBID}/${file}`;
const redirect = (location, status = 307) => new Response(null, {status, headers: {location}});

test('CAA registers only a canonical UUID release/front-500 entry without fetching', async t => {
  let calls = 0;
  const value = service(t, {fetchImpl: async () => {calls++; throw new Error('offline');}});
  const local = value.urlFor(CAA);
  assert.match(local, /^still-apple-art:\/\/art\/[a-f0-9]{64}$/);
  assert.equal(local, value.urlFor(CAA.replace('.org/', '.org:443/')));
  const invalid = [CAA.replace('https:', 'http:'), CAA.replace('coverartarchive.org', 'coverartarchive.org.evil.test'),
    CAA.replace('coverartarchive.org', 'beta.coverartarchive.org'), CAA.replace('https://', 'https://user:secret@'),
    CAA.replace('.org/', '.org:444/'), CAA + '?x=1', CAA + '?', CAA + '#x', CAA + '#', CAA + '\n', ' ' + CAA,
    CAA.replace('/release/', '/release-group/'), CAA.replace('/release/', '/release/../release/'),
    CAA.replace('front-500', 'front'), CAA.replace('front-500', 'front-500.jpg'), CAA.replace('front-500', 'back-500'),
    CAA.replace('front-500', 'front-1200'), CAA.replace(MBID, '00000000-0000-0000-0000-000000000000'),
    CAA.replace(MBID, MBID.toUpperCase()), CAA.replace(MBID, MBID.replace('33eb', '93eb')),
    CAA.replace(MBID, MBID.replace('8e9a', '0e9a')), CAA.replace('/front', '/%66ront'), archiveImage, storageImage()];
  for (const url of invalid) assert.equal(value.urlFor(url), '', url);
  assert.equal(calls, 0);
});

test('CAA follows only the same release and same 500px image through public archive storage', async t => {
  for (const suffix of ['_thumb500.jpg', '-500.jpg']) {
    let cancelled = 0;
    const file = `mbid-${MBID}-829521842${suffix}`, first = `https://archive.org/download/mbid-${MBID}/${file}`;
    const final = storageImage('ia600308.us.archive.org', '21', file), calls = [];
    const value = service(t, {fetchImpl: async (url, options) => {
      calls.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit'); assert.equal(options.referrer, '');
      assert.deepEqual(options.headers, {Accept: 'image/jpeg, image/png'});
      if (url === final) return upstream(JPEG, 'image/jpeg');
      return new Response(new ReadableStream({cancel() {cancelled++;}}), {status: 307, headers: {location: url === CAA ? first : final}});
    }});
    const local = value.urlFor(CAA);
    assert.equal(local.includes(MBID), false);
    await assertImage(await value.handleRequest(localRequest(local, {headers: {authorization: 'secret', cookie: 'secret'}})), JPEG, 'image/jpeg');
    assert.deepEqual(calls, [CAA, first, final]); assert.equal(cancelled, 2);
  }
});

test('CAA redirect rejection never fetches arbitrary hosts, unsafe paths or a changed release', async t => {
  const wrongMbid = '99b09d02-9cc9-3fed-8431-f162165a9371';
  const bad = [archiveImage.replace('https:', 'http:'), archiveImage.replace('archive.org', 'archive.org.evil.test'),
    archiveImage.replace('archive.org', '127.0.0.1'), archiveImage.replace('archive.org', '[::1]'),
    archiveImage.replace('archive.org', '192.168.1.1'), archiveImage.replace('archive.org', '169.254.169.254'),
    archiveImage.replace('archive.org', 'internal.archive.org'), archiveImage.replace('archive.org', 's3.us.archive.org'),
    archiveImage.replace('https://', 'https://user:secret@'), archiveImage.replace('.org/', '.org:444/'),
    archiveImage + '?token=secret', archiveImage + '?', archiveImage + '#', archiveImage.replace('/download/', '/download /'),
    archiveImage.replace('/download/', '/download/../download/'), archiveImage.replace('/download/', '/%64ownload/'),
    archiveImage.replace('/download/', '/serve/'), archiveImage.replace(MBID, wrongMbid),
    archiveImage.replace(caaFile, caaFile.replace(MBID, wrongMbid)),
    archiveImage.replace('_thumb500.jpg', '.jpg'), archiveImage.replace('_thumb500.jpg', '_thumb1200.jpg'),
    archiveImage.replace('_thumb500.jpg', '_thumb500.svg'), archiveImage.replace('_thumb500.jpg', '_thumb500.html'),
    archiveImage.replace('829521842', '0'), archiveImage.replace('829521842', '9'.repeat(21)),
    storageImage('ia800308.us.archive.org.evil.test'), storageImage('ia800308.local.archive.org'),
    storageImage('ia8.us.archive.org'), storageImage('ia800308.us.archive.org', '../21'),
    CAA, CAA.replace(MBID, wrongMbid), '/download/fixture.jpg', '//archive.org/download/fixture.jpg'];
  for (const destination of bad) {
    const calls = [], value = service(t, {fetchImpl: async url => {calls.push(url); return redirect(destination);}});
    const result = await value.handleRequest(localRequest(value.urlFor(CAA)));
    assert.equal(result.status, 502, destination); assert.equal(await result.text(), 'Artwork unavailable.');
    assert.deepEqual(calls, [CAA], destination);
  }
});

test('CAA locks image identity and permits at most three redirects with no loops', async t => {
  const nodes = [CAA, archiveImage, storageImage('ia600308.us.archive.org', '21'), storageImage('ia800308.eu.archive.org', '31')];
  const calls = [], allowed = service(t, {fetchImpl: async url => {
    calls.push(url); const next = nodes[nodes.indexOf(url) + 1];
    return next ? redirect(next, 302) : upstream(JPEG, 'image/jpeg');
  }});
  await assertImage(await allowed.handleRequest(localRequest(allowed.urlFor(CAA))), JPEG, 'image/jpeg'); assert.deepEqual(calls, nodes);
  for (const chain of [
    [...nodes, storageImage('ia700308.us.archive.org', '41')],
    [CAA, archiveImage, archiveImage],
    [CAA, archiveImage, storageImage('ia600308.us.archive.org', '21', caaFile.replace('829521842', '829521843'))],
    [CAA, archiveImage, storageImage('ia600308.us.archive.org', '21', caaFile.replace('_thumb500', '-500'))],
  ]) {
    const seen = [], value = service(t, {fetchImpl: async url => {seen.push(url); return redirect(chain[seen.length]);}});
    assert.equal((await value.handleRequest(localRequest(value.urlFor(CAA)))).status, 502);
    assert.ok(seen.length <= 4); assert.deepEqual(seen, chain.slice(0, seen.length));
  }
});

test('CAA retains image MIME, byte and pixel limits after redirects and never retries failures', async t => {
  for (const response of [upstream(Buffer.from('<svg/>'), 'image/png'), upstream(PNG, 'text/html'),
    upstream(png(4096, 1)), upstream(Buffer.alloc(2 * 1024 * 1024 + 1)), new Response(null, {status: 404}),
    new Response(null, {status: 429}), new Response(null, {status: 300})]) {
    const calls = [], value = service(t, {fetchImpl: async url => {calls.push(url); return url === CAA ? redirect(archiveImage) : response;}});
    assert.equal((await value.handleRequest(localRequest(value.urlFor(CAA)))).status, 502);
    assert.deepEqual(calls, [CAA, archiveImage]);
  }
});

test('CAA redirects share the original deadline and subscriber cancellation signal', async t => {
  let signal, cancelled = false;
  const calls = [], value = service(t, {timeoutMs: 25, fetchImpl: async (url, options) => {
    calls.push(url); signal = options.signal;
    if (url === CAA) return redirect(archiveImage);
    return new Response(new ReadableStream({cancel() {cancelled = true;}}), {headers: {'content-type': 'image/jpeg'}});
  }});
  assert.equal((await value.handleRequest(localRequest(value.urlFor(CAA)))).status, 504);
  assert.deepEqual(calls, [CAA, archiveImage]); assert.equal(signal.aborted, true); assert.equal(cancelled, true);
  const controller = new AbortController(), secondCalls = [];
  const aborted = service(t, {fetchImpl: async url => {secondCalls.push(url); controller.abort(); return redirect(archiveImage);}});
  assert.equal((await aborted.handleRequest(localRequest(aborted.urlFor(CAA), {signal: controller.signal}))).status, 499);
  assert.deepEqual(secondCalls, [CAA]);
});

test('CAA and Apple jobs share concurrency/dedupe limits while Apple still refuses redirects', async t => {
  const gate = deferred(), calls = [], value = service(t, {maxConcurrent: 1, maxQueued: 1, fetchImpl: async url => {
    calls.push(url); if (url === CAA) return gate.promise;
    return url === archiveImage ? upstream(JPEG, 'image/jpeg') : redirect(archiveImage);
  }});
  const caa = value.urlFor(CAA), apple = value.urlFor(remote());
  const first = value.handleRequest(localRequest(caa)), duplicate = value.handleRequest(localRequest(caa)), queued = value.handleRequest(localRequest(apple));
  await tick(); assert.deepEqual(calls, [CAA]);
  assert.equal((await value.handleRequest(localRequest(value.urlFor(remote('overflow'))))).status, 503);
  gate.resolve(redirect(archiveImage));
  await assertImage(await first, JPEG, 'image/jpeg'); await assertImage(await duplicate, JPEG, 'image/jpeg');
  assert.equal((await queued).status, 502); assert.deepEqual(calls, [CAA, archiveImage, remote()]);
});

test('CAA successful public image is cached under its entry ID and fresh service reads offline', async t => {
  const cacheDirectory = await folder(t), calls = [];
  const first = createAppleArtworkService({cacheDirectory, fetchImpl: async url => {
    calls.push(url); return url === CAA ? redirect(archiveImage) : upstream(JPEG, 'image/jpeg');
  }});
  const local = first.urlFor(CAA), result = await first.handleRequest(localRequest(local));
  assert.equal(result.headers.get('x-still-artwork-cache'), 'disk'); await assertImage(result, JPEG, 'image/jpeg'); await first.close();
  assert.deepEqual(calls, [CAA, archiveImage]); assert.deepEqual(await fs.readdir(cacheDirectory), [`${idFor(local)}.jpg`]);
  const offline = service(t, {cacheDirectory, fetchImpl: async () => {throw new Error('offline');}});
  assert.equal(offline.urlFor(CAA), local);
  await assertImage(await offline.handleRequest(localRequest(local)), JPEG, 'image/jpeg');
});

async function assertUncachedFailure(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(await response.text(), 'Artwork unavailable.');
}

test('same stable Apple URL recovers after HTTP/network/image failure without negative caching', async t => {
  for (const fail of [() => new Response(null, {status: 404}), () => new Response(null, {status: 503}),
    () => {throw new Error('Temporary offline.');}, () => upstream(Buffer.from('<html>temporary</html>')),
    () => redirect('https://127.0.0.1/private')]) {
    let calls = 0;
    const value = service(t, {maxConcurrent: 1, fetchImpl: async () => ++calls === 1 ? fail() : upstream()});
    const local = value.urlFor(remote());
    await assertUncachedFailure(await value.handleRequest(localRequest(local)), 502);
    assert.equal(value.urlFor(remote()), local);
    await assertImage(await value.handleRequest(localRequest(local)));
    await assertImage(await value.handleRequest(localRequest(local)));
    assert.equal(calls, 2); assert.equal(local.includes('?'), false);
  }
});

test('same CAA entry recovers after missing front image and persists only successful bytes', async t => {
  const cacheDirectory = await folder(t); let calls = 0;
  const value = service(t, {cacheDirectory, fetchImpl: async url => {
    calls++; if (calls === 1) return new Response(null, {status: 404});
    return url === CAA ? redirect(archiveImage) : upstream(JPEG, 'image/jpeg');
  }});
  const local = value.urlFor(CAA);
  await assertUncachedFailure(await value.handleRequest(localRequest(local)), 502);
  assert.deepEqual(await fs.readdir(cacheDirectory), []);
  assert.equal(value.urlFor(CAA), local);
  const recovered = await value.handleRequest(localRequest(local));
  assert.equal(recovered.headers.get('x-still-artwork-cache'), 'disk'); await assertImage(recovered, JPEG, 'image/jpeg');
  assert.equal(calls, 3); assert.deepEqual(await fs.readdir(cacheDirectory), [`${idFor(local)}.jpg`]);
});

test('all protocol failures are no-store and registering a formerly unknown ID allows the same URL', async t => {
  let calls = 0;
  const value = service(t, {fetchImpl: async () => {calls++; return upstream();}});
  const local = `still-apple-art://art/${createHash('sha256').update(remote()).digest('hex')}`;
  await assertUncachedFailure(await value.handleRequest(localRequest(local)), 404); assert.equal(calls, 0);
  assert.equal(value.urlFor(remote()), local);
  await assertUncachedFailure(await value.handleRequest(localRequest(local, {method: 'POST'})), 405);
  const controller = new AbortController(); controller.abort();
  await assertUncachedFailure(await value.handleRequest(localRequest(local, {signal: controller.signal})), 499);
  await assertImage(await value.handleRequest(localRequest(local))); assert.equal(calls, 1);
});

test('busy and timed-out requests can retry the identical URL after bounded transport cleanup', async t => {
  let calls = 0; const gate = deferred();
  const busy = service(t, {maxConcurrent: 1, maxQueued: 0, fetchImpl: async () => ++calls === 1 ? gate.promise : upstream()});
  const first = busy.handleRequest(localRequest(busy.urlFor(remote('held')))), local = busy.urlFor(remote('retry'));
  await tick(); await assertUncachedFailure(await busy.handleRequest(localRequest(local)), 503);
  gate.resolve(upstream()); await assertImage(await first); await tick();
  await assertImage(await busy.handleRequest(localRequest(local))); assert.equal(calls, 2);
  let attempts = 0;
  const timed = service(t, {timeoutMs: 25, maxConcurrent: 1, fetchImpl: async () => {
    if (++attempts > 1) return upstream();
    return new Response(new ReadableStream({start() {}, cancel() {}}), {headers: {'content-type': 'image/png'}});
  }});
  const stable = timed.urlFor(remote());
  await assertUncachedFailure(await timed.handleRequest(localRequest(stable)), 504); await tick();
  assert.equal(timed.urlFor(remote()), stable); await assertImage(await timed.handleRequest(localRequest(stable))); assert.equal(attempts, 2);
});
