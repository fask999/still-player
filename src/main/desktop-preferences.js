'use strict';

const {validateWindowPlacement} = require('./window-placement');

const DESKTOP_DEFAULTS = Object.freeze({
  preventSleep: true,
  systemMediaControls: true,
  globalShortcutsEnabled: false,
  hotkeyToggle: '',
  hotkeyNext: '',
  hotkeyPrevious: '',
  hotkeyShowWindow: '',
  windowPlacement: null
});
const HOTKEY_ACTIONS = Object.freeze({toggle: 'hotkeyToggle', previous: 'hotkeyPrevious', next: 'hotkeyNext', showWindow: 'hotkeyShowWindow'});
const BOOLEAN_KEYS = new Set(['preventSleep', 'systemMediaControls', 'globalShortcutsEnabled']);
const HOTKEY_KEYS = new Set(Object.values(HOTKEY_ACTIONS));
const NAMED_KEYS = new Map(['Space', 'Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete'].map(key => [key.toLowerCase(), key]));

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeDesktopShortcut(value) {
  if (typeof value !== 'string' || value.length > 64) throw new Error('快捷键必须是有效的组合键。');
  if (value === '') return '';
  if (value !== value.trim()) throw new Error('快捷键不能包含首尾空格。');
  const parts = value.split('+');
  if (parts.length < 2 || parts.length > 4 || parts.some(part => !part)) throw new Error('快捷键需要 Ctrl 或 Alt 修饰键。');
  const rawKey = parts.pop();
  let key = /^[a-z0-9]$/i.test(rawKey) ? rawKey.toUpperCase() : /^f(?:[1-9]|1\d|2[0-4])$/i.test(rawKey) ? rawKey.toUpperCase() : NAMED_KEYS.get(rawKey.toLowerCase());
  if (!key) throw new Error('此快捷键不受支持；媒体键由 Windows 媒体控制处理。');
  const modifiers = new Set();
  for (const part of parts) {
    const modifier = /^(?:control|ctrl)$/i.test(part) ? 'Control' : /^alt$/i.test(part) ? 'Alt' : /^shift$/i.test(part) ? 'Shift' : null;
    if (!modifier || modifiers.has(modifier)) throw new Error('快捷键修饰键无效或重复。');
    modifiers.add(modifier);
  }
  if (!modifiers.has('Control') && !modifiers.has('Alt')) throw new Error('快捷键需要 Ctrl 或 Alt 修饰键。');
  // These Windows session/window commands must remain under the operating system.
  if (modifiers.has('Alt') && !modifiers.has('Control') && ['F4', 'Space'].includes(key) ||
      modifiers.has('Control') && modifiers.has('Alt') && key === 'Delete') throw new Error('此组合键由 Windows 使用，请换一个。');
  return [...['Control', 'Alt', 'Shift'].filter(modifier => modifiers.has(modifier)), key].join('+');
}

function validateDesktopPreference(key, value) {
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value !== 'boolean') throw new Error(`Invalid setting: desktop.${key}`);
    return value;
  }
  if (HOTKEY_KEYS.has(key)) return normalizeDesktopShortcut(value);
  if (key === 'windowPlacement') return validateWindowPlacement(value);
  throw new Error(`Unknown setting: desktop.${key}`);
}

function validateDesktopPreferences(value, {partial = false} = {}) {
  if (!record(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new Error('Desktop preferences must be a data object');
  const result = partial ? {} : structuredClone(DESKTOP_DEFAULTS);
  for (const [key, setting] of Object.entries(value)) result[key] = validateDesktopPreference(key, setting);
  const shortcuts = Object.values(HOTKEY_ACTIONS).map(key => result[key]).filter(Boolean);
  if (new Set(shortcuts).size !== shortcuts.length) throw new Error('不同操作不能使用同一个全局快捷键。');
  return result;
}

function mergeDesktopPreferences(current, patch) {
  const next = {...validateDesktopPreferences(current || {}), ...validateDesktopPreferences(patch, {partial: true})};
  return validateDesktopPreferences(next);
}

function readDesktopPreferences(settings) {
  try {return validateDesktopPreferences(settings?.desktop || {});}
  catch {return structuredClone(DESKTOP_DEFAULTS);}
}

module.exports = {DESKTOP_DEFAULTS, HOTKEY_ACTIONS, normalizeDesktopShortcut, validateDesktopPreference, validateDesktopPreferences, mergeDesktopPreferences, readDesktopPreferences};
