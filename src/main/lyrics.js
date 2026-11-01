'use strict';

// Original implementation. These parsers do not load ESLyric scripts or native decoders.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { sourceUrl: qqSourceUrl, validRecord: validQqRecord, SOURCE: QQ_SOURCE } = require('./qq-lyrics');

const supportedFormats = Object.freeze(['lrc', 'yrc', 'qrc', 'txt', 'json', 'srt']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TIMELINE_MS = 24 * 60 * 60 * 1000;
const SUCCESS = new Set(['ready', 'plain', 'instrumental']);
const LRCLIB_URL = 'https://lrclib.net/api';
const USER_AGENT = 'STILL/0.1.0 (desktop music player; read-only LRCLIB client)';

class LyricsError extends Error {
  constructor(message, status = 'parse-error', code = 'INVALID_LYRICS') {
    super(message);
    this.name = 'LyricsError';
    this.status = status;
    this.code = code;
  }
}

function clone(value) { return structuredClone(value); }
function fail(message) { throw new LyricsError(message); }
function ms(value, name = '时间戳') {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_TIMELINE_MS) fail(`${name}无效。`);
  return number;
}
function textInput(input) {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) input = decodeLyricBuffer(input);
  if (typeof input !== 'string') fail('歌词内容必须是文本。');
  if (Buffer.byteLength(input, 'utf8') > MAX_FILE_BYTES) fail('歌词文件超过 2 MiB 上限。');
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) fail('歌词文件为空。');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) fail('文件包含二进制数据；加密 QRC 需要先导出为明文。');
  if (/<(?:!doctype\s+html|html\b|body\b)/i.test(text)) fail('收到的是 HTML 页面，无法作为歌词解析。');
  return text;
}

function decodeLyricBuffer(input) {
  const buffer = Buffer.from(input);
  if (buffer.length > MAX_FILE_BYTES) fail('歌词文件超过 2 MiB 上限。');
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) return new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2));
  if (buffer[0] === 0xFE && buffer[1] === 0xFF) return new TextDecoder('utf-16be', { fatal: true }).decode(buffer.subarray(2));
  // Encrypted QRC containers are not text and must never become an apparent plain lyric.
  if (buffer.includes(0)) fail('文件包含二进制数据；不支持直接解密 QRC。');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch {
    try { return new TextDecoder('gb18030', { fatal: true }).decode(buffer); }
    catch { fail('歌词编码无效。请导出为 UTF-8、UTF-16 或 GB18030 文本。'); }
  }
}

function timestamp(value) {
  const match = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(value);
  if (!match || Number(match[3]) >= 60 || (match[1] && Number(match[2]) >= 60)) fail(`无效歌词时间戳：${value}`);
  return ms(Number(match[1] || 0) * 3600000 + Number(match[2]) * 60000 + Number(match[3]) * 1000 + Number((match[4] || '').padEnd(3, '0')));
}

function metadataLine(line, metadata) {
  const match = /^\[([a-zA-Z][\w-]*):([^\]]*)\]\s*$/.exec(line);
  if (!match) return false;
  const key = match[1].toLowerCase();
  metadata[key] = match[2].trim();
  if (key === 'offset' || key === 'manualoffset') {
    if (!/^[+-]?\d+$/.test(metadata[key]) || Math.abs(Number(metadata[key])) > MAX_TIMELINE_MS) fail('文件内 offset 无效。');
    metadata.offsetMs = Number(metadata[key]);
  }
  return true;
}

function finishTimed(lines, format, metadata = {}, durationMs) {
  lines.sort((a, b) => a.startMs - b.startMs);
  if (!lines.some(line => line.text.trim())) fail('未找到有效的歌词正文。');
  const embeddedOffsetMs = metadata.offsetMs || 0;
  const lastDuration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined;
  const nextStarts = new Array(lines.length);
  let nextDistinct;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (index < lines.length - 1 && lines[index + 1].startMs > lines[index].startMs) nextDistinct = lines[index + 1].startMs;
    nextStarts[index] = nextDistinct;
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.endMs === undefined) {
      const wordEnd = line.words?.length ? Math.max(...line.words.map(word => word.endMs ?? word.startMs)) : undefined;
      const end = nextStarts[index] ?? lastDuration ?? wordEnd;
      if (end !== undefined && end >= line.startMs) line.endMs = end;
    }
    if (line.words) {
      for (let wordIndex = 0; wordIndex < line.words.length; wordIndex += 1) {
        const word = line.words[wordIndex];
        if (word.endMs === undefined) word.endMs = Math.max(word.startMs, line.words[wordIndex + 1]?.startMs ?? line.endMs ?? word.startMs);
        if (word.endMs < word.startMs) fail('逐词时间戳顺序无效。');
        word.startMs -= embeddedOffsetMs;
        word.endMs -= embeddedOffsetMs;
      }
    }
    line.startMs -= embeddedOffsetMs;
    if (line.endMs !== undefined) line.endMs -= embeddedOffsetMs;
  }
  const wordCount = lines.reduce((count, line) => count + (line.words?.length || 0), 0);
  return {
    status: 'ready', kind: wordCount ? 'word' : 'line', lines, format, metadata, embeddedOffsetMs,
    timingEvidence: { format, lineTimestamps: lines.length, wordTimestamps: wordCount, wordTiming: wordCount ? 'source-timestamps' : 'none' },
  };
}

function parseLrc(input, options = {}) {
  const text = textInput(input);
  const metadata = {};
  const lines = [];
  const plainLines = [];
  let malformed = false;
  for (const raw of text.split('\n')) {
    const rawLine = raw.trim();
    if (!rawLine || metadataLine(rawLine, metadata)) continue;
    const stampMatches = [...rawLine.matchAll(/\[([^\]]+)\]/g)];
    let prefixEnd = 0;
    const starts = [];
    for (const match of stampMatches) {
      if (match.index !== prefixEnd) break;
      if (!/^\d+:/.test(match[1])) break;
      try { starts.push(timestamp(match[1])); }
      catch { malformed = true; }
      prefixEnd = match.index + match[0].length;
    }
    if (!starts.length) {
      if (/^\[\d/.test(rawLine) || /<\d+:/.test(rawLine)) malformed = true;
      else plainLines.push(raw);
      continue;
    }
    const body = rawLine.slice(prefixEnd);
    const tags = [...body.matchAll(/<([^>]+)>/g)].filter(match => /^\d+:/.test(match[1]));
    const words = [];
    let bodyText = body;
    if (tags.length) {
      let previous = -1;
      for (let index = 0; index < tags.length; index += 1) {
        const tag = tags[index];
        const startMs = timestamp(tag[1]);
        if (startMs < previous || startMs < starts[0]) fail('增强 LRC 的词时间戳逆序或早于行时间戳。');
        previous = startMs;
        const next = tags[index + 1];
        const fragment = body.slice(tag.index + tag[0].length, next?.index ?? body.length);
        if (fragment) words.push({ startMs, ...(next ? { endMs: timestamp(next[1]) } : {}), text: fragment });
      }
      bodyText = body.replace(/<\d+:[^>]*>/g, '');
    }
    if (/<\d+:/.test(bodyText)) fail('增强 LRC 的词时间戳损坏。');
    for (let index = 0; index < starts.length; index += 1) {
      // A repeated line stamp is not evidence for shifted word stamps.
      lines.push({ startMs: starts[index], text: bodyText, ...(index === 0 && words.length ? { words } : {}) });
    }
  }
  if (malformed) fail('LRC 中含有损坏的时间戳。');
  if (lines.length) return finishTimed(lines, lines.some(line => line.words?.length) ? 'enhanced-lrc' : 'lrc', metadata, options.durationMs);
  if (!plainLines.some(line => line.trim())) {
    if (metadata.instrumental === 'true') return plainResult('[Instrumental]', metadata);
    fail('歌词只有元数据，没有正文。');
  }
  return plainResult(plainLines.join('\n').trim(), metadata);
}

