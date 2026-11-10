'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {version: productVersion} = require('../package.json');
const fs = require('node:fs/promises');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');
const path = require('node:path');
const {DEFAULTS, mergeSettings, createSettingsService} = require('../src/main/settings');
const {createHandlers, invokeSafely, mapPlayer, mapQueue, safeCoverPath, resolveFoobarDir, initializeBackend, prepareLocalPlaybackLifecycle, revealBeforeBackend, guardFoobarService, shutdownDesktop, withSmokeLyricsFixture, windowSize, validateSmokePlan, registerApplicationSchemes, createAppleMusicIntegration, createLyricsTrackResolver, isTrustedApplicationSender, isApprovedPublicRequest, createPublicFetchService} = require('../src/main/main');
const {checkRendererAssets} = require('../scripts/build');
const {preparePackageOutput, copyRuntimeTools, verifyPrivateBackend} = require('../scripts/package');
test('online cover contact is opt-in, normalized and rejects unsafe or inferred identities', () => {
  assert.deepEqual(DEFAULTS.onlineCovers, {musicBrainzContact: ''});
  for (const input of ['contact@example.test', ' https://example.test/contact ']) {
    const result = mergeSettings(structuredClone(DEFAULTS), {onlineCovers: {musicBrainzContact: input}});
    assert.equal(result.onlineCovers.musicBrainzContact, input.trim());
  }
  for (const input of ['plain name', 'http://example.test', 'contact@example.test\n', 'https://user:secret@example.test/contact', 'x'.repeat(201), null, 1]) {
    assert.throws(() => mergeSettings(structuredClone(DEFAULTS), {onlineCovers: {musicBrainzContact: input}}));
  }
  assert.equal(mergeSettings(structuredClone(DEFAULTS), {onlineCovers: {musicBrainzContact: ''}}).onlineCovers.musicBrainzContact, '');
});
test('a changed CUE refuses before backend paths or the startup lifetime can be changed', async () => {
  let pathsCalled = false, startCalled = false;
  const location = {path: 'E:\\Music\\Known.cue', subsong: 1};
  await assert.rejects(prepareLocalPlaybackLifecycle({backend: {preparePaths: async () => {pathsCalled = true;}, ensureStarted: async () => {startCalled = true;}},
    async getCuePlaybackRequests(locations) {assert.deepEqual(locations, [location]); throw Object.assign(new Error('Synthetic CUE change'), {code: 'STILL_CUE_PLAYBACK_REVALIDATION_REQUIRED'});}
  }, {locations: [location]}, {check() {}}), {code: 'STILL_CUE_PLAYBACK_REVALIDATION_REQUIRED'});
  assert.equal(pathsCalled, false); assert.equal(startCalled, false);
});
test('portable backend defaults only to the app-owned directory and respects an explicit diagnostic override', async t => {
  const {root: directory, parent: tempParent} = createCanonicalTemp('still-discovery-');
  t.after(async () => {assert.equal(path.dirname(directory), tempParent); assert.ok(path.basename(directory).startsWith('still-discovery-')); await fs.rm(directory, {recursive: true, force: true});});
  const appDirectory = path.join(directory, 'Still', 'dist', 'Still-win32-x64');
  await fs.mkdir(appDirectory, {recursive: true});
  await fs.writeFile(path.join(directory, 'foobar2000.exe'), 'test-only-path-marker');
  assert.equal(await resolveFoobarDir(appDirectory), path.join(appDirectory, 'backend', 'foobar2000'));
  assert.equal(await resolveFoobarDir(appDirectory, path.join(directory, 'custom')), path.join(directory, 'custom'));
});
test('partial settings patches preserve other fields and reject prototype/unknown keys', () => {
  const next = mergeSettings(DEFAULTS, {lyrics: {fontSize: 36}});
  assert.equal(next.lyrics.fontSize, 36);
  assert.equal(next.lyrics.cacheEnabled, true);
  assert.equal(next.appearance.reducedMotion, false);
  assert.equal(next.appearance.localView, 'albums');
  assert.throws(() => mergeSettings(DEFAULTS, JSON.parse('{"__proto__":{"polluted":true}}')));
  assert.throws(() => mergeSettings(DEFAULTS, {lyrics: {fontSize: NaN}}));
  assert.throws(() => mergeSettings(DEFAULTS, {volume: 0.5}));
  assert.throws(() => mergeSettings(DEFAULTS, {lyrics: {showOriginal: false, showTranslation: false}}), /visible/);
  assert.equal(mergeSettings(DEFAULTS, {lyrics: {showOriginal: false}}).lyrics.showTranslation, true);
  for (const localView of ['library', 'albums', 'artists', 'playlists']) assert.equal(mergeSettings(DEFAULTS, {appearance: {localView}}).appearance.localView, localView);
  for (const localView of ['apple', '../library', '', null, 0]) assert.throws(() => mergeSettings(DEFAULTS, {appearance: {localView}}), /Invalid setting/);
});
test('concurrent settings writes merge and survive restart', async t => {
  const {root: dataDir, parent: tempParent} = createCanonicalTemp('still-settings-');
  t.after(async () => {assert.equal(path.dirname(dataDir), tempParent); assert.ok(path.basename(dataDir).startsWith('still-settings-')); await fs.rm(dataDir, {recursive: true, force: true});});
  const service = createSettingsService({dataDir}); await service.initialize();
  await Promise.all([service.update({lyrics: {fontSize: 38}}), service.update({lyrics: {showTranslation: false}})]);
  const restored = createSettingsService({dataDir}); await restored.initialize();
  assert.equal(restored.get().lyrics.fontSize, 38);
  assert.equal(restored.get().lyrics.showTranslation, false);
  await assert.rejects(service.update({lyrics: {lineHeight: 99}}));
  assert.equal((await service.update({appearance: {reducedMotion: true}})).lyrics.fontSize, 38);
});

test('local navigation defaults migrate old preferences and persist without replacing other fields', async t => {
  const {root: dataDir, parent: tempParent} = createCanonicalTemp('still-navigation-settings-');
  t.after(async () => {assert.equal(path.dirname(dataDir), tempParent); assert.ok(path.basename(dataDir).startsWith('still-navigation-settings-')); await fs.rm(dataDir, {recursive: true, force: true});});
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({lyrics: {fontSize: 37}, appearance: {reducedMotion: true}}));
  const service = createSettingsService({dataDir}); await service.initialize();
  assert.equal(service.get().appearance.localView, 'albums');
  await service.update({appearance: {localView: 'artists'}});
  await service.update({lyrics: {translationSize: 21}});
  assert.equal(service.get().appearance.localView, 'artists');
  assert.equal(service.get().appearance.reducedMotion, true);
  assert.equal(service.get().lyrics.fontSize, 37);
  await assert.rejects(service.update({appearance: {localView: 'apple'}}), /Invalid setting/);
  const restored = createSettingsService({dataDir}); await restored.initialize();
  assert.equal(restored.get().appearance.localView, 'artists');
  assert.equal(restored.get().lyrics.translationSize, 21);
  await service.close(); await restored.close();
});

test('accent colour accepts only six hex digits, normalizes case and preserves every other preference', () => {
  const existing = mergeSettings(DEFAULTS, {lyrics: {fontSize: 37, showTranslation: false}, appearance: {reducedMotion: true, localView: 'artists'}});
  for (const [input, normalized] of [['#000000', '#000000'], ['#FFFFFF', '#FFFFFF'], ['#a1b2c3', '#A1B2C3']]) {
    const next = mergeSettings(existing, {appearance: {accentColor: input}});
    assert.equal(next.appearance.accentColor, normalized);
    assert.equal(next.appearance.reducedMotion, true); assert.equal(next.appearance.localView, 'artists');
    assert.deepEqual(next.lyrics, existing.lyrics);
  }
  for (const value of ['#fff', '#11223344', '112233', ' #112233', '#112233 ', '#GG2233', 'red', 'var(--accent)', '#112233;display:none', 'url(https://example.invalid)', '', null, 123, {}, []]) {
    assert.throws(() => mergeSettings(existing, {appearance: {accentColor: value}}), /Invalid setting: appearance.accentColor/);
  }
  assert.equal(existing.appearance.accentColor, '#A8B9FF');
});

