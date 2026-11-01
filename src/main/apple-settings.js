'use strict';

// Pure DTO boundary only. Core owns SDK reads, writes and session coordination.
const SNAPSHOT_KEYS = new Set(['source', 'available', 'status', 'sessionOpen', 'authorized', 'pending',
  'repeatMode', 'shuffleMode', 'bitrateTarget', 'capabilities', 'details']);
const CAPABILITY_KEYS = new Set(['read', 'repeatMode', 'shuffleMode', 'bitrateTarget', 'openSession',
  'refreshLibrary', 'canSelectLossless', 'outputSelection']);
const DETAIL_KEYS = new Set(['actualBitrate', 'actualDacRate']);
const PATCH_KEYS = new Set(['repeatMode', 'shuffleMode']);
const STATUSES = new Set(['ready', 'pending', 'session-closed', 'unavailable', 'unsupported']);
const REPEAT_MODES = new Set(['none', 'one', 'all']);
const SHUFFLE_MODES = new Set(['off', 'songs']);

function invalid(kind) {return new TypeError(`Invalid Apple settings ${kind}`);}
function dataRecord(raw, allowed, kind, optional = false) {
  if (optional && (raw === undefined || raw === null)) return Object.create(null);
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(kind);
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) throw invalid(kind);
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== 'string' || !allowed.has(key)) throw invalid(kind);
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid(kind);
      result[key] = descriptor.value;
    }
    return result;
  } catch {throw invalid(kind);}
}
const enumValue = (value, choices) => typeof value === 'string' && choices.has(value) ? value : null;

function normalizeAppleSettingsSnapshot(raw) {
  const value = dataRecord(raw, SNAPSHOT_KEYS, 'snapshot', true);
  if (Object.hasOwn(value, 'source') && value.source !== 'apple') throw invalid('snapshot');
  const capabilities = dataRecord(value.capabilities, CAPABILITY_KEYS, 'snapshot', true);
  // Accept our complete output at another boundary without accepting a quality
  // measurement from input. This bridge has no verified stream or DAC metrics.
  dataRecord(value.details, DETAIL_KEYS, 'snapshot', true);
  const repeatMode = enumValue(value.repeatMode, REPEAT_MODES);
  const shuffleMode = enumValue(value.shuffleMode, SHUFFLE_MODES);
  return {
    source: 'apple',
    available: value.available === true,
    status: enumValue(value.status, STATUSES) || 'unsupported',
    sessionOpen: value.sessionOpen === true,
    authorized: typeof value.authorized === 'boolean' ? value.authorized : null,
    pending: value.pending === true,
    repeatMode,
    shuffleMode,
    bitrateTarget: value.bitrateTarget === 64 || value.bitrateTarget === 256 ? value.bitrateTarget : null,
    capabilities: {
      read: capabilities.read === true,
      repeatMode: capabilities.repeatMode === true && repeatMode !== null,
      shuffleMode: capabilities.shuffleMode === true && shuffleMode !== null,
      bitrateTarget: false,
      openSession: capabilities.openSession === true,
      refreshLibrary: capabilities.refreshLibrary === true,
      canSelectLossless: false,
      outputSelection: false
    },
    details: {actualBitrate: null, actualDacRate: null}
  };
}

function validateAppleSettingsPatch(patch) {
  const value = dataRecord(patch, PATCH_KEYS, 'patch');
  const keys = Object.keys(value);
  if (keys.length !== 1) throw invalid('patch');
  const key = keys[0], mode = enumValue(value[key], key === 'repeatMode' ? REPEAT_MODES : SHUFFLE_MODES);
  if (mode === null) throw invalid('patch');
  return {[key]: mode};
}

module.exports = {normalizeAppleSettingsSnapshot, validateAppleSettingsPatch};
