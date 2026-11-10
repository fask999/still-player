'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {createOutputConnection} = require('../src/main/foobar-output-connection');
const endpoint = '{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}';
const other = '{0.0.0.00000000}.{11111111-2222-3333-4444-555555555555}';
const ZERO = '0x00000000', NOT_FOUND = '0x80070490';
const state = (value = 1) => ({schemaVersion: 3, endpoint, observedEndpoint: endpoint, endpointState: value,
  operation: 'GetState', mode: 'state', stage: 'GetState', failureStage: null, hresult: ZERO, hresultSource: 'native-return',
  nativeResults: ['GetDevice', 'GetId', 'GetState'].map(stage => ({stage, hresult: ZERO})),
  deviceFound: true, deviceNotFound: false, state: value, active: value === 1,
  clientActivated: false, initializeCalled: false, initialized: false, startCalled: false,
  cleanupComplete: true, released: true, cleanupFailures: [], actualDacRate: null});
const missing = () => ({...state(), observedEndpoint: null, endpointState: null, stage: 'GetDevice', failureStage: 'GetDevice',
  hresult: NOT_FOUND, nativeResults: [{stage: 'GetDevice', hresult: NOT_FOUND}],
  deviceFound: false, deviceNotFound: true, state: null, active: false});
function fixture() {
  let result = state();
  const output = {typeId: 'output', deviceId: 'exact-selected-output'};
  const calls = [];
  const connection = createOutputConnection({getSelected: () => output, getOutputs: () => ({active: output}),
    endpointForOutput: () => endpoint, isClosed: () => false, ttlMs: 0,
    probeOutputState: async args => {calls.push(args); return result;}});
  return {connection, calls, set: value => {result = value;}};
}

test('an expired endpoint tells the user to reselect while observation never activates audio', async () => {
  const f = fixture(); f.set(missing());
  const result = await f.connection.refresh();
  assert.equal(result.status, 'disconnected'); assert.equal(result.requiresReselection, true);
  assert.equal(result.reason, 'endpoint-not-found'); assert.equal(result.retryRequired, true);
  assert.match(result.message, /0x80070490.*输出设置.*重新选择/);
  assert.equal(result.evidence.result.initializeCalled, false); assert.equal(result.evidence.result.startCalled, false);
  assert.equal(result.actualDacRate, null); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].endpointId, endpoint); f.connection.close();
});

test('unplugged, not present, disabled and reconnect messages retain explicit retry without changing selection', async () => {
  const f = fixture();
  for (const [value, reason] of [[8, 'device-unplugged'], [4, 'device-not-present'], [2, 'device-disabled']]) {
    f.set(state(value)); const result = await f.connection.refresh();
    assert.equal(result.status, 'disconnected'); assert.equal(result.reason, reason);
    assert.equal(result.retryRequired, true); assert.equal(result.requiresReselection, false);
  }
  f.set(state()); const reconnected = await f.connection.refresh();
  assert.equal(reconnected.status, 'connected'); assert.equal(reconnected.retryRequired, true);
  assert.match(reconnected.message, /重新连接.*重试/);
  assert.equal(reconnected.output.deviceId, 'exact-selected-output');
  assert.equal(f.connection.confirmRetry().retryRequired, false); f.connection.close();
});

test('wrong identity, malformed native result, contradictory state or failed cleanup stays unknown', async () => {
  const f = fixture();
  for (const patch of [{endpoint: other}, {observedEndpoint: other}, {endpointState: 4}, {state: 3}, {state: 0},
    {nativeResults: []}, {nativeResults: [...state().nativeResults].reverse()}, {hresultSource: 'managed-exception'},
    ...[undefined, null, 'wrong', 0, true].map(deviceNotFound => ({deviceNotFound})),
    {initializeCalled: true}, {clientActivated: true}, {startCalled: true},
    {cleanupComplete: false}, {released: false}, {cleanupFailures: [{}]}, {initialized: true}, {actualDacRate: 48000}]) {
    f.set({...state(), ...patch}); assert.equal((await f.connection.refresh()).status, 'unknown', JSON.stringify(patch));
  }
  for (const patch of [{active: true}, {observedEndpoint: endpoint}, {endpointState: 4}, {stage: 'GetState'}]) {
    f.set({...missing(), ...patch}); assert.equal((await f.connection.refresh()).status, 'unknown', JSON.stringify(patch));
  }
  f.connection.close();
});