test('old stored settings gain the accent default without rewriting the file or discarding lyrics and motion preferences', async t => {
  const {root: dataDir, parent: tempParent} = createCanonicalTemp('still-accent-migration-');
  t.after(async () => {assert.equal(path.dirname(dataDir), tempParent); assert.ok(path.basename(dataDir).startsWith('still-accent-migration-')); await fs.rm(dataDir, {recursive: true, force: true});});
  const original = JSON.stringify({lyrics: {fontSize: 39, translationSize: 23}, appearance: {reducedMotion: true, localView: 'playlists'}});
  await fs.writeFile(path.join(dataDir, 'settings.json'), original);
  const service = createSettingsService({dataDir}); await service.initialize();
  const settings = service.get();
  assert.equal(settings.appearance.accentColor, '#A8B9FF'); assert.equal(settings.appearance.reducedMotion, true);
  assert.equal(settings.appearance.localView, 'playlists'); assert.equal(settings.lyrics.fontSize, 39); assert.equal(settings.lyrics.translationSize, 23);
  assert.equal(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'), original);
  await service.close();
});

test('accent updates persist alongside concurrent partial settings patches and invalid colours leave the last commit intact', async t => {
  const {root: dataDir, parent: tempParent} = createCanonicalTemp('still-accent-persistence-');
  t.after(async () => {assert.equal(path.dirname(dataDir), tempParent); assert.ok(path.basename(dataDir).startsWith('still-accent-persistence-')); await fs.rm(dataDir, {recursive: true, force: true});});
  const service = createSettingsService({dataDir}); await service.initialize();
  await service.update({appearance: {reducedMotion: true, localView: 'artists'}});
  await Promise.all([service.update({appearance: {accentColor: '#7be8cf'}}), service.update({lyrics: {fontSize: 42}})]);
  const committed = await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8');
  await assert.rejects(service.update({appearance: {accentColor: '#123456;color:red'}}), /Invalid setting/);
  assert.equal(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'), committed);
  const restored = createSettingsService({dataDir}); await restored.initialize();
  assert.equal(restored.get().appearance.accentColor, '#7BE8CF');
  assert.equal(restored.get().appearance.reducedMotion, true); assert.equal(restored.get().appearance.localView, 'artists');
  assert.equal(restored.get().lyrics.fontSize, 42);
  await service.close(); await restored.close();
});

test('read-only smoke explicitly disables UI preference persistence in bootstrap capabilities', async () => {
  for (const persistUIState of [false, true]) {
    const h = createHandlers({library: {list: () => ({tracks: [], playlists: [], folders: []})},
      foobar: {getState: async () => ({available: false, state: 'unavailable'}), capabilities: () => ({persistUIState: true})},
      settings: {get: () => DEFAULTS}, persistUIState});
    assert.equal((await h['app:bootstrap']()).capabilities.persistUIState, persistUIState);
  }
});

test('diagnostics export requires an explicit trusted command and accepts no renderer path or extra fields', async () => {
  let exports = 0;
  const make = persistUIState => createHandlers({library: {list: () => ({tracks: [], playlists: []})},
    foobar: {getState: async () => ({available: false, state: 'unavailable'}), capabilities: () => ({})},
    settings: {get: () => DEFAULTS}, persistUIState,
    exportDiagnostics: async () => {exports++; return {saved: true, filePath: 'C:\\Still-data\\diagnostics\\fixed.json'};}});
  const h = make(true), smoke = make(false);
  assert.equal((await h['app:bootstrap']()).capabilities.exportDiagnostics, true);
  assert.equal(exports, 0);
  await assert.rejects(h['app:exportDiagnostics']({path: 'C:\\somewhere-else.json'}), /不接受路径/);
  await assert.rejects(h['app:exportDiagnostics']({includeRaw: true}), /不接受路径/);
  assert.equal(exports, 0);
  assert.equal((await h['app:exportDiagnostics']({})).saved, true); assert.equal(exports, 1);
  assert.equal((await smoke['app:bootstrap']()).capabilities.exportDiagnostics, false);
  await assert.rejects(smoke['app:exportDiagnostics']({}), /此运行模式/);
  assert.equal(exports, 1);
});

test('manual diagnostics accept only bounded viewport, overflow, motion and hex-accent layout fields', async () => {
  const exported = [], layout = {width: 600, height: 1000, devicePixelRatio: 3.25, horizontalOverflow: false,
    appReducedMotion: false, systemReducedMotion: true, effectiveReducedMotion: true, accentColor: '#a8b9ff'};
  const h = createHandlers({exportDiagnostics: async value => {exported.push(value); return {saved: true};}});
  assert.equal((await h['app:exportDiagnostics']({layout})).saved, true);
  assert.deepEqual(exported[0], {layout: {...layout, accentColor: '#A8B9FF'}});
  for (const change of [{width: 0}, {height: 32769}, {width: 600.5}, {devicePixelRatio: 0}, {devicePixelRatio: Infinity},
    {horizontalOverflow: 'false'}, {effectiveReducedMotion: false}, {accentColor: '#fff'}, {accentColor: '#112233;color:red'},
    {html: '<body>PRIVATE_DOM_SENTINEL</body>'}, {account: 'PRIVATE_ACCOUNT_SENTINEL'}]) {
    await assert.rejects(h['app:exportDiagnostics']({layout: {...layout, ...change}}), /诊断布局/);
  }
  await assert.rejects(h['app:exportDiagnostics']({layout, path: 'C:\\escape.json'}), /不接受路径/);
  assert.equal(exported.length, 1);
});

test('diagnostics retain legacy payloads and add only the explicit Apple scope without invoking payload getters', async () => {
  const requests = [], h = createHandlers({exportDiagnostics: async value => {requests.push(value); return {saved: true};}});
  await h['app:exportDiagnostics']({}); await h['app:exportDiagnostics'](); await h['app:exportDiagnostics']({scope: 'apple'});
  const layout = {width: 600, height: 1000, devicePixelRatio: 2, horizontalOverflow: false,
    appReducedMotion: false, systemReducedMotion: false, effectiveReducedMotion: false, accentColor: '#A8B9FF'};
  await h['app:exportDiagnostics']({scope: 'apple', layout}); await h['app:exportDiagnostics']({layout});
  assert.deepEqual(requests, [{}, {}, {scope: 'apple'}, {scope: 'apple', layout}, {layout}]);
  let reads = 0;
  for (const key of ['scope', 'layout']) {
    const input = {}; Object.defineProperty(input, key, {get() {reads++; throw new Error('Private input');}});
    await assert.rejects(h['app:exportDiagnostics'](input));
  }
  for (const input of [{scope: 'all'}, {scope: null}, {scope: 'apple', url: 'https://example.invalid'}, {scope: 'apple', [Symbol('extra')]: true}]) {
    await assert.rejects(h['app:exportDiagnostics'](input));
  }
  assert.equal(reads, 0); assert.equal(requests.length, 5);
});

test('local image schemes have only required privileges and Apple artwork factory receives a registry-only URL function', async () => {
  let schemes, registered, factoryOptions, closeCalls = 0; const registry = new Map(), handlers = new Map(), unhandled = [];
  const protocol = {registerSchemesAsPrivileged: value => {schemes = value;},
    handle: (scheme, handler) => {registered = scheme; handlers.set(scheme, handler);},
    unhandle: scheme => {unhandled.push(scheme); handlers.delete(scheme);}};
  registerApplicationSchemes(protocol);
  assert.deepEqual(schemes, ['still-cover', 'still-apple-art'].map(scheme => ({scheme, privileges: {standard: true, secure: true, supportFetchAPI: true}})));
  const knownUrl = 'still-apple-art://art/' + 'a'.repeat(64), fetched = [];
  const artwork = {urlFor: input => {registry.set(knownUrl, input); return knownUrl;}, close: () => {closeCalls++; registry.clear();},
    handleRequest: async request => {const value = registry.get(request.url); if (!value) return new Response('', {status: 404}); fetched.push(value); return new Response('fixture');}};
  const apple = {initialize() {throw new Error('Do not start');}, authorize() {throw new Error('Do not authorize');}};
  const integration = await createAppleMusicIntegration({protocol, createArtworkService: () => artwork,
    createMusicService: options => {factoryOptions = options; return apple;}, serviceOptions: {dataDir: 'fixture-data'}});
  assert.equal(registered, 'still-apple-art'); assert.equal(integration.apple, apple); assert.equal(factoryOptions.dataDir, 'fixture-data');
  assert.equal(integration.artworkUrlFor, factoryOptions.artworkUrlFor);
  assert.equal((await handlers.get(registered)({url: knownUrl})).status, 404);
  assert.equal((await handlers.get(registered)({url: 'https://example.invalid/unregistered'})).status, 404);
  assert.deepEqual(fetched, []);
  const remoteUrl = 'https://is1-ssl.mzstatic.com/image/thumb/fixture/512x512bb.jpg';
  assert.equal(factoryOptions.artworkUrlFor(remoteUrl), knownUrl);
  assert.equal((await handlers.get(registered)({url: knownUrl})).status, 200); assert.deepEqual(fetched, [remoteUrl]);
  await integration.closeArtwork(); await integration.closeArtwork();
  assert.equal(closeCalls, 1); assert.deepEqual(unhandled, ['still-apple-art']); assert.equal(handlers.size, 0);
});

test('failed Apple factory startup and failed protocol registration close only their artwork service', async () => {
  for (const stage of ['protocol', 'factory']) {
    const events = [], failure = new Error(`fixture-${stage}`);
    await assert.rejects(createAppleMusicIntegration({protocol: {
      handle: scheme => {events.push(['handle', scheme]); if (stage === 'protocol') throw failure;},
      unhandle: scheme => events.push(['unhandle', scheme])},
    createArtworkService: () => ({urlFor: () => '', handleRequest: () => {}, close: () => events.push(['close'])}),
    createMusicService: () => {events.push(['factory']); throw failure;}}), error => error === failure);
    assert.deepEqual(events, stage === 'protocol' ? [['handle', 'still-apple-art'], ['close']] :
      [['handle', 'still-apple-art'], ['factory'], ['unhandle', 'still-apple-art'], ['close']]);
  }
});

test('application commands including diagnostic export still require the exact renderer, main frame and application URL', () => {
  const expectedUrl = 'file:///fixture/src/renderer/index.html', mainFrame = {url: expectedUrl}, webContents = {mainFrame}, mainWindow = {webContents};
  const trusted = {sender: webContents, senderFrame: mainFrame};
  assert.equal(isTrustedApplicationSender(trusted, mainWindow, expectedUrl), true);
  assert.equal(isTrustedApplicationSender({...trusted, sender: {mainFrame}}, mainWindow, expectedUrl), false);
  assert.equal(isTrustedApplicationSender({...trusted, senderFrame: {url: expectedUrl}}, mainWindow, expectedUrl), false);
  assert.equal(isTrustedApplicationSender(trusted, mainWindow, 'file:///fixture/other.html'), false);
  assert.equal(isTrustedApplicationSender({...trusted, senderFrame: null}, mainWindow, expectedUrl), false);
  assert.equal(isTrustedApplicationSender(trusted, undefined, expectedUrl), false);
});

test('lyrics resolve Apple virtual song keys solely from known metadata while preserving original local IDs', async () => {
  const localTrack = {id: 'local-original', path: 'E:\\Song.flac'}, lookups = [], localIds = []; let getterCalls = 0;
  const metadata = {id: 'known-song', type: 'songs', source: 'apple', title: 'Song', artist: 'Artist', album: 'Album', duration: 180,
    path: 'E:\\NEVER_READ_APPLE_PATH.flac', subsong: 9, credentials: 'NEVER_INCLUDE'};
  Object.defineProperty(metadata, 'toJSON', {value() {getterCalls++; throw new Error('Never serialize provider objects');}});
  const apple = {lookupMetadata: input => {lookups.push(input); return input.id === 'known-song' ? {...metadata, type: input.kind} : null;},
    initialize() {throw new Error('No initialize');}, authorize() {throw new Error('No authorize');}, getState() {throw new Error('No extra reads');}};
  const getTrack = createLyricsTrackResolver({library: {getTrack: id => {localIds.push(id); return localTrack;}}, apple});
  assert.equal(await getTrack(localTrack.id), localTrack);
  for (const kind of ['songs', 'library-songs']) {
    assert.deepEqual(await getTrack(`apple:${kind}:known-song`), {id: `apple:${kind}:known-song`, type: kind, source: 'apple', subsong: 0,
      title: 'Song', artist: 'Artist', album: 'Album', duration: 180});
  }
  for (const key of ['apple:songs:unknown', 'apple:albums:known-song', 'apple:songs:../../file', 'apple:songs:known-song:extra',
    'apple:songs:https://private.invalid', 'apple:songs:' + 'x'.repeat(201), 'apple::known-song']) assert.equal(await getTrack(key), null);
  assert.deepEqual(localIds, ['local-original']); assert.equal(getterCalls, 0);
  assert.deepEqual(lookups, [{id: 'known-song', kind: 'songs'}, {id: 'known-song', kind: 'library-songs'}, {id: 'unknown', kind: 'songs'}]);
  for (const replacement of [{...metadata, id: 'wrong'}, {...metadata, source: 'local'}, {...metadata, type: 'albums'}, {...metadata, title: ''}, null]) {
    const resolve = createLyricsTrackResolver({library: {}, apple: {lookupMetadata: () => replacement}});
    assert.equal(await resolve('apple:songs:known-song'), null);
  }
});

test('Apple metadata drives generic LRCLIB resolution and survives restart as offline cached lyrics without a file path', async t => {
  const {createLyricsService} = require('../src/main/lyrics');
  const {root: dataDir, parent: tempParent} = createCanonicalTemp('still-apple-lyrics-integration-');
  t.after(async () => {assert.equal(path.dirname(dataDir), tempParent); assert.ok(path.basename(dataDir).startsWith('still-apple-lyrics-integration-')); await fs.rm(dataDir, {recursive: true, force: true});});
  const getTrack = createLyricsTrackResolver({library: {getTrack: () => null}, apple: {lookupMetadata: ({id, kind}) =>
    id === 'known-song' ? {id, type: kind, source: 'apple', title: 'Song', artist: 'Artist', album: 'Album', duration: 180} : null}});
  let reads = 0;
  const options = {dataDir, getTrack, getSettings: () => ({lyrics: {onlineEnabled: true, cacheEnabled: true}}), minRequestIntervalMs: 0,
    fetchImpl: async () => {reads++; return new Response(JSON.stringify({id: 10, trackName: 'Song', artistName: 'Artist', albumName: 'Album', duration: 180,
      instrumental: false, syncedLyrics: '[00:01]Known public metadata lyric', plainLyrics: 'Known public metadata lyric'}), {headers: {'content-type': 'application/json'}});}};
  const service = createLyricsService(options); t.after(() => service.close()); await service.initialize();
  const trackId = 'apple:songs:known-song', document = await service.resolve({trackId});
  assert.equal(document.source, 'LRCLIB'); assert.equal(document.trackId, trackId); assert.equal(document.status, 'ready');
  assert.equal(document.sourcePath, undefined); assert.equal(reads, 1); await service.close();
  const offline = createLyricsService({...options, getSettings: () => ({lyrics: {onlineEnabled: false, cacheEnabled: true}}),
    fetchImpl: () => {throw new Error('Offline cache must not fetch');}});
  t.after(() => offline.close()); await offline.initialize();
  const cached = await offline.resolve({trackId}); assert.equal(cached.fromCache, true); assert.equal(cached.source, 'LRCLIB');
  assert.equal(cached.lines[0].text, 'Known public metadata lyric'); assert.equal(reads, 1);
  await assert.rejects(offline.resolve({trackId: 'apple:songs:unknown'}), /曲目不存在/);
});

test('library and player presentation share cached cover decoration while stored local tracks and playback IDs stay intact', async () => {
  const cachedUrl = 'still-apple-art://art/' + 'b'.repeat(64), embeddedUrl = 'still-cover://art/embedded.jpg';
  const snapshot = {tracks: [{id: 'missing', path: 'E:\\Song.flac', subsong: 0, title: 'Song', artist: 'Artist', album: 'Album', coverUrl: ''},
    {id: 'embedded', path: 'E:\\Other.flac', subsong: 0, coverUrl: embeddedUrl}], playlists: [], folders: []};
  const storedBefore = JSON.stringify(snapshot), emitted = [];
  const decorateTrack = track => track.coverUrl ? track : {...track, coverUrl: cachedUrl, coverMetadataStatus: 'matched'};
  const decorateLibrarySnapshot = value => ({...value, tracks: value.tracks.map(decorateTrack)});
  const h = createHandlers({library: {list: () => snapshot, refresh: () => snapshot, getTrack: id => snapshot.tracks.find(track => track.id === id)},
    foobar: {getState: () => ({available: true, source: 'local', state: 'paused', currentTrack: {path: 'E:\\Song.flac', subsong: 0}}), capabilities: () => ({})},
    settings: {get: () => DEFAULTS}, emit: (name, value) => emitted.push([name, value]), decorateLibrarySnapshot, decorateTrack});
  const bootstrap = await h['app:bootstrap']();
  assert.equal(bootstrap.library.tracks[0].coverUrl, cachedUrl); assert.equal(bootstrap.library.tracks[1].coverUrl, embeddedUrl);
  assert.equal(bootstrap.player.currentTrackId, 'missing'); assert.equal(bootstrap.player.currentTrack.coverUrl, cachedUrl);
  assert.equal(bootstrap.capabilities.externalLyrics, true);
  assert.equal((await h['library:list']()).tracks[0].coverUrl, cachedUrl);
  assert.equal((await h['library:refresh']()).tracks[0].coverUrl, cachedUrl); assert.equal(emitted.at(-1)[1].tracks[0].coverUrl, cachedUrl);
  assert.equal(JSON.stringify(snapshot), storedBefore);
  const appleState = {source: 'apple', currentTrackId: 'provider-id', currentTrack: {id: 'provider-id', coverUrl: ''}};
  assert.deepEqual(mapPlayer(appleState, snapshot.tracks, () => {throw new Error('Do not decorate an Apple provider track');}), appleState);
});

test('a library artwork update appears in the next real same-track player read without changing transport state', async () => {
  const coverUrl = 'still-apple-art://art/' + 'd'.repeat(64), events = []; let ready = false, playerReads = 0;
  const tracks = [{id: 'same-id', path: 'E:\\Song.flac', subsong: 0, title: 'Song', artist: 'Artist', album: 'Album', coverUrl: ''}];
  const librarySnapshot = {tracks, playlists: []};
  const realState = {source: 'local', lastSource: 'local', state: 'playing', available: true, currentTrackId: 'same-id',
    currentTrack: {...tracks[0]}, generation: 17, revision: 23, position: 93.5, duration: 180, volume: 0.42, audible: true};
  const decorateTrack = track => ready && !track.coverUrl ? {...track, coverUrl} : track;
  const h = createHandlers({library: {refresh: () => librarySnapshot}, getLibrarySnapshot: () => librarySnapshot,
    coordinator: {getState: async () => {playerReads++; return structuredClone(realState);}},
    decorateTrack, decorateLibrarySnapshot: value => ({...value, tracks: value.tracks.map(decorateTrack)}),
    emit: (name, value) => events.push([name, value])});
  const before = await h['player:state'](); assert.equal(before.currentTrack.coverUrl, '');
  ready = true; await h['library:refresh']();
  assert.equal(events.at(-1)[0], 'library'); assert.equal(events.at(-1)[1].tracks[0].coverUrl, coverUrl);
  assert.equal(playerReads, 1);
  const next = await h['player:state'](); assert.equal(playerReads, 2); assert.equal(next.currentTrack.coverUrl, coverUrl);
  assert.equal(next.currentTrackId, before.currentTrackId); assert.equal(next.currentTrack.id, before.currentTrack.id);
  for (const key of ['source', 'lastSource', 'state', 'generation', 'revision', 'position', 'duration', 'volume', 'audible']) assert.equal(next[key], before[key]);
  assert.equal(realState.currentTrack.coverUrl, ''); assert.equal(tracks[0].coverUrl, '');
  const withoutPathMatch = {...realState, currentTrack: {...realState.currentTrack, path: 'E:\\Readback.flac'}};
  const enriched = mapPlayer(withoutPathMatch, [{...tracks[0], coverUrl}]);
  assert.equal(enriched.currentTrack.coverUrl, coverUrl); assert.equal(enriched.currentTrack.path, 'E:\\Readback.flac');
  assert.equal(enriched.generation, realState.generation); assert.equal(enriched.revision, realState.revision);
});

test('public fetch uses one fresh memory session, forwards streaming cancellation and strips account-bearing options', async () => {
  const calls = [], partitionCalls = [], controller = new AbortController(); let closed = 0;
  const response = new Response('upstream fixture failure', {status: 502});
  const isolated = {fetch: async (url, options) => {calls.push([url, options]); return response;}, closeAllConnections: async () => {closed++;}};
  const sessionFactory = {fromPartition: (partition, options) => {partitionCalls.push([partition, options]); return isolated;}};
  for (const key of ['defaultSession', 'cookies', 'fromPath']) Object.defineProperty(sessionFactory, key, {get() {throw new Error('No account or persisted session access');}});
  const network = createPublicFetchService({session: sessionFactory});
  assert.equal(partitionCalls.length, 1); assert.match(partitionCalls[0][0], /^still-public-[a-f0-9-]{36}$/);
  assert.equal(partitionCalls[0][0].startsWith('persist:'), false); assert.deepEqual(partitionCalls[0][1], {cache: false});
  const result = await network.fetch('https://lrclib.net/api/search?track_name=Song&artist_name=Artist', {signal: controller.signal,
    credentials: 'include', redirect: 'follow', referrer: 'https://private.invalid/', cache: 'force-cache',
    headers: {Accept: 'application/json', 'User-Agent': 'STILL/1.0.0', Cookie: 'private-fixture', Authorization: 'private-fixture', Referer: 'https://private.invalid/'}});
  assert.equal(result, response); assert.equal(result.status, 502); assert.equal(result.bodyUsed, false);
  const options = calls[0][1]; assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
  assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.referrer, ''); assert.equal(options.cache, 'no-store');
  assert.equal(options.signal, controller.signal); assert.deepEqual(options.headers, {'accept': 'application/json', 'user-agent': 'STILL/1.0.0'});
  controller.abort(); assert.equal(options.signal.aborted, true);
  await assert.rejects(network.fetch('https://lrclib.net/api/search', {method: 'POST', body: 'forbidden'}), {code: 'PUBLIC_FETCH_FORBIDDEN'});
  await assert.rejects(network.fetch('https://private.invalid/'), {code: 'PUBLIC_FETCH_FORBIDDEN'}); assert.equal(calls.length, 1);
  await network.close(); await network.close(); assert.equal(closed, 1);
  await assert.rejects(network.fetch('https://lrclib.net/api/search'), {code: 'PUBLIC_FETCH_CLOSED'});
  assert.equal(calls.length, 1); assert.equal(partitionCalls.length, 1);
});

test('public fetch accepts only approved HTTPS source routes and exact bounded artwork host paths', () => {
  const mbid = '12345678-1234-4234-8234-123456789abc';
  for (const input of ['https://lrclib.net/api/search?q=Song', 'https://lrclib.net/api/get?track_name=Song&duration=180', 'https://lrclib.net/api/get/123',
    'https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/fixture/512x512bb.jpg',
    'https://musicbrainz.org/ws/2/release/?query=Album&fmt=json&limit=50', `https://coverartarchive.org/release/${mbid}/front-500`,
    `https://archive.org/download/mbid-${mbid}/mbid-${mbid}-123_thumb500.jpg`,
    `https://ia123456.us.archive.org/23/items/mbid-${mbid}/mbid-${mbid}-123-500.jpg`]) assert.equal(isApprovedPublicRequest(input), true, input);
  for (const input of ['http://lrclib.net/api/search', 'https://lrclib.net:444/api/search', 'https://user:secret@lrclib.net/api/search',
    'https://lrclib.net/api/search#private', 'https://lrclib.net/account', 'https://lrclib.net/api/search?token=secret',
    'https://evil.lrclib.net/api/search', 'file:///private', 'https://127.0.0.1/', 'https://musicbrainz.org/account',
    'https://is1-ssl.mzstatic.com/image/thumb/fixture/512x512bb.jpg?token=secret', 'https://is1-ssl.mzstatic.com/image/thumb/fixture/original.jpg',
    `https://coverartarchive.org/release/${mbid}/front`, `https://archive.org/download/private.jpg`,
    `https://ia123456.us.archive.org/23/items/mbid-${mbid}/other-123_thumb500.jpg`,
    `https://ia123456.us.archive.org/23/items/mbid-${mbid}/mbid-${mbid}-123_original.jpg`]) assert.equal(isApprovedPublicRequest(input), false, input);
});

test('only the two fixed QQ guest routes receive their constant public referrer and headers', async () => {
  const search = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?' + new URLSearchParams({format: 'json', n: '10', p: '0', w: 'Song Artist', cr: '1', g_tk: '5381'});
  const lyric = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?' + new URLSearchParams({songmid: '002EXAMPLE12345', pcachetime: '1793548800000',
    g_tk: '5381', loginUin: '0', hostUin: '0', inCharset: 'utf8', outCharset: 'utf-8', notice: '0', platform: 'yqq', needNewCode: '1', format: 'json'});
  const calls = [], network = createPublicFetchService({session: {fromPartition: () => ({
    fetch: async (input, options) => {calls.push([input, options]); return new Response('{}', {headers: {'content-type': 'application/json'}});},
    closeAllConnections: async () => {}})}});
  for (const input of [search, lyric]) {
    assert.equal(isApprovedPublicRequest(input), true);
    await network.fetch(input, {headers: {Referer: 'https://private.invalid/', Authorization: 'private', 'User-Agent': 'private'}, referrer: 'https://private.invalid/'});
    const options = calls.at(-1)[1];
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    assert.equal(options.referrer, 'https://y.qq.com/'); assert.equal(options.referrerPolicy, 'strict-origin');
    assert.deepEqual(options.headers, {accept: 'application/json', 'user-agent': `STILL/${productVersion} (desktop music player; read-only public lyrics client)`, referer: 'https://y.qq.com/'});
  }
  for (const input of [search.replace('g_tk=5381', 'g_tk=1234'), search + '&Cookie=private', search + '&g_tk=5381',
    lyric.replace('loginUin=0', 'loginUin=12345'), lyric.replace('songmid=002EXAMPLE12345', 'songmid=..%2Fprivate'),
    'https://c.y.qq.com/account', 'https://y.qq.com/soso/fcgi-bin/client_search_cp']) {
    assert.equal(isApprovedPublicRequest(input), false, input);
    await assert.rejects(network.fetch(input), {code: 'PUBLIC_FETCH_FORBIDDEN'});
  }
  assert.equal(calls.length, 2); await network.close();
});

