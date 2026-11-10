'use strict';

// Source paths are admitted before native ingestion and held by a separate,
// pinned read-only process. There is deliberately no production spawn/brand
// injection option. Default tests replace module dependencies instead.
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const backendJob = require('./backend-job');
const {decodeCue, parseCue} = require('./cue-import');
const {createMediaFileReader} = require('./media-file-safety');

const DIRECTORY = 'native/cue-read-lease/bin';
const MANIFEST = `${DIRECTORY}/runtime-manifest.json`;
const FILES = Object.freeze(['StillCueReadLease.exe', 'NOTICE.txt']);
const LIMITS = Object.freeze({cueBytes: 1024 * 1024, references: 32, directories: 512, pathChars: 2048,
  totalPathChars: 32768, inputBytes: 196608, lineBytes: 16384, bytesPerSecond: 65536,
  messagesPerSecond: 32, stderrBytes: 4096, startupMs: 6000, checkMs: 5000, closeMs: 5000, heartbeatMs: 2000});
const brands = new WeakMap(), retained = new Set();
const HEX = /^[a-f0-9]{64}$/u;
const UNSAFE_ATTRIBUTES = 0x10 | 0x40 | 0x400 | 0x1000 | 0x4000 | 0x10000 | 0x40000 | 0x400000;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), {code});
const assert = (condition, code, message) => {if (!condition) throw failure(code, message);};
// Full Unicode lowercasing can merge distinct NTFS names (for example U+0130
// and i + combining dot). Object IDs are authoritative; only fold ASCII here.
const foldPath = value => value.replace(/[A-Z]/gu, character => character.toLowerCase());
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && foldPath(a) === foldPath(b);
const cancelled = () => failure('ERR_CUE_READ_LEASE_CANCELLED', 'CUE read-lease acquisition was cancelled.');
const unavailable = () => failure('ERR_CUE_READ_LEASE_UNAVAILABLE', 'A trusted Windows CUE read-lease holder is unavailable.');
const lostError = () => failure('ERR_CUE_READ_LEASE_LOST', 'The CUE read lease is no longer verified.');
const protocolError = () => failure('ERR_CUE_READ_LEASE_PROTOCOL', 'The read-lease holder returned invalid bounded metadata.');
const closeError = () => failure('ERR_CUE_READ_LEASE_CLOSE_UNVERIFIED', 'The read-lease holder has not proved physical closure.');

