'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');

function windowsFixture({redirectRoot = false, symbolicRoot = false} = {}) {
  const shortParent = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp';
  const canonicalParent = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp';
  const root = path.win32.join(canonicalParent, 'still-canonical-di-AbCd12');
  const calls = [];
  const fileSystem = {
    realpathSync(target) {
      calls.push(['realpath', target]);
      if (target === shortParent) return canonicalParent;
      if (target === root) return redirectRoot ? path.win32.join(canonicalParent, 'pre-existing-target') : root;
      throw new Error('Unexpected realpath input');
    },
    lstatSync(target) {calls.push(['lstat', target]); return {isDirectory: () => true, isSymbolicLink: () => target === root && symbolicRoot};},
    mkdtempSync(prefix) {calls.push(['mkdtemp', prefix]); assert.equal(prefix, path.win32.join(canonicalParent, 'still-canonical-di-')); return root;}
  };
  return {shortParent, canonicalParent, root, calls, fileSystem};
}

test('Windows 8.3 temporary parent is resolved before creation and both cleanup anchors are canonical', () => {
  const f = windowsFixture();
  const created = createCanonicalTemp('still-canonical-di-', {parent: f.shortParent, fileSystem: f.fileSystem, pathImpl: path.win32});
  assert.deepEqual(created, {root: f.root, parent: f.canonicalParent});
  assert.ok(Object.isFrozen(created));
  assert.deepEqual(f.calls.filter(call => call[0] === 'mkdtemp'), [['mkdtemp', path.win32.join(f.canonicalParent, 'still-canonical-di-')]]);
  assert.equal(f.calls[0][0], 'realpath'); assert.equal(f.calls[0][1], f.shortParent);
  assert.throws(() => {created.root = 'C:\\Unowned';}, TypeError);
});

test('a newly created root that redirects is rejected instead of canonicalizing a tested rejection path', () => {
  for (const options of [{redirectRoot: true}, {symbolicRoot: true}]) {
    const f = windowsFixture(options);
    assert.throws(() => createCanonicalTemp('still-canonical-di-', {parent: f.shortParent, fileSystem: f.fileSystem, pathImpl: path.win32}), /redirected/);
  }
});

test('invalid fixture names reject before any filesystem access', () => {
  const unexpected = () => {throw new Error('No filesystem access should occur');};
  for (const prefix of ['', '..', '../outside', 'C:\\outside', 'two/names']) {
    assert.throws(() => createCanonicalTemp(prefix, {parent: 'C:\\Temp', pathImpl: path.win32,
      fileSystem: {realpathSync: unexpected}}), TypeError);
  }
});

test('a real new fixture uses its canonical parent without weakening application path checks', t => {
  const fixture = createCanonicalTemp('still-canonical-helper-');
  try {
    const resolveReal = fs.realpathSync.native || fs.realpathSync;
    const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    assert.equal(normalize(resolveReal(fixture.root)), normalize(fixture.root));
    assert.equal(normalize(path.dirname(fixture.root)), normalize(fixture.parent));
    t.diagnostic(JSON.stringify({temporaryInput: os.tmpdir(), canonicalParent: fixture.parent}));
  } finally {
    assert.equal(path.resolve(path.dirname(fixture.root)), path.resolve(fixture.parent));
    assert.ok(path.basename(fixture.root).startsWith('still-canonical-helper-'));
    assert.equal(fs.lstatSync(fixture.root).isSymbolicLink(), false);
    fs.rmSync(fixture.root, {recursive: true, force: false});
  }
});