test('real lyric client factories share the isolated fake session and reach QQ fallback after an unchanged LRCLIB 502', async t => {
  const {createLyricsService} = require('../src/main/lyrics'), {createQqLyricsClient} = require('../src/main/qq-lyrics');
  const {root: dataDir, parent: tempParent} = createCanonicalTemp('still-public-lyrics-integration-');
  const calls = []; let closed = 0;
  const network = createPublicFetchService({session: {fromPartition: () => ({fetch: async (input, options) => {
    const url = new URL(input); calls.push([url, options]);
    if (url.hostname === 'lrclib.net') return new Response('fixture upstream 502', {status: 502});
    const value = url.pathname.includes('client_search_cp') ? {code: 0, data: {song: {list: [
      {songmid: '002EXAMPLE12345', songname: 'Song', singer: [{name: 'Artist'}], albumname: 'Album', interval: 180}
    ]}}} : {code: 0, lyric: Buffer.from('[00:01.00]QQ plain LRC fixture').toString('base64')};
    return new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
  }, closeAllConnections: async () => {closed++;}})}});
  const lyrics = createLyricsService({dataDir, getTrack: id => id === 'known' ? {id, title: 'Song', artist: 'Artist', album: 'Album', duration: 180} : null,
    getSettings: () => ({lyrics: {onlineEnabled: true, cacheEnabled: true}}), fetchImpl: network.fetch,
    fallbackClient: createQqLyricsClient({fetchImpl: network.fetch, minRequestIntervalMs: 0}), minRequestIntervalMs: 0, maxAttempts: 1});
  t.after(async () => {await lyrics.close(); await network.close(); assert.equal(closed, 1);
    assert.equal(path.dirname(dataDir), tempParent); assert.ok(path.basename(dataDir).startsWith('still-public-lyrics-integration-')); await fs.rm(dataDir, {recursive: true, force: true});});
  await lyrics.initialize(); const result = await lyrics.resolve({trackId: 'known'});
  assert.equal(result.status, 'ready'); assert.equal(result.source, 'QQ Music'); assert.equal(result.kind, 'line');
  assert.equal(result.lines[0].text, 'QQ plain LRC fixture'); assert.equal(result.lines[0].words, undefined);
  assert.deepEqual(calls.map(([url]) => url.hostname), ['lrclib.net', 'c.y.qq.com', 'c.y.qq.com']);
  for (const [, options] of calls) {assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual'); assert.ok(options.signal instanceof AbortSignal);}
  for (const [, options] of calls.slice(1)) assert.equal(options.referrer, 'https://y.qq.com/');
});

test('diagnostics observe only existing player/source/catalog/library reads without extra engine operations', async () => {
  const observed = [], writes = [];
  const source = {available: true, state: 'stopped', position: 0};
  const h = createHandlers({library: {list: () => ({tracks: [], playlists: []})},
    foobar: {getState: async () => source, play: async () => writes.push('play'), capabilities: () => ({})},
    apple: {getStatus: () => ({status: 'ready', capabilities: {search: true, library: true}}),
      getState: async () => ({available: false, state: 'unavailable'}),
      search: async () => ({items: [{id: 'catalog', title: 'Public metadata'}]}),
      library: async () => ({items: [{id: 'library', title: 'Owned metadata'}]})},
    settings: {get: () => DEFAULTS},
    observeDiagnosticPlayer: value => observed.push(['player', value]),
    observeDiagnosticSources: value => observed.push(['sources', value]),
    observeAppleRead: value => observed.push(['apple-read', value])});
  await h['app:bootstrap']();
  await h['apple:search']({term: 'Music'}); await h['apple:library']({kind: 'songs'});
  assert.equal(observed.filter(value => value[0] === 'player').length, 1);
  assert.equal(observed.filter(value => value[0] === 'sources').length, 1);
  const reads = observed.filter(value => value[0] === 'apple-read').map(value => value[1]);
  assert.deepEqual(reads.map(value => value.operation), ['search', 'library']);
  assert.deepEqual(reads.map(value => value.result.items[0].id), ['catalog', 'library']);
  assert.deepEqual(writes, []);
});

test('player context IPC is source-explicit, read-only and cannot probe an unverified backend or closed Apple session', async () => {
  let probes = 0, reads = 0;
  const local = guardFoobarService({playbackContext: () => {reads++; throw new Error('No unverified HTTP');}, outputConnection: () => {probes++; throw new Error('No output probe');}}, () => ({available: false, verified: false}));
  const h = createHandlers({foobar: local, apple: {getStatus: () => ({available: false, runtime: {sessionOpen: false}, capabilities: {queue: false}}),
    getQueue: () => {throw new Error('No queue in a closed session');}}});
  const value = await h['player:context']({source: 'local'}); assert.equal(value.status, 'unavailable'); assert.deepEqual(value.items, []); assert.equal(value.capabilities.select, false);
  assert.deepEqual((await h['player:context']({source: 'apple'})).items, []); assert.equal(probes, 0); assert.equal(reads, 0);
  let getters = 0; const input = {}; Object.defineProperty(input, 'source', {get() {getters++; return 'local';}});
  for (const payload of [input, {}, {source: 'queue'}, {source: 'local', select: 1}]) await assert.rejects(async () => h['player:context'](payload), /source/);
  assert.equal(getters, 0); assert.equal(Object.keys(h).includes('closePlaybackContext'), false); h.closePlaybackContext();
  assert.equal((await h['player:context']({source: 'local'})).reason, 'context-closed');
});

test('a new coordinated player command promptly invalidates a pending context read', async () => {
  let release, entered;
  const gate = new Promise(resolve => {release = resolve;}), started = new Promise(resolve => {entered = resolve;});
  let generation = 1;
  const h = createHandlers({foobar: {playbackContext: () => {entered(); return gate;}}, library: {list: () => ({tracks: []})},
    coordinator: {currentGeneration: () => generation, currentRevision: () => 1,
      command: async () => {generation++;}, getState: async () => ({source: 'local', state: 'paused', generation, revision: 1})}});
  const pending = h['player:context']({source: 'local'}); await started;
  await h['player:pause']({}); const value = await pending;
  assert.equal(value.status, 'unknown'); assert.deepEqual(value.items, []); assert.equal(value.currentIndex, null);
  release({status: 'unavailable', reason: 'backend-unavailable'}); await new Promise(resolve => setImmediate(resolve)); h.closePlaybackContext();
});

test('preload exposes only the new read context command through the existing invoke bridge', async () => {
  const vm = require('node:vm'); let api, request;
  const source = await fs.readFile(path.join(__dirname, '../src/main/preload.js'), 'utf8');
  vm.runInNewContext(source, {require: name => {assert.equal(name, 'electron'); return {
    contextBridge: {exposeInMainWorld: (_name, value) => {api = value;}}, ipcRenderer: {invoke: async (channel, payload) => {request = [channel, payload]; return {ok: true, value: {status: 'unknown'}};}}
  };}});
  assert.equal((await api.invoke('player:context', {source: 'apple'})).status, 'unknown');
  assert.deepEqual(request, ['player:context', {source: 'apple'}]);
  await assert.rejects(api.invoke('player:context:select', {}), /Unknown application command/);
});

test('spectrum capability is explicit and its read-only IPC rejects every renderer identity field', async () => {
  let reads = 0;
  const make = spectrumSupported => createHandlers({library: {list: () => ({tracks: [], playlists: []})},
    foobar: {getState: async () => ({available: false}), capabilities: () => ({spectrum: true})}, settings: {get: () => DEFAULTS}, spectrumSupported,
    readSpectrum: () => {reads++; return {available: false, bands: []};}});
  const accepted = make(true), missing = make(false);
  assert.equal((await accepted['app:bootstrap']()).capabilities.spectrum, true); assert.equal((await missing['app:bootstrap']()).capabilities.spectrum, false);
  assert.equal((await accepted['player:spectrum']({})).available, false); assert.equal(reads, 1);
  let getters = 0; const evil = {}; Object.defineProperty(evil, 'path', {get() {getters++; return 'private';}});
  for (const payload of [{backendPid: 1}, {generation: 2}, {path: 'C:/private'}, {source: 'local'}, {[Symbol('extra')]: true}, evil]) await assert.rejects(async () => accepted['player:spectrum'](payload), /payload/);
  assert.equal(reads, 1); assert.equal(getters, 0);
});

test('owned handoff standby is public offline with a separate on-demand capability and no backend or output probe', async () => {
  for (const eligible of [true, false]) {
    let calls = 0;
    const h = createHandlers({getBackendInfo: () => ({status: 'standby', pendingHandoff: true, canStartOnDemand: eligible}),
      coordinator: {getEngineState: () => {calls++; throw new Error('No read of the exited local lifetime');}},
      retryBackend: () => {throw new Error('Not an implicit restart');}});
    const local = (await h['source:status']()).sources.local;
    assert.equal(local.status, 'standby'); assert.equal(local.available, false); assert.equal(local.backendReachable, false); assert.equal(local.connected, false);
    assert.equal(local.capabilities.playback, false); assert.equal(local.capabilities.canStartOnDemand, eligible); assert.equal(local.capabilities.retryBackend, false); assert.equal(calls, 0);
  }
  const guarded = guardFoobarService({getState() {throw new Error('A stale verified flag cannot override standby');}, outputConnection() {throw new Error('No CoreAudio probe while pending restore');}},
    () => ({available: false, verified: true, status: 'standby', pendingHandoff: true}));
  assert.equal((await guarded.getState()).available, false);
  assert.equal((await guarded.playbackContext()).reason, 'backend-unavailable');
});

test('standby guard preserves synchronous cached handoff status and permits only the existing handoff lease cleanup', () => {
  const {createPlaybackCoordinator} = require('../src/main/playback-coordinator');
  const cached = {current: null, history: [], pendingRestore: true, exitUnverified: false}; let reads = 0, finished = 0;
  const guarded = guardFoobarService({getState() {reads++; throw new Error('No local read');}, getHandoffStatus: () => cached,
    finishOutputHandoff: () => {finished++;}, outputConnection() {throw new Error('No output probe');}},
    () => ({available: false, verified: false, status: 'standby', pendingHandoff: true}));
  const coordinator = createPlaybackCoordinator({engines: {local: guarded}});
  assert.equal(coordinator.cachedHandoffStatus(), cached); assert.equal(reads, 0);
  guarded.finishOutputHandoff({}); assert.equal(finished, 1); assert.equal(reads, 0);
});

test('background startup cannot start a pending handoff backend even when normal startup requested start', async () => {
  const options = [];
  const backend = {getInfo: () => ({status: 'standby', pendingHandoff: true}), initialize: async value => {options.push(value); return {available: false, status: 'standby'};}};
  assert.equal((await initializeBackend(backend, {start: true, restartOwned: false})).status, 'standby');
  assert.deepEqual(options, [{start: false, restartOwned: false}]);
});

test('only explicit local preparation starts a fresh handoff lifetime and verifies restore before exposing readiness', async () => {
  const calls = [], controller = new AbortController(), context = {signal: controller.signal, check: () => {}}; let ready = true;
  const backend = {getInfo: () => ({available: false, pendingHandoff: true}), preparePaths: async input => {calls.push(['paths', input]); return {restartRequired: false};},
    ensureStarted: async input => {calls.push(['ensure', input]); return {available: true, pid: 123};}};
  const bridge = {connect: async info => {calls.push(['connect', info]); assert.equal(ready, false); return {available: true};},
    verifyHandoffRestore: async supplied => {assert.equal(supplied, context); assert.equal(ready, false); calls.push(['verify']);}};
  const foobar = {cancelPending() {throw new Error('No old-lifetime operation');}, getState() {throw new Error('No old-lifetime state/probe');}};
  await prepareLocalPlaybackLifecycle({backend, bridge, foobar, isBridgeReady: () => ready, onBridgeReady: value => {ready = value;}}, {locations: [{path: 'E:\\Song.flac'}]}, context);
  assert.deepEqual(calls.map(row => row[0]), ['paths', 'ensure', 'connect', 'verify']); assert.equal(ready, true);
  assert.deepEqual(calls[1][1], {paths: ['E:\\Song.flac'], allowRestart: true, explicitLocalPlay: true, signal: controller.signal});
  bridge.verifyHandoffRestore = async () => {throw new Error('Semantic restore fixture failure');};
  await assert.rejects(prepareLocalPlaybackLifecycle({backend, bridge, foobar, isBridgeReady: () => ready, onBridgeReady: value => {ready = value;}}, {locations: [{path: 'E:\\Song.flac'}]}, context), /Semantic restore/);
  assert.equal(ready, false);
});

test('an already connected explicit local preparation still verifies the pending semantic restore', async () => {
  let verified = 0;
  await prepareLocalPlaybackLifecycle({backend: {getInfo: () => ({available: true}), preparePaths: async () => ({restartRequired: false}),
    ensureStarted() {throw new Error('No needless restart');}}, foobar: {}, bridge: {verifyHandoffRestore: async () => {verified++;}},
    isBridgeReady: () => true, onBridgeReady() {throw new Error('No new lifetime');}}, {locations: []}, {check() {}, signal: new AbortController().signal});
  assert.equal(verified, 1);
});

test('ordinary explicit backend reconfiguration keeps its verified bridge through the existing stop, then gates the fresh lifetime', async () => {
  let ready = true; const calls = [];
  const guarded = guardFoobarService({cancelPending: async () => {calls.push('cancel');}, getState: async () => {calls.push('state'); assert.equal(ready, true); return {available: true};},
    stop: async () => {calls.push('stop'); assert.equal(ready, true);}}, () => ({verified: ready, available: ready}));
  await prepareLocalPlaybackLifecycle({backend: {getInfo: () => ({available: true}), preparePaths: async () => ({restartRequired: true}),
    ensureStarted: async () => {calls.push('ensure'); assert.equal(ready, false); return {available: true};}}, foobar: guarded,
    bridge: {connect: async () => {calls.push('connect'); assert.equal(ready, false); return {available: true};}, verifyHandoffRestore: async () => {calls.push('verify');}},
    isBridgeReady: () => ready, onBridgeReady: value => {ready = value;}}, {locations: []}, {check() {}, signal: new AbortController().signal});
  assert.deepEqual(calls, ['cancel', 'state', 'stop', 'ensure', 'connect', 'verify']); assert.equal(ready, true);
});
test('IPC errors retain useful backend messages and reject invalid payloads', async () => {
  assert.deepEqual(await invokeSafely(async () => {throw new Error('Beefweb is offline');}, {}), {ok: false, error: 'Beefweb is offline'});
  assert.equal((await invokeSafely(() => 1, [])).ok, false);
});
test('playback resolves library IDs and preserves subsong identity', async () => {
  let request;
  const track = {id: 'cue-2', path: 'D:\\music\\album.flac', subsong: 2, valid: true};
  const h = createHandlers({library: {getTrack: async id => id === track.id ? track : null, list: async () => ({tracks: [track]})}, foobar: {play: async value => {request = value;}, getState: async () => ({available: true, currentTrack: {path: track.path, subsong: 2}})}, emit: () => {}});
  const state = await h['player:play']({trackId: track.id});
  assert.deepEqual(request, {locations: [{path: track.path, subsong: 2}], startIndex: 0});
  assert.equal(state.currentTrackId, track.id);
  await assert.rejects(h['player:play']({trackId: 'missing'}), /Track not found/);
  await assert.rejects(h['player:play']({trackId: track.id, trackIds: ['other']}), /absent/);
});
test('play skips invalid neighbors and starts the requested duplicate occurrence', async () => {
  let request;
  const good = {id: 'good', path: 'D:\\music\\good.flac', subsong: 0, valid: true, supported: true};
  const gone = {id: 'gone', path: 'D:\\music\\gone.flac', subsong: 0, valid: false};
  const h = createHandlers({library: {getTrack: async id => ({good, gone})[id], list: async () => ({tracks: [good, gone]})}, foobar: {play: async value => {request = value;}, getState: async () => ({available: true, currentTrack: good})}, emit: () => {}});
  const value = await h['player:play']({trackId: 'good', trackIds: ['gone','good','good'], startIndex: 2});
  assert.equal(request.startIndex, 1);
  assert.equal(request.locations.length, 2);
  assert.equal(value.skippedCount, 1);
  await assert.rejects(h['player:play']({trackId: 'gone', trackIds: ['good','gone'], startIndex: 1}), /unavailable/);
  await assert.rejects(h['player:play']({trackId: 'good', trackIds: ['gone','good'], startIndex: 0}), /chosen index/);
});
test('player and queue mapping do not confuse CUE subsongs', () => {
  const tracks = [{id: 'one', path: 'D:\\a.flac', subsong: 1}, {id: 'two', path: 'D:\\a.flac', subsong: 2}];
  assert.equal(mapPlayer({currentTrack: {path: 'd:\\a.flac', subsong: 2}}, tracks).currentTrackId, 'two');
  assert.equal(mapQueue({items: [{path: 'D:\\a.flac', subsong: 1}]}, tracks).items[0].trackId, 'one');
  assert.equal(mapPlayer({currentTrack: {path: 'D:\\a.flac', subsong: null}}, [{id: 'zero', path: 'D:\\a.flac', subsong: 0}]).currentTrackId, undefined);
});
test('playlist item IPC validates positions while preserving duplicate track IDs', async () => {
  let removed, moved;
  const h = createHandlers({library: {
    removePlaylistItem: async (...args) => {removed = args; return {tracks: [], playlists: []};},
    movePlaylistItem: async (...args) => {moved = args; return {tracks: [], playlists: []};}
  }, emit: () => {}});
  await h['playlist:removeItem']({id: 'p', index: 2});
  assert.deepEqual(removed, ['p', 2]);
  await h['playlist:moveItem']({id: 'p', fromIndex: 2, toIndex: 0});
  assert.deepEqual(moved, ['p', 2, 0]);
  await assert.rejects(h['playlist:moveItem']({id: 'p', fromIndex: 0.5, toIndex: 0}), /integers/);
});
test('player mapping uses last complete snapshot without waiting for an active library scan', async () => {
  const h = createHandlers({library: {list: () => {throw new Error('should not await the scanning library');}}, getLibrarySnapshot: () => ({tracks: [{id: 't', path: 'D:\\a.flac', subsong: 0}]}), foobar: {getState: async () => ({available: true, currentTrack: {path: 'D:\\a.flac', subsong: 0}})}});
  assert.equal((await h['player:state']()).currentTrackId, 't');
});
test('unsupported source errors stay specific before file availability checks', async () => {
  const h = createHandlers({library: {getTrack: async () => ({path: 'D:\\disc.cue', subsong: null, supported: false, valid: false, playbackUnsupportedReason: 'Unverified CUE subsong'})}, foobar: {}, emit: () => {}});
  await assert.rejects(h['player:play']({trackId: 'cue'}), /Unverified CUE subsong/);
});
test('playback order sends a real numeric backend enum and rejects invalid IDs', async () => {
  let selected;
  const h = createHandlers({library: {list: async () => ({tracks: []})}, foobar: {setOrder: async id => {selected = id;}, getState: async () => ({playbackOrder: {id: selected}})}, emit: () => {}});
  assert.equal((await h['player:order']({id: 3})).playbackOrder.id, 3);
  assert.equal(selected, 3);
  await assert.rejects(h['player:order']({id: 'shuffle'}), /Invalid/);
  await assert.rejects(h['player:order']({id: 1.5}), /integer/);
});
test('bootstrap retains library and useful unavailable state when backend cannot be reached', async () => {
  const h = createHandlers({library: {list: async () => ({tracks: [], playlists: [], folders: []})}, foobar: {getState: async () => {throw new Error('Backend unavailable');}, capabilities: () => ({available: false, outputSwitching: false})}, settings: {get: () => DEFAULTS}, version: '1.0.0'});
  const result = await h['app:bootstrap']();
  assert.equal(result.player.available, false);
  assert.equal(result.player.error, 'Backend unavailable');
  assert.equal(result.capabilities.outputSwitching, false);
  assert.deepEqual(result.library.tracks, []);
  assert.equal(result.sources.apple.available, false);
  assert.equal(result.sources.apple.capabilities.playback, false);
  assert.equal(result.selectedSource, 'local');
  assert.ok(Number.isInteger(result.player.generation));
  assert.ok(Number.isInteger(result.player.revision));
});

test('browsing source selection leaves real playback and generation unchanged', async () => {
  const commands = [], events = [];
  const library = {list: () => ({tracks: [], playlists: [], folders: []})};
  const foobar = {getState: async () => ({available: true, state: 'playing', currentTrack: {path: 'D:\\music\\real.flac', subsong: 0}}),
    cancelPending: () => commands.push('cancel'), pause: () => commands.push('pause'), stop: () => commands.push('stop'), play: () => commands.push('play')};
  const h = createHandlers({library, foobar, emit: (...args) => events.push(args)});
  const before = await h['player:state']();
  assert.equal((await h['source:select']({source: 'apple'})).selectedSource, 'apple');
  const after = await h['player:state']();
  assert.equal(after.state, 'playing');
  assert.equal(after.source, 'local');
  assert.equal(after.generation, before.generation);
  assert.deepEqual(commands, []);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'source');
  await assert.rejects(h['player:play']({source: 'apple', trackId: 'invented'}), /尚未连接/);
  assert.deepEqual(commands, []);
  assert.equal((await h['source:status']()).selectedSource, 'apple');
  await assert.rejects(h['source:select']({source: 'external'}), /Invalid/);
});

