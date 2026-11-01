'use strict';

// This reader only uses the app's existing Apple service. No session creation,
// account authorization, local engine, output probe or process APIs belong here.
const {safeDiagnosticErrorCode} = require('./diagnostics');
const own = (value, key) => {
  if (!value || typeof value !== 'object') return undefined;
  try {return Object.getOwnPropertyDescriptor(value, key)?.value;} catch {return undefined;}
};
async function readAppleDiagnosticSnapshot(apple) {
  const read = async (method, input, fallback) => {
    try {
      const operation = own(apple, method);
      if (typeof operation !== 'function') return {available: false, status: 'unavailable', errorCode: fallback};
      const value = await operation.call(apple, ...(input ? [input] : []));
      return value && typeof value === 'object' && !Array.isArray(value) ? value :
        {available: false, status: 'unavailable', errorCode: 'official-invalid-response'};
    } catch (error) {
      return {available: false, status: 'unavailable', errorCode: safeDiagnosticErrorCode(error) || 'official-operation-failed'};
    }
  };
  const state = await read('getState', null, 'official-api-unavailable');
  const queue = own(state, 'available') === true && own(state, 'pending') !== true && typeof own(apple, 'getQueue') === 'function' ?
    await read('getQueue', {limit: 5, offset: 0}, 'official-queue-unavailable') : undefined;
  // State/queue reads can refresh authorization and method support. Take status
  // last so a cached pre-probe status cannot overwrite their fresh evidence.
  const status = await read(typeof own(apple, 'getStatus') === 'function' ? 'getStatus' : 'status', null, 'official-api-unavailable');
  return {apple: {state, ...(queue === undefined ? {} : {queue}), status}};
}
function createDiagnosticSnapshotReader({apple, getGeneralSnapshot, getBuildSnapshot, getHandoffSnapshot}) {
  return async ({scope} = {}) => {
    let value = scope === 'apple' ? await readAppleDiagnosticSnapshot(apple) : await getGeneralSnapshot();
    if (scope === 'apple' && typeof getBuildSnapshot === 'function') value = {...value, build: await getBuildSnapshot()};
    return typeof getHandoffSnapshot === 'function' ? {...value, handoff: getHandoffSnapshot()} : value;
  };
}
module.exports = {readAppleDiagnosticSnapshot, createDiagnosticSnapshotReader};
