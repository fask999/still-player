'use strict';

// This transport reports observations and emits intents. It has no playback,
// network, URL, globalShortcut or audio-device dependency.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');

const RUNTIME_DIRECTORY = 'native/desktop-media/bin';
const MANIFEST_RELATIVE_PATH = `${RUNTIME_DIRECTORY}/runtime-manifest.json`;
const RUNTIME_FILES = Object.freeze(['StillMediaControls.exe', 'LICENSE.txt', 'NOTICE.txt']);
const ACTIONS = Object.freeze(['play', 'pause', 'stop', 'next', 'previous', 'seek']);
const LIMITS = Object.freeze({artworkBytes: 512 * 1024, artworkDimension: 4096, snapshotBytes: 720000,
  outputLineBytes: 8192, outputBytesPerSecond: 65536, outputMessagesPerSecond: 40, stderrBytes: 16384,
  startupMs: 5000, requestMs: 3500, heartbeatMs: 4000, shutdownMs: 600, snapshotIntervalMs: 80});
const utf8 = new TextDecoder('utf-8', {fatal: true});

function invalid(what) { throw new TypeError(`Invalid desktop media ${what}`); }
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('object');
  return value;
}
function keys(value, required, optional = []) {
  object(value);
  if (required.some(key => !Object.hasOwn(value, key)) || Reflect.ownKeys(value).some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key !== 'string' || !required.includes(key) && !optional.includes(key) || !Object.hasOwn(descriptor, 'value');
  })) invalid('fields');
}
function wellFormed(value) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const low = value.charCodeAt(++i); if (!(low >= 0xdc00 && low <= 0xdfff)) return false; }
    else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function text(value, max, token = false) {
  if (typeof value !== 'string' || value.length > max || !wellFormed(value) || /[\u0000-\u0008\u000b-\u001f]/.test(value) || (token && !/^[A-Za-z0-9_.-]+$/.test(value))) invalid('text');
  return value;
}
function number(value, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isSafeInteger(value))) invalid('number');
  return value;
}

// JSON.parse alone accepts duplicate keys and unpaired UTF-16 escapes. This
// bounded parser detects both before any protocol/manifest fields are trusted.
function parseStrictJson(bytes, {maxBytes = LIMITS.outputLineBytes, arrays = false} = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) invalid('JSON length');
  let source; try {source = utf8.decode(bytes);} catch {invalid('UTF-8');}
  let at = 0, nodes = 0;
  const stringPattern = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const white = () => {while (at < source.length && /[ \t\r\n]/.test(source[at])) at++;};
  function string() {
    stringPattern.lastIndex = at; const match = stringPattern.exec(source); if (!match) invalid('JSON string');
    at = stringPattern.lastIndex; const value = JSON.parse(match[0]); if (!wellFormed(value)) invalid('JSON string'); return value;
  }
  function value(depth) {
    if (++nodes > 128 || depth > 7) invalid('JSON complexity'); white();
    if (source[at] === '"') return string();
    if (source[at] === '{') {
      at++; white(); const result = Object.create(null);
      if (source[at] === '}') {at++; return result;}
      while (at < source.length) {
        white(); if (source[at] !== '"') invalid('JSON key'); const key = string(); white();
        if (source[at++] !== ':' || Object.hasOwn(result, key)) invalid('JSON duplicate or separator');
        result[key] = value(depth + 1); white(); const separator = source[at++];
        if (separator === '}') return result; if (separator !== ',') invalid('JSON object');
      }
      invalid('JSON object');
    }
    if (arrays && source[at] === '[') {
      at++; white(); const result = []; if (source[at] === ']') {at++; return result;}
      while (at < source.length) {result.push(value(depth + 1)); white(); const separator = source[at++]; if (separator === ']') return result; if (separator !== ',') invalid('JSON array');}
      invalid('JSON array');
    }
    for (const [token, literal] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(token, at)) {at += token.length; return literal;}
    }
    numberPattern.lastIndex = at; const match = numberPattern.exec(source); if (!match) invalid('JSON value'); at = numberPattern.lastIndex;
    const result = Number(match[0]); if (!Number.isFinite(result)) invalid('JSON number'); return result;
  }
  const result = value(0); white(); if (at !== source.length) invalid('JSON trailing data'); return object(result);
}

