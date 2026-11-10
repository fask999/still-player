'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const {createNativeMediaControls, verifyNativeMediaRuntime, validateSnapshot, validateArtwork, parseStrictJson,
  RUNTIME_DIRECTORY, MANIFEST_RELATIVE_PATH, RUNTIME_FILES, LIMITS} = require('../src/main/media-controls-native');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function snapshot(extra = {}) {
  return {schemaVersion: 1, sessionId: 'local-generation-1', sequence: 1, source: 'local', state: 'playing',
    metadata: {title: 'Track · 静室', artist: 'Artist', album: 'Album'}, position: 10, duration: 120,
    capabilities: {play: true, pause: true, stop: true, next: true, previous: true, seek: true}, ...extra};
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'still-desktop-media-test-')));
  t.after(() => {
    assert.equal(path.dirname(root).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('still-desktop-media-test-'));
    fs.rmSync(root, {recursive: true, force: true});
  });
  const directory = path.join(root, ...RUNTIME_DIRECTORY.split('/')); fs.mkdirSync(directory, {recursive: true});
  const files = RUNTIME_FILES.map(name => {
    const bytes = Buffer.from(name.endsWith('.exe') ? 'MZ SYNTHETIC NONEXECUTABLE FIXTURE; NEVER RUN' : `SYNTHETIC NOTICE ${name}`);
    fs.writeFileSync(path.join(directory, name), bytes); return {path: name, bytes: bytes.length, sha256: sha256(bytes)};
  });
  const manifest = {schemaVersion: 1, kind: 'still-desktop-media', architecture: 'x64', files};
  const writeManifest = () => fs.writeFileSync(path.join(directory, 'runtime-manifest.json'), JSON.stringify(manifest)); writeManifest();
  const expectedManifestSha256 = sha256(fs.readFileSync(path.join(directory, 'runtime-manifest.json')));
  return {root, directory, manifest, writeManifest, expectedManifestSha256};
}
function fakeChild() {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.messages = []; child.kills = 0; child.ends = 0; child.block = false;
  child.stdin.write = (line, callback) => {child.messages.push(JSON.parse(line)); callback?.(null); return !child.block;};
  child.stdin.end = () => {child.ends++;}; child.kill = () => {child.kills++; child.emit('exit', 0); return true;};
  child.reply = fields => {const generation = child.messages[0]?.generation; child.stdout.emit('data', Buffer.from(`${JSON.stringify({v: 1, generation, ...fields})}\n`));};
  child.ready = () => child.reply({type: 'ready', id: child.messages[0].id, backend: 'native-smtc', protocolTest: false});
  child.ack = message => child.reply({type: 'ack', id: message.id, sessionId: message.snapshot.sessionId, sequence: message.snapshot.sequence});
  return child;
}
function clientFixture(t, options = {}) {
  const f = fixture(t), child = fakeChild(), commands = [], statuses = [], calls = [];
  const client = createNativeMediaControls({runtimeRoot: f.root, expectedManifestSha256: f.expectedManifestSha256, platform: 'win32', architecture: 'x64', onCommand: command => commands.push(command),
    onStatus: status => statuses.push(status), spawnProcess: (...args) => {calls.push(args); return child;}, ...options});
  t.after(async () => {const promise = client.dispose(); child.emit('exit', 0); await promise;});
  return {...f, client, child, commands, statuses, calls};
}
async function ready(f) {const pending = f.client.start(); f.child.ready(); await pending;}
const command = (f, extra = {}) => f.child.reply({type: 'command', action: 'pause', sessionId: 'local-generation-1', sequence: 1, ...extra});
function png(width = 1, height = 1) {
  const bytes = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return {mimeType: 'image/png', dataBase64: bytes.toString('base64')};
}

test('snapshot validation clones truthful source, capabilities and timeline', () => {
  const input = snapshot(), output = validateSnapshot(input); input.metadata.title = 'changed'; input.capabilities.pause = false;
  assert.equal(output.metadata.title, 'Track · 静室'); assert.equal(output.capabilities.pause, true);
  const apple = snapshot({source: 'apple', state: 'paused', capabilities: {play: true, pause: false, stop: false, next: false, previous: false, seek: false}});
  assert.deepEqual(validateSnapshot(apple).capabilities, apple.capabilities);
  const unavailable = snapshot({source: null, state: 'unavailable', position: 0, duration: 0, capabilities: Object.fromEntries(Object.keys(input.capabilities).map(action => [action, false]))});
  assert.equal(validateSnapshot(unavailable).source, null);
});