function exact(value, required, optional = []) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) && required.every(key => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)) &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')));
}
function canonical(value, directory = false) {
  assert(typeof value === 'string' && value.length >= 3 && value.length <= LIMITS.pathChars && value.isWellFormed() &&
    /^[A-Za-z]:\\/u.test(value) && value === path.win32.normalize(value) && !/[\0-\x1f\x7f<>"|?*/]/u.test(value) &&
    !value.slice(2).includes(':') && (directory || !value.endsWith('\\')),
  'ERR_CUE_READ_LEASE_REQUEST', 'Read leases require canonical authorized local paths.');
  for (const part of value.slice(3).split('\\').filter((part, index, parts) => !(directory && parts.length === 1 && !part && index === 0))) {
    assert(part && part !== '.' && part !== '..' && !/[. ]$/u.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part),
      'ERR_CUE_READ_LEASE_REQUEST', 'A read-lease path contains an unsupported component.');
  }
  return value;
}
function snapshotRequest(value) {
  assert(exact(value, ['path', 'references', 'trackCount', 'authorizationRoot', 'encoding', 'contentHash']) &&
    Array.isArray(value.references) && value.references.length > 0 && value.references.length <= LIMITS.references &&
    Reflect.ownKeys(value.references).length === value.references.length + 1 &&
    Array.from({length: value.references.length}, (_, index) => Object.getOwnPropertyDescriptor(value.references, index)).every(row => row && Object.hasOwn(row, 'value')) &&
    Number.isInteger(value.trackCount) && value.trackCount > 0 && value.trackCount <= 99 &&
    ['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].includes(value.encoding) && typeof value.contentHash === 'string' && HEX.test(value.contentHash),
  'ERR_CUE_READ_LEASE_REQUEST', 'CUE read-lease preflight evidence is incomplete.');
  const root = canonical(value.authorizationRoot, true), cue = canonical(value.path), references = value.references.map(name => canonical(name));
  const prefix = foldPath(root.replace(/\\$/u, '')) + '\\';
  assert(path.win32.extname(cue).toLowerCase() === '.cue' && [cue, ...references].every(name => foldPath(name).startsWith(prefix)) &&
    new Set([cue, ...references].map(foldPath)).size === references.length + 1 &&
    root.length + cue.length + references.reduce((sum, name) => sum + name.length, 0) <= LIMITS.totalPathChars,
  'ERR_CUE_READ_LEASE_REQUEST', 'CUE read-lease paths do not match one authorized subtree.');
  return Object.freeze({path: cue, references: Object.freeze(references), trackCount: value.trackCount,
    authorizationRoot: root, encoding: value.encoding, contentHash: value.contentHash});
}
function fingerprint(request) {
  return digest(Buffer.from(JSON.stringify([request.path, request.references,
    request.trackCount, request.authorizationRoot, request.encoding, request.contentHash])));
}
function statIdentity(stat, directory = false) {
  assert(stat && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n) && !stat.isSymbolicLink() &&
    typeof stat.dev === 'bigint' && stat.dev >= 0n && stat.dev <= 0xffffffffn && typeof stat.ino === 'bigint' &&
    stat.ino > 0n && stat.ino <= 0xffffffffffffffffn && (directory || stat.size >= 0n && stat.size <= BigInt(Number.MAX_SAFE_INTEGER)),
  'ERR_CUE_READ_LEASE_REQUEST', 'A precise independent Windows file identity is required.');
  return stat.dev.toString(16).padStart(8, '0') + ':' + stat.ino.toString(16).padStart(16, '0') + (directory ? '' : ':' + stat.size);
}
const fileWitness = stat => [statIdentity(stat), stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
async function ancestors(directory) {
  const root = path.parse(directory).root; let current = root;
  for (const segment of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment); const stat = await fs.lstat(current, {bigint: true});
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'ERR_CUE_READ_LEASE_RUNTIME', 'Runtime ancestry must contain independent directories.');
  }
  assert(samePath(await fs.realpath(directory), directory), 'ERR_CUE_READ_LEASE_RUNTIME', 'Runtime ancestry resolves through a link.');
}
async function regularBytes(filename, maxBytes) {
  await ancestors(path.dirname(filename));
  const before = await fs.lstat(filename, {bigint: true}), identity = fileWitness(before);
  assert(before.size > 0n && before.size <= BigInt(maxBytes) && samePath(await fs.realpath(filename), filename),
    'ERR_CUE_READ_LEASE_RUNTIME', 'A fixed runtime file is missing or unsafe.');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    assert(fileWitness(await handle.stat({bigint: true})) === identity, 'ERR_CUE_READ_LEASE_RUNTIME', 'A runtime identity changed.');
    const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < bytes.length) {const result = await handle.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead;}
    assert(BigInt(length) === before.size && fileWitness(await handle.stat({bigint: true})) === identity &&
      fileWitness(await fs.lstat(filename, {bigint: true})) === identity,
    'ERR_CUE_READ_LEASE_RUNTIME', 'A runtime file changed while being verified.');
    return {bytes: bytes.subarray(0, length), identity};
  } finally {await handle.close();}
}
async function verifyRuntime(root, expected) {
  try {
    assert(typeof backendJob.readCueReadLeaseRuntimeAssets === 'function', 'ERR_CUE_READ_LEASE_RUNTIME', 'The trusted CUE runtime registry reader is unavailable.');
    const trusted = await backendJob.readCueReadLeaseRuntimeAssets(root), pin = trusted?.cueReadLeaseManifest;
    assert(samePath(trusted?.root, root) && pin?.relativePath === MANIFEST && typeof pin.sha256 === 'string' && HEX.test(pin.sha256),
      'ERR_CUE_READ_LEASE_RUNTIME', 'The CUE holder lacks an independently trusted source pin.');
    const directory = path.join(root, ...DIRECTORY.split('/')); await ancestors(directory);
    const names = (await fs.readdir(directory)).sort(), allowed = [...FILES, 'runtime-manifest.json'].sort();
    assert(names.length === allowed.length && names.every((name, index) => name === allowed[index]), 'ERR_CUE_READ_LEASE_RUNTIME', 'The CUE runtime inventory is not closed.');
    const manifestFile = await regularBytes(path.join(directory, 'runtime-manifest.json'), 16384), manifestHash = digest(manifestFile.bytes);
    assert(manifestHash === pin.sha256 && (!expected || expected.manifestHash === manifestHash), 'ERR_CUE_READ_LEASE_RUNTIME', 'The CUE manifest differs from its source pin.');
    // Parse only after the independent enclosing pin has matched raw bytes.
    const manifest = JSON.parse(manifestFile.bytes.toString('utf8'));
    assert(exact(manifest, ['schemaVersion', 'kind', 'architecture', 'files']) && manifest.schemaVersion === 1 &&
      manifest.kind === 'still-cue-read-lease' && manifest.architecture === 'x64' && Array.isArray(manifest.files) && manifest.files.length === FILES.length,
    'ERR_CUE_READ_LEASE_RUNTIME', 'The CUE runtime manifest schema is invalid.');
    const seen = new Set(), witnesses = {[MANIFEST]: `${manifestFile.identity}:${manifestHash}`};
    for (const row of manifest.files) {
      assert(exact(row, ['path', 'bytes', 'sha256']) && FILES.includes(row.path) && !seen.has(row.path) &&
        Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= (row.path.endsWith('.exe') ? 2 * 1024 * 1024 : 16384) && HEX.test(row.sha256),
      'ERR_CUE_READ_LEASE_RUNTIME', 'A CUE runtime manifest entry is invalid.'); seen.add(row.path);
      const file = await regularBytes(path.join(directory, row.path), row.path.endsWith('.exe') ? 2 * 1024 * 1024 : 16384), hash = digest(file.bytes);
      assert(file.bytes.length === row.bytes && hash === row.sha256, 'ERR_CUE_READ_LEASE_RUNTIME', 'A pinned CUE runtime file changed.');
      if (row.path.endsWith('.exe')) {
        const pe = file.bytes.length >= 64 ? file.bytes.readUInt32LE(0x3c) : 0;
        assert(pe >= 64 && pe <= file.bytes.length - 26 && file.bytes[0] === 77 && file.bytes[1] === 90 &&
          file.bytes.readUInt32LE(pe) === 0x4550 && file.bytes.readUInt16LE(pe + 4) === 0x8664 && file.bytes.readUInt16LE(pe + 24) === 0x20b,
        'ERR_CUE_READ_LEASE_RUNTIME', 'The pinned CUE holder is not the required x64 executable.');
      }
      witnesses[`${DIRECTORY}/${row.path}`] = `${file.identity}:${hash}`;
    }
    assert(!expected || JSON.stringify(witnesses) === JSON.stringify(expected.witnesses), 'ERR_CUE_READ_LEASE_RUNTIME', 'The CUE runtime identity changed.');
    return {directory, executable: path.join(directory, FILES[0]), manifestHash, witnesses};
  } catch {throw failure('ERR_CUE_READ_LEASE_RUNTIME', 'The fixed CUE read-lease runtime could not be verified.');}
}
function deferred() {
  let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); promise.catch(() => {}); return {promise, resolve, reject};
}
function deadline(promise, ms, error) {
  return new Promise((resolve, reject) => {const timer = setTimeout(() => reject(error), ms); promise.then(value => {clearTimeout(timer); resolve(value);}, cause => {clearTimeout(timer); reject(cause);});});
}
function number(value, max) {assert(/^(?:0|[1-9]\d*)$/u.test(value) && value.length <= 16 && BigInt(value) <= BigInt(max), 'ERR_CUE_READ_LEASE_PROTOCOL', 'Invalid holder metadata number.'); return Number(value);}

