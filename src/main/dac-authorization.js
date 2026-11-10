'use strict';

const {randomBytes, randomUUID} = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {stockDacOutput, isVerifiedDacIdentity, isDacIdentityScope, isSha256, dataFields, readOwn} = require('./dac-identity');
const {MAX_GRANTS} = require('./dac-authorization-store');

const CAPABILITIES = ['exclusive-check', 'owned-exit-fallback'];
const PROVIDER_POLICY_VERSION = 1;
const CHALLENGE_MS = 90_000;
const PERMIT_MS = 10_000;
const GRANT_MS = 30 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const messages = {
  STILL_DAC_INVALID_REQUEST: 'DAC 授权请求无效。',
  STILL_DAC_CONTEXT_CHANGED: '当前设备或会话已改变，请重新发起 DAC 授权。',
  STILL_DAC_IDENTITY_UNVERIFIED: '无法核验当前 USB 音频输出的设备身份。',
  STILL_DAC_OUTPUT_UNSUPPORTED: '此输出类型不支持专属 DAC 授权。',
  STILL_DAC_CONFIRMATION_EXPIRED: 'DAC 确认已失效，请重新发起。',
  STILL_DAC_CONFIRMATION_DECLINED: '未确认 DAC 授权。',
  STILL_DAC_CONFIRMATION_UNAVAILABLE: '无法打开 DAC 确认。',
  STILL_DAC_AUTHORIZATION_REQUIRED: '当前设备和操作没有有效的 DAC 授权。',
  STILL_DAC_STORE_UNAVAILABLE: '无法安全读取或保存 DAC 授权。',
  STILL_DAC_LIMIT: 'DAC 授权数量已达上限，请先撤销不再使用的授权。'
};
const failure = code => Object.assign(new Error(messages[code]), {code});
const changed = () => failure('STILL_DAC_CONTEXT_CHANGED');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const uuid = value => typeof value === 'string' && value.length === 36 && UUID.test(value);
const nonce = value => typeof value === 'string' && value.length === 43 && /^[A-Za-z0-9_-]{43}$/.test(value);

function capabilities(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > CAPABILITIES.length || Reflect.ownKeys(value).length !== value.length + 1) return null;
  const requested = Array.from({length: value.length}, (_, index) => readOwn(value, String(index)));
  return requested.every(item => CAPABILITIES.includes(item)) && new Set(requested).size === requested.length ? requested.sort() : null;
}

function format(value) {
  const result = dataFields(value, ['sampleRate', 'bits', 'channels']);
  return result?.sampleRate === 48000 && [16, 24, 32].includes(result.bits) && result.channels === 2 ? result : null;
}

function version(value) {
  const result = dataFields(value, ['backendId', 'coreSha256', 'componentsSha256', 'probeSha256', 'providerPolicyVersion']);
  if (!result || typeof result.backendId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(result.backendId) ||
      /[\r\n]/.test(result.backendId) || ![result.coreSha256, result.componentsSha256, result.probeSha256].every(isSha256) ||
      result.providerPolicyVersion !== PROVIDER_POLICY_VERSION) return null;
  return result;
}

function sameOutput(a, b) {
  return Boolean(a && b && a.typeId === b.typeId && a.deviceId === b.deviceId && a.endpoint === b.endpoint);
}

function sameSnapshot(a, b) {
  return a.session === b.session && a.generation === b.generation && a.selectionEpoch === b.selectionEpoch &&
    a.versionKey === b.versionKey && sameOutput(a.output, b.output);
}

function parseGrant(value) {
  const legacy = readOwn(value, 'schemaVersion') === 1;
  const keys = ['schemaVersion', 'authorizationId', 'issuedAt', 'expiresAt', 'capabilities',
    'validationFormat', 'versionScope', 'output', 'identitySha256'];
  if (!legacy) keys.push('scope');
  const row = dataFields(value, keys), scope = legacy ? 'hardware-instance' : row?.scope;
  if (!row || row.schemaVersion !== (legacy ? 1 : 2) || !isDacIdentityScope(scope) || !uuid(row.authorizationId) || !integer(row.issuedAt) || !integer(row.expiresAt) ||
      row.expiresAt <= row.issuedAt || row.expiresAt - row.issuedAt > GRANT_MS || !isSha256(row.identitySha256)) return null;
  const output = dataFields(row.output, ['typeId', 'deviceId', 'endpoint']);
  const versionScope = version(row.versionScope), allowed = capabilities(row.capabilities), validationFormat = format(row.validationFormat);
  if (!sameOutput(output, stockDacOutput(output)) || !versionScope || !allowed || !validationFormat) return null;
  return {...row, schemaVersion: 2, scope, output, versionScope, capabilities: allowed, validationFormat};
}

