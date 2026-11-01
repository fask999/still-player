'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {createBackdropController} = require('../src/renderer/glass');
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return {promise, resolve, reject}; }
function setup() {
  const loads = [], commits = [], clears = [], pending = new Map(); let settles = 0;
  const controller = createBackdropController({
    load(url) { loads.push(url); const task = deferred(); pending.set(url, task); return task.promise; },
    commit(image, options) { commits.push({image, ...options}); },
    clear(options) { clears.push(options); }, settle() { settles++; }
  });
  return {controller, loads, commits, clears, pending, settles: () => settles};
}

test('A to B to C out-of-order image decode can commit only the newest actual track artwork', async () => {
  const {controller, loads, commits, clears, pending} = setup();
  controller.update({key: 'local:A:1', url: 'coverA'});
  controller.update({key: 'local:B:2', url: 'coverB'});
  controller.update({key: 'local:C:3', url: 'coverC'});
  await flush(); assert.deepEqual(loads, ['coverA', 'coverB', 'coverC']);
  pending.get('coverC').resolve({id: 'decodedC'}); await flush();
  pending.get('coverA').resolve({id: 'decodedA'}); pending.get('coverB').reject(new Error('old image failed')); await flush();
  assert.deepEqual(commits, [{image: {id: 'decodedC'}, url: 'coverC', immediate: false}]);
  assert.equal(clears.length, 0); assert.equal(controller.snapshot().activeUrl, 'coverC');
});

test('the same artwork never reflashes across track generations and reduced motion settles immediately', async () => {
  const state = setup(), {controller, pending, loads, commits} = state;
  controller.update({key: 'A:1', url: 'shared'}); await flush(); pending.get('shared').resolve('decoded'); await flush();
  controller.update({key: 'B:2', url: 'shared'});
  controller.update({key: 'B:2', url: 'shared', reducedMotion: true});
  assert.deepEqual(loads, ['shared']); assert.equal(commits.length, 1); assert.equal(state.settles(), 1);
  controller.update({key: 'C:3', url: 'next'}); await flush();
  controller.update({key: 'C:3', url: 'next', reducedMotion: true});
  pending.get('next').resolve('decodedNext'); await flush();
  assert.equal(commits.at(-1).immediate, true); assert.equal(commits.at(-1).url, 'next');
});

test('missing artwork cancels stale decode and a current decode failure fades to fallback', async () => {
  const {controller, pending, commits, clears} = setup();
  controller.update({key: 'A:1', url: 'a'}); await flush(); pending.get('a').resolve('a'); await flush();
  controller.update({key: 'B:2', url: 'b'}); await flush();
  controller.update({key: 'C:3', url: ''});
  pending.get('b').resolve('lateB'); await flush();
  assert.equal(commits.length, 1); assert.equal(controller.snapshot().activeUrl, ''); assert.deepEqual(clears.at(-1), {immediate: false});
  controller.update({key: 'D:4', url: 'broken', reducedMotion: true}); await flush();
  pending.get('broken').reject(new Error('image cannot decode')); await flush();
  assert.equal(commits.length, 1); assert.deepEqual(clears.at(-1), {immediate: true});
});

test('a shared pending artwork decode is reused but committed only against the latest track generation', async () => {
  const {controller, loads, pending, commits} = setup();
  controller.update({key: 'same-id:1', url: 'shared'});
  controller.update({key: 'same-id:2', url: 'shared'});
  controller.update({key: 'same-id:3', url: 'shared'}); await flush();
  assert.deepEqual(loads, ['shared']);
  pending.get('shared').resolve('decoded'); await flush();
  assert.equal(commits.length, 1); assert.equal(controller.snapshot().key, 'same-id:3');
  controller.update({key: 'same-id:3', url: 'shared'}); assert.equal(commits.length, 1);
});

test('a failed safe URL retries after an explicit refresh but never loops on playback polling', async () => {
  const {controller, loads, pending, commits} = setup();
  const url = 'still-apple-art://art/' + 'a'.repeat(64);
  controller.update({key: 'apple:one:1', url}); await flush();
  pending.get(url).reject(new Error('first controlled decode failed')); await flush();
  for (let i = 0; i < 20; i++) controller.update({key: 'apple:one:1', url});
  await flush(); assert.equal(loads.length, 1); assert.equal(commits.length, 0);
  controller.update({key: 'apple:one:1', url, retry: true}); await flush();
  controller.update({key: 'apple:one:1', url, retry: true});
  assert.equal(loads.length, 2, 'another refresh while decode is pending reuses that request');
  pending.get(url).resolve('recovered image'); await flush();
  assert.equal(commits.length, 1); assert.equal(commits[0].url, url);
  assert.equal(controller.snapshot().failedUrl, '');
});
