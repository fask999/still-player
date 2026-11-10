'use strict';

const {boundedMilliseconds, errorWith} = require('./foobar-transport');

const cancelled = () => Object.assign(new Error('播放请求已被较新的播放或控制操作取消。'), {code: 'STILL_CANCELLED'});
const active = value => value?.available !== false && ['playing', 'paused'].includes(value?.state);
const explicitAppleHandoffContexts = new WeakSet();
function isExplicitAppleHandoffContext(value) {
  if (!value || !explicitAppleHandoffContexts.has(value)) return false;
  try {value.check(); return true;} catch {return false;}
}

// Adapters own their cancellable materialization/verification work. cancelPending()
// must invalidate all future commits synchronously and return a barrier for already
// dispatched transport writes only. A play promise must never occupy this lane.
function createPlaybackCoordinator({engines, defaultSource = 'local', prepareAppleHandoff, fenceTimeoutMs, clock = {}} = {}) {
  if (!engines || !engines[defaultSource]) throw new Error('A default playback engine is required');
  const adapters = new Map(Object.entries(engines));
  const setTimer = clock.setTimeout || setTimeout, clearTimer = clock.clearTimeout || clearTimeout;
  function waitBarrier(promise) {
    let timer;
    return Promise.race([Promise.resolve(promise), new Promise((_resolve, reject) => {
      timer = setTimer(() => reject(errorWith('STILL_TRANSPORT_UNCERTAIN',
        '旧播放写入在时限内未完成；未派发新的引擎交接或控制。')), boundedMilliseconds(fenceTimeoutMs, 25000));
    })]).finally(() => clearTimer(timer));
  }
  const states = new Map(), reads = new Map(), publishedReads = new Map();
  const outputOwners = new Set([defaultSource]);
  const operations = new Set();
  let generation = 0, epoch = 0, revision = 0, intent = null, closed = false, shutdown = null;
  let transition = Promise.resolve(), ownerSource = defaultSource, lastSource = null;

  function adapter(source) {
    const value = adapters.get(source);
    if (!value) throw new Error(`此来源尚未提供可用的播放引擎：${source}`);
    return value;
  }
  function beginIntent(hint = {intent: 'cancel'}) {
    if (closed) throw new Error('Playback coordinator has been closed');
    intent?.controller.abort();
    const controller = new AbortController(), id = ++generation;
    const barriers = new Map();
    for (const [source, engine] of adapters) {
      // Invoke synchronously: a newer play/stop must cancel old pending commits
      // before any asynchronous library lookup, release probe or transport wait.
      try { barriers.set(source, Promise.resolve(engine.cancelPending?.(hint))); }
      catch (error) { barriers.set(source, Promise.reject(error)); }
      barriers.get(source).catch(() => {});
    }
    const context = {generation: id, controller, signal: controller.signal, barriers,
      check() {if (closed || controller.signal.aborted || id !== generation) throw cancelled();}};
    intent = context;
    epoch++;
    return context;
  }
  function run(context, action) {
    let onAbort;
    const interrupted = new Promise((_resolve, reject) => {
      onAbort = () => reject(cancelled());
      context.signal.addEventListener('abort', onAbort, {once: true});
    });
    const work = Promise.resolve().then(() => {context.check(); return action();});
    operations.add(work);
    work.finally(() => operations.delete(work)).catch(() => {});
    return Promise.race([work, interrupted]).finally(() => context.signal.removeEventListener('abort', onAbort));
  }
  function shortTransition(action) {
    const task = transition.then(action);
    transition = task.catch(() => {});
    return task;
  }
  async function read(source) {
    const sequence = (reads.get(source) || 0) + 1, readEpoch = epoch;
    reads.set(source, sequence);
    let value;
    try {
      value = await adapter(source).getState();
      if (!value || typeof value !== 'object') throw new Error('Playback engine returned no state');
    } catch (error) {
      value = {available: false, state: 'unavailable', position: 0, duration: 0, volume: null, error: error.message};
    }
    if (readEpoch === epoch && sequence >= (publishedReads.get(source) || 0)) {
      states.set(source, {...value});
      publishedReads.set(source, sequence);
      revision++;
    }
  }
  function snapshot() {
    const playing = [...states].filter(([, value]) => active(value));
    const source = playing.find(([id]) => id === ownerSource)?.[0] || playing[0]?.[0] || null;
    for (const [id] of playing) outputOwners.add(id);
    if (source) lastSource = source;
    const value = states.get(source || ownerSource || defaultSource) || {
      available: false, state: 'unavailable', position: 0, duration: 0, volume: null,
      error: '尚未读取到播放引擎状态。'
    };
    return {...value, source, lastSource, generation, revision,
      ...(playing.length > 1 ? {conflictingSources: playing.map(([id]) => id), error: '检测到多个引擎同时活动，播放互斥状态未确认。'} : {})};
  }
  async function getState() {
    await Promise.all([...adapters.keys()].map(read));
    return snapshot();
  }
  function checkCurrentSource(source, expectedGeneration) {
    if (closed || !adapters.has(source) || expectedGeneration !== generation || source !== (ownerSource || lastSource || defaultSource) ||
        [...outputOwners].some(owner => owner !== source)) throw errorWith('STILL_CONTEXT_CHANGED', '当前播放来源或播放列表已改变，请刷新后重试。');
  }
  function verifiedState(source, state, stopped = false) {
    const actual = states.get(source);
    if (state.conflictingSources || state.source && state.source !== source || !actual || actual.available !== true ||
        actual.stale === true || actual.controlUncertain === true || !['playing', 'paused', 'stopped'].includes(actual.state) ||
        stopped && actual.state !== 'stopped') throw errorWith('STILL_TRANSPORT_UNCERTAIN', '当前播放或停止读回尚未确认；未继续释放输出。');
  }

  const service = {
    getState,
    cachedHandoffStatus() {return adapters.get('local')?.getHandoffStatus?.() || {current: null, history: [], pendingRestore: false, exitUnverified: false};},
    async getEngineState(source) {adapter(source); await read(source); return {...states.get(source)};},
    currentGeneration: () => generation,
    currentRevision: () => revision,
    // Explicit backend reconnect invalidates in-flight intents synchronously.
    // Its owner may then retire an owned process independently of a hung HTTP
    // barrier; merely invalidating here is never proof that audio has stopped.
    cancelPending() {
      const context = beginIntent();
      return Promise.allSettled([...context.barriers.values()].map(waitBarrier));
    },
    // prepare runs outside the short transition lane, so a slow track lookup or
    // playlist expansion cannot delay a newer play/pause/stop.
    play({source = defaultSource, input, prepare, beforeStart} = {}) {
      let engine, context;
      try {engine = adapter(source); context = beginIntent({intent: 'play', source});}
      catch (error) {return Promise.reject(error);}
      return run(context, async () => {
        const prepared = prepare ? await prepare(context) : input;
        context.check();
        if (source === 'apple' && adapters.get('local')?.needsColdHandoffRestore?.() === true) {
          if ([...outputOwners].some(id => id !== 'local')) throw Object.assign(new Error('冷恢复前仍有其他来源的输出归属；未启动本地内核。'), {code: 'STILL_HANDOFF_RESTORE_CONFLICT'});
          if (typeof prepareAppleHandoff !== 'function') throw Object.assign(new Error('待机元数据需要受控的显式 Apple 恢复准备；未启动或跳过输出门。'), {code: 'STILL_HANDOFF_RESTORE_REQUIRED'});
          explicitAppleHandoffContexts.add(context);
          try {await prepareAppleHandoff(context); context.check();}
          finally {explicitAppleHandoffContexts.delete(context);}
        }
        const preparedHandoffs = [], sourceAlreadyExited = new Set();
        try {
        // Read and preserve local context before stop, outside the short
        // transition lane. Each adapter owns its write/resource barrier.
        for (const previousSource of [...outputOwners].filter(id => id !== source)) {
          const previous = adapter(previousSource);
          if (typeof previous.prepareOutputHandoff !== 'function') continue;
          await waitBarrier(context.barriers.get(previousSource)); context.check();
          preparedHandoffs.push(previous);
          const preparation = await previous.prepareOutputHandoff(context); context.check();
          if (preparation?.sourceAlreadyExited === true) sourceAlreadyExited.add(previousSource);
        }
        let playback;
        try {await shortTransition(async () => {
          context.check();
          for (const previousSource of [...outputOwners].filter(id => id !== source)) {
            const previous = adapter(previousSource);
            await waitBarrier(context.barriers.get(previousSource));
            context.check();
            // A stopped readback is not proof that an exclusive device was
            // released. The adapter must provide independent release evidence.
            if (!sourceAlreadyExited.has(previousSource)) await previous.stop();
            context.check();
            if (typeof previous.releaseOutput !== 'function') throw new Error(`无法确认 ${previousSource} 已释放音频输出；未启动另一播放引擎。`);
            const release = await previous.releaseOutput({signal: context.signal, check: context.check});
            context.check();
            if (release?.released !== true) throw new Error(`未确认 ${previousSource} 已释放音频输出；未启动另一播放引擎。`);
            states.delete(previousSource);
            outputOwners.delete(previousSource);
            if (ownerSource === previousSource) ownerSource = null;
            epoch++;
          }
          context.check();
          // Only an actual lifecycle resource barrier belongs here (for example
          // applying an imported directory to an owned, stopped backend). It
          // must honor context cancellation at every destructive boundary.
          if (beforeStart) {await beforeStart(prepared, context); context.check();}
          ownerSource = source;
          outputOwners.add(source);
          epoch++;
          // Calling play dispatches cancellable adapter work. Deliberately do
          // not return/await its long materialization or verification promise.
          playback = Promise.resolve(engine.play(prepared, context));
          playback.catch(() => {});
        });} catch (error) {
          if (context.generation === generation) {epoch++; await getState();}
          context.check(); throw error;
        }
        let result;
        try {result = await playback;}
        catch (error) {
          if (context.generation === generation) {epoch++; await getState();}
          context.check();
          throw error;
        }
        context.check();
        epoch++;
        const state = await getState();
        context.check();
        return {...state, ...(Number.isInteger(result?.skippedCount) ? {skippedCount: result.skippedCount} : {})};
        } finally {
          for (const previous of preparedHandoffs) await previous.finishOutputHandoff?.(context);
        }
      });
    },
    commandForCurrentSource(source, expectedGeneration, method, ...args) {
      try {checkCurrentSource(source, expectedGeneration);} catch (error) {return Promise.reject(error);}
      return service.command(method, ...args);
    },
    stopAndReleaseForCurrentSource({source, generation: expectedGeneration, signal, isCurrent = () => true, origin} = {}) {
      let context, engine;
      try {
        if (origin !== 'sleep-timer' || typeof isCurrent !== 'function') throw errorWith('STILL_CONTEXT_CHANGED', '定时停止上下文无效。');
        if (signal?.aborted || !isCurrent()) throw cancelled();
        checkCurrentSource(source, expectedGeneration);
        engine = adapter(source);
        if (typeof engine.stop !== 'function' || typeof engine.releaseOutput !== 'function') throw errorWith('STILL_OUTPUT_RELEASE_UNVERIFIED', '当前播放来源没有可核验的停止释放能力。');
        // Claim the generation and invalidate every older commit synchronously,
        // before entering an async read, snapshot, transport or release boundary.
        context = beginIntent({intent: 'command', source, method: 'stop', origin});
      } catch (error) {return Promise.reject(error);}
      const cancel = () => {
        if (intent !== context || generation !== context.generation || context.signal.aborted) return;
        context.controller.abort(); epoch++;
        for (const value of adapters.values()) {
          try {Promise.resolve(value.cancelPending?.({intent: 'cancel', origin})).catch(() => {});} catch {}
        }
      };
      const coordinatorCheck = context.check;
      context.check = () => {
        coordinatorCheck();
        if (signal?.aborted || !isCurrent()) {cancel(); throw cancelled();}
      };
      signal?.addEventListener('abort', cancel, {once: true});
      if (signal?.aborted) cancel();
      return run(context, async () => {
        let prepared = false;
        try {
          await Promise.all([...context.barriers.values()].map(waitBarrier)); context.check();
          const initial = await getState(); context.check(); verifiedState(source, initial);
          let alreadyExited = false;
          if (typeof engine.prepareOutputHandoff === 'function') {
            prepared = true;
            const preparation = await engine.prepareOutputHandoff(context); context.check();
            alreadyExited = preparation?.sourceAlreadyExited === true;
          }
          return await shortTransition(async () => {
            context.check();
            if (!alreadyExited) {
              await engine.stop(context); context.check(); epoch++;
              const stopped = await getState(); context.check(); verifiedState(source, stopped, true);
            }
            context.check();
            const release = await engine.releaseOutput(context); context.check();
            if (release?.released !== true || !release.evidence || typeof release.evidence !== 'object' || Array.isArray(release.evidence) || !Object.keys(release.evidence).length) {
              throw errorWith('STILL_OUTPUT_RELEASE_UNVERIFIED', '停止读回不能证明音频输出已释放。');
            }
            outputOwners.delete(source);
            if (ownerSource === source) ownerSource = null;
            epoch++;
            const state = await getState(); context.check();
            return {released: true, evidence: release.evidence, state};
          });
        } finally {if (prepared) await engine.finishOutputHandoff?.(context);}
      }).finally(() => signal?.removeEventListener('abort', cancel));
    },
    command(method, ...args) {
      let context, engine;
      try {
        context = beginIntent({intent: 'command', source: ownerSource || lastSource || defaultSource, method});
        engine = adapter(ownerSource || lastSource || defaultSource);
        if (typeof engine[method] !== 'function') throw new Error(`当前播放引擎不支持此操作：${method}`);
      } catch (error) {return Promise.reject(error);}
      return run(context, async () => {
        // Controls invalidate an in-flight transition synchronously and enter
        // the adapter immediately; they never wait behind a pending play.
        await engine[method](...args, context);
        context.check(); epoch++;
        const value = await getState(); context.check(); return value;
      });
    },
    beginShutdown() {
      if (shutdown) return shutdown;
      closed = true; intent?.controller.abort(); generation++; epoch++;
      const barriers = [...adapters.values()].map(engine => {
        try {return engine.cancelPending?.({intent: 'quit'});} catch (error) {return Promise.reject(error);}
      });
      shutdown = {settled: Promise.allSettled([...barriers, transition, ...operations])};
      return shutdown;
    },
    close() {return service.beginShutdown().settled;}
  };
  return service;
}

module.exports = {createPlaybackCoordinator, isExplicitAppleHandoffContext};
