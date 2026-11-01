'use strict';

// Public guest plain-LRC endpoints, verified against the installed source and a
// bounded real request. No account state, signatures, script execution or QRC.
const { TextDecoder } = require('node:util');
const ORIGIN = 'https://c.y.qq.com';
const SEARCH_PATH = '/soso/fcgi-bin/client_search_cp';
const LYRIC_PATH = '/lyric/fcgi-bin/fcg_query_lyric_new.fcg';
const SOURCE = 'QQ Music';
const MID = /^[A-Za-z0-9]{5,40}$/;
const publicHeaders = Object.freeze({ Accept: 'application/json', 'User-Agent': 'STILL/1.0 (desktop music player; read-only public lyrics client)', Referer: 'https://y.qq.com/' });

function error(message, status = 'parse-error', code = 'INVALID_QQ_RESPONSE') {
  return Object.assign(new Error(message), { status, code });
}
function sourceUrl(songmid) { return `https://y.qq.com/n/ryqq/songDetail/${songmid}`; }
function validRecord(record) {
  return record?.provider === 'qq' && MID.test(record.songmid || '') && record.id === `qq:${record.songmid}`
    && ['trackName', 'artistName', 'albumName'].every(key => typeof record[key] === 'string' && record[key].length <= 1000)
    && Number.isFinite(record.duration) && record.duration > 0 && record.duration <= 86400;
}
function decodeBase64(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw error('QQ Music 普通歌词 Base64 无效。');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw error('QQ Music 普通歌词 Base64 无效。');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw error('QQ Music 普通歌词不是有效 UTF-8。'); }
}