test('unavailable Apple playback and unsupported queue capabilities cannot stop local playback', async () => {
  const calls = [];
  const h = createHandlers({library: {list: () => ({tracks: [], playlists: [], folders: []})},
    foobar: {getState: async () => ({available: true, state: 'playing'}), cancelPending: () => calls.push('cancel'), stop: () => calls.push('stop')},
    apple: {getStatus: () => ({provider: 'officialWeb', status: 'session-closed', available: false, message: 'Apple playback is not ready', capabilities: {authorize: true, playback: false, queue: true}}),
      getState: async () => ({available: false, state: 'unavailable'}), cancelPending: () => calls.push('apple-cancel'), play: () => calls.push('apple-play')}});
  const status = h['apple:status']();
  assert.equal(status.capabilities.authorize, true);
  assert.equal(status.capabilities.playback, false);
  assert.equal(status.capabilities.queue, false);
  assert.equal(status.available, false);
  await assert.rejects(h['player:play']({source: 'apple', id: '123', kind: 'songs'}), /not ready/);
  assert.deepEqual(calls, []);
});

test('unsupported Apple playback types and batches reject before cancelling or stopping the local engine', async () => {
  const calls = [];
  const h = createHandlers({library: {list: () => ({tracks: [], playlists: [], folders: []})},
    foobar: {cancelPending: () => calls.push('cancel'), stop: () => calls.push('stop'), getState: async () => ({available: true, state: 'playing'})},
    apple: {getStatus: () => ({available: true, capabilities: {playback: true, queue: true, playableTypes: ['songs', 'library-songs']}}),
      getState: async () => ({available: true, state: 'stopped'}), cancelPending: () => calls.push('apple-cancel')}});
  assert.equal(h['apple:status']().capabilities.playback, true);
  assert.equal(h['apple:status']().capabilities.queue, false);
  await assert.rejects(h['player:play']({source: 'apple', id: '123', kind: 'artists'}), /no verified playback/);
  await assert.rejects(h['player:play']({source: 'apple', ids: ['123', '456'], kind: 'songs'}), /unsupported Apple item IDs/);
  assert.deepEqual(calls, []);
});

