# Current-playback spectrum

Status on 2026-11-01: **the x64 foobar component has been compiled and statically reviewed; it has not been deployed, loaded into foobar, or validated against playback**. Following explicit user authorization, the minimal official Build Tools installation succeeded with exit code 0 and no reboot requirement. The UI must report unavailable until the reviewed component is deployed to the private backend and real playback data is validated. This work does not start any player, alter an output device, or change the original `D:\foobar2000` profile.

## Feasibility and primary sources

The [official foobar2000 SDK](https://www.foobar2000.org/SDK) exposes `visualisation_manager::create_stream` and `visualisation_stream::get_chunk_absolute` in `foobar2000/SDK/vis.h`. That reads PCM from the current playback visualization stream. Its `audio_chunk` provides the actual sample rate and channels of the analyzed stream. Its time is relative to the last playback start or seek. Reading this stream is independent of decoding a second copy of the source file.

The original SDK archive is retained at `native/foobar-spectrum/vendor/SDK-2026-10-01.7z`, 793,738 bytes, SHA-256 `d4c55077336fae81bf8df0259b5b2748fa45ea84132c656ead93eb123cbcdc26`. The extracted SDK and its `sdk-license.txt`, PFC license, shared library notices, and project files are retained beside it. The SDK license permits source and binary use subject to its retained notices and conditions. This does not establish redistribution rights for the assembled private foobar installation.

The [Beefweb API documentation](https://hyperblast.org/beefweb/api/) points to the author's OpenAPI. The [v0.10 schema](https://github.com/hyperblast/beefweb/blob/v0.10/docs/player-api.yml) has no PCM or frequency-spectrum endpoint. The separately fetched original schema exactly matches this repository's pinned schema: SHA-256 `37f7a9131d3bc27fb12f81c5cca17bba06282316e06752e454efd63b4d582a9a`.

The [official MusicKit JS documentation](https://developer.apple.com/documentation/musickitjs) documents playback and catalog operations. Inspection of that public documentation did not establish a supported PCM, FFT, or frequency-band readout for the protected audio in this project's official Apple WebView2 session. This is a capability conclusion for this integration, not proof that every Apple platform or separately authorized program lacks analysis APIs. Apple's native [Music Understanding](https://developer.apple.com/documentation/musicunderstanding) accepts a supplied asset or PCM provider; it does not provide this WebView session's protected samples. Apple spectrum therefore returns `unavailable`, with no simulated bars. Seeking remains a separate playback capability. No authentication profile, cookies, tokens, request headers, protected audio, system loopback, or microphone was accessed.

## Measurement definition

The values measure **digital signal level in a frequency band**, not acoustic sound pressure or perceived loudness. They are not dBSPL, LUFS, a DAC sample-rate measurement, or an output-volume readout. The precise reference is `calibration: "rms-full-scale-1"`:

```text
N = 4096 real sample frames; no zero padding
w[n] = 0.5 - 0.5 cos(2πn/N), 0 <= n < N   (periodic Hann)
W2 = Σ w[n]^2 = 3N/8
Xc[k] = unnormalized DFT of channel c's x[n]w[n]
Pc[k] = m[k] |Xc[k]|² / (N W2)
m[0] = m[N/2] = 1; other positive-frequency m[k] = 2
Pband = Σ(k in band) (Σ(c) Pc[k] / channelCount)
bandDbfs = max(-100, 10 log10(Pband))
```

The equivalent one-sided PSD is `m|X|²/(sampleRate W2)`; multiplying by `sampleRate/N` and summing bins gives the band power above. This is window-energy normalization, not a coherent-gain peak-amplitude scale.

A peak-1 sine wholly contained in the displayed bands has total RMS power 0.5 and reads **−3.0103 dBFS** when its occupied bins are summed. A peak-0.5 sine reads −9.0309 dBFS. This explicit RMS reference differs from an AES17 full-scale-sine-as-0-dBFS convention. A bin-centered sine spreads across three Hann bins; a band containing only part of those bins measures only that part of the energy. Adding dB values directly is incorrect.

Channels are analyzed separately and their powers averaged. Identical and opposite-phase stereo tones have the same result. A tone in one stereo channel with the other silent reads 3.0103 dB lower than the same tone in both. No mono summation can cancel an opposite-phase recording. There is no automatic gain, fabricated envelope, randomized animation, or time smoothing in the backend.

There are 48 logarithmic bands from 20 Hz to `min(20000, sampleRate/2)`. Bin centers are `k sampleRate/N`, assigned once to `[lowHz, highHz)`; the final upper edge is inclusive. DC is excluded; DC's real Hann leakage into a positive bin is not fabricated or detrended. Nyquist is not doubled. A band containing no bin has `hasBins:false` and the floor value. It must not be filled by copying neighboring energy. At high sample rates a fixed 4096-frame FFT has coarse bass resolution; the client exposes `binHz` and empty bands honestly.

Only integer stream rates 8000–768000 Hz and 1–32 channels are supported. Insufficient frames, invalid formats, non-finite samples, or analysis failures produce unavailable data. Sample magnitude is checked for safe arithmetic; real PCM headroom may produce positive dBFS. The UI may clamp its bar height to its chosen displayed range while retaining the measured value. It should map the fixed dB range, for example `clamp((dbfs + 100)/100, 0, 1)`, instead of rescaling every frame's maximum.

## Native and client boundaries

`native/foobar-spectrum/component.cpp` implements a private x64 foobar component using the official SDK stream. SDK service access, playback reads, stream construction, and stream release stay on foobar's main thread. Playback callbacks invalidate state without calling `playback_control` from a global callback. Only one polling callback may be queued at a time. The main callback copies a bounded real PCM window; a worker performs FFT and serialization. No DSP, output, playback, volume, decoding, or audio-device API is changed.

Each startup receives a random component session ID. Track, seek, pause, stop, and lifecycle changes invalidate an analysis generation. Pending work from an older generation cannot publish. Repeated SDK stream timestamps do not renew the capture timestamp. Paused, stopped, unavailable, and data older than 250 ms have empty bands and no claimed analyzed sample rate. Source/path/subsong identity is checked with the current playback observation before data is used.

The component serves one UTF-8 JSON line per connection, at most 60 KiB including LF, on the fixed local named pipe `\\.\pipe\Still.FoobarSpectrum.v1.<backendPid>`. The reader's final UTF-8 envelope is bounded to 64 KiB including LF. It accepts no commands and exports no PCM. The server grants the current Windows user and SYSTEM access, rejects remote clients, uses a first-instance pipe, and bounds asynchronous connection/write waits. It does not write a spectrum log or the original profile.

`SpectrumPipeReader.cs` is a separate console reader. Before reading any payload it calls Windows' [GetNamedPipeServerProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid) to compare the kernel-reported server process with the verified private backend PID. A self-reported JSON PID alone is insufficient. The reader limits connection/read time and bytes, reads only one snapshot per connection, and emits a bounded NDJSON envelope. Its protocol self-test uses fixed data and returns before opening any pipe or initializing a player.

`src/main/spectrum-client.js` is a main-process module. It starts no process when imported. Its reader may start only for a currently playing local track with a branded session from `backend.getSession()` accepted by `isVerifiedBackendSession`. Unverified or externally reused sessions without that proof remain unavailable. The reader is owned by this client; disposal never exits foobar or any audio engine.

Proposed main-process integration, to be connected by the main integration owner:

```js
const { createSpectrumClient } = require('./spectrum-client');
const spectrum = createSpectrumClient({ getBackendSession: () => backend.getSession() });
// context is the current authoritative coordinator observation, never renderer input.
const frame = await spectrum.read({
  source: player.source,
  state: player.state,
  currentTrack: player.currentTrack,       // path and subsong stay in main
  currentTrackId: player.currentTrackId,
  generation: player.generation,
});
// Publish only the returned reconstructed, sanitized frame.
// Call read on playback identity/state changes to clear promptly; dispose on quit.
```

For `player:spectrum`, main should accept only an empty payload and reconstruct this context itself. If transport is pending, or the cached player generation differs from the coordinator's current generation, return an empty unavailable frame. Do not combine an old cached track/state with a newly read coordinator generation. At renderer IPC delivery, allow only the intended spectrum fields: source/status/availability/reason, track ID and coordinator generation, an opaque stream identity and sequence, age, frequency bands and dBFS units/calibration, and analyzed sample rate. Keep native path, backend PID, and absolute clock values inside main. The renderer should conservatively add elapsed monotonic time since its request began, clear at 250 ms, and never renew a repeated sequence's life.

The client also exposes synchronous, analysis-only `invalidate()` and `settleInvalidation(token, disposition)`. Main calls `invalidate()` immediately before an actual seek/play/restart/next/previous dispatch, after preconditions/cancellation checks and with no asynchronous gap before dispatch. It clears cached/pending frames and its owned reader, returning an opaque exact-identity token. With an observed native baseline, even a fresh new sequence for the same path is withheld until native generation advances. Without a baseline, a whole new FFT window is required after the invalidation boundary: both independently elapsed monotonic time and the frame's capture-window boundary must satisfy the actual sample-rate-dependent window length. A forward wall-clock adjustment cannot bypass that waiting period. Ordinary coordinator generation changes still clear and require fresh data; they do not impose this stronger fence, because volume controls also advance the coordinator generation without requiring a native playback discontinuity.

If a command is proven to be a no-op or canceled before dispatch, main may call `settleInvalidation(token, "not-dispatched")`. Only the exact current token cancels that strong fence; the operation still clears data and preserves sequence high-water marks and ordinary freshness boundaries. `"dispatched"` and `"uncertain"` retain it. A cancellation/error name alone is not proof of non-dispatch. Old/copied tokens cannot unlock a newer invalidation. These methods do not wait for PCM or alter playback; they never start, seek, pause, stop, or restore a player. Prefer the exact dispatch hook so a command that never dispatches needs no strong fence in the first place.

Native generation advances on starting/new-track/stop/seek/pause-or-resume/edited callbacks, and also on unavailable analysis resets to invalidate an in-flight FFT. It is an analysis validity epoch, not an acknowledgement or nonce proving that a particular seek command succeeded. The playback owner still determines transport success through its own actual readback.

The client validates kernel/server PID binding, track path plus subsong, component session/generation/sequence, coordinator generation, finite band geometry, Hann/calibration metadata, Nyquist, capture age, and receipt age. `units` is always `"dBFS"`; `analyzedSampleRate` equals the SDK PCM `sampleRate` on running frames and is null otherwise. An independent monotonic clock prevents wall-clock corrections from extending a frame's life; repeated native age may only increase the conservative age bound. Replaying a sequence does not extend its lifetime. Provider changes, pauses, stops, superseded reads, malformed data, child failures, or stale data clear bands. If the main playback owner gracefully exits foobar to hand audio to Apple, a missing backend session clears the spectrum and reader; this analysis client never starts or restores foobar. A later explicit local play must supply a newly verified main-owner session. Source paths are used only for main-process matching and are never included in the returned renderer frame. No renderer-supplied pipe name, executable path, backend PID, or track identity is accepted.

The native schema is `schemaVersion:1`, `source:"foobar2000"`, `analyzer:"sdk-visualisation-pcm"`; it carries `status`, `reason`, `sequence`, `sessionId`, `backendPid`, `generation`, internal `track:{path,subsong}`, `capturedAtUnixMs`, `ageMs`, `streamTimeSeconds`, `sampleRate`, `channels`, `fftSize`, `window`, `calibration`, `floorDbfs`, `binHz`, `windowSeconds`, and `bands:[{lowHz,highHz,dbfs,hasBins}]`. Non-running frames have no bands and null analyzed-format/time fields. `sampleRate` always means the SDK chunk's analyzed PCM rate. `actualDacRate` is not inferred or added.

## Build dependency and authorized installation

The read-only probe is retained at `review-evidence/spectrum-20261101/toolchain-probe.json`. It found no `cl`, `clang++`, `clang-cl`, `g++`, C++ MSBuild, `cmake`, `ninja`, or `vswhere` on PATH, and no VS or Windows SDK in their usual C:/D: install locations. A bounded search of project/tools, Codex tool caches, `D:\工具`, `D:\llama.cpp`, and Python/Anaconda locations found no usable C++ driver. This is evidence of this environment's tested paths, not a claim that every byte of every drive was indexed. Installed .NET runtimes are not a C++ SDK. The existing .NET Framework C# compiler can build the console reader.

The installed official path is **Visual Studio Build Tools 2022, MSVC v143 x64/x86, and one Windows 11 SDK**. The project uses C++20 and the official SDK's v143 project references. No Visual Studio IDE, CMake, vcpkg, ARM compiler, WDK/driver kit, MFC, Clang, ATL, or audio driver was needed for the successful actual build. Microsoft's selected workload/SDK required dependency closure is installed by its own installer; no unrelated optional workload was selected.

| Selection | Official component ID |
| --- | --- |
| C++ Build Tools workload required dependencies, including MSBuild | `Microsoft.VisualStudio.Workload.VCTools` |
| MSVC v143 compiler, headers, libraries | `Microsoft.VisualStudio.Component.VC.Tools.x86.x64` |
| Windows 11 SDK 10.0.26100 | `Microsoft.VisualStudio.Component.Windows11SDK.26100` |

The reviewable selection is saved at `native/foobar-spectrum/minimal-buildtools.vsconfig`. It is a configuration file, not an installer invocation. Required dependencies are resolved by Microsoft's installer; recommended/optional extras are not broadly selected. Component names and dependencies come from the [official Build Tools component directory](https://learn.microsoft.com/en-us/visualstudio/install/workload-component-id-vs-build-tools?view=vs-2022). Obtain the bootstrapper through the [official VS 2022 release history](https://learn.microsoft.com/en-us/visualstudio/releases/2022/release-history) or [official Build Tools 2022 link](https://aka.ms/vs/17/release/vs_BuildTools.exe).

This is a **system installation** through the official installer, not a portable project-only compiler. It installs shared MSBuild/MSVC/SDK components and may require administrator authorization. The user subsequently authorized that installation. It does not require changing security, approval policy, drivers, proxy, or playback settings; none of those settings has been changed here.

The initial engineering budget was **2–4 GiB of downloads and 6–10 GiB of disk including installed tools/cache**, not a measured installer result or a guaranteed upper bound. Microsoft's [published Build Tools range](https://learn.microsoft.com/en-us/visualstudio/releases/2022/system-requirements#visual-studio-build-tools-2022) is 2.3–60 GB depending on selected features. The signed official bootstrapper is version 17.14.37827.9 (Visual Studio 2022 17.14.44), SHA-256 `972d771c33c2887b13900c2052e5d2e88208531f6d5ee3c4405d7648e853009b`; Authenticode status was Valid with Microsoft Corporation as signer. The preflight found 18.30 GiB free on C: and 75.68 GiB on D:.

The installer completed with `--quiet --wait --norestart`, only the three selections above, without `--includeRecommended`, an IDE, or unrelated workloads. Its target is `native/foobar-spectrum/tools/BuildTools2022`; shared components and the download cache use `native/foobar-spectrum/shared` and `native/foobar-spectrum/cache`. Windows SDK headers/libraries are registered at `C:\Program Files (x86)\Windows Kits\10`, version `10.0.26100.0`. The compiler's actual file version is **19.44.35229.0**, product version 14.44.35229.0; it has a valid Microsoft Authenticode signature. The first attempt stopped because the original cache path exceeded Microsoft's 50-character limit; one evidence-based retry shortened the cache/shared paths to 48/49 characters. Both attempts, signatures, exact arguments, exit status, disk measurements, and native installer logs are retained under `review-evidence/spectrum-20261101/toolchain-install`. No UAC workaround, security change, forced process closure, or reboot was used.

The four measured installation/cache directories contain about **5.54 GiB of logical file bytes** in total (Build Tools 3,031,092,513 bytes, cache 1,111,783,035, shared 6,878,315, Windows SDK 1,796,265,155), excluding separately installed installer/support files. This is not a network download meter or physical allocation measurement. The measured free space afterwards was C: 17.49 GiB, D: 71.76 GiB; unrelated concurrent activity can affect free-space deltas. The exact machine probe is `toolchain-install/summary.json`.

Run `native/foobar-spectrum/build.ps1 -CheckOnly`, then `native/foobar-spectrum/build.ps1` for the component. `native/foobar-spectrum/test-native.ps1` discovers those installed tools and runs the four spectrum test files with a process-local x64 compiler environment, restoring the caller's environment afterwards. It fails if prerequisites are missing instead of silently skipping native execution; it never installs tools or contacts a player/device. Plain `node --test tests/spectrum-*.test.js` also works from a configured developer environment. The actual component build succeeded for all four required projects with **zero warnings and zero errors**. It stages artifacts under `native/foobar-spectrum/package`; it does not deploy them.

The build pins an empty user-properties directory, disables ancestor directory imports and custom import hooks, audits the three official SDK project files for build/deployment commands, disables recursive project builds, and uses separate intermediates and a shared output inside `native/foobar-spectrum/build`. It never invokes the SDK sample. Only the DLL, two original licenses, and component details are staged by the component build. Do not recursively package `tools`, `cache`, `shared`, `vendor`, or `build`.

Deployment is a later private-backend integration operation. The main integration owner must arrange normal user closure/reopen, update the private backend's reviewed manifest and package assets, and validate real SDK stream behavior. Never install this into the original player profile. Do not overwrite a running backend or claim a playback test from a protocol fixture.

## Acceptance evidence and limits

`tests/spectrum-dsp.test.js` labels its independent analytical/direct-DFT fixtures separately from native execution. Those fixtures verify Hann energy, RMS scaling, channel-power averaging, DC/Nyquist multiplicity, and deterministic multi-tone Parseval relations. The actual production header was then compiled with MSVC and its **23 synthetic C++ cases passed**. An independent reviewer separately compiled it with `/W4 /WX` and reproduced all 23 passes. The first real run exposed four incorrect single-band fixture assumptions: a 1500 Hz sine sits beside a logarithmic band boundary and its real Hann energy splits as 1/12 and 5/12. The production algorithm was unchanged; calibration now explicitly requires all three occupied bins to lie in one band, with a separate split-band conservation regression. Initial failures, source snapshot, diagnosis, and fixed results are retained.

The client/reader fixtures exercise the actual Node client and compiled reader protocol, using test doubles or fixed values. They do not attach to the real current backend or authenticate Apple. Static source/project tests are labeled as such. The final task evidence records exact counts, compiled-reader hash, component build availability, independent reviewer findings, and unresolved deployment/hardware checks under `review-evidence/spectrum-20261101/`.

Final leader acceptance on 2026-11-01 ran `powershell.exe -NoProfile -NonInteractive -File native/foobar-spectrum/test-native.ps1`: **122 passed, 0 failed, 0 skipped**, including actual MSVC production-DSP compilation/execution and the existing compiled x64 reader's 26 in-memory protocol checks. No standalone linter is configured; JavaScript syntax and PowerShell AST checks passed, and component/native compiler diagnostics are retained. The independent read-only reviewer verified the native archive/PE/licenses, independently compiled the 23 DSP cases with warnings as errors, and passed the final 20 targeted identity/discontinuity/clock regressions. Two medium client clock findings and a low cross-process byte-limit finding were repaired and independently rechecked; original failures remain in the evidence. No confirmed medium/high issue remains in the assigned source scope. Main/renderer integration was outside this module's write ownership and still requires the hooks above and its own acceptance.

`native/foobar-spectrum/delivery-manifest.json` lists exact source paths, hashes, sizes, recommended app-relative and private-backend-relative destinations, and excluded development directories. It does not perform deployment. The DLL is 696,320 bytes, SHA-256 `7cd94163f8040a1e95c3d3c908b7d9314fd1eb8bc2f2ad984f2d83a8419be391`; the 15,872-byte reader is SHA-256 `2ab9a0e40e37177170d10b0351f783371ac01232416d4e3de246366297a65663`. The exact sanitized read-result shapes were generated through actual mocked client calls, clearly as protocol fixtures, at `reader-client/snapshot-running.fixture.json` and `reader-client/snapshot-awaiting.fixture.json` under the evidence directory. These are not playback observations.

Native compilation/linking, static x64 DLL structure, expected export, binary/source hashes, and included licenses have been checked. Foobar component loading, actual paused/seek/track/time semantics, audio-thread impact, real named-pipe operation, real playback, output/DAC behavior, and protected Apple visualization remain **unvalidated** by the source/fixture work. Keep unavailable visible until the relevant real acceptance succeeds.
