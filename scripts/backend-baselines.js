'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = 'manifests/backend-baselines.json';
const PURPOSE = 'still-private-backend-spectrum-baselines';
const DESTINATIONS = Object.freeze({source: 'backend/foobar2000', target: 'dist/Still-V2-preview-win32-x64/backend/foobar2000'});
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.hasOwn(value, key))) throw new Error(`Invalid closed ${label} schema`);
}
function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}
function validateBackendBaselines(value) {
  exactKeys(value, ['schemaVersion', 'purpose', 'baselines'], 'backend baseline registry');
  if (value.schemaVersion !== 1 || value.purpose !== PURPOSE) throw new Error('Invalid backend baseline registry version or purpose');
  exactKeys(value.baselines, ['source', 'target'], 'backend baseline kinds');
  for (const kind of Object.keys(DESTINATIONS)) {
    const entry = value.baselines[kind];
    exactKeys(entry, ['sha256', 'canonicalSha256', 'backendId', 'destinationRelativePath'], 'backend baseline entry');
    if (typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256) || typeof entry.canonicalSha256 !== 'string' || !HASH.test(entry.canonicalSha256) ||
      typeof entry.backendId !== 'string' || !UUID.test(entry.backendId) || entry.destinationRelativePath !== DESTINATIONS[kind]) throw new Error('Invalid reviewed backend baseline identity, hash or fixed destination');
  }
  if (value.baselines.source.sha256 === value.baselines.target.sha256 || value.baselines.source.backendId === value.baselines.target.backendId) throw new Error('Duplicate reviewed backend baseline identity');
  return freeze(value);
}
function closedRelative(root, relative) {
  if (typeof relative !== 'string' || !relative || /[\\:\0-\x1f]/.test(relative) || relative.split('/').some(part =>
    !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Invalid closed baseline path');
  const filename = path.resolve(root, ...relative.split('/')), local = path.relative(path.resolve(root), filename);
  if (!local || local === '..' || local.startsWith(`..${path.sep}`) || path.isAbsolute(local)) throw new Error('Baseline path escapes root');
  return filename;
}
function noLinks(filename, {allowMissing = false} = {}) {
  const resolved = path.resolve(filename);
  for (let cursor = resolved; ; cursor = path.dirname(cursor)) {
    let entry;
    try {entry = fs.lstatSync(cursor);} catch (error) {if (allowMissing && error.code === 'ENOENT') entry = null; else throw error;}
    if (entry?.isSymbolicLink()) throw new Error('Baseline link or junction is forbidden');
    if (path.dirname(cursor) === cursor) break;
  }
  if (fs.existsSync(resolved) && fs.realpathSync(resolved).toLowerCase() !== resolved.toLowerCase()) throw new Error('Baseline resolved path differs');
  return resolved;
}
function readRegularBytes(root, relative, maxBytes = 64 * 1024) {
  const filename = noLinks(closedRelative(root, relative)), descriptor = fs.openSync(filename, 'r');
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error('Expected a small unlinked regular baseline file');
    const bytes = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor), named = fs.lstatSync(noLinks(filename));
    if (![after, named].every(stat => stat.isFile() && stat.nlink === 1 && stat.dev === before.dev && stat.ino === before.ino &&
      stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs) || bytes.length !== before.size) throw new Error('Baseline file changed during snapshot');
    return bytes;
  } finally {fs.closeSync(descriptor);}
}
function loadBackendBaselines(sourceRoot = ROOT) {
  const bytes = readRegularBytes(sourceRoot, REGISTRY_PATH);
  return freeze({policySha256: sha256(bytes), policy: validateBackendBaselines(JSON.parse(bytes))});
}
function selectBackendBaseline(registry, kind, sourceRoot = ROOT) {
  if (!Object.hasOwn(DESTINATIONS, kind)) throw new Error('Backend baseline kind must be source or target');
  const entry = registry.policy.baselines[kind];
  return Object.freeze({kind, sha256: entry.sha256, canonicalSha256: entry.canonicalSha256, backendId: entry.backendId,
    destinationDir: closedRelative(sourceRoot, entry.destinationRelativePath)});
}
module.exports = {REGISTRY_PATH, PURPOSE, DESTINATIONS, HASH, UUID, sha256, validateBackendBaselines, loadBackendBaselines, selectBackendBaseline, closedRelative, noLinks, readRegularBytes};
