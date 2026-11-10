'use strict';

const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');

function unsafe(message) { return Object.assign(new Error(message), {code: 'ERR_MEDIA_UNSAFE_PATH'}); }
function normalized(value) { const absolute = path.resolve(value); return process.platform === 'win32' ? absolute.toLowerCase() : absolute; }
function isWithin(root, target) {
  const relative = path.relative(normalized(root), normalized(target));
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function integer(value) {
  if (typeof value === 'bigint') return value;
  if (Number.isSafeInteger(value)) return BigInt(value);
  throw unsafe('An exact media file identity is unavailable.');
}
function identity(stat) {
  return [integer(stat.dev), integer(stat.ino), integer(stat.size), stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs].map(String).join(':');
}

function createMediaFileReader({fileSystem = fs} = {}) {
  const io = fileSystem;
  async function assertDirectory(directory) {
    const absolute = path.resolve(directory), root = path.parse(absolute).root;
    let current = root;
    for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = await io.lstat(current, {bigint: true});
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe('Media directory ancestry must not contain links.');
    }
    if (normalized(await io.realpath(absolute)) !== normalized(absolute)) throw unsafe('Media directory resolves through a link.');
    return absolute;
  }
  function regular(stat) {
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || (stat.nlink !== 1 && stat.nlink !== 1n)) throw unsafe('Media must be an independent regular file without links.');
    integer(stat.size);
  }
  async function inspect(target) {
    const absolute = path.resolve(target);
    await assertDirectory(path.dirname(absolute));
    const stat = await io.lstat(absolute, {bigint: true});
    regular(stat);
    if (normalized(await io.realpath(absolute)) !== normalized(absolute)) throw unsafe('Media file resolves through a link.');
    return {path: absolute, stat, identity: identity(stat)};
  }
  async function read(target, {maxBytes} = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('A finite media read limit is required.');
    const before = await inspect(target);
    if (integer(before.stat.size) > BigInt(maxBytes)) throw Object.assign(new Error('Media exceeds the allowed byte limit.'), {code: 'ERR_MEDIA_TOO_LARGE'});
    let handle;
    try {
      handle = await io.open(before.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat({bigint: true}); regular(opened);
      if (identity(opened) !== before.identity) throw unsafe('Media changed while being opened.');
      // A bounded positional read does not allocate/read an unbounded file if it
      // grows after stat. The extra byte detects growth beyond the admission cap.
      const buffer = Buffer.alloc(Number(integer(opened.size)) + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      const after = await handle.stat({bigint: true}); regular(after);
      const named = await inspect(before.path);
      if (identity(after) !== before.identity || named.identity !== before.identity || BigInt(length) !== integer(after.size)) throw unsafe('Media changed while being read.');
      return {path: before.path, bytes: buffer.subarray(0, length), identity: before.identity};
    } finally { if (handle) await handle.close(); }
  }
  return {assertDirectory, inspect, read};
}

module.exports = {createMediaFileReader, isWithin, normalized};
