'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
// All tests below use pure functions, temporary files and fake windows/IPC.
// No Electron/app/browser process is spawned by this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {EventEmitter} = require('node:events');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const harness = require('../scripts/render-isolated');
const ROOT = path.resolve(__dirname, '..');
const EVIDENCE = path.join(ROOT, 'review-evidence', 'apple-playback-polish-20261101');
async function evidenceFixtureDirectory(t, label) {
  // A clean checkout has no historical evidence directory. Create only its
  // necessary parents, then own a unique child; never clean the evidence root.
  await fs.mkdir(EVIDENCE, {recursive: true});
  const directory = await fs.mkdtemp(path.join(EVIDENCE, `isolated-render-test-${label}-`));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(EVIDENCE));
    assert.ok(path.basename(directory).startsWith(`isolated-render-test-${label}-`));
    await fs.rm(directory, {recursive: true, force: true});
  });
  return directory;
}
const fakeFixture = () => ({bootstrap: {library: {tracks: [{id: 'fixture', title: 'Explicit test track'}]}, player: {state: 'paused'}, settings: {}, selectedSource: 'local', sources: {local: {fixture: true}, apple: {available: false}}}, lyrics: {trackId: 'fixture', fixtureLabel: '自编测试歌词 / 非真实匹配', lines: [{text: '这是自编测试文字'}]}});
function fakeWindow() {
  const win = new EventEmitter(); let visible = false, focused = false, offscreen = true, destroyed = false;
  win.isVisible = () => visible; win.isFocused = () => focused; win.isDestroyed = () => destroyed; win.destroy = () => {destroyed = true;};
  win.webContents = {isOffscreen: () => offscreen};
  return {win, visible: value => {visible = value;}, focused: value => {focused = value;}, offscreen: value => {offscreen = value;}};
}
test('plan CLI defaults to zero spawn and only creates assigned exclusive plan evidence', async t => {
  const scope = await evidenceFixtureDirectory(t, 'plan');
  const file = path.join(scope, 'isolated-render-plan.json'); let spawns = 0;
  const result = await harness.runCLI(['--plan', '--plan-file', file], {spawnImpl: () => {spawns++; throw new Error('MUST NOT SPAWN');}, makePlanImpl: async () => ({planId: 'fixture-only', payload: {fixture: true}})});
  assert.equal(spawns, 0); assert.equal(result.payload.fixture, true); assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).planId, 'fixture-only');
  await assert.rejects(harness.runCLI(['--execute'], {spawnImpl: () => {spawns++;}})); assert.equal(spawns, 0);
  await assert.rejects(harness.runCLI(['--plan-file', path.join(os.tmpdir(), 'forbidden.json')], {makePlanImpl: async () => ({})}));
});
test('one exact lyrics-actualsize 1173x601 scene preserves the hidden/sandbox contract', () => {
  assert.deepEqual(harness.SCENES, [{id: 'lyrics-actualsize', width: 1173, height: 601, hook: 'lyrics'}]);
  for (const scene of harness.SCENES) {
    const session = {}, opts = harness.windowOptions(scene, session);
    assert.equal(opts.show, false); assert.equal(opts.focusable, false); assert.equal(opts.skipTaskbar, true); assert.equal(opts.useContentSize, true);
    assert.equal(opts.webPreferences.offscreen, true); assert.equal(opts.webPreferences.session, session);
    assert.equal(opts.webPreferences.nodeIntegration, false); assert.equal(opts.webPreferences.contextIsolation, true); assert.equal(opts.webPreferences.sandbox, true); assert.equal(opts.webPreferences.webSecurity, true);
    assert.equal(opts.webPreferences.disableDialogs, true); assert.equal(opts.webPreferences.webviewTag, false); assert.equal(opts.webPreferences.devTools, false);
    assert.equal(path.basename(opts.webPreferences.preload), 'render-isolated-preload.js');
  }
  assert.throws(() => harness.windowOptions({width: 300, height: 400, hook: 'arbitrary'}, {}));
});
test('capturePage explicitly stays hidden/does not wake and never calls show/focus', async () => {
  const f = fakeWindow(), calls = [];
  f.win.show = f.win.focus = () => {throw new Error('Forbidden presentation');};
  f.win.webContents.capturePage = async (rect, options) => {calls.push({rect, options}); return 'fake-image';};
  const guard = harness.hiddenGuard(f.win, () => {throw new Error('Guard failure');});
  assert.equal(await harness.captureHidden(f.win, harness.SCENES[0], guard), 'fake-image');
  assert.deepEqual(calls, [{rect: {x: 0, y: 0, width: 1173, height: 601}, options: {stayHidden: true, stayAwake: false}}]); guard.dispose();
});
test('visibility/focus events and broken offscreen invariant abort the owned fake window', async () => {
  for (const change of [f => f.visible(true), f => f.focused(true), f => f.offscreen(false)]) {
    const f = fakeWindow(); const guard = harness.hiddenGuard(f.win, () => f.win.destroy()); change(f); assert.throws(guard.check); assert.equal(f.win.isDestroyed(), true); guard.dispose();
  }
  for (const event of ['show', 'focus']) {const f = fakeWindow(), guard = harness.hiddenGuard(f.win, () => f.win.destroy()); f.win.emit(event); assert.equal(f.win.isDestroyed(), true); guard.dispose();}
});
test('only explicit read fixtures return; every write/login/file picker/source-change is denied and recorded', () => {
  const fixture = fakeFixture(), log = {reads: [], deniedWrites: []};
  const bootstrap = harness.fixtureRead(fixture, 'app:bootstrap', {}, log); bootstrap.player.state = 'playing'; assert.equal(fixture.bootstrap.player.state, 'paused');
  assert.equal(harness.fixtureRead(fixture, 'lyrics:resolve', {trackId: 'fixture'}, log).fixtureLabel, '自编测试歌词 / 非真实匹配');
  for (const channel of ['player:play', 'player:pause', 'player:stop', 'player:seek', 'player:volume', 'audio:select', 'queue:add', 'queue:clear', 'settings:update', 'apple:authorize', 'library:import', 'source:select']) {
    assert.throws(() => harness.fixtureRead(fixture, channel, {path: 'C:\\never-read'}, log), /WRITE_DENIED/);
  }
  assert.equal(log.deniedWrites.length, 12); assert.equal(log.reads.length, 2);
  assert.throws(() => harness.fixtureRead(fixture, 'lyrics:resolve', {trackId: 'not-the-fixture'}, log));
});
test('request gate rejects all remote/18880/WSS and nonlisted/traversal file paths before any filesystem read', () => {
  const asset = path.join(ROOT, 'src', 'renderer', 'index.html');
  const plan = {payload: {sourceFiles: [{path: 'src/renderer/index.html'}], embedded: []}};
  const data = new Set(['data:image/jpeg;base64,explicitfixture']);
  assert.equal(harness.requestAllowed(require('node:url').pathToFileURL(asset).href, plan, data), true);
  assert.equal(harness.requestAllowed('data:image/jpeg;base64,explicitfixture', plan, data), true);
  for (const url of ['http://127.0.0.1:18880/api/player', 'https://music.apple.com/', 'wss://localhost:18880/', 'file:///C:/private/Cookies', 'file:///D:/foobar2000/Still/src/renderer/../../data/library.json', 'data:text/html,notfixture']) assert.equal(harness.requestAllowed(url, plan, data), false);
});
test('asset collection permits exact source scripts/styles and refuses symlink/traversal/remote references', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'still-isolated-assets-')), renderer = path.join(root, 'src', 'renderer');
  t.after(async () => {assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('still-isolated-assets-')); await fs.rm(root, {recursive: true, force: true});});
  await fs.mkdir(renderer, {recursive: true}); await fs.writeFile(path.join(renderer, 'app.js'), '/* explicit test asset */');
  await fs.writeFile(path.join(renderer, 'index.html'), '<script src="app.js"></script>');
  assert.equal((await harness.collectAssets(root)).files.length, 2);
  await fs.mkdir(path.join(renderer, 'assets'));
  const backgroundBytes = Buffer.from('explicit nested background fixture');
  await fs.writeFile(path.join(renderer, 'assets', 'moonlit-lake-v1.png'), backgroundBytes);
  await fs.writeFile(path.join(renderer, 'room.css'), 'body {background-image:url("assets/moonlit-lake-v1.png")}');
  await fs.writeFile(path.join(renderer, 'index.html'), '<script src="app.js"></script><link rel="stylesheet" href="room.css">');
  const nestedAssets = await harness.collectAssets(root);
  assert.equal(nestedAssets.files.length, 4);
  assert.equal(nestedAssets.files.find(item => item.path === 'src/renderer/assets/moonlit-lake-v1.png').sha256, require('node:crypto').createHash('sha256').update(backgroundBytes).digest('hex'));
  await fs.writeFile(path.join(renderer, 'index.html'), '<script src="https://example.invalid/script.js"></script>'); await assert.rejects(harness.collectAssets(root), /exact local/);
  await fs.writeFile(path.join(renderer, 'index.html'), '<script src="../outside.js"></script>'); await assert.rejects(harness.collectAssets(root), /escapes/);
  const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'linked.js'), 'not permitted');
  await fs.symlink(outside, path.join(renderer, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(renderer, 'index.html'), '<script src="linked/linked.js"></script>'); await assert.rejects(harness.collectAssets(root), /Linked/);
});
test('initial render hooks are fixed one-time public entries, not input/click/resize/navigation sequences', () => {
  assert.deepEqual(Object.keys(harness.INITIAL_HOOKS), ['lyrics']);
  assert.match(harness.INITIAL_HOOKS.lyrics, /StillFeatures\.enterImmersive\(\)/);
  for (const source of Object.values(harness.INITIAL_HOOKS)) assert.doesNotMatch(source, /\.click\(|dispatchEvent|sendInputEvent|\.show\(|\.focus\(|resize|location\./);
  let immersiveCalls = 0;
  const window = {StillApp: {state: {immersive: false}}, StillFeatures: {enterImmersive() {immersiveCalls++; window.StillApp.state.immersive = true;}}};
  vm.runInNewContext(harness.INITIAL_HOOKS.lyrics, {window});
  assert.equal(immersiveCalls, 1);
  assert.throws(() => vm.runInNewContext(harness.INITIAL_HOOKS.lyrics, {window}), /Invalid initial lyric scene/);
  assert.equal(immersiveCalls, 1);
});
test('known real metadata selection requires Rose and never fabricates a track/cover', () => {
  const saved = {tracks: [{id: 'known', title: 'Known album', album: 'Known album', artist: 'Known artist', coverUrl: `still-cover://art/${'a'.repeat(64)}.jpg`},
    {id: 'rose', title: '玫瑰少年 (Live)', path: 'E:\\音乐\\华语流行\\玫瑰少年-周深&GAI周延.flac', subsong: 0}]};
  const selected = harness.selectRecords(saved); assert.equal(selected.rose.id, 'rose'); assert.equal(selected.selected.length, 2);
  assert.throws(() => harness.selectRecords({tracks: [saved.tracks[0]]}), /Rose metadata/);
});

test('fixture current uses an existing middle record with two existing neighbours on each side', () => {
  for (const length of [5, 6, 17]) {
    const tracks = Array.from({length}, (_, index) => ({id: `selected-fixture-${index}`, title: `Explicit metadata fixture ${index}`}));
    const before = structuredClone(tracks), selected = harness.middleFixtureTrack(tracks);
    assert.equal(selected.current, tracks[selected.index]);
    assert.ok(selected.index >= 2 && selected.index <= tracks.length - 3);
    assert.equal(tracks.slice(selected.index - 2, selected.index + 3).length, 5);
    assert.deepEqual(tracks, before);
  }
  assert.throws(() => harness.middleFixtureTrack([]), /neighbours/);
});

test('denied writes synchronously abort even when swallowed during capture', async () => {
  const fixture = fakeFixture(), log = {reads: [], deniedWrites: []}, f = fakeWindow(); let fatal = null;
  const fail = error => {fatal = error; f.win.destroy();};
  const guard = harness.hiddenGuard(f.win, fail);
  f.win.webContents.capturePage = async () => {
    try {harness.fixtureRead(fixture, 'player:play', {}, log, fail);} catch {}
    assert.equal(f.win.isDestroyed(), true); return 'must-not-pass';
  };
  await assert.rejects(harness.captureHidden(f.win, harness.SCENES[0], guard));
  assert.equal(fatal, 'ISOLATED_RENDER_WRITE_DENIED'); assert.equal(log.deniedWrites.length, 1); guard.dispose();
});

// Evaluate the exact production registration block, never Electron or a mirrored handler.
async function registeredFixtureIPC() {
  const source = await fs.readFile(path.join(ROOT, 'scripts/render-isolated.js'), 'utf8');
  const start = source.indexOf("    ipcMain.handle('isolated-render:fixture-read'");
  const end = source.indexOf('\n    for (const scene of SCENES)', start);
  assert.ok(start > 0 && end > start);
  const f = fakeWindow(), report = {reads: [], deniedWrites: []}, previous = {reads: [], deniedWrites: []};
  const frame = {url: pathToFileURL(path.join(ROOT, 'src/renderer/index.html')).href};
  Object.assign(f.win.webContents, {id: 101, mainFrame: frame});
  const stale = {id: 100, mainFrame: frame};
  let callback, fatal = null;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: {handle: (name, handler) => {assert.equal(name, 'isolated-render:fixture-read'); callback = handler;}},
    reportBySender: new Map([[100, previous], [101, report]]), reports: [previous], active: f.win,
    READS: harness.READS, fixtureRead: harness.fixtureRead, fixture: fakeFixture(), pathToFileURL,
    config: {plan: {payload: {entry: path.join(ROOT, 'src/renderer/index.html')}}},
    fail: message => {fatal ||= message; f.win.destroy();},
    demand: (value, message) => {if (!value) throw new Error(message);}
  });
  return {...f, report, previous, stale, frame, callback, fatal: () => fatal,
    event: {sender: f.win.webContents, senderFrame: frame}};
}

const invalidIPC = {
  'wrong frame': f => [{...f.event, senderFrame: {url: f.frame.url}}, {channel: 'app:bootstrap'}],
  'wrong URL': f => {f.frame.url = 'https://example.invalid/'; return [f.event, {channel: 'app:bootstrap'}];},
  'stale registered sender': f => [{sender: f.stale, senderFrame: f.frame}, {channel: 'app:bootstrap'}],
  'unknown sender': f => [{sender: {id: 999}, senderFrame: f.frame}, {channel: 'app:bootstrap'}],
  'invalid fixture ID': f => [f.event, {channel: 'lyrics:resolve', payload: {trackId: 'wrong'}}],
  'forbidden write': f => [f.event, {channel: 'player:play'}],
  'malformed event': () => [null, {channel: 'app:bootstrap'}]
};

test('actual registered fixture IPC serves trusted reads without fatal or denial', async () => {
  const f = await registeredFixtureIPC();
  assert.equal(f.callback(f.event, {channel: 'app:bootstrap'}).player.state, 'paused');
  assert.equal(f.fatal(), null); assert.equal(f.win.isDestroyed(), false); assert.equal(f.report.deniedIPC, undefined);
});

for (const [name, argumentsFor] of Object.entries(invalidIPC)) {
  test(`actual registered fixture IPC rejects ${name} synchronously and fails swallowed late capture`, async () => {
    const f = await registeredFixtureIPC(), guard = harness.hiddenGuard(f.win, () => f.win.destroy());
    f.win.webContents.capturePage = async () => {
      // A renderer catching the rejected invocation must never rescue this capture.
      assert.throws(() => f.callback(...argumentsFor(f)));
      assert.ok(f.fatal()); assert.equal(f.win.isDestroyed(), true);
      const denied = name === 'stale registered sender' ? f.previous : f.report;
      assert.equal(denied.deniedIPC.length, 1);
      assert.equal(JSON.stringify(denied.deniedIPC), '[{"reason":"ISOLATED_RENDER_IPC_REJECTED"}]');
      if (name === 'forbidden write') assert.equal(f.report.deniedWrites.length, 1);
      return 'must-not-pass';
    };
    await assert.rejects(harness.captureHidden(f.win, harness.SCENES[0], guard), /destroyed/);
    assert.ok(f.fatal()); guard.dispose();
  });
}

test('output ancestor validation precedes mkdir and refuses an outside junction without creating output', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'still-isolated-output-')), outside = path.join(root, 'outside'), evidence = path.join(root, 'evidence');
  t.after(async () => {assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('still-isolated-output-')); await fs.rm(root, {recursive: true, force: true});});
  await fs.mkdir(outside); await fs.mkdir(evidence); await fs.symlink(outside, path.join(evidence, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(harness.prepareOutputDirectory(path.join(evidence, 'link', 'isolated-render-forbidden'), evidence), /ancestor/);
  assert.deepEqual(await fs.readdir(outside), []);
  const safe = await harness.prepareOutputDirectory(path.join(evidence, 'isolated-render-safe'), evidence); assert.equal(safe, path.join(evidence, 'isolated-render-safe'));
});