test('snapshot rejects unknown fields, fabricated capabilities, invalid numbers, tokens and metadata', () => {
  const invalid = [snapshot({extra: true}), snapshot({schemaVersion: 2}), snapshot({source: null}), snapshot({source: 'web'}), snapshot({state: 'buffering'}),
    snapshot({position: 121}), snapshot({duration: Infinity}), snapshot({sequence: 1.1}), snapshot({sequence: Number.MAX_SAFE_INTEGER + 1}),
    snapshot({sessionId: '../track'}), snapshot({sessionId: ''}), snapshot({metadata: {title: '\ud800', artist: '', album: ''}}),
    snapshot({metadata: {title: '', artist: '', album: '', url: 'https://example.com'}}),
    snapshot({state: 'unavailable'}), snapshot({capabilities: {play: true}}), snapshot({capabilities: {...snapshot().capabilities, next: 1}}),
    snapshot({duration: 0, position: 0}), snapshot({metadata: {title: '\r', artist: '', album: ''}})];
  for (const value of invalid) assert.throws(() => validateSnapshot(value), TypeError);
  const accessor = snapshot(); Object.defineProperty(accessor, 'source', {get: () => {throw new Error('must not invoke getter');}}); assert.throws(() => validateSnapshot(accessor), TypeError);
  const symbol = snapshot(); symbol[Symbol('unknown')] = true; assert.throws(() => validateSnapshot(symbol), TypeError);
});

test('artwork is bounded canonical PNG/JPEG bytes with bounded dimensions, never a URL or file path', () => {
  assert.deepEqual(validateArtwork(png()), png());
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 8, 8, 0, 1, 0, 1, 1, 255, 217]);
  assert.deepEqual(validateArtwork({mimeType: 'image/jpeg', dataBase64: jpeg.toString('base64')}), {mimeType: 'image/jpeg', dataBase64: jpeg.toString('base64')});
  for (const value of [png(4097), png(0), {...png(), path: 'C:\\cover.png'}, {mimeType: 'image/png', dataBase64: 'https://example.com/cover'},
    {mimeType: 'image/svg+xml', dataBase64: 'PHN2Zz4='}, {mimeType: 'image/jpeg', dataBase64: png().dataBase64},
    {mimeType: 'image/png', dataBase64: `${png().dataBase64}\n`}, {mimeType: 'image/png', dataBase64: Buffer.alloc(LIMITS.artworkBytes + 1).toString('base64')}]) assert.throws(() => validateArtwork(value), TypeError);
});

test('strict JSON rejects duplicate and escaped duplicate keys, broken UTF-8, surrogates, arrays and trailing values', () => {
  assert.equal(parseStrictJson(Buffer.from('{"title":"静室","n":1.5e2,"b":true,"z":null}')).n, 150);
  for (const value of ['{"v":1,"v":2}', '{"v":1,"\\u0076":2}', '{"a":[1]}', '{"a":01}', '{"a":1e999}', '{"a":NaN}', '{"a":"\\ud800"}', '{}{}', '{"a":false,}', '{"a":"\\x20"}']) assert.throws(() => parseStrictJson(Buffer.from(value)), TypeError);
  assert.throws(() => parseStrictJson(Buffer.from([123, 34, 97, 34, 58, 34, 255, 34, 125])), TypeError);
  assert.throws(() => parseStrictJson(Buffer.alloc(8193)), TypeError);
  const pollution = parseStrictJson(Buffer.from('{"__proto__":{"polluted":true}}')); assert.equal(Object.getPrototypeOf(pollution), null); assert.equal({}.polluted, undefined);
});

