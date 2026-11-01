'use strict';
const guard = require('./helpers/test-effect-guard.cjs');
const state = guard.installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function blocked(invoke, effect) {
  assert.throws(invoke, error => error.code === 'ERR_STILL_TEST_EFFECT' && error.effect === effect);
}

test('effect guard installs in a real Node test worker and is idempotent', () => {
  assert.equal(state.active, true);
  assert.equal(state.integrationEnabled, false);
  assert.strictEqual(guard.installTestEffectGuard(), state);
});

test('every integration requires both exact flags, allowlisted suite and matching entry file', () => {
  for (const [suite, filename] of Object.entries(guard.INTEGRATION_SUITES)) {
    const entryFile = path.join(__dirname, filename);
    const env = { STILL_TEST_INTEGRATION: '1', STILL_TEST_INTEGRATION_SUITE: suite };
    assert.equal(guard.integrationEnabledFor({ suite, entryFile, env }), true);
    for (const input of [
      { suite, entryFile, env: { STILL_TEST_INTEGRATION: '1' } },
      { suite, entryFile, env: { STILL_TEST_INTEGRATION_SUITE: suite } },
      { suite, entryFile, env: { ...env, STILL_TEST_INTEGRATION: 'true' } },
      { suite, entryFile, env: { ...env, STILL_TEST_INTEGRATION_SUITE: `${suite},other` } },
      { suite: 'unreviewed-suite', entryFile, env },
      { suite, entryFile: __filename, env },
      { suite, entryFile: path.join(__dirname, 'other', filename), env }
    ]) assert.equal(guard.integrationEnabledFor(input), false);
  }
  assert.equal(state.active, true, 'Flag validation never disables an installed guard');
});

test('real child entry points fail before launching even a Node CLI, compiler or native self-test', () => {
  const child = require('node:child_process');
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    blocked(() => child[name](process.execPath, ['--version']), `child_process.${name}`);
  }
  for (const target of ['where.exe', 'cl.exe', 'StillAppleHost.exe', 'StillSpectrumReader.exe']) {
    blocked(() => child.spawnSync(target, ['--protocol-self-test']), 'child_process.spawnSync');
  }
  blocked(() => new child.ChildProcess().spawn({ file: process.execPath, args: [] }), 'ChildProcess.spawn');
  blocked(() => new child.ChildProcess().kill(), 'ChildProcess.kill');
  blocked(() => process.kill(-1, 0), 'process.kill');
  blocked(() => require('node:cluster').fork(), 'cluster.fork');
});

test('TCP, TLS and pipe/loopback server entry points fail before binding or connecting', () => {
  const net = require('node:net');
  for (const host of ['127.0.0.1', '::1', 'example.invalid']) {
    for (const name of ['connect', 'createConnection']) blocked(() => net[name]({ host, port: 1 }), `net.${name}`);
    blocked(() => new net.Socket().connect({ host, port: 1 }), 'Socket.connect');
    blocked(() => new net.Server().listen({ host, port: 0 }), 'Server.listen');
  }
  blocked(() => net.connect('\\\\.\\pipe\\StillGuardNeverConnect'), 'net.connect');
  blocked(() => net.createServer(), 'net.createServer');
  const tls = require('node:tls');
  blocked(() => tls.connect({ host: '127.0.0.1', port: 1 }), 'tls.connect');
  blocked(() => tls.createServer(), 'tls.createServer');
});

test('HTTP, HTTPS, HTTP2 and UDP entry points fail before network access', () => {
  for (const protocol of ['http', 'https']) {
    const http = require(`node:${protocol}`);
    for (const name of ['get', 'request']) blocked(() => http[name](`${protocol}://127.0.0.1:1/`), `${protocol}.${name}`);
    blocked(() => http.createServer(), `${protocol}.createServer`);
    blocked(() => new http.Agent().createConnection({ host: '127.0.0.1', port: 1 }), `${protocol}.Agent.createConnection`);
  }
  blocked(() => new (require('node:http').ClientRequest)('http://127.0.0.1:1/'), 'http.ClientRequest');
  const http2 = require('node:http2');
  for (const name of ['connect', 'createServer', 'createSecureServer']) blocked(() => http2[name]('https://127.0.0.1:1'), `http2.${name}`);
  const dgram = require('node:dgram');
  blocked(() => dgram.createSocket('udp4'), 'dgram.createSocket');
  for (const name of ['bind', 'connect', 'send']) blocked(() => dgram.Socket.prototype[name].call({}), `dgram.Socket.${name}`);
});

test('DNS callback, promise and resolver APIs fail before resolution', () => {
  const dns = require('node:dns');
  for (const target of [dns, dns.promises, new dns.Resolver(), new dns.promises.Resolver()]) {
    for (const name of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'reverse']) {
      if (typeof target[name] === 'function') blocked(() => target[name]('example.invalid'), `dns.${name}`);
    }
  }
});

test('global fetch and WebSocket fail before contacting loopback or remote endpoints', () => {
  for (const url of ['http://127.0.0.1:1/', 'http://[::1]:1/', 'https://example.invalid/']) {
    blocked(() => fetch(url), 'fetch');
  }
  if (typeof WebSocket === 'function') blocked(() => new WebSocket('ws://127.0.0.1:1/'), 'WebSocket');
  if (typeof EventSource === 'function') blocked(() => new EventSource('http://127.0.0.1:1/'), 'EventSource');
});

test('ESM builtin imports see the guarded functions too', async () => {
  const child = await import('node:child_process');
  const net = await import('node:net');
  const http = await import('node:http');
  blocked(() => child.spawn(process.execPath, ['--version']), 'child_process.spawn');
  blocked(() => net.connect({ host: '127.0.0.1', port: 1 }), 'net.connect');
  blocked(() => http.get('http://127.0.0.1:1/'), 'http.get');
});

test('injected transport and child fixtures remain callable under the guard', async () => {
  const calls = [];
  const fakeFetch = async url => { calls.push(['fetch', url]); return { ok: true, json: async () => ({ fixture: true }) }; };
  const fakeSpawn = (file, args) => { calls.push(['spawn', file, args]); return { fixture: true }; };
  assert.deepEqual(await (await fakeFetch('http://127.0.0.1:1/')).json(), { fixture: true });
  assert.deepEqual(fakeSpawn('fixture-helper.exe', ['--fixture']), { fixture: true });
  assert.equal(calls.length, 2);
});
