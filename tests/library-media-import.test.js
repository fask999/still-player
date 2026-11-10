'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {createLibraryService, trackId} = require('../src/main/library');
const {COVER_LIMITS, COVER_NAMES} = require('../src/main/local-covers');
const {imageDimensions} = require('../src/main/library-metadata');
const {createCueReader, decodeCue, parseCue, CUE_LIMITS} = require('../src/main/cue-import');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(width = 1, height = 1, colour = 0) {
  const chunk = (name, data) => {
    const type = Buffer.from(name), header = Buffer.alloc(4), checksum = Buffer.alloc(4);
    header.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([header, type, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, colour);
  for (let row = 0; row < height; row++) pixels[row * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const sourceUrl = bytes => `still-cover://art/${crypto.createHash('sha256').update(bytes).digest('hex')}.png`;
const cueText = (file = 'audio.flac', newline = '\n') => [`FILE "${file}" WAVE`, '  TRACK 01 AUDIO', '    TITLE "First"', '    INDEX 01 00:00:00', '  TRACK 02 AUDIO', '    TITLE "Second"', '    INDEX 01 01:00:00', ''].join(newline);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(__dirname, '.tmp-library-media-')), music = path.join(root, 'music'), dataDir = path.join(root, 'data');
  await fs.mkdir(music);
  const audio = path.join(music, 'audio.flac'), cue = path.join(music, 'album.cue');
  await fs.writeFile(audio, 'synthetic audio, never sent to native playback');
  const services = [];
  const create = options => {
    const service = createLibraryService({dataDir, metadataParser: async () => ({common: {title: 'Physical file metadata'}, format: {}}), ...options});
    services.push(service); return service;
  };
  t.after(async () => {
    for (const service of services) await service.close();
    assert.equal(path.dirname(root), path.resolve(__dirname));
    assert.ok(path.basename(root).startsWith('.tmp-library-media-'));
    await fs.rm(root, {recursive: true, force: true});
  });
  return {root, music, dataDir, audio, cue, create};
}

test('finite sidecar names use actual image bytes, embedded priority and read-only source files', async t => {
  const {music, audio, create} = await fixture(t), cover = path.join(music, 'cover.jpg'), outside = path.join(music, 'unrelated.png');
  const sidecar = png(4, 3, 30), embedded = png(2, 2, 40), originalAudio = await fs.readFile(audio);
  await fs.writeFile(cover, sidecar); await fs.writeFile(outside, png(1, 1, 99));
  const service = create(); await service.importFiles([audio]);
  let track = service.getTrack(trackId(audio));
  assert.equal(track.coverUrl, sourceUrl(sidecar)); assert.equal(track.coverSource, 'sidecar');
  assert.equal(track.coverThumbnailUrl, track.coverUrl); assert.equal(track.coverLargeUrl, track.coverUrl);
  const withEmbedded = create({metadataParser: async () => ({common: {picture: [{data: embedded}]}})});
  await withEmbedded.initialize();
  await fs.appendFile(audio, 'changed timestamp and size for fresh metadata');
  await withEmbedded.refresh(); track = withEmbedded.getTrack(trackId(audio));
  assert.equal(track.coverUrl, sourceUrl(embedded)); assert.equal(track.coverSource, 'embedded');
  assert.deepEqual(await fs.readFile(cover), sidecar);
  assert.deepEqual((await fs.readFile(audio)).subarray(0, originalAudio.length), originalAudio);
  assert.equal(COVER_NAMES.includes('unrelated.png'), false);
});

test('refresh detects sidecar addition, same-size same-mtime replacement, rename and removal without re-parsing audio', async t => {
  const {music, audio, create} = await fixture(t);
  let parses = 0;
  const service = create({metadataParser: async () => {parses++; return {common: {}};}});
  await service.importFiles([audio]); assert.equal(service.getTrack(trackId(audio)).coverUrl, '');
  const cover = path.join(music, 'cover.png'), first = png(3, 2, 11), second = png(3, 2, 22);
  await fs.writeFile(cover, first); await service.refresh();
  assert.equal(service.getTrack(trackId(audio)).coverUrl, sourceUrl(first));
  const old = await fs.stat(cover);
  await fs.writeFile(cover, second); await fs.utimes(cover, old.atime, old.mtime); await service.refresh();
  assert.equal(service.getTrack(trackId(audio)).coverUrl, sourceUrl(second));
  await fs.rename(cover, path.join(music, 'folder.jpg')); await service.refresh();
  assert.equal(service.getTrack(trackId(audio)).coverUrl, sourceUrl(second));
  await fs.unlink(path.join(music, 'folder.jpg')); await service.refresh();
  assert.equal(service.getTrack(trackId(audio)).coverUrl, ''); assert.equal(parses, 1);
});

test('sidecar rejects byte/pixel limits, unknown dimensions, spoofed formats and hardlinks before publishing or processing', async t => {
  const {root, music, audio, create} = await fixture(t);
  let processed = 0;
  const service = create({coverTransform: async () => {processed++; return png();}}), cover = path.join(music, 'cover.png');
  const huge = Buffer.from(png()); huge.writeUInt32BE(COVER_LIMITS.maxSourceEdge + 1, 16);
  const tooManyPixels = Buffer.from(png()); tooManyPixels.writeUInt32BE(10000, 16); tooManyPixels.writeUInt32BE(10000, 20);
  for (const bytes of [huge, tooManyPixels, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('<svg><script>bad</script></svg>')]) {
    await fs.writeFile(cover, bytes); await service.importFiles([audio]);
    assert.equal(service.getTrack(trackId(audio)).coverUrl, '');
  }
  const handle = await fs.open(cover, 'w'); await handle.truncate(COVER_LIMITS.maxSourceBytes + 1); await handle.close();
  await service.refresh(); assert.equal(service.getTrack(trackId(audio)).coverUrl, '');
  await fs.unlink(cover);
  const external = path.join(root, 'linked.png'); await fs.writeFile(external, png()); await fs.link(external, cover);
  await service.refresh(); assert.equal(service.getTrack(trackId(audio)).coverUrl, '');
  assert.equal(processed, 0); assert.deepEqual(await fs.readFile(external), png());
});

test('sidecar symlinks and linked ancestor directories are rejected without reading their images', async t => {
  const {root, music, audio, create} = await fixture(t);
  const external = path.join(root, 'external.png'); await fs.writeFile(external, png());
  try {await fs.symlink(external, path.join(music, 'cover.png'), 'file');}
  catch (error) {if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {t.skip(`File symlink unavailable: ${error.code}`); return;} throw error;}
  const opened = [];
  const service = create({fileSystem: {...fs, async open(target, ...args) {opened.push(target); return fs.open(target, ...args);}}});
  await service.importFiles([audio]); assert.equal(service.getTrack(trackId(audio)).coverUrl, '');
  assert.equal(opened.includes(external), false); assert.equal(opened.includes(path.join(music, 'cover.png')), false);
  const linked = path.join(root, 'music-link'); await fs.symlink(music, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.unlink(path.join(music, 'cover.png')); await fs.writeFile(path.join(music, 'cover.png'), png());
  const throughLink = path.join(linked, 'audio.flac'); await service.importFiles([throughLink]);
  assert.equal(service.getTrack(trackId(throughLink)).coverUrl, '');
});

test('thumbnail recipes separate source and size, retain original bytes and reuse verified variants across restarts', async t => {
  const {music, dataDir, audio, create} = await fixture(t), original = png(1024, 800, 30), cover = path.join(music, 'cover.png');
  await fs.writeFile(cover, original);
  const calls = [];
  const transform = async (bytes, options) => {calls.push({hash: sourceUrl(bytes), ...options}); bytes.fill(0); return png(options.maxEdge, Math.floor(options.maxEdge * 800 / 1024), options.maxEdge % 255);};
  const service = create({coverTransform: transform}); await service.importFiles([audio]);
  const track = service.getTrack(trackId(audio));
  assert.equal(track.coverUrl, sourceUrl(original)); assert.notEqual(track.coverThumbnailUrl, track.coverLargeUrl);
  assert.deepEqual(calls.map(item => item.maxEdge), [96, 768]);
  assert.ok(calls.every(item => item.quality === 82)); assert.deepEqual(await fs.readFile(cover), original);
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'library.json'), 'utf8')).tracks[0];
  assert.match(stored._coverVariants.thumbnail.key, /^[a-f0-9]{64}:96:82:1$/);
  await service.close();
  let restartCalls = 0;
  const restarted = create({coverTransform: async () => {restartCalls++; throw new Error('A valid persisted derivative should be reused.');}});
  await restarted.initialize(); await restarted.refresh();
  assert.equal(restartCalls, 0); assert.equal(restarted.getTrack(track.id).coverThumbnailUrl, track.coverThumbnailUrl);
  const second = png(1024, 800, 40); await fs.writeFile(cover, second);
  const changed = create({coverTransform: transform}); await changed.initialize(); await changed.refresh();
  assert.equal(calls.length, 4); assert.equal(changed.getTrack(track.id).coverUrl, sourceUrl(second));
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'covers', track.coverUrl.split('/').pop())), original);
});

