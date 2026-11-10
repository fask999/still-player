'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {createHash} = require('node:crypto');
const {promisify} = require('node:util');

const executeFile = promisify(execFile);
const GUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const RENDER_ENDPOINT = new RegExp(`^\\{0\\.0\\.0\\.00000000\\}\\.\\{(${GUID})\\}$`, 'i');
const STOCK_WASAPI_DEVICE = new RegExp(`^0DD9B977-765B-4804-BF2D-B28EBF0C510D:(${GUID})$`, 'i');
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const SHA256 = /^[0-9a-f]{64}$/;
const isSha256 = value => typeof value === 'string' && value.length === 64 && SHA256.test(value);
const DAC_IDENTITY_PROBE_SHA256 = 'e3e34c64cba947254db4482a1036eab2dd0485c57eceb550b1ad52813049562d';
const DAC_IDENTITY_SCOPES = Object.freeze(['hardware-instance', 'windows-endpoint']);
const isDacIdentityScope = scope => DAC_IDENTITY_SCOPES.includes(scope);
const failureStages = new Set(['Endpoint', 'GetId', 'GetState', 'EndpointProperties', 'RenderInterface', 'UsbChain', 'UsbDriver', 'UsbIdentity', 'Topology', 'Arrival', 'Reenumeration', 'Cleanup']);
const identityBrands = new WeakMap();

function dataFields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== keys.length || !keys.every(key => Object.hasOwn(fields, key) && Object.hasOwn(fields[key], 'value'))) return null;
  return Object.fromEntries(keys.map(key => [key, fields[key].value]));
}

function readOwn(value, key) {
  return value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

function normalizeEndpoint(value) {
  if (typeof value !== 'string') return null;
  const match = RENDER_ENDPOINT.exec(value);
  return match?.[0] === value && match[1] !== ZERO_GUID ? value.toUpperCase() : null;
}

function stockDacOutput(output) {
  const typeId = readOwn(output, 'typeId'), deviceId = readOwn(output, 'deviceId');
  const name = readOwn(output, 'name'), typeName = readOwn(output, 'typeName');
  if (typeId !== 'output' || typeof deviceId !== 'string' || readOwn(output, 'unavailableInList') === true ||
      [name, typeName].some(value => typeof value === 'string' && /asio|dsd|sacd|external|外部/i.test(value))) return null;
  const match = STOCK_WASAPI_DEVICE.exec(deviceId);
  if (match?.[0] !== deviceId || match[1] === ZERO_GUID) return null;
  const endpoint = `{0.0.0.00000000}.{${match[1].toUpperCase()}}`, supplied = readOwn(output, 'endpoint');
  if (supplied !== undefined && normalizeEndpoint(supplied) !== endpoint) return null;
  return {typeId, deviceId: deviceId.toUpperCase(), endpoint};
}

function identityError(failureStage) {
  const error = Object.assign(new Error('无法核验当前 USB 音频输出的设备身份。'), {code: 'STILL_DAC_IDENTITY_UNVERIFIED'});
  if (failureStages.has(failureStage)) Object.defineProperty(error, 'nativeIdentityStage', {value: failureStage});
  return error;
}

function parseDacIdentityReport(value, {endpointId, probeSha256, scope} = {}) {
  const keys = ['schemaVersion', 'mode', 'operation', 'scope', 'endpoint', 'observedEndpoint', 'endpointGuid', 'endpointState', 'dataFlow',
    'identitySha256', 'usbUniqueInstance', 'topologyVerified', 'arrivalVerified', 'freshReadVerified', 'containerMatched', 'cleanupComplete',
    'clientActivated', 'initializeCalled', 'startCalled'];
  let row;
  try {row = dataFields(value, keys);} catch {throw identityError();}
  const endpoint = normalizeEndpoint(endpointId);
  const endpointProof = scope === 'windows-endpoint';
  if (!row || !endpoint || !isSha256(probeSha256) || row.schemaVersion !== 2 || !isDacIdentityScope(scope) || row.scope !== scope ||
      row.mode !== 'identity' || row.operation !== 'ReadUsbEndpointIdentity' || normalizeEndpoint(row.endpoint) !== endpoint ||
      normalizeEndpoint(row.observedEndpoint) !== endpoint || typeof row.endpointGuid !== 'string' ||
      row.endpointGuid.toUpperCase() !== RENDER_ENDPOINT.exec(endpoint)[1] || row.endpointState !== 1 || row.dataFlow !== 'render' ||
      !isSha256(row.identitySha256) || typeof row.usbUniqueInstance !== 'boolean' || !endpointProof && !row.usbUniqueInstance ||
      row.topologyVerified !== endpointProof || row.arrivalVerified !== endpointProof || row.freshReadVerified !== endpointProof || row.containerMatched !== true ||
      row.cleanupComplete !== true || row.clientActivated !== false || row.initializeCalled !== false || row.startCalled !== false) throw identityError();
  const identity = Object.freeze({scope, endpointId: endpoint, identitySha256: row.identitySha256, probeSha256});
  identityBrands.set(identity, scope);
  return identity;
}

function isVerifiedDacIdentity(identity, expectedScope) {
  const scope = identityBrands.get(identity);
  return Boolean(scope && (expectedScope === undefined || scope === expectedScope));
}

function readNativeFailureStage(error) {
  if (readOwn(error, 'code') !== 1 || readOwn(error, 'killed') === true || readOwn(error, 'signal')) return null;
  const stdout = readOwn(error, 'stdout');
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 4096) return null;
  try {
    const row = dataFields(JSON.parse(stdout), ['schemaVersion', 'mode', 'code', 'failureStage']);
    return row?.schemaVersion === 2 && row.mode === 'identity' && row.code === 'STILL_DAC_IDENTITY_UNVERIFIED' &&
      failureStages.has(row.failureStage) ? row.failureStage : null;
  } catch {return null;}
}

