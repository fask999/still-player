'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');
const {createCueReader} = require('../src/main/cue-import');
const {createCueInspector, CUE_INSPECTOR_LIMITS, CUE_INSPECTOR_NULL_PROVIDER} = require('../src/main/cue-inspector');
const cueVerifier = require('../scripts/verify-cue-inspector');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const NULL = Object.freeze({typeId: 'output', deviceId: `${CUE_INSPECTOR_NULL_PROVIDER}:00000000-0000-0000-0000-000000000000`});
const DAC = Object.freeze({typeId: 'output', deviceId: 'D41D2423-FBB0-4635-B233-7054F79814AB:01234567-89AB-CDEF-0123-456789ABCDEF'});
const cueText = 'FILE "audio.wav" WAVE\n  TRACK 01 AUDIO\n    TITLE "First"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE "Second"\n    INDEX 01 00:01:00\n';

// Complete synthetic runtime modules: none of these bytes are executable, no
// real native constructor/fetch/brand fallback is reachable from this fixture.
async function fixture(t, options = {}) {
  const {root, parent} = createCanonicalTemp('still-cue-inspector-');
  const appRoot = path.join(root, 'app'), dataDir = path.join(root, options.longDataPath ? 'd'.repeat(180) : 'data'), music = path.join(root, 'music');
  await fs.mkdir(appRoot); await fs.mkdir(music);
  const cue = path.join(music, 'album.cue'), audio = path.join(music, 'audio.wav');
  await fs.writeFile(cue, cueText); await fs.writeFile(audio, 'SYNTHETIC AUDIO; NEVER PLAY');
  const write = async (relative, bytes) => {const target = path.join(appRoot, relative); await fs.mkdir(path.dirname(target), {recursive: true}); await fs.writeFile(target, bytes);};
  const core = new Map([['foobar2000.exe', Buffer.from('SYNTHETIC CORE; NOT EXECUTABLE')], ['portable_mode_enabled', Buffer.alloc(0)],
    ['components/foo_ui_std.dll', Buffer.from('SYNTHETIC UI; NOT EXECUTABLE')], ['components/foo_input_std.dll', Buffer.from('SYNTHETIC INPUT; NOT EXECUTABLE')]]);
  const component = Buffer.from('SYNTHETIC BEEFWEB; NOT EXECUTABLE');
  const installer = Buffer.from('SYNTHETIC INSTALLER; NEVER EXECUTE'), extractor = Buffer.from('SYNTHETIC EXTRACTOR; NEVER EXECUTE');
  const manifest = {schemaVersion: 2, deployment: 'extract-original-installer', coreFiles: [...core].map(([relativePath, bytes]) => ({relativePath, bytes: bytes.length, sha256: hash(bytes)})),
    installer: {relativePath: 'bootstrap/installer.exe', bytes: installer.length, sha256: hash(installer)},
    extractor: {files: [{relativePath: 'bootstrap/extractor.exe', bytes: extractor.length, sha256: hash(extractor)}]},
    components: [{sourcePath: 'bootstrap/beefweb.dll', targetPath: 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll', bytes: component.length, sha256: hash(component)}]};
  await write(manifest.installer.relativePath, installer); await write(manifest.extractor.files[0].relativePath, extractor); await write(manifest.components[0].sourcePath, component);
  const launcher = Buffer.from('SYNTHETIC JOB; NEVER EXECUTE'), policy = Buffer.from('{}');
  await write('native/backend-job/StillBackendLauncher.exe', launcher); await write('src/main/backend-output-policy.json', policy);
  const leaseFiles = [['StillCueReadLease.exe', Buffer.from('SYNTHETIC HOLDER; NEVER EXECUTE')], ['NOTICE.txt', Buffer.from('Synthetic holder notice')]];
  const leaseManifest = Buffer.from(JSON.stringify({schemaVersion: 1, kind: 'still-cue-read-lease', architecture: 'x64',
    files: leaseFiles.map(([name, bytes]) => ({path: name, bytes: bytes.length, sha256: hash(bytes)}))}));
  await write('native/cue-read-lease/bin/runtime-manifest.json', leaseManifest);
  for (const [name, bytes] of leaseFiles) await write(`native/cue-read-lease/bin/${name}`, bytes);
  await write('src/main/runtime-assets.json', JSON.stringify({schemaVersion: 1, assets: {
    backendLauncher: {relativePath: 'native/backend-job/StillBackendLauncher.exe', sha256: hash(launcher)},
    backendOutputPolicy: {relativePath: 'src/main/backend-output-policy.json', sha256: hash(policy)},
    cueReadLeaseManifest: {relativePath: 'native/cue-read-lease/bin/runtime-manifest.json', sha256: hash(leaseManifest)}}}));
  await write('manifests/public-backend.json', JSON.stringify(manifest));
  await write('package.json', '{"type":"commonjs"}');
  const publicFiles = [...manifest.coreFiles.map(row => ({...row, mutable: false})), ...manifest.components.map(row =>
    ({relativePath: row.targetPath, bytes: row.bytes, sha256: row.sha256, mutable: false}))];
  const calls = [], events = [], managers = [], sessions = new WeakSet(), exits = new WeakSet(), trees = new WeakSet(), leases = new WeakMap(), leaseObjects = [], progress = [];
  let scope = null, backendCreations = 0, active = 0, maxActive = 0, initialized = 0, pageReads = 0;
  let selected = {...DAC}, added = false, lists = [{id: 'default', title: 'Default', itemCount: 0}], ownedSession, running = false, loseLease;
  const main = Object.freeze({source: 'local', playlist: Object.freeze(['unrelated.flac']), queue: Object.freeze(['unrelated-queued.flac']), position: 30});
  const bootstrapApi = {
    validateBootstrapManifest: value => value,
    createBackendBootstrap(input) {
      events.push('bootstrap-created'); scope = input;
      assert.equal(input.appRoot, appRoot);
      let prepared = false;
      return {
        initialize: async () => {events.push('bootstrap-initialize'); return {automatic: true, prepared: Boolean(options.existingProfile)};},
        begin: async () => {
          events.push('extractor-entered'); await options.begin?.(input);
          for (const [relative, bytes] of core) {
            const target = path.join(input.backendDir, relative); await fs.mkdir(path.dirname(target), {recursive: true}); await fs.writeFile(target, bytes);
          }
          events.push('extractor-closed');
        },
        complete: async ({musicDirs}) => {
          assert.deepEqual(musicDirs, [music]);
          for (const row of manifest.components) {
            const target = path.join(input.backendDir, row.targetPath); await fs.mkdir(path.dirname(target), {recursive: true}); await fs.writeFile(target, component);
          }
          const config = path.join(input.backendDir, 'profile/beefweb/config.json');
          await fs.mkdir(path.dirname(config), {recursive: true}); await fs.writeFile(config, JSON.stringify({musicDirs}));
          await fs.writeFile(path.join(input.backendDir, 'backend-manifest.json'), '{}');
          if (options.unknownProfile) await fs.writeFile(path.join(input.backendDir, 'profile/config.sqlite'), 'UNANCHORED SAVED STATE');
          prepared = true;
        },
        getStatus: () => ({prepared}), getExpectedFiles: () => publicFiles,
        markReady: session => {assert.ok(sessions.has(session)); events.push('bootstrap-ready');},
        cancel: () => {events.push('extractor-cancel'); if (options.cancelThrow) throw new Error('SYNTHETIC CANCEL OBSERVER FAILURE');},
        close: async () => {events.push('bootstrap-close-entered'); await options.bootstrapClose?.(); events.push('bootstrap-closed');}
      };
    }
  };
  const backendApi = {
    createBackendManager(input) {
      backendCreations++; events.push('manager-created');
      selected = {...DAC}; added = false; lists = [{id: 'default', title: 'Default', itemCount: 0}];
      assert.equal(input.backendDir, scope.backendDir); assert.equal(input.startStopped, false);
      assert.equal(input.requireOwnedSession, true); assert.equal(input.requirePublicProvenance, true); assert.deepEqual(input.publicFiles, publicFiles);
      assert.equal(Object.hasOwn(input, 'runtimeRoot'), false);
      assert.equal(Object.hasOwn(input, 'fetch'), false); assert.equal(Object.hasOwn(input, 'spawn'), false);
      const token = Object.freeze({sessionId: randomUUID(), backendId: randomUUID(), pid: 41001,
        foobarDir: input.backendDir, baseUrl: 'http://127.0.0.1:53141/api/', executable: path.join(input.backendDir, 'foobar2000.exe'),
        profilePath: path.join(input.backendDir, 'profile/beefweb/config.json')});
      ownedSession = token; if (!options.unbrandedSession) sessions.add(token);
      let started = false, exited = false;
      const info = () => ({available: started && !exited, owned: started && !exited, nativeReadySeen: started, pid: token.pid,
        backendId: token.backendId, baseUrl: token.baseUrl, musicDirs: [music], startupCreated: started});
      const manager = {
        initialize: async ({start}) => {
          initialized++; events.push(start ? 'owned-hide-start' : 'port-owner-reverified');
          if (start && (options.noStartupWitness || options.closedUnverifiedStartupTree)) throw Object.assign(new Error('SYNTHETIC STARTUP BEFORE HTTP'), {code: 'ERR_CUE_INSPECTOR_SESSION'});
          if (start) {started = true; running = true; active++; maxActive = Math.max(maxActive, active);}
          return options.wrongOwner ? {...info(), owned: false} : info();
        },
        getInfo: info, getSession: () => started && !exited ? token : null,
        hasClosedUnverifiedStartupTree({foobarDir}) {
          assert.equal(foobarDir, input.backendDir);
          return options.closedUnverifiedStartupTree === true && exited;
        },
        isOwnedTreeExited: session => session === token && exited && !options.missingTree,
        close: async () => {
          events.push('job-close-entered'); await options.backendClose?.(scope);
          if (options.noStartupWitness) return {...info(), exitEvidence: null};
          if (options.closedUnverifiedStartupTree) {exited = true; events.push('startup-physical-tree-empty'); return {...info(), exitEvidence: null};}
          if (!exited && started) active--;
          exited = true; running = false; events.push('actual-child-exit');
          const proof = Object.freeze({sessionId: token.sessionId});
          if (!options.missingChild) exits.add(proof);
          if (!options.missingTree) {trees.add(proof); events.push('actual-tree-empty');}
          return {...info(), exitEvidence: proof};
        }
      };
      managers.push(manager); return manager;
    },
    isVerifiedBackendSession: (token, expected) => sessions.has(token) && token.foobarDir === expected.foobarDir && token.baseUrl === expected.baseUrl,
    isVerifiedBackendChildExit: (proof, token) => sessions.has(token) && token === ownedSession && exits.has(proof),
    isVerifiedBackendTreeExit: (proof, token) => sessions.has(token) && token === ownedSession && exits.has(proof) && trees.has(proof)
  };
  const key = `still-cue-fixture-${randomUUID()}`;
  const leaseApi = {
    createCueReadLease: async input => {
      if (options.acquisitionCloseMissing) throw Object.assign(new Error('SYNTHETIC ACQUISITION CLOSE UNKNOWN'), {
        code: 'ERR_CUE_READ_LEASE_PROTOCOL', cleanupPending: true, retainedController: Object.freeze({close: async () => {throw new Error('SYNTHETIC STILL LIVE');}})
      });
      assert.equal(input.request.path, cue); events.push('read-lease-acquired'); let leaseClosed = false, lost = false;
      const lose = () => {if (lost) return; lost = true; events.push('read-lease-invalidated'); input.onLost(new Error('SYNTHETIC HOLDER LOST'));};
      loseLease = lose; input.signal.addEventListener('abort', lose, {once: true});
      const lease = {
        check: async () => {assert.equal(leaseClosed, false); if (options.leaseLost || lost) throw Object.assign(new Error('SYNTHETIC READ LEASE LOST'), {code: 'ERR_CUE_INSPECTOR_LEASE_LOST'});},
        close: async () => {
          if (options.leaseCloseFailure) throw new Error('SYNTHETIC HOLDER CLOSE UNVERIFIED');
          assert.equal(running, false, 'Read leases must outlive the exact metadata Job'); leaseClosed = true;
          input.signal.removeEventListener('abort', lose); events.push('read-lease-closed');
        }
      };
      if (!options.unbrandedLease) leases.set(lease, () => !lost && !leaseClosed); leaseObjects.push(lease); return lease;
    },
    isVerifiedCueReadLease: (lease, {request}) => Boolean(leases.get(lease)?.()) && request.path === cue
  };
  globalThis[Symbol.for(key)] = {bootstrapApi, backendApi, leaseApi};
  await write('src/main/backend-bootstrap.js', `module.exports = globalThis[Symbol.for(${JSON.stringify(key)})].bootstrapApi;`);
  await write('src/main/backend.js', `module.exports = globalThis[Symbol.for(${JSON.stringify(key)})].backendApi;`);
  await write('src/main/cue-read-lease.js', `module.exports = globalThis[Symbol.for(${JSON.stringify(key)})].leaseApi;`);
  const items = () => options.items || [73, 91].map((subsong, i) => ({columns: [cue, String(subsong), i ? 'Second backend title' : 'First backend title', 'Backend artist', 'Backend album', '1', 'PCM', '44100', '16', '2', 'Backend album artist', String(i + 1), '1']}));
  t.mock.method(globalThis, 'fetch', async (url, input) => {
    assert.ok(running, 'No RPC can precede owned startup');
    const address = new URL(url); assert.equal(address.origin, ownedSession.baseUrl.slice(0, -5));
    const route = address.pathname.slice('/api/'.length), body = input.body === undefined ? undefined : JSON.parse(input.body);
    const call = {route, search: address.search, method: input.method, body}; calls.push(call);
    await options.beforeRpc?.(call, {scope, cue, audio, appRoot, signal: input.signal});
    const json = value => new Response(JSON.stringify(value), {status: 200, headers: {'Content-Type': 'application/json'}});
    if (options.response) {const response = await options.response(call); if (response) return response;}
    if (route === 'browser/roots') return json({roots: options.roots || [{path: music}]});
    if (route === 'query') return json({player: {info: {name: 'foobar2000', pluginVersion: '0.10'}, playbackState: options.state || 'stopped'},
      playQueue: options.queue || [], playlists: lists, outputs: {active: selected, types: [{id: 'output', devices: options.devices || [{id: NULL.deviceId, name: 'Null'}, {id: DAC.deviceId, name: 'Physical DAC'}]}]}});
    if (route === 'outputs/active') {assert.deepEqual(body, NULL); if (!options.badNullReadback) selected = {...body}; return new Response(null, {status: 204});}
    if (route === 'playlists/add') {
      assert.equal(body.setCurrent, false); lists = [...lists, {id: 'shadow-id', title: body.title, itemCount: 0}]; return json(lists.at(-1));
    }
    if (route === 'playlists') return json({playlists: lists});
    if (route === 'playlists/shadow-id/items/add') {
      assert.deepEqual(body, {items: [cue], async: true, replace: false, play: false});
      added = true; lists.at(-1).itemCount = 2; return new Response(null, {status: 202});
    }
    if (route.startsWith('playlists/shadow-id/items/0:')) {
      assert.ok(added); pageReads++;
      const value = options.page ? options.page(pageReads, items()) : {offset: 0, totalCount: items().length, items: items()};
      return json({playlistItems: value});
    }
    assert.fail(`Unexpected RPC: ${route}`);
  });
  const inspector = createCueInspector({runtimeRoot: appRoot, dataDir, onProgress: value => {
    progress.push(value); events.push(`progress:${value.state}`); return options.onProgress?.(value);
  }});
  const request = (await createCueReader()(cue, {authorizationRoot: music})).request;
  t.after(async () => {
    await inspector.close().catch(() => {});
    assert.equal(active, 0, 'Synthetic children must have physically ended before fixture cleanup');
    for (const lease of leaseObjects) await lease.close().catch(() => {});
    delete globalThis[Symbol.for(key)];
    for (const name of Object.keys(require.cache)) if (name.startsWith(`${appRoot}${path.sep}`)) delete require.cache[name];
    assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('still-cue-inspector-'));
    await fs.rm(root, {recursive: true, force: true});
  });
  return {root, appRoot, dataDir, music, cue, audio, inspector, request, calls, events, progress, main, write, manifest,
    loseLease: () => loseLease(), get scope() {return scope;}, get maxActive() {return maxActive;}, get backendCreations() {return backendCreations;}, get initialized() {return initialized;}};
}

test('construction and disabled smoke mode perform no I/O', async t => {
  let touched = 0;
  for (const name of ['lstat', 'stat', 'readFile', 'mkdir', 'readdir', 'opendir', 'realpath', 'open']) t.mock.method(fs, name, async () => {touched++; throw new Error('Unexpected I/O');});
  const inspector = createCueInspector({runtimeRoot: path.resolve('not-created-runtime'), dataDir: path.resolve('not-created-data'), enabled: false});
  await assert.rejects(inspector.inspect({}), {code: 'ERR_CUE_INSPECTOR_DISABLED'});
  await inspector.close(); assert.equal(touched, 0);
});

test('discovers exact native subsongs and metadata through Null-only RPC, then proves tree exit and removes only its own workspace', async t => {
  const f = await fixture(t), beforeCue = await fs.readFile(f.cue), beforeAudio = await fs.readFile(f.audio), main = JSON.stringify(f.main);
  const result = await f.inspector.inspect(f.request);
  assert.equal(result.verified, true); assert.deepEqual(result.items.map(row => row.subsong), [73, 91]);
  assert.equal(result.items[0].title, 'First backend title'); assert.equal(result.items[1].artist, 'Backend artist');
  assert.ok(result.items.every(row => row.path === f.cue && row.supported === true && row.sampleRate === 44100));
  assert.deepEqual(await fs.readFile(f.cue), beforeCue); assert.deepEqual(await fs.readFile(f.audio), beforeAudio); assert.equal(JSON.stringify(f.main), main);
  assert.equal(f.maxActive, 1); assert.ok(f.initialized >= 4);
  assert.deepEqual(f.calls.filter(row => row.method === 'POST').map(row => row.route), ['outputs/active', 'playlists/add', 'playlists/shadow-id/items/add']);
  assert.ok(f.events.indexOf('actual-tree-empty') < f.events.indexOf('progress:verified'));
  assert.ok(f.events.indexOf('actual-tree-empty') < f.events.indexOf('read-lease-closed'));
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'cue-indexer')), []);
});