function parseYrc(input, options = {}) {
  const text = textInput(input);
  const metadata = {};
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || metadataLine(line, metadata)) continue;
    // YRC may contain JSON credit entries; they are not timed singing words.
    if (/^\{/.test(line)) {
      try { const credit = JSON.parse(line); if (typeof credit.t === 'number' && Array.isArray(credit.c)) continue; } catch { /* rejected below */ }
    }
    const head = /^\[(\d+),(\d+)\]/.exec(line);
    if (!head) fail('YRC 行时间戳无效。');
    const startMs = ms(head[1]);
    const endMs = startMs + ms(head[2], '行时长');
    if (endMs > MAX_TIMELINE_MS) fail('YRC 行结束时间无效。');
    const body = line.slice(head[0].length);
    const tokens = [...body.matchAll(/\((\d+),(\d+),(\d+)\)/g)];
    if (!tokens.length || body.slice(0, tokens[0].index).trim()) fail('YRC 缺少有效的逐词时间戳。');
    const words = tokens.map((token, index) => {
      const wordStart = ms(token[1]);
      const wordEnd = wordStart + ms(token[2], '词时长');
      const wordText = body.slice(token.index + token[0].length, tokens[index + 1]?.index ?? body.length);
      if (wordStart < startMs || wordEnd > endMs || (index && wordStart < Number(tokens[index - 1][1]))) fail('YRC 词时间超出行范围或顺序无效。');
      return { startMs: wordStart, endMs: wordEnd, text: wordText };
    }).filter(word => word.text.length);
    lines.push({ startMs, endMs, text: words.map(word => word.text).join(''), ...(words.length ? { words } : {}) });
  }
  return finishTimed(lines, 'yrc', metadata, options.durationMs);
}

function decodeXmlEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    if (code.startsWith('#')) {
      const point = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point > 0 && point <= 0x10FFFF && !(point >= 0xD800 && point <= 0xDFFF) ? String.fromCodePoint(point) : entity;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[code.toLowerCase()];
  });
}

function parseQrc(input, options = {}) {
  let text = textInput(input);
  if (/^<\?xml|^<QrcInfos\b/i.test(text)) {
    // Attribute extraction only: no XML parser, DTD, entities, external URLs, or execution.
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail('QRC XML 不允许 DTD 或外部实体。');
    const element = /<Lyric_1\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(text)?.[0];
    if (!element) fail('QRC XML 缺少 Lyric_1。');
    const type = /\bLyricType\s*=\s*(["'])(.*?)\1/i.exec(element)?.[2];
    if (type && type !== '1') fail('不支持此 QRC LyricType。');
    const content = /\bLyricContent\s*=\s*(["'])([\s\S]*?)\1/i.exec(element)?.[2];
    if (content === undefined) fail('QRC XML 缺少 LyricContent。');
    text = decodeXmlEntities(content).replace(/\r\n?/g, '\n');
  }
  const metadata = {};
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || metadataLine(line, metadata)) continue;
    const head = /^\[(\d+),(\d+)\]/.exec(line);
    if (!head) fail('QRC 需为已解密的明文逐词歌词或 LyricContent XML；不支持加密容器。');
    const startMs = ms(head[1]);
    const endMs = startMs + ms(head[2], '行时长');
    if (endMs > MAX_TIMELINE_MS) fail('QRC 行结束时间无效。');
    const body = line.slice(head[0].length);
    const tokens = [...body.matchAll(/\((\d+),(\d+)\)/g)];
    if (!tokens.length) fail('QRC 缺少有效的逐词时间戳。');
    let cursor = 0;
    const words = tokens.map((token, index) => {
      const fragment = body.slice(cursor, token.index);
      cursor = token.index + token[0].length;
      const wordStart = ms(token[1]);
      const wordEnd = wordStart + ms(token[2], '词时长');
      if (wordStart < startMs || wordEnd > endMs || (index && wordStart < Number(tokens[index - 1][1]))) fail('QRC 词时间超出行范围或顺序无效。');
      return { startMs: wordStart, endMs: wordEnd, text: fragment };
    }).filter(word => word.text.length);
    if (body.slice(cursor).trim()) fail('QRC 存在没有时间戳的尾部正文。');
    lines.push({ startMs, endMs, text: words.map(word => word.text).join(''), ...(words.length ? { words } : {}) });
  }
  return finishTimed(lines, 'qrc', metadata, options.durationMs);
}

function parseSrt(input, options = {}) {
  const text = textInput(input);
  const lines = [];
  for (const block of text.split(/\n\s*\n/)) {
    const rows = block.split('\n');
    if (/^\d+\s*$/.test(rows[0])) rows.shift();
    const match = /^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})(?:\s+.*)?$/.exec(rows.shift() || '');
    if (!match) fail('SRT cue 时间戳无效。');
    const startMs = timestamp(match[1]);
    const endMs = timestamp(match[2]);
    if (endMs < startMs || !rows.some(row => row.trim())) fail('SRT cue 时长或正文无效。');
    lines.push({ startMs, endMs, text: decodeXmlEntities(rows.join('\n').replace(/<\/?(?:b|i|u|font)\b[^>]*>/gi, '')) });
  }
  return finishTimed(lines, 'srt', {}, options.durationMs);
}

function plainResult(text, metadata = {}) {
  const marker = text.trim().replace(/[\[\]【】。.!！\s]/g, '').toLowerCase();
  if (['instrumental', '纯音乐', '纯音乐请欣赏', '此歌曲为没有填词的纯音乐'].includes(marker) || metadata.instrumental === 'true') {
    return { status: 'instrumental', kind: 'instrumental', lines: [], format: 'plain', metadata, timingEvidence: { format: 'plain', lineTimestamps: 0, wordTimestamps: 0, wordTiming: 'none' } };
  }
  return { status: 'plain', kind: 'plain', lines: [], plainText: text, format: 'plain', metadata, timingEvidence: { format: 'plain', lineTimestamps: 0, wordTimestamps: 0, wordTiming: 'none' } };
}

function lyricString(value) { return typeof value === 'string' ? value : (typeof value?.lyric === 'string' ? value.lyric : ''); }

function attachTranslation(result, translated) {
  if (translated.status === 'ready' && result.status === 'ready') result.lines = alignTranslation(result.lines, translated.lines);
  else if (translated.status === 'plain') {
    // Preserve untimed translations as a separate text, never pair rows by index.
    result.plainTranslation = translated.plainText;
    if (result.status === 'ready') result.translationWarning = '译文没有可靠的时间戳，已保留完整文本。';
  } else if (translated.status === 'ready' && result.status === 'plain') {
    result.plainTranslation = translated.lines.map(line => line.text).join('\n');
  } else result.translationWarning = '译文没有有效正文或时间戳，未逐行匹配。';
  return result;
}