test('processor null, throw, oversized dimensions or unknown output safely use source URL without a successful recipe', async t => {
  const {music, audio, create} = await fixture(t), original = png(1024, 800, 1);
  await fs.writeFile(path.join(music, 'cover.png'), original);
  const outputs = [null, new Error('decode failed'), Buffer.from('not an image'), png(1000, 1), Buffer.alloc(COVER_LIMITS.maxVariantBytes + 1)];
  for (const output of outputs) {
    const service = create({coverTransform: async () => {if (output instanceof Error) throw output; return output;}});
    await service.initialize(); await service.importFiles([audio]);
    const track = service.getTrack(trackId(audio));
    assert.equal(track.coverThumbnailUrl, track.coverUrl); assert.equal(track.coverLargeUrl, track.coverUrl);
  }
});

test('all committed and published cover variants participate in existing GC references and recovery retention', async t => {
  const {music, dataDir, audio, create} = await fixture(t);
  await fs.writeFile(path.join(music, 'cover.png'), png(1024, 800, 10));
  const service = create({coverTransform: async (_bytes, {maxEdge}) => png(maxEdge, 1, maxEdge % 255)});
  await service.importFiles([audio]); const track = service.getTrack(trackId(audio));
  const urls = [track.coverUrl, track.coverThumbnailUrl, track.coverLargeUrl];
  let plan = await service.planCoverCollection();
  for (const url of urls) assert.equal(plan.referenceCounts[url], 1);
  await service.remove([track.id]); plan = await service.planCoverCollection();
  assert.deepEqual(plan.candidates, []);
  await fs.writeFile(path.join(dataDir, 'library-reset-user-kept.json'), 'synthetic recovery reference');
  await service.close();
  assert.equal((await service.collectCovers()).recoveryRetention, 'recovery-backup-present');
  for (const url of urls) assert.ok(await fs.readFile(path.join(dataDir, 'covers', url.split('/').pop())));
});

