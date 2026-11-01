(() => {
  'use strict';
  // Executes ONLY in the genuine, top-level https://music.apple.com page.
  // This intentionally never reads configuration, tokens, cookies, headers,
  // localStorage, SDK internals, stream URLs, license responses or source files.
  let generation = 0;
  let controlGeneration = -1;
  const ID = /^[A-Za-z0-9._-]{1,200}$/;
  const string = value => typeof value === 'string' ? value.slice(0, 500).replace(/[\u0000-\u001f]/g, '') : '';
  const invalid = code => {throw Object.assign(new Error(code), {publicCode: code});};
  function identifier(value) {if (typeof value !== 'string' || !ID.test(value)) invalid('invalid-item'); return value;}
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
  function metadata(raw, fallbackType = 'songs') {
    if (!raw || typeof raw !== 'object') return null;
    const attributes = raw.attributes || raw;
    const params = attributes.playParams || raw.playParams || {};
    const id = string(raw.id || params.id);
    if (!ID.test(id)) return null;
    const declaredType = ['songs', 'albums', 'artists', 'playlists', 'library-songs', 'library-albums', 'library-artists', 'library-playlists'].includes(raw.type) ? raw.type : fallbackType;
    const catalogId = typeof params.catalogId === 'string' && ID.test(params.catalogId) ? params.catalogId : null;
    const songShape = raw.type === 'songs' || raw.type === 'song' ||
      (raw.type === undefined && ['songs', 'library-songs'].includes(fallbackType));
    // Some public MediaItems use a generic/missing type while playParams
    // explicitly identifies a library song. Keep only the normalized type;
    // neither a catalogId alone nor an i.*-looking ID establishes this fact.
    const type = songShape && params.isLibrary === true && params.kind === 'song' && catalogId ? 'library-songs' : declaredType;
    const milliseconds = attributes.durationInMillis;
    return {id, type, title: string(attributes.name || attributes.title) || '未命名', artist: string(attributes.artistName),
      album: string(attributes.albumName), duration: Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds / 1000 : null,
      catalogId, coverUrl: artworkUrl(attributes.artwork?.url), playable: type === 'songs' ? !!attributes.playParams : type === 'library-songs' && !!catalogId};
  }
  function state(music) {
    const track = metadata(music.nowPlayingItem);
    const duration = music.currentPlaybackDuration, position = music.currentPlaybackTime;
    return {authorized: music.isAuthorized === true, isPlaying: music.isPlaying === true,
      playbackState: typeof music.playbackState === 'number' ? music.playbackState : null,
      position: Number.isFinite(position) && position >= 0 ? position : 0,
      duration: Number.isFinite(duration) && duration >= 0 ? duration : track?.duration || 0,
      volume: Number.isFinite(music.volume) ? Math.max(0, Math.min(1, music.volume)) : null,
      // A public library resource may keep its i.* identity after a catalog
      // setQueue. Use only that resource's observed catalogId as the canonical
      // playback identity; never substitute the requested target or a title.
      currentTrack: track, currentTrackId: track?.type === 'library-songs' && track.catalogId ? track.catalogId : track?.id || null,
      fullSongVerified: false};
  }
  function probe(music) {
    return {state: state(music), methods: {
      play: typeof music.play === 'function', pause: typeof music.pause === 'function', stop: typeof music.stop === 'function',
      next: typeof music.skipToNextItem === 'function', previous: typeof music.skipToPreviousItem === 'function',
      seek: typeof music.seekToTime === 'function', setQueue: typeof music.setQueue === 'function',
      apiMusic: typeof music.api?.music === 'function', queue: Array.isArray(music.queue?.items), volume: typeof music.volume === 'number',
    }};
  }
  function namedValues(enumObject, names) {
    if (!enumObject || !['object', 'function'].includes(typeof enumObject)) return null;
    const values = names.map(name => enumObject[name]);
    if (values.some(value => typeof value !== 'number' || !Number.isFinite(value)) || new Set(values).size !== names.length) return null;
    return Object.fromEntries(names.map((name, index) => [name, values[index]]));
  }
  function publicSettingEnums() {return {
    repeatMode: namedValues(window.MusicKit.PlayerRepeatMode, ['none', 'one', 'all']),
    shuffleMode: namedValues(window.MusicKit.PlayerShuffleMode, ['off', 'songs']),
    bitrate: namedValues(window.MusicKit.PlaybackBitrate, ['STANDARD', 'HIGH'])
  };}
  function settingName(value, choices) {return choices ? Object.keys(choices).find(name => choices[name] === value) || null : null;}
  function playbackSettings(music) {
    const enums = publicSettingEnums(); let repeatMode = null, shuffleMode = null, bitrateTarget = null;
    try {repeatMode = settingName(music.repeatMode, enums.repeatMode);} catch {}
    try {shuffleMode = settingName(music.shuffleMode, enums.shuffleMode);} catch {}
    try {const bitrate = settingName(music.bitrate, enums.bitrate); bitrateTarget = bitrate === 'STANDARD' ? 64 : bitrate === 'HIGH' ? 256 : null;} catch {}
    return {authorized: music.isAuthorized === true, repeatMode, shuffleMode, bitrateTarget,
      supported: {repeatMode: repeatMode !== null, shuffleMode: shuffleMode !== null}};
  }
  async function api(music, pathname) {
    if (typeof music.api?.music !== 'function') invalid('official-api-unavailable');
    const response = await music.api.music(pathname);
    if (!response || typeof response.data !== 'object') invalid('official-invalid-response');
    return response.data;
  }
  async function waitForPlaying(music, requestedId, check) {
    // MusicKit's public play() returns void. Its return is not evidence that
    // playback or nowPlayingItem is ready. Keep the native audio gate closed
    // until a later public state confirms this exact requested item.
    const until = Date.now() + 8000;
    do {
      check();
      const value = state(music);
      if (value.isPlaying && value.currentTrackId && (!requestedId || value.currentTrackId === requestedId)) return value;
      if (Date.now() >= until) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (true);
    invalid('official-track-unconfirmed');
  }
  return async function dispatch(input) {
    try {
      if (!input || typeof input !== 'object' || typeof input.method !== 'string') invalid('invalid-input');
      if (input.method === 'settings-write' && input.documentNonce !== undefined && input.documentNonce !== window.__STILL_SETTINGS_DOCUMENT__) invalid('cancelled');
      if (input.controlGeneration !== undefined) {
        int(input.controlGeneration, 0, Number.MAX_SAFE_INTEGER);
        if (input.controlGeneration < controlGeneration) invalid('cancelled');
        if (input.controlGeneration > controlGeneration) {controlGeneration = input.controlGeneration; generation++;}
      }
      if (input.method === 'cancel') {generation++; return {ok: true, value: {cancelled: true}};}
      if (['play', 'resume', 'pause', 'stop'].includes(input.method)) generation++;
      const music = instance();
      const ownGeneration = generation;
      const check = () => {if (ownGeneration !== generation) invalid('cancelled');};
      const limit = input.limit ?? 50, offset = input.offset ?? 0;
      let value;
      if (input.method === 'probe') value = probe(music);
      else if (input.method === 'state') value = state(music);
      else if (input.method === 'settings') value = playbackSettings(music);
      else if (input.method === 'settings-write') {
        if (music.isAuthorized !== true) invalid('needs-auth');
        const patch = input.patch;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) invalid('invalid-input');
        const keys = Reflect.ownKeys(patch);
        if (keys.length !== 1 || !['repeatMode', 'shuffleMode'].includes(keys[0])) invalid('invalid-input');
        const key = keys[0], descriptor = Object.getOwnPropertyDescriptor(patch, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('invalid-input');
        const requested = descriptor.value, enums = publicSettingEnums()[key];
        if (!enums || typeof requested !== 'string' || !Object.hasOwn(enums, requested)) invalid('official-control-unavailable');
        if (playbackSettings(music)[key] === null) invalid('official-control-unavailable');
        check(); music[key] = enums[requested]; check();
        value = playbackSettings(music);
        if (value[key] !== requested) invalid('official-setting-unconfirmed');
      }
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
        if (['songs', 'albums', 'artists', 'playlists'].includes(kind)) {endpoint = `/v1/me/library/${kind}`; type = `library-${kind}`;}
        else if (kind === 'album-songs' || kind === 'playlist-songs') {endpoint = `/v1/me/library/${kind === 'album-songs' ? 'albums' : 'playlists'}/${identifier(input.id)}/tracks`; type = 'library-songs';}
        else if (kind === 'artist-albums') {endpoint = `/v1/me/library/artists/${identifier(input.id)}/albums`; type = 'library-albums';}
        else invalid('invalid-input');
        const data = await api(music, `${endpoint}?limit=${limit}&offset=${offset}`); check();
        if (!Array.isArray(data.data)) invalid('official-invalid-response');
        const items = data.data.slice(0, limit).map(item => metadata(item, type)).filter(Boolean);
        const hasMore = typeof data.next === 'string' && !!data.next;
        value = {kind, items, offset, limit, hasMore, ...(hasMore ? {nextOffset: offset + data.data.length} : {})};
      } else if (input.method === 'queue') {
        int(limit, 1, 200); int(offset, 0, 1000000);
        if (!Array.isArray(music.queue?.items)) invalid('official-queue-unavailable');
        value = {items: music.queue.items.slice(offset, offset + limit).map(item => metadata(item)).filter(Boolean), offset, limit,
          total: music.queue.items.length, position: Number.isSafeInteger(music.queue.position) ? music.queue.position : null,
          hasMore: offset + limit < music.queue.items.length};
      } else {
        if (music.isAuthorized !== true && !['stop', 'pause'].includes(input.method)) invalid('needs-auth');
        if (input.method === 'play') {
          const id = identifier(input.id);
          if (input.kind !== undefined && input.kind !== 'songs') invalid('unsupported-item');
          if (typeof music.setQueue !== 'function' || typeof music.play !== 'function') invalid('official-control-unavailable');
          await music.setQueue({songs: [id]}); check(); await music.play(); check();
          value = await waitForPlaying(music, id, check);
        } else if (input.method === 'resume') {check(); await music.play(); check(); value = await waitForPlaying(music, null, check);}
        else if (input.method === 'pause') {check(); await music.pause(); check();}
        else if (input.method === 'stop') {await music.stop();}
        else if (input.method === 'seek') {check(); await music.seekToTime(numeric(input.position, 0, 86400)); check();}
        else if (input.method === 'volume') {check(); music.volume = numeric(input.volume, 0, 1);}
        else if (input.method === 'next') {check(); await music.skipToNextItem(); check();}
        else if (input.method === 'previous') {check(); await music.skipToPreviousItem(); check();}
        else invalid('unsupported-method');
        value = value || state(music);
      }
      return {ok: true, value};
    } catch (error) {
      const allowed = new Set(['invalid-input', 'invalid-item', 'official-origin-required', 'official-player-not-ready', 'official-api-unavailable',
        'official-invalid-response', 'needs-auth', 'official-queue-unavailable', 'unsupported-item', 'official-control-unavailable', 'official-setting-unconfirmed', 'official-track-unconfirmed', 'unsupported-method', 'cancelled']);
      const code = allowed.has(error?.publicCode) ? error.publicCode : error?.name === 'NotAllowedError' ? 'needs-user-interaction' : 'official-operation-failed';
      return {ok: false, code, ...(code === 'official-player-not-ready' ? {origin: 'bridge-instance'} : {})};
    }
  };
})()
