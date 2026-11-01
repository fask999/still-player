'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLyrics, alignTranslation, decodeLyricBuffer, candidateMatchesTrack, supportedFormats } = require('../src/main/lyrics');

test('LRC supports metadata, fractional timestamps, hours, repeated lines and source offset', () => {
  const result = parseLyrics('[ti:Song]\n[ar:Artist]\n[offset:100]\n[00:01.2][00:03.200]Repeat\n[01:02:03.004]Last');
  assert.equal(result.status, 'ready');
  assert.equal(result.kind, 'line');
  assert.equal(result.metadata.ti, 'Song');
  assert.equal(result.embeddedOffsetMs, 100);
  assert.deepEqual(result.lines.map(line => line.startMs), [1100, 3100, 3722904]);
  assert.equal(result.lines[0].endMs, 3100);
  assert.equal(result.timingEvidence.wordTimestamps, 0);
  assert.ok(result.lines.every(line => !line.words));
});

test('enhanced LRC uses actual word timestamps and explicit final endpoint', () => {
  const result = parseLyrics('[00:01.000]<00:01.000>Hello <00:01.400>world<00:02.100>\n[00:03]Next');
  assert.equal(result.kind, 'word');
  assert.equal(result.format, 'enhanced-lrc');
  assert.equal(result.lines[0].text, 'Hello world');
  assert.deepEqual(result.lines[0].words, [
    { startMs: 1000, endMs: 1400, text: 'Hello ' }, { startMs: 1400, endMs: 2100, text: 'world' },
  ]);
  assert.equal(result.lines[1].words, undefined);
  assert.equal(result.timingEvidence.wordTimestamps, 2);
});

test('repeated enhanced LRC does not manufacture shifted word timestamps', () => {
  const result = parseLyrics('[00:01][00:05]<00:01>First<00:02>');
  assert.ok(result.lines[0].words);
  assert.equal(result.lines[1].words, undefined);
});

test('YRC parses absolute word starts and durations; JSON translation aligns by timestamps', () => {
  const result = parseLyrics(JSON.stringify({
    yrc: { lyric: '{"t":0,"c":[{"tx":"Credit"}]}\n[1000,1200](1000,400,0)你(1400,800,0)好\n[4000,500](4000,500,0)尾' },
    ytlrc: { lyric: '[00:00.100]unmatched\n[00:04.000]End\n[00:01.000]Hello' },
  }), { format: 'json' });
  assert.equal(result.status, 'ready');
  assert.equal(result.kind, 'word');
  assert.equal(result.lines[0].text, '你好');
  assert.equal(result.lines[0].translation, 'Hello');
  assert.equal(result.lines[1].translation, 'End');
  assert.deepEqual(result.lines[0].words[1], { startMs: 1400, endMs: 2200, text: '好' });
});

test('QRC plaintext and XML entities preserve actual per-word timing', () => {
  const raw = '[1000,1200]你(1000,400)好(1400,800)';
  const result = parseLyrics(raw, { format: 'qrc' });
  assert.equal(result.kind, 'word');
  assert.deepEqual(result.lines[0].words[0], { startMs: 1000, endMs: 1400, text: '你' });
  const xml = '<?xml version="1.0"?><QrcInfos><LyricInfo><Lyric_1 LyricType="1" LyricContent="[1000,1000]A &amp; &quot;B&quot;(1000,1000)&#10;[3000,500]尾(3000,500)"/></LyricInfo></QrcInfos>';
  const parsed = parseLyrics(xml, { format: 'qrc' });
  assert.equal(parsed.status, 'ready');
  assert.equal(parsed.lines[0].text, 'A & "B"');
  assert.equal(parsed.lines.length, 2);
});

test('SRT exposes line timing, strips styling and retains multiline cues', () => {
  const result = parseLyrics('1\n00:00:01,000 --> 00:00:02,500\n<i>Hello</i>\nWorld\n\n2\n00:00:04,000 --> 00:00:05,000\nEnd', { format: 'srt' });
  assert.equal(result.kind, 'line');
  assert.equal(result.format, 'srt');
  assert.deepEqual(result.lines[0], { startMs: 1000, endMs: 2500, text: 'Hello\nWorld' });
  assert.ok(supportedFormats.includes('srt'));
});

test('plain text and explicit instrumental markers stay untimed', () => {
  const plain = parseLyrics('First line\nSecond line', { format: 'txt' });
  assert.equal(plain.status, 'plain');
  assert.equal(plain.kind, 'plain');
  assert.deepEqual(plain.lines, []);
  assert.equal(plain.plainText, 'First line\nSecond line');
  assert.equal(parseLyrics('纯音乐，请欣赏').status, 'plain'); // punctuation alone is not an unsupported guess
  assert.equal(parseLyrics('[Instrumental]').status, 'instrumental');
  assert.equal(parseLyrics('[instrumental:true]').status, 'instrumental');
});

test('empty, damaged, encrypted, HTML and inconsistent timestamps are parse errors', () => {
  const cases = [
    '', '[ar:Only metadata]', '[00:xx]Broken', '[00:99]Broken', '[00:01]Good\n[00:x]Broken',
    '[00:02]<00:01>Backwards', '[00:01]<00:01.2>valid<00:x>bad',
    '[1000,500](1000,900,0)Too long', '[1000,500]Word(1000,900)',
    '<html><body>Cloud error</body></html>', '{"yrc":', JSON.stringify({ lyric: 'ab'.repeat(100) }),
    '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]><QrcInfos/>',
  ];
  for (const input of cases) assert.equal(parseLyrics(input).status, 'parse-error', input);
  assert.equal(parseLyrics(Buffer.from([0x98, 0, 0x16, 0xFF]), { format: 'qrc' }).status, 'parse-error');
});

