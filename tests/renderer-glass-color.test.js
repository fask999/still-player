'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {normalize, deriveAccent, contrast, createAccentController, DEFAULT_ACCENT, PRESETS} = require('../src/renderer/glass');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return {promise, resolve, reject}; };
const settings = color => ({appearance: {accentColor: color}});

test('glass accents require exactly six hex digits, with uppercase normalized persistence', () => {
  assert.equal(normalize('#abcDEF'), '#ABCDEF');
  for (const value of ['#fff', '#12345678', ' #123456', '#123456 ', 'var(--accent)', '#12345g', null, 0, {}, 'red']) assert.equal(normalize(value), null);
  assert.equal(PRESETS.length, 8);
  assert.equal(new Set(PRESETS.map(preset => preset[1])).size, 8);
});

test('none mode preserves the selected colour and restoring colour mode uses that confirmed value', async () => {
  const writes = [], paints = [];
  const c = createAccentController({initial: '#E5C49B', save: async (color, mode) => { writes.push({color, mode}); return {appearance: {accentColor: color, accentMode: mode}}; }, paint: (color, mode) => paints.push({color, mode})});
  c.preview('#FF0000', 'color'); c.commitMode('none'); await flush();
  assert.deepEqual(c.snapshotTheme().committed, {accentColor: '#E5C49B', accentMode: 'none'});
  c.commitMode('color'); await flush();
  assert.deepEqual(writes, [{color: '#E5C49B', mode: 'none'}, {color: '#E5C49B', mode: 'color'}]);
  assert.deepEqual(paints.at(-1), {color: '#E5C49B', mode: 'color'});
});

test('a failed colour-and-mode transaction restores both confirmed fields even after the dialog closes', async () => {
  const wait = deferred(), paints = [], errors = [];
  const c = createAccentController({initial: '#92D5BC', initialMode: 'none', save: () => wait.promise, paint: (color, mode) => paints.push({color, mode}), onError: () => errors.push(true)});
  c.commit('#E5C49B', 'color'); c.cancelPreview(); wait.reject(new Error('disk full')); await flush();
  assert.deepEqual(c.snapshotTheme().draft, {accentColor: '#92D5BC', accentMode: 'none'});
  assert.deepEqual(paints.at(-1), {color: '#92D5BC', mode: 'none'}); assert.equal(errors.length, 1);
});

test('an older colour response cannot erase a newer none-mode intent', async () => {
  const first = deferred(), second = deferred(), writes = [], paints = [];
  const c = createAccentController({initial: '#92D5BC', save: (color, mode) => { writes.push({color, mode}); return writes.length === 1 ? first.promise : second.promise; }, paint: (color, mode) => paints.push({color, mode})});
  c.commit('#E5C49B', 'color'); c.commitMode('none');
  first.resolve({appearance: {accentColor: '#E5C49B', accentMode: 'color'}}); await flush();
  assert.deepEqual(paints.at(-1), {color: '#E5C49B', mode: 'none'});
  assert.deepEqual(writes[1], {color: '#E5C49B', mode: 'none'});
  second.resolve({appearance: {accentColor: '#E5C49B', accentMode: 'none'}}); await flush();
  assert.equal(c.snapshotTheme().committed.accentMode, 'none');
});

test('arbitrary accents retain readable foregrounds and solid button ink, including black and white', () => {
  const colors = ['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#777777', '#808080', ...PRESETS.map(preset => preset[1])];
  // Deterministic coverage over the RGB cube catches intermediate-luminance ink gaps.
  for (let r = 0; r <= 255; r += 17) for (let g = 0; g <= 255; g += 17) for (let b = 0; b <= 255; b += 17) colors.push('#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join(''));
  for (const color of colors) {
    const result = deriveAccent(color);
    assert.equal(result.raw, color.toUpperCase());
    assert.ok(contrast(result.readable, '#465161') >= 4.5, `${color} foreground ${result.readable}`);
    assert.ok(contrast(result.ink, result.raw) >= 4.5, `${color} button ink ${result.ink}`);
  }
  assert.equal(deriveAccent('url(file:///secret)').raw, DEFAULT_ACCENT);
});

test('color pointer previews issue no persistence and invalid drafts never reach save', () => {
  const writes = [], paints = [];
  const c = createAccentController({save: value => { writes.push(value); return Promise.resolve(settings(value)); }, paint: value => paints.push(value)});
  for (const value of ['#000000', '#777777', '#FFFFFF']) c.preview(value);
  assert.deepEqual(writes, []);
  assert.equal(c.snapshot().committed, DEFAULT_ACCENT);
  assert.equal(c.snapshot().draft, '#FFFFFF');
  assert.equal(c.commit('#FFF'), false);
  assert.deepEqual(writes, []);
  c.cancelPreview(); assert.equal(paints.at(-1), DEFAULT_ACCENT);
});

test('accent saves serialize and coalesce rapid selections so an old result cannot replace a newer preview', async () => {
  const first = deferred(), last = deferred(), writes = [], paints = [];
  const c = createAccentController({save: value => { writes.push(value); return writes.length === 1 ? first.promise : last.promise; }, paint: value => paints.push(value)});
  c.commit('#000000'); c.commit('#777777'); c.commit('#FFFFFF');
  assert.deepEqual(writes, ['#000000']);
  c.receive('#000000'); assert.equal(paints.at(-1), '#FFFFFF');
  first.resolve(settings('#000000')); await flush();
  assert.deepEqual(writes, ['#000000', '#FFFFFF']);
  assert.equal(paints.at(-1), '#FFFFFF');
  assert.equal(c.snapshot().committed, '#000000');
  last.resolve(settings('#FFFFFF')); await flush();
  assert.deepEqual(c.snapshot(), {committed: '#FFFFFF', draft: '#FFFFFF', busy: false});
});

test('a failed newest save restores the last confirmed readback, including after the dialog closes', async () => {
  const pending = deferred(), paints = [], errors = [];
  const c = createAccentController({initial: '#92D5BC', save: () => pending.promise, paint: value => paints.push(value), onError: () => errors.push('save failed')});
  c.commit('#000000'); c.cancelPreview(); pending.reject(new Error('disk full')); await flush();
  assert.equal(paints.at(-1), '#92D5BC');
  assert.equal(c.snapshot().committed, '#92D5BC');
  assert.deepEqual(errors, ['save failed']);
});

test('a pending old save cannot erase a newer uncommitted text preview', async () => {
  const pending = deferred(), paints = [];
  const c = createAccentController({save: () => pending.promise, paint: value => paints.push(value)});
  c.commit('#000000'); c.preview('#FFFFFF'); pending.resolve(settings('#000000')); await flush();
  assert.equal(c.snapshot().committed, '#000000');
  assert.equal(paints.at(-1), '#FFFFFF');
  c.cancelPreview(); assert.equal(paints.at(-1), '#000000');
});

test('failed queued save rolls back to the prior successful commit instead of bootstrap defaults', async () => {
  const first = deferred(), second = deferred(), paints = [];
  let calls = 0;
  const c = createAccentController({save: () => ++calls === 1 ? first.promise : second.promise, paint: value => paints.push(value)});
  c.commit('#92D5BC'); c.commit('#FFFFFF'); first.resolve(settings('#92D5BC')); await flush();
  second.resolve(null); await flush();
  assert.equal(paints.at(-1), '#92D5BC');
  assert.equal(c.snapshot().committed, '#92D5BC');
});
