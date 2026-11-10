'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {createNativeCoverTransform} = require('../src/main/native-cover-transform');
const {imageDimensions} = require('../src/main/library-metadata');
const {COVER_LIMITS} = require('../src/main/local-covers');

// Header fixtures are self-authored dimension probes for a stub decoder. They
// are not claimed to be complete image files or real Electron render evidence.
function png(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}
function jpeg(width, height) {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9); return bytes;
}
function decoder({actualSize, empty = false, throws = false, wrongResize = false, wrongOutput = false} = {}) {
  const calls = [];
  const make = size => ({
    isEmpty: () => empty, getSize: () => size,
    resize(options) { calls.push({action: 'resize', ...options}); return make(wrongResize ? size : {width: options.width, height: options.height}); },
    toJPEG(quality) { calls.push({action: 'jpeg', quality}); return jpeg(wrongOutput ? size.width + 1 : size.width, size.height); },
    toPNG() { calls.push({action: 'png'}); return png(wrongOutput ? size.width + 1 : size.width, size.height); }
  });
  return {calls, nativeImage: {createFromBuffer(bytes) {
    calls.push({action: 'decode'}); if (throws) throw new Error('Synthetic decoder failure');
    return make(actualSize || imageDimensions(bytes));
  }}};
}

test('native cover transform scales both tiers without upscaling and preserves aspect and alpha', async () => {
  const fixture = decoder(), transform = createNativeCoverTransform(fixture.nativeImage), source = png(1600, 900), original = Buffer.from(source);
  assert.deepEqual(imageDimensions(await transform(source, {maxEdge: 96, quality: 82})), {width: 96, height: 54});
  assert.deepEqual(imageDimensions(await transform(source, {maxEdge: 768, quality: 82})), {width: 768, height: 432});
  assert.deepEqual(source, original);
  assert.deepEqual(fixture.calls.filter(call => call.action === 'resize'), [
    {action: 'resize', width: 96, height: 54, quality: 'good'}, {action: 'resize', width: 768, height: 432, quality: 'good'}
  ]);
  assert.equal(fixture.calls.filter(call => call.action === 'png').length, 2);
  fixture.calls.length = 0;
  assert.deepEqual(imageDimensions(await transform(png(50, 25), {maxEdge: 96})), {width: 50, height: 25});
  assert.equal(fixture.calls.some(call => call.action === 'resize'), false);
});

test('JPEG variants pass the requested compression quality and use actual decoded dimensions', async () => {
  const fixture = decoder({actualSize: {width: 900, height: 1600}}), transform = createNativeCoverTransform(fixture.nativeImage);
  assert.deepEqual(imageDimensions(await transform(jpeg(1600, 900), {maxEdge: 96, quality: 78})), {width: 54, height: 96});
  assert.deepEqual(fixture.calls.at(-1), {action: 'jpeg', quality: 78});
});

test('invalid and oversized source headers or arguments never reach the native decoder', async () => {
  const fixture = decoder(), transform = createNativeCoverTransform(fixture.nativeImage);
  for (const source of [Buffer.alloc(0), Buffer.from('not an image'), png(COVER_LIMITS.maxSourceEdge + 1, 1), png(8192, 8192)]) {
    assert.equal(await transform(source, {maxEdge: 96}), null);
  }
  for (const options of [{maxEdge: 0}, {maxEdge: 769}, {maxEdge: 96.5}, {maxEdge: 96, quality: 0}, {maxEdge: 96, quality: Infinity}]) {
    assert.equal(await transform(png(1600, 900), options), null);
  }
  assert.equal(fixture.calls.length, 0);
});

test('decoder failures, oversized decoded bitmaps and malformed derived sizes return null', async () => {
  for (const options of [{throws: true}, {empty: true}, {actualSize: {width: 8192, height: 8192}}, {wrongResize: true}, {wrongOutput: true}]) {
    assert.equal(await createNativeCoverTransform(decoder(options).nativeImage)(png(1600, 900), {maxEdge: 96}), null);
  }
  assert.throws(() => createNativeCoverTransform({}), /nativeImage/);
});
