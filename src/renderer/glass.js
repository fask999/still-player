'use strict';

/* Code-native materials. The scene only displays library data; it never owns audio. */
(() => {
  const DEFAULT_ACCENT = '#A8B9FF';
  const PRESETS = [['月白', '#C7D1E1'], ['鸢尾', DEFAULT_ACCENT], ['冰川', '#83D7E8'], ['青瓷', '#92D5BC'], ['香槟', '#E5C49B'], ['珊瑚', '#F2A89D'], ['蔷薇', '#E3A7CB'], ['紫雾', '#C4AEF3']];
  const normalize = value => typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value) ? value.toUpperCase() : null;
  function layoutMode(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'wide';
    return height >= width ? 'portrait' : width <= 720 ? 'compact' : 'wide';
  }
  const rgb = value => [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16));
  const hex = values => '#' + values.map(value => Math.round(value).toString(16).padStart(2, '0')).join('').toUpperCase();
  function luminance(value) {
    const linear = rgb(value).map(channel => { const c = channel / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  }
  function contrast(first, second) { const a = luminance(first), b = luminance(second); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }
  function deriveAccent(value) {
    const raw = normalize(value) || DEFAULT_ACCENT, components = rgb(raw);
    // Conservative upper bound for the composited dark glass surfaces.
    let readable = raw;
    for (let step = 1; contrast(readable, '#465161') < 4.5 && step <= 100; step++) readable = hex(components.map(c => c + (255 - c) * step / 100));
    const ink = contrast(raw, '#11151D') >= 4.5 ? '#11151D' : contrast(raw, '#FFFFFF') >= 4.5 ? '#FFFFFF' : '#000000';
    return {raw, readable, ink, rgb: components.join(', '), readableRgb: rgb(readable).join(', ')};
  }
  function createAccentController({initial = DEFAULT_ACCENT, initialMode = 'color', save, paint, onCommit = () => {}, onError = () => {}}) {
    let committed = normalize(initial) || DEFAULT_ACCENT, draft = committed, committedMode = initialMode === 'none' ? 'none' : 'color', draftMode = committedMode, sequence = 0, pending = null, running = null;
    function preview(value, mode = draftMode) { const color = normalize(value); if (!color || !['none', 'color'].includes(mode)) return false; sequence++; draft = color; draftMode = mode; paint(color, mode); return true; }
    async function drain() {
      if (running) return;
      while (pending) {
        const intent = pending; pending = null; running = intent;
        let result = null;
        try { result = await save(intent.color, intent.mode); } catch { /* Restore both confirmed appearance fields. */ }
        const color = normalize(result?.appearance?.accentColor);
        if (color) { committed = color; committedMode = result.appearance.accentMode === 'none' ? 'none' : 'color'; onCommit(color, result, committedMode); }
        if (intent.sequence === sequence) { draft = committed; draftMode = committedMode; paint(committed, committedMode); if (!color) onError(); }
        running = null;
      }
    }
    return {
      preview,
      commit(value, mode = draftMode) { if (!preview(value, mode)) return false; pending = {color: draft, mode: draftMode, sequence}; void drain(); return true; },
      commitMode(mode) { const color = (pending || running)?.color || committed; if (!preview(color, mode)) return false; pending = {color: draft, mode: draftMode, sequence}; void drain(); return true; },
      receive(value, mode = 'color') { const color = normalize(value) || DEFAULT_ACCENT; mode = mode === 'none' ? 'none' : 'color'; if (!running && !pending) { const editing = draft !== committed || draftMode !== committedMode; committed = color; committedMode = mode; if (!editing) { draft = color; draftMode = mode; paint(color, mode); } } },
      cancelPreview() { const intent = pending || running; sequence = intent ? intent.sequence : sequence + 1; draft = intent?.color || committed; draftMode = intent?.mode || committedMode; paint(draft, draftMode); },
      snapshot: () => ({committed, draft, busy: !!running || !!pending}),
      snapshotTheme: () => ({committed: {accentColor: committed, accentMode: committedMode}, draft: {accentColor: draft, accentMode: draftMode}, busy: !!running || !!pending})
    };
  }
  function createBackdropController({load, commit, clear, settle = () => {}}) {
    let revision = 0, desiredKey = '', desiredUrl = '', activeUrl = '', failedUrl = '', reduced = false;
    const pending = new Map();
    function decoded(url) {
      if (!pending.has(url)) {
        const task = Promise.resolve().then(() => load(url)); pending.set(url, task);
        task.then(() => { if (pending.get(url) === task) pending.delete(url); }, () => { if (pending.get(url) === task) pending.delete(url); });
      }
      return pending.get(url);
    }
    return {
      update({key = '', url = '', reducedMotion = false, retry = false}) {
        reduced = !!reducedMotion;
        if (reduced) settle();
        if (key === desiredKey && url === desiredUrl && !(retry && url && url === failedUrl)) return;
        desiredKey = key; desiredUrl = url;
        const token = ++revision; failedUrl = '';
        if (!url) { activeUrl = ''; clear({immediate: reduced}); return; }
        if (url === activeUrl) return;
        decoded(url).then(image => {
          if (token !== revision || key !== desiredKey || url !== desiredUrl) return;
          activeUrl = url; commit(image, {url, immediate: reduced});
        }, () => {
          if (token !== revision || key !== desiredKey || url !== desiredUrl) return;
          activeUrl = ''; failedUrl = url; clear({immediate: reduced});
        });
      },
      snapshot: () => ({key: desiredKey, desiredUrl, activeUrl, failedUrl, reducedMotion: reduced})
    };
  }
  function createSleeveGesture({commit, preview = () => {}, now = () => Date.now()}) {
    let active = null, suppressUntil = 0;
    const reset = suppress => { if (suppress) suppressUntil = now() + 400; active = null; preview(0, false); };
    return {
      start({pointerId, x, y, width, key, primary = true, button = 0}) {
        if (!primary || button !== 0 || !key || !(width > 0)) { reset(!!active); return false; }
        suppressUntil = 0; active = {pointerId, x, y, width, key, dx: 0, dy: 0, axis: null}; return true;
      },
      move({pointerId, x, y}) {
        if (!active || active.pointerId !== pointerId) return false;
        const dx = x - active.x, dy = y - active.y; active.dx = dx; active.dy = dy;
        if (!active.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 9) {
          if (Math.abs(dy) > Math.abs(dx) * 1.15) active.axis = 'vertical';
          else if (Math.abs(dx) > Math.abs(dy) * 1.3) active.axis = 'horizontal';
        }
        if (active.axis !== 'horizontal') return false;
        preview(Math.max(-active.width * .22, Math.min(active.width * .22, dx)) * .65, true); return true;
      },
      end({pointerId, key}) {
        if (!active || active.pointerId !== pointerId) return false;
        const state = active, dragged = Math.max(Math.abs(state.dx), Math.abs(state.dy)) >= 9;
        const accepted = key === state.key && state.axis === 'horizontal' && Math.abs(state.dx) >= Math.max(48, state.width * .13) && Math.abs(state.dx) >= Math.abs(state.dy) * 1.3;
        reset(dragged);
        if (accepted) commit(state.dx < 0 ? 'next' : 'previous', state.key);
        return accepted;
      },
      cancel() { reset(!!active && Math.max(Math.abs(active.dx), Math.abs(active.dy)) >= 9); },
      cancelIfChanged(key) { if (active && active.key !== key) this.cancel(); },
      consumeClick(detail = 1) { if (detail > 0 && now() < suppressUntil) { suppressUntil = 0; return true; } return false; },
      snapshot: () => active && {...active}
    };
  }
  function createSpectrumController({paint, now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout}) {
    let player = null, key = null, epoch = 0, timer = null, version = 0, stream = null, sequence = -1, deadline = 0, visible = false;
    const retired = new Set(), lifetimes = new Map();
    const identity = value => value?.source === 'local' && value.available === true && value.state === 'playing' && typeof (value.currentTrackId || value.currentTrack?.id) === 'string' && (value.currentTrackId || value.currentTrack?.id) && Number.isSafeInteger(value.generation) && value.generation >= 0 ? JSON.stringify(['local', value.currentTrackId || value.currentTrack.id, value.generation]) : null;
    function flat() { if (timer !== null) cancel(timer); timer = null; version++; if (visible) paint(null); visible = false; }
    return {
      updatePlayer(value) {
        const next = identity(value); player = value;
        if (next !== key) { flat(); key = next; epoch++; stream = null; sequence = -1; deadline = 0; retired.clear(); }
        if (!next) flat();
      },
      owner: () => epoch,
      eligible: () => key !== null,
      receive(frame, {owner, rttMs = 0} = {}) {
        if (!key || owner !== epoch) return false;
        if (!frame) { flat(); return false; }
        if (frame.available !== true || frame.status !== 'running') { flat(); return false; }
        if (frame.source !== 'local' || frame.trackId !== (player.currentTrackId || player.currentTrack?.id) || frame.generation !== player.generation) { flat(); return false; }
        const basic = frame.schemaVersion === 1 && frame.units === 'dBFS' && frame.floorDbfs === -100 && frame.ceilingDbfs === 0 && frame.calibration === 'rms-full-scale-1' && frame.fftSize === 4096 && frame.window === 'hann-periodic' && Number.isFinite(frame.analyzedSampleRate) && frame.analyzedSampleRate > 0 && Number.isInteger(frame.channels) && frame.channels > 0 && typeof frame.streamId === 'string' && /^[a-f0-9]{64}$/.test(frame.streamId) && Number.isSafeInteger(frame.sequence) && frame.sequence >= 0 && Number.isFinite(frame.ageMs) && frame.ageMs >= 0 && Number.isFinite(rttMs) && rttMs >= 0 && Array.isArray(frame.bands) && frame.bands.length === 48;
        if (!basic) { flat(); return false; }
        if (retired.has(frame.streamId)) return false;
        const prior = lifetimes.get(frame.streamId);
        if (prior && frame.sequence <= prior.sequence) { if (stream === frame.streamId && now() >= prior.deadline) flat(); return false; }
        let previousLow = -1;
        const levels = [];
        for (const band of frame.bands) {
          if (!band || !Number.isFinite(band.lowHz) || !Number.isFinite(band.highHz) || band.lowHz < 0 || band.highHz <= band.lowHz || band.lowHz <= previousLow || !Number.isFinite(band.dbfs) || typeof band.hasBins !== 'boolean') { flat(); return false; }
          previousLow = band.lowHz;
          levels.push(band.hasBins ? Math.max(0, Math.min(1, (band.dbfs + 100) / 100)) : 0);
        }
        if (stream && stream !== frame.streamId) { retired.add(stream); while (retired.size > 32) retired.delete(retired.values().next().value); }
        stream = frame.streamId; sequence = frame.sequence;
        const remaining = 250 - frame.ageMs - rttMs;
        deadline = now() + Math.max(0, remaining);
        lifetimes.delete(stream); lifetimes.set(stream, {sequence, deadline}); while (lifetimes.size > 32) lifetimes.delete(lifetimes.keys().next().value);
        if (!(remaining > 0)) { flat(); return false; }
        if (timer !== null) cancel(timer);
        const stamp = ++version, scope = epoch;
        visible = true; paint(levels);
        timer = schedule(() => { if (stamp === version && scope === epoch) flat(); }, remaining);
        return true;
      },
      dispose() { flat(); key = null; epoch++; retired.clear(); lifetimes.clear(); },
      snapshot: () => ({eligible: key !== null, visible, streamId: stream, sequence, deadline, owner: epoch})
    };
  }

  function contextNeighbors(player, context) {
    if (!context || context.status !== 'ready' || context.source !== player.source || !['local', 'apple'].includes(player.source) || !context.contextId || !Number.isInteger(context.currentIndex) || !Array.isArray(context.items)) return null;
    if (Number.isInteger(context.generation) && Number.isInteger(player.generation) && context.generation !== player.generation) return null;
    if (context.currentIndex < 0 || !context.items.every(item => item && Number.isInteger(item.index) && item.index >= 0 && typeof item.key === 'string' && item.key) || new Set(context.items.map(item => item.index)).size !== context.items.length || new Set(context.items.map(item => item.key)).size !== context.items.length) return null;
    const byIndex = new Map(context.items.map(item => [item.index, item]));
    if (!byIndex.has(context.currentIndex)) return null;
    const result = {contextId: context.contextId, currentIndex: context.currentIndex, canNavigate: context.capabilities?.predictNeighbors === true};
    for (const [side, offset] of [['previous', -1], ['next', 1], ['previousOuter', -2], ['nextOuter', 2]]) {
      const item = byIndex.get(context.currentIndex + offset);
      result[side] = item || null;
    }
    return result;
  }
  const api = {DEFAULT_ACCENT, PRESETS, normalize, contrast, deriveAccent, createAccentController, createBackdropController, createSleeveGesture, createSpectrumController, contextNeighbors, layoutMode};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || !window.document) return;
  const helpers = api;
  (window.StillModules ||= []).push({name: 'glass', create({app: suppliedApp, extensions}) {
  const api = {...helpers};
  let accentController, appearanceControls = null, listeningSignature = '', playbackContext = null, playbackContextOwner = null, backdropController, backdropFront = 0, sleeveGesture, gestureBusy = false, spectrumController, spectrumTimer = null, spectrumInFlight = false, spectrumDisposed = false;
  const app = () => suppliedApp;
  function paintAccent(value, mode = 'color') {
    const selected = normalize(value) || DEFAULT_ACCENT, color = deriveAccent(mode === 'none' ? '#C7CDD6' : selected), style = document.body.style;
    document.body.dataset.accentMode = mode;
    for (const [key, entry] of Object.entries({'--accent': color.raw, '--accent-rgb': color.rgb, '--accent-readable': color.readable, '--accent-readable-rgb': color.readableRgb, '--accent-ink': color.ink, '--amber': color.readable, '--amber-soft': color.readable})) style.setProperty(key, entry);
    if (appearanceControls) {
      appearanceControls.picker.value = selected;
      if (!appearanceControls.textEditing) appearanceControls.text.value = selected;
      for (const swatch of appearanceControls.swatches) swatch.setAttribute('aria-pressed', String(mode === 'color' && swatch.dataset.color === selected));
      for (const control of appearanceControls.modes) control.setAttribute('aria-pressed', String(control.dataset.mode === mode));
    }
  }
  function controller() {
    if (!accentController) accentController = createAccentController({
      initial: app().state.settings.appearance?.accentColor,
      initialMode: app().state.settings.appearance?.accentMode,
      paint: paintAccent,
      save: (color, mode) => app().invoke('settings:update', {patch: {appearance: {accentColor: color, accentMode: mode}}}, {quiet: true}),
      onCommit: (color, _result, mode) => { app().actions.acceptAppearance({accentColor: color, accentMode: mode}); },
      onError: () => app().notify('外观未保存，已恢复上一次设置。')
    });
    return accentController;
  }
  function backdrop() {
    if (backdropController) return backdropController;
    const layers = [app().$('coverBackdropA'), app().$('coverBackdropB')];
    const opacity = (layer, value, immediate) => { layer.style.transition = immediate ? 'none' : ''; layer.style.opacity = String(value); };
    backdropController = createBackdropController({
      load: url => new Promise((resolve, reject) => {
        const image = document.createElement('img'); image.className = 'backdrop-image'; image.alt = ''; image.decoding = 'async';
        image.addEventListener('load', () => { Promise.resolve().then(() => typeof image.decode === 'function' ? image.decode() : undefined).then(() => resolve(image), reject); }, {once: true});
        image.addEventListener('error', () => reject(new Error('Artwork unavailable')), {once: true}); image.src = url;
      }),
      commit: (image, {immediate}) => {
        const next = 1 - backdropFront, layer = layers[next];
        opacity(layer, 0, true); layer.replaceChildren(image);
        // Commit the decoded image while invisible, then crossfade only opacity.
        void layer.offsetWidth;
        opacity(layer, 1, immediate); opacity(layers[backdropFront], 0, immediate); backdropFront = next;
        document.body.classList.add('has-cover-backdrop');
      },
      clear: ({immediate}) => {
        layers.forEach(layer => opacity(layer, 0, immediate)); document.body.classList.remove('has-cover-backdrop');
      },
      settle: () => {
        layers.forEach((layer, index) => opacity(layer, index === backdropFront && document.body.classList.contains('has-cover-backdrop') ? 1 : 0, true));
      }
    });
    return backdropController;
  }
  api.updateBackdrop = (track, retry = false) => {
    const player = app().state.player;
    const current = track || player.currentTrack || ((player.source || player.lastSource) === 'apple' ? null : app().tracks().find(item => item.id === player.currentTrackId));
    const source = player.source || player.lastSource || '';
    const key = current ? `${source}:${current.id || player.currentTrackId || ''}:${player.generation ?? ''}` : '';
    const url = typeof current?.coverUrl === 'string' && (/^(still-cover:\/\/art\/|data:image\/(?:png|jpeg|gif|webp|avif);base64,)/i.test(current.coverUrl) || /^still-apple-art:\/\/art\/[a-f0-9]{64}$/.test(current.coverUrl)) ? current.coverUrl : '';
    backdrop().update({key, url, retry, reducedMotion: !!app().state.settings.appearance?.reducedMotion || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches});
  };
  api.retryArtwork = () => { api.updateBackdrop(undefined, true); app().retryVisibleArtwork(); };
  api.settingsChanged = settings => { controller().receive(settings.appearance?.accentColor, settings.appearance?.accentMode); api.updateBackdrop(); };
  api.playerChanged = player => {
    sleeveGesture?.cancelIfChanged(gestureKey());
    syncSpectrum();
    api.updateBackdrop();
    document.body.classList.toggle('is-playing', player.state === 'playing' && player.available === true);
    document.body.classList.toggle('has-listening-track', !!(player.currentTrackId || player.currentTrack) && ['playing', 'paused'].includes(player.state));
    const duration = Number(player.duration), position = Number(player.position);
    document.body.style.setProperty('--playback-fraction', String(duration > 0 && Number.isFinite(position) ? Math.max(0, Math.min(1, position / duration)) : 0));
    app().$('listeningState').textContent = player.state === 'playing' ? '正在聆听 · NOW PLAYING' : player.state === 'paused' ? '已暂停 · PAUSED' : player.state === 'stopped' ? '已停止 · STOPPED' : '尚未播放';
  };
  api.renderListening = track => {
    api.updateBackdrop(track);
    const {node, button, cover, clean, $, state} = app(), root = $('sleeveNeighbors');
    const key = gestureKey(), context = playbackContextOwner === key ? contextNeighbors(state.player, playbackContext) : null, available = state.player.available === true;
    const signature = JSON.stringify([state.player.source, state.player.currentTrackId, available, $('previous').disabled, $('next').disabled, context?.contextId, context?.currentIndex, context?.canNavigate,
      ['previous', 'next', 'previousOuter', 'nextOuter'].map(side => { const item = context?.[side]; return item ? [item.key, item.coverUrl, item.title] : null; })]);
    $('listeningContext').textContent = '';
    if (signature === listeningSignature) return;
    sleeveGesture?.cancel();
    listeningSignature = signature; app().clearContent(root);
    if (!context) return;
    for (const side of ['previousOuter', 'nextOuter', 'previous', 'next']) {
      const neighbor = context[side];
      if (!neighbor) continue;
      const title = clean(neighbor.title, '未知标题'), direction = side.startsWith('previous') ? 'previous' : 'next', outer = side.endsWith('Outer'), interactive = !outer && context.canNavigate && neighbor.playable === true;
      const className = `sleeve-neighbor sleeve-${direction}${outer ? ' sleeve-outer' : ''}`;
      const card = !interactive ? node('div', className) : button('', className, () => {
        const latest = contextNeighbors(state.player, playbackContext);
        if (!state.immersive || !key || key !== gestureKey() || app().isPlaybackPending() || !latest?.canNavigate || latest.contextId !== context.contextId || latest.currentIndex !== context.currentIndex || latest[side]?.key !== neighbor.key || latest[side]?.playable !== true || $(direction).disabled) return;
        return app().commandTransport(direction);
      });
      if (outer) card.setAttribute('aria-hidden', 'true');
      else if (interactive) { card.disabled = !available || !key || $(direction).disabled; card.setAttribute('aria-label', `播放${direction === 'previous' ? '上一首' : '下一首'} ${title}`); }
      else { card.setAttribute('role', 'group'); card.setAttribute('aria-label', `列表相邻曲目 ${title}`); }
      card.title = title;
      const image = node('span', 'sleeve-image'), label = node('span', 'sleeve-label');
      cover(image, neighbor.coverUrl, 'album');
      label.append(node('span', '', title));
      card.append(image, label); root.append(card);
    }
  };
  api.contextChanged = context => { playbackContext = context; playbackContextOwner = context ? gestureKey() : null; if (app().state.immersive) api.renderListening(app().state.player.currentTrack); };
  api.controlsChanged = () => { syncSpectrum(); if (app().state.immersive) api.renderListening(app().state.player.currentTrack); };
  api.renderRail = () => {
    const {node, button, cover, coverReference, clean, $, playlists} = app(), root = $('railCollections');
    app().clearContent(root);
    const open = async (view, detail) => {
      await app().selectSource('local');
      if (app().state.browseSource !== 'local') return;
      app().setView(view); if (detail) app().openDetail(detail);
    };
    const navigation = node('nav', 'listening-navigation'), roving = []; navigation.setAttribute('aria-label', '本地音乐库');
    for (const [view, label, icon] of [['albums', '专辑', 'album'], ['library', '曲目', 'music'], ['playlists', '播放列表', 'playlist']]) { const entry = button(label, 'listening-nav-item', () => open(view), icon); navigation.append(entry); roving.push({key: `nav:${view}`, controls: [entry]}); }
    root.append(navigation);
    const lists = playlists();
    if (!lists.length) { app().configureRoving(root, roving, null, 'rail', '本地音乐导航'); return; }
    const shelf = node('div', 'rail-playlists');
    for (const list of lists) {
      const title = clean(list.name, '未命名列表'), ids = Array.isArray(list.trackIds) ? list.trackIds : [];
      const entry = button('', 'rail-playlist', () => open('playlists', {type: 'playlist', id: list.id, title}));
      const art = node('span', 'rail-list-cover'), copy = node('span', 'rail-list-copy');
      const reference = coverReference(ids); cover(art, reference.resolve(), 'playlist', reference);
      copy.append(node('strong', '', title), node('small', '', `${ids.length} 首`)); entry.append(art, copy); shelf.append(entry); roving.push({key: `playlist:${list.id}`, controls: [entry]});
    }
    root.append(shelf);
    app().configureRoving(root, roving, null, 'rail', '本地音乐导航');
  };
  function initializeSeekRail(target) {
    target.replaceChildren();
    target.classList.add('spectrum-empty');
  }
  function paintSpectrum(levels) {
    const {$, node} = app(); $('waveSeek').classList.toggle('has-spectrum', !!levels);
    for (const target of [$('footerWave'), $('footerWavePlayed')]) {
      if (!levels) { initializeSeekRail(target); continue; }
      target.classList.remove('spectrum-empty');
      if (target.children.length !== levels.length) target.replaceChildren(...levels.map(() => node('span', 'spectrum-bar')));
      levels.forEach((level, index) => target.children[index].style.setProperty('--band-level', String(level)));
    }
  }
  function spectrum() {
    if (!spectrumController) spectrumController = createSpectrumController({paint: paintSpectrum, now: () => window.performance.now(), schedule: (callback, delay) => setTimeout(callback, delay), cancel: timer => clearTimeout(timer)});
    return spectrumController;
  }
  function spectrumAllowed() {
    const state = app().state, player = state.player;
    return !spectrumDisposed && document.hidden !== true && state.capabilities.spectrum === true && state.sources.local?.status !== 'standby' && state.sources.local?.available !== false && player.source === 'local' && player.available === true && player.state === 'playing';
  }
  function syncSpectrum() {
    spectrum().updatePlayer(spectrumAllowed() ? app().state.player : null);
    if (!spectrumAllowed() || !spectrum().eligible()) { if (spectrumTimer !== null) clearTimeout(spectrumTimer); spectrumTimer = null; return; }
    if (!spectrumInFlight && spectrumTimer === null) spectrumTimer = setTimeout(pollSpectrum, 0);
  }
  async function pollSpectrum() {
    spectrumTimer = null;
    if (spectrumInFlight || !spectrumAllowed() || !spectrum().eligible()) return;
    spectrumInFlight = true;
    const owner = spectrum().owner(), started = window.performance.now();
    try {
      const frame = await app().invoke('player:spectrum', {}, {quiet: true});
      if (spectrumAllowed()) spectrum().receive(frame, {owner, rttMs: Math.max(0, window.performance.now() - started)});
    } finally {
      spectrumInFlight = false;
      if (spectrumAllowed() && spectrum().eligible() && spectrumTimer === null) spectrumTimer = setTimeout(pollSpectrum, Math.max(0, 50 - (window.performance.now() - started)));
    }
  }
  api.openAppearance = () => {
    const {node, button, openDialog, $, state, notify} = app(), c = controller(), body = node('div', 'appearance-settings');
    const swatches = [], modes = [], palette = node('div', 'accent-presets'), modeRow = node('div', 'appearance-modes'), canSave = state.capabilities.persistUIState === true;
    for (const [mode, label] of [['none', '封面原色'], ['color', '主题色']]) {
      const control = button(label, 'button appearance-mode', () => { appearanceControls.textEditing = false; c.commitMode(mode); });
      control.dataset.mode = mode; control.disabled = !canSave; control.setAttribute('aria-pressed', String(c.snapshotTheme().draft.accentMode === mode)); modes.push(control); modeRow.append(control);
    }
    body.append(modeRow);
    const picker = node('input', 'accent-picker'), text = node('input', 'accent-text');
    picker.type = 'color'; picker.value = c.snapshot().draft; picker.setAttribute('aria-label', '自定义强调色'); picker.disabled = !canSave;
    text.type = 'text'; text.maxLength = 7; text.value = c.snapshot().draft; text.setAttribute('aria-label', '十六进制强调色'); text.placeholder = '#A8B9FF'; text.spellcheck = false; text.disabled = !canSave;
    for (const [name, value] of PRESETS) {
      const swatch = button(name, 'accent-swatch', () => { appearanceControls.textEditing = false; text.removeAttribute('aria-invalid'); c.commit(value, 'color'); }); swatch.dataset.color = value; swatch.style.setProperty('--swatch', value); swatch.setAttribute('aria-label', `${name} ${value}`); swatch.setAttribute('aria-pressed', String(c.snapshotTheme().draft.accentMode === 'color' && c.snapshot().draft === value)); swatch.disabled = !canSave; swatches.push(swatch); palette.append(swatch);
    }
    picker.addEventListener('input', () => { if (canSave) { appearanceControls.textEditing = false; c.preview(picker.value, 'color'); text.value = picker.value.toUpperCase(); } });
    picker.addEventListener('change', () => { if (canSave) c.commit(picker.value, 'color'); });
    text.addEventListener('input', () => { appearanceControls.textEditing = true; if (canSave) c.preview(text.value, 'color'); });
    const commitText = () => {
      if (!canSave) return;
      if (!normalize(text.value)) { text.setAttribute('aria-invalid', 'true'); notify('请输入完整的六位十六进制颜色，例如 #A8B9FF。'); return; }
      text.removeAttribute('aria-invalid'); appearanceControls.textEditing = false; c.commit(text.value, 'color');
    };
    text.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); commitText(); } });
    const row = node('div', 'custom-accent'); row.append(picker, text, button('应用颜色', 'button', commitText));
    row.children[2].disabled = !canSave;
    const note = node('p', 'dialog-note', canSave ? '拖动取色器即时预览，松开后保存。输入色值后按 Enter 或应用颜色。' : '当前只读模式无法保存外观。');
    const motion = node('label', 'switch-row'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = !!state.settings.appearance?.reducedMotion; checkbox.disabled = !canSave;
    checkbox.addEventListener('change', async () => { const result = await app().invoke('settings:update', {patch: {appearance: {reducedMotion: checkbox.checked}}}); if (result) app().applySettings(result); else checkbox.checked = !!state.settings.appearance?.reducedMotion; });
    motion.append(checkbox, node('span', '', '减少界面动效')); body.append(palette, row, note, motion); openDialog('光线与外观', body);
    appearanceControls = {picker, text, swatches, modes, textEditing: false};
    $('dialog').addEventListener('close', () => { appearanceControls = null; c.cancelPreview(); }, {once: true});
  };
  api.dialogChanging = () => { if (appearanceControls) { appearanceControls = null; accentController?.cancelPreview(); } };
  api.updateLayout = () => {
    sleeveGesture?.cancel();
    document.body.dataset.layout = layoutMode(window.innerWidth, window.innerHeight);
    extensions.features?.layoutChanged();
  };
  api.diagnosticsLayout = () => {
    const width = window.innerWidth, height = window.innerHeight, devicePixelRatio = window.devicePixelRatio;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 32768 || height > 32768 || !Number.isFinite(devicePixelRatio) || devicePixelRatio < .25 || devicePixelRatio > 16) return null;
    const appReducedMotion = !!app().state.settings.appearance?.reducedMotion;
    const systemReducedMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    return {width, height, devicePixelRatio,
      horizontalOverflow: Math.max(Number(document.documentElement?.scrollWidth) || 0, Number(document.body.scrollWidth) || 0) > width + 1,
      appReducedMotion, systemReducedMotion, effectiveReducedMotion: appReducedMotion || systemReducedMotion,
      accentColor: controller().snapshot().draft};
  };
  let initialized = false;
  api.init = () => {
    if (initialized) return; initialized = true;
    api.updateLayout(); window.addEventListener?.('resize', api.updateLayout);
    initializeSeekRail(app().$('footerWave')); initializeSeekRail(app().$('footerWavePlayed'));
    document.addEventListener('visibilitychange', syncSpectrum);
    window.addEventListener?.('beforeunload', () => { spectrumDisposed = true; if (spectrumTimer !== null) clearTimeout(spectrumTimer); spectrumTimer = null; spectrumController?.dispose(); });
    const deck = app().$('listeningDeck');
    sleeveGesture = createSleeveGesture({
      preview: (offset, dragging) => { deck.style.setProperty('--sleeve-drag', `${offset}px`); deck.classList.toggle('sleeve-dragging', dragging); },
      commit: (direction, key) => {
        if (gestureBusy || app().isPlaybackPending() || key !== gestureKey() || app().$(direction).disabled || !app().state.immersive) return;
        gestureBusy = true; deck.setAttribute('aria-busy', 'true');
        Promise.resolve(app().commandTransport(direction)).finally(() => { gestureBusy = false; deck.removeAttribute('aria-busy'); });
      }
    });
    deck.addEventListener('dragstart', event => event.preventDefault());
    deck.addEventListener('pointerdown', event => {
      if (gestureBusy || app().isPlaybackPending() || !app().state.immersive) return;
      sleeveGesture.start({pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: deck.getBoundingClientRect().width, key: gestureKey(), primary: event.isPrimary !== false, button: event.button || 0});
    });
    deck.addEventListener('pointermove', event => {
      if (sleeveGesture.move({pointerId: event.pointerId, x: event.clientX, y: event.clientY})) {
        event.preventDefault(); if (!deck.hasPointerCapture?.(event.pointerId)) deck.setPointerCapture?.(event.pointerId);
      }
    });
    deck.addEventListener('pointerup', event => {
      sleeveGesture.end({pointerId: event.pointerId, key: gestureKey()});
      if (deck.hasPointerCapture?.(event.pointerId)) deck.releasePointerCapture(event.pointerId);
    });
    deck.addEventListener('pointercancel', () => sleeveGesture.cancel());
    deck.addEventListener('lostpointercapture', () => sleeveGesture.cancel());
    deck.addEventListener('click', event => { if (sleeveGesture.consumeClick(event.detail)) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    window.addEventListener?.('blur', () => sleeveGesture.cancel());
    window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => api.updateBackdrop());
    app().$('listeningSearch').addEventListener('click', () => {
      extensions.features?.leaveImmersive();
      app().$(app().state.browseSource === 'apple' ? 'appleSearch' : 'search').focus();
    });
  };
  function gestureKey() {
    const player = app().state.player, id = player.currentTrackId || player.currentTrack?.id;
    return ['local', 'apple'].includes(player.source) && player.available === true && ['playing', 'paused'].includes(player.state) && typeof id === 'string' && id ? `${player.source}:${id}:${player.generation ?? ''}` : null;
  }
  return Object.freeze(api);
  }});
})();
