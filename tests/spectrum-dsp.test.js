'use strict';
// The reference tests below validate the documented mathematics and synthetic
// fixtures ONLY. They do not execute, translate, emulate or certify dsp.hpp.
// Only the separately labelled native test compiles and executes production C++.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const N = 4096;
const PI = Math.PI;
const SOURCE = path.resolve(__dirname, '../native/foobar-spectrum/dsp-tests.cpp');
const EVIDENCE = path.resolve(__dirname, '../review-evidence/spectrum-20261101/dsp');

function near(actual, expected, tolerance, label) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} versus ${expected}, tolerance ${tolerance}`);
}

function hann(n) { return Math.sin(PI * n / N) ** 2; }
function windowEnergy() {
  let sum = 0;
  for (let n = 0; n < N; n++) sum += hann(n) ** 2;
  return sum;
}

// Deliberately slow direct DFT at a handful of analytically known occupied
// bins, not an FFT and not the production logarithmic-band implementation.
function directDft(signal, bin) {
  let real = 0;
  let imaginary = 0;
  for (let n = 0; n < N; n++) {
    const value = signal(n) * hann(n);
    const phase = 2 * PI * bin * n / N;
    real += value * Math.cos(phase);
    imaginary -= value * Math.sin(phase);
  }
  return real ** 2 + imaginary ** 2;
}

function density(signal, bin, sampleRate) {
  return directDft(signal, bin) * (bin === 0 || bin === N / 2 ? 1 : 2) /
    (sampleRate * windowEnergy());
}

function occupiedPower(signal, bins, sampleRate = 48000) {
  return bins.reduce((sum, bin) => sum + density(signal, bin, sampleRate) * sampleRate / N, 0);
}

function sine(bin, amplitude = 1) { return n => amplitude * Math.sin(2 * PI * bin * n / N); }
const rmsDbfs = power => power === 0 ? -100 : Math.max(-100, 10 * Math.log10(power));

test('independent mathematical reference ONLY: periodic Hann energy is 3N/8', () => {
  near(windowEnergy(), 3 * N / 8, 1e-9, 'window energy');
  near(hann(0), 0, 0, 'first sample');
  assert.ok(hann(N - 1) > 0, 'periodic Hann differs from symmetric endpoint Hann');
});

test('independent direct-DFT reference ONLY: PSD integration calibrates FS and half sine RMS', () => {
  const bins = [127, 128, 129];
  for (const sampleRate of [8000, 48000, 768000]) {
    const full = occupiedPower(sine(128), bins, sampleRate);
    const half = occupiedPower(sine(128, 0.5), bins, sampleRate);
    near(full, 0.5, 1e-11, 'full-scale sine mean square');
    near(half, 0.125, 1e-11, 'half-amplitude sine mean square');
    near(rmsDbfs(full), -3.010299956639812, 1e-9, 'FS sine dBFS');
    near(rmsDbfs(half), -9.030899869919436, 1e-9, 'half sine dBFS');
  }
  // Hann's three occupied DFT bins carry 1/12, 1/3, 1/12 of a FS sine's
  // integrated mean square. A lone peak-bin reading is not the RMS reference.
  near(density(sine(128), 127, 48000) * 48000 / N, 1 / 12, 1e-11, 'lower side lobe');
  near(density(sine(128), 128, 48000) * 48000 / N, 1 / 3, 1e-11, 'central bin');
});

test('independent direct-DFT reference ONLY: opposite channels survive power averaging', () => {
  const bins = [127, 128, 129];
  const left = occupiedPower(sine(128), bins);
  const opposite = occupiedPower(sine(128, -1), bins);
  const silent = occupiedPower(() => 0, bins);
  near((left + opposite) / 2, 0.5, 1e-11, 'opposite-phase channel power average');
  near((left + silent) / 2, 0.25, 1e-11, 'single active stereo channel');
  near(rmsDbfs((left + silent) / 2) - rmsDbfs(left), -3.010299956639812, 1e-9,
    'silent channel difference');
  near(rmsDbfs(silent), -100, 0, 'silence floor definition');
});

test('independent direct-DFT reference ONLY: calibration lobe and split-band fixture expectations', () => {
  const bandForBin = bin => Math.floor(48 * Math.log((bin * 48000 / N) / 20) / Math.log(1000));
  assert.deepEqual([99, 100, 101].map(bandForBin), [28, 28, 28],
    '1171.875 Hz calibration tone must fit its entire Hann lobe in one band');
  assert.deepEqual([127, 128, 129].map(bandForBin), [29, 30, 30],
    '1500 Hz original fixture straddles a band edge');
  near(20 * Math.exp(Math.log(1000) * 30 / 48), 1499.7884186649114, 1e-9, 'split edge');
  near(occupiedPower(sine(100), [99, 100, 101]), 0.5, 1e-11, 'single-band calibration power');
  near(occupiedPower(sine(128), [127]), 1 / 12, 1e-11, 'lower-band split power');
  near(occupiedPower(sine(128), [128, 129]), 5 / 12, 1e-11, 'main-band split power');
  near(rmsDbfs(5 / 12), -3.80211241711606, 1e-9, 'correct split-band peak dBFS');
});

test('independent direct-DFT reference ONLY: DC and Nyquist are not doubled', () => {
  const dc = () => 1;
  const nyquist = n => n % 2 === 0 ? 1 : -1;
  near(occupiedPower(dc, [0, 1]), 1, 1e-11, 'DC plus Hann side lobe');
  near(occupiedPower(nyquist, [N / 2 - 1, N / 2]), 1, 1e-11, 'Nyquist plus Hann side lobe');
  near(occupiedPower(dc, [0]), 2 / 3, 1e-11, 'DC unpaired bin');
  near(occupiedPower(dc, [1]), 1 / 3, 1e-11, 'real Hann DC leakage');
});

test('independent mathematical reference ONLY: deterministic wideband Parseval fixture', () => {
  const tones = [[20, 0.2], [128, 0.1], [511, 0.3], [1500, 0.05]];
  const signal = n => tones.reduce((sum, [bin, amplitude]) => sum + sine(bin, amplitude)(n), 0);
  const bins = tones.flatMap(([bin]) => [bin - 1, bin, bin + 1]);
  let weightedTimePower = 0;
  for (let n = 0; n < N; n++) weightedTimePower += signal(n) ** 2 * hann(n) ** 2;
  weightedTimePower /= windowEnergy();
  const analyticPower = tones.reduce((sum, [, amplitude]) => sum + amplitude ** 2 / 2, 0);
  near(weightedTimePower, analyticPower, 1e-11, 'time-domain window-energy reference');
  near(occupiedPower(signal, bins, 32000), analyticPower, 1e-11, 'direct-DFT occupied power');
});

test('source/API availability ONLY: native fixtures are separate from the JS reference', () => {
  const header = fs.readFileSync(path.join(path.dirname(SOURCE), 'dsp.hpp'), 'utf8');
  const nativeTests = fs.readFileSync(SOURCE, 'utf8');
  for (const required of ['namespace still_spectrum', 'struct FrameAnalysis', 'struct Band',
    'kFftSize = 4096', 'kFloorDbfs = -100.0', 'analyze_interleaved', 'std::span<const Sample>']) {
    assert.ok(header.includes(required), `missing source/API contract: ${required}`);
  }
  assert.ok(nativeTests.includes('#include "dsp.hpp"'));
  assert.ok(nativeTests.includes('int main()'));
  assert.doesNotMatch(header, /#include\s*[<"](?:windows\.h|foobar2000|random)/i);
});

test('NATIVE production C++ DSP fixtures (requires installed C++20 compiler)', { timeout: 120000 }, t => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const candidates = process.platform === 'win32' ? ['cl', 'clang++', 'g++'] : ['c++', 'clang++', 'g++'];
  const probes = [];
  let compiler;
  for (const command of candidates) {
    const result = spawnSync(command, [command === 'cl' ? '/Bv' : '--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000
    });
    probes.push({ command, status: result.status, error: result.error?.code || null,
      stdout: result.stdout || '', stderr: result.stderr || '' });
    if (!result.error) { compiler = command; break; }
  }
  const sourceFiles = [SOURCE, path.join(path.dirname(SOURCE), 'dsp.hpp'), __filename];
  const record = { kind: 'native-cpp-dsp', timestamp: new Date().toISOString(), probes,
    mathReferenceIsNotNativeExecution: true, nativeExecuted: false,
    sourceHashes: sourceFiles.map(filename => ({ path: filename,
      sha256: createHash('sha256').update(fs.readFileSync(filename)).digest('hex') })) };
  const save = () => fs.writeFileSync(path.join(EVIDENCE, 'native-test-status.json'),
    JSON.stringify(record, null, 2) + '\n');
  if (!compiler) {
    record.status = 'unavailable';
    record.reason = 'No installed C++20 compiler in PATH; no compiler was downloaded or installed.';
    save();
    t.skip('UNAVAILABLE: native C++ compiler absent; JS math/reference checks do not certify dsp.hpp');
    return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'still-dsp-native-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const executable = path.join(temporary, process.platform === 'win32' ? 'dsp-tests.exe' : 'dsp-tests');
  const args = compiler === 'cl'
    ? ['/nologo', '/std:c++20', '/EHsc', '/W4', '/permissive-', `/Fo${path.join(temporary, 'dsp-tests.obj')}`,
      `/Fe${executable}`, SOURCE]
    : ['-std=c++20', '-O2', '-Wall', '-Wextra', '-Wpedantic', '-Werror', SOURCE, '-o', executable];
  const build = spawnSync(compiler, args, { cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  record.compiler = compiler;
  record.build = { args, status: build.status, error: build.error?.message || null,
    stdout: build.stdout || '', stderr: build.stderr || '' };
  if (build.error || build.status !== 0) {
    record.status = 'build-failed';
    save();
    assert.fail(`Native C++ build failed; see ${path.join(EVIDENCE, 'native-test-status.json')}`);
  }
  const run = spawnSync(executable, [], { cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  record.nativeExecuted = !run.error;
  record.run = { status: run.status, error: run.error?.message || null,
    stdout: run.stdout || '', stderr: run.stderr || '' };
  record.status = !run.error && run.status === 0 ? 'passed' : 'run-failed';
  save();
  assert.equal(run.error, undefined, `native fixture process failed: ${run.error?.message}`);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Native C\+\+ synthetic DSP fixtures: \d+ passed, 0 failed/);
});