async function verifyProtectedCue(request, rootIdentity, expectations) {
  const reader = createMediaFileReader(), content = await reader.read(request.path, {maxBytes: LIMITS.cueBytes});
  try {
    const decoded = decodeCue(content.bytes), parsed = parseCue(decoded.text);
    assert(digest(content.bytes) === request.contentHash && decoded.encoding === request.encoding && parsed.trackCount === request.trackCount,
      'ERR_CUE_READ_LEASE_REQUEST', 'The locked CUE differs from its complete preflight.');
    const prefix = foldPath(request.authorizationRoot.replace(/\\$/u, '')) + '\\', seen = new Set(), actual = [], ids = [];
    for (const name of parsed.references) {
      assert(!name.includes(':') || /^[A-Za-z]:\\/u.test(name), 'ERR_CUE_READ_LEASE_REQUEST', 'Drive-relative CUE references are unsupported.');
      const resolved = canonical(path.win32.resolve(path.win32.dirname(request.path), name));
      assert(foldPath(resolved).startsWith(prefix) && statIdentity(await fs.lstat(resolved.slice(0, request.authorizationRoot.length), {bigint: true}), true) === rootIdentity,
        'ERR_CUE_READ_LEASE_REQUEST', 'A CUE reference escaped the actual authorized root.');
      const witness = await reader.inspect(resolved), identity = statIdentity(witness.stat);
      assert(expectations.slice(1).includes(identity), 'ERR_CUE_READ_LEASE_REQUEST', 'A real CUE reference was not held by the native lease.');
      // Deduplicate actual file objects, never Unicode-folded names. This also
      // catches distinct NTFS names merged by an earlier parser's lowercasing.
      if (!seen.has(identity)) {seen.add(identity); actual.push(resolved); ids.push(identity);}
    }
    assert(actual.length === request.references.length && actual.every((name, index) => name === request.references[index] && ids[index] === expectations[index + 1]),
      'ERR_CUE_READ_LEASE_REQUEST', 'The complete locked CUE reference order differs from preflight.');
  } finally {content.bytes.fill(0);}
}

