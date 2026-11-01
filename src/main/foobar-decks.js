'use strict';
// Immutable decks retain queued references; this module owns pins and cleanup.
function createOwnedDecks({request, checkPlayer, playlists, sourceCache, getIdentity, getTransport, getTransportFault, isClosed, hasHandoff, options, notifyError}) {
  const ownedDecks = new Map(), pins = new Map(), pendingDeckTitles = new Map();
  let cleanupPending = null, cleanupTimer = null, ownedDiscovered = false;
  const keepDecks = Number.isInteger(options.keepDecks) ? Math.max(0, options.keepDecks) : 2;
  const cleanupBatchSize = Math.max(1, Math.min(10, options.cleanupBatchSize || 4));
  function pin(id) { pins.set(id, (pins.get(id) || 0) + 1); }
  function unpin(id) { const count = (pins.get(id) || 0) - 1; if (count > 0) pins.set(id, count); else pins.delete(id); }
  function releasePin(id, context) {
    Promise.allSettled([...context.pendingPosts, getTransport()]).then(() => { if (!getTransportFault()) unpin(id); scheduleCleanup(); });
  }
  const deckTitle = title => typeof title === 'string' && title.startsWith('STILL · Playback ') && title.endsWith(`[${getIdentity().instanceId}]`);
  const ownedTitle = title => deckTitle(title) || title === getIdentity().storeTitle;
  // Old STILL instances are excluded from source scans, but can never be deleted
  // by this identity. Avoid rescanning their potentially large immutable decks.
  const anyStillTitle = title => /^STILL · (?:Playback .+|Queue sources) \[[0-9a-f-]{36}\]$/i.test(title || '');
  async function copyRefs(refs, deck, context) {
    let batch = [], sourceId = null;
    async function flush() {
      if (!batch.length) return;
      await request(`playlists/${encodeURIComponent(sourceId)}/${encodeURIComponent(deck.id)}/items/copy`, { items: batch }, { context });
      batch = [];
    }
    for (const ref of refs) {
      // foobar's item selection is a bit mask: arbitrary input order and repeated
      // indexes are not guaranteed by the API. Increasing runs batch safely while
      // preserving occurrences such as [A, B, A] as [A, B] then [A].
      if (batch.length && (ref.playlistId !== sourceId || ref.itemIndex <= batch.at(-1) || batch.length >= 500)) await flush();
      sourceId = ref.playlistId; batch.push(ref.itemIndex);
    }
    await flush();
  }
  function scheduleCleanup() {
    if (hasHandoff()) return;
    if (isClosed() || getTransportFault() || cleanupTimer) return;
    cleanupTimer = setTimeout(() => { cleanupTimer = null; cleanupOwnedDecks().catch(notifyError); }, options.cleanupDelayMs ?? 25);
    cleanupTimer.unref?.();
  }
  async function cleanupOwnedDecks() {
    if (isClosed()) return { removed: [], retained: [...ownedDecks.keys()] };
    if (cleanupPending) return cleanupPending;
    cleanupPending = performCleanup().finally(() => { cleanupPending = null; });
    return cleanupPending;
  }
  async function performCleanup() {
    const current = await playlists(), byId = new Map(current.map(item => [item.id, item]));
    if (!ownedDiscovered) {
      for (const item of current) if (deckTitle(item.title)) ownedDecks.set(item.id, { id: item.id, title: item.title, createdAt: 0 });
      ownedDiscovered = true;
    }
    for (const [id, deck] of ownedDecks) if (byId.get(id)?.title !== deck.title) ownedDecks.delete(id);
    async function protectedIds() {
      const result = await request('query?player=true&playQueue=true');
      checkPlayer(result?.player);
      if (!Array.isArray(result.playQueue)) throw new Error('清理前无法确认播放队列；保留 STILL 播放列表。');
      return new Set([result.player.activeItem?.playlistId, ...result.playQueue.map(item => item.playlistId), ...pins.keys(),
        ...[...ownedDecks.values()].filter(deck => pendingDeckTitles.has(deck.title)).map(deck => deck.id)].filter(Boolean));
    }
    const protectedSet = await protectedIds();
    const candidates = [...ownedDecks.values()].filter(item => !protectedSet.has(item.id)).sort((a, b) => a.createdAt - b.createdAt);
    const remove = candidates.slice(0, Math.max(0, candidates.length - keepDecks)).slice(0, cleanupBatchSize);
    const removed = [];
    for (const deck of remove) {
      // Recheck actual queue and active references immediately before each delete.
      // Never clear a live deck; deleting one item would shift queued indexes.
      if ((await protectedIds()).has(deck.id)) continue;
      const actual = (await playlists()).find(item => item.id === deck.id);
      if (!actual || actual.title !== deck.title || !deckTitle(actual.title) || pins.has(deck.id) || pendingDeckTitles.has(deck.title)) continue;
      await request(`playlists/remove/${encodeURIComponent(deck.id)}`, {});
      ownedDecks.delete(deck.id); sourceCache.delete(deck.id); removed.push(deck.id);
    }
    if (candidates.length - keepDecks > cleanupBatchSize && removed.length) scheduleCleanup();
    return { removed, retained: [...ownedDecks.keys()] };
  }

  return {ownedDecks, pins, pendingDeckTitles, pin, releasePin, deckTitle, ownedTitle, anyStillTitle, copyRefs, scheduleCleanup, cleanupOwnedDecks,
    cancelTimer() {if (cleanupTimer) clearTimeout(cleanupTimer); cleanupTimer = null;}, get pending() {return cleanupPending;}};
}
module.exports = {createOwnedDecks};
