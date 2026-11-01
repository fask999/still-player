'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createSpectrumController} = require('../src/renderer/glass');
// Public DTO projected from the reviewed peer fixture. This is not host PCM evidence.
const fixture = require('./renderer-spectrum.fixture.json');
const frame = overrides => ({...JSON.parse(JSON.stringify(fixture)), ...overrides});
const player = overrides => ({source: 'local', state: 'playing', available: true, currentTrackId: 'fft-track', generation: 7, ...overrides});
function setup() {
  let clock = 0, serial = 0; const paints = [], timers = new Map();
  const controller = createSpectrumController({paint: levels => paints.push(levels), now: () => clock,
    schedule(callback, delay) { const id = ++serial; timers.set(id, {callback, at: clock + delay}); return id; }, cancel(id) { timers.delete(id); }});
  controller.updatePlayer(player());
  return {controller, paints, timers, receive: (value, rttMs = 0, owner = controller.owner()) => controller.receive(value, {owner, rttMs}),
    advance(ms) { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback(); } }};
}

test('48 actual low-to-high bands map fixed dBFS values with no envelope or per-frame normalization', () => {
  const {receive, paints} = setup(), value = frame();
  [-100, -75, -50, -25, 0, 6].forEach((dbfs, i) => { value.bands[24 + i].dbfs = dbfs; value.bands[24 + i].hasBins = true; });
  assert.equal(receive(value), true);
  assert.equal(paints[0].length, 48); assert.deepEqual(paints[0].slice(24, 30), [0, .25, .5, .75, 1, 1]);
  assert.equal(paints[0][0], 0, 'hasBins=false is no energy'); assert.equal(value.bands[29].dbfs, 6, 'positive measurement is retained, only drawing clamps');
  const flat = frame({sequence: 2}); flat.bands.forEach(band => { band.dbfs = -60; band.hasBins = true; }); receive(flat);
  assert.ok(paints[1].every(level => level === .4));
});

test('expiry subtracts age and IPC RTT, and duplicate sequence never extends or revives it', () => {
  const {controller, receive, paints, advance} = setup();
  receive(frame({ageMs: 20}), 30); assert.equal(controller.snapshot().deadline, 200);
  advance(190); receive(frame({ageMs: 0}), 0); assert.equal(controller.snapshot().deadline, 200);
  advance(10); assert.equal(paints.at(-1), null); assert.equal(controller.snapshot().visible, false);
  receive(frame({ageMs: 0}), 0); assert.equal(controller.snapshot().visible, false);
  assert.equal(paints.filter(Boolean).length, 1);
});

test('pause, Apple and generation changes clear immediately; late owners cannot overwrite the new stream', () => {
  const {controller, receive, paints} = setup(); const oldOwner = controller.owner(); receive(frame());
  controller.updatePlayer(player({state: 'paused'})); assert.equal(paints.at(-1), null);
  controller.updatePlayer(player()); assert.equal(receive(frame(), 0), false, 'same stream/sequence cannot revive after pause');
  assert.equal(receive(frame({sequence: 2})), true);
  controller.updatePlayer(player({source: 'apple'})); assert.equal(controller.snapshot().eligible, false);
  controller.updatePlayer(player({generation: 8})); const next = frame({generation: 8, streamId: 'b'.repeat(64)}); receive(next);
  const count = paints.length; receive(frame({sequence: 99}), 0, oldOwner);
  assert.equal(paints.length, count); assert.equal(controller.snapshot().streamId, 'b'.repeat(64));
});

test('retired streams, old timers, missing bins and over-age data cannot manufacture a live display', () => {
  const {controller, receive, paints, timers} = setup(); receive(frame()); const oldTimer = [...timers.values()][0].callback;
  receive(frame({streamId: 'b'.repeat(64), sequence: 1})); oldTimer();
  assert.equal(controller.snapshot().visible, true); const count = paints.length;
  receive(frame({sequence: 999, ageMs: 0})); assert.equal(paints.length, count, 'retired stream ignored');
  receive(frame({streamId: 'b'.repeat(64), sequence: 2, ageMs: 245}), 6); assert.equal(controller.snapshot().visible, false);
  const bad = frame({streamId: 'b'.repeat(64), sequence: 3}); bad.bands[3].dbfs = NaN;
  assert.equal(receive(bad), false); assert.equal(controller.snapshot().visible, false);
  receive(frame({streamId: 'b'.repeat(64), sequence: 4})); receive({available: false, trackId: null, source: 'local'});
  assert.equal(paints.at(-1), null, 'an unavailable current reply clears even without an identity');
});

test('late identity/older sequence replies keep a newer valid display, while duplicate age can only shorten expiry', () => {
  const {controller, receive, paints, advance} = setup(); receive(frame({sequence: 10, ageMs: 10}));
  const original = controller.snapshot().deadline; advance(40);
  for (const old of [frame({sequence: 9, ageMs: 200}), frame({generation: 6, sequence: 11}), frame({source: 'apple', sequence: 11}), {...frame({generation: 6}), available: false, status: 'unavailable'}]) receive(old);
  assert.equal(paints.length, 1); assert.equal(controller.snapshot().visible, true); assert.equal(controller.snapshot().deadline, original);
  receive(frame({sequence: 10, ageMs: 180}), 10);
  assert.equal(controller.snapshot().deadline, 100); assert.equal(controller.snapshot().visible, true);
  receive(frame({sequence: 10, ageMs: 0})); assert.equal(controller.snapshot().deadline, 100);
  advance(60); assert.equal(controller.snapshot().visible, false); assert.equal(paints.at(-1), null);
});
