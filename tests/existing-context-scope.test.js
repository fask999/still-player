'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {createExistingContextScopeIssuer, verifyExistingContextScope, isExistingContextScopeForOperation} = require('../src/main/existing-context-scope');
function fixture() {
  let current = true; const operation = {}, session = {}, bridge = {}, target = {path: 'C:\\Fixture\\Image.flac', subsong: 1};
  const issuer = createExistingContextScopeIssuer({bridge, session, endpoint: '["output","actual-endpoint"]', operation, isCurrent: () => current});
  return {issuer, target, session, operation, invalidate() {current = false;}};
}
test('opaque existing-context scope allows only its exact tuple and remains repeatable within its operation', () => {
  const f = fixture(), scope = f.issuer.issue([f.target]);
  for (let count = 0; count < 3; count++) assert.equal(verifyExistingContextScope(scope, {...f.target}), true);
  assert.equal(verifyExistingContextScope(scope, {...f.target, subsong: 0}), false);
  assert.equal(verifyExistingContextScope(scope, {...f.target, path: f.target.path.toLowerCase()}), false);
  assert.equal(isExistingContextScopeForOperation(scope, f.operation, f.session), true);
  assert.equal(isExistingContextScopeForOperation(scope, {}, f.session), false);
  assert.equal(isExistingContextScopeForOperation(scope, f.operation, {}), false);
  assert.throws(() => f.issuer.issue([f.target]));
});
test('scope cannot be restored from serialization, cloning, another issuer or a forged flag', () => {
  const f = fixture(), scope = f.issuer.issue([f.target]);
  assert.equal(JSON.stringify(scope), '{}'); assert.deepEqual(Reflect.ownKeys(scope), []);
  for (const forged of [JSON.parse(JSON.stringify(scope)), structuredClone(scope), {...scope}, {verified: true}, null, 1]) assert.equal(verifyExistingContextScope(forged, f.target), false);
  const second = fixture(); assert.equal(isExistingContextScopeForOperation(scope, second.operation, second.session), false);
});
test('cancellation and finally revocation reject every later verification without changing a replacement scope', () => {
  for (const action of ['invalidate', 'revoke']) {
    const f = fixture(), scope = f.issuer.issue([f.target]), replacement = fixture(), next = replacement.issuer.issue([replacement.target]);
    if (action === 'invalidate') f.invalidate(); else f.issuer.revoke();
    assert.equal(verifyExistingContextScope(scope, f.target), false); assert.equal(verifyExistingContextScope(next, replacement.target), true);
  }
});
test('synchronous exact true is required; getters and asynchronous checks grant no scope', async () => {
  for (const value of [1, {}, Promise.resolve(true), Promise.reject(new Error('SYNTHETIC'))]) {
    const issuer = createExistingContextScopeIssuer({bridge: {}, session: null, endpoint: 'real', operation: {}, isCurrent: () => value});
    assert.throws(() => issuer.issue([{path: 'C:\\Fixture\\x.wav', subsong: 0}]));
  }
  const f = fixture(); let accessed = false;
  assert.throws(() => f.issuer.issue([Object.defineProperty({subsong: 0}, 'path', {get() {accessed = true; return f.target.path;}})]));
  assert.equal(accessed, false); await new Promise(resolve => setImmediate(resolve));
});
