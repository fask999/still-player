'use strict';

const {HOTKEY_ACTIONS, readDesktopPreferences} = require('./desktop-preferences');

function createDesktopShortcuts({globalShortcut, onAction, onChange = () => {}} = {}) {
  const owned = new Map();
  let enabled = false, disposed = false, registrations = [];
  const supported = Boolean(globalShortcut && ['register', 'unregister', 'isRegistered'].every(method => typeof globalShortcut[method] === 'function'));
  function snapshot() {return {enabled, available: supported, registrations: registrations.map(row => ({...row}))};}
  function emit() {try {onChange(snapshot());} catch {}}
  function remove(action) {
    const accelerator = owned.get(action);
    if (!accelerator) return;
    owned.delete(action);
    try {globalShortcut.unregister(accelerator);} catch {}
  }
  return {
    configure(settings) {
      if (disposed) return snapshot();
      const preferences = readDesktopPreferences(settings);
      enabled = preferences.globalShortcutsEnabled;
      for (const [action, accelerator] of owned) {
        if (!enabled || preferences[HOTKEY_ACTIONS[action]] !== accelerator) remove(action);
      }
      registrations = [];
      if (enabled) for (const [action, key] of Object.entries(HOTKEY_ACTIONS)) {
        const accelerator = preferences[key];
        if (!accelerator) continue;
        const row = {action, accelerator, registered: owned.get(action) === accelerator};
        if (!supported) row.error = '全局快捷键暂不可用。';
        else if (!row.registered) {
          try {
            if (globalShortcut.isRegistered(accelerator)) row.error = '此快捷键已被占用，请换一个。';
            else if (globalShortcut.register(accelerator, () => {
              if (!disposed && enabled && owned.get(action) === accelerator) Promise.resolve().then(() => onAction?.(action)).catch(() => {});
            }) === true) {owned.set(action, accelerator); row.registered = true;}
            else row.error = '此快捷键已被占用或无法注册，请换一个。';
          } catch {row.error = '此快捷键无法注册，请换一个。';}
        }
        registrations.push(row);
      }
      emit(); return snapshot();
    },
    getStatus: snapshot,
    dispose() {if (disposed) return; disposed = true; enabled = false; for (const action of [...owned.keys()]) remove(action); registrations = [];}
  };
}

module.exports = {createDesktopShortcuts};
