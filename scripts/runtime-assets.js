'use strict';
const path = require('node:path');
const {HASH, sha256, readRegularBytes} = require('./backend-baselines');
const ROOT = path.resolve(__dirname, '..');
const RUNTIME_REGISTRY_PATH = 'src/main/runtime-assets.json';
const RUNTIME_ASSETS = Object.freeze({
  backendOutputPolicy: Object.freeze({relativePath: 'src/main/backend-output-policy.json', maxBytes: 64 * 1024}),
  backendLauncher: Object.freeze({relativePath: 'native/backend-job/StillBackendLauncher.exe', maxBytes: 8 * 1024 * 1024})
});
// Keep the legacy two-entry export for existing fixtures and private bundles.
// New deliveries opt into exactly this one reviewed third asset.
const DESKTOP_MEDIA_ASSET = Object.freeze({relativePath: 'native/desktop-media/bin/runtime-manifest.json', maxBytes: 64 * 1024,
  reviewedSha256: 'efe33953481d601f9477f9547b592b4b50b57d988aa2e86b763fccc8ae6acb37'});
const DESKTOP_MEDIA_FILES = Object.freeze(['StillMediaControls.exe', 'LICENSE.txt', 'NOTICE.txt', 'runtime-manifest.json']);
const CUE_READ_LEASE_ASSET = Object.freeze({relativePath: 'native/cue-read-lease/bin/runtime-manifest.json', maxBytes: 64 * 1024,
  reviewedSha256: '6ce49390918d8f4b5eaf2001f58980a0f344e8078ab02ba7e9540d71a9af84c6'});
