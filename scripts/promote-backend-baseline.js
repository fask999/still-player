'use strict';
// Produces candidates for code review. No mode can overwrite the reviewed registry.
const fs = require('node:fs');
const path = require('node:path');
const {REGISTRY_PATH, DESTINATIONS, HASH, UUID, sha256, validateBackendBaselines, loadBackendBaselines, closedRelative, noLinks, readRegularBytes} = require('./backend-baselines');
const ROOT = path.resolve(__dirname, '..');
function evidencePath(sourceRoot, filename) {
  if (typeof filename !== 'string' || !filename) throw new Error('An explicit evidence JSON path is required');
  const relative = path.relative(sourceRoot, path.resolve(sourceRoot, filename)).replaceAll('\\', '/');
  if (!/^review-evidence\/.+\.json$/.test(relative)) throw new Error('Candidate snapshot and output must be JSON under project review-evidence');
  closedRelative(sourceRoot, relative);
  return relative;
}
function candidateEntry(bytes, kind, sourceRoot) {
  const manifest = JSON.parse(bytes), destination = closedRelative(sourceRoot, DESTINATIONS[kind]);
  if (!manifest || manifest.schemaVersion !== 1 || manifest.privateUseOnly !== true || !UUID.test(manifest.backendId || '') ||
    typeof manifest.destinationDir !== 'string' || path.resolve(manifest.destinationDir).toLowerCase() !== destination.toLowerCase() ||
    manifest.executable !== 'foobar2000.exe' || !Array.isArray(manifest.files) || !manifest.files.length ||
    ['spectrumComponent', 'packagedAt', 'packagedFromBackendId'].some(key => Object.hasOwn(manifest, key))) throw new Error('Candidate must be an exact pre-spectrum private backend manifest with the fixed destination');
  const seen = new Set();
  for (const entry of manifest.files) {
    closedRelative(sourceRoot, entry.relativePath);
    const key = entry.relativePath.toLowerCase();
    if (seen.has(key) || typeof entry.mutable !== 'boolean' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
      typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256) || typeof entry.mode !== 'string' || !entry.mode ||
      (Object.hasOwn(entry, 'sourceSha256') && (typeof entry.sourceSha256 !== 'string' || !HASH.test(entry.sourceSha256)))) throw new Error('Invalid or duplicate candidate manifest entry');
    if (key.startsWith('profile/user-components-x64/foo_still_spectrum/')) throw new Error('Candidate must precede the spectrum component migration');
    seen.add(key);
  }
  if (manifest.totalFiles !== manifest.files.length || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes !== manifest.files.reduce((sum, entry) => sum + entry.bytes, 0) ||
    !['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll'].every(name => seen.has(name))) throw new Error('Candidate manifest totals or core entries are invalid');
  const config = manifest.configuration;
  if (!config || config.allowRemote !== false || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || config.port === 8880 ||
    !Array.isArray(config.musicDirs) || !config.musicDirs.length || !config.musicDirs.every(value => typeof value === 'string' && path.win32.isAbsolute(value) && !/[\0\r\n]/.test(value))) throw new Error('Candidate requires the dedicated loopback configuration');
  return {sha256: sha256(bytes), canonicalSha256: sha256(Buffer.from(JSON.stringify(manifest))), backendId: manifest.backendId, destinationRelativePath: DESTINATIONS[kind]};
}
function planBaselineCandidate({sourceRoot = ROOT, backend, manifest, expectedCurrentSha256, output} = {}) {
  const candidateMode = [backend, manifest, expectedCurrentSha256, output].some(value => value !== undefined);
  if (candidateMode && (!Object.hasOwn(DESTINATIONS, backend) || !manifest || typeof expectedCurrentSha256 !== 'string' || !HASH.test(expectedCurrentSha256))) throw new Error('Candidate requires --backend source|target, --manifest and --expected-current-sha256');
  const inputRelative = candidateMode ? evidencePath(sourceRoot, manifest) : null;
  const outputRelative = output === undefined ? null : evidencePath(sourceRoot, output);
  if (outputRelative && inputRelative.toLowerCase() === outputRelative.toLowerCase()) throw new Error('Candidate output cannot replace its snapshot');
  if (outputRelative) {
    const filename = noLinks(closedRelative(sourceRoot, outputRelative), {allowMissing: true});
    if (fs.existsSync(filename)) throw new Error('Candidate output already exists');
    if (!fs.statSync(noLinks(path.dirname(filename))).isDirectory()) throw new Error('Candidate output parent must exist');
  }
  const registry = loadBackendBaselines(sourceRoot);
  if (!candidateMode) return {schemaVersion: 1, operation: 'validate-backend-baselines', candidateOnly: true, approved: false,
    registry: REGISTRY_PATH, policySha256: registry.policySha256, policy: registry.policy};
  if (registry.policySha256 !== expectedCurrentSha256) throw new Error('Current backend baseline policy SHA256 differs from expected-current');
  const snapshot = readRegularBytes(sourceRoot, inputRelative, 4 * 1024 * 1024), entry = candidateEntry(snapshot, backend, sourceRoot);
  const proposedPolicy = JSON.parse(JSON.stringify(registry.policy));
  proposedPolicy.baselines[backend] = entry;
  validateBackendBaselines(proposedPolicy);
  const result = {schemaVersion: 1, operation: 'propose-backend-baseline', candidateOnly: true, approved: false,
    expectedCurrentPolicySha256: expectedCurrentSha256, backendKind: backend, previous: registry.policy.baselines[backend], candidate: entry, proposedPolicy};
  // Revalidate both inputs immediately before any candidate-file write. The registry is never a write destination.
  if (loadBackendBaselines(sourceRoot).policySha256 !== expectedCurrentSha256 || sha256(readRegularBytes(sourceRoot, inputRelative, 4 * 1024 * 1024)) !== entry.sha256) throw new Error('Baseline policy or candidate snapshot changed during planning');
  if (outputRelative) {
    const filename = noLinks(closedRelative(sourceRoot, outputRelative), {allowMissing: true}), descriptor = fs.openSync(filename, 'wx');
    try {fs.writeFileSync(descriptor, `${JSON.stringify(result, null, 2)}\n`); fs.fsyncSync(descriptor);} finally {fs.closeSync(descriptor);}
  }
  return result;
}
function main(args = process.argv.slice(2), {sourceRoot = ROOT, print = value => console.log(value)} = {}) {
  const options = {}, flags = new Map([['--backend', 'backend'], ['--manifest', 'manifest'], ['--expected-current-sha256', 'expectedCurrentSha256'], ['--output', 'output']]);
  for (let i = 0; i < args.length; i++) {
    const key = flags.get(args[i]);
    if (!key || Object.hasOwn(options, key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use no arguments to validate, or explicit --backend, --manifest, --expected-current-sha256 and optional --output; promotion is by code review only');
    options[key] = args[++i];
  }
  const result = planBaselineCandidate({sourceRoot, ...options});
  print(JSON.stringify(result, null, 2));
  return result;
}
if (require.main === module) {
  try {main();} catch (error) {console.error(error.message); process.exitCode = 1;}
}
module.exports = {planBaselineCandidate, main};
