'use strict';

require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {DESKTOP_DEFAULTS, normalizeDesktopShortcut, validateDesktopPreferences} = require('../src/main/desktop-preferences');
const {createPlaybackPowerController} = require('../src/main/desktop-power');
const {createSleepTimer} = require('../src/main/sleep-timer');
const {createDesktopShortcuts} = require('../src/main/desktop-shortcuts');
const {mediaCapabilities, buildMediaSnapshot, createMediaControlsController} = require('../src/main/media-controls');
const {validateSnapshot} = require('../src/main/media-controls-native');
const {createDesktopIntegration} = require('../src/main/desktop-integration');
const {isDesktopArtworkUrl, createDesktopArtworkReader, MAX_INPUT_BYTES} = require('../src/main/desktop-artwork');

function fakeClock() {
  let monotonic = 0, wall = 1700000000000, serial = 0;
  const timers = new Map();
  return {now: () => monotonic, wallNow: () => wall,
    setTimeout(callback, ms) {const id = ++serial; timers.set(id, {callback, due: monotonic + ms}); return id;},
    clearTimeout(id) {timers.delete(id);},
    jumpWall(ms) {wall += ms;},
    advance(ms) {
      const end = monotonic + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due).find(([, timer]) => timer.due <= end);
        if (!next) break;
        monotonic = next[1].due; timers.delete(next[0]); next[1].callback();
      }
      monotonic = end; wall += ms;
    },
    pending: () => timers.size};
}
const settle = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const actualPlayer = overrides => ({available: true, source: 'local', state: 'playing', generation: 3, revision: 9, duration: 180, position: 2,
  currentTrack: {id: 'song-a', title: 'A', artist: 'Artist', album: 'Album'}, ...overrides});
const sourceSnapshot = () => ({selectedSource: 'apple', sources: {local: {available: true, capabilities: {playback: true}},
  apple: {available: false, capabilities: {playback: false, toggle: false, seek: false, next: false, previous: false}}}});
function blockerFixture() {
  let next = 0;
  const active = new Set(), calls = [];
  return {calls, active, api: {start(type) {calls.push(['start', type]); active.add(next); return next++;},
    stop(id) {calls.push(['stop', id]); return active.delete(id);}, isStarted: id => active.has(id)}};
}
function mediaFixture() {
  const clients = [];
  return {clients, factory(options) {const client = {options, snapshots: [], closed: false, async start() {},
    async update(snapshot) {client.snapshots.push(structuredClone(snapshot));}, async dispose() {client.closed = true;}}; clients.push(client); return client;}};
}

test('desktop shortcuts normalize explicit combinations and reject reserved/media/duplicate settings', () => {
  assert.equal(normalizeDesktopShortcut('alt+ctrl+p'), 'Control+Alt+P');
  assert.equal(normalizeDesktopShortcut(''), '');
  for (const value of ['P', 'Shift+P', 'Control+MediaPlayPause', 'Alt+F4', 'Alt+Space', 'Control+Alt+Delete', 'Control+Control+P', 'Control+P ', 'Super+P']) {
    assert.throws(() => normalizeDesktopShortcut(value));
  }
  assert.throws(() => validateDesktopPreferences({hotkeyToggle: 'Ctrl+P', hotkeyNext: 'Control+P'}));
  assert.throws(() => validateDesktopPreferences({path: 'C:/anything'}));
  assert.throws(() => validateDesktopPreferences({preventSleep: 'true'}));
  assert.deepEqual(validateDesktopPreferences({}), DESKTOP_DEFAULTS);
});

