'use strict';

// Renderer projection of the reviewed main-only spectrum client. No media IO,
// process creation or renderer-supplied backend/track identity belongs here.
const {createHash} = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {isVerifiedBackendSession} = require('./backend');
const MAX_AGE = 250;
const own = (value, key) => {if (!value || typeof value !== 'object') return undefined; try {return Object.getOwnPropertyDescriptor(value, key)?.value;} catch {return undefined;}};
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : null;
const REASONS = new Set(['component-not-connected', 'awaiting-native-discontinuity', 'backend-session-unverified', 'component-session-replayed',
  'frame-order-invalid', 'invalid-context', 'malformed-frame', 'platform-unsupported', 'reader-missing', 'reader-unavailable', 'stale-frame',
  'track-mismatch', 'snapshot-invalidated', 'disposed', 'apple-protected-spectrum-unavailable', 'playback-unavailable', 'paused', 'stopped',
  'server-pid-mismatch', 'read-timeout', 'component-unavailable', 'not-playing', 'no-track', 'no-pcm', 'insufficient-pcm', 'unsupported-format',
  'analysis-failed', 'stream-unavailable', 'initializing']);
function emptySpectrum({source = 'local', status = 'unavailable', reason = 'spectrum-unavailable', trackId = null, generation = null} = {}) {
  return {schemaVersion: 1, source, status, available: false, reason, trackId, generation, units: 'dBFS', floorDbfs: -100, ceilingDbfs: 0,
    calibration: 'rms-full-scale-1', analyzedSampleRate: null, fftSize: 4096, window: 'hann-periodic', channels: null,
    streamId: null, sequence: null, ageMs: null, bands: []};
}
function createPlayerSpectrumService({client, getPlayer, getGeneration, getBackendInfo, getBackendSession, getAudioTransportStatus,
  monotonicClock = () => performance.now()} = {}) {
  const lifetimes = new Map(); let disposed = false;
  function view() {
    const player = getPlayer?.(), generation = getGeneration?.(), info = getBackendInfo?.(), session = getBackendSession?.();
    const source = own(player, 'source') === 'apple' ? 'apple' : 'local', trackId = id(own(player, 'currentTrackId') ?? own(own(player, 'currentTrack'), 'id'));
    const base = {source, trackId, generation: integer(generation) ? generation : null};
    let reason;
    if (disposed) reason = 'disposed';
    else if (!player || own(player, 'generation') !== generation || !integer(generation)) reason = 'cached-generation-mismatch';
    else if (source === 'apple') reason = 'apple-protected-spectrum-unavailable';
    else if (own(player, 'source') !== 'local' || own(player, 'available') !== true || own(player, 'simulatedUIFixture') === true) reason = 'playback-unavailable';
    else if (own(player, 'state') !== 'playing') reason = ['paused', 'stopped'].includes(own(player, 'state')) ? own(player, 'state') : 'playback-unavailable';
    else if (own(getAudioTransportStatus?.(), 'pending') !== false) reason = 'audio-transport-pending';
    else if (own(info, 'status') === 'standby' || own(info, 'pendingHandoff') === true || own(info, 'available') !== true || own(info, 'verified') !== true ||
        own(info, 'owned') !== true || !isVerifiedBackendSession(session)) reason = 'backend-session-unverified';
    else if (typeof own(own(player, 'currentTrack'), 'path') !== 'string' || !own(own(player, 'currentTrack'), 'path') ||
        !integer(own(own(player, 'currentTrack'), 'subsong'), 0, 0xffffffff)) reason = 'invalid-context';
    const args = !reason ? {source: 'local', state: 'playing', currentTrack: own(player, 'currentTrack'), currentTrackId: trackId, generation} :
      {source, state: 'unavailable', currentTrackId: null, generation: base.generation};
    return {player, session, generation, base, args, reason};
  }
  function clear(context) {
    try {const pending = client.read(context.args); if (pending && typeof pending.catch === 'function') pending.catch(() => {});} catch {}
  }
  function emptyFor(context, reason = context.reason) {
    const status = ['paused', 'stopped'].includes(reason) ? reason : 'unavailable';
    return emptySpectrum({...context.base, trackId: reason === 'cached-generation-mismatch' ? null : context.base.trackId, status, reason});
  }
  function same(a, b) {return !b.reason && a.player === b.player && a.session === b.session && a.generation === b.generation;}
  function reconstruct(frame, context, age) {
    const rate = own(frame, 'analyzedSampleRate'), channels = own(frame, 'channels'), sequence = own(frame, 'sequence');
    const component = own(frame, 'componentSessionId'), componentGeneration = own(frame, 'componentGeneration'), rows = own(frame, 'bands');
    if (own(frame, 'schemaVersion') !== 1 || own(frame, 'source') !== 'local' || own(frame, 'status') !== 'running' || own(frame, 'available') !== true ||
        own(frame, 'generation') !== context.generation || own(frame, 'trackId') !== context.base.trackId || own(frame, 'backendPid') !== context.session.pid || own(frame, 'units') !== 'dBFS' ||
        own(frame, 'floorDbfs') !== -100 || own(frame, 'calibration') !== 'rms-full-scale-1' || own(frame, 'fftSize') !== 4096 || own(frame, 'window') !== 'hann-periodic' ||
        !integer(rate, 8000, 768000) || own(frame, 'sampleRate') !== rate || !integer(channels, 1, 32) || !integer(sequence, 1) || !integer(componentGeneration) ||
        typeof component !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(component) || !Array.isArray(rows) || own(rows, 'length') !== 48) return null;
    const bands = []; let edge = 20;
    for (let index = 0; index < 48; index++) {
      const row = own(rows, String(index)), lowHz = own(row, 'lowHz'), highHz = own(row, 'highHz'), dbfs = own(row, 'dbfs'), hasBins = own(row, 'hasBins');
      if (![lowHz, highHz, dbfs].every(finite) || Math.abs(lowHz - edge) > 1e-5 || highHz <= lowHz || highHz > Math.min(20000, rate / 2) + 1e-5 ||
          dbfs < -100 || typeof hasBins !== 'boolean' || (!hasBins && dbfs !== -100)) return null;
      bands.push({lowHz, highHz, dbfs, hasBins}); edge = highHz;
    }
    if (Math.abs(edge - Math.min(20000, rate / 2)) > 1e-5) return null;
    const streamId = createHash('sha256').update(JSON.stringify([context.session.sessionId, context.session.backendId, component, componentGeneration])).digest('hex');
    return {schemaVersion: 1, source: 'local', status: 'running', available: true, reason: null, trackId: context.base.trackId, generation: context.generation,
      units: 'dBFS', floorDbfs: -100, ceilingDbfs: 0, calibration: 'rms-full-scale-1', analyzedSampleRate: rate, fftSize: 4096,
      window: 'hann-periodic', channels, streamId, sequence, ageMs: age, bands};
  }
  return {
    refresh() {if (disposed) return; try {clear(view());} catch {}},
    async read() {
      if (disposed) return emptySpectrum({reason: 'disposed'});
      let context;
      try {context = view();} catch {return emptySpectrum({reason: 'spectrum-unavailable'});}
      if (context.reason) {if (!disposed) clear(context); return emptyFor(context);}
      let frame; const requestedAt = monotonicClock();
      try {frame = await client.read(context.args);} catch {return emptyFor(context, 'reader-unavailable');}
      // Last microtask before returning: no pipe/PCM wait, and no old identity
      // may be relabelled under a newly observed coordinator generation.
      await Promise.resolve();
      let latest;
      try {latest = view();} catch {return emptyFor(context, 'spectrum-unavailable');}
      if (!same(context, latest)) {if (!disposed) clear(latest); return emptyFor(latest, latest.reason || 'snapshot-invalidated');}
      if (own(frame, 'available') !== true) return emptyFor(context, REASONS.has(own(frame, 'reason')) ? own(frame, 'reason') : 'spectrum-unavailable');
      const time = monotonicClock(), rawAge = own(frame, 'ageMs');
      if (!finite(requestedAt) || !finite(time) || time < requestedAt || !finite(rawAge) || rawAge < 0) return emptyFor(context, 'stale-frame');
      const result = reconstruct(frame, context, rawAge + time - requestedAt);
      if (!result) return emptyFor(context, 'malformed-frame');
      const prior = lifetimes.get(result.streamId);
      if (prior && (result.sequence < prior.sequence || time < prior.time)) return emptyFor(context, 'stale-frame');
      if (prior && result.sequence === prior.sequence) result.ageMs = Math.max(result.ageMs, prior.age + time - prior.time);
      if (result.ageMs > MAX_AGE) return emptyFor(context, 'stale-frame');
      lifetimes.delete(result.streamId); lifetimes.set(result.streamId, {sequence: result.sequence, age: result.ageMs, time});
      while (lifetimes.size > 32) lifetimes.delete(lifetimes.keys().next().value);
      return result;
    },
    onAudioDispatch(event) {
      if (disposed || own(event, 'source') !== 'local' || !['play', 'seek', 'pause', 'stop', 'next', 'previous'].includes(own(event, 'kind'))) return undefined;
      try {
        const token = client.invalidate();
        if (token && typeof token.then === 'function') {token.catch?.(() => {}); return undefined;}
        return {settle(disposition) {try {const work = client.settleInvalidation(token, ['not-dispatched', 'dispatched', 'uncertain'].includes(disposition) ? disposition : 'uncertain');
          work?.catch?.(() => {});} catch {}}};
      } catch {return undefined;}
    },
    dispose() {if (disposed) return; disposed = true; try {client.dispose()?.catch?.(() => {});} catch {}}
  };
}
module.exports = {createPlayerSpectrumService, emptySpectrum};
