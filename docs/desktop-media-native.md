# Native Windows media controls bridge

STILL publishes observed playback metadata and capabilities to Windows System
Media Transport Controls (SMTC). The helper is a separate, app-owned process.
It decodes no audio, opens no audio endpoint, starts no player, opens no URL,
and installs no keyboard hook. SMTC is the only media-key entry point for this
feature; do not also register media keys through Electron `globalShortcut`.

`src/main/media-controls-native.js` is the strict Node transport.
`src/main/media-controls.js` owns playback-session identity and dispatches
validated intents through the existing playback coordinator.
`native/desktop-media/StillMediaControls.cs` owns the native SMTC object.

## Runtime files and integrity

`runtimeRoot` is the application root, including packaged `resources/app` when
that is where the application files live. The fixed manifest path is:

`native/desktop-media/bin/runtime-manifest.json`

The runtime directory must contain exactly these four regular files:

| File | Purpose |
| --- | --- |
| `StillMediaControls.exe` | Our x64 .NET Framework helper |
| `LICENSE.txt` | Scope statement for this original STILL component; grants no additional independent license |
| `NOTICE.txt` | Attribution, prerequisites, and OS dependencies |
| `runtime-manifest.json` | Closed-schema size/SHA-256 inventory of the three files above |

The manifest has only `{schemaVersion:1,kind:'still-desktop-media',architecture:'x64',files}`.
Each of its three unique entries has exactly `{path,bytes,sha256}`. Paths are
literal allowlisted basenames; SHA-256 values are lowercase, 64-digit hex.
An executable can be at most 2 MiB and each notice at most 16 KiB. The manifest
itself is at most 8 KiB. No extra DLL, configuration file, subdirectory, symbolic
link, junction/reparse traversal, missing file, mismatched size, or mismatched
hash is accepted. The executable must also begin with the PE `MZ` signature.

`verifyNativeMediaRuntime(runtimeRoot, {expectedManifestSha256} = {})` returns
`{executable,directory,manifestRelativePath,hashes}`. `hashes` includes the raw
manifest SHA-256 and all three file hashes under their application-relative
paths. Packaging can omit the pin when discovering candidate hashes. Production
`createNativeMediaControls` requires `expectedManifestSha256`: the trusted
lowercase 64-digit digest injected by main from the enclosing runtime registry.
The digest is checked against the raw manifest bytes before parsing its JSON or
trusting its entries. A missing, invalid, or mismatched pin prevents spawning;
replacing both the executable and its local manifest cannot satisfy the original
trusted pin. Packaging must freeze/copy these four files and retain their hashes
in the enclosing package integrity record. The caller must not derive its
production pin from that same mutable local manifest. A person able to replace
the enclosing trusted application/registry can still replace the trust anchor.
There remains an ordinary path-based check-to-launch interval; this is not an
attacker-isolation boundary.

The directory's original-component scope statement does not add an independent
license, assert a root license exists, or change existing third-party/other-directory
license scopes. Framework and Windows components retain their Microsoft terms.

No framework DLL or Windows SDK metadata is redistributed. Windows 10/11 x64
with .NET Framework 4.8 is required. A missing or invalid runtime produces a
real unavailable status and never falls back to fake playback or global keys.

## Main-process API

```js
const {createNativeMediaControls} = require('./media-controls-native');
// expectedManifestSha256 comes from main's trusted enclosing runtime registry.
const controls = createNativeMediaControls({runtimeRoot, expectedManifestSha256,
  onCommand, onStatus});
await controls.start();
await controls.update(snapshot);
await controls.dispose();
```

`start()` is idempotent while a helper is active and resolves a status object:
`{available,state,backend:'native-smtc',verified,reason}`. State is `idle`,
`starting`, `ready`, `unavailable`, or `disposed`. Reasons are fixed diagnostic
codes and contain no raw helper exceptions, arbitrary strings, or paths.
`getStatus()` returns a copy of that status. `onStatus` receives the same shape.
The Windows-x64 and runtime checks happen before spawning. Spawn uses hidden
console pipes, an explicit executable, the verified runtime directory, and an
environment containing only `SystemRoot` and `WINDIR`.

`update()` validates and clones the snapshot synchronously, then resolves
`{queued:true}`. This means transport acceptance, not a playback commit or even
a native acknowledgement. It retains only the newest snapshot while waiting
for readiness, a write drain, or an acknowledgement. There is at most one
request in flight, and updates are spaced by at least 80 ms. Progress polls
cannot create an unbounded stdin buffer. Sequence numbers must strictly
increase across all sessions in an instance.

