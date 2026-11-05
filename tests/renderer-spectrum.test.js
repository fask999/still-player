'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {createSpectrumController} = require('../src/renderer/glass');
// Public DTO projected from the reviewed peer fixture. This is not host PCM evidence.
const fixture = require('./renderer-spectrum.fixture.json');
const frame = overrides => ({...JSON.parse(JSON.stringify(fixture)), ...overrides});
const player = overrides => ({source: 'local', state: 'playing', available: true, currentTrackId: 'fft-track', generation: 7, ...overrides});
function setup() {
  let clock = 0, serial = 0; const paints = [], timers = new Map(), frames = new Map();
  const controller = createSpectrumController({paint: levels => paints.push(levels), now: () => clock,
    schedule(callback, delay) { const id = ++serial; timers.set(id, {callback, at: clock + delay}); return id; },
    cancel: id => timers.delete(id),
    requestFrame(callback) { const id = ++serial; frames.set(id, callback); return id; },
    cancelFrame: id => frames.delete(id)});
  controller.updatePlayer(player());
  return {controller, paints, timers, frames, receive: (value, rttMs = 0, owner = controller.owner()) => controller.receive(value, {owner, rttMs}),
    advance(ms, {expire = true, draw = true} = {}) {
      clock += ms;
      if (expire) for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback(); }
      if (draw) for (const [id, callback] of [...frames]) { frames.delete(id); callback(clock); }
    }};
}
const approximately = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${actual} to approximate ${expected}`);

test('48 actual low-to-high bands use a fixed dBFS scale and only paint on animation frames', () => {
  const {receive, paints, advance} = setup(), value = frame();
  [-100, -75, -50, -25, 0, 6].forEach((dbfs, i) => { value.bands[24 + i].dbfs = dbfs; value.bands[24 + i].hasBins = true; });
  assert.equal(receive(value), true);
  assert.equal(paints.length, 0);
  advance(48);
  const attack = 1 - Math.exp(-1);
  assert.equal(paints[0].length, 48);
  paints[0].slice(24, 30).forEach((level, index) => approximately(level, [0, .25, .5, .75, 1, 1][index] * attack));
  assert.equal(paints[0][0], 0, 'hasBins=false is no energy'); assert.equal(value.bands[29].dbfs, 6, 'positive measurement is retained, only drawing clamps');
  assert.equal(receive({...value, sequence: 2}), true);
  advance(100); assert.equal(receive({...value, sequence: 3}), true);
  advance(100); assert.equal(receive({...value, sequence: 4}), true);
  advance(25);
  assert.deepEqual(paints.at(-1).slice(24, 30), [0, .25, .5, .75, 1, 1]);
});

test('expiry subtracts age and IPC RTT, and duplicate sequence never extends or revives it', () => {
  const {controller, receive, paints, advance, frames} = setup();
  receive(frame({ageMs: 20}), 30); assert.equal(controller.snapshot().deadline, 200);
  advance(100); const peak = paints.at(-1)[1];
  advance(90); receive(frame({ageMs: 0}), 0); assert.equal(controller.snapshot().deadline, 200);
  const before = paints.at(-1)[1];
  assert.ok(before > 0 && before < peak, 'bars begin to fade before the expiry');
  advance(10);
  assert.equal(controller.snapshot().fresh, false);
  assert.equal(paints.at(-1), null); assert.equal(controller.snapshot().visible, false); assert.equal(frames.size, 0);
  assert.equal(receive(frame({ageMs: 0}), 0), false);
  assert.equal(frames.size, 0);
});

test('mute, pause, Apple and generation changes clear immediately and late work cannot overwrite a new owner', () => {
  const {controller, receive, paints, timers, frames, advance} = setup(); const oldOwner = controller.owner(); receive(frame());
  advance(16);
  const oldFrame = [...frames.values()][0];
  controller.updatePlayer(player({state: 'paused'})); assert.equal(paints.at(-1), null);
  assert.equal(frames.size, 0); assert.equal(timers.size, 0);
  controller.updatePlayer(player()); assert.equal(receive(frame(), 0), false, 'same stream/sequence cannot revive after pause');
  assert.equal(receive(frame({sequence: 2})), true);
  const before = paints.length; oldFrame(); assert.equal(paints.length, before);
  advance(16);
  controller.updatePlayer(player({volume: 0})); assert.equal(controller.snapshot().eligible, false); assert.equal(paints.at(-1), null);
  controller.updatePlayer(player({source: 'apple'})); assert.equal(controller.snapshot().eligible, false);
  controller.updatePlayer(player({generation: 8})); const next = frame({generation: 8, streamId: 'b'.repeat(64)}); receive(next);
  const count = paints.length; receive(frame({sequence: 99}), 0, oldOwner);
  assert.equal(paints.length, count); assert.equal(controller.snapshot().streamId, 'b'.repeat(64));
  advance(16);
  controller.dispose(); assert.equal(paints.at(-1), null); assert.equal(frames.size, 0); assert.equal(timers.size, 0);
  controller.updatePlayer(player()); assert.equal(receive(frame({sequence: 100})), false);
});

test('retired streams, old timers, missing bins and over-age data cannot manufacture a live display', () => {
  const {controller, receive, paints, timers, frames, advance} = setup(); receive(frame()); const oldTimer = [...timers.values()][0].callback;
  receive(frame({streamId: 'b'.repeat(64), sequence: 1})); oldTimer();
  assert.equal(controller.snapshot().fresh, true); const count = paints.length;
  receive(frame({sequence: 999, ageMs: 0})); assert.equal(paints.length, count, 'retired stream ignored');
  receive(frame({streamId: 'b'.repeat(64), sequence: 2, ageMs: 245}), 6); assert.equal(controller.snapshot().fresh, false);
  const bad = frame({streamId: 'b'.repeat(64), sequence: 3}); bad.bands[3].dbfs = NaN;
  assert.equal(receive(bad), false); assert.equal(controller.snapshot().visible, false);
  receive(frame({streamId: 'b'.repeat(64), sequence: 4, ageMs: 245}));
  advance(16, {expire: false});
  assert.equal(frames.size, 0); assert.equal(paints.length, 0, 'a frame which expires before its first paint never lights');
});

test('an unavailable reply decays the drawn levels and a fresh reply can recover before they reach zero', () => {
  const {controller, receive, paints, advance, frames} = setup();
  receive(frame()); advance(120);
  const before = paints.at(-1)[1];
  assert.equal(receive(null), false); assert.equal(controller.snapshot().fresh, false);
  advance(16);
  const dipped = paints.at(-1)[1]; approximately(dipped, before * .84);
  assert.equal(receive(frame({sequence: 2})), true);
  advance(16);
  assert.ok(paints.at(-1)[1] > dipped);
  assert.ok(paints.every(Boolean), 'a brief gap never triggers a flat repaint');
  assert.equal(receive({available: false, trackId: null, source: 'local'}), false);
  for (let tick = 0; tick < 64 && frames.size; tick++) {
    const previous = paints.at(-1)[1];
    advance(16);
    assert.ok((paints.at(-1)?.[1] ?? 0) <= previous);
  }
  assert.equal(paints.at(-1), null); assert.equal(frames.size, 0);
});

test('gaps stop by the earlier of 100ms after loss and the previous freshness deadline', () => {
  for (const {ageMs, stopAt} of [{ageMs: 0, stopAt: 148}, {ageMs: 150, stopAt: 100}]) {
    const {controller, receive, paints, advance, frames, timers} = setup();
    assert.equal(receive(frame({ageMs})), true); advance(48);
    assert.equal(receive(frame({sequence: 2, ageMs: 250})), false, 'over-age packets are not accepted');
    advance(stopAt - 48 - 1);
    assert.ok(paints.at(-1)[1] > 0);
    assert.equal(receive(null), false, 'repeated unavailable packets leave the original stop time intact');
    advance(1, {expire: false});
    assert.equal(controller.snapshot().visible, false); assert.equal(paints.at(-1), null);
    assert.equal(frames.size, 0); assert.equal(timers.size, 0);
  }
});

test('attack and release follow elapsed time across refresh rates and silence keeps the animation idle', () => {
  function renderWithStep(ms) {
    const {controller, receive, paints, advance, frames} = setup();
    const quiet = frame({sequence: 2}); quiet.bands.forEach(band => { band.dbfs = -100; });
    receive(frame());
    for (let t = 0; t < 96; t += ms) advance(ms);
    const peak = paints.at(-1)[1];
    receive(quiet);
    for (let t = 0; t < 96; t += ms) advance(ms);
    const after = paints.at(-1)[1];
    assert.ok(after > 0 && after < peak);
    advance(1200);
    assert.equal(receive({...quiet, sequence: 3}), true);
    assert.equal(controller.snapshot().fresh, true); assert.equal(controller.snapshot().visible, false); assert.equal(frames.size, 0);
    return {peak, after};
  }
  const fast = renderWithStep(8), slow = renderWithStep(32);
  approximately(fast.peak, slow.peak); approximately(fast.after, slow.after);
});
