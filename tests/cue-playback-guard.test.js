'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createSyntheticOwnedBackend} = require('./helpers/synthetic-owned-backend');
const {createExistingContextScopeIssuer, verifyExistingContextScope} = require('../src/main/existing-context-scope');
const source = fs.readFileSync(path.join(__dirname, '../src/main/cue-playback-guard.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function operation() {
  const controller = new AbortController(), cancelled = [];
  const context = {signal: controller.signal, check() {if (controller.signal.aborted) throw Object.assign(new Error('Synthetic cancellation'), {code: 'STILL_CANCELLED'});}};
  return {context, controller, cancelled, cancel(error) {cancelled.push(error); controller.abort(error);}};
}
async function fixture(t, options = {}) {
  const owned = await createSyntheticOwnedBackend(t);
  const replacement = options.replacement ? await createSyntheticOwnedBackend(t, {port: 19342}) : null;
  const managers = [owned.manager, ...(replacement ? [replacement.manager] : [])], created = [], calls = [], leaseBrands = new WeakMap();
  const lib = new Map();
  const request = (id, fields = {}) => ({path: path.join(owned.root, `${id}.cue`), references: [path.join(owned.root, `${id}.flac`)],
    trackCount: 2, authorizationRoot: owned.root, encoding: 'utf-8', contentHash: 'a'.repeat(64), ...fields});
  const remember = (value, location = {path: value.path, subsong: 1}) => {lib.set(JSON.stringify([location.path, location.subsong]), value); return location;};
  const lookup = locations => [...new Set(locations.map(location => lib.get(JSON.stringify([location.path, location.subsong]))).filter(Boolean))];
  let readRequests = options.getRequests || lookup, observer;
  const native = {
    async createCueReadLease(input) {
      const row = {input, live: true, closed: 0, checks: 0}; created.push(row); calls.push('holder-acquire');
      await options.beforeAcquire?.(row);
      const lease = Object.freeze({async check() {row.checks++; calls.push('holder-check'); if (!row.live) throw new Error('Synthetic lease loss');},
        async close() {row.closed++; row.live = false; calls.push('holder-close'); await options.beforeClose?.(row);}});
      if (!options.unbranded) leaseBrands.set(lease, row); return lease;
    },
    isVerifiedCueReadLease(lease, {request: expected}) {const row = leaseBrands.get(lease); return Boolean(row?.live && JSON.stringify(row.input.request) === JSON.stringify(expected));}
  };
  const module = {exports: {}};
  vm.runInNewContext(source, {module, AbortController, setTimeout, clearTimeout,
    require(name) {return name === './cue-read-lease' ? native : name.startsWith('./') ? require(path.join(__dirname, '../src/main', name)) : require(name);}});
  const guard = module.exports.createCuePlaybackGuard({runtimeRoot: path.resolve(__dirname, '..'),
    getRequests: async (locations, scope) => {calls.push('library-getter'); return readRequests(locations, scope);},
    getTreeExitEvidence: token => managers.map(manager => manager.getVerifiedOwnedTreeExit(token)).find(Boolean),
    onTreeExit(listener) {observer = listener; const off = managers.map(manager => manager.subscribeVerifiedOwnedTreeExit(listener)); return () => off.forEach(remove => remove());}});
  const prepare = (locations, op = operation(), session = owned.session, existingContextScope) => guard.prepare({locations, context: op.context,
    session, existingContextScope, cancel: op.cancel});
  t.after(async () => {await Promise.allSettled(managers.map(manager => manager.close())); await guard.close().catch(() => {});});
  return {guard, owned, replacement, created, calls, request, remember, lookup, prepare, operation,
    setGetter(value) {readRequests = value;}, observe(evidence, token) {observer?.(evidence, token);}};
}

test('CUE playback runs the private getter again with the verified Native lease already held', async t => {
  const f = await fixture(t), location = f.remember(f.request('album'));
  const permit = await f.prepare([location]);
  assert.deepEqual(f.calls.slice(0, 4), ['library-getter', 'holder-acquire', 'holder-check', 'library-getter']);
  assert.equal(f.guard.getStatus().retained, 0);
  await permit.release(); assert.equal(f.created[0].closed, 1);
  assert.throws(() => permit.markNativeRead(), {code: 'STILL_CANCELLED'});
});

for (const change of ['content', 'reference']) test(`a same-path CUE ${change} replacement under the acquisition window refuses dispatch`, async t => {
  const f = await fixture(t), original = f.request('album'), location = f.remember(original);
  let reads = 0;
  f.setGetter(() => ++reads === 1 ? [original] : [change === 'content' ? {...original, contentHash: 'b'.repeat(64)} : {...original, references: [path.join(f.owned.root, 'other.flac')]}]);
  await assert.rejects(f.prepare([location]), {code: 'STILL_CUE_PLAYBACK_REVALIDATION_REQUIRED'});
  assert.equal(f.created.length, 1); assert.equal(f.created[0].closed, 1); assert.equal(f.guard.getStatus().retained, 0);
});

test('materialization feeds the actual CUE source only for its exact referenced subsong', async t => {
  const f = await fixture(t), value = f.request('album'), segment = f.remember(value, {path: value.references[0], subsong: 1});
  const ordinary = {path: value.references[0], subsong: 0}, permit = await f.prepare([segment, ordinary]);
  const resolved = await permit.resolveIngestionPaths([ordinary, segment]);
  assert.deepEqual(Array.from(resolved), [ordinary.path, value.path]);
  await assert.rejects(permit.resolveIngestionPaths([{...segment, subsong: 2}]), {code: 'STILL_CUE_PLAYBACK_REVALIDATION_REQUIRED'});
  await permit.release();
});

test('scoped unknown ordinary tuples are read-only and cannot be borrowed by another operation or sent to ingestion', async t => {
  const f = await fixture(t), op = operation(), location = {path: path.join(f.owned.root, 'Legacy.flac'), subsong: 1};
  const issuer = createExistingContextScopeIssuer({bridge: {}, session: f.owned.session, endpoint: 'real-output', operation: op.context, isCurrent: () => !op.context.signal.aborted});
  const scope = issuer.issue([location]); let reads = 0;
  f.setGetter((locations, options) => {reads++; assert.equal(options.existingContextScope, scope); assert.equal(verifyExistingContextScope(scope, locations[0]), true); return [];});
  await assert.rejects(f.prepare([location], operation(), f.owned.session, scope), {code: 'STILL_CUE_PLAYBACK_REVALIDATION_REQUIRED'});
  assert.equal(reads, 0);
  const permit = await f.prepare([location], op, f.owned.session, scope);
  assert.equal(reads, 2); assert.equal(f.created.length, 0);
  await assert.rejects(permit.resolveIngestionPaths([location]), {code: 'STILL_CUE_PLAYBACK_REVALIDATION_REQUIRED'});
  issuer.revoke(); assert.throws(() => permit.markNativeRead(), {code: 'STILL_CUE_PLAYBACK_REVALIDATION_REQUIRED'});
  await permit.release();
});

test('cancelled acquisition cannot publish a late permit or retain a never-dispatched holder', async t => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const f = await fixture(t, {beforeAcquire(row) {entered.resolve(row); return gate.promise;}}), op = operation();
  const work = f.prepare([f.remember(f.request('slow'))], op), rejected = assert.rejects(work, {code: 'STILL_CANCELLED'});
  const row = await entered.promise; op.controller.abort(); assert.equal(row.input.signal.aborted, true);
  gate.resolve(); await rejected; assert.equal(row.closed, 1); assert.equal(f.guard.getStatus().holders, 0);
});

