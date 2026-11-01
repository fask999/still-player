'use strict';

const {createHash} = require('node:crypto');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs/promises');
const {constants: FS} = require('node:fs');
const path = require('node:path');

// This module has no account/session, Electron, or renderer access. Its optional
// persistent cache accesses only the explicitly supplied cache directory.
// Artwork templates are documented by Apple at:
// https://developer.apple.com/documentation/applemusicapi/artwork
const LIMITS = Object.freeze({maxResponseBytes: 2 * 1024 * 1024, timeoutMs: 8000,
  maxConcurrent: 4, maxQueued: 32, maxWaiters: 128, maxCacheBytes: 32 * 1024 * 1024,
  maxCacheEntries: 128, maxRegisteredUrls: 512, maxDimension: 2048, maxPixels: 4_000_000,
  maxDiskBytes: 128 * 1024 * 1024, maxDiskEntries: 512});
const LOCAL_URL = /^still-apple-art:\/\/art\/([a-f0-9]{64})$/;
const PUBLIC_URL = /^https:\/\/(is[1-5]-ssl\.mzstatic\.com)(?::443)?(\/image\/thumb\/(?:[A-Za-z0-9._~-]+\/)+(?:\{w\}x\{h\}|512x512)(?:bb)?\.(?:jpeg|jpg|png))$/;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const CAA_ENTRY = new RegExp(`^https://coverartarchive\\.org(?::443)?/release/(${UUID})/front-500$`);
const SECURITY_HEADERS = Object.freeze({'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'cross-origin', 'referrer-policy': 'no-referrer'});

function normalizePublicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\%?#]/.test(value)) return '';
  const caa = CAA_ENTRY.exec(value);
  if (caa) return `https://coverartarchive.org/release/${caa[1]}/front-500`;
  const match = PUBLIC_URL.exec(value);
  if (!match || match[2].split('/').some(part => part === '.' || part === '..')) return '';
  try {
    const pathname = match[2].replace('{w}x{h}', '512x512');
    const url = new URL(value.replace('{w}x{h}', '512x512'));
    if (url.protocol !== 'https:' || url.hostname !== match[1] || url.port || url.username || url.password || url.search || url.hash || url.pathname !== pathname) return '';
    return `https://${match[1]}${pathname}`;
  } catch {return '';}
}

// CAA's official redirect implementation names 500px files *_thumb500.jpg;
// its API documentation also specifies the legacy *-500.jpg representation.
// https://github.com/metabrainz/artwork-redirect/blob/master/artwork_redirect/request.py
// A hosting URL can only originate from this fixed CAA entry, never urlFor.
function archiveRedirect(value, mbid, previousFile) {
  if (typeof value !== 'string' || value.length > 1024 || /[\s\\%?#]/.test(value)) return null;
  if (!/^https:\/\/(?:archive\.org|ia[0-9]{6,12}\.(?:us|eu)\.archive\.org)(?::443)?\//.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== value.slice(value.indexOf('/', 8))) return null;
    const prefix = url.hostname === 'archive.org' ? '/download' : '/[0-9]{1,2}/items';
    const pattern = new RegExp(`^${prefix}/mbid-${mbid}/(mbid-${mbid}-[1-9][0-9]{0,19}(?:_thumb500|-500)\\.jpg)$`);
    const match = pattern.exec(url.pathname);
    if (!match || (previousFile && previousFile !== match[1])) return null;
    return {url: url.href, file: match[1]};
  } catch {return null;}
}

function bound(value, name, allowZero = false) {
  const selected = value === undefined ? LIMITS[name] : value;
  if (!Number.isSafeInteger(selected) || selected < (allowZero ? 0 : 1) || selected > LIMITS[name]) throw new TypeError('Invalid artwork service limit.');
  return selected;
}
function unavailable(status) {
  return new Response('Artwork unavailable.', {status, headers: {...SECURITY_HEADERS,
    pragma: 'no-cache', 'content-type': 'text/plain; charset=utf-8'}});
}
function imageResponse(entry) {
  return new Response(entry.blob, {status: 200, headers: {...SECURITY_HEADERS,
    'content-type': entry.type, 'content-length': String(entry.size),
    'x-still-artwork-cache': entry.persisted ? 'disk' : 'memory'}});
}
function quietlyCancel(body) {
  try {Promise.resolve(body?.cancel()).catch(() => {});} catch {}
}
function invalidImage() {throw new Error('Invalid artwork image.');}
function dimensions(width, height, limits) {
  if (!width || !height || width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels) invalidImage();
}

const CRC_TABLE = Uint32Array.from({length: 256}, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function validatePng(bytes, limits) {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalidImage();
  let offset = 8, chunks = 0, header = false, palette = false, data = false, dataBytes = 0, dataEnded = false, color;
  while (offset + 12 <= bytes.length && ++chunks <= 8192) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) invalidImage();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!bytes.subarray(offset + 4, offset + 8).every(byte => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) || crc32(bytes, offset + 4, end - 4) !== bytes.readUInt32BE(end - 4)) invalidImage();
    if (!header && type !== 'IHDR') invalidImage();
    if (type === 'IHDR') {
      if (header || length !== 13) invalidImage();
      dimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12), limits);
      const depth = bytes[offset + 16]; color = bytes[offset + 17];
      const depths = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]};
      if (!depths[color]?.includes(depth) || bytes[offset + 18] || bytes[offset + 19] || bytes[offset + 20] > 1) invalidImage();
      header = true;
    } else if (type === 'PLTE') {
      if (palette || data || !length || length > 768 || length % 3 || color === 0 || color === 4) invalidImage();
      palette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (color === 3 && !palette)) invalidImage();
      data = true; dataBytes += length;
    } else if (type === 'IEND') {
      if (length || !dataBytes || end !== bytes.length) invalidImage();
      return;
    } else {
      // Reject animation: a small canvas must not hide arbitrarily many frames.
      if (['acTL', 'fcTL', 'fdAT'].includes(type) || type[0] === type[0].toUpperCase()) invalidImage();
      if (data) dataEnded = true;
    }
    offset = end;
  }
  invalidImage();
}
function validateJpeg(bytes, limits) {
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalidImage();
  let offset = 2, frame = false, scan = false, inScan = false, markers = 0;
  while (offset < bytes.length && ++markers <= 8192) {
    if (inScan) {
      offset = bytes.indexOf(0xff, offset);
      if (offset < 0) invalidImage();
    } else if (bytes[offset] !== 0xff) invalidImage();
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) invalidImage();
    const marker = bytes[offset++];
    if (inScan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    inScan = false;
    if (marker === 0xd9) {
      if (!frame || !scan || offset !== bytes.length) invalidImage();
      return;
    }
    if (offset + 2 > bytes.length) invalidImage();
    const length = bytes.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > bytes.length) invalidImage();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || scan || length < 11 || bytes[offset + 2] !== 8) invalidImage();
      dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3), limits);
      if (![1, 3, 4].includes(bytes[offset + 7]) || length !== 8 + bytes[offset + 7] * 3) invalidImage();
      frame = true;
    } else if (marker === 0xda) {
      if (!frame || length < 8 || length !== 6 + bytes[offset + 2] * 2 || bytes[offset + 2] < 1 || bytes[offset + 2] > 4) invalidImage();
      scan = true; inScan = true;
    } else if (![0xc4, 0xdb, 0xdd, 0xfe].includes(marker) && !(marker >= 0xe0 && marker <= 0xef)) invalidImage();
    offset = end;
  }
  invalidImage();
}
function validateImage(bytes, type, limits) {
  if (type === 'image/png') validatePng(bytes, limits);
  else if (type === 'image/jpeg') validateJpeg(bytes, limits);
  else invalidImage();
}

