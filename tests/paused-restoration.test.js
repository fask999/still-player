'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
// In-memory services only: no HTTP server, process launch, real playback or device probe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {createFoobarService} = require('../src/main/foobar');
const {buildPlan, orderedFingerprint, ownedTitle, sessionIdentity, createTransport, inspectCurrent, executeRestoration, loadLocalPlan, argsFor, main} = require('../scripts/restore-paused-session');
const {createSyntheticPausedSource, OUTPUT_DEVICE_ID, SYNTHETIC_BACKEND} = require('./helpers/paused-restoration-synthetic.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const outputId = OUTPUT_DEVICE_ID;
async function savedPlan(allowCreateDeck = false, sourceOptions) {
  return buildPlan({...createSyntheticPausedSource(sourceOptions), allowCreateDeck});
}
function fakeServices(plan, {missing = false} = {}) {
  const p = plan.payload, writes = [], reads = [], events = [];
  const state = {playback: 'stopped', active: null, volume: 0, order: 0, output: outputId, queue: [], formalLibrary: 'fixture-formal-library-hash',
    pid: 34567, createdAt: '2026-10-31T03:00:00.000Z', lists: missing ? [] : [{id: 'fresh-playlist-id', title: p.playlist.name, items: clone(p.playlist.items)}],
    beforeRead: null, beforeWrite: null, alterImport: null, failPost: null, checkedFiles: 0};
  function raw() {const a = state.active; return {info: {name: 'foobar2000', pluginVersion: '0.10'}, playbackState: state.playback,
    volume: {type: 'db', value: state.volume, min: -100, max: 0, isMuted: false}, options: [{id: 'playbackOrder', type: 'enum', value: state.order, enumNames: ['Default', 'Repeat']}],
    activeItem: a ? {playlistId: a.playlistId, index: a.index, position: a.position, columns: [a.path, String(a.subsong)]} : null};}
  const request = async (route, body) => {
    const routePath = route.split('?')[0];
    if (body !== undefined) {
      events.push(`POST ${routePath}`); writes.push({route: routePath, body: clone(body)});
      await state.beforeWrite?.(routePath, body);
      if (state.failPost === routePath) throw Object.assign(new Error('Synthetic uncertain POST'), {code: 'RESTORE_POST_UNCERTAIN'});
      if (routePath === 'playlists/add') {state.lists.push({id: 'new-restore-deck', title: body.title, items: []}); return {id: 'new-restore-deck', title: body.title};}
      if (routePath.endsWith('/items/add')) {const list = state.lists.find(item => item.id === routePath.split('/')[1]); list.items = body.items.map(file => ({path: file, subsong: 0})); state.alterImport?.(list.items); return null;}
      if (routePath.startsWith('player/play/')) {const [, , id, index] = routePath.split('/'), item = state.lists.find(x => x.id === id).items[Number(index)];
        state.active = {...clone(item), playlistId: id, index: Number(index), position: 0}; state.playback = 'playing'; return null;}
      if (routePath === 'player/pause') {state.playback = 'paused'; return null;}
      if (routePath === 'player') {state.active.position = body.position; return null;}
      throw new Error(`Unexpected write ${route}`);
    }
    events.push(`GET ${routePath}`); reads.push(route); await state.beforeRead?.(routePath);
    if (routePath === 'query') return {player: raw(), outputs: {active: {typeId: 'output', deviceId: state.output}, types: [{id: 'output', name: 'Output', devices: [{id: state.output, name: 'Synthetic exclusive output'}]}]}};
    if (routePath === 'playqueue') return {playQueue: clone(state.queue)};
    if (routePath === 'playlists') return {playlists: state.lists.map((item, index) => ({id: item.id, title: item.title, index, itemCount: item.items.length}))};
    const match = routePath.match(/^playlists\/([^/]+)\/items\/(\d+):(\d+)$/);
    if (match) {const list = state.lists.find(item => item.id === match[1]), offset = Number(match[2]);
      return {playlistItems: {offset, totalCount: list.items.length, items: list.items.slice(offset, offset + Number(match[3])).map(item => ({columns: [item.path, String(item.subsong)]}))}};}
    throw new Error(`Unexpected read ${route}`);
  };
  const deps = {request, session: async () => ({pid: state.pid, createdAt: state.createdAt, executable: p.backend.executable}),
    libraryHash: async () => state.formalLibrary, verifyFiles: async items => {state.checkedFiles = items.length;}, sleep: async () => {}, uuid: () => '12345678-1234-4234-8234-123456789abc'};
  return {state, writes, reads, events, deps};
}
async function inspected(plan, f, allowCreateDeck = false) {return inspectCurrent(plan, {...f.deps, approvedPlanId: plan.planId, allowCreateDeck});}
async function restore(plan, baseline, f, extra = {}) {
  return executeRestoration(plan, baseline, {...f.deps, approvedPlanId: plan.planId, approvedBaselineId: baseline.baselineId, exclusiveWindowAck: true, ...extra});
}

test('synthetic paused context pins all 107 ordered locations, target occurrence and independent old ID', async () => {
  const plan = await savedPlan(); const p = plan.payload;
  assert.equal(p.playlist.count, 107); assert.equal(p.playlist.targetIndex, 50); assert.equal(p.playlist.targetOccurrence, 1); assert.equal(p.playlist.targetOccurrences, 1);
  assert.equal(p.playlist.orderedPathSubsongSha256, 'a638d459c11a0f459f530c43b6068d74ad89f6a8224e9407fdd227a37e59af72');
  assert.equal(p.target.path, 'C:\\__STILL_PAUSED_UNIT_FIXTURE__\\track-050.flac'); assert.equal(p.target.subsong, 0); assert.ok(Math.abs(p.target.position - 14.54) < 0.001);
  assert.equal(p.source.historicalPlaylistId, 'synthetic-old-deck'); assert.equal(p.source.historicalIdIsNotReusable, true); assert.equal(p.fallback.allowCreateDeck, false);
});

test('duplicate target occurrence preserves index and subsong independently of the historical playlist ID', async () => {
  let fingerprint;
  for (const historicalPlaylistId of ['synthetic-old-deck-a', 'synthetic-old-deck-b']) {
    const plan = await savedPlan(false, {historicalPlaylistId, duplicateTargetLocations: true}), p = plan.payload;
    assert.equal(p.playlist.count, 107); assert.equal(p.playlist.targetIndex, 50);
    assert.equal(p.playlist.targetOccurrence, 2); assert.equal(p.playlist.targetOccurrences, 3);
    assert.equal(p.playlist.items[20].path, p.target.path); assert.equal(p.playlist.items[20].subsong, 1);
    assert.equal(p.target.subsong, 0); assert.equal(p.source.historicalPlaylistId, historicalPlaylistId);
    assert.equal(p.source.historicalIdIsNotReusable, true);
    if (fingerprint) assert.equal(p.playlist.orderedPathSubsongSha256, fingerprint);
    fingerprint = p.playlist.orderedPathSubsongSha256;
    const f = fakeServices(plan), baseline = await inspected(plan, f);
    const result = await restore(plan, baseline, f);
    assert.equal(result.restored, true); assert.equal(f.state.checkedFiles, 107);
    assert.equal(f.state.active.playlistId, 'fresh-playlist-id'); assert.equal(f.state.active.index, 50);
    assert.deepEqual(f.writes.map(item => item.route), ['player/play/fresh-playlist-id/50', 'player/pause', 'player']);
    assert.equal(f.state.playback, 'paused');
  }
});

test('different fresh playlist ID is resolved by complete context; immediate pause precedes any new read', async () => {
  const plan = await savedPlan(), f = fakeServices(plan), baseline = await inspected(plan, f);
  const result = await restore(plan, baseline, f);
  assert.equal(result.restored, true); assert.equal(f.state.checkedFiles, 107);
  assert.deepEqual(f.writes.map(item => item.route), ['player/play/fresh-playlist-id/50', 'player/pause', 'player']);
  const playIndex = f.events.indexOf('POST player/play/fresh-playlist-id/50'); assert.equal(f.events[playIndex + 1], 'POST player/pause');
  assert.equal(f.state.playback, 'paused'); assert.ok(Math.abs(f.state.active.position - 14.54) < 0.001);
});

test('missing context, same-name partial list, reordered content and duplicate exact lists refuse without writes', async () => {
  const plan = await savedPlan();
  for (const change of [f => {f.state.lists = [];}, f => f.state.lists[0].items.pop(), f => f.state.lists[0].items.reverse(),
    f => f.state.lists.push({...clone(f.state.lists[0]), id: 'second-exact'})]) {
    const f = fakeServices(plan); change(f); await assert.rejects(inspected(plan, f), /playlist|fallback|ambiguous/i); assert.equal(f.writes.length, 0);
  }
});

test('playing, other paused track, nonempty/unknown queue and output/order/volume conflicts preserve the new session', async () => {
  const plan = await savedPlan();
  for (const change of [f => {f.state.playback = 'playing';}, f => {f.state.playback = 'paused';}, f => {f.state.queue = [{playlistId: 'new-user', itemIndex: 0}];},
    f => {f.state.queue = null;}, f => {f.state.output = 'other-device';}, f => {f.state.order = 1;}, f => {f.state.volume = -20;}]) {
    const f = fakeServices(plan); change(f); await assert.rejects(inspected(plan, f)); assert.equal(f.writes.length, 0);
  }
});

test('plan/baseline/exclusive-window approvals and fresh unchanged session are mandatory', async () => {
  const plan = await savedPlan(), f = fakeServices(plan), baseline = await inspected(plan, f);
  await assert.rejects(restore(plan, baseline, f, {approvedPlanId: 'wrong'}));
  await assert.rejects(restore(plan, baseline, f, {approvedBaselineId: 'wrong'}));
  await assert.rejects(restore(plan, baseline, f, {exclusiveWindowAck: false}));
  f.state.createdAt = '2026-10-31T03:01:00.000Z'; await assert.rejects(restore(plan, baseline, f), /changes/i);
  assert.equal(f.writes.length, 0);
});

test('all source locations must pass preflight before fallback creates anything', async () => {
  const plan = await savedPlan(true), f = fakeServices(plan, {missing: true}), baseline = await inspected(plan, f, true);
  f.deps.verifyFiles = async () => {throw new Error('Synthetic missing location 106');};
  await assert.rejects(restore(plan, baseline, f, {allowCreateDeck: true}), /missing location/); assert.equal(f.writes.length, 0);
});

test('explicit fallback reconstructs every location in order and production librarySnapshot filters the new deck', async () => {
  const plan = await savedPlan(true), f = fakeServices(plan, {missing: true}), baseline = await inspected(plan, f, true);
  await assert.rejects(restore(plan, baseline, f), /fallback/i); assert.equal(f.writes.length, 0);
  const result = await restore(plan, baseline, f, {allowCreateDeck: true}); assert.equal(result.createdOwnedDeck, true);
  assert.equal(f.state.lists.length, 1); const deck = f.state.lists[0];
  assert.equal(ownedTitle(deck.title), true); assert.equal(orderedFingerprint(deck.items), plan.payload.playlist.orderedPathSubsongSha256);
  assert.equal(deck.items.length, 107); assert.equal(f.state.active.index, 50); assert.equal(f.state.formalLibrary, baseline.payload.snapshot.formalLibrarySha256);
  const bridge = createFoobarService({dataDir: path.join(__dirname, 'synthetic-restoration-no-data-written'), pollIntervalMs: 0, persistOutputSelection: false, fetch: async url => {
    const route = String(url).split('/api/')[1]; const value = await f.deps.request(route);
    return {ok: true, status: 200, text: async () => JSON.stringify(value)};
  }});
  try {const library = await bridge.librarySnapshot(); assert.equal(library.playlists[0].ownedByStill, true); assert.deepEqual(library.playlists[0].items, []);}
  finally {await bridge.close();}
});

test('fallback expanded/reordered/missing/subsong-changed import never reaches player writes', async () => {
  const plan = await savedPlan(true);
  for (const alter of [items => items.push(clone(items[0])), items => items.reverse(), items => items.pop(), items => {items[50].subsong = 1;}]) {
    const f = fakeServices(plan, {missing: true}); f.state.alterImport = alter; const baseline = await inspected(plan, f, true);
    await assert.rejects(restore(plan, baseline, f, {allowCreateDeck: true}));
    assert.equal(f.writes.some(item => item.route.startsWith('player')), false); assert.equal(f.state.playback, 'stopped');
  }
});

test('new user/library changes during preflight or fallback refuse without touching player or configuration', async () => {
  const plan = await savedPlan(true), f = fakeServices(plan, {missing: true}), baseline = await inspected(plan, f, true);
  f.state.beforeWrite = route => {if (route === 'playlists/add') f.state.formalLibrary = 'new-user-library-hash';};
  await assert.rejects(restore(plan, baseline, f, {allowCreateDeck: true}), /change/i);
  assert.deepEqual(f.writes.map(item => item.route), ['playlists/add']);
});

test('wrong actual path/subsong after pause prevents seek and never stops a different track', async () => {
  const plan = await savedPlan(), f = fakeServices(plan), baseline = await inspected(plan, f);
  f.state.beforeWrite = route => {if (route === 'player/pause') f.state.active.subsong = 7;};
  await assert.rejects(restore(plan, baseline, f), /path\/subsong/);
  assert.deepEqual(f.writes.map(item => item.route), ['player/play/fresh-playlist-id/50', 'player/pause']);
});

test('an uncertain POST is neither retried nor followed by other mutations or a success claim', async () => {
  const plan = await savedPlan(), f = fakeServices(plan), baseline = await inspected(plan, f); f.state.failPost = 'player/play/fresh-playlist-id/50';
  await assert.rejects(restore(plan, baseline, f), {code: 'RESTORE_POST_UNCERTAIN'});
  assert.deepEqual(f.writes.map(item => item.route), ['player/play/fresh-playlist-id/50']);
});

test('exact already-restored paused target is read-only and frozen readback rejects advancing position', async () => {
  const plan = await savedPlan(), f = fakeServices(plan);
  f.state.playback = 'paused'; f.state.active = {...clone(plan.payload.target), playlistId: 'fresh-playlist-id', index: 50};
  const baseline = await inspected(plan, f); const result = await restore(plan, baseline, f);
  assert.equal(result.alreadyRestored, true); assert.equal(f.writes.length, 0);
  const g = fakeServices(plan), gBaseline = await inspected(plan, g);
  g.deps.sleep = async ms => {if (ms === 500) g.state.active.position += 0.03;};
  await assert.rejects(restore(plan, gBaseline, g), /frozen/);
});

test('session proof refuses old PID, nonloopback listener, wrong executable and recycled PID creation time', async () => {
  const identity = {executable: SYNTHETIC_BACKEND.executable};
  const system = {processes: [{pid: 34567, createdAt: '2026-10-31T03:00:00Z', executable: identity.executable}], listeners: [{pid: 34567, address: '127.0.0.1'}]};
  assert.equal(sessionIdentity(system, identity).pid, 34567);
  for (const mutate of [x => {x.processes[0].pid = x.listeners[0].pid = 23400;}, x => {x.listeners[0].address = '0.0.0.0';},
    x => {x.processes[0].executable = 'C:\\Original\\foobar2000.exe';}, x => {x.processes[0].createdAt = null;}]) {
    const x = clone(system); mutate(x); assert.throws(() => sessionIdentity(x, identity));
  }
});

test('fixed transport uses only 127.0.0.1:18880, supports page ranges, and never exposes a configuration writer', async () => {
  const requests = [], request = createTransport(async (url, init) => {requests.push({url: String(url), init}); return {ok: true, status: 204, text: async () => ''};});
  await request('playlists/new-id/items/0:500?columns=x'); await request('player', {position: 14.54});
  assert.ok(requests.every(x => x.url.startsWith('http://127.0.0.1:18880/api/')));
  assert.equal(requests[1].init.signal, undefined, 'POST settlement must not be falsely revoked by socket abort');
  await assert.rejects(request('http://evil.invalid/api/player')); await assert.rejects(request('outputs/active', {}));
  await assert.rejects(request('../player', {})); assert.equal(requests.length, 2);
});

test('default CLI plan performs local file validation without HTTP or app startup and pins immutable hashes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'still-paused-synthetic-files-')), backendDir = path.join(root, 'backend', 'foobar2000');
  t.after(async () => {assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.ok(path.basename(root).startsWith('still-paused-synthetic-files-')); await fs.rm(root, {recursive: true, force: true});});
  const evidenceDir = path.join(root, 'synthetic-evidence'), synthetic = createSyntheticPausedSource();
  await fs.mkdir(evidenceDir);
  await fs.writeFile(path.join(evidenceDir, 'result.json'), synthetic.resultRaw);
  await fs.writeFile(path.join(evidenceDir, 'playlists-before.json'), synthetic.playlistsRaw);
  const files = [];
  for (const relativePath of ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll']) {
    const file = path.join(backendDir, relativePath); await fs.mkdir(path.dirname(file), {recursive: true}); const data = `synthetic fixture ${relativePath}`;
    await fs.writeFile(file, data); files.push({relativePath, mutable: false, sha256: hash(data)});
  }
  const config = {port: 18880, allowRemote: false, musicDirs: ['C:\\__STILL_PAUSED_UNIT_FIXTURE__']};
  await fs.mkdir(path.join(backendDir, 'profile', 'beefweb'), {recursive: true}); await fs.writeFile(path.join(backendDir, 'profile', 'beefweb', 'config.json'), JSON.stringify(config));
  await fs.writeFile(path.join(backendDir, 'backend-manifest.json'), JSON.stringify({schemaVersion: 1, dryRun: false, privateUseOnly: true, backendId: 'fixture', sourceDir: 'C:\\Original', destinationDir: backendDir, executable: 'foobar2000.exe', files, configuration: config}));
  const priorFetch = globalThis.fetch; let fetchCalls = 0;
  globalThis.fetch = () => {fetchCalls++; throw new Error('Default plan must never touch HTTP');};
  try {
    const out = path.join(root, 'plan.json'), plan = await main(['--evidence-dir', evidenceDir, '--backend-dir', backendDir, '--out', out]);
    assert.equal(plan.payload.playlist.count, 107); assert.equal(JSON.parse(await fs.readFile(out, 'utf8')).planId, plan.planId);
    assert.equal(plan.payload.source.resultHash, synthetic.resultHash); assert.equal(plan.payload.source.playlistsHash, synthetic.playlistsHash);
    await fs.writeFile(path.join(backendDir, 'foobar2000.exe'), 'changed immutable fixture');
    await assert.rejects(loadLocalPlan({evidenceDir, backendDir}), /hash mismatch/);
  } finally {globalThis.fetch = priorFetch;}
  assert.equal(fetchCalls, 0);
  assert.throws(() => argsFor(['--execute', '--inspect-current'])); assert.throws(() => argsFor(['--unknown']));
});
