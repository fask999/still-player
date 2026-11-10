'use strict';

const {imageExtension, imageDimensions} = require('./library-metadata');
const {COVER_LIMITS} = require('./local-covers');

function allowedSize(size) {
  return size && Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height) && size.width > 0 && size.height > 0
    && size.width <= COVER_LIMITS.maxSourceEdge && size.height <= COVER_LIMITS.maxSourceEdge
    && size.width * size.height <= COVER_LIMITS.maxPixels;
}

// Electron stays in main: callers inject its existing nativeImage object. This
// module never loads Electron, opens a path, fetches artwork or touches audio.
function createNativeCoverTransform(nativeImage) {
  if (typeof nativeImage?.createFromBuffer !== 'function') throw new TypeError('Electron nativeImage is required for cover thumbnails.');
  return async function coverTransform(bytes, {maxEdge, quality = COVER_LIMITS.quality} = {}) {
    if (!ArrayBuffer.isView(bytes) || bytes.byteLength < 1 || bytes.byteLength > COVER_LIMITS.maxSourceBytes
      || !Number.isSafeInteger(maxEdge) || maxEdge < 1 || maxEdge > COVER_LIMITS.largeEdge
      || !Number.isSafeInteger(quality) || quality < 1 || quality > 100) return null;
    const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Check compressed-image dimensions before allowing a native decoder to
    // allocate its full bitmap; then validate what the decoder actually read.
    if (!allowedSize(imageDimensions(source))) return null;
    try {
      const image = nativeImage.createFromBuffer(Buffer.from(source));
      if (!image || image.isEmpty()) return null;
      const actual = image.getSize();
      if (!allowedSize(actual)) return null;
      const scale = Math.min(1, maxEdge / Math.max(actual.width, actual.height));
      const target = {width: Math.max(1, Math.floor(actual.width * scale)), height: Math.max(1, Math.floor(actual.height * scale))};
      const resized = scale < 1 ? image.resize({...target, quality: 'good'}) : image;
      if (!resized || resized.isEmpty()) return null;
      const size = resized.getSize();
      if (!allowedSize(size) || size.width !== target.width || size.height !== target.height) return null;
      // Preserve alpha for PNG/WebP/GIF-derived images. JPEG sources retain the
      // requested quality and do not produce needlessly large PNG variants.
      const output = imageExtension(source) === 'jpg' ? resized.toJPEG(quality) : resized.toPNG();
      if (!ArrayBuffer.isView(output) || output.byteLength < 1 || output.byteLength > COVER_LIMITS.maxVariantBytes) return null;
      const outputSize = imageDimensions(output);
      if (!allowedSize(outputSize) || outputSize.width !== size.width || outputSize.height !== size.height) return null;
      return Buffer.from(output);
    } catch { return null; }
  };
}

module.exports = {createNativeCoverTransform};