// No URLs or account metadata need be written: the filename is the canonical
// public URL's hash, registered again via urlFor after every application start.
function createDiskCache(directory, limits, isClosed) {
  if (directory === undefined) return {read: async () => null, write: async () => false, close: async () => {}};
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.dirname(path.resolve(directory)) === path.resolve(directory)) throw new TypeError('Invalid artwork cache directory.');
  const root = path.resolve(directory), entries = new Map(), temporary = new Set();
  const filename = /^([a-f0-9]{64})\.(png|jpg)$/;
  const temporaryName = /^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/;
  let initialization, tail = Promise.resolve(), enabled = true, diskBytes = 0, accessClock = 0;
  const nextAccess = () => (accessClock = Math.max(Date.now(), accessClock + 1));
  async function safeDirectory(allowMissing = false) {
    let current = root;
    while (true) {
      try {
        const stat = await fs.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      } catch (error) {if (!(allowMissing && error.code === 'ENOENT')) return false;}
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return true;
  }
  async function regular(file) {
    try {
      const stat = await fs.lstat(path.join(root, file));
      return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 ? stat : null;
    } catch {return null;}
  }
  async function remove(file) {
    const entry = entries.get(file);
    if (!entry) return;
    // unlink never follows a file symlink. Refuse unexpected directories/files.
    if (!await safeDirectory() || !await regular(file)) {enabled = false; return;}
    await fs.unlink(path.join(root, file));
    entries.delete(file); diskBytes -= entry.size;
  }
  async function prune(incoming = 0, extraEntries = 0) {
    const oldest = [...entries.values()].sort((a, b) => a.used - b.used || a.file.localeCompare(b.file));
    for (const entry of oldest) {
      if (diskBytes + incoming <= limits.maxDiskBytes && entries.size + extraEntries <= limits.maxDiskEntries) break;
      await remove(entry.file);
      if (!enabled) return;
    }
  }
  async function initialize() {
    try {
      if (isClosed() || !await safeDirectory(true)) {enabled = false; return;}
      if (isClosed()) return;
      await fs.mkdir(root, {recursive: true, mode: 0o700});
      if (isClosed() || !await safeDirectory()) {enabled = false; return;}
      const folder = await fs.opendir(root);
      let count = 0;
      for await (const item of folder) {
        if (isClosed() || ++count > 4096) {enabled = false; return;}
        if (temporaryName.test(item.name)) {
          if (await regular(item.name)) await fs.unlink(path.join(root, item.name));
          continue;
        }
        if (!filename.test(item.name)) continue;
        const stat = await regular(item.name);
        if (!stat) {enabled = false; return;}
        entries.set(item.name, {file: item.name, size: stat.size, used: stat.mtimeMs}); diskBytes += stat.size;
        accessClock = Math.max(accessClock, stat.mtimeMs);
      }
      await prune();
    } catch {enabled = false;}
  }
  function transaction(work) {
    if (!initialization) initialization = initialize();
    const task = tail.then(async () => {await initialization; if (!enabled || isClosed()) return null; return work();});
    tail = task.catch(() => {});
    return task.catch(() => null);
  }
  return {
    read(id, job) {
      return transaction(async () => {
        for (const extension of ['png', 'jpg']) {
          const file = `${id}.${extension}`, known = entries.get(file);
          if (!known || job.done) continue;
          if (!await safeDirectory()) {enabled = false; return null;}
          const before = await regular(file);
          if (!before) {enabled = false; return null;}
          if (before.size > limits.maxResponseBytes || !before.size) {await remove(file); continue;}
          let handle;
          try {
            handle = await fs.open(path.join(root, file), FS.O_RDONLY | (FS.O_NOFOLLOW || 0));
            const actual = await handle.stat();
            if (!actual.isFile() || actual.nlink !== 1 || actual.ino !== before.ino || actual.dev !== before.dev || actual.size > limits.maxResponseBytes) return null;
            // Fixed-size reads enforce the byte bound even if a file grows after stat.
            const buffer = Buffer.alloc(Math.min(actual.size + 1, limits.maxResponseBytes + 1));
            let size = 0;
            while (size < buffer.length && !job.done && !isClosed()) {
              const read = await handle.read(buffer, size, Math.min(65536, buffer.length - size), size);
              if (!read.bytesRead) break;
              size += read.bytesRead;
            }
            if (job.done || isClosed()) return null;
            if (size !== actual.size || size > limits.maxResponseBytes) invalidImage();
            const bytes = buffer.subarray(0, size), type = extension === 'png' ? 'image/png' : 'image/jpeg';
            validateImage(bytes, type, limits);
            const now = new Date(nextAccess()); await handle.utimes(now, now).catch(() => {}); known.used = now.getTime();
            return {blob: new Blob([bytes], {type}), size, type, persisted: true};
          } catch {
            await handle?.close().catch(() => {}); handle = null;
            await remove(file).catch(() => {});
          } finally {await handle?.close().catch(() => {});}
        }
        return null;
      });
    },
    write(id, entry, job) {
      return transaction(async () => {
        if (entry.size > limits.maxDiskBytes || !limits.maxDiskEntries || job.done || isClosed()) return false;
        if (!await safeDirectory()) {enabled = false; return false;}
        const file = `${id}.${entry.type === 'image/png' ? 'png' : 'jpg'}`;
        // Reserve the complete incoming image before creating its temporary file.
        const existing = entries.get(file);
        if (existing && !await regular(file)) {enabled = false; return false;}
        if (existing) await remove(file);
        await prune(entry.size, 1);
        if (!enabled || job.done || isClosed()) return false;
        const temp = `${id}.${randomUUID()}.tmp`, tempPath = path.join(root, temp);
        temporary.add(temp);
        let handle;
        try {
          handle = await fs.open(tempPath, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | (FS.O_NOFOLLOW || 0), 0o600);
          const bytes = new Uint8Array(await entry.blob.arrayBuffer());
          if (job.done || isClosed()) return false;
          await handle.writeFile(bytes, {signal: job.controller.signal});
          await handle.close(); handle = null;
          if (job.done || isClosed() || !await safeDirectory() || !await regular(temp)) return false;
          const destination = await fs.lstat(path.join(root, file)).catch(error => {if (error.code !== 'ENOENT') throw error; return null;});
          if (destination && (!destination.isFile() || destination.isSymbolicLink() || destination.nlink !== 1)) {enabled = false; return false;}
          if (job.done || isClosed()) return false;
          await fs.rename(tempPath, path.join(root, file));
          if (entries.has(file)) diskBytes -= entries.get(file).size;
          entries.set(file, {file, size: entry.size, used: nextAccess()}); diskBytes += entry.size;
          temporary.delete(temp);
          return true;
        } finally {
          await handle?.close().catch(() => {});
          if (temporary.has(temp)) {
            if (await safeDirectory() && await regular(temp)) await fs.unlink(tempPath).catch(() => {});
            temporary.delete(temp);
          }
        }
      }).then(Boolean);
    },
    async close() {await initialization; await tail; entries.clear();}
  };
}

