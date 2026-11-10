'use strict';

const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {normalizeHresult} = require('./output-release-evidence');
const executeFile = promisify(execFile);
const sameOutput = (a, b) => Boolean(a && b && a.typeId === b.typeId && a.deviceId === b.deviceId);

// GetState is only a connection observation. It never activates a client,
// initializes audio, or supplies playback progress / hardware format evidence.
function createOutputConnection({getSelected, getOutputs, endpointForOutput, isClosed, probeOutputState,
  probePath, timeoutMs = 1500, ttlMs = 5000, now = Date.now, clock = {}, onChange = () => {}}) {
  const ttl = Number.isFinite(ttlMs) ? Math.max(0, Math.min(5000, ttlMs)) : 5000;
  let epoch = 0, pending = null, retryRequired = false, checkedAt = -Infinity;
  const setTimer = clock.setTimeout || setTimeout, clearTimer = clock.clearTimeout || clearTimeout;
  let connection = {status: 'unknown', endpointId: null, lastCheckedAt: null, retryRequired: false,
    message: '尚未读回所选音频设备。', actualDacRate: null};
  function snapshot() {
    const selected = getSelected(), outputs = getOutputs();
    const selectionMatches = outputs && selected ? sameOutput(outputs.active, selected) : null;
    return {...connection, output: selected && {...selected}, retryRequired: retryRequired || selectionMatches === false,
      selectionMatches, stale: !Number.isFinite(checkedAt) || now() - checkedAt >= ttl, actualDacRate: null};
  }
  function update(value) {
    const previous = snapshot(); connection = value;
    if (value.endpointId && value.status !== 'connected' && value.lastCheckedAt) retryRequired = true;
    const next = snapshot(); onChange(next, previous); return next;
  }
  function invalidate({selectionChanged = false} = {}) {
    epoch++; checkedAt = -Infinity;
    pending?.controller.abort(); pending = null;
    if (selectionChanged) {
      retryRequired = false;
      update({status: 'unknown', endpointId: endpointForOutput(getSelected()), lastCheckedAt: null,
        message: '正在核对所选音频设备连接。', actualDacRate: null});
    }
  }
  async function refresh({force = false} = {}) {
    const output = getSelected(), endpointId = endpointForOutput(output), readEpoch = epoch;
    if (isClosed()) return snapshot();
    if (!endpointId) return update({status: 'unknown', endpointId: null, lastCheckedAt: null,
      message: output ? '此输出无法精确映射到 CoreAudio 端点；连接状态未知。' : '尚未读回所选音频设备。', actualDacRate: null});
    if (!force && connection.endpointId === endpointId && now() - checkedAt < ttl) return snapshot();
    if (pending?.epoch === readEpoch) return pending.promise;
    const controller = new AbortController();
    const promise = (async () => {
      let next;
      try {
        const limit = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(5000, timeoutMs)) : 1500;
        let timer, result;
        try {
          const observation = typeof probeOutputState === 'function'
            ? Promise.resolve().then(() => probeOutputState({output: {...output}, endpointId, signal: controller.signal}))
            : executeFile(probePath, [endpointId, 'state'], {windowsHide: true, timeout: limit,
              maxBuffer: 64 * 1024, signal: controller.signal}).then(({stdout}) => JSON.parse(String(stdout).trim()));
          result = await Promise.race([observation, new Promise((_resolve, reject) => {
            timer = setTimer(() => {controller.abort(); reject(new Error('CONNECTION_READ_TIMEOUT'));}, limit);
          })]);
        } finally {clearTimer(timer);}
        if (result?.endpoint?.toLowerCase() !== endpointId.toLowerCase() || result.operation !== 'GetState' || result.mode !== 'state' ||
            result.clientActivated !== false || result.initializeCalled !== false || result.startCalled !== false || result.actualDacRate !== null) {
          throw new Error('INVALID_CONNECTION_EVIDENCE');
        }
        const hresult = normalizeHresult(result.hresult);
        const missing = result.deviceFound === false && result.deviceNotFound === true && hresult === '0x80070490' &&
          result.state === null && result.active === false;
        const known = hresult === '0x00000000' && result.deviceFound === true &&
          (!Object.hasOwn(result, 'deviceNotFound') || result.deviceNotFound === false) &&
          [1, 2, 4, 8].includes(result.state) && result.active === (result.state === 1);
        if (!missing && !known) throw new Error('INVALID_CONNECTION_EVIDENCE');
        if (result.schemaVersion != null) {
          const expectedStages = missing ? ['GetDevice'] : ['GetDevice', 'GetId', 'GetState'];
          const nativeSequence = Array.isArray(result.nativeResults) && result.nativeResults.length === expectedStages.length &&
            expectedStages.every((stage, index) => result.nativeResults[index]?.stage === stage &&
              normalizeHresult(result.nativeResults[index]?.hresult) === (missing ? '0x80070490' : '0x00000000'));
          if (result.schemaVersion !== 3 || result.deviceNotFound !== missing || result.stage !== (missing ? 'GetDevice' : 'GetState') ||
              result.failureStage !== (missing ? 'GetDevice' : null) || result.hresultSource !== 'native-return' || !nativeSequence ||
              result.cleanupComplete !== true || result.released !== true || !Array.isArray(result.cleanupFailures) ||
              result.cleanupFailures.length !== 0 || result.initialized !== false || result.error ||
              (missing ? result.observedEndpoint !== null || result.endpointState !== null :
                result.observedEndpoint?.toLowerCase() !== endpointId.toLowerCase() || result.endpointState !== result.state)) {
            throw new Error('INVALID_CONNECTION_EVIDENCE');
          }
        }
        const connected = known && result.active;
        const reason = missing ? 'endpoint-not-found' : ({2: 'device-disabled', 4: 'device-not-present', 8: 'device-unplugged'})[result.state] || null;
        // Preserve only the validated connection evidence; helper stdout may
        // contain arbitrary provider fields and is never copied into diagnostics.
        const evidence = {endpoint: endpointId, operation: 'GetState', mode: 'state', deviceFound: result.deviceFound,
          deviceNotFound: result.deviceNotFound === true, hresult, state: result.state, active: result.active === true,
          clientActivated: false, initializeCalled: false, startCalled: false, actualDacRate: null};
        const message = connected ? retryRequired ? '所选音频设备已重新连接；请重试设备，再明确发起播放。' : '所选音频设备已连接；播放需由用户明确发起。' :
          missing ? '所选音频设备的端点已失效（0x80070490）；USB 设备重插后可能改变标识，请在输出设置中重新选择设备。' :
            result.state === 2 ? '所选音频设备已被禁用，请检查设备状态后重试，或在输出设置中重新选择设备。' :
              '所选音频设备已断开或不可用，请连接原设备后重试；若仍不可用，请在输出设置中重新选择设备。';
        next = {status: connected ? 'connected' : 'disconnected', endpointId, lastCheckedAt: new Date(now()).toISOString(), reason,
          requiresReselection: missing, message,
          evidence: {probe: 'IMMDevice.GetState', result: evidence, initializeCalled: false, startCalled: false}, actualDacRate: null};
      } catch (error) {
        next = {status: 'unknown', endpointId, lastCheckedAt: new Date(now()).toISOString(),
          message: '无法确认所选音频设备连接，请检查设备与诊断后重试。',
          probeError: error?.code === 'ENOENT' ? '连接探测工具不可用（ENOENT）。' : '连接探测未提供可核验的 GetState 证据。', actualDacRate: null};
      }
      if (isClosed() || readEpoch !== epoch) return snapshot();
      checkedAt = now(); return update(next);
    })();
    pending = {epoch: readEpoch, controller, promise};
    return promise.finally(() => {if (pending?.promise === promise) pending = null;});
  }
  return {snapshot, refresh, invalidate, confirmRetry() {retryRequired = false; return update(connection);},
    close() {invalidate();}, get pending() {return pending?.promise;}};
}

module.exports = {createOutputConnection, sameOutput};
