'use strict';

// A caller deadline is never a cancellation of a physical POST. Each original
// lane keeps its own causal lifetime, including consumption of the response body.
const MAX_TRANSPORT_WAIT_MS = 25000;
const boundedMilliseconds = (value, fallback) => Number.isFinite(value) && value > 0
  ? Math.max(1, Math.min(MAX_TRANSPORT_WAIT_MS, Math.floor(value))) : fallback;
const laneForRoute = route => /^(?:player(?:\/|$)|outputs\/active$)/.test(route) ? 'control'
  : /^playqueue(?:\/|$)/.test(route) ? 'queue' : 'preparation';
const errorWith = (code, message, extra = {}) => Object.assign(new Error(message), {code, ...extra});
const uncertainError = lane => errorWith('STILL_TRANSPORT_UNCERTAIN',
  '操作在时限内未确认；已发送的写入仍可能完成，相关新写入已暂停。请等待真实完成或安全退出专属内核后重连。', {lane});
const SAFETY_CODES = new Set(['STILL_BACKEND_IDENTITY_MISMATCH', 'STILL_BACKEND_INVALID_RESPONSE',
  'STILL_BACKEND_ACCESS_DENIED', 'STILL_BACKEND_REDIRECT_REJECTED']);
const isSafetyError = error => SAFETY_CODES.has(error?.code);
const LOCAL_CODES = new Set([...SAFETY_CODES, 'STILL_TRANSPORT_UNCERTAIN', 'STILL_HTTP_READ_FAILED',
  'STILL_HTTP_READ_TIMEOUT', 'STILL_CANCELLED', 'STILL_BACKEND_EXITED', 'STILL_HANDOFF_BUSY',
  'STILL_OUTPUT_DISCONNECTED', 'STILL_OUTPUT_UNKNOWN', 'STILL_OUTPUT_CHANGED',
  'STILL_HANDOFF_SNAPSHOT_UNVERIFIED', 'STILL_HANDOFF_CONTEXT_CHANGED',
  'STILL_SHUTDOWN_WRITES_CLOSED', 'STILL_SHUTDOWN_NOT_OWNED']);

// Shutdown admission is permanent for this bridge lifetime. Its one stop closure
// is private to the main process and cannot authorize play, queue or deck writes.
function createShutdownWriteGate({isOwned, onQuiesce, stop}) {
  const permit = Object.freeze({});
  let quiesced = false, used = false;
  const closedError = () => errorWith('STILL_SHUTDOWN_WRITES_CLOSED', '播放服务已进入关闭只读阶段；未发送新的写入。');
  const shutdown = Object.freeze({stop() {
    if (used) return Promise.reject(closedError()); used = true;
    if (!isOwned()) return Promise.reject(errorWith('STILL_SHUTDOWN_NOT_OWNED', '没有同一专属 owned 会话证明；未发送关闭停止写入。'));
    try {return Promise.resolve(stop(permit));} catch (error) {return Promise.reject(error);}
  }});
  return {begin() {if (!quiesced) {quiesced = true; onQuiesce();} return shutdown;},
    assert(route, extra = {}) {
      if (!quiesced) return;
      if (route === 'player/stop' && extra.shutdownPermit === permit && isOwned()) return;
      throw closedError();
    },
    get quiesced() {return quiesced;}};
}

