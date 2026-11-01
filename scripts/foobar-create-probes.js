'use strict';
const fs = require('node:fs');
const path = require('node:path');
function makeSilentWav(sampleRate, seconds = 25) {
  const channels = 2, bits = 16, align = channels * bits / 8, bytes = sampleRate * seconds * align;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF'); b.writeUInt32LE(36 + bytes, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * align, 28); b.writeUInt16LE(align, 32); b.writeUInt16LE(bits, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40); return b;
}
if (require.main === module) {
  const folder = path.join(__dirname, 'foobar-probes'); fs.mkdirSync(folder, { recursive: true });
  const files = [44100, 48000, 96000, 192000].map(rate => {
    const file = path.join(folder, `silence-${rate}-16bit-stereo.wav`);
    fs.writeFileSync(file, makeSilentWav(rate)); return file;
  });
  console.log(JSON.stringify({ files, silent: true, seconds: 25, bits: 16, channels: 2 }, null, 2));
}
module.exports = { makeSilentWav };