test('serial requests use independent fresh profiles and can keep importing new folders after success', async t => {
  const f = await fixture(t), requests = Array.from({length: 5}, () => f.inspector.inspect(f.request));
  await Promise.all(requests); assert.equal(f.maxActive, 1); assert.equal(f.backendCreations, 5);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'cue-indexer')), []);
});

for (const [name, change] of [
  ['hash', value => ({...value, contentHash: 'a'.repeat(64)})],
  ['encoding', value => ({...value, encoding: 'gb18030'})],
  ['count', value => ({...value, trackCount: 3})],
  ['references', value => ({...value, references: [value.path]})],
  ['duplicate references', value => ({...value, references: [...value.references, ...value.references]})]
]) test(`rejects changed preflight ${name} before creating an owned process`, async t => {
  const f = await fixture(t); await assert.rejects(f.inspector.inspect(change(f.request)), {code: 'ERR_CUE_INSPECTOR_REQUEST'}); assert.equal(f.backendCreations, 0);
});

for (const [name, options, code] of [
  ['saved profile', {unknownProfile: true}, 'ERR_CUE_INSPECTOR_PROFILE'],
  ['prepared reused profile', {existingProfile: true}, 'ERR_CUE_INSPECTOR_PROFILE'],
  ['playing session', {state: 'playing'}, 'ERR_CUE_INSPECTOR_NOT_QUIET'],
  ['nonempty queue', {queue: [{playlistId: 'other', itemIndex: 0}]}, 'ERR_CUE_INSPECTOR_NOT_QUIET'],
  ['foreign roots', {roots: [{path: path.resolve('foreign-music')}]}, 'ERR_CUE_INSPECTOR_SESSION'],
  ['missing Null', {devices: [{id: DAC.deviceId, name: 'Null'}]}, 'ERR_CUE_INSPECTOR_NULL_OUTPUT'],
  ['ambiguous Null', {devices: [{id: NULL.deviceId}, {id: `${CUE_INSPECTOR_NULL_PROVIDER}:01234567-89AB-CDEF-0123-456789ABCDEF`}]}, 'ERR_CUE_INSPECTOR_NULL_OUTPUT'],
  ['wrong Null readback', {badNullReadback: true}, 'ERR_CUE_INSPECTOR_NULL_OUTPUT']
]) test(`fails closed on ${name} without importing any CUE`, async t => {
  const f = await fixture(t, options); await assert.rejects(f.inspector.inspect(f.request), {code});
  assert.equal(f.calls.some(row => row.route.endsWith('/items/add')), false);
  assert.equal(f.progress.some(row => row.state === 'verified'), false);
});

