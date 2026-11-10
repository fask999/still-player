'use strict';
(() => {
  const defaults = {preventSleep: true, systemMediaControls: true, globalShortcutsEnabled: false,
    hotkeyToggle: '', hotkeyPrevious: '', hotkeyNext: '', hotkeyShowWindow: ''};
  const actions = [
    ['toggle', 'hotkeyToggle', '播放／暂停'], ['previous', 'hotkeyPrevious', '上一首'],
    ['next', 'hotkeyNext', '下一首'], ['showWindow', 'hotkeyShowWindow', '显示窗口']
  ];
  const timerMessages = {idle: '未设置定时停止。', firing: '正在停止播放并释放音频…',
    completed: '定时停止已完成。', cancelled: '定时停止已取消。', error: '定时停止未完成。'};
  const powerMessages = {active: '播放时防止系统睡眠已生效。', idle: '等待播放。', disabled: '已关闭。', unavailable: '当前不可用。'};
  const mediaMessages = {disabled: '已关闭。', idle: '等待播放。', starting: '正在准备。', ready: '已就绪。', unavailable: '当前不可用。', failed: '未能启用。'};
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function message(text, error) { return text + (error ? ` ${String(error)}` : ''); }
  function validHotkey(value) {
    if (!value) return true;
    const parts = value.split('+').map(part => part.trim());
    if (parts.some(part => !part) || parts.length < 2 || parts.some(part => /^(media.*|volumeup|volumedown|volumemute)$/i.test(part))) return false;
    const modifiers = /^(control|ctrl|alt|shift)$/i, prefix = parts.slice(0, -1);
    return prefix.every(part => modifiers.test(part)) && prefix.some(part => /^(control|ctrl|alt)$/i.test(part)) && !modifiers.test(parts[parts.length - 1]);
  }
  function create({bridge = window.still, onError, isCurrent = () => true} = {}) {
    let host = null, root = null, view = null, state = null, unsubscribe = null, interval = null;
    let generation = 0, eventVersion = 0, refreshVersion = 0, pending = false, timerAnchor = 0, timerRemaining = 0;
    let subscriptionToken = null, intervalToken = null;
    let feedback = '';
    function current(token) {
      if (token !== generation || !root) return false;
      let active = false;
      try { active = isCurrent() === true; } catch (_) { /* Treat a stale host as closed. */ }
      if (!active) dispose();
      return active;
    }
    function report(error, token) {
      if (!current(token)) return;
      feedback = message('操作未完成，请重试。', error?.message);
      render();
      if (typeof onError === 'function') { try { onError(error); } catch (_) { /* A host callback must not break the panel. */ } }
    }
    function update(value) {
      if (!value || typeof value !== 'object') return;
      state = value;
      timerRemaining = Math.max(0, Number(value.sleepTimer?.remainingSeconds) || 0);
      timerAnchor = Date.now();
      render();
    }
    async function refresh(token) {
      const request = ++refreshVersion, seen = eventVersion;
      try {
        const result = await bridge.invoke('desktop:status', {});
        if (current(token) && request === refreshVersion && seen === eventVersion) update(result);
      } catch (error) {
        if (current(token) && request === refreshVersion && seen === eventVersion) {
          state = {available: false, readOnly: true};
          report(error, token);
        }
      }
    }
    async function command(channel, payload) {
      const token = generation;
      if (!current(token) || !state?.available || state.readOnly || pending) return;
      pending = true; feedback = ''; render();
      try {
        await bridge.invoke(channel, payload);
        if (current(token)) await refresh(token);
      } catch (error) { report(error, token); }
      finally { if (current(token)) { pending = false; render(); } }
    }
    function patch(key, value) { return command('settings:update', {patch: {desktop: {[key]: value}}}); }
    function controlButton(label, callback) {
      const token = generation;
      const button = element('button', 'button desktop-controls__button', label);
      button.type = 'button'; button.addEventListener('click', () => { if (current(token)) callback(); }); return button;
    }
    function switchControl(labelText, detail, key) {
      const token = generation;
      const wrap = element('div', 'desktop-controls__switch');
      const label = element('label', 'desktop-controls__switch-label');
      const input = element('input'); input.type = 'checkbox';
      label.append(input, element('span', '', labelText));
      const description = element('p', 'desktop-controls__note', detail);
      input.addEventListener('change', () => { if (current(token)) void patch(key, input.checked); });
      wrap.append(label, description); return {wrap, input};
    }
    function createView() {
      const token = generation;
      const panel = element('section', 'desktop-controls');
      panel.setAttribute('aria-label', '桌面控制');
      panel.append(element('h3', '', '桌面控制'));
      const availability = element('p', 'desktop-controls__status');
      availability.setAttribute('role', 'status'); availability.setAttribute('aria-live', 'polite'); panel.append(availability);
      const content = element('div', 'desktop-controls__content'); panel.append(content);
      const power = switchControl('播放时防止系统睡眠', '仅在播放时防止系统睡眠，显示器仍可自然熄屏。', 'preventSleep');
      const powerStatus = element('p', 'desktop-controls__status'); power.wrap.append(powerStatus); content.append(power.wrap);
      const media = switchControl('Windows 媒体卡片和媒体键', '在 Windows 媒体卡片中显示播放信息，并使用媒体键控制播放。', 'systemMediaControls');
      const mediaStatus = element('p', 'desktop-controls__status'); media.wrap.append(mediaStatus); content.append(media.wrap);
      const timer = element('div', 'desktop-controls__group');
      timer.append(element('h4', '', '定时停止'), element('p', 'desktop-controls__note', '到期后停止播放并释放音频；不会让电脑睡眠或关机。定时仅在本次会话内有效。'));
      const timerRow = element('div', 'desktop-controls__timer-row');
      const presetLabel = element('label', 'desktop-controls__field', '常用时长');
      const preset = element('select');
      for (const [value, label] of [['', '选择时长'], ['15', '15 分钟'], ['30', '30 分钟'], ['60', '60 分钟'], ['90', '90 分钟'], ['120', '120 分钟']]) {
        const option = element('option', '', label); option.value = value; preset.append(option);
      }
      presetLabel.append(preset);
      const minutesLabel = element('label', 'desktop-controls__field', '分钟（1–1440）');
      const minutes = element('input'); minutes.type = 'number'; minutes.min = '1'; minutes.max = '1440'; minutes.step = '1'; minutes.value = '30'; minutesLabel.append(minutes);
      preset.addEventListener('change', () => { if (current(token) && preset.value) minutes.value = preset.value; });
      const start = controlButton('设置定时停止', () => {
        const raw = minutes.value.trim(), value = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < 1 || value > 1440) {
          feedback = '请输入 1 到 1440 之间的整数分钟。'; render(); return;
        }
        void command('desktop:sleepTimer:set', {minutes: value});
      });
      const cancel = controlButton('取消定时', () => { void command('desktop:sleepTimer:cancel', {}); });
      timerRow.append(presetLabel, minutesLabel, start, cancel); timer.append(timerRow);
      const timerStatus = element('p', 'desktop-controls__status'); timerStatus.setAttribute('aria-live', 'off'); timer.append(timerStatus); content.append(timer);
      const shortcuts = element('div', 'desktop-controls__group');
      shortcuts.append(element('h4', '', '全局自定义快捷键'));
      const enable = switchControl('启用全局快捷键', '默认关闭；未填写的操作不会设置快捷键。', 'globalShortcutsEnabled'); shortcuts.append(enable.wrap);
      shortcuts.append(element('p', 'desktop-controls__note', '手动输入组合键，例如 Control+Alt+P。请使用 Ctrl 或 Alt 组合键，不支持媒体键或单键；留空可清除。'));
      const shortcutRows = [];
      for (const [action, key, title] of actions) {
        const row = element('div', 'desktop-controls__shortcut-row');
        const label = element('label', 'desktop-controls__field', title);
        const input = element('input'); input.type = 'text'; input.maxLength = 64; input.placeholder = '例如 Control+Alt+P'; label.append(input);
        let dirty = false;
        input.addEventListener('input', () => { if (current(token)) dirty = true; });
        const save = controlButton('保存', () => {
          const value = input.value.trim().split('+').map(part => part.trim()).join('+');
          if (!validHotkey(value)) { feedback = '请输入包含 Ctrl 或 Alt 的组合，且不要使用媒体键。'; render(); return; }
          dirty = false; void patch(key, value);
        });
        save.setAttribute('aria-label', `保存${title}快捷键`);
        const status = element('p', 'desktop-controls__status'); status.setAttribute('role', 'status'); row.append(label, save, status); shortcuts.append(row);
        shortcutRows.push({action, key, input, save, status, isDirty: () => dirty});
      }
      shortcuts.append(element('p', 'desktop-controls__note', '单个快捷键启用失败时，其他播放器功能仍可使用。'));
      content.append(shortcuts);
      const feedbackNode = element('p', 'desktop-controls__feedback'); feedbackNode.setAttribute('role', 'alert'); panel.append(feedbackNode);
      return {panel, content, availability, power, powerStatus, media, mediaStatus, preset, minutes, start, cancel, timerStatus, enable, shortcutRows, feedbackNode};
    }
    function renderTimer() {
      if (!current(generation) || !view || !state) return;
      const timer = state.sleepTimer || {};
      if (timer.status === 'armed') {
        const remaining = Math.max(0, Math.ceil(timerRemaining - (Date.now() - timerAnchor) / 1000));
        view.timerStatus.textContent = remaining > 0 ? `距离定时停止约 ${Math.floor(remaining / 60)} 分 ${String(remaining % 60).padStart(2, '0')} 秒。` : '等待定时停止状态更新…';
      } else view.timerStatus.textContent = message(timerMessages[timer.status] || '未设置定时停止。', timer.error);
    }
    function render() {
      if (!current(generation) || !view) return;
      const prefs = {...defaults, ...(state?.preferences || {})};
      const writable = state?.available === true && state.readOnly !== true && !pending;
      view.availability.textContent = !state ? '正在读取桌面控制状态…' : !state.available ? '桌面控制当前不可用。' : state.readOnly ? '当前为只读状态，不能更改桌面控制。' : '';
      view.content.hidden = !state?.available;
      view.power.input.checked = !!prefs.preventSleep; view.media.input.checked = !!prefs.systemMediaControls; view.enable.input.checked = !!prefs.globalShortcutsEnabled;
      for (const input of [view.power.input, view.media.input, view.enable.input, view.preset, view.minutes, view.start]) input.disabled = !writable;
      view.cancel.disabled = !writable || !['armed', 'firing'].includes(state?.sleepTimer?.status);
      view.powerStatus.textContent = message(powerMessages[state?.power?.status] || '状态未知。', state?.power?.error);
      view.mediaStatus.textContent = message(mediaMessages[state?.media?.status] || '状态未知。', state?.media?.error);
      for (const row of view.shortcutRows) {
        // Preserve an in-progress edit while unrelated status events arrive.
        if (!row.isDirty() && document.activeElement !== row.input) row.input.value = String(prefs[row.key] || '');
        row.input.disabled = row.save.disabled = !writable;
        const registration = state?.shortcuts?.registrations?.find(item => item.action === row.action);
        row.status.textContent = !registration || !registration.accelerator ? '' : registration.registered ? '已启用。' : message('未能启用。', registration.error);
      }
      view.feedbackNode.textContent = feedback;
      renderTimer();
    }
    function mount(container) {
      if (!container || typeof container.replaceChildren !== 'function') throw new TypeError('A container is required');
      generation++; pending = false; state = null; feedback = ''; refreshVersion++;
      if (root) root.remove();
      host = container; view = createView(); root = view.panel; host.replaceChildren(root);
      if (!unsubscribe && typeof bridge?.on === 'function') {
        const token = {}; subscriptionToken = token;
        const result = bridge.on('desktop', value => { if (subscriptionToken !== token || !current(generation)) return; eventVersion++; update(value); });
        if (subscriptionToken !== token) { if (typeof result === 'function') result(); return; }
        unsubscribe = typeof result === 'function' ? result : () => {};
      }
      if (interval == null) {
        const token = {}; intervalToken = token;
        interval = setInterval(() => { if (intervalToken === token) renderTimer(); }, 1000);
      }
      render(); if (current(generation)) void refresh(generation);
    }
    function dispose() {
      generation++; refreshVersion++; pending = false;
      subscriptionToken = intervalToken = null;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (interval != null) { clearInterval(interval); interval = null; }
      if (root) root.remove();
      root = host = view = state = null;
    }
    return Object.freeze({mount, dispose});
  }
  function createModule({app, bridge = window.still, onError} = {}) {
    if (!app || typeof app.$ !== 'function') throw new TypeError('An app with a dialog is required');
    const dialog = app.$('dialog');
    if (!dialog || typeof dialog.addEventListener !== 'function') throw new TypeError('A dialog is required');
    let ownerCurrent = null, disposed = false;
    const active = () => {
      try { return typeof ownerCurrent === 'function' && ownerCurrent() === true; } catch (_) { return false; }
    };
    const controller = create({bridge, onError, isCurrent: active});
    const close = () => { if (!active()) { controller.dispose(); ownerCurrent = null; } };
    dialog.addEventListener('close', close);
    function render({current} = {}) {
      if (disposed) throw new Error('Desktop controls module is disposed');
      if (typeof current !== 'function') throw new TypeError('A current predicate is required');
      controller.dispose(); ownerCurrent = current;
      const host = element('div', 'desktop-controls-slot');
      controller.mount(host);
      return host;
    }
    function dispose() {
      if (disposed) return;
      disposed = true; ownerCurrent = null; controller.dispose();
      dialog.removeEventListener('close', close);
    }
    return Object.freeze({render, dispose});
  }
  window.STILLDesktopControls = Object.freeze({create, createModule});
})();