async function verifyDacProbe(probePath, probeSha256) {
  const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  let cursor = probePath;
  for (;;) {
    if ((await fs.lstat(cursor)).isSymbolicLink() || !same(await fs.realpath(cursor), cursor)) throw identityError();
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const stat = await fs.lstat(probePath);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 1024 * 1024 ||
      createHash('sha256').update(await fs.readFile(probePath)).digest('hex') !== probeSha256) throw identityError();
}

function createDacIdentityReader({probePath, probeSha256 = DAC_IDENTITY_PROBE_SHA256, execute = executeFile} = {}) {
  if (typeof probePath !== 'string' || !path.isAbsolute(probePath) || /^[\\/]{2}/.test(probePath) ||
      path.resolve(probePath) !== probePath || !isSha256(probeSha256)) throw identityError();
  return async function readIdentity({endpointId, scope, signal} = {}) {
    const endpoint = normalizeEndpoint(endpointId);
    if (!endpoint || !isDacIdentityScope(scope) || signal?.aborted) throw identityError();
    let failureStage;
    try {
      await verifyDacProbe(probePath, probeSha256);
      if (signal?.aborted) throw identityError();
      let stdout;
      try {({stdout} = await execute(probePath, [endpoint, 'identity', scope], {windowsHide: true, timeout: 2500, maxBuffer: 4096, signal}));}
      catch (error) {
        await verifyDacProbe(probePath, probeSha256);
        if (!signal?.aborted) failureStage = readNativeFailureStage(error);
        throw identityError();
      }
      await verifyDacProbe(probePath, probeSha256);
      if (signal?.aborted || typeof stdout !== 'string' || Buffer.byteLength(stdout) > 4096) throw identityError();
      return parseDacIdentityReport(JSON.parse(stdout), {endpointId: endpoint, probeSha256, scope});
    } catch {throw identityError(failureStage);}
  };
}

module.exports = {createDacIdentityReader, parseDacIdentityReport, isVerifiedDacIdentity, stockDacOutput, verifyDacProbe,
  isDacIdentityScope, isSha256, dataFields, readOwn, DAC_IDENTITY_PROBE_SHA256};
