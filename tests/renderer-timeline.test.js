'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const timeline = require('../src/renderer/timeline');
const lines = [{startMs: 1000, endMs: 2900, words: [{startMs: 1000, endMs: 1600}, {startMs: 1600, endMs: 2900}]}, {startMs: 3000, endMs: 5000}];
test('actual line timestamps, gaps and positive delay determine the current line', () => {
  assert.equal(timeline.lineIndex(lines, 0.9, 0), -1);
  assert.equal(timeline.lineIndex(lines, 1.2, 500), -1);
  assert.equal(timeline.lineIndex(lines, 1.6, 500), 0);
  assert.equal(timeline.lineIndex(lines, 3.45, 500), -1);
  assert.equal(timeline.lineIndex(lines, 3.5, 500), 1);
});
test('word progress uses real start/end and never fabricates timing', () => {
  assert.equal(timeline.wordProgress(lines[0].words[0], 1.3, 0), 0.5);
  assert.equal(timeline.wordProgress(lines[0].words[0], 2, 0), 1);
  assert.equal(timeline.wordProgress({text: '无时间'}, 2, 0), null);
});
test('line seek applies positive delay and clamps negative offsets', () => {
  assert.equal(timeline.seekPosition(lines[0], 500), 1.5);
  assert.equal(timeline.seekPosition(lines[0], -2000), 0);
  assert.equal(timeline.seekPosition({text: '无时间'}, 0), null);
});
test('plain and empty timestamps never become zero-time lyric lines', () => {
  const plain = [{startMs: null, text: 'one'}, {startMs: undefined, text: 'two'}, {startMs: '', text: 'three'}, {startMs: '  ', text: 'four'}];
  assert.equal(timeline.lineIndex(plain, 0, 0), -1);
  assert.equal(timeline.lineIndex(plain, 100, 0), -1);
  assert.equal(timeline.seekPosition(plain[0], 0), null);
  assert.equal(timeline.seekPosition(plain[3], 0), null);
  assert.equal(timeline.wordProgress({startMs: ' ', endMs: 1000}, 0.5, 0), null);
  assert.equal(timeline.lineIndex([{startMs: 0, endMs: ''}], 1, 0), 0);
});
