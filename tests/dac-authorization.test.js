'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, createCipheriv, createDecipheriv, randomBytes} = require('node:crypto');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');
const {createDacAuthorizationService} = require('../src/main/dac-authorization');
const {createDacAuthorizationStore} = require('../src/main/dac-authorization-store');
const {createDacIdentityReader, parseDacIdentityReport, isVerifiedDacIdentity, stockDacOutput, DAC_IDENTITY_PROBE_SHA256} = require('../src/main/dac-identity');
const renderer = require('../src/renderer/dac-authorization');

const guid = 'AAAABBBB-1111-2222-3333-444455556666';
const endpoint = `{0.0.0.00000000}.{${guid}}`;
const output = {typeId: 'output', deviceId: `0DD9B977-765B-4804-BF2D-B28EBF0C510D:${guid}`, name: 'PRIVATE_DEVICE_NAME'};
const versionScope = {backendId: 'synthetic-backend', coreSha256: 'a'.repeat(64), componentsSha256: 'b'.repeat(64),
  probeSha256: 'c'.repeat(64), providerPolicyVersion: 1};
const identityHash = 'd'.repeat(64);
const hardwareScope = 'hardware-instance', windowsScope = 'windows-endpoint';
const validationFormat = {sampleRate: 48000, bits: 24, channels: 2};
const request = {scope: hardwareScope, capabilities: ['exclusive-check', 'owned-exit-fallback'], validationFormat};
const identityReport = (overrides = {}, scope = hardwareScope) => ({schemaVersion: 2, mode: 'identity', operation: 'ReadUsbEndpointIdentity', scope,
  endpoint, observedEndpoint: endpoint.toLowerCase(), endpointGuid: guid.toLowerCase(), endpointState: 1, dataFlow: 'render',
  identitySha256: identityHash, usbUniqueInstance: scope === hardwareScope, topologyVerified: scope === windowsScope,
  arrivalVerified: scope === windowsScope, freshReadVerified: scope === windowsScope, containerMatched: true, cleanupComplete: true, clientActivated: false,
  initializeCalled: false, startCalled: false, ...overrides});
const verifiedIdentity = (overrides, pin = versionScope.probeSha256, scope = hardwareScope) =>
  parseDacIdentityReport(identityReport(overrides, scope), {endpointId: endpoint, probeSha256: pin, scope});

function fixture() {
  const brands = new WeakSet(), calls = [];
  const state = {generation: 1, selectionEpoch: 1, output: {...output}, versionScope: {...versionScope},
    wall: 1_800_000_000_000, monotonic: 1, identity: verifiedIdentity(), identityScopes: [], rows: [], confirm: async () => true, beforeWrite: async () => {}};
  function replaceSession() {
    state.session = Object.freeze({backendId: state.versionScope.backendId, executableSha256: state.versionScope.coreSha256});
    brands.add(state.session); return state.session;
  }
  replaceSession();
  const current = () => ({session: state.session, generation: state.generation, selectionEpoch: state.selectionEpoch,
    output: state.output, versionScope: state.versionScope});
  const store = {async read() {return structuredClone(state.rows);}, async write(rows, {check} = {}) {
    await state.beforeWrite(); check?.(); calls.push('write'); state.rows = structuredClone(rows);
  }};
  const create = () => createDacAuthorizationService({store, getCurrent: current,
    readCurrent: async () => {calls.push('selected'); return current();}, isVerifiedSession: session => brands.has(session),
    readIdentity: async ({endpointId, scope}) => {calls.push('identity'); state.identityScopes.push(scope); assert.equal(endpointId, endpoint); return state.identity;},
    confirmUser: async preview => {calls.push('confirm'); return state.confirm(preview);},
    clock: {now: () => state.wall, monotonicNow: () => state.monotonic}});
  const service = create(), caller = {sender: {}, windowGeneration: 1};
  const prepare = (scope = hardwareScope) => service.prepare({...request, scope}, caller);
  const grant = async scope => service.confirm({token: (await prepare(scope)).token}, caller);
  const use = (capability = 'exclusive-check') => ({session: state.session, output: state.output, context: {}, capability});
  return {service, create, state, calls, caller, prepare, grant, use, replaceSession};
}

