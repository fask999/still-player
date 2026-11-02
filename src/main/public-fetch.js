'use strict';
const {randomUUID} = require('node:crypto');
const QQ_PUBLIC_REFERER = 'https://y.qq.com/';
const QQ_PUBLIC_USER_AGENT = 'STILL/1.0.1 (desktop music player; read-only public lyrics client)';

function isApprovedPublicRequest(input) {
  if (typeof input !== 'string' || input.length > 8192 || /[\\\u0000-\u0020\u007f]/.test(input)) return false;
  let url;
  try {url = new URL(input);} catch {return false;}
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  const queryKeys = allowed => [...url.searchParams.keys()].every(key => allowed.includes(key));
  if (url.hostname === 'c.y.qq.com') {
    const search = url.pathname === '/soso/fcgi-bin/client_search_cp', lyric = url.pathname === '/lyric/fcgi-bin/fcg_query_lyric_new.fcg';
    if (!search && !lyric) return false;
    const fixed = search ? {format: 'json', n: '10', p: '0', cr: '1', g_tk: '5381'} :
      {g_tk: '5381', loginUin: '0', hostUin: '0', inCharset: 'utf8', outCharset: 'utf-8', notice: '0', platform: 'yqq', needNewCode: '1', format: 'json'};
    if (!queryKeys([...Object.keys(fixed), ...(search ? ['w'] : ['songmid', 'pcachetime'])]) ||
        new Set(url.searchParams.keys()).size !== [...url.searchParams].length ||
        !Object.entries(fixed).every(([key, value]) => url.searchParams.get(key) === value)) return false;
    return search ? !!url.searchParams.get('w')?.trim() && url.searchParams.get('w').length <= 1024 :
      /^[A-Za-z0-9]{5,40}$/.test(url.searchParams.get('songmid') || '') && /^[0-9]{1,16}$/.test(url.searchParams.get('pcachetime') || '');
  }
  if (url.hostname === 'lrclib.net') return /^\/api\/(?:search|get(?:\/[1-9][0-9]{0,15})?)$/.test(url.pathname) &&
    queryKeys(['q', 'track_name', 'artist_name', 'album_name', 'duration']);
  if (url.hostname === 'musicbrainz.org') return url.pathname === '/ws/2/release/' &&
    queryKeys(['query', 'fmt', 'limit']) && url.searchParams.get('fmt') === 'json';
  if (url.search) return false;
  if (/^is[1-5]-ssl\.mzstatic\.com$/.test(url.hostname)) return /^\/image\/thumb\/(?:[A-Za-z0-9._~-]+\/)+512x512(?:bb)?\.(?:jpe?g|png)$/.test(url.pathname);
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
  if (url.hostname === 'coverartarchive.org') return new RegExp(`^/release/${uuid}/front-500$`).test(url.pathname);
  const prefix = url.hostname === 'archive.org' ? '/download' : /^ia[0-9]{6,12}\.(?:us|eu)\.archive\.org$/.test(url.hostname) ? '/[0-9]{1,2}/items' : null;
  return prefix !== null && new RegExp(`^${prefix}/mbid-(${uuid})/mbid-\\1-[1-9][0-9]{0,19}(?:_thumb500|-500)\\.jpg$`).test(url.pathname);
}
function createPublicFetchService({session}) {
  // A fresh, non-persistent partition uses Chromium's system-proxy network
  // stack without sharing the renderer or official Apple account session.
  const publicSession = session.fromPartition(`still-public-${randomUUID()}`, {cache: false});
  let closed = false, closing;
  const failure = code => Object.assign(new Error({PUBLIC_FETCH_CLOSED: '公共网络服务已关闭。',
    PUBLIC_FETCH_FORBIDDEN: '公共网络请求不在允许范围内。'}[code]), {code});
  return {
    async fetch(input, options = {}) {
      if (closed) throw failure('PUBLIC_FETCH_CLOSED');
      if (!isApprovedPublicRequest(input) || (options.method && String(options.method).toUpperCase() !== 'GET') || options.body != null) throw failure('PUBLIC_FETCH_FORBIDDEN');
      let headers;
      try {
        const offered = new Headers(options.headers);
        headers = Object.fromEntries(['accept', 'user-agent'].filter(name => offered.has(name)).map(name => [name, offered.get(name)]));
      } catch {throw failure('PUBLIC_FETCH_FORBIDDEN');}
      const qq = new URL(input).hostname === 'c.y.qq.com';
      if (qq) headers = {accept: 'application/json', 'user-agent': QQ_PUBLIC_USER_AGENT, referer: QQ_PUBLIC_REFERER};
      const response = await publicSession.fetch(input, {method: 'GET', headers, signal: options.signal,
        credentials: 'omit', redirect: 'manual', referrerPolicy: qq ? 'strict-origin' : 'no-referrer',
        referrer: qq ? QQ_PUBLIC_REFERER : '', cache: 'no-store'});
      if (closed) {
        try {await response?.body?.cancel();} catch {}
        throw failure('PUBLIC_FETCH_CLOSED');
      }
      // Keep the original streaming response. Per-service status validation,
      // byte limits, bounded redirects and AbortSignals remain authoritative.
      return response;
    },
    close() {
      closed = true;
      if (!closing) closing = Promise.resolve().then(() => publicSession.closeAllConnections());
      return closing;
    }
  };
}

module.exports = {isApprovedPublicRequest, createPublicFetchService};