test('embedded input has the same finite byte admission and unknown dimensions never enter the processor', async t => {
  const {audio, create} = await fixture(t);
  const oversized = Buffer.alloc(COVER_LIMITS.maxSourceBytes + 1); png().copy(oversized);
  let calls = 0;
  const service = create({metadataParser: async () => ({common: {picture: [{data: oversized}]}}), coverTransform: async () => {calls++; return png();}});
  await service.importFiles([audio]); assert.equal(service.getTrack(trackId(audio)).coverUrl, ''); assert.equal(calls, 0);
});

test('CUE discovery imports only exact backend identities, keeps CUE metadata and never invokes player or queue APIs', async t => {
  const {audio, cue, create} = await fixture(t); await fs.writeFile(cue, cueText());
  const requests = [];
  const service = create({cueInspector: async request => {
    requests.push(request);
    return {verified: true, items: [{path: cue, subsong: 4, supported: true, title: 'Backend first', duration: 12}, {path: audio, subsong: 9, supported: true, title: 'Backend second', duration: 21}]};
  }});
  const result = await service.importFiles([cue]);
  assert.deepEqual(result.tracks.map(track => [track.path, track.subsong, track.title]), [[cue, 4, 'Backend first'], [audio, 9, 'Backend second']]);
  assert.ok(result.tracks.every(track => track.supported && track.source === 'cue' && track.sourceScope === 'explicit-import'));
  assert.deepEqual(requests[0].references, [audio]); assert.equal(requests[0].trackCount, 2); assert.equal(requests[0].encoding, 'utf-8');
  assert.match(requests[0].contentHash, /^[a-f0-9]{64}$/); assert.equal(result.playlists.length, 0);
  assert.equal(service.getTrack(trackId(cue, 1)), null, 'TRACK 01 is never guessed as subsong 1');
});

