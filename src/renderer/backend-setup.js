'use strict';
(() => {
  const api = globalThis.still;
  if (!api?.invoke) return;
  const panel = document.createElement('section');
  panel.className = 'settings-section'; panel.hidden = true; panel.setAttribute('aria-label', '本地播放内核首次设置');
  const title = document.createElement('h2'); title.textContent = '准备本地播放内核';
  const description = document.createElement('p');
  description.textContent = '使用本地音乐或 Apple Music 播放前，请先完成此内核设置；Apple Music 的登录与浏览可先使用。设置会打开原版官方安装器，请选 Portable installation（便携安装），安装到下方独立目录。';
  const target = document.createElement('input'); target.readOnly = true; target.setAttribute('aria-label', '官方便携安装目标目录');
  const instructions = document.createElement('p');
  instructions.textContent = '在官方向导中选择 Portable，把这里的完整目录粘贴为目标；完成安装后返回。若完成页启动了 foobar2000，请先正常关闭那个新窗口，再点“检测并连接”。不要选择原来 foobar2000 的安装或资料目录。';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const buttons = document.createElement('div'); buttons.className = 'settings-shortcuts';
  const button = (label, action) => {const node = document.createElement('button'); node.className = 'button'; node.textContent = label;
    node.addEventListener('click', () => {void action();}); buttons.append(node); return node;};
  let pending = false, current = null, refreshing = false, paused = false;
  const refresh = async () => {
    if (refreshing) return; refreshing = true;
    try {render(await api.invoke('backend:setupStatus'));} catch { /* Private or unavailable application stays usable. */ }
    finally {refreshing = false;}
  };
  const action = async channel => {
    if (pending) return; pending = true; paused = false; render(current);
    try {
      const result = await api.invoke(channel);
      status.textContent = result?.backendReady === false ? '内核文件已准备，连接尚未就绪。请重试连接或查看诊断。' : channel === 'backend:setupComplete' || current?.automatic ? '首次准备已完成。请打开音频设置，明确选择带设备名称的具体共享输出，再播放本地音乐或 Apple Music。不要选择模糊的 Default / 主声音驱动程序；它无法提供精确的切源释放证明。' :
        '官方安装器已打开。完成 Portable 安装并关闭其启动的 foobar2000 后，再检测并连接。';
    } catch (error) {status.textContent = error.message || '准备未完成，请检查便携安装目标后重试。';}
    finally {pending = false; await refresh();}
  };
  const copy = button('选择并复制目标目录', async () => {target.focus(); target.select(); document.execCommand('copy');});
  const begin = button('打开官方安装器', () => action('backend:setupBegin'));
  const complete = button('检测并连接', () => action('backend:setupComplete'));
  const later = button('稍后准备', async () => {
    try {if (!current?.ready) await api.invoke('backend:setupCancel'); paused = true; panel.hidden = true;}
    catch (error) {status.textContent = error.message;}
  });
  const folder = button('打开 STILL 数据目录', () => api.invoke('app:openDataFolder'));
  const audio = button('选择具体音频设备', async () => {document.getElementById('audioButton')?.click();});
  const format = document.createElement('p');
  format.textContent = '默认使用全新官方的系统共享输出。需要独占模式时，请先停止播放并退出 STILL，再打开上方专属目录中的 foobar2000，在 File → Preferences → Playback → Output 中选择设备支持的格式/位深；正常关闭后重新打开 STILL。不复制其他设备的格式或音量偏好。';
  function render(value) {
    if (!value) return; current = value;
    if (value.public === false || value.state === 'not-applicable') {panel.hidden = true; return;}
    panel.hidden = paused && !value.ready;
    title.textContent = value.ready ? '本地播放内核' : value.automatic ? value.busy || value.connecting ? '正在准备内置播放内核' :
      value.code === 'STILL_SETUP_CANCELLED' ? '自动准备已暂停' : value.code ? '内置内核准备未完成' : '内置播放内核' : '准备本地播放内核';
    description.textContent = value.automatic ? 'STILL 已内置原版 foobar2000 来源文件，首次打开会在当前用户的独立目录自动准备播放内核，不依赖电脑上已有的 foobar2000，也不会导入其资料。准备完成后才能开始本地或 Apple Music 播放；不会自动播放。' :
      '使用本地音乐或 Apple Music 播放前，请先完成此内核设置；Apple Music 的登录与浏览可先使用。设置会打开原版官方安装器，请选 Portable installation（便携安装），安装到下方独立目录。';
    description.hidden = instructions.hidden = begin.hidden = complete.hidden = value.ready === true;
    if (value.automatic) {instructions.hidden = begin.hidden = true; target.hidden = copy.hidden = value.ready !== true; complete.textContent = '重试自动准备';}
    else {target.hidden = copy.hidden = false; complete.textContent = '检测并连接';}
    later.textContent = value.ready ? '收起设置' : '稍后设置';
    folder.hidden = audio.hidden = format.hidden = value.ready !== true;
    target.value = value.targetDirectory || '';
    for (const item of [begin, complete, copy]) item.disabled = pending || value.busy === true;
    later.disabled = value.connecting === true;
    begin.disabled ||= value.installerActive === true;
    complete.disabled ||= (!value.automatic && value.state === 'setup-required') || value.installerActive === true;
    if (value.ready) status.textContent = '内核准备已完成。请在音频设置选择带设备名称的具体共享输出；当前连接以播放状态为准。';
    else if (value.automatic && (value.busy || value.connecting)) {
      const phases = {'verifying-source': '正在核验内置来源与工具', 'extracting-core': '正在校验并准备原版内核', 'committing-core': '正在放置已校验的内核文件',
        'core-prepared': '正在准备连接', 'validating-installation': '正在复核独立内核', 'preparing-profile': '正在准备组件和本机配置', prepared: '正在核验播放内核连接'};
      status.textContent = `${phases[value.state] || '正在自动准备播放内核'}${value.progress ? `（${value.progress.completed}/${value.progress.total}）` : ''}；不会自动播放。`;
    } else if (value.automatic && value.code) status.textContent = value.code === 'STILL_SETUP_CANCELLED' ? '自动准备已暂停，可稍后重试。' :
      value.code === 'STILL_BACKEND_CONNECTION_FAILED' ? '内核文件已准备，连接尚未就绪。请重试连接或查看诊断。' : '自动准备未完成。请重试；若存在目录或文件冲突，请保留资料并查看诊断。';
    else if (!pending) status.textContent = value.automatic ? value.prepared ? '内核文件已准备，连接尚未就绪。请重试连接或查看诊断。' :
      '即将自动准备内置播放内核；无需其他 foobar2000 安装。' : value.installerActive ? '等待官方安装向导完成。' : '完成以下设置后即可连接本地播放内核。';
  }
  panel.append(title, description, target, instructions, buttons, status, format);
  const anchor = document.getElementById('connectionStrip');
  if (anchor?.parentNode) anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  else document.body.prepend(panel);
  api.on?.('backend-setup', render);
  document.addEventListener('click', event => {if (event.target.closest?.('#retryLocal, #audioButton')) {paused = false; void refresh();}});
  setInterval(() => {if (current?.automatic && !current.ready && !paused) void refresh();}, 750);
  void refresh();
})();
