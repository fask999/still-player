'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { INTEGRATION_SUITES } = require('./helpers/test-effect-guard.cjs');
const { parseArgs, createPlan, main, RUNNER_SUITES } = require('../scripts/run-integration');

test('integration CLI rejects unknown, duplicated, missing and arbitrary path/command arguments before any effects', async () => {
  const invalid = [[], ['--execute'], ['--suite'], ['--suite', 'unknown'], ['--suite', '../tests/apple-official.test.js'],
    ['--suite=apple-host-protocol'], ['--help'], ['--suite', '__proto__'], ['--suite', 'constructor'],
    ['--suite', 'apple-host-protocol', '--suite', 'spectrum-dsp-native'],
    ['--suite', 'apple-host-protocol', '--execute', '--execute'],
    ['--suite', 'apple-host-protocol', '--command', 'node'],
    ['--suite', 'apple-host-protocol', '--', 'tests/backend.test.js'],
    ['--suite', 'apple-host-protocol', 'extra'], ['--suite', 1]];
  for (const argv of invalid) {
    let spawned = 0, printed = 0;
    await assert.rejects(main(argv, { spawn() { spawned++; }, print() { printed++; } }), { code: 'STILL_INTEGRATION_ARGUMENTS' });
    assert.equal(spawned, 0); assert.equal(printed, 0);
  }
  assert.throws(() => parseArgs('invalid'), { code: 'STILL_INTEGRATION_ARGUMENTS' });
  assert.throws(() => createPlan({ suite: 'spectrum-pipe', execute: 'true' }), { code: 'STILL_INTEGRATION_ARGUMENTS' });
});

test('every suite defaults to a relative, sanitized plan with zero real or injected child calls', async () => {
  for (const [suite, filename] of Object.entries(RUNNER_SUITES)) {
    let spawned = 0;
    const output = [];
    const result = await main(['--suite', suite], {
      env: { FIXTURE_SECRET: 'do-not-print', STILL_TEST_INTEGRATION: '1' },
      spawn() { spawned++; throw new Error('No spawn in plan mode'); }, print: value => output.push(value)
    });
    assert.equal(spawned, 0); assert.equal(result.status, 'planned'); assert.equal(result.exitCode, 0);
    assert.equal(result.testFile, `tests/${filename}`); assert.equal(path.isAbsolute(result.testFile), false);
    assert.deepEqual(result.nodeArguments, ['--test', `tests/${filename}`]);
    assert.equal(output.length, 1); assert.equal(output[0].execute, false);
    assert.equal(JSON.stringify(output).includes('do-not-print'), false);
    assert.equal(JSON.stringify(output).includes(process.execPath), false);
    // Without a spawn injection, the worker guard still makes accidental spawn
    // an immediate failure; this default plan must also succeed.
    assert.equal((await main(['--suite', suite], { print() {} })).status, 'planned');
  }
});

test('execute launches only the current Node and one fixed suite with exact flags (injected child only)', async () => {
  for (const [suite, filename] of Object.entries(RUNNER_SUITES)) {
    const calls = [], prints = [];
    const environment = { FIXTURE_SECRET: 'never-print', STILL_TEST_INTEGRATION: 'old',
      STILL_TEST_INTEGRATION_SUITE: 'other', STILL_SPECTRUM_REAL_PIPE_FIXTURE: 'old' };
    const result = await main(['--execute', '--suite', suite], {
      env: environment, print: value => prints.push(value),
      spawn(file, args, options) {
        calls.push({ file, args, options });
        const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 0, null)); return child;
      }
    });
    assert.equal(calls.length, 1); assert.equal(calls[0].file, process.execPath);
    assert.deepEqual(calls[0].args, ['--test', `tests/${filename}`]);
    assert.equal(calls[0].options.cwd, path.resolve(__dirname, '..'));
    assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].options.stdio, 'inherit');
    assert.equal(calls[0].options.env.STILL_TEST_INTEGRATION, '1');
    assert.equal(calls[0].options.env.STILL_TEST_INTEGRATION_SUITE, suite);
    assert.equal(calls[0].options.env.STILL_SPECTRUM_REAL_PIPE_FIXTURE, suite === 'spectrum-pipe' ? '1' : undefined);
    assert.equal(calls[0].options.env.FIXTURE_SECRET, 'never-print');
    assert.equal(environment.STILL_TEST_INTEGRATION, 'old', 'Caller environment is not mutated');
    assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 0);
    assert.equal(JSON.stringify(prints).includes('never-print'), false);
    assert.equal(JSON.stringify(result).includes('never-print'), false);
  }
});