for (const [name, change] of [
  ['outside path', (items, f) => {items[0].columns[0] = path.join(f.root, 'foreign.wav');}],
  ['duplicate pair', items => {items[1].columns[0] = items[0].columns[0]; items[1].columns[1] = items[0].columns[1];}],
  ['guessed or missing subsong', items => {items[0].columns[1] = '?';}],
  ['unsupported metadata', items => {items[0].columns[5] = '?';}],
  ['extra track', items => {items.push({...items[0]});}]
]) test(`rejects discovered ${name} and waits for the exact child/tree exit`, async t => {
  let f;
  f = await fixture(t, {page: (_read, items) => {change(items, f); return {offset: 0, totalCount: items.length, items};}});
  await assert.rejects(f.inspector.inspect(f.request));
  assert.ok(f.events.includes('actual-child-exit')); assert.ok(f.events.includes('actual-tree-empty')); assert.equal(f.progress.some(row => row.state === 'verified'), false);
});

test('accepts an authorized referenced audio path with an actually reported subsong', async t => {
  let audio;
  const f = await fixture(t, {page: (_read, items) => {items[1].columns[0] = audio; return {offset: 0, totalCount: items.length, items};}}); audio = f.audio;
  const result = await f.inspector.inspect(f.request); assert.equal(result.items[1].path, f.audio); assert.equal(result.items[1].subsong, 91);
});

