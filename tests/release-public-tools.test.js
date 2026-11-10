'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const {sha256} = require('../scripts/package-public');
const {safeZipEntries, writeEntries} = require('../scripts/release-public-integrity');
const {fetchTool, loadRecipe} = require('../scripts/prepare-release-tools');
function zip(items) {
  const body = [], table = []; let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name), bytes = Buffer.from(item.data || ''), crc = zlib.crc32(bytes), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(item.flags || 0, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(item.flags || 0, 8); central.writeUInt32LE(item.badCrc ? (crc ^ 1) >>> 0 : crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(item.size ?? bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(item.attrs || 0, 38); central.writeUInt32LE(offset, 42);
    body.push(local, name, bytes); table.push(central, name); offset += local.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(table), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, directory, end]);
}
test('release ZIP reader closes namespace, traversal, links, encryption, duplicates and CRC before extraction', () => {
  assert.equal(safeZipEntries(zip([{name: 'root/file.txt', data: 'OK'}]), {prefix: 'root/', expectedFiles: ['file.txt']}).get('file.txt').toString(), 'OK');
  for (const item of [{name: '../escape'}, {name: 'C:/escape'}, {name: 'dir\\escape'}, {name: 'CON'}, {name: 'link', attrs: 0xa0000000}, {name: 'encrypted', flags: 1}, {name: 'bad', data: 'wrong', badCrc: true}, {name: 'large', size: 0xffffffff}]) assert.throws(() => safeZipEntries(zip([item])));
  assert.throws(() => safeZipEntries(zip([{name: 'FILE'}, {name: 'file'}])), /colliding/);
  assert.throws(() => safeZipEntries(zip([{name: 'root/file'}]), {expectedFiles: ['other']}), /namespace/);
});
test('release ZIP extraction only creates a fresh checked target and preserves existing files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'still-release-tools-'));
  t.after(() => {assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase()); assert.ok(path.basename(root).startsWith('still-release-tools-')); fs.rmSync(root, {recursive: true, force: true});});
  const target = path.join(root, 'new'); writeEntries(safeZipEntries(zip([{name: 'deep/file', data: 'KNOWN'}])), target);
  assert.equal(fs.readFileSync(path.join(target, 'deep/file'), 'utf8'), 'KNOWN');
  assert.throws(() => writeEntries(new Map([['deep/file', Buffer.from('REPLACE')]]), target), /already exists/);
  assert.equal(fs.readFileSync(path.join(target, 'deep/file'), 'utf8'), 'KNOWN');
});
test('fixed tool downloads verify exact bytes and refuse unapproved redirects without live network', async () => {
  const bytes = Buffer.from('PINNED'), spec = {url: 'https://nodejs.org/dist/fixed.zip', bytes: bytes.length, sha256: sha256(bytes)};
  assert.deepEqual(await fetchTool(spec, {fetcher: async () => new Response(bytes)}), bytes);
  await assert.rejects(fetchTool({...spec, sha256: '0'.repeat(64)}, {fetcher: async () => new Response(bytes)}), /mismatch/);
  let calls = 0;
  await assert.rejects(fetchTool(spec, {fetcher: async () => {calls++; return new Response(null, {status: 302, headers: {location: 'https://untrusted.invalid/tool'}});}}), /Unapproved/);
  assert.equal(calls, 1);
});
test('reviewed recipe fixes Node and all official actions to exact versions/commits', () => {
  const recipe = loadRecipe(); assert.equal(recipe.node.version, '24.22.1');
  for (const action of Object.values(recipe.actions)) assert.match(action, /^actions\/[a-z-]+@[a-f0-9]{40}$/);
  assert.equal(recipe.node.sha256, 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5');
});
module.exports = {zip};