test('power request follows actual playback only and releases on pause, stale reads, silence and disposal', () => {
  const clock = fakeClock(), blocker = blockerFixture();
  const power = createPlaybackPowerController({powerSaveBlocker: blocker.api, clock, freshnessMs: 5000});
  power.observe(actualPlayer({source: null, state: 'stopped'}));
  assert.equal(blocker.active.size, 0);
  power.observe(actualPlayer());
  assert.deepEqual(blocker.calls, [['start', 'prevent-app-suspension']]);
  power.observe(actualPlayer({state: 'paused'}));
  assert.equal(blocker.active.size, 0);
  power.observe(actualPlayer()); clock.advance(4999);
  assert.equal(power.getStatus().active, true);
  clock.advance(1); assert.equal(power.getStatus().active, false);
  power.observe(actualPlayer({stale: true})); assert.equal(blocker.active.size, 0);
  power.observe(actualPlayer()); power.setEnabled(false); assert.equal(blocker.active.size, 0);
  power.setEnabled(true); assert.equal(blocker.active.size, 1);
  power.dispose(); assert.equal(blocker.active.size, 0); assert.equal(clock.pending(), 0);
  power.observe(actualPlayer()); assert.equal(blocker.active.size, 0);
});

test('power request reports failure without blocking playback or fabricating an active blocker', () => {
  const power = createPlaybackPowerController({powerSaveBlocker: {start() {throw new Error('native failure');}, stop() {}, isStarted: () => false}, clock: fakeClock()});
  assert.doesNotThrow(() => power.observe(actualPlayer()));
  assert.equal(power.getStatus().active, false); assert.equal(power.getStatus().status, 'unavailable');
  power.dispose();
});

test('sleep timer uses monotonic elapsed time and confirms real output release once', async () => {
  const clock = fakeClock(), calls = [];
  const timer = createSleepTimer({clock, onExpire: async value => {calls.push(value); return {released: true};}});
  for (const value of [{minutes: 0}, {minutes: 1.1}, {minutes: 1441}, {minutes: '1'}, {minutes: 1, action: 'shutdown'}]) assert.throws(() => timer.set(value));
  timer.set({minutes: 1}); clock.jumpWall(24 * 3600000); clock.advance(59000); await settle();
  assert.equal(calls.length, 0); assert.equal(timer.getStatus().remainingSeconds, 1);
  clock.advance(1000); await settle(); assert.equal(calls.length, 1); assert.equal(timer.getStatus().status, 'completed');
  clock.advance(60000); await settle(); assert.equal(calls.length, 1); assert.equal(clock.pending(), 0);
  timer.dispose();
});

test('cancel/rearm/dispose invalidates a pending expiry before it can stop a later session', async () => {
  const clock = fakeClock(), gate = deferred(); let expireContext;
  const timer = createSleepTimer({clock, onExpire: context => {expireContext = context; return gate.promise;}});
  timer.set({minutes: 1}); clock.advance(60000); assert.equal(timer.getStatus().status, 'firing');
  timer.cancel(); assert.equal(expireContext.signal.aborted, true); assert.equal(expireContext.isCurrent(), false);
  timer.set({minutes: 2}); gate.resolve({released: true}); await settle();
  assert.equal(timer.getStatus().status, 'armed'); assert.equal(timer.getStatus().remainingSeconds, 120);
  timer.dispose(); clock.advance(300000); await settle(); assert.equal(timer.getStatus().status, 'idle'); assert.equal(clock.pending(), 0);
});

test('an unverified timer stop is an error rather than a completed release', async () => {
  const clock = fakeClock(), timer = createSleepTimer({clock, onExpire: async () => ({released: false, state: 'stopped'})});
  timer.set({minutes: 1}); clock.advance(60000); await settle();
  assert.equal(timer.getStatus().status, 'error'); assert.match(timer.getStatus().error, /音频已释放/);
  assert.equal(clock.pending(), 0); timer.dispose();
});

test('global shortcuts never unregister another owner or register media keys, and individual failures remain isolated', async () => {
  const registered = new Map([['Control+Alt+P', () => {}]]), removed = [], actions = [];
  const shortcuts = createDesktopShortcuts({globalShortcut: {isRegistered: key => registered.has(key),
    register(key, callback) {if (key === 'Control+Alt+N') return false; registered.set(key, callback); return true;},
    unregister(key) {removed.push(key); registered.delete(key);}}, onAction: action => actions.push(action)});
  const settings = {desktop: {globalShortcutsEnabled: true, hotkeyToggle: 'Control+Alt+P', hotkeyNext: 'Control+Alt+N', hotkeyShowWindow: 'Control+Alt+S'}};
  const status = shortcuts.configure(settings);
  assert.equal(status.registrations.filter(row => row.registered).length, 1);
  registered.get('Control+Alt+S')(); await settle(); assert.deepEqual(actions, ['showWindow']);
  shortcuts.dispose(); assert.deepEqual(removed, ['Control+Alt+S']); assert.equal(registered.has('Control+Alt+P'), true);
});