function validateArtwork(value) {
  keys(value, ['mimeType', 'dataBase64']);
  if (!['image/png', 'image/jpeg'].includes(value.mimeType) || typeof value.dataBase64 !== 'string' || value.dataBase64.length > 699052 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.dataBase64)) invalid('artwork');
  const bytes = Buffer.from(value.dataBase64, 'base64');
  if (!bytes.length || bytes.length > LIMITS.artworkBytes || bytes.toString('base64') !== value.dataBase64) invalid('artwork bytes');
  let width = 0, height = 0;
  if (value.mimeType === 'image/png') {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid('PNG header');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) invalid('JPEG header');
    let at = 2;
    while (at + 3 < bytes.length) {
      if (bytes[at++] !== 255) invalid('JPEG marker'); while (bytes[at] === 255) at++;
      if (at >= bytes.length) invalid('JPEG marker'); const marker = bytes[at++];
      if ([217, 218].includes(marker)) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (at + 1 >= bytes.length) invalid('JPEG segment'); const length = bytes.readUInt16BE(at);
      if (length < 2 || at + length > bytes.length) invalid('JPEG segment');
      if ((marker >= 192 && marker <= 195) || (marker >= 197 && marker <= 199) || (marker >= 201 && marker <= 203) || (marker >= 205 && marker <= 207)) {
        if (length < 8) invalid('JPEG dimensions'); height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); break;
      }
      at += length;
    }
  }
  if (width < 1 || height < 1 || width > LIMITS.artworkDimension || height > LIMITS.artworkDimension) invalid('artwork dimensions');
  return {mimeType: value.mimeType, dataBase64: value.dataBase64};
}

function validateSnapshot(value) {
  keys(value, ['schemaVersion', 'sessionId', 'sequence', 'source', 'state', 'metadata', 'position', 'duration', 'capabilities']);
  if (value.schemaVersion !== 1 || ![null, 'local', 'apple'].includes(value.source) || !['playing', 'paused', 'stopped', 'unavailable'].includes(value.state)) invalid('snapshot');
  if (['playing', 'paused'].includes(value.state) && value.source === null) invalid('source state');
  const sessionId = text(value.sessionId, 128, true), sequence = number(value.sequence, Number.MAX_SAFE_INTEGER, true);
  const position = number(value.position, 31536000), duration = number(value.duration, 31536000); if (position > duration) invalid('timeline');
  keys(value.metadata, ['title', 'artist', 'album'], ['artwork']); keys(value.capabilities, ACTIONS);
  const metadata = {title: text(value.metadata.title, 1024), artist: text(value.metadata.artist, 1024), album: text(value.metadata.album, 1024)};
  if (value.metadata.artwork != null) metadata.artwork = validateArtwork(value.metadata.artwork);
  const capabilities = {};
  for (const action of ACTIONS) {
    const enabled = value.capabilities[action]; if (typeof enabled !== 'boolean' || (enabled && (value.source === null || value.state === 'unavailable'))) invalid('capability'); capabilities[action] = enabled;
  }
  if (capabilities.seek && duration <= 0) invalid('seek duration');
  return {schemaVersion: 1, sessionId, sequence, source: value.source, state: value.state, metadata, position, duration, capabilities};
}

