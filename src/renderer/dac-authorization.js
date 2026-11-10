'use strict';

(() => {
  const operations = {
    'exclusive-check': '检查当前设备的独占格式',
    'owned-exit-fallback': '交接时允许正常退出专属播放内核'
  };
  const scopes = {
    'hardware-instance': {label: 'USB 硬件实例', detail: '使用 Windows 报告的唯一 USB 实例身份，绑定当前选中的端点。'},
    'windows-endpoint': {label: '此 Windows 端点', detail: '仅授权本机当前端点和连接位置。Windows 报告换口或重新枚举后，需要再次确认。'}
  };

  function createModule({app, document: doc = globalThis.document} = {}) {
    function element(tag, className, text) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }
    function render({current = () => true} = {}) {
      const section = element('section', 'dialog-section dac-authorization');
      section.append(element('h3', '', 'USB DAC 授权'), element('p', 'dialog-note',
        '先在输出设置中选中 USB 音频设备。授权后，STILL 会在使用前再次核对所选设备和内核。'));
      const fields = element('fieldset', 'dac-authorization-fields');
      fields.append(element('legend', '', '选择要授权的操作'));
      const scopeRow = element('label', 'dac-authorization-choice', '授权范围'), scopeSelect = element('select');
      scopeSelect.setAttribute('data-dac-scope', 'true');
      const scopePlaceholder = element('option', '', '请选择范围'); scopePlaceholder.value = ''; scopeSelect.append(scopePlaceholder);
      for (const [value, scope] of Object.entries(scopes)) {
        const option = element('option', '', scope.label); option.value = value; scopeSelect.append(option);
      }
      scopeRow.append(scopeSelect);
      const scopeDetail = element('p', 'dialog-note');
      fields.append(scopeRow, scopeDetail);
      const choices = Object.entries(operations).map(([capability, label]) => {
        const row = element('label', 'dac-authorization-choice'), check = element('input'); check.type = 'checkbox';
        row.append(check, element('span', '', label)); fields.append(row);
        return {capability, check};
      });
      const formatRow = element('label', 'dac-authorization-choice', '验证格式'), select = element('select');
      for (const bits of [0, 16, 24, 32]) {
        const option = element('option', '', bits ? `48 kHz · ${bits} bit · 双声道` : '请选择格式');
        option.value = bits ? String(bits) : ''; select.append(option);
      }
      formatRow.append(select); fields.append(formatRow);
      const review = element('button', 'button', '审阅并确认授权'); review.type = 'button'; review.disabled = true;
      const status = element('p', 'dialog-note'); status.setAttribute('role', 'status');
      const list = element('ul', 'dac-authorization-list'); list.setAttribute('aria-label', '已保存的 DAC 授权');
      section.append(fields, review, status, list);
      let busy = false;

      function updateControls() {
        fields.disabled = busy;
        const validScope = Object.hasOwn(scopes, scopeSelect.value);
        scopeDetail.textContent = validScope ? scopes[scopeSelect.value].detail : '';
        review.disabled = busy || !validScope || !choices.some(row => row.check.checked) || ![16, 24, 32].includes(Number(select.value));
      }
      const quiet = {quiet: true, isCurrent: current};
      async function refresh() {
        const grants = await app.invoke('dac:list', {}, quiet);
        if (!current()) return;
        list.replaceChildren();
        if (!Array.isArray(grants)) {status.textContent = '暂时无法读取 DAC 授权。'; return;}
        for (const grant of grants.slice(0, 32)) {
          if (typeof grant?.authorizationId !== 'string' || !Object.hasOwn(scopes, grant.scope) || !Array.isArray(grant.capabilities) || ![16, 24, 32].includes(grant.validationFormat?.bits) ||
              !Number.isFinite(grant.expiresAt) || !Number.isFinite(new Date(grant.expiresAt).getTime())) continue;
          const labels = grant.capabilities.filter(name => Object.hasOwn(operations, name)).map(name => operations[name]);
          if (!labels.length) continue;
          const row = element('li', 'dac-authorization-entry');
          const summary = element('div');
          summary.append(element('strong', '', `${scopes[grant.scope].label} · ${grant.authorizationId.slice(0, 8)}`), element('p', 'dialog-note',
            `${labels.join(' · ')} · 48 kHz · ${grant.validationFormat.bits} bit · 双声道 · ${new Date(grant.expiresAt).toLocaleDateString('zh-CN')} 到期`));
          const remove = element('button', 'button', '撤销'); remove.type = 'button';
          remove.addEventListener('click', async () => {
            if (busy || !current()) return;
            busy = true; remove.disabled = true; updateControls();
            try {
              const result = await app.invoke('dac:revoke', {authorizationId: grant.authorizationId}, quiet);
              if (!current()) return;
              status.textContent = result?.revoked ? '已撤销授权。' : '撤销未完成，请重试。';
              await refresh();
            } finally {busy = false; remove.disabled = false; updateControls();}
          });
          row.append(summary, remove); list.append(row);
        }
      }
      fields.addEventListener('change', updateControls);
      review.addEventListener('click', async () => {
        const capabilities = choices.filter(row => row.check.checked).map(row => row.capability), bits = Number(select.value), scope = scopeSelect.value;
        if (busy || !current() || !Object.hasOwn(scopes, scope) || !capabilities.length || ![16, 24, 32].includes(bits)) return;
        busy = true; updateControls(); status.textContent = '正在核验所选设备…';
        try {
          const request = await app.invoke('dac:prepare', {scope, capabilities, validationFormat: {sampleRate: 48000, bits, channels: 2}}, quiet);
          if (!current()) return;
          if (typeof request?.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(request.token)) {
            status.textContent = '无法核验所选 USB 设备，请检查输出设置。'; return;
          }
          status.textContent = '请在 STILL 确认窗口中审阅。';
          const result = await app.invoke('dac:confirm', {token: request.token}, quiet);
          if (!current()) return;
          status.textContent = result?.authorizationId ? '已保存授权。' : '授权未保存。';
          await refresh();
        } finally {busy = false; updateControls();}
      });
      void refresh();
      return section;
    }
    return {render};
  }

  const api = Object.freeze({createModule});
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.STILLDacAuthorization = api;
})();
