'use strict';

const {randomUUID} = require('node:crypto');
const {isDesktopArtworkUrl} = require('./desktop-artwork');

const ACTIONS = Object.freeze(['play', 'pause', 'stop', 'next', 'previous', 'seek']);
const RETRY_DELAYS_MS = [500, 1000, 2000];
const RETRYABLE_REASONS = new Set(['startup-timeout', 'request-timeout', 'stdin-failed', 'helper-eof', 'helper-exited']);
const RETRY_RESET_MS = 60000;
const TIMELINE_REFRESH_MS = 5000;
const TIMELINE_DRIFT_SECONDS = 1;
const isActiveState = state => state === 'playing' || state === 'paused';
const noCapabilities = () => Object.fromEntries(ACTIONS.map(action => [action, false]));
const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').toWellFormed().slice(0, 512).toWellFormed() : '';
const seconds = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(604800, value)) : 0;

function mediaCapabilities(player, sources) {
  const source = player?.source;
  const descriptor = sources?.sources?.[source] || sources?.[source];
  if (!['local', 'apple'].includes(source) || !['playing', 'paused'].includes(player?.state) || player?.available !== true ||
      player.readOnly === true || player.stale === true || player.controlUncertain === true || player.controlsReady === false ||
      player.connectionStatus === 'degraded' || Array.isArray(player.conflictingSources) || !descriptor || descriptor.available !== true ||
      descriptor.controlsReady === false || descriptor.stale === true || descriptor.controlUncertain === true || descriptor.capabilities?.playback !== true) return noCapabilities();
  const capabilities = descriptor.capabilities;
  // Local playback's generic capability is supplied by the verified adapter.
  // Apple actions always need the adapter's explicit per-method permission.
  const permits = action => source === 'local' ? capabilities[action] !== false : capabilities[action] === true;
  const toggle = permits('toggle');
  return {play: toggle, pause: toggle, stop: source === 'local' ? permits('stop') : capabilities.stop === true,
    next: permits('next'), previous: permits('previous'), seek: seconds(player.duration) > 0 && permits('seek')};
}

function buildMediaSnapshot({player, sources, sessionId, sequence, artwork} = {}) {
  const source = ['local', 'apple'].includes(player?.source) ? player.source : null;
  const state = source && player?.available === true && ['playing', 'paused'].includes(player.state) ? player.state :
    player?.state === 'unavailable' || player?.available === false ? 'unavailable' : 'stopped';
  const track = source ? player.currentTrack || {} : {};
  const duration = seconds(player?.duration || track.duration), position = Math.min(seconds(player?.position), duration);
  return {schemaVersion: 1, sessionId, sequence, source, state,
    metadata: {title: text(track.title), artist: text(track.artist), album: text(track.album), ...(artwork && source ? {artwork} : {})},
    position, duration, capabilities: mediaCapabilities(player, sources)};
}

function snapshotChanged(previous, next) {
  return previous.sessionId !== next.sessionId || previous.source !== next.source || previous.state !== next.state ||
    previous.duration !== next.duration || previous.metadata.title !== next.metadata.title || previous.metadata.artist !== next.metadata.artist ||
    previous.metadata.album !== next.metadata.album || previous.metadata.artwork !== next.metadata.artwork ||
    ACTIONS.some(action => previous.capabilities[action] !== next.capabilities[action]);
}

function timelineChanged(previous, next, elapsedMs, force) {
  if (next.state !== 'playing' || force) return previous.position !== next.position;
  const projected = Math.min(previous.duration, previous.position + elapsedMs / 1000);
  return Math.abs(next.position - projected) >= TIMELINE_DRIFT_SECONDS ||
    elapsedMs >= TIMELINE_REFRESH_MS && next.position !== previous.position;
}

