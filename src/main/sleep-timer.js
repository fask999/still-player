'use strict';

function validateSleepTimerRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== 1 || !Object.hasOwn(value, 'minutes') || !Number.isSafeInteger(value.minutes) || value.minutes < 1 || value.minutes > 1440) {
    throw new Error('定时停止需要 1 到 1440 分钟的整数。');
  }
  return {minutes: value.minutes};
}

function createSleepTimer({onExpire, onChange = () => {}, clock = {}} = {}) {
  if (typeof onExpire !== 'function') throw new Error('Sleep timer requires a controlled stop-and-release callback');
  const now = clock.now || (() => performance.now()), wallNow = clock.wallNow || Date.now;
  const setTimer = clock.setTimeout || setTimeout, clearTimer = clock.clearTimeout || clearTimeout;
  let generation = 0, task = null, timer = null, disposed = false;
  let value = {status: 'idle', remainingSeconds: 0};
  function snapshot() {
    const remainingSeconds = task && value.status === 'armed' ? Math.max(0, Math.ceil((task.due - now()) / 1000)) : 0;
    return {...value, remainingSeconds};
  }
  function emit() {try {onChange(snapshot());} catch {}}
  function clear() {if (timer !== null) {clearTimer(timer); timer = null;}}
  function invalidate() {generation++; clear(); task?.controller.abort(); task = null;}
  function schedule(current) {
    if (disposed || task !== current || current.id !== generation) return;
    const remaining = current.due - now();
    if (remaining <= 0) {void expire(current); return;}
    timer = setTimer(() => {timer = null; if (task !== current || current.id !== generation || disposed) return; emit(); schedule(current);}, Math.min(1000, Math.max(1, remaining)));
    timer?.unref?.();
  }
  async function expire(current) {
    if (disposed || task !== current || current.id !== generation) return;
    clear(); value = {status: 'firing', remainingSeconds: 0, deadline: value.deadline}; emit();
    const isCurrent = () => !disposed && task === current && current.id === generation && !current.controller.signal.aborted;
    try {
      const result = await onExpire({signal: current.controller.signal, isCurrent});
      if (!isCurrent()) return;
      if (result?.released !== true) throw new Error('Unverified release');
      task = null; value = {status: 'completed', remainingSeconds: 0}; emit();
    } catch (error) {
      if (!isCurrent()) return;
      task = null;
      value = {status: 'error', remainingSeconds: 0, error: error?.code === 'STILL_CONTEXT_CHANGED' || error?.code === 'STILL_CANCELLED' ?
        '播放状态已改变，本次定时停止未继续执行。' : '定时停止未能确认音频已释放，请检查当前播放状态。'};
      emit();
    }
  }
  return {
    set(request) {
      if (disposed) throw new Error('定时停止已关闭。');
      const {minutes} = validateSleepTimerRequest(request);
      invalidate();
      task = {id: generation, due: now() + minutes * 60000, controller: new AbortController()};
      value = {status: 'armed', remainingSeconds: minutes * 60, deadline: wallNow() + minutes * 60000};
      emit(); schedule(task); return snapshot();
    },
    cancel() {if (disposed) return snapshot(); invalidate(); value = {status: 'cancelled', remainingSeconds: 0}; emit(); return snapshot();},
    getStatus: snapshot,
    dispose() {if (disposed) return; disposed = true; invalidate(); value = {status: 'idle', remainingSeconds: 0};}
  };
}

module.exports = {validateSleepTimerRequest, createSleepTimer};
