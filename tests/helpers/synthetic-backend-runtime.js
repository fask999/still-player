'use strict';
// Temporary data for complete process/fetch DI only. Nothing here is executable.
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const endpoint = '{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}';
const syntheticPolicy = () => ({schemaVersion: 1, policyId: 'dx1-wasapi-in-process-v1', outputs: [{typeId: 'output',
  deviceId: '0DD9B977-765B-4804-BF2D-B28EBF0C510D:016F9F0C-AFE4-4072-9018-CCEBB576B4CB', endpoint,
  exclusiveValidationFormat: {sampleRate: 48000, bits: 32, channels: 2}, ownedExitRelease: true}]});
async function writeSyntheticBackendRuntime(root, {policy = syntheticPolicy()} = {}) {
  const values = {
    backendOutputPolicy: {relativePath: 'src/main/backend-output-policy.json', bytes: Buffer.from(JSON.stringify(policy))},
    backendLauncher: {relativePath: 'native/backend-job/StillBackendLauncher.exe', bytes: Buffer.from('SYNTHETIC NOT EXECUTABLE; NEVER RUN')}
  };
  const assets = {};
  for (const [name, value] of Object.entries(values)) {
    const target = path.join(root, value.relativePath); await fs.mkdir(path.dirname(target), {recursive: true}); await fs.writeFile(target, value.bytes);
    assets[name] = {relativePath: value.relativePath, sha256: createHash('sha256').update(value.bytes).digest('hex')};
  }
  const registryPath = path.join(root, 'src/main/runtime-assets.json');
  await fs.writeFile(registryPath, JSON.stringify({schemaVersion: 1, assets}));
  return {policy, registryPath, assets};
}
module.exports = {writeSyntheticBackendRuntime, syntheticPolicy};