test('plan output also refuses linked ancestors before writing the plan file', async t => {
  const scope = await evidenceFixtureDirectory(t, 'link'), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'still-isolated-plan-outside-'));
  t.after(async () => {assert.ok(outside.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(outside, {recursive: true, force: true});});
  await fs.symlink(outside, path.join(scope, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(harness.runCLI(['--plan-file', path.join(scope, 'link', 'isolated-render-plan.json')], {makePlanImpl: async () => ({fixture: true})}), /ancestor/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('actual lyrics fixture requires exact 1173x601 DPR1 DOM and lyric markers', () => {
  const scene = harness.SCENES[0], lyric = {viewport: {width: 1173, height: 601, devicePixelRatio: 1}, playerState: 'paused', fixtureLabel: '隔离测试状态 / 非播放验收', immersive: true, lyricNodes: 8, lyricsFixture: '隔离测试状态'};
  assert.doesNotThrow(() => harness.validateSceneDOM(scene, lyric));
  assert.throws(() => harness.validateSceneDOM(scene, {...lyric, lyricNodes: 0}));
  assert.throws(() => harness.validateSceneDOM(scene, {...lyric, immersive: false}));
  assert.throws(() => harness.validateSceneDOM(scene, {...lyric, lyricsFixture: ''}));
  assert.throws(() => harness.validateSceneDOM(scene, {...lyric, viewport: {...lyric.viewport, width: 1183}}), /CSS viewport/);
  assert.throws(() => harness.validateSceneDOM(scene, {...lyric, viewport: {...lyric.viewport, devicePixelRatio: 3.25}}), /fixture DPR/);
});

test('only confirmed owned child close permits profile removal; a kill without close retains failure evidence', async t => {
  const output = await evidenceFixtureDirectory(t, 'cleanup'), roots = [];
  t.after(async () => {for (const root of roots) {assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('still-isolated-render-')); await fs.rm(root, {recursive: true, force: true});}});
  for (const mode of ['normal', 'late', 'never']) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'still-isolated-render-')); roots.push(tempRoot);
    await fs.writeFile(path.join(tempRoot, 'profile-fixture.txt'), 'owned fresh test profile');
    const child = new EventEmitter(); child.kill = () => true;
    if (mode === 'late') setTimeout(() => child.emit('close', 0), 5);
    if (mode === 'never') {
      child.kill(); await assert.rejects(harness.cleanupOwnedProfile({tempRoot, child, childClosed: false, outputDir: output, waitMs: 20}), /exit unverified/);
      assert.equal((await fs.stat(tempRoot)).isDirectory(), true);
      const failure = JSON.parse(await fs.readFile(path.join(output, 'launcher-failure.json'), 'utf8')); assert.equal(failure.profileRemoved, false); assert.equal(failure.error, 'OWN_WORKER_EXIT_UNVERIFIED');
    } else {
      assert.deepEqual(await harness.cleanupOwnedProfile({tempRoot, child, childClosed: mode === 'normal', outputDir: output, waitMs: 30}), {profileRemoved: true});
      await assert.rejects(fs.stat(tempRoot), {code: 'ENOENT'});
    }
  }
});