test('runtime integrity verifies exactly three runtime files plus their manifest', t => {
  const f = fixture(t), result = verifyNativeMediaRuntime(f.root);
  assert.equal(result.executable, path.join(f.directory, 'StillMediaControls.exe')); assert.equal(result.manifestRelativePath, MANIFEST_RELATIVE_PATH);
  assert.deepEqual(Object.keys(result.hashes).sort(), [MANIFEST_RELATIVE_PATH, ...RUNTIME_FILES.map(name => `${RUNTIME_DIRECTORY}/${name}`)].sort());
  fs.writeFileSync(path.join(f.directory, 'StillMediaControls.exe'), 'MZ changed'); assert.throws(() => verifyNativeMediaRuntime(f.root));
});

test('runtime rejects extra files, duplicate entries, traversal, wrong architecture and wrong manifest fields', t => {
  const f = fixture(t), extra = path.join(f.directory, 'injected.dll'); fs.writeFileSync(extra, 'SYNTHETIC'); assert.throws(() => verifyNativeMediaRuntime(f.root)); fs.unlinkSync(extra);
  f.manifest.files[1] = {...f.manifest.files[0]}; f.writeManifest(); assert.throws(() => verifyNativeMediaRuntime(f.root));
  f.manifest.files[1].path = '../StillMediaControls.exe'; f.writeManifest(); assert.throws(() => verifyNativeMediaRuntime(f.root));
  f.manifest.architecture = 'arm64'; f.writeManifest(); assert.throws(() => verifyNativeMediaRuntime(f.root));
  f.manifest.architecture = 'x64'; f.manifest.url = 'https://example.com'; f.writeManifest(); assert.throws(() => verifyNativeMediaRuntime(f.root));
});

test('runtime rejects symlink/reparse directories before spawn', t => {
  const f = fixture(t), directory = path.join(f.root, 'linked'); fs.symlinkSync(f.directory, directory, process.platform === 'win32' ? 'junction' : 'dir');
  const root = path.join(f.root, 'other'); fs.mkdirSync(path.join(root, 'native', 'desktop-media'), {recursive: true});
  fs.symlinkSync(directory, path.join(root, ...RUNTIME_DIRECTORY.split('/')), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyNativeMediaRuntime(root), TypeError);
});

test('start verifies hashes and Windows x64 before any process launch', async t => {
  const f = clientFixture(t); fs.writeFileSync(path.join(f.directory, 'StillMediaControls.exe'), 'MZ wrong');
  const status = await f.client.start(); assert.equal(status.reason, 'runtime-integrity'); assert.equal(f.calls.length, 0);
  const unsupported = createNativeMediaControls({runtimeRoot: f.root, expectedManifestSha256: f.expectedManifestSha256, platform: 'linux', spawnProcess: () => {throw new Error('must not launch');}});
  assert.equal((await unsupported.start()).reason, 'unsupported-platform'); await unsupported.dispose();
});

test('start is idempotent, keeps its own parent PID and generation, and queues only the latest pre-start snapshot', async t => {
  const f = clientFixture(t); await f.client.update(snapshot()); await f.client.update(snapshot({sequence: 2, position: 11}));
  const first = f.client.start(), second = f.client.start(); assert.equal(first, second); assert.equal(f.calls.length, 1);
  const [exe, args, options] = f.calls[0]; assert.equal(exe, path.join(f.directory, 'StillMediaControls.exe')); assert.deepEqual(args.slice(0, 4), ['--stdio', '--parent-pid', String(process.pid), '--generation']);
  assert.match(args[4], /^[a-f0-9]{32}$/); assert.equal(options.windowsHide, true); assert.deepEqual(Object.keys(options.env).sort(), ['SystemRoot', 'WINDIR']);
  f.child.ready(); assert.equal((await first).available, true); assert.equal(f.child.messages[1].snapshot.sequence, 2);
  f.child.ack(f.child.messages[1]); await f.client.start(); assert.equal(f.calls.length, 1);
});

test('production start requires a trusted lowercase SHA-256 manifest pin before spawn', async t => {
  for (const pin of [undefined, null, '', 'F'.repeat(64), 'f'.repeat(63), 'f'.repeat(64), 123]) {
    const f = clientFixture(t, {expectedManifestSha256: pin}); assert.equal((await f.client.start()).reason, 'runtime-integrity'); assert.equal(f.calls.length, 0);
  }
});

