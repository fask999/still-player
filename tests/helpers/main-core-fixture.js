'use strict';
// Synthetic bytes, injected process inspection/spawn/exec/fetch only. All
// session, output-scope and child-exit brands come from production classes.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {EventEmitter} = require('node:events');
const {createHash} = require('node:crypto');
const {createBackendManager} = require('../../src/main/backend');
const {createFoobarService} = require('../../src/main/foobar');
const {createFoobarSessionService} = require('../../src/main/foobar-session');
const {createPlaybackCoordinator} = require('../../src/main/playback-coordinator');
const {guardFoobarService} = require('../../src/main/main');
const ENDPOINT = '{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}';
const DEVICE = '0DD9B977-765B-4804-BF2D-B28EBF0C510D:016F9F0C-AFE4-4072-9018-CCEBB576B4CB';
async function mainCoreFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'still-main-core-fixture-')), backendDir = path.join(root, 'backend'), dataDir = path.join(root, 'data');
  let manager, raw, coordinator, finishCleanup;
  const cleanupGate = new Promise(resolve => {finishCleanup = resolve;});
  t.after(async () => {finishCleanup(); await coordinator?.close().catch(() => {}); await manager?.close().catch(() => {}); await raw?.close().catch(() => {});
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('still-main-core-fixture-')) throw new Error('Unsafe fake cleanup');
    await fs.rm(root, {recursive: true, force: true});});
  const files = [];
  for (const relativePath of ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll']) {
    const file = path.join(backendDir, relativePath), bytes = Buffer.from(`SYNTHETIC MAIN FIXTURE ${relativePath}`);
    await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, bytes);
    files.push({relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), mutable: false});
  }
  await fs.mkdir(path.join(backendDir, 'profile/beefweb'), {recursive: true});
  await fs.writeFile(path.join(backendDir, 'backend-manifest.json'), JSON.stringify({schemaVersion: 1, privateUseOnly: true, backendId: 'main-core-fixture',
    sourceDir: 'C:/FixtureOriginalDoNotTouch', executable: 'foobar2000.exe', configuration: {port: 18880}, files}));
  await fs.writeFile(path.join(backendDir, 'profile/beefweb/config.json'), JSON.stringify({port: 18880, allowRemote: false, musicDirs: ['C:/Fixture']}));
  const probePath = path.join(root, 'synthetic-probe.exe'); await fs.writeFile(probePath, 'NOT EXECUTABLE');
  const rows = [{path: 'C:/Fixture/repeat.flac', subsong: 0}, {path: 'C:/Fixture/other.flac', subsong: 0}, {path: 'C:/Fixture/repeat.flac', subsong: 0}];
  const output = {active: {typeId: 'output', deviceId: DEVICE}, types: [{id: 'output', name: 'WASAPI', devices: [{id: DEVICE, name: 'DX1 II [exclusive]'}]}]};
  let running = false, pid = 651, child, playback = 'playing', appleStarts = 0, exitCalls = 0;
  const calls = [], columns = row => [row.path, String(row.subsong), 'Fixture song', 'Fixture artist', 'Fixture album', '180'];
  const player = () => ({info: {name: 'foobar2000', pluginVersion: '0.10'}, playbackState: playback, activeItem: {playlistId: 'real', index: 2, columns: columns(rows[2]), position: 1, duration: 180},
    volume: {type: 'db', min: -100, max: 0, value: -18}, options: [{id: 'playbackOrder', type: 'enum', value: 0, enumNames: ['Default', 'Repeat']}]});
  const fetcher = async (input, init) => {
    const url = new URL(input), route = url.pathname.replace('/api/', ''); calls.push({route, method: init.method}); let value;
    if (route === 'query') value = {player: player(), outputs: output, playQueue: [], playlists: [{id: 'real', title: 'Actual fixture list', itemCount: rows.length}]};
    else if (route === 'player' && init.method === 'GET') value = {player: player()};
    else if (route === 'browser/roots') value = {roots: [{path: 'C:/Fixture'}]};
    else if (route === 'playlists') value = {playlists: [{id: 'real', title: 'Actual fixture list', itemCount: rows.length}]};
    else if (/^playlists\/real\/items\//.test(route)) {const match = /items\/(\d+):(\d+)/.exec(route), offset = Number(match[1]);
      value = {playlistItems: {offset, totalCount: rows.length, items: rows.slice(offset, offset + Number(match[2])).map(row => ({columns: columns(row)}))}};}
    else if (route === 'player/stop') {playback = 'stopped'; value = null;}
    else if (route === 'playqueue') value = {playQueue: []};
    else if (route === 'outputs') value = {outputs: output};
    else throw new Error(`Unexpected fake route ${route}`);
    return {ok: true, text: async () => value === null ? '' : JSON.stringify(value)};
  };
  manager = createBackendManager({backendDir, probePath, platform: 'win32', fetch: fetcher, quietRestartPolicy: 'stopped-owned-exit', ownedExitOutputPolicy: 'dx1-wasapi-in-process-v1',
    pollMs: 1, startupTimeoutMs: 100, shutdownTimeoutMs: 50,
    inspectSystem: async args => ({processes: running ? [{pid, executablePath: path.join(backendDir, 'foobar2000.exe')}] : [],
      listeners: running ? [{pid, address: '127.0.0.1'}] : [], pidCheck: args.pid ? {pid: args.pid, present: running} : null}),
    spawn: () => {running = true; child = new EventEmitter(); child.pid = ++pid; child.exitCode = null; return child;},
    execFile: async (_file, args) => {
      if (args[1] === 'shared') return {stdout: JSON.stringify({endpoint: ENDPOINT, operation: 'Initialize', mode: 'shared', initialized: false, hresult: '0x887C001A', startCalled: false})};
      if (args[0] !== '/exit') throw new Error('Unexpected fake command'); exitCalls++; options.onExit?.(); await Promise.race([options.exitGate, cleanupGate]);
      running = false; child.exitCode = 0; child.emit('exit', 0); return {stdout: ''};
    }});
  raw = createFoobarSessionService({createService: createFoobarService, backend: manager, serviceOptions: {dataDir, foobarDir: backendDir, baseUrl: 'http://127.0.0.1:18880/api/', fetch: fetcher,
    pollIntervalMs: 0, persistOutputSelection: false, timeoutMs: 50, handoffTimeoutMs: 1000, verifyTimeoutMs: 100, verifyPollMs: 1,
    onAudioDispatch: options.onAudioDispatch,
    probeOutputState: async () => ({endpoint: ENDPOINT, operation: 'GetState', mode: 'state', startCalled: false, deviceFound: true, state: 1, active: true, hresult: '0x00000000'}),
    waitForOutputRelease: args => manager.waitForOutputRelease({...args, timeoutMs: 25})}});
  await raw.initializeHandoff(); await raw.connect(await manager.initialize());
  const session = manager.getSession();
  const getInfo = () => {const info = manager.getInfo(), pending = raw.getHandoffStatus().pendingRestore;
    return {...info, verified: info.available && !pending, pendingHandoff: info.pendingHandoff || pending};};
  const guarded = guardFoobarService(raw, getInfo);
  const apple = {cancelPending: async () => {}, stop: async () => {}, releaseOutput: async () => ({released: true}),
    getState: async () => ({available: true, state: appleStarts ? 'playing' : 'stopped'}), play: async () => {appleStarts++;}};
  coordinator = createPlaybackCoordinator({engines: {local: guarded, apple}});
  return {manager, raw, guarded, coordinator, getInfo, session, calls, rows, exitCalls: () => exitCalls, appleStarts: () => appleStarts};
}
module.exports = {mainCoreFixture};
