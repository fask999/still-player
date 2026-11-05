(() => {
  'use strict';
  // Executes ONLY in the genuine, top-level https://music.apple.com page.
  // This intentionally never reads configuration, tokens, cookies, headers,
  // localStorage, SDK internals, stream URLs, license responses or source files.
  let generation = 0;
  const ID = /^[A-Za-z0-9._-]{1,200}$/;
  const TYPES = new Set(['songs', 'albums', 'artists', 'playlists', 'music-videos', 'library-songs', 'library-albums', 'library-artists', 'library-playlists']);
  const ALBUM_TRACK_LIMIT = 500;
  const string = value => typeof value === 'string' ? value.slice(0, 500).replace(/[\u0000-\u001f]/g, '') : '';
  const invalid = code => {throw Object.assign(new Error(code), {publicCode: code});};
  function identifier(value) {if (typeof value !== 'string' || !ID.test(value)) invalid('invalid-item'); return value;}
  function pathId(value) {
    if (value === '.' || value === '..') invalid('invalid-item');
    return identifier(value);
  }
  function int(value, minimum, maximum) {if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid('invalid-input'); return value;}
  function numeric(value, minimum, maximum) {if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) invalid('invalid-input'); return value;}
  function instance() {
    if (location.origin !== 'https://music.apple.com' || window.top !== window) invalid('official-origin-required');
    if (typeof window.MusicKit?.getInstance !== 'function') invalid('official-player-not-ready');
    const music = window.MusicKit.getInstance();
    if (!music) invalid('official-player-not-ready');
    return music;
  }
  function artworkUrl(value) {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\\%?#]/.test(value) || /(?:^|\/)\.\.(?:\/|$)/.test(value)) return '';
    try {
      const url = new URL(value.replace(/\{w\}/g, '512').replace(/\{h\}/g, '512'));
      if (url.protocol !== 'https:' || !/^is[1-5]-ssl\.mzstatic\.com$/.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash) return '';
      if (!/^\/image\/thumb\/(?:[A-Za-z0-9._~-]+\/)+512x512(?:bb)?\.(?:jpe?g|png)$/.test(url.pathname)) return '';
      return url.href;
    } catch {return '';}
  }
  function identity(raw, fallbackType = 'songs') {
    if (!raw || typeof raw !== 'object') return null;
    const attributes = raw.attributes || raw;
    const params = attributes.playParams || raw.playParams || {};
    const id = string(raw.id || params.id);
    if (!ID.test(id)) return null;
    const declaredType = TYPES.has(raw.type) ? raw.type : fallbackType;
    const catalogId = typeof params.catalogId === 'string' && ID.test(params.catalogId) ? params.catalogId : null;
    const songShape = raw.type === 'songs' || raw.type === 'song' ||
      (raw.type === undefined && ['songs', 'library-songs'].includes(fallbackType));
    // Some public MediaItems use a generic/missing type while playParams
    // explicitly identifies a library song. Keep only the normalized type;
    // neither a catalogId alone nor an i.*-looking ID establishes this fact.
    const type = songShape && params.isLibrary === true && params.kind === 'song' && catalogId ? 'library-songs' : declaredType;
    return {id, type, catalogId};
  }
  function playbackId(track) {
    return track?.type === 'library-songs' && track.catalogId ? track.catalogId : track?.id || null;
  }
  function metadata(raw, fallbackType) {
    const track = identity(raw, fallbackType);
    if (!track) return null;
    const attributes = raw.attributes || raw;
    const milliseconds = attributes.durationInMillis;
    return {...track, title: string(attributes.name || attributes.title) || '未命名', artist: string(attributes.artistName),
      album: string(attributes.albumName), duration: Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds / 1000 : null,
      coverUrl: artworkUrl(attributes.artwork?.url), playable: track.type === 'songs' ? !!attributes.playParams : track.type === 'library-songs' && !!track.catalogId};
  }
  function queuePosition(queue, items = queue?.items) {
    const position = queue?.position;
    return Array.isArray(items) && Number.isSafeInteger(position) && position >= 0 && position < items.length ? position : null;
  }
  function queueIds(items) {
    return Array.isArray(items) && items.length <= ALBUM_TRACK_LIMIT ? Array.from(items, raw => {
      const track = identity(raw);
      return ['songs', 'library-songs'].includes(track?.type) ? playbackId(track) : null;
    }) : null;
  }
  function sameIds(actual, expected) {
    return actual?.length === expected.length && actual.every((id, index) => id === expected[index]);
  }
  function sameTracks(actual, expected) {
    return actual?.length === expected.length && sameIds([...actual].sort(), [...expected].sort());
  }
  function readOrder(music) {
    try {
      const sdk = window.MusicKit;
      const shuffle = [sdk.PlayerShuffleMode?.off, sdk.PlayerShuffleMode?.songs];
      const repeat = [sdk.PlayerRepeatMode?.none, sdk.PlayerRepeatMode?.all, sdk.PlayerRepeatMode?.one];
      if (![...shuffle, ...repeat].every(Number.isSafeInteger) || new Set(shuffle).size !== 2 || new Set(repeat).size !== 3) return null;
      const shuffleIndex = shuffle.indexOf(music.shuffleMode), repeatIndex = repeat.indexOf(music.repeatMode);
      return shuffleIndex >= 0 && repeatIndex >= 0 ? {id: shuffleIndex * 3 + repeatIndex, shuffle, repeat} : null;
    } catch {return null;}
  }
  function canWrite(music, name) {
    for (let owner = music; owner; owner = Object.getPrototypeOf(owner)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor) return descriptor.writable === true || typeof descriptor.set === 'function';
    }
    return false;
  }
  function canSetOrder(music, order) {
    return !!order && canWrite(music, 'shuffleMode') && canWrite(music, 'repeatMode');
  }
  function state(music, includeQueue = false, order = readOrder(music)) {
    const track = metadata(music.nowPlayingItem);
    const duration = music.currentPlaybackDuration, position = music.currentPlaybackTime;
    const queue = music.queue, items = queue?.items, index = queuePosition(queue, items);
    return {authorized: music.isAuthorized === true, isPlaying: music.isPlaying === true,
      playbackState: typeof music.playbackState === 'number' ? music.playbackState : null,
      position: Number.isFinite(position) && position >= 0 ? position : 0,
      duration: Number.isFinite(duration) && duration >= 0 ? duration : track?.duration || 0,
      volume: Number.isFinite(music.volume) ? Math.max(0, Math.min(1, music.volume)) : null,
      // A public library resource may keep its i.* identity after a catalog
      // setQueue. Use only that resource's observed catalogId as the canonical
      // playback identity; never substitute the requested target or a title.
      currentTrack: track, currentTrackId: playbackId(track), queuePosition: index, playbackOrderId: order?.id ?? null,
      ...(includeQueue ? {queueIds: queueIds(items)} : {}),
      fullSongVerified: false};
  }
  function albumPlaybackAvailable(music) {
    const queue = music.queue;
    return typeof music.api?.music === 'function' && typeof music.setQueue === 'function' && typeof music.play === 'function' &&
      typeof music.changeToMediaAtIndex === 'function' && typeof music.skipToNextItem === 'function' &&
      typeof music.skipToPreviousItem === 'function' && Array.isArray(queue?.items) && 'position' in queue;
  }
  function probe(music, includeQueue) {
    const order = readOrder(music);
    return {state: state(music, includeQueue, order), methods: {
      play: typeof music.play === 'function', pause: typeof music.pause === 'function', stop: typeof music.stop === 'function',
      next: typeof music.skipToNextItem === 'function', previous: typeof music.skipToPreviousItem === 'function',
      seek: typeof music.seekToTime === 'function', setQueue: typeof music.setQueue === 'function',
      apiMusic: typeof music.api?.music === 'function', queue: Array.isArray(music.queue?.items), volume: typeof music.volume === 'number',
      albumPlayback: albumPlaybackAvailable(music), order: canSetOrder(music, order),
    }};
  }
  async function api(music, pathname) {
    if (typeof music.api?.music !== 'function') invalid('official-api-unavailable');
    const response = await music.api.music(pathname);
    if (!response || typeof response.data !== 'object') invalid('official-invalid-response');
    return response.data;
  }
  async function resolveCatalogAlbum(music, id, check) {
    const relationship = await api(music, `/v1/me/library/albums/${id}/catalog`); check();
    if (!Array.isArray(relationship.data) || relationship.data.length > 1 || relationship.next) invalid('official-invalid-response');
    if (relationship.data.length === 0) return null;
    const album = relationship.data[0];
    if (album?.type !== 'albums' || typeof album.id !== 'string' || !ID.test(album.id) || album.id === '.' || album.id === '..') invalid('official-invalid-response');
    const storefront = music.storefrontId;
    if (typeof storefront !== 'string' || !/^[a-z]{2}$/.test(storefront)) invalid('official-api-unavailable');
    const endpoint = `/v1/catalog/${storefront}/albums/${album.id}`;
    let trackCount = album.attributes?.trackCount;
    // Apple relationship responses can contain only resource identifiers.
    // Verify the exact catalog resource if the relationship omitted attributes.
    if (trackCount === undefined) {
      const data = await api(music, endpoint); check();
      if (!Array.isArray(data.data) || data.data.length !== 1 || data.data[0]?.id !== album.id || data.data[0].type !== 'albums') invalid('official-invalid-response');
      trackCount = data.data[0].attributes?.trackCount;
    }
    if (!Number.isSafeInteger(trackCount) || trackCount < 1) invalid('official-invalid-response');
    return {endpoint: `${endpoint}/tracks`, trackCount};
  }
  async function catalogTracksPage(music, album, limit, offset, check) {
    const data = await api(music, `${album.endpoint}?limit=${limit}&offset=${offset}`); check();
    const tracks = data.data;
    if (!Array.isArray(tracks) || tracks.length > limit || Array.from(tracks).some(track =>
      !['songs', 'music-videos'].includes(track?.type) || typeof track.id !== 'string' || !ID.test(track.id))) invalid('official-invalid-response');
    const end = offset + tracks.length;
    let nextOffset;
    if (data.next !== undefined) {
      if (typeof data.next !== 'string' || !data.next.startsWith(`${album.endpoint}?`) || !tracks.length) invalid('official-invalid-response');
      // Only the known catalog relationship is queried. Never forward a URL from the API.
      const next = new URLSearchParams(data.next.slice(album.endpoint.length + 1)).getAll('offset');
      if (next.length !== 1 || next[0] !== String(end)) invalid('official-invalid-response');
      nextOffset = end;
    }
    if (end > album.trackCount || (nextOffset !== undefined) !== (end < album.trackCount)) invalid('official-invalid-response');
    return {tracks, nextOffset};
  }
  function isAlbumSong(track) {
    const params = track.attributes?.playParams;
    return track.type === 'songs' && params?.kind === 'song' && params.id === track.id;
  }
  async function startAlbum(music, id, album, check) {
    if (!album || typeof album !== 'object' || Array.isArray(album)) invalid('invalid-input');
    const libraryId = pathId(album.id), index = int(album.index, 0, ALBUM_TRACK_LIMIT - 1);
    if (!albumPlaybackAvailable(music)) invalid('official-control-unavailable');
    const catalog = await resolveCatalogAlbum(music, libraryId, check);
    if (!catalog || catalog.trackCount > ALBUM_TRACK_LIMIT) invalid('unsupported-item');
    const tracks = [];
    let offset = 0;
    do {
      const page = await catalogTracksPage(music, catalog, 100, offset, check);
      tracks.push(...page.tracks); offset = page.nextOffset;
    } while (offset !== undefined);
    if (tracks[index]?.id !== id) invalid('official-track-unconfirmed');
    if (!tracks.every(isAlbumSong)) invalid('unsupported-item');
    const ids = tracks.map(track => track.id), orderId = readOrder(music)?.id ?? null, shuffled = orderId >= 3;
    if (shuffled && ids.indexOf(id) !== ids.lastIndexOf(id)) invalid('official-track-unconfirmed');
    check();
    // MusicKit Web documents queueing the paginated resource objects and starting
    // a particular occurrence with changeToMediaAtIndex. The native gate stays
    // muted throughout preparation, indexed start and the first full readback.
    await music.setQueue({items: tracks, startPlaying: false}); check();
    const live = queueIds(music.queue?.items);
    if ((readOrder(music)?.id ?? null) !== orderId || !(shuffled ? sameTracks(live, ids) : sameIds(live, ids))) invalid('official-track-unconfirmed');
    const startIndex = shuffled ? live.indexOf(id) : index;
    await music.changeToMediaAtIndex(startIndex);
    check();
    return {...await waitForPlaying(music, id, check, {index, ids, shuffled, orderId}), albumIds: ids};
  }
  async function waitForPlaying(music, requestedId, check, album) {
    // MusicKit's public play() returns void. Its return is not evidence that
    // playback or nowPlayingItem is ready. Keep the native audio gate closed
    // until a later public state confirms this exact requested item.
    const until = Date.now() + 8000;
    do {
      check();
      const value = state(music, !!album);
      if (value.isPlaying && value.currentTrackId && (!requestedId || value.currentTrackId === requestedId) &&
        (!album || (value.playbackOrderId === album.orderId && ['songs', 'library-songs'].includes(value.currentTrack?.type) &&
          (album.shuffled ? value.queueIds?.[value.queuePosition] === requestedId && sameTracks(value.queueIds, album.ids) :
            value.queuePosition === album.index && sameIds(value.queueIds, album.ids))))) return value;
      if (Date.now() >= until) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (true);
    invalid('official-track-unconfirmed');
  }
  function setOrder(music, id, check) {
    const order = readOrder(music);
    if (!canSetOrder(music, order)) invalid('official-control-unavailable');
    const repeat = order.repeat[id % 3], shuffle = order.shuffle[Math.floor(id / 3)];
    const before = music.nowPlayingItem, itemId = playbackId(identity(before));
    const changesShuffle = music.shuffleMode !== shuffle;
    const items = music.queue?.items;
    const ambiguous = changesShuffle && itemId && Array.isArray(items) && items.filter(raw => playbackId(identity(raw)) === itemId).length > 1;
    // If the SDK provides duplicate IDs, a shuffle can only preserve an exact
    // occurrence when the current public MediaItem has a distinct reference.
    if (ambiguous && items.filter(raw => raw === before).length !== 1) invalid('official-track-unconfirmed');
    check();
    if (music.repeatMode !== repeat) music.repeatMode = repeat;
    if (changesShuffle) music.shuffleMode = shuffle;
    check();
    if (itemId && playbackId(identity(music.nowPlayingItem)) !== itemId) invalid('official-track-unconfirmed');
    if (ambiguous && music.queue?.items?.[queuePosition(music.queue)] !== before) invalid('official-track-unconfirmed');
    return state(music);
  }
  return async function dispatch(input) {
    try {
      if (!input || typeof input !== 'object' || typeof input.method !== 'string') invalid('invalid-input');
      if (input.method === 'cancel') {generation++; return {ok: true, value: {cancelled: true}};}
      if (['play', 'resume', 'pause', 'stop'].includes(input.method)) generation++;
      const music = instance();
      const ownGeneration = generation;
      const check = () => {if (ownGeneration !== generation) invalid('cancelled');};
      const limit = input.limit ?? 50, offset = input.offset ?? 0;
      let value;
      if (input.method === 'probe') value = probe(music, input.includeQueue === true);
      else if (input.method === 'state') value = state(music);
      else if (input.method === 'search') {
        int(limit, 1, 25); int(offset, 0, 1000000);
        if (typeof input.term !== 'string' || !input.term.trim() || input.term.length > 200) invalid('invalid-input');
        const types = input.types || ['songs'];
        if (!Array.isArray(types) || !types.length || types.length > 4 || types.some(type => !['songs', 'albums', 'artists', 'playlists'].includes(type))) invalid('invalid-input');
        const storefront = /^[a-z]{2}$/.test(music.storefrontId) ? music.storefrontId : 'cn';
        const query = new URLSearchParams({term: input.term.trim(), types: types.join(','), limit: String(limit), offset: String(offset)});
        const data = await api(music, `/v1/catalog/${storefront}/search?${query}`); check();
        if (!data.results || typeof data.results !== 'object') invalid('official-invalid-response');
        const groups = types.map(type => {
          const group = data.results[type];
          if (group && !Array.isArray(group.data)) invalid('official-invalid-response');
          return {type, items: (group?.data || []).slice(0, limit).map(item => metadata(item, type)).filter(Boolean), hasMore: typeof group?.next === 'string' && !!group.next};
        });
        const hasMore = groups.some(group => group.hasMore);
        value = {kind: types.length === 1 ? types[0] : 'search', items: groups.flatMap(group => group.items), groups, offset, limit, hasMore,
          ...(hasMore ? {nextOffset: offset + limit} : {})};
      } else if (input.method === 'library') {
        if (music.isAuthorized !== true) invalid('needs-auth');
        int(limit, 1, 100); int(offset, 0, 1000000);
        const kind = input.kind || 'songs';
        let endpoint, type;
        let album;
        if (['songs', 'albums', 'artists', 'playlists'].includes(kind)) {endpoint = `/v1/me/library/${kind}`; type = `library-${kind}`;}
        else if (kind === 'album-songs') {
          const id = pathId(input.id);
          album = await resolveCatalogAlbum(music, id, check);
          endpoint = `/v1/me/library/albums/${id}/tracks`; type = 'library-songs';
        }
        else if (kind === 'playlist-songs') {endpoint = `/v1/me/library/playlists/${identifier(input.id)}/tracks`; type = 'library-songs';}
        else if (kind === 'artist-albums') {endpoint = `/v1/me/library/artists/${identifier(input.id)}/albums`; type = 'library-albums';}
        else invalid('invalid-input');
        if (album) {
          const {tracks, nextOffset} = await catalogTracksPage(music, album, limit, offset, check);
          value = {kind, items: tracks.map(track => metadata(track)), offset, limit, total: album.trackCount,
            albumPlayback: album.trackCount <= ALBUM_TRACK_LIMIT && tracks.every(isAlbumSong),
            hasMore: nextOffset !== undefined, ...(nextOffset !== undefined ? {nextOffset} : {})};
        } else {
          const data = await api(music, `${endpoint}?limit=${limit}&offset=${offset}`); check();
          if (!Array.isArray(data.data)) invalid('official-invalid-response');
          const items = data.data.slice(0, limit).map(item => metadata(item, type)).filter(Boolean);
          const hasMore = typeof data.next === 'string' && !!data.next;
          value = {kind, items, offset, limit, hasMore, ...(hasMore ? {nextOffset: offset + data.data.length} : {}),
            ...(kind === 'album-songs' ? {albumPlayback: false} : {})};
        }
      } else if (input.method === 'queue') {
        int(limit, 1, 200); int(offset, 0, 1000000);
        const queue = music.queue, entries = queue?.items;
        if (!Array.isArray(entries)) invalid('official-queue-unavailable');
        const items = Array.from(entries.slice(offset, offset + limit), item => metadata(item));
        if (items.includes(null)) invalid('official-invalid-response');
        value = {items, offset, limit, total: entries.length, position: queuePosition(queue, entries), hasMore: offset + limit < entries.length};
      } else {
        if (music.isAuthorized !== true && !['stop', 'pause'].includes(input.method)) invalid('needs-auth');
        if (input.method === 'play') {
          const id = identifier(input.id);
          if (input.kind !== undefined && input.kind !== 'songs') invalid('unsupported-item');
          if (typeof music.setQueue !== 'function' || typeof music.play !== 'function') invalid('official-control-unavailable');
          if (input.album !== undefined) value = await startAlbum(music, id, input.album, check);
          else {
            await music.setQueue({songs: [id]}); check(); await music.play(); check();
            value = await waitForPlaying(music, id, check);
          }
        } else if (input.method === 'resume') {check(); await music.play(); check(); value = await waitForPlaying(music, null, check);}
        else if (input.method === 'pause') {check(); await music.pause(); check();}
        else if (input.method === 'stop') {await music.stop();}
        else if (input.method === 'seek') {check(); await music.seekToTime(numeric(input.position, 0, 86400)); check();}
        else if (input.method === 'volume') {check(); music.volume = numeric(input.volume, 0, 1);}
        else if (input.method === 'order') value = setOrder(music, int(input.order, 0, 5), check);
        else if (input.method === 'next') {check(); await music.skipToNextItem(); check();}
        else if (input.method === 'previous') {check(); await music.skipToPreviousItem(); check();}
        else invalid('unsupported-method');
        value = value || state(music);
      }
      return {ok: true, value};
    } catch (error) {
      const allowed = new Set(['invalid-input', 'invalid-item', 'official-origin-required', 'official-player-not-ready', 'official-api-unavailable',
        'official-invalid-response', 'needs-auth', 'official-queue-unavailable', 'unsupported-item', 'official-control-unavailable', 'official-track-unconfirmed', 'unsupported-method', 'cancelled']);
      const code = allowed.has(error?.publicCode) ? error.publicCode : error?.name === 'NotAllowedError' ? 'needs-user-interaction' : 'official-operation-failed';
      return {ok: false, code, ...(code === 'official-player-not-ready' ? {origin: 'bridge-instance'} : {})};
    }
  };
})()
