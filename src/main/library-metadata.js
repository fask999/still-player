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

function imageDimensions(bytes) {
  if (!ArrayBuffer.isView(bytes)) return null;
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), extension = imageExtension(data);
  let width = 0, height = 0;
  if (extension === 'png' && data.length >= 33 && data.readUInt32BE(8) === 13 && data.toString('ascii', 12, 16) === 'IHDR') {
    width = data.readUInt32BE(16); height = data.readUInt32BE(20);
  } else if (extension === 'gif' && data.length >= 13) {
    width = data.readUInt16LE(6); height = data.readUInt16LE(8);
  } else if (extension === 'webp' && data.length >= 30) {
    const chunk = data.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && data.readUInt32LE(16) >= 10) {
      width = data.readUIntLE(24, 3) + 1; height = data.readUIntLE(27, 3) + 1;
    } else if (chunk === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
      width = data.readUInt16LE(26) & 0x3fff; height = data.readUInt16LE(28) & 0x3fff;
    } else if (chunk === 'VP8L' && data[20] === 0x2f) {
      width = 1 + (data[21] | ((data[22] & 0x3f) << 8));
      height = 1 + ((data[22] >> 6) | (data[23] << 2) | ((data[24] & 0x0f) << 10));
    }
  } else if (extension === 'jpg') {
    let offset = 2, segments = 0;
    while (offset < data.length && segments++ < 4096) {
      if (data[offset++] !== 0xff) break;
      while (offset < data.length && data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xda || marker === 0xd9 || marker === undefined) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  return width > 0 && height > 0 ? {width, height} : null;
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

module.exports = { imageExtension, imageDimensions, stripCoverPictures };