test('co-tampering executable and its local manifest cannot replace the trusted pin', async t => {
  const f = clientFixture(t), exe = path.join(f.directory, 'StillMediaControls.exe'), bytes = Buffer.from('MZ SYNTHETIC TAMPERED HELPER; NEVER RUN');
  fs.writeFileSync(exe, bytes); const entry = f.manifest.files.find(file => file.path === 'StillMediaControls.exe'); entry.bytes = bytes.length; entry.sha256 = sha256(bytes); f.writeManifest();
  assert.ok(verifyNativeMediaRuntime(f.root), 'un-pinned packaging discovery is deliberately not runtime authorization');
  assert.throws(() => verifyNativeMediaRuntime(f.root, {expectedManifestSha256: f.expectedManifestSha256}), /manifest pin/);
  assert.equal((await f.client.start()).reason, 'runtime-integrity'); assert.equal(f.calls.length, 0);
});

test('trusted pin is checked before parsing or trusting local manifest entries', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.directory, 'runtime-manifest.json'), '{"files": MALFORMED UNTRUSTED JSON');
  assert.throws(() => verifyNativeMediaRuntime(f.root, {expectedManifestSha256: f.expectedManifestSha256}), /manifest pin/);
});

test('only current-session supported commands from already-sent snapshots reach the coordinator', async t => {
  const f = clientFixture(t); await f.client.update(snapshot()); await ready(f); f.child.ack(f.child.messages[1]); command(f);
  assert.deepEqual(f.commands, [{action: 'pause', sessionId: 'local-generation-1', sequence: 1}]);
  command(f, {sessionId: 'other-source'}); command(f, {sequence: 2}); command(f, {action: 'seek', position: 121}); assert.equal(f.commands.length, 1);
  await f.client.update(snapshot({sequence: 2, position: 11})); command(f); assert.equal(f.commands.length, 2, 'older progress sequence in the same session remains an intent');
  await f.client.update(snapshot({sessionId: 'apple-generation-2', sequence: 3, source: 'apple', state: 'paused', capabilities: {play: true, pause: false, stop: false, next: false, previous: false, seek: false}}));
  command(f); command(f, {sessionId: 'apple-generation-2', sequence: 3}); assert.equal(f.commands.length, 2, 'old source and unsupported Apple pause cannot gain capability');
});

test('current capabilities revoke previously enabled commands before the helper ack arrives', async t => {
  const f = clientFixture(t); await f.client.update(snapshot()); await ready(f); f.child.ack(f.child.messages[1]);
  await f.client.update(snapshot({sequence: 2, capabilities: {...snapshot().capabilities, pause: false, seek: false}}));
  command(f); command(f, {action: 'seek', position: 50}); assert.equal(f.commands.length, 0);
});

test('backpressure bounds updates to one in-flight message plus one coalesced latest snapshot', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});
  const f = clientFixture(t); f.child.block = true; const pending = f.client.start(); f.child.ready(); await pending;
  for (let i = 1; i <= 200; i++) await f.client.update(snapshot({sequence: i}));
  assert.equal(f.child.messages.length, 1); f.child.block = false; f.child.stdin.emit('drain');
  assert.equal(f.child.messages.length, 2); assert.equal(f.child.messages[1].snapshot.sequence, 200);
  await f.client.update(snapshot({sequence: 201})); await f.client.update(snapshot({sequence: 202})); assert.equal(f.child.messages.length, 2);
  f.child.ack(f.child.messages[1]); t.mock.timers.tick(LIMITS.snapshotIntervalMs); assert.equal(f.child.messages.length, 3); assert.equal(f.child.messages[2].snapshot.sequence, 202);
});

test('snapshots with stale sequence reject without changing the current transport state', async t => {
  const f = clientFixture(t); await f.client.update(snapshot()); await assert.rejects(f.client.update(snapshot()), /sequence/); await assert.rejects(f.client.update(snapshot({sequence: 0})), /sequence/);
  assert.equal(f.client.getStatus().state, 'idle'); assert.equal(f.calls.length, 0);
});