function bindHolder(raw, input) {
  const {nonce, binding, request, expectations, runtime, runtimeRoot, onLost} = input;
  const ready = deferred(), physical = deferred();
  const state = {raw, ready, physical, live: true, acquired: false, valid: true, closing: false, closed: false,
    readyProof: null, closedProof: null, closeSequence: null, sequence: 0, reply: null, checkPromise: null,
    closingCheck: null, closingChannelFault: false,
    heartbeat: null, lost: null, notified: false, buffer: '', stderrBytes: 0, bucketAt: Date.now(), bucketBytes: 0, bucketMessages: 0};
  retained.add(state);
  function markLost(error = lostError()) {
    if (!state.lost) state.lost = error;
    state.valid = false; clearInterval(state.heartbeat); state.heartbeat = null; ready.reject(state.lost); state.reply?.reject(state.lost);
    if (state.acquired && !state.notified && !state.closing) {
      state.notified = true;
      try {const result = onLost(state.lost); if (result?.then) Promise.resolve(result).catch(() => {});} catch { /* Observation never owns the handles. */ }
    }
  }
  function channelFault(error = protocolError()) {
    // A prior loss can still be cleaned up normally. New close-phase channel
    // faults are sticky, even if a later parser catch empties the line buffer.
    if (state.closing) state.closingChannelFault = true;
    markLost(error);
  }
  function identities(rows) {
    assert(rows.length === expectations.length, 'ERR_CUE_READ_LEASE_PROTOCOL', 'Holder file count changed.');
    return rows.map((row, index) => {
      assert(/^[a-f0-9]{8}:[a-f0-9]{16}:(?:0|[1-9]\d{0,15}):[a-f0-9]{16}:[a-f0-9]{16}:[a-f0-9]{8}:1$/u.test(row),
        'ERR_CUE_READ_LEASE_PROTOCOL', 'Holder file identity is malformed.');
      const fields = row.split(':');
      assert(fields.slice(0, 3).join(':') === expectations[index] && (Number.parseInt(fields[5], 16) & UNSAFE_ATTRIBUTES) === 0 &&
        (index !== 0 || number(fields[2], LIMITS.cueBytes) > 0), 'ERR_CUE_READ_LEASE_PROTOCOL', 'Holder identities differ from preflight.');
      return row;
    });
  }
  function line(value) {
    assert(!state.closedProof, 'ERR_CUE_READ_LEASE_PROTOCOL', 'The holder emitted data after its close proof.');
    const fields = value.split('\t');
    assert(fields[1] === nonce && fields[2] === binding, 'ERR_CUE_READ_LEASE_PROTOCOL', 'Holder generation differs.');
    if (fields[0] === 'READY1') {
      assert(!state.readyProof && fields.length === 10 + expectations.length && number(fields[3], 0xffffffff) === raw.pid &&
        number(fields[4], 0xffffffff) === process.pid && /^[a-f0-9]{16}$/u.test(fields[5]) && /^[a-f0-9]{16}$/u.test(fields[6]) &&
        BigInt(`0x${fields[5]}`) > 0n && BigInt(`0x${fields[5]}`) < BigInt(`0x${fields[6]}`) &&
        number(fields[7], 33) === expectations.length && number(fields[8], LIMITS.directories) > 0 && fields[9] === request.contentHash,
      'ERR_CUE_READ_LEASE_PROTOCOL', 'Holder readiness proof is invalid.');
      state.readyProof = Object.freeze({files: expectations.length, directories: Number(fields[8]), identities: Object.freeze(identities(fields.slice(10)))});
      ready.resolve(); return;
    }
    if (fields[0] === 'CHECKED1') {
      const expected = state.reply || state.closingCheck;
      assert(expected && state.readyProof && fields.length === 5 + expectations.length &&
        number(fields[3], 0xffffffff) === expected.sequence && fields[4] === request.contentHash &&
        JSON.stringify(identities(fields.slice(5))) === JSON.stringify(state.readyProof.identities),
      'ERR_CUE_READ_LEASE_PROTOCOL', 'Holder check proof is invalid.');
      const reply = state.reply; state.reply = null; state.closingCheck = null; reply?.resolve(); return;
    }
    if (fields[0] === 'CLOSED1') {
      assert(state.closing && !state.closingCheck && state.readyProof && fields.length === 6 && number(fields[3], 0xffffffff) === state.closeSequence &&
        number(fields[4], LIMITS.directories + 33) === state.readyProof.files + state.readyProof.directories && fields[5] === '0',
      'ERR_CUE_READ_LEASE_PROTOCOL', 'Holder close proof is invalid.');
      state.closedProof = true; return;
    }
    assert(fields[0] === 'ERROR1' && fields.length === 4 && ['INPUT', 'PATH', 'SHARING', 'IDENTITY', 'HASH', 'IO', 'PROTOCOL', 'CLOSE', 'EOF', 'PARENT'].includes(fields[3]),
      'ERR_CUE_READ_LEASE_PROTOCOL', 'Unknown holder output.');
    channelFault(lostError());
  }
  function write(value) {
    assert(raw.stdin && !raw.stdin.destroyed && !raw.stdin.writableEnded, 'ERR_CUE_READ_LEASE_LOST', 'Holder input closed.');
    raw.stdin.write(value, error => {if (error) channelFault(lostError());});
  }
  function assertLive() {if (!state.valid || !state.live || state.closing || state.closed) throw state.lost || lostError();}
  state.check = () => {
    if (state.checkPromise) return state.checkPromise;
    const task = (async () => {
      assertLive(); await verifyRuntime(runtimeRoot, runtime); assertLive();
      const reply = {...deferred(), sequence: ++state.sequence}; state.reply = reply;
      write(`CHECK1\t${nonce}\t${reply.sequence}\n`);
      await deadline(reply.promise, LIMITS.checkMs, failure('ERR_CUE_READ_LEASE_TIMEOUT', 'The holder did not verify its read lease in time.'));
      await verifyRuntime(runtimeRoot, runtime); assertLive();
    })().catch(() => {if (!state.closing) markLost(lostError()); throw state.lost || lostError();}).finally(() => {if (state.checkPromise === task) state.checkPromise = null;});
    task.catch(() => {}); state.checkPromise = task; return task;
  };
  state.close = async () => {
    if (!state.closing) {
      state.closing = true; state.valid = false; clearInterval(state.heartbeat); state.heartbeat = null;
      state.closingCheck = state.reply ? {sequence: state.reply.sequence} : null;
      state.reply?.reject(closeError()); state.reply = null; state.closeSequence = ++state.sequence;
      if (!state.closed) {
        try {write(`CLOSE1\t${nonce}\t${state.closeSequence}\n`); raw.stdin.end();} catch {state.closingChannelFault = true;}
      }
    }
    let exited;
    try {exited = await deadline(physical.promise, LIMITS.closeMs, closeError());}
    catch {const error = closeError(); error.cleanupPending = !state.closed; throw error;}
    if (!state.closedProof || state.closingChannelFault || state.buffer !== '' || exited.code !== 0 || exited.signal !== null) {
      const error = closeError(); error.cleanupPending = false; throw error;
    }
  };
  raw.stdout?.on('data', bytes => {
    try {
      assert(Buffer.isBuffer(bytes), 'ERR_CUE_READ_LEASE_PROTOCOL', 'Holder output must be bytes.');
      const now = Date.now(); if (now - state.bucketAt >= 1000) {state.bucketAt = now; state.bucketBytes = 0; state.bucketMessages = 0;}
      state.bucketBytes += bytes.length;
      assert(state.bucketBytes <= LIMITS.bytesPerSecond && bytes.every(byte => byte === 9 || byte === 10 || byte === 13 || byte >= 32 && byte < 127),
        'ERR_CUE_READ_LEASE_PROTOCOL', 'Holder output exceeded its bounded ASCII channel.');
      state.buffer += bytes.toString('ascii'); let at;
      while ((at = state.buffer.indexOf('\n')) >= 0) {
        assert(at <= LIMITS.lineBytes && ++state.bucketMessages <= LIMITS.messagesPerSecond, 'ERR_CUE_READ_LEASE_PROTOCOL', 'Holder output exceeded its frame limit.');
        const frame = state.buffer.slice(0, at).replace(/\r$/u, ''); state.buffer = state.buffer.slice(at + 1); line(frame);
      }
      assert(state.buffer.length <= LIMITS.lineBytes, 'ERR_CUE_READ_LEASE_PROTOCOL', 'Holder output frame is too large.');
    } catch {state.buffer = ''; channelFault(protocolError());}
  });
  raw.stderr?.on('data', bytes => {state.stderrBytes = Math.min(LIMITS.stderrBytes + 1, state.stderrBytes + bytes.length); channelFault(protocolError());});
  raw.stdout?.on('error', () => channelFault(lostError()));
  raw.stderr?.on('error', () => channelFault(lostError()));
  raw.stdin?.on('error', () => channelFault(lostError()));
  raw.on('error', () => channelFault(unavailable()));
  raw.on('exit', () => {state.live = false; if (!state.closing) markLost(lostError());});
  raw.on('close', (code, signal) => {
    state.live = false; state.closed = true; retained.delete(state); clearInterval(state.heartbeat); state.heartbeat = null;
    state.removeSignal?.();
    if (!state.closing) markLost(lostError()); ready.reject(state.lost || lostError()); state.reply?.reject(state.lost || lostError());
    physical.resolve({code, signal: signal ?? null});
  });
  state.markLost = markLost; state.write = write;
  return state;
}