function parseLyrics(input, options = {}) {
  try {
    const text = textInput(input);
    let result;
    const format = (options.format || '').replace(/^\./, '').toLowerCase();
    // Raw YRC can include JSON credit rows before the first timed row.
    if (/^\[\d+,\d+\]/m.test(text)) {
      const isYrc = /^\[\d+,\d+\]\s*\(\d+,\d+,\d+\)/m.test(text);
      result = isYrc ? parseYrc(text, options) : parseQrc(text, options);
    } else if (format === 'json' || /^\{/.test(text) || /^\[\s*\{/.test(text)) {
      let object;
      try { object = JSON.parse(text); } catch { fail('歌词 JSON 已损坏。'); }
      if (!object || typeof object !== 'object' || Array.isArray(object)) fail('不支持此歌词 JSON 结构。');
      if (object.instrumental === true && !lyricString(object.syncedLyrics) && !lyricString(object.plainLyrics)) result = plainResult('[Instrumental]');
      else {
        const original = lyricString(object.yrc) || lyricString(object.lrc) || lyricString(object.syncedLyrics) || lyricString(object.lyric) || lyricString(object.plainLyrics);
        if (!original) fail('歌词 JSON 缺少可识别的明文 yrc/lrc/lyric/syncedLyrics/plainLyrics 字段。');
        if (/^[0-9a-f]{80,}$/i.test(original.trim())) fail('此 QRC JSON 含加密正文，需要先导出为明文。');
        result = parseLyrics(original, { ...options, format: '' });
        if (result.status === 'parse-error') return result;
        const translated = lyricString(object.ytlrc) || lyricString(object.tlyric) || lyricString(object.translation) || lyricString(object.trans);
        if (translated) {
          const translation = parseLyrics(translated, { durationMs: options.durationMs });
          attachTranslation(result, translation);
        }
        result.containerFormat = 'json';
      }
    } else if (format === 'qrc' || /^<\?xml|^<QrcInfos\b/i.test(text)) result = parseQrc(text, options);
    else if (format === 'yrc') result = parseYrc(text, options);
    else if (format === 'srt' || /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(text)) result = parseSrt(text, options);
    else result = parseLrc(text, options);
    if (options.translation && ['ready', 'plain'].includes(result.status)) {
      const translated = parseLyrics(options.translation, { durationMs: options.durationMs });
      attachTranslation(result, translated);
    }
    return result;
  } catch (error) {
    return { status: 'parse-error', kind: 'none', lines: [], format: options.format || 'unknown', error: error.message, errorCode: error.code || 'INVALID_LYRICS', timingEvidence: { lineTimestamps: 0, wordTimestamps: 0, wordTiming: 'none' } };
  }
}

// Only exact timestamps by default. Optional tolerance requires a unique mutual nearest match.
function alignTranslation(original, translated, { toleranceMs = 0 } = {}) {
  const result = clone(original);
  const sourceTimes = [...new Set(result.filter(line => line.text.trim()).map(line => line.startMs))];
  const groups = new Map();
  for (const line of translated) {
    if (!Number.isFinite(line.startMs) || !line.text.trim()) continue;
    const group = groups.get(line.startMs) || [];
    if (!group.includes(line.text)) group.push(line.text);
    groups.set(line.startMs, group);
  }
  const nearest = (target, times) => {
    const sorted = times.map(time => ({ time, distance: Math.abs(target - time) })).sort((a, b) => a.distance - b.distance);
    return sorted[0] && sorted[0].distance <= toleranceMs && sorted[0].distance !== sorted[1]?.distance ? sorted[0].time : undefined;
  };
  for (const line of result) {
    let match = groups.has(line.startMs) ? line.startMs : undefined;
    if (match === undefined && toleranceMs > 0) {
      const candidate = nearest(line.startMs, [...groups.keys()]);
      if (candidate !== undefined && nearest(candidate, sourceTimes) === line.startMs) match = candidate;
    }
    if (match !== undefined && line.text.trim()) {
      const translation = groups.get(match).filter(text => text.trim() !== line.text.trim()).join('\n');
      if (translation) line.translation = translation;
    }
  }
  return result;
}

function normalized(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function metadataFingerprint(track) {
  return createHash('sha256').update(JSON.stringify([track.path, track.subsong ?? 0, track.title, track.artist, track.album, track.duration])).digest('hex');
}
function candidateMatchesTrack(record, track) {
  if (!normalized(track.title) || !normalized(track.artist)) return false;
  if (normalized(record.trackName || record.name) !== normalized(track.title) || normalized(record.artistName) !== normalized(track.artist)) return false;
  if (normalized(track.album) && normalized(record.albumName) !== normalized(track.album)) return false;
  if (Number.isFinite(track.duration) && track.duration > 0 && (!Number.isFinite(record.duration) || Math.abs(record.duration - track.duration) > 2)) return false;
  return true;
}

function recordDocument(record, trackId) {
  if (record?.provider === 'qq') {
    if (!validQqRecord(record) || typeof record.syncedLyrics !== 'string') fail('QQ Music 返回的歌曲记录无效。');
    const parsed = parseLyrics(record.syncedLyrics, { format: 'lrc', durationMs: record.duration * 1000 });
    return { ...parsed, trackId, provider: 'qq', source: QQ_SOURCE, sourceId: record.id, sourceKey: record.id, sourceUrl: qqSourceUrl(record.songmid), title: record.trackName, artist: record.artistName, album: record.albumName, duration: record.duration, local: false, bound: false, fromCache: false, offsetMs: 0 };
  }
  if (!record || typeof record !== 'object' || !Number.isSafeInteger(record.id) || record.id < 1) fail('LRCLIB 返回的歌曲记录无效。');
  const timed = typeof record.syncedLyrics === 'string' && record.syncedLyrics.trim();
  const plain = typeof record.plainLyrics === 'string' && record.plainLyrics.trim();
  let parsed;
  if (timed) parsed = parseLyrics(record.syncedLyrics, { format: 'lrc', durationMs: Number.isFinite(record.duration) ? record.duration * 1000 : undefined });
  else if (plain) parsed = parseLyrics(record.plainLyrics, { format: 'txt' });
  else if (record.instrumental === true) parsed = plainResult('[Instrumental]');
  else parsed = { status: 'parse-error', kind: 'none', lines: [], error: 'LRCLIB 记录没有歌词正文，也未标记为纯音乐。' };
  // hasWordSync is deliberately not trusted: only parsed word timestamps enable word mode.
  return { ...parsed, trackId, provider: 'lrclib', sourceKey: `lrclib:${record.id}`, source: 'LRCLIB', sourceId: record.id, sourceUrl: `https://lrclib.net/api/get/${record.id}`, title: record.trackName || record.name || '', artist: record.artistName || '', album: record.albumName || '', duration: record.duration ?? null, local: false, bound: false, fromCache: false, offsetMs: 0 };
}

function recordCandidate(record) {
  const document = recordDocument(record, '');
  return {
    id: `lrclib:${record.id}`, provider: 'lrclib', sourceKey: `lrclib:${record.id}`, sourceId: record.id, source: 'LRCLIB', sourceUrl: document.sourceUrl,
    title: document.title, artist: document.artist, album: document.album, duration: document.duration,
    instrumental: document.kind === 'instrumental', kind: document.kind, status: document.status, format: document.format,
    preview: document.lines.slice(0, 3).map(line => line.text).join('\n') || document.plainText?.slice(0, 300) || '',
    timingEvidence: document.timingEvidence, ...(document.error ? { error: document.error } : {}),
  };
}

function createLrclibClient({ fetchImpl = globalThis.fetch, apiBaseUrl = LRCLIB_URL, timeoutMs = 8000, minRequestIntervalMs = 700, maxResponseBytes = MAX_RESPONSE_BYTES, maxAttempts = 3, retryBaseMs = 800, retryBudgetMs = 28000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时不支持 fetch。');
  const base = new URL(apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new Error('歌词源必须使用 HTTPS。');
  let tail = Promise.resolve();
  let queued = 0;
  let nextRequestAt = 0;
  let retryAt = 0;
  let closed = false;
  const controllers = new Set();
  const attempts = Math.min(3, Math.max(1, Math.floor(maxAttempts) || 1));
  const backoff = Math.min(5000, Math.max(0, Number(retryBaseMs) || 0));
  const budget = Math.min(30000, Math.max(1, Number(retryBudgetMs) || 28000));
  async function request(endpoint, params = {}, { signal, isCurrent = () => true } = {}) {
    if (closed) throw new LyricsError('歌词服务已关闭。', 'network-error', 'CLOSED');
    if (queued >= 16) throw new LyricsError('歌词请求过多，请稍后重试。', 'network-error', 'BUSY');
    const lifetime = new AbortController();
    controllers.add(lifetime);
    const cancel = () => lifetime.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const aborted = () => new LyricsError(closed ? '歌词服务已关闭。' : '歌词请求已取消。', 'network-error', closed ? 'CLOSED' : 'CANCELLED');
    const guard = async () => {
      if (lifetime.signal.aborted || closed) throw aborted();
      if (!(await isCurrent())) { lifetime.abort(); throw aborted(); }
      if (lifetime.signal.aborted || closed) throw aborted();
    };
    const delay = milliseconds => new Promise((resolve, reject) => {
      if (lifetime.signal.aborted) { reject(aborted()); return; }
      const stop = () => { clearTimeout(timer); reject(aborted()); };
      const timer = setTimeout(() => { lifetime.signal.removeEventListener('abort', stop); resolve(); }, milliseconds);
      lifetime.signal.addEventListener('abort', stop, { once: true });
    });
    queued += 1;
    const operation = tail.catch(() => {}).then(async () => {
      await guard();
      const deadline = Date.now() + budget;
      if (retryAt > Date.now()) throw new LyricsError(`LRCLIB 请求受限，请在 ${new Date(retryAt).toISOString()} 后重试。`, 'network-error', 'RATE_LIMITED');
      const url = new URL(endpoint.replace(/^\//, ''), base);
      for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        await guard();
        if (nextRequestAt > Date.now()) await delay(Math.min(nextRequestAt - Date.now(), Math.max(0, deadline - Date.now())));
        await guard();
        if (Date.now() >= deadline) throw new LyricsError('LRCLIB 请求超时，请稍后重试。', 'network-error', 'TIMEOUT');
        const controller = new AbortController();
        const abortAttempt = () => controller.abort();
        lifetime.signal.addEventListener('abort', abortAttempt, { once: true });
        let timer;
        let rejectCancellation;
        const cancellation = new Promise((_, reject) => { rejectCancellation = () => reject(aborted()); });
        lifetime.signal.addEventListener('abort', rejectCancellation, { once: true });
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new LyricsError('LRCLIB 请求超时，请检查网络后重试。', 'network-error', 'TIMEOUT')); }, Math.min(timeoutMs, Math.max(1, deadline - Date.now())));
        });
        const run = async () => {
          let response;
          try { response = await fetchImpl(url.href, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: controller.signal, redirect: 'error' }); }
          catch (error) { throw new LyricsError(`无法连接 LRCLIB：${error.name === 'AbortError' ? '请求已中止' : error.message}`, 'network-error', 'NETWORK'); }
          if (controller.signal.aborted) { await response?.body?.cancel(); throw aborted(); }
          if (!response || !Number.isInteger(response.status)) throw new LyricsError('LRCLIB 响应无效。', 'network-error', 'INVALID_RESPONSE');
          if (response.status === 429) {
            const retry = response.headers.get('retry-after');
            const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) : NaN;
            const until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retry);
            const minimum = Number.isFinite(until) && until > Date.now() ? until : Date.now() + 60000;
            // No automatic 429 retry. Jitter the shared cooldown before accepting a later user request.
            retryAt = Math.min(8640000000000000, minimum + Math.floor(Math.random() * Math.max(0, minimum - Date.now()) * 0.3));
            await response.body?.cancel();
            throw new LyricsError('LRCLIB 请求受限，请稍后重试。', 'network-error', 'RATE_LIMITED');
          }
          if (response.status === 404 && endpoint !== 'search') { await response.body?.cancel(); return null; }
          if (!response.ok) { await response.body?.cancel(); throw new LyricsError(`LRCLIB 返回 HTTP ${response.status}，请稍后重试。`, 'network-error', `HTTP_${response.status}`); }
          const length = Number(response.headers.get('content-length'));
          if (length > maxResponseBytes) { await response.body?.cancel(); fail('LRCLIB 响应超过大小上限。'); }
          const reader = response.body?.getReader();
          if (!reader) fail('LRCLIB 响应为空。');
          const chunks = [];
          let total = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (total > maxResponseBytes) { await reader.cancel(); fail('LRCLIB 响应超过大小上限。'); }
              chunks.push(Buffer.from(value));
            }
          } catch (error) {
            if (error instanceof LyricsError) throw error;
            throw new LyricsError(`LRCLIB 响应读取失败：${error.message}`, 'network-error', 'NETWORK');
          } finally { reader.releaseLock(); }
          try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
          catch { fail('LRCLIB 返回了损坏的 JSON。'); }
        };
        let failure;
        try { return await Promise.race([run(), timeout, cancellation]); }
        catch (error) { failure = error; }
        finally {
          clearTimeout(timer);
          lifetime.signal.removeEventListener('abort', abortAttempt);
          lifetime.signal.removeEventListener('abort', rejectCancellation);
          nextRequestAt = Date.now() + minRequestIntervalMs;
        }
        await guard();
        const retryable = ['HTTP_408', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504', 'NETWORK', 'TIMEOUT'].includes(failure.code);
        const waitMs = Math.max(minRequestIntervalMs, backoff * 2 ** (attempt - 1));
        if (!retryable || attempt >= attempts || Date.now() + waitMs >= deadline) throw failure;
        await delay(waitMs);
      }
    });
    tail = operation;
    try { return await operation; }
    finally { queued -= 1; controllers.delete(lifetime); signal?.removeEventListener('abort', cancel); }
  }
  return { request, close() { closed = true; for (const controller of controllers) controller.abort(); } };
}

