'use strict';

// Default CLI mode only plans. --execute is for an independently reviewed,
// explicitly released isolated render run, never the production application.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createHash, randomUUID} = require('node:crypto');
const {pathToFileURL, fileURLToPath} = require('node:url');
const {spawn} = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const EVIDENCE = path.join(ROOT, 'review-evidence', 'apple-playback-polish-20261101');
const SNAPSHOT = 'scripts/foobar-evidence/acceptance-1793332902113/still-library-before.json';
const PRELOAD = path.join(__dirname, 'render-isolated-preload.js');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SHARP = 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp';
const LABEL = '隔离源码fixture1173x601/DPR1；非用户DPI3.25/非播放';
const VIEWPORT_MODE = 'fixed source fixture CSS viewport';
const SCENES = Object.freeze([
  {id: 'lyrics-actualsize', width: 1173, height: 601, hook: 'lyrics'}
]);
const READS = new Set(['app:bootstrap', 'library:list', 'player:state', 'settings:get', 'source:status', 'apple:status', 'queue:list', 'lyrics:resolve']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprint = value => digest(JSON.stringify(value));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function demand(value, message) {if (!value) throw new Error(message);}
function inside(root, value) {const r = path.relative(root, value); return r !== '' && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);}
async function regularFile(root, filename) {
  const resolved = path.resolve(filename); demand(inside(root, resolved), 'Read path escapes its explicit root.');
  demand(canonical(await fs.realpath(root)) === canonical(root), 'Root is a symlink/junction.');
  let cursor = root;
  for (const segment of path.relative(root, resolved).split(path.sep)) {cursor = path.join(cursor, segment); demand(!(await fs.lstat(cursor)).isSymbolicLink(), 'Linked source/asset refused.');}
  demand((await fs.stat(resolved)).isFile() && canonical(await fs.realpath(resolved)) === canonical(resolved), 'Not an exact regular source/asset file.');
  return resolved;
}
async function exactDirectory(directory) {
  const resolved = path.resolve(directory), root = path.parse(resolved).root;
  let cursor = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment); const stat = await fs.lstat(cursor);
    demand(stat.isDirectory() && !stat.isSymbolicLink() && canonical(await fs.realpath(cursor)) === canonical(cursor), 'Output ancestor is not an exact directory (symlink/junction refused).');
  }
}
async function prepareOutputDirectory(directory, evidenceRoot = EVIDENCE) {
  const resolved = path.resolve(directory);
  demand(inside(evidenceRoot, resolved) && path.basename(resolved).startsWith('isolated-render-'), 'Output outside assigned evidence scope.');
  await exactDirectory(path.dirname(resolved)); // Must precede mkdir, not follow an outside write.
  await fs.mkdir(resolved); await exactDirectory(resolved); return resolved;
}
async function cleanupOwnedProfile({tempRoot, child, childClosed, outputDir, waitMs = 3000}) {
  demand(inside(os.tmpdir(), tempRoot) && path.basename(tempRoot).startsWith('still-isolated-render-') && canonical(await fs.realpath(tempRoot)) === canonical(tempRoot), 'Temporary profile cleanup boundary mismatch.');
  let closed = childClosed || !child;
  if (!closed) closed = await new Promise(resolve => {
    const onClose = () => {clearTimeout(timer); resolve(true);};
    const timer = setTimeout(() => {child.removeListener('close', onClose); resolve(false);}, waitMs);
    child.once('close', onClose);
  });
  if (!closed) {
    await exactDirectory(outputDir);
    await fs.writeFile(path.join(outputDir, 'launcher-failure.json'), JSON.stringify({passed: false, fixture: true,
      error: 'OWN_WORKER_EXIT_UNVERIFIED', profileRemoved: false, retainedFreshTempRoot: tempRoot}, null, 2), {flag: 'wx'});
    throw new Error('Owned test process exit unverified; fresh profile retained.');
  }
  await fs.rm(tempRoot, {recursive: true, force: true}); return {profileRemoved: true};
}
async function collectAssets(root = ROOT) {
  const renderer = path.join(root, 'src', 'renderer'), files = new Map(), embedded = new Set();
  async function add(reference, owner) {
    if (reference.startsWith('#')) return;
    if (reference.startsWith('data:')) {embedded.add(reference); return;}
    const url = new URL(reference, pathToFileURL(owner)); demand(url.protocol === 'file:' && !url.host && !url.search, 'Only exact local renderer assets are allowed.');
    const file = await regularFile(renderer, fileURLToPath(url)); if (files.has(file)) return;
    const bytes = await fs.readFile(file); files.set(file, {path: path.relative(root, file).replaceAll('\\', '/'), sha256: digest(bytes)});
    if (path.extname(file).toLowerCase() === '.css') {
      const css = bytes.toString('utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of css.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]/gi)) await add(match[1] || match[2], file);
    }
  }
  const entry = path.join(renderer, 'index.html'); await add('index.html', entry);
  const html = await fs.readFile(entry, 'utf8');
  for (const tag of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const attrs = Object.fromEntries([...tag[2].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(m => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4]]));
    if (tag[1].toLowerCase() === 'script' && attrs.src) await add(attrs.src, entry);
    if (tag[1].toLowerCase() === 'link' && attrs.rel?.toLowerCase() === 'stylesheet') await add(attrs.href, entry);
  }
  return {entry, files: [...files.values()], embedded: [...embedded]};
}
function selectRecords(saved) {
  demand(Array.isArray(saved?.tracks), 'Missing explicit historical library fixture.');
  const groups = new Map();
  for (const raw of saved.tracks) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string') continue;
    const key = `${raw.album || ''}\u0000${raw.albumArtist || raw.artist || ''}`;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(raw);
  }
  const rose = saved.tracks.find(raw => raw.path === 'E:\\音乐\\华语流行\\玫瑰少年-周深&GAI周延.flac' && raw.subsong === 0);
  demand(rose, 'Known real Rose metadata is absent from the historical fixture.');
  const selected = [...groups.values()].filter(group => group.some(t => /^still-cover:\/\/art\/[a-f0-9]{64}\.(?:jpg|png|webp|gif)$/i.test(t.coverUrl || ''))).slice(0, 14).flatMap(group => group.slice(0, 6));
  if (!selected.some(t => t.id === rose.id)) selected.push(rose);
  return {selected, rose};
}
async function makePlan({root = ROOT} = {}) {
  const assets = await collectAssets(root), sourceFile = await regularFile(root, path.join(root, SNAPSHOT));
  const sourceBytes = await fs.readFile(sourceFile), saved = JSON.parse(sourceBytes), {selected} = selectRecords(saved);
  const covers = [];
  for (const name of new Set(selected.map(raw => /^still-cover:\/\/art\/([a-f0-9]{64}\.(?:jpg|png|webp|gif))$/i.exec(raw.coverUrl || '')?.[1]).filter(Boolean))) {
    const file = await regularFile(path.join(root, 'data', 'covers'), path.join(root, 'data', 'covers', name));
    covers.push({name, sha256: digest(await fs.readFile(file))});
  }
  const pins = [];
  for (const relative of ['scripts/render-isolated.js', 'scripts/render-isolated-preload.js', 'node_modules/electron/dist/electron.exe']) {
    const file = await regularFile(root, path.join(root, relative)); pins.push({path: relative, sha256: digest(await fs.readFile(file))});
  }
  const payload = {schemaVersion: 1, mode: 'static-offscreen-not-native', fixture: true, label: LABEL,
    root, entry: assets.entry, scenes: SCENES, sourceFiles: assets.files, embedded: assets.embedded,
    snapshot: {path: SNAPSHOT, sha256: digest(sourceBytes)}, covers, pins,
    isolation: {show: false, focusable: false, skipTaskbar: true, offscreen: true, sandbox: true,
      contextIsolation: true, nodeIntegration: false, webSecurity: true, captureStayHidden: true,
      captureStayAwake: false, persistentSession: false, frameRate: 10, audioMuted: true,
      singleElectronWorker: true, chromiumChildProcessesExpected: true, oneWindowAtATime: true, maximumSceneMs: 15000,
      viewportMode: VIEWPORT_MODE, fixtureDPR: 1, exactCapturePixels: true},
    initialHooks: {lyrics: 'bootstrap plus one StillFeatures.enterImmersive()'},
    unverified: ['native-window rendering/focus/DPI', 'real playback and full-song subscription', 'device/output/engine handoff']};
  return {planId: fingerprint(payload), payload};
}
function validatePlan(plan, approvedId) {
  demand(plan?.payload?.schemaVersion === 1 && plan.planId === approvedId && fingerprint(plan.payload) === plan.planId, 'Exact reviewed plan ID required.');
  demand(canonical(plan.payload.root) === canonical(ROOT) && fingerprint(plan.payload.scenes) === fingerprint(SCENES) && plan.payload.entry === path.join(ROOT, 'src', 'renderer', 'index.html'), 'Plan scope differs from this fixed renderer harness.');
}
async function verifyPins(plan) {
  for (const item of [...plan.payload.sourceFiles, plan.payload.snapshot, ...plan.payload.pins]) {
    const file = await regularFile(ROOT, path.join(ROOT, item.path)); demand(digest(await fs.readFile(file)) === item.sha256, `Reviewed file changed: ${item.path}`);
  }
  for (const cover of plan.payload.covers) {
    const file = await regularFile(path.join(ROOT, 'data', 'covers'), path.join(ROOT, 'data', 'covers', cover.name));
    demand(digest(await fs.readFile(file)) === cover.sha256, 'Explicit cover changed after review.');
  }
}
function middleFixtureTrack(tracks) {
  demand(Array.isArray(tracks) && tracks.length >= 5, 'Fixture needs two selected historical neighbours on each side.');
  const index = Math.floor(tracks.length / 2);
  return {current: tracks[index], index};
}
async function prepareFixture(plan, sharp) {
  const saved = JSON.parse(await fs.readFile(path.join(ROOT, SNAPSHOT), 'utf8')), {selected} = selectRecords(saved), data = new Map();
  for (const cover of plan.payload.covers) {
    const bytes = await sharp(path.join(ROOT, 'data', 'covers', cover.name)).resize(320, 320, {fit: 'cover'}).jpeg({quality: 86}).toBuffer();
    data.set(cover.name, `data:image/jpeg;base64,${bytes.toString('base64')}`);
  }
  const tracks = selected.map(raw => ({id: `isolated-fixture-${raw.id}`, title: raw.title, artist: raw.artist || '', album: raw.album || '', albumArtist: raw.albumArtist || raw.artist || '',
    duration: raw.duration, trackNumber: raw.trackNumber, discNumber: raw.discNumber, valid: true, supported: true,
    coverUrl: data.get(/^still-cover:\/\/art\/(.+)$/.exec(raw.coverUrl || '')?.[1]) || '', fixture: true}));
  const {current, index: currentIndex} = middleFixtureTrack(tracks);
  demand(current, 'Paused fixture metadata missing.');
  const local = {id: 'local', available: true, status: 'ready', message: '隔离渲染测试状态；未连接播放服务。', capabilities: {playback: true, retryBackend: false}};
  const apple = {id: 'apple', provider: 'officialWeb', available: false, status: 'unavailable', message: '隔离渲染不连接 Apple 会话。', capabilities: {authorize: false, library: false, search: false, playback: false}};
  const settings = {appearance: {localView: 'albums', accentColor: '#E5C49B', reducedMotion: false}, lyrics: {fontSize: 30, lineHeight: 1.75, translationSize: 18, showOriginal: true, showTranslation: true, onlineEnabled: false}};
  const player = {available: true, state: 'paused', source: 'local', lastSource: 'local', generation: 0, revision: 1, position: 14.54,
    duration: current.duration, volume: 1, currentTrackId: current.id, currentTrack: current, playbackOrder: {id: 0, name: '默认'}, playbackOrders: [{id: 0, name: '默认'}],
    simulatedUIFixture: true, fixtureLabel: '隔离测试状态 / 非用户会话 / 非真实队列 / 非播放验收'};
  const lines = ['把窗边的微光，轻轻放进此刻', '让唱片停在安静的一页', '这些文字只为界面测试而写', '不是这首歌曲的真实歌词', '玻璃映着远处柔和的颜色', '时间暂停在同一个位置', '请把声音留给真实的聆听', '此处没有播放，也没有匹配'];
  const lyrics = {trackId: current.id, status: 'ready', kind: 'line', source: 'isolated-render-fixture', simulatedUIFixture: true,
    fixtureLabel: '自编测试歌词 / 非真实匹配', title: current.title, artist: current.artist, offsetMs: 0,
    lines: lines.map((text, index) => ({startMs: index * 4800, endMs: (index + 1) * 4800, text, translation: 'Static renderer fixture — not matched lyrics.'}))};
  const fixture = {bootstrap: {library: {tracks, playlists: [], folders: []}, player, settings, selectedSource: 'local', sources: {local, apple},
    capabilities: {persistUIState: false, exportDiagnostics: false}, version: 'isolated-static-fixture'}, lyrics,
    provenance: {snapshot: plan.payload.snapshot, coverHashes: plan.payload.covers, originalTrackCount: saved.tracks.length, selectedTrackCount: tracks.length,
      currentSelection: {index: currentIndex, trackId: current.id, method: 'middle of selected historical metadata; neighbours are selected fixture records only'},
      fixtureOnly: true, userSession: false, realQueue: false, restoredRoseSession: false, accentPreviewOnly: '#E5C49B'}};
  return fixture;
}
function fixtureRead(fixture, channel, payload, log, deny = () => {}) {
  if (!READS.has(channel)) {log.deniedWrites.push({channel: typeof channel === 'string' ? channel.slice(0, 80) : 'invalid'}); deny('ISOLATED_RENDER_WRITE_DENIED'); throw new Error('ISOLATED_RENDER_WRITE_DENIED');}
  log.reads.push({channel});
  const b = fixture.bootstrap;
  if (channel === 'app:bootstrap') return structuredClone(b);
  if (channel === 'library:list') return structuredClone(b.library);
  if (channel === 'player:state') return structuredClone(b.player);
  if (channel === 'settings:get') return structuredClone(b.settings);
  if (channel === 'source:status') return structuredClone({selectedSource: b.selectedSource, sources: b.sources});
  if (channel === 'apple:status') return structuredClone(b.sources.apple);
  if (channel === 'queue:list') return {items: [], fixture: true};
  demand(payload?.trackId === fixture.lyrics.trackId, 'Unknown isolated lyric fixture ID.');
  return structuredClone(fixture.lyrics);
}
function windowOptions(scene, session) {
  demand(SCENES.some(s => fingerprint(s) === fingerprint(scene)), 'Unknown initial scene.');
  return {width: scene.width, height: scene.height, useContentSize: true, show: false, frame: false, focusable: false, skipTaskbar: true,
    webPreferences: {session, preload: PRELOAD, offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      webviewTag: false, devTools: false, disableDialogs: true, spellcheck: false, navigateOnDragDrop: false, backgroundThrottling: false}};
}
function hiddenGuard(win, failed) {
  const check = () => {
    demand(!win.isDestroyed(), 'Isolated test window was destroyed.');
    if (win.isVisible() || win.isFocused() || win.webContents.isOffscreen() !== true) {failed('Own hidden/offscreen window invariant failed.'); throw new Error('OWN_WINDOW_VISIBILITY_OR_FOCUS');}
    return {visible: false, focused: false, offscreen: true};
  };
  const violation = () => failed('Own test window emitted show/focus.');
  win.on('show', violation); win.on('focus', violation);
  return {check, dispose() {win.removeListener('show', violation); win.removeListener('focus', violation);}};
}
async function captureHidden(win, scene, guard) {
  guard.check();
  // Electron 45 capturePage's default stayHidden=false is intentionally overridden.
  const image = await win.webContents.capturePage({x: 0, y: 0, width: scene.width, height: scene.height}, {stayHidden: true, stayAwake: false});
  guard.check(); return image;
}
function validatePNGSize(bytes, scene) {
  demand(Buffer.isBuffer(bytes) && bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR', 'Capture is not a PNG with an IHDR.');
  const size = {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
  demand(size.width === scene.width && size.height === scene.height, 'PNG pixel dimensions differ from scene plan.');
  return size;
}
function requestAllowed(urlText, plan, allowedData) {
  try {
    if (allowedData.has(urlText) || plan.payload.embedded.includes(urlText)) return true;
    const url = new URL(urlText); if (url.protocol !== 'file:' || url.host || url.search) return false;
    const filename = canonical(fileURLToPath(url));
    return plan.payload.sourceFiles.some(item => canonical(path.join(ROOT, item.path)) === filename);
  } catch {return false;}
}
const READY = `(() => !!window.StillApp?.state?.ready && !!window.StillFeatures && !!window.StillGlass)()`;
const INITIAL_HOOKS = {
  lyrics: `(() => { if (!window.StillFeatures || window.StillApp.state.immersive) throw new Error('Invalid initial lyric scene'); window.StillFeatures.enterImmersive(); return {hook:'StillFeatures.enterImmersive-once'}; })()`
};
const SETTLE = `(async () => { await Promise.race([document.fonts.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Fonts timeout')),3000))]); await Promise.all([...document.images].map(image=>image.decode().catch(()=>{}))); await new Promise(resolve=>setTimeout(resolve,1100)); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); return true; })()`;
const MEASURE = `(() => ({viewport:{width:innerWidth,height:innerHeight,devicePixelRatio}, horizontalOverflow:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)>innerWidth+1, title:document.title, browseSource:window.StillApp.state.browseSource, view:window.StillApp.state.view, playerState:window.StillApp.state.player.state, fixtureLabel:window.StillApp.state.player.fixtureLabel, immersive:window.StillApp.state.immersive, dialogOpen:document.getElementById('dialog').open, dialogTitle:document.getElementById('dialogTitle').textContent, lyricNodes:document.querySelectorAll('#lyricsBody .lyric-line').length, lyricsFixture:document.getElementById('lyricsFixture').textContent, paletteSwatches:document.querySelectorAll('.accent-swatch').length, albumTiles:document.querySelectorAll('#viewContent .tile').length, fanCards:document.querySelectorAll('#recordStage .fan-card').length, missingImages:[...document.images].map((im,index)=>({index,complete:im.complete,width:im.naturalWidth})).filter(im=>!im.complete||!im.width), actualSourceDOM:true, fixture:true}))()`;
function validateSceneDOM(scene, dom) {
  demand(dom.viewport.width === scene.width && dom.viewport.height === scene.height, 'CSS viewport differs from scene plan.');
  demand(dom.viewport.devicePixelRatio === 1, 'Source fixture viewport DPR differs from fixed fixture DPR 1.');
  demand(dom.playerState === 'paused' && typeof dom.fixtureLabel === 'string' && dom.fixtureLabel.includes('隔离测试'), 'Paused/test-state marker absent.');
  demand(scene.hook === 'lyrics' && dom.immersive && dom.lyricNodes > 0 && typeof dom.lyricsFixture === 'string' && dom.lyricsFixture.includes('测试'), 'Actual initial lyric scene/fixture marker absent.');
}
async function runWorker(config) {
  const {app, BrowserWindow, ipcMain, session} = require('electron');
  validatePlan(config.plan, config.plan.planId);
  demand(inside(os.tmpdir(), config.tempRoot) && path.basename(config.tempRoot).startsWith('still-isolated-render-') &&
    inside(config.tempRoot, config.profileDir) && canonical(fsSync.realpathSync(config.tempRoot)) === canonical(config.tempRoot) &&
    canonical(fsSync.realpathSync(config.profileDir)) === canonical(config.profileDir), 'Invalid fresh test profile.');
  // These calls run synchronously before the first await/app-ready/session use.
  app.setPath('userData', config.profileDir); app.setPath('sessionData', path.join(config.profileDir, 'session'));
  app.commandLine.appendSwitch('disable-background-networking'); app.commandLine.appendSwitch('disable-component-update');
  await verifyPins(config.plan);
  demand(inside(EVIDENCE, config.outputDir) && path.basename(config.outputDir).startsWith('isolated-render-') && inside(config.outputDir, config.fixtureFile), 'Invalid worker evidence boundary.');
  await exactDirectory(config.outputDir);
  const fixtureBytes = await fs.readFile(config.fixtureFile); demand(digest(fixtureBytes) === config.fixtureSha256, 'Fixture changed.');
  const fixture = JSON.parse(fixtureBytes), allowedData = new Set(fixture.bootstrap.library.tracks.map(t => t.coverUrl).filter(Boolean));
  const reports = [], reportBySender = new Map(); let active = null, fatal = null;
  const fail = message => {fatal ||= message; if (active && !active.isDestroyed()) active.destroy();};
  app.on('window-all-closed', () => {});
  try {
    await app.whenReady();
    const ses = session.fromPartition(`isolated-render-${config.runId}`, {cache: false});
    const networkDenied = [];
    ses.webRequest.onBeforeRequest({urls: ['<all_urls>']}, async (details, callback) => {
      const allowed = requestAllowed(details.url, config.plan, allowedData);
      if (!allowed) {let scheme = 'invalid'; try {scheme = new URL(details.url).protocol;} catch {} networkDenied.push({scheme}); callback({cancel: true}); fail('Unapproved request attempted.'); return;}
      try {
        if (details.url.startsWith('file:')) {
          // Never lstat/realpath an arbitrary requested path: membership above is first.
          const file = await regularFile(path.join(ROOT, 'src', 'renderer'), fileURLToPath(details.url));
          const pin = config.plan.payload.sourceFiles.find(item => canonical(path.join(ROOT, item.path)) === canonical(file));
          demand(pin && digest(await fs.readFile(file)) === pin.sha256, 'Requested source asset changed.');
        }
        callback({cancel: false});
      } catch {networkDenied.push({scheme: 'file:', reason: 'asset-boundary'}); callback({cancel: true}); fail('Asset boundary check failed.');}
    });
    ses.setPermissionRequestHandler((_wc, permission, callback) => {networkDenied.push({permission}); callback(false); fail('Permission request attempted.');});
    ses.setPermissionCheckHandler(() => false); ses.setDevicePermissionHandler(() => false);
    ses.on('will-download', event => {event.preventDefault(); fail('Download attempted.');});
    ipcMain.handle('isolated-render:fixture-read', (event, value) => {
      let report;
      try {
        report = reportBySender.get(event.sender.id);
        demand(report, 'Untrusted isolated fixture sender.');
        // A forbidden attempt is globally fatal synchronously, including late IPC
        // from a prior scene or while capture/file-write is in progress.
        if (!READS.has(value?.channel)) return fixtureRead(fixture, value?.channel, value?.payload, report, fail);
        demand(event.sender === active?.webContents && event.senderFrame === active.webContents.mainFrame && event.senderFrame.url === pathToFileURL(config.plan.payload.entry).href, 'Untrusted isolated fixture sender.');
        return fixtureRead(fixture, value?.channel, value?.payload, report, fail);
      } catch (error) {
        // Renderer code can swallow invoke rejections. Make every rejection fatal
        // before rethrowing, and retain a static marker without untrusted payloads.
        fail('ISOLATED_RENDER_IPC_REJECTED');
        const deniedReport = report || [...reportBySender.values()].at(-1) || reports.at(-1);
        if (deniedReport) (deniedReport.deniedIPC ||= []).push({reason: 'ISOLATED_RENDER_IPC_REJECTED'});
        throw error;
      }
    });
    for (const scene of SCENES) {
      demand(!fatal, fatal); await verifyPins(config.plan);
      const report = {scene, mode: 'static-offscreen-not-native', fixture: true, viewportMode: VIEWPORT_MODE, fixtureDPR: 1, sourceHashes: config.plan.payload.sourceFiles,
        reads: [], deniedWrites: [], deniedRequests: networkDenied, consoleErrors: [], initialHook: null};
      let guard, timer;
      try {
        demand(BrowserWindow.getAllWindows().length === 0, 'More than one test window.');
        active = new BrowserWindow(windowOptions(scene, ses));
        reportBySender.set(active.webContents.id, report);
        guard = hiddenGuard(active, fail); report.before = guard.check(); active.webContents.setAudioMuted(true); active.webContents.setFrameRate(10);
        timer = setTimeout(() => fail('Scene deadline exceeded.'), 15000);
        active.webContents.setWindowOpenHandler(() => {fail('New window attempted.'); return {action: 'deny'};});
        for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) active.webContents.on(event, e => {e.preventDefault(); fail(`Forbidden ${event}.`);});
        active.webContents.on('console-message', details => {if (details.level === 'error') report.consoleErrors.push(String(details.message).slice(0, 1000));});
        active.webContents.on('preload-error', () => fail('Isolated preload failed.'));
        active.webContents.on('render-process-gone', () => fail('Test renderer exited unexpectedly.'));
        guard.check();
        await active.loadFile(config.plan.payload.entry);
        const until = Date.now() + 5000;
        while (!(await active.webContents.executeJavaScript(READY))) {demand(Date.now() < until && !fatal, 'Renderer bootstrap timeout.'); await delay(30); guard.check();}
        report.initialHook = await active.webContents.executeJavaScript(INITIAL_HOOKS[scene.hook]);
        await active.webContents.executeJavaScript(SETTLE);
        report.dom = await active.webContents.executeJavaScript(MEASURE); report.after = guard.check();
        demand(!fatal && !report.deniedWrites.length && !networkDenied.length && !report.consoleErrors.length && !report.dom.missingImages.length, 'Scene had forbidden writes/requests or rendering errors.');
        validateSceneDOM(scene, report.dom);
        const image = await captureHidden(active, scene, guard); report.capture = guard.check();
        const bytes = image.toPNG(); demand(bytes.length > 1000, 'Empty offscreen capture.');
        report.capturePixelSize = validatePNGSize(bytes, scene);
        const file = path.join(config.outputDir, `${scene.id}.raw.png`); await fs.writeFile(file, bytes, {flag: 'wx'});
        guard.check(); demand(!fatal && !report.deniedWrites.length && !networkDenied.length && !report.consoleErrors.length, 'Late scene violation during capture/write.');
        report.rawImage = {file, sha256: digest(bytes), size: image.getSize(), sizeUnit: 'NativeImage DIP', pixelSize: report.capturePixelSize}; report.passed = true;
      } catch (error) {report.passed = false; report.error = error.message; fatal ||= error.message;}
      finally {clearTimeout(timer); guard?.dispose(); if (active && !active.isDestroyed()) active.destroy(); active = null; if (fatal) {report.passed = false; report.error ||= fatal;} reports.push(report);}
      if (fatal) break;
    }
    await verifyPins(config.plan);
    if (fatal && reports.length) {reports.at(-1).passed = false; reports.at(-1).error ||= fatal;}
    const result = {mode: 'static-offscreen-not-native', fixture: true, viewportMode: VIEWPORT_MODE, fixtureDPR: 1, planId: config.plan.planId, passed: !fatal && reports.length === SCENES.length && reports.every(r => r.passed),
      error: fatal, reports, unverified: config.plan.payload.unverified};
    await fs.writeFile(path.join(config.outputDir, 'worker-result.json'), `${JSON.stringify(result, null, 2)}\n`, {flag: 'wx'});
    app.exit(result.passed ? 0 : 1);
  } catch (error) {
    if (active && !active.isDestroyed()) active.destroy();
    await fs.writeFile(path.join(config.outputDir, 'worker-failure.json'), JSON.stringify({passed: false, error: error.message, reports}, null, 2), {flag: 'wx'}).catch(() => {});
    app.exit(1);
  }
}
async function labelImages(result, sharp) {
  for (const report of result.reports.filter(r => r.passed)) {
    const size = await sharp(report.rawImage.file).metadata(), width = size.width, height = size.height;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="48"><rect width="100%" height="100%" fill="#0C121C"/><text x="14" y="22" font-size="14" fill="#E7D2A8" font-family="Microsoft YaHei UI,Segoe UI,sans-serif">${LABEL}</text><text x="14" y="40" font-size="10" fill="#ADBFD9" font-family="Segoe UI,sans-serif">${report.scene.id} · ${report.scene.width} × ${report.scene.height} ${VIEWPORT_MODE} · DPR 1 · non-native</text></svg>`;
    const bytes = await sharp({create: {width, height: height + 48, channels: 4, background: '#0C121C'}}).composite([{input: Buffer.from(svg), top: 0, left: 0}, {input: report.rawImage.file, top: 48, left: 0}]).png().toBuffer();
    const file = report.rawImage.file.replace(/\.raw\.png$/, '.png'); await fs.writeFile(file, bytes, {flag: 'wx'}); report.labeledImage = {file, sha256: digest(bytes)};
  }
}
function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]; demand(['--plan', '--execute', '--plan-file', '--approved-plan-id', '--output'].includes(key) && !(key in result), 'Unknown or duplicate isolated-render argument.');
    if (['--plan', '--execute'].includes(key)) result[key] = true;
    else {demand(argv[i + 1] && !argv[i + 1].startsWith('--'), 'Missing isolated-render argument.'); result[key] = argv[++i];}
  }
  demand(!(result['--plan'] && result['--execute']), 'Choose plan or execute.'); return result;
}
async function runCLI(argv = process.argv.slice(2), {spawnImpl = spawn, sharpImpl, makePlanImpl = makePlan} = {}) {
  const args = parseArgs(argv);
  if (!args['--execute']) {
    const plan = await makePlanImpl();
    if (args['--plan-file']) {const filename = path.resolve(args['--plan-file']); demand(inside(EVIDENCE, filename) && path.basename(filename).startsWith('isolated-render-'), 'Plan evidence path outside assigned scope.'); await exactDirectory(path.dirname(filename)); await fs.writeFile(filename, `${JSON.stringify(plan, null, 2)}\n`, {flag: 'wx'});}
    else process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return plan;
  }
  demand(args['--plan-file'] && args['--approved-plan-id'] && args['--output'], 'Execute requires reviewed plan, approved plan ID and explicit fresh output directory.');
  const plan = JSON.parse(await fs.readFile(args['--plan-file'], 'utf8')); validatePlan(plan, args['--approved-plan-id']); await verifyPins(plan);
  const outputDir = await prepareOutputDirectory(args['--output']);
  const sharp = sharpImpl || require(SHARP), fixture = await prepareFixture(plan, sharp), fixtureFile = path.join(outputDir, 'fixture.json'), fixtureBytes = Buffer.from(JSON.stringify(fixture));
  await fs.writeFile(fixtureFile, fixtureBytes, {flag: 'wx'});
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'still-isolated-render-')), profileDir = path.join(tempRoot, 'profile');
  await fs.mkdir(path.join(profileDir, 'session'), {recursive: true});
  const config = {runId: randomUUID(), plan, tempRoot, profileDir, outputDir, fixtureFile, fixtureSha256: digest(fixtureBytes)}, configFile = path.join(tempRoot, 'worker.json');
  await fs.writeFile(configFile, JSON.stringify(config), {flag: 'wx'});
  let child, result, exitCode, childClosed = false;
  const stdout = [], stderr = [];
  try {
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    child = spawnImpl(ELECTRON, [__filename, '--isolated-worker', configFile], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env});
    child.stdout.on('data', bytes => {if (stdout.length < 200) stdout.push(bytes.toString('utf8').slice(0, 2000));}); child.stderr.on('data', bytes => {if (stderr.length < 200) stderr.push(bytes.toString('utf8').slice(0, 2000));});
    exitCode = await new Promise((resolve, reject) => {const timer = setTimeout(() => {child.kill(); reject(new Error('Owned isolated-render worker deadline exceeded.'));}, 100000); child.once('error', error => {clearTimeout(timer); reject(error);}); child.once('close', code => {childClosed = true; clearTimeout(timer); resolve(code);});});
    result = JSON.parse(await fs.readFile(path.join(outputDir, 'worker-result.json'), 'utf8'));
    await labelImages(result, sharp); result.workerExitCode = exitCode;
    demand(exitCode === 0 && result.passed, 'Isolated rendering failed; inspect retained evidence.');
  } finally {
    await cleanupOwnedProfile({tempRoot, child, childClosed, outputDir});
    // Preserve the same bounded diagnostics on timeout/error, after owned close.
    await fs.writeFile(path.join(outputDir, 'worker-stdio.json'), JSON.stringify({stdout, stderr}, null, 2), {flag: 'wx'});
    if (result) {result.profileRemoved = true; await fs.writeFile(path.join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, {flag: 'wx'});}
  }
  return result;
}
// Electron 45's app entry can have require.main !== module. Recognize only this
// exact script entry in its browser process; importing from another app is inert.
const isElectronBrowser = Boolean(process.versions.electron && process.type === 'browser');
const isOwnEntry = Boolean(process.argv[1] && canonical(process.argv[1]) === canonical(__filename));
if (isElectronBrowser && isOwnEntry) {
  try {
    demand(process.argv.length === 4 && process.argv[2] === '--isolated-worker', 'Exact isolated worker arguments required.');
    runWorker(JSON.parse(fsSync.readFileSync(process.argv[3], 'utf8'))).catch(error => {process.stderr.write(`${error.message}\n`); require('electron').app.exit(1);});
  } catch (error) {process.stderr.write(`${error.message}\n`); require('electron').app.exit(1);}
} else if (!process.versions.electron && require.main === module) {
  runCLI().catch(error => {process.stderr.write(`${error.message}\n`); process.exitCode = 1;});
}
module.exports = {SCENES, READS, LABEL, collectAssets, makePlan, validatePlan, verifyPins, selectRecords, middleFixtureTrack, fixtureRead,
  windowOptions, hiddenGuard, captureHidden, requestAllowed, parseArgs, runCLI, INITIAL_HOOKS, prepareOutputDirectory, validateSceneDOM, validatePNGSize, cleanupOwnedProfile};