test('SDK source suite keeps the worker effect guard active even with both explicit audit flags (pure VM fixtures)', () => {
  const plan = createPlan({ suite: 'spectrum-sdk-source', execute: true });
  assert.equal(plan.testFile, 'tests/spectrum-component.test.js');
  assert.equal(Object.hasOwn(INTEGRATION_SUITES, plan.suite), false);
  const guardSource = fs.readFileSync(path.join(__dirname, 'helpers/test-effect-guard.cjs'), 'utf8');
  let effectCalls = 0;
  const effect = () => { effectCalls++; throw new Error('Unpatched fixture effect'); };
  const type = () => { class FixtureType {} FixtureType.prototype.connect = effect;
    FixtureType.prototype.listen = effect; FixtureType.prototype.spawn = effect;
    FixtureType.prototype.kill = effect; FixtureType.prototype.createConnection = effect; return FixtureType; };
  const modules = {
    'node:path': path, 'node:module': { syncBuiltinESMExports() {} },
    'node:child_process': { spawn: effect, spawnSync: effect, ChildProcess: type() },
    'node:cluster': { fork: effect }, 'node:net': { connect: effect, Socket: type(), Server: type() },
    'node:tls': { connect: effect }, 'node:http': { request: effect, Agent: type() },
    'node:https': { request: effect, Agent: type() }, 'node:http2': { connect: effect },
    'node:dgram': { createSocket: effect, Socket: type() },
    'node:dns': { resolve: effect, Resolver: type(), promises: { resolve: effect, Resolver: type() } }
  };
  const localModule = { exports: {} };
  const context = { module: localModule, __dirname: path.join(__dirname, 'helpers'), fetch: effect,
    process: { env: { ...plan.environment, NODE_TEST_CONTEXT: 'child-v8' },
      argv: [process.execPath, path.join(__dirname, 'spectrum-component.test.js')], kill: effect },
    require(name) { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; } };
  vm.runInNewContext(guardSource, context);
  const state = localModule.exports.installTestEffectGuard({ suite: plan.suite });
  assert.equal(state.active, true); assert.equal(state.integrationEnabled, false);
  for (const invoke of [() => modules['node:child_process'].spawn('fixture-compiler'),
    () => modules['node:net'].connect({ host: '127.0.0.1', port: 1 }), () => context.fetch('http://127.0.0.1:1/')]) {
    assert.throws(invoke, error => error.code === 'ERR_STILL_TEST_EFFECT');
  }
  assert.equal(effectCalls, 0, 'No actual child, network, or SDK audit is executed');
});

test('component defaults and incomplete SDK opt-ins run source fixtures without any vendor filesystem access', () => {
  const componentTestSource = fs.readFileSync(path.join(__dirname, 'spectrum-component.test.js'), 'utf8');
  const vendorRoot = path.resolve(__dirname, '../native/foobar-spectrum/vendor');
  for (const env of [{}, { STILL_TEST_INTEGRATION: '1' }, { STILL_TEST_INTEGRATION_SUITE: 'spectrum-sdk-source' },
    { STILL_TEST_INTEGRATION: '1', STILL_TEST_INTEGRATION_SUITE: 'spectrum-dsp-native' }]) {
    let vendorCalls = 0, passed = 0, skipped = 0;
    function assertNotVendor(file) {
      const resolved = path.resolve(file);
      if (resolved === vendorRoot || resolved.startsWith(`${vendorRoot}${path.sep}`)) {
        vendorCalls++;
        assert.fail('Default source fixtures cannot probe or read ignored vendor SDK files');
      }
    }
    const sourceFs = {
      readFileSync(file, ...options) { assertNotVendor(file); return fs.readFileSync(file, ...options); },
      existsSync(file) { assertNotVendor(file); return fs.existsSync(file); }
    };
    vm.runInNewContext(componentTestSource, { __dirname, process: { env }, require(name) {
      if (name === 'node:fs') return sourceFs;
      if (name === 'node:test') return (_name, options, callback) => {
        if (typeof options === 'function') callback = options;
        else if (options.skip) { skipped++; return; }
        callback(); passed++;
      };
      return require(name);
    } });
    assert.equal(vendorCalls, 0); assert.equal(skipped, 2);
    assert.equal(passed, 16, 'All remaining project/build/source assertions still execute');
  }
});

test('execute propagates bounded exit codes and sanitizes failed spawn/error/signal outcomes', async () => {
  for (const outcome of [{ code: 7, signal: null, expected: 7 }, { code: null, signal: 'SIGTERM', expected: 1 },
    { code: -1, signal: null, expected: 1 }, { code: 256, signal: null, expected: 1 }, { error: true, expected: 1 }, { throws: true, expected: 1 }]) {
    const result = await main(['--suite', 'apple-host-protocol', '--execute'], {
      print() {}, spawn() {
        if (outcome.throws) throw new Error('fixture-private-spawn-error');
        const child = new EventEmitter();
        queueMicrotask(() => outcome.error ? child.emit('error', new Error('fixture-private-error')) : child.emit('close', outcome.code, outcome.signal));
        return child;
      }
    });
    assert.equal(result.status, 'failed'); assert.equal(result.exitCode, outcome.expected);
    assert.equal(JSON.stringify(result).includes('fixture-private'), false);
  }
});

test('execution without an injected child cannot bypass the default worker guard', async () => {
  const result = await main(['--suite', 'spectrum-reader-protocol', '--execute'], { print() {} });
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 1);
});
