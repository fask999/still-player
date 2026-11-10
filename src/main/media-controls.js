'use strict';

const {randomUUID} = require('node:crypto');
const {isDesktopArtworkUrl} = require('./desktop-artwork');

const ACTIONS = Object.freeze(['play', 'pause', 'stop', 'next', 'previous', 'seek']);
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

function createMediaControlsController({createClient, runtimeRoot, expectedManifestSha256, onCommand, getArtwork,
  onChange = () => {}, onError = () => {}, enabled = true, makeId = randomUUID} = {}) {
  let client = null, disposed = false, starting = null, epoch = 0, failed = false, retiring = Promise.resolve();
  let player = null, sources = null, sessionId = makeId(), sequence = 0, contextKey = '', artworkKey = '', artwork = null;
  let currentSnapshot = null, statusValue = {status: enabled ? 'idle' : 'disabled'};
  const status = () => ({...statusValue});
  const emit = () => {try {onChange(status());} catch {}};
  function retire(target) {
    if (!target) return retiring;
    const work = Promise.resolve().then(() => target.dispose()).catch(() => {});
    retiring = Promise.allSettled([retiring, work]).then(() => {});
    return retiring;
  }
  const fail = () => {
    if (disposed || !enabled || failed) return;
    failed = true; epoch++; const previous = client; client = null; starting = null;
    retire(previous);
    statusValue = {status: 'unavailable', error: 'Windows 媒体控制暂不可用。'};
    try {onError({code: 'STILL_DESKTOP_MEDIA'});} catch {} emit();
  };
  function getContextKey(value) {
    return JSON.stringify([value?.source ?? null, value?.generation ?? null,
      value?.currentTrackId ?? value?.currentTrack?.id ?? value?.currentTrack?.path ?? null, value?.currentTrack?.subsong ?? null]);
  }
  async function updateClient(target, snapshot, currentEpoch) {
    try {await target.update(snapshot);} catch {if (!disposed && enabled && client === target && epoch === currentEpoch) fail();}
  }
  function publish() {
    if (disposed) return;
    currentSnapshot = buildMediaSnapshot({player, sources, sessionId, sequence: ++sequence, artwork});
    if (!enabled || failed) return;
    if (client) {if (!starting) void updateClient(client, currentSnapshot, epoch); return;}
    if (!['playing', 'paused'].includes(currentSnapshot.state)) return;
    const currentEpoch = ++epoch;
    try {
      if (typeof createClient !== 'function') throw new Error('Media bridge unavailable');
      let target;
      target = createClient({runtimeRoot, expectedManifestSha256, onCommand: command => {
        if (disposed || !enabled || failed || client !== target || epoch !== currentEpoch) return;
        // Revisions advance on ordinary progress polls. A valid command from
        // the same playback session may refer to a recently published sequence.
        if (!command || command.sessionId !== sessionId || !Number.isSafeInteger(command.sequence) || command.sequence < 1 || command.sequence > sequence ||
            !ACTIONS.includes(command.action) || !currentSnapshot?.capabilities?.[command.action]) return;
        if (command.action === 'seek' && (typeof command.position !== 'number' || !Number.isFinite(command.position) || command.position < 0 || command.position > currentSnapshot.duration)) return;
        const bound = {...command, source: player.source, generation: player.generation};
        Promise.resolve().then(() => {
          if (!disposed && enabled && client === target && bound.sessionId === sessionId && currentSnapshot?.capabilities?.[bound.action]) return onCommand?.(bound);
        }).catch(() => {});
      }, onStatus: value => {
        if (disposed || !enabled || client !== target || epoch !== currentEpoch) return;
        const state = value?.status || value?.state;
        if (['unavailable', 'failed'].includes(state)) {fail(); return;}
        statusValue = {status: ['idle', 'starting', 'ready', 'unavailable', 'failed'].includes(state) ? state : 'unavailable',
          ...(['unavailable', 'failed'].includes(state) ? {error: 'Windows 媒体控制暂不可用。'} : {})}; emit();
      }});
      client = target; statusValue = {status: 'starting'}; emit();
      starting = retiring.then(() => {
        if (!disposed && enabled && client === target && epoch === currentEpoch) return target.start();
      }).then(async result => {
        if (disposed || !enabled || client !== target || epoch !== currentEpoch) {await retire(target); return;}
        if (result?.available === false || typeof target.getStatus === 'function' && target.getStatus().available === false) {fail(); return;}
        starting = null; statusValue = {status: 'ready'}; emit(); await updateClient(target, currentSnapshot, currentEpoch);
      }).catch(() => {if (!disposed && enabled && client === target && epoch === currentEpoch) {starting = null; fail();}});
    } catch {fail();}
  }
  function refreshArtwork() {
    if (!enabled || failed) {artworkKey = ''; artwork = null; return;}
    const track = player?.currentTrack;
    // Local originals may exceed the media reader's finite input limit. Prefer
    // the already bounded large cache, and admit only our internal protocols.
    const key = player?.source && ['playing', 'paused'].includes(player.state) ?
      [track?.coverLargeUrl, track?.coverUrl, track?.coverThumbnailUrl].find(isDesktopArtworkUrl) || '' : '';
    if (key === artworkKey) return;
    artworkKey = key; artwork = null;
    if (!key || typeof getArtwork !== 'function') return;
    const requestSession = sessionId;
    Promise.resolve().then(() => getArtwork(key)).then(value => {
      if (disposed || !enabled || key !== artworkKey || requestSession !== sessionId) return;
      try {artwork = value ? require('./media-controls-native').validateArtwork(value) : null;} catch {artwork = null;}
      publish();
    }).catch(() => {});
  }
  return {
    observe(nextPlayer, nextSources = sources) {
      if (disposed) return;
      player = nextPlayer || null; sources = nextSources;
      const key = getContextKey(player);
      if (key !== contextKey) {contextKey = key; sessionId = makeId(); artworkKey = ''; artwork = null;}
      refreshArtwork(); publish();
    },
    setEnabled(value) {
      if (disposed || enabled === (value === true)) return;
      enabled = value === true; failed = false; epoch++; sessionId = makeId();
      const previous = client; client = null; starting = null;
      retire(previous);
      statusValue = {status: enabled ? 'idle' : 'disabled'}; emit();
      if (enabled) {artworkKey = ''; refreshArtwork(); publish();}
    },
    getStatus: status,
    isCurrentSession: id => !disposed && enabled && !failed && currentSnapshot?.sessionId === id,
    getSnapshot: () => currentSnapshot ? structuredClone(currentSnapshot) : null,
    async dispose() {
      if (disposed) return; disposed = true; enabled = false; epoch++; sessionId = makeId();
      const previous = client; client = null; starting = null; currentSnapshot = null; artwork = null;
      statusValue = {status: 'disabled'};
      await retire(previous);
    }
  };
}

module.exports = {ACTIONS, mediaCapabilities, buildMediaSnapshot, createMediaControlsController};
