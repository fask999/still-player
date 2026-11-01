'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseOutputReleaseEvidence: parse, normalizeHresult, describeHresult} = require('../src/main/output-release-evidence');
const endpoint = '{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}';
const boundary = {expectedEndpoint: endpoint, processExited: true, exitCode: 0};
const ZERO = '0x00000000', BUSY = '0x8889000A', UNKNOWN = '0x887C001A';
const nativeStages = ['GetDevice', 'Activate', 'GetMixFormat', 'Initialize'];
const v2 = (hresult = ZERO) => ({schemaVersion: 2, endpoint, operation: 'Initialize', mode: 'shared',
  stage: 'Initialize', failureStage: hresult === ZERO ? null : 'Initialize', hresult, hresultSource: 'native-return',
  nativeResults: nativeStages.map(stage => ({stage, hresult: stage === 'Initialize' ? hresult : ZERO})),
  clientActivated: true, initializeCalled: true, initialized: hresult === ZERO, startCalled: false,
  cleanupComplete: true, released: true, cleanupFailures: [], formatKind: 'Windows shared mix format',
  mixRate: 48000, mixBits: 32, mixChannels: 2, threadApartment: 'STA'});
const legacy = (hresult = ZERO) => ({endpoint, operation: 'Initialize', mode: 'shared', hresult, initialized: hresult === ZERO});

test('normalizes HRESULT representation without mistaking invalid inputs for S_OK', () => {
  for (const value of [UNKNOWN, UNKNOWN.toLowerCase(), 0x887C001A, -2005139430, '-2005139430', '2289827866']) assert.equal(normalizeHresult(value), UNKNOWN);
  for (const value of [undefined, null, NaN, Infinity, 1.1, 0x100000000, -0x80000001, '', 'garbage', {}, true, '0x100000000']) assert.equal(normalizeHresult(value), null);
  assert.equal(normalizeHresult(0), ZERO);
  assert.deepEqual(describeHresult(UNKNOWN), {hresult: UNKNOWN, facility: 2172, facilityName: 'FACILITY_DIRECT3D11', statusCode: 26, symbolName: null});
  assert.equal(describeHresult(BUSY).symbolName, 'AUDCLNT_E_DEVICE_IN_USE');
});

test('schema 2 release requires same endpoint, exact native sequence and cleanup after child exit', () => {
  const result = parse(v2(), boundary);
  assert.equal(result.classification, 'released');
  assert.equal(result.trustedEndpoint, true);
  assert.equal(result.evidence.released, true);
  assert.equal(result.evidence.probeChildExited, true);
  assert.match(result.evidence.exitMeaning, /no source-owner exit/);
  assert.equal(parse(JSON.stringify(v2()), {...boundary, expectedEndpoint: endpoint.toLowerCase()}).classification, 'released');
});

test('exact native Initialize device-in-use is busy, independently of an untrusted boolean', () => {
  for (const deviceInUse of [true, false, undefined]) {
    const result = parse({...v2(BUSY), deviceInUse}, boundary);
    assert.equal(result.classification, 'busy'); assert.equal(result.evidence.released, false);
  }
  const actual = parse({...v2(UNKNOWN), deviceInUse: true}, boundary);
  assert.equal(actual.classification, 'unknown'); assert.equal(actual.trustedEndpoint, true);
  assert.equal(actual.evidence.hresult, UNKNOWN); assert.equal(actual.evidence.symbolName, null);
  assert.equal(actual.evidence.released, false);
});

test('every pre-Initialize native call and managed stage remains unknown, with primary evidence intact', () => {
  for (const [index, stage] of nativeStages.entries()) {
    const result = v2(UNKNOWN); result.stage = stage; result.failureStage = stage;
    result.initializeCalled = stage === 'Initialize'; result.clientActivated = index > 1;
    result.nativeResults = nativeStages.slice(0, index + 1).map(name => ({stage: name, hresult: name === stage ? UNKNOWN : ZERO}));
    const measured = parse(result, boundary);
    assert.equal(measured.classification, 'unknown', stage); assert.equal(measured.evidence.failureStage, stage);
    assert.equal(measured.evidence.hresult, UNKNOWN); assert.equal(measured.evidence.hresultSource, 'native-return');
    assert.equal(measured.trustedEndpoint, true);
    if (stage !== 'Initialize') assert.equal(parse({...result, hresult: BUSY, deviceInUse: true}, boundary).classification, 'unknown');
  }
  for (const stage of ['CreateDeviceEnumerator', 'GetDevice', 'Activate', 'CastAudioClient', 'GetMixFormat', 'ReadMixFormat', 'Initialize']) {
    const result = parse({...v2(BUSY), stage, failureStage: stage, hresultSource: 'managed-exception', error: 'fixture exception'}, boundary);
    assert.equal(result.classification, 'unknown', stage); assert.equal(result.evidence.failureStage, stage);
    assert.equal(result.evidence.hresultSource, 'managed-exception');
  }
});

