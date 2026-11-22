'use strict';

const {EventEmitter} = require('node:events');
const {PassThrough, Writable} = require('node:stream');
const assert = require('node:assert/strict');
const {createNativeOfficialHost, createOfficialAppleMusicService} = require('../../src/main/apple-official-web');

function syntheticOfficialAppleHost(t, options = {}) {
  let child;
  const wire = [];
  const methods = {play: true, pause: true, stop: true, setQueue: true};
  function finish(target, code) {
    assert.equal(target.exitCode, null);
    target.exitCode = code;
    target.stdout.end(); target.stderr.end(); target.emit('close', code);
  }
  const spawnImpl = () => {
    const target = new EventEmitter();
    child = target;
    const state = {authorized: true, isPlaying: false, playbackState: 0, position: 0, duration: 120, volume: 0.5};
    let outputMuted = true;
    target.stdout = new PassThrough(); target.stderr = new PassThrough(); target.exitCode = null;
    target.kill = () => assert.fail('The synthetic Apple helper should close without kill');
    const send = row => target.stdout.write(JSON.stringify(row) + '\n');
    target.stdin = new Writable({write(bytes, _encoding, done) {
      for (const line of String(bytes).trim().split('\n')) {
        const {method, rpcId, id} = JSON.parse(line);
        wire.push(method);
        let value = {};
        if (method === 'play') {
          outputMuted = false;
          Object.assign(state, {isPlaying: true, playbackState: 2, currentTrack: {id, type: 'songs', title: 'Synthetic Apple track'}});
        }
        if (method === 'stop') {
          outputMuted = true;
          Object.assign(state, {isPlaying: false, playbackState: 4});
        }
        if (method === 'probe') {
          if (state.isPlaying) state.position += 0.1;
          value = {methods, state, outputMuted};
        }
        if (method === 'close') value = {closed: true, browserProcessExited: true};
        send({type: 'response', rpcId, ok: true, value});
        if (method === 'close') finish(target, 0);
      }
      done();
    }});
    queueMicrotask(() => send({type: 'ready', origin: 'https://music.apple.com', runtime: 'synthetic-host'}));
    return target;
  };
  const host = createNativeOfficialHost({hostPath: __filename, profileDir: __dirname, spawnImpl, mkdirImpl: async () => {}});
  const service = createOfficialAppleMusicService({dataDir: __dirname, hostPath: __filename, hostFactory: () => host,
    runtimeDetector: async () => 'synthetic-host', verificationTimeout: 500, pollInterval: 1, ...options});
  t.after(() => service.close());
  return {service, wire, crash: () => finish(child, 105)};
}

module.exports = {syntheticOfficialAppleHost};
