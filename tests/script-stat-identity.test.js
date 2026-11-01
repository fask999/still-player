'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const FIRST_ID = 2n ** 53n, FOREIGN_ID = FIRST_ID + 1n;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const project = path.resolve(__dirname, '..');

// All paths, descriptors, mutations and stats below live only in this map.
// The only real reads are the two production JavaScript sources under review.
function memoryFileSystem({numberProvider = false} = {}) {
  const entries = new Map(), descriptors = new Map(), calls = [], destructive = [];
  let nextId = 20n, nextDescriptor = 1, afterRead = null;
  const key = filename => path.resolve(filename);
  const absent = filename => Object.assign(new Error(`SYNTHETIC ENOENT: ${filename}`), {code: 'ENOENT'});
  function get(filename) {const entry = entries.get(key(filename)); if (!entry) throw absent(filename); return entry;}
  function parents(filename) {
    for (let cursor = path.dirname(key(filename)); ; cursor = path.dirname(cursor)) {
      if (!entries.has(cursor)) entries.set(cursor, {kind: 'directory', bytes: Buffer.alloc(0), dev: 3n, ino: nextId++});
      if (path.dirname(cursor) === cursor) break;
    }
  }
  function put(filename, bytes, {ino = nextId++, dev = 3n, kind = 'file'} = {}) {
    parents(filename); const entry = {kind, bytes: Buffer.from(bytes), dev, ino}; entries.set(key(filename), entry); return entry;
  }
  function stat(entry, options) {
    const suppliedAsNumber = typeof numberProvider === 'function' ? numberProvider(entry) : numberProvider;
    const raw = options?.bigint === true && !suppliedAsNumber, convert = value => raw ? value : Number(value);
    return {dev: convert(entry.dev), ino: convert(entry.ino), nlink: convert(entry.nlink ?? 1n), size: convert(BigInt(entry.bytes.length)),
      mtimeMs: convert(entry.mtimeMs ?? 5n), ctimeMs: convert(entry.ctimeMs ?? 5n),
      ...(raw ? {mtimeNs: entry.mtimeNs ?? (entry.mtimeMs ?? 5n) * 1000000n, ctimeNs: entry.ctimeNs ?? (entry.ctimeMs ?? 5n) * 1000000n} : {}),
      isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'directory', isSymbolicLink: () => false};
  }
  function namedStat(method, filename, options) {calls.push({method, filename: key(filename), bigint: options?.bigint === true}); return stat(get(filename), options);}
  const sync = {
    existsSync: filename => entries.has(key(filename)), realpathSync: filename => {get(filename); return key(filename);},
    lstatSync: (filename, options) => namedStat('lstatSync', filename, options),
    statSync: (filename, options) => namedStat('statSync', filename, options),
    openSync(filename, flags) {
      if (flags === 'wx') {if (entries.has(key(filename))) throw Object.assign(new Error('SYNTHETIC EEXIST'), {code: 'EEXIST'}); put(filename, '');}
      const descriptor = nextDescriptor++; descriptors.set(descriptor, {filename: key(filename), entry: get(filename)}); return descriptor;
    },
    fstatSync(descriptor, options) {
      const opened = descriptors.get(descriptor); assert.ok(opened, 'Only an open synthetic descriptor may be statted');
      calls.push({method: 'fstatSync', filename: opened.filename, bigint: options?.bigint === true}); return stat(opened.entry, options);
    },
    readFileSync(filename) {
      const descriptor = typeof filename === 'number' ? descriptors.get(filename) : null;
      const name = descriptor ? descriptor.filename : key(filename), entry = descriptor ? descriptor.entry : get(name), bytes = Buffer.from(entry.bytes);
      if (afterRead) afterRead(name, entry); return bytes;
    },
    closeSync: descriptor => {assert.equal(descriptors.delete(descriptor), true);},
    readdirSync(directory) {get(directory); return [...entries.keys()].filter(filename => path.dirname(filename) === key(directory)).map(filename => path.basename(filename));},
    unlinkSync(filename) {destructive.push({method: 'unlink', filename: key(filename), ino: get(filename).ino.toString()}); entries.delete(key(filename));},
    rmdirSync(filename) {
      assert.equal(sync.readdirSync(filename).length, 0, 'Synthetic rmdir never deletes nonempty directories');
      destructive.push({method: 'rmdir', filename: key(filename), ino: get(filename).ino.toString()}); entries.delete(key(filename));
    },
    renameSync(source, destination) {
      const entry = get(source); destructive.push({method: 'rename', filename: key(source), destination: key(destination), ino: entry.ino.toString()});
      entries.delete(key(source)); parents(destination); entries.set(key(destination), entry);
    }
  };
  const promises = {
    async open(filename, flags) {
      const descriptor = sync.openSync(filename, flags);
      return {fd: descriptor, async writeFile(bytes) {descriptors.get(descriptor).entry.bytes = Buffer.from(bytes);}, async sync() {}, async close() {sync.closeSync(descriptor);}};
    },
    async unlink(filename) {sync.unlinkSync(filename);}, async rmdir(filename) {sync.rmdirSync(filename);},
    async rename(source, destination) {sync.renameSync(source, destination);}
  };
  return {entries, descriptors, calls, destructive, sync, promises, put, get, key, afterRead: callback => {afterRead = callback;}};
}