function createQqLyricsClient({ fetchImpl = globalThis.fetch, timeoutMs = 10000, minRequestIntervalMs = 700, maxResponseBytes = 524288 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时不支持 fetch。');
  const timeout = Math.min(10000, Math.max(1, Number(timeoutMs) || 10000));
  const interval = Math.min(5000, Math.max(0, Number(minRequestIntervalMs) || 0));
  const byteLimit = Math.min(524288, Math.max(1, Number(maxResponseBytes) || 524288));
  let tail = Promise.resolve(), queued = 0, nextRequestAt = 0, retryAt = 0, closed = false;
  const lifetimes = new Set();
  async function request(pathname, params, { signal, isCurrent = () => true } = {}) {
    if (closed) throw error('QQ Music 歌词服务已关闭。', 'network-error', 'CLOSED');
    if (queued >= 16) throw error('QQ Music 歌词请求过多。', 'network-error', 'BUSY');
    const lifetime = new AbortController();
    lifetimes.add(lifetime);
    const cancel = () => lifetime.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    let timedOut = false;
    const cancelled = () => error(closed ? 'QQ Music 歌词服务已关闭。' : timedOut ? 'QQ Music 请求超时。' : 'QQ Music 歌词请求已取消。', 'network-error', closed ? 'CLOSED' : timedOut ? 'TIMEOUT' : 'CANCELLED');
    const guard = async () => {
      if (lifetime.signal.aborted || closed) throw cancelled();
      if (!(await isCurrent())) { lifetime.abort(); throw cancelled(); }
      if (lifetime.signal.aborted || closed) throw cancelled();
    };
    // Cancellation covers queue waits as well as fetches that ignore AbortSignal.
    let rejectCancellation;
    const cancellation = new Promise((_, reject) => { rejectCancellation = () => reject(cancelled()); });
    lifetime.signal.addEventListener('abort', rejectCancellation, { once: true });
    if (lifetime.signal.aborted) rejectCancellation();
    let timer, pacingTimer, reader, bodyCancellation;
    const stopReader = () => {
      if (reader && !bodyCancellation) {
        const currentReader = reader;
        bodyCancellation = (async () => { try { await currentReader.cancel(); } catch {} })();
      }
      return bodyCancellation;
    };
    lifetime.signal.addEventListener('abort', stopReader, { once: true });
    queued += 1;
    // The caller's deadline includes waiting for the physical slot. A timed-out
    // injected fetch may ignore abort forever; queued callers must still settle.
    timer = setTimeout(() => { timedOut = true; lifetime.abort(); }, timeout);
    const operation = tail.catch(() => {}).then(async () => {
      await guard();
      if (retryAt > Date.now()) throw error('QQ Music 请求受限，请稍后重试。', 'network-error', 'RATE_LIMITED');
      const run = async () => {
        if (nextRequestAt > Date.now()) await Promise.race([new Promise(resolve => { pacingTimer = setTimeout(resolve, nextRequestAt - Date.now()); }), cancellation]);
        await guard();
        const url = new URL(pathname, ORIGIN);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
        let response;
        try { response = await fetchImpl(url.href, { method: 'GET', headers: { ...publicHeaders }, credentials: 'omit', referrer: 'https://y.qq.com/', referrerPolicy: 'strict-origin', redirect: 'error', signal: lifetime.signal }); }
        catch { if (lifetime.signal.aborted) throw cancelled(); throw error('无法连接 QQ Music 公开歌词服务。', 'network-error', 'NETWORK'); }
        if (lifetime.signal.aborted) { await response?.body?.cancel(); throw cancelled(); }
        if (!response || !Number.isInteger(response.status)) throw error('QQ Music 响应无效。', 'network-error', 'INVALID_RESPONSE');
        if (response.status === 429) {
          const retry = response.headers.get('retry-after');
          const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) : NaN;
          const until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retry);
          retryAt = Math.min(8640000000000000, Number.isFinite(until) && until > Date.now() ? until : Date.now() + 60000);
          await response.body?.cancel();
          throw error('QQ Music 请求受限，请稍后重试。', 'network-error', 'RATE_LIMITED');
        }
        if (!response.ok) { await response.body?.cancel(); throw error(`QQ Music 返回 HTTP ${response.status}。`, 'network-error', `HTTP_${response.status}`); }
        if (Number(response.headers.get('content-length')) > byteLimit) { await response.body?.cancel(); throw error('QQ Music 响应超过大小上限。'); }
        reader = response.body?.getReader();
        if (!reader) throw error('QQ Music 响应为空。');
        const chunks = []; let total = 0;
        try {
          while (true) {
            if (lifetime.signal.aborted) throw cancelled();
            const { done, value } = await reader.read();
            if (lifetime.signal.aborted) throw cancelled();
            if (done) break;
            total += value.byteLength;
            if (total > byteLimit) throw error('QQ Music 响应超过大小上限。');
            chunks.push(Buffer.from(value));
          }
        } catch (failure) { if (failure.status) throw failure; throw error('QQ Music 响应读取失败。', 'network-error', 'NETWORK'); }
        finally {
          // Cancellation can settle the public result before either read or
          // cancel settles. Keep both in the physical operation before reuse.
          await stopReader();
          try { reader.releaseLock(); } catch {}
          reader = null;
        }
        let body;
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw error('QQ Music 返回了损坏的 JSON / UTF-8。'); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.code !== 0) throw error('QQ Music 公开接口未返回成功结果。');
        await guard();
        return body;
      };
      return run();
    });
    // This tail tracks the real fetch/body/cancel lifetime, never Promise.race.
    // Retain its admitted slot until actual settlement, bounding even injected
    // ignored-abort transports; close does not await this physical tail.
    const physical = operation.finally(() => {
      queued -= 1; clearTimeout(pacingTimer); clearTimeout(timer);
      lifetimes.delete(lifetime); signal?.removeEventListener('abort', cancel);
      lifetime.signal.removeEventListener('abort', stopReader);
      nextRequestAt = Date.now() + interval;
    });
    tail = physical.catch(() => {});
    try { return await Promise.race([physical, cancellation]); }
    finally { clearTimeout(timer); lifetime.signal.removeEventListener('abort', rejectCancellation); }
  }
  async function search(track, context) {
    const title = String(track?.title || '').trim(), artist = String(track?.artist || '').trim();
    if (!title || !artist || title.length + artist.length > 500) throw error('QQ Music 自动搜索需要有效曲名与歌手。');
    const body = await request(SEARCH_PATH, { format: 'json', n: 10, p: 0, w: `${title} ${artist}`, cr: 1, g_tk: 5381 }, context);
    if (!Array.isArray(body.data?.song?.list)) throw error('QQ Music 搜索结果结构无效。');
    return body.data.song.list.slice(0, 10).map(song => {
      const record = { provider: 'qq', id: `qq:${song?.songmid}`, songmid: song?.songmid, trackName: song?.songname, artistName: Array.isArray(song?.singer) && song.singer.every(singer => typeof singer?.name === 'string') ? song.singer.map(singer => singer.name).join(', ') : null, albumName: song?.albumname, duration: song?.interval };
      if (!validRecord(record)) throw error('QQ Music 搜索结果含无效歌曲记录。');
      return record;
    });
  }
  async function get(record, context) {
    if (!validRecord(record)) throw error('QQ Music 歌曲记录无效。');
    const body = await request(LYRIC_PATH, { songmid: record.songmid, pcachetime: Date.now(), g_tk: 5381, loginUin: 0, hostUin: 0, inCharset: 'utf8', outCharset: 'utf-8', notice: 0, platform: 'yqq', needNewCode: 1, format: 'json' }, context);
    return { ...record, syncedLyrics: decodeBase64(body.lyric) };
  }
  return { search, get, close() { closed = true; for (const lifetime of lifetimes) lifetime.abort(); } };
}

module.exports = { createQqLyricsClient, sourceUrl, validRecord, SOURCE };
