'use strict';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;

function isDesktopArtworkUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  if (/^still-apple-art:\/\/art\/[a-f0-9]{64}$/.test(value)) return true;
  // The existing still-cover protocol handler independently resolves realpath
  // containment; this tighter gate only accepts one canonical cover-cache name.
  return /^still-cover:\/\/art\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp|gif|avif)$/i.test(value);
}

function createDesktopArtworkReader({net, nativeImage} = {}) {
  if (typeof net?.fetch !== 'function' || typeof nativeImage?.createFromBuffer !== 'function') return async () => null;
  return async url => {
    if (!isDesktopArtworkUrl(url)) return null;
    const controller = new AbortController(); let reader, timer;
    const timeout = new Promise(resolve => {timer = setTimeout(() => {
      controller.abort(); try {Promise.resolve(reader?.cancel()).catch(() => {});} catch {}
      resolve(null);
    }, 5000); timer.unref?.();});
    const read = (async () => {
      try {
        const response = await net.fetch(url, {signal: controller.signal});
        if (controller.signal.aborted || !response?.ok) return null;
        const declaredSize = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declaredSize) && declaredSize > MAX_INPUT_BYTES) {await response.body?.cancel?.(); return null;}
        reader = response.body?.getReader?.();
        if (!reader) return null;
        const chunks = []; let length = 0;
        while (true) {
          const part = await reader.read();
          if (controller.signal.aborted) return null;
          if (part.done) break;
          length += part.value.byteLength;
          if (length > MAX_INPUT_BYTES) {await reader.cancel(); return null;}
          chunks.push(Buffer.from(part.value));
        }
        if (!length || controller.signal.aborted) return null;
        let image = nativeImage.createFromBuffer(Buffer.concat(chunks, length));
        if (image.isEmpty()) return null;
        const size = image.getSize();
        if (!size.width || !size.height || size.width > 32768 || size.height > 32768) return null;
        const scale = Math.min(1, 512 / Math.max(size.width, size.height));
        if (scale < 1) image = image.resize({width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good'});
        const bytes = image.toJPEG(85);
        if (!bytes?.length || bytes.length > MAX_OUTPUT_BYTES) return null;
        return {mimeType: 'image/jpeg', dataBase64: bytes.toString('base64')};
      } catch {return null;}
      finally {try {reader?.releaseLock();} catch {}}
    })();
    try {return await Promise.race([read, timeout]);} finally {clearTimeout(timer);}
  };
}

module.exports = {MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, isDesktopArtworkUrl, createDesktopArtworkReader};
