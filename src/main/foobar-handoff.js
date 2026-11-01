'use strict';
const {validateSnapshot, contextIdentity, handoffError} = require('./owned-output-handoff');
// Read-only double snapshots preserve playlist occurrences and preferences.
function createHandoffSnapshots({request, COLUMNS, checkPlayer, normalizeOutputs, endpointForOutput, normalizeOrders, playlists, itemPage, locationKey, trackFromColumns}) {
  async function handoffSnapshot(context) {
    context?.check?.();
    const result = await request(`query?player=true&outputs=true&playQueue=true&trcolumns=${encodeURIComponent(COLUMNS.join(','))}`, undefined, {context});
    checkPlayer(result?.player);
    if (!Array.isArray(result.playQueue)) throw handoffError('STILL_HANDOFF_QUEUE_UNKNOWN', '临时队列未完整回读；保留队列和内核。');
    if (result.playQueue.length) throw handoffError('STILL_HANDOFF_QUEUE_NOT_EMPTY', '临时队列非空；保留完整队列，当前不允许退出内核交接。');
    const player = result.player, active = player.activeItem, output = normalizeOutputs(result.outputs).selected;
    const endpoint = endpointForOutput(output);
    if (!endpoint) throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '当前输出未完整核验；未退出。');
    const prefs = {queue: [], output: {typeId: output.typeId, deviceId: output.deviceId, name: output.name || '', typeName: output.typeName || ''}, endpoint,
      volume: {type: player.volume?.type, min: player.volume?.min, max: player.volume?.max, value: player.volume?.value}, order: normalizeOrders(player).playbackOrder?.id, playbackState: player.playbackState};
    const lists = await playlists(context);
    if (active === null && player.playbackState === 'stopped') {
      if (lists.length > 50 || lists.some(row => !Number.isInteger(row.itemCount) || row.itemCount < 0) || lists.reduce((sum, row) => sum + row.itemCount, 0) > 500) throw handoffError('STILL_HANDOFF_SNAPSHOT_TOO_LARGE', '无当前曲的完整列表保全超过上限；未退出。');
      const saved = [];
      for (const list of lists) saved.push({id: list.id, name: list.title, items: await snapshotItems(list)});
      return validateSnapshot({schemaVersion: 1, contextMode: 'none', playlistId: null, playlistName: null, currentIndex: null, items: [], playlists: saved, ...prefs});
    }
    if (!active || typeof active.playlistId !== 'string' || !Number.isSafeInteger(active.index)) throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '当前播放列表引用未完整核验；未退出。');
    const matching = lists.filter(row => row.id === active.playlistId);
    if (matching.length !== 1 || !Number.isInteger(matching[0].itemCount) || matching[0].itemCount < 1 || matching[0].itemCount > 500) throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '当前列表为空、过大或引用不唯一；未退出。');
    async function snapshotItems(list) {
    const rows = [], counts = new Map();
    while (rows.length < list.itemCount) {
      const count = Math.min(100, list.itemCount - rows.length);
      const page = await itemPage(list.id, rows.length, count, context);
      if (page.total !== list.itemCount || !page.items.length || page.items.length > count) throw handoffError('STILL_HANDOFF_CONTEXT_CHANGED', '交接列表分页已改变或超限；未继续读取或退出。');
      rows.push(...page.items);
    }
    if (rows.length !== list.itemCount || !rows.every(row => row.supported)) throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '列表曲目或子曲身份不完整；未退出。');
    return rows.map(row => {
      const key = locationKey(row), occurrence = counts.get(key) || 0; counts.set(key, occurrence + 1);
      return {path: row.path, subsong: row.subsong, occurrence};
    });
    }
    const items = await snapshotItems(matching[0]);
    if (locationKey(items[active.index] || {}) !== locationKey(trackFromColumns(active.columns))) throw handoffError('STILL_HANDOFF_CONTEXT_CHANGED', '当前曲与有序列表不一致；未退出。');
    return validateSnapshot({schemaVersion: 1, contextMode: 'active', playlistId: active.playlistId, playlistName: matching[0].title,
      currentIndex: active.index, items, ...prefs});
  }
  async function stableHandoffSnapshot(context) {
    const first = await handoffSnapshot(context), second = await handoffSnapshot(context);
    if (first.playlistId !== second.playlistId || contextIdentity(first) !== contextIdentity(second)) throw handoffError('STILL_HANDOFF_CONTEXT_CHANGED', '交接双次回读内容已改变；保留现有上下文，未退出。');
    return second;
  }

  return {stableHandoffSnapshot};
}
module.exports = {createHandoffSnapshots};
