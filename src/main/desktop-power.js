'use strict';

function isConfirmedPlayback(player) {
  return player?.available === true && player.state === 'playing' && ['local', 'apple'].includes(player.source) &&
    player.stale !== true && player.controlUncertain !== true && player.readOnly !== true &&
    player.connectionStatus !== 'degraded' && !Array.isArray(player.conflictingSources);
}

function createPlaybackPowerController({powerSaveBlocker, enabled = true, freshnessMs = 10000,
  onChange = () => {}, onError = () => {}, clock = {}} = {}) {
  const setTimer = clock.setTimeout || setTimeout, clearTimer = clock.clearTimeout || clearTimeout;
  const now = clock.now || (() => performance.now());
  let blockerId = null, timer = null, lastObservation = -Infinity, playing = false, disposed = false;
  let error = null;
  const available = Boolean(powerSaveBlocker && ['start', 'stop', 'isStarted'].every(method => typeof powerSaveBlocker[method] === 'function'));
  const emit = () => {try {onChange(status());} catch {}};
  const report = () => {error = '播放防休眠暂不可用。'; try {onError({code: 'STILL_DESKTOP_POWER'});} catch {}};
  function started() {
    if (blockerId === null || !available) return false;
    try {return powerSaveBlocker.isStarted(blockerId) === true;} catch {report(); return false;}
  }
  function release() {
    if (blockerId === null) return;
    const id = blockerId;
    // Keep the ID if Windows/Electron has not acknowledged release; a later
    // observation/dispose can retry this same owned request without starting another.
    try {
      powerSaveBlocker.stop(id);
      if (!powerSaveBlocker.isStarted(id)) blockerId = null;
      else report();
    } catch {report();}
  }
  function status() {
    const active = started();
    return {enabled: enabled === true, active, status: !available || error ? 'unavailable' : !enabled ? 'disabled' : active ? 'active' : 'idle', ...(error ? {error} : {})};
  }
  function reconcile() {
    if (timer !== null) {clearTimer(timer); timer = null;}
    const fresh = now() - lastObservation < freshnessMs;
    const hold = !disposed && enabled && available && playing && fresh;
    if (!hold) release();
    else {
      if (!started()) {
        if (blockerId !== null) release();
        if (blockerId === null) {
          try {
            const id = powerSaveBlocker.start('prevent-app-suspension');
            if (!Number.isInteger(id) || id < 0) throw new Error('Invalid blocker id');
            blockerId = id;
            if (!started()) {release(); report();} else error = null;
          } catch {report();}
        }
      }
      if (!disposed) {
        timer = setTimer(() => {timer = null; reconcile();}, Math.max(1, freshnessMs - (now() - lastObservation)));
        timer?.unref?.();
      }
    }
    emit();
  }
  return {
    observe(player) {if (disposed) return; playing = isConfirmedPlayback(player); lastObservation = now(); reconcile();},
    setEnabled(value) {if (disposed) return; enabled = value === true; reconcile();},
    getStatus: status,
    dispose() {disposed = true; playing = false; reconcile();}
  };
}

module.exports = {isConfirmedPlayback, createPlaybackPowerController};