function loadScript(relative, memory, {recoveryDelivery = false, writeJournal} = {}) {
  const filename = path.join(project, relative), source = fs.readFileSync(filename, 'utf8'), module = {exports: {}};
  function fixtureRequire(name) {
    if (name === 'node:fs') return memory.sync;
    if (name === 'node:fs/promises') return memory.promises;
    if (name === './backend-baselines') return {loadBackendBaselines: () => assert.fail('No real baseline provider is used by VM recovery'), selectBackendBaseline: () => assert.fail('No real baseline provider is used by VM recovery')};
    if (name === './spectrum-client-revision') return {verifySpectrumClientRevision: () => assert.fail('VM recovery supplies only synthetic delivery metadata')};
    return require(name);
  }
  const context = {require: fixtureRequire, module, exports: module.exports, __dirname: path.dirname(filename), Buffer, process,
    injectedDelivery: {manifestSha256: '284dae8ad48b96a464c635d8e848bc20d1699dfa74948987f8765d4ac94a131f'}, injectedWriteJournal: writeJournal};
  // Only this VM copy replaces unrelated delivery/journal dependencies. No
  // production verifier, pin, CLI mode or exported test override is changed.
  const inject = recoveryDelivery ? '\nverifySpectrumDelivery = () => injectedDelivery; writeJournal = injectedWriteJournal;' : '';
  vm.runInNewContext(source + inject, context, {filename}); return module.exports;
}

function regularFixture(options) {
  const memory = memoryFileSystem(options), root = path.resolve('virtual-stat-project'), filename = path.join(root, 'bytes.txt');
  memory.put(filename, 'UNCHANGED SYNTHETIC BYTES', {ino: FIRST_ID}); return {memory, root, filename};
}

for (const relative of ['scripts/backend-baselines.js', 'scripts/install-spectrum-component.js']) for (const drift of ['named inode', 'descriptor inode', 'named device']) {
  test(`exact stat: ${relative} rejects colliding ${drift} with unchanged bytes`, () => {
    const f = regularFixture(), target = f.memory.get(f.filename); if (drift === 'named device') target.dev = FIRST_ID;
    let replaced = false;
    f.memory.afterRead(name => {
      if (name !== f.filename || replaced) return; replaced = true;
      if (drift === 'descriptor inode') target.ino = FOREIGN_ID;
      else f.memory.put(f.filename, target.bytes, {ino: drift === 'named inode' ? FOREIGN_ID : target.ino, dev: drift === 'named device' ? FOREIGN_ID : target.dev});
    });
    const script = loadScript(relative, f.memory), read = script.readRegularBytes || script.regularBytes;
    assert.equal(Number(FIRST_ID), Number(FOREIGN_ID), 'The vectors must collide as Numbers');
    assert.throws(() => read(f.root, 'bytes.txt'), /changed|exact|bigint/i);
    assert.equal(replaced, true); assert.equal(f.memory.get(f.filename).bytes.toString(), 'UNCHANGED SYNTHETIC BYTES');
    assert.equal(f.memory.descriptors.size, 0);
  });
}

