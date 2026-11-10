'use strict';

(() => {
  const sources = ['library', 'metadata'];
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const validId = value => typeof value === 'string' && value.length > 0;
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const visibleFields = ['title', 'artist', 'album', 'albumArtist', 'duration', 'discNumber', 'trackNumber', 'year', 'valid', 'supported', 'path', 'subsong'];
  function cursor(value) { return record(value) && validId(value.streamId) && value.streamId.length <= 128 && integer(value.sequence) ? {streamId: value.streamId, sequence: value.sequence} : null; }
  function eventIdentity(value) {
    if (typeof value !== 'string') return null;
    const parts = value.split(':');
    if (parts.length !== 3 || !sources.includes(parts[0]) || !parts[1] || parts[1].length > 128 || !/^[1-9]\d*$/.test(parts[2])) return null;
    const sequence = Number(parts[2]); return integer(sequence) ? {source: parts[0], streamId: parts[1], sequence} : null;
  }
  function createLibraryState({fetchSnapshot, onChange = () => {}, onError = () => {}, maxBuffered = 64} = {}) {
    let value = {tracks: [], playlists: [], folders: []}, initialized = false, byId = new Map(), positions = new Map();
    let cursors = {library: null, metadata: null}, rejected = {library: null, metadata: null}, pending = [], syncing = null, needsSync = false, disposed = false, installFailure = null;
    const revision = () => integer(value.revision) ? value.revision : null;
    const copyLists = lists => lists.map(list => ({...list, ...(Array.isArray(list.trackIds) ? {trackIds: [...list.trackIds]} : {})}));
    function publish(change) { onChange(value, change); }
    function install(snapshot, authoritative = false) {
      installFailure = 'invalid';
      if (!record(snapshot) || !Array.isArray(snapshot.tracks) || !Array.isArray(snapshot.playlists)) return false;
      if (!snapshot.tracks.every(track => record(track) && validId(track.id)) || new Set(snapshot.tracks.map(track => track.id)).size !== snapshot.tracks.length) return false;
      const nextRevision = integer(snapshot.revision) ? snapshot.revision : null;
      if (revision() !== null && (nextRevision === null || nextRevision < revision())) { installFailure = 'stale'; return false; }
      const nextCursors = Object.fromEntries(sources.map(source => [source, cursor(snapshot.eventCursors?.[source])]));
      if (nextRevision !== null && sources.some(source => !nextCursors[source])) return false;
      if (initialized) for (const source of sources) {
        const prior = cursors[source], next = nextCursors[source];
        if (prior && next && prior.streamId === next.streamId && next.sequence < prior.sequence) { installFailure = 'stale'; return false; }
      }
      if (initialized && !authoritative && sources.some(source => cursors[source] && nextCursors[source] && cursors[source].streamId !== nextCursors[source].streamId)) { installFailure = 'stream'; return false; }
      const tracks = snapshot.tracks.map(track => ({...track}));
      byId = new Map(tracks.map(track => [track.id, track])); positions = new Map(tracks.map((track, index) => [track.id, index]));
      value = {...snapshot, tracks, playlists: copyLists(snapshot.playlists), folders: Array.isArray(snapshot.folders) ? [...snapshot.folders] : [], ...(record(snapshot.status) ? {status: {...snapshot.status}} : {})};
      cursors = nextCursors; value.eventCursors = Object.fromEntries(sources.filter(source => cursors[source]).map(source => [source, {...cursors[source]}]));
      initialized = true; installFailure = null;
      publish({full: true, structural: true, changedTrackIds: tracks.map(track => track.id), coverTrackIds: tracks.map(track => track.id), playlistsChanged: true, statusChanged: true});
      return true;
    }
    function buffered(event) {
      if (pending.some(item => item.eventId === event.eventId)) return;
      if (pending.length >= maxBuffered) { pending = []; needsSync = true; }
      pending.push(event);
    }
    function requestSync(event) {
      if (event) buffered(event);
      needsSync = true;
      if (syncing || disposed) return;
      syncing = Promise.resolve().then(async () => {
        let attempts = 0;
        while (needsSync && !disposed && attempts++ < 2) {
          needsSync = false;
          let snapshot;
          try { snapshot = await fetchSnapshot(); } catch { onError('音乐库暂时无法重新读取'); pending = []; break; }
          if (disposed) break;
          const installed = install(snapshot, true);
          if (!installed && installFailure !== 'stale') { onError('音乐库同步数据不可用'); pending = []; break; }
          const queue = pending; pending = [];
          for (const event of queue) ingestDelta(event, true);
        }
        if (needsSync && !disposed) { needsSync = false; pending = []; onError('音乐库同步尚未完成，请刷新'); }
      }).finally(() => { syncing = null; });
    }
    function ingestDelta(delta, replaying = false) {
      const identity = eventIdentity(delta.eventId);
      if (!identity) { if (!replaying) requestSync(); return false; }
      const {source, streamId, sequence} = identity, current = cursors[source];
      if (!current || current.streamId !== streamId) {
        if (rejected[source] === streamId) return false;
        if (replaying) { rejected[source] = streamId; return false; }
        requestSync(delta); return false;
      }
      if (sequence <= current.sequence) return false;
      if (syncing && !replaying) { buffered(delta); return false; }
      if (sequence !== current.sequence + 1) { requestSync(delta); return false; }
      if (!integer(delta.baseRevision) || !integer(delta.revision) || (delta.revision !== delta.baseRevision && delta.revision !== delta.baseRevision + 1)) { requestSync(); return false; }
      if (source === 'metadata' && delta.revision !== delta.baseRevision) { requestSync(); return false; }
      if (source === 'metadata' && revision() !== null && delta.revision < revision()) {
        current.sequence = sequence; value.eventCursors = {...value.eventCursors, [source]: {...current}};
        requestSync(); return false;
      }
      if (delta.revision < revision() || (delta.revision === revision() && delta.baseRevision < revision())) {
        current.sequence = sequence; value.eventCursors = {...value.eventCursors, [source]: {...current}}; return false;
      }
      if (revision() === null || delta.baseRevision !== revision()) { requestSync(delta); return false; }
      const upserts = delta.tracks, removed = delta.removedTrackIds;
      const sameRevision = delta.revision === delta.baseRevision;
      if (!Array.isArray(upserts) || !upserts.every(track => record(track) && validId(track.id)) || new Set(upserts.map(track => track.id)).size !== upserts.length || !Array.isArray(removed) || !removed.every(validId) || new Set(removed).size !== removed.length) { requestSync(); return false; }
      if (sameRevision && (removed.length || delta.trackIds !== undefined || delta.playlists !== undefined || delta.folders !== undefined || upserts.some(track => !byId.has(track.id)))) { requestSync(); return false; }
      const membershipChanged = removed.length > 0 || upserts.some(track => !byId.has(track.id));
      if (membershipChanged && !Array.isArray(delta.trackIds)) { requestSync(); return false; }
      if ((delta.playlists !== undefined && !Array.isArray(delta.playlists)) || (delta.folders !== undefined && !Array.isArray(delta.folders)) || (delta.status !== undefined && !record(delta.status))) { requestSync(); return false; }
      let nextMap = byId, ordered = null;
      if (delta.trackIds !== undefined) {
        if (!Array.isArray(delta.trackIds) || !delta.trackIds.every(validId) || new Set(delta.trackIds).size !== delta.trackIds.length) { requestSync(); return false; }
        nextMap = new Map(byId); removed.forEach(id => nextMap.delete(id)); upserts.forEach(track => nextMap.set(track.id, {...track}));
        if (nextMap.size !== delta.trackIds.length || delta.trackIds.some(id => !nextMap.has(id))) { requestSync(); return false; }
        ordered = delta.trackIds.map(id => nextMap.get(id));
      }
      const changedTrackIds = [], coverTrackIds = []; let structural = !!ordered;
      for (const track of upserts) {
        const before = byId.get(track.id); changedTrackIds.push(track.id);
        if (!before || ['coverUrl', 'coverThumbnailUrl', 'coverLargeUrl'].some(field => before[field] !== track[field])) coverTrackIds.push(track.id);
        if (!before || visibleFields.some(field => before[field] !== track[field])) structural = true;
      }
      if (ordered) { byId = nextMap; positions = new Map(ordered.map((track, index) => [track.id, index])); }
      else for (const track of upserts) { const owned = {...track}; byId.set(track.id, owned); value.tracks[positions.get(track.id)] = owned; }
      current.sequence = sequence;
      const statusChanged = delta.status !== undefined && ['status', 'readOnly', 'recovered', 'backupPath', 'message'].some(field => value.status?.[field] !== delta.status[field]);
      value = {...value, tracks: ordered || value.tracks, revision: delta.revision, eventCursors: {...value.eventCursors, [source]: {...current}},
        ...(delta.playlists !== undefined ? {playlists: copyLists(delta.playlists)} : {}), ...(delta.folders !== undefined ? {folders: [...delta.folders]} : {}), ...(delta.status !== undefined ? {status: {...delta.status}} : {})};
      publish({full: false, structural, changedTrackIds, coverTrackIds, playlistsChanged: delta.playlists !== undefined, foldersChanged: delta.folders !== undefined, statusChanged});
      return true;
    }
    return {
      receive(input) {
        if (disposed || !record(input)) return false;
        if (input.kind === 'library-delta') return ingestDelta(input);
        if (install(input, !initialized)) return true;
        const unknownStream = sources.some(source => cursors[source] && cursor(input.eventCursors?.[source]) && cursors[source].streamId !== input.eventCursors[source].streamId);
        if (!integer(input.revision) || revision() === null || input.revision > revision() || unknownStream) requestSync();
        return false;
      },
      snapshot: () => value,
      getTrack: id => byId.get(id),
      whenSettled: () => syncing || Promise.resolve(),
      resync: () => requestSync(),
      dispose() { disposed = true; pending = []; }
    };
  }
  const api = {createLibraryState, eventIdentity};
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window.StillModules ||= []).push({name: 'libraryState', create: () => api});
})();
