# Read-only spectrum reader and Node client

`SpectrumPipeReader.cs` builds `package/StillSpectrumReader.exe`, a Windows x64
.NET Framework console helper. It references the Windows .NET Framework JSON
serializer (`System.Web.Extensions.dll`), with no Forms, WebView, audio capture,
loopback, device, playback-control or process-management references. No runtime
or toolchain is downloaded by the build script.

Build and fixture acceptance, from the Still directory:

```powershell
& .\native\foobar-spectrum\build-reader.ps1 -SelfTest
node --test tests/spectrum-client.test.js tests/spectrum-reader.test.js
node --check src/main/spectrum-client.js
```

The only executable invocation authorized for this implementation session is
`StillSpectrumReader.exe --protocol-self-test`. This branch returns before stdin
monitoring, named-pipe construction and kernel PID inspection. It uses constant
JSON fixtures and MemoryStream input. No pipe server or real process/audio
fixture is needed. Normal `--pid` mode was implemented but **not run against a
player or pipe**, and no runtime/native component integration is claimed.

## Runtime wire contract

Normal arguments are exactly `--pid <positive-uint32>` and optional
`--interval-ms <40..250>` (default 50). No pipe name, command, audio data, file
path, server address, or executable can be selected through reader arguments.
The reader connects for input only to the local name
`\\.\pipe\Still.FoobarSpectrum.v1.<PID>`; connection timeout is 150 ms.

Every successful connection calls `GetNamedPipeServerProcessId` on its actual
SafePipeHandle **before any read** and compares the kernel PID with the expected
PID. It never accepts the JSON backendPid as identity evidence. It then reads a
maximum of 61,440 (60 KiB) UTF-8 bytes through EOF, with a single 150 ms deadline
for the entire snapshot. This native snapshot budget includes LF. The native
server emits one JSON object plus LF and closes. After validation/reserialization,
the reader separately limits the complete stdout envelope including LF to 65,536
(64 KiB) UTF-8 bytes; serializer expansion cannot overrun the Node transport limit.
Normal-mode console output explicitly uses LF rather than the Windows CRLF default.
Extra JSON documents, trailing non-whitespace, malformed UTF-8, invalid schemas,
non-finite numbers, oversized input, and unsupported PID-query APIs fail closed.
The validated object is reserialized; raw pipe text is never concatenated into
stdout.

Stdout is NDJSON with one of these envelopes:

```json
{"protocol":1,"kind":"frame","serverPid":651,"frame":{}}
{"protocol":1,"kind":"unavailable","reason":"component-not-connected"}
```

The first example omits the required native frame members for brevity. The full
native schema is checked in both C# and Node. The only reader failure reasons are
`component-not-connected`, `server-pid-mismatch`, `malformed-frame`, and
`read-timeout`. Stderr uses constant diagnostic short codes for invalid arguments
or failed self-tests. No exception message, header, credential or raw frame is
written to stderr.

Parent stdin EOF sets the stop signal and disposes the current owned pipe;
connect/read deadlines also bound shutdown. Node ends stdin and kills only its
exact returned reader child on cancellation/dispose, never a process selected by
PID and never the backend player. A failed asynchronous spawn retains a harmless
error sink to prevent a late child error from crashing Node.

## Node interface

```js
const { createSpectrumClient } = require('./spectrum-client');
const client = createSpectrumClient({ getBackendSession: () => backend.getSession() });
const snapshot = await client.read({
  source: 'local', state: 'playing', generation: 4,
  currentTrack: { id: 'track-id', path: 'C:\\Music\\track.flac', subsong: 0 },
  currentTrackId: 'track-id'
});
client.dispose();
```

`sampleRate` and `analyzedSampleRate` both describe the PCM window supplied by
foobar's visualisation stream. They are not a measurement of the DAC/output
device rate. Both are null for empty output. Every output carries `units: "dBFS"`.
Running output also includes componentSource, analyzer, componentSessionId,
componentGeneration, sequence and backendPid, in addition to the source timestamp,
age, FFT metadata and all 48 bands. Native path/subsong are not exposed.