for (const relative of ['scripts/backend-baselines.js', 'scripts/install-spectrum-component.js']) {
  test(`exact stat: ${relative} explicitly requests raw BigInt snapshots and returns a Buffer DTO`, () => {
    const f = regularFixture(), script = loadScript(relative, f.memory), read = script.readRegularBytes || script.regularBytes;
    assert.equal(read(f.root, 'bytes.txt').toString(), 'UNCHANGED SYNTHETIC BYTES');
    const descriptors = f.memory.calls.filter(call => call.method === 'fstatSync');
    assert.ok(descriptors.length >= 2); assert.ok(descriptors.every(call => call.bigint));
    assert.ok(f.memory.calls.some(call => call.method === 'lstatSync' && call.filename === f.filename && call.bigint));
    assert.doesNotThrow(() => JSON.stringify({bytes: read(f.root, 'bytes.txt').length}));
  });
  test(`exact stat: ${relative} refuses an unsafe Number stat provider instead of converting rounded IDs`, () => {
    const f = regularFixture({numberProvider: true}), script = loadScript(relative, f.memory), read = script.readRegularBytes || script.regularBytes;
    assert.throws(() => read(f.root, 'bytes.txt'), /exact|bigint|unsafe/i);
    assert.equal(f.memory.destructive.length, 0); assert.equal(f.memory.descriptors.size, 0);
  });
  test(`exact stat: ${relative} does not silently accept even a safe Number-only provider`, () => {
    const f = regularFixture({numberProvider: true}); f.memory.get(f.filename).ino = 100n;
    const script = loadScript(relative, f.memory), read = script.readRegularBytes || script.regularBytes;
    assert.throws(() => read(f.root, 'bytes.txt'), /exact|bigint/i); assert.equal(f.memory.descriptors.size, 0);
  });
  for (const field of ['mtimeNs', 'ctimeNs', 'nlink', 'size']) {
    test(`exact stat: ${relative} retains before/after ${field} validation`, () => {
      const f = regularFixture();
      f.memory.afterRead((_name, entry) => {
        if (field === 'size') entry.bytes = Buffer.concat([entry.bytes, Buffer.from('DRIFT')]);
        else entry[field] = field === 'nlink' ? 2n : 5000001n;
      });
      const script = loadScript(relative, f.memory), read = script.readRegularBytes || script.regularBytes;
      assert.throws(() => read(f.root, 'bytes.txt'), /changed/i); assert.equal(f.memory.descriptors.size, 0);
    });
  }
}