function createLyricsService(options) {
  const { dataDir, getTrack, getSettings = () => ({}) } = options;
  if (!dataDir || typeof getTrack !== 'function') throw new Error('Lyrics service requires dataDir and getTrack.');
  const folder = path.join(dataDir, 'lyrics');
  const statePath = path.join(folder, 'state.json');
  const maxCacheEntries = Math.max(1, options.maxCacheEntries ?? 256);
  const maxCacheBytes = Math.max(MAX_FILE_BYTES, options.maxCacheBytes ?? 16 * 1024 * 1024);
  const client = createLrclibClient(options);
  // Explicit injection only: fixture/custom LRCLIB clients never enable a second network source.
  const fallbackClient = options.fallbackClient ?? null;
  if (fallbackClient && !['search', 'get', 'close'].every(key => typeof fallbackClient[key] === 'function')) throw new Error('Invalid fallback lyrics client.');
  const state = { version: 1, bindings: Object.create(null), offsets: Object.create(null), cache: Object.create(null) };
  const resolved = new Map();
  const resolvedKeys = new Map();
  const revisions = new Map();
  const requestScopes = new Map();
  const pending = new Map();
  const manualPending = new Map();
  const searchRevisions = new Map();
  const previewRevisions = new Map();
  const searchCache = new Map();
  const recordCache = new Map();
  let initializing;
  let saveTail = Promise.resolve();
  let closed = false;

  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
  function cancelScope(trackId, channel) {
    const key = JSON.stringify([trackId, channel]);
    requestScopes.get(key)?.abort();
    requestScopes.delete(key);
  }
  function scope(trackId, channel, active) {
    cancelScope(trackId, channel);
    const controller = new AbortController();
    requestScopes.set(JSON.stringify([trackId, channel]), controller);
    return { signal: controller.signal, isCurrent: active };
  }
  const revision = trackId => { cancelScope(trackId, 'resolve'); const value = (revisions.get(trackId) || 0) + 1; revisions.set(trackId, value); return value; };
  const current = (trackId, token) => revisions.get(trackId) === token && !closed;
  const invalidateSelection = trackId => {
    cancelScope(trackId, 'search'); cancelScope(trackId, 'preview');
    searchRevisions.set(trackId, (searchRevisions.get(trackId) || 0) + 1);
    previewRevisions.set(trackId, (previewRevisions.get(trackId) || 0) + 1);
  };
  const offset = trackId => own(state.offsets, trackId) || 0;
  const decorate = (document, trackId, flags = {}) => ({ ...clone(document), trackId, offsetMs: offset(trackId), local: false, bound: false, fromCache: false, ...flags });
  const empty = (trackId, status, extras = {}) => ({ trackId, status, kind: 'none', source: 'LRCLIB', lines: [], offsetMs: offset(trackId), fromCache: false, local: false, bound: false, ...extras });
  function assertTrackId(trackId) { if (typeof trackId !== 'string' || !trackId || trackId.length > 500 || ['__proto__', 'constructor', 'prototype'].includes(trackId)) throw new Error('无效 trackId。'); }
  async function trackFor(trackId) { assertTrackId(trackId); const track = await getTrack(trackId); if (!track) throw new Error('曲目不存在，请先导入音乐。'); return clone(track); }
  async function sameTrack(trackId, track) {
    const latest = await getTrack(trackId);
    return !!latest && metadataFingerprint(latest) === metadataFingerprint(track);
  }
  async function contextCurrent(trackId, token, track) {
    return current(trackId, token) && await sameTrack(trackId, track) && current(trackId, token);
  }
  async function settings() {
    const value = await getSettings();
    return { onlineEnabled: true, cacheEnabled: true, preferredSource: 'lrclib', ...(value?.lyrics || {}) };
  }
  function boundDocument(trackId) {
    const binding = own(state.bindings, trackId);
    return binding ? decorate(binding.document, trackId, { local: !!binding.document.local, bound: true }) : null;
  }
  function remember(trackId, document, track) {
    resolved.delete(trackId);
    resolved.set(trackId, clone(document));
    if (track) resolvedKeys.set(trackId, metadataFingerprint(track));
    while (resolved.size > 128) { const first = resolved.keys().next().value; resolved.delete(first); resolvedKeys.delete(first); }
    return document;
  }
  function superseded(trackId) {
    const document = boundDocument(trackId) || (resolved.has(trackId) ? decorate(resolved.get(trackId), trackId, { local: !!resolved.get(trackId).local, bound: !!resolved.get(trackId).bound, fromCache: !!resolved.get(trackId).fromCache }) : empty(trackId, 'not-found', { reason: 'superseded' }));
    return { ...document, superseded: true };
  }
  function pruneCache(target = state) {
    const entries = Object.entries(target.cache).sort((a, b) => (b[1].storedAt || 0) - (a[1].storedAt || 0));
    let bytes = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const [key, value] = entries[index];
      const size = Buffer.byteLength(JSON.stringify(value));
      if (index >= maxCacheEntries || bytes + size > maxCacheBytes) delete target.cache[key];
      else bytes += size;
    }
  }
  function commit(mutate, isCurrent = () => !closed) {
    const operation = saveTail.catch(() => {}).then(async () => {
      if (!(await isCurrent())) return false;
      const next = clone(state);
      mutate(next);
      pruneCache(next);
      const serialized = JSON.stringify(next);
      const temporary = path.join(folder, `state-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
        if (!(await isCurrent())) return false;
        await fs.rename(temporary, statePath);
        // A failed write never changes the live state; queued edits start from the last successful commit.
        Object.assign(state, next);
        return true;
      }
      finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    });
    saveTail = operation;
    return operation;
  }
  function validStoredDocument(document, trackId) {
    if (!document || document.trackId !== trackId || !SUCCESS.has(document.status) || !Array.isArray(document.lines)) return false;
    if (document.provider === 'qq' || document.source === QQ_SOURCE || String(document.sourceId).startsWith('qq:')) {
      const mid = /^qq:([A-Za-z0-9]{5,40})$/.exec(String(document.sourceId))?.[1];
      if (!mid || document.provider !== 'qq' || document.source !== QQ_SOURCE || document.sourceKey !== document.sourceId || document.sourceUrl !== qqSourceUrl(mid)) return false;
    } else if (document.provider === 'lrclib' || document.source === 'LRCLIB') {
      // Old snapshots predate provider/sourceKey and retain their numeric ID.
      if (!Number.isSafeInteger(document.sourceId) || document.sourceId < 1 || document.sourceUrl !== `https://lrclib.net/api/get/${document.sourceId}`
        || (document.provider !== undefined && document.provider !== 'lrclib') || (document.sourceKey !== undefined && document.sourceKey !== `lrclib:${document.sourceId}`)) return false;
    }
    if (document.status === 'plain') return document.kind === 'plain' && typeof document.plainText === 'string' && !!document.plainText.trim() && !document.lines.length;
    if (document.status === 'instrumental') return document.kind === 'instrumental' && !document.lines.length;
    if (!['line', 'word'].includes(document.kind) || !document.lines.length) return false;
    const validTime = time => Number.isSafeInteger(time) && Math.abs(time) <= MAX_TIMELINE_MS * 2;
    let words = 0;
    for (const line of document.lines) {
      if (typeof line?.text !== 'string' || !validTime(line.startMs) || (line.endMs !== undefined && (!validTime(line.endMs) || line.endMs < line.startMs))) return false;
      if (line.words !== undefined) {
        if (!Array.isArray(line.words)) return false;
        for (const word of line.words) {
          if (typeof word?.text !== 'string' || !validTime(word.startMs) || !validTime(word.endMs) || word.endMs < word.startMs) return false;
          words += 1;
        }
      }
    }
    return document.lines.some(line => line.text.trim()) && (document.kind === 'word' ? words > 0 : words === 0);
  }
  async function initialize() {
    if (closed) throw new Error('歌词服务已关闭。');
    if (!initializing) initializing = (async () => {
      await fs.mkdir(folder, { recursive: true });
      try {
        const info = await fs.stat(statePath);
        if (info.size > maxCacheBytes + 64 * MAX_FILE_BYTES) throw new Error('歌词状态文件过大。');
        const loaded = JSON.parse(await fs.readFile(statePath, 'utf8'));
        if (loaded.version !== 1 || !loaded.bindings || !loaded.offsets || !loaded.cache) throw new Error('不支持的歌词状态文件。');
        for (const [id, binding] of Object.entries(loaded.bindings)) if (validStoredDocument(binding?.document, id)) state.bindings[id] = binding;
        for (const [id, value] of Object.entries(loaded.offsets)) if (Number.isFinite(value) && Math.abs(value) <= 600000) state.offsets[id] = Math.round(value);
        for (const [id, entry] of Object.entries(loaded.cache)) if (validStoredDocument(entry?.document, id)) state.cache[id] = entry;
        pruneCache();
      } catch (error) {
        if (error.code !== 'ENOENT') {
          // Preserve damaged user data for recovery; a corrupt cache must not break playback.
          await fs.rename(statePath, path.join(folder, `state-corrupt-${Date.now()}.json`));
          state.recoveryWarning = `歌词状态文件损坏，已保留副本：${error.message}`;
        }
      }
      return { supportedFormats: [...supportedFormats], ...(state.recoveryWarning ? { warning: state.recoveryWarning } : {}) };
    })();
    return initializing;
  }
  async function readFileDocument(filePath, trackId, durationMs, source) {
    const info = await fs.stat(filePath);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new LyricsError('歌词文件不是普通文件或超过 2 MiB 上限。');
    const parsed = parseLyrics(await fs.readFile(filePath), { format: path.extname(filePath).slice(1), durationMs });
    return { ...parsed, trackId, source, sourcePath: filePath, fileName: path.basename(filePath), sourceUrl: null, local: true, bound: false, fromCache: false, offsetMs: offset(trackId) };
  }
  async function attachSidecarTranslation(document, stem, durationMs) {
    if (!['ready', 'plain'].includes(document.status)) return document;
    for (const suffix of ['.translation.lrc', '.trans.lrc', '.zh.lrc', '.translation.txt', '.trans.txt', '.zh.txt']) {
      try {
        const translation = await readFileDocument(`${stem}${suffix}`, document.trackId, durationMs, '本地译文');
        attachTranslation(document, translation);
        document.translationSourcePath = `${stem}${suffix}`;
        break;
      } catch (error) { if (error.code !== 'ENOENT') document.translationWarning = error.message; }
    }
    return document;
  }
  async function localDocument(track, trackId) {
    if (!track.path || typeof track.path !== 'string' || /^https?:\/\//i.test(track.path)) return null;
    const stem = path.join(path.dirname(track.path), path.basename(track.path, path.extname(track.path)));
    let invalid;
    for (const extension of ['yrc', 'qrc', 'lrc', 'srt', 'txt', 'json']) {
      try {
        const document = await readFileDocument(`${stem}.${extension}`, trackId, track.duration ? track.duration * 1000 : undefined, '本地歌词');
        if (SUCCESS.has(document.status)) return attachSidecarTranslation(document, stem, track.duration ? track.duration * 1000 : undefined);
        invalid ||= document;
      } catch (error) {
        if (error.code !== 'ENOENT') invalid ||= empty(trackId, 'parse-error', { source: '本地歌词', sourcePath: `${stem}.${extension}`, local: true, error: error.message });
      }
    }
    return invalid || null;
  }
  function lruSet(map, key, value, limit = 64) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > 8 * 1024 * 1024) return;
    map.delete(key); map.set(key, { value: clone(value), savedAt: Date.now(), bytes });
    let total = [...map.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (map.size > limit || total > 8 * 1024 * 1024) {
      const first = map.keys().next().value;
      total -= map.get(first).bytes;
      map.delete(first);
    }
  }
  function lruGet(map, key) {
    const entry = map.get(key);
    if (!entry || Date.now() - entry.savedAt > 10 * 60 * 1000) { map.delete(key); return null; }
    map.delete(key); map.set(key, entry);
    return clone(entry.value);
  }
  function cacheDocument(trackId, track) {
    const entry = own(state.cache, trackId);
    return entry && entry.metadataKey === metadataFingerprint(track) ? decorate(entry.document, trackId, { fromCache: true, cachedAt: entry.storedAt }) : null;
  }
  async function queryRecords(track, query, prefs, context) {
    const params = query ? { q: query } : { track_name: track.title || '', artist_name: track.artist || '', ...(track.album ? { album_name: track.album } : {}) };
    const key = JSON.stringify(params);
    if (prefs.cacheEnabled) {
      const cached = lruGet(searchCache, key);
      if (cached) return { records: cached, fromCache: true };
    }
    const records = await client.request('search', params, context);
    if (!Array.isArray(records)) fail('LRCLIB 搜索响应不是结果数组。');
    const bounded = records.slice(0, 50);
    if (bounded.some(record => !record || typeof record !== 'object' || !Number.isSafeInteger(record.id) || record.id < 1)) fail('LRCLIB 搜索结果含损坏的歌曲记录。');
    if ((await settings()).cacheEnabled) {
      lruSet(searchCache, key, bounded, 32);
      for (const record of bounded) if (Number.isSafeInteger(record?.id)) lruSet(recordCache, `lrclib:${record.id}`, record);
    }
    return { records: bounded, fromCache: false };
  }
  async function automaticDocument(track, trackId, prefs, context) {
    if (!normalized(track.title) || !normalized(track.artist)) return empty(trackId, 'not-found', { reason: 'missing-metadata', error: '自动查询需要曲名和歌手；可手动输入搜索词。' });
    if (track.album && Number.isFinite(track.duration) && track.duration >= 1 && track.duration <= 3600) {
      const record = await client.request('get', { track_name: track.title, artist_name: track.artist, album_name: track.album, duration: track.duration }, context);
      if (record && candidateMatchesTrack(record, track)) return recordDocument(record, trackId);
    }
    const { records, fromCache } = await queryRecords(track, undefined, prefs, context);
    const matches = records.filter(record => candidateMatchesTrack(record, track));
    if (matches.length === 1) return { ...recordDocument(matches[0], trackId), fromCache };
    return empty(trackId, 'not-found', { reason: matches.length > 1 ? 'selection-required' : 'no-match', candidateCount: records.length, error: matches.length > 1 ? '存在多个相符版本，请搜索并预览后选择。' : undefined });
  }
  async function onlineDocument(track, trackId, prefs, context) {
    let primary;
    try { primary = await automaticDocument(track, trackId, prefs, context); }
    catch (error) { primary = empty(trackId, error.status || 'network-error', { error: error.message, errorCode: error.code }); }
    if (!fallbackClient || SUCCESS.has(primary.status) || !['not-found', 'network-error', 'parse-error'].includes(primary.status)
      || ['selection-required', 'missing-metadata'].includes(primary.reason) || ['CANCELLED', 'CLOSED'].includes(primary.errorCode)) return primary;
    if (context.signal.aborted || !(await context.isCurrent())) return primary;
    const latest = await settings();
    if (!latest.onlineEnabled || latest.preferredSource !== 'lrclib' || context.signal.aborted || !(await context.isCurrent())) return primary;
    // QQ fallback deliberately requires all metadata. Normalize case/width/space,
    // retaining punctuation and version qualifiers such as Live/Remaster/Cover.
    const strict = value => String(value || '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
    if (!strict(track.title) || !strict(track.artist) || !strict(track.album) || !Number.isFinite(track.duration) || track.duration <= 0) return primary;
    const provenance = { primarySource: 'LRCLIB', primaryStatus: primary.status, ...(primary.errorCode ? { primaryErrorCode: primary.errorCode } : {}) };
    const failed = (status, extras) => empty(trackId, status, { source: QQ_SOURCE, provider: 'qq', ...provenance, ...extras });
    try {
      const records = await fallbackClient.search(track, context);
      if (context.signal.aborted || !(await context.isCurrent())) return primary;
      if (!Array.isArray(records) || records.length > 10 || records.some(record => !validQqRecord(record))) fail('QQ Music 搜索结果无效。');
      const matches = records.filter(record => strict(record.trackName) === strict(track.title) && strict(record.artistName) === strict(track.artist)
        && strict(record.albumName) === strict(track.album) && Math.abs(record.duration - track.duration) <= 2);
      if (matches.length !== 1) return failed('not-found', { reason: matches.length > 1 ? 'selection-required' : 'no-match', candidateCount: records.length });
      const currentPrefs = await settings();
      if (!currentPrefs.onlineEnabled || currentPrefs.preferredSource !== 'lrclib' || context.signal.aborted || !(await context.isCurrent())) return primary;
      const record = await fallbackClient.get(matches[0], context);
      if (context.signal.aborted || !(await context.isCurrent())) return primary;
      // Do not trust a custom/injected adapter to substitute a different version.
      if (!validQqRecord(record) || ['id', 'songmid', 'trackName', 'artistName', 'albumName', 'duration'].some(key => record[key] !== matches[0][key])) fail('QQ Music 返回了不同的歌曲记录。');
      return { ...recordDocument(record, trackId), ...provenance };
    } catch (error) { return failed(error.status || 'network-error', { error: error.message, errorCode: error.code }); }
  }
  async function resolve({ trackId, force = false }, bypassManual = false) {
    await initialize();
    assertTrackId(trackId);
    if (!bypassManual && manualPending.has(trackId)) return manualPending.get(trackId);
    if (!force && pending.has(trackId)) return pending.get(trackId);
    const token = revision(trackId);
    const operation = (async () => {
      const track = await trackFor(trackId);
      const binding = boundDocument(trackId);
      if (binding) return current(trackId, token) ? remember(trackId, binding, track) : superseded(trackId);
      const local = await localDocument(track, trackId);
      if (!current(trackId, token)) return superseded(trackId);
      if (!(await sameTrack(trackId, track))) return empty(trackId, 'not-found', { superseded: true, reason: 'track-changed' });
      if (!current(trackId, token)) return superseded(trackId);
      if (local) return remember(trackId, decorate(local, trackId, { local: true }), track);
      const prefs = await settings();
      if (!current(trackId, token)) return superseded(trackId);
      if (!(await sameTrack(trackId, track))) return empty(trackId, 'not-found', { superseded: true, reason: 'track-changed' });
      if (!current(trackId, token)) return superseded(trackId);
      const cached = prefs.cacheEnabled ? cacheDocument(trackId, track) : null;
      if (cached && !force) return remember(trackId, cached, track);
      if (!prefs.onlineEnabled || prefs.preferredSource !== 'lrclib') return remember(trackId, cached || empty(trackId, 'not-found', { reason: prefs.onlineEnabled ? 'source-disabled' : 'online-disabled' }), track);
      let document;
      try { document = await onlineDocument(track, trackId, force ? { ...prefs, cacheEnabled: false } : prefs, scope(trackId, 'resolve', () => contextCurrent(trackId, token, track))); }
      catch (error) {
        const status = error.status || 'network-error';
        document = cached ? { ...cached, refreshStatus: status, error: error.message, errorCode: error.code } : empty(trackId, status, { error: error.message, errorCode: error.code });
      }
      if (cached && (['parse-error', 'network-error'].includes(document.status) || (!SUCCESS.has(document.status) && ['parse-error', 'network-error'].includes(document.primaryStatus)))) document = { ...cached, refreshStatus: document.status, error: document.error, errorCode: document.errorCode, ...(document.primaryStatus ? { primaryStatus: document.primaryStatus, primaryErrorCode: document.primaryErrorCode } : {}) };
      if (!current(trackId, token)) return superseded(trackId);
      const latestPrefs = await settings();
      if (!current(trackId, token)) return superseded(trackId);
      if (!(await sameTrack(trackId, track))) return empty(trackId, 'not-found', { superseded: true, reason: 'track-changed' });
      if (!current(trackId, token)) return superseded(trackId);
      if (SUCCESS.has(document.status) && !document.refreshStatus && latestPrefs.cacheEnabled) {
        try {
          await commit(next => { next.cache[trackId] = { metadataKey: metadataFingerprint(track), document: { ...clone(document), fromCache: false }, storedAt: Date.now() }; }, () => contextCurrent(trackId, token, track));
        } catch (error) { document.cacheWarning = `歌词可用，但缓存保存失败：${error.message}`; }
      }
      if (!current(trackId, token)) return superseded(trackId);
      if (!(await sameTrack(trackId, track))) return empty(trackId, 'not-found', { superseded: true, reason: 'track-changed' });
      if (!current(trackId, token)) return superseded(trackId);
      return remember(trackId, decorate(document, trackId, { fromCache: !!document.fromCache }), track);
    })();
    pending.set(trackId, operation);
    try { return await operation; }
    finally { if (pending.get(trackId) === operation) pending.delete(trackId); }
  }
  async function search({ trackId, query } = {}) {
    await initialize();
    assertTrackId(trackId);
    const token = (searchRevisions.get(trackId) || 0) + 1;
    cancelScope(trackId, 'search'); cancelScope(trackId, 'preview');
    searchRevisions.set(trackId, token);
    previewRevisions.set(trackId, (previewRevisions.get(trackId) || 0) + 1);
    const track = await trackFor(trackId);
    const explicit = typeof query === 'string' ? query.trim() : '';
    if (explicit.length > 500) throw new Error('搜索词最多 500 字符。');
    const result = { trackId, query: explicit || null, source: 'LRCLIB', sourceUrl: 'https://lrclib.net/docs', results: [], fromCache: false };
    const stale = () => ({ ...result, status: 'not-found', superseded: true, reason: 'superseded' });
    const active = () => searchRevisions.get(trackId) === token && !closed;
    const prefs = await settings();
    if (!active()) return stale();
    if (!prefs.onlineEnabled || prefs.preferredSource !== 'lrclib') return { ...result, status: 'not-found', reason: prefs.onlineEnabled ? 'source-disabled' : 'online-disabled' };
    if (!explicit && !track.title) return { ...result, status: 'not-found', reason: 'missing-metadata' };
    try {
      const found = await queryRecords(track, explicit, prefs, scope(trackId, 'search', async () => active() && await sameTrack(trackId, track) && active()));
      if (!active() || !(await sameTrack(trackId, track)) || !active()) return stale();
      const candidates = found.records.map(recordCandidate);
      return { ...result, status: candidates.length ? 'ready' : 'not-found', results: candidates, fromCache: found.fromCache };
    } catch (error) {
      if (!active() || !(await sameTrack(trackId, track)) || !active()) return stale();
      return { ...result, status: error.status || 'network-error', error: error.message, errorCode: error.code };
    }
  }
  function candidateId(candidate) {
    const value = candidate?.sourceId ?? (/^lrclib:\d+$/.test(String(candidate?.id)) ? String(candidate.id).slice(7) : candidate?.id);
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1 || (candidate?.source && !['lrclib', 'LRCLIB'].includes(candidate.source))
      || (candidate?.provider && candidate.provider !== 'lrclib') || (candidate?.sourceKey && candidate.sourceKey !== `lrclib:${id}`)
      || (String(candidate?.id).includes(':') && candidate.id !== `lrclib:${id}`)) throw new Error('请选择有效的 LRCLIB 搜索结果。');
    return id;
  }
  async function candidateDocument({ trackId, candidate }, context) {
    const id = candidateId(candidate);
    const prefs = await settings();
    let record = prefs.cacheEnabled ? lruGet(recordCache, `lrclib:${id}`) : null;
    const fromCache = !!record;
    if (!record && (!prefs.onlineEnabled || prefs.preferredSource !== 'lrclib')) return empty(trackId, 'not-found', { reason: prefs.onlineEnabled ? 'source-disabled' : 'online-disabled' });
    try {
      if (!record) record = await client.request(`get/${id}`, {}, context);
      if (!record) return empty(trackId, 'not-found', { reason: 'no-match' });
      if (record.id !== id) fail('歌词源返回了不同的歌曲 ID。');
      if ((await settings()).cacheEnabled) lruSet(recordCache, `lrclib:${id}`, record);
      return decorate(recordDocument(record, trackId), trackId, { preview: true, fromCache });
    } catch (error) { return empty(trackId, error.status || 'network-error', { error: error.message, errorCode: error.code }); }
  }
  async function preview({ trackId, candidate }) {
    await initialize();
    assertTrackId(trackId);
    const token = (previewRevisions.get(trackId) || 0) + 1;
    cancelScope(trackId, 'preview');
    previewRevisions.set(trackId, token);
    const track = await trackFor(trackId);
    if (previewRevisions.get(trackId) !== token || closed) return empty(trackId, 'not-found', { preview: true, superseded: true, reason: 'superseded' });
    const document = await candidateDocument({ trackId, candidate }, scope(trackId, 'preview', async () => previewRevisions.get(trackId) === token && !closed && await sameTrack(trackId, track)));
    if (previewRevisions.get(trackId) !== token || closed || !(await sameTrack(trackId, track)) || previewRevisions.get(trackId) !== token) return empty(trackId, 'not-found', { preview: true, superseded: true, reason: 'superseded' });
    return document;
  }
  async function bind({ trackId, candidate }) {
    await initialize();
    assertTrackId(trackId);
    const token = revision(trackId);
    invalidateSelection(trackId);
    const operation = (async () => {
      const track = await trackFor(trackId);
      if (!current(trackId, token)) return superseded(trackId);
      const document = await candidateDocument({ trackId, candidate }, scope(trackId, 'resolve', () => contextCurrent(trackId, token, track)));
      if (!current(trackId, token)) return superseded(trackId);
      if (!(await sameTrack(trackId, track))) return empty(trackId, 'not-found', { superseded: true, reason: 'track-changed' });
      if (!SUCCESS.has(document.status)) return document;
      delete document.preview;
      const committed = await commit(next => { next.bindings[trackId] = { document: { ...document, bound: true }, savedAt: Date.now() }; }, () => contextCurrent(trackId, token, track));
      if (!current(trackId, token)) return superseded(trackId);
      if (!committed || !(await sameTrack(trackId, track))) return empty(trackId, 'not-found', { superseded: true, reason: 'track-changed' });
      return current(trackId, token) ? remember(trackId, boundDocument(trackId), track) : superseded(trackId);
    })();
    manualPending.set(trackId, operation);
    try { return await operation; }
    finally { if (manualPending.get(trackId) === operation) manualPending.delete(trackId); }
  }
  async function importFile({ trackId, path: filePath }) {
    await initialize();
    assertTrackId(trackId);
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('请选择本地歌词文件。');
    if (!supportedFormats.includes(path.extname(filePath).slice(1).toLowerCase())) throw new Error('不支持此歌词文件扩展名。');
    const token = revision(trackId);
    invalidateSelection(trackId);
    const operation = (async () => {
      const track = await trackFor(trackId);
      let document;
      try {
        document = await readFileDocument(filePath, trackId, track.duration ? track.duration * 1000 : undefined, '手动导入');
        document = await attachSidecarTranslation(document, path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath))), track.duration ? track.duration * 1000 : undefined);
      } catch (error) { document = empty(trackId, 'parse-error', { source: '手动导入', local: true, error: error.message, errorCode: error.code }); }
      if (!current(trackId, token)) return superseded(trackId);
      if (!(await sameTrack(trackId, track))) return empty(trackId, 'not-found', { superseded: true, reason: 'track-changed' });
      if (!SUCCESS.has(document.status)) return decorate(document, trackId, { local: true });
      const committed = await commit(next => { next.bindings[trackId] = { document: { ...document, bound: true }, savedAt: Date.now() }; }, () => contextCurrent(trackId, token, track));
      if (!current(trackId, token)) return superseded(trackId);
      if (!committed || !(await sameTrack(trackId, track))) return empty(trackId, 'not-found', { superseded: true, reason: 'track-changed' });
      return current(trackId, token) ? remember(trackId, boundDocument(trackId), track) : superseded(trackId);
    })();
    manualPending.set(trackId, operation);
    try { return await operation; }
    finally { if (manualPending.get(trackId) === operation) manualPending.delete(trackId); }
  }
  async function setOffset({ trackId, offsetMs }) {
    await initialize();
    await trackFor(trackId);
    if (typeof offsetMs !== 'number' || !Number.isFinite(offsetMs) || Math.abs(offsetMs) > 600000) throw new Error('偏移量必须在 -600000 到 600000 毫秒之间。');
    const value = Math.round(offsetMs);
    await commit(next => { if (value === 0) delete next.offsets[trackId]; else next.offsets[trackId] = value; });
    const track = await trackFor(trackId);
    const document = boundDocument(trackId) || (resolved.has(trackId) && resolvedKeys.get(trackId) === metadataFingerprint(track) ? { ...clone(resolved.get(trackId)), offsetMs: offset(trackId) } : await resolve({ trackId }));
    return document.superseded ? document : remember(trackId, document, track);
  }
  async function unbind({ trackId }) {
    await initialize();
    await trackFor(trackId);
    const token = revision(trackId);
    invalidateSelection(trackId);
    const operation = (async () => {
      await commit(next => { delete next.bindings[trackId]; }, () => current(trackId, token));
      if (!current(trackId, token)) return superseded(trackId);
      resolved.delete(trackId);
      resolvedKeys.delete(trackId);
      pending.delete(trackId);
      return resolve({ trackId }, true);
    })();
    manualPending.set(trackId, operation);
    try { return await operation; }
    finally { if (manualPending.get(trackId) === operation) manualPending.delete(trackId); }
  }
  async function close() {
    closed = true;
    client.close();
    fallbackClient?.close();
    for (const controller of requestScopes.values()) controller.abort();
    requestScopes.clear();
    await saveTail;
    recordCache.clear(); searchCache.clear(); resolved.clear(); resolvedKeys.clear();
  }
  return { supportedFormats: [...supportedFormats], initialize, resolve, search, preview, bind, importFile, setOffset, unbind, close };
}

function createSearchingDocument(trackId) {
  return { trackId, status: 'searching', kind: 'none', source: 'LRCLIB', lines: [], offsetMs: 0, fromCache: false, local: false, bound: false };
}

module.exports = { createLyricsService, supportedFormats, parseLyrics, parseLrc, parseYrc, parseQrc, parseSrt, alignTranslation, decodeLyricBuffer, candidateMatchesTrack, createLrclibClient, createSearchingDocument, LyricsError };