test('waits through an asynchronous short expansion instead of inventing missing subsongs', async t => {
  const f = await fixture(t, {page: (read, items) => read === 1 ? {offset: 0, totalCount: 0, items: []} : {offset: 0, totalCount: items.length, items}});
  assert.equal((await f.inspector.inspect(f.request)).items.length, 2);
});

for (const target of ['cue', 'audio']) test(`rejects a ${target} identity change while native metadata is being read`, async t => {
  let changed = false;
  const f = await fixture(t, {beforeRpc: async (call, context) => {
    if (!changed && call.route.startsWith('playlists/shadow-id/items/0:')) {changed = true; await fs.appendFile(context[target], 'CHANGED');}
  }});
  await assert.rejects(f.inspector.inspect(f.request)); assert.equal(f.progress.some(row => row.state === 'verified'), false); assert.ok(f.events.includes('actual-tree-empty'));
});

test('rechecks authorized file identities after the actual process has exited', async t => {
  const f = await fixture(t, {backendClose: async () => {await fs.appendFile(f.audio, 'CHANGED DURING EXIT');}});
  await assert.rejects(f.inspector.inspect(f.request)); assert.equal(f.progress.some(row => row.state === 'verified'), false);
});

test('rejects a runtime source mutation during discovery and retains the workspace for diagnosis', async t => {
  let changed = false;
  const f = await fixture(t, {beforeRpc: async (call, context) => {
    if (!changed && call.route.startsWith('playlists/shadow-id/items/0:')) {changed = true; await fs.appendFile(path.join(context.appRoot, 'src/main/backend-output-policy.json'), ' ');}
  }});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_RUNTIME'});
  assert.ok(f.events.includes('actual-tree-empty')); assert.equal((await fs.readdir(path.join(f.dataDir, 'cue-indexer'))).length, 1);
});

test('rejects immutable isolated core mutation after discovery', async t => {
  let changed = false;
  const f = await fixture(t, {beforeRpc: async (call, context) => {
    if (!changed && call.route.startsWith('playlists/shadow-id/items/0:')) {changed = true; await fs.appendFile(path.join(context.scope.backendDir, 'foobar2000.exe'), 'CHANGED');}
  }});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_RUNTIME'}); assert.equal(f.progress.some(row => row.state === 'verified'), false);
});

for (const option of ['missingChild', 'missingTree', 'unbrandedSession', 'noStartupWitness']) test(`${option} cannot be replaced by a successful close result or a missing PID`, async t => {
  const f = await fixture(t, {[option]: true});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_EXIT_UNVERIFIED'});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_EXIT_UNVERIFIED'});
  await assert.rejects(f.inspector.close(), {code: 'ERR_CUE_INSPECTOR_EXIT_UNVERIFIED'});
  assert.equal(f.backendCreations, 1); assert.equal((await fs.readdir(path.join(f.dataDir, 'cue-indexer'))).length, 1);
  assert.equal(f.events.includes('read-lease-closed'), false, 'An unproven Job exit must retain the read-lease holder');
  assert.equal(f.progress.some(row => row.state === 'verified'), false);
});

