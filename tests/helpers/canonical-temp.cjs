'use strict';
// Fixture setup only. Never use this to normalize a path under a production
// rejection test: only the existing temporary parent is deliberately resolved.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createCanonicalTemp(prefix, {parent = os.tmpdir(), fileSystem = fs, pathImpl = path} = {}) {
  if (typeof prefix !== 'string' || !prefix || prefix.length > 128 || prefix === '.' || prefix === '..' ||
      /[\\/:*?"<>|\0\r\n]/.test(prefix) || pathImpl.basename(prefix) !== prefix) {
    throw new TypeError('A fixture directory prefix must be one non-empty local name.');
  }
  if (typeof parent !== 'string' || !pathImpl.isAbsolute(parent)) throw new TypeError('The fixture temporary parent must be absolute.');
  const resolveReal = target => typeof fileSystem.realpathSync.native === 'function'
    ? fileSystem.realpathSync.native(target) : fileSystem.realpathSync(target);
  const normalized = value => {
    const resolved = pathImpl.resolve(value);
    return pathImpl.sep === '\\' ? resolved.toLowerCase() : resolved;
  };
  const canonicalParent = resolveReal(parent);
  const parentStat = fileSystem.lstatSync(canonicalParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('The canonical fixture parent must be a real directory.');
  const root = fileSystem.mkdtempSync(pathImpl.join(canonicalParent, prefix));
  if (normalized(pathImpl.dirname(root)) !== normalized(canonicalParent) || !pathImpl.basename(root).startsWith(prefix)) {
    throw new Error('The new fixture root is outside its canonical temporary parent.');
  }
  const rootStat = fileSystem.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || normalized(resolveReal(root)) !== normalized(root)) {
    // Do not follow or delete a redirected root. In particular, never return
    // its realpath as though that pre-existing target had been made by mkdtemp.
    throw new Error('The newly created fixture root was redirected.');
  }
  return Object.freeze({root, parent: canonicalParent});
}

module.exports = {createCanonicalTemp};