test('helper output is strict, generation-bound and never echoes exception paths into status', async t => {
  const f = clientFixture(t); await ready(f);
  f.child.reply({generation: 'f'.repeat(32), type: 'command', action: 'play', sessionId: 'local-generation-1', sequence: 1, error: 'C:\\private\\account.txt'});
  assert.equal(f.client.getStatus().reason, 'invalid-helper-output'); assert.equal(f.commands.length, 0); assert.equal(f.child.ends, 1);
  assert.ok(!JSON.stringify(f.statuses).includes('private')); assert.ok(!JSON.stringify(f.statuses).includes(f.root));
});

test('production client rejects a protocol-test helper ready response', async t => {
  const f = clientFixture(t); const pending = f.client.start(); f.child.reply({type: 'ready', id: 1, backend: 'native-smtc', protocolTest: true});
  assert.equal((await pending).reason, 'invalid-helper-output');
});

test('unexpected response IDs, duplicate fields and unexpected command fields fail closed', async t => {
  for (const kind of ['id', 'duplicate', 'field']) {
    const f = clientFixture(t); await f.client.update(snapshot()); await ready(f);
    if (kind === 'id') f.child.reply({type: 'ack', id: 99, sessionId: 'local-generation-1', sequence: 1});
    if (kind === 'duplicate') f.child.stdout.emit('data', Buffer.from(`{"v":1,"v":2,"generation":"${f.child.messages[0].generation}","type":"pong","id":1}\n`));
    if (kind === 'field') command(f, {url: 'https://example.com'});
    assert.equal(f.client.getStatus().reason, 'invalid-helper-output');
  }
});

test('output line length, total byte rate, message rate and stderr total are bounded', async t => {
  for (const kind of ['line', 'bytes', 'messages', 'stderr']) {
    const f = clientFixture(t); await ready(f);
    if (kind === 'line') f.child.stdout.emit('data', Buffer.alloc(LIMITS.outputLineBytes + 1, 32));
    if (kind === 'bytes') f.child.stdout.emit('data', Buffer.alloc(LIMITS.outputBytesPerSecond + 1, 32));
    if (kind === 'messages') {await f.client.update(snapshot()); for (let i = 0; i < LIMITS.outputMessagesPerSecond; i++) command(f);}
    if (kind === 'stderr') f.child.stderr.emit('data', Buffer.alloc(LIMITS.stderrBytes + 1));
    assert.equal(f.client.getStatus().available, false); assert.ok(['invalid-helper-output', 'helper-stderr-limit'].includes(f.client.getStatus().reason));
  }
});

test('partial UTF-8 chunks are assembled; EOF on a partial message fails closed', async t => {
  const f = clientFixture(t); const pending = f.client.start();
  const line = Buffer.from(JSON.stringify({v: 1, generation: f.child.messages[0].generation, type: 'ready', id: 1, backend: 'native-smtc', protocolTest: false}) + '\n');
  f.child.stdout.emit('data', line.subarray(0, 11)); f.child.stdout.emit('data', line.subarray(11)); assert.equal((await pending).available, true);
  f.child.stdout.emit('data', Buffer.from('{"')); f.child.stdout.emit('end'); assert.equal(f.client.getStatus().reason, 'truncated-helper-output');
});

test('startup and request timeouts end stdin and kill only their own child', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});
  const f = clientFixture(t), pending = f.client.start(); t.mock.timers.tick(LIMITS.startupMs);
  assert.equal((await pending).reason, 'startup-timeout'); assert.equal(f.child.ends, 1); t.mock.timers.tick(LIMITS.shutdownMs); assert.equal(f.child.kills, 1);
  const g = clientFixture(t); await g.client.update(snapshot()); await ready(g); t.mock.timers.tick(LIMITS.requestMs);
  assert.equal(g.client.getStatus().reason, 'request-timeout');
});