test('a physically closed unverified startup may release its own isolated resources without verifying discovery', async t => {
  const f = await fixture(t, {closedUnverifiedStartupTree: true});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_SESSION'});
  await f.inspector.close();
  assert.ok(f.events.indexOf('startup-physical-tree-empty') < f.events.indexOf('read-lease-closed'));
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'cue-indexer')), []);
  assert.equal(f.progress.some(row => row.state === 'exit-verified' || row.state === 'verified'), false);
});
test('a deeply nested component path refuses CUE startup before preparing a workspace or acquiring the lease', {skip: process.platform !== 'win32'}, async t => {
  const f = await fixture(t, {longDataPath: true});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_NATIVE_PATH_LENGTH'});
  await f.inspector.close();
  assert.equal(f.backendCreations, 0);
  assert.equal(f.events.includes('read-lease-acquired'), false);
  await assert.rejects(fs.lstat(f.dataDir), {code: 'ENOENT'});
});

test('close waits for both the extractor lifetime and its close fence before returning', async t => {
  const entered = deferred(), extractor = deferred(), closeGate = deferred();
  const f = await fixture(t, {begin: async () => {entered.resolve(); await extractor.promise;}, bootstrapClose: () => closeGate.promise});
  const work = f.inspector.inspect(f.request); const rejected = assert.rejects(work, {code: 'ERR_CUE_INSPECTOR_CANCELLED'});
  await entered.promise; let complete = false;
  const closing = f.inspector.close().then(() => {complete = true;});
  await tick(); assert.equal(complete, false); assert.ok(f.events.includes('extractor-cancel'));
  extractor.resolve(); await tick(); assert.equal(complete, false);
  closeGate.resolve(); await closing; await rejected; assert.equal(f.backendCreations, 0);
});

test('close prevents late native metadata delivery and awaits the actual Job tree fence', async t => {
  const entered = deferred(), rpc = deferred(), exitEntered = deferred(), exitGate = deferred();
  const f = await fixture(t, {
    beforeRpc: async call => {if (call.route.startsWith('playlists/shadow-id/items/0:')) {entered.resolve(); await rpc.promise;}},
    backendClose: async () => {exitEntered.resolve(); await exitGate.promise;}
  });
  const work = f.inspector.inspect(f.request), rejected = assert.rejects(work, {code: 'ERR_CUE_INSPECTOR_CANCELLED'});
  await entered.promise; let complete = false;
  const closing = f.inspector.close().then(() => {complete = true;});
  await tick(); assert.equal(complete, false);
  rpc.resolve(); await exitEntered.promise; assert.equal(complete, false);
  exitGate.resolve(); await closing; await rejected;
  assert.equal(f.progress.some(row => row.state === 'verified'), false); assert.ok(f.events.includes('actual-tree-empty'));
});

test('a caller AbortSignal cancels one inspection and subsequent requests can still succeed', async t => {
  const entered = deferred(), gate = deferred(); let first = true;
  const f = await fixture(t, {begin: async () => {if (first) {first = false; entered.resolve(); await gate.promise;}}});
  const controller = new AbortController(), work = f.inspector.inspect(f.request, {signal: controller.signal});
  const rejected = assert.rejects(work, {code: 'ERR_CUE_INSPECTOR_CANCELLED'});
  await entered.promise; controller.abort(); gate.resolve(); await rejected;
  assert.equal((await f.inspector.inspect(f.request)).verified, true);
});

test('deadline cancels setup, then waits for extractor completion instead of claiming a timeout is exit evidence', async t => {
  const timer = globalThis.setTimeout;
  let fireDeadline;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms === CUE_INSPECTOR_LIMITS.deadlineMs) {fireDeadline = fn; return timer(() => {}, ms);}
    return timer(fn, ms, ...args);
  });
  const entered = deferred(), gate = deferred();
  const f = await fixture(t, {begin: async () => {entered.resolve(); await gate.promise;}, bootstrapClose: async () => {}});
  const work = f.inspector.inspect(f.request), rejected = assert.rejects(work, {code: 'ERR_CUE_INSPECTOR_DEADLINE'});
  await entered.promise; fireDeadline(); assert.ok(f.events.includes('extractor-cancel'));
  assert.equal(f.events.includes('extractor-closed'), false); gate.resolve(); await rejected; assert.equal(f.backendCreations, 0);
});

test('the pending queue has a fixed bound', async t => {
  const entered = deferred(), gate = deferred();
  const f = await fixture(t, {begin: async () => {entered.resolve(); await gate.promise;}});
  const works = Array.from({length: CUE_INSPECTOR_LIMITS.pending}, () => f.inspector.inspect(f.request));
  const rejected = works.map(work => assert.rejects(work, {code: 'ERR_CUE_INSPECTOR_CANCELLED'}));
  await entered.promise;
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_BUSY'});
  const closing = f.inspector.close(); gate.resolve(); await closing; await Promise.all(rejected); assert.equal(f.backendCreations, 0);
});

test('unknown retained directories exhaust the bounded cache without being removed', async t => {
  const f = await fixture(t), cache = path.join(f.dataDir, 'cue-indexer'); await fs.mkdir(cache, {recursive: true});
  for (let i = 0; i < CUE_INSPECTOR_LIMITS.retainedRuns; i++) {await fs.mkdir(path.join(cache, `unknown-${i}`)); await fs.writeFile(path.join(cache, `unknown-${i}`, 'preserve.txt'), 'UNKNOWN');}
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_QUOTA'});
  assert.equal(f.backendCreations, 0); assert.equal((await fs.readdir(cache)).length, CUE_INSPECTOR_LIMITS.retainedRuns);
  assert.equal(await fs.readFile(path.join(cache, 'unknown-0/preserve.txt'), 'utf8'), 'UNKNOWN');
});

test('a linked file in an otherwise owned workspace prevents cleanup', async t => {
  const f = await fixture(t, {backendClose: async scope => {await fs.link(f.audio, path.join(scope.dataDir, 'foreign-hardlink.wav'));}});
  await assert.rejects(f.inspector.inspect(f.request));
  assert.equal(await fs.readFile(f.audio, 'utf8'), 'SYNTHETIC AUDIO; NEVER PLAY');
  assert.equal((await fs.readdir(path.join(f.dataDir, 'cue-indexer'))).length, 1);
});

test('response size is capped before a declared oversized response is consumed', async t => {
  const f = await fixture(t, {response: call => call.route === 'query' ? new Response('{}', {headers: {'Content-Length': String(CUE_INSPECTOR_LIMITS.responseBytes + 1)}}) : null});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_RESPONSE_LIMIT'});
  assert.equal(f.calls.some(row => row.method === 'POST'), false); assert.ok(f.events.includes('actual-tree-empty'));
});

