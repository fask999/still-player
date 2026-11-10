'use strict';

const fs = require('node:fs/promises');
const { constants: FS } = require('node:fs');
const path = require('node:path');
const { createBoundedSerialFetch } = require('./bounded-serial-fetch');

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.m4a', '.m4b', '.mp4', '.aac', '.wav', '.wave', '.aif', '.aiff', '.aifc',
  '.ogg', '.oga', '.opus', '.wv', '.dsf', '.dff', '.ape', '.mpc', '.mpp', '.mp+', '.wma', '.tak', '.tta', '.ac3', '.dts', '.caf', '.alac']);
let modules;
function failure(message) { return Object.assign(new Error(message), { code: 'INVALID_EMBEDDED_LYRICS' }); }
function identity(info) { return [info.dev, info.ino, info.size, info.mtimeNs ?? info.mtimeMs, info.ctimeNs ?? info.ctimeMs].map(String).join(':'); }
function directoryIdentity(info) { return [info.dev, info.ino].map(String).join(':'); }
function eligible(track) {
  return !!track && typeof track.path === 'string' && path.isAbsolute(track.path) && track.valid !== false
    && track.source !== 'cue' && track.cueTrack !== true && (track.subsong === undefined || track.subsong === 0)
    && AUDIO_EXTENSIONS.has(path.extname(track.path).toLowerCase());
}