function createAppleArtworkService({fetchImpl = globalThis.fetch, cacheDirectory, ...options} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Artwork transport unavailable.');
  const limits = Object.fromEntries(Object.keys(LIMITS).map(name => [name, bound(options[name], name, ['maxQueued', 'maxCacheBytes', 'maxCacheEntries', 'maxDiskBytes', 'maxDiskEntries'].includes(name))]));
  const registered = new Map(), cache = new Map(), jobs = new Map(), activeJobs = new Set(), queue = [];
  let closed = false, cacheBytes = 0, waiterCount = 0;
  const disk = createDiskCache(cacheDirectory, limits, () => closed);
  function removeCached(id) {
    const entry = cache.get(id);
    if (entry) {cacheBytes -= entry.size; cache.delete(id);}
  }
  function remember(id, entry) {
    if (closed || !registered.has(id) || !limits.maxCacheEntries || entry.size > limits.maxCacheBytes) return;
    removeCached(id); cache.set(id, entry); cacheBytes += entry.size;
    while (cache.size > limits.maxCacheEntries || cacheBytes > limits.maxCacheBytes) removeCached(cache.keys().next().value);
  }
  function settle(waiter, entry, status) {
    waiter.job.waiters.delete(waiter); waiterCount--;
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.resolve(entry ? imageResponse(entry) : unavailable(status));
  }
  function finish(job, entry, status) {
    if (job.done) return;
    job.done = true; clearTimeout(job.timer);
    if (jobs.get(job.id) === job) jobs.delete(job.id);
    const queuedIndex = queue.indexOf(job);
    if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
    if (entry) remember(job.id, entry);
    else {job.controller.abort(); quietlyCancel(job.reader);}
    for (const waiter of [...job.waiters]) settle(waiter, entry, status);
  }
  async function run(job) {
    let response;
    try {
      const cached = await disk.read(job.id, job);
      if (job.done) return;
      if (cached) {finish(job, cached, 200); return;}
      const caa = CAA_ENTRY.exec(job.url), visited = new Set([job.url]);
      let currentUrl = job.url, imageFile = '', redirects = 0;
      while (!job.done) {
        response = await fetchImpl(currentUrl, {method: 'GET', redirect: 'manual', credentials: 'omit',
          referrerPolicy: 'no-referrer', referrer: '', cache: 'no-store',
          headers: {Accept: 'image/jpeg, image/png'}, signal: job.controller.signal});
        if (job.done) {quietlyCancel(response?.body); return;}
        if (!response || response.redirected || (response.url && response.url !== currentUrl)) invalidImage();
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        if (!caa || redirects >= 3) invalidImage();
        const next = archiveRedirect(response.headers?.get('location'), caa[1], imageFile);
        if (!next || visited.has(next.url)) invalidImage();
        imageFile = next.file; visited.add(next.url); currentUrl = next.url; redirects++;
        quietlyCancel(response.body); response = null;
      }
      if (job.done) return;
      if (response?.status !== 200) invalidImage();
      const type = response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!['image/jpeg', 'image/png'].includes(type)) invalidImage();
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > limits.maxResponseBytes)) invalidImage();
      if (typeof response.body?.getReader !== 'function') invalidImage();
      const reader = job.reader = response.body.getReader(), chunks = [];
      let size = 0, reads = 0;
      while (!job.done) {
        if (++reads > 8192) invalidImage();
        const part = await reader.read();
        if (job.done) return;
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || part.value.byteLength > limits.maxResponseBytes - size) invalidImage();
        size += part.value.byteLength;
        // Copy each chunk: injected transports cannot mutate validated bytes.
        if (part.value.byteLength) chunks.push(Buffer.from(part.value));
      }
      if (job.done) return;
      const bytes = Buffer.concat(chunks, size);
      validateImage(bytes, type, limits);
      const entry = {blob: new Blob([bytes], {type}), type, size, persisted: false};
      entry.persisted = await disk.write(job.id, entry, job);
      if (!job.done) finish(job, entry, 200);
    } catch {
      finish(job, null, 502);
    } finally {
      if (!job.reader) quietlyCancel(response?.body);
      try {job.reader?.releaseLock();} catch {}
      job.reader = null; activeJobs.delete(job); drain();
    }
  }
  function drain() {
    while (!closed && activeJobs.size < limits.maxConcurrent && queue.length) {
      const job = queue.shift();
      if (job.done) continue;
      activeJobs.add(job);
      // A canceled transport retains its slot until it actually settles. Even a
      // transport that ignores AbortSignal cannot cause unbounded live fetches.
      void run(job);
    }
  }
  return {
    urlFor(value) {
      if (closed) return '';
      const url = normalizePublicUrl(value);
      if (!url) return '';
      const id = createHash('sha256').update(url).digest('hex');
      registered.delete(id); registered.set(id, url);
      while (registered.size > limits.maxRegisteredUrls) {
        const evicted = registered.keys().next().value;
        registered.delete(evicted); removeCached(evicted);
      }
      return `still-apple-art://art/${id}`;
    },
    async handleRequest(request) {
      const match = typeof request?.url === 'string' && LOCAL_URL.exec(request.url);
      if (!match || !registered.has(match[1])) return unavailable(404);
      if (closed) return unavailable(503);
      if (request.method !== 'GET') return unavailable(405);
      const signal = request.signal;
      if (signal?.aborted) return unavailable(499);
      const id = match[1], url = registered.get(id);
      registered.delete(id); registered.set(id, url);
      if (cache.has(id)) {
        const entry = cache.get(id); cache.delete(id); cache.set(id, entry);
        return imageResponse(entry);
      }
      if (waiterCount >= limits.maxWaiters) return unavailable(503);
      let job = jobs.get(id), created = false;
      if (!job) {
        if (activeJobs.size >= limits.maxConcurrent && queue.length >= limits.maxQueued) return unavailable(503);
        job = {id, url, controller: new AbortController(), waiters: new Set(), done: false, reader: null};
        jobs.set(id, job); created = true;
        job.timer = setTimeout(() => finish(job, null, 504), limits.timeoutMs);
      }
      return new Promise(resolve => {
        const waiter = {job, resolve, signal, onAbort: null};
        waiter.onAbort = () => {
          if (!job.waiters.has(waiter)) return;
          settle(waiter, null, 499);
          if (!job.waiters.size) finish(job, null, 499);
        };
        job.waiters.add(waiter); waiterCount++;
        signal?.addEventListener('abort', waiter.onAbort, {once: true});
        if (signal?.aborted) waiter.onAbort();
        if (created && !job.done) {queue.push(job); drain();}
      });
    },
    close() {
      if (closed) return disk.close();
      closed = true;
      for (const job of new Set([...jobs.values(), ...activeJobs])) finish(job, null, 503);
      queue.length = 0; jobs.clear(); registered.clear(); cache.clear(); cacheBytes = 0;
      return disk.close();
    }
  };
}

module.exports = {createAppleArtworkService};