test('authorization prompts once and projects neither private identity nor endpoint, probe or version into renderer DTOs', async () => {
  const f = fixture();
  f.state.confirm = async preview => {
    assert.deepEqual(preview.capabilities, request.capabilities);
    assert.deepEqual(preview.validationFormat, validationFormat);
    assert.equal(preview.scope, hardwareScope);
    assert.equal(Object.keys(preview).length, 4);
    return true;
  };
  const prepared = await f.prepare();
  assert.match(prepared.token, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(f.service.confirm({token: prepared.token}, {...f.caller, sender: {}}), {code: 'STILL_DAC_CONFIRMATION_EXPIRED'});
  await assert.rejects(f.service.confirm({token: prepared.token}, {...f.caller, windowGeneration: 2}), {code: 'STILL_DAC_CONFIRMATION_EXPIRED'});
  const grant = await f.service.confirm({token: prepared.token}, f.caller);
  await assert.rejects(f.service.confirm({token: prepared.token}, f.caller), {code: 'STILL_DAC_CONFIRMATION_EXPIRED'});
  assert.deepEqual(f.calls, ['selected', 'identity', 'selected', 'confirm', 'selected', 'identity', 'selected', 'write']);
  assert.equal(f.state.rows[0].identitySha256, identityHash);
  assert.equal(f.state.rows[0].scope, hardwareScope);
  const json = JSON.stringify([prepared.preview, grant, await f.service.list()]);
  for (const value of [guid, identityHash, 'PRIVATE_DEVICE_NAME', prepared.token, versionScope.backendId, versionScope.probeSha256]) {
    assert.equal(json.includes(value), false);
  }
});

test('pending user confirmation is single-use and denial consumes it without saving', async () => {
  const f = fixture(); let finish;
  f.state.confirm = () => new Promise(resolve => {finish = resolve;});
  const {token} = await f.prepare(), first = f.service.confirm({token}, f.caller);
  await assert.rejects(f.service.confirm({token}, f.caller), {code: 'STILL_DAC_CONFIRMATION_EXPIRED'});
  finish(false);
  await assert.rejects(first, {code: 'STILL_DAC_CONFIRMATION_DECLINED'});
  assert.deepEqual(f.state.rows, []); assert.equal(f.calls.filter(item => item === 'confirm').length, 1);
});

for (const changed of ['identity', 'session', 'generation', 'selectionEpoch', 'version', 'serviceEpoch']) test(`confirmation rejects changed ${changed} and never saves the captured challenge`, async () => {
  const f = fixture();
  f.state.confirm = async () => {
    if (changed === 'identity') f.state.identity = verifiedIdentity({identitySha256: 'e'.repeat(64)});
    if (changed === 'session') f.replaceSession();
    if (['generation', 'selectionEpoch'].includes(changed)) f.state[changed]++;
    if (changed === 'version') f.state.versionScope = {...f.state.versionScope, componentsSha256: 'f'.repeat(64)};
    if (changed === 'serviceEpoch') f.service.invalidate();
    return true;
  };
  await assert.rejects(f.grant(), {code: 'STILL_DAC_CONTEXT_CHANGED'});
  assert.equal(f.calls.includes('write'), false); assert.deepEqual(f.state.rows, []);
});

test('confirmation rejects elapsed monotonic time and rechecks the authorization context at persistent commit', async () => {
  const expired = fixture(), {token} = await expired.prepare(); expired.state.monotonic += 90_000;
  await assert.rejects(expired.service.confirm({token}, expired.caller), {code: 'STILL_DAC_CONFIRMATION_EXPIRED'});
  assert.equal(expired.calls.includes('confirm'), false);
  const f = fixture(); f.state.beforeWrite = async () => {f.state.selectionEpoch++;};
  await assert.rejects(f.grant(), {code: 'STILL_DAC_CONTEXT_CHANGED'});
  assert.deepEqual(f.state.rows, []);
});

test('stock output rejects default, unknown, external, malformed and unavailable outputs before probing', async () => {
  for (const selected of [{...output, typeId: 'asio'}, {...output, typeName: 'External host'}, {...output, deviceId: `UNKNOWN:${guid}`},
    {...output, deviceId: output.deviceId.replace(guid, '00000000-0000-0000-0000-000000000000')},
    {...output, deviceId: `${output.deviceId}\n`}, {...output, unavailableInList: true}]) {
    const f = fixture(); f.state.output = selected;
    await assert.rejects(f.prepare(), {code: 'STILL_DAC_OUTPUT_UNSUPPORTED'});
    assert.equal(f.calls.includes('identity'), false);
  }
  assert.equal(stockDacOutput({typeId: 'output', deviceId: output.deviceId.toLowerCase()}).endpoint, endpoint);
  for (const fields of [{...request, endpoint}, {...request, scope: undefined}, {...request, scope: 'device'}, {...request, capabilities: ['play']}, {...request, capabilities: ['exclusive-check', 'exclusive-check']},
    {...request, validationFormat: {...validationFormat, sampleRate: 44100}}, {...request, validationFormat: {...validationFormat, channels: 1}}]) {
    const f = fixture(); await assert.rejects(f.service.prepare(fields, f.caller), {code: 'STILL_DAC_INVALID_REQUEST'}); assert.deepEqual(f.calls, []);
  }
});

test('native identity evidence is closed, branded, and bound to the exact active render endpoint and probe bytes', async () => {
  const good = verifiedIdentity(); assert.equal(isVerifiedDacIdentity(good), true); assert.equal(isVerifiedDacIdentity({...good}), false);
  for (const fields of [{endpointState: 2}, {dataFlow: 'capture'}, {observedEndpoint: endpoint + '\n'}, {endpointGuid: guid + '\n'},
    {usbUniqueInstance: false}, {containerMatched: false}, {clientActivated: true}, {initializeCalled: true}, {startCalled: true},
    {cleanupComplete: false}, {identitySha256: identityHash + '\n'}, {rawInstanceId: 'PRIVATE_IDENTIFIER'}]) {
    assert.throws(() => verifiedIdentity(fields), {code: 'STILL_DAC_IDENTITY_UNVERIFIED'});
  }
  for (const result of [{...good}, verifiedIdentity({}, 'f'.repeat(64))]) {
    const f = fixture(); f.state.identity = result; await assert.rejects(f.prepare(), {code: 'STILL_DAC_IDENTITY_UNVERIFIED'});
  }
});

test('the two proof scopes have separate brands and Windows endpoint proof needs topology, arrival and a fresh matching read', () => {
  const hardware = verifiedIdentity(), windows = verifiedIdentity({}, versionScope.probeSha256, windowsScope);
  assert.equal(isVerifiedDacIdentity(hardware, hardwareScope), true);
  assert.equal(isVerifiedDacIdentity(hardware, windowsScope), false);
  assert.equal(isVerifiedDacIdentity(windows, hardwareScope), false);
  assert.equal(isVerifiedDacIdentity(windows, windowsScope), true);
  for (const field of ['topologyVerified', 'arrivalVerified', 'freshReadVerified']) {
    assert.throws(() => verifiedIdentity({[field]: false}, versionScope.probeSha256, windowsScope), {code: 'STILL_DAC_IDENTITY_UNVERIFIED'});
  }
  assert.throws(() => verifiedIdentity({scope: windowsScope, topologyVerified: true, arrivalVerified: true, freshReadVerified: true}), {code: 'STILL_DAC_IDENTITY_UNVERIFIED'});
});

test('endpoint authorization always revalidates its sealed scope and changed topology or arrival requires new consent', async () => {
  const f = fixture(); f.state.identity = verifiedIdentity({}, versionScope.probeSha256, windowsScope);
  const grant = await f.grant(windowsScope), use = f.use();
  assert.equal(grant.scope, windowsScope); assert.equal(f.state.rows[0].schemaVersion, 2);
  assert.deepEqual(f.state.identityScopes, [windowsScope, windowsScope]);
  await assert.rejects(f.service.issueUsePermit({...use, scope: hardwareScope}), {code: 'STILL_DAC_AUTHORIZATION_REQUIRED'});
  assert.deepEqual(f.state.identityScopes, [windowsScope, windowsScope]);
  const permit = await f.service.issueUsePermit(use);
  assert.equal(f.service.consumeUsePermit(permit, {...use, scope: hardwareScope}), null);
  assert.equal(f.service.consumeUsePermit(permit, use), null);
  const fresh = await f.service.issueUsePermit({...use, scope: windowsScope});
  assert.equal(f.service.consumeUsePermit(fresh, {...use, scope: windowsScope}).checkCurrent(), true);
  f.state.identity = verifiedIdentity();
  await assert.rejects(f.service.issueUsePermit(use), {code: 'STILL_DAC_IDENTITY_UNVERIFIED'});
  f.state.identity = verifiedIdentity({identitySha256: 'e'.repeat(64)}, versionScope.probeSha256, windowsScope);
  await assert.rejects(f.service.issueUsePermit(use), {code: 'STILL_DAC_AUTHORIZATION_REQUIRED'});
  assert.equal(f.state.identityScopes.every(scope => scope === windowsScope), true);
  const replacement = await f.grant(windowsScope);
  assert.notEqual(replacement.authorizationId, grant.authorizationId);
  assert.equal(f.state.rows.length, 1);
});

test('legacy sealed grants retain only the hardware scope and cannot fallback to endpoint proof', async () => {
  const f = fixture(); await f.grant();
  delete f.state.rows[0].scope; f.state.rows[0].schemaVersion = 1;
  assert.equal((await f.service.list())[0].scope, hardwareScope);
  f.state.identity = verifiedIdentity({}, versionScope.probeSha256, windowsScope);
  await assert.rejects(f.service.issueUsePermit(f.use()), {code: 'STILL_DAC_IDENTITY_UNVERIFIED'});
  assert.deepEqual(f.state.identityScopes, [hardwareScope, hardwareScope, hardwareScope]);
  const next = await f.grant(windowsScope);
  assert.equal(next.scope, windowsScope); assert.equal(f.state.rows.length, 1);
  await assert.rejects(f.service.issueUsePermit({...f.use(), scope: hardwareScope}), {code: 'STILL_DAC_AUTHORIZATION_REQUIRED'});
});

test('sealed authorization can be reused only with a newly observed exact identity and current branded session', async () => {
  const f = fixture(); await f.grant(); const old = f.use();
  f.replaceSession(); const service = f.create(), args = f.use(), live = await service.issueUsePermit(args);
  assert.equal(service.consumeUsePermit({...live}, args), null);
  assert.equal(service.consumeUsePermit(live, old), null);
  assert.equal(service.consumeUsePermit(live, args), null);
  const permit = await service.issueUsePermit(args), scope = service.consumeUsePermit(permit, args);
  assert.equal(scope.endpoint, endpoint); assert.equal(scope.ownedExitRelease, false); assert.equal(scope.checkCurrent(), true);
  assert.deepEqual(scope.exclusiveValidationFormat, validationFormat);
  assert.equal(service.consumeUsePermit(permit, args), null);
  f.state.selectionEpoch++;
  assert.equal(scope.checkCurrent(), false);
  f.state.identity = verifiedIdentity({identitySha256: 'e'.repeat(64)});
  await assert.rejects(service.issueUsePermit(f.use()), {code: 'STILL_DAC_AUTHORIZATION_REQUIRED'});
});

test('permissions are individually scoped and short-lived permits cannot outlast context, time, grant expiry or revocation', async () => {
  const f = fixture();
  const prepared = await f.service.prepare({...request, capabilities: ['owned-exit-fallback']}, f.caller);
  const grant = await f.service.confirm({token: prepared.token}, f.caller);
  await assert.rejects(f.service.issueUsePermit(f.use()), {code: 'STILL_DAC_AUTHORIZATION_REQUIRED'});
  const args = f.use('owned-exit-fallback'), stale = await f.service.issueUsePermit(args);
  f.state.monotonic += 10_000; assert.equal(f.service.consumeUsePermit(stale, args), null);
  const permit = await f.service.issueUsePermit(args), scope = f.service.consumeUsePermit(permit, args);
  assert.equal(scope.ownedExitRelease, true); assert.equal(scope.checkCurrent(), true);
  const controller = new AbortController();
  const cancelledArgs = {...args, signal: controller.signal};
  const cancelled = await f.service.issueUsePermit(cancelledArgs); controller.abort();
  assert.equal(f.service.consumeUsePermit(cancelled, cancelledArgs), null);
  f.state.wall = grant.expiresAt;
  assert.equal(scope.checkCurrent(), false);
  await assert.rejects(f.service.issueUsePermit(args), {code: 'STILL_DAC_AUTHORIZATION_REQUIRED'});
  assert.deepEqual(await f.service.revoke({authorizationId: grant.authorizationId}), {revoked: true});
  assert.deepEqual(await f.service.list(), []);
});

test('revocation invalidates outstanding scopes before its asynchronous write completes', async () => {
  const f = fixture(), grant = await f.grant(), args = f.use();
  const permit = await f.service.issueUsePermit(args), scope = f.service.consumeUsePermit(permit, args);
  let finish, entered;
  const writing = new Promise(resolve => {entered = resolve;});
  f.state.beforeWrite = () => new Promise(resolve => {finish = resolve; entered();});
  const removing = f.service.revoke({authorizationId: grant.authorizationId});
  assert.equal(scope.checkCurrent(), false);
  await assert.rejects(f.service.issueUsePermit(args), {code: 'STILL_DAC_CONTEXT_CHANGED'});
  assert.equal(f.state.rows.length, 1);
  await writing;
  finish(); assert.deepEqual(await removing, {revoked: true});
});

async function temp(t) {
  const {root, parent} = createCanonicalTemp('still-dac-test-');
  t.after(async () => {
    assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('still-dac-test-'));
    await fs.rm(root, {recursive: true, force: true});
  });
  return root;
}

