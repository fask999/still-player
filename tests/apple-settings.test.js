'use strict';

// Pure data fixtures: no Apple host, account, engine, network or process IO.
const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeAppleSettingsSnapshot: normalize, validateAppleSettingsPatch: validate} = require('../src/main/apple-settings');
const snapshotError = {name: 'TypeError', message: 'Invalid Apple settings snapshot'};
const patchError = {name: 'TypeError', message: 'Invalid Apple settings patch'};
const valid = () => ({source: 'apple', available: true, status: 'ready', sessionOpen: true, authorized: true, pending: false,
  repeatMode: 'all', shuffleMode: 'songs', bitrateTarget: 256,
  capabilities: {read: true, repeatMode: true, shuffleMode: true, openSession: true, refreshLibrary: true}});

test('empty facts stay unknown or disabled without invented authorization or quality', () => {
  const expected = {source: 'apple', available: false, status: 'unsupported', sessionOpen: false, authorized: null, pending: false,
    repeatMode: null, shuffleMode: null, bitrateTarget: null,
    capabilities: {read: false, repeatMode: false, shuffleMode: false, bitrateTarget: false, openSession: false,
      refreshLibrary: false, canSelectLossless: false, outputSelection: false}, details: {actualBitrate: null, actualDacRate: null}};
  for (const input of [undefined, null, {}, Object.create(null)]) assert.deepEqual(normalize(input), expected);
});

test('Core connection facts are retained independently rather than inferred from modes or status', () => {
  const result = normalize({...valid(), available: false, status: 'pending', sessionOpen: false, authorized: false, pending: false});
  assert.equal(result.available, false); assert.equal(result.status, 'pending');
  assert.equal(result.sessionOpen, false); assert.equal(result.authorized, false); assert.equal(result.pending, false);
  assert.equal(result.repeatMode, 'all'); assert.equal(result.shuffleMode, 'songs');
  const noModes = normalize({available: true, status: 'ready', authorized: true, sessionOpen: true, pending: true});
  assert.equal(noModes.available, true); assert.equal(noModes.status, 'ready'); assert.equal(noModes.pending, true);
  assert.equal(noModes.repeatMode, null); assert.equal(noModes.capabilities.repeatMode, false);
});

test('all documented application modes and status values survive complete normalization', () => {
  for (const repeatMode of ['none', 'one', 'all']) for (const shuffleMode of ['off', 'songs']) {
    for (const status of ['ready', 'pending', 'session-closed', 'unavailable', 'unsupported']) {
      const result = normalize({...valid(), repeatMode, shuffleMode, status});
      assert.equal(result.repeatMode, repeatMode); assert.equal(result.shuffleMode, shuffleMode); assert.equal(result.status, status);
      assert.equal(result.capabilities.repeatMode, true); assert.equal(result.capabilities.shuffleMode, true);
    }
  }
});

test('truthy flags, ordinals and unsupported modes cannot manufacture supported capabilities', () => {
  for (const bad of [undefined, null, 0, 1, true, 'ALL', '', {}, [], new String('all')]) {
    const result = normalize({...valid(), repeatMode: bad, shuffleMode: bad});
    assert.equal(result.repeatMode, null); assert.equal(result.shuffleMode, null);
    assert.equal(result.capabilities.repeatMode, false); assert.equal(result.capabilities.shuffleMode, false);
  }
  const result = normalize({available: 1, sessionOpen: 'true', authorized: 'true', pending: [], status: 'connected',
    repeatMode: 'one', shuffleMode: 'off', capabilities: {read: 1, repeatMode: 'true', shuffleMode: {}, openSession: 1, refreshLibrary: 'true'}});
  assert.equal(result.available, false); assert.equal(result.sessionOpen, false); assert.equal(result.authorized, null);
  assert.equal(result.pending, false); assert.equal(result.status, 'unsupported');
  assert.ok(Object.values(result.capabilities).every(value => value === false));
});

test('target bitrate is narrowly readable while unsupported quality and output capabilities stay false', () => {
  for (const bitrateTarget of [64, 256]) assert.equal(normalize({bitrateTarget}).bitrateTarget, bitrateTarget);
  for (const bitrateTarget of ['256', 128, 0, -1, Infinity, NaN, true, {}, []]) assert.equal(normalize({bitrateTarget}).bitrateTarget, null);
  const result = normalize({...valid(), capabilities: {...valid().capabilities, bitrateTarget: true, canSelectLossless: true, outputSelection: true},
    details: {actualBitrate: 999999, actualDacRate: 192000}});
  assert.equal(result.capabilities.bitrateTarget, false); assert.equal(result.capabilities.canSelectLossless, false);
  assert.equal(result.capabilities.outputSelection, false); assert.deepEqual(result.details, {actualBitrate: null, actualDacRate: null});
  assert.equal(result.capabilities.openSession, true); assert.equal(result.capabilities.refreshLibrary, true);
});