test('missing cleanup, failed cleanup and interrupted or failed process exit cannot release or retry', () => {
  const patches = [{cleanupComplete: false}, {released: false}, {cleanupFailures: [{resource: 'AudioClient', hresult: '0x80004005', error: 'cleanup fixture'}]},
    {cleanupFailures: null}, {startCalled: true}, {initializeCalled: false}, {clientActivated: false}, {stage: 'Activate'},
    {nativeResults: []}, {nativeResults: [...v2().nativeResults].reverse()}, {formatKind: 'fallback'}, {mixRate: null}, {mixBits: 0}, {mixChannels: 0},
    {schemaVersion: 3}, {error: 'fixture'}, {hresultSource: 'managed-exception'}];
  for (const patch of patches) for (const hr of [ZERO, BUSY]) assert.equal(parse({...v2(hr), ...patch}, boundary).classification, 'unknown', JSON.stringify(patch));
  for (const patch of [{processExited: false}, {exitCode: 1}, {exitCode: null}, {aborted: true}, {timedOut: true}]) {
    for (const hr of [ZERO, BUSY]) assert.equal(parse(v2(hr), {...boundary, ...patch}).classification, 'unknown', JSON.stringify(patch));
  }
  const measured = parse({...v2(UNKNOWN), cleanupFailures: [{resource: 'Device', hresult: '0x80004005', error: 'cleanup fixture'}]}, boundary);
  assert.equal(measured.evidence.hresult, UNKNOWN);
  assert.equal(measured.evidence.cleanupFailures[0].hresult, '0x80004005');
});

test('legacy known source shape preserves the original S_OK/process-exit gate and unknown HRESULT', () => {
  assert.equal(parse(legacy(), boundary).classification, 'released');
  assert.equal(parse(legacy(), {...boundary, processExited: false}).classification, 'unknown');
  assert.equal(parse(legacy(BUSY), boundary).classification, 'busy');
  const result = parse({...legacy(UNKNOWN), deviceInUse: true}, boundary);
  assert.equal(result.classification, 'unknown'); assert.equal(result.trustedEndpoint, true);
  assert.equal(result.evidence.hresult, UNKNOWN); assert.equal(result.evidence.legacyInference, true);
  assert.equal(result.evidence.cleanupComplete, false); assert.equal(result.evidence.released, false);
  for (const patch of [{stage: 'GetDevice'}, {hresultSource: 'managed-exception'}, {error: 'native exception'}, {initializeCalled: false}, {startCalled: true}, {released: false}]) {
    assert.equal(parse({...legacy(BUSY), ...patch}, boundary).classification, 'unknown', JSON.stringify(patch));
  }
});

test('malformed, wrong endpoint or wrong mode results never have a trusted endpoint', () => {
  const other = '{0.0.0.00000000}.{11111111-2222-3333-4444-555555555555}';
  for (const result of [null, [], '', '{broken', 'x'.repeat(65537), {...v2(), endpoint: other}, {...v2(), operation: 'GetMixFormat'}, {...v2(), mode: 'exclusive-check'}]) {
    const actual = parse(result, boundary); assert.equal(actual.classification, 'unknown'); assert.equal(actual.trustedEndpoint, false);
  }
  assert.equal(parse(v2(), {...boundary, expectedEndpoint: null}).trustedEndpoint, false);
});

test('bounded evidence strips unexpected fields and preserves a JSON serializable shape', () => {
  const result = parse({...v2(UNKNOWN), unexpected: {secret: 'discard'}, error: 'e'.repeat(1000),
    cleanupFailures: Array.from({length: 40}, () => ({resource: 'r'.repeat(100), error: 'e'.repeat(1000), hresult: UNKNOWN}))}, boundary);
  assert.equal(result.evidence.error.length, 300); assert.equal(result.evidence.cleanupFailures.length, 12);
  assert.equal(result.evidence.unexpected, undefined); assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)));
});