function testSealer() {
  const key = randomBytes(32);
  return {
    seal(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    unseal(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
}

test('store commits only sealed bytes, preserves an earlier value after a cancelled commit and rejects tampering and hardlinks', async t => {
  const dataDir = await temp(t), store = createDacAuthorizationStore({dataDir, ...testSealer()});
  const filename = path.join(dataDir, 'dac-authorizations.sealed'), payload = [{identity: 'PRIVATE_IDENTIFIER'}];
  assert.deepEqual(await store.read(), []); await store.write(payload);
  assert.deepEqual(await store.read(), payload);
  const original = await fs.readFile(filename); assert.equal(original.includes(Buffer.from('PRIVATE_IDENTIFIER')), false);
  await assert.rejects(store.write([], {check() {throw Object.assign(new Error('changed'), {code: 'STILL_DAC_CONTEXT_CHANGED'});}}), {code: 'STILL_DAC_CONTEXT_CHANGED'});
  assert.deepEqual(await fs.readdir(dataDir), ['dac-authorizations.sealed']); assert.deepEqual(await fs.readFile(filename), original);
  const alias = path.join(dataDir, 'fixture-alias'); await fs.link(filename, alias);
  await assert.rejects(store.read(), {code: 'STILL_DAC_STORE_UNAVAILABLE'});
  await assert.rejects(store.write([]), {code: 'STILL_DAC_STORE_UNAVAILABLE'});
  assert.deepEqual(await fs.readFile(alias), original); await fs.unlink(alias);
  const damaged = Buffer.from(original); damaged[damaged.length - 1] ^= 0xff; await fs.writeFile(filename, damaged);
  await assert.rejects(store.read(), {code: 'STILL_DAC_STORE_UNAVAILABLE'});
});

test('failed sealing creates no plaintext store or temporary grant', async t => {
  const dataDir = await temp(t);
  const store = createDacAuthorizationStore({dataDir, seal() {throw new Error('PRIVATE_CIPHER_ERROR');}, unseal() {return '';}});
  await assert.rejects(store.write([{identityHash}]), error => error.code === 'STILL_DAC_STORE_UNAVAILABLE' && !error.message.includes('PRIVATE'));
  assert.deepEqual(await fs.readdir(dataDir), []);
});

test('sealed store rejects replacement by a different NTFS file whose identifier collides as a Number', async t => {
  const dataDir = path.resolve('synthetic-dac-store'), filename = path.join(dataDir, 'dac-authorizations.sealed');
  const original = 0x100000000000001n, replacement = 0x100000000000002n, bytes = Buffer.from('SYNTHETIC_SEALED');
  assert.notEqual(original, replacement); assert.equal(Number(original), Number(replacement));
  let observations = 0, decrypted = 0;
  const stat = (ino, bigint, file) => ({dev: bigint ? 17n : 17, ino: bigint ? ino : Number(ino),
    size: bigint ? BigInt(bytes.length) : bytes.length, nlink: bigint ? 1n : 1,
    isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false});
  t.mock.method(fs, 'lstat', async (name, options) => name === filename
    ? stat(++observations === 1 ? original : replacement, options?.bigint, true) : stat(1n, options?.bigint, false));
  t.mock.method(fs, 'realpath', async name => name);
  t.mock.method(fs, 'open', async () => ({stat: async options => stat(original, options?.bigint, true),
    read: async buffer => {bytes.copy(buffer); return {bytesRead: bytes.length};}, close: async () => {}}));
  const store = createDacAuthorizationStore({dataDir, seal: async () => bytes, unseal: async () => {decrypted++; return '{"schemaVersion":1,"grants":[]}';}});
  await assert.rejects(store.read(), {code: 'STILL_DAC_STORE_UNAVAILABLE'});
  assert.equal(observations, 2); assert.equal(decrypted, 0);
});

test('native identity reader uses only pinned local bytes and bounded read-only args, masking native errors', async t => {
  const root = await temp(t), probePath = path.join(root, 'synthetic-probe.exe'), bytes = Buffer.from('SYNTHETIC, NEVER EXECUTE');
  await fs.writeFile(probePath, bytes);
  const probeSha256 = createHash('sha256').update(bytes).digest('hex');
  let calls = 0, fail = false;
  const read = createDacIdentityReader({probePath, probeSha256, async execute(filename, args, options) {
    calls++; assert.equal(filename, probePath); assert.deepEqual(args, [endpoint, 'identity', hardwareScope]);
    assert.equal(options.maxBuffer, 4096); assert.equal(options.windowsHide, true);
    if (fail) throw new Error('PRIVATE_NATIVE_STDERR');
    return {stdout: JSON.stringify(identityReport())};
  }});
  const input = {endpointId: endpoint, scope: hardwareScope};
  const result = await read(input); assert.equal(isVerifiedDacIdentity(result), true); assert.equal(result.probeSha256, probeSha256);
  fail = true;
  await assert.rejects(read(input), error => error.code === 'STILL_DAC_IDENTITY_UNVERIFIED' && !error.message.includes('PRIVATE'));
  await fs.writeFile(probePath, 'changed'); await assert.rejects(read(input), {code: 'STILL_DAC_IDENTITY_UNVERIFIED'});
  assert.equal(calls, 2);
});

test('only a closed native failure enum is retained privately on a matching pinned probe failure', async t => {
  const root = await temp(t), probePath = path.join(root, 'synthetic-failure.exe'), bytes = Buffer.from('SYNTHETIC, NEVER EXECUTE');
  await fs.writeFile(probePath, bytes);
  const probeSha256 = createHash('sha256').update(bytes).digest('hex');
  let extras = {};
  const read = createDacIdentityReader({probePath, probeSha256, async execute() {
    const stdout = JSON.stringify({schemaVersion: 2, mode: 'identity', code: 'STILL_DAC_IDENTITY_UNVERIFIED', failureStage: 'Arrival', ...extras});
    throw Object.assign(new Error('PRIVATE_NATIVE_DIAGNOSTIC'), {code: 1, signal: null, stdout});
  }});
  const input = {endpointId: endpoint, scope: windowsScope};
  await assert.rejects(read(input), error => error.nativeIdentityStage === 'Arrival' && !JSON.stringify(error).includes('Arrival') && !error.message.includes('PRIVATE'));
  for (const fields of [{failureStage: 'PRIVATE_NATIVE_DIAGNOSTIC'}, {deviceId: 'PRIVATE_IDENTIFIER'}]) {
    extras = fields;
    await assert.rejects(read(input), error => error.code === 'STILL_DAC_IDENTITY_UNVERIFIED' && error.nativeIdentityStage === undefined);
  }
});

test('identity helper path reads only metadata and emits no raw device identity fields', async () => {
  const source = await fs.readFile(path.join(__dirname, '../scripts/foobar-coreaudio-probe.cs'), 'utf8');
  const binary = await fs.readFile(path.join(__dirname, '../scripts/foobar-coreaudio-probe.exe'));
  assert.equal(createHash('sha256').update(binary).digest('hex'), DAC_IDENTITY_PROBE_SHA256);
  const block = source.slice(source.indexOf('static class ReadOnlyIdentity'), source.indexOf('static Options Parse'));
  assert.match(block, /enumerator\.GetDevice\(/); assert.match(block, /device\.GetId\(/); assert.match(block, /device\.GetState\(/);
  assert.match(block, /GetDataFlow\(/); assert.match(block, /OpenPropertyStore\(0,/); assert.match(block, /CM_Get_Parent\(/);
  assert.doesNotMatch(block, /\.(?:Activate|Initialize|Start|SetValue|SetDefaultEndpoint)\(/);
  const output = block.slice(block.indexOf('internal static int Check('));
  assert.doesNotMatch(output, /(?:Quote\(instance|Quote\(container|Quote\(usb|\.Message)/);
  assert.match(source, /if \(options\.Mode == "identity"\) return ReadOnlyIdentity\.Check\(options\)/);
  assert.match(block, /SameUsbTopology\(physicalPaths, functionPaths/);
  assert.match(block, /Arrival\(endpointNode\), Arrival\(functionNode\), Arrival\(physicalNode\)/);
  assert.match(block, /observation\.Digest == second\.Digest/);
  assert.match(block, /DriverVersion = new PropertyKey\("A8B865DD-2E3D-4094-AD97-E593A70C75D6", 3\)/);
});

class FakeNode {
  constructor(tag) {this.tag = tag; this.children = []; this.events = new Map(); this.attributes = new Map(); this.value = '';}
  append(...nodes) {this.children.push(...nodes);}
  replaceChildren(...nodes) {this.children = nodes;}
  setAttribute(name, value) {this.attributes.set(name, value);}
  addEventListener(name, listener) {this.events.set(name, listener);}
  fire(name) {return this.events.get(name)?.();}
  all() {return [this, ...this.children.flatMap(child => child.all())];}
}

test('renderer requests only chosen scope and format, and closes stale challenges before confirmation', async () => {
  const calls = []; let current = true, finish;
  const document = {createElement: tag => new FakeNode(tag)};
  const panel = renderer.createModule({document, app: {async invoke(route, value) {
    calls.push({route, value});
    if (route === 'dac:list') return [];
    if (route === 'dac:prepare') return new Promise(resolve => {finish = resolve;});
    assert.fail('stale UI must not confirm');
  }}}).render({current: () => current});
  const all = panel.all(), review = all.find(node => node.tag === 'button');
  assert.equal(review.disabled, true);
  all.find(node => node.tag === 'input').checked = true;
  all.find(node => node.tag === 'select' && !node.attributes.has('data-dac-scope')).value = '24';
  all.find(node => node.tag === 'fieldset').fire('change'); assert.equal(review.disabled, true);
  all.find(node => node.attributes.has('data-dac-scope')).value = windowsScope;
  all.find(node => node.tag === 'fieldset').fire('change'); assert.equal(review.disabled, false);
  const action = review.fire('click'); current = false; finish({token: 'a'.repeat(43)}); await action;
  assert.deepEqual(calls, [{route: 'dac:list', value: {}}, {route: 'dac:prepare', value: {scope: windowsScope, capabilities: ['exclusive-check'], validationFormat}}]);
});
