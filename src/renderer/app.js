'use strict';

(() => {
  function createApp({readonly, extensions, libraryState}) {
  const $ = id => document.getElementById(id);
  const state = {
    view: 'albums', detail: null, query: '', sort: 'order', library: {tracks: [], playlists: []},
    player: {available: false, state: 'unavailable'}, settings: {}, ready: false, immersive: false, viewDirty: false,
    browseSource: 'local', appleView: 'library', appleQuery: '', appleDetail: null, sources: {}, capabilities: {}
  };
  const labels = {
    library: ['TRACKS', '曲目库', '', '全部曲目'],
    albums: ['RECORDS', '专辑', '', '唱片收藏'],
    artists: ['ARTISTS', '艺术家', '', '全部艺术家'],
    playlists: ['PLAYLISTS', '播放列表', '', '全部播放列表']
  };
  let toastTimer, started = false, playbackGeneration = 0, pendingRow = null, transportPending = 0, lastCover = null, seeking = false, seekOwner = null, seekCanceled = false, volumeEditing = false, volumeOwner = null, volumeCanceled = false, detailReturnScroll = 0, detailReturnQuery = '';
  let sourceGeneration = 0, localScroll = 0, seenPlayerGeneration = -1, seenPlayerRevision = -1, appleAuthorizationPending = false, localRetryPending = false;
  let appleScroll = 0, appleFetchRevision = 0, appleStatusExpanded = false, appleReturn = null;
  let appleResults = {key: '', items: [], loading: false, error: '', nextOffset: null, total: null};
  let searchTimer = null, searchVersion = 0, composingSearch = false, normalizedQuery = '';
  let renderedAppleResults = null, renderedAppleControls = '';
  const searchText = new WeakMap(), coverBindings = new WeakMap(), imageOwners = new WeakMap(), imageState = new WeakMap(), pooledSize = new WeakMap();
  const activeCovers = new Set(), releasedCovers = new Map(), coverPool = new Map(), coverDependencies = new Map();
  let pooledImages = 0, pooledBytes = 0;
  let localRows = [];
  let localRovingItems = [], localRovingGrid = null;
  const rovingControllers = new WeakMap(), rovingRoots = new Set(), focusMemory = new Map();
  const libraryWrites = new Set(), libraryWriteChannels = new Set(['library:import', 'library:remove', 'library:refresh', 'playlist:create', 'playlist:rename', 'playlist:delete', 'playlist:addTracks', 'playlist:removeItem', 'playlist:moveItem']);
  const libraryStore = libraryState.createLibraryState({fetchSnapshot: () => invoke('library:list', {}, {quiet: true}), onChange: acceptLibrary, onError: notify});

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }
  function button(text, className, callback, iconName) {
    const element = node('button', className);
    element.type = 'button';
    if (iconName) element.append(icon(iconName));
    if (text) element.append(node('span', '', text));
    if (callback) element.addEventListener('click', async event => {
      if (element.disabled) return;
      element.disabled = true; element.dataset.busy = 'true';
      try { await callback(event); }
      catch (error) { notify(error?.message || '操作未完成，请稍后重试。'); }
      finally { delete element.dataset.busy; element.disabled = element.dataset.unavailable === 'true' || (element.dataset.libraryWrite === 'true' ? !libraryWritable() || element.dataset.libraryBaseDisabled === 'true' : false); }
    });
    return element;
  }
  function titled(element, value) { element.title = value || ''; return element; }
  function clean(value, fallback = '未知') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
  function time(value) {
    if (!Number.isFinite(Number(value)) || Number(value) < 0) return '0:00';
    const seconds = Math.floor(Number(value));
    const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60);
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function paintRange(element) {
    const min = Number(element.min) || 0, max = Number(element.max) || 1;
    const fill = max > min ? Math.max(0, Math.min(100, (Number(element.value) - min) / (max - min) * 100)) : 0;
    element.style.setProperty('--range-fill', `${fill}%`);
    if (element === $('seek')) {
      $('waveSeek').style.setProperty('--seek-progress', `${fill}%`);
      element.setAttribute('aria-valuetext', `${time(Number(element.value))} / ${time(Number(element.max))}`);
      element.title = time(Number(element.value));
    }
  }
  function notify(message) {
    const target = $('dialog').open ? $('dialogAlert') : $('toast');
    target.textContent = message;
    target.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { target.hidden = true; }, 5000);
  }
  async function invoke(channel, payload = {}, options = {}) {
    if (libraryWriteChannels.has(channel) && !libraryWritable()) { if (!options.quiet) notify('音乐库为只读状态'); return null; }
    try { return await window.still.invoke(channel, payload); }
    catch (error) {
      if (!options.quiet && (!options.isCurrent || options.isCurrent()) && !/cancelled|canceled|superseded|已取消|已被替代|请求.*(?:替代|取消)/i.test(error?.message || '')) notify(error?.message || '操作未完成，请稍后重试。');
      return null;
    }
  }
  function tracks() { return Array.isArray(state.library?.tracks) ? state.library.tracks : []; }
  function playlists() { return Array.isArray(state.library?.playlists) ? state.library.playlists : []; }
  function libraryWritable() { return state.library?.status?.readOnly !== true; }
  function markLibraryWrite(element, disabled = false) { element.dataset.libraryWrite = 'true'; element.dataset.libraryBaseDisabled = String(disabled); element.disabled = disabled || !libraryWritable(); libraryWrites.add(element); return element; }
  function paintLibraryStatus() {
    const status = state.library?.status, message = status?.readOnly ? '音乐库为只读状态' : status?.recovered ? (status.backupPath ? '原库已备份，索引已重建' : '库索引已重建') : '';
    const target = $('libraryState'); if (target.textContent !== message) target.textContent = message; target.hidden = !message; target.title = status?.message || '';
    for (const element of libraryWrites) element.disabled = !libraryWritable() || element.dataset.libraryBaseDisabled === 'true' || element.dataset.busy === 'true';
  }
  function announce(target, message) { if (target.textContent !== message) target.textContent = message; }
  function coverReference(ids) {
    const selected = [...new Set(ids.filter(id => typeof id === 'string'))];
    return {ids: selected, resolve: () => selected.map(id => libraryStore.getTrack(id)).find(track => track?.coverUrl)?.coverUrl || ''};
  }
  function refreshTrackCovers(ids) {
    const targets = new Set(); for (const id of ids) for (const target of coverDependencies.get(id) || []) targets.add(target);
    for (const target of targets) { const binding = coverBindings.get(target); if (binding?.options.resolve) cover(target, binding.options.resolve(), binding.fallback, binding.options); }
  }
  function localAvailable() {
    const local = state.sources.local;
    const available = typeof local?.available === 'boolean' ? local.available : (state.player.source !== 'apple' && state.player.available === true);
    return available && local?.capabilities?.playback !== false;
  }
  function localCanPlayTarget() {
    const local = state.sources.local;
    return localAvailable() || (local?.status === 'standby' && local.available === false && local.backendReachable === false && local.capabilities?.canStartOnDemand === true);
  }
  function matches(track) {
    if (!normalizedQuery) return true;
    let fields = searchText.get(track);
    if (!fields) { fields = [track.title, track.artist, track.album, track.albumArtist].map(value => String(value || '').toLocaleLowerCase()); searchText.set(track, fields); }
    return fields.some(value => value.includes(normalizedQuery));
  }
  function cancelSearch(commit = false) {
    if (searchTimer !== null) clearTimeout(searchTimer); searchTimer = null; searchVersion++;
    if (!commit || state.query === $('search').value) return false;
    state.query = $('search').value; return true;
  }
  function scheduleSearch() {
    cancelSearch();
    if (composingSearch || state.browseSource !== 'local' || state.immersive) return;
    const token = searchVersion, query = $('search').value;
    searchTimer = setTimeout(() => {
      searchTimer = null;
      if (token !== searchVersion || state.browseSource !== 'local' || state.immersive || $('search').value !== query) return;
      state.query = query; render();
    }, 150);
  }
  function updateCoverDependencies(binding, options) {
    for (const id of binding.ids || []) { const entries = coverDependencies.get(id); entries?.delete(binding.container); if (entries?.size === 0) coverDependencies.delete(id); }
    binding.options = options || binding.options || {};
    binding.ids = [...new Set((binding.options.ids || []).filter(id => typeof id === 'string'))];
    for (const id of binding.ids) { if (!coverDependencies.has(id)) coverDependencies.set(id, new Set()); coverDependencies.get(id).add(binding.container); }
  }
  function recycleImage(image, url) {
    if (!imageState.get(image)?.loaded || image.parentElement) return;
    const width = Number(image.naturalWidth), height = Number(image.naturalHeight), bytes = width * height * 4;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || !Number.isSafeInteger(bytes) || bytes > 32 * 1024 * 1024) return;
    const pool = coverPool.get(url) || [];
    if (pool.length >= 2) return;
    pool.push(image); pooledSize.set(image, bytes); coverPool.delete(url); coverPool.set(url, pool); pooledImages++; pooledBytes += bytes;
    while (pooledImages > 64 || pooledBytes > 32 * 1024 * 1024) { const first = coverPool.keys().next().value, entries = coverPool.get(first), discarded = entries.shift(); pooledImages--; pooledBytes -= pooledSize.get(discarded) || 0; pooledSize.delete(discarded); if (!entries.length) coverPool.delete(first); }
  }
  function releaseCover(container, retain = false) {
    const binding = coverBindings.get(container);
    if (!binding) { if (!retain) releasedCovers.delete(container); return; }
    updateCoverDependencies(binding, {ids: []});
    coverBindings.delete(container); activeCovers.delete(container);
    if (binding.image) {
      imageOwners.delete(binding.image);
      if (container.children[0] === binding.image) container.replaceChildren(icon(binding.fallback));
      if (!binding.failed) recycleImage(binding.image, binding.url);
    }
    if (retain) releasedCovers.set(container, {url: binding.url, fallback: binding.fallback, options: binding.restoreOptions});
    else releasedCovers.delete(container);
  }
  function releaseCovers(root, retain = false) {
    for (const container of [...activeCovers]) if (container === root || root.contains(container)) releaseCover(container, retain);
    if (!retain) for (const container of releasedCovers.keys()) if (container === root || root.contains(container)) releasedCovers.delete(container);
  }
  function restoreCovers(root) {
    for (const [container, record] of [...releasedCovers]) if (container === root || root.contains(container)) {
      releasedCovers.delete(container); const url = record.options?.resolve ? record.options.resolve() : record.url;
      cover(container, url, record.fallback, record.options);
    }
  }
  function clearContent(root, ...children) {
    releaseCovers(root);
    for (const element of libraryWrites) if (root === element || root.contains(element)) libraryWrites.delete(element);
    for (const target of rovingRoots) if (root === target || root.contains(target)) { const controller = rovingControllers.get(target); controller.restoreFocus = target.contains(document.activeElement); controller.items = []; controller.lookup = new WeakMap(); if (target !== root) rovingRoots.delete(target); }
    root.replaceChildren(...children);
  }
  function configureRoving(root, items, grid = null, scope = 'local', label = '音乐列表') {
    let controller = rovingControllers.get(root);
    const enabled = item => item.controls.filter(control => !control.disabled && !control.hidden);
    function activate(index, controlIndex = 0, focus = false) {
      const previous = controller.items[controller.active]; if (previous) previous.controls.forEach(control => { control.tabIndex = -1; });
      controller.active = index; const item = controller.items[index]; if (!item) return;
      const controls = enabled(item); controls.forEach(control => { control.tabIndex = 0; });
      const target = controls[Math.max(0, Math.min(controlIndex, controls.length - 1))];
      focusMemory.set(controller.scope, {key: item.key, controlIndex});
      if (focus && target) target.focus();
    }
    if (!controller) {
      controller = {items: [], active: -1, lookup: new WeakMap(), grid, scope, restoreFocus: false}; rovingControllers.set(root, controller);
      const locate = target => { for (let current = target; current && current !== root; current = current.parentElement) if (controller.lookup.has(current)) return controller.lookup.get(current); return null; };
      root.addEventListener('focusin', event => { const entry = locate(event.target); if (entry) activate(entry.index, enabled(controller.items[entry.index]).indexOf(entry.control)); });
      root.addEventListener('keydown', event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const entry = locate(event.target); if (!entry || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation?.();
        const controls = enabled(controller.items[entry.index]), currentControl = Math.max(0, controls.indexOf(entry.control));
        if (!controller.grid && controls.length > 1 && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { activate(entry.index, currentControl + (event.key === 'ArrowRight' ? 1 : -1), true); return; }
        const columns = controller.grid ? Math.max(1, (window.getComputedStyle?.(controller.grid)?.gridTemplateColumns || '').split(/\s+/).filter(value => /px$/.test(value)).length) : 1;
        const step = event.key === 'ArrowUp' ? -columns : event.key === 'ArrowDown' ? columns : event.key === 'ArrowLeft' ? -1 : 1;
        let index = event.key === 'Home' ? 0 : event.key === 'End' ? controller.items.length - 1 : Math.max(0, Math.min(controller.items.length - 1, entry.index + step));
        const direction = event.key === 'End' || step < 0 ? -1 : 1;
        while (index >= 0 && index < controller.items.length && !enabled(controller.items[index]).length) index += direction;
        if (index >= 0 && index < controller.items.length) activate(index, currentControl, true);
      });
    }
    rovingRoots.add(root); controller.items = items.filter(item => item.controls.length); controller.grid = grid; controller.scope = scope; controller.lookup = new WeakMap();
    root.setAttribute('role', 'group'); root.setAttribute('aria-label', label);
    controller.items.forEach((item, index) => item.controls.forEach(control => { control.tabIndex = -1; controller.lookup.set(control, {index, control}); }));
    const memory = focusMemory.get(scope); let index = controller.items.findIndex(item => item.key === memory?.key && enabled(item).length);
    if (index < 0) index = controller.items.findIndex(item => enabled(item).length);
    activate(index, memory?.controlIndex || 0, controller.restoreFocus); controller.restoreFocus = false;
  }
  function cover(container, url, fallback = 'music', options = {}) {
    const safe = typeof url === 'string' && (/^(still-cover:\/\/art\/|data:image\/(?:png|jpeg|gif|webp|avif);base64,)/i.test(url) || /^still-apple-art:\/\/art\/[a-f0-9]{64}$/.test(url)) ? url : '';
    const previous = coverBindings.get(container);
    if (previous && previous.url === safe && previous.fallback === fallback && !options.retry && (previous.failed || container.children[0] === previous.image || !safe)) { updateCoverDependencies(previous, options); previous.restoreOptions = previous.options; return; }
    releaseCover(container);
    const binding = {container, url: safe, fallback, image: null, failed: false, ids: [], restoreOptions: options};
    coverBindings.set(container, binding); activeCovers.add(container); updateCoverDependencies(binding, options);
    delete container.dataset.coverFailed; container.dataset.coverUrl = safe; container.dataset.coverFallback = fallback;
    container.replaceChildren(icon(fallback));
    if (!safe) return;
    const pool = !options.retry && coverPool.get(safe); let image = null;
    if (pool?.length) { image = pool.pop(); pooledImages--; pooledBytes -= pooledSize.get(image) || 0; pooledSize.delete(image); if (!pool.length) coverPool.delete(safe); if (image.parentElement) image = null; }
    if (!image) {
      image = document.createElement('img'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; imageState.set(image, {loaded: false});
      image.addEventListener('load', () => { imageState.get(image).loaded = true; const owner = imageOwners.get(image); if (owner && owner.container.children[0] === image) { owner.failed = false; delete owner.container.dataset.coverFailed; } });
      image.addEventListener('error', () => { const owner = imageOwners.get(image); if (owner && owner.container.children[0] === image) { owner.failed = true; owner.container.dataset.coverFailed = owner.url; owner.container.replaceChildren(icon(owner.fallback)); } });
      image.src = safe;
    }
    binding.image = image; imageOwners.set(image, binding); container.replaceChildren(image);
  }
  function retryVisibleArtwork() {
    for (const container of document.querySelectorAll('[data-cover-failed]')) {
      if (container.dataset.coverFailed && container.dataset.coverFailed === container.dataset.coverUrl) cover(container, container.dataset.coverUrl, container.dataset.coverFallback || 'music', {...coverBindings.get(container)?.options, retry: true});
    }
  }
  function empty(title, description, symbol = 'music') {
    const wrap = node('div', 'empty'), art = node('div', 'empty-art');
    art.append(icon(symbol));
    wrap.append(art, node('h3', '', title), node('p', '', description));
    return wrap;
  }
  function setView(view, options = {}) {
    if (!labels[view]) return;
    cancelSearch(true);
    if (state.immersive && extensions.features) extensions.features.leaveImmersive();
    state.view = view; state.detail = null; state.sort = 'order';
    $('sortSelect').value = 'order';
    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      const active = item.dataset.view === view;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    });
    $('content').scrollTop = 0;
    render();
    if (options.persist && state.capabilities.persistUIState === true) invoke('settings:update', {patch: {appearance: {localView: view}}});
  }
  function renderConnection() {
    if (state.browseSource === 'apple') {
      const status = state.sources.apple?.status;
      const online = status === 'ready';
      const names = {ready: 'Apple Music 已连接', 'not-installed': 'Cider 尚未安装', 'not-running': 'Cider 未运行', 'not-connected': 'Apple Music 后端未连接', 'not-paired': 'Apple Music 需要配对', 'paired-unverified': 'Apple Music 待验证', 'signed-out': 'Apple Music 未登录', 'needs-auth': 'Apple Music 需要登录', 'authorization-required': 'Apple Music 需要登录', unconfigured: 'Apple Music 尚未配置', 'missing-config': 'Apple Music 尚未配置', configured: 'Apple Music 待验证', connecting: 'Apple Music 正在连接', 'configured-unverified': 'Apple Music 待验证', expired: 'Apple Music 凭据已过期', 'drm-unsupported': 'Apple Music 播放不可用', 'unsupported-drm': 'Apple Music 播放不可用', 'unsupported-DRM': 'Apple Music 播放不可用', unavailable: 'Apple Music 暂不可用', error: 'Apple Music 连接失败'};
      Object.assign(names, {'session-closed': '官方会话尚未打开', 'session-unverified': '官方会话已登录', 'needs-user-interaction': '请在官方会话中继续'});
      $('connectionText').textContent = names[status] || 'Apple Music 状态未知';
      $('connection').title = state.sources.apple?.message || $('connectionText').textContent;
      $('connection').classList.toggle('online', online); $('connection').classList.toggle('offline', !online);
      $('connection').classList.remove('standby');
      $('retryLocal').hidden = true;
      return;
    }
    const local = state.sources.local;
    const reachable = local?.backendReachable ?? (typeof local?.available === 'boolean' ? local.available : state.player.available === true);
    const output = local?.outputConnection || state.player.outputConnection;
    const unavailable = Boolean(output && output.status !== 'connected');
    const needsRetry = output?.retryRequired === true;
    const changed = output?.selectionMatches === false;
    const uncertain = local?.controlUncertain === true || local?.status === 'control-unconfirmed';
    const available = reachable && !unavailable && !needsRetry && !changed && !uncertain;
    const starting = local?.backendStatus === 'starting' || local?.status === 'starting';
    const standby = local?.status === 'standby' && local.available === false && local.backendReachable === false && local.capabilities?.canStartOnDemand === true;
    $('connectionText').textContent = standby ? '本地内核待命' : starting ? '正在启动本地播放内核' : !reachable ? '本地播放内核不可用' : uncertain ? '播放控制需重新连接' :
      changed ? '输出设备待确认' : unavailable ? (output.status === 'disconnected' ? '音频设备已断开' : '音频设备状态未知') :
      needsRetry ? '音频设备已重连，待确认' : '本地播放内核已连接';
    $('connection').title = local?.message || output?.message || (standby ? '选曲时启动本地内核' : available ? '本地播放内核已连接' : (state.player.error || '本地播放内核不可用，音乐库仍可浏览'));
    $('connection').classList.toggle('online', available && !standby); $('connection').classList.toggle('offline', !available && !standby); $('connection').classList.toggle('standby', standby);
    $('retryLocal').hidden = standby || available || starting || local?.capabilities?.retryBackend !== true;
    $('retryLocal').disabled = localRetryPending;
    const retryLabel = reachable && !uncertain ? '重新检查原音频设备' : '重新连接专属播放内核';
    $('retryLocal').setAttribute('aria-label', retryLabel);
    $('retryLocal').title = `${retryLabel}；不会自动开始播放`;
  }
  function renderApple() {
    const scroll = $('appleContent').scrollTop;
    const descriptor = state.sources.apple, capabilities = descriptor?.capabilities || {}, cider = descriptor?.provider === 'cider', official = descriptor?.provider === 'officialWeb';
    const titles = {unconfigured: 'Apple Music 尚未配置', 'missing-config': 'Apple Music 尚未配置', 'not-installed': '尚未安装 Cider', 'not-running': 'Cider 未运行', 'not-connected': 'Apple Music 后端未连接', 'not-paired': '需要连接并配对', 'paired-unverified': '已配对，服务能力尚未验证', configured: '凭据已配置，连接尚未验证', connecting: '正在连接 Apple Music', 'configured-unverified': '凭据已配置，连接尚未验证', expired: '开发者凭据已过期', 'needs-auth': '需要登录 Apple Music', 'authorization-required': '需要登录 Apple Music', 'signed-out': '尚未登录 Apple Music', ready: 'Apple Music 已连接', 'drm-unsupported': '此环境暂不支持受保护播放', 'unsupported-drm': '此环境暂不支持受保护播放', 'unsupported-DRM': '此环境暂不支持受保护播放', unavailable: 'Apple Music 暂不可用', error: '无法连接 Apple Music'};
    Object.assign(titles, {'session-closed': '打开 Apple Music 官方会话', 'session-unverified': '官方会话已登录', 'needs-user-interaction': '请在官方会话中完成操作'});
    $('applePageTitle').textContent = state.appleDetail?.title || labels[state.appleView][1];
    $('appleStateTitle').textContent = titles[descriptor?.status] || 'Apple Music 状态尚未确认';
    $('appleStateMessage').textContent = descriptor?.message || '尚未收到 Apple Music 的连接与能力信息。';
    $('ciderPrerequisite').hidden = !cider || !['not-installed', 'not-running', 'not-connected', 'not-paired', 'unavailable'].includes(descriptor?.status);
    const container = $('appleCapabilities'); container.replaceChildren();
    for (const [key, label] of [['authorize', cider ? '配对授权' : '登录授权'], ['library', '订阅曲库'], ['playback', '播放']]) {
      const available = capabilities[key];
      const badge = node('span', `source-capability${available === true ? ' available' : ''}`, `${label} · ${available === true ? '可用' : available === false ? '未就绪' : '未知'}`);
      container.append(badge);
    }
    const credentials = descriptor?.credentials || {}, metadata = $('appleCredentialInfo');
    metadata.replaceChildren();
    for (const [key, label] of [['teamId', 'Team ID'], ['keyId', 'Key ID'], ['expiresAt', '有效期至']]) {
      if (credentials[key] != null && credentials[key] !== '') metadata.append(node('div', '', `${label}：${credentials[key]}`));
    }
    const canConfigure = !official && (capabilities.configureKey === true || capabilities.importToken === true);
    $('appleConfigure').hidden = !canConfigure;
    $('appleDeveloperNote').hidden = !canConfigure;
    $('appleConfigure').disabled = !canConfigure;
    $('appleConfigure').title = canConfigure ? '配置 Apple Music 开发者凭据' : '本机凭据配置尚未就绪';
    $('appleAuthorize').hidden = capabilities.authorize !== true;
    $('appleAuthorize').disabled = capabilities.authorize !== true || appleAuthorizationPending;
    $('appleAuthorize').textContent = official ? clean(descriptor.actionLabel, '登录 Apple Music') : cider ? '连接 Cider' : '登录 Apple Music';
    $('appleAuthorize').title = capabilities.authorize === true ? (cider ? '由你在 Cider 中批准配对' : '由你完成 Apple Music 登录') : '授权尚未就绪';
    $('appleSearch').disabled = capabilities.search !== true;
    $('appleSearchSubmit').disabled = capabilities.search !== true;
    const showCollection = (state.appleDetail ? capabilities.library === true : capabilities.library === true || (!!state.appleQuery && capabilities.search === true)) || hasCachedAppleSongIntent();
    $('applePageDescription').textContent = showCollection && descriptor?.message ? descriptor.message : '你的 Apple Music 订阅曲库。';
    $('appleStateCard').hidden = showCollection && !appleStatusExpanded;
    $('appleCollection').hidden = !showCollection || appleStatusExpanded;
    $('appleBackCollection').hidden = !showCollection;
    if (showCollection && !appleStatusExpanded) renderAppleCollection();
    $('appleContent').scrollTop = scroll;
  }
  function appleKind() { return state.appleDetail?.kind || {library: 'songs', albums: 'albums', artists: 'artists', playlists: 'playlists'}[state.appleView]; }
  function appleRequestKey() { return `${appleKind()}\u0000${state.appleDetail?.id || ''}\u0000${state.appleDetail ? '' : state.appleQuery}`; }
  function appleCanRequest() {
    const capabilities = state.sources.apple?.capabilities || {};
    return !state.appleDetail && state.appleQuery ? capabilities.search === true : capabilities.library === true;
  }
  function appleCanSubmitPlayIntent(item, kind) {
    const capabilities = state.sources.apple?.capabilities || {}, type = item?.type || kind;
    return capabilities.canSubmitPlayIntent === true && Array.isArray(capabilities.playIntentTypes) &&
      ['songs', 'album-songs', 'playlist-songs'].includes(kind) && ['songs', 'library-songs'].includes(type) && capabilities.playIntentTypes.includes(type) &&
      item?.playable === true && typeof item.id === 'string' && /^[A-Za-z0-9._-]{1,256}$/.test(item.id);
  }
  function hasCachedAppleSongIntent() { return appleResults.key === appleRequestKey() && appleResults.items.some(item => appleCanSubmitPlayIntent(item, appleKind())); }
  function appleCanPlay(item, kind) {
    const source = state.sources.apple, capabilities = source?.capabilities || {};
    if (kind === 'artists' || item.playable === false) return false;
    if (source?.available === false || capabilities.playback !== true) return appleCanSubmitPlayIntent(item, kind);
    const supported = Array.isArray(capabilities.playableTypes) ? capabilities.playableTypes : ['songs'];
    return supported.includes(kind.endsWith('-songs') ? 'songs' : kind) || supported.includes(item.type);
  }
  function officialAlbumPlayback(kind) {
    const source = state.sources.apple;
    const available = source?.capabilities?.albumPlayback;
    return kind === 'album-songs' && source?.provider === 'officialWeb' ? available === true : null;
  }
  function applePlay(row, item, kind) {
    if (!appleCanPlay(item, kind)) return;
    return playRequest(row, {source: 'apple', id: item.id, kind: item.type || kind});
  }
  function appleDetailKind(item, kind) {
    const capabilities = state.sources.apple?.capabilities || {};
    const detailKind = item.type === 'library-albums' && kind === 'albums' ? 'album-songs'
      : item.type === 'library-playlists' && kind === 'playlists' ? 'playlist-songs' : null;
    return capabilities.library === true && Array.isArray(capabilities.detailKinds) && capabilities.detailKinds.includes(detailKind) ? detailKind : null;
  }
  function openAppleDetail(item, kind) {
    const detailKind = appleDetailKind(item, kind);
    if (!detailKind) return;
    appleReturn = {results: {...appleResults, loading: false}, scroll: $('appleContent').scrollTop};
    state.appleDetail = {id: item.id, kind: detailKind, title: clean(item.title, kind === 'albums' ? '未知专辑' : '未命名播放列表')};
    $('appleContent').scrollTop = 0; paintBrowseSource(); ensureApple();
  }
  function backFromAppleDetail() {
    appleFetchRevision++;
    state.appleDetail = null;
    const scroll = appleReturn?.scroll || 0;
    if (appleReturn) { appleResults = appleReturn.results; appleReturn = null; }
    paintBrowseSource(); ensureApple();
    $('appleContent').scrollTop = scroll;
  }
  function renderAppleCollection() {
    const parent = $('appleViewContent'), kind = appleKind(), detail = state.appleDetail, results = appleResults;
    const albumPlayback = officialAlbumPlayback(kind);
    const rovingItems = []; let rovingGrid = null;
    $('appleSectionTitle').textContent = state.appleDetail ? '曲目' : state.appleQuery ? `搜索结果 · ${labels[state.appleView][1]}` : labels[state.appleView][3];
    $('appleCollectionRefresh').textContent = !state.appleDetail && state.appleQuery ? '重新搜索' : '刷新曲库';
    $('appleCollectionRefresh').disabled = !appleCanRequest();
    const source = state.sources.apple, capabilities = source?.capabilities || {}, types = value => Array.isArray(value) ? value.filter(type => typeof type === 'string').slice().sort() : null;
    const controls = JSON.stringify([appleRequestKey(), appleCanRequest(), source?.available !== false, capabilities.playback === true, albumPlayback, types(capabilities.playableTypes), capabilities.canSubmitPlayIntent === true, types(capabilities.playIntentTypes), capabilities.library === true, types(capabilities.detailKinds)]);
    if (renderedAppleResults === appleResults && renderedAppleControls === controls) return;
    renderedAppleResults = appleResults; renderedAppleControls = controls;
    clearContent(parent);
    if (state.appleDetail) parent.append(button('返回', 'back-button', backFromAppleDetail, 'back'));
    if (appleResults.key !== appleRequestKey() || appleResults.loading && !appleResults.items.length) {
      $('appleItemCount').textContent = ''; parent.append(empty('正在读取 Apple Music', '请稍候。')); return;
    }
    if (appleResults.error && !appleResults.items.length) {
      $('appleItemCount').textContent = ''; parent.append(empty('无法读取 Apple Music', appleResults.error)); return;
    }
    const items = appleResults.items;
    $('appleItemCount').textContent = appleResults.total != null ? `${appleResults.total} 个` : `${items.length} 个`;
    announce($('appleResultStatus'), `${$('appleSectionTitle').textContent}，${$('appleItemCount').textContent}`);
    if (!items.length) {
      parent.append(empty(state.appleQuery ? '没有找到匹配结果' : '这里还没有内容', state.appleQuery ? '试试其他关键词。' : '当前曲库没有返回此类内容。', kind === 'albums' ? 'album' : kind === 'artists' ? 'artist' : kind === 'playlists' ? 'playlist' : 'music'));
      return;
    }
    if (kind === 'songs' || kind === 'album-songs' || kind === 'playlist-songs') {
      if (albumPlayback === false) parent.append(node('p', 'dialog-note', '专辑播放暂不可用。请查看连接状态，在 Apple Music 会话就绪后重试。'));
      const albumUnavailable = albumPlayback === true && results.albumPlayback !== true;
      if (albumUnavailable) parent.append(node('p', 'dialog-note', '此专辑目前无法完整播放。可在曲库或搜索中单独查找曲目。'));
      items.forEach(item => {
        const row = node('div', 'track-row'), titleCell = node('div', 'track-title-cell'), art = node('div', 'track-cover'), copy = node('div', 'track-cell track-title-copy');
        cover(art, item.coverUrl);
        const play = titled(node('button', 'track-play track-name', clean(item.title, '未知标题')), clean(item.title, '未知标题'));
        play.type = 'button';
        const albumTarget = albumPlayback === true && !albumUnavailable && detail && ['songs', 'library-songs'].includes(item.type);
        play.disabled = !appleCanPlay(item, kind) || (albumPlayback !== null && !albumTarget);
        if (!play.disabled) play.addEventListener('click', () => {
          if (state.browseSource !== 'apple' || state.immersive || appleStatusExpanded || state.appleDetail !== detail || appleResults !== results ||
              officialAlbumPlayback(kind) !== albumPlayback || !parent.contains(row) || !appleCanPlay(item, kind)) return;
          if (albumTarget) return playRequest(row, {source: 'apple', id: item.id, kind: item.type, album: {id: detail.id, index: item.index}});
          return applePlay(row, item, kind);
        });
        else if (albumUnavailable || (albumPlayback === true && item.playable === false)) play.title = '此曲目暂不支持随专辑播放，可在曲库或搜索中单独查找。';
        else play.title = albumPlayback === false ? '专辑播放暂不可用，请查看连接状态。' : '此来源的播放能力尚未就绪';
        copy.append(play, node('span', 'track-mobile-artist', clean(item.artist, '未知艺术家'))); titleCell.append(art, copy); row.append(titleCell);
        appendTrackMetadata(row, item);
        row.append(node('span', 'row-actions')); parent.append(row);
        rovingItems.push({key: `${results.key}:${item.index}:${item.id}`, controls: [play]});
      });
    } else if (kind === 'albums') {
      const grid = node('div', 'grid album-grid');
      rovingGrid = grid;
      for (const item of items) {
        const tile = node('div', 'tile apple-album'), detailKind = appleDetailKind(item, kind);
        const open = detailKind ? button('', 'album-open', () => openAppleDetail(item, kind)) : node('div', 'album-open');
        const art = node('span', 'tile-cover'), caption = node('span', 'tile-caption');
        if (detailKind) open.setAttribute('aria-label', `查看专辑 ${clean(item.title, '未知专辑')}`);
        cover(art, item.coverUrl, 'album');
        caption.append(node('span', 'tile-title', clean(item.title, '未知专辑')), node('span', 'tile-subtitle', clean(item.artist, '未知艺术家')));
        open.append(art, caption); tile.append(open);
        if (!detailKind) tile.append(node('span', 'album-unavailable', '此来源暂不支持查看曲目'));
        if (appleCanPlay(item, kind)) tile.append(button('播放专辑', 'text-button apple-item-play', () => applePlay(tile, item, kind), 'play'));
        rovingItems.push({key: `album:${item.type}:${item.id}`, controls: Array.from(tile.children).filter(element => element.tagName === 'BUTTON')});
        grid.append(tile);
      }
      parent.append(grid);
    } else {
      for (const item of items) {
        const row = node('div', 'list-row'), display = node('div', 'list-open'), art = node('span', 'list-icon'), copy = node('span', 'list-copy');
        cover(art, item.coverUrl, kind === 'artists' ? 'artist' : 'playlist');
        copy.append(node('strong', '', clean(item.title, kind === 'artists' ? '未知艺术家' : '未命名播放列表')));
        if (item.artist) copy.append(node('small', '', item.artist));
        display.append(art, copy); row.append(display);
        if (appleDetailKind(item, kind)) row.append(button('查看曲目', 'text-button with-icon', () => openAppleDetail(item, kind), 'chevron'));
        if (appleCanPlay(item, kind)) row.append(button('播放', 'text-button with-icon', () => applePlay(row, item, kind), 'play'));
        rovingItems.push({key: `${kind}:${item.id}`, controls: Array.from(row.children).filter(element => element.tagName === 'BUTTON')});
        parent.append(row);
      }
    }
    if (appleResults.error) parent.append(node('p', 'dialog-note', appleResults.error));
    if (appleResults.nextOffset != null) {
      const more = button(appleResults.loading ? '正在读取…' : '显示更多', 'button apple-load-more', () => fetchApple(true));
      more.disabled = appleResults.loading || !appleCanRequest(); parent.append(more);
    }
    configureRoving(parent, rovingItems, rovingGrid, 'apple', $('appleSectionTitle').textContent);
  }
  async function fetchApple(append = false) {
    if (!appleCanRequest()) return;
    const kind = appleKind(), query = state.appleDetail ? '' : state.appleQuery, key = appleRequestKey();
    const offset = append && appleResults.key === key ? appleResults.nextOffset : 0;
    if (offset == null || (append && appleResults.loading)) return;
    const token = ++appleFetchRevision, before = append ? appleResults.items : [];
    const previousAlbumPlayback = append ? appleResults.albumPlayback : undefined;
    appleResults = {key, items: before, loading: true, error: '', nextOffset: append ? offset : null, total: append ? appleResults.total : null, albumPlayback: previousAlbumPlayback};
    renderApple();
    const current = () => token === appleFetchRevision && key === appleRequestKey() && appleCanRequest();
    const result = query
      ? await invoke('apple:search', {term: query, types: [kind], limit: 25, offset}, {isCurrent: current})
      : await invoke('apple:library', {kind, ...(state.appleDetail ? {id: state.appleDetail.id} : {}), limit: 100, offset}, {isCurrent: current});
    if (token !== appleFetchRevision || key !== appleRequestKey() || !appleCanRequest()) return;
    if (!result || !Array.isArray(result.items)) {
      appleResults = {...appleResults, loading: false, error: '请查看连接状态并重试。', nextOffset: append ? offset : null}; renderApple(); return;
    }
    const received = result.items.flatMap((item, index) => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[A-Za-z0-9._-]{1,256}$/.test(item.id) ||
          (item.type != null && !/^(?:library-)?(?:songs?|albums?|artists?|playlists?)$/.test(item.type) &&
            !(kind === 'album-songs' && item.type === 'music-videos'))) return [];
      return [{id: item.id, type: typeof item.type === 'string' ? item.type : kind,
        index: kind === 'album-songs' && Number.isSafeInteger(item.index) && item.index >= 0 ? item.index : offset + index,
        title: typeof item.title === 'string' ? item.title : '', artist: typeof item.artist === 'string' ? item.artist : '',
        album: typeof item.album === 'string' ? item.album : '', duration: Number.isFinite(item.duration) ? item.duration : null,
        coverUrl: typeof item.coverUrl === 'string' ? item.coverUrl : '', playable: item.playable}];
    });
    const nextOffset = Number.isInteger(result.nextOffset) && result.nextOffset > offset ? result.nextOffset
      : result.hasMore === true && result.items.length ? offset + result.items.length : null;
    const discarded = result.items.length - received.length;
    const albumPlayback = previousAlbumPlayback === false || (kind === 'album-songs' && result.albumPlayback !== true) ? false : result.albumPlayback;
    appleResults = {key, items: [...before, ...received], loading: false, error: discarded ? `有 ${discarded} 项标识或类型无效，未显示。` : '', nextOffset, total: Number.isFinite(result.total) && result.total >= 0 ? result.total : null, albumPlayback};
    renderApple();
  }
  function ensureApple() {
    if (state.browseSource !== 'apple') return;
    if (!appleCanRequest()) {
      appleFetchRevision++;
      if (hasCachedAppleSongIntent()) { if (appleResults.loading) appleResults = {...appleResults, loading: false}; }
      else appleResults = {key: '', items: [], loading: false, error: '', nextOffset: null, total: null};
      renderApple(); return;
    }
    if (appleResults.key !== appleRequestKey()) fetchApple();
  }
  function paintBrowseSource() {
    const apple = state.browseSource === 'apple';
    $('sourceLocal').classList.toggle('active', !apple); $('sourceLocal').setAttribute('aria-pressed', String(!apple));
    $('sourceApple').classList.toggle('active', apple); $('sourceApple').setAttribute('aria-pressed', String(apple));
    $('localNavigation').hidden = apple; $('appleNavigation').hidden = !apple;
    $('sourceTitle').textContent = apple ? 'Apple Music' : '本地音乐';
    $('sourceSubtitle').textContent = apple ? 'SUBSCRIPTION' : 'LOCAL LIBRARY';
    $('navCaption').textContent = apple ? '订阅曲库' : '音乐收藏';
    $('breadcrumbSource').textContent = apple ? 'Apple Music' : '本地音乐';
    $('breadcrumbCurrent').textContent = labels[apple ? state.appleView : state.view][1];
    $('localTopActions').hidden = apple;
    $('appleTopActions').hidden = !apple;
    if (!state.immersive) { $('content').hidden = apple; $('appleContent').hidden = !apple; }
    if (apple) renderApple();
    renderConnection();
  }
  function setBrowseSource(source) {
    if (!['local', 'apple'].includes(source)) return;
    if (source !== state.browseSource) {
      if (state.browseSource === 'local' && cancelSearch(true)) state.viewDirty = true;
      if (state.immersive && extensions.features) extensions.features.leaveImmersive();
      if (state.browseSource === 'local') { localScroll = $('content').scrollTop; releaseCovers($('viewContent'), true); }
      else { appleScroll = $('appleContent').scrollTop; releaseCovers($('appleViewContent'), true); }
      state.browseSource = source;
      paintBrowseSource();
      if (source === 'local') {
        if (state.viewDirty) { state.viewDirty = false; render(); }
        else restoreCovers($('viewContent'));
        $('content').scrollTop = localScroll;
      } else { $('appleContent').scrollTop = appleScroll; ensureApple(); restoreCovers($('appleViewContent')); }
    } else paintBrowseSource();
  }
  function applySourceStatus(value) {
    if (!value || typeof value !== 'object') return;
    const wasAvailable = localCanPlayTarget();
    const hadAppleLibrary = state.sources.apple?.capabilities?.library === true;
    if (value.sources && typeof value.sources === 'object') state.sources = {...state.sources, ...value.sources};
    if (!hadAppleLibrary && state.sources.apple?.capabilities?.library === true) appleStatusExpanded = false;
    paintBrowseSource();
    if (state.ready) updateControlAvailability();
    ensureApple();
    if (state.ready && wasAvailable !== localCanPlayTarget()) {
      if (state.immersive || state.browseSource !== 'local') state.viewDirty = true; else render();
    }
  }
  function applyAppleStatus(apple) {
    if (!apple || typeof apple !== 'object') return;
    if (state.sources.apple?.capabilities?.library !== true && apple.capabilities?.library === true) appleStatusExpanded = false;
    state.sources = {...state.sources, apple}; paintBrowseSource(); if (state.ready) updateControlAvailability(); ensureApple();
  }
  async function selectSource(source) {
    if (source === state.browseSource) return;
    const previous = state.browseSource, generation = ++sourceGeneration;
    setBrowseSource(source);
    const result = await invoke('source:select', {source}, {isCurrent: () => generation === sourceGeneration});
    if (generation !== sourceGeneration) return;
    if (result?.sources) applySourceStatus(result);
    if (result?.selectedSource === source) setBrowseSource(source);
    else setBrowseSource(previous);
  }
  function setAppleView(view) {
    if (!labels[view]) return;
    if (state.immersive && extensions.features) extensions.features.leaveImmersive();
    state.appleView = view; state.appleDetail = null; appleReturn = null; appleStatusExpanded = false;
    document.querySelectorAll('.nav-item[data-apple-view]').forEach(item => {
      const active = item.dataset.appleView === view;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    });
    $('appleContent').scrollTop = 0; paintBrowseSource(); ensureApple();
  }
  function groupBy(items, keyFn) {
    const groups = new Map();
    for (const item of items) {
      const key = keyFn(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups.entries()].sort((a, b) => Number(!a[0] || a[0].startsWith('\u0000')) - Number(!b[0] || b[0].startsWith('\u0000')) || a[0].localeCompare(b[0], 'zh-CN'));
  }
  const albumKey = track => `${track.album || ''}\u0000${track.albumArtist || track.artist || ''}`;
  function openDetail(detail) {
    cancelSearch(true);
    detailReturnScroll = $('content').scrollTop;
    detailReturnQuery = state.query; state.query = ''; $('search').value = '';
    state.detail = detail; state.sort = 'order'; $('sortSelect').value = 'order';
    $('content').scrollTop = 0; render();
  }
  function backFromDetail() {
    cancelSearch();
    state.detail = null; state.sort = 'order'; $('sortSelect').value = 'order';
    state.query = detailReturnQuery; $('search').value = detailReturnQuery;
    render(); $('content').scrollTop = detailReturnScroll;
  }
  function detailEntries() {
    const detail = state.detail;
    if (!detail) return [];
    if (detail.type === 'playlist') {
      const list = playlists().find(item => item.id === detail.id);
      if (!list) return [];
      const byId = new Map(tracks().map(track => [track.id, track]));
      return (Array.isArray(list.trackIds) ? list.trackIds : []).map((id, originalIndex) => ({
        track: byId.get(id) || {id, title: '曲目不可用', valid: false}, originalIndex
      }));
    }
    const selected = tracks().filter(track => detail.type === 'album' ? albumKey(track) === detail.key : String(track.artist || '') === detail.key);
    if (detail.type === 'album') selected.sort((a, b) => (Number(a.discNumber) || 0) - (Number(b.discNumber) || 0) || (Number(a.trackNumber) || 0) - (Number(b.trackNumber) || 0));
    return selected.map((track, originalIndex) => ({track, originalIndex}));
  }
  function sorted(entries) {
    if (state.sort === 'order') return entries;
    const key = state.sort;
    return [...entries].sort((a, b) => key === 'duration'
      ? (Number(a.track.duration) || 0) - (Number(b.track.duration) || 0)
      : String(a.track[key] || '').localeCompare(String(b.track[key] || ''), 'zh-CN', {numeric: true}));
  }
  async function playRequest(row, payload) {
    const generation = ++playbackGeneration;
    if (pendingRow) { pendingRow.classList.remove('preparing'); pendingRow.removeAttribute('aria-busy'); }
    pendingRow = row; row.classList.add('preparing'); row.setAttribute('aria-busy', 'true');
    try {
      const result = await invoke('player:play', payload, {isCurrent: () => generation === playbackGeneration});
      if (generation === playbackGeneration && result) { updatePlayer(result); if (result.skippedCount) notify(`已跳过 ${result.skippedCount} 首不可播放的曲目。`); }
    } finally {
      if (generation === playbackGeneration && pendingRow) {
        pendingRow.classList.remove('preparing'); pendingRow.removeAttribute('aria-busy'); pendingRow = null;
      }
    }
  }
  function appendTrackMetadata(row, track) {
    const artist = clean(track.artist, '未知艺术家'), album = clean(track.album, '未知专辑');
    row.append(titled(node('span', 'track-cell track-artist', artist), artist), titled(node('span', 'track-cell track-album', album), album),
      node('span', 'track-cell track-duration', track.duration ? time(track.duration) : '—'));
  }
  function trackList(entries, parent) {
    entries.forEach((entry, index) => {
      const track = entry.track;
      const row = node('div', `track-row${track.valid === false || track.supported === false ? ' invalid' : ''}${state.player.source === 'local' && track.id === state.player.currentTrackId ? ' current' : ''}`);
      localRows.push({row, id: track.id});
      const titleCell = node('div', 'track-title-cell'), art = node('div', 'track-cover'), copy = node('div', 'track-cell track-title-copy');
      cover(art, track.coverUrl, 'music', coverReference([track.id]));
      const play = titled(node('button', 'track-play track-name', clean(track.title, '未知标题')), clean(track.title, '未知标题'));
      play.type = 'button';
      const playable = localCanPlayTarget() && track.valid !== false && track.supported !== false;
      play.disabled = !playable;
      if (playable) play.addEventListener('click', () => playRequest(row, {source: 'local', trackId: track.id, trackIds: entries.map(item => item.track.id), startIndex: index}));
      copy.append(play, node('span', 'track-mobile-artist', clean(track.artist, '未知艺术家')));
      if (track.valid === false || track.supported === false) copy.append(node('span', 'track-state', track.valid === false ? '文件不可用' : '不支持播放'));
      titleCell.append(art, copy); row.append(titleCell);
      appendTrackMetadata(row, track);
      const actions = node('div', 'row-actions');
      if (extensions.features) extensions.features.trackActions(actions, track, entry.originalIndex, entries, state.detail);
      row.append(actions); parent.append(row);
      localRovingItems.push({key: state.detail?.type === 'playlist' ? `playlist:${state.detail.id}:${entry.originalIndex}:${track.id}` : `track:${state.view}:${state.detail?.key || ''}:${track.id}`, controls: [play, ...Array.from(actions.children).filter(element => element.tagName === 'BUTTON')]});
    });
  }
  function render() {
    const scroll = $('content').scrollTop;
    renderLocal();
    configureRoving($('viewContent'), localRovingItems, localRovingGrid, 'local', $('sectionTitle').textContent);
    $('content').scrollTop = scroll;
    announce($('localResultStatus'), `${$('sectionTitle').textContent}，${$('itemCount').textContent}`);
  }
  function renderLocal() {
    normalizedQuery = state.query.trim().toLocaleLowerCase();
    localRows = []; localRovingItems = []; localRovingGrid = null; paintLibraryStatus();
    const [eyebrow, title, description, section] = labels[state.view];
    $('createPlaylist').hidden = state.view !== 'playlists' || !!state.detail;
    $('pageEyebrow').textContent = eyebrow; $('pageTitle').textContent = title;
    $('pageDescription').textContent = description; $('breadcrumbCurrent').textContent = title;
    const currentList = state.detail?.type === 'playlist' ? playlists().find(item => item.id === state.detail.id) : null;
    if (state.detail?.type === 'playlist' && !currentList) state.detail = null;
    const detailTitle = currentList ? clean(currentList.name, '未命名播放列表') : state.detail?.title;
    $('content').classList.toggle('is-gallery', state.view === 'albums' && !state.detail);
    $('content').classList.toggle('is-detail', !!state.detail);
    $('sectionTitle').textContent = detailTitle || section;
    $('sectionTitle').title = detailTitle || section;
    $('sectionHint').textContent = state.detail?.subtitle || '';
    $('sortControl').hidden = !state.detail && state.view !== 'library';
    const content = $('viewContent'); clearContent(content);
    if (!state.ready) { $('itemCount').textContent = ''; content.append(empty('正在准备音乐库', '请稍候。')); return; }
    const filtered = state.detail || state.view === 'playlists' ? null : normalizedQuery ? tracks().filter(matches) : tracks();
    if (state.detail) {
      const entries = sorted(detailEntries().filter(entry => matches(entry.track)));
      content.append(button('返回', 'back-button', backFromDetail, 'back'));
      const layout = node('div', `detail-layout detail-${state.detail.type}`);
      const hero = node('div', 'collection-detail'), art = node('div', 'detail-cover'), copy = node('div', 'detail-copy'), songs = node('div', 'detail-tracks');
      cover(art, entries.find(entry => entry.track.coverUrl)?.track.coverUrl, state.detail.type === 'artist' ? 'artist' : state.detail.type === 'playlist' ? 'playlist' : 'album', coverReference(entries.map(entry => entry.track.id)));
      copy.append(node('h2', '', detailTitle || title), node('p', '', [state.detail.subtitle, `${entries.length} 首曲目`].filter(Boolean).join(' · ')));
      const firstPlayable = entries.findIndex(entry => entry.track.valid !== false && entry.track.supported !== false);
      const playAll = button('播放', 'button primary detail-play', () => playRequest(hero, {source: 'local', trackId: entries[firstPlayable].track.id, trackIds: entries.map(entry => entry.track.id), startIndex: firstPlayable}), 'play');
      playAll.disabled = !localCanPlayTarget() || firstPlayable < 0;
      copy.append(playAll);
      hero.append(art, copy); layout.append(hero, songs); content.append(layout);
      $('itemCount').textContent = `${entries.length} 首`;
      if (entries.length) trackList(entries, songs);
      else songs.append(empty(state.query ? '没有找到匹配的曲目' : '这里还没有曲目', state.query ? '试试其他关键词。' : '可以从曲目菜单添加音乐。'));
      return;
    }
    if (state.view === 'library') {
      const entries = sorted(filtered.map((track, originalIndex) => ({track, originalIndex})));
      $('itemCount').textContent = `${entries.length} 首`;
      if (entries.length) trackList(entries, content);
      else content.append(empty(state.query ? '没有找到匹配的曲目' : '音乐库还是空的', state.query ? '试试其他关键词。' : '导入文件或文件夹，让喜欢的音乐在这里相遇。'));
      return;
    }
    if (state.view === 'albums') {
      const groups = groupBy(filtered, albumKey).sort((a, b) => {
        const rank = group => !clean(group[0].album, '') ? 2 : group.some(track => track.coverUrl) ? 0 : 1;
        return rank(a[1]) - rank(b[1]);
      });
      $('itemCount').textContent = `${groups.length} 张`;
      if (!groups.length) { content.append(empty(state.query ? '没有找到匹配的专辑' : '还没有专辑', state.query ? '试试其他关键词。' : '导入音乐后，专辑会显示在这里。', 'album')); return; }
      const grid = node('div', 'grid album-grid');
      localRovingGrid = grid;
      for (const [key, group] of groups) {
        const name = clean(group[0].album, '未知专辑'), artist = clean(group[0].albumArtist || group[0].artist, '未知艺术家');
        const tile = titled(node('button', 'tile'), `${name} · ${artist}`), art = node('div', 'tile-cover');
        tile.type = 'button'; cover(art, group.find(track => track.coverUrl)?.coverUrl, 'album', coverReference(group.map(track => track.id)));
        tile.setAttribute('aria-label', `查看专辑 ${name} · ${artist}`);
        const caption = node('span', 'tile-caption'), meta = node('span', 'tile-meta');
        caption.append(node('span', 'tile-title', name), node('span', 'tile-subtitle', artist));
        meta.append(node('span', 'tile-count', `${group.length} 首`), icon('chevron'));
        tile.append(art, caption, meta);
        tile.addEventListener('click', () => openDetail({type: 'album', key, title: name, subtitle: artist})); grid.append(tile); localRovingItems.push({key: `album:${key}`, controls: [tile]});
      }
      content.append(grid); return;
    }
    if (state.view === 'artists') {
      const groups = groupBy(filtered, track => String(track.artist || ''));
      $('itemCount').textContent = `${groups.length} 位`;
      if (!groups.length) { content.append(empty(state.query ? '没有找到匹配的艺术家' : '还没有艺术家', state.query ? '试试其他关键词。' : '导入音乐后，艺术家会显示在这里。', 'artist')); return; }
      const artistGrid = node('div', 'artist-grid');
      localRovingGrid = artistGrid;
      for (const [key, group] of groups) {
        const name = clean(key, '未知艺术家'), row = node('div', 'list-row'), open = titled(node('button', 'list-open'), name), art = node('span', 'list-icon'), copy = node('span', 'list-copy');
        open.type = 'button'; cover(art, group.find(track => track.coverUrl)?.coverUrl, 'artist', coverReference(group.map(track => track.id)));
        copy.append(node('strong', '', name), node('small', '', `${group.length} 首曲目`));
        const chevron = icon('chevron'); chevron.setAttribute('class', 'icon list-chevron');
        open.append(art, copy, chevron); open.addEventListener('click', () => openDetail({type: 'artist', key, title: name, subtitle: `${group.length} 首曲目`}));
        row.append(open); artistGrid.append(row); localRovingItems.push({key: `artist:${key}`, controls: [open]});
      }
      content.append(artistGrid);
      return;
    }
    const q = state.query.trim().toLocaleLowerCase();
    const lists = playlists().filter(list => !q || String(list.name || '').toLocaleLowerCase().includes(q));
    $('itemCount').textContent = `${lists.length} 个`;
    if (!lists.length) { content.append(empty(q ? '没有找到匹配的播放列表' : '还没有播放列表', q ? '试试其他关键词。' : '新建列表，把喜欢的曲目留在一起。', 'playlist')); return; }
    const byId = new Map(tracks().map(track => [track.id, track]));
    for (const list of lists) {
      const ids = Array.isArray(list.trackIds) ? list.trackIds : [];
      const name = clean(list.name, '未命名播放列表'), row = node('div', 'list-row'), open = titled(node('button', 'list-open'), name), art = node('span', 'list-icon'), copy = node('span', 'list-copy');
      open.type = 'button'; cover(art, ids.map(id => byId.get(id)).find(track => track?.coverUrl)?.coverUrl, 'playlist', coverReference(ids));
      copy.append(node('strong', '', name), node('small', '', `${ids.length} 首曲目${list.source === 'foobar2000' ? ' · 导入的副本' : ''}`));
      const chevron = icon('chevron'); chevron.setAttribute('class', 'icon list-chevron');
      open.append(art, copy, chevron); open.addEventListener('click', () => openDetail({type: 'playlist', id: list.id, title: name, subtitle: list.source === 'foobar2000' ? '导入的列表副本' : ''}));
      row.append(open);
      if (extensions.features) extensions.features.playlistActions(row, list);
      content.append(row); localRovingItems.push({key: `playlist:${list.id}`, controls: [open, ...Array.from(row.children).filter(element => element.tagName === 'BUTTON' && element !== open)]});
    }
  }
  function applyLibrary(library) {
    if (library) libraryStore.receive(library);
  }
  function acceptLibrary(library, change) {
    state.library = library;
    if (!state.ready) return;
    if (change.full || change.statusChanged) paintLibraryStatus();
    if (change.full || change.structural || change.playlistsChanged || change.foldersChanged) { if (state.immersive || state.browseSource !== 'local') state.viewDirty = true; else render(); }
    else refreshTrackCovers(change.coverTrackIds);
    if (extensions.features) extensions.features.libraryChanged(change);
  }
  function applySettings(settings) {
    if (!settings) return;
    state.settings = settings;
    document.body.classList.toggle('reduced-motion', !!settings.appearance?.reducedMotion);
    extensions.glass?.settingsChanged(settings);
    if (extensions.features) extensions.features.settingsChanged(settings);
  }
  function updateControlAvailability() {
    const player = state.player, available = player.available === true;
    const applePlayback = (player.source || player.lastSource) === 'apple';
    const capabilities = state.sources.apple?.capabilities || {};
    const allowed = name => capabilities[name] === true || capabilities.controls?.[name] === true;
    for (const [id, label] of [['previous', '上一曲'], ['toggle', player.state === 'playing' ? '暂停' : '播放'], ['next', '下一曲']]) {
      const startsLocalPlayback = !applePlayback && (id !== 'toggle' || player.state !== 'playing');
      const blockedLocal = startsLocalPlayback && !localAvailable();
      $(id).disabled = !available || (applePlayback && !allowed(id)) || blockedLocal;
      $(id).title = applePlayback && !allowed(id) ? `Apple Music ${label}控制尚不可用` : blockedLocal ?
        state.sources.local?.message || '请先检查原音频设备与播放内核' : label;
    }
    $('seek').disabled = !available || !(Number(player.duration) > 0) || (applePlayback && !allowed('seek'));
    $('waveSeek').classList.toggle('disabled', $('seek').disabled);
    $('volume').disabled = !available || !Number.isFinite(player.volume) || (applePlayback && !allowed('volume'));
    $('volume').title = applePlayback && !allowed('volume') ? '当前 Apple Music 音量控制尚不可用' : '音量';
    const orders = Array.isArray(player.playbackOrders) ? player.playbackOrders : [];
    const orderReady = applePlayback ? capabilities.order === true && player.controlsReady === true : localAvailable();
    $('playbackOrder').disabled = !available || !orders.length || !orderReady;
    $('playbackOrder').title = !available || !orderReady ? (applePlayback ? '当前 Apple Music 播放顺序控制尚不可用' : '本地播放顺序控制尚不可用') :
      player.playbackOrder?.name ? `播放顺序：${player.playbackOrder.name}` : '播放顺序';
    extensions.glass?.controlsChanged();
  }
  function updatePlayer(player) {
    if (!player || typeof player !== 'object') return;
    const generation = player.generation, revision = player.revision;
    if (Number.isInteger(generation) && generation >= 0 && Number.isInteger(revision) && revision >= 0) {
      if (generation < seenPlayerGeneration || (generation === seenPlayerGeneration && revision < seenPlayerRevision)) return;
      if (generation > seenPlayerGeneration) { seenPlayerGeneration = generation; seenPlayerRevision = -1; }
      seenPlayerRevision = Math.max(seenPlayerRevision, revision);
    } else if (seenPlayerGeneration >= 0) return;
    const previous = state.player;
    if (seekOwner && seekOwner !== playbackIdentity(player)) { seeking = false; seekOwner = null; seekCanceled = true; }
    if (volumeOwner && volumeOwner !== player.source) { volumeEditing = false; volumeOwner = null; volumeCanceled = true; }
    const availabilityChanged = (previous.available === true) !== (player.available === true);
    const trackChanged = previous.currentTrackId !== player.currentTrackId || previous.currentTrack?.path !== player.currentTrack?.path || previous.source !== player.source || previous.lastSource !== player.lastSource;
    state.player = player;
    const available = player.available === true;
    renderConnection();
    const current = player.currentTrack || ((player.source || player.lastSource) === 'apple' ? null : tracks().find(track => track.id === player.currentTrackId));
    $('nowTitle').textContent = current ? clean(current.title, '未知标题') : '没有正在播放的音乐';
    $('nowTitle').title = current ? clean(current.title, '未知标题') : '';
    $('nowTitle').disabled = !current;
    $('nowSource').textContent = player.source === 'local' ? '本地音乐' : player.source === 'apple' ? 'Apple Music' : '尚无播放来源';
    const fixture = player.simulatedUIFixture === true;
    $('nowFixture').hidden = !fixture;
    $('nowFixture').textContent = fixture ? clean(player.fixtureLabel, '测试歌词 / 非真实匹配') : '';
    $('playerFooter').classList.toggle('fixture-player', fixture);
    $('nowArtist').textContent = current ? clean(current.artist, '未知艺术家') : (available ? '选择一首曲目开始聆听' : '请查看音乐来源的连接状态');
    $('nowArtist').title = $('nowArtist').textContent;
    if (lastCover !== (current?.coverUrl || '')) { lastCover = current?.coverUrl || ''; cover($('miniCover'), lastCover); }
    const playing = player.state === 'playing';
    $('toggleIcon').setAttribute('href', playing ? '#i-pause' : '#i-play');
    $('toggle').setAttribute('aria-label', playing ? '暂停' : '播放'); $('toggle').title = playing ? '暂停' : '播放';
    const duration = Math.max(0, Number(player.duration) || 0), position = Math.max(0, Number(player.position) || 0);
    $('duration').textContent = time(duration);
    if (!seeking) { $('elapsed').textContent = time(position); $('seek').value = String(Math.min(position, duration)); }
    $('seek').max = String(duration);
    if (!volumeEditing && Number.isFinite(player.volume)) $('volume').value = String(Math.max(0, Math.min(1, player.volume)));
    paintRange($('seek')); paintRange($('volume'));
    const orders = Array.isArray(player.playbackOrders) ? player.playbackOrders : [];
    const orderSignature = JSON.stringify(orders);
    if ($('playbackOrder').dataset.signature !== orderSignature) {
      $('playbackOrder').replaceChildren();
      if (!orders.length) $('playbackOrder').append(node('option', '', '播放顺序'));
      for (const order of orders) { const option = node('option', '', clean(order.name, String(order.id))); option.value = String(order.id); $('playbackOrder').append(option); }
      $('playbackOrder').dataset.signature = orderSignature;
    }
    if (player.playbackOrder?.id != null) $('playbackOrder').value = String(player.playbackOrder.id);
    updateControlAvailability();
    extensions.glass?.playerChanged(player);
    if (extensions.features) extensions.features.playerChanged(player, previous);
    if (trackChanged) for (const {row, id} of localRows) row.classList.toggle('current', player.source === 'local' && id === player.currentTrackId);
    if (state.ready && availabilityChanged) {
      if (state.immersive || state.browseSource !== 'local') state.viewDirty = true; else render();
    }
  }
  async function importMusic(kind) {
    const result = await invoke('library:import', {kind});
    if (result) {
      applyLibrary(result);
      const report = result.importReport;
      if (report) {
        const count = Number.isFinite(report.indexedCount) ? `已索引 ${report.indexedCount} 首。` : '音乐库已更新。';
        const warnings = Array.isArray(report.warnings) ? report.warnings.filter(Boolean) : [];
        if (report.backendPrepared === false && !warnings.length) warnings.push('播放准备未确认。请查看本地内核状态与导入诊断。');
        if (warnings.length) {
          const body = node('div');
          body.append(node('p', 'dialog-note', count), ...warnings.map(warning => node('p', 'dialog-note', warning)));
          openDialog('导入结果', body);
        } else notify(count);
      }
    }
  }
  function openDialog(title, content) {
    extensions.glass?.dialogChanging();
    extensions.features?.stashSettingsControls();
    $('dialogTitle').textContent = title;
    $('dialogAlert').hidden = true; $('dialogAlert').textContent = '';
    clearContent($('dialogBody'), ...(Array.isArray(content) ? content : [content]));
    if (!$('dialog').open) $('dialog').showModal();
  }
  function closeDialog() { if ($('dialog').open) $('dialog').close(); }

  document.querySelectorAll('.nav-item[data-view]').forEach(item => item.addEventListener('click', () => setView(item.dataset.view, {persist: true})));
  document.querySelectorAll('.nav-item[data-apple-view]').forEach(item => item.addEventListener('click', () => setAppleView(item.dataset.appleView)));
  $('sourceLocal').addEventListener('click', () => selectSource('local'));
  $('sourceApple').addEventListener('click', () => selectSource('apple'));
  function submitAppleSearch() {
    if (state.sources.apple?.capabilities?.search !== true) return;
    state.appleQuery = $('appleSearch').value.trim(); state.appleDetail = null; appleReturn = null; appleStatusExpanded = false; appleFetchRevision++;
    appleResults = {key: '', items: [], loading: false, error: '', nextOffset: null, total: null};
    $('appleContent').scrollTop = 0; paintBrowseSource(); ensureApple();
  }
  $('appleSearch').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); submitAppleSearch(); } });
  $('appleSearchSubmit').addEventListener('click', submitAppleSearch);
  $('appleShowStatus').addEventListener('click', () => { appleStatusExpanded = true; renderApple(); });
  $('appleBackCollection').addEventListener('click', () => { appleStatusExpanded = false; renderApple(); ensureApple(); });
  $('retryLocal').addEventListener('click', async () => {
    if (state.sources.local?.capabilities?.retryBackend !== true || localRetryPending) return;
    localRetryPending = true; renderConnection();
    try { const result = await invoke('backend:retry'); if (result) applySourceStatus(result); }
    finally { localRetryPending = false; renderConnection(); }
  });
  $('appleRefresh').addEventListener('click', async () => {
    const result = await invoke('apple:status');
    if (!result) return;
    const apple = result.sources?.apple || result.apple || result;
    applyAppleStatus(apple);
    extensions.glass?.retryArtwork();
    if (appleCanRequest() && !appleResults.loading) fetchApple();
  });
  $('appleCollectionRefresh').addEventListener('click', async () => { await fetchApple(); extensions.glass?.retryArtwork(); });
  $('appleAuthorize').addEventListener('click', async () => {
    if (state.sources.apple?.capabilities?.authorize !== true || appleAuthorizationPending) return;
    appleAuthorizationPending = true; paintBrowseSource();
    try {
      const result = await invoke('apple:authorize');
      if (!result) return;
      const descriptor = result.status && typeof result.status === 'object' ? result.status : result.id === 'apple' ? result : null;
      if (descriptor) applyAppleStatus(descriptor);
      else if (!result.canceled) {
        const latest = await invoke('apple:status');
        if (latest) applyAppleStatus(latest);
      }
    } finally { appleAuthorizationPending = false; paintBrowseSource(); }
  });
  $('search').addEventListener('input', scheduleSearch);
  $('search').addEventListener('compositionstart', () => { composingSearch = true; cancelSearch(); });
  $('search').addEventListener('compositionend', () => { composingSearch = false; scheduleSearch(); });
  $('search').addEventListener('keydown', event => { if (event.key === 'Enter' && !composingSearch) { event.preventDefault(); cancelSearch(true); if (state.browseSource === 'local' && !state.immersive) render(); } });
  $('sortSelect').addEventListener('change', event => { state.sort = event.target.value; render(); });
  $('importFiles').addEventListener('click', () => importMusic('files'));
  $('importFolder').addEventListener('click', () => importMusic('folder'));
  $('refreshButton').addEventListener('click', async () => { const result = await invoke('library:refresh'); if (result) applyLibrary(result); extensions.glass?.retryArtwork(); });
  $('closeDialog').addEventListener('click', closeDialog);
  async function commandTransport(id) {
    const channel = {previous: 'player:previous', toggle: 'player:toggle', next: 'player:next'}[id];
    if (!channel || $(id).disabled) return null;
    transportPending++;
    try { const result = await invoke(channel); if (result) updatePlayer(result); return result; }
    finally { transportPending--; }
  }
  for (const id of ['previous', 'toggle', 'next']) $(id).addEventListener('click', () => commandTransport(id));
  function playbackIdentity(player = state.player) { return `${player.source || ''}:${player.currentTrackId || player.currentTrack?.id || ''}:${player.generation ?? ''}`; }
  function cancelSeekPreview() { if (seeking || seekOwner) seekCanceled = true; seeking = false; seekOwner = null; $('seek').value = String(Math.max(0, Math.min(Number(state.player.position) || 0, Number(state.player.duration) || 0))); $('elapsed').textContent = time(Number($('seek').value)); paintRange($('seek')); }
  const beginSeek = () => { seekOwner = playbackIdentity(); seekCanceled = false; };
  $('seek').addEventListener('pointerdown', beginSeek);
  $('seek').addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) beginSeek(); });
  $('seek').addEventListener('input', event => { if (seekCanceled) { cancelSeekPreview(); return; } if (!seekOwner) seekOwner = playbackIdentity(); seeking = true; $('elapsed').textContent = time(Number(event.target.value)); paintRange(event.target); });
  $('seek').addEventListener('change', async event => {
    const canceled = seekCanceled || (seekOwner && seekOwner !== playbackIdentity()); seeking = false; seekOwner = null; seekCanceled = false;
    if ($('seek').disabled || canceled) { updatePlayer(state.player); return; }
    const result = await invoke('player:seek', {position: Number(event.target.value)}); if (result) updatePlayer(result); else updatePlayer(state.player);
  });
  $('seek').addEventListener('pointercancel', () => { cancelSeekPreview(); updatePlayer(state.player); });
  $('seek').addEventListener('pointermove', event => {
    const seek = $('seek'), rect = seek.getBoundingClientRect();
    if (seek.disabled || !(rect.width > 0) || !Number.isFinite(event.clientX)) return;
    seek.title = time(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * Number(seek.max));
  });
  $('seek').addEventListener('pointerleave', () => { $('seek').title = time(Number($('seek').value)); });
  const beginVolume = () => { volumeOwner = state.player.source; volumeCanceled = false; };
  $('volume').addEventListener('pointerdown', beginVolume);
  $('volume').addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) beginVolume(); });
  $('volume').addEventListener('input', event => { if (volumeCanceled) { updatePlayer(state.player); return; } if (!volumeOwner) volumeOwner = state.player.source; volumeEditing = true; paintRange(event.target); });
  $('volume').addEventListener('change', async event => { const canceled = volumeCanceled || (volumeOwner && volumeOwner !== state.player.source); volumeEditing = false; volumeOwner = null; volumeCanceled = false; if ($('volume').disabled || canceled) { updatePlayer(state.player); return; } const result = await invoke('player:volume', {volume: Number(event.target.value)}); if (result) updatePlayer(result); else updatePlayer(state.player); });
  $('volume').addEventListener('pointercancel', () => { volumeEditing = false; volumeOwner = null; volumeCanceled = true; updatePlayer(state.player); });
  let orderOwner = null;
  const orderOwnerKey = () => JSON.stringify([state.player.source || state.player.lastSource || 'local', state.player.generation, $('playbackOrder').dataset.signature]);
  $('playbackOrder').addEventListener('pointerdown', () => { orderOwner = orderOwnerKey(); });
  $('playbackOrder').addEventListener('keydown', event => {
    if (event.key === 'Escape') orderOwner = null;
    else orderOwner ??= orderOwnerKey();
  });
  for (const event of ['blur', 'pointercancel']) $('playbackOrder').addEventListener(event, () => { orderOwner = null; });
  $('playbackOrder').addEventListener('change', async event => {
    const stale = orderOwner !== null && orderOwner !== orderOwnerKey();
    orderOwner = null;
    const player = state.player, id = Number(event.target.value);
    if ($('playbackOrder').disabled || stale || !player.playbackOrders?.some(order => order.id === id)) { updatePlayer(player); return; }
    const payload = {id};
    if (Number.isSafeInteger(player.generation) && player.generation >= 0) Object.assign(payload, {source: player.source || player.lastSource || 'local', generation: player.generation});
    const result = await invoke('player:order', payload); if (result) updatePlayer(result); else updatePlayer(state.player);
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input, textarea, select, button, [contenteditable="true"]')) return;
    if (event.code === 'Space' && !$('toggle').disabled) { event.preventDefault(); $('toggle').click(); }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !$('seek').disabled) {
      event.preventDefault();
      const position = Math.max(0, Math.min(Number($('seek').max), Number($('seek').value) + (event.key === 'ArrowLeft' ? -5 : 5)));
      invoke('player:seek', {position}).then(result => { if (result) updatePlayer(result); });
    }
  });
  async function start() {
    if (started) return; started = true;
    if (!window.still?.invoke || !window.still?.on) {
      state.ready = true; updatePlayer(state.player); render(); notify('无法连接应用服务。'); return;
    }
    window.still.on('library', applyLibrary);
    window.still.on('player', updatePlayer);
    window.still.on('settings', applySettings);
    window.still.on('source', applySourceStatus);
    window.still.on('error', error => { if (error?.channel === 'library:sync') notify(error.message); });
    const data = await invoke('app:bootstrap');
    if (data) {
      applyLibrary(data.library || state.library); state.sources = data.sources || {}; state.capabilities = data.capabilities || {}; state.ready = true;
      if (labels[data.settings?.appearance?.localView]) state.view = data.settings.appearance.localView;
      document.querySelectorAll('.nav-item[data-view]').forEach(item => {
        const active = item.dataset.view === state.view; item.classList.toggle('active', active);
        if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
      });
      applySettings(data.settings || {}); updatePlayer(data.player);
      if (['local', 'apple'].includes(data.selectedSource)) setBrowseSource(data.selectedSource);
    }
    else { state.ready = true; updatePlayer(state.player); }
    render(); paintBrowseSource();
  }
  const actions = Object.freeze({
    acceptAppearance(appearance) { if (!appearance || !/^#[0-9A-Fa-f]{6}$/.test(appearance.accentColor) || !['none', 'color'].includes(appearance.accentMode)) return false; state.settings = {...state.settings, appearance: {...state.settings.appearance, accentColor: appearance.accentColor.toUpperCase(), accentMode: appearance.accentMode}}; return true; },
    acceptMusicBrainzContact(contact) { if (typeof contact !== 'string' || contact.length > 200) return false; state.settings = {...state.settings, onlineCovers: {...state.settings.onlineCovers, musicBrainzContact: contact}}; return true; },
    setListening(value) { if (typeof value !== 'boolean') return false; if (value) { if (cancelSearch(true)) state.viewDirty = true; releaseCovers($('viewContent'), true); releaseCovers($('appleViewContent'), true); restoreCovers($('immersive')); } else { releaseCovers($('immersive'), true); if (state.browseSource === 'apple') restoreCovers($('appleViewContent')); else if (!state.viewDirty) restoreCovers($('viewContent')); } state.immersive = value; return true; },
    clearViewDirty() { state.viewDirty = false; }
  });
  for (const id of ['importFiles', 'importFolder', 'createPlaylist', 'refreshButton']) markLibraryWrite($(id));
  return Object.freeze({state: readonly(state), actions, start, $, node, icon, button, titled, clean, time, cover, coverReference, releaseCovers, clearContent, configureRoving, retryVisibleArtwork, empty, notify, invoke, libraryWritable, markLibraryWrite, tracks: () => readonly(tracks()), playlists: () => readonly(playlists()), getTrack: id => readonly(libraryStore.getTrack(id)), localAvailable, playRequest, commandTransport, cancelSeekPreview, isPlaybackPending: () => !!pendingRow || transportPending > 0, render, updatePlayer, applyLibrary, applySettings, applyAppleStatus, openDetail, setView, selectSource, openDialog, closeDialog});
  }
  (window.StillModules ||= []).push({name: 'app', create: createApp});
})();
