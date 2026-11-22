'use strict';

function withoutProbeTime({lastCheckedAt, ...connection}) {return connection;}

// Revisions order deliveries, and read timestamps/counters describe the latest
// observation. They are carried on each delivery without triggering one.
function comparablePlayer({revision, readAt, lastGoodAt, consecutiveReadFailures, ...player}) {
  if (player.outputConnection) player.outputConnection = withoutProbeTime(player.outputConnection);
  return player;
}

function comparableSources(value) {
  if (!value.sources?.local) return value;
  const {lastGoodAt, consecutiveReadFailures, ...local} = value.sources.local;
  if (local.outputConnection) local.outputConnection = withoutProbeTime(local.outputConnection);
  return {...value, sources: {...value.sources, local}};
}

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
module.exports = {createRuntimePoll, comparablePlayer, comparableSources};