test('translations align by timestamp without shifting when a line is absent or reordered', () => {
  const original = [{ startMs: 1000, text: 'One' }, { startMs: 2000, text: 'Two' }, { startMs: 3000, text: 'Three' }];
  const translation = [{ startMs: 3000, text: '三' }, { startMs: 1000, text: '一' }, { startMs: 9000, text: 'No match' }];
  const result = alignTranslation(original, translation);
  assert.deepEqual(result.map(line => line.translation), ['一', undefined, '三']);
  assert.equal(original[0].translation, undefined);
  assert.equal(alignTranslation(original, [{ startMs: 1100, text: 'Near' }])[0].translation, undefined);
  assert.equal(alignTranslation(original, [{ startMs: 1100, text: 'Near' }], { toleranceMs: 120 })[0].translation, 'Near');
  assert.equal(alignTranslation([{ startMs: 1000, text: 'A' }, { startMs: 1100, text: 'B' }], [{ startMs: 1050, text: 'Ambiguous' }], { toleranceMs: 100 })[0].translation, undefined);
});

test('translation file offsets normalize independently before exact matching', () => {
  const result = parseLyrics('[offset:100]\n[00:01.100]One\n[00:02.100]Two', { translation: '[offset:-100]\n[00:00.900]一\n[00:01.900]二' });
  assert.deepEqual(result.lines.map(line => line.translation), ['一', '二']);
});

test('untimed translations remain full text without invented row alignment', () => {
  const plain = parseLyrics(JSON.stringify({ lyric: 'One\nTwo\nThree', translation: '一和二\n三' }));
  assert.equal(plain.kind, 'plain');
  assert.equal(plain.plainTranslation, '一和二\n三');
  assert.deepEqual(plain.lines, []);
  const timed = parseLyrics('[00:01]One\n[00:02]Two', { translation: '一句完整的译文' });
  assert.equal(timed.plainTranslation, '一句完整的译文');
  assert.ok(timed.lines.every(line => line.translation === undefined));
  assert.match(timed.translationWarning, /完整文本/);
  const untimedOriginal = parseLyrics('One\nTwo', { translation: '[00:02]二\n[00:01]一' });
  assert.equal(untimedOriginal.plainTranslation, '一\n二');
  assert.deepEqual(untimedOriginal.lines, []);
});

test('real GBK and GB18030 bytes decode Chinese and supplementary characters; damaged sequences fail', () => {
  // CP936 D6 D0 CE C4 = 中文. GB18030 95 32 82 36 = U+20000 (𠀀).
  const prefix = Buffer.from('[00:01]');
  const gbk = Buffer.concat([prefix, Buffer.from([0xD6, 0xD0, 0xCE, 0xC4])]);
  assert.equal(decodeLyricBuffer(gbk), '[00:01]中文');
  assert.equal(parseLyrics(gbk).lines[0].text, '中文');
  const gb18030 = Buffer.concat([gbk, Buffer.from([0x95, 0x32, 0x82, 0x36])]);
  assert.equal(parseLyrics(gb18030).lines[0].text, '中文𠀀');
  assert.equal(parseLyrics(Buffer.concat([prefix, Buffer.from([0xD6])])).status, 'parse-error');
  assert.equal(parseLyrics(Buffer.concat([prefix, Buffer.from([0x95, 0x32, 0x82])])).status, 'parse-error');
});

test('decodes UTF-8 and BOM UTF-16 without treating binary QRC as text', () => {
  const source = '[00:01]你好';
  assert.equal(decodeLyricBuffer(Buffer.from(source)), source);
  assert.equal(decodeLyricBuffer(Buffer.concat([Buffer.from([255, 254]), Buffer.from(source, 'utf16le')])), source);
  const be = Buffer.from(source, 'utf16le'); be.swap16();
  assert.equal(decodeLyricBuffer(Buffer.concat([Buffer.from([254, 255]), be])), source);
  assert.throws(() => decodeLyricBuffer(Buffer.from([0, 1, 2])));
});

test('automatic metadata matching retains live versions, albums, artists and duration limits', () => {
  const track = { title: 'Example', artist: 'Artist', album: 'Album', duration: 180 };
  const record = { trackName: 'EXAMPLE', artistName: 'Artist', albumName: 'Album', duration: 181.9 };
  assert.equal(candidateMatchesTrack(record, track), true);
  assert.equal(candidateMatchesTrack({ ...record, trackName: 'Example (Live)' }, track), false);
  assert.equal(candidateMatchesTrack({ ...record, trackName: 'Example (2011 Remaster)' }, track), false);
  assert.equal(candidateMatchesTrack({ ...record, artistName: 'Other' }, track), false);
  assert.equal(candidateMatchesTrack({ ...record, albumName: 'Other album' }, track), false);
  assert.equal(candidateMatchesTrack({ ...record, duration: 183 }, track), false);
  assert.equal(candidateMatchesTrack({ ...record, duration: null }, track), false);
});