Before an actual audio discontinuity (seek, play/restart, next or previous), the
main process must call `const token = client.invalidate()` immediately **before**
dispatching the transport mutation. Prefer the dispatch hook after preconditions
and cancellation checks, with no await between invalidate and dispatch. Calling
invalidate only after the seek has completed can fence against the new native
generation and keep the analyzer unavailable until another discontinuity.
Do not call invalidate for volume-only coordinator changes: those have no native
discontinuity callback. Ordinary coordinator generation changes already clear
the cache and reject old sequence/capture times without requiring a native
generation advance.

`invalidate()` is synchronous and does not control playback. It increments the
pending-read revision, clears the cache, stops only the owned reader, records the
invalidation wall boundary, and returns an opaque frozen object token. When a
native baseline has been observed, the same backend token/component session must
produce a strictly greater native generation before running output is accepted.
A fresh sequence/timestamp or a new coordinator generation on the same path does
not satisfy that fence. Nonrunning frames clear bars and update high-water marks
but never release it. A fresh verified backend token clears the old fence; a
legitimate new, non-retired component session can establish a new identity.

Without an observed native baseline, a fresh running frame must satisfy both
`capturedAtUnixMs - windowSeconds * 1000 >= invalidationWallBoundary` and
`monotonicNow - invalidationMonotonicBoundary >= windowSeconds * 1000`. Thus the
entire real FFT window must follow invalidation, and a wall-clock forward jump
cannot replace the actual elapsed window time. Invalid monotonic boundaries are
stored as Infinity and cannot pass this gate; nonfinite or negative elapsed time
is also rejected. Both boundaries remain in force even if nonrunning frames
arrive or a coordinator generation changes first. Waiting a local monotonic
window never substitutes for the capture-window boundary, future timestamp check
or normal 250 ms freshness gates; a new fresh sequence is still required.

After dispatch outcome is known, main may synchronously call
`client.settleInvalidation(token, disposition)`:

- `"dispatched"` or `"uncertain"` preserves the native-generation/full-window
  fence until real native evidence satisfies it.
- `"not-dispatched"` cancels that strong fence only for the exact current token.
  It still increments the revision, clears the cache/reader, preserves native
  sequence high-water marks and requires a new frame after the ordinary capture
  boundary. It never restores an old snapshot.
- A copied, forged, superseded, retired-backend or already-satisfied token cannot
  alter the current fence. Invalid tokens/dispositions return false; an accepted
  settlement returns true. Dispose makes invalidate return null and settlement
  return false.

Choose `not-dispatched` only from exact transport evidence that no request was
sent (including a proven no-op or pre-dispatch cancellation). An error code named
cancelled is not proof that a request was not sent. An uncertain failure must keep
the fence. Neither interface starts, stops, seeks, resumes, configures, resets or
sends commands to the backend/native analyzer.

Main must return empty unavailable output while a transport mutation is pending,
or when `cachedPlayer.generation !== currentCoordinatorGeneration`. Do not feed an
older cached player track/state into client.read under a newer generation.
Invalidate-before-dispatch and this outer coordinator check are both required;
the client cannot infer a main-process mutation that has not been reported to it.

For example, immediately after invalidating generation 2 the exact empty JSON
shape is:

```json
{"schemaVersion":1,"source":"local","status":"unavailable","available":false,"reason":"awaiting-native-discontinuity","trackId":"fixture-track","generation":2,"units":"dBFS","floorDbfs":-100,"calibration":"rms-full-scale-1","fftSize":4096,"window":"hann-periodic","sampleRate":null,"analyzedSampleRate":null,"channels":null,"binHz":null,"windowSeconds":null,"streamTimeSeconds":null,"capturedAtUnixMs":null,"ageMs":null,"bands":[]}
```

Complete JSON examples, including every running field and all 48 bands, are
exported from actual client calls using only the mock test fixture:
[awaiting output](../../review-evidence/spectrum-20261101/reader-client/snapshot-awaiting.fixture.json)
and [running output](../../review-evidence/spectrum-20261101/reader-client/snapshot-running.fixture.json).
These are explicitly test examples, not captured playback measurements.

The authoritative coordinator supplies source, state, generation and current
track. `isVerifiedBackendSession` is imported from `./backend` and always applied;
an object copy, PID or serialized token cannot substitute for the genuine branded
object from an owned and verified backend manager. No testing bypass exists.

