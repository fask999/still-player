'use strict';

// Private in-process read receipts. Only the bridge's already-validated native
// context path receives an issuer; library code receives the verifier alone.
const scopes = new WeakMap();
const invalid = () => Object.assign(new Error('现有播放上下文许可已失效，请刷新当前列表后重试。'), {code: 'STILL_EXISTING_CONTEXT_SCOPE_INVALID'});
function locationKey(location) {
  if (!location || typeof location !== 'object' || Array.isArray(location)) return null;
  const file = Object.getOwnPropertyDescriptor(location, 'path'), subsong = Object.getOwnPropertyDescriptor(location, 'subsong');
  return file && Object.hasOwn(file, 'value') && typeof file.value === 'string' && file.value.length > 0 &&
    subsong && Object.hasOwn(subsong, 'value') && Number.isSafeInteger(subsong.value) && subsong.value >= 0 ? JSON.stringify([file.value, subsong.value]) : null;
}
function live(binding) {
  if (!binding?.active) return false;
  try {
    const value = binding.isCurrent();
    if (value === true) return true;
    // Never assimilate a thenable, and never turn asynchronous verification into
    // permission. Consume a real rejecting Promise only to avoid an orphan error.
    try {void Promise.prototype.then.call(value, () => {}, () => {});} catch {}
  } catch {}
  return false;
}
function createExistingContextScopeIssuer({bridge, session, endpoint, operation, isCurrent} = {}) {
  if (!bridge || typeof bridge !== 'object' || !operation || typeof operation !== 'object' ||
      session !== null && typeof session !== 'object' || typeof endpoint !== 'string' || !endpoint || typeof isCurrent !== 'function') throw invalid();
  const binding = {bridge, session, endpoint, operation, isCurrent, active: true}; let issued = false;
  return Object.freeze({
    issue(locations) {
      if (issued || !live(binding) || !Array.isArray(locations) || !locations.length || locations.length > 50000) throw invalid();
      const keys = new Set();
      for (let index = 0; index < locations.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(locations, String(index));
        const key = descriptor && Object.hasOwn(descriptor, 'value') && locationKey(descriptor.value);
        if (!key) throw invalid(); keys.add(key);
      }
      issued = true;
      const scope = Object.freeze(Object.create(null)); scopes.set(scope, {...binding, owner: binding, keys}); return scope;
    },
    revoke() {binding.active = false;}
  });
}
function verifyExistingContextScope(scope, location) {
  try {const binding = scopes.get(scope), key = locationKey(location); return Boolean(key && binding && live(binding.owner) && binding.keys.has(key));}
  catch {return false;}
}
function isExistingContextScopeForOperation(scope, operation, session) {
  try {const binding = scopes.get(scope); return Boolean(binding && binding.operation === operation && binding.session === session && live(binding.owner));}
  catch {return false;}
}
module.exports = {createExistingContextScopeIssuer, verifyExistingContextScope, isExistingContextScopeForOperation};
