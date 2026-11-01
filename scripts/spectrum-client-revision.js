'use strict';
const path = require('node:path');
const {HASH, sha256, readRegularBytes} = require('./backend-baselines');
const ROOT = path.resolve(__dirname, '..');
const CLIENT_SOURCE_PATH = 'src/main/spectrum-client.js';
const CLIENT_REVISION_PATH = 'manifests/spectrum-client-revision.json';
const CLIENT_REVISION_SHA256 = 'ae578691b8124fd4674464fc1099c405ee09b9152c65f18bffdfddd00c211ae7';
const NATIVE_MANIFEST_SHA256 = '284dae8ad48b96a464c635d8e848bc20d1699dfa74948987f8765d4ac94a131f';
const MAX_CLIENT_BYTES = 1024 * 1024;
const ORIGINAL_CLIENT_SOURCE = Object.freeze({relativePath: CLIENT_SOURCE_PATH, bytes: 20573,
  sha256: 'b7967d3723ab742b9f426a8ae0d00024616d04f2849bd1a2bf30a50b5da7b652'});
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.hasOwn(value, key))) throw new Error(`Invalid closed spectrum client ${label} schema`);
}
function validateSpectrumClientRevision(value) {
  exactKeys(value, ['schemaVersion', 'nativeManifestSha256', 'originalClientSha256', 'clientSource', 'proofHash'], 'revision');
  exactKeys(value.clientSource, ['relativePath', 'bytes', 'sha256'], 'source');
  if (value.schemaVersion !== 1 || value.nativeManifestSha256 !== NATIVE_MANIFEST_SHA256 || value.originalClientSha256 !== ORIGINAL_CLIENT_SOURCE.sha256 ||
    value.clientSource.relativePath !== CLIENT_SOURCE_PATH || !Number.isSafeInteger(value.clientSource.bytes) || value.clientSource.bytes <= 0 || value.clientSource.bytes > MAX_CLIENT_BYTES ||
    typeof value.clientSource.sha256 !== 'string' || !HASH.test(value.clientSource.sha256) || typeof value.proofHash !== 'string' || !HASH.test(value.proofHash)) throw new Error('Spectrum client revision differs from its fixed native/source/proof contract');
  Object.freeze(value.clientSource);
  return Object.freeze(value);
}
function verifySpectrumClientRevision(sourceRoot = ROOT) {
  const initial = readRegularBytes(sourceRoot, CLIENT_SOURCE_PATH, MAX_CLIENT_BYTES), initialSha256 = sha256(initial);
  // This is a separate exact known-vector branch, never a fallback after an
  // invalid new revision. The original reviewed source needs no revision file.
  if (initial.length === ORIGINAL_CLIENT_SOURCE.bytes && initialSha256 === ORIGINAL_CLIENT_SOURCE.sha256) {
    return Object.freeze({clientSource: ORIGINAL_CLIENT_SOURCE, clientRevision: null,
      clientHashes: Object.freeze({[CLIENT_SOURCE_PATH]: ORIGINAL_CLIENT_SOURCE.sha256})});
  }
  const recordBytes = readRegularBytes(sourceRoot, CLIENT_REVISION_PATH, 8 * 1024);
  if (sha256(recordBytes) !== CLIENT_REVISION_SHA256) throw new Error('Spectrum client revision does not match its reviewed raw SHA256');
  const record = validateSpectrumClientRevision(JSON.parse(recordBytes));
  const current = readRegularBytes(sourceRoot, CLIENT_SOURCE_PATH, MAX_CLIENT_BYTES);
  if (current.length !== record.clientSource.bytes || sha256(current) !== record.clientSource.sha256) throw new Error('Spectrum client source integrity failed for the reviewed revision');
  if (sha256(readRegularBytes(sourceRoot, CLIENT_REVISION_PATH, 8 * 1024)) !== CLIENT_REVISION_SHA256) throw new Error('Spectrum client revision changed during verification');
  return Object.freeze({clientSource: record.clientSource,
    clientRevision: Object.freeze({recordPath: CLIENT_REVISION_PATH, rawSha256: CLIENT_REVISION_SHA256, proofHash: record.proofHash,
      nativeManifestSha256: record.nativeManifestSha256, originalClientSha256: record.originalClientSha256}),
    clientHashes: Object.freeze({[CLIENT_REVISION_PATH]: CLIENT_REVISION_SHA256, [CLIENT_SOURCE_PATH]: record.clientSource.sha256})});
}
module.exports = {CLIENT_SOURCE_PATH, CLIENT_REVISION_PATH, CLIENT_REVISION_SHA256, NATIVE_MANIFEST_SHA256, ORIGINAL_CLIENT_SOURCE,
  validateSpectrumClientRevision, verifySpectrumClientRevision};
