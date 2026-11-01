'use strict';
// Test-only mechanical extraction. Importing does not spawn or write anything.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const pins = () => readJson(path.join(__dirname, 'accepted-inputs.json'));

function assertAcceptedInputs() {
  const accepted = pins(), observed = [];
  for (const item of accepted.files) {
    const bytes = fs.readFileSync(path.join(ROOT, item.path));
    assert.equal(bytes.length, item.bytes, `accepted byte count changed: ${item.path}`);
    assert.equal(sha(bytes), item.sha256, `accepted input changed: ${item.path}`);
    observed.push({ ...item });
  }
  const delivery = readJson(path.join(ROOT, 'native/foobar-spectrum/delivery-manifest.json'));
  const covered = [delivery.clientSource, ...delivery.packageWhitelist.map(item => ({ ...item, relativePath: item.sourceRelativePath }))];
  for (const item of covered) {
    const pinned = accepted.files.find(f => f.path === item.relativePath);
    assert.ok(pinned, `delivery input is not pinned: ${item.relativePath}`);
    assert.equal(pinned.sha256, item.sha256, `pin differs from accepted delivery manifest: ${item.relativePath}`);
    assert.equal(pinned.bytes, item.bytes);
  }
  const nativeAccepted = readJson(path.join(ROOT, 'review-evidence/spectrum-20261101/component/source-hashes.json'));
  for (const relative of ['native/foobar-spectrum/component.cpp', 'native/foobar-spectrum/dsp.hpp']) {
    const old = nativeAccepted.find(item => item.path.replace(/\\/g, '/') === relative);
    assert.equal(accepted.files.find(item => item.path === relative)?.sha256, old?.sha256, `native source acceptance mismatch: ${relative}`);
  }
  return observed;
}

const boundaries = [
  ['types-and-constants', 'using Clock = std::chrono::steady_clock;', 'struct SampleJob {'],
  ['production-encoder', 'std::string json_string(', '\nclass Runtime;'],
  ['production-security-and-io', 'class PipeSecurity {', '\nclass Runtime :'],
  ['production-pipe-loop', '    void pipe_loop() noexcept {', '\n    const std::string session_;']
];
function extractFragments() {
  assertAcceptedInputs();
  const source = fs.readFileSync(path.join(ROOT, 'native/foobar-spectrum/component.cpp'), 'utf8');
  return boundaries.map(([name, startMarker, endMarker]) => {
    for (const marker of [startMarker, endMarker]) assert.equal(source.split(marker).length - 1, 1, `nonunique boundary: ${name}`);
    const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(end > start, `invalid extraction range: ${name}`);
    const text = source.slice(start, end);
    assert.doesNotMatch(text, /foobar2000\/SDK|playback_control|visualisation_stream|service_ptr_t|analyze_interleaved\s*\(/);
    return { name, startMarker, endMarker, startByte: Buffer.byteLength(source.slice(0, start)),
      endByte: Buffer.byteLength(source.slice(0, end)), startLine: source.slice(0, start).split('\n').length,
      bytes: Buffer.byteLength(text), sha256: sha(Buffer.from(text)), text };
  });
}
function generate() {
  const accepted = assertAcceptedInputs(), fragments = extractFragments();
  let generated = fs.readFileSync(path.join(__dirname, 'fixture-template.cpp'), 'utf8');
  for (const fragment of fragments) {
    const marker = `/* EXTRACT:${fragment.name} */`;
    assert.equal(generated.split(marker).length - 1, 1, `nonunique template marker: ${fragment.name}`);
    generated = generated.replace(marker, fragment.text);
  }
  assert.doesNotMatch(generated, /EXTRACT:|analyze_interleaved\s*\(|#include.*foobar2000|foobar2000_get_interface/);
  const output = path.join(__dirname, 'generated'); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'fixture.cpp'), generated, 'utf8');
  const manifest = { schemaVersion: 1, fixtureOnly: true, executed: false, acceptedInputs: accepted,
    componentSha256: accepted.find(item => item.path.endsWith('/component.cpp')).sha256,
    fragments: fragments.map(({ text, ...entry }) => entry),
    generated: { path: 'native/foobar-spectrum/pipe-fixture/generated/fixture.cpp', bytes: Buffer.byteLength(generated), sha256: sha(Buffer.from(generated)) } };
  fs.writeFileSync(path.join(output, 'extraction-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
module.exports = { ROOT, sha, pins, assertAcceptedInputs, extractFragments, generate };
if (require.main === module) {
  assert.deepEqual(process.argv.slice(2), ['--generate']);
  const manifest = generate();
  process.stdout.write(JSON.stringify({ fixtureOnly: true, generated: manifest.generated, fragments: manifest.fragments.length, executed: false }) + '\n');
}