test('SMTC capabilities follow the actual source and explicit Apple methods, independent of the browsing source', () => {
  const sources = sourceSnapshot();
  assert.equal(mediaCapabilities(actualPlayer(), sources).next, true);
  assert.equal(mediaCapabilities(actualPlayer({source: 'apple'}), sources).play, false);
  sources.sources.apple = {available: true, capabilities: {playback: true, toggle: true, seek: true, previous: false, next: false}};
  const apple = mediaCapabilities(actualPlayer({source: 'apple'}), sources);
  assert.deepEqual(apple, {play: true, pause: true, stop: false, next: false, previous: false, seek: true});
  assert.equal(mediaCapabilities(actualPlayer({stale: true}), sources).pause, false);
  assert.equal(mediaCapabilities(actualPlayer({source: null, state: 'stopped', lastSource: 'local'}), sources).play, false);
});

test('SMTC does not create audio; stale session and pending microtask events cannot control a replacement source', async () => {
  const fixture = mediaFixture(), commands = []; let serial = 0;
  const media = createMediaControlsController({createClient: fixture.factory, onCommand: value => commands.push(value), makeId: () => `desktop-session-${++serial}`});
  media.observe(actualPlayer(), sourceSnapshot()); await settle();
  const first = fixture.clients[0], snapshot = first.snapshots.at(-1);
  assert.equal(snapshot.source, 'local'); assert.equal(snapshot.metadata.title, 'A');
  first.options.onCommand({action: 'pause', sessionId: snapshot.sessionId, sequence: snapshot.sequence});
  media.observe(actualPlayer({source: 'apple', generation: 4}), sourceSnapshot()); await settle();
  assert.equal(commands.length, 0);
  first.options.onCommand({action: 'pause', sessionId: snapshot.sessionId, sequence: snapshot.sequence}); await settle(); assert.equal(commands.length, 0);
  media.observe(actualPlayer({generation: 5}), sourceSnapshot()); await settle();
  const latest = first.snapshots.at(-1);
  first.options.onCommand({action: 'seek', position: 999, sessionId: latest.sessionId, sequence: latest.sequence});
  first.options.onCommand({action: 'pause', sessionId: latest.sessionId, sequence: latest.sequence}); await settle();
  assert.equal(commands.length, 1); assert.equal(commands[0].generation, 5);
  await media.dispose(); assert.equal(first.closed, true);
});

test('late artwork and native startup cannot republish a retired track or survive disable', async () => {
  const startup = deferred(), art = deferred(), clients = [];
  const media = createMediaControlsController({getArtwork: () => art.promise, createClient: options => {
    const client = {options, snapshots: [], closed: false, start: () => startup.promise,
      async update(value) {client.snapshots.push(value);}, async dispose() {client.closed = true;}};
    clients.push(client); return client;
  }});
  media.observe(actualPlayer({currentTrack: {id: 'a', coverUrl: 'still-cover://art/a.png'}}), sourceSnapshot()); await settle();
  media.setEnabled(false); art.resolve({mimeType: 'image/png', dataBase64: 'fixture'}); startup.resolve(); await settle();
  assert.equal(clients[0].closed, true); assert.equal(clients[0].snapshots.length, 0); assert.equal(media.getStatus().status, 'disabled');
  await media.dispose();
});

