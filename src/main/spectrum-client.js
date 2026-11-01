'use strict';
// Read-only, private-backend spectrum transport. Importing starts nothing.
const path = require('node:path');
const fs = require('node:fs');
const { spawn: nativeSpawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { performance } = require('node:perf_hooks');
const { isVerifiedBackendSession } = require('./backend');

const DEFAULT_READER_PATH = path.resolve(__dirname, '../../native/foobar-spectrum/package/StillSpectrumReader.exe');
const LIMIT = 65536, MAX_AGE = 250, FLOOR = -100;
const integer = (n, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= min && n <= max;
const finite = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const near = (a, b) => Math.abs(a - b) <= Math.max(1e-7, Math.abs(b) * 1e-8);
const canonical = value => {
  if (typeof value !== 'string' || value.length > 32768 || /[\0\r\n]/.test(value)) return null;
  // SDK locations may have file:// prepended. No IO, symlink lookup or URL decode.
  const local = value.replace(/^file:\/\//i, '').replace(/\//g, '\\');
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/.exec(local);
  const qualifiedUnc = unc && unc.slice(1).every(part => part !== '.' && part !== '..' && !/[<>:"|?*\x00-\x1f]/.test(part));
  if (!/^[a-z]:\\/i.test(local) && !qualifiedUnc) return null;
  return path.win32.normalize(local).replace(/\\+$/, '').toLowerCase();
};
const FRAME_KEYS = ['schemaVersion', 'source', 'analyzer', 'status', 'reason', 'sequence', 'sessionId', 'backendPid',
  'generation', 'track', 'capturedAtUnixMs', 'ageMs', 'streamTimeSeconds', 'sampleRate', 'channels', 'fftSize', 'window',
  'calibration', 'floorDbfs', 'binHz', 'windowSeconds', 'bands'];
const READER_REASONS = new Set(['component-not-connected', 'server-pid-mismatch', 'malformed-frame', 'read-timeout']);
const NATIVE_REASONS = new Set(['component-not-connected', 'not-playing', 'paused', 'stopped', 'stale-frame',
  'no-track', 'no-pcm', 'insufficient-pcm', 'unsupported-format', 'analysis-failed', 'stream-unavailable', 'initializing']);

function validateFrame(frame, expectedPid) {
  if (!exactKeys(frame, FRAME_KEYS) || frame.schemaVersion !== 1 || frame.source !== 'foobar2000' ||
      frame.analyzer !== 'sdk-visualisation-pcm' || !['running', 'paused', 'stopped', 'unavailable', 'stale'].includes(frame.status) ||
      !(frame.reason === null || (typeof frame.reason === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(frame.reason))) ||
      !integer(frame.sequence, 1) || !integer(frame.generation) || frame.backendPid !== expectedPid ||
      typeof frame.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(frame.sessionId) ||
      frame.fftSize !== 4096 || frame.window !== 'hann-periodic' || frame.calibration !== 'rms-full-scale-1' || frame.floorDbfs !== FLOOR ||
      !Array.isArray(frame.bands)) return false;
  if (frame.track !== null && (!exactKeys(frame.track, ['path', 'subsong']) || !canonical(frame.track.path) || !integer(frame.track.subsong, 0, 0xffffffff))) return false;
  for (const key of ['capturedAtUnixMs', 'ageMs', 'streamTimeSeconds']) if (frame[key] !== null && !finite(frame[key], 0, Number.MAX_SAFE_INTEGER)) return false;
  if (frame.status !== 'running') return frame.bands.length === 0 &&
    ['sampleRate', 'channels', 'binHz', 'windowSeconds', 'capturedAtUnixMs', 'ageMs', 'streamTimeSeconds'].every(key => frame[key] === null);
  if (!frame.track || frame.reason !== null || frame.capturedAtUnixMs === null || frame.ageMs === null || frame.streamTimeSeconds === null ||
      !integer(frame.sampleRate, 8000, 768000) || !integer(frame.channels, 1, 32) ||
      !finite(frame.binHz, 0, 768000) || !near(frame.binHz, frame.sampleRate / 4096) ||
      !finite(frame.windowSeconds, 0, 1) || !near(frame.windowSeconds, 4096 / frame.sampleRate) || frame.bands.length !== 48) return false;
  const upper = Math.min(20000, frame.sampleRate / 2);
  for (let i = 0; i < 48; i++) {
    const band = frame.bands[i], low = 20 * Math.exp(Math.log(upper / 20) * i / 48);
    const high = i === 47 ? upper : 20 * Math.exp(Math.log(upper / 20) * (i + 1) / 48);
    if (!exactKeys(band, ['lowHz', 'highHz', 'dbfs', 'hasBins']) || !finite(band.lowHz, 20, upper) ||
        !finite(band.highHz, 20, upper) || band.lowHz >= band.highHz || !near(band.lowHz, low) || !near(band.highHz, high) ||
        !finite(band.dbfs, FLOOR, 60) || typeof band.hasBins !== 'boolean') return false;
    // Verify actual FFT-bin membership, including the last inclusive edge.
    let hasBins = false;
    for (let k = 1; k <= 2048; k++) {
      const frequency = k * frame.binHz;
      if (frequency >= band.lowHz && (frequency < band.highHz || (i === 47 && frequency <= band.highHz))) { hasBins = true; break; }
    }
    if (band.hasBins !== hasBins || (!hasBins && band.dbfs !== FLOOR)) return false;
  }
  return true;
}

function createSpectrumClient(options = {}) {
  if (typeof options.getBackendSession !== 'function') throw new TypeError('getBackendSession is required');
  const readerPath = path.resolve(options.readerPath || DEFAULT_READER_PATH);
  // The main process may explicitly supply the same packaged helper. This API
  // cannot be used to select another executable or a renderer-provided pipe.
  if (readerPath.toLowerCase() !== DEFAULT_READER_PATH.toLowerCase()) throw new TypeError('Only the packaged spectrum reader is allowed');
  const launch = options.spawn || nativeSpawn, platform = options.platform || process.platform;
  const readerExists = options.readerExists || (() => fs.existsSync(readerPath));
  const now = options.clock || Date.now;
  const monotonicNow = options.monotonicClock || (() => performance.now());
  let disposed = false, childState = null, context = null, contextKey = null, session = null;
  let cache = null, failure = 'component-not-connected', boundaryTime = null, stream = null, discontinuityFence = null;
  let revision = 0;
  let consecutiveFailures = 0, retryAt = 0, cooldownSession = null;
  function observeCooldownSession(nextSession) {
    // Loss of verification is not a new lifetime. A temporary null followed by
    // the same branded token must not bypass the reader crash-loop cooldown.
    if (nextSession && nextSession !== cooldownSession) {
      cooldownSession = nextSession; consecutiveFailures = 0; retryAt = 0;
    }
  }
  const notify = (event, reason, retryInMs = 0) => {
    try {options.onDiagnostic?.(event, {level: 'warning', code: reason, failures: consecutiveFailures, retryInMs});} catch {}
  };
  function readerFailed(reason, owned) {
    if (owned?.failureRecorded) return;
    if (owned) owned.failureRecorded = true;
    consecutiveFailures = Math.min(consecutiveFailures + 1, 1000);
    const delay = consecutiveFailures < 3 ? 0 : Math.min(30000, 1000 * 2 ** Math.min(consecutiveFailures - 3, 5));
    const time = monotonicNow();
    retryAt = Number.isFinite(time) ? time + delay : Infinity;
    notify(delay ? 'spectrum-reader-cooldown' : 'spectrum-reader-failed', reason, delay);
  }
  function readerHealthy(owned) {
    // A single frame followed by a crash must not defeat the rapid-exit limit.
    if (consecutiveFailures && monotonicNow() - owned.startedAt >= 5000) {
      consecutiveFailures = 0; retryAt = 0;
      notify('spectrum-reader-recovered', null);
    }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  function currentSession() {
    try {
      const value = options.getBackendSession();
      return isVerifiedBackendSession(value) && integer(value.pid, 1, 0xffffffff) ? value : null;
    } catch { return null; }
  }
  function stopChild() {
    const owned = childState; childState = null;
    if (!owned) return;
    for (const [emitter, event, listener] of owned.listeners) emitter.removeListener(event, listener);
    // Only this exact returned child is ours. No PID lookup, taskkill or backend command.
    try { owned.child.stdin?.end(); } catch {}
    try { owned.child.kill(); } catch {}
    // A failed asynchronous spawn may still emit error after disposal.
    owned.child?.on?.('error', () => {});
  }
  function fail(reason, stop = false) {
    if (stop && childState && ['malformed-frame', 'reader-unavailable', 'frame-order-invalid', 'component-session-replayed'].includes(reason)) readerFailed(reason, childState);
    ++revision; cache = null; failure = reason; if (stop) stopChild();
  }
  function reset(nextContext, nextKey, nextSession, time) {
    ++revision;
    stopChild(); cache = null;
    if (session !== nextSession) { stream = null; discontinuityFence = null; }
    observeCooldownSession(nextSession);
    failure = discontinuityFence ? 'awaiting-native-discontinuity' : 'component-not-connected';
    context = nextContext; contextKey = nextKey; session = nextSession;
    boundaryTime = Math.max(time, discontinuityFence?.boundaryWall ?? time);
  }
  function empty(status = 'unavailable', reason = failure) {
    return { schemaVersion: 1, source: context?.source || 'local', status, available: false, reason,
      trackId: context?.trackId ?? null, generation: context?.generation ?? null,
      units: 'dBFS', floorDbfs: FLOOR, calibration: 'rms-full-scale-1', fftSize: 4096, window: 'hann-periodic',
      sampleRate: null, analyzedSampleRate: null, channels: null, binHz: null, windowSeconds: null, streamTimeSeconds: null,
      capturedAtUnixMs: null, ageMs: null, bands: [] };
  }
  function cacheAge(time, monotonicTime, nativeAge = 0) {
    if (!cache || !finite(time, 0, Number.MAX_SAFE_INTEGER) || !finite(monotonicTime, 0, Number.MAX_SAFE_INTEGER)) return null;
    const elapsed = monotonicTime - cache.receivedAtMonotonic, wallElapsed = time - cache.receivedAt;
    if (elapsed < 0 || wallElapsed < 0) return null;
    // Anchor every observation to the ORIGINAL receipt. Wall time may only
    // tighten the bound; a rollback cannot undo elapsed monotonic time, a larger
    // native age, or a previous wall-clock observation. No receipt is renewed.
    const age = Math.max(cache.ageAnchor + elapsed, cache.initialAge + wallElapsed, nativeAge);
    cache.ageAnchor = Math.max(cache.ageAnchor, age - elapsed);
    return age;
  }
  function accept(envelope, owned) {
    if (childState !== owned || disposed) return;
    if (currentSession() !== session) { fail('backend-session-unverified', true); return; }
    if (exactKeys(envelope, ['protocol', 'kind', 'reason']) && envelope.protocol === 1 && envelope.kind === 'unavailable' && READER_REASONS.has(envelope.reason)) {
      fail(envelope.reason); return;
    }
    if (!exactKeys(envelope, ['protocol', 'kind', 'serverPid', 'frame']) || envelope.protocol !== 1 || envelope.kind !== 'frame' ||
        envelope.serverPid !== session.pid || !validateFrame(envelope.frame, session.pid)) { fail('malformed-frame', true); return; }
    const frame = envelope.frame, time = now(), monotonicTime = monotonicNow();
    if (!finite(time, 0, Number.MAX_SAFE_INTEGER) || !finite(monotonicTime, 0, Number.MAX_SAFE_INTEGER)) { fail('stale-frame', true); return; }
    if (stream && frame.sessionId !== stream.id) {
      if (stream.retired.has(frame.sessionId)) { fail('component-session-replayed', true); return; }
      const retired = new Set(stream.retired); retired.add(stream.id);
      // Bound memory under a malfunctioning server; require a new backend session.
      if (retired.size > 16) { fail('component-session-replayed', true); return; }
      stream = { id: frame.sessionId, generation: -1, sequence: 0, signature: null, lastAge: null, retired };
      cache = null;
    }
    if (!stream) stream = { id: frame.sessionId, generation: -1, sequence: 0, signature: null, lastAge: null, retired: new Set() };
    // The server reserializes ageMs on each connection without making a new
    // analysis. Every other field of the same sequence must remain identical.
    const signature = JSON.stringify(FRAME_KEYS.filter(key => key !== 'ageMs').map(key => frame[key]));
    if (frame.generation < stream.generation || frame.sequence < stream.sequence) { fail('frame-order-invalid', true); return; }
    if (frame.sequence === stream.sequence) {
      // A repeat may increase the age lower bound, never refresh the receipt,
      // capture time or bars. Different contents under the same seq are invalid.
      if (frame.generation !== stream.generation || signature !== stream.signature ||
          (frame.ageMs !== null && stream.lastAge !== null && frame.ageMs < stream.lastAge)) fail('frame-order-invalid', true);
      else {
        stream.lastAge = frame.ageMs;
        if (cache) {
          const age = cacheAge(time, monotonicTime, frame.ageMs || 0);
          if (age === null || age > MAX_AGE) fail('stale-frame');
        }
      }
      return;
    }
    stream.generation = frame.generation; stream.sequence = frame.sequence; stream.signature = signature; stream.lastAge = frame.ageMs;
    if (frame.status !== 'running') {
      fail(NATIVE_REASONS.has(frame.reason) ? frame.reason : 'component-unavailable'); return;
    }
    if (!frame.track || canonical(frame.track.path) !== context.path || frame.track.subsong !== context.subsong) { fail('track-mismatch'); return; }
    const age = Math.max(frame.ageMs, time - frame.capturedAtUnixMs);
    if (frame.capturedAtUnixMs > time || frame.capturedAtUnixMs < boundaryTime || age > MAX_AGE || time < boundaryTime) { fail('stale-frame'); return; }
    if (discontinuityFence) {
      const fence = discontinuityFence;
      const windowMs = frame.windowSeconds * 1000, sinceInvalidation = monotonicTime - fence.boundaryMonotonic;
      const waiting = fence.componentSessionId === null
        ? !Number.isFinite(sinceInvalidation) || sinceInvalidation < 0 || sinceInvalidation < windowMs ||
          frame.capturedAtUnixMs - windowMs < fence.boundaryWall
        : frame.sessionId === fence.componentSessionId && frame.generation <= fence.nativeGeneration;
      if (waiting) { fail('awaiting-native-discontinuity'); return; }
      // A genuinely new component identity was already checked against retired
      // sessions above. Nonrunning/old-track frames never retire this fence.
      discontinuityFence = null;
    }
    ++revision; cache = { frame, receivedAt: time, receivedAtMonotonic: monotonicTime, initialAge: age, ageAnchor: age }; failure = null;
    readerHealthy(owned);
  }
  function startChild() {
    if (childState || disposed) return;
    if (platform !== 'win32') { fail('platform-unsupported'); return; }
    if (!readerExists()) { fail('reader-missing'); return; }
    const attemptTime = monotonicNow();
    if (retryAt > 0 && (!Number.isFinite(attemptTime) || attemptTime < retryAt)) {fail('reader-cooldown'); return;}
    let child;
    try { child = launch(readerPath, ['--pid', String(session.pid), '--interval-ms', '50'], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'], cwd: path.dirname(readerPath)
    }); } catch { readerFailed('reader-unavailable'); fail('reader-unavailable'); return; }
    const owned = { child, buffer: Buffer.alloc(0), listeners: [], startedAt: monotonicNow(), failureRecorded: false }; childState = owned;
    const listen = (emitter, event, fn) => { emitter.on(event, fn); owned.listeners.push([emitter, event, fn]); };
    if (!child?.stdout?.on || !child?.on) { readerFailed('reader-unavailable', owned); fail('reader-unavailable', true); return; }
    listen(child.stdout, 'data', data => {
      if (childState !== owned) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (chunk.length > LIMIT) { fail('malformed-frame', true); return; }
      owned.buffer = Buffer.concat([owned.buffer, chunk]);
      while (childState === owned) {
        const index = owned.buffer.indexOf(10);
        if (index < 0) { if (owned.buffer.length > LIMIT) fail('malformed-frame', true); return; }
        if (index === 0 || index > LIMIT) { fail('malformed-frame', true); return; }
        const line = owned.buffer.subarray(0, index); owned.buffer = owned.buffer.subarray(index + 1);
        try { accept(JSON.parse(decoder.decode(line)), owned); } catch { fail('malformed-frame', true); return; }
      }
    });
    const failedTransport = reason => {
      if (childState !== owned) return;
      readerFailed(reason, owned); fail(reason, true);
    };
    listen(child.stdout, 'error', () => failedTransport('reader-unavailable'));
    listen(child, 'error', () => failedTransport('reader-unavailable'));
    for (const event of ['exit', 'close']) listen(child, event, () => failedTransport(owned.buffer.length ? 'malformed-frame' : 'component-not-connected'));
    // EPIPE during shutdown is an owned-helper transport failure, never fatal to Node.
    if (child.stdin?.on) listen(child.stdin, 'error', () => failedTransport('reader-unavailable'));
  }
  function readCurrent(input) {
    const source = input?.source === 'apple' ? 'apple' : 'local';
    const state = input?.state;
    const generation = input?.generation;
    const track = input?.currentTrack;
    const trackId = input?.currentTrackId ?? track?.id ?? null;
    const validId = trackId === null || (typeof trackId === 'string' && trackId.length <= 1024);
    const next = { source, state, generation: integer(generation) ? generation : null, trackId: validId ? trackId : null,
      path: canonical(track?.path), subsong: track?.subsong };
    const nextSession = currentSession(), time = now();
    const key = JSON.stringify([source, state, next.generation, next.trackId, next.path, next.subsong]);
    if (contextKey !== key || session !== nextSession) reset(next, key, nextSession, time);
    if (disposed) return empty('unavailable', 'disposed');
    if (source === 'apple') return empty('unavailable', 'apple-protected-spectrum-unavailable');
    if (!['local', 'apple'].includes(input?.source) || !['playing', 'paused', 'stopped', 'unavailable'].includes(state) ||
        !integer(generation) || !validId || !finite(time, 0, Number.MAX_SAFE_INTEGER)) { fail('invalid-context', true); return empty(); }
    if (state === 'paused' || state === 'stopped') return empty(state, state);
    if (state !== 'playing') return empty('unavailable', 'playback-unavailable');
    if (!next.path || !integer(next.subsong, 0, 0xffffffff)) return empty('unavailable', 'invalid-context');
    if (!session) return empty('unavailable', 'backend-session-unverified');
    startChild();
    if (!cache) return empty();
    const age = cacheAge(time, monotonicNow());
    if (age === null || age > MAX_AGE) { fail('stale-frame'); return empty('stale', 'stale-frame'); }
    const frame = cache.frame;
    return { schemaVersion: 1, source: 'local', status: 'running', available: true, reason: null,
      trackId: context.trackId, generation: context.generation, componentSource: 'foobar2000', analyzer: frame.analyzer,
      componentSessionId: frame.sessionId, componentGeneration: frame.generation, sequence: frame.sequence, backendPid: session.pid,
      capturedAtUnixMs: frame.capturedAtUnixMs, ageMs: age, units: 'dBFS', floorDbfs: FLOOR, calibration: frame.calibration,
      fftSize: frame.fftSize, window: frame.window, sampleRate: frame.sampleRate, analyzedSampleRate: frame.sampleRate, channels: frame.channels,
      binHz: frame.binHz, windowSeconds: frame.windowSeconds, streamTimeSeconds: frame.streamTimeSeconds,
      bands: frame.bands.map(band => ({ ...band })) };
  }
  async function read(input) {
    const snapshot = readCurrent(input), requestedRevision = revision;
    // Yield only a microtask, never wait for startup or a pipe read. A source
    // switch/dispose/protocol failure before delivery invalidates a pending read.
    await Promise.resolve();
    if (disposed) return empty('unavailable', 'disposed');
    if (revision !== requestedRevision) return empty('unavailable', 'snapshot-invalidated');
    if (snapshot.available && currentSession() !== session) { fail('backend-session-unverified', true); return empty(); }
    if (snapshot.available) {
      const age = cacheAge(now(), monotonicNow());
      if (age === null || age > MAX_AGE) { fail('stale-frame'); return empty('stale', 'stale-frame'); }
      snapshot.ageMs = age;
    }
    return snapshot;
  }
  function invalidate() {
    if (disposed) return null;
    const time = now(), monotonicTime = monotonicNow();
    // A mutation may precede the first spectrum read. Bind current verified
    // identity now, without spawning, so that first read cannot mistake it for
    // a new backend and accidentally discard the no-baseline window fence.
    const nextSession = currentSession();
    if (session !== nextSession) { session = nextSession; stream = null; }
    observeCooldownSession(nextSession);
    const token = Object.freeze(Object.create(null)), hasBaseline = integer(stream?.generation);
    discontinuityFence = { token, backendSession: session, componentSessionId: hasBaseline ? stream.id : null,
      nativeGeneration: hasBaseline ? stream.generation : null,
      boundaryWall: finite(time, 0, Number.MAX_SAFE_INTEGER) ? time : Infinity,
      boundaryMonotonic: finite(monotonicTime, 0, Number.MAX_SAFE_INTEGER) ? monotonicTime : Infinity };
    boundaryTime = discontinuityFence.boundaryWall;
    // The main process calls BEFORE dispatching an audio discontinuity. This
    // only cancels our reader; it sends no command to the native analyzer/player.
    fail('awaiting-native-discontinuity', true);
    return token;
  }
  function settleInvalidation(token, disposition) {
    if (disposed || !discontinuityFence || token !== discontinuityFence.token ||
        !['dispatched', 'uncertain', 'not-dispatched'].includes(disposition)) return false;
    if (disposition === 'not-dispatched') {
      discontinuityFence = null;
      const time = now();
      boundaryTime = Math.max(boundaryTime, finite(time, 0, Number.MAX_SAFE_INTEGER) ? time : Infinity);
      // Exact transport evidence may cancel the strong fence, never restore
      // an old cache/partial read, reset native high-water marks or issue audio IO.
      fail('component-not-connected', true);
    }
    return true;
  }
  function dispose() { ++revision; disposed = true; cache = null; stopChild(); }
  function getDiagnostics() {
    const remaining = retryAt - monotonicNow();
    return {consecutiveFailures, coolingDown: remaining > 0, retryInMs: Number.isFinite(remaining) ? Math.max(0, Math.ceil(remaining)) : 30000,
      childActive: childState !== null, reason: failure};
  }
  return { read, invalidate, settleInvalidation, dispose, getDiagnostics };
}

module.exports = { createSpectrumClient, DEFAULT_READER_PATH };