function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
function readRegular(filename, maxBytes) {
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes || !samePath(fs.realpathSync(filename), path.resolve(filename))) invalid('runtime file');
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor); if (!stat.isFile() || stat.size !== before.size || stat.ino !== before.ino) invalid('runtime identity');
    const bytes = fs.readFileSync(descriptor); const after = fs.fstatSync(descriptor);
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) invalid('runtime changed');
    return bytes;
  } finally {fs.closeSync(descriptor);}
}
function verifyNativeMediaRuntime(runtimeRoot, {expectedManifestSha256} = {}) {
  if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot)) invalid('runtime root');
  const root = path.resolve(runtimeRoot), directory = path.join(root, ...RUNTIME_DIRECTORY.split('/'));
  if (!samePath(fs.realpathSync(root), root) || !samePath(fs.realpathSync(directory), directory)) invalid('runtime directory');
  const entries = fs.readdirSync(directory).sort(), expected = [...RUNTIME_FILES, 'runtime-manifest.json'].sort();
  if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) invalid('runtime inventory');
  const manifestBytes = readRegular(path.join(root, ...MANIFEST_RELATIVE_PATH.split('/')), 8192);
  const manifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  // Packaging can discover hashes without a pin. Production start must supply
  // the trusted enclosing runtime-registry pin, before this manifest is parsed.
  if (expectedManifestSha256 !== undefined && (typeof expectedManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedManifestSha256) || manifestSha256 !== expectedManifestSha256)) invalid('runtime manifest pin');
  const manifest = parseStrictJson(manifestBytes, {maxBytes: 8192, arrays: true}); keys(manifest, ['schemaVersion', 'kind', 'architecture', 'files']);
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'still-desktop-media' || manifest.architecture !== 'x64' || !Array.isArray(manifest.files) || manifest.files.length !== RUNTIME_FILES.length) invalid('runtime manifest');
  const hashes = {[MANIFEST_RELATIVE_PATH]: manifestSha256}, found = new Set();
  for (const entry of manifest.files) {
    keys(entry, ['path', 'bytes', 'sha256']);
    if (!RUNTIME_FILES.includes(entry.path) || found.has(entry.path) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) invalid('runtime entry'); found.add(entry.path);
    number(entry.bytes, entry.path.endsWith('.exe') ? 2 * 1024 * 1024 : 16384, true);
    const bytes = readRegular(path.join(directory, entry.path), entry.path.endsWith('.exe') ? 2 * 1024 * 1024 : 16384);
    if (bytes.length !== entry.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256 || (entry.path.endsWith('.exe') && (bytes.length < 2 || bytes[0] !== 77 || bytes[1] !== 90))) invalid('runtime hash');
    hashes[`${RUNTIME_DIRECTORY}/${entry.path}`] = entry.sha256;
  }
  return {executable: path.join(directory, 'StillMediaControls.exe'), directory, manifestRelativePath: MANIFEST_RELATIVE_PATH, hashes};
}

