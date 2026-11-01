'use strict';

(() => {
  (window.StillModules ||= []).push({name: 'features', create({app, timeline, glass}) {
  const {state, $, node, icon, button, clean, time, invoke, notify, openDialog, closeDialog} = app;
  let lyricDocument = null, lyricTrackId = null, lyricDialogTrack = null, lyricRevision = 0, searchRevision = 0, dialogRevision = 0;
  let follow = true, activeLine = -1, renderedLines = [], frame = null, anchorTime = 0, anchorPosition = 0;
  let lastArt = null, lastArtTrack = null, savedContentScroll = 0, savedAppleScroll = 0, coverMotion = null;
  let layoutFollowPending = false;
  let contactSequence = 0, pendingContact = null, contactRunning = false;

  function currentTrack() {
    if (state.player.currentTrack) return state.player.currentTrack;
    if ((state.player.source || state.player.lastSource) === 'apple') return null;
    return app.tracks().find(track => track.id === state.player.currentTrackId) || null;
  }
  function currentTrackId() {
    if ((state.player.source || state.player.lastSource) === 'apple') {
      const track = state.player.currentTrack;
      if (state.capabilities.externalLyrics !== true || state.player.source !== 'apple' || typeof track?.id !== 'string' || !track.id.trim() || typeof track.title !== 'string' || !track.title.trim() || typeof track.artist !== 'string' || !track.artist.trim()) return null;
      return `apple:${track.type === 'library-songs' ? 'library-songs' : 'songs'}:${track.id}`;
    }
    return state.player.currentTrackId || currentTrack()?.id || null;
  }
  function sameTrack(id) { return !!id && currentTrackId() === id; }
  function motionReduced() { return !!state.settings.appearance?.reducedMotion || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; }
  function now() { return window.performance?.now ? window.performance.now() : Date.now(); }
  function position() {
    const elapsed = state.player.available && state.player.state === 'playing' ? Math.min(2, Math.max(0, (now() - anchorTime) / 1000)) : 0;
    const value = Math.max(0, anchorPosition + elapsed), duration = Number(state.player.duration);
    return Number.isFinite(duration) && duration > 0 ? Math.min(value, duration) : value;
  }
  function setDialog(title, body) { lyricDialogTrack = null; dialogRevision++; openDialog(title, body); return dialogRevision; }
  function paragraph(text, className = 'dialog-note') { return node('p', className, text); }
  function section(title) { const wrap = node('section', 'dialog-section'); wrap.append(node('h3', '', title)); return wrap; }
  function action(text, callback, iconName, disabled = false) {
    const result = button(text, 'menu-action', callback, iconName);
    result.disabled = disabled;
    return result;
  }
  function writeAction(text, callback, iconName, disabled = false) { return app.markLibraryWrite(action(text, callback, iconName, disabled), disabled); }
  function writeButton(...args) { return app.markLibraryWrite(button(...args)); }
  function updateLibrary(result) { if (result) app.applyLibrary(result); }
  function resetDialog() { lyricDialogTrack = null; dialogRevision++; searchRevision++; closeDialog(); }
  $('dialog').addEventListener('close', () => { if (!$('dialog').open) { lyricDialogTrack = null; dialogRevision++; searchRevision++; } });

  function trackActions(parent, track, originalIndex, entries, detail) {
    const menu = button('', 'row-action', () => openTrackMenu(track, originalIndex, detail), 'more');
    menu.setAttribute('aria-label', `曲目操作：${clean(track.title, '未知标题')}`);
    menu.title = '曲目操作';
    parent.append(menu);
  }
  function playlistActions(parent, list) {
    const menu = button('', 'row-action', () => openPlaylistMenu(list.id), 'more');
    menu.setAttribute('aria-label', `列表操作：${clean(list.name, '未命名播放列表')}`);
    menu.title = '列表操作'; parent.append(menu);
  }
  function openTrackMenu(track, originalIndex, detail) {
    const body = node('div'), menu = node('div', 'menu-list');
    const originalOrder = detail?.type === 'playlist' ? [...(app.playlists().find(item => item.id === detail.id)?.trackIds || [])] : null;
    let owner;
    function orderStillCurrent() {
      const current = app.playlists().find(item => item.id === detail?.id)?.trackIds || [];
      if (originalOrder && current.length === originalOrder.length && current.every((id, index) => id === originalOrder[index])) return true;
      if (owner === dialogRevision) resetDialog();
      notify('播放列表已改变，请重新选择曲目。');
      return false;
    }
    body.append(paragraph(`${clean(track.title, '未知标题')} · ${clean(track.artist, '未知艺术家')}`), menu);
    menu.append(action('加入本地临时队列', async () => {
      const result = await invoke('queue:add', {trackIds: [track.id]});
      if (result) { if (owner === dialogRevision) resetDialog(); notify('已加入临时队列。'); }
    }, 'queue', !app.localAvailable() || track.valid === false || track.supported === false));
    menu.append(writeAction('添加到播放列表', () => choosePlaylist(track), 'playlist', track.valid === false));
    if (detail?.type === 'playlist') {
      const list = app.playlists().find(item => item.id === detail.id), length = list?.trackIds?.length || 0;
      menu.append(writeAction('在原列表中上移', async () => {
        if (!orderStillCurrent()) return;
        const result = await invoke('playlist:moveItem', {id: detail.id, fromIndex: originalIndex, toIndex: originalIndex - 1});
        if (result) { updateLibrary(result); if (owner === dialogRevision) resetDialog(); if (state.sort !== 'order') notify('已调整原列表顺序；选择“原始顺序”查看。'); }
      }, 'up', originalIndex <= 0));
      menu.append(writeAction('在原列表中下移', async () => {
        if (!orderStillCurrent()) return;
        const result = await invoke('playlist:moveItem', {id: detail.id, fromIndex: originalIndex, toIndex: originalIndex + 1});
        if (result) { updateLibrary(result); if (owner === dialogRevision) resetDialog(); if (state.sort !== 'order') notify('已调整原列表顺序；选择“原始顺序”查看。'); }
      }, 'down', originalIndex >= length - 1));
      menu.append(writeAction('从此列表移除这一项', async () => {
        if (!orderStillCurrent()) return;
        const result = await invoke('playlist:removeItem', {id: detail.id, index: originalIndex});
        if (result) { updateLibrary(result); if (owner === dialogRevision) resetDialog(); }
      }, 'trash'));
    }
    menu.append(action('在文件夹中显示', async () => {
      const result = await invoke('library:reveal', {id: track.id});
      if (result !== null && owner === dialogRevision) resetDialog();
    }, 'folder', track.valid === false));
    menu.append(writeAction('从曲目库移除', () => confirmRemoveTrack(track), 'trash'));
    owner = setDialog('曲目操作', body);
  }
  function choosePlaylist(track) {
    const body = node('div');
    let owner;
    body.append(paragraph(`将“${clean(track.title, '未知标题')}”添加到：`));
    const lists = app.playlists(), menu = node('div', 'menu-list'), roving = []; body.append(menu);
    if (!lists.length) body.append(paragraph('还没有播放列表。请先新建一个列表。'));
    for (const list of lists) { const entry = writeAction(clean(list.name, '未命名播放列表'), async () => {
      const result = await invoke('playlist:addTracks', {id: list.id, trackIds: [track.id]});
      if (result) { updateLibrary(result); if (owner === dialogRevision) resetDialog(); notify('已添加到播放列表。'); }
    }, 'playlist'); menu.append(entry); roving.push({key: list.id, controls: [entry]}); }
    owner = setDialog('添加到播放列表', body);
    app.configureRoving(menu, roving, null, 'dialog', '选择播放列表');
  }
  function confirmRemoveTrack(track) {
    const body = node('div');
    let owner;
    body.append(paragraph(`从 STILL 曲目库移除“${clean(track.title, '未知标题')}”？这不会删除音频文件。`));
    const actions = node('div', 'dialog-actions');
    actions.append(button('取消', 'button', resetDialog), writeButton('移除', 'button danger', async () => {
      const result = await invoke('library:remove', {ids: [track.id]});
      if (result) { updateLibrary(result); if (owner === dialogRevision) resetDialog(); }
    }));
    body.append(actions); owner = setDialog('移除曲目', body);
  }
  function playlistNameDialog(list) {
    const body = node('div'), row = node('div', 'dialog-row'), label = node('label', '', '列表名称'), input = node('input');
    let owner;
    input.type = 'text'; input.maxLength = 200; input.value = list?.name || ''; input.placeholder = '给列表起个名字';
    label.htmlFor = 'playlistNameInput'; input.id = 'playlistNameInput'; row.append(label, input);
    const actions = node('div', 'dialog-actions');
    const save = async () => {
      const name = input.value.trim();
      if (!name) { notify('请输入列表名称。'); input.focus(); return; }
      const result = list ? await invoke('playlist:rename', {id: list.id, name}) : await invoke('playlist:create', {name});
      if (result) { updateLibrary(result); if (owner === dialogRevision) resetDialog(); }
    };
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); save(); } });
    actions.append(button('取消', 'button', resetDialog), writeButton(list ? '保存' : '新建', 'button primary', save));
    body.append(row, actions); owner = setDialog(list ? '重命名列表' : '新建播放列表', body); input.focus();
  }
  function openPlaylistMenu(id) {
    const list = app.playlists().find(item => item.id === id);
    if (!list) return;
    const body = node('div'), menu = node('div', 'menu-list');
    body.append(paragraph(clean(list.name, '未命名播放列表')), menu);
    menu.append(writeAction('重命名', () => playlistNameDialog(list), 'edit'));
    menu.append(writeAction('删除列表', () => {
      const confirmation = node('div');
      let owner;
      confirmation.append(paragraph(`删除 STILL 中的“${clean(list.name, '未命名播放列表')}”？${list.source === 'foobar2000' ? '原始列表不会被删除。' : '曲目文件不会被删除。'}`));
      const actions = node('div', 'dialog-actions');
      actions.append(button('取消', 'button', resetDialog), writeButton('删除列表', 'button danger', async () => {
        const result = await invoke('playlist:delete', {id: list.id});
        if (result) { updateLibrary(result); if (owner === dialogRevision) resetDialog(); }
      }));
      confirmation.append(actions); owner = setDialog('删除列表', confirmation);
    }, 'trash'));
    setDialog('列表操作', body);
  }
  $('createPlaylist').addEventListener('click', () => playlistNameDialog(null));

  async function showQueue() {
    const body = node('div'); body.append(paragraph('正在读取队列…'));
    const token = setDialog('本地临时队列', body);
    const result = await invoke('queue:list', {}, {quiet: true});
    if (token !== dialogRevision) return;
    renderQueue(body, result, token);
  }
  function renderQueue(body, queue, token, isCurrent = () => token === dialogRevision) {
    if (!isCurrent()) return;
    body.replaceChildren();
    if (!queue) {
      body.append(paragraph('无法读取队列。请检查播放器连接后重试。'));
      return;
    }
    const items = Array.isArray(queue.items) ? queue.items : [];
    body.append(paragraph('本地临时队列独立于保存的播放列表。'));
    if (!items.length) body.append(paragraph('队列是空的。可从曲目操作中添加。'));
    items.forEach((item, index) => {
      const row = node('div', 'queue-item'), number = node('span', 'count', String(index + 1)), copy = node('span', 'list-copy');
      copy.append(node('strong', '', clean(item.title, '未知标题')), node('small', '', clean(item.artist, '未知艺术家')));
      const remove = button('', 'row-action', async () => {
        const latest = await invoke('queue:list');
        if (!isCurrent() || !latest) return;
        const signature = value => JSON.stringify((value.items || []).map(entry => [entry.index ?? null, entry.playlistId ?? null, entry.itemIndex ?? null, entry.trackId ?? null, entry.path ?? null, entry.subsong ?? null, entry.title ?? null, entry.artist ?? null]));
        if (signature(latest) !== signature(queue)) {
          renderQueue(body, latest, token, isCurrent); notify('队列已改变，请重新选择要移除的曲目。'); return;
        }
        const result = await invoke('queue:remove', {index: item.index ?? index});
        if (result) renderQueue(body, result, token, isCurrent);
      }, 'close');
      remove.title = '从队列移除'; remove.setAttribute('aria-label', `从队列移除 ${clean(item.title, '未知标题')}`);
      row.append(number, copy, remove); body.append(row);
    });
    if (items.length) {
      const actions = node('div', 'dialog-actions');
      actions.append(button('清空队列', 'button', async () => {
        const result = await invoke('queue:clear');
        if (result) renderQueue(body, result, token, isCurrent);
      }));
      body.append(actions);
    }
  }
  $('queueButton').addEventListener('click', showQueue);

  let contextRevision = 0, currentPlaybackContext = null, contextKey = '', contextReadAt = 0, contextLoading = false, renderedContextSignature = '';
  function playbackContextKey() { const p = state.player; return ['local', 'apple'].includes(p.source) ? `${p.source}:${p.currentTrackId || p.currentTrack?.id || ''}:${p.generation ?? ''}` : ''; }
  function renderPlaybackContext(body, result) {
    const items = Array.isArray(result?.items) ? result.items.filter(item => item && typeof item === 'object') : [];
    const resultStatus = $('contextResultStatus'), count = result?.status === 'ready' ? `当前播放列表，${items.length} 首` : '当前播放列表暂不可用';
    if (resultStatus.textContent !== count) resultStatus.textContent = count;
    const signature = JSON.stringify([result?.source, result?.status, result?.contextId, result?.currentIndex, result?.playlist?.name, state.player.state, items.map(item => [item.key, item.index, item.title, item.artist, item.coverUrl])]);
    if (signature === renderedContextSignature && body.children.length) return;
    renderedContextSignature = signature; const scroll = body.scrollTop;
    app.clearContent(body);
    if (!result || result.status !== 'ready') {
      body.append(node('p', 'context-empty', result?.status === 'unknown' ? '暂无播放列表' : '暂时无法读取'));
      body.append(button('重试', 'text-button context-retry', () => loadPlaybackContext(true), 'refresh')); return;
    }
    if (!items.length) { body.append(node('p', 'context-empty', '列表为空')); return; }
    for (const item of items) {
      const current = Number.isInteger(result.currentIndex) && item.index === result.currentIndex;
      const row = node('div', `context-row${current ? ' current' : ''}`), number = node('span', 'context-index', Number.isInteger(item.index) ? String(item.index + 1) : '');
      row.dataset.key = String(item.key || '');
      if (current) { row.setAttribute('aria-current', 'true'); number.replaceChildren(icon(state.player.state === 'playing' ? 'play' : 'pause')); }
      const art = node('span', 'track-cover context-cover'), title = node('span', 'context-title', clean(item.title, '未知标题'));
      app.cover(art, item.coverUrl); title.title = [clean(item.title, '未知标题'), item.artist].filter(Boolean).join(' · ');
      row.append(number, art, title); body.append(row);
    }
    body.scrollTop = scroll;
  }
  async function loadPlaybackContext(clearFirst = true) {
    const source = state.player.source, body = $('cabinQueueBody');
    const key = playbackContextKey(), token = ++contextRevision;
    contextKey = key; contextReadAt = now(); contextLoading = true;
    if (clearFirst) { currentPlaybackContext = null; glass?.contextChanged(null); }
    if (!key) { contextLoading = false; if (!body.hidden) renderPlaybackContext(body, {status: 'unknown'}); return; }
    if (clearFirst && !body.hidden) { renderedContextSignature = ''; app.clearContent(body, node('p', 'context-empty', '读取中…')); }
    const isCurrent = () => token === contextRevision && state.immersive && key === playbackContextKey();
    const result = await invoke('player:context', {source}, {quiet: true, isCurrent});
    if (!isCurrent()) return;
    contextLoading = false;
    const generationMatches = !Number.isInteger(result?.generation) || !Number.isInteger(state.player.generation) || result.generation === state.player.generation;
    const valid = result?.source === source && generationMatches ? result : null;
    const previousContext = currentPlaybackContext;
    if (previousContext && valid?.status === 'ready' && previousContext.source === valid.source && Number.isInteger(previousContext.currentIndex) && Number.isInteger(valid.currentIndex) && (previousContext.currentIndex !== valid.currentIndex || (previousContext.playlist?.id != null && valid.playlist?.id != null && previousContext.playlist.id !== valid.playlist.id))) {
      app.cancelSeekPreview(); follow = true; if (state.immersive) renderLyrics();
    }
    currentPlaybackContext = valid?.status === 'ready' ? valid : null;
    glass?.contextChanged(currentPlaybackContext);
    if (!body.hidden) renderPlaybackContext(body, valid);
  }
  function selectCabin(playlist) {
    $('cabinLyrics').classList.toggle('active', !playlist); $('cabinLyrics').setAttribute('aria-pressed', String(!playlist));
    $('cabinQueue').classList.toggle('active', playlist); $('cabinQueue').setAttribute('aria-pressed', String(playlist));
    $('lyricsColumn').hidden = playlist; $('cabinQueueBody').hidden = !playlist;
    syncLyricFrame();
    if (!playlist) { paintLyrics(); return; }
    if (currentPlaybackContext) renderPlaybackContext($('cabinQueueBody'), currentPlaybackContext);
    else { renderedContextSignature = ''; app.clearContent($('cabinQueueBody'), node('p', 'context-empty', '读取中…')); }
    if (!contextLoading) void loadPlaybackContext(!currentPlaybackContext);
  }
  $('cabinLyrics').addEventListener('click', () => selectCabin(false));
  $('cabinQueue').addEventListener('click', () => selectCabin(true));

  async function settingPatch(sectionName, key, value) {
    const result = await invoke('settings:update', {patch: {[sectionName]: {[key]: value}}});
    if (result) app.applySettings(result);
    return result;
  }
  function switchRow(labelText, sectionName, key, fallback = false) {
    const label = node('label', 'switch-row'), input = node('input'), text = node('span', '', labelText);
    input.type = 'checkbox'; input.checked = state.settings[sectionName]?.[key] ?? fallback;
    input.addEventListener('change', async () => {
      if (sectionName === 'lyrics' && !input.checked && ((key === 'showOriginal' && !state.settings.lyrics?.showTranslation) || (key === 'showTranslation' && !state.settings.lyrics?.showOriginal))) {
        input.checked = true; notify('请至少保留原文或译文中的一种。'); return;
      }
      const result = await settingPatch(sectionName, key, input.checked);
      if (!result) input.checked = !!state.settings[sectionName]?.[key];
    });
    label.append(input, text); return label;
  }
  function rangeRow(labelText, key, min, max, step, fallback, suffix = '') {
    const row = node('div', 'dialog-row'), label = node('label', '', labelText), input = node('input'), output = node('output');
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(state.settings.lyrics?.[key] ?? fallback);
    label.htmlFor = `setting-${key}`; input.id = label.htmlFor; output.textContent = `${input.value}${suffix}`;
    input.addEventListener('input', () => { output.textContent = `${input.value}${suffix}`; });
    input.addEventListener('change', async () => {
      const result = await settingPatch('lyrics', key, Number(input.value));
      if (!result) { input.value = String(state.settings.lyrics?.[key] ?? fallback); output.textContent = `${input.value}${suffix}`; }
    });
    row.append(label, input, output); return row;
  }
  function showLyricSettings() {
    const body = node('div'), display = section('歌词显示');
    let owner, paintTiming = null;
    display.append(rangeRow('原文字号', 'fontSize', 14, 72, 1, 30, ' px'), rangeRow('译文字号', 'translationSize', 10, 48, 1, 18, ' px'), rangeRow('行距', 'lineHeight', 1, 3, 0.05, 1.75),
      switchRow('显示原文', 'lyrics', 'showOriginal', true), switchRow('显示译文', 'lyrics', 'showTranslation', true));
    const timing = section('当前曲目时间');
    const id = currentTrackId();
    if (id) {
      const row = node('div', 'dialog-row'), label = node('label', '', '偏移（毫秒）'), input = node('input');
      input.type = 'number'; input.min = '-600000'; input.max = '600000'; input.step = '50'; input.value = ''; input.disabled = true; input.placeholder = '读取中';
      label.htmlFor = 'lyricOffset'; input.id = 'lyricOffset'; row.append(label, input);
      const apply = button('应用', 'button', async () => {
        if (!sameTrack(id)) return;
        const offsetMs = Number(input.value);
        if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > 600000) { notify('偏移须在 -600000 至 600000 毫秒之间。'); return; }
        const result = await lyricCommand('lyrics:offset', {trackId: id, offsetMs});
        if (result) { input.value = String(result.offsetMs || 0); notify('歌词时间已更新。'); }
      }); apply.disabled = true; row.append(apply);
      timing.append(row, paragraph('正值让歌词稍晚出现；点击歌词定位时也会计入偏移。'));
      let bindingAdded = false;
      paintTiming = doc => {
        const ready = !!doc && ['ready', 'plain', 'instrumental'].includes(doc.status);
        input.disabled = apply.disabled = !ready; input.value = ready ? String(Number(doc.offsetMs) || 0) : ''; input.placeholder = ready ? '' : '暂无歌词';
        if (doc?.bound && !bindingAdded) {
          bindingAdded = true; timing.append(button('解除此曲目绑定', 'button', async () => {
            const result = await lyricCommand('lyrics:unbind', {trackId: id});
            if (result) { if (owner === dialogRevision) resetDialog(); notify('已解除歌词绑定。'); }
          }));
        }
      };
    } else timing.append(paragraph('播放库中的曲目后，可以调整该曲目的歌词偏移。'));
    const source = section('歌词来源与缓存');
    const sourceInfo = paragraph(sourceText(lyricDocument)); sourceInfo.hidden = !sourceInfo.textContent; source.append(sourceInfo);
    source.append(switchRow('允许在线搜索 LRCLIB', 'lyrics', 'onlineEnabled', true), switchRow('保存歌词缓存，供离线使用', 'lyrics', 'cacheEnabled', true), paragraph('手动绑定与本地歌词优先。纯文本歌词没有时间戳，不会逐句高亮。'));
    body.append(display, timing, source); owner = setDialog('歌词设置', body); lyricDialogTrack = id;
    if (id && paintTiming) {
      if (lyricDocument && lyricDocument.status !== 'searching' && (!lyricDocument.trackId || lyricDocument.trackId === id)) paintTiming(lyricDocument);
      else void loadLyrics(id).then(doc => {
        if (owner !== dialogRevision || !sameTrack(id)) return;
        paintTiming(doc); sourceInfo.textContent = sourceText(doc); sourceInfo.hidden = !sourceInfo.textContent;
      });
    }
  }
  $('lyricsTools').addEventListener('click', showLyricSettings);

  function showAppleConfiguration() {
    const capabilities = state.sources.apple?.capabilities || {};
    const canKey = capabilities.configureKey === true;
    const canToken = capabilities.importToken === true;
    if (!canKey && !canToken) return;
    const body = node('div'), keys = section('使用现有 MusicKit 密钥');
    let owner;
    keys.append(paragraph('如果你已有 Apple Developer 的 MusicKit 凭据，可填写 Team ID 和 Key ID，再由系统文件选择器读取 .p8 密钥。没有凭据时可以稍后再配置；开发者计划可能收费，请在 Apple 官网确认。'));
    function idInput(labelText, id) {
      const row = node('div', 'dialog-row'), label = node('label', '', labelText), input = node('input');
      input.type = 'text'; input.id = id; input.maxLength = 128; input.autocomplete = 'off'; label.htmlFor = id;
      row.append(label, input); keys.append(row); return input;
    }
    const team = idInput('Team ID', 'appleTeamId'), key = idInput('Key ID', 'appleKeyId');
    const apply = async result => {
      if (!result || result.canceled) return;
      if (result.status && typeof result.status === 'object') app.applyAppleStatus(result.status);
      if (owner === dialogRevision) resetDialog();
      notify('Apple Music 配置状态已更新。');
    };
    const chooseKey = button('选择 .p8 并配置', 'button primary', async () => {
      const teamId = team.value.trim(), keyId = key.value.trim();
      if (!teamId || !keyId) { notify('请填写 Team ID 和 Key ID。'); return; }
      await apply(await invoke('apple:configure-key', {teamId, keyId}));
    });
    chooseKey.disabled = !canKey;
    keys.append(chooseKey);
    const token = section('导入已有 developer token');
    token.append(paragraph('如果已有合法的 developer token，可由系统文件选择器导入。凭据内容不会显示在此界面。'));
    const importToken = button('选择 token 文件', 'button', async () => { await apply(await invoke('apple:import-token')); });
    importToken.disabled = !canToken;
    token.append(importToken);
    const actions = node('div', 'dialog-actions'); actions.append(button('稍后再说', 'button', resetDialog));
    body.append(keys, token, actions); owner = setDialog('配置 Apple Music', body);
  }
  $('appleConfigure').addEventListener('click', showAppleConfiguration);

  function detailRow(list, label, value) {
    list.append(node('dt', '', label), node('dd', '', value || '未知'));
  }
  function validContact(value) {
    if (!value) return true;
    if (value.length > 200 || /[\u0000-\u0020\u007f-\u009f()<>"\\]/u.test(value) || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return false;
    if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(value)) return true;
    try { const url = new URL(value); return /^https:\/\//i.test(value) && url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !/[^\x21-\x7e]/u.test(value) && !/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value); } catch { return false; }
  }
  async function drainContacts() {
    if (contactRunning) return; contactRunning = true;
    while (pendingContact) {
      const intent = pendingContact; pendingContact = null;
      const result = await invoke('settings:update', {patch: {onlineCovers: {musicBrainzContact: intent.value}}}, {quiet: true});
      const confirmed = result?.onlineCovers?.musicBrainzContact;
      const accepted = typeof confirmed === 'string' && validContact(confirmed) && app.actions.acceptMusicBrainzContact(confirmed);
      if (intent.sequence === contactSequence && intent.current()) {
        intent.input.value = state.settings.onlineCovers?.musicBrainzContact || '';
        intent.status.textContent = accepted ? '已保存' : '未保存，已保留原设置';
      }
    }
    contactRunning = false;
  }
  function contactSettings(current) {
    const body = section('在线封面联系信息'), row = node('div', 'dialog-row'), label = node('label', '', 'MusicBrainz'), input = node('input'), status = paragraph('');
    input.type = 'text'; input.maxLength = 200; input.value = state.settings.onlineCovers?.musicBrainzContact || ''; input.placeholder = '邮箱或 HTTPS 联系页'; input.setAttribute('aria-label', 'MusicBrainz 联系信息'); input.disabled = state.capabilities.persistUIState !== true;
    const save = button('保存', 'button', () => {
      if (!current() || state.capabilities.persistUIState !== true) return;
      const value = input.value.trim();
      if (!validContact(value)) { status.textContent = '请输入有效邮箱或 HTTPS 联系页'; return; }
      pendingContact = {value, input, status, current, sequence: ++contactSequence}; status.textContent = '保存中…'; void drainContacts();
    }); save.disabled = input.disabled;
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); save.click(); } });
    row.append(label, input, save); body.append(row, status); return body;
  }
  function safeExitSettings(current) {
    const body = section('遗留后台'), status = paragraph('先检查可核验的后台'), details = node('details', 'diagnostics'), detail = node('dl', 'detail-grid');
    details.append(node('summary', '', '目标详情'), detail); details.hidden = true;
    let selected = null, checkRevision = 0;
    const unavailable = value => ({STILL_BACKEND_ALREADY_EXITED: '后台已退出', STILL_BACKEND_STARTUP_UNCERTAIN: '启动状态尚未确认', STILL_BACKEND_OWNERSHIP_UNVERIFIED: '无法核验后台归属'}[value?.code] || '当前无法安全退出');
    const exit = button('安全退出遗留后台', 'button danger', async () => {
      if (!current() || !selected) return;
      const selectionToken = selected; selected = null; const revision = ++checkRevision;
      const result = await invoke('app:safeOwnedExit', {selectionToken}, {quiet: true});
      if (!current() || revision !== checkRevision) return;
      status.textContent = result?.exited === true && result?.refused === false ? '后台已确认退出' : unavailable(result);
      exit.dataset.unavailable = 'true'; exit.disabled = true; details.hidden = true;
    }); exit.disabled = true; exit.dataset.unavailable = 'true';
    const check = button('检查后台', 'button', async () => {
      if (!current()) return;
      const revision = ++checkRevision; selected = null; exit.disabled = true; exit.dataset.unavailable = 'true'; status.textContent = '检查中…'; details.hidden = true;
      const result = await invoke('app:safeOwnedExitStatus', {}, {quiet: true});
      if (!current() || revision !== checkRevision) return;
      const target = result?.target;
      const ready = result?.available === true && result.refused === false && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.selectionToken || '') &&
        Number.isSafeInteger(target?.pid) && target.pid > 0 && ['startTime', 'executable', 'profilePath'].every(field => typeof target[field] === 'string' && !!target[field].trim());
      selected = ready ? result.selectionToken : null; exit.disabled = !ready; exit.dataset.unavailable = String(!ready);
      status.textContent = ready ? '可退出已核验后台；退出会结束其播放' : unavailable(result); status.title = result?.reason || '';
      detail.replaceChildren(); details.hidden = !ready;
      if (ready) { detailRow(detail, '进程', String(result.target.pid)); detailRow(detail, '程序', result.target.executable); detailRow(detail, '配置目录', result.target.profilePath); }
    });
    const actions = node('div', 'dialog-actions'); actions.append(check, exit); body.append(status, actions, details); return body;
  }
  async function showAudioSettings() {
    const body = node('div'); body.append(paragraph('正在读取播放器与输出信息…'));
    const token = setDialog('音频与设置', body);
    const [outputs, details, restore] = await Promise.all([invoke('audio:outputs', {}, {quiet: true}), invoke('audio:details', {}, {quiet: true}), invoke('app:restoreInfo', {}, {quiet: true})]);
    if (token !== dialogRevision) return;
    body.replaceChildren();
    const playback = section('播放与歌词'); playback.append($('settingsPlaybackControls'));
    const outputSection = section('本地输出设备');
    outputSection.append(paragraph('Apple Music 的输出路径及独占能力尚未实测；以下为本地内核的输出配置。'));
    if (outputs?.outputs?.length) {
      const row = node('div', 'dialog-row'), label = node('label', '', '当前输出'), select = node('select');
      let confirmedId = outputs.selected?.id || '';
      label.htmlFor = 'outputSelect'; select.id = label.htmlFor;
      for (const output of outputs.outputs) {
        const option = node('option', '', [output.typeName, output.name].filter(Boolean).join(' · ') || output.id);
        option.value = output.id; select.append(option);
      }
      if (outputs.selected?.id) select.value = outputs.selected.id;
      else { const option = node('option', '', '当前输出未确认'); option.value = ''; option.selected = true; select.append(option); }
      select.addEventListener('change', async () => {
        if (!select.value) return;
        select.disabled = true;
        const selected = await invoke('audio:select', {id: select.value});
        if (selected?.selected?.id) { confirmedId = selected.selected.id; select.value = confirmedId; notify('输出设备已读回确认。'); }
        else select.value = confirmedId;
        select.disabled = false;
      });
      row.append(label, select); outputSection.append(row, paragraph('显示的是播放器报告的输出配置；硬件实际接收格式和独占占用状态不由此接口测量。'));
    } else outputSection.append(paragraph('当前无法读回本地输出设备。请查看本地内核状态与诊断信息。'));
    const evidence = section('当前音频信息'), dl = node('dl', 'detail-grid');
    const outputConnection = details?.outputConnection || state.sources.local?.outputConnection;
    const backendReachable = details?.backendReachable ?? state.sources.local?.backendReachable ?? state.sources.local?.available;
    detailRow(dl, '本地内核连接', backendReachable === true ? '已连接' : '未连接');
    detailRow(dl, '原音频设备连接', outputConnection?.status === 'connected' ?
      (outputConnection.retryRequired ? '已重连，等待明确重试' : '已连接') : outputConnection?.status === 'disconnected' ? '已断开或不可用' : '未知');
    detailRow(dl, '播放器状态', state.player.available ? ({playing: '播放中', paused: '已暂停', stopped: '已停止'}[state.player.state] || state.player.state) : '未连接');
    detailRow(dl, '本地已选输出', details?.selection?.name || outputConnection?.output?.name || outputs?.selected?.name || '未确认');
    const source = state.player.source === 'apple' ? currentTrack() : (details?.source || currentTrack());
    detailRow(dl, '音源格式', source ? [source.codec, source.sampleRate ? `${source.sampleRate} Hz` : '', source.bitsPerSample ? `${source.bitsPerSample} bit` : '', source.channels ? `${source.channels} 声道` : ''].filter(Boolean).join(' · ') || '未知' : '未知');
    detailRow(dl, '实际输出格式', '未测量');
    evidence.append(dl);
    if (outputConnection?.message) evidence.append(paragraph(outputConnection.message));
    if (outputConnection?.retryRequired) evidence.append(paragraph('设备重连后不会自动切换输出或恢复播放；请明确重试连接或选择播放。'));
    if (Array.isArray(details?.unknowns)) evidence.append(paragraph(details.unknowns.join('；')));
    const preferences = section('偏好与数据');
    preferences.append(button('光线与外观', 'button', () => glass?.openAppearance()));
    preferences.append(switchRow('减少界面动效', 'appearance', 'reducedMotion'), paragraph('本地内核与输出状态以实际读回为准。连接失败时，请查看下方诊断信息。'));
    if (state.sources.local?.message) preferences.append(paragraph(`本地内核：${state.sources.local.message}`));
    const diagnostic = state.sources.local?.backendDiagnostic || restore?.backendError || details?.error || state.player.error;
    if (diagnostic) {
      const details = node('details', 'diagnostics'), raw = typeof diagnostic === 'string' ? diagnostic : JSON.stringify(diagnostic, null, 2);
      details.append(node('summary', '', '查看详细诊断'), node('pre', '', raw)); preferences.append(details);
    }
    if (restore?.dataDir) preferences.append(paragraph(`STILL 数据目录：${restore.dataDir}`));
    if (state.capabilities.exportDiagnostics === true) preferences.append(button('保存诊断状态', 'button', async () => {
      const layout = glass?.diagnosticsLayout();
      const result = await invoke('app:exportDiagnostics', {...(layout ? {layout} : {}), ...(state.browseSource === 'apple' ? {scope: 'apple'} : {})});
      if (result?.saved === true) notify('诊断状态已保存到 STILL 数据目录。');
    }));
    preferences.append(button('打开 STILL 数据目录', 'button', () => invoke('app:openDataFolder')));
    const current = () => token === dialogRevision && $('dialog').open && $('dialogBody').contains(body);
    body.append(playback, outputSection, evidence, preferences, contactSettings(current), safeExitSettings(current)); updateLyricActionAvailability();
  }
  function stashSettingsControls() { $('settingsControlsHome').append($('settingsPlaybackControls')); }
  $('dialog').addEventListener('close', stashSettingsControls);
  $('audioButton').addEventListener('click', showAudioSettings);

  function settingsChanged(settings) {
    if (settings?.appearance?.reducedMotion) { coverMotion?.cancel(); coverMotion = null; }
    const lyric = settings?.lyrics || {};
    $('lyricsBody').style.setProperty('--lyric-font-size', `${lyric.fontSize ?? 30}px`);
    $('lyricsBody').style.setProperty('--translation-size', `${lyric.translationSize ?? 18}px`);
    $('lyricsBody').style.setProperty('--lyric-line-height', String(lyric.lineHeight ?? 1.75));
    if (state.immersive) renderLyrics();
  }
  function libraryChanged(change = {}) {
    if (change.full || change.structural || change.playlistsChanged) glass?.renderRail();
    if (state.immersive) updateImmersiveTrack();
  }
  function playerChanged(player, previous = {}) {
    updateLyricActionAvailability();
    anchorPosition = Math.max(0, Number(player.position) || 0); anchorTime = now();
    const id = currentTrackId();
    let changed = false;
    if (id !== lyricTrackId) {
      lyricRevision++; searchRevision++;
      if (lyricDialogTrack && lyricDialogTrack !== id) { resetDialog(); notify('曲目已切换，已关闭上一首的歌词操作。'); }
      lyricTrackId = id; lyricDocument = null; activeLine = -1; follow = true;
      changed = true;
      if (state.immersive && id) loadLyrics(id);
    } else if (id && (previous.source !== player.source || previous.generation !== player.generation)) { follow = true; changed = true; }
    if (state.immersive) {
      updateImmersiveTrack();
      if (changed || previous.available !== player.available) renderLyrics();
      paintLyrics();
      if (!$('cabinQueueBody').hidden && currentPlaybackContext && playbackContextKey() === contextKey) renderPlaybackContext($('cabinQueueBody'), currentPlaybackContext);
      if (playbackContextKey() !== contextKey || previous.available !== player.available) void loadPlaybackContext(true);
      else if (!contextLoading && now() - contextReadAt >= 2000) void loadPlaybackContext(false);
    }
    syncLyricFrame();
  }
  function updateImmersiveTrack() {
    const track = currentTrack();
    $('immersiveTitle').textContent = track ? clean(track.title, '未知标题') : '没有正在播放的音乐';
    $('immersiveTitle').title = $('immersiveTitle').textContent;
    $('immersiveArtist').textContent = track ? clean(track.artist, '未知艺术家') : '选择一首曲目开始聆听';
    $('immersiveArtist').title = $('immersiveArtist').textContent;
    $('lyricsFixture').hidden = state.player.simulatedUIFixture !== true;
    $('lyricsFixture').textContent = state.player.simulatedUIFixture === true ? clean(state.player.fixtureLabel, '测试歌词 / 非真实匹配') : '';
    const art = track?.coverUrl || '', identity = `${state.player.source || state.player.lastSource || ''}:${state.player.currentTrackId || track?.id || ''}`;
    if (art !== lastArt || identity !== lastArtTrack) {
      const turn = lastArtTrack !== null && identity !== lastArtTrack;
      coverMotion?.cancel(); coverMotion = null; lastArt = art; lastArtTrack = identity;
      app.cover($('largeCover'), art, 'album');
      if (turn && !motionReduced() && typeof $('largeCover').animate === 'function') {
        const motion = $('largeCover').animate([
          {transform: 'perspective(900px) translateX(16px) rotateY(-18deg) scale(.96)', opacity: .45},
          {transform: 'perspective(900px) translateX(0) rotateY(0) scale(1)', opacity: 1}
        ], {duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)'});
        coverMotion = motion;
        motion.finished.then(() => { if (coverMotion === motion) coverMotion = null; }, () => { if (coverMotion === motion) coverMotion = null; });
      }
    }
    glass?.renderListening(track);
    updateLyricActionAvailability();
  }
  function updateLyricActionAvailability() { const enabled = !!currentTrackId(); $('findLyrics').disabled = !enabled; $('importLyrics').disabled = !enabled; }
  function carryCover(target, from) {
    coverMotion?.cancel(); coverMotion = null;
    if (!currentTrack()?.coverUrl || state.settings.appearance?.reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches || typeof target.animate !== 'function') return;
    const to = target.getBoundingClientRect();
    if (!(from.width > 0 && from.height > 0 && to.width > 0 && to.height > 0)) return;
    const x = from.left + from.width / 2 - to.left - to.width / 2;
    const y = from.top + from.height / 2 - to.top - to.height / 2;
    const motion = target.animate([
      {transform: `translate(${x}px, ${y}px) scale(${from.width / to.width})`, opacity: 0.7},
      {transform: 'none', opacity: 1}
    ], {duration: 340, easing: 'cubic-bezier(.22,.68,.25,1)'});
    coverMotion = motion;
    motion.finished.then(() => { if (coverMotion === motion) coverMotion = null; }, () => { if (coverMotion === motion) coverMotion = null; });
  }
  function enterImmersive() {
    if (state.immersive) return;
    const from = $('miniCover').getBoundingClientRect();
    savedContentScroll = $('content').scrollTop;
    savedAppleScroll = $('appleContent').scrollTop;
    app.actions.setListening(true); document.body.classList.add('listening'); $('topbar').hidden = true; $('content').hidden = true; $('appleContent').hidden = true; $('immersive').hidden = false;
    glass?.renderRail();
    selectCabin(false);
    updateImmersiveTrack();
    void loadPlaybackContext(true);
    carryCover($('largeCover'), from);
    const id = currentTrackId();
    if (id && (!lyricDocument || lyricDocument.trackId !== id)) loadLyrics(id);
    else renderLyrics();
    $('leaveImmersive').focus();
    syncLyricFrame();
  }
  function leaveImmersive() {
    if (!state.immersive) return;
    const from = $('largeCover').getBoundingClientRect();
    app.actions.setListening(false); document.body.classList.remove('listening'); $('immersive').hidden = true; $('topbar').hidden = false;
    contextRevision++; contextLoading = false; currentPlaybackContext = null; glass?.contextChanged(null);
    $('content').hidden = state.browseSource !== 'local'; $('appleContent').hidden = state.browseSource !== 'apple';
    if (state.browseSource === 'local') {
      if (state.viewDirty) { app.actions.clearViewDirty(); app.render(); }
      $('content').scrollTop = savedContentScroll;
    } else $('appleContent').scrollTop = savedAppleScroll;
    if (frame != null) { window.cancelAnimationFrame(frame); frame = null; }
    carryCover($('miniCover'), from);
    if (!$('nowTitle').disabled) $('nowTitle').focus();
  }
  function tick() {
    frame = null;
    if (!state.immersive || $('lyricsColumn').hidden || state.player.state !== 'playing' || lyricDocument?.status !== 'ready') return;
    paintLyrics();
    frame = window.requestAnimationFrame(tick);
  }
  function syncLyricFrame() {
    const needed = state.immersive && !$('lyricsColumn').hidden && state.player.state === 'playing' && lyricDocument?.status === 'ready';
    if (needed && frame == null) frame = window.requestAnimationFrame(tick);
    else if (!needed && frame != null) { window.cancelAnimationFrame(frame); frame = null; }
  }
  $('leaveImmersive').addEventListener('click', leaveImmersive);
  $('nowTitle').addEventListener('click', enterImmersive);
  $('miniCover').addEventListener('click', enterImmersive);

  async function loadLyrics(id, force = false) {
    const token = ++lyricRevision;
    lyricDocument = {trackId: id, status: 'searching', kind: 'none', lines: []}; renderLyrics();
    const result = await invoke('lyrics:resolve', {trackId: id, ...(force ? {force: true} : {})}, {isCurrent: () => token === lyricRevision && sameTrack(id)});
    if (token !== lyricRevision || !sameTrack(id)) return null;
    lyricDocument = result && (!result.trackId || result.trackId === id) ? result : {trackId: id, status: 'unavailable', kind: 'none', lines: [], error: '无法读取歌词，请重试。'};
    renderLyrics(); syncLyricFrame(); return lyricDocument;
  }
  async function lyricCommand(channel, payload) {
    const id = payload.trackId, token = ++lyricRevision, before = lyricDocument;
    if (!sameTrack(id)) return null;
    const result = await invoke(channel, payload, {isCurrent: () => token === lyricRevision && sameTrack(id)});
    if (token !== lyricRevision || !sameTrack(id)) return null;
    if (result?.canceled || !result) { lyricDocument = before; renderLyrics(); return null; }
    if (result.trackId && result.trackId !== id) return null;
    lyricDocument = result; renderLyrics(); return result;
  }
  function statusText(document) {
    if (!document) return currentTrack() && !currentTrackId() ? '当前播放来源未提供可匹配的歌词。' : '选择曲目后显示歌词。';
    switch (document.status) {
      case 'searching': return '正在查找歌词…';
      case 'ready': return document.kind === 'word' ? '逐词歌词' : '逐行歌词';
      case 'plain': return '纯文本歌词 · 无时间轴';
      case 'instrumental': return '纯音乐';
      case 'network-error': return '歌词暂时无法获取';
      case 'parse-error': return '歌词解析失败';
      case 'not-found':
        if (document.reason === 'online-disabled' || document.reason === 'source-disabled') return '在线歌词已关闭';
        if (document.reason === 'selection-required') return '找到多个版本，请手动选择';
        return '没有找到歌词';
      default: return '歌词不可用';
    }
  }
  function sourceText(document) {
    if (!document) return '';
    const parts = [];
    if (document.source) parts.push(document.source);
    if (document.bound) parts.push('手动绑定');
    else if (document.local) parts.push('本地歌词');
    if (document.fromCache) parts.push('离线缓存');
    if (Number(document.offsetMs)) parts.push(`偏移 ${Number(document.offsetMs) > 0 ? '+' : ''}${document.offsetMs} ms`);
    if (document.refreshStatus === 'network-error') parts.push('更新失败，正在使用缓存');
    else if (document.refreshStatus === 'parse-error') parts.push('更新内容解析失败，正在使用缓存');
    if (document.translationWarning) parts.push(document.translationWarning);
    return parts.join(' · ');
  }
  function renderLyrics() {
    if (!state.immersive) return;
    syncLyricFrame();
    const doc = lyricDocument, body = $('lyricsBody'), prefs = state.settings.lyrics || {};
    $('lyricsStatus').textContent = statusText(doc); $('lyricsSource').textContent = sourceText(doc);
    body.replaceChildren(); renderedLines = []; activeLine = -1;
    const statusOnly = !doc || !['ready', 'plain'].includes(doc.status);
    body.classList.toggle('lyrics-status-body', statusOnly);
    $('lyricsColumn').classList.toggle('has-status', statusOnly);
    if (!doc || !['ready', 'plain', 'instrumental'].includes(doc.status)) {
      const loading = doc?.status === 'searching';
      const message = loading ? '正在查找歌词' : !currentTrack() ? '选择一首音乐' : !currentTrackId() ? '此来源暂不提供歌词' : doc?.reason === 'online-disabled' || doc?.reason === 'source-disabled' ? '在线歌词已关闭' : doc?.status === 'not-found' ? '暂未找到歌词' : doc?.status === 'parse-error' ? '此版本无法显示' : '歌词暂时无法获取';
      const card = node('div', 'lyric-status-card');
      card.append(icon('lyrics'), node('h3', '', message));
      if (currentTrackId()) {
        const id = currentTrackId(), actions = node('div', 'lyric-status-actions');
        if (!loading) actions.append(button('重试', 'button', () => { if (sameTrack(id)) return loadLyrics(id, true); }, 'refresh'));
        actions.append(button('搜索', 'text-button', () => { if (sameTrack(id)) showSearch(); }),
          button('导入', 'text-button', () => { if (sameTrack(id)) $('importLyrics').click(); }));
        card.append(actions);
      }
      if (doc?.error && !loading) {
        const details = node('details', 'lyric-error-details');
        details.append(node('summary', '', '详情'), node('p', '', doc.error)); card.append(details);
      }
      body.append(card);
      $('resumeFollow').hidden = true; return;
    }
    if (doc.status === 'instrumental') {
      const card = node('div', 'lyric-status-card'); card.append(icon('music'), node('h3', '', '纯音乐')); body.append(card);
      $('resumeFollow').hidden = true; return;
    }
    if (doc.status === 'plain' || doc.kind === 'plain') {
      body.append(node('div', 'lyrics-note', '以下文本没有时间戳，原文与译文分别展示。'));
      const original = doc.plainText || (Array.isArray(doc.lines) ? doc.lines.map(line => line.text || '').join('\n') : '');
      if (prefs.showOriginal !== false && original) body.append(node('div', 'plain-lyrics', original));
      if (prefs.showTranslation !== false && doc.plainTranslation) body.append(node('div', 'plain-lyrics translation', doc.plainTranslation));
      if (prefs.showOriginal === false && !doc.plainTranslation) body.append(node('div', 'lyrics-empty', '此版本没有可显示的译文。'));
      $('resumeFollow').hidden = true; return;
    }
    const lines = Array.isArray(doc.lines) ? doc.lines : [];
    if (!lines.length) { body.append(node('div', 'lyrics-empty', '此版本没有可显示的歌词行。')); return; }
    if (prefs.showOriginal === false && !lines.some(line => line.translation) && !doc.plainTranslation) body.append(node('div', 'lyrics-note', '此版本没有按时间匹配的译文。'));
    lines.forEach((line, index) => {
      const row = node('button', 'lyric-line'), words = [];
      row.type = 'button';
      const seek = timeline.seekPosition(line, doc.offsetMs);
      row.disabled = seek == null || !state.player.available;
      if (prefs.showOriginal !== false) {
        const original = node('span', 'original');
        const timed = doc.kind === 'word' && Array.isArray(line.words) ? line.words.filter(word => typeof word.text === 'string') : [];
        const joined = timed.map(word => word.text).join(''), text = String(line.text || '');
        if (timed.length && text.endsWith(joined)) {
          const prefix = text.slice(0, text.length - joined.length);
          if (prefix) original.append(node('span', '', prefix));
          for (const word of timed) {
            const span = node('span', 'lyric-word', word.text);
            span.style.setProperty('--word-progress', '0%'); original.append(span); words.push({span, word});
          }
        } else original.textContent = text;
        row.append(original);
      }
      if (prefs.showTranslation !== false && line.translation) row.append(node('span', 'translation', line.translation));
      if (prefs.showOriginal === false && !line.translation) row.hidden = true;
      if (!row.disabled) row.addEventListener('click', async () => {
        if (!sameTrack(doc.trackId)) return;
        const limit = Number(state.player.duration), target = Number.isFinite(limit) && limit > 0 ? Math.min(seek, limit) : seek;
        const result = await invoke('player:seek', {position: target});
        if (result) app.updatePlayer(result);
      });
      body.append(row); renderedLines[index] = {row, words};
    });
    if (prefs.showTranslation !== false && doc.plainTranslation) {
      body.append(node('div', 'untimed-translation-label', '完整译文 · 无时间轴'), node('div', 'plain-lyrics translation untimed-translation', doc.plainTranslation));
    }
    $('resumeFollow').hidden = follow;
    paintLyrics();
  }
  function scrollToActive() {
    const entry = renderedLines[activeLine], scroll = $('lyricsScroll');
    if (!entry || entry.row.hidden) return;
    const rowRect = entry.row.getBoundingClientRect(), scrollRect = scroll.getBoundingClientRect();
    const top = Math.max(0, scroll.scrollTop + rowRect.top - scrollRect.top - scroll.clientHeight * .34);
    scroll.scrollTo({top, behavior: motionReduced() ? 'auto' : 'smooth'});
  }
  function layoutChanged() {
    if (layoutFollowPending) return;
    layoutFollowPending = true;
    // Coalesce this turn's resize notifications after the layout mode is applied.
    // The rectangle read below flushes the updated CSS layout, even while paused.
    // This is one bounded microtask, not an additional animation-frame loop.
    Promise.resolve().then(() => {
      layoutFollowPending = false;
      if (!state.immersive || $('lyricsColumn').hidden || !follow || lyricDocument?.status !== 'ready' || $('lyricsScroll').clientHeight <= 0) return;
      const current = timeline.lineIndex(lyricDocument.lines, position(), lyricDocument.offsetMs);
      if (current < 0 || !renderedLines[current] || renderedLines[current].row.hidden) return;
      if (current !== activeLine) paintLyrics();
      else scrollToActive();
    });
  }
  function paintLyrics() {
    if (!state.immersive || lyricDocument?.status !== 'ready') return;
    const next = timeline.lineIndex(lyricDocument.lines, position(), lyricDocument.offsetMs);
    if (next !== activeLine) {
      const old = renderedLines[activeLine];
      if (old) { old.row.classList.remove('active'); for (const word of old.words) word.span.style.setProperty('--word-progress', '0%'); }
      activeLine = next;
      if (renderedLines[next]) renderedLines[next].row.classList.add('active');
      if (follow && next >= 0) scrollToActive();
    }
    const entry = renderedLines[activeLine];
    if (entry) for (const {span, word} of entry.words) {
      const progress = timeline.wordProgress(word, position(), lyricDocument.offsetMs);
      span.style.setProperty('--word-progress', `${progress == null ? 0 : Math.round(progress * 1000) / 10}%`);
    }
  }
  function pauseFollow() {
    if (!state.immersive || lyricDocument?.status !== 'ready') return;
    follow = false; $('resumeFollow').hidden = false;
  }
  $('lyricsScroll').addEventListener('wheel', pauseFollow, {passive: true});
  $('lyricsScroll').addEventListener('touchmove', pauseFollow, {passive: true});
  $('lyricsScroll').addEventListener('pointerdown', event => { if (event.target === $('lyricsScroll')) pauseFollow(); });
  $('lyricsScroll').addEventListener('keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) pauseFollow(); });
  $('resumeFollow').addEventListener('click', () => { follow = true; $('resumeFollow').hidden = true; scrollToActive(); });

  function resultStatus(result) {
    if (!result) return '无法读取搜索结果，请重试。';
    if (result.status === 'network-error') return `网络连接失败：${result.error || '请检查网络。'}`;
    if (result.status === 'parse-error') return `歌词源返回内容无法解析：${result.error || '请稍后重试。'}`;
    if (result.reason === 'online-disabled' || result.reason === 'source-disabled') return '在线歌词已关闭，可在歌词设置中开启。';
    if (result.reason === 'missing-metadata') return '曲目信息不足，请输入搜索词。';
    if (!result.results?.length) return '没有找到匹配结果，请尝试其他关键词。';
    return `找到 ${result.results.length} 个版本${result.fromCache ? ' · 搜索缓存' : ''}`;
  }
  function previewText(document) {
    if (!document) return '预览失败，请重试。';
    if (document.status === 'instrumental') return '纯音乐';
    if (document.status === 'plain') return [document.plainText, document.plainTranslation ? `完整译文（无时间轴）\n${document.plainTranslation}` : ''].filter(Boolean).join('\n\n') || '纯文本歌词为空';
    if (document.status === 'ready') {
      const lines = (document.lines || []).slice(0, 8).map(line => [line.text, line.translation].filter(Boolean).join('\n')).join('\n');
      return [lines, document.plainTranslation ? `完整译文（无时间轴）\n${document.plainTranslation}` : ''].filter(Boolean).join('\n\n') || '歌词内容为空';
    }
    return `${statusText(document)}${document.error ? `：${document.error}` : ''}`;
  }
  function showSearch() {
    const id = currentTrackId();
    if (!id) return;
    const body = node('div'), track = currentTrack(), description = paragraph(`为“${clean(track?.title, '未知标题')}”选择歌词版本。可预览后手动绑定。`);
    const row = node('div', 'dialog-row'), input = node('input'), results = node('div'), status = paragraph('正在搜索…');
    input.type = 'text'; input.maxLength = 500; input.placeholder = '曲名、艺术家或其他关键词';
    input.setAttribute('aria-label', '歌词搜索词');
    const search = async () => {
      const token = ++searchRevision, dialog = dialogRevision, query = input.value.trim();
      status.textContent = '正在搜索…'; results.replaceChildren();
      const found = await invoke('lyrics:search', {trackId: id, ...(query ? {query} : {})}, {isCurrent: () => token === searchRevision && dialog === dialogRevision && sameTrack(id)});
      if (token !== searchRevision || dialog !== dialogRevision || !sameTrack(id)) return;
      status.textContent = resultStatus(found);
      for (const candidate of found?.results || []) {
        const item = node('div', 'candidate'), preview = node('div', 'preview-box');
        item.append(node('div', 'candidate-title', clean(candidate.title, '未知标题')));
        const kind = {word: '逐词', line: '逐行', plain: '纯文本', instrumental: '纯音乐'}[candidate.kind] || '无时间轴';
        item.append(node('div', 'candidate-meta', [clean(candidate.artist, '未知艺术家'), candidate.album, candidate.duration ? time(candidate.duration) : '', candidate.source, candidate.format, kind].filter(Boolean).join(' · ')));
        const controls = node('div', 'candidate-actions');
        controls.append(button('预览', 'button', async () => {
          const selectedSearch = searchRevision, selectedDialog = dialogRevision;
          preview.textContent = '正在读取预览…';
          const document = await invoke('lyrics:preview', {trackId: id, candidate}, {isCurrent: () => selectedSearch === searchRevision && selectedDialog === dialogRevision && sameTrack(id)});
          if (selectedSearch !== searchRevision || selectedDialog !== dialogRevision || !sameTrack(id)) return;
          preview.textContent = previewText(document);
        }), button('绑定此版本', 'button primary', async () => {
          const selectedDialog = dialogRevision;
          const result = await lyricCommand('lyrics:bind', {trackId: id, candidate});
          if (!result) return;
          if (['ready', 'plain', 'instrumental'].includes(result.status)) { if (selectedDialog === dialogRevision) resetDialog(); notify('歌词版本已绑定。'); }
          else if (selectedDialog === dialogRevision) preview.textContent = previewText(result);
        }));
        item.append(controls, preview); results.append(item);
      }
    };
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search(); } });
    row.append(input, button('搜索', 'button primary', search, 'search'));
    body.append(description, row, status, results); setDialog('搜索歌词', body); lyricDialogTrack = id; search();
  }
  $('findLyrics').addEventListener('click', showSearch);
  $('importLyrics').addEventListener('click', async () => {
    const id = currentTrackId();
    if (!id) return;
    const result = await lyricCommand('lyrics:import', {trackId: id});
    if (result && ['ready', 'plain', 'instrumental'].includes(result.status)) notify('本地歌词已绑定。');
  });

  return Object.freeze({trackActions, playlistActions, playerChanged, settingsChanged, libraryChanged, enterImmersive, leaveImmersive, layoutChanged, stashSettingsControls});
  }});
})();
