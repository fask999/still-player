'use strict';

// Node v24's process-isolated test runner sets child-v8 in the worker only:
// https://github.com/nodejs/node/blob/v24.22.1/lib/internal/test_runner/runner.js#L483
// Install before importing application modules so their default dependencies
// capture these guards. This is an accidental-effect tripwire, not a sandbox.
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

const INTEGRATION_SUITES = Object.freeze({
  'apple-host-protocol': 'apple-official.test.js',
  'spectrum-reader-protocol': 'spectrum-reader.test.js',
  'spectrum-dsp-native': 'spectrum-dsp.test.js',
  'spectrum-pipe': 'spectrum-pipe.integration.test.js'
});
let installed;

function integrationEnabledFor({ suite, entryFile = process.argv[1], env = process.env } = {}) {
  return env.STILL_TEST_INTEGRATION === '1' &&
    Object.hasOwn(INTEGRATION_SUITES, suite) &&
    env.STILL_TEST_INTEGRATION_SUITE === suite &&
    path.resolve(entryFile || '') === path.resolve(__dirname, '..', INTEGRATION_SUITES[suite]);
}

function installTestEffectGuard({ suite } = {}) {
  // Do not patch the parent: node:test must spawn its own isolated workers.
  // NODE_TEST_WORKER_ID also identifies Node 24 --test-isolation=none execution.
  const worker = process.env.NODE_TEST_CONTEXT === 'child-v8' ||
    /^[1-9]\d*$/.test(process.env.NODE_TEST_WORKER_ID || '');
  if (!worker) return Object.freeze({ active: false, integrationEnabled: false });
  if (installed) return installed;
  const integrationEnabled = integrationEnabledFor({ suite });
  installed = Object.freeze({ active: !integrationEnabled, integrationEnabled });
  if (integrationEnabled) return installed;

  function block(target, name, effect) {
    if (!target || typeof target[name] !== 'function') return;
    target[name] = function guardedTestEffect() {
      const error = new Error(`Default tests forbid real ${effect}; inject a fixture or use an explicit integration suite`);
      error.code = 'ERR_STILL_TEST_EFFECT';
      error.effect = effect;
      throw error;
    };
  }
  const child = require('node:child_process');
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    block(child, name, `child_process.${name}`);
  }
  for (const name of ['spawn', 'kill']) block(child.ChildProcess.prototype, name, `ChildProcess.${name}`);
  block(process, 'kill', 'process.kill');
  block(require('node:cluster'), 'fork', 'cluster.fork');

  const net = require('node:net');
  for (const name of ['connect', 'createConnection', 'createServer']) block(net, name, `net.${name}`);
  block(net.Socket.prototype, 'connect', 'Socket.connect');
  block(net.Server.prototype, 'listen', 'Server.listen');
  const tls = require('node:tls');
  for (const name of ['connect', 'createServer']) block(tls, name, `tls.${name}`);
  for (const moduleName of ['http', 'https']) {
    const http = require(`node:${moduleName}`);
    for (const name of ['request', 'get', 'createServer']) block(http, name, `${moduleName}.${name}`);
    block(http.Agent.prototype, 'createConnection', `${moduleName}.Agent.createConnection`);
    block(http, 'ClientRequest', `${moduleName}.ClientRequest`);
  }
  const http2 = require('node:http2');
  for (const name of ['connect', 'createServer', 'createSecureServer']) block(http2, name, `http2.${name}`);
  const dgram = require('node:dgram');
  block(dgram, 'createSocket', 'dgram.createSocket');
  for (const name of ['bind', 'connect', 'send']) block(dgram.Socket.prototype, name, `dgram.Socket.${name}`);
  const dns = require('node:dns');
  for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const name of Object.getOwnPropertyNames(target)) {
      if (/^(?:lookup|resolve|reverse)/.test(name)) block(target, name, `dns.${name}`);
    }
  }
  for (const name of ['fetch', 'WebSocket', 'EventSource']) block(globalThis, name, name);
  syncBuiltinESMExports();
  return installed;
}

module.exports = { installTestEffectGuard, integrationEnabledFor, INTEGRATION_SUITES };
