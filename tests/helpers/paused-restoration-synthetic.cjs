'use strict';

// Authored from the restoration input schema, never from historical acceptance
// JSON or a user library. These paths name nonexistent synthetic media only.
const {createHash} = require('node:crypto');
const OUTPUT_DEVICE_ID = 'synthetic-output-device';
const SYNTHETIC_BACKEND = Object.freeze({
  backendDir: 'C:\\__STILL_PAUSED_UNIT_FIXTURE__\\backend\\foobar2000',
  executable: 'C:\\__STILL_PAUSED_UNIT_FIXTURE__\\backend\\foobar2000\\foobar2000.exe'
});
const hash = value => createHash('sha256').update(value).digest('hex');

function createSyntheticPausedSource({historicalPlaylistId = 'synthetic-old-deck', duplicateTargetLocations = false} = {}) {
  const items = Array.from({length: 107}, (_, index) => ({
    path: `C:\\__STILL_PAUSED_UNIT_FIXTURE__\\track-${String(index).padStart(3, '0')}.flac`,
    subsong: 0, supported: true, title: `Synthetic paused fixture ${String(index).padStart(3, '0')}`
  }));
  if (duplicateTargetLocations) {
    items[12] = {...items[50]};
    items[88] = {...items[50]};
    items[20] = {...items[50], subsong: 1}; // Same path, distinct media location.
  }
  const target = items[50];
  const output = {typeId: 'output', deviceId: OUTPUT_DEVICE_ID, id: JSON.stringify(['output', OUTPUT_DEVICE_ID])};
  const result = {initialUserState: {
    state: {state: 'paused', controlUncertain: false, currentTrack: {...target}, position: 14.54, duration: 180,
      volumeInfo: {type: 'db', value: 0, isMuted: false}, playbackOrder: {id: 0}, output},
    rawPlayer: {playbackState: 'paused',
      options: [{id: 'playbackOrder', type: 'enum', value: 0, enumNames: ['Default', 'Repeat']}],
      activeItem: {playlistId: historicalPlaylistId, index: 50, position: 14.54,
        columns: [target.path, String(target.subsong), target.title]}},
    queue: {items: []}
  }};
  const playlists = {playlists: [{id: historicalPlaylistId,
    name: 'STILL · Playback Synthetic Unit Fixture [11111111-2222-4333-8444-555555555555]', items}]};
  const resultRaw = JSON.stringify(result), playlistsRaw = JSON.stringify(playlists);
  return {result, playlists, resultRaw, playlistsRaw,
    resultHash: hash(resultRaw), playlistsHash: hash(playlistsRaw), backend: {...SYNTHETIC_BACKEND}};
}

module.exports = {createSyntheticPausedSource, OUTPUT_DEVICE_ID, SYNTHETIC_BACKEND};