test('response size is capped while streaming even without a Content-Length', async t => {
  const f = await fixture(t, {response: call => call.route === 'query' ? new Response('x'.repeat(CUE_INSPECTOR_LIMITS.responseBytes + 1)) : null});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_RESPONSE_LIMIT'}); assert.ok(f.events.includes('actual-tree-empty'));
});

test('a missing native read-lease module fails before creating an extractor or Job', async t => {
  const f = await fixture(t); await fs.unlink(path.join(f.appRoot, 'src/main/cue-read-lease.js'));
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_LEASE_UNAVAILABLE'});
  assert.equal(f.events.includes('extractor-entered'), false); assert.equal(f.backendCreations, 0);
});

test('an unbranded read lease cannot authorize native ingestion', async t => {
  const f = await fixture(t, {unbrandedLease: true});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_LEASE_UNAVAILABLE'});
  assert.equal(f.backendCreations, 0); assert.equal(f.events.includes('extractor-entered'), false);
});

test('a lost read lease prevents any owned metadata Job from starting', async t => {
  const f = await fixture(t, {leaseLost: true});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_LEASE_LOST'}); assert.equal(f.backendCreations, 0);
});

test('an unproven lease-holder close prevents verified delivery and blocks further runs', async t => {
  const f = await fixture(t, {leaseCloseFailure: true});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_LEASE_EXIT_UNVERIFIED'});
  await assert.rejects(f.inspector.close(), {code: 'ERR_CUE_INSPECTOR_LEASE_EXIT_UNVERIFIED'});
  assert.ok(f.events.includes('actual-tree-empty')); assert.equal(f.progress.some(row => row.state === 'verified'), false);
});

test('a pre-READY acquisition failure with pending holder cleanup retains the owner and cannot report drained close', async t => {
  const f = await fixture(t, {acquisitionCloseMissing: true});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_LEASE_EXIT_UNVERIFIED'});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_LEASE_EXIT_UNVERIFIED'});
  await assert.rejects(f.inspector.close(), {code: 'ERR_CUE_INSPECTOR_LEASE_EXIT_UNVERIFIED'});
  assert.equal(f.events.includes('extractor-entered'), false); assert.equal(f.backendCreations, 0);
});

test('an extractor close failure retains its owner and read lease instead of reporting drained shutdown', async t => {
  const f = await fixture(t, {bootstrapClose: async () => {throw new Error('SYNTHETIC EXTRACTOR CLOSE UNKNOWN');}});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_SETUP_EXIT_UNVERIFIED'});
  await assert.rejects(f.inspector.close(), {code: 'ERR_CUE_INSPECTOR_SETUP_EXIT_UNVERIFIED'});
  assert.equal(f.events.includes('read-lease-closed'), false); assert.ok(f.events.includes('actual-tree-empty'));
});

test('replacing an owned workspace never grants deletion rights over its replacement', async t => {
  let replacement;
  const f = await fixture(t, {backendClose: async scope => {
    const runDir = path.dirname(scope.dataDir); replacement = path.join(runDir, 'preserve.txt');
    await fs.rename(runDir, `${runDir}-original`); await fs.mkdir(runDir); await fs.writeFile(replacement, 'FOREIGN REPLACEMENT');
  }});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_WORKSPACE'});
  assert.equal(await fs.readFile(replacement, 'utf8'), 'FOREIGN REPLACEMENT');
  assert.equal((await fs.readdir(path.join(f.dataDir, 'cue-indexer'))).length, 2);
});

test('a preexisting cache junction is never followed, modified or deleted', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'), cache = path.join(f.dataDir, 'cue-indexer');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'preserve.txt'), 'OUTSIDE'); await fs.mkdir(f.dataDir);
  await fs.symlink(outside, cache, 'junction');
  await assert.rejects(f.inspector.inspect(f.request));
  assert.equal(await fs.readFile(path.join(outside, 'preserve.txt'), 'utf8'), 'OUTSIDE');
  assert.ok((await fs.lstat(cache)).isSymbolicLink()); assert.equal(f.backendCreations, 0);
});

test('the original request object cannot redirect a queued discovery after admission', async t => {
  const entered = deferred(), gate = deferred(); let first = true;
  const f = await fixture(t, {begin: async () => {if (first) {first = false; entered.resolve(); await gate.promise;}}});
  const a = f.inspector.inspect(f.request); await entered.promise;
  const mutable = {...f.request, references: [...f.request.references]}, b = f.inspector.inspect(mutable);
  mutable.path = path.join(f.root, 'foreign.cue'); mutable.references[0] = path.join(f.root, 'foreign.wav'); mutable.contentHash = 'b'.repeat(64);
  gate.resolve(); await a; const result = await b;
  assert.equal(result.items[0].path, f.cue); assert.equal(f.maxActive, 1);
  assert.ok(f.calls.filter(row => row.route.endsWith('/items/add')).every(row => row.body.items[0] === f.cue));
});

test('the read lease remains held until the delayed metadata tree has actually exited on cancellation', async t => {
  const entered = deferred(), rpcGate = deferred(), exitEntered = deferred(), exitGate = deferred();
  const f = await fixture(t, {beforeRpc: async call => {
    if (call.route.startsWith('playlists/shadow-id/items/0:')) {entered.resolve(); await rpcGate.promise;}
  }, backendClose: async () => {exitEntered.resolve(); await exitGate.promise;}});
  const controller = new AbortController(), work = f.inspector.inspect(f.request, {signal: controller.signal});
  const rejected = assert.rejects(work, {code: 'ERR_CUE_INSPECTOR_CANCELLED'});
  await entered.promise; controller.abort(); rpcGate.resolve(); await exitEntered.promise;
  assert.equal(f.events.includes('read-lease-invalidated'), true);
  assert.equal(f.events.includes('read-lease-closed'), false);
  exitGate.resolve(); await rejected;
  assert.ok(f.events.indexOf('actual-tree-empty') < f.events.indexOf('read-lease-closed'));
});

test('a short native expansion must hit the deadline rather than manufacture the missing track', async t => {
  const timer = globalThis.setTimeout; let fireDeadline;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms === CUE_INSPECTOR_LIMITS.deadlineMs) {fireDeadline = fn; return timer(() => {}, ms);}
    return timer(fn, ms, ...args);
  });
  const f = await fixture(t, {page: (_read, items) => {
    fireDeadline(); return {offset: 0, totalCount: 1, items: items.slice(0, 1)};
  }});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_DEADLINE'});
  assert.equal(f.progress.some(row => row.state === 'verified'), false); assert.ok(f.events.includes('actual-tree-empty'));
});