test('CUE accepts same-directory references or an explicitly selected folder subtree and refuses dot-dot/absolute escape', async t => {
  const {root, music, audio, cue, create} = await fixture(t), nested = path.join(music, 'nested'); await fs.mkdir(nested);
  const child = path.join(nested, 'child.flac'); await fs.writeFile(child, 'synthetic audio');
  let calls = 0;
  const inspect = async () => {calls++; return {verified: true, items: [{path: cue, subsong: 1, supported: true}, {path: cue, subsong: 2, supported: true}]};};
  await fs.writeFile(cue, cueText('nested/child.flac'));
  const service = create({cueInspector: inspect}); await service.importFiles([cue]);
  assert.equal(calls, 0); assert.equal(service.getTrack(trackId(cue)).supported, false);
  await service.importFolder(music); assert.equal(calls, 1); assert.equal(service.getTrack(trackId(cue, 2)).supported, true);
  const outside = path.join(root, 'outside.flac'); await fs.writeFile(outside, 'synthetic outside');
  for (const reference of ['../outside.flac', outside, path.join(music, '..', 'outside.flac')]) {
    await fs.writeFile(cue, cueText(reference)); await service.importFiles([cue]);
    assert.equal(calls, 1); assert.equal(service.getTrack(trackId(cue, 2)).supported, false);
  }
  assert.ok(await fs.readFile(audio));
});

test('CUE strict UTF8, BOM UTF16 and GB18030 decoding and finite text/track/reference limits', async t => {
  const {cue, create} = await fixture(t);
  const text = cueText();
  assert.equal(decodeCue(Buffer.from(text)).encoding, 'utf-8');
  assert.equal(decodeCue(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])).text, text);
  const bigEndian = Buffer.from(text, 'utf16le'); bigEndian.swap16();
  assert.equal(decodeCue(Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian])).text, text);
  const gbk = Buffer.concat([Buffer.from('REM '), Buffer.from([0xd2, 0xf4, 0xc0, 0xd6]), Buffer.from('\n' + text)]);
  assert.equal(decodeCue(gbk).encoding, 'gb18030'); assert.match(decodeCue(gbk).text, /音乐/);
  assert.throws(() => decodeCue(Buffer.from([0xff])), /not valid/);
  assert.throws(() => parseCue('FILE "audio.flac" WAVE\nTRACK 00 AUDIO'), /ordered unique/);
  assert.throws(() => parseCue('FILE "audio.flac" WAVE\nTRACK 01 AUDIO\nTRACK 01 AUDIO'), /ordered unique/);
  assert.throws(() => parseCue('FILE "audio.flac" WAVE\nTRACK 100 AUDIO'), /ordered unique/);
  assert.throws(() => parseCue(Array.from({length: CUE_LIMITS.maxReferences + 1}, (_, i) => `FILE "${i}.flac" WAVE`).join('\n')), /too many FILE/);
  await fs.writeFile(cue, Buffer.alloc(CUE_LIMITS.maxBytes + 1));
  let calls = 0;
  const service = create({cueInspector: async () => {calls++;}}); await service.importFiles([cue]);
  assert.equal(calls, 0); assert.equal(service.getTrack(trackId(cue)).supported, false);
});