test('heartbeat has the same request deadline and a bounded request slot', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});
  const f = clientFixture(t); await ready(f); t.mock.timers.tick(LIMITS.heartbeatMs);
  assert.equal(f.child.messages.at(-1).type, 'ping'); const ping = f.child.messages.at(-1); f.child.reply({type: 'pong', id: ping.id});
  assert.equal(f.client.getStatus().available, true); t.mock.timers.tick(LIMITS.heartbeatMs); t.mock.timers.tick(LIMITS.requestMs);
  assert.equal(f.client.getStatus().reason, 'request-timeout');
});

test('dispose during startup resolves start, ignores delayed replies and permanently prevents restart', async t => {
  const f = clientFixture(t), pending = f.client.start(), closing = f.client.dispose(); f.child.ready();
  assert.equal((await pending).state, 'disposed'); assert.equal((await f.client.start()).state, 'disposed'); assert.equal(f.calls.length, 1);
  f.child.emit('exit', 0); assert.equal((await closing).state, 'disposed'); assert.equal(f.client.dispose(), closing); assert.deepEqual(await f.client.update(snapshot()), {queued: false, disposed: true});
});

test('a synchronous status callback can dispose during start before spawn', async t => {
  const f = fixture(t); let client, launches = 0;
  client = createNativeMediaControls({runtimeRoot: f.root, expectedManifestSha256: f.expectedManifestSha256, platform: 'win32', architecture: 'x64', spawnProcess: () => {launches++; return fakeChild();},
    onStatus: value => {if (value.state === 'starting') void client.dispose();}});
  assert.equal((await client.start()).state, 'disposed'); assert.equal(launches, 0); await client.dispose();
});

test('reentrant start from status callbacks shares the existing launch promise', async t => {
  const f = fixture(t), child = fakeChild(); let client, nested, launches = 0;
  client = createNativeMediaControls({runtimeRoot: f.root, expectedManifestSha256: f.expectedManifestSha256, platform: 'win32', architecture: 'x64', spawnProcess: () => {launches++; return child;},
    onStatus: value => {if (value.state === 'starting') nested = client.start();}});
  const first = client.start(); assert.equal(first, nested); assert.equal(launches, 1); child.ready(); await first;
  const closing = client.dispose(); child.emit('exit', 0); await closing;
});

test('dispose sends only controlled shutdown, invalidates late commands and does not reactivate after close', async t => {
  const f = clientFixture(t); await f.client.update(snapshot()); await ready(f); f.child.ack(f.child.messages[1]);
  const closing = f.client.dispose(); assert.equal(f.child.messages.at(-1).type, 'shutdown'); command(f); assert.equal(f.commands.length, 0);
  f.child.emit('close', 0); await closing; assert.equal((await f.client.start()).state, 'disposed');
});

test('dispose prepublishes one terminal promise before reentrant status callbacks', async t => {
  const f = fixture(t), child = fakeChild(); let client, nested, callbacks = 0;
  client = createNativeMediaControls({runtimeRoot: f.root, expectedManifestSha256: f.expectedManifestSha256, platform: 'win32', architecture: 'x64', spawnProcess: () => child,
    onStatus: value => {if (value.state === 'disposed') {callbacks++; nested = client.dispose();}}});
  const starting = client.start(); child.ready(); await starting;
  const closing = client.dispose(); assert.equal(nested, closing); assert.equal(callbacks, 1); assert.equal(child.ends, 1);
  child.emit('exit', 0); await closing; assert.equal(client.dispose(), closing); assert.equal(callbacks, 1);
});

test('process spawn errors close cleanly even when only close follows error', async t => {
  const f = clientFixture(t), pending = f.client.start(); f.child.emit('error', new Error('C:\\private\\missing.exe')); f.child.emit('close', -1);
  assert.equal((await pending).reason, 'helper-start-failed'); assert.equal(f.child.ends, 1); assert.ok(!JSON.stringify(f.statuses).includes('private'));
});

test('callback exceptions cannot escape, expose helper data or prevent disposal', async t => {
  const f = clientFixture(t, {onStatus: () => {throw new Error('SYNTHETIC callback');}, onCommand: async () => {throw new Error('SYNTHETIC adapter');}});
  await f.client.update(snapshot()); await ready(f); f.child.ack(f.child.messages[1]); assert.doesNotThrow(() => command(f)); await Promise.resolve();
  assert.equal(f.client.getStatus().available, true);
});
