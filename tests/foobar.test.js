'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBeefwebHttp } = require('./helpers/fake-beefweb-http');
const fs = require('node:fs/promises');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');
const path = require('node:path');
const { createFoobarService, trackFromColumns, normalizedVolume, backendVolume, normalizeLocations,
  normalizeOutputs, normalizeOrders, COLUMNS } = require('../src/main/foobar');

const source = (name, subsong = 0) => ({ path: `C:\\Music\\${name}`, subsong,
  title: `Track ${subsong}`, artist: 'Artist', album: 'Album', duration: 300, codec: 'PCM',
  sampleRate: 96000, bitsPerSample: 24, channels: 2 });
const columns = item => item ? [item.path, String(item.subsong), item.title, item.artist, item.album,
  String(item.duration), item.codec, String(item.sampleRate), String(item.bitsPerSample), String(item.channels)] : [];
async function fixture(t, settings = {}) {
  const {root: dataDir, parent: tempParent} = createCanonicalTemp('still-foobar-test-');
  const calls = [], lists = [{ id: 'p1', title: 'User collection', items: [source('album.flac', 1), source('album.flac', 2), source('one.wav')] }];
  let queue = [], active = { playlistId: 'p1', index: 2 }, playing = false, paused = false, position = 0, volume = -20, order = 0;
  let output = { typeId: 'wasapi', deviceId: 'dx1-shared' }, refuseOutput = false, fail = false;
  const outputs = { active: output, types: [{ id: 'wasapi', name: 'WASAPI', devices: [
    { id: 'dx1-shared', name: '扬声器 (DX1 II)' }, { id: 'dx1-exclusive', name: '扬声器 (DX1 II) [exclusive]' }] },
    { id: 'asio', name: 'ASIO', devices: [{ id: 'realtek', name: 'Realtek ASIO' }] }] };
  function player() {
    if (playing && !settings.frozen) position += 0.16;
    const item = lists.find(p => p.id === active.playlistId)?.items[active.index];
    return { info: { name: 'foobar2000', version: '2.25.10', pluginVersion: '0.10' },
      playbackState: playing ? 'playing' : paused ? 'paused' : 'stopped',
      volume: { type: settings.volumeType || 'db', min: -100, max: 0, value: volume, isMuted: false },
      activeItem: { ...active, position, duration: item?.duration || 0, columns: columns(item) },
      options: [{ id: 'playbackOrder', type: 'enum', value: order, enumNames: ['Default', 'Repeat (track)', 'Shuffle (tracks)'] }] };
  }
  const http = createFakeBeefwebHttp(({ url, method, body, send }) => {
    calls.push({ method, route: url.pathname, body });
    if (fail) return send({ error: 'fixture unavailable' }, 503);
    const route = url.pathname.replace('/api/', '');
    if (route === 'query') return send({ player: player(), outputs: { ...outputs, active: output } });
    if (route === 'outputs') return send({ outputs: { ...outputs, active: output } });
    if (route === 'browser/roots') return send({ roots: [{ path: 'C:\\Music', name: 'Music', type: 'D' }] });
    if (route === 'outputs/active') { if (!refuseOutput) output = body; return send(null, 204); }
    if (route === 'playlists' && method === 'GET') return send({ playlists: lists.map((p, index) => ({ id: p.id, title: p.title, index, itemCount: p.items.length })) });
    if (route === 'playlists/add') { const p = { id: `p${lists.length + 1}`, title: body.title, items: [] }; lists.push(p); return send({ id: p.id, title: p.title }); }
    let match;
    if ((match = route.match(/^playlists\/([^/]+)\/items\/(\d+):(\d+)$/))) {
      const p = lists.find(p => p.id === match[1]); if (!p) return send({}, 404);
      const offset = Number(match[2]); return send({ playlistItems: { offset, totalCount: p.items.length,
        items: p.items.slice(offset, offset + Number(match[3])).map(item => ({ columns: columns(item) })) } });
    }
    if ((match = route.match(/^playlists\/([^/]+)\/items\/add$/))) {
      const p = lists.find(p => p.id === match[1]);
      if (!settings.neverLoad) {
        const added = body.items.flatMap(file => /expanded/.test(file) ? [source('expanded.flac', 1), source('expanded.flac', 2)] : [source(path.win32.basename(file))]);
        if (settings.delayedLoad) setTimeout(() => p.items.push(...added), 45); else p.items.push(...added);
      }
      return send(null, 202);
    }
    if ((match = route.match(/^playlists\/([^/]+)\/([^/]+)\/items\/copy$/))) {
      const from = lists.find(p => p.id === match[1]), to = lists.find(p => p.id === match[2]);
      to.items.push(...body.items.map(i => from.items[i])); return send(null, 204);
    }
    if ((match = route.match(/^player\/play\/([^/]+)\/(\d+)$/))) { active = { playlistId: match[1], index: Number(match[2]) }; position = 0; playing = true; paused = false; return send(null, 204); }
    if (route === 'player/pause') { paused = playing || paused; playing = false; return send(null, 204); }
    if (route === 'player/stop') { playing = paused = false; return send(null, 204); }
    if (route === 'player/play') { playing = true; paused = false; return send(null, 204); }
    if (route === 'player') { if (body.volume != null) volume = body.volume; if (body.position != null) position = body.position;
      if (body.options) order = body.options[0].value; return send(null, 204); }
    if (route === 'playqueue') return send({ playQueue: queue.map(q => ({ ...q, columns: columns(lists.find(p => p.id === q.playlistId)?.items[q.itemIndex]) })) });
    if (route === 'playqueue/add') { queue.push({ playlistId: body.plref, itemIndex: body.itemIndex }); return send(null, 204); }
    if (route === 'playqueue/remove') { queue.splice(body.queueIndex, 1); return send(null, 204); }
    if (route === 'playqueue/clear') { queue = []; return send(null, 204); }
    send({ error: `Unhandled ${route}` }, 404);
  });
  const service = createFoobarService({ dataDir, baseUrl: http.baseUrl, fetch: http.fetch,
    pollIntervalMs: 0, verifyTimeoutMs: 180, verifyPollMs: 10, timeoutMs: 500 });
  t.after(async () => { await service.close(); await http.drain(); assert.equal(path.dirname(dataDir), tempParent); assert.ok(path.basename(dataDir).startsWith('still-foobar-test-')); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { service, lists, calls, setFail: value => { fail = value; }, refuseOutput: () => { refuseOutput = true; } };
}

test('v0.10 metadata retains subsong identity and unknown fields', () => {
  const a = trackFromColumns(['C:\\x.flac', '2', 'Title', '', '', '?']);
  assert.equal(a.subsong, 2); assert.equal(a.supported, true); assert.equal(a.duration, null);
  assert.equal(trackFromColumns(['C:\\x.flac', '?']).supported, false);
  assert.equal(COLUMNS[1], '%subsong%');
  assert.throws(() => normalizeLocations([{ path: 'C:\\x.flac', subsong: -1 }]), /索引/);
});
test('volume uses reported dB/linear limits and rejects upDown or malformed ranges', () => {
  assert.equal(normalizedVolume({ type: 'db', min: -100, max: 0, value: -20 }), 0.8);
  assert.equal(backendVolume(0.5, { type: 'linear', min: 10, max: 20, value: 12 }), 15);
  assert.equal(normalizedVolume({ type: 'upDown', min: 0, max: 100, value: 5 }), null);
  assert.throws(() => backendVolume(1, { type: 'upDown' }), /不支持/);
  assert.throws(() => backendVolume(2, { type: 'db' }), /0 到 1/);
});
test('only loopback transport accepted; outputs preserve exact type and device combinations', () => {
  assert.throws(() => createFoobarService({ baseUrl: 'http://192.168.1.1:8880/api/' }), /只允许本机/);
  const result = normalizeOutputs({ active: { typeId: 't1', deviceId: 'same' }, types: [
    { id: 't1', name: 'One', devices: [{ id: 'same', name: 'DAC' }] }, { id: 't2', name: 'Two', devices: [{ id: 'same', name: 'Other' }] }] });
  assert.notEqual(result.outputs[0].id, result.outputs[1].id);
  assert.equal(result.selected.typeId, 't1'); assert.equal(result.selected.configuredExclusive, null);
});
test('initialize/readback does not change volume, DSP, output, playlists or start foobar', async t => {
  const { service, calls } = await fixture(t);
  const state = await service.initialize();
  assert.equal(state.available, true); assert.equal(state.volume, 0.8); assert.equal(state.currentTrack.subsong, 0);
  assert.ok(calls.every(call => call.method === 'GET'));
  const snapshot = await service.librarySnapshot();
  assert.equal(snapshot.playlists[0].items.length, 3);
  assert.deepEqual(snapshot.playlists[0].items.slice(0, 2).map(i => i.subsong), [1, 2]);
  assert.equal(snapshot.mediaLibraryEnumeration, false);
});
test('play copies exact subsongs without changing user lists, and requires progressing playback', async t => {
  const { service, lists, calls } = await fixture(t);
  await service.initialize();
  const state = await service.play({ locations: [source('album.flac', 2), source('album.flac', 1)] });
  assert.equal(state.currentTrack.subsong, 2); assert.equal(state.state, 'playing');
  assert.equal(lists[0].items.length, 3);
  assert.deepEqual(lists[1].items.map(item => item.subsong), [2, 1]);
  assert.equal(calls.filter(call => /\/items\/copy$/.test(call.route))[0].body.items[0], 1);
  assert.ok(!calls.some(call => /clear|remove/.test(call.route)));
  await service.pause(); await service.seek(40); await service.toggle(); await service.stop();
});
test('202 import waits for exact loaded subsong before copying or playing', async t => {
  const { service, calls } = await fixture(t, { delayedLoad: true });
  const state = await service.play({ locations: [source('expanded.flac', 2)] });
  assert.equal(state.currentTrack.subsong, 2);
  const addIndex = calls.findIndex(call => /\/items\/add$/.test(call.route));
  const copyIndex = calls.findIndex(call => /\/items\/copy$/.test(call.route));
  assert.ok(copyIndex > addIndex + 1);
  assert.equal(calls[addIndex].body.replace, false);
});
test('missing subsong and frozen playback never report success after accepted request', async t => {
  const missing = await fixture(t, { neverLoad: true });
  await assert.rejects(missing.service.play({ locations: [source('missing.flac', 7)] }), /精确曲目/);
  assert.ok(!missing.calls.some(call => /\/player\/play\//.test(call.route)));
  const frozen = await fixture(t, { frozen: true });
  await assert.rejects(frozen.service.play({ locations: [source('one.wav')] }), /时间前进/);
});
test('real queue references survive subsequent play; queue controls read back', async t => {
  const { service, lists, calls } = await fixture(t);
  await service.queueAdd([source('album.flac', 2), source('one.wav')]);
  await service.play({ locations: [source('album.flac', 1)] });
  assert.deepEqual((await service.queueList()).items.map(item => item.subsong), [2, 0]);
  assert.equal(lists[0].items.length, 3);
  await service.queueRemove(0);
  assert.equal((await service.queueList()).items[0].path, source('one.wav').path);
  await service.queueClear(); assert.equal((await service.queueList()).items.length, 0);
  assert.ok(!calls.some(call => /playlists.*(clear|remove)/.test(call.route)));
});
test('playback order and volume use actual enum and limits with readback', async t => {
  const { service, calls } = await fixture(t);
  const state = await service.initialize();
  assert.equal(state.playbackOrder.name, 'Default');
  assert.equal((await service.setOrder(2)).playbackOrder.name, 'Shuffle (tracks)');
  assert.deepEqual(calls.find(call => call.body?.options)?.body, { options: [{ id: 'playbackOrder', value: 2 }] });
  await assert.rejects(service.setOrder(7), /实际提供/);
  assert.equal((await service.setVolume(0.4)).volume, 0.4);
  assert.equal(calls.find(call => call.body?.volume != null)?.body.volume, -60);
  assert.equal(normalizeOrders({ playbackMode: 1, playbackModes: ['A', 'B'] }).playbackOrder.name, 'B');
});
test('output selection rejects stale ids and requires selection readback; hardware facts stay unknown', async t => {
  const { service, calls, refuseOutput } = await fixture(t);
  const list = await service.outputs();
  const desired = list.outputs.find(item => item.deviceId === 'dx1-exclusive');
  await service.selectOutput(desired.id);
  assert.deepEqual(calls.find(call => call.route.endsWith('outputs/active')).body, { typeId: 'wasapi', deviceId: 'dx1-exclusive' });
  const details = await service.audioDetails();
  assert.equal(details.configured.configuredExclusive, true);
  assert.equal(details.measured.exclusive, null); assert.equal(details.measured.sampleRate, null);
  await assert.rejects(service.selectOutput('not-present'), /设备已断开/);
  refuseOutput(); await assert.rejects(service.selectOutput(list.outputs[0].id), /输出配置未读回/);
});
test('transient backend reads retain stale state until the failure threshold and genuine responses reconnect', async t => {
  const { service, setFail } = await fixture(t);
  const initial = await service.initialize(); setFail(true);
  for (let count = 1; count <= 2; count++) {
    const degraded = await service.getState();
    assert.equal(degraded.available, true); assert.equal(degraded.backendReachable, false);
    assert.equal(degraded.connectionStatus, 'degraded'); assert.equal(degraded.stale, true);
    assert.equal(degraded.consecutiveReadFailures, count);
    assert.equal(degraded.state, initial.state); assert.equal(degraded.position, initial.position);
    assert.deepEqual(degraded.currentTrack, initial.currentTrack);
    assert.match(degraded.error, /503/);
  }
  const offline = await service.getState();
  assert.equal(offline.available, false); assert.equal(offline.connectionStatus, 'offline');
  assert.equal(offline.consecutiveReadFailures, 3); assert.match(offline.error, /503/);
  await assert.rejects(service.stop(), /503/);
  setFail(false);
  const reconnected = await service.getState();
  assert.equal(reconnected.available, true); assert.equal(reconnected.connectionStatus, 'connected');
  assert.equal(reconnected.stale, false); assert.equal(reconnected.consecutiveReadFailures, 0);
  assert.equal(reconnected.controlUncertain, true, 'read recovery cannot clear the failed physical stop');
});
