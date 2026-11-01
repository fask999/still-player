'use strict';

// Opt-in isolated, unauthenticated native-host check. Does not call authorize,
// search, play, or any Apple account/credential API. No Still/foobar startup.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createNativeOfficialHost} = require('../src/main/apple-official-web');

async function main() {
  const root = path.resolve(__dirname, '..');
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'still-official-native-smoke-'));
  const host = createNativeOfficialHost({hostPath: path.join(root, 'native', 'apple-host', 'bin', 'StillAppleHost.exe'), profileDir});
  const result = {checkedAt: new Date().toISOString(), authenticated: false, attemptedAuthorization: false, attemptedPlayback: false, attemptedAppleApiCalls: false};
  try {
    result.started = await host.start({show: false});
    result.probe = await host.request('probe');
    try {await host.request('library', {kind: 'playlist-songs', id: 'fixture-native-id-separation-check', limit: 1, offset: 0}); result.unauthenticatedLibraryBlocked = false;}
    catch (error) {result.unauthenticatedLibraryBlocked = error.code === 'needs-auth'; result.libraryCode = error.code;}
  } catch (error) {result.errorCode = error.code || 'smoke-failed'; process.exitCode = 1;}
  finally {result.release = await host.close();}
  const evidenceDir = path.join(root, 'docs', 'evidence'); await fs.mkdir(evidenceDir, {recursive: true});
  const file = path.join(evidenceDir, 'apple-official-native-smoke-20261030.json');
  await fs.writeFile(file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({evidence: file, ...result}));
  if (!result.probe || result.probe.state.authorized !== false || !result.unauthenticatedLibraryBlocked || !result.release.helperExited) process.exitCode = 1;
}
main().catch(() => {console.error('Official native smoke could not complete.'); process.exitCode = 1;});