test('a nonautomatic runtime cannot enter an installer GUI branch', async t => {
  const f = await fixture(t); f.manifest.schemaVersion = 1; delete f.manifest.deployment;
  await f.write('manifests/public-backend.json', JSON.stringify(f.manifest));
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_RUNTIME'});
  assert.equal(f.events.includes('extractor-entered'), false); assert.equal(f.backendCreations, 0);
});

for (const kind of ['throw', 'reject']) test(`progress observer ${kind} cannot skip extractor/Job/holder cleanup`, async t => {
  const f = await fixture(t, {onProgress: () => {
    if (kind === 'throw') throw new Error('SYNTHETIC PROGRESS OBSERVER');
    return Promise.reject(new Error('SYNTHETIC ASYNC PROGRESS OBSERVER'));
  }});
  const result = await f.inspector.inspect(f.request); assert.equal(result.verified, true);
  assert.ok(f.events.includes('bootstrap-closed')); assert.ok(f.events.includes('actual-child-exit'));
  assert.ok(f.events.includes('actual-tree-empty')); assert.ok(f.events.includes('read-lease-closed'));
});

for (const kind of ['throw', 'reject']) test(`progress observer ${kind} cannot turn an unproven Job exit into success`, async t => {
  const f = await fixture(t, {missingTree: true, onProgress: () => {
    if (kind === 'throw') throw new Error('SYNTHETIC PROGRESS OBSERVER');
    return Promise.reject(new Error('SYNTHETIC ASYNC PROGRESS OBSERVER'));
  }});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_EXIT_UNVERIFIED'});
  await assert.rejects(f.inspector.close(), {code: 'ERR_CUE_INSPECTOR_EXIT_UNVERIFIED'});
  assert.equal(f.progress.some(row => row.state === 'verified'), false); assert.equal(f.events.includes('read-lease-closed'), false);
});

test('lease loss while ingesting still drains the actual Job before releasing handles, even if setup cancellation throws', async t => {
  let f;
  f = await fixture(t, {cancelThrow: true, beforeRpc: async call => {
    if (call.route.startsWith('playlists/shadow-id/items/0:')) f.loseLease();
  }});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_LEASE_LOST'});
  assert.ok(f.events.includes('actual-tree-empty'));
  assert.ok(f.events.indexOf('actual-tree-empty') < f.events.indexOf('read-lease-closed'));
  assert.equal(f.progress.some(row => row.state === 'verified'), false);
});

function verificationFixture(options = {}) {
  const root = path.resolve(__dirname, 'SYNTHETIC-NOT-CREATED-CUE-VERIFIER'), directoryA = path.join(root, 'a'), directoryB = path.join(root, 'b');
  const scope = {directoryA, directoryB, waveA: path.join(directoryA, 'main.wav'), cue: path.join(directoryB, 'album.cue')};
  scope.request = {path: scope.cue, references: [path.join(directoryB, 'cue.wav')], authorizationRoot: directoryB,
    trackCount: 2, encoding: 'utf-8', contentHash: 'a'.repeat(64)};
  const items = [73, 91].map((subsong, index) => ({path: scope.cue, subsong, title: index ? 'CUE Inspector Second' : 'CUE Inspector First',
    duration: 45, supported: true}));
  const calls = [], events = []; let active = false, plays = 0, position = 0, sessionId = 'old-main';
  const state = () => ({available: true, backendReachable: true, state: 'playing', source: options.sourceChanged && active ? 'apple' : 'local',
    stale: false, position, duration: plays > 1 ? 45 : 90,
    currentTrack: plays > 1 ? {...items[1], ...(options.wrongSubsong ? {subsong: 0} : {})} : {path: scope.waveA, subsong: 0}});
  const main = {
    initialize: async () => {calls.push('fresh-main-A-only');},
    play: async locations => {
      assert.equal(active, false, 'Main mutations cannot occur during discovery'); plays++; position = 0;
      if (plays === 1) assert.deepEqual(locations, [{path: scope.waveA, subsong: 0}]);
      else {assert.deepEqual(locations, [{path: items[1].path, subsong: items[1].subsong}]); calls.push('formal-pending-root-restart'); if (!options.noRestart) sessionId = 'new-main';}
      return state();
    },
    snapshot: async () => {
      position += options.noProgress ? 0 : 0.3;
      const changed = active && options.mainChanged;
      return {state: state(), roots: plays > 1 ? [directoryA, directoryB] : [directoryA],
        fingerprint: JSON.stringify({sessionId, roots: changed ? [directoryA, directoryB] : plays > 1 ? [directoryA, directoryB] : [directoryA],
          playlists: changed ? ['CHANGED'] : ['ORIGINAL'], queue: [], config: changed ? 'CHANGED' : 'ORIGINAL', source: 'local'})};
    },
    sessionId: () => sessionId, previousTreeExitVerified: () => !options.oldTreeMissing,
    cancel: () => {calls.push('main-cancelled');},
    close: async () => {calls.push('main-close'); return {childExited: true, treeExited: !options.mainTreeMissing, drained: true,
      failureCode: options.cleanupFailureCode || null};}
  };
  const api = {createMain: () => main, createInspector: (_scope, onProgress) => ({
    inspect: async (_request, {signal}) => {
      calls.push('indexer-B-start'); active = true; onProgress({state: 'discovering'}); await tick(); active = false;
      if (signal.aborted) throw signal.reason;
      if (options.discoveryError) throw Object.assign(new Error('SYNTHETIC NATIVE FAILURE'), {code: 'ERR_CUE_INSPECTOR_ITEMS'});
      calls.push('indexer-tree-and-holder-exited'); return {verified: true, items};
    },
    close: async () => {calls.push('indexer-close'); active = false; if (options.indexerExitMissing) throw Object.assign(new Error('SYNTHETIC TREE UNKNOWN'), {code: 'ERR_CUE_INSPECTOR_EXIT_UNVERIFIED'});}
  })};
  const run = more => cueVerifier.runLifecycle({api, scope, wanted: DAC, emit: event => events.push(event), wait: tick, ...more});
  return {scope, calls, events, run};
}

