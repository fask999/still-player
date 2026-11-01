'use strict';

const {EventEmitter} = require('node:events');
const {isVerifiedBackendSession, isVerifiedBackendChildExit} = require('./backend');
const {createOwnedOutputHandoffStore, handoffError} = require('./owned-output-handoff');

function within(promise, milliseconds) {
  let timer;
  return Promise.race([Promise.resolve(promise), new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('旧播放连接尚未排空；未创建新连接或宣称重连成功。')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

// A stable adapter for the coordinator, with one transport lifetime per verified
// backend session. Reconnect does not clear faults on a live bridge. Only the
// old owned session's exact exit evidence permits disposing and replacing it.
function createFoobarSessionService({createService, backend, serviceOptions = {}, drainTimeoutMs = 5000,
  onUpdate = () => {}, onOutputConnection = () => {}} = {}) {
  if (typeof createService !== 'function' || !backend) throw new Error('A backend and bridge factory are required');
  const events = new EventEmitter();
  let current, connecting = null, disposed = false, handoff = null, pendingRestore = null, pendingRetirement = null;
  const store = serviceOptions.dataDir ? createOwnedOutputHandoffStore({dataDir: serviceOptions.dataDir}) : null;
  let handoffSequence = 0, cachedHandoff = null;
  const handoffHistory = [];
  const sameEndpoint = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const stages = ['CreateDeviceEnumerator', 'GetDevice', 'Activate', 'CastAudioClient', 'GetMixFormat', 'ReadMixFormat', 'Initialize', 'Complete'];
  const safeHr = value => typeof value === 'string' && /^0x[0-9A-Fa-f]{8}$/.test(value) ? value : null;
  const safeProbe = value => value && typeof value === 'object' ? {
    classification: ['released', 'busy', 'unknown', 'disconnected', 'mismatch', 'invalid'].includes(value.classification) ? value.classification : 'unknown',
    trustedEndpoint: value.trustedEndpoint === true,
    endpoint: typeof value.endpoint === 'string' && /^\{0\.0\.0\.00000000\}\.\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/i.test(value.endpoint) ? value.endpoint : null,
    hresult: safeHr(value.hresult),
    operation: value.operation === 'Initialize' ? 'Initialize' : null,
    mode: ['shared', 'exclusive-check'].includes(value.mode) ? value.mode : null,
    stage: stages.includes(value.stage) ? value.stage : null,
    failureStage: stages.includes(value.failureStage) ? value.failureStage : null,
    hresultSource: ['native-return', 'managed-exception', 'not-called', 'legacy-native-return-inferred'].includes(value.hresultSource) ? value.hresultSource : null,
    nativeResults: Array.isArray(value.nativeResults) ? value.nativeResults.slice(0, 12).map(row => ({stage: stages.includes(row?.stage) ? row.stage : null, hresult: safeHr(row?.hresult)})) : [],
    cleanupComplete: typeof value.cleanupComplete === 'boolean' ? value.cleanupComplete : null,
    cleanupFailures: Array.isArray(value.cleanupFailures) ? value.cleanupFailures.slice(0, 12).map(row => ({resource: typeof row?.resource === 'string' && /^[A-Za-z0-9._-]{1,60}$/.test(row.resource) ? row.resource : null, hresult: safeHr(row?.hresult)})) : [],
    initializeCalled: typeof value.initializeCalled === 'boolean' ? value.initializeCalled : null,
    startCalled: typeof value.startCalled === 'boolean' ? value.startCalled : null,
    probeChildExited: typeof value.probeChildExited === 'boolean' ? value.probeChildExited : null,
    probeExitCode: Number.isInteger(value.probeExitCode) ? value.probeExitCode : null,
    actualDacRate: null
  } : null;
  function recordHandoff(phase, {code = null, releaseEvidence = null, cleanupCode = null} = {}) {
    code = typeof code === 'string' && /^STILL_[A-Z0-9_]{1,80}$/.test(code) ? code : code === null ? null : 'STILL_OUTPUT_RELEASE_UNVERIFIED';
    cleanupCode = typeof cleanupCode === 'string' && /^STILL_[A-Z0-9_]{1,80}$/.test(cleanupCode) ? cleanupCode : cleanupCode === null ? null : 'STILL_HANDOFF_EXIT_UNVERIFIED';
    cachedHandoff = {phase, code, cleanupCode, from: 'local', to: 'apple', releaseEvidence: safeProbe(releaseEvidence),
      sourceExited: pendingRestore?.session ? isVerifiedBackendChildExit(backend.getExitEvidence?.(pendingRestore.session), pendingRestore.session) : null,
      sequence: ++handoffSequence};
    handoffHistory.push({...cachedHandoff}); if (handoffHistory.length > 16) handoffHistory.shift();
    events.emit('handoff', structuredClone(cachedHandoff));
  }
  function checkContext(context) {if (context?.signal?.aborted) throw Object.assign(new Error('交接已取消。'), {code: 'STILL_CANCELLED'}); context?.check?.();}
  function observeRetirement() {
    if (!pendingRetirement) return;
    const proof = backend.getExitEvidence?.(pendingRetirement.session);
    if (!isVerifiedBackendChildExit(proof, pendingRetirement.session)) throw handoffError('STILL_HANDOFF_EXIT_UNVERIFIED', '已请求退出的专属内核尚缺 child 退出证明；未允许新写入或重启。');
    pendingRetirement.slot.service.markBackendExited(proof); pendingRetirement.slot.exited = true;
    pendingRestore = {session: pendingRetirement.session, snapshot: pendingRetirement.snapshot}; pendingRetirement = null;
  }
  function cachedSourceExit() {
    const source = pendingRestore?.session, info = backend.getInfo?.();
    if (!source || current.session !== source || !current.exited || info?.available || info?.owned) return null;
    const proof = backend.getExitEvidence?.(source);
    return isVerifiedBackendChildExit(proof, source) ? proof : null;
  }

  function createSlot() {
    const slot = {service: null, key: null, session: null, initialized: false, exited: false};
    slot.service = createService({...serviceOptions, onUpdate: state => {
      if (current === slot) onUpdate(state);
    }});
    for (const name of ['player', 'diagnostic', 'output-connection']) slot.service.on?.(name, value => {
      if (current !== slot) return;
      events.emit(name, value);
      if (name === 'output-connection') onOutputConnection(value);
    });
    return slot;
  }
  current = createSlot();

  function observeExit(slot = current, supplied) {
    if (!slot.session) return false;
    const proof = supplied || backend.getExitEvidence?.(slot.session);
    if (!proof) return false;
    slot.service.markBackendExited(proof);
    slot.exited = true;
    return true;
  }
  async function connect(info) {
    observeRetirement();
    if (disposed) throw new Error('播放连接管理器已关闭。');
    if (!info?.available || !Number.isInteger(info.pid)) throw new Error('专属后端进程与端口尚未核验；未连接播放服务。');
    const session = backend.getSession?.() || null;
    const key = session ? `owned:${session.sessionId}` : `observed:${info.pid}`;
    const old = current;
    observeExit(old);
    if (old.initialized && (old.key !== key || old.exited)) {
      if (!old.session || !observeExit(old)) {
        throw new Error('旧连接缺少同一专属进程的已核验退出证据；保留旧控制屏障，未建立替代连接。');
      }
      await within(old.service.close(), drainTimeoutMs);
      if (disposed) throw new Error('播放连接管理器已关闭。');
      current = createSlot();
    }
    const slot = current;
    slot.key = key; slot.session = session; slot.initialized = true;
    if (session) slot.service.bindBackendSession(session);
    return slot.service.initialize();
  }
  const management = {
    // Trusted adapter operation: the existing release implementation already
    // performs and reads back stop before the endpoint/owned-exit proof.
    // No caller-supplied "alreadyStopped" fact is accepted.
    stopAndReleaseOutput(context = {}) {return management.releaseOutput(context);},
    async initializeHandoff() {
      if (!store) return {pending: false};
      const result = await store.initialize(), record = store.current();
      if (record) {
        const awaitingLocalRestore = record.status === 'awaiting-local' && record.snapshot.playbackState === 'stopped' && record.snapshot.queue.length === 0;
        backend.deferForSavedOutputHandoff?.(record.backendId, record.closedProfileFingerprint, {awaitingLocalRestore});
        pendingRestore = {session: null, sessionId: record.sessionId, backendId: record.backendId, status: record.status, snapshot: record.snapshot}; recordHandoff('standby');
      }
      return result;
    },
    async prepareOutputHandoff(context = {}) {
      checkContext(context);
      observeRetirement();
      if (cachedSourceExit()) {recordHandoff('standby', {releaseEvidence: cachedHandoff?.releaseEvidence}); return {sourceAlreadyExited: true};}
      if (backend.getInfo?.().available !== true || current.exited || pendingRestore) throw handoffError('STILL_HANDOFF_SESSION_UNVERIFIED', '当前本地资源未处于已验证活动会话；未读取或操作离线播放连接。');
      if (handoff) throw handoffError('STILL_HANDOFF_BUSY', '上一次资源交接尚未完成；未开始新交接。');
      const transition = {slot: current, session: current.session, signal: context.signal, lease: null};
      handoff = transition; recordHandoff('snapshot');
      if (typeof current.service.acquireOutputHandoff !== 'function') return;
      transition.lease = await current.service.acquireOutputHandoff(context);
      if (['STILL_HANDOFF_DRAIN_UNVERIFIED', 'STILL_CANCELLED'].includes(transition.lease.error?.code)) {
        recordHandoff('blocked', {code: transition.lease.error.code}); throw transition.lease.error;
      }
      checkContext(context);
    },
    finishOutputHandoff(context = {}) {
      if (!handoff || handoff.signal !== context.signal) return;
      handoff.lease?.release(); handoff = null;
    },
    async releaseOutput(context = {}) {
      checkContext(context); observeRetirement();
      const alreadyExited = cachedSourceExit();
      if (alreadyExited) return {released: true, evidence: {method: 'verified-owned-source-exit', sourceExit: {
        owned: true, verified: true, sessionId: alreadyExited.sessionId, verifiedBy: 'owned-child-process-exit'}}};
      if (backend.getInfo?.().available !== true || current.exited || pendingRestore) throw handoffError('STILL_HANDOFF_SESSION_UNVERIFIED', '离线会话没有本次 owned child 的退出证明；未探测或宣称释放。');
      const transition = handoff;
      if (!transition || transition.slot !== current || transition.signal !== context.signal) return current.service.releaseOutput(context);
      recordHandoff('shared-probe');
      try {
        const proof = await transition.slot.service.releaseOutput(context); checkContext(context);
        recordHandoff('released', {releaseEvidence: proof?.evidence || null}); return proof;
      } catch (primary) {
        const evidence = primary.releaseEvidence;
        recordHandoff('probe-failed', {code: primary.code || 'STILL_OUTPUT_RELEASE_UNVERIFIED', releaseEvidence: evidence || null});
        checkContext(context);
        if (evidence?.classification !== 'unknown' || evidence.trustedEndpoint !== true || evidence.probeChildExited !== true ||
            evidence.initializeCalled !== true || evidence.aborted === true || evidence.timedOut === true) throw primary;
        // Classification is supplied by the shared production probe verifier.
        // Unknown compatibility is retained; it is never re-labelled busy or
        // endpoint availability. Reused/unbranded sessions cannot be exited.
        if (!transition.lease?.snapshot || !store ||
            !sameEndpoint(evidence.endpoint, transition.lease.snapshot.endpoint) || !isVerifiedBackendSession(transition.session) ||
            backend.getSession?.() !== transition.session || typeof backend.retireForOutputHandoff !== 'function') {
          if (transition.lease?.error) {
            const failure = handoffError(transition.lease.error.code || 'STILL_HANDOFF_SNAPSHOT_UNVERIFIED', transition.lease.error.message, evidence);
            failure.cause = primary; recordHandoff('blocked', {code: failure.code, releaseEvidence: evidence}); throw failure;
          }
          throw primary;
        }
        if (backend.getInfo().quietRestartPolicy !== 'stopped-owned-exit') throw handoffError('STILL_HANDOFF_QUIET_RESTART_UNVERIFIED', '未启用 stopped-owned-exit 交接策略；保留专属内核，未用未知探测结果退出。', evidence);
        try {
          const stoppedSnapshot = await transition.lease.verify();
          if (stoppedSnapshot.playbackState !== 'stopped') throw handoffError('STILL_HANDOFF_NOT_STOPPED', '退出前未真实读回 stopped。'); checkContext(context);
          const outputScope = backend.verifyOwnedOutputScope?.(transition.session, transition.lease.snapshot.output);
          if (!outputScope) throw handoffError('STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED', '没有已批准的进程内输出范围证明；未退出后端。');
          await store.save({...stoppedSnapshot, preStopPlaybackState: transition.lease.snapshot.playbackState}, transition.session); checkContext(context);
          if ((await transition.lease.verify()).playbackState !== 'stopped') throw handoffError('STILL_HANDOFF_NOT_STOPPED', '保存后未再次真实读回 stopped。'); checkContext(context);
          recordHandoff('owned-exit', {releaseEvidence: evidence});
          pendingRetirement = {slot: transition.slot, session: transition.session, snapshot: transition.lease.snapshot};
          const exitEvidence = await backend.retireForOutputHandoff(transition.session, {...context, outputScope});
          if (!isVerifiedBackendChildExit(exitEvidence, transition.session)) throw handoffError('STILL_HANDOFF_EXIT_UNVERIFIED', '未收到同一 owned child 的真实退出证明。', evidence);
          transition.slot.service.markBackendExited(exitEvidence); transition.slot.exited = true;
          pendingRestore = {session: transition.session, snapshot: transition.lease.snapshot};
          pendingRetirement = null;
          await store.markExited(backend.getClosedProfileFingerprint?.());
          checkContext(context); recordHandoff('standby', {releaseEvidence: evidence});
          return {released: true, evidence: {probe: evidence, sourceExit: {owned: true, verified: true,
            sessionId: transition.session.sessionId, verifiedBy: 'owned-child-process-exit'}, method: 'verified-owned-source-exit'}};
        } catch (cleanup) {
          const actualExit = backend.getExitEvidence?.(transition.session);
          if (isVerifiedBackendChildExit(actualExit, transition.session)) {
            transition.slot.service.markBackendExited(actualExit); transition.slot.exited = true;
            pendingRestore = {session: transition.session, snapshot: transition.lease.snapshot};
            pendingRetirement = null;
            await store.markExited(backend.getClosedProfileFingerprint?.()).catch(() => {});
          } else if (backend.getOutputRetirementState?.(transition.session)?.exitRequested === false) {
            pendingRetirement = null;
            await store.abandonPrepared(transition.session.sessionId);
          }
          recordHandoff('blocked', {code: primary.code || 'STILL_OUTPUT_RELEASE_UNVERIFIED', releaseEvidence: evidence,
            cleanupCode: cleanup.code || 'STILL_HANDOFF_EXIT_UNVERIFIED'});
          cleanup.code ||= 'STILL_HANDOFF_EXIT_UNVERIFIED'; cleanup.releaseEvidence = evidence; cleanup.cause = primary; throw cleanup;
        }
      }
    },
    async verifyHandoffRestore(context = {}) {
      observeRetirement();
      checkContext(context); if (!pendingRestore) return {verified: true, pending: false};
      if (pendingRestore.status && (pendingRestore.status !== 'awaiting-local' || pendingRestore.snapshot.playbackState !== 'stopped')) throw handoffError('STILL_HANDOFF_RESTORE_UNVERIFIED', '恢复记录不完整或没有保存真实 stopped；未恢复。');
      if (!current.session || current.session === pendingRestore.session || current.session.sessionId === pendingRestore.sessionId ||
          pendingRestore.backendId && current.session.backendId !== pendingRestore.backendId || !isVerifiedBackendSession(current.session)) throw handoffError('STILL_HANDOFF_SESSION_UNVERIFIED', '本次本地播放必须连接新的已核验专属实例。');
      const snapshot = await current.service.verifyOutputHandoffContext(context); checkContext(context);
      if (snapshot.playbackState !== 'stopped') throw handoffError('STILL_HANDOFF_NOT_STOPPED', '新实例没有真实回读 stopped；未恢复旧曲或派发新播放。');
      const result = store.verify(snapshot); checkContext(context);
      await store.clear(); pendingRestore = null; recordHandoff('restored'); return result;
    },
    getHandoffStatus: () => ({current: cachedHandoff ? structuredClone(cachedHandoff) : null, history: structuredClone(handoffHistory), pendingRestore: Boolean(pendingRestore), exitUnverified: Boolean(pendingRetirement)}),
    needsColdHandoffRestore: () => Boolean(pendingRestore?.session === null && pendingRestore.status === 'awaiting-local' &&
      pendingRestore.snapshot.playbackState === 'stopped' && store?.current()?.closedProfileFingerprint?.length === 3),
    getAudioTransportStatus: () => current.service.getAudioTransportStatus?.() || {pending: false},
    connect(info) {
      if (connecting) return connecting;
      connecting = connect(info).finally(() => {connecting = null;});
      return connecting;
    },
    sessionBound: () => Boolean(current.session),
    transportStatus() {
      observeExit();
      return {initialized: current.initialized, sessionBound: Boolean(current.session),
        ...(current.service.transportStatus?.() || {}), backendExited: current.exited};
    },
    markBackendExited(evidence) {
      if (!current.session) throw new Error('当前连接没有已核验的 owned session；未采用退出证据。');
      observeExit(current, evidence);
      return {backendExited: true};
    },
    on: events.on.bind(events), off: events.off.bind(events),
    async close() {
      disposed = true;
      if (connecting) await connecting.catch(() => {});
      observeExit();
      await current.service.close();
      events.removeAllListeners();
    }
  };
  return new Proxy(management, {get(target, name) {
    if (name in target) return target[name];
    const value = current.service[name];
    if (typeof value !== 'function') return value;
    // Capture the bridge at invocation. A delayed method from the old session
    // must never commit through the newly installed session.
    return (...args) => {
      if (['play', 'selectPlaybackContext', 'toggle', 'next', 'previous', 'seek', 'setVolume', 'setOrder', 'queueAdd', 'queueRemove', 'queueClear', 'selectOutput', 'prepareLocations'].includes(name)) observeRetirement();
      const slot = current;
      observeExit(slot);
      return slot.service[name](...args);
    };
  }});
}

module.exports = {createFoobarSessionService};