async function actualEntry({electron = true, type = 'browser', main = false, argv} = {}) {
  const source = await fs.readFile(path.join(ROOT, 'scripts/render-isolated.js'), 'utf8');
  const start = source.indexOf('const isElectronBrowser ='), end = source.indexOf('\nmodule.exports =', start);
  assert.ok(start > 0 && end > start);
  const entry = path.join(ROOT, 'scripts/render-isolated.js'), config = path.join(ROOT, 'owned-config-fixture.json');
  const calls = {worker: [], cli: 0, reads: [], exits: [], errors: []}, ownModule = {exports: {}};
  const fakeRequire = name => {assert.equal(name, 'electron'); return {app: {exit: code => calls.exits.push(code)}};};
  fakeRequire.main = main ? ownModule : {anotherModule: true};
  vm.runInNewContext(source.slice(start, end), {
    module: ownModule, require: fakeRequire, __filename: entry,
    process: {versions: electron ? {electron: '45.0.0'} : {}, type, argv: argv || ['stock-electron', entry, '--isolated-worker', config], stderr: {write: text => calls.errors.push(text)}},
    canonical: value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value),
    demand: (value, message) => {if (!value) throw new Error(message);},
    fsSync: {readFileSync: (file, encoding) => {calls.reads.push(file); assert.equal(encoding, 'utf8'); return '{"ownedFixture":true}';}},
    runWorker: fixture => {calls.worker.push(fixture); return Promise.resolve();},
    runCLI: () => {calls.cli++; return Promise.resolve();}
  });
  return calls;
}

