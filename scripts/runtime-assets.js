'use strict';
const path = require('node:path');
const {HASH, sha256, readRegularBytes} = require('./backend-baselines');
const ROOT = path.resolve(__dirname, '..');
const RUNTIME_REGISTRY_PATH = 'src/main/runtime-assets.json';
const RUNTIME_ASSETS = Object.freeze({
  backendOutputPolicy: Object.freeze({relativePath: 'src/main/backend-output-policy.json', maxBytes: 64 * 1024}),
  backendLauncher: Object.freeze({relativePath: 'native/backend-job/StillBackendLauncher.exe', maxBytes: 8 * 1024 * 1024})
});
const ASSET_ALIASES = Object.freeze({policy: 'backendOutputPolicy', launcher: 'backendLauncher'});
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.hasOwn(value, key))) throw new Error(`Invalid closed runtime ${label} schema`);
}
function validateRuntimeAssetRegistry(value) {
  exactKeys(value, ['schemaVersion', 'assets'], 'asset registry');
  if (value.schemaVersion !== 1) throw new Error('Invalid runtime asset registry version');
  exactKeys(value.assets, Object.keys(RUNTIME_ASSETS), 'asset kinds');
  for (const [key, fixed] of Object.entries(RUNTIME_ASSETS)) {
    const entry = value.assets[key];
    exactKeys(entry, ['relativePath', 'sha256'], 'asset entry');
    if (entry.relativePath !== fixed.relativePath || typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)) throw new Error('Runtime asset path or reviewed SHA256 differs from the fixed contract');
    Object.freeze(entry);
  }
  Object.freeze(value.assets);
  return Object.freeze(value);
}
function loadRuntimeAssetRegistry(sourceRoot = ROOT) {
  const bytes = readRegularBytes(sourceRoot, RUNTIME_REGISTRY_PATH, 8 * 1024);
  return Object.freeze({registrySha256: sha256(bytes), registry: validateRuntimeAssetRegistry(JSON.parse(bytes))});
}
function readRuntimeAsset(sourceRoot, key) {
  if (!Object.hasOwn(RUNTIME_ASSETS, key)) throw new Error('Unknown fixed runtime asset');
  const fixed = RUNTIME_ASSETS[key], bytes = readRegularBytes(sourceRoot, fixed.relativePath, fixed.maxBytes);
  if (!bytes.length) throw new Error('Runtime asset is empty');
  // Output-policy authorization/schema belongs to the runtime loader. Here we
  // only bind the exact original bytes and reject malformed JSON.
  if (key === 'backendOutputPolicy') JSON.parse(bytes);
  return bytes;
}
function verifyRuntimeAssets(sourceRoot = ROOT) {
  const loaded = loadRuntimeAssetRegistry(sourceRoot), assets = {}, hashes = {[RUNTIME_REGISTRY_PATH]: loaded.registrySha256};
  for (const [key, entry] of Object.entries(loaded.registry.assets)) {
    const bytes = readRuntimeAsset(sourceRoot, key);
    if (sha256(bytes) !== entry.sha256) throw new Error(`Runtime asset differs from reviewed SHA256: ${key}`);
    assets[key] = Object.freeze({...entry, bytes: bytes.length});
    hashes[entry.relativePath] = entry.sha256;
  }
  if (loadRuntimeAssetRegistry(sourceRoot).registrySha256 !== loaded.registrySha256) throw new Error('Runtime asset registry changed during verification');
  return Object.freeze({registrySha256: loaded.registrySha256, assets: Object.freeze(assets), hashes: Object.freeze(hashes)});
}
function assertRuntimeAssetSnapshot(expected, actual) {
  if (JSON.stringify(actual.hashes) !== JSON.stringify(expected.hashes)) throw new Error('Runtime asset snapshot changed after validation');
}
function assertRuntimeAssetHashes(snapshot, hashes, prefix = 'resources/app/') {
  for (const [relativePath, expected] of Object.entries(snapshot.hashes)) {
    if (hashes[`${prefix}${relativePath}`] !== expected) throw new Error(`Runtime asset changed before the package snapshot was frozen: ${relativePath}`);
  }
}
module.exports = {RUNTIME_REGISTRY_PATH, RUNTIME_ASSETS, ASSET_ALIASES, validateRuntimeAssetRegistry, loadRuntimeAssetRegistry,
  readRuntimeAsset, verifyRuntimeAssets, assertRuntimeAssetSnapshot, assertRuntimeAssetHashes};
