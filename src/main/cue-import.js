'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const {TextDecoder} = require('node:util');
const {createMediaFileReader, isWithin, normalized} = require('./media-file-safety');

const CUE_LIMITS = Object.freeze({maxBytes: 1024 * 1024, maxTracks: 99, maxReferences: 32, maxLineLength: 8192});
const REFERENCE_EXTENSIONS = new Set(['.wav', '.wave', '.flac', '.ape', '.wv', '.aif', '.aiff', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.tta', '.tak', '.dff', '.dsf']);
function invalid(message) {return Object.assign(new Error(message), {code: 'ERR_CUE_IMPORT'});}
function decodeCue(bytes) {
  let encoding = 'utf-8', offset = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {encoding = 'utf-16le'; offset = 2;}
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) {encoding = 'utf-16be'; offset = 2;}
  else if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) offset = 3;
  let text;
  try {text = new TextDecoder(encoding, {fatal: true}).decode(bytes.subarray(offset));}
  catch {
    if (encoding !== 'utf-8' || offset) throw invalid('CUE text has invalid encoded bytes.');
    encoding = 'gb18030';
    try {text = new TextDecoder(encoding, {fatal: true}).decode(bytes);}
    catch {throw invalid('CUE text is not valid UTF-8, BOM UTF-16 or GB18030.');}
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/u.test(text)) throw invalid('CUE text contains control characters.');
  return {text, encoding};
}
function parseCue(text) {
  const references = [], tracks = new Set();
  let currentReference = false, lastTrack = 0;
  const commands = new Set(['REM', 'CATALOG', 'FILE', 'FLAGS', 'INDEX', 'ISRC', 'PERFORMER', 'POSTGAP', 'PREGAP', 'SONGWRITER', 'TITLE', 'TRACK']);
  for (const line of text.split(/\r\n|\r|\n/u)) {
    if (line.length > CUE_LIMITS.maxLineLength) throw invalid('CUE line exceeds the allowed length.');
    if (!line.trim()) continue;
    const command = /^\s*([A-Za-z]+)(?:\s|$)/u.exec(line)?.[1].toUpperCase();
    if (!commands.has(command)) throw invalid('CUE contains an unsupported directive or external file reference.');
    if (/^\s*FILE\b/iu.test(line)) {
      const match = /^\s*FILE\s+(?:"([^"\r\n]+)"|([^\s"]+))\s+(?:WAVE|MP3|AIFF|FLAC)\s*$/iu.exec(line);
      if (!match) throw invalid('CUE FILE syntax or media type is unsupported.');
      const reference = match[1] || match[2];
      if (reference.length > 4096 || /[<>|?*\u0000-\u001f]/u.test(reference) || reference.split(/[\\/]/u).includes('..')) throw invalid('CUE FILE traversal or invalid filename is not allowed.');
      if (!REFERENCE_EXTENSIONS.has(path.extname(reference).toLowerCase())) throw invalid('CUE FILE must refer to a supported audio file.');
      if (!references.includes(reference)) references.push(reference);
      if (references.length > CUE_LIMITS.maxReferences) throw invalid('CUE has too many FILE references.');
      currentReference = true;
    } else if (/^\s*TRACK\b/iu.test(line)) {
      const match = /^\s*TRACK\s+(\d{1,2})\s+AUDIO\s*$/iu.exec(line), number = match && Number(match[1]);
      if (!currentReference || !number || number <= lastTrack || tracks.has(number)) throw invalid('CUE requires ordered unique AUDIO tracks after FILE.');
      tracks.add(number); lastTrack = number;
      if (tracks.size > CUE_LIMITS.maxTracks) throw invalid('CUE has too many tracks.');
    }
  }
  if (!references.length || !tracks.size) throw invalid('CUE has no supported FILE/AUDIO TRACK entries.');
  return {references, trackCount: tracks.size};
}

function createCueReader({fileSystem} = {}) {
  const reader = createMediaFileReader({fileSystem});
  return async function inspectCue(cuePath, {authorizationRoot} = {}) {
    const absolute = path.resolve(cuePath), directory = path.dirname(absolute), root = path.resolve(authorizationRoot || directory);
    if (!isWithin(root, absolute)) throw invalid('CUE is outside the explicitly authorized folder.');
    const content = await reader.read(absolute, {maxBytes: CUE_LIMITS.maxBytes});
    const {text, encoding} = decodeCue(content.bytes), parsed = parseCue(text);
    const references = [], witnesses = [];
    for (const name of parsed.references) {
      // Reject drive-relative, device/ADS and foreign absolute syntax as well as
      // dot-dot. Absolute paths are admitted only inside the selected subtree.
      const windowsAbsolute = path.win32.isAbsolute(name);
      if ((/^[A-Za-z]:/u.test(name) && !windowsAbsolute) || /:/u.test(name.replace(/^[A-Za-z]:/u, '')) || (windowsAbsolute && !path.isAbsolute(name))) throw invalid('CUE FILE contains an unsupported absolute or device path.');
      const resolved = path.resolve(directory, name.replace(/[\\/]/gu, path.sep));
      if (!isWithin(root, resolved) || (!authorizationRoot && normalized(path.dirname(resolved)) !== normalized(directory))) throw invalid('CUE FILE is outside the authorized directory.');
      const witness = await reader.inspect(resolved);
      if (!references.some(item => normalized(item) === normalized(resolved))) {references.push(resolved); witnesses.push(witness);}
    }
    const contentHash = crypto.createHash('sha256').update(content.bytes).digest('hex');
    const request = {path: absolute, references, trackCount: parsed.trackCount, authorizationRoot: root, encoding, contentHash};
    const safetyHash = crypto.createHash('sha256').update(JSON.stringify(witnesses.map(item => [normalized(item.path), item.identity]))).digest('hex');
    const contentIdentity = content.identity;
    return {request, safetyHash, async recheck() {
      const current = await reader.read(absolute, {maxBytes: CUE_LIMITS.maxBytes});
      if (current.identity !== contentIdentity || crypto.createHash('sha256').update(current.bytes).digest('hex') !== contentHash) throw invalid('CUE changed during backend discovery.');
      for (const witness of witnesses) if ((await reader.inspect(witness.path)).identity !== witness.identity) throw invalid('CUE reference changed during backend discovery.');
    }};
  };
}

function validateCueItems(result, request) {
  if (result?.verified !== true || !Array.isArray(result.items) || result.items.length !== request.trackCount) throw invalid('Backend did not verify every CUE track.');
  const allowed = new Set([request.path, ...request.references].map(normalized)), identities = new Set();
  return result.items.map(item => {
    if (!item || typeof item.path !== 'string' || !path.isAbsolute(item.path) || !allowed.has(normalized(item.path)) || !Number.isSafeInteger(item.subsong) || item.subsong < 0 || item.supported !== true) throw invalid('Backend returned an unverified CUE path or subsong.');
    const key = `${normalized(item.path)}\0${item.subsong}`;
    if (identities.has(key)) throw invalid('Backend returned duplicate CUE identities.');
    identities.add(key);
    return {...item, path: path.resolve(item.path)};
  });
}

module.exports = {createCueReader, validateCueItems, decodeCue, parseCue, CUE_LIMITS};