test('actual entry starts only exact Electron browser worker even when require.main differs', async () => {
  for (const main of [false, true]) {
    const calls = await actualEntry({main});
    assert.equal(calls.worker.length, 1); assert.equal(calls.worker[0].ownedFixture, true);
    assert.equal(calls.reads.length, 1); assert.equal(calls.cli, 0); assert.equal(calls.exits.length, 0);
  }
});

test('actual entry keeps Node imports inert and Node direct CLI separate from worker startup', async () => {
  const imported = await actualEntry({electron: false});
  assert.equal(imported.worker.length, 0); assert.equal(imported.cli, 0); assert.equal(imported.reads.length, 0);
  const direct = await actualEntry({electron: false, main: true});
  assert.equal(direct.worker.length, 0); assert.equal(direct.cli, 1); assert.equal(direct.reads.length, 0);
});

test('actual entry rejects unknown/missing/extra worker args without invoking CLI or reading config', async () => {
  const entry = path.join(ROOT, 'scripts/render-isolated.js');
  for (const args of [[], ['--execute', 'fixture.json'], ['--isolated-worker'], ['--isolated-worker', 'fixture.json', 'extra']]) {
    const calls = await actualEntry({argv: ['stock-electron', entry, ...args]});
    assert.equal(calls.worker.length, 0); assert.equal(calls.cli, 0); assert.equal(calls.reads.length, 0);
    assert.deepEqual(calls.exits, [1]); assert.match(calls.errors[0], /Exact isolated worker arguments required/);
  }
});

