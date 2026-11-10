'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const {createHandlers, invokeSafely, createDacCurrentReaders, createDacWindowConfirmation, verifyAppleOutputRelease} = require('../src/main/main');
const {SMOKE_READ_CHANNELS} = require('../src/main/smoke');
const {createFoobarService} = require('../src/main/foobar');
const {createFakeBeefwebHttp} = require('./helpers/fake-beefweb-http');
const {createSyntheticOwnedBackend} = require('./helpers/synthetic-owned-backend');

const GUID = '016F9F0C-AFE4-4072-9018-CCEBB576B4CB';
const deviceId = `0DD9B977-765B-4804-BF2D-B28EBF0C510D:${GUID}`;
const output = Object.freeze({typeId: 'output', deviceId, endpoint: `{0.0.0.00000000}.{${GUID}}`});
const request = {scope: 'hardware-instance', capabilities: ['exclusive-check'], validationFormat: {sampleRate: 48000, bits: 24, channels: 2}};

test('DAC IPC accepts only bounded fields and trusted caller arguments supplied outside the payload', async () => {
  const calls = [], caller = {sender: {}, windowGeneration: 4}; let readOnly = false;
  const service = Object.fromEntries(['prepare', 'confirm', 'list', 'revoke'].map(method => [method, (...args) => {calls.push([method, ...args]); return {synthetic: true};}]));
  const h = createHandlers({foobar: {}, dacAuthorization: service, getRuntimeState: () => ({readOnly})});
  assert.equal((await invokeSafely(h['dac:prepare'], request, caller)).ok, true);
  assert.deepEqual(calls[0], ['prepare', request, caller]);
  const endpointRequest = {...request, scope: 'windows-endpoint'};
  assert.equal((await invokeSafely(h['dac:prepare'], endpointRequest, caller)).ok, true);
  assert.deepEqual(calls[1], ['prepare', endpointRequest, caller]);
  for (const [channel, payload] of [
    ['dac:prepare', {...request, sender: {}}], ['dac:prepare', {...request, endpointId: output.endpoint}],
    ['dac:prepare', {capabilities: request.capabilities, validationFormat: request.validationFormat}],
    ['dac:prepare', {...request, scope: 'all-outputs'}], ['dac:prepare', {...request, scope: {scope: 'windows-endpoint'}}],
    ['dac:prepare', {...request, validationFormat: {...request.validationFormat, sampleRate: 96000}}],
    ['dac:prepare', {...request, capabilities: ['exclusive-check', 'exclusive-check']}],
    ['dac:confirm', {token: 'a'.repeat(43), windowGeneration: 4}], ['dac:confirm', {token: 'a'.repeat(43), scope: 'windows-endpoint'}],
    ['dac:confirm', {token: 'short'}], ['dac:confirm', {token: 'a'.repeat(43) + '\n'}],
    ['dac:revoke', {authorizationId: 'not-a-uuid'}], ['dac:revoke', {authorizationId: '11111111-1111-4111-8111-111111111111\n'}], ['dac:list', {includeIdentity: true}]
  ]) assert.equal((await invokeSafely(h[channel], payload, caller)).ok, false);
  let accessed = false;
  const accessor = Object.defineProperty({}, 'token', {enumerable: true, get() {accessed = true; return 'a'.repeat(43);}});
  assert.equal((await invokeSafely(h['dac:confirm'], accessor, caller)).ok, false); assert.equal(accessed, false);
  const scopeAccessor = Object.defineProperty({...request}, 'scope', {enumerable: true, get() {accessed = true; return 'windows-endpoint';}});
  assert.equal((await invokeSafely(h['dac:prepare'], scopeAccessor, caller)).ok, false); assert.equal(accessed, false);
  assert.equal(calls.length, 2);
  readOnly = true;
  assert.equal((await invokeSafely(h['dac:list'], {})).ok, true);
  assert.equal((await invokeSafely(h['dac:prepare'], request, caller)).ok, false);
  assert.equal((await invokeSafely(h['dac:confirm'], {token: 'a'.repeat(43)}, caller)).ok, false);
  assert.equal((await invokeSafely(h['dac:revoke'], {authorizationId: '11111111-1111-4111-8111-111111111111'}, caller)).ok, false);
  assert.equal(SMOKE_READ_CHANNELS.has('dac:list'), true);
  assert.equal(['dac:prepare', 'dac:confirm', 'dac:revoke'].some(channel => SMOKE_READ_CHANNELS.has(channel)), false);
  h.closePlaybackContext();
});

