'use strict';

// Public guest plain-LRC endpoints, verified against the installed source and a
// bounded real request. No account state, signatures, script execution or QRC.
const { TextDecoder } = require('node:util');
const { version: productVersion } = require('../../package.json');
const { createBoundedSerialFetch } = require('./bounded-serial-fetch');
const ORIGIN = 'https://c.y.qq.com';
const SEARCH_PATH = '/soso/fcgi-bin/client_search_cp';
const LYRIC_PATH = '/lyric/fcgi-bin/fcg_query_lyric_new.fcg';
const SOURCE = 'QQ Music';
const MID = /^[A-Za-z0-9]{5,40}$/;
const publicHeaders = Object.freeze({ Accept: 'application/json', 'User-Agent': `STILL/${productVersion} (desktop music player; read-only public lyrics client)`, Referer: 'https://y.qq.com/' });

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
  const timeout = Math.min(10000, Math.max(1, Math.floor(Number(timeoutMs)) || 10000));
  const interval = Math.min(5000, Math.max(0, Math.floor(Number(minRequestIntervalMs)) || 0));
  const byteLimit = Math.min(524288, Math.max(1, Math.floor(Number(maxResponseBytes)) || 524288));
  const transport = createBoundedSerialFetch({fetchImpl, maxConcurrent: 1, maxQueued: 15,
    timeoutMs: timeout, minRequestIntervalMs: interval, intervalFrom: 'finish'});
  let retryAt = 0;
  const cancelled = code => error(code === 'CLOSED' ? 'QQ Music 歌词服务已关闭。' : code === 'TIMEOUT' ? 'QQ Music 请求超时。' : code === 'BUSY' ? 'QQ Music 歌词请求过多。' : 'QQ Music 歌词请求已取消。', 'network-error', code);
  async function request(pathname, params, { signal, isCurrent = () => true } = {}) {
    try {
      return await transport.run(async context => {
        const guard = async () => {
          context.guard();
          if (!(await isCurrent())) throw cancelled('CANCELLED');
          context.guard();
        };
        await guard();
        if (retryAt > Date.now()) throw error('QQ Music 请求受限，请稍后重试。', 'network-error', 'RATE_LIMITED');
        const url = new URL(pathname, ORIGIN);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
        let response;
        try {response = await context.fetch(url.href, {method: 'GET', headers: {...publicHeaders},
          credentials: 'omit', referrer: 'https://y.qq.com/', referrerPolicy: 'strict-origin', redirect: 'error'});}
        catch (failure) {context.guard(); if (failure.code === 'INVALID_RESPONSE') throw failure; throw error('无法连接 QQ Music 公开歌词服务。', 'network-error', 'NETWORK');}
        if (!response || !Number.isInteger(response.status)) throw error('QQ Music 响应无效。', 'network-error', 'INVALID_RESPONSE');
        if (response.status === 429) {
          const retry = response.headers.get('retry-after');
          const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) : NaN;
          const until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retry);
          retryAt = Math.min(8640000000000000, Number.isFinite(until) && until > Date.now() ? until : Date.now() + 60000);
          await context.cancelBody(response);
          throw error('QQ Music 请求受限，请稍后重试。', 'network-error', 'RATE_LIMITED');
        }
        if (!response.ok) {await context.cancelBody(response); throw error(`QQ Music 返回 HTTP ${response.status}。`, 'network-error', `HTTP_${response.status}`);}
        if (Number(response.headers.get('content-length')) > byteLimit) {await context.cancelBody(response); throw error('QQ Music 响应超过大小上限。');}
        let bytes;
        try {bytes = await context.readBody(response, {maxBytes: byteLimit});}
        catch (failure) {
          context.guard();
          if (['RESPONSE_TOO_LARGE', 'INVALID_RESPONSE'].includes(failure.code)) throw error('QQ Music 响应为空或超过大小上限。');
          throw error('QQ Music 响应读取失败。', 'network-error', 'NETWORK');
        }
        let body;
        try {body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));}
        catch {throw error('QQ Music 返回了损坏的 JSON。');}
        if (body?.code !== 0) throw error('QQ Music 公开接口未返回成功响应。');
        await guard();
        return body;
      }, {signal}).result;
    } catch (failure) {
      if (['TIMEOUT', 'CANCELLED', 'CLOSED', 'BUSY'].includes(failure.code)) throw cancelled(failure.code);
      throw failure;
    }
  }
  async function search(track, context, { query } = {}) {
    const title = String(track?.title || '').trim(), artist = String(track?.artist || '').trim();
    if (query !== undefined && (typeof query !== 'string' || !query.trim() || query.length > 500)) throw error('QQ Music 搜索词需为 1 到 500 字符。');
    if (query === undefined && (!title || !artist || title.length + artist.length > 500)) throw error('QQ Music 自动搜索需要有效曲名与歌手。');
    const body = await request(SEARCH_PATH, { format: 'json', n: 10, p: 0, w: query === undefined ? `${title} ${artist}` : query.trim(), cr: 1, g_tk: 5381 }, context);
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
    const result = { ...record, syncedLyrics: decodeBase64(body.lyric) };
    // Translation is optional. A broken optional field must not discard usable
    // original lyrics, and its bytes must never reach timestamp alignment.
    if (body.trans !== undefined && body.trans !== null && !(typeof body.trans === 'string' && !body.trans.trim())) {
      try {
        const translated = decodeBase64(body.trans);
        if (translated.trim()) result.translationLyrics = translated;
      } catch (failure) {
        result.translationWarning = `QQ Music 译文无效，已保留原文：${failure.message}`;
        result.translationErrorCode = failure.code;
      }
    }
    return result;
  }
  return { search, get, close() { transport.close(); } };
}

module.exports = { createQqLyricsClient, sourceUrl, validRecord, SOURCE };