test('actual entry imported by another Electron app or nonbrowser process is inert', async () => {
  for (const options of [{main: true, argv: ['stock-electron', path.join(ROOT, 'other-app.js'), '--isolated-worker', 'fixture.json']}, {type: 'renderer', main: true}]) {
    const calls = await actualEntry(options);
    assert.equal(calls.worker.length, 0); assert.equal(calls.cli, 0); assert.equal(calls.reads.length, 0); assert.equal(calls.exits.length, 0);
  }
});

test('actual one-scene setup loads fresh owned fixture without emulation/native resize/show/focus/input', async () => {
  const source = await fs.readFile(path.join(ROOT, 'scripts/render-isolated.js'), 'utf8');
  assert.doesNotMatch(source, /enableDeviceEmulation|disableDeviceEmulation|deviceScaleFactor|\.setSize\(|\.setBounds\(|\.setContentSize\(|\.setContentBounds\(|\.show\(|\.focus\(|sendInputEvent/);
  const start = source.indexOf('        demand(BrowserWindow.getAllWindows().length === 0'), end = source.indexOf('        const until = Date.now()', start);
  assert.ok(start > 0 && end > start);
  const owned = new Set();
  for (const scene of harness.SCENES) {
    const f = fakeWindow(), order = [], report = {}, reportBySender = new Map();
    for (const method of ['show', 'focus', 'setSize', 'setBounds', 'setContentSize', 'setContentBounds']) f.win[method] = () => {throw new Error(`Forbidden native ${method}`);};
    Object.assign(f.win.webContents, new EventEmitter());
    f.win.webContents.on = EventEmitter.prototype.on;
    Object.assign(f.win.webContents, {id: owned.size + 1, setAudioMuted() {}, setFrameRate() {}, setWindowOpenHandler() {},
      sendInputEvent() {throw new Error('Forbidden input');},
      enableDeviceEmulation() {throw new Error('Forbidden device emulation');}, disableDeviceEmulation() {throw new Error('Forbidden device emulation');}});
    f.win.loadFile = async file => {assert.equal(file, 'fixed-source-entry'); order.push('load');};
    function BrowserWindow(options) {assert.equal(options.show, false); assert.equal(options.focusable, false); assert.equal(options.webPreferences.offscreen, true); owned.add(f.win); order.push('create'); return f.win;}
    BrowserWindow.getAllWindows = () => [];
    await vm.runInNewContext(`(async () => {${source.slice(start, end)}})()`, {
      BrowserWindow, windowOptions: harness.windowOptions, hiddenGuard: harness.hiddenGuard,
      scene, ses: {}, active: null, guard: null, timer: null, report, reportBySender,
      config: {plan: {payload: {entry: 'fixed-source-entry'}}},
      fail: message => {throw new Error(message);}, setTimeout: () => 1,
      demand: (value, message) => {if (!value) throw new Error(message);}
    });
    assert.deepEqual(order, ['create', 'load']);
    assert.equal(reportBySender.size, 1); assert.equal(report.emulation, undefined);
    assert.equal(f.win.isVisible(), false); assert.equal(f.win.isFocused(), false); f.win.destroy();
  }
  assert.equal(owned.size, 1);
});

function pngHeaderFixture(width, height) {
  const bytes = Buffer.alloc(1024);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}

test('PNG IHDR pixel gate requires exact scene pixels, rejects DIP-scaled or malformed captures', () => {
  for (const scene of harness.SCENES) {
    assert.deepEqual(harness.validatePNGSize(pngHeaderFixture(scene.width, scene.height), scene), {width: scene.width, height: scene.height});
    assert.throws(() => harness.validatePNGSize(pngHeaderFixture(scene.width * 2, scene.height * 2), scene), /PNG pixel dimensions/);
    assert.throws(() => harness.validatePNGSize(pngHeaderFixture(scene.width, scene.height - 1), scene), /PNG pixel dimensions/);
  }
  assert.throws(() => harness.validatePNGSize(Buffer.alloc(1024), harness.SCENES[0]), /IHDR/);
  assert.throws(() => harness.validatePNGSize(Buffer.alloc(24), harness.SCENES[0]), /IHDR/);
});

test('actual capture/write block rejects incorrect PNG pixels even if NativeImage DIP size matches', async () => {
  const source = await fs.readFile(path.join(ROOT, 'scripts/render-isolated.js'), 'utf8');
  const start = source.indexOf('        const image = await captureHidden(active, scene, guard)'), end = source.indexOf('      } catch (error)', start);
  assert.ok(start > 0 && end > start);
  const scene = harness.SCENES[0], report = {}, writes = [];
  await assert.rejects(vm.runInNewContext(`(async () => {${source.slice(start, end)}})()`, {
    scene, report, active: {}, guard: {check: () => ({visible: false, focused: false, offscreen: true})},
    captureHidden: async () => ({toPNG: () => pngHeaderFixture(scene.width * 2, scene.height * 2), getSize: () => ({width: scene.width, height: scene.height})}),
    validatePNGSize: harness.validatePNGSize, path, config: {outputDir: 'never-written'}, fs: {writeFile: async (...args) => writes.push(args)},
    demand: (value, message) => {if (!value) throw new Error(message);}
  }), /PNG pixel dimensions/);
  assert.equal(writes.length, 0); assert.notEqual(report.passed, true);
});
