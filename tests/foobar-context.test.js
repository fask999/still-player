'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
// Injected fetch only: no sockets, initialization, helpers or audio devices.
const test = require('node:test');
const assert = require('node:assert/strict');
const {createFoobarService} = require('../src/main/foobar');
const columns = (name, subsong = 0) => [`E:\\Music\\${name}.flac`, String(subsong), name, 'Artist', 'Album', '180'];
function fixture(t, options = {}) {
  const calls = [], items = [columns('Duplicate'), columns('Other'), columns('Duplicate')]; let queries = 0, pages = 0, probes = 0;
  const fetch = async (input, init) => {
    const url = new URL(input), route = url.pathname.replace('/api/', ''); calls.push([route, init, url.searchParams]);
    assert.equal(init.method, 'GET');
    if (options.fetch) return options.fetch(url, init);
    let value;
    if (route === 'query') {
      queries++; options.onQuery?.({queries, items});
      const index = options.finalIndex !== undefined && queries > 1 ? options.finalIndex : 2;
      value = {player: {info: {name: 'foobar2000', pluginVersion: '0.10'}, playbackState: 'playing', activeItem: {playlistId: 'real', index, columns: items[index]}},
        playlists: [{id: 'ui-selected', title: 'Unrelated UI selection', isCurrent: true, itemCount: 99}, {id: 'real', title: 'Actually playing', isCurrent: false, itemCount: options.total ?? items.length}]};
    } else {
      const match = /^playlists\/real\/items\/(\d+):(\d+)$/.exec(route); assert.ok(match, route);
      pages++; options.onPage?.({pages, items}); const offset = Number(match[1]), count = Number(match[2]);
      value = {playlistItems: {offset, totalCount: items.length, items: items.slice(offset, offset + count).map(row => ({columns: row}))}};
    }
    return new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
  };
  const service = createFoobarService({fetch, pollIntervalMs: 0, probeOutputState: () => {probes++; throw new Error('No device probe allowed');}});
  t.after(() => service.close());
  return {service, calls, items, probes: () => probes};
}
test('context follows the real active playlist rather than isCurrent or playqueue, preserving duplicate occurrences', async t => {
  const f = fixture(t), result = await f.service.playbackContext({pageSize: 2});
  assert.equal(result.status, 'ready'); assert.deepEqual(result.playlist, {id: 'real', name: 'Actually playing'});
  assert.equal(result.currentIndex, 2); assert.deepEqual(result.items.map(item => item.itemIndex), [0, 1, 2]);
  assert.equal(result.items[0].path, result.items[2].path); assert.equal(f.probes(), 0);
  assert.equal(f.calls.filter(([route]) => route === 'query').length, 2); assert.equal(f.calls.filter(([route]) => route.startsWith('playlists/')).length, 4);
  for (const [route,, params] of f.calls) {assert.equal(route.includes('playqueue'), false); assert.equal(params.has('outputs'), false);}
});
test('same-count content edits and an active occurrence change fail the double-read validation', async t => {
  const changed = fixture(t, {onPage: ({pages, items}) => {if (pages === 2) items[1] = columns('Replaced');}});
  assert.equal((await changed.service.playbackContext()).reason, 'context-changed');
  const moved = fixture(t, {finalIndex: 0}), result = await moved.service.playbackContext();
  assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'context-changed'); assert.deepEqual(result.items, []); assert.equal(result.currentIndex, null);
});
test('oversized contexts stop before page reads and metadata identity changes are not reported as ready', async t => {
  const large = fixture(t, {total: 501}), result = await large.service.playbackContext();
  assert.equal(result.reason, 'context-too-large'); assert.equal(large.calls.length, 1);
  const changed = fixture(t, {onQuery: ({queries, items}) => {if (queries === 2) items[2] = columns('Different active file');}});
  assert.equal((await changed.service.playbackContext()).status, 'unknown');
  await assert.rejects(large.service.playbackContext({maxItems: 501}), /limits/);
});
test('context cancellation aborts only read transport and returns a fixed reason without raw errors', async t => {
  let received;
  const f = fixture(t, {fetch: (_url, init) => {received = init; return new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('PRIVATE_CONNECTION_FIXTURE')), {once: true});
  });}});
  const controller = new AbortController(), pending = f.service.playbackContext({signal: controller.signal});
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  const result = await pending; assert.equal(result.reason, 'context-timeout'); assert.deepEqual(result.items, []);
  assert.equal(received.signal.aborted, true); assert.equal(JSON.stringify(result).includes('PRIVATE_CONNECTION_FIXTURE'), false); assert.equal(f.probes(), 0);
});

test('a context response arriving after its bridge closes cannot become a ready snapshot', async t => {
  let release, entered;
  const gate = new Promise(resolve => {release = resolve;}), started = new Promise(resolve => {entered = resolve;});
  const f = fixture(t, {fetch: async () => {entered(); await gate; return new Response(JSON.stringify({player: {
    info: {name: 'foobar2000', pluginVersion: '0.10'}, playbackState: 'playing', activeItem: {playlistId: 'real', index: 0, columns: columns('Track')}},
    playlists: [{id: 'real', title: 'Actual list', itemCount: 1}]}));}});
  const pending = f.service.playbackContext(); await started; await f.service.close(); release();
  const result = await pending; assert.equal(result.status, 'unavailable'); assert.deepEqual(result.items, []); assert.equal(f.calls.length, 1);
});