test('Apple state never resolves an Apple item ID to a local library path', () => {
  const state = {source: 'apple', state: 'playing', currentTrackId: 'same-id', currentTrack: {id: 'same-id', title: 'Actual Apple title'}};
  assert.deepEqual(mapPlayer(state, [{id: 'same-id', path: 'D:\\local.flac', title: 'Local title'}]), state);
  assert.deepEqual(mapPlayer({...state, source: null, lastSource: 'apple'}, [{id: 'same-id', path: 'D:\\local.flac', title: 'Local title'}]), {...state, source: null, lastSource: 'apple'});
});

test('a slow backend startup leaves the visible window and offline bootstrap usable first', {timeout: 1000}, async () => {
  const events = [];
  let finishStartup, backendAvailable = false, transportReads = 0;
  const pending = new Promise(resolve => {finishStartup = resolve;});
  const startup = await revealBeforeBackend({openWindow: async () => {events.push('window-visible');}, initialize: async () => {
    events.push('backend-starting'); await pending; backendAvailable = true; events.push('backend-ready');
  }});
  const guarded = guardFoobarService({getState: async () => {transportReads++; return {available: true, state: 'stopped'};}, capabilities: () => ({playback: true})},
    () => ({available: backendAvailable, status: backendAvailable ? 'ready' : 'starting'}));
  const h = createHandlers({foobar: guarded, library: {list: () => ({tracks: [], playlists: [], folders: []})}, settings: {get: () => DEFAULTS}});
  const initial = await h['app:bootstrap'](); events.push('bootstrap-usable');
  assert.equal(initial.player.available, false); assert.equal(transportReads, 0);
  assert.deepEqual(events, ['window-visible', 'backend-starting', 'bootstrap-usable']);
  finishStartup(); await startup.completion;
  assert.equal((await h['player:state']()).available, true);
  assert.equal(transportReads, 1);
});

