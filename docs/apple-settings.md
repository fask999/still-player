# Apple Music settings contract

`src/main/apple-settings.js` exports two pure functions:

- `normalizeAppleSettingsSnapshot(raw)` returns a new fixed Apple settings DTO.
- `validateAppleSettingsPatch(patch)` returns a new one-field validated patch.

The module imports no engine, network, filesystem, process or session code. Core owns public MusicKit reads/writes and playback coordination; main owns IPC; renderer owns the settings panel. A valid patch is data validation, not evidence of an applied setting or permission to play.

## Snapshot

```js
{
  source: 'apple',
  available: false,
  status: 'unsupported', // ready | pending | session-closed | unavailable | unsupported
  sessionOpen: false,
  authorized: null, // true | false | null (unknown)
  pending: false,
  repeatMode: null, // none | one | all | null
  shuffleMode: null, // off | songs | null
  bitrateTarget: null, // 64 | 256 | null, next-item target only
  capabilities: {
    read: false,
    repeatMode: false,
    shuffleMode: false,
    bitrateTarget: false,
    openSession: false,
    refreshLibrary: false,
    canSelectLossless: false,
    outputSelection: false
  },
  details: {actualBitrate: null, actualDacRate: null}
}
```

Core supplies actual connection facts and recognized public setting values. The normalizer never infers `available`, authorization, pending or session state from modes or other fields. Missing/invalid boolean values become false, except authorization becomes null. Unsupported status becomes `unsupported`; unsupported mode/target values become null. Repeat/shuffle write capability is preserved only when Core supplied true and the corresponding mode is recognized. Open-session and library-refresh capability follow Core's strict boolean facts.

`bitrateTarget`, `canSelectLossless` and `outputSelection` capabilities are always false. Actual stream bitrate and DAC rate always remain null, even if input suggests measurements. The `details` input allows only those two known own data fields, so normalizing a complete normalized DTO is idempotent.

Top-level input, `capabilities` and `details` may be missing/null for an empty snapshot. Every supplied record must have the ordinary Object prototype or a null prototype. Unknown keys, symbols, accessors, custom prototypes and `toJSON` are rejected without reading getters or invoking serialization hooks. A supplied source must be exactly `apple`. Structural rejection throws `TypeError('Invalid Apple settings snapshot')` without including input data.

## Updates and integration

IPC contract reserved for main integration:

```js
still.invoke('apple:settings:get', {})
still.invoke('apple:settings:update', {patch: {repeatMode: 'one'}})
still.invoke('apple:settings:update', {patch: {shuffleMode: 'songs'}})
```

The patch validator accepts exactly one own field: `repeatMode` with `none|one|all`, or `shuffleMode` with `off|songs`. It rejects empty patches, both fields together, all quality/output/session fields, invalid enums and the structural traps listed above. Rejection throws `TypeError('Invalid Apple settings patch')`. No coercion, inferred toggle or partial two-field update occurs.

Core must map these strings using the current SDK's named public enum values, then read back the actual property after setting it. Never hardcode numeric enum ordinals or return the requested value as confirmation. Preserve existing generation/session fencing, write serialization, engine ownership and native mute/permission rules; settings neither create playback authorization nor start a host. Pending play, stop, close and source handoff must supersede stale writes. Main should normalize only a projected settings DTO, not a whole source descriptor containing unrelated fields.

Account controls use only existing high-level facts, the explicit open-session action (`apple:authorize`, which shows the existing official session), and a real library fetch (`apple:library`) for the current view. Status-only reads are not library refreshes. Opening the settings panel must not start sessions or play. This contract adds no close-session, sign-out, reauthentication, profile reset or account-identity collection.

## Public SDK behavior and limits

The official [MusicKit JS instance reference](https://js-cdn.music.apple.com/musickit/v3/docs/index.html?path=/story/reference-javascript-musickit-instance--page) documents `repeatMode`, `shuffleMode` and `bitrate`; the [MusicKit global reference](https://js-cdn.music.apple.com/musickit/v3/docs/index.html?path=/story/reference-javascript-musickit--page) defines their enums.

Repeat uses `MusicKit.PlayerRepeatMode.none|one|all`: disabled, current item, or current SDK queue. Shuffle uses `MusicKit.PlayerShuffleMode.off|songs`; changing it preserves the current item while reordering the queue. Turning it off is not a documented promise to recover the original queue order. Undo can restore a previous mode through another current-session checked write, but cannot guarantee an exact queue permutation. Repeat and shuffle are independent. STILL's one-song queue must not be presented as whole-library shuffle.

MusicKit's reported target bitrate supports `PlaybackBitrate.STANDARD` (64 kbps) and `HIGH` (256 kbps). It affects future item selection and does not measure the currently played stream. It provides no evidence of lossless playback, bit depth, sample rate, exclusive mode or physical DAC output. This settings contract exposes no quality or output switch.

The [Apple library songs endpoint](https://developer.apple.com/documentation/applemusicapi/get-all-library-songs) supports actual library fetches. [WebView2's media interface](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_8) reports mute/audio activity, which does not establish output quality or device selection. Official documentation was checked on 2026-11-01; public API documentation does not prove current live-instance support, applied settings or audible output.

## Verification

Run `node --test tests/apple-settings.test.js` and `node --check src/main/apple-settings.js`. Tests use pure synthetic records only. They cover idempotence, connection-fact independence, enum boundaries, disabled unsupported capabilities, single-field updates, detached records, getters, setters, custom prototypes, symbols, nonenumerable unknown fields and `toJSON`. Real host/SDK integration and rendering remain checks owned by their respective writers.