async function createCueReadLease(options) {
  assert(exact(options, ['runtimeRoot', 'request'], ['signal', 'onLost']), 'ERR_CUE_READ_LEASE_REQUEST', 'Invalid read-lease options.');
  const request = snapshotRequest(options.request), onLost = options.onLost === undefined ? (() => {}) : options.onLost, signal = options.signal;
  assert(typeof onLost === 'function' && (signal === undefined || signal && typeof signal.aborted === 'boolean' &&
    typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function'), 'ERR_CUE_READ_LEASE_REQUEST', 'Invalid lease observer or acquisition signal.');
  assert(typeof options.runtimeRoot === 'string' && path.isAbsolute(options.runtimeRoot) && options.runtimeRoot === path.normalize(options.runtimeRoot),
    'ERR_CUE_READ_LEASE_REQUEST', 'The CUE runtime root must be canonical and absolute.');
  if (signal?.aborted) throw cancelled();
  if (process.platform !== 'win32' || process.arch !== 'x64') throw unavailable();
  const runtimeRoot = path.resolve(options.runtimeRoot), runtime = await verifyRuntime(runtimeRoot);
  if (signal?.aborted) throw cancelled();
  let rootIdentity; const expectations = [];
  try {
    rootIdentity = statIdentity(await fs.lstat(request.authorizationRoot, {bigint: true}), true);
    for (const name of [request.path, ...request.references]) {
      // Case-sensitive directories can share an ASCII-folded spelling. Check
      // the actual root object before even capturing a candidate file ID.
      const candidateRoot = name.slice(0, request.authorizationRoot.length);
      assert(statIdentity(await fs.lstat(candidateRoot, {bigint: true}), true) === rootIdentity,
        'ERR_CUE_READ_LEASE_REQUEST', 'A source root spelling identifies another directory.');
      expectations.push(statIdentity(await fs.lstat(name, {bigint: true})));
    }
  } catch {throw failure('ERR_CUE_READ_LEASE_REQUEST', 'The authorized read-lease identities could not be captured.');}
  const b64 = value => Buffer.from(value, 'utf8').toString('base64');
  const tokens = [request.contentHash, request.encoding, String(request.trackCount), String(request.references.length), b64(request.authorizationRoot), rootIdentity,
    b64(request.path), expectations[0]];
  request.references.forEach((name, index) => tokens.push(b64(name), expectations[index + 1]));
  const nonce = crypto.randomBytes(32).toString('hex'), binding = digest(Buffer.from(tokens.join('\t'))), wire = ['ACQUIRE1', nonce, binding, ...tokens].join('\t') + '\n';
  assert(Buffer.byteLength(wire) <= LIMITS.inputBytes, 'ERR_CUE_READ_LEASE_REQUEST', 'CUE lease request exceeds its bounded channel.');
  await verifyRuntime(runtimeRoot, runtime); if (signal?.aborted) throw cancelled();
  let state;
  try {
    const raw = childProcess.spawn(runtime.executable, ['--stdio-read-lease-v1', '--parent-pid', String(process.pid)], {cwd: runtime.directory, windowsHide: true, detached: false, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'], env: {SystemRoot: process.env.SystemRoot || process.env.WINDIR, WINDIR: process.env.WINDIR || process.env.SystemRoot}});
    state = bindHolder(raw, {nonce, binding, request, expectations, runtime, runtimeRoot, onLost});
    assert(Number.isInteger(raw.pid) && raw.pid > 0 && raw.stdout?.on && raw.stderr?.on && raw.stdin?.write,
      'ERR_CUE_READ_LEASE_UNAVAILABLE', 'The holder channel was not created.');
    // After acquisition, cancellation invalidates verification and reports the
    // loss but never releases handles. Only the caller's post-tree-exit close
    // owns that release. Acquisition failure may clean up immediately.
    const abort = () => state.markLost(cancelled());
    state.removeSignal = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, {once: true});
    try {
      if (signal?.aborted) throw cancelled(); state.write(wire);
      await deadline(state.ready.promise, LIMITS.startupMs, failure('ERR_CUE_READ_LEASE_TIMEOUT', 'The holder did not acquire its read lease in time.'));
      if (!state.valid || !state.live || state.closed) throw state.lost || lostError();
      // Reparse only AFTER the real locks exist. A forged reference array
      // cannot admit a native consumer, and Node's CUE read shares the same
      // protected path/identity window instead of relying on post-read hashes.
      try {await verifyProtectedCue(request, rootIdentity, expectations);}
      catch {throw failure('ERR_CUE_READ_LEASE_REQUEST', 'The authorized CUE preflight could not be reverified.');}
      await verifyRuntime(runtimeRoot, runtime);
      if (signal?.aborted) throw cancelled();
      if (!state.valid || !state.live || state.closed || !state.readyProof) throw state.lost || lostError();
      state.acquired = true;
      const lease = Object.freeze({check: () => state.check(), close: () => state.close()});
      brands.set(lease, {state, fingerprint: fingerprint(request)});
      state.heartbeat = setInterval(() => {state.check().catch(() => {});}, LIMITS.heartbeatMs); state.heartbeat.unref?.();
      return lease;
    } finally {if (!state.acquired) state.removeSignal();}
  } catch (cause) {
    const error = ['ERR_CUE_READ_LEASE_CANCELLED', 'ERR_CUE_READ_LEASE_TIMEOUT', 'ERR_CUE_READ_LEASE_RUNTIME', 'ERR_CUE_READ_LEASE_PROTOCOL', 'ERR_CUE_READ_LEASE_LOST', 'ERR_CUE_READ_LEASE_REQUEST'].includes(cause?.code) ? cause : unavailable();
    if (state) {
      state.markLost(error); await state.close().catch(() => {});
      error.cleanupPending = !state.closed;
      if (!state.closed) error.retainedController = Object.freeze({close: () => state.close()});
    }
    throw error;
  }
}
function isVerifiedCueReadLease(lease, {request} = {}) {
  try {
    const proof = brands.get(lease), state = proof?.state;
    return Boolean(state && proof.fingerprint === fingerprint(snapshotRequest(request)) && state.acquired && state.valid && state.live &&
      !state.closing && !state.closed && state.raw.exitCode === null && state.raw.signalCode == null);
  } catch {return false;}
}

module.exports = {createCueReadLease, isVerifiedCueReadLease};