test('preload admits four DAC commands and has no renderer identity or probe execution channel', async () => {
  let bridge; const calls = [];
  const source = await fs.readFile(path.join(__dirname, '../src/main/preload.js'), 'utf8');
  vm.runInNewContext(source, {require() {return {contextBridge: {exposeInMainWorld(_name, value) {bridge = value;}},
    ipcRenderer: {async invoke(channel) {calls.push(channel); return {ok: true, value: null};}}};}});
  for (const channel of ['dac:list', 'dac:prepare', 'dac:confirm', 'dac:revoke']) await bridge.invoke(channel, {});
  for (const channel of ['dac:identify', 'dac:exclusive-check', 'dac:issueUsePermit', 'dac:deviceIdentity']) await assert.rejects(bridge.invoke(channel, {}));
  assert.deepEqual(calls, ['dac:list', 'dac:prepare', 'dac:confirm', 'dac:revoke']);
});

test('main DAC readers combine current owner, fresh output, generation and reviewed version', async () => {
  const session = {}, original = {session, selectionEpoch: 3, output}, versionScope = {backendId: 'synthetic'}, controller = new AbortController();
  let state = original, owned = true, generation = 6, active = true, fresh = async () => state, reads = 0;
  const readers = createDacCurrentReaders({rawFoobar: {getDacAuthorizationState: () => state,
    readDacAuthorizationState: async ({signal}) => {reads++; assert.equal(signal, controller.signal); return fresh();}},
  backend: {getInfo: () => ({owned, available: true}), getSession: () => session, getDacVersionScope: token => token === session ? versionScope : null},
  coordinator: {currentGeneration: () => generation}, isActive: () => active});
  assert.deepEqual(await readers.readCurrent({signal: controller.signal}), {...original, generation, versionScope});
  fresh = async () => {generation++; return original;};
  assert.equal(await readers.readCurrent({signal: controller.signal}), null);
  owned = false; assert.equal(await readers.readCurrent({signal: controller.signal}), null); assert.equal(reads, 2);
  owned = true; state = {...original, session: {}}; assert.equal(readers.getCurrent(), null);
  state = original; active = false; assert.equal(readers.getCurrent(), null);
});

test('the main confirmation binds the real window and cancels stale acceptance after navigation', async () => {
  const sender = {}, window = {webContents: sender, isDestroyed: () => false}, gate = Promise.withResolvers();
  let generation = 2, calls = 0, shown, result = Promise.resolve({response: 1});
  const controller = new AbortController();
  const confirm = createDacWindowConfirmation({getWindow: () => window, getGeneration: () => generation, getSignal: () => controller.signal,
    isActive: () => true, dialog: {showMessageBox(owner, options) {assert.equal(owner, window); calls++; shown = options; return result;}}});
  assert.equal(await confirm(request, {sender: {}, windowGeneration: generation}), false); assert.equal(calls, 0);
  assert.equal(await confirm(request, {sender, windowGeneration: generation}), true);
  assert.equal(shown.defaultId, 0); assert.equal(shown.cancelId, 0); assert.equal(shown.signal, controller.signal);
  assert.match(shown.title, /硬件实例授权/); assert.match(shown.detail, /经核验的 USB 硬件实例和当前 Windows 音频端点/);
  assert.match(shown.detail, /换接口、端点 GUID 变化或设备重新枚举后/);
  assert.doesNotMatch(JSON.stringify(shown), /endpoint|deviceId|sessionId/);
  assert.equal(await confirm({...request, scope: 'windows-endpoint'}, {sender, windowGeneration: generation}), true);
  assert.match(shown.title, /Windows 端点授权/); assert.match(shown.detail, /稳定唯一标识/);
  assert.match(shown.detail, /只绑定这台电脑上当前的 Windows 音频端点/);
  assert.match(shown.detail, /Windows 无法区分替换后的物理设备/);
  assert.match(shown.detail, /换接口、端点 GUID 变化或设备重新枚举后/);
  assert.equal(await confirm({...request, scope: 'unrecognized'}, {sender, windowGeneration: generation}), false); assert.equal(calls, 2);
  result = gate.promise; const stale = confirm(request, {sender, windowGeneration: generation});
  generation++; controller.abort(); gate.resolve({response: 1}); assert.equal(await stale, false);
});