Factory injection supports `spawn`, `platform`, a millisecond Unix `clock`
function (default `Date.now`) and an independent millisecond `monotonicClock`
function (default `performance.now`) for fixtures. `readerPath` may only resolve to the exact default packaged
`native/foobar-spectrum/package/StillSpectrumReader.exe`; other executables are
rejected. The fixed path is exported as `DEFAULT_READER_PATH`. Import and factory
creation start nothing. A missing reader or unverified backend returns controlled
unavailable output.

`read` never waits for a helper connection/frame. It starts at most one owned
reader for an active binding and returns the sanitized cached snapshot, or an
empty unavailable result. It yields one microtask so a source/track/generation
change, protocol failure or dispose before delivery invalidates an older pending
result. Empty snapshots carry `bands: []`, `sampleRate: null`, null measurement
metadata, `available: false`, a controlled reason, and the coordinator track ID
and generation. Native paths never appear in returned snapshots.

Apple reads return `apple-protected-spectrum-unavailable`; paused/stopped reads
return their corresponding status. They clear any old bars and start no helper.
Source, state, track ID, canonical Windows path, subsong, coordinator generation,
and exact backend token changes cancel the prior child's listeners and partial
line. Old callbacks cannot fill a new binding. Windows path comparison requires a
fully qualified ASCII drive root or UNC server/share root, then applies lexical
normalization/case folding. It accepts the SDK `file://` prefix, performs no IO and
does not URL-decode paths. Single-root, drive-relative, current-directory,
incomplete UNC and Windows device namespace paths are rejected in both readers.

Native frames require schemaVersion 1, source `foobar2000`, analyzer
`sdk-visualisation-pcm`, a UUID in 36-character D format, a positive safe sequence,
a nonnegative safe generation, kernel/self-reported PID agreement, and an exact
match to current path/subsong. Both sequence and generation must be monotonic
within a component session, including across coordinator context changes. A new
component session replaces the cache; a retired session cannot return. Retired
session memory is bounded to 16; exceeding the bound requires a new backend token.
For a repeated sequence every member except ageMs must be identical; ageMs may
only increase. A greater native age immediately raises the cache's age lower
bound, anchored to the original monotonic receipt. A repeated frame never refreshes
the first local receipt, capture time or bars. Age above 250 immediately clears it.

Running frames require real timestamps and all format fields; nonrunning frames
require empty bands and null sampleRate, channels, binHz, windowSeconds,
capturedAtUnixMs, ageMs and streamTimeSeconds. Running FFT metadata is exactly
4096, periodic Hann, RMS full-scale-1 calibration and -100 dBFS floor. The 48
logarithmic bands cover 20 Hz through min(20 kHz, Fs/2), and their actual FFT-bin
membership is recomputed. Empty bands must be at the floor; no interpolation,
AGC, smoothing or synthetic bars are added. Legitimate headroom to +60 dBFS is
preserved for the renderer to clamp. These are dBFS values, not dB SPL.

Freshness starts at `max(native ageMs, wall receipt - capturedAtUnixMs)`, thereby
including transmission delay. Subsequent elapsed time comes from the independent
monotonic clock. Wall-clock elapsed and greater native age can only tighten that
bound; any observed increase is carried forward on the monotonic timeline. A
wall clock rolling back while still above the first receipt cannot make the frame
younger or extend its lifetime. A frame older than 250 ms, future capture time,
capture before the active context boundary, wall time before receipt, invalid
clock, or backward monotonic time fails closed. The final microtask delivery
rechecks the same clocks. Repeated sequences never prolong the deadline. Stdout
is bounded per line to 64 KiB, decoded with strict UTF-8, and
cleared on malformed/extra data, close, error, PID/track mismatch or expiry.

## Evidence and limits

Task evidence lives under
`review-evidence/spectrum-20261101/reader-client/`. Tests use mocked
spawn/fetch/process inspection through the real backend manager to mint genuine
branded fixture sessions. The compiled-reader test runs only the early-return
self-test and verifies the PE machine is AMD64 and the subsystem is console.
The Apple/local lifecycle regression simulates an externally retired branded
session, rejects late old-PID frames through Apple playback, and only binds after
the external manager provides a fresh verified token and PID. The spectrum client
has no API that starts, restores, stops or exits the backend.
No live pipe authentication, DACL, native runtime loading, playback, profile,
audio device, GUI or Electron behavior has been exercised by this worker.