test('normalization is idempotent and returns detached ordinary records', () => {
  const input = valid(), before = structuredClone(input), first = normalize(input), second = normalize(first);
  assert.deepEqual(second, first); assert.deepEqual(input, before);
  assert.notEqual(second, first); assert.notEqual(second.capabilities, first.capabilities); assert.notEqual(second.details, first.details);
  assert.equal(Object.getPrototypeOf(first), Object.prototype); assert.equal(Object.getPrototypeOf(first.capabilities), Object.prototype);
  input.capabilities.openSession = false; input.repeatMode = 'none';
  assert.equal(first.capabilities.openSession, true); assert.equal(first.repeatMode, 'all');
  for (const input of [null, {}, {status: 'unavailable', authorized: false}, {capabilities: null, details: null}]) {
    assert.deepEqual(normalize(normalize(input)), normalize(input));
  }
});

test('null-prototype and nonenumerable own data fields work without reading inherited fields', () => {
  const input = Object.assign(Object.create(null), valid());
  input.capabilities = Object.assign(Object.create(null), input.capabilities);
  input.details = Object.assign(Object.create(null), {actualBitrate: null, actualDacRate: null});
  Object.defineProperty(input, 'authorized', {value: false, enumerable: false});
  assert.equal(normalize(input).authorized, false); assert.equal(normalize(input).capabilities.openSession, true);
  const patch = Object.create(null); Object.defineProperty(patch, 'repeatMode', {value: 'one', enumerable: false});
  assert.deepEqual(validate(patch), {repeatMode: 'one'});
});

test('snapshot rejects non-record roots, nested records and cross-source records', () => {
  for (const bad of [[], () => {}, 0, true, 'apple', new Date(), Object.create({available: true})]) assert.throws(() => normalize(bad), snapshotError);
  for (const source of ['local', '', null, undefined, {}, 1]) assert.throws(() => normalize({source}), snapshotError);
  for (const key of ['capabilities', 'details']) for (const bad of [[], () => {}, 1, 'true', new Date(), Object.create({read: true})]) {
    assert.throws(() => normalize({[key]: bad}), snapshotError);
  }
});

test('snapshot rejects unknown, prototype, symbol and toJSON keys at every record boundary', () => {
  for (const key of ['unknown', '__proto__', 'constructor', 'prototype', 'toJSON', Symbol('hidden')]) {
    const raw = Object.create(null); Object.defineProperty(raw, key, {value: () => {throw new Error('must not run');}});
    assert.throws(() => normalize(raw), snapshotError);
    for (const parent of ['capabilities', 'details']) assert.throws(() => normalize({[parent]: raw}), snapshotError);
  }
  assert.equal({}.polluted, undefined);
});

test('snapshot refuses getters and setters without invoking either or serializing input', () => {
  let calls = 0;
  for (const [parent, key] of [[null, 'status'], ['capabilities', 'read'], ['details', 'actualDacRate']]) {
    for (const descriptor of [{get() {calls++; return true;}}, {set() {calls++;}}]) {
      const record = {}; Object.defineProperty(record, key, descriptor);
      assert.throws(() => normalize(parent ? {[parent]: record} : record), snapshotError);
    }
  }
  assert.throws(() => normalize({toJSON() {calls++; return valid();}}), snapshotError);
  assert.equal(calls, 0);
});

test('patch accepts exactly one documented mode and never silently changes the other', () => {
  for (const repeatMode of ['none', 'one', 'all']) {
    const input = Object.freeze({repeatMode}), result = validate(input);
    assert.deepEqual(result, input); assert.notEqual(result, input); assert.deepEqual(Object.keys(result), ['repeatMode']);
  }
  for (const shuffleMode of ['off', 'songs']) assert.deepEqual(validate({shuffleMode}), {shuffleMode});
  for (const input of [{}, {repeatMode: 'one', shuffleMode: 'songs'}, {repeatMode: 'one', unknown: 1}, {bitrateTarget: 256},
    {patch: {repeatMode: 'one'}}, {available: true}, {openSession: true}]) assert.throws(() => validate(input), patchError);
});

test('patch rejects invalid values without coercion or leaked input content', () => {
  for (const key of ['repeatMode', 'shuffleMode']) for (const value of [undefined, null, true, false, 0, 1, 2, '', 'ALL', ' none', 'songs ', {}, [], new String('one')]) {
    assert.throws(() => validate({[key]: value}), patchError);
  }
  assert.throws(() => validate({repeatMode: 'songs'}), patchError);
  assert.throws(() => validate({shuffleMode: 'one'}), patchError);
  for (const value of [undefined, null, [], () => {}, 'one', 1, new Date(), Object.create({repeatMode: 'one'})]) assert.throws(() => validate(value), patchError);
});

test('patch rejects getters, setters, symbols, custom prototypes and toJSON without running hooks', () => {
  let calls = 0;
  for (const descriptor of [{get() {calls++; return 'one';}}, {set() {calls++;}}]) {
    const patch = {}; Object.defineProperty(patch, 'repeatMode', descriptor);
    assert.throws(() => validate(patch), patchError);
  }
  for (const key of ['toJSON', '__proto__', 'constructor', 'prototype', Symbol('ignored')]) {
    const patch = Object.assign(Object.create(null), {repeatMode: 'one'});
    Object.defineProperty(patch, key, {value() {calls++;}});
    assert.throws(() => validate(patch), patchError);
  }
  assert.throws(() => validate(Object.create({toJSON() {calls++;}})), patchError);
  assert.equal(calls, 0);
});
