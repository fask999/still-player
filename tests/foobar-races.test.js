'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBeefwebHttp } = require('./helpers/fake-beefweb-http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFoobarService, locationKey, normalizeLocations } = require('../src/main/foobar');

const track = (name, subsong = 0) => ({ path: `C:\\Music\\${name}`, subsong, title: name, duration: 300 });
const A = track('a.flac', 1), B = track('a.flac', 2), C = track('c.wav');
const columns = item => item ? [item.path, String(item.subsong), item.title, '', '', String(item.duration)] : [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate, message) {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(1);
  }
}
function gate() {
  let release, entered;
  return { waiting: new Promise(resolve => { entered = resolve; }),
    hold: new Promise(resolve => { release = resolve; }), release: () => release(), entered: () => entered() };
}

async function fixture(t, config = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'still-foobar-races-'));
  const lists = [{ id: 'user', title: 'Original', items: [A, B, C] },
    { id: 'other', title: 'Other original', items: [track('other.wav')] }];
  const original = JSON.stringify(lists);
  const calls = [], played = [], removed = [], holds = new Set();
  let nextId = 1, active = { playlistId: 'user', index: 2 }, playback = config.playing ? 'playing' : 'stopped', position = 0;
  let queue = [], roots = config.emptyRoots ? [] : [{ path: 'C:\\Music', name: 'Music', type: 'D' }], volumeValue = 0, order = 0;
  let hook = null, responseHook = null, droppedPlay = false, frozen = config.frozen || false;
  const outputs = { active: { typeId: 'output', deviceId: 'dx1' }, types: [
    { id: 'output', name: 'Output', devices: [{ id: 'dx1', name: 'DX1 II' }] }] };
  function player() {
    if (playback === 'playing' && !frozen) position += 0.2;
    const item = lists.find(item => item.id === active.playlistId)?.items[active.index];
    return { info: { name: 'foobar2000', pluginVersion: '0.10', version: '2.25.10' },
      playbackState: playback, activeItem: { ...active, position, duration: item?.duration || 0, columns: columns(item) },
      volume: { type: 'db', min: -100, max: 0, value: volumeValue }, playbackModes: ['Default', 'Repeat'], playbackMode: order,
      ...(config.predictionOptions ? {options: config.predictionOptions} : {}) };
  }
  const http = createFakeBeefwebHttp(async ({ url, body, route, call, send: reply, drop }) => {
    calls.push(call);
    const send = async (value, status = 200) => {
      if (responseHook) await responseHook(call, value);
      reply(value, status);
    };
    if (hook) await hook(call);
    if (route === 'query') {
      const result = { player: player() };
      if (url.searchParams.get('outputs')) result.outputs = outputs;
      if (url.searchParams.get('playQueue')) result.playQueue = queue.map(item => ({ ...item }));
      if (url.searchParams.get('playlists')) result.playlists = lists.map(item => ({id: item.id, title: item.title, itemCount: item.items.length}));
      return send(result);
    }
    if (route === 'browser/roots') return send({ roots });
    if (route === 'playlists') return send({ playlists: lists.map((item, index) => ({ id: item.id, title: item.title, index, itemCount: item.items.length })) });
    if (route === 'playlists/add') {
      const item = { id: `deck${nextId++}`, title: body.title, items: [] }; lists.push(item); return send({ id: item.id, title: item.title });
    }
    let match;
    if ((match = route.match(/^playlists\/([^/]+)\/items\/(\d+):(\d+)$/))) {
      const list = lists.find(item => item.id === match[1]); if (!list) return send({}, 404);
      const offset = Number(match[2]); return send({ playlistItems: { offset, totalCount: list.items.length,
        items: list.items.slice(offset, offset + Number(match[3])).map(item => ({ columns: columns(item) })) } });
    }
    if ((match = route.match(/^playlists\/([^/]+)\/items\/add$/))) {
      if (config.denyAdd) return send({ error: 'Path is not in musicDirs' }, 403);
      const list = lists.find(item => item.id === match[1]);
      if (!config.neverLoad) list.items.push(...body.items.flatMap(file => /image\.cue$/.test(file)
        ? [track('image.cue', 1), track('image.cue', 2)] : [{ ...track(path.win32.basename(file)), path: file }]));
      return send(null, 202);
    }
    if ((match = route.match(/^playlists\/([^/]+)\/([^/]+)\/items\/copy$/))) {
      const from = lists.find(item => item.id === match[1]), to = lists.find(item => item.id === match[2]);
      if (!from || !to) return send({}, 404);
      // Real foobar selection semantics may sort and deduplicate indices.
      to.items.push(...[...new Set(body.items)].sort((a, b) => a - b).map(index => from.items[index]));
      return send(null, 204);
    }
    if ((match = route.match(/^playlists\/remove\/([^/]+)$/))) {
      const index = lists.findIndex(item => item.id === match[1]);
      if (index < 0) return send({}, 404);
      assert.notEqual(active.playlistId, match[1], 'a backend active-item reference must stay alive');
      assert.ok(!queue.some(item => item.playlistId === match[1]), 'a backend queue reference must stay alive');
      removed.push(match[1]); lists.splice(index, 1); return send(null, 204);
    }
    if ((match = route.match(/^player\/play\/([^/]+)\/(\d+)$/))) {
      if (config.disconnectLatePlay && !droppedPlay) { droppedPlay = true; drop(); await sleep(60); }
      active = { playlistId: match[1], index: Number(match[2]) }; position = 0; playback = 'playing'; played.push(match[1]);
      return config.playResponseBody ? send({ applied: true }, 200) : send(null, 204);
    }
    if (route === 'player/stop') { playback = 'stopped'; return send(null, 204); }
    if (route === 'player/pause') { if (playback === 'playing') playback = 'paused'; return send(null, 204); }
    if (route === 'player') { if (body.position != null) position = body.position; if (body.volume != null) volumeValue = body.volume;
      if (body.playbackMode != null) order = body.playbackMode; return send(null, 204); }
    if (route === 'playqueue') return send({ playQueue: queue.map(item => ({ ...item,
      columns: columns(lists.find(list => list.id === item.playlistId)?.items[item.itemIndex]) })) });
    if (route === 'playqueue/add') { queue.push({ playlistId: body.plref, itemIndex: body.itemIndex }); return send(null, 204); }
    if (route === 'playqueue/clear') { queue = []; return send(null, 204); }
    return send({ error: `Unhandled ${route}` }, 404);
  });
  const service = createFoobarService({ dataDir, baseUrl: http.baseUrl, fetch: http.fetch,
    pollIntervalMs: 0, verifyTimeoutMs: 350, verifyPollMs: 5, timeoutMs: config.timeoutMs || 1500, cleanupDelayMs: 60000,
    fenceTimeoutMs: config.fenceTimeoutMs,
    waitForOutputRelease: config.waitForOutputRelease,
    onAudioDispatch: config.onAudioDispatch,
    keepDecks: config.keepDecks ?? 0, cleanupBatchSize: config.cleanupBatchSize || 4 });
  t.after(async () => {
    for (const hold of holds) hold.release();
    await service.close(); await http.drain();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  function blockOnce(predicate) {
    const hold = gate(); holds.add(hold); let matched = false;
    hook = async call => { if (!matched && predicate(call)) { matched = true; hold.entered(); await hold.hold; } };
    return hold;
  }
  function blockResponseOnce(predicate) {
    const hold = gate(); holds.add(hold); let matched = false;
    responseHook = async call => { if (!matched && predicate(call)) { matched = true; hold.entered(); await hold.hold; } };
    return hold;
  }
  function blockBodyOnce(predicate) {
    const hold = gate(); holds.add(hold); let matched = false;
    http.setBodyHook(async call => { if (!matched && predicate(call)) { matched = true; hold.entered(); await hold.hold; } });
    return hold;
  }
  return { service, lists, calls, played, removed, dataDir, blockOnce, blockResponseOnce, blockBodyOnce, http, original,
    setHook: value => { hook = value; }, setRoots: value => { roots = value; }, setFrozen: value => { frozen = value; },
    addQueue: (playlistId, itemIndex = 0) => queue.push({ playlistId, itemIndex }),
    assertOriginal: () => assert.equal(JSON.stringify(lists.filter(item => ['user', 'other'].includes(item.id))), original) };
}

test('batched copy retains [A,B,A], reverse order and exact subsongs with bit-mask backend', async t => {
  const f = await fixture(t);
  await f.service.play({ locations: [A, B, A], startIndex: 2 });
  const deck = f.lists.find(item => item.id === f.played[0]);
  assert.deepEqual(deck.items.map(locationKey), [A, B, A].map(locationKey));
  assert.deepEqual(f.calls.filter(call => /items\/copy$/.test(call.route)).map(call => call.body.items), [[0, 1], [0]]);
  await f.service.play({ locations: [B, A, C] });
  assert.deepEqual(f.lists.find(item => item.id === f.played[1]).items.map(locationKey), [B, A, C].map(locationKey));
  f.assertOriginal();
  assert.throws(() => normalizeLocations([{ path: A.path, subsong: null }]), /索引/);
});

for (const command of ['play', 'stop', 'pause', 'seek']) {
  test(`slow A copy is cancelled by ${command}; late copy cannot resurrect A`, async t => {
    const f = await fixture(t, { playing: command === 'seek' });
    const blocked = f.blockOnce(call => /items\/copy$/.test(call.route));
    const old = f.service.play({ locations: [A] });
    const oldResult = old.then(() => null, error => error);
    await blocked.waiting;
    const began = Date.now();
    const current = command === 'play' ? await f.service.play({ locations: [B] })
      : command === 'seek' ? await f.service.seek(45) : await f.service[command]();
    assert.ok(Date.now() - began < 300, 'urgent intent must not wait for the held building request');
    assert.equal((await oldResult)?.code, 'STILL_CANCELLED');
    if (command === 'play') assert.equal(locationKey(current.currentTrack), locationKey(B));
    if (command === 'seek') assert.ok(Math.abs(current.position - 45) < 1);
    await f.service.cleanupOwnedDecks();
    const heldDeck = f.lists.find(item => item.title.startsWith('STILL · Playback ') && item.items.length === 0);
    assert.ok(heldDeck, 'an in-flight copy destination stays pinned');
    blocked.release(); await sleep(50);
    assert.equal(f.played.length, command === 'play' ? 1 : 0);
    assert.equal((await f.service.getState()).state, command === 'play' || command === 'seek' ? 'playing' : 'stopped');
    await f.service.cleanupOwnedDecks();
    assert.ok(!f.lists.some(item => item.id === heldDeck.id));
    f.assertOriginal();
  });
}

test('late playlist creation is tracked, never played, and collected after supersession', async t => {
  const f = await fixture(t);
  const blocked = f.blockOnce(call => call.route === 'playlists/add');
  const old = f.service.play({ locations: [A] }).catch(error => error);
  await blocked.waiting;
  await f.service.play({ locations: [B] });
  assert.equal((await old).code, 'STILL_CANCELLED');
  blocked.release(); await sleep(50);
  await f.service.cleanupOwnedDecks();
  assert.equal(f.played.length, 1);
  assert.equal(f.lists.filter(item => item.title.startsWith('STILL · Playback ')).length, 1);
  f.assertOriginal();
});

test('stop bypasses old playback verification and no old poll reports success', async t => {
  const f = await fixture(t, { frozen: true });
  const old = f.service.play({ locations: [A] }).catch(error => error);
  while (!f.played.length) await sleep(2);
  const before = Date.now();
  assert.equal((await f.service.stop()).state, 'stopped');
  assert.ok(Date.now() - before < 200);
  assert.equal((await old).code, 'STILL_CANCELLED');
  await sleep(50); assert.equal((await f.service.getState()).state, 'stopped');
  f.assertOriginal();
});

test('already-dispatched late play commits before stop, so it cannot start after confirmed stop', async t => {
  const f = await fixture(t);
  const blocked = f.blockOnce(call => /^player\/play\//.test(call.route));
  const old = f.service.play({ locations: [A] }).catch(error => error);
  await blocked.waiting;
  let finished = false;
  const stopped = f.service.stop().then(value => { finished = true; return value; });
  assert.equal((await old).code, 'STILL_CANCELLED');
  await sleep(20); assert.equal(finished, false);
  blocked.release(); assert.equal((await stopped).state, 'stopped');
  assert.deepEqual(f.calls.filter(call => /^player\/(play\/|stop$)/.test(call.route)).map(call => call.route.split('/')[1]), ['play', 'stop']);
  await sleep(30); assert.equal((await f.service.getState()).state, 'stopped');
  f.assertOriginal();
});

test('control headers do not release the play fence while its response body is still held', async t => {
  const f = await fixture(t, { playResponseBody: true });
  const blocked = f.blockBodyOnce(call => /^player\/play\//.test(call.route));
  const old = f.service.play({ locations: [A] }).catch(error => error);
  await blocked.waiting;
  const play = f.calls.find(call => /^player\/play\//.test(call.route));
  assert.equal(play.status, 200); assert.equal(play.headersSent, true);
  assert.equal(play.bodyRead, true); assert.equal(play.bodySettled, false);
  assert.equal(f.played.length, 1, 'the physical play was applied before its body was held');
  let finished = false;
  const stopped = f.service.stop().then(value => { finished = true; return value; });
  assert.equal((await old).code, 'STILL_CANCELLED');
  await sleep(20);
  assert.equal(finished, false); assert.equal(f.service.getAudioTransportStatus().pending, true);
  assert.equal(play.signal.aborted, false, 'a newer media intent does not revoke a dispatched POST');
  assert.ok(!f.calls.some(call => call.route === 'player/stop'));
  blocked.release(); assert.equal((await stopped).state, 'stopped');
  assert.equal(play.bodySettled, true); assert.equal(f.service.getAudioTransportStatus().pending, false);
  assert.deepEqual(f.calls.filter(call => /^player\/(play\/|stop$)/.test(call.route)).map(call => call.route.split('/')[1]), ['play', 'stop']);
  f.assertOriginal();
});

test('same-count source reorder invalidates cached refs; unchanged unrelated lists are not reread', async t => {
  const f = await fixture(t);
  await f.service.play({ locations: [A] });
  const initialOtherReads = f.calls.filter(call => /^playlists\/other\/items\//.test(call.route)).length;
  f.lists[0].items = [B, C, A];
  const prepared = await f.service.prepareLocations({ locations: [A] });
  assert.deepEqual(prepared, { prepared: true, count: 1, locations: [{ path: A.path, subsong: A.subsong }] });
  await f.service.play({ locations: [A] });
  const latest = f.lists.find(item => item.id === f.played.at(-1));
  assert.equal(locationKey(latest.items[0]), locationKey(A));
  assert.equal(f.calls.filter(call => /^playlists\/other\/items\//.test(call.route)).length, initialOtherReads);
  assert.equal(f.lists[0].items.length, 3);
});

test('cleanup is bounded, respects queue and active references, and never scans history items', async t => {
  const f = await fixture(t, { cleanupBatchSize: 2 });
  await f.service.play({ locations: [A] });
  const queuedDeck = f.played[0]; f.addQueue(queuedDeck);
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'foobar-service.json'), 'utf8'));
  for (let index = 0; index < 8; index++) f.lists.push({ id: `history${index}`,
    title: `STILL · Playback historical${index} [${saved.instanceId}]`, items: [A, B, A] });
  f.lists.push({ id: 'someone-else', title: 'STILL · Playback old [00000000-0000-0000-0000-000000000000]', items: [A] });
  await f.service.play({ locations: [B] });
  const currentDeck = f.played.at(-1);
  const first = await f.service.cleanupOwnedDecks();
  assert.equal(first.removed.length, 2);
  for (let index = 0; index < 6; index++) await f.service.cleanupOwnedDecks();
  assert.ok(f.lists.some(item => item.id === queuedDeck));
  assert.ok(f.lists.some(item => item.id === currentDeck));
  assert.ok(f.lists.some(item => item.id === 'someone-else'));
  assert.deepEqual((await f.service.queueList()).items.map(locationKey), [locationKey(A)]);
  assert.ok(!f.calls.some(call => /^playlists\/(history\d+|someone-else)\/items\//.test(call.route)));
  const snapshot = await f.service.librarySnapshot();
  assert.equal(snapshot.playlists.find(item => item.id === queuedDeck).ownedByStill, true);
  assert.equal(snapshot.playlists.find(item => item.id === queuedDeck).items.length, 0);
  f.assertOriginal();
});

test('prepare imports exact subsong without playing; an independent stop does not wait', async t => {
  const f = await fixture(t);
  const blocked = f.blockOnce(call => /items\/add$/.test(call.route));
  const preparing = f.service.prepareLocations({ locations: [track('image.cue', 2)] });
  await blocked.waiting;
  assert.equal((await f.service.stop()).state, 'stopped');
  blocked.release(); const result = await preparing;
  assert.equal(result.prepared, true); assert.equal(result.locations[0].subsong, 2);
  assert.equal(f.played.length, 0);
  assert.ok(!f.calls.some(call => /^player\/play/.test(call.route)));
  f.assertOriginal();
});

test('empty allowed directories fail before POST and reread roots after a manual fix', async t => {
  const f = await fixture(t, { emptyRoots: true });
  await assert.rejects(f.service.prepareLocations({ paths: ['C:\\Music\\new.wav'] }), /musicDirs.*C:\\Music/s);
  assert.ok(f.calls.every(call => call.method === 'GET'));
  f.setRoots([{ path: 'C:\\Music', type: 'D' }]);
  assert.equal((await f.service.prepareLocations({ paths: ['C:\\Music\\new.wav'] })).prepared, true);
  assert.equal(f.played.length, 0);
  f.assertOriginal();
});

test('real 403 remains visible with allowed-directory diagnostics and no CLI fallback', async t => {
  const f = await fixture(t, { denyAdd: true });
  await assert.rejects(f.service.prepareLocations({ paths: ['C:\\Music\\new.wav'] }), /Beefweb 403[:：].*musicDirs.*C:\\\\Music/s);
  assert.equal(f.played.length, 0);
  assert.equal(f.calls.filter(call => /items\/add$/.test(call.route)).length, 1);
  f.assertOriginal();
});

test('a timed-out control lane rejects new stop until late play settles and a new explicit stop is requested', async t => {
  const f = await fixture(t, { timeoutMs: 120 });
  const blocked = f.blockOnce(call => /^player\/play\//.test(call.route));
  const old = f.service.play({ locations: [A] }).catch(error => error);
  await blocked.waiting;
  assert.equal((await old).code, 'STILL_TRANSPORT_UNCERTAIN');
  await assert.rejects(f.service.cancelPending(), { code: 'STILL_TRANSPORT_UNCERTAIN' });
  await assert.rejects(f.service.stop(), { code: 'STILL_TRANSPORT_UNCERTAIN' });
  assert.equal(f.service.getAudioTransportStatus().pending, true);
  assert.ok(!f.calls.some(call => call.route === 'player/stop'));
  blocked.release(); await eventually(() => !f.service.getAudioTransportStatus().pending, 'the physical play must eventually settle');
  assert.equal(f.played.length, 1);
  assert.ok(!f.calls.some(call => call.route === 'player/stop'), 'the rejected stop must not dispatch late');
  assert.equal((await f.service.stop()).state, 'stopped');
  await sleep(30); assert.equal((await f.service.getState()).state, 'stopped');
  f.assertOriginal();
});

test('a timed-out control body remains fenced despite a successful GET and clears only on its own physical settlement', async t => {
  const f = await fixture(t, { timeoutMs: 120, playResponseBody: true });
  const blocked = f.blockBodyOnce(call => /^player\/play\//.test(call.route));
  const old = f.service.play({ locations: [A] }).catch(error => error);
  await blocked.waiting; assert.equal((await old).code, 'STILL_TRANSPORT_UNCERTAIN');
  const play = f.calls.find(call => /^player\/play\//.test(call.route));
  assert.equal(play.status, 200); assert.equal(play.headersSent, true);
  assert.equal(play.bodySettled, false); assert.equal(play.signal.aborted, false);
  const current = await f.service.getState();
  assert.equal(current.state, 'playing'); assert.equal(current.controlUncertain, true);
  assert.equal(f.service.capabilities().playback, false, 'a fresh GET is not POST settlement evidence');
  await assert.rejects(f.service.stop(), { code: 'STILL_TRANSPORT_UNCERTAIN' });
  assert.ok(!f.calls.some(call => call.route === 'player/stop'));
  blocked.release(); await eventually(() => !f.service.getAudioTransportStatus().pending, 'body settlement must end the physical audio request');
  assert.equal(play.bodySettled, true);
  assert.equal((await f.service.getState()).controlUncertain, false);
  assert.ok(!f.calls.some(call => call.route === 'player/stop'), 'the rejected stop cannot be replayed after body settlement');
  assert.equal((await f.service.stop()).state, 'stopped');
  f.assertOriginal();
});

test('a control ticket whose own wait expired is never dispatched when the preceding late play settles', async t => {
  const f = await fixture(t, { timeoutMs: 250, fenceTimeoutMs: 70 });
  const blocked = f.blockOnce(call => /^player\/play\//.test(call.route));
  const old = f.service.play({ locations: [A] }).catch(error => error);
  await blocked.waiting;
  const stopped = f.service.stop();
  const rejected = assert.rejects(stopped, { code: 'STILL_TRANSPORT_UNCERTAIN' });
  assert.equal((await old).code, 'STILL_CANCELLED');
  await rejected;
  assert.ok(!f.calls.some(call => call.route === 'player/stop'));
  blocked.release(); await sleep(25);
  assert.equal(f.played.length, 1, 'the earlier physical request can still apply after foreground timeouts');
  assert.ok(!f.calls.some(call => call.route === 'player/stop'), 'the rejected stop must not be retried or dispatched late');
  assert.equal((await f.service.stop()).state, 'stopped', 'a new explicit stop is admitted after physical success');
  assert.equal(f.calls.filter(call => call.route === 'player/stop').length, 1);
  f.assertOriginal();
});

test('timed-out copy pins its destination until real settlement but does not delay cancel barrier or stop', async t => {
  const f = await fixture(t, { timeoutMs: 120 });
  const blocked = f.blockResponseOnce(call => /items\/copy$/.test(call.route));
  const old = f.service.play({ locations: [A] }).catch(error => error);
  await blocked.waiting; assert.equal((await old).code, 'STILL_TRANSPORT_UNCERTAIN');
  await f.service.cancelPending();
  assert.equal((await f.service.stop()).state, 'stopped');
  await f.service.cleanupOwnedDecks();
  assert.equal(f.lists.filter(item => item.title.startsWith('STILL · Playback ')).length, 1);
  blocked.release(); await sleep(40); await f.service.cleanupOwnedDecks();
  assert.equal(f.lists.filter(item => item.title.startsWith('STILL · Playback ')).length, 0);
  assert.equal(f.played.length, 0); f.assertOriginal();
});

test('timed-out create with an already-existing backend deck is protected and eventually collected', async t => {
  const f = await fixture(t, { timeoutMs: 120 });
  const blocked = f.blockResponseOnce(call => call.route === 'playlists/add');
  const old = f.service.play({ locations: [A] }).catch(error => error);
  await blocked.waiting; assert.equal((await old).code, 'STILL_TRANSPORT_UNCERTAIN');
  await f.service.cleanupOwnedDecks();
  assert.equal(f.lists.filter(item => item.title.startsWith('STILL · Playback ')).length, 1);
  await f.service.stop(); blocked.release(); await sleep(40); await f.service.cleanupOwnedDecks();
  assert.equal(f.lists.filter(item => item.title.startsWith('STILL · Playback ')).length, 0);
  assert.equal(f.played.length, 0); f.assertOriginal();
});

test('releaseOutput requires separate endpoint measurement after stopped readback', async t => {
  const unavailable = await fixture(t);
  await assert.rejects(unavailable.service.releaseOutput(), /stopped.*不能证明/);
  const proof = { released: true, evidence: { probe: 'IAudioClient.Initialize/shared', endpoint: 'test-device' } };
  const measured = await fixture(t, { waitForOutputRelease: async args => {
    assert.equal(args.output.deviceId, 'dx1');
    assert.equal((await measured.service.getState()).state, 'stopped');
    return proof;
  } });
  const result = await measured.service.releaseOutput();
  assert.equal(result.released, true); assert.deepEqual(result.evidence, proof.evidence);
  measured.assertOriginal();
});

test('late stale read returns the latest published state as well as suppressing stale events', async t => {
  const f = await fixture(t, { playing: true });
  const events = []; f.service.on('player', value => events.push(value.state));
  const blocked = f.blockResponseOnce(call => call.route === 'query');
  const slowRead = f.service.getState(); await blocked.waiting;
  assert.equal((await f.service.stop()).state, 'stopped');
  blocked.release(); assert.equal((await slowRead).state, 'stopped');
  assert.deepEqual(events, ['stopped']);
  f.assertOriginal();
});

test('lost control connection fails closed instead of claiming stop before an unknowable late play', async t => {
  const f = await fixture(t, { disconnectLatePlay: true });
  await assert.rejects(f.service.play({ locations: [A] }), /连接中断/);
  await assert.rejects(f.service.cancelPending(), error => error.code === 'STILL_TRANSPORT_UNCERTAIN');
  await assert.rejects(f.service.stop(), error => error.code === 'STILL_TRANSPORT_UNCERTAIN');
  assert.ok(!f.calls.some(call => call.route === 'player/stop'));
  await sleep(80);
  const current = await f.service.getState();
  assert.equal(current.state, 'playing'); assert.equal(current.controlUncertain, true);
  assert.equal(f.service.capabilities().playback, false);
  await f.service.cleanupOwnedDecks();
  assert.ok(f.lists.some(item => item.id === f.played[0]), 'unknown committed playback deck is retained');
  f.assertOriginal();
});

test('a timed-out queue lane rejects clear until physical add settles and does not block playback stop', async t => {
  const f = await fixture(t, { timeoutMs: 120 });
  const blocked = f.blockOnce(call => call.route === 'playqueue/add');
  const adding = f.service.queueAdd([A]).catch(error => error);
  await blocked.waiting; assert.equal((await adding).code, 'STILL_TRANSPORT_UNCERTAIN');
  await assert.rejects(f.service.queueClear(), { code: 'STILL_TRANSPORT_UNCERTAIN' });
  assert.equal((await f.service.stop()).state, 'stopped');
  assert.ok(!f.calls.some(call => call.route === 'playqueue/clear'));
  blocked.release(); await f.http.drain();
  assert.equal((await f.service.queueList()).items.length, 1, 'the old add still applies after its foreground timeout');
  assert.ok(!f.calls.some(call => call.route === 'playqueue/clear'), 'the rejected clear must not dispatch late');
  assert.deepEqual((await f.service.queueClear()).items, []);
  await sleep(30); assert.deepEqual((await f.service.queueList()).items, []); f.assertOriginal();
});

test('audio observer sees actual play and seek dispatch; volume, order, queue and preparation never trigger it', async t => {
  const events = [], settled = [];
  const f = await fixture(t, {onAudioDispatch: event => {events.push(event); return {settle: disposition => {settled.push(disposition);}};}});
  await f.service.prepareLocations([A]); await f.service.setVolume(0.5); await f.service.setOrder(1);
  await f.service.queueAdd([A]); await f.service.queueClear();
  assert.deepEqual(events, []); assert.deepEqual(f.service.getAudioTransportStatus(), {pending: false});
  await f.service.play({locations: [A]}); await f.service.seek(42); await f.service.pause(); await f.service.stop();
  assert.deepEqual(events, [{kind: 'play', source: 'local'}, {kind: 'seek', source: 'local'}, {kind: 'pause', source: 'local'}, {kind: 'stop', source: 'local'}]);
  assert.deepEqual(settled, ['dispatched', 'dispatched', 'dispatched', 'dispatched']);
  assert.deepEqual(f.service.getAudioTransportStatus(), {pending: false});
});

for (const failure of ['throw', 'promise', 'settle-throw', 'settle-promise']) {
  test(`observer ${failure} cannot block or change actual media playback`, async t => {
    const f = await fixture(t, {onAudioDispatch: () => {
      if (failure === 'throw') throw new Error('Synthetic analysis observer failure');
      if (failure === 'promise') return Promise.reject(new Error('Synthetic analysis-only rejected promise'));
      return {settle() {if (failure === 'settle-throw') throw new Error('Synthetic settle failure'); return Promise.reject(new Error('Synthetic settle-only promise'));}};
    }});
    assert.equal((await f.service.play({locations: [A]})).state, 'playing');
    assert.equal(f.played.length, 1); assert.equal(f.service.getAudioTransportStatus().pending, false);
  });
}

test('cancelled materialization never reaches the audio observer or audio fetch', async t => {
  const events = [], f = await fixture(t, {onAudioDispatch: event => {events.push(event);}});
  const blocked = f.blockOnce(call => /items\/copy$/.test(call.route));
  const playing = f.service.play({locations: [A]}); playing.catch(() => {}); await blocked.waiting;
  await f.service.cancelPending(); blocked.release();
  await assert.rejects(playing, {code: 'STILL_CANCELLED'}); await sleep(10);
  assert.deepEqual(events, []); assert.equal(f.played.length, 0); assert.equal(f.service.getAudioTransportStatus().pending, false);
});

test('pending audio stays true across a caller timeout and cancellation until actual HTTP settlement', async t => {
  const dispositions = [], f = await fixture(t, {timeoutMs: 30, onAudioDispatch: () => ({settle: value => {dispositions.push(value);}})});
  const blocked = f.blockOnce(call => /^player\/play\//.test(call.route));
  const playing = f.service.play({locations: [A]}); playing.catch(() => {}); await blocked.waiting;
  assert.equal(f.service.getAudioTransportStatus().pending, true);
  await assert.rejects(playing, {code: 'STILL_TRANSPORT_UNCERTAIN'});
  const dispatched = f.calls.find(call => /^player\/play\//.test(call.route));
  assert.equal(dispatched.signal.aborted, false, 'the foreground timeout must not abort a physical POST');
  assert.equal(f.service.getAudioTransportStatus().pending, true); assert.deepEqual(dispositions, []);
  await assert.rejects(f.service.cancelPending(), { code: 'STILL_TRANSPORT_UNCERTAIN' });
  assert.equal(f.service.getAudioTransportStatus().pending, true);
  assert.equal(dispatched.signal.aborted, false, 'ordinary cancellation must not abort a physical POST');
  blocked.release(); await eventually(() => !f.service.getAudioTransportStatus().pending, 'the audio request must remain pending until actual settlement');
  assert.equal(f.service.getAudioTransportStatus().pending, false);
  assert.deepEqual(dispositions, ['dispatched']); assert.equal(dispositions.includes('not-dispatched'), false);
});

test('a synchronous newer media intent after observation has definite not-dispatched evidence', async t => {
  let service; const dispositions = [];
  const f = await fixture(t, {onAudioDispatch: () => {void service.cancelPending(); return {settle: value => {dispositions.push(value);}};}});
  service = f.service;
  await assert.rejects(service.play({locations: [A]}), {code: 'STILL_CANCELLED'}); await sleep(10);
  assert.deepEqual(dispositions, ['not-dispatched']);
  assert.equal(f.calls.some(call => /^player\/play\//.test(call.route)), false);
  assert.equal(service.getAudioTransportStatus().pending, false);
});

const predictionEvidence = () => [{id: 'playbackOrder', type: 'enum', value: 0, enumNames: ['默认', '重复', '重复曲目', '随机']},
  {id: 'stopAfterCurrentTrack', type: 'bool', value: false}, {id: 'playbackFollowsCursor', type: 'bool', value: false},
  {id: 'cursorFollowsPlayback', type: 'bool', value: false}];

test('read-only context predicts neighbors only from two stable explicit ordinary-order/options/empty-queue observations', async t => {
  const f = await fixture(t, {predictionOptions: predictionEvidence()}), before = f.calls.length;
  const context = await f.service.playbackContext();
  assert.equal(context.status, 'ready'); assert.equal(context.predictNeighbors, true);
  assert.equal(f.calls.slice(before).every(call => call.method === 'GET'), true);
  assert.equal(f.calls.slice(before).some(call => call.route === 'outputs' || /^player\//.test(call.route)), false);
});

for (const name of ['missing-cursor', 'random', 'follow-cursor', 'stop-after', 'queue', 'duplicate-order', 'changing-mode']) {
  test(`context prediction remains false with ${name} evidence`, async t => {
    const options = predictionEvidence();
    if (name === 'missing-cursor') options.pop();
    if (name === 'random') options[0].value = 3;
    if (name === 'follow-cursor') options[2].value = true;
    if (name === 'stop-after') options[1].value = true;
    if (name === 'duplicate-order') options.push({...options[0]});
    const f = await fixture(t, {predictionOptions: options});
    if (name === 'queue') f.addQueue('user', 0);
    if (name === 'changing-mode') {let count = 0; f.setHook(async call => {if (call.route === 'query' && ++count === 2) options[0].value = 3;});}
    const context = await f.service.playbackContext();
    assert.equal(context.status, 'ready'); assert.equal(context.predictNeighbors, false);
  });
}
