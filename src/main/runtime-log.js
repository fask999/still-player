'use strict';

// The only runtime console sink. Never serialize caller text or Error objects.
const LIMIT = 200;
const EVENTS = Object.freeze({
  'runtime-event': '运行时事件。',
  'startup-failed': '应用启动失败。',
  'single-instance': '此数据目录已有运行中的应用。',
  'uncaught-exception': '主进程发生未捕获异常，正在安全退出。',
  'unhandled-rejection': '主进程发生未处理拒绝，正在安全退出。',
  'fatal-shutdown-failed': '异常退出期间未能确认完整清理。',
  'renderer-console': '界面报告运行时消息。',
  'preload-error': '界面预加载失败。',
  'renderer-exited': '界面进程退出。',
  'service-unavailable': '可选服务暂不可用。',
  'shutdown-failed': '安全退出尚未完成，仅保留只读状态与诊断。',
  'cover-gc-skipped': '本次退出未执行封面清理。',
  'cover-gc-expired': '封面清理预算已结束，后续删除已停止。',
  'cover-gc-pending': '已提交的封面删除仍在结束中，安全退出尚待完成。',
  'cover-gc-failed': '可选封面清理未能全部完成。',
  'cover-gc-complete': '退出时的封面清理已结束。',
  'poll-failed': '读取播放状态失败。',
  'spectrum-reader-failed': '频谱读取器异常结束。',
  'spectrum-reader-cooldown': '频谱读取器暂时冷却。',
  'spectrum-reader-recovered': '频谱读取器已恢复。',
  'smoke-blocked': '只读检查已阻止更改命令。',
  'smoke-complete': '界面只读检查结束。',
  'backend-startup-uncertain': '后端未就绪且启动身份未确认，应用正在异常退出。'
});
const CODES = new Set(['STILL_BACKEND_STARTUP_UNCERTAIN', 'STILL_RUNTIME_FATAL', 'STILL_SHUTDOWN_FAILED',
  'STILL_BACKEND_EXITED', 'STILL_HTTP_TIMEOUT', 'STILL_TRANSPORT_UNCERTAIN', 'STILL_BACKEND_IDENTITY_MISMATCH',
  'STILL_BACKEND_INVALID_RESPONSE', 'STILL_BACKEND_ACCESS_DENIED', 'STILL_BACKEND_REDIRECT_REJECTED',
  'STILL_HTTP_READ_FAILED', 'STILL_HTTP_READ_TIMEOUT', 'reader-unavailable', 'component-not-connected',
  'malformed-frame', 'reader-cooldown']);
const LEVELS = new Set(['debug', 'info', 'warning', 'error']);
const FILES = new Set(['main.js', 'preload.js', 'index.html', 'app.js', 'features.js', 'glass.js', 'spectrum-client.js']);
function own(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  try {return Object.getOwnPropertyDescriptor(value, key)?.value;} catch {return undefined;}
}
function safeEntry(event, details = {}, time) {
  const selected = typeof event === 'string' && Object.hasOwn(EVENTS, event) ? event : 'runtime-event';
  const level = own(details, 'level'), code = own(details, 'code'), source = own(details, 'source');
  const row = {event: selected, level: LEVELS.has(level) ? level : 'warning', message: EVENTS[selected]};
  if (typeof time === 'number' && Number.isFinite(time) && time >= 0) row.recordedAt = time;
  if (CODES.has(code)) row.code = code;
  // Only known source basenames are retained; an arbitrary basename may itself be a secret.
  if (typeof source === 'string' && source.length <= 2048) {
    const name = source.replaceAll('\\', '/').split('/').at(-1);
    if (FILES.has(name)) row.source = name;
  }
  for (const key of ['line', 'exitCode', 'failures', 'retryInMs']) {
    const value = own(details, key);
    if (Number.isSafeInteger(value) && value >= (key === 'exitCode' ? -0x80000000 : 0) && value <= 0xffffffff) row[key] = value;
  }
  if (selected.startsWith('cover-gc-')) for (const key of ['collected', 'pendingDeletes']) {
    const value = own(details, key);
    if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) row[key] = value;
  }
  return row;
}
function sanitizeRuntimeLog(raw) {
  const entries = own(raw, 'entries'), rows = [];
  const length = own(entries, 'length');
  if (Array.isArray(entries) && Number.isSafeInteger(length) && length >= 0 && length <= 1000000) {
    for (let i = Math.max(0, length - LIMIT); i < length; i++) {
      const row = own(entries, String(i));
      if (row && typeof row === 'object') rows.push(safeEntry(own(row, 'event'), row, own(row, 'recordedAt')));
    }
  }
  const dropped = own(raw, 'dropped');
  return {limit: LIMIT, dropped: Number.isSafeInteger(dropped) && dropped >= 0 ? dropped : 0, entries: rows};
}
function createRuntimeLog({now = Date.now, sink = row => {
  if (row.level === 'error') console.error(`STILL: ${row.message}`);
}} = {}) {
  const entries = []; let dropped = 0;
  return {
    record(event, details) {
      let time;
      try {time = now();} catch {time = undefined;}
      const row = safeEntry(event, details, time);
      entries.push(row);
      if (entries.length > LIMIT) {entries.shift(); dropped++;}
      // Sink sees a detached, reconstructed record, never the offered object.
      try {sink({...row});} catch { /* Logging must not throw recursively. */ }
      return {...row};
    },
    snapshot() {return {limit: LIMIT, dropped, entries: entries.map(row => ({...row}))};}
  };
}
function installRuntimeFailureHandlers({processTarget = process, log, onFatal, exit = code => processTarget.exit(code),
  cleanupTimeoutMs = 10000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout} = {}) {
  let fatal = false, completion = null;
  const trigger = event => {
    if (fatal) return completion;
    fatal = true; processTarget.exitCode = 1;
    log.record(event, {level: 'error'});
    // Invoke synchronously so IPC and polling gates close before yielding.
    let cleanup;
    try {cleanup = Promise.resolve(onFatal());} catch {cleanup = Promise.reject(new Error('Fatal cleanup failed'));}
    let timeout;
    const deadline = new Promise((_, reject) => {timeout = setTimeoutFn(() => reject(new Error('Fatal cleanup deadline')), cleanupTimeoutMs);});
    completion = Promise.race([cleanup, deadline]).catch(() => {log.record('fatal-shutdown-failed', {level: 'error'});})
      .finally(() => {clearTimeoutFn(timeout); exit(1);});
    return completion;
  };
  const exception = () => {void trigger('uncaught-exception');};
  const rejection = () => {void trigger('unhandled-rejection');};
  processTarget.on('uncaughtException', exception);
  processTarget.on('unhandledRejection', rejection);
  return {isFatal: () => fatal, trigger, completion: () => completion,
    configure(next) {if (typeof next.onFatal === 'function') onFatal = next.onFatal; if (typeof next.exit === 'function') exit = next.exit;},
    dispose() {processTarget.removeListener('uncaughtException', exception); processTarget.removeListener('unhandledRejection', rejection);}};
}
module.exports = {createRuntimeLog, sanitizeRuntimeLog, installRuntimeFailureHandlers};