`dispose()` synchronously invalidates callbacks, requests controlled shutdown
when possible, closes stdin, and waits at most 1.2 seconds. A helper that has
not exited gets a process-specific kill after 600 ms. The instance is terminal:
later `start()` returns `disposed`, and later `update()` returns
`{queued:false,disposed:true}`. Create a new instance for an explicit retry.
The controller serializes retiring instances before starting their replacements.

The optional `spawnProcess`, `platform`, and `architecture` arguments exist for
in-process fake-transport tests. Normal product construction supplies none of
them. The production client always requests `--stdio` and rejects a
`protocolTest:true` handshake.

## Snapshot and command contract

```js
{
  schemaVersion: 1,
  sessionId: 'opaque-ASCII-session-token',
  sequence: 12,
  source: 'local', // 'local' | 'apple' | null
  state: 'paused', // 'playing' | 'paused' | 'stopped' | 'unavailable'
  metadata: {title: '', artist: '', album: '', artwork: null},
  position: 10, duration: 180, // observed seconds
  capabilities: {play: true, pause: true, stop: true,
    next: false, previous: false, seek: true}
}
```

All object schemas are closed. The session token is 1–128 ASCII letters,
digits, `_`, `-`, or `.`; sequence is a nonnegative safe integer. Metadata
strings are at most 1024 UTF-16 code units, must have paired surrogates, and
allow tab/newline but no other C0 controls. Position and duration are finite,
nonnegative seconds up to 31,536,000, with position no greater than duration.
Playing/paused requires a real source. A null source or unavailable state
cannot advertise any capability. Seeking additionally requires positive
duration. The bridge preserves the supplied capability booleans; it does not
invent Apple Music abilities.

Artwork, when present, is only
`{mimeType:'image/png'|'image/jpeg',dataBase64:string}`. It is canonical base64,
at most 512 KiB after decoding, with a matching PNG/JPEG header and dimensions
between 1 and 4096 in each direction. JPEG segment bounds are checked before
reading dimensions. This is bounded header validation, not a complete image
decoder. Windows decodes the thumbnail. No URL or path is accepted or opened.
Omitting artwork or passing null clears the prior thumbnail. Image bytes stay
in an in-memory random-access stream; no temporary cover file is written.

`onCommand` receives exactly
`{action,sessionId,sequence,position?}`. Action is `play`, `pause`, `stop`,
`next`, `previous`, or `seek`; only seek has a position. Native events carry
the snapshot identity applied when the event was handled. The client rejects
old process generations, other sessions, future/unsent sequences, and commands
revoked by the newest capabilities. A recent older sequence in the same
session remains valid across ordinary progress polls. The coordinator must
recheck the current source, generation, capability, and seek bounds when it
atomically dispatches the intent. The helper never changes playback itself.

## Native ownership and API mapping

Normal mode sets the process AppUserModelID to `Still.Desktop.MediaControls`,
creates a hidden top-level window titled `STILL`, verifies that its HWND belongs
to the helper process, and obtains SMTC through the activation factory's
`ISystemMediaTransportControlsInterop::GetForWindow`. It never uses an Electron
HWND or `GetForCurrentView`. The object remains disabled until a valid snapshot
is applied. Only a validated `hello` activates the SMTC object.

Metadata maps to `DisplayUpdater` music properties and an in-memory thumbnail.
The observed state maps to `PlaybackStatus`, and position/duration map to
`UpdateTimelineProperties`. Individual button flags follow the six supplied
capabilities. Windows exposes seek through the timeline range: when seek is
disabled, min/max seek time both equal the observed position, and incoming seek
events are rejected too. Fast-forward, rewind, record, channel-up, and
channel-down remain disabled and produce no forwarded intent.

Shutdown disables SMTC, sets `Closed`, removes handlers, clears display data,
disposes the streams, destroys the owned window, and exits. The helper pins its
actual parent's process handle after checking the OS-reported parent PID. EOF,
parent exit, malformed input, handshake timeout, or missing heartbeats ends the
host. A watchdog forces process exit if orderly native cleanup is stuck for two
seconds. Only its own SMTC lifetime and process are affected.

Microsoft references:

- [Desktop GetForWindow and same-process top-level HWND requirement](https://learn.microsoft.com/en-us/windows/win32/api/systemmediatransportcontrolsinterop/nf-systemmediatransportcontrolsinterop-isystemmediatransportcontrolsinterop-getforwindow)
- [Desktop WinRT alternatives to GetForCurrentView](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/winrt-api-desktop-app-support)
- [SMTC timeline updates](https://learn.microsoft.com/en-us/uwp/api/windows.media.systemmediatransportcontrols.updatetimelineproperties)
- [Playback position change requests](https://learn.microsoft.com/en-us/uwp/api/windows.media.systemmediatransportcontrols.playbackpositionchangerequested)
- [Disabling SMTC](https://learn.microsoft.com/en-us/uwp/api/windows.media.systemmediatransportcontrols.isenabled)
- [Creating an in-memory stream reference](https://learn.microsoft.com/en-us/uwp/api/windows.storage.streams.randomaccessstreamreference.createfromstream)
- [OS process information and parent-process identifier](https://learn.microsoft.com/en-us/windows/win32/procthread/zwqueryinformationprocess)

## Wire limits and failure behavior

Transport is strict UTF-8 JSON, one object per LF-delimited line. Duplicate
keys (including escaped duplicates), unpaired surrogates, unknown fields,
unexpected arrays, nonfinite numbers, and trailing values reject. Requests
have `{v:1,type,id,generation,...}`. Request IDs increase; the random 128-bit
generation must match the command line and every reply. Snapshot identity
returns in both acknowledgements and native commands.

| Limit | Value |
| --- | --- |
| Input line | 720,000 bytes |
| Input rate | 40 lines per second |
| Output line | 8,192 bytes |
| Client output consumption | 40 messages and 65,536 bytes per second |
| Native command emission | 20 commands per second, excess dropped |
| Native output queue | 64 bounded messages, never blocks the UI thread |
| Helper stderr consumption | 16 KiB total; contents are not surfaced |
| JSON nesting / nodes | 7 / 100 native, 7 / 128 Node |
| Initial hello / ready | 5 seconds |
| Node acknowledgement / pong | 3.5 seconds |
| Node heartbeat interval | 4 seconds |
| Helper idle deadline | 15 seconds |

The only requests are `hello`, `update` (with `snapshot`), `ping`, and
`shutdown`. Replies are `ready`, `ack`, `pong`, and `bye`; native events are
`command`. A protocol rejection emits the fixed `invalid-message` code and
exits. Unexpected output fails closed, ends stdin, and schedules a bounded
kill. Every process event is bound to its own run, so delayed output from a
retiring helper cannot affect a replacement.

## Building and non-UI verification

These commands use installed tools only, perform no downloads, and do not
register SMTC:

```powershell
& ./native/desktop-media/build.ps1 -CheckOnly
& ./native/desktop-media/build.ps1 -SelfTest
node --test ./tests/desktop-media-native.test.js
node ./node_modules/eslint/bin/eslint.js ./src/main/media-controls-native.js ./tests/desktop-media-native.test.js ./native/desktop-media/check-protocol.js --max-warnings=0
node ./native/desktop-media/check-protocol.js
```

Build uses the installed Framework64 `csc.exe`, the Windows SDK's versioned
`Windows.winmd`, and installed Framework WinRT facade references. Warnings are
errors. It compiles x64, copies our two notices, and regenerates the exact
runtime size/hash manifest. It refuses unexpected/link entries in its runtime
directory. Framework compiler output is not claimed to be byte-reproducible;
rebuilding intentionally changes the reviewed executable hash.

`--self-test` exits before creating a host, window, activation factory or SMTC.
`--protocol-test --parent-pid N --generation HEX` runs the actual bounded stdio
protocol and lifecycle but never creates a window or activates WinRT/SMTC.
The explicit protocol CLI checks real helper framing, large artwork envelopes,
schema rejection, rate/length limits, sequence guards, EOF, parent-exit/pipe
cleanup, and native deadlines. The parent-exit scenario may also deliver EOF;
it does not isolate those two Windows notification paths from one another.
The normal `node --test` suite uses only fake child processes and temporary
synthetic fixtures, with the repository's side-effect guard installed.

These checks do not establish actual shell presentation, the desktop COM
activation/marshaling result, thumbnail rendering, physical media-key routing,
seek UI behavior, or real session removal. Those require a separately scheduled
normal-mode check. No actual SMTC registration, keyboard injection, Computer
Use, screenshot, audio, or real playback is part of the checks above.
