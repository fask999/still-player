'use strict';
// A candidate is evidence for code review, never a runtime registry or approval.
const fs = require('node:fs');
const path = require('node:path');
const {HASH, sha256, closedRelative, noLinks} = require('./backend-baselines');
const {RUNTIME_REGISTRY_PATH, ASSET_ALIASES, loadRuntimeAssetRegistry, readRuntimeAsset, verifyRuntimeAssets, validateRuntimeAssetRegistry} = require('./runtime-assets');
const ROOT = path.resolve(__dirname, '..');
function candidateOutput(sourceRoot, filename) {
  if (typeof filename !== 'string' || !filename) throw new Error('An explicit new candidate JSON path is required');
  const relative = path.relative(sourceRoot, path.resolve(sourceRoot, filename)).replaceAll('\\', '/');
  if (!/^review-evidence\/.+\.json$/.test(relative)) throw new Error('Runtime asset candidate must be JSON under project review-evidence');
  const resolved = noLinks(closedRelative(sourceRoot, relative), {allowMissing: true});
  if (fs.existsSync(resolved)) throw new Error('Runtime asset candidate output already exists');
  if (!fs.statSync(noLinks(path.dirname(resolved))).isDirectory()) throw new Error('Runtime asset candidate output parent must exist');
  return resolved;
}
function planRuntimeAssetCandidate({sourceRoot = ROOT, asset, expectedCurrentSha256, output} = {}) {
  const candidateMode = [asset, expectedCurrentSha256, output].some(value => value !== undefined);
  if (candidateMode && (!Object.hasOwn(ASSET_ALIASES, asset) || typeof expectedCurrentSha256 !== 'string' || !HASH.test(expectedCurrentSha256))) throw new Error('Runtime asset candidate requires --asset policy|launcher and --expected-current-sha256');
  const outputFile = output === undefined ? null : candidateOutput(sourceRoot, output);
  if (!candidateMode) return {schemaVersion: 1, operation: 'validate-runtime-assets', candidateOnly: true, approved: false, ...verifyRuntimeAssets(sourceRoot)};
  const loaded = loadRuntimeAssetRegistry(sourceRoot);
  if (loaded.registrySha256 !== expectedCurrentSha256) throw new Error('Current runtime asset registry SHA256 differs from expected-current');
  const key = ASSET_ALIASES[asset], bytes = readRuntimeAsset(sourceRoot, key), current = loaded.registry.assets[key];
  const entry = {relativePath: current.relativePath, sha256: sha256(bytes)}, proposedRegistry = JSON.parse(JSON.stringify(loaded.registry));
  proposedRegistry.assets[key] = entry;
  validateRuntimeAssetRegistry(proposedRegistry);
  const result = {schemaVersion: 1, operation: 'propose-runtime-asset', candidateOnly: true, approved: false,
    expectedCurrentRegistrySha256: expectedCurrentSha256, asset, previous: current, candidate: entry, proposedRegistry};
  // The only writable path is a new evidence candidate. Fixed assets and the
  // reviewed registry are never destinations, even when their bytes drift.
  if (loadRuntimeAssetRegistry(sourceRoot).registrySha256 !== expectedCurrentSha256 || sha256(readRuntimeAsset(sourceRoot, key)) !== entry.sha256) throw new Error('Runtime asset registry or candidate changed during planning');
  if (outputFile) {
    noLinks(outputFile, {allowMissing: true});
    const descriptor = fs.openSync(outputFile, 'wx');
    try {fs.writeFileSync(descriptor, `${JSON.stringify(result, null, 2)}\n`); fs.fsyncSync(descriptor);} finally {fs.closeSync(descriptor);}
  }
  return result;
}
function main(args = process.argv.slice(2), {sourceRoot = ROOT, print = value => process.stdout.write(`${value}\n`)} = {}) {
  const flags = new Map([['--asset', 'asset'], ['--expected-current-sha256', 'expectedCurrentSha256'], ['--output', 'output']]), options = {};
  for (let i = 0; i < args.length; i++) {
    const key = flags.get(args[i]);
    if (!key || Object.hasOwn(options, key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use no arguments to validate, or --asset policy|launcher --expected-current-sha256 and optional --output; promotion is by code review only');
    options[key] = args[++i];
  }
  const result = planRuntimeAssetCandidate({sourceRoot, ...options});
  print(JSON.stringify(result, null, 2));
  return result;
}
if (require.main === module) {
  try {main();} catch (error) {process.stderr.write(`${error.message}\n`); process.exitCode = 1;}
}
module.exports = {planRuntimeAssetCandidate, main, RUNTIME_REGISTRY_PATH};
