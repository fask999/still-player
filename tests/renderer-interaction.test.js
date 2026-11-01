'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {createSleeveGesture, contextNeighbors} = require('../src/renderer/glass');

function gesture() {
  const commands = [], previews = []; let time = 0;
  const controller = createSleeveGesture({commit: (direction, key) => commands.push({direction, key}), preview: (...value) => previews.push(value), now: () => time});
  const begin = () => controller.start({pointerId: 1, x: 100, y: 100, width: 400, key: 'local:a:1'});
  return {controller, commands, previews, begin, advance: value => { time += value; }};
}

test('one horizontal gesture emits at most one direction after the explicit width threshold', () => {
  const {controller, commands, begin} = gesture(); begin();
  controller.move({pointerId: 1, x: 40, y: 106});
  assert.equal(controller.end({pointerId: 1, key: 'local:a:1'}), true);
  controller.end({pointerId: 1, key: 'local:a:1'});
  assert.deepEqual(commands, [{direction: 'next', key: 'local:a:1'}]);
  begin(); controller.move({pointerId: 1, x: 175, y: 96}); controller.end({pointerId: 1, key: 'local:a:1'});
  assert.equal(commands.at(-1).direction, 'previous');
});

test('vertical intent locks out track changes and short horizontal drags settle without a command', () => {
  const {controller, commands, previews, begin} = gesture(); begin();
  assert.equal(controller.move({pointerId: 1, x: 104, y: 125}), false);
  controller.move({pointerId: 1, x: 240, y: 127}); controller.end({pointerId: 1, key: 'local:a:1'});
  assert.equal(commands.length, 0);
  begin(); controller.move({pointerId: 1, x: 135, y: 103}); controller.end({pointerId: 1, key: 'local:a:1'});
  assert.equal(commands.length, 0); assert.deepEqual(previews.at(-1), [0, false]);
});

test('cancel, changed playback identity and another pointer cannot commit an old swipe', () => {
  for (const cancel of ['cancel', 'identity', 'end-key']) {
    const {controller, commands, begin} = gesture(); begin(); controller.move({pointerId: 1, x: 10, y: 100});
    if (cancel === 'cancel') controller.cancel();
    if (cancel === 'identity') controller.cancelIfChanged('apple:b:2');
    controller.end({pointerId: 1, key: cancel === 'end-key' ? 'local:a:2' : 'local:a:1'});
    assert.equal(commands.length, 0, cancel);
  }
  const {controller, commands, begin} = gesture(); begin();
  controller.move({pointerId: 2, x: 0, y: 100}); controller.end({pointerId: 2, key: 'local:a:1'});
  controller.end({pointerId: 1, key: 'local:a:1'}); assert.equal(commands.length, 0);
});

test('drag-tail click suppression never swallows keyboard activation or a fresh intentional tap', () => {
  const {controller, begin, advance} = gesture(); begin(); controller.move({pointerId: 1, x: 30, y: 100}); controller.end({pointerId: 1, key: 'local:a:1'});
  assert.equal(controller.consumeClick(0), false); assert.equal(controller.consumeClick(1), true); assert.equal(controller.consumeClick(1), false);
  begin(); controller.move({pointerId: 1, x: 20, y: 100}); controller.cancel(); advance(500); assert.equal(controller.consumeClick(1), false);
  begin(); controller.move({pointerId: 1, x: 20, y: 100}); controller.cancel(); begin(); controller.end({pointerId: 1, key: 'local:a:1'}); assert.equal(controller.consumeClick(1), false);
});

function context(overrides = {}) {
  return {source: 'local', status: 'ready', contextId: 'ctx', generation: 3, currentIndex: 1, capabilities: {select: false, predictNeighbors: true}, items: [0, 1, 2, 3].map(index => ({index, key: `ctx:${index}`, trackId: 'same-track', playable: true})), ...overrides};
}

test('real context neighbors preserve repeated track occurrences and never wrap or invent missing indices', () => {
  const p = {source: 'local', generation: 3};
  const neighbors = contextNeighbors(p, context());
  assert.equal(neighbors.previous.key, 'ctx:0'); assert.equal(neighbors.next.key, 'ctx:2'); assert.equal(neighbors.nextOuter.key, 'ctx:3'); assert.equal(neighbors.previousOuter, null);
  const gaps = context({currentIndex: 0, items: [{index: 0, key: '0', playable: true}, {index: 2, key: '2', playable: true}]});
  assert.equal(contextNeighbors(p, gaps).next, null); assert.equal(contextNeighbors(p, gaps).nextOuter.key, '2');
});

test('stale or mismatched context is rejected while unknown navigation keeps genuine list neighbors passive', () => {
  const p = {source: 'local', generation: 3};
  for (const value of [null, context({status: 'unknown'}), context({source: 'apple'}), context({generation: 2}), context({currentIndex: null}), context({contextId: null}), context({items: [null]}), context({items: [{index: 1, key: 'a'}, {index: 1, key: 'b'}]})]) assert.equal(contextNeighbors(p, value), null);
  for (const capabilities of [{select: false}, {select: false, predictNeighbors: false}]) {
    const neighbors = contextNeighbors(p, context({capabilities})); assert.equal(neighbors.next.key, 'ctx:2'); assert.equal(neighbors.canNavigate, false);
  }
  const invalid = context({items: [{index: 1, key: 'current', playable: true}, {index: 2, key: 'bad', playable: false}]});
  assert.equal(contextNeighbors(p, invalid).next.key, 'bad'); assert.equal(contextNeighbors(p, invalid).next.playable, false);
});
