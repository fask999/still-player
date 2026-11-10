'use strict';

const {createWindowPlacementController, resolveWindowPlacement} = require('./window-placement');
const {readDesktopPreferences} = require('./desktop-preferences');
const {createPlaybackPowerController} = require('./desktop-power');
const {createSleepTimer} = require('./sleep-timer');
const {createDesktopShortcuts} = require('./desktop-shortcuts');
const {mediaCapabilities, createMediaControlsController} = require('./media-controls');

const changed = () => Object.assign(new Error('当前播放来源或状态已改变。'), {code: 'STILL_CONTEXT_CHANGED'});
function emptyPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length) throw new Error('此操作不接受额外参数。');
}

function desktopWindowOptions({settings, screen}) {
  return resolveWindowPlacement({saved: readDesktopPreferences(settings).windowPlacement,
    displays: screen.getAllDisplays(), primaryDisplay: screen.getPrimaryDisplay()});
}

function createDesktopIntegration({window, screen, settings, powerSaveBlocker, globalShortcut, runtimeRoot, mediaManifestSha256,
  getPlayer, getSources, performAction, stopAndRelease, getArtwork, emit = () => {}, onError = () => {},
  createMediaClient, enabled = true, readOnly = false, clock = {}} = {}) {
  if (!settings || typeof settings.get !== 'function') throw new Error('Desktop integration requires the existing settings service');
  const active = () => enabled && !readOnly && !shuttingDown;
  let shuttingDown = false, shutdownWork = null, player = null, sources = null, lastStatus = '';
  let preferences = readDesktopPreferences(settings.get());
  let power, sleepTimer, shortcuts, media, placement;
  const publicPreferences = () => Object.fromEntries(Object.entries(preferences).filter(([key]) => key !== 'windowPlacement'));
  function status() {
    return {available: active(), readOnly: readOnly || !enabled || shuttingDown, preferences: publicPreferences(),
      power: power?.getStatus() || {enabled: preferences.preventSleep, active: false, status: 'idle'},
      sleepTimer: sleepTimer?.getStatus() || {status: 'idle', remainingSeconds: 0},
      media: media?.getStatus() || {status: preferences.systemMediaControls ? 'idle' : 'disabled'},
      shortcuts: shortcuts?.getStatus() || {enabled: false, available: false, registrations: []}};
  }
  function publish() {
    if (shuttingDown) return;
    const value = status(), serialized = JSON.stringify(value);
    if (serialized === lastStatus) return;
    lastStatus = serialized;
    try {emit('desktop', value);} catch {}
  }
  function report(code) {try {onError({code});} catch {}}
  function assertActive() {if (!active()) throw new Error('当前仅可查看桌面设置。');}
  function observePlayer(value) {
    if (shuttingDown || !value || typeof value !== 'object') return false;
    if (player && Number.isSafeInteger(value.generation) && Number.isSafeInteger(player.generation) &&
        (value.generation < player.generation || value.generation === player.generation && Number.isSafeInteger(value.revision) && Number.isSafeInteger(player.revision) && value.revision < player.revision)) return false;
    player = structuredClone(value);
    if (active()) {power.observe(player); media.observe(player, sources);}
    publish(); return true;
  }
  function observeSources(value) {
    if (shuttingDown || !value || typeof value !== 'object') return;
    sources = structuredClone(value);
    if (active()) media.observe(player, sources);
    publish();
  }
  async function readCurrent() {
    assertActive();
    if (typeof getPlayer !== 'function' || typeof getSources !== 'function') throw new Error('当前播放控制暂不可用。');
    const currentSources = await getSources(); assertActive();
    const currentPlayer = await getPlayer(); assertActive();
    observeSources(currentSources); observePlayer(currentPlayer);
    return {player: currentPlayer, sources: currentSources};
  }
  async function action(actionName, expected) {
    assertActive();
    if (actionName === 'showWindow') {
      if (window && !window.isDestroyed()) {if (window.isMinimized()) window.restore(); window.show(); window.focus();}
      return {shown: Boolean(window && !window.isDestroyed())};
    }
    const current = await readCurrent(), currentPlayer = current.player;
    if (!['local', 'apple'].includes(currentPlayer?.source) || !Number.isSafeInteger(currentPlayer.generation)) throw changed();
    if (expected && (expected.source !== currentPlayer.source || expected.generation !== currentPlayer.generation || !media.isCurrentSession(expected.sessionId))) throw changed();
    const capability = actionName === 'toggle' ? currentPlayer.state === 'paused' ? 'play' : 'pause' : actionName;
    if (mediaCapabilities(currentPlayer, current.sources)[capability] !== true) throw new Error('当前播放来源不支持此操作。');
    if (actionName === 'play' && currentPlayer.state === 'playing' || actionName === 'pause' && currentPlayer.state === 'paused') return currentPlayer;
    if (actionName === 'seek' && (!Number.isFinite(expected?.position) || expected.position < 0 || expected.position > currentPlayer.duration)) throw new Error('播放进度无效。');
    if (typeof performAction !== 'function') throw new Error('当前播放控制暂不可用。');
    const result = await performAction({action: actionName, source: currentPlayer.source, generation: currentPlayer.generation,
      ...(actionName === 'seek' ? {position: expected.position} : {}), origin: expected ? 'smtc' : 'shortcut'});
    if (active() && result && typeof result === 'object' && Object.hasOwn(result, 'state')) observePlayer(result);
    return result;
  }
  power = createPlaybackPowerController({powerSaveBlocker, enabled: active() && preferences.preventSleep, onChange: publish, onError, clock});
  sleepTimer = createSleepTimer({clock, onChange: publish, onExpire: async context => {
    const current = await readCurrent();
    if (!context.isCurrent()) throw changed();
    const currentPlayer = current.player;
    if (!Number.isSafeInteger(currentPlayer?.generation) || currentPlayer.available !== true || currentPlayer.stale === true || currentPlayer.controlUncertain === true ||
        Array.isArray(currentPlayer.conflictingSources)) throw changed();
    const source = ['local', 'apple'].includes(currentPlayer.source) ? currentPlayer.source :
      ['local', 'apple'].includes(currentPlayer.lastSource) ? currentPlayer.lastSource : null;
    // A stopped DTO with no source history cannot establish that an owned
    // backend has exited or released output. Never infer a release or engine.
    if (!source || typeof stopAndRelease !== 'function') throw new Error('Controlled stop-and-release unavailable');
    const result = await stopAndRelease({source, generation: currentPlayer.generation, signal: context.signal, isCurrent: context.isCurrent, origin: 'sleep-timer'});
    if (!context.isCurrent() || !active()) throw changed();
    if (result?.state && typeof result.state === 'object') observePlayer(result.state);
    return result;
  }});
  shortcuts = createDesktopShortcuts({globalShortcut, onChange: publish, onAction: name => action(name).catch(() => report('STILL_DESKTOP_SHORTCUT'))});
  media = createMediaControlsController({runtimeRoot, expectedManifestSha256: mediaManifestSha256, getArtwork, enabled: active() && preferences.systemMediaControls, onChange: publish, onError,
    createClient: createMediaClient || (options => require('./media-controls-native').createNativeMediaControls(options)),
    onCommand: command => action(command.action, command).catch(() => report('STILL_DESKTOP_MEDIA_COMMAND'))});
  if (window && screen) placement = createWindowPlacementController({window, screen, getSaved: () => preferences.windowPlacement,
    persist: value => enabled && !readOnly && typeof settings.update === 'function' ? settings.update({desktop: {windowPlacement: value}}) : Promise.resolve(),
    onError: () => report('STILL_DESKTOP_WINDOW'), clock: {setTimeout, clearTimeout, ...clock}});
  function observeSettings(value) {
    if (shuttingDown) return;
    preferences = readDesktopPreferences(value);
    power.setEnabled(active() && preferences.preventSleep);
    media.setEnabled(active() && preferences.systemMediaControls);
    shortcuts.configure({desktop: {...preferences, globalShortcutsEnabled: active() && preferences.globalShortcutsEnabled}});
    publish();
  }
  observeSettings(settings.get());
  function beginShutdown() {
    if (shutdownWork) return shutdownWork;
    // Invalidate every pending timer/media command synchronously, before any
    // backend drain or disk flush can await. The power request ends here too.
    shuttingDown = true; sleepTimer.dispose(); power.dispose(); shortcuts.dispose();
    const mediaClose = media.dispose().catch(() => report('STILL_DESKTOP_MEDIA_CLOSE'));
    shutdownWork = Promise.resolve().then(async () => {await placement?.flush(); placement?.dispose(); await mediaClose;});
    return shutdownWork;
  }
  return {
    restoreWindow() {if (active()) return placement?.restore();},
    observePlayer, observeSources, observeSettings,
    getStatus: status,
    handlers: {
      'desktop:status': (payload = {}) => {emptyPayload(payload); return status();},
      'desktop:sleepTimer:set': payload => {assertActive(); return sleepTimer.set(payload);},
      'desktop:sleepTimer:cancel': (payload = {}) => {emptyPayload(payload); assertActive(); return sleepTimer.cancel();}
    },
    beginShutdown,
    dispose: beginShutdown
  };
}

module.exports = {desktopWindowOptions, createDesktopIntegration, emptyPayload};