test('Apple fallback uses the same original operation and current owned device and refuses a retired late positive', async () => {
  const session = {}, state = {session, selectionEpoch: 1, output}, controller = new AbortController();
  let active = true, current = state, owned = true, reads = 0, probes = 0, gate;
  const context = {signal: controller.signal, check() {assert.equal(controller.signal.aborted, false);}};
  const rawFoobar = {getDacAuthorizationState: () => current, async readDacAuthorizationState({signal}) {reads++; assert.equal(signal, controller.signal); return current;}};
  const backend = {getInfo: () => ({owned, available: true}), getSession: () => session,
    async waitForExclusiveAccess(args) {
      assert.equal(args.session, session); assert.equal(args.output, output); assert.equal(args.context, context); assert.equal(args.signal, controller.signal);
      args.check(); probes++; if (gate) await gate.promise; return {released: true, evidence: {synthetic: true}};
    }};
  const run = () => verifyAppleOutputRelease({rawFoobar, backend, isActive: () => active}, {context, signal: controller.signal, check: context.check});
  assert.equal((await run()).released, true);
  owned = false; await assert.rejects(run(), {code: 'STILL_DAC_CONTEXT_CHANGED'}); assert.equal(reads, 1); assert.equal(probes, 1);
  owned = true; active = false; await assert.rejects(run(), {code: 'STILL_DAC_CONTEXT_CHANGED'}); assert.equal(probes, 1);
  active = true; gate = Promise.withResolvers(); const pending = run(), rejected = assert.rejects(pending, {code: 'STILL_DAC_CONTEXT_CHANGED'});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(probes, 2);
  current = null; gate.resolve(); await rejected;
});

test('private Apple fallback can retain the fixed policy output and carries no dynamic session authority', async () => {
  const controller = new AbortController(), context = {signal: controller.signal}; let probes = 0;
  const result = await verifyAppleOutputRelease({rawFoobar: {getDacAuthorizationState() {assert.fail('private fixed-policy path requested a live DAC grant');}},
    isActive: () => true, readFixedOutput: async () => output, backend: {async waitForExclusiveAccess(args) {
      assert.equal(args.output, output); assert.equal(args.context, context); assert.equal(args.signal, controller.signal);
      assert.equal(Object.hasOwn(args, 'session'), false); args.check(); probes++; return {released: true};
    }}}, {context, signal: controller.signal});
  assert.equal(result.released, true); assert.equal(probes, 1);
});

test('raw DAC authority is a fresh read of the same bound active stock output and changes revoke the epoch', async t => {
  const owner = await createSyntheticOwnedBackend(t);
  const outputs = {active: {typeId: 'output', deviceId}, types: [{id: 'output', name: 'WASAPI', devices: [{id: deviceId, name: 'Synthetic USB'}]}]};
  let invalidated = 0, outputProbes = 0;
  const http = createFakeBeefwebHttp(({route, send}) => {
    if (route === 'query') return send({player: {info: {name: 'foobar2000', pluginVersion: '0.10'}, playbackState: 'stopped'}, outputs});
    if (route === 'outputs') return send({outputs});
    return send(null, 404);
  }, {baseUrl: owner.info.baseUrl});
  const service = createFoobarService({foobarDir: owner.backendDir, dataDir: owner.root, baseUrl: http.baseUrl, fetch: http.fetch,
    persistOutputSelection: false, pollIntervalMs: 0, onDacAuthorizationInvalidated() {invalidated++;},
    probeOutputState: async ({endpointId}) => {outputProbes++; return {endpoint: endpointId, operation: 'GetState', mode: 'state', clientActivated: false,
      initializeCalled: false, startCalled: false, actualDacRate: null, deviceFound: true, state: 1, active: true, hresult: '0x00000000'};}});
  t.after(async () => {await service.close(); await http.drain();});
  assert.equal(service.getDacAuthorizationState(), null);
  service.bindBackendSession(owner.session); await service.getState();
  const current = service.getDacAuthorizationState(), before = invalidated, probeCount = outputProbes;
  assert.equal(current.session, owner.session); assert.deepEqual(current.output, output);
  assert.deepEqual(await service.readDacAuthorizationState({}), current); assert.equal(outputProbes, probeCount);
  outputs.types[0].devices[0].name = 'External ASIO';
  assert.equal(await service.readDacAuthorizationState({}), null); assert.equal(service.getDacAuthorizationState(), null);
  assert.ok(invalidated > before); assert.deepEqual(http.calls.filter(call => call.method !== 'GET'), []);
  assert.equal(http.calls.filter(call => call.route === 'outputs').length, 2);
});