test('SMTC prefers the bounded internal large cover and falls back only to other internal artwork URLs', async t => {
  const fixture = mediaFixture(), requested = [], original = `still-cover://art/${'a'.repeat(64)}.png`, large = `still-cover://art/${'b'.repeat(64)}.jpg`;
  const thumbnail = `still-cover://art/${'c'.repeat(64)}.jpg`;
  const media = createMediaControlsController({createClient: fixture.factory, getArtwork: async url => {requested.push(url); return null;}});
  t.after(() => media.dispose());
  media.observe(actualPlayer({currentTrack: {id: 'a', coverUrl: original, coverLargeUrl: large, coverThumbnailUrl: thumbnail}}), sourceSnapshot()); await settle();
  assert.deepEqual(requested, [large]);
  media.observe(actualPlayer({currentTrack: {id: 'a', coverUrl: original, coverLargeUrl: 'https://example.com/large.jpg', coverThumbnailUrl: thumbnail}}), sourceSnapshot()); await settle();
  assert.deepEqual(requested, [large, original]);
  media.observe(actualPlayer({currentTrack: {id: 'a', coverUrl: '', coverThumbnailUrl: thumbnail}}), sourceSnapshot()); await settle();
  assert.deepEqual(requested, [large, original, thumbnail]);
  media.observe(actualPlayer({currentTrack: {id: 'a', coverUrl: 'file:///C:/private.jpg', coverLargeUrl: 'https://example.com/large.jpg'}}), sourceSnapshot()); await settle();
  assert.deepEqual(requested, [large, original, thumbnail]);
});

test('native resolved-unavailable and later EOF stay unavailable, close the card, and do not retry on each progress poll', async () => {
  const clients = [];
  const createClient = options => {
    const client = {closed: false, startCount: 0, options, async start() {client.startCount++; return {available: false, state: 'unavailable'};},
      async update() {throw new Error('Must not update unavailable helper');}, async dispose() {client.closed = true;}};
    clients.push(client); return client;
  };
  const media = createMediaControlsController({createClient});
  media.observe(actualPlayer(), sourceSnapshot()); await settle();
  assert.equal(media.getStatus().status, 'unavailable'); assert.equal(clients[0].closed, true);
  for (let revision = 10; revision < 15; revision++) media.observe(actualPlayer({revision}), sourceSnapshot());
  await settle(); assert.equal(clients.length, 1);
  media.setEnabled(false); media.setEnabled(true); await settle(); assert.equal(clients.length, 2);
  await media.dispose();
  const healthy = mediaFixture(), second = createMediaControlsController({createClient: healthy.factory});
  second.observe(actualPlayer(), sourceSnapshot()); await settle();
  healthy.clients[0].options.onStatus({available: false, state: 'unavailable', reason: 'helper-eof'}); await settle();
  assert.equal(second.getStatus().status, 'unavailable'); assert.equal(healthy.clients[0].closed, true); await second.dispose();
});

test('reenabling media waits for an earlier helper to exit, and shutdown awaits retired helpers too', async () => {
  const gate = deferred(), clients = [];
  const media = createMediaControlsController({createClient: () => {
    const client = {starts: 0, async start() {client.starts++;}, async update() {}, dispose() {return clients[0] === client ? gate.promise : Promise.resolve();}};
    clients.push(client); return client;
  }});
  media.observe(actualPlayer(), sourceSnapshot()); await settle(); assert.equal(clients[0].starts, 1);
  media.setEnabled(false); media.setEnabled(true); await settle(); assert.equal(clients[1].starts, 0);
  let closed = false; const closing = media.dispose().then(() => {closed = true;}); await settle(); assert.equal(closed, false);
  gate.resolve(); await closing; assert.equal(clients[1].starts, 0);
});

test('metadata sanitation and unknown duration remain compatible with the strict native snapshot protocol', () => {
  const snapshot = buildMediaSnapshot({player: actualPlayer({position: 20, duration: 0,
    currentTrack: {title: 'a'.repeat(511) + '😀' + '\ud800\u0000', artist: 'A', album: ''}}), sources: sourceSnapshot(), sessionId: 'metadata-session', sequence: 1});
  assert.equal(snapshot.position, 0); assert.equal(snapshot.duration, 0);
  assert.doesNotThrow(() => validateSnapshot(snapshot));
});