test('an unverified or conflicting backend port cannot receive player or queue commands', async () => {
  const calls = [];
  const guarded = guardFoobarService({getState: async () => {calls.push('read'); return {available: true};}, play: async () => calls.push('play'), queueClear: async () => calls.push('clear'), capabilities: () => ({playback: true})},
    () => ({available: false, status: 'failed', error: 'dedicated port belongs to another executable'}));
  assert.equal((await guarded.getState()).available, false);
  assert.equal(guarded.capabilities().playback, false);
  await assert.rejects(guarded.play({}), /another executable/);
  await assert.rejects(guarded.queueClear(), /another executable/);
  assert.deepEqual(calls, []);
});

test('offline diagnostics can probe the selected DAC without sending HTTP to an unverified port', async () => {
  const calls = [], connection = {status: 'disconnected', endpointId: 'exact-selected-dac', retryRequired: true};
  const guarded = guardFoobarService({getState: async () => {calls.push('HTTP'); return {available: true};},
    outputConnection: async () => {calls.push('native-GetState-only'); return connection;},
    audioDetails: async options => {calls.push(options); return {available: false, backendReachable: false, outputConnection: connection};},
    capabilities: () => ({playback: true})}, () => ({available: false, verified: false, status: 'failed', error: 'wrong listener'}));
  const state = await guarded.getState(), details = await guarded.audioDetails();
  assert.equal(state.backendReachable, false); assert.deepEqual(state.outputConnection, connection);
  assert.equal(details.outputConnection.status, 'disconnected');
  assert.equal(calls.includes('HTTP'), false); assert.deepEqual(calls.at(-1), {readBackend: false});
  assert.equal(guarded.capabilities().playback, false);
});

