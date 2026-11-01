'use strict';

const COVER_TAGS = new Set(['APIC', 'PIC', 'COVR', 'PICTURE', 'METADATA_BLOCK_PICTURE', 'COVERART', 'WM/PICTURE', 'COVER ART (FRONT)', 'COVER ART (BACK)']);

function imageExtension(bytes) {
  if (!bytes || !ArrayBuffer.isView(bytes)) return '';
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))) return 'gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return '';
}

function coverBinary(value) {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(coverBinary);
  if (value && typeof value === 'object') return coverBinary(value.data);
  if (typeof value === 'string' && value.length >= 8 && /^[a-z0-9+/]+={0,2}$/i.test(value)) {
    const bytes = Buffer.from(value, 'base64');
    return Boolean(imageExtension(bytes)) || flacPicture(bytes);
  }
  return false;
}

function flacPicture(bytes) {
  // Vorbis METADATA_BLOCK_PICTURE is a base64 FLAC picture structure rather than
  // base64 image bytes. Check each length before confirming its embedded image.
  if (bytes.length < 32 || bytes.readUInt32BE(0) > 20) return false;
  let offset = 8 + bytes.readUInt32BE(4);
  if (offset > bytes.length - 4) return false;
  offset += 4 + bytes.readUInt32BE(offset);
  if (offset > bytes.length - 20) return false;
  const length = bytes.readUInt32BE(offset + 16);
  offset += 20;
  return offset + length === bytes.length && Boolean(imageExtension(bytes.subarray(offset)));
}

function stripCoverPictures(metadata) {
  // These fields are canonical cover tags. Arbitrary binary/text tags (including
  // lyrics and cue data) remain intact even if they happen to contain image bytes.
  if (metadata.common && typeof metadata.common === 'object') delete metadata.common.picture;
  if (metadata.native && typeof metadata.native === 'object') {
    for (const [key, tags] of Object.entries(metadata.native)) {
      if (!Array.isArray(tags)) continue;
      metadata.native[key] = tags.filter(tag => !tag || !COVER_TAGS.has(String(tag.id).toUpperCase()) || !coverBinary(tag.value));
    }
  }
  return metadata;
}

module.exports = { imageExtension, stripCoverPictures };