test('old SMTC events cannot cross an automatic same-generation track change during async current-state reads', async () => {
  const fixture = mediaFixture(), read = deferred(), actions = [];
  const desktop = createDesktopIntegration({settings: {get: () => ({})}, clock: fakeClock(), createMediaClient: fixture.factory,
    getSources: async () => sourceSnapshot(), getPlayer: () => read.promise, performAction: value => actions.push(value)});
  desktop.observeSources(sourceSnapshot()); desktop.observePlayer(actualPlayer()); await settle();
  const client = fixture.clients[0], old = client.snapshots.at(-1);
  client.options.onCommand({action: 'next', sessionId: old.sessionId, sequence: old.sequence}); await settle();
  const replacement = actualPlayer({revision: 10, currentTrack: {id: 'song-b', title: 'B'}});
  desktop.observePlayer(replacement); read.resolve(replacement); await settle();
  assert.equal(actions.length, 0); await desktop.dispose();
});

test('desktop artwork accepts only canonical internal URLs and converts a bounded image to helper bytes', async () => {
  for (const value of ['https://example.com/cover.jpg', 'file:///C:/private.jpg', 'data:image/png;base64,AAAA',
    'still-cover://art/../private.jpg', 'still-cover://art/%2e%2e.jpg', 'still-cover://art/a.jpg?path=other']) assert.equal(isDesktopArtworkUrl(value), false);
  assert.equal(isDesktopArtworkUrl(`still-apple-art://art/${'a'.repeat(64)}`), true);
  const requests = [], resized = [], jpeg = Buffer.from('synthetic converted bytes');
  const image = {isEmpty: () => false, getSize: () => ({width: 2048, height: 1024}), resize(options) {resized.push(options); return image;}, toJPEG: () => jpeg};
  const artwork = createDesktopArtworkReader({net: {async fetch(url, options) {requests.push([url, options]); let read = false;
    return {ok: true, headers: {get: () => null}, body: {getReader: () => ({async read() {if (read) return {done: true}; read = true; return {done: false, value: Buffer.from('fixture')};}, releaseLock() {}})}};}},
  nativeImage: {createFromBuffer: () => image}});
  assert.equal(await artwork('https://example.com/anything'), null); assert.equal(requests.length, 0);
  const value = await artwork('still-cover://art/cache-1.jpg');
  assert.deepEqual(value, {mimeType: 'image/jpeg', dataBase64: jpeg.toString('base64')});
  assert.equal(resized[0].width, 512); assert.equal(resized[0].height, 256); assert.equal(requests[0][1].signal.aborted, false);
});

test('oversized or undecodable artwork is omitted and its stream is cancelled without failing media control', async () => {
  let cancelled = false, decoded = false;
  const artwork = createDesktopArtworkReader({net: {async fetch() {return {ok: true, headers: {get: () => String(MAX_INPUT_BYTES + 1)},
    body: {async cancel() {cancelled = true;}}};}}, nativeImage: {createFromBuffer() {decoded = true; throw new Error('Not expected');}}});
  assert.equal(await artwork('still-cover://art/big.png'), null); assert.equal(cancelled, true); assert.equal(decoded, false);
});

test('desktop IPC stays read-only in smoke mode and never starts native media or system requests', async () => {
  const fixture = mediaFixture(), blocker = blockerFixture(), clock = fakeClock();
  const desktop = createDesktopIntegration({settings: {get: () => ({desktop: {...DESKTOP_DEFAULTS, globalShortcutsEnabled: true, hotkeyToggle: 'Control+Alt+P'}})},
    createMediaClient: fixture.factory, powerSaveBlocker: blocker.api, enabled: false, clock});
  desktop.observeSources(sourceSnapshot()); desktop.observePlayer(actualPlayer());
  assert.equal(desktop.handlers['desktop:status']({}).available, false);
  assert.throws(() => desktop.handlers['desktop:sleepTimer:set']({minutes: 1}));
  assert.throws(() => desktop.handlers['desktop:sleepTimer:cancel']({path: 'anything'}));
  assert.equal(blocker.calls.length, 0); assert.equal(fixture.clients.length, 0);
  await desktop.dispose(); assert.equal(clock.pending(), 0);
});

