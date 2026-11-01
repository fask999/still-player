'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {normalizeMusicBrainzContact} = require('./metadata-covers');

const DEFAULTS = Object.freeze({
  lyrics: Object.freeze({fontSize: 30, lineHeight: 1.75, translationSize: 18,
    showOriginal: true, showTranslation: true, onlineEnabled: true, cacheEnabled: true, preferredSource: 'lrclib'}),
  appearance: Object.freeze({reducedMotion: false, localView: 'albums', accentColor: '#A8B9FF', accentMode: 'color'}),
  onlineCovers: Object.freeze({musicBrainzContact: ''})
});
const RULES = {
  lyrics: {fontSize: [14, 72], lineHeight: [1, 3], translationSize: [10, 48],
    showOriginal: 'boolean', showTranslation: 'boolean', onlineEnabled: 'boolean', cacheEnabled: 'boolean', preferredSource: ['lrclib']},
  appearance: {reducedMotion: 'boolean', localView: ['library', 'albums', 'artists', 'playlists'], accentColor: 'hexColor', accentMode: ['none', 'color']},
  onlineCovers: {musicBrainzContact: 'musicBrainzContact'}
};
const clone = value => JSON.parse(JSON.stringify(value));
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function mergeSettings(current, patch) {
  if (!isRecord(patch)) throw new Error('Settings patch must be an object');
  const result = clone(current);
  for (const [section, values] of Object.entries(patch)) {
    if (!Object.hasOwn(RULES, section) || !isRecord(values)) throw new Error(`Unknown settings section: ${section}`);
    result[section] ||= clone(DEFAULTS[section]);
    for (const [key, value] of Object.entries(values)) {
      const rule = RULES[section][key];
      if (!Object.hasOwn(RULES[section], key)) throw new Error(`Unknown setting: ${section}.${key}`);
      const contact = rule === 'musicBrainzContact' ? normalizeMusicBrainzContact(value) : '';
      const valid = rule === 'musicBrainzContact' ? value === '' || Boolean(contact) : rule === 'hexColor' ? typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value) : typeof rule === 'string' ? typeof value === rule :
        typeof rule[0] === 'number' ? typeof value === 'number' && Number.isFinite(value) && value >= rule[0] && value <= rule[1] : rule.includes(value);
      if (!valid) throw new Error(`Invalid setting: ${section}.${key}`);
      result[section][key] = rule === 'musicBrainzContact' ? contact : rule === 'hexColor' ? value.toUpperCase() : value;
    }
  }
  if (!result.lyrics.showOriginal && !result.lyrics.showTranslation) throw new Error('Keep original lyrics or translation visible');
  return result;
}
function createSettingsService({dataDir}) {
  const file = path.join(dataDir, 'settings.json');
  let value = clone(DEFAULTS);
  let pending = Promise.resolve();
  let closed = false;
  return {
    async initialize() {
      await fs.mkdir(dataDir, {recursive: true});
      try { value = mergeSettings(clone(DEFAULTS), JSON.parse(await fs.readFile(file, 'utf8'))); }
      catch (error) {
        if (error.code !== 'ENOENT') {
          // Retain an unreadable file for inspection, never silently overwrite it.
          await fs.copyFile(file, `${file}.invalid-${Date.now()}`).catch(() => {});
        }
      }
      return clone(value);
    },
    get() { return clone(value); },
    update(patch) {
      if (closed) return Promise.reject(new Error('Settings service has been closed'));
      // A caller cannot change a queued patch while another disk write is pending.
      try {
        if (!isRecord(patch) || Object.values(patch).some(section => !isRecord(section))) throw new Error('Settings patch sections must be objects');
        patch = structuredClone(patch);
      }
      catch (error) { return Promise.reject(error); }
      const operation = pending.then(async () => {
        const next = mergeSettings(value, patch);
        const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
        let handle;
        try {
          handle = await fs.open(temp, 'wx');
          await handle.writeFile(JSON.stringify(next, null, 2), 'utf8');
          await handle.sync();
          await handle.close(); handle = null;
          await fs.rename(temp, file);
        } finally {await handle?.close().catch(() => {}); await fs.unlink(temp).catch(() => {});}
        value = next;
        return clone(value);
      });
      pending = operation.catch(() => {});
      return operation;
    },
    async close() { closed = true; await pending; }
  };
}
module.exports = {DEFAULTS, mergeSettings, createSettingsService};
