'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {dataFields} = require('./dac-identity');

const MAX_GRANTS = 32;
const MAX_BYTES = 64 * 1024;
const MAX_FILE_BYTES = BigInt(MAX_BYTES);
const STORE_NAME = 'dac-authorizations.sealed';

function storeError() {
  return Object.assign(new Error('无法安全读取或保存 DAC 授权。'), {code: 'STILL_DAC_STORE_UNAVAILABLE'});
}

const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const sameFile = (left, right) => left && right && left.dev === right.dev && left.ino === right.ino;

async function verifyDirectory(directory) {
  let cursor = directory;
  for (;;) {
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(cursor), cursor)) throw storeError();
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function readStat(filename) {
  const stat = await fs.lstat(filename, {bigint: true}).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n || stat.size > MAX_FILE_BYTES ||
      !samePath(await fs.realpath(filename), filename))) throw storeError();
  return stat;
}

function createDacAuthorizationStore({dataDir, seal, unseal} = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || /^[\\/]{2}/.test(dataDir) || path.resolve(dataDir) !== dataDir ||
      typeof seal !== 'function' || typeof unseal !== 'function') throw storeError();
  const filename = path.join(dataDir, STORE_NAME);

  async function read() {
    try {
      await verifyDirectory(dataDir);
      const before = await readStat(filename);
      if (!before) return [];
      const handle = await fs.open(filename, 'r');
      let ciphertext;
      try {
        const current = await handle.stat({bigint: true});
        if (!sameFile(before, current) || current.nlink !== 1n || current.size < 1n || current.size > MAX_FILE_BYTES) throw storeError();
        const size = Number(current.size), buffer = Buffer.alloc(size + 1);
        const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== size) throw storeError();
        ciphertext = buffer.subarray(0, bytesRead);
      } finally {await handle.close();}
      if (!sameFile(before, await readStat(filename))) throw storeError();
      const plaintext = await unseal(ciphertext);
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > MAX_BYTES) throw storeError();
      const record = dataFields(JSON.parse(plaintext), ['schemaVersion', 'grants']);
      if (!record || record.schemaVersion !== 1 || !Array.isArray(record.grants) || record.grants.length > MAX_GRANTS) throw storeError();
      return record.grants;
    } catch {throw storeError();}
  }

  async function write(grants, {check} = {}) {
    let temporary, identity;
    try {
      if (!Array.isArray(grants) || grants.length > MAX_GRANTS) throw storeError();
      const plaintext = JSON.stringify({schemaVersion: 1, grants});
      if (Buffer.byteLength(plaintext) > MAX_BYTES) throw storeError();
      const ciphertext = await seal(plaintext);
      if (!Buffer.isBuffer(ciphertext) || ciphertext.length < 1 || ciphertext.length > MAX_BYTES) throw storeError();
      await verifyDirectory(dataDir);
      const previous = await readStat(filename);
      temporary = path.join(dataDir, `.dac-authorizations-${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        identity = await handle.stat({bigint: true});
        if (!identity.isFile() || identity.nlink !== 1n) throw storeError();
        await handle.writeFile(ciphertext);
        await handle.sync();
      } finally {await handle.close();}
      await verifyDirectory(dataDir);
      const current = await readStat(filename);
      if ((previous || current) && !sameFile(previous, current)) throw storeError();
      if (!sameFile(identity, await readStat(temporary))) throw storeError();
      check?.();
      await fs.rename(temporary, filename);
      temporary = null;
    } catch (error) {
      if (error?.code === 'STILL_DAC_CONTEXT_CHANGED') throw error;
      throw storeError();
    } finally {
      if (temporary && identity) {
        try {
          await verifyDirectory(dataDir);
          const stat = await fs.lstat(temporary, {bigint: true});
          if (sameFile(identity, stat) && stat.isFile() && stat.nlink === 1n) await fs.unlink(temporary);
        } catch { /* Preserve any file whose identity cannot be checked. */ }
      }
    }
  }
  return {read, write};
}

module.exports = {createDacAuthorizationStore, MAX_GRANTS};
