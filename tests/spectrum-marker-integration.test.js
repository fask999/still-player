'use strict';
// Single incremental fixture: real manager and accepted reader client, with
// only temporary fake files and injected children/fetches. No actual migration.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createBackendManager, isVerifiedBackendSession} = require('../src/main/backend');
const {createSpectrumClient} = require('../src/main/spectrum-client');
const {createPlayerSpectrumService} = require('../src/main/player-spectrum');
const {mainCoreFixture} = require('./helpers/main-core-fixture');

test('closed migration marker prevents a new verified manager session and the spectrum adapter starts no reader', async t => {
  const f = await mainCoreFixture(t);
  // Controlled migration begins only after the previous owned child exits.
  await f.manager.close(); assert.equal(f.manager.getSession(), null);
  const backendDir = f.session.foobarDir;
  await fs.writeFile(path.join(backendDir, '.spectrum-component-install-incomplete.json'), JSON.stringify({syntheticOnly: true}));
  let backendStarts = 0, readerStarts = 0, requests = 0;
  const manager = createBackendManager({backendDir, platform: 'win32',
    inspectSystem: async () => ({processes: [], listeners: []}),
    spawn: () => {backendStarts++; throw new Error('A marked backend must not launch');},
    fetch: async () => {requests++; throw new Error('No backend HTTP is allowed here');},
    execFile: async () => {throw new Error('No executable is allowed here');}});
  t.after(() => manager.close());
  await assert.rejects(manager.initialize(), {code: 'STILL_BACKEND_COMPONENT_INSTALL_INCOMPLETE'});
  assert.equal(manager.getSession(), null); assert.equal(isVerifiedBackendSession(manager.getSession()), false); assert.equal(backendStarts, 0);
  const peer = createSpectrumClient({getBackendSession: () => manager.getSession(), platform: 'win32',
    spawn: () => {readerStarts++; throw new Error('No trusted session means no reader');}});
  const view = createPlayerSpectrumService({client: peer,
    getPlayer: () => ({source: 'local', state: 'playing', available: true, generation: 2, currentTrackId: 'old-cached-track', currentTrack: f.rows[2]}),
    getGeneration: () => 2, getBackendInfo: () => ({...manager.getInfo(), verified: isVerifiedBackendSession(manager.getSession())}),
    getBackendSession: () => manager.getSession(), getAudioTransportStatus: () => ({pending: false})});
  t.after(() => view.dispose());
  const value = await view.read();
  assert.equal(value.available, false); assert.equal(value.reason, 'backend-session-unverified'); assert.deepEqual(value.bands, []);
  assert.equal(readerStarts, 0); assert.equal(backendStarts, 0); assert.equal(requests, 0);
});