function recoveryFixture({directory = false, numberDirectoryProvider = false} = {}) {
  const memory = memoryFileSystem({numberProvider: entry => numberDirectoryProvider && entry.kind === 'directory'});
  const sourceRoot = path.resolve('virtual-stat-recovery'), backendDir = path.join(sourceRoot, 'backend/foobar2000');
  const evidenceDir = path.join(sourceRoot, 'review-evidence/spectrum-package-stat-identity');
  const before = Buffer.from('SYNTHETIC BEFORE MANIFEST'), after = Buffer.from('SYNTHETIC AFTER MANIFEST'), config = Buffer.from('SYNTHETIC CONFIG');
  const transactionId = '11111111-2222-4333-8444-555555555555', manifest = path.join(backendDir, 'backend-manifest.json');
  const componentDirectory = path.join(backendDir, 'profile/user-components-x64/foo_still_spectrum');
  const temporaryPath = path.join(backendDir, `.spectrum-component-manifest-${transactionId}.json`), marker = path.join(backendDir, '.spectrum-component-install-incomplete.json');
  const plan = {schemaVersion: 1, operation: 'install-private-spectrum-component', dryRun: true, sourceRoot, backendDir, backendKind: 'source',
    backendId: transactionId, beforeManifestSha256: hash(before), afterManifestSha256: hash(after), oldFiles: [],
    configuration: {relativePath: 'profile/beefweb/config.json', bytes: config.length, sha256: hash(config)}, componentDirectoryExisted: false, componentFiles: [], afterManifest: {files: []}};
  const expectedPlanSha256 = hash(Buffer.from(JSON.stringify(plan)));
  const journal = {schemaVersion: 1, transactionId, planSha256: expectedPlanSha256, phase: 'completed', plan};
  memory.put(path.join(sourceRoot, 'package.json'), json({name: 'still-desktop', private: true}));
  memory.put(manifest, before, {ino: FIRST_ID});
  memory.put(path.join(backendDir, 'profile/beefweb/config.json'), config);
  memory.put(path.join(evidenceDir, 'transaction.json'), json(journal));
  memory.put(path.join(evidenceDir, 'before/backend-manifest.json'), before); memory.put(path.join(evidenceDir, 'after-backend-manifest.json'), after);
  memory.put(marker, json({schemaVersion: 1, transactionId, planSha256: expectedPlanSha256, evidenceDir}));
  if (directory) memory.put(componentDirectory, '', {kind: 'directory', ino: FIRST_ID});
  const script = loadScript('scripts/install-spectrum-component.js', memory, {recoveryDelivery: true,
    writeJournal: async (_directory, value) => {memory.put(path.join(evidenceDir, 'transaction.json'), json(value));}});
  const run = options => script.rollbackSpectrumInstall(evidenceDir, {sourceRoot, expectedPlanSha256, authorization: script.ROLLBACK_AUTHORIZATION,
    processInspector: async () => [], ...options});
  return {memory, script, run, componentDirectory, temporaryPath, marker, manifest, before, after, plan, journal};
}

test('exact stat: colliding foreign component directory cannot be removed during rollback', async t => {
  const f = recoveryFixture({directory: true}); let failure;
  try {await f.run({onPhase: async phase => {if (phase === 'manifest-restored') f.memory.put(f.componentDirectory, '', {kind: 'directory', ino: FOREIGN_ID});}});} catch (error) {failure = error;}
  t.diagnostic(JSON.stringify({failure: failure?.message || null, destructive: f.memory.destructive}));
  assert.equal(f.memory.entries.has(f.componentDirectory), true, 'The foreign same-name directory must remain');
  assert.match(failure?.message || '', /directory identity changed/);
  assert.equal(f.memory.destructive.some(call => call.method === 'rmdir'), false);
  assert.ok(f.memory.calls.some(call => call.filename === f.componentDirectory && call.method === 'lstatSync' && call.bigint));
});

test('exact stat: present refuses a Number directory witness before any rollback cleanup', async () => {
  const f = recoveryFixture({directory: true, numberDirectoryProvider: true});
  await assert.rejects(f.run(), /exact.*bigint/i); assert.equal(f.memory.destructive.length, 0);
  assert.ok(f.memory.calls.some(call => call.filename === f.componentDirectory && call.method === 'lstatSync' && call.bigint));
});

test('exact stat: stable raw BigInt directory witnesses preserve JSON-compatible rollback and journal contracts', async () => {
  const f = recoveryFixture({directory: true}), result = await f.run();
  assert.equal(result.rolledBack, true); assert.doesNotThrow(() => JSON.stringify(result));
  assert.doesNotThrow(() => JSON.stringify(f.plan)); assert.doesNotThrow(() => JSON.stringify(f.journal));
  assert.equal(f.memory.destructive.some(call => call.method === 'rmdir' && call.ino === FIRST_ID.toString()), true);
  assert.equal(typeof f.plan.configuration.bytes, 'number'); assert.equal(f.memory.descriptors.size, 0);
});