function createNativeMediaControls({runtimeRoot, expectedManifestSha256, onCommand = () => {}, onStatus = () => {},
  spawnProcess = spawn, platform = process.platform, architecture = process.arch} = {}) {
  if (typeof onCommand !== 'function' || typeof onStatus !== 'function' || typeof spawnProcess !== 'function') invalid('callbacks');
  let disposed = false, active = null, startPromise = null, disposal = null, latest = null;
  let status = {available: false, state: 'idle', backend: 'native-smtc', verified: false, reason: null};
  const getStatus = () => ({...status});
  function publish(next) {status = {...status, ...next}; try {onStatus(getStatus());} catch { /* A callback cannot break process cleanup. */ }}
  function clear(run) {for (const timer of ['requestTimer', 'heartbeatTimer', 'pumpTimer']) {clearTimeout(run[timer]); run[timer] = null;}}
  function settleStart(run) {if (run.resolveStart) {run.resolveStart(getStatus()); run.resolveStart = null;}}
  function end(run) {
    if (run.closing) return; run.closing = true; clear(run); run.pending = null; settleStart(run);
    try {run.child?.stdin.end();} catch { /* EOF is best effort before the bounded kill. */ }
    run.killTimer = setTimeout(() => {try {run.child?.kill();} catch { /* Exit status remains observable. */ }}, LIMITS.shutdownMs); run.killTimer.unref?.();
  }
  function fail(run, reason) {
    if (active !== run || run.closing) return;
    publish({available: false, state: disposed ? 'disposed' : 'unavailable', reason}); end(run);
  }
  function request(run, type, extra = {}) {
    if (active !== run || run.closing || run.pending || run.backpressure) return false;
    const id = ++run.id; const message = {v: 1, type, id, generation: run.generation, ...extra};
    const line = `${JSON.stringify(message)}\n`; if (Buffer.byteLength(line) > LIMITS.snapshotBytes) {fail(run, 'snapshot-too-large'); return false;}
    run.pending = {id, type, snapshot: extra.snapshot};
    run.requestTimer = setTimeout(() => fail(run, type === 'hello' ? 'startup-timeout' : 'request-timeout'), type === 'hello' ? LIMITS.startupMs : LIMITS.requestMs); run.requestTimer.unref?.();
    try {
      run.backpressure = !run.child.stdin.write(line, error => {if (error) fail(run, 'stdin-failed');});
    } catch {fail(run, 'stdin-failed'); return false;}
    return true;
  }
  function pump(run) {
    if (active !== run || run.closing || !run.ready || run.pending || run.backpressure || !latest || run.sentSequence === latest.sequence) return;
    const wait = Math.max(0, run.lastUpdateAt + LIMITS.snapshotIntervalMs - Date.now());
    if (wait > 0) {if (!run.pumpTimer) run.pumpTimer = setTimeout(() => {run.pumpTimer = null; pump(run);}, wait); return;}
    const snapshot = latest;
    if (request(run, 'update', {snapshot})) {run.sentSequence = snapshot.sequence; run.lastUpdateAt = Date.now();}
  }
  function receive(run, message) {
    object(message);
    if (message.v !== 1 || message.generation !== run.generation || typeof message.type !== 'string') invalid('helper envelope');
    if (message.type === 'command') {
      keys(message, ['v', 'generation', 'type', 'action', 'sessionId', 'sequence'], ['position']);
      if (!ACTIONS.includes(message.action)) invalid('helper action'); text(message.sessionId, 128, true); number(message.sequence, Number.MAX_SAFE_INTEGER, true);
      if (message.action === 'seek') number(message.position, 31536000); else if (Object.hasOwn(message, 'position')) invalid('helper position');
      if (!run.ready || !latest || latest.sessionId !== message.sessionId || message.sequence > run.sentSequence || message.sequence > latest.sequence || message.sequence < run.sessionFloor || !latest.capabilities[message.action] || (message.action === 'seek' && message.position > latest.duration)) return;
      // Commands preserve the applied snapshot token. The coordinator checks
      // current source/generation again when it atomically dispatches the intent.
      const command = {action: message.action, sessionId: message.sessionId, sequence: message.sequence}; if (message.action === 'seek') command.position = message.position;
      try {Promise.resolve(onCommand(command)).catch(() => {});} catch { /* Adapter errors belong to the coordinator. */ }
      return;
    }
    if (message.type === 'error') {keys(message, ['v', 'generation', 'type', 'code']); if (message.code !== 'invalid-message') invalid('helper error'); fail(run, 'helper-rejected'); return;}
    const pending = run.pending;
    if (!pending || message.id !== pending.id) invalid('helper response');
    if (message.type === 'ready') {
      keys(message, ['v', 'generation', 'type', 'id', 'backend', 'protocolTest']);
      if (pending.type !== 'hello' || run.ready || message.backend !== 'native-smtc' || message.protocolTest !== false) invalid('helper ready');
      run.ready = true; publish({available: true, state: 'ready', reason: null});
    } else if (message.type === 'ack') {
      keys(message, ['v', 'generation', 'type', 'id', 'sessionId', 'sequence']);
      if (pending.type !== 'update' || message.sessionId !== pending.snapshot.sessionId || message.sequence !== pending.snapshot.sequence) invalid('helper ack');
    } else if (message.type === 'pong') {keys(message, ['v', 'generation', 'type', 'id']); if (pending.type !== 'ping') invalid('helper pong');}
    else invalid('helper message');
    clearTimeout(run.requestTimer); run.requestTimer = null; run.pending = null; run.lastReplyAt = Date.now(); settleStart(run); pump(run);
  }
  function read(run, bytes) {
    if (active !== run || run.closing) return;
    try {
      if (!Buffer.isBuffer(bytes)) invalid('helper bytes');
      const now = Date.now(); if (now - run.rateAt >= 1000) {run.rateAt = now; run.rateBytes = 0; run.rateLines = 0;}
      run.rateBytes += bytes.length; if (run.rateBytes > LIMITS.outputBytesPerSecond) invalid('helper byte rate');
      run.buffer = Buffer.concat([run.buffer, bytes]);
      let newline;
      while ((newline = run.buffer.indexOf(10)) >= 0) {
        if (newline > LIMITS.outputLineBytes || ++run.rateLines > LIMITS.outputMessagesPerSecond) invalid('helper line rate');
        const line = run.buffer.subarray(0, newline); run.buffer = run.buffer.subarray(newline + 1); receive(run, parseStrictJson(line));
        if (run.closing) return;
      }
      if (run.buffer.length > LIMITS.outputLineBytes) invalid('helper line length');
    } catch {fail(run, 'invalid-helper-output');}
  }
  function start() {
    if (disposed || active) return startPromise || Promise.resolve(getStatus());
    if (startPromise) return startPromise;
    let resolveStart;
    const promise = new Promise(resolve => {resolveStart = resolve;}); startPromise = promise;
    promise.then(() => {if (startPromise === promise) startPromise = null;});
    launch(resolveStart);
    return promise;
  }
  function launch(resolve) {
      if (platform !== 'win32' || architecture !== 'x64') {publish({available: false, state: 'unavailable', reason: 'unsupported-platform'}); resolve(getStatus()); return;}
      let runtime;
      try {
        if (typeof expectedManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedManifestSha256)) invalid('required runtime manifest pin');
        runtime = verifyNativeMediaRuntime(runtimeRoot, {expectedManifestSha256});
      } catch {publish({available: false, state: 'unavailable', verified: false, reason: 'runtime-integrity'}); resolve(getStatus()); return;}
      const run = {generation: crypto.randomBytes(16).toString('hex'), id: 0, ready: false, closing: false, child: null, pending: null, backpressure: false,
        sentSequence: -1, sessionFloor: latest?.sequence ?? 0, lastUpdateAt: -Infinity, lastReplyAt: Date.now(), buffer: Buffer.alloc(0), rateAt: Date.now(), rateBytes: 0, rateLines: 0, stderrBytes: 0, resolveStart: resolve};
      active = run;
      publish({available: false, state: 'starting', verified: true, reason: null});
      if (disposed || run.closing) {settleStart(run); clearTimeout(run.killTimer); active = null; return;}
      try {
        const windows = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
        run.child = spawnProcess(runtime.executable, ['--stdio', '--parent-pid', String(process.pid), '--generation', run.generation],
          {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: runtime.directory, env: {SystemRoot: windows, WINDIR: windows}});
        if (!run.child?.stdin || !run.child.stdout || !run.child.stderr) throw new Error('Missing pipes');
        run.exited = new Promise(resolveExit => {run.resolveExit = resolveExit;});
        run.child.once('error', () => fail(run, 'helper-start-failed'));
        const finished = () => {
          if (run.finished) return; run.finished = true;
          clear(run); clearTimeout(run.killTimer);
          if (active === run) {
            if (!run.closing) publish({available: false, state: disposed ? 'disposed' : 'unavailable', reason: 'helper-exited'});
            active = null;
          }
          run.closing = true; settleStart(run); run.resolveExit();
        };
        run.child.once('exit', finished); run.child.once('close', finished);
        run.child.stdin.on('error', () => fail(run, 'stdin-failed'));
        run.child.stdin.on('drain', () => {run.backpressure = false; pump(run);});
        run.child.stdout.on('data', bytes => read(run, bytes));
        run.child.stdout.once('end', () => {if (!run.closing) fail(run, run.buffer.length ? 'truncated-helper-output' : 'helper-eof');});
        run.child.stderr.on('data', bytes => {run.stderrBytes += Buffer.byteLength(bytes); if (run.stderrBytes > LIMITS.stderrBytes) fail(run, 'helper-stderr-limit');});
        run.heartbeatTimer = setInterval(() => {if (!run.pending && !run.backpressure && Date.now() - run.lastReplyAt >= LIMITS.heartbeatMs) request(run, 'ping');}, 500); run.heartbeatTimer.unref?.();
        request(run, 'hello');
      } catch {fail(run, 'helper-start-failed'); if (!run.child) {active = null; clearTimeout(run.killTimer);}}
  }
  function update(value) {
    if (disposed) return Promise.resolve({queued: false, disposed: true});
    let snapshot; try {snapshot = validateSnapshot(value); if (latest && snapshot.sequence <= latest.sequence) invalid('snapshot sequence');} catch (error) {return Promise.reject(error);}
    const changedSession = !latest || snapshot.sessionId !== latest.sessionId; latest = snapshot;
    if (active && changedSession) active.sessionFloor = snapshot.sequence;
    if (active) pump(active);
    return Promise.resolve({queued: true});
  }
  function dispose() {
    if (disposal) return disposal;
    let resolveDisposal;
    disposal = new Promise(resolve => {resolveDisposal = resolve;});
    disposed = true; latest = null;
    publish({available: false, state: 'disposed', reason: null});
    const run = active;
    if (run && !run.closing && run.ready && !run.backpressure) {
      // A shutdown follows any already-written update in the same bounded pipe.
      try {run.child.stdin.write(`${JSON.stringify({v: 1, type: 'shutdown', id: ++run.id, generation: run.generation})}\n`);} catch { /* EOF below also shuts the helper down. */ }
    }
    if (run) end(run);
    const finished = run?.exited ? Promise.race([run.exited, new Promise(resolve => {const timer = setTimeout(resolve, LIMITS.shutdownMs * 2); timer.unref?.();})]) : Promise.resolve();
    finished.then(() => resolveDisposal(getStatus()));
    return disposal;
  }
  return {start, update, dispose, getStatus};
}

module.exports = {createNativeMediaControls, verifyNativeMediaRuntime, validateSnapshot, validateArtwork, parseStrictJson,
  RUNTIME_DIRECTORY, MANIFEST_RELATIVE_PATH, RUNTIME_FILES, LIMITS};