test('CUE bare CR, CDTEXTFILE, unknown directives and Unicode line breaks cannot hide external references', async t => {
  const {cue, create} = await fixture(t); let calls = 0;
  const service = create({cueInspector: async () => {calls++;}});
  for (const text of ['REM x\rFILE "../outside.flac" WAVE\rTRACK 01 AUDIO', 'CDTEXTFILE "../outside.cdt"\n' + cueText(), 'INCLUDE "outside.cue"\n' + cueText(), 'REM x\u2028FILE "../outside.flac" WAVE\nTRACK 01 AUDIO']) {
    await fs.writeFile(cue, text); await service.importFiles([cue]);
    assert.equal(service.getTrack(trackId(cue)).supported, false);
  }
  assert.equal(calls, 0); assert.equal(parseCue(cueText('audio.flac', '\r')).trackCount, 2);
});

test('CUE references reject hardlinks, symbolic links and linked ancestors before invoking discovery', async t => {
  const {root, music, audio, cue, create} = await fixture(t); const other = path.join(root, 'other.flac');
  await fs.link(audio, other); await fs.writeFile(cue, cueText());
  let calls = 0;
  const service = create({cueInspector: async () => {calls++;}}); await service.importFiles([cue]); assert.equal(calls, 0);
  await fs.unlink(other);
  const linked = path.join(music, 'linked.flac');
  try {await fs.symlink(audio, linked, 'file');}
  catch (error) {if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {t.diagnostic(`File symlink unavailable: ${error.code}`); return;} throw error;}
  await fs.writeFile(cue, cueText('linked.flac')); await service.importFiles([cue]); assert.equal(calls, 0);
  const directoryLink = path.join(music, 'sub-link'); await fs.symlink(music, directoryLink, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(cue, cueText('sub-link/audio.flac')); await service.importFolder(music); assert.equal(calls, 0);
});

test('CUE unavailable/partial/foreign/duplicate/unverified backend output never invents playable subsongs', async t => {
  const {root, cue, create} = await fixture(t); await fs.writeFile(cue, cueText());
  const item = {path: cue, subsong: 7, supported: true};
  const outputs = [undefined, {verified: false, items: [item, {...item, subsong: 8}]}, {verified: true, items: [item]}, {verified: true, items: [item, item]},
    {verified: true, items: [item, {...item, path: path.join(root, 'foreign.flac'), subsong: 8}]}, {verified: true, items: [item, {...item, subsong: null}]}, {verified: true, items: [item, {...item, subsong: 8, supported: false}]}];
  for (const output of outputs) {
    const service = create(output === undefined ? {} : {cueInspector: async () => output});
    await service.initialize(); await service.importFiles([cue]);
    assert.ok(service.list().tracks.every(track => track.supported === false));
    assert.ok(service.list().tracks.every(track => track.valid === true));
    assert.equal(service.getTrack(trackId(cue, 7)), null);
  }
});

test('verified CUE identities survive restart/refresh and removal of one subsong without a discovery adapter', async t => {
  const {cue, create} = await fixture(t); await fs.writeFile(cue, cueText());
  const service = create({cueInspector: async () => ({verified: true, items: [3, 6].map(subsong => ({path: cue, subsong, supported: true, title: `Backend ${subsong}`}))})});
  await service.importFiles([cue]); await service.remove([trackId(cue, 3)]); await service.close();
  const restarted = create(); await restarted.initialize(); await restarted.refresh();
  assert.equal(restarted.getTrack(trackId(cue, 3)), null); assert.equal(restarted.getTrack(trackId(cue, 6)).supported, true);
  assert.equal(restarted.getTrack(trackId(cue, 6)).title, 'Backend 6');
  await fs.appendFile(cue, 'REM changed\n'); await restarted.refresh();
  assert.equal(restarted.getTrack(trackId(cue, 6)).supported, false);
  assert.match(restarted.getTrack(trackId(cue, 6)).playbackUnsupportedReason, /discovery is unavailable/);
});

test('explicit CUE reimport discovers and restores a removed exact identity while refresh preserves its tombstone', async t => {
  const {cue, create} = await fixture(t); await fs.writeFile(cue, cueText()); let calls = 0;
  const service = create({cueInspector: async () => {calls++; return {verified: true, items: [2, 5].map(subsong => ({path: cue, subsong, supported: true}))};}});
  await service.importFiles([cue]); await service.remove([trackId(cue, 2)]); await service.refresh();
  assert.equal(service.getTrack(trackId(cue, 2)), null); assert.equal(service.getTrack(trackId(cue, 5)).supported, true); assert.equal(calls, 1);
  await service.importFiles([cue]); assert.equal(calls, 2); assert.equal(service.getTrack(trackId(cue, 2)).supported, true);
});

test('a backend-proven referenced audio subsong zero carries cueTrack without leaking private CUE paths', async t => {
  const {audio, cue, create} = await fixture(t); await fs.writeFile(cue, cueText());
  const service = create({cueInspector: async () => ({verified: true, items: [{path: audio, subsong: 0, supported: true, title: 'Backend first'}, {path: cue, subsong: 7, supported: true}]})});
  await service.importFiles([cue]); const track = service.getTrack(trackId(audio));
  assert.equal(track.cueTrack, true); assert.equal(track.title, 'Backend first');
  assert.equal(Object.keys(track).some(key => key.startsWith('_')), false); assert.equal(track.cuePath, undefined);
});

test('existing foobar identities/source remain authoritative when explicitly importing a matching CUE', async t => {
  const {cue, create} = await fixture(t); await fs.writeFile(cue, cueText());
  const service = create({cueInspector: async () => ({verified: true, items: [0, 1].map(subsong => ({path: cue, subsong, supported: true, title: `Discovery ${subsong}`}))})});
  await service.importFoobar({tracks: [{path: cue, subsong: 0, supported: true, title: 'Existing original'}]});
  await service.importFiles([cue]);
  assert.equal(service.getTrack(trackId(cue, 0)).source, 'foobar2000'); assert.equal(service.getTrack(trackId(cue, 0)).sourceScope, 'existing-playlists');
  assert.equal(service.getTrack(trackId(cue, 0)).title, 'Existing original'); assert.equal(service.getTrack(trackId(cue, 1)).source, 'cue');
});

test('a later real foobar snapshot can verify an earlier unsupported direct-CUE identity', async t => {
  const {cue, create} = await fixture(t); await fs.writeFile(cue, cueText());
  const service = create(); await service.importFiles([cue]); assert.equal(service.getTrack(trackId(cue)).supported, false);
  await service.importFoobar({tracks: [{path: cue, subsong: 0, supported: true, title: 'Actual source track'}]});
  const track = service.getTrack(trackId(cue));
  assert.equal(track.supported, true); assert.equal(track.source, 'foobar2000'); assert.equal(track.title, 'Actual source track'); assert.equal(track.cueTrack, true);
});

test('CUE refresh marks a missing backend location invalid while retaining its exact saved playlist occurrence', async t => {
  const {audio, cue, create} = await fixture(t); await fs.writeFile(cue, cueText());
  const service = create({cueInspector: async () => ({verified: true, items: [{path: audio, subsong: 0, supported: true}, {path: cue, subsong: 4, supported: true}]})});
  await service.importFiles([cue]); const id = trackId(audio); const playlist = (await service.createPlaylist('Saved')).playlists[0];
  await service.setPlaylistTracks(playlist.id, [id]); await fs.unlink(audio); await service.refresh();
  assert.equal(service.getTrack(id).valid, false); assert.equal(service.getTrack(id).supported, false);
  assert.deepEqual(service.list().playlists[0].trackIds, [id]);
});

test('a CUE change during metadata preparation rolls back the complete import before publication', async t => {
  const {cue, create} = await fixture(t); await fs.writeFile(cue, cueText());
  let changed = false;
  const service = create({metadataParser: async () => {if (!changed) {changed = true; await fs.appendFile(cue, 'REM changed during metadata\n');} return {common: {}};},
    cueInspector: async () => ({verified: true, items: [3, 8].map(subsong => ({path: cue, subsong, supported: true}))})});
  await service.createPlaylist('Committed'); const before = service.list();
  await assert.rejects(service.importFiles([cue]), /changed during backend discovery/);
  assert.deepEqual(service.list().tracks, before.tracks); assert.deepEqual(service.list().playlists, before.playlists); assert.equal(service.getStatus().readOnly, false);
});

test('CUE or reference changes during discovery are refused and never published as verified tracks', async t => {
  const {audio, cue, create} = await fixture(t); await fs.writeFile(cue, cueText());
  const service = create({cueInspector: async () => {
    await fs.appendFile(audio, 'changed during discovery');
    return {verified: true, items: [1, 2].map(subsong => ({path: cue, subsong, supported: true}))};
  }});
  await service.importFiles([cue]); assert.equal(service.getTrack(trackId(cue, 1)), null); assert.equal(service.getTrack(trackId(cue)).supported, false);
  const read = createCueReader(); const prepared = await read(cue); await fs.appendFile(cue, 'REM changed\n');
  await assert.rejects(prepared.recheck(), /changed during/);
});

test('CUE and cover commit failure rolls back published identities, variants and playlists', async t => {
  const {music, audio, cue, dataDir, create} = await fixture(t); await fs.writeFile(cue, cueText()); await fs.writeFile(path.join(music, 'cover.png'), png(1024, 1));
  let fail = false;
  const service = create({coverTransform: async (_bytes, {maxEdge}) => png(maxEdge, 1), cueInspector: async () => ({verified: true, items: [1, 2].map(subsong => ({path: cue, subsong, supported: true}))}),
    fileSystem: {...fs, async rename(source, target) {if (fail && target === path.join(dataDir, 'library.json')) throw new Error('synthetic commit failure'); return fs.rename(source, target);}}});
  await service.createPlaylist('Committed'); const before = service.list(); fail = true;
  await assert.rejects(service.importFiles([audio, cue]), /synthetic commit failure/);
  assert.deepEqual(service.list().tracks, before.tracks); assert.deepEqual(service.list().playlists, before.playlists);
  assert.equal(service.getStatus().readOnly, true);
});

test('image dimension admission understands bounded PNG, GIF, JPEG and WebP headers', () => {
  assert.deepEqual(imageDimensions(png(3, 4)), {width: 3, height: 4});
  const gif = Buffer.alloc(13); gif.write('GIF89a'); gif.writeUInt16LE(8, 6); gif.writeUInt16LE(9, 8);
  assert.deepEqual(imageDimensions(gif), {width: 8, height: 9});
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 7, 0, 6, 1]);
  assert.deepEqual(imageDimensions(jpeg), {width: 6, height: 7});
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.write('WEBP', 8); webp.write('VP8X', 12); webp.writeUInt32LE(10, 16); webp.writeUIntLE(4, 24, 3); webp.writeUIntLE(5, 27, 3);
  assert.deepEqual(imageDimensions(webp), {width: 5, height: 6});
  assert.equal(imageDimensions(Buffer.from('unknown')), null);
});