function createMediaControlsController({createClient, runtimeRoot, expectedManifestSha256, onCommand, getArtwork,
  onChange = () => {}, onError = () => {}, enabled = true, makeId = randomUUID, clock = {}} = {}) {
  const {now = () => performance.now(), setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout} = clock;
  let client = null, disposed = false, starting = false, epoch = 0, retiring = Promise.resolve();
  let failed = false, retirementUnconfirmed = false, retryAttempt = 0, retryTimer = null, readyAt = null;
  let player = null, sources = null, sessionId = makeId(), sequence = 0, contextKey = '', artworkKey = '', artwork = null;
  let currentSnapshot = null, lastSent = null, lastSentAt = 0, artworkRequest = null;
  let statusValue = {status: enabled ? 'idle' : 'disabled'};
  const status = () => ({...statusValue});
  function setStatus(state) {
    if (state === statusValue.status) return;
    statusValue = {status: state, ...(state === 'unavailable' ? {error: 'Windows 媒体控制暂不可用。'} : {})};
    try {onChange(status());} catch {}
  }
  const isCurrent = currentEpoch => !disposed && enabled && epoch === currentEpoch;
  function retire(target) {
    if (!target) return retiring;
    const work = Promise.resolve().then(() => target.dispose()).then(value => {
      if (value?.childExited === false) retirementUnconfirmed = true;
    }).catch(() => {retirementUnconfirmed = true;});
    retiring = Promise.all([retiring, work]).then(() => {});
    return retiring;
  }
  function detach() {
    epoch++; sessionId = makeId(); lastSent = null; starting = false; readyAt = null;
    const previous = client; client = null;
    return retire(previous);
  }
  function cancelRetry() {
    if (retryTimer !== null) cancel(retryTimer);
    retryTimer = null;
  }
  function fail(reason) {
    detach();
    if (RETRYABLE_REASONS.has(reason) && retryAttempt < RETRY_DELAYS_MS.length) {
      retryTimer = schedule(() => {retryTimer = null; publish();}, RETRY_DELAYS_MS[retryAttempt++]);
      retryTimer?.unref?.();
    } else {
      failed = true;
    }
    setStatus('unavailable');
    try {onError({code: 'STILL_DESKTOP_MEDIA'});} catch {}
  }
  function getContextKey(value) {
    return JSON.stringify([value?.source ?? null, value?.generation ?? null,
      value?.currentTrackId ?? value?.currentTrack?.id ?? value?.currentTrack?.path ?? null, value?.currentTrack?.subsong ?? null,
      value?.playbackOccurrence ?? null]);
  }
  async function updateClient(target, snapshot, currentEpoch) {
    try {await target.update(snapshot);} catch {if (isCurrent(currentEpoch) && client === target) fail();}
  }
  function publish({sampleTimeline = false, forceTimeline = false} = {}) {
    if (disposed) return;
    currentSnapshot = buildMediaSnapshot({player, sources, sessionId, sequence, artwork});
    if (!enabled || failed || retryTimer !== null || starting) return;
    if (!client) {
      if (isActiveState(currentSnapshot.state)) startClient();
      return;
    }
    // Protocol v1 clears artwork on every update. Keep complete snapshots
    // and send only changes or the periodic playback timeline correction.
    const observedAt = now();
    if (lastSent && !snapshotChanged(lastSent, currentSnapshot) &&
        !(sampleTimeline && timelineChanged(lastSent, currentSnapshot, observedAt - lastSentAt, forceTimeline))) return;
    currentSnapshot.sequence = ++sequence;
    lastSent = currentSnapshot; lastSentAt = observedAt;
    void updateClient(client, currentSnapshot, epoch);
  }
  function startClient() {
    const currentEpoch = ++epoch;
    starting = true; setStatus('starting');
    void retiring.then(async () => {
      if (!isCurrent(currentEpoch)) return;
      if (retirementUnconfirmed) {fail(); return;}
      if (!isActiveState(currentSnapshot?.state)) {starting = false; setStatus('idle'); return;}
      if (typeof createClient !== 'function') throw new Error('Media bridge unavailable');
      let target;
      target = createClient({runtimeRoot, expectedManifestSha256, onCommand: command => {
        if (!target || !isCurrent(currentEpoch) || client !== target || starting) return;
        // Older published sequences remain valid within the current session.
        if (!command || command.sessionId !== sessionId || !Number.isSafeInteger(command.sequence) || command.sequence < 1 || command.sequence > sequence ||
            !ACTIONS.includes(command.action) || !currentSnapshot?.capabilities?.[command.action]) return;
        if (command.action === 'seek' && (typeof command.position !== 'number' || !Number.isFinite(command.position) || command.position < 0 || command.position > currentSnapshot.duration)) return;
        const bound = {...command, source: player.source, generation: player.generation,
          ...(command.action === 'seek' && player.source === 'local' && player.playbackOccurrence ? {playbackOccurrence: player.playbackOccurrence} : {})};
        Promise.resolve().then(() => {
          if (isCurrent(currentEpoch) && client === target && bound.sessionId === sessionId && currentSnapshot?.capabilities?.[bound.action]) return onCommand?.(bound);
        }).catch(() => {});
      }, onStatus: value => {
        if (!target || !isCurrent(currentEpoch) || client !== target) return;
        const state = value?.status || value?.state;
        if (['unavailable', 'failed'].includes(state)) fail(value.reason);
      }, onAcknowledged: () => {
        if (retryAttempt > 0 && readyAt !== null && isCurrent(currentEpoch) && client === target &&
            isActiveState(currentSnapshot?.state) && now() - readyAt >= RETRY_RESET_MS) retryAttempt = 0;
      }});
      if (!isCurrent(currentEpoch)) {await retire(target); return;}
      client = target;
      const result = await target.start();
      if (!isCurrent(currentEpoch)) return;
      const value = result?.available === false ? result : target.getStatus?.();
      if (value?.available === false) {fail(value.reason); return;}
      starting = false; readyAt = now(); setStatus('ready'); publish();
    }).catch(() => {if (isCurrent(currentEpoch)) fail();});
  }
  function clearArtwork() {
    artworkKey = ''; artwork = null; artworkRequest = null;
  }
  function refreshArtwork() {
    if (!enabled || failed) {clearArtwork(); return;}
    const track = player?.currentTrack;
    // Local originals may exceed the media reader's finite input limit. Prefer
    // the already bounded large cache, and admit only our internal protocols.
    const key = player?.source && ['playing', 'paused'].includes(player.state) ?
      [track?.coverLargeUrl, track?.coverUrl, track?.coverThumbnailUrl].find(isDesktopArtworkUrl) || '' : '';
    if (key === artworkKey) return;
    clearArtwork(); artworkKey = key;
    if (!key || typeof getArtwork !== 'function') return;
    const request = {}; artworkRequest = request;
    Promise.resolve().then(() => getArtwork(key)).then(value => {
      if (disposed || !enabled || failed || request !== artworkRequest || !value) return;
      try {artwork = require('./media-controls-native').validateArtwork(value);} catch {return;}
      publish();
    }).catch(() => {});
  }
  return {
    observe(nextPlayer, nextSources = sources, {sampleTimeline = true, forceTimeline = false} = {}) {
      if (disposed) return;
      player = nextPlayer || null; sources = nextSources;
      const key = getContextKey(player);
      if (key !== contextKey) {contextKey = key; sessionId = makeId(); clearArtwork();}
      refreshArtwork(); publish({sampleTimeline, forceTimeline});
    },
    setEnabled(value) {
      if (disposed || enabled === (value === true)) return;
      enabled = value === true; failed = false; retryAttempt = 0;
      cancelRetry(); detach(); clearArtwork();
      setStatus(enabled ? 'idle' : 'disabled');
      if (enabled) {refreshArtwork(); publish();}
    },
    getStatus: status,
    isCurrentSession: id => !disposed && enabled && client !== null && !starting && currentSnapshot?.sessionId === id,
    getSnapshot: () => currentSnapshot ? structuredClone(currentSnapshot) : null,
    async dispose() {
      if (disposed) return retiring;
      disposed = true; enabled = false;
      cancelRetry(); currentSnapshot = null; clearArtwork();
      statusValue = {status: 'disabled'};
      await detach();
    }
  };
}

module.exports = {ACTIONS, mediaCapabilities, buildMediaSnapshot, createMediaControlsController};