test('a verified bridge may re-read after a transient GET failure without claiming backend availability', async () => {
  let reads = 0;
  const guarded = guardFoobarService({getState: async () => {reads++; return {available: true, state: 'stopped'};},
    capabilities: () => ({playback: false})}, () => ({available: false, verified: true, status: 'ready'}));
  assert.equal((await guarded.getState()).available, true); assert.equal(reads, 1);
});

test('source status separates a reachable backend from disconnected, reconnected and unknown selected devices', async () => {
  let current = {available: true, backendReachable: true, state: 'stopped', outputConnection: {status: 'disconnected',
    endpointId: 'exact-dac', output: {deviceId: 'exact-dac'}, retryRequired: true}};
  const h = createHandlers({library: {list: () => ({tracks: []})}, foobar: {getState: async () => current}, retryBackend: async () => ({available: true})});
  let local = (await h['source:status']()).sources.local;
  assert.equal(local.available, true); assert.equal(local.backendReachable, true); assert.equal(local.backendStatus, 'ready');
  assert.equal(local.status, 'device-disconnected'); assert.equal(local.capabilities.playback, false);
  current = {...current, outputConnection: {...current.outputConnection, status: 'connected'}};
  local = (await h['source:status']()).sources.local;
  assert.equal(local.status, 'device-reconnected'); assert.match(local.message, /不会自动恢复/);
  current = {...current, outputConnection: {status: 'unknown', endpointId: null, output: null, retryRequired: false}};
  local = (await h['source:status']()).sources.local;
  assert.equal(local.status, 'device-unknown'); assert.equal(local.capabilities.playback, false);
  current = {...current, available: false, backendReachable: false, outputConnection: {status: 'connected', endpointId: 'exact-dac'}};
  local = (await h['source:status']()).sources.local;
  assert.equal(local.status, 'offline'); assert.equal(local.backendReachable, false); assert.equal(local.outputConnection.status, 'connected');
});

test('shutdown can gracefully exit an owned backend before a hung transport fence settles', {timeout: 1000}, async () => {
  const calls = []; let release;
  const fence = new Promise(resolve => {release = resolve;});
  const evidence = {fixtureExitEvidence: true};
  const coordinator = {beginShutdown: () => {calls.push('cancel'); return {settled: fence};}};
  const foobar = {stop: () => {calls.push('stop-request'); return fence;},
    markBackendExited: actual => {assert.equal(actual, evidence); calls.push('verified-exit'); release();},
    close: async () => {calls.push('bridge-close'); await fence;}};
  const backend = {getInfo: () => ({owned: true}), close: async () => {calls.push('owned-graceful-exit'); return {exitEvidence: evidence};}};
  await shutdownDesktop({coordinator, foobar, backend, stopGraceMs: 1, closeServices: [async () => {calls.push('save-data');}]});
  assert.deepEqual(calls, ['cancel', 'stop-request', 'owned-graceful-exit', 'verified-exit', 'bridge-close', 'save-data']);
});

test('failed owned shutdown is not reported as closed or followed by service disposal', async () => {
  const calls = [];
  await assert.rejects(shutdownDesktop({coordinator: {beginShutdown: () => ({settled: Promise.resolve()})},
    foobar: {stop: async () => {}, close: async () => calls.push('bridge-close'), markBackendExited: () => calls.push('mark')},
    backend: {getInfo: () => ({owned: true}), close: async () => {throw new Error('owned process is still running');}},
    closeServices: [async () => calls.push('data-close')], stopGraceMs: 1}), /still running/);
  assert.deepEqual(calls, []);
});

test('a user retry can complete shutdown after the first graceful exit failed', async () => {
  let attempts = 0, disposed = 0, release;
  const fence = new Promise(resolve => {release = resolve;});
  const evidence = {fixtureExitEvidence: true};
  const options = {coordinator: {beginShutdown: () => ({settled: fence})},
    foobar: {stop: () => fence, close: async () => {disposed++;}, markBackendExited: actual => {assert.equal(actual, evidence); release();}},
    backend: {getInfo: () => ({owned: true}), close: async () => {if (++attempts === 1) throw new Error('not exited'); return {exitEvidence: evidence};}}, stopGraceMs: 1};
  await assert.rejects(shutdownDesktop(options), /not exited/);
  assert.equal(disposed, 0);
  await shutdownDesktop(options);
  assert.equal(attempts, 2); assert.equal(disposed, 1);
});

test('lyric UI fixture is explicitly labeled, read-only and impossible to enable in product mode', async () => {
  const base = {'app:bootstrap': async () => ({library: {tracks: [{id: 'real-track'}]}, player: {available: false}}), 'player:state': async () => ({available: false})};
  assert.equal(withSmokeLyricsFixture(base, {enabled: false}), base);
  assert.throws(() => withSmokeLyricsFixture(base, {enabled: true, smokeMode: false, track: {id: 'real-track'}}), /read-only/);
  const fixture = withSmokeLyricsFixture(base, {enabled: true, smokeMode: true, track: {id: 'real-track', title: 'Actual metadata', duration: 123}});
  const boot = await fixture['app:bootstrap']();
  assert.equal(boot.simulatedUIFixture, true); assert.match(boot.fixtureLabel, /非真实匹配/);
  assert.equal(boot.player.state, 'paused'); assert.equal(boot.player.currentTrackId, 'real-track');
  const document = await fixture['lyrics:resolve']({trackId: 'real-track'});
  assert.equal(document.source, 'smoke-fixture'); assert.equal(document.simulatedUIFixture, true);
  assert.ok(document.lines.every(line => line.translation && line.words.length && line.words.every(word => word.startMs < word.endMs)));
  assert.equal((await base['player:state']()).available, false);
});

test('normal backend startup failures keep an offline bootstrap with actual diagnostics and retry capability', async () => {
  for (const message of ['manifest is missing', 'dedicated port is occupied', 'backend failed to start']) {
    const backend = {initialize: async input => {assert.equal(input.start, true); throw new Error(message);}, getInfo: () => ({status: 'failed', available: false, error: message})};
    const info = await initializeBackend(backend, {start: true});
    assert.equal(info.available, false);
    assert.equal(info.error, message);
    const h = createHandlers({library: {list: () => ({tracks: [], playlists: [], folders: []})},
      foobar: {getState: async () => ({available: false, state: 'unavailable', error: message})}, settings: {get: () => DEFAULTS},
      getBackendInfo: backend.getInfo, retryBackend: () => initializeBackend(backend, {start: true})});
    const bootstrap = await h['app:bootstrap']();
    assert.equal(bootstrap.sources.local.backendStatus, 'offline');
    assert.equal(bootstrap.sources.local.backendDiagnostic, message);
    assert.equal(bootstrap.sources.local.capabilities.retryBackend, true);
    assert.equal(bootstrap.player.available, false);
    await assert.rejects(h['backend:retry'](), new RegExp(message));
  }
});

