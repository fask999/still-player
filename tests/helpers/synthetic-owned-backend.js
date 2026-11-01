'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {EventEmitter} = require('node:events');
const {createHash} = require('node:crypto');
const {createBackendManager} = require('../../src/main/backend');
const {writeSyntheticBackendRuntime} = require('./synthetic-backend-runtime');
let nextPid = 30000;
async function createSyntheticOwnedBackend(t, {root: suppliedRoot, port = 19341, running: reused = false} = {}) {
  const root = suppliedRoot || await fs.mkdtemp(path.join(os.tmpdir(), 'still-owned-session-di-'));
  const backendDir = path.join(root, 'backend'), configPath = path.join(backendDir, 'profile/beefweb/config.json');
  await writeSyntheticBackendRuntime(root);
  const files = [];
  for (const relativePath of ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll']) {
    const target = path.join(backendDir, relativePath), bytes = Buffer.from(`SYNTHETIC NOT EXECUTABLE ${relativePath}`);
    await fs.mkdir(path.dirname(target), {recursive: true}); await fs.writeFile(target, bytes);
    files.push({relativePath, mutable: false, sha256: createHash('sha256').update(bytes).digest('hex')});
  }
  await fs.mkdir(path.dirname(configPath), {recursive: true});
  await fs.writeFile(configPath, JSON.stringify({port, allowRemote: false, musicDirs: ['C:\\Music']}));
  await fs.writeFile(path.join(backendDir, 'backend-manifest.json'), JSON.stringify({schemaVersion: 1, privateUseOnly: true,
    backendId: 'synthetic-session-lifecycle', executable: 'foobar2000.exe', configuration: {port}, files}));
  let running = reused, child; const pid = ++nextPid, calls = [];
  const fetcher = async url => {calls.push(String(url)); const route = new URL(url).pathname;
    const value = route.endsWith('/player') ? {player: {info: {name: 'foobar2000', pluginVersion: '0.10'}, playbackState: 'stopped'}} : {roots: [{path: 'C:\\Music'}]};
    return {ok: true, text: async () => JSON.stringify(value)};
  };
  const manager = createBackendManager({backendDir, runtimeRoot: root, platform: 'win32', fetch: fetcher,
    inspectSystem: async () => ({processes: running ? [{pid, executablePath: path.join(backendDir, 'foobar2000.exe')}] : [], listeners: running ? [{pid, address: '127.0.0.1'}] : []}),
    spawn: () => {running = true; child = new EventEmitter(); child.pid = pid; child.exitCode = null; return child;},
    execFile: async () => {running = false; child.exitCode = 0; child.emit('exit', 0); return {stdout: ''};}, pollMs: 1, shutdownTimeoutMs: 50});
  t.after(async () => {await manager.close().catch(() => {}); if (!suppliedRoot) await fs.rm(root, {recursive: true, force: true});});
  const info = await manager.initialize();
  return {root, backendDir, manager, info, session: manager.getSession(), calls, fetch: fetcher};
}
module.exports = {createSyntheticOwnedBackend};