function preview(scope, capabilities, validationFormat) {
  return {label: '当前选中的 USB 音频输出', scope, capabilities: [...capabilities], validationFormat: {...validationFormat}};
}

function publicGrant(grant) {
  return {authorizationId: grant.authorizationId, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt,
    ...preview(grant.scope, grant.capabilities, grant.validationFormat)};
}

function createDacAuthorizationService({store, readIdentity, readCurrent, getCurrent, isVerifiedSession, confirmUser, clock = {}} = {}) {
  if (![store?.read, store?.write, readIdentity, readCurrent, getCurrent, isVerifiedSession, confirmUser].every(value => typeof value === 'function')) {
    throw new TypeError('DAC authorization requires main-process capabilities.');
  }
  const challenges = new Map(), permits = new WeakMap();
  const now = clock.now || Date.now, monotonicNow = clock.monotonicNow || (() => performance.now());
  let epoch = 0, lastWall = -1, lastMonotonic = -Infinity, mutationTail = Promise.resolve(), mutations = 0;

  function time() {
    const wall = now(), monotonic = monotonicNow();
    if (!integer(wall) || wall > Number.MAX_SAFE_INTEGER - GRANT_MS || wall < lastWall ||
        !Number.isFinite(monotonic) || monotonic < lastMonotonic) throw changed();
    lastWall = wall; lastMonotonic = monotonic;
    return {wall, monotonic};
  }

  function invalidate() {
    epoch++; challenges.clear();
  }

  function checkEpoch(issuedEpoch, signal) {
    if (issuedEpoch !== epoch || signal?.aborted) throw changed();
  }

  function snapshot(value) {
    const session = readOwn(value, 'session'), generation = readOwn(value, 'generation'), selectionEpoch = readOwn(value, 'selectionEpoch');
    const scope = version(readOwn(value, 'versionScope'));
    if (!session || !isVerifiedSession(session) || !integer(generation) || !integer(selectionEpoch) || !scope ||
        readOwn(session, 'backendId') !== scope.backendId || readOwn(session, 'executableSha256') !== scope.coreSha256) throw changed();
    const output = stockDacOutput(readOwn(value, 'output'));
    if (!output) throw failure('STILL_DAC_OUTPUT_UNSUPPORTED');
    return {session, generation, selectionEpoch, output, versionScope: scope, versionKey: JSON.stringify(scope)};
  }

  function assertCurrent(expected, issuedEpoch, signal) {
    checkEpoch(issuedEpoch, signal);
    let current;
    try {current = snapshot(getCurrent());} catch {throw changed();}
    checkEpoch(issuedEpoch, signal);
    if (!sameSnapshot(expected, current)) throw changed();
  }

  async function freshSnapshot(signal) {
    let current;
    try {current = await readCurrent({signal});} catch {throw changed();}
    return snapshot(current);
  }

  async function observe({issuedEpoch, expected, scope, signal, snapshotBefore}) {
    checkEpoch(issuedEpoch, signal);
    const before = snapshotBefore || await freshSnapshot(signal);
    assertCurrent(before, issuedEpoch, signal);
    if (expected && !sameSnapshot(before, expected)) throw changed();
    let identity;
    try {identity = await readIdentity({endpointId: before.output.endpoint, scope, signal});}
    catch {throw failure('STILL_DAC_IDENTITY_UNVERIFIED');}
    assertCurrent(before, issuedEpoch, signal);
    if (!isVerifiedDacIdentity(identity, scope) || identity.endpointId !== before.output.endpoint || identity.probeSha256 !== before.versionScope.probeSha256) {
      throw failure('STILL_DAC_IDENTITY_UNVERIFIED');
    }
    const after = await freshSnapshot(signal);
    assertCurrent(before, issuedEpoch, signal);
    if (!sameSnapshot(before, after)) throw changed();
    return {snapshot: before, scope, identitySha256: identity.identitySha256};
  }

  function callerIdentity(caller) {
    const sender = readOwn(caller, 'sender'), windowGeneration = readOwn(caller, 'windowGeneration');
    if (!sender || typeof sender !== 'object' || !integer(windowGeneration)) throw failure('STILL_DAC_INVALID_REQUEST');
    return {sender, windowGeneration};
  }

  async function loadGrants() {
    try {
      const rows = await store.read();
      if (!Array.isArray(rows) || rows.length > MAX_GRANTS) throw new Error();
      const grants = rows.map(parseGrant);
      if (grants.some(row => !row) || new Set(grants.map(row => row.authorizationId)).size !== grants.length) throw new Error();
      return grants;
    } catch {throw failure('STILL_DAC_STORE_UNAVAILABLE');}
  }

  function mutate(action) {
    mutations++;
    const work = mutationTail.then(action);
    mutationTail = work.catch(() => {});
    return work.finally(() => {mutations--;});
  }

  function active(grant, wall) {return grant.issuedAt <= wall && wall < grant.expiresAt;}
  function matchesBinding(grant, snapshot) {
    return sameOutput(grant.output, snapshot.output) && JSON.stringify(grant.versionScope) === snapshot.versionKey;
  }

  async function prepare(input, caller) {
    const identity = callerIdentity(caller);
    const requested = dataFields(input, ['scope', 'capabilities', 'validationFormat']);
    const scope = requested?.scope;
    const allowed = capabilities(requested?.capabilities), validationFormat = format(requested?.validationFormat);
    if (!isDacIdentityScope(scope) || !allowed || !validationFormat) throw failure('STILL_DAC_INVALID_REQUEST');
    const issuedEpoch = epoch, observed = await observe({issuedEpoch, scope}), stamp = time();
    assertCurrent(observed.snapshot, issuedEpoch);
    for (const [token, challenge] of challenges) {
      if (challenge.monotonicExpiresAt <= stamp.monotonic || challenge.expiresAt <= stamp.wall) challenges.delete(token);
    }
    if (challenges.size >= MAX_GRANTS) throw failure('STILL_DAC_LIMIT');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = stamp.wall + CHALLENGE_MS;
    challenges.set(token, {...identity, ...observed, issuedEpoch, capabilities: allowed, validationFormat,
      expiresAt, monotonicExpiresAt: stamp.monotonic + CHALLENGE_MS});
    return {token, preview: preview(scope, allowed, validationFormat), expiresAt};
  }

  function checkChallenge(challenge) {
    const stamp = time();
    if (stamp.wall >= challenge.expiresAt || stamp.monotonic >= challenge.monotonicExpiresAt) throw failure('STILL_DAC_CONFIRMATION_EXPIRED');
    assertCurrent(challenge.snapshot, challenge.issuedEpoch);
    return stamp;
  }

  async function confirm(input, caller) {
    const identity = callerIdentity(caller), fields = dataFields(input, ['token']);
    if (!nonce(fields?.token)) throw failure('STILL_DAC_INVALID_REQUEST');
    const challenge = challenges.get(fields.token);
    if (!challenge || challenge.sender !== identity.sender || challenge.windowGeneration !== identity.windowGeneration) {
      throw failure('STILL_DAC_CONFIRMATION_EXPIRED');
    }
    challenges.delete(fields.token);
    checkChallenge(challenge);
    let accepted;
    try {accepted = await confirmUser(preview(challenge.scope, challenge.capabilities, challenge.validationFormat), identity);}
    catch {throw failure('STILL_DAC_CONFIRMATION_UNAVAILABLE');}
    if (accepted !== true) throw failure('STILL_DAC_CONFIRMATION_DECLINED');
    checkChallenge(challenge);
    const observed = await observe({issuedEpoch: challenge.issuedEpoch, expected: challenge.snapshot, scope: challenge.scope});
    if (observed.identitySha256 !== challenge.identitySha256) throw changed();
    return mutate(async () => {
      const rows = await loadGrants(), stamp = checkChallenge(challenge);
      const retained = rows.filter(row => active(row, stamp.wall) && !matchesBinding(row, observed.snapshot));
      if (retained.length >= MAX_GRANTS) throw failure('STILL_DAC_LIMIT');
      const grant = {schemaVersion: 2, scope: challenge.scope, authorizationId: randomUUID(), issuedAt: stamp.wall, expiresAt: stamp.wall + GRANT_MS,
        capabilities: challenge.capabilities, validationFormat: challenge.validationFormat, versionScope: observed.snapshot.versionScope,
        output: observed.snapshot.output, identitySha256: observed.identitySha256};
      await store.write([...retained, grant], {check: () => {checkChallenge(challenge);}});
      invalidate();
      return publicGrant(grant);
    });
  }

  async function revoke(input) {
    const fields = dataFields(input, ['authorizationId']);
    if (!uuid(fields?.authorizationId)) throw failure('STILL_DAC_INVALID_REQUEST');
    invalidate();
    return mutate(async () => {
      const rows = await loadGrants(), retained = rows.filter(row => row.authorizationId !== fields.authorizationId);
      if (retained.length === rows.length) return {revoked: false};
      await store.write(retained);
      return {revoked: true};
    });
  }

  async function issueUsePermit({session, output, context, capability, scope, signal} = {}) {
    if (!CAPABILITIES.includes(capability) || !context || typeof context !== 'object' ||
        scope !== undefined && !isDacIdentityScope(scope)) throw failure('STILL_DAC_INVALID_REQUEST');
    if (mutations) throw changed();
    const issuedEpoch = epoch;
    checkEpoch(issuedEpoch, signal);
    const snapshotBefore = await freshSnapshot(signal);
    assertCurrent(snapshotBefore, issuedEpoch, signal);
    if (snapshotBefore.session !== session || !sameOutput(snapshotBefore.output, stockDacOutput(output))) throw changed();
    const grants = await loadGrants();
    const before = time();
    assertCurrent(snapshotBefore, issuedEpoch, signal);
    if (mutations) throw changed();
    const candidates = grants.filter(row => active(row, before.wall) && row.capabilities.includes(capability) &&
      matchesBinding(row, snapshotBefore) && (scope === undefined || scope === row.scope));
    if (candidates.length !== 1) throw failure('STILL_DAC_AUTHORIZATION_REQUIRED');
    const [grant] = candidates;
    // Read only the explicitly sealed scope. A failed identity read cannot
    // select a different grant or turn a physical-instance grant into an endpoint grant.
    const observed = await observe({issuedEpoch, snapshotBefore, scope: grant.scope, signal});
    const stamp = time();
    assertCurrent(snapshotBefore, issuedEpoch, signal);
    if (mutations) throw changed();
    if (!active(grant, stamp.wall) || grant.identitySha256 !== observed.identitySha256) throw failure('STILL_DAC_AUTHORIZATION_REQUIRED');
    const permit = Object.freeze({});
    permits.set(permit, {issuedEpoch, snapshot: observed.snapshot, context, capability, grant, signal, expiresAt: stamp.monotonic + PERMIT_MS});
    return permit;
  }

  function consumeUsePermit(permit, {session, output, context, capability, scope} = {}) {
    const record = permits.get(permit);
    if (!record) return null;
    permits.delete(permit);
    function checkCurrent() {
      try {
        const stamp = time();
        assertCurrent(record.snapshot, record.issuedEpoch, record.signal);
        return !mutations && stamp.monotonic < record.expiresAt && active(record.grant, stamp.wall);
      } catch {return false;}
    }
    try {
      if (record.snapshot.session !== session || record.context !== context || record.capability !== capability ||
          scope !== undefined && scope !== record.grant.scope ||
          !sameOutput(record.snapshot.output, stockDacOutput(output)) || !checkCurrent()) return null;
    } catch {return null;}
    // An existing resource transition can recheck the authorization at its
    // last dispatch gate after awaits. This callback never proves release.
    return Object.freeze({...record.snapshot.output, policy: 'user-dac-authorization-v1',
      exclusiveValidationFormat: Object.freeze({...record.grant.validationFormat}), ownedExitRelease: capability === 'owned-exit-fallback', checkCurrent});
  }

  async function list() {
    await mutationTail;
    const rows = await loadGrants();
    return rows.map(publicGrant);
  }

  return {prepare, confirm, list, revoke, invalidate, issueUsePermit, consumeUsePermit};
}

module.exports = {createDacAuthorizationService, PROVIDER_POLICY_VERSION};