test('the trusted packaging manifest pin passes through desktop and media layers unchanged', async () => {
  const fixture = mediaFixture(), pin = '9'.repeat(64);
  const desktop = createDesktopIntegration({settings: {get: () => ({})}, clock: fakeClock(), createMediaClient: fixture.factory,
    runtimeRoot: 'D:/StillApp', mediaManifestSha256: pin});
  desktop.observeSources(sourceSnapshot()); desktop.observePlayer(actualPlayer()); await settle();
  assert.equal(fixture.clients[0].options.expectedManifestSha256, pin);
  assert.equal(fixture.clients[0].options.runtimeRoot, 'D:/StillApp');
  await desktop.dispose();
});

test('timer stops/releases the source read at expiry, passes an atomic generation guard, and shutdown cancels pending work', async () => {
  const fixture = mediaFixture(), blocker = blockerFixture(), clock = fakeClock(), stopGate = deferred();
  let state = actualPlayer(), stopContext;
  const desktop = createDesktopIntegration({settings: {get: () => ({})}, clock, powerSaveBlocker: blocker.api,
    createMediaClient: fixture.factory, getSources: async () => sourceSnapshot(), getPlayer: async () => state,
    stopAndRelease: context => {stopContext = context; return stopGate.promise;}});
  desktop.observeSources(sourceSnapshot()); desktop.observePlayer(state); desktop.handlers['desktop:sleepTimer:set']({minutes: 1});
  state = actualPlayer({source: 'apple', generation: 5});
  clock.advance(60000); await settle(); assert.equal(stopContext.source, 'apple'); assert.equal(stopContext.generation, 5);
  const close = desktop.dispose; const closing = close();
  assert.equal(stopContext.signal.aborted, true); assert.equal(stopContext.isCurrent(), false); assert.equal(blocker.active.size, 0);
  stopGate.resolve({released: true, state: actualPlayer({source: null, state: 'stopped', generation: 6})}); await closing; await settle();
  assert.equal(desktop.getStatus().sleepTimer.status, 'idle'); assert.equal(clock.pending(), 0);
});

test('a stopped readback with no source history cannot complete a timer or guess the engine to release', async () => {
  const clock = fakeClock(), releases = [];
  const desktop = createDesktopIntegration({settings: {get: () => ({desktop: {preventSleep: false, systemMediaControls: false}})}, clock,
    getSources: async () => sourceSnapshot(),
    getPlayer: async () => actualPlayer({state: 'stopped', source: null, lastSource: null, currentTrack: null}),
    stopAndRelease: async context => {releases.push(context); return {released: true};}});
  desktop.handlers['desktop:sleepTimer:set']({minutes: 1}); clock.advance(60000); await settle();
  assert.equal(desktop.getStatus().sleepTimer.status, 'error');
  assert.match(desktop.getStatus().sleepTimer.error, /音频已释放/);
  assert.deepEqual(releases, []);
  await desktop.dispose(); assert.equal(clock.pending(), 0);
});

test('shutdown flushes final window placement before settings close while dropping power and native controls synchronously', async () => {
  const window = new EventEmitter(), screen = new EventEmitter(), writes = [], clock = fakeClock(), fixture = mediaFixture();
  let bounds = {x: 10, y: 20, width: 900, height: 700};
  Object.assign(window, {isDestroyed: () => false, isMinimized: () => false, isVisible: () => true, isMaximized: () => false,
    getNormalBounds: () => bounds, setBounds: value => {bounds = value;}, setMinimumSize() {}});
  const display = {id: 1, scaleFactor: 1, workArea: {x: 0, y: 0, width: 1920, height: 1080}};
  Object.assign(screen, {getAllDisplays: () => [display], getPrimaryDisplay: () => display});
  const desktop = createDesktopIntegration({window, screen, clock, createMediaClient: fixture.factory,
    settings: {get: () => ({}), update: async patch => {writes.push(patch);}}});
  await desktop.beginShutdown();
  assert.equal(writes.length, 1); assert.equal(writes[0].desktop.windowPlacement.bounds.width, 900);
  assert.equal(window.listenerCount('move'), 0); assert.equal(screen.listenerCount('display-removed'), 0);
});
