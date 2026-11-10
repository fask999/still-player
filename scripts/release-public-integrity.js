'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {sha256, safeRelative, assertNoLinks, regularBytes, walkFiles} = require('./package-public');
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw new Error(`Invalid closed ${label}`);
}
function integer(value, label) {
  const number = typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid ${label}`);
  return number;
}
function fileRecord(bytes) {return {bytes: bytes.length, sha256: sha256(bytes)};}
function safeZipEntries(bytes, {prefix = '', expectedFiles, maxTotalBytes = 2 * 1024 ** 3, maxFileBytes = 512 * 1024 ** 2} = {}) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {end = i; break;}
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)) throw new Error('Unsupported ZIP end/disk record');
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16), centralBytes = bytes.readUInt32LE(end + 12);
  if (!count || count === 0xffff || offset === 0xffffffff || offset + centralBytes !== end) throw new Error('ZIP64 or invalid ZIP directory is not permitted');
  const entries = new Map(), seen = new Set(), ranges = []; let cursor = offset, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor > end - 46 || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP central entry');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), disk = bytes.readUInt16LE(cursor + 34), attrs = bytes.readUInt32LE(cursor + 38), local = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extra + comment;
    if (next > end || flags & ~0x808 || ![0, 8].includes(method) || disk || size > maxFileBytes || compressed === 0xffffffff || local === 0xffffffff) throw new Error('Unsupported or oversized ZIP entry');
    const mode = attrs >>> 16 & 0xf000;
    if (![0, 0x4000, 0x8000].includes(mode) || attrs & 0x400) throw new Error('ZIP links, reparse points or special files are forbidden');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength), name = rawName.toString('utf8'), directory = name.endsWith('/');
    if (!Buffer.from(name, 'utf8').equals(rawName) || !name.startsWith(prefix)) throw new Error('ZIP filename encoding or root differs');
    const relative = name.slice(prefix.length).replace(/\/$/, '');
    if (!relative && directory && name === prefix) {if (size || compressed) throw new Error('ZIP root directory carries data'); cursor = next; continue;}
    safeRelative(relative);
    const folded = relative.toLowerCase();
    if (seen.has(folded)) throw new Error('Duplicate/case-colliding ZIP path'); seen.add(folded);
    if (local > offset - 30 || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw new Error('Invalid ZIP local header');
    const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), start = local + 30 + localName + localExtra, finish = start + compressed;
    if (finish > offset || !bytes.subarray(local + 30, local + 30 + localName).equals(rawName)) throw new Error('ZIP local namespace or extent differs');
    ranges.push([local, finish]);
    if (directory) {if (size || compressed) throw new Error('Directory ZIP entry carries data'); cursor = next; continue;}
    total += size; if (total > maxTotalBytes) throw new Error('ZIP expanded size exceeds bound');
    const data = bytes.subarray(start, finish), value = method === 8 ? zlib.inflateRawSync(data, {maxOutputLength: maxFileBytes}) : Buffer.from(data);
    if (value.length !== size || zlib.crc32(value) !== crc) throw new Error('ZIP entry CRC/length differs');
    entries.set(relative, value); cursor = next;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((r, i) => i && r[0] < ranges[i - 1][1]) || cursor !== end) throw new Error('ZIP entries overlap or directory is incomplete');
  if (expectedFiles) assertNames([...entries.keys()], expectedFiles, 'ZIP file namespace');
  for (const name of entries.keys()) for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) if (entries.has(parent)) throw new Error('ZIP file/directory collision');
  return entries;
}
function assertNames(actual, expected, label) {
  if (new Set(expected.map(name => name.toLowerCase())).size !== expected.length || JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) throw new Error(`Unexpected ${label}`);
}
function writeEntries(entries, destination) {
  const root = assertNoLinks(destination, {allowMissing: true});
  if (fs.existsSync(root)) throw new Error('Extraction target already exists');
  fs.mkdirSync(path.dirname(root), {recursive: true}); assertNoLinks(path.dirname(root)); fs.mkdirSync(root);
  for (const [relative, bytes] of entries) {
    safeRelative(relative); const target = assertNoLinks(path.join(root, relative), {allowMissing: true});
    fs.mkdirSync(path.dirname(target), {recursive: true}); assertNoLinks(path.dirname(target)); fs.writeFileSync(target, bytes, {flag: 'wx'});
    if (!regularBytes(root, relative).equals(bytes)) throw new Error('Extracted file differs');
  }
  assertNames(walkFiles(root), [...entries.keys()], 'extracted namespace');
  return root;
}
function readTree(root) {return Object.fromEntries(walkFiles(root).map(relative => [relative, fileRecord(regularBytes(root, relative))]));}
function writeJsonNew(filename, value) {assertNoLinks(filename, {allowMissing: true}); fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx'});}
module.exports = {HASH, COMMIT, VERSION, exact, integer, fileRecord, safeZipEntries, assertNames, writeEntries, readTree, writeJsonNew};
