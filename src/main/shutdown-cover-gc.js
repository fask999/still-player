'use strict';

// Only the normal before-quit tail owns this object. Keep the raw library
// operation across retries: an AbortSignal is not proof that submitted IO ended.
function createShutdownCoverGc({library, record = () => {}, budgetMs = 250, maxDeletes = 64,
  now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout} = {}) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 0 || budgetMs > 60000 ||
      !Number.isSafeInteger(maxDeletes) || maxDeletes < 0) throw new TypeError('Invalid shutdown cover collection budget.');
  let operation = null, completion = null, controller = null;
  const cancel = () => controller?.abort();
  const log = (event, details = {}) => {try {record(event, details);} catch { /* Maintenance logging cannot fail quit. */ }};
  const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 0xffffffff) : 0;
  const pendingFailure = () => Object.assign(new Error('A submitted cover deletion has not finished; safe shutdown remains pending.'), {code: 'STILL_COVER_GC_PENDING'});
  async function finish({eligible = false, retainUrls = [], isCurrent = () => true} = {}) {
    if (!isCurrent()) {cancel(); return;}
    // An earlier pending deletion must be observed even in read-only recovery.
    // Sticky shutdownFailure only prevents starting a different collection.
    if (!operation && (!eligible || typeof library?.collectCovers !== 'function' || typeof library?.getStatus !== 'function')) {
      log('cover-gc-skipped'); return;
    }
    if (!operation) {
      let status;
      try {status = library.getStatus();} catch {log('cover-gc-failed'); return;}
      if (status?.status !== 'ready' || status.readOnly === true || status.recovered === true) {log('cover-gc-skipped'); return;}
    }
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimeoutFn(() => {cancel(); resolve(false);}, budgetMs);
    });
    try {
      if (!operation) {
        controller = new AbortController();
        try {operation = library.collectCovers({retainUrls: [...retainUrls], signal: controller.signal, deadlineAt: now() + budgetMs, maxDeletes});}
        catch {log('cover-gc-failed'); return;}
        if (!operation || typeof operation.getState !== 'function') {
          // Only the current library's operation-bound state is accepted. Never
          // infer completion of unknown work from a timer or an aborted signal.
          cancel(); Promise.resolve(operation).catch(() => {}); throw pendingFailure();
        }
        completion = Promise.resolve(operation).then(result => {
          const failures = count(result?.errors?.length), collected = count(result?.removed?.length);
          log(failures ? 'cover-gc-failed' : result?.recoveryRetention ? 'cover-gc-skipped' : result?.interrupted ? 'cover-gc-expired' : 'cover-gc-complete', {failures, collected});
          return true;
        }, () => {log('cover-gc-failed'); return true;});
      }
      const settled = await Promise.race([completion, deadline]);
      if (!isCurrent()) {cancel(); return;}
      if (!settled) {
        cancel();
        const state = operation.getState();
        if (state.pendingDeletes > 0) {
          log('cover-gc-pending', {pendingDeletes: count(state.pendingDeletes)});
          throw pendingFailure();
        }
        log('cover-gc-expired');
      }
    } finally {clearTimeoutFn(timer);}
  }
  return {finish, cancel};
}

function retainedPlayerCoverUrls(player) {
  const url = player?.currentTrack?.coverUrl;
  return typeof url === 'string' && url ? [url] : [];
}

module.exports = {createShutdownCoverGc, retainedPlayerCoverUrls};