function createFoobarTransport({baseUrl, fetch: fetcher, timeoutMs, fenceTimeoutMs, clock = {},
  beforeDispatch = () => {}, exitSignal, backendExitedError, onAudioDispatch,
  onChange = () => {}, onSafetyError = () => {}, forbiddenHint = () => ''} = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]', '::1', 'localhost'].includes(base.hostname) ||
      base.username || base.password || base.search || base.hash) throw new Error('Beefweb bridge 只允许本机 HTTP 地址。');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const timeout = boundedMilliseconds(timeoutMs, 4000), fenceTimeout = boundedMilliseconds(fenceTimeoutMs, MAX_TRANSPORT_WAIT_MS);
  const setTimer = clock.setTimeout || setTimeout, clearTimer = clock.clearTimeout || clearTimeout;
  const pending = new Set(), latched = new Map();
  let pendingAudio = 0;
  function fault(lane) {
    return latched.get(lane) || [...pending].find(record => record.lane === lane && record.deadlineError)?.deadlineError || null;
  }
  function assertLane(lane) {const error = fault(lane); if (error && !exitSignal?.aborted) throw error;}
  function latch(lane, cause) {
    if (exitSignal?.aborted || latched.has(lane)) return;
    const error = uncertainError(lane); error.cause = cause;
    latched.set(lane, error); onChange();
  }
  function markDeadline(lane, error, onlyRecord) {
    let changed = false;
    for (const record of pending) if (record.lane === lane && (!onlyRecord || record === onlyRecord) && !record.deadlineError) {
      record.deadlineError = error; changed = true;
    }
    if (changed) onChange();
  }
  function waitForFence(promise, {lane = 'control', check = () => {}, onTimeout = () => {}, allowFault = false} = {}) {
    if (!allowFault) {try {check(); assertLane(lane);} catch (error) {return Promise.reject(error);}}
    let timer;
    return Promise.race([Promise.resolve(promise), new Promise((_resolve, reject) => {
      timer = setTimer(() => {
        const error = uncertainError(lane); onTimeout(error); markDeadline(lane, error); reject(error);
      }, fenceTimeout);
    })]).finally(() => clearTimer(timer));
  }
  function safety(error) {latch('control', error); onSafetyError(error); return error;}
  function sanitizedFailure(error, write) {
    if (LOCAL_CODES.has(error?.code)) return error;
    return errorWith(write ? 'STILL_TRANSPORT_UNCERTAIN' : 'STILL_HTTP_READ_FAILED',
      write ? '本机播放写入连接中断；无法确认该写入是否完成。' : '本机 foobar2000/Beefweb 连接中断。');
  }
  async function request(route, body, extra = {}) {
    const write = body !== undefined, lane = write ? laneForRoute(route) : null;
    beforeDispatch(route, body, extra);
    if (write) assertLane(lane);
    const url = new URL(route.replace(/^\//, ''), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw safety(errorWith(
      'STILL_BACKEND_REDIRECT_REJECTED', '播放请求超出已核验的本机接口范围；未发送。'));
    const deadlineMs = boundedMilliseconds(extra.timeoutMs, timeout);
    const controller = new AbortController();
    const readSignals = [controller.signal, exitSignal, extra.context?.signal].filter(Boolean);
    const signal = write ? exitSignal : AbortSignal.any(readSignals);
    const record = write ? {lane, dispatched: false, deadlineError: null} : null;
    let rejectSafety;
    const safetyFailure = new Promise((_resolve, reject) => {rejectSafety = reject;});
    const failSafety = error => {safety(error); if (write && record.dispatched) latch(lane, error); rejectSafety(error); return error;};
    let observer = null, audioPending = false, observerSettled = false;
    const ignore = value => {try {if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});} catch {}};
    const settleObserver = disposition => {
      if (observerSettled) return; observerSettled = true;
      try {ignore(observer?.(disposition));} catch {}
    };
    const audioKind = !write ? null : /^player\/play(?:\/|$)/.test(route) ? 'play'
      : ['player/pause', 'player/stop', 'player/next', 'player/previous'].includes(route) ? route.slice(7)
      : route === 'player' && body?.position != null ? 'seek' : null;
    if (record) pending.add(record);
    const http = Promise.resolve().then(async () => {
      beforeDispatch(route, body, extra); extra.settlementContext?.check();
      if (write) assertLane(lane);
      const init = {method: write ? 'POST' : 'GET', redirect: 'error',
        headers: write ? {'Content-Type': 'application/json'} : {}, body: write ? JSON.stringify(body) : undefined, signal};
      if (audioKind) {
        try {
          const observation = onAudioDispatch?.({kind: audioKind, source: 'local'}); ignore(observation);
          if (observation && typeof observation.then !== 'function' && typeof observation.settle === 'function') observer = observation.settle.bind(observation);
        } catch {}
      }
      // Synchronous observers have no authority. A newer real intent may have
      // invalidated this ticket while it was being observed.
      beforeDispatch(route, body, extra); extra.settlementContext?.check();
      if (audioKind) {audioPending = true; pendingAudio++;}
      if (record) record.dispatched = true;
      let response;
      try {response = await fetcher(url, init);} catch (error) {
        if (error?.cause?.code === 'ERR_INVALID_REDIRECT' || /redirect/i.test(String(error?.cause?.message || ''))) {
          throw failSafety(errorWith('STILL_BACKEND_REDIRECT_REJECTED', '本机接口返回重定向；播放连接已关闭写入。'));
        }
        if (exitSignal?.aborted) throw backendExitedError();
        extra.context?.check();
        throw errorWith(write ? 'STILL_TRANSPORT_UNCERTAIN' : controller.signal.aborted ? 'STILL_HTTP_READ_TIMEOUT' : 'STILL_HTTP_READ_FAILED',
          write ? '本机播放写入连接中断；无法确认该写入是否完成。' : '本机 foobar2000/Beefweb 连接中断。');
      }
      if (!response || typeof response.text !== 'function' || typeof response.ok !== 'boolean') throw failSafety(errorWith(
        'STILL_BACKEND_INVALID_RESPONSE', '本机端口未返回有效的 Beefweb 响应。'));
      let headerError = null;
      if (response.status != null && (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) ||
          !response.ok && response.status == null) headerError = errorWith('STILL_BACKEND_INVALID_RESPONSE', '本机端口未返回有效的 Beefweb 状态码。');
      if (response.redirected === true || response.status >= 300 && response.status < 400) headerError = errorWith(
        'STILL_BACKEND_REDIRECT_REJECTED', '本机接口返回重定向；播放连接已关闭写入。');
      if (response.status === 401 || response.status === 403) headerError = errorWith('STILL_BACKEND_ACCESS_DENIED',
        `Beefweb ${response.status}：本机接口拒绝访问。${response.status === 403 ? forbiddenHint() : ''}`, {status: response.status});
      if (headerError) {
        // Security failure closes admission as soon as headers arrive. A POST
        // still retains its physical body fence even after this foreground fails.
        failSafety(headerError);
        if (!write) {controller.abort(); throw headerError;}
      }
      let text;
      try {text = await response.text();} catch {
        if (exitSignal?.aborted) throw backendExitedError();
        if (headerError) throw headerError;
        extra.context?.check();
        throw errorWith(write ? 'STILL_TRANSPORT_UNCERTAIN' : controller.signal.aborted ? 'STILL_HTTP_READ_TIMEOUT' : 'STILL_HTTP_READ_FAILED',
          write ? '本机播放写入响应中断；无法确认该写入是否完成。' : '本机播放状态响应中断。');
      }
      if (exitSignal?.aborted) throw backendExitedError();
      if (headerError) throw headerError;
      if (!response.ok) {
        throw errorWith(write ? 'STILL_TRANSPORT_UNCERTAIN' : 'STILL_HTTP_READ_FAILED', `Beefweb ${response.status}：本机接口未成功完成请求。`, {status: response.status});
      }
      let value = null;
      if (text) {try {value = JSON.parse(text);} catch {throw failSafety(errorWith('STILL_BACKEND_INVALID_RESPONSE', '本机端口返回的不是有效 Beefweb JSON。'));}}
      extra.onResult?.(value);
      return value;
    });
    let onExit;
    const ended = new Promise((_resolve, reject) => {
      onExit = () => reject(backendExitedError());
      if (exitSignal?.aborted) onExit(); else exitSignal?.addEventListener('abort', onExit, {once: true});
    });
    const actual = Promise.race([http, ended]).then(value => {
      settleObserver(record?.dispatched || !write ? 'dispatched' : 'not-dispatched'); return value;
    }, failure => {
      settleObserver(record?.dispatched ? 'uncertain' : 'not-dispatched');
      if (record?.dispatched && failure?.code !== 'STILL_BACKEND_EXITED' &&
          !(failure?.status >= 400 && failure.status < 500 && !isSafetyError(failure))) latch(lane, sanitizedFailure(failure, true));
      throw sanitizedFailure(failure, write);
    }).finally(() => {
      if (audioPending) pendingAudio--;
      if (record) {pending.delete(record); onChange();}
      exitSignal?.removeEventListener('abort', onExit);
    });
    const owner = extra.context || extra.settlementContext;
    if (write) {
      record.actual = actual;
      owner?.pendingPosts.add(actual);
      actual.finally(() => {owner?.pendingPosts.delete(actual); extra.onSettled?.();}).catch(() => {});
    }
    let timer, onReadAbort;
    try {
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimer(() => {
          if (write) {
            const error = uncertainError(lane); markDeadline(lane, error, record); reject(error);
          } else {controller.abort(); reject(errorWith('STILL_HTTP_READ_TIMEOUT', '本机播放状态读取超时。'));}
        }, deadlineMs);
      });
      const interruptedRead = write ? new Promise(() => {}) : new Promise((_resolve, reject) => {
        onReadAbort = () => reject(exitSignal?.aborted ? backendExitedError() : extra.context?.signal?.aborted
          ? errorWith('STILL_CANCELLED', '读取已取消。') : errorWith('STILL_HTTP_READ_TIMEOUT', '本机播放状态读取超时。'));
        if (signal.aborted) onReadAbort(); else signal.addEventListener('abort', onReadAbort, {once: true});
      });
      const value = await Promise.race([actual, deadline, interruptedRead, safetyFailure]);
      extra.context?.check(); return value;
    } catch (error) {extra.context?.check(); throw sanitizedFailure(error, write);}
    finally {clearTimer(timer); if (onReadAbort) signal.removeEventListener('abort', onReadAbort);}
  }
  return {base, request, fault, assertLane, latch, waitForFence,
    drain: lane => Promise.allSettled([...pending].filter(row => !lane || row.lane === lane).map(row => row.actual)),
    status: () => ({controlUncertain: Boolean(fault('control')) && !exitSignal?.aborted,
      queueUncertain: Boolean(fault('queue')) && !exitSignal?.aborted, preparationUncertain: Boolean(fault('preparation')) && !exitSignal?.aborted,
      uncertainLanes: exitSignal?.aborted ? [] : ['control', 'queue', 'preparation'].filter(lane => fault(lane)),
      faultCode: ['control', 'queue', 'preparation'].some(lane => fault(lane)) && !exitSignal?.aborted ? 'STILL_TRANSPORT_UNCERTAIN' : null,
      pendingControlRequests: [...pending].filter(row => row.lane === 'control').length,
      pendingQueueRequests: [...pending].filter(row => row.lane === 'queue').length,
      pendingPreparationRequests: [...pending].filter(row => row.lane === 'preparation').length}),
    audioStatus: () => ({pending: !exitSignal?.aborted && pendingAudio > 0})};
}

module.exports = {createFoobarTransport, createShutdownWriteGate, MAX_TRANSPORT_WAIT_MS, boundedMilliseconds, laneForRoute, isSafetyError, errorWith};