test('non-UI verifier defaults to a plan and refuses r6 or unpinned executable input', () => {
  assert.equal(cueVerifier.plan().executes, false); assert.equal(cueVerifier.parseArguments([]).mode, 'plan');
  assert.throws(() => cueVerifier.parseArguments(['--run']), {code: 'CUE_VERIFY_CANDIDATE_PIN_REQUIRED'});
  assert.throws(() => cueVerifier.parseArguments(['--check', '--candidate', path.resolve('dist/Still-public-1.1.0-candidate-20261108-r6'), '--build-sha256', 'a'.repeat(64)]), {code: 'CUE_VERIFY_NEW_CANDIDATE_REQUIRED'});
  assert.throws(() => cueVerifier.parseArguments(['--run', '--candidate', path.resolve('dist/Still-public-1.1.0-candidate-20261108-r7'), '--build-sha256', 'a'.repeat(64), '--type-id', 'output', '--device-id', NULL.deviceId]));
});

test('the exported pending-root lifecycle can be imported without Electron or invoking app.run', () => {
  const before = new Set(Object.keys(require.cache)), main = require('../src/main/main');
  assert.equal(typeof main.prepareLocalPlaybackLifecycle, 'function');
  for (const filename of Object.keys(require.cache).filter(name => !before.has(name))) assert.equal(/[\\/]node_modules[\\/]electron[\\/]/u.test(filename), false);
});

test('a missing fourth runtime pin cannot be replaced with a neighboring holder manifest', async t => {
  const f = await fixture(t), filename = path.join(f.appRoot, 'src/main/runtime-assets.json');
  const registry = JSON.parse(await fs.readFile(filename, 'utf8')); delete registry.assets.cueReadLeaseManifest;
  await fs.writeFile(filename, JSON.stringify(registry));
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_LEASE_UNAVAILABLE'});
  assert.equal(f.events.includes('read-lease-acquired'), false); assert.equal(f.backendCreations, 0);
});

test('a holder manifest mutation is refused by the trusted fourth runtime pin before acquisition', async t => {
  const f = await fixture(t); await fs.appendFile(path.join(f.appRoot, 'native/cue-read-lease/bin/runtime-manifest.json'), ' ');
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_RUNTIME'});
  assert.equal(f.events.includes('read-lease-acquired'), false); assert.equal(f.backendCreations, 0);
});

for (const relative of ['native/cue-read-lease/bin/StillCueReadLease.exe', 'src/main/cue-read-lease.js']) test(`a live-run mutation of ${relative} cannot deliver verified items`, async t => {
  let changed = false;
  const f = await fixture(t, {beforeRpc: async (call, context) => {
    if (!changed && call.route.startsWith('playlists/shadow-id/items/0:')) {changed = true; await fs.appendFile(path.join(context.appRoot, relative), ' CHANGED');}
  }});
  await assert.rejects(f.inspector.inspect(f.request), {code: 'ERR_CUE_INSPECTOR_RUNTIME'});
  assert.ok(f.events.includes('actual-tree-empty')); assert.equal(f.progress.some(row => row.state === 'verified'), false);
});

test('non-UI verifier generates a bounded 90-second all-zero stereo PCM WAV', () => {
  const bytes = cueVerifier.wave(); assert.equal(bytes.length, 90 * 44100 * 4 + 44); assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt16LE(20), 1); assert.equal(bytes.readUInt32LE(24), 44100); assert.equal(bytes.readUInt16LE(34), 16);
  assert.ok(bytes.subarray(44).every(value => value === 0));
});

test('non-UI A/B verifier preserves main discovery state, then uses explicit returned identities after an owned restart', async () => {
  const f = verificationFixture(), result = await f.run();
  assert.equal(result.status, 'passed'); assert.equal(result.mainUnchangedDuringDiscovery, true); assert.equal(result.mainProgressedDuringDiscovery, true);
  assert.equal(result.mainRestartedForNewRoot, true); assert.equal(result.exactCuePlayback, true); assert.equal(result.cueProgressed, true);
  assert.ok(f.calls.indexOf('indexer-close') < f.calls.indexOf('formal-pending-root-restart')); assert.equal(result.finalMainTreeExited, true);
});

for (const [name, options] of [
  ['main roots/config/playlist mutation', {mainChanged: true}], ['source change', {sourceChanged: true}], ['no progress', {noProgress: true}],
  ['no main restart for B', {noRestart: true}], ['unproven old main tree', {oldTreeMissing: true}], ['wrong returned subsong during play', {wrongSubsong: true}],
  ['native discovery failure', {discoveryError: true}]
]) test(`non-UI A/B verifier rejects ${name} and still closes both owners`, async () => {
  const f = verificationFixture(options), result = await f.run(); assert.equal(result.status, 'failed');
  assert.ok(f.calls.includes('indexer-close')); assert.ok(f.calls.includes('main-close')); assert.equal(result.requiresExecutorRetention, false);
});

for (const option of ['indexerExitMissing', 'mainTreeMissing']) test(`non-UI verifier retains ownership when ${option}`, async () => {
  const f = verificationFixture({[option]: true}), result = await f.run();
  assert.equal(result.status, 'failed'); assert.equal(result.requiresExecutorRetention, true); assert.ok(f.calls.includes('main-close'));
});

for (const kind of ['throw', 'reject']) test(`non-UI evidence observer ${kind} cannot skip cleanup or lose a retained owner`, async () => {
  const f = verificationFixture({mainTreeMissing: true});
  const result = await f.run({emit: () => {if (kind === 'throw') throw new Error('SYNTHETIC LOG ERROR'); return Promise.reject(new Error('SYNTHETIC LOG ERROR'));}});
  assert.equal(result.status, 'failed'); assert.equal(result.requiresExecutorRetention, true); assert.ok(f.calls.includes('main-close'));
});

test('a cancelled non-UI run does not proceed to the explicit B playback stage and still drains both owners', async () => {
  const f = verificationFixture(), controller = new AbortController();
  const result = await f.run({signal: controller.signal, emit: event => {if (event.type === 'indexer-progress') controller.abort();}});
  assert.equal(result.status, 'failed'); assert.equal(f.calls.includes('formal-pending-root-restart'), false);
  assert.ok(f.calls.includes('main-cancelled')); assert.ok(f.calls.includes('indexer-close')); assert.ok(f.calls.includes('main-close'));
});

test('a cleanup command failure preserves actual child/tree exit facts without inventing a still-live owner', async () => {
  const f = verificationFixture({cleanupFailureCode: 'CUE_VERIFY_MAIN_STOP'}), result = await f.run();
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'CUE_VERIFY_MAIN_STOP');
  assert.equal(result.finalMainChildExited, true); assert.equal(result.finalMainTreeExited, true); assert.equal(result.requiresExecutorRetention, false);
});