test('ordinary WAV and an unbranded CUE result cannot trigger a Native holder-backed playback permit', async t => {
  const f = await fixture(t, {unbranded: true}), plain = {path: path.join(f.owned.root, 'ordinary.wav'), subsong: 0};
  const wav = await f.prepare([plain], operation(), null); wav.markNativeRead(); await wav.release(); assert.equal(f.created.length, 0);
  await assert.rejects(f.prepare([f.remember(f.request('cue'))]), {code: 'STILL_CUE_PLAYBACK_CLEANUP_UNVERIFIED'});
  assert.equal(f.created[0].closed, 1); assert.equal(f.guard.getStatus().retained, 0);
});

test('retained same-session CUEs reuse one holder, reject before cap overflow, and recover with a new session after true tree exit', async t => {
  const f = await fixture(t, {replacement: true}), old = operation(), first = f.remember(f.request('first'));
  const permit = await f.prepare([first], old); permit.markNativeRead(); old.controller.abort(); await permit.release();
  const reused = await f.prepare([first]); reused.markNativeRead(); await reused.release(); assert.equal(f.created.length, 1); assert.equal(f.created[0].closed, 0);
  for (let index = 1; index < 8; index++) {const next = await f.prepare([f.remember(f.request(`album${index}`))]); next.markNativeRead(); await next.release();}
  await assert.rejects(f.prepare([f.remember(f.request('overflow'))]), {code: 'STILL_CUE_PLAYBACK_LIMIT'});
  assert.equal(f.created.length, 8); assert.equal(f.guard.getStatus().retained, 8);
  f.observe({sessionId: f.owned.session.sessionId, exited: true, childExited: true, treeExited: true}, f.owned.session);
  await tick(); assert.equal(f.created.some(row => row.closed), false);
  const exactExit = await f.owned.manager.close(); assert.ok(exactExit.exitEvidence);
  await tick(); assert.equal(f.created.every(row => row.closed === 1), true);
  const nextSession = await f.prepare([first], operation(), f.replacement.session); nextSession.markNativeRead(); await nextSession.release();
  assert.equal(f.created.length, 9); assert.equal(f.created[8].closed, 0);
  f.observe(exactExit.exitEvidence, f.replacement.session); await tick(); assert.equal(f.created[8].closed, 0);
});

test('closing a logical controller preserves a Native-read lease until its matching tree, while a lost old lease cannot cancel replacement playback', async t => {
  const f = await fixture(t), old = operation(), replacement = operation();
  const first = await f.prepare([f.remember(f.request('one'))], old); first.markNativeRead(); await first.release();
  const second = await f.prepare([f.remember(f.request('two'))], replacement); second.markNativeRead();
  f.created[0].input.onLost(new Error('Synthetic old holder loss')); assert.equal(replacement.context.signal.aborted, false); assert.equal(old.cancelled.length, 0);
  await second.release(); await assert.rejects(f.guard.close(), {code: 'STILL_CUE_PLAYBACK_CLEANUP_UNVERIFIED'});
  assert.equal(f.created.every(row => row.closed === 0), true);
  await f.owned.manager.close(); await f.guard.close(); assert.equal(f.created.every(row => row.closed === 1), true);
});