test('native imports defer new backend directories without stopping or preparing playback', async () => {
  const track = {id: 'a', path: 'D:\\new music\\a.flac', subsong: 0, valid: true, supported: true};
  const calls = [];
  const h = createHandlers({library: {importFiles: async () => ({tracks: [track], playlists: [], folders: []})},
    dialog: {showOpenDialog: async () => ({canceled: false, filePaths: [track.path]})}, window: () => null,
    prepareLibraryPaths: async locations => {calls.push(['roots', locations]); return {pending: true, restartRequired: true};},
    foobar: {prepareLocations: async () => calls.push('prepare'), stop: async () => calls.push('stop')}});
  const result = await h['library:import']({kind: 'files'});
  assert.equal(result.importReport.pending, true);
  assert.equal(result.importReport.restartRequired, true);
  assert.equal(result.importReport.backendPrepared, false);
  assert.deepEqual(calls, [['roots', [{path: track.path, subsong: 0}]]]);
});
test('cover protocol only resolves allowed images under its real directory', async t => {
  const {root: directory, parent: tempParent} = createCanonicalTemp('still-covers-');
  t.after(async () => {assert.equal(path.dirname(directory), tempParent); assert.ok(path.basename(directory).startsWith('still-covers-')); await fs.rm(directory, {recursive: true, force: true});});
  await fs.writeFile(path.join(directory, 'a.jpg'), 'image');
  await fs.writeFile(path.join(directory, 'secret.txt'), 'not an image');
  assert.equal(await safeCoverPath('still-cover://art/a.jpg', directory), path.join(directory, 'a.jpg'));
  await assert.rejects(safeCoverPath('still-cover://other/a.jpg', directory));
  await assert.rejects(safeCoverPath('still-cover://art/%2e%2e%5csecret.jpg', directory));
  await assert.rejects(safeCoverPath('still-cover://art/secret.txt', directory));
  await assert.rejects(safeCoverPath('still-cover://user@art/a.jpg', directory));
  await assert.rejects(safeCoverPath('still-cover://art/a.jpg?secret=1', directory));
  await fs.mkdir(path.join(directory, 'folder.jpg'));
  await assert.rejects(safeCoverPath('still-cover://art/folder.jpg', directory), /not a file/);
});

test('native imports retain a committed library when backend path access is denied', async () => {
  const a = {id: 'a', path: 'D:\\music\\a.flac', subsong: 0, valid: true, supported: true};
  const elsewhere = {id: 'b', path: 'D:\\other\\b.flac', subsong: 0, valid: true, supported: true};
  const snapshot = {tracks: [a, elsewhere], playlists: [], folders: []};
  let prepared, committed = false;
  const h = createHandlers({library: {importFiles: async () => {committed = true; return snapshot;}},
    dialog: {showOpenDialog: async () => ({canceled: false, filePaths: [a.path]})}, window: () => null,
    foobar: {prepareLocations: async request => {assert.equal(committed, true); prepared = request; throw new Error('Music directories is empty');}}, emit: () => {}});
  const result = await h['library:import']({kind: 'files'});
  assert.deepEqual(result.tracks, snapshot.tracks);
  assert.deepEqual(prepared, {locations: [{path: a.path, subsong: 0}]});
  assert.equal(result.importReport.indexedCount, 1);
  assert.equal(result.importReport.backendPrepared, false);
  assert.match(result.importReport.warnings[0], /Music directories is empty/);
});

test('playback never turns an explicitly unknown subsong into zero', async () => {
  let played = false;
  const track = {id: 'unknown', path: 'D:\\music\\album.cue', subsong: null, valid: true};
  const h = createHandlers({library: {getTrack: () => track}, foobar: {play: () => {played = true;}}});
  await assert.rejects(h['player:play']({trackId: track.id}), /Exact subsong/);
  assert.equal(played, false);
});

test('settings writes snapshot queued patches and roll back failed disk replacements', async t => {
  const {root: dataDir, parent: tempParent} = createCanonicalTemp('still-settings-atomic-');
  t.after(async () => {assert.equal(path.dirname(dataDir), tempParent); assert.ok(path.basename(dataDir).startsWith('still-settings-atomic-')); await fs.rm(dataDir, {recursive: true, force: true});});
  const service = createSettingsService({dataDir}); await service.initialize();
  const patch = {lyrics: {fontSize: 41}};
  const save = service.update(patch); patch.lyrics.fontSize = 52;
  await save;
  assert.equal(service.get().lyrics.fontSize, 41);
  const file = path.join(dataDir, 'settings.json');
  await fs.rename(file, `${file}.backup`); await fs.mkdir(file);
  await assert.rejects(service.update({lyrics: {fontSize: 47}}));
  assert.equal(service.get().lyrics.fontSize, 41);
  assert.equal((await fs.readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
  await fs.rmdir(file); await fs.rename(`${file}.backup`, file);
  await service.close();
  await assert.rejects(service.update({lyrics: {fontSize: 47}}), /closed/);
});

test('desktop size respects the display work area in device-independent pixels', () => {
  assert.deepEqual(windowSize({width: 2560, height: 1440}), {width: 1440, height: 940, minWidth: 480, minHeight: 680});
  assert.deepEqual(windowSize({width: 853, height: 620}), {width: 853, height: 620, minWidth: 480, minHeight: 620});
  assert.deepEqual(windowSize({width: 600, height: 1000}), {width: 600, height: 940, minWidth: 480, minHeight: 680});
  assert.deepEqual(windowSize({width: 768, height: 1280}), {width: 768, height: 940, minWidth: 480, minHeight: 680});
  for (const workArea of [{width: 480, height: 1000}, {width: 400, height: 760}, {width: 1173, height: 601}]) {
    const size = windowSize(workArea);
    assert.ok(size.minWidth <= size.width && size.width <= workArea.width);
    assert.ok(size.minHeight <= size.height && size.height <= workArea.height);
    assert.ok(size.minWidth <= 480, 'native minimum must permit portrait client layouts');
  }
});

test('smoke plan accepts bounded DOM steps and rejects filesystem escape and arbitrary actions', () => {
  assert.equal(validateSmokePlan([{action: 'click', selector: '#queueButton'}, {action: 'screenshot', name: 'queue'}]).length, 2);
  assert.throws(() => validateSmokePlan([{action: 'evaluate', source: 'require("fs")'}]), /Unknown/);
  assert.throws(() => validateSmokePlan([{action: 'screenshot', name: '../outside'}]), /Invalid/);
  assert.throws(() => validateSmokePlan([{action: 'wait', ms: 60000}]), /Invalid/);
});

test('build checks referenced scripts, nested CSS resources and renderer directory bounds', async t => {
  const {root: directory, parent: tempParent} = createCanonicalTemp('still-assets-');
  t.after(async () => {assert.equal(path.dirname(directory), tempParent); assert.ok(path.basename(directory).startsWith('still-assets-')); await fs.rm(directory, {recursive: true, force: true});});
  const renderer = path.join(directory, 'renderer'); await fs.mkdir(renderer);
  await fs.writeFile(path.join(renderer, 'index.html'), '<script defer src="features.js"></script><link rel="stylesheet" href="styles.css">');
  await assert.rejects(async () => checkRendererAssets(renderer), /features.js/);
  await fs.writeFile(path.join(renderer, 'features.js'), '');
  await fs.writeFile(path.join(renderer, 'styles.css'), '@import "nested.css";');
  assert.throws(() => checkRendererAssets(renderer), /nested.css/);
  await fs.writeFile(path.join(renderer, 'nested.css'), 'body{background:url("data:image/png;base64,AAAA")}');
  assert.equal(checkRendererAssets(renderer).length, 3);
  await fs.writeFile(path.join(directory, 'outside.js'), '');
  await fs.writeFile(path.join(renderer, 'index.html'), '<script src="../outside.js"></script>');
  assert.throws(() => checkRendererAssets(renderer), /escapes/);
});

test('packaging includes only fixed release-probe executable/source and rejects a missing or invalid tool', async t => {
  const {root: directory, parent: tempParent} = createCanonicalTemp('still-package-tools-');
  t.after(async () => {assert.equal(path.dirname(directory), tempParent); assert.ok(path.basename(directory).startsWith('still-package-tools-')); await fs.rm(directory, {recursive: true, force: true});});
  const tools = path.join(directory, 'tools'), app = path.join(directory, 'app');
  await fs.mkdir(tools);
  await assert.rejects(copyRuntimeTools(tools, app), /ENOENT/);
  await fs.writeFile(path.join(tools, 'foobar-coreaudio-probe.exe'), 'not a PE');
  await fs.writeFile(path.join(tools, 'foobar-coreaudio-probe.cs'), '// fixture source');
  await assert.rejects(copyRuntimeTools(tools, app), /Windows executable/);
  await fs.writeFile(path.join(tools, 'foobar-coreaudio-probe.exe'), 'MZ fixture only');
  await fs.writeFile(path.join(tools, 'do-not-ship-token.txt'), 'fixture secret marker');
  await copyRuntimeTools(tools, app);
  assert.deepEqual((await fs.readdir(path.join(app, 'scripts'))).sort(), ['foobar-coreaudio-probe.cs', 'foobar-coreaudio-probe.exe']);
});

test('packaging rejects a backend without the reviewed private manifest', async t => {
  const {root: directory, parent: tempParent} = createCanonicalTemp('still-package-backend-');
  t.after(async () => {assert.equal(path.dirname(directory), tempParent); assert.ok(path.basename(directory).startsWith('still-package-backend-')); await fs.rm(directory, {recursive: true, force: true});});
  await assert.rejects(verifyPrivateBackend(directory), /ENOENT/);
  await fs.writeFile(path.join(directory, 'backend-manifest.json'), JSON.stringify({schemaVersion: 1, privateUseOnly: false, files: []}));
  await assert.rejects(verifyPrivateBackend(directory), /private backend manifest/);
});

test('versioned packages stay in distinct direct output directories and reject escapes before copying', async t => {
  const {root: directory, parent: tempParent} = createCanonicalTemp('still-versioned-package-');
  t.after(async () => {assert.equal(path.dirname(directory), tempParent); assert.ok(path.basename(directory).startsWith('still-versioned-package-')); await fs.rm(directory, {recursive: true, force: true});});
  const distribution = path.join(directory, 'dist');
  const first = await preparePackageOutput(path.join(distribution, 'Still-win32-x64'), distribution);
  await fs.writeFile(path.join(first, 'frozen-marker'), 'V1 preserved');
  const second = await preparePackageOutput(path.join(distribution, 'Still-V2-preview-win32-x64'), distribution);
  assert.notEqual(first, second);
  assert.equal(await fs.readFile(path.join(first, 'frozen-marker'), 'utf8'), 'V1 preserved');
  await assert.rejects(preparePackageOutput(path.join(directory, 'outside'), distribution), /direct child/);
  await assert.rejects(preparePackageOutput(path.join(distribution, 'nested', 'target'), distribution), /direct child/);
  await assert.rejects(preparePackageOutput(path.join(distribution, '.. '), distribution), /direct child/);
  assert.equal(await fs.lstat(path.join(directory, 'outside')).then(() => true, () => false), false);
});
