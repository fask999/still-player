'use strict';

// One timer and one global in-flight read across all generations. Imports start nothing.
function createRuntimePoll({read, publish, onError = () => {}, intervalMs = 600,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval} = {}) {
  let timer = null, epoch = 0, running = false, inFlight = null;
  async function tick() {
    if (!running || inFlight) return;
    const requested = epoch, token = {};
    const current = () => running && requested === epoch;
    inFlight = token;
    try {
      const value = await read(current);
      if (current()) await publish(value, current);
    } catch (error) {if (current()) onError(error);}
    finally {if (inFlight === token) inFlight = null;}
  }
  function stop() {
    running = false; epoch++;
    if (timer !== null) {clearIntervalFn(timer); timer = null;}
    // Do not clear inFlight: a hung older request must never overlap a new read.
  }
  function start() {
    if (running) return;
    running = true; epoch++;
    const scheduledEpoch = epoch;
    timer = setIntervalFn(() => {if (running && scheduledEpoch === epoch) void tick();}, intervalMs);
  }
  return {start, stop, tick, state: () => ({running, inFlight: inFlight !== null, hasTimer: timer !== null, epoch})};
}
module.exports = {createRuntimePoll};