const CUE_READ_LEASE_FILES = Object.freeze(['StillCueReadLease.exe', 'NOTICE.txt', 'runtime-manifest.json']);
const ASSET_ALIASES = Object.freeze({policy: 'backendOutputPolicy', launcher: 'backendLauncher'});
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.hasOwn(value, key))) throw new Error(`Invalid closed runtime ${label} schema`);
}
function validateRuntimeAssetRegistry(value) {
  exactKeys(value, ['schemaVersion', 'assets'], 'asset registry');
  if (value.schemaVersion !== 1) throw new Error('Invalid runtime asset registry version');
  const kinds = {...RUNTIME_ASSETS, ...(Object.hasOwn(value.assets || {}, 'desktopMediaManifest') ? {desktopMediaManifest: DESKTOP_MEDIA_ASSET} : {}),
    ...(Object.hasOwn(value.assets || {}, 'cueReadLeaseManifest') ? {cueReadLeaseManifest: CUE_READ_LEASE_ASSET} : {})};
  exactKeys(value.assets, Object.keys(kinds), 'asset kinds');
  for (const [key, fixed] of Object.entries(kinds)) {
    const entry = value.assets[key];
    exactKeys(entry, ['relativePath', 'sha256'], 'asset entry');
    if (entry.relativePath !== fixed.relativePath || typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)) throw new Error('Runtime asset path or reviewed SHA256 differs from the fixed contract');
    if (fixed.reviewedSha256 && entry.sha256 !== fixed.reviewedSha256) throw new Error('Optional runtime manifest differs from its independently reviewed top-level pin');
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
  if (!Object.hasOwn(RUNTIME_ASSETS, key) && !['desktopMediaManifest', 'cueReadLeaseManifest'].includes(key)) throw new Error('Unknown fixed runtime asset');
  const fixed = key === 'desktopMediaManifest' ? DESKTOP_MEDIA_ASSET : key === 'cueReadLeaseManifest' ? CUE_READ_LEASE_ASSET : RUNTIME_ASSETS[key], bytes = readRegularBytes(sourceRoot, fixed.relativePath, fixed.maxBytes);
  if (!bytes.length) throw new Error('Runtime asset is empty');
  // Output-policy authorization/schema belongs to the runtime loader. Here we
  // only bind the exact original bytes and reject malformed JSON.
  if (['backendOutputPolicy', 'desktopMediaManifest', 'cueReadLeaseManifest'].includes(key)) JSON.parse(bytes);
  return bytes;
}
function verifyOptionalRuntimeAssets(sourceRoot, key, spec, names, kind) {
  const loaded = loadRuntimeAssetRegistry(sourceRoot), entry = loaded.registry.assets[key];
  if (!entry) throw new Error('Optional runtime requires a reviewed top-level manifest entry');
  const bytes = readRuntimeAsset(sourceRoot, key);
  if (sha256(bytes) !== entry.sha256) throw new Error('Optional manifest differs from the reviewed top-level SHA256');
  const manifest = JSON.parse(bytes);
  exactKeys(manifest, ['schemaVersion', 'kind', 'architecture', 'files'], 'desktop media manifest');
  if (manifest.schemaVersion !== 1 || manifest.kind !== kind || manifest.architecture !== 'x64' || !Array.isArray(manifest.files) || manifest.files.length !== names.length - 1) throw new Error('Invalid optional runtime manifest');
  const expected = names.slice(0, -1), seen = new Set(), files = [];
  const prefix = spec.relativePath.slice(0, spec.relativePath.lastIndexOf('/') + 1);
  for (const item of manifest.files) {
    exactKeys(item, ['path', 'bytes', 'sha256'], 'desktop media file');
    if (!expected.includes(item.path) || seen.has(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > 1024 * 1024 || !HASH.test(item.sha256)) throw new Error('Desktop media file escapes the fixed runtime allowlist');
    seen.add(item.path);
    const relativePath = prefix + item.path, value = readRegularBytes(sourceRoot, relativePath, 1024 * 1024);
    if (value.length !== item.bytes || sha256(value) !== item.sha256) throw new Error(`Desktop media runtime bytes differ from the reviewed manifest: ${item.path}`);
    files.push(Object.freeze({relativePath, bytes: value.length, sha256: item.sha256}));
  }
  files.push(Object.freeze({relativePath: spec.relativePath, bytes: bytes.length, sha256: entry.sha256}));
  if (loadRuntimeAssetRegistry(sourceRoot).registrySha256 !== loaded.registrySha256) throw new Error('Runtime registry changed during desktop media validation');
  return Object.freeze({manifestSha256: entry.sha256, files: Object.freeze(files), hashes: Object.freeze(Object.fromEntries(files.map(file => [file.relativePath, file.sha256])))});
}
function verifyDesktopMediaRuntimeAssets(sourceRoot = ROOT) {return verifyOptionalRuntimeAssets(sourceRoot, 'desktopMediaManifest', DESKTOP_MEDIA_ASSET, DESKTOP_MEDIA_FILES, 'still-desktop-media');}
function verifyCueReadLeaseRuntimeAssets(sourceRoot = ROOT) {return verifyOptionalRuntimeAssets(sourceRoot, 'cueReadLeaseManifest', CUE_READ_LEASE_ASSET, CUE_READ_LEASE_FILES, 'still-cue-read-lease');}
function verifyRuntimeAssets(sourceRoot = ROOT) {
  const loaded = loadRuntimeAssetRegistry(sourceRoot), assets = {}, hashes = {[RUNTIME_REGISTRY_PATH]: loaded.registrySha256};
  for (const [key, entry] of Object.entries(loaded.registry.assets)) {
    const bytes = readRuntimeAsset(sourceRoot, key);
    if (sha256(bytes) !== entry.sha256) throw new Error(`Runtime asset differs from reviewed SHA256: ${key}`);
    assets[key] = Object.freeze({...entry, bytes: bytes.length});
    hashes[entry.relativePath] = entry.sha256;
  }
  if (loadRuntimeAssetRegistry(sourceRoot).registrySha256 !== loaded.registrySha256) throw new Error('Runtime asset registry changed during verification');
  const desktopMedia = loaded.registry.assets.desktopMediaManifest ? verifyDesktopMediaRuntimeAssets(sourceRoot) : null;
  if (desktopMedia) Object.assign(hashes, desktopMedia.hashes);
  const cueReadLease = loaded.registry.assets.cueReadLeaseManifest ? verifyCueReadLeaseRuntimeAssets(sourceRoot) : null;
  if (cueReadLease) Object.assign(hashes, cueReadLease.hashes);
  if (loadRuntimeAssetRegistry(sourceRoot).registrySha256 !== loaded.registrySha256) throw new Error('Runtime asset registry changed during verification');
  return Object.freeze({registrySha256: loaded.registrySha256, assets: Object.freeze(assets), hashes: Object.freeze(hashes), ...(desktopMedia ? {desktopMedia} : {}), ...(cueReadLease ? {cueReadLease} : {})});
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
  DESKTOP_MEDIA_ASSET, DESKTOP_MEDIA_FILES, CUE_READ_LEASE_ASSET, CUE_READ_LEASE_FILES, readRuntimeAsset, verifyRuntimeAssets, verifyDesktopMediaRuntimeAssets, verifyCueReadLeaseRuntimeAssets, assertRuntimeAssetSnapshot, assertRuntimeAssetHashes};
