'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const {imageExtension, imageDimensions} = require('./library-metadata');
const {createMediaFileReader} = require('./media-file-safety');

const COVER_LIMITS = Object.freeze({maxSourceBytes: 20 * 1024 * 1024, maxVariantBytes: 8 * 1024 * 1024,
  maxPixels: 40 * 1024 * 1024, maxSourceEdge: 16384, thumbnailEdge: 96, largeEdge: 768, quality: 82, version: 1});
const COVER_NAMES = Object.freeze(['cover', 'folder', 'front', 'album'].flatMap(name => ['jpg', 'jpeg', 'png', 'webp', 'gif'].map(extension => `${name}.${extension}`)));
const COVER_URL = /^still-cover:\/\/art\/([a-f0-9]{64})\.(jpg|png|gif|webp)$/;
function coverUrls(record) {
  return [...new Set([...['coverUrl', 'coverThumbnailUrl', 'coverLargeUrl', '_embeddedCoverUrl'].map(key => record?.[key]),
    record?._coverVariants?.thumbnail?.url, record?._coverVariants?.large?.url].filter(url => typeof url === 'string' && COVER_URL.test(url)))];
}

function remember(cache, key, value) {
  cache.set(key, value);
  if (cache.size > 32) cache.delete(cache.keys().next().value);
}

function allowedDimensions(size) {
  return size && size.width <= COVER_LIMITS.maxSourceEdge && size.height <= COVER_LIMITS.maxSourceEdge && size.width * size.height <= COVER_LIMITS.maxPixels;
}

function createLocalCoverService({storage, fileSystem, coverTransform} = {}) {
  const reader = createMediaFileReader({fileSystem});
  const variants = new Map();
  // Only identities, URLs and dimensions are shared during a scan. Reusing an
  // entry still checks the named regular file and every directory ancestor.
  const sidecars = new Map(), managed = new Map();
  async function save(bytes) {
    if (!ArrayBuffer.isView(bytes) || !bytes.byteLength || bytes.byteLength > COVER_LIMITS.maxSourceBytes) return '';
    bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const extension = imageExtension(bytes);
    if (!extension) return '';
    const filename = `${crypto.createHash('sha256').update(bytes).digest('hex')}.${extension}`, target = path.join(storage.coversDir, filename);
    await storage.assertDirectories(storage.coversDir);
    const existing = await storage.readRegular(target, {missing: true});
    if (existing) {
      if (!existing.equals(bytes)) throw new Error('An existing managed cover does not match its content hash.');
    } else await storage.writeAtomic(target, bytes);
    return `still-cover://art/${filename}`;
  }
  async function load(url, {includeBytes = false} = {}) {
    const match = COVER_URL.exec(url || '');
    if (!match) return null;
    const target = path.join(storage.coversDir, `${match[1]}.${match[2]}`);
    const cached = managed.get(url);
    if (!includeBytes && cached && (await reader.inspect(target)).identity === cached.identity) return cached;
    managed.delete(url);
    const {bytes, identity} = await reader.read(target, {maxBytes: COVER_LIMITS.maxSourceBytes});
    if (imageExtension(bytes) !== match[2] || crypto.createHash('sha256').update(bytes).digest('hex') !== match[1]) return null;
    const image = {identity, size: imageDimensions(bytes)};
    remember(managed, url, image);
    return {...image, bytes};
  }
  async function sidecar(audioPath) {
    for (const name of COVER_NAMES) {
      const target = path.join(path.dirname(audioPath), name);
      try {
        const cached = sidecars.get(target);
        if (cached && (await reader.inspect(target)).identity === cached.identity) {
          const image = await load(cached.url).catch(() => null);
          if (image) return {url: cached.url, image};
        }
        const {bytes, identity} = await reader.read(target, {maxBytes: COVER_LIMITS.maxSourceBytes});
        if (!allowedDimensions(imageDimensions(bytes))) continue;
        const url = await save(bytes);
        const image = await load(url);
        if (image) {
          remember(sidecars, target, {identity, url});
          return {url, image};
        }
      } catch { /* An absent, linked, oversized or unreadable candidate grants no additional access. */ }
    }
    return {};
  }
  async function variant(sourceUrl, size, sourceBytes, maxEdge, previous) {
    const sourceHash = COVER_URL.exec(sourceUrl)[1];
    const key = `${sourceHash}:${maxEdge}:${COVER_LIMITS.quality}:${COVER_LIMITS.version}`;
    if (!allowedDimensions(size)) return {url: sourceUrl};
    if (Math.max(size.width, size.height) <= maxEdge) return {url: sourceUrl, key};
    const cached = previous?.key === key ? previous : variants.get(key);
    if (cached && COVER_URL.test(cached.url)) {
      try {
        const image = await load(cached.url);
        if (image?.size && Math.max(image.size.width, image.size.height) <= maxEdge) return {url: cached.url, key};
      } catch { /* A missing/bad derived cache is regenerated from the read-only source. */ }
    }
    if (typeof coverTransform !== 'function') return {url: sourceUrl};
    try {
      const bytes = await sourceBytes();
      if (!bytes) return {url: sourceUrl};
      // A processor receives a copy; mutating it cannot alter source/cache bytes.
      const output = await coverTransform(Buffer.from(bytes), {maxEdge, quality: COVER_LIMITS.quality});
      if (!ArrayBuffer.isView(output) || !output.byteLength || output.byteLength > COVER_LIMITS.maxVariantBytes) return {url: sourceUrl};
      const resized = imageDimensions(output);
      if (!resized || Math.max(resized.width, resized.height) > maxEdge) return {url: sourceUrl};
      const url = await save(output);
      if (url) {
        const result = {url, key};
        remember(variants, key, result);
        return result;
      }
    } catch { /* An invalid transformation leaves the verified source available. */ }
    return {url: sourceUrl};
  }
  async function decorate(record, embeddedUrl) {
    const artwork = embeddedUrl ? {url: embeddedUrl, image: await load(embeddedUrl).catch(() => null)} : await sidecar(record.path);
    const sourceUrl = artwork.url || '';
    const result = {...record, coverUrl: sourceUrl, coverThumbnailUrl: sourceUrl, coverLargeUrl: sourceUrl,
      coverSource: sourceUrl ? embeddedUrl ? 'embedded' : 'sidecar' : '', _embeddedCoverUrl: embeddedUrl || ''};
    delete result._coverVariants;
    if (!artwork.image) return result;
    let bytes = artwork.image.bytes;
    async function sourceBytes() {
      bytes ||= (await load(sourceUrl, {includeBytes: true}))?.bytes;
      return bytes;
    }
    const small = await variant(sourceUrl, artwork.image.size, sourceBytes, COVER_LIMITS.thumbnailEdge, record._coverVariants?.thumbnail);
    const large = await variant(sourceUrl, artwork.image.size, sourceBytes, COVER_LIMITS.largeEdge, record._coverVariants?.large);
    result.coverThumbnailUrl = small.url; result.coverLargeUrl = large.url;
    result._coverVariants = {thumbnail: small, large};
    return result;
  }
  function clearScan() { sidecars.clear(); managed.clear(); }
  return {save, decorate, clearScan, clear() { clearScan(); variants.clear(); }};
}

module.exports = {createLocalCoverService, coverUrls, COVER_URL, COVER_LIMITS, COVER_NAMES};