// music-metadata's common LRC conversion can drop offset/multiple line stamps.
// Prefer literal native lyric tags; only use common ILyricsTag when no such tag
// exists. Objects are inspected explicitly, never stringified into lyric text.
function extractEmbeddedLyrics(metadata) {
  let bytes = 0, inspected = 0;
  const native = [], common = [];
  function add(target, value, tag) {
    if (++inspected > MAX_ENTRIES) throw failure('内嵌标签条目超过上限。');
    if (typeof value === 'string') {
      if (!value.trim()) return;
      bytes += Buffer.byteLength(value);
      if (bytes > MAX_TEXT_BYTES || target.length >= 16) throw failure('内嵌歌词正文超过上限。');
      target.push({ text: value, tag });
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (value.contentType !== undefined && value.contentType !== 1) return;
    if (Array.isArray(value.syncText) && value.syncText.length) {
      // MPEG frame numbers are not milliseconds. They need decoding evidence
      // unavailable in this read-only metadata path, so do not invent timing.
      if (value.timeStampFormat !== 2) return;
      if (value.syncText.length > MAX_ENTRIES || target.length >= 16) throw failure('内嵌歌词时间轴超过上限。');
      const lines = value.syncText.map(line => {
        if (typeof line?.text !== 'string' || !Number.isSafeInteger(line.timestamp) || line.timestamp < 0 || line.timestamp > 86400000) throw failure('内嵌歌词时间戳无效。');
        bytes += Buffer.byteLength(line.text);
        if (bytes > MAX_TEXT_BYTES) throw failure('内嵌歌词正文超过上限。');
        return { startMs: line.timestamp, text: line.text };
      });
      if (lines.some(line => line.text.trim())) target.push({ lines, tag });
    } else if (typeof value.text === 'string') add(target, value.text, tag);
  }
  let groups = 0, tags = 0;
  for (const [format, entries] of Object.entries(metadata?.native || {})) {
    if (++groups > 64 || !Array.isArray(entries)) throw failure('内嵌标签结构无效。');
    for (const entry of entries) {
      if (++tags > MAX_ENTRIES) throw failure('内嵌标签条目超过上限。');
      if (typeof entry?.id === 'string' && /^(?:LYRICS|UNSYNCEDLYRICS|USLT(?::.*)?|ULT(?::.*)?|SYLT(?::.*)?|TXXX:(?:LYRICS|UNSYNCEDLYRICS)|©LYR|WM\/LYRICS)$/i.test(entry.id)) add(native, entry.value, `${format}:${entry.id}`);
    }
  }
  if (native.length) return native;
  const lyrics = metadata?.common?.lyrics;
  if (Array.isArray(lyrics)) {
    if (lyrics.length > 16) throw failure('内嵌歌词候选超过上限。');
    for (const value of lyrics) add(common, value, 'common.lyrics');
  } else if (lyrics !== undefined) add(common, lyrics, 'common.lyrics');
  return common;
}

function createEmbeddedLyricsReader({ fsImpl = fs, metadataParser, timeoutMs = 3000, maxReadBytes = 16 * 1024 * 1024, maxReadOperations = MAX_ENTRIES } = {}) {
  const io = fsImpl || fs;
  const limit = (value, cap) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, cap) : cap;
  const readLimit = limit(maxReadBytes, 16 * 1024 * 1024), operationLimit = limit(maxReadOperations, MAX_ENTRIES);
  // Reuse the tested bounded physical-work lane. This reader never calls its
  // fetch method; a timed-out parser retains its slot until it really settles.
  const lane = createBoundedSerialFetch({ fetchImpl() { throw failure('内嵌读取不使用网络。'); }, maxConcurrent: 1, maxQueued: 15,
    timeoutMs: limit(timeoutMs, 3000) });
  let closed = false;
  async function inspect(filePath) {
    const absolute = path.resolve(filePath), root = path.parse(absolute).root;
    const ancestors = [], segments = path.relative(root, path.dirname(absolute)).split(path.sep).filter(Boolean);
    let current = root;
    for (const segment of [null, ...segments]) {
      if (segment !== null) current = path.join(current, segment);
      const info = await io.lstat(current, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) throw failure('内嵌歌词路径的父目录不是普通目录。');
      ancestors.push(directoryIdentity(info));
    }
    const file = await io.lstat(absolute, { bigint: true });
    if (file.isSymbolicLink() || !file.isFile() || Number(file.nlink) !== 1) throw failure('内嵌歌词只读取无链接的普通音频文件。');
    if (file.size <= 0 || file.size > MAX_FILE_BYTES) throw failure('音频文件大小超出内嵌歌词读取范围。');
    return { file, ancestors: ancestors.join('/') };
  }
  async function read(track, { isCurrent = () => true, signal } = {}) {
    if (closed || !eligible(track)) return null;
    try {
      return await lane.run(async context => {
        const guard = async () => {
          context.guard();
          if (closed || !(await isCurrent())) throw failure('内嵌歌词请求已失效。');
          context.guard();
        };
        await guard();
        let before;
        try { before = await inspect(track.path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        await guard();
        // O_NOFOLLOW is absent on Windows; lstat + opened-handle + post-read
        // identity checks still reject reparse/link substitution there.
        const handle = await io.open(track.path, FS.O_RDONLY | (FS.O_NOFOLLOW || 0) | (FS.O_NONBLOCK || 0));
        let tokenizer, readError;
        try {
          const opened = await handle.stat({ bigint: true });
          if (!opened.isFile() || Number(opened.nlink) !== 1 || identity(opened) !== identity(before.file)) throw failure('音频文件在打开时已改变。');
          modules ||= Promise.all([import('music-metadata'), import('strtok3')]).catch(error => { modules = undefined; throw error; });
          const [metadataModule, { FileTokenizer }] = await modules;
          await guard();
          let bytes = 0, reads = 0;
          // Extend the public class through its supported protected constructor.
          // The base receives the real read-only FileHandle and owns closing it.
          class BoundedLyricsTokenizer extends FileTokenizer {
            constructor(fileHandle, tokenizerOptions) { super(fileHandle, tokenizerOptions); }
            reserveRead(buffer, options) {
              context.guard();
              const normalized = this.normalizeOptions(buffer, options);
              this.validateBufferSize(normalized.length);
              if (++reads > operationLimit || normalized.length > readLimit - bytes) throw failure('内嵌歌词读取超过字节或操作上限。');
              bytes += normalized.length;
              return normalized;
            }
            async readBuffer(buffer, options) {
              const normalized = this.reserveRead(buffer, options);
              const result = await super.readBuffer(buffer, normalized);
              context.guard();
              return result;
            }
            async peekBuffer(buffer, options) {
              const normalized = this.reserveRead(buffer, options);
              const result = await super.peekBuffer(buffer, normalized);
              context.guard();
              return result;
            }
          }
          // Cancellation guards surround every real read. Keep the handle open
          // until the physical parser settles, independent of abort semantics.
          tokenizer = new BoundedLyricsTokenizer(handle, { fileInfo: { path: track.path, size: Number(opened.size) }, maxBufferSize: MAX_TEXT_BYTES });
          const parser = metadataParser || metadataModule.parseFromTokenizer;
          const metadata = await parser(tokenizer, { duration: false, skipCovers: true, maxMemoryAllocation: MAX_TEXT_BYTES, maxMetadataEntries: MAX_ENTRIES });
          await guard();
          const after = await inspect(track.path), finalHandle = await handle.stat({ bigint: true });
          if (identity(finalHandle) !== identity(opened) || identity(after.file) !== identity(opened) || after.ancestors !== before.ancestors) throw failure('音频文件在读取期间已改变。');
          const candidates = extractEmbeddedLyrics(metadata);
          await guard();
          return candidates.length ? { candidates } : null;
        } catch (error) {
          readError = error;
          throw error;
        } finally {
          let closeError;
          try { await tokenizer?.close(); } catch (error) { closeError = error; }
          // Constructor/early-read failures still belong to this owner. Avoid
          // closing a successfully closed base handle twice or hiding the
          // original read error behind a secondary cleanup failure.
          if (handle.fd !== -1) {
            try { await handle.close(); } catch (error) { closeError ||= error; }
          }
          if (closeError && !readError) throw closeError;
        }
      }, { signal }).result;
    } catch (error) {
      return { warning: ['TIMEOUT', 'BUSY'].includes(error.code) ? '内嵌歌词读取超时或繁忙，已继续查找其他来源。'
        : error.code === 'INVALID_EMBEDDED_LYRICS' ? `内嵌歌词未使用：${error.message}` : '内嵌歌词无法安全读取，已继续查找其他来源。' };
    }
  }
  return { read, close() { closed = true; lane.close(); } };
}

module.exports = { createEmbeddedLyricsReader, extractEmbeddedLyrics };
