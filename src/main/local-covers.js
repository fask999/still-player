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

function createLocalCoverService({storage, fileSystem, coverTransform} = {}) {
  const reader = createMediaFileReader({fileSystem});
  const variants = new Map();
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
  async function load(url) {
    const match = COVER_URL.exec(url || '');
    if (!match) return null;
    const target = path.join(storage.coversDir, `${match[1]}.${match[2]}`);
    // Source cache is app-owned, but still apply a finite admission before read.
    const stat = await storage.statOrNull(target);
    if (!stat || stat.size > BigInt(COVER_LIMITS.maxSourceBytes)) return null;
    storage.assertRegular(stat, target);
    const {bytes} = await reader.read(target, {maxBytes: COVER_LIMITS.maxSourceBytes});
    if (bytes.length > COVER_LIMITS.maxSourceBytes || imageExtension(bytes) !== match[2] || crypto.createHash('sha256').update(bytes).digest('hex') !== match[1]) return null;
    return bytes;
  }
  async function sidecar(audioPath) {
    for (const name of COVER_NAMES) {
      try {
        const {bytes} = await reader.read(path.join(path.dirname(audioPath), name), {maxBytes: COVER_LIMITS.maxSourceBytes});
        const size = imageDimensions(bytes);
        if (size && size.width <= COVER_LIMITS.maxSourceEdge && size.height <= COVER_LIMITS.maxSourceEdge && size.width * size.height <= COVER_LIMITS.maxPixels) return await save(bytes);
      } catch { /* An absent, linked, oversized or unreadable candidate grants no additional access. */ }
    }
    return '';
  }
  async function variant(sourceUrl, bytes, maxEdge, previous) {
    const sourceHash = COVER_URL.exec(sourceUrl)[1];
    const key = `${sourceHash}:${maxEdge}:${COVER_LIMITS.quality}:${COVER_LIMITS.version}`;
    const dimensions = imageDimensions(bytes);
    if (!dimensions || dimensions.width > COVER_LIMITS.maxSourceEdge || dimensions.height > COVER_LIMITS.maxSourceEdge || dimensions.width * dimensions.height > COVER_LIMITS.maxPixels) return {url: sourceUrl};
    if (Math.max(dimensions.width, dimensions.height) <= maxEdge) return {url: sourceUrl, key};
    if (previous?.key === key && COVER_URL.test(previous.url)) {
      try {
        const cached = await load(previous.url), size = cached && imageDimensions(cached);
        if (size && Math.max(size.width, size.height) <= maxEdge) return {url: previous.url, key};
      } catch { /* A missing/bad derived cache is regenerated from the read-only source. */ }
    }
    if (typeof coverTransform !== 'function') return {url: sourceUrl};
    if (!variants.has(key)) {
      const job = (async () => {
        try {
          // A processor receives a copy; mutating it cannot alter source/cache bytes.
          const output = await coverTransform(Buffer.from(bytes), {maxEdge, quality: COVER_LIMITS.quality});
          if (!ArrayBuffer.isView(output) || !output.byteLength || output.byteLength > COVER_LIMITS.maxVariantBytes) return {url: sourceUrl};
          const size = imageDimensions(output);
          if (!size || Math.max(size.width, size.height) > maxEdge) return {url: sourceUrl};
          const url = await save(output);
          return url ? {url, key} : {url: sourceUrl};
        } catch { return {url: sourceUrl}; }
      })();
      variants.set(key, job);
      if (variants.size > 32) variants.delete(variants.keys().next().value);
    }
    return variants.get(key);
  }
  async function decorate(record, embeddedUrl) {
    const sourceUrl = embeddedUrl || await sidecar(record.path);
    const result = {...record, coverUrl: sourceUrl, coverThumbnailUrl: sourceUrl, coverLargeUrl: sourceUrl,
      coverSource: sourceUrl ? embeddedUrl ? 'embedded' : 'sidecar' : '', _embeddedCoverUrl: embeddedUrl || ''};
    delete result._coverVariants;
    if (!sourceUrl) return result;
    let bytes;
    try { bytes = await load(sourceUrl); } catch { return result; }
    if (!bytes) return result;
    const small = await variant(sourceUrl, bytes, COVER_LIMITS.thumbnailEdge, record._coverVariants?.thumbnail);
    const large = await variant(sourceUrl, bytes, COVER_LIMITS.largeEdge, record._coverVariants?.large);
    result.coverThumbnailUrl = small.url; result.coverLargeUrl = large.url;
    result._coverVariants = {thumbnail: small, large};
    return result;
  }
  return {save, decorate, clear() {variants.clear();}};
}

module.exports = {createLocalCoverService, coverUrls, COVER_URL, COVER_LIMITS, COVER_NAMES};
