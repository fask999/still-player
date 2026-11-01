# Still foobar2000 read-only spectrum component

`foo_still_spectrum.dll` is an x64 foobar2000 component built from `component.cpp`, the standard-library-only `dsp.hpp`, and the official SDK. It exports one local read-only JSON snapshot per named-pipe connection. It does not open source media, decode files independently, issue playback commands, initialize an audio device, capture loopback or microphone input, or create substitute audio.

## Source and numerical meaning

The only PCM producer is `visualisation_manager::create_stream` / `visualisation_stream_v2::get_chunk_absolute`. The component requests one second of backlog and `channel_mode_default`. The SDK `KStreamFlagNewFFT` flag is set for the stream, but SDK-generated spectra are never requested: the component performs its own documented FFT from real PCM.

Every 50 ms an analysis worker may enqueue at most one `main_thread_callback`. Its queue slot starts occupied because `on_init` prequeues the initial callback; the slot remains occupied while that callback starts the workers, preventing the initial callback from clearing another queued callback's slot. The callback reads playback state, obtains `get_now_playing()` path plus subsong, probes a short real chunk for its actual sample rate, and requests the most recent 4096 complete frames. The format must agree across the probe and requested chunk. It checks playback identity and playing/paused state again after copying. All service/stream reads, PCM copies and SDK object destruction occur on the main thread. The callback manager's documented thread-safe `add_callback` is the sole worker-side SDK operation. Global playback callbacks only invalidate state; they do not read playback services.

No zero padding, cross-window accumulation, independent decode, or synthetic fallback is used. A newly created stream establishes an observed time origin and waits for 4096 frames to pass. New track, seek, start, stop, edit and pause/resume invalidate the current generation; the following sampling callback releases/recreates the stream. The SDK absolute clock is relative to playback start/seek, not a source-file timestamp. Repeated clock values never renew sample capture time.

`dsp.hpp` analyzes exactly 4096 frames using a periodic Hann window. It combines channel powers by their mean, integrates one-sided FFT bin power into 48 logarithmic bands from 20 Hz to `min(20000, sampleRate / 2)`, and floors power at -100 dBFS. Empty bands carry `hasBins:false`, not invented estimates. This is RMS dBFS relative to full-scale 1 (a full-scale sine is approximately -3.0103 dBFS), not dB SPL or a measured acoustic level. The label is the actual SDK visualisation stream's rate; it makes no claim about a DAC device's hardware rate.

## Threading and invalidation

The analysis worker owns FFT work. It consumes at most one queued PCM window and publishes an immutable snapshot only if its generation still matches. Every authoritative unavailable/paused/stopped update also increments the generation, rejecting an FFT that began while the old public snapshot was already unavailable. Input/analyzer errors or nonfinite values produce an unavailable snapshot with no bands. A dBFS value outside the wire contract [-100, +60] is rejected rather than clipped.

`generation` and `sequence` never decrease within one random component `sessionId`; the initial immutable snapshot and sequence counter both start at sequence 1. The PID is the actual host process ID. Paused/stopped/seek/new-track callbacks clear the snapshot under the same short mutex used for analysis commit. A sample at least 250 ms old becomes `stale`, clearing measurements. Expiration runs on worker ticks and is checked again during pipe serialization. JSON generation occurs only on the pipe worker, outside the snapshot mutex; it is retried if invalidation or expiry replaced the immutable snapshot during serialization.

Shutdown sets `stopping`, signals the stop event and wakes the analysis condition variable, then joins workers. No worker waits for the main callback it enqueues. Pending callbacks hold only a weak pointer, check `stopping`, and become harmless after shutdown. `initquit::on_quit` invokes a preallocated `main_thread_callback` directly on its already-main thread to release SDK stream and manager references after workers have stopped; it does not queue cleanup behind host shutdown. No thread is detached and there is no audio-thread callback.

Bytes already written to a pipe cannot be revoked by a subsequent playback event. The snapshot generation/session/path/subsong allow the consumer to reject a response for a superseded playback context. The consuming process must verify the OS-reported named-pipe server PID, not trust the JSON PID alone.

## Pipe protocol

Endpoint: `\\.\pipe\Still.FoobarSpectrum.v1.<host PID>`.

The server uses `PIPE_ACCESS_OUTBOUND`, `FILE_FLAG_OVERLAPPED`, `FILE_FLAG_FIRST_PIPE_INSTANCE`, and `PIPE_REJECT_REMOTE_CLIENTS`. A protected DACL grants access only to the process token's user SID and LocalSystem. Security descriptor creation or endpoint ownership failure disables the endpoint without an insecure fallback. There is no input parser and no command/RPC interface.

Connection and write operations each have a 100 ms deadline and observe the stop event. Pending operations are cancelled and their kernel completion drained before freeing `OVERLAPPED` memory. After a complete write, a bounded 50 ms drain interval lets the read-once client consume buffered bytes, then the server disconnects. A client that does not read inside the bounded interval may receive a truncated response and must treat it as unavailable. `FlushFileBuffers` is deliberately absent because a slow reader could make it block indefinitely. Kernel cancellation completion is still an OS dependency; no cancellation path waits on the foobar2000 main thread.

Each successful response is one UTF-8 JSON object followed by LF, at most 60 KiB including LF. The pipe's 64 KiB buffer is separate from this payload cap; the reserved space accommodates the reader's JSON envelope below the consuming Node process's 64 KiB cap. Oversized responses are disconnected without writing a partial JSON object. Its fixed metadata is:

| Field | Value |
| --- | --- |
| `schemaVersion` | `1` |
| `source` | `foobar2000` |
| `analyzer` | `sdk-visualisation-pcm` |
| `status` | `running`, `paused`, `stopped`, `unavailable`, or `stale` |
| `fftSize` / `window` | `4096` / `hann-periodic` |
| `calibration` / `floorDbfs` | `rms-full-scale-1` / `-100` |
| `sessionId` | OS-random version-4 UUID in standard 8-4-4-4-12 lowercase-hex form |
| `backendPid`, `generation`, `sequence` | host PID and monotonic per-session counters |
| `track` | `{path, subsong}` or `null` |

Only `running` has `capturedAtUnixMs`, `ageMs`, `streamTimeSeconds`, integer `sampleRate` (8000..768000), `channels` (1..32), `binHz`, `windowSeconds`, and 48 `{lowHz,highHz,dbfs,hasBins}` bands. For all other statuses the measurements are null and `bands` is `[]`. `ageMs` uses a monotonic clock; wall-clock changes cannot prolong freshness. Reasons are short fixed codes from component source, never raw exception messages or source file contents. Captured PCM remains process-local and is never serialized.

## Build and provenance

Run from PowerShell:

```powershell
.\build.ps1 -CheckOnly
.\build.ps1
```

`-CheckOnly` performs read-only toolchain/source checks and reports JSON. A normal invocation returns exit code 2 when prerequisites are missing. It never downloads/installs prerequisites, starts foobar2000, initializes audio or deploys a DLL. With a discovered Visual Studio installation containing MSBuild C++ targets, MSVC v143 Hostx64/x64 and a Windows 10/11 SDK, it builds `Release|x64` using C++20. It checks the private `tools/BuildTools2022` location as well as installed Visual Studio registrations. The component project references official `pfc`, `foobar2000_SDK` and `foobar2000_component_client` projects and links the SDK's `shared-x64.lib`, matching the SDK sample's import-library pattern. PFC uses its `Release FB2K` configuration as required by `pfc/pfc-readme.txt`, redirecting host hooks to `shared.dll`. C++/link reproducibility flags are enabled for the component; cross-machine byte identity has not been verified.

Output is `native/foobar-spectrum/package/foo_still_spectrum.dll`, with the original SDK and PFC licenses and this file copied alongside it. `shared-x64.lib` is part of the original foobar2000 SDK and is covered by its SDK notice; the vendored `foobar2000/shared` directory contains no separate license or notice file. The script builds PFC, SDK, component client and the component in four controlled sequential MSBuild invocations. Each invocation disables recursive project builds, uses the fixed `native/foobar-spectrum/build/output` output directory, and has its own `build/obj/<project>` intermediate directory. `SolutionDir` also points inside this build subtree. Project references still resolve and link the already-built libraries from that shared output directory. Only the DLL, SDK license, PFC license and this document are copied from the build output to `package`; no SDK source is edited. Build output/package paths that traverse a reparse point or leave the native component tree are rejected. The script never copies into a foobar2000 profile or `user-components` folder. Distribution/install orchestration is outside this component's build script.

The three referenced SDK project XML files are checked for unexpected imports and build events, commands or filesystem actions before any build. Their explicit user-property imports are redirected using a global `UserRootDir` to `build/empty-msbuild-user/`, which must remain empty before and after the build. Global `ImportDirectoryBuildProps=false` and `ImportDirectoryBuildTargets=false` suppress directory-level customization; standard force/custom import hooks are cleared, and `VCTargetsPath` is fixed to the discovered official toolchain. Compiler/linker environment option overrides are removed only for the child build and restored afterward. Host tool architecture is explicitly x64. Project-reference metadata also assigns each referenced project's intermediate directory because the VC `GetProjectInfoForReference` target performs preparation even when recursive builds are disabled. Explicit link-time code generation matches the official libraries' `/GL` configuration. No SDK sample project or sample post-build deployment is invoked. The exact project paths and global arguments are written to `build/build-plan.json` before MSBuild runs. `-CheckOnly` reports these isolation settings without creating directories or invoking a build.

Official vendored SDK: `vendor/foobar2000-SDK-2026-10-01`, archive size 793738 bytes, SHA-256 `d4c55077336fae81bf8df0259b5b2748fa45ea84132c656ead93eb123cbcdc26`. The original `sdk-license.txt` is retained without editing.

## Verification boundary for this machine

On 2026-11-01, after the leader installed the explicitly authorized official toolchain, all four projects built successfully with zero warnings and zero errors. The final native toolchain was MSVC v143 (tool directory `14.44.35207`, compiler file version `19.44.35229.0`), HostX64/x64, MSBuild `17.14.60.43110`, and Windows SDK `10.0.26100.0` at `C:\Program Files (x86)\Windows Kits\10\`. The exact evaluated paths and build arguments are preserved in the review evidence. An earlier probe correctly reported unavailable before installation; those logs are retained as historical evidence.

Static `dumpbin /headers /exports /dependents` checks confirm an x64 PE32+ DLL with the expected `foobar2000_get_interface` export. Its dependencies are the foobar2000 SDK's `shared.dll`, Microsoft VC runtime/UCRT and standard Windows libraries including BCrypt/Advapi32. Read-only binary inspection also checks the embedded friendly name, version and required component filename strings, and confirms that packaged SDK/PFC licenses are byte-identical to the originals. These static metadata checks do not invoke the SDK metadata service inside a host.

The 16 Node source-contract tests pass and validate safety-critical wiring, declarations and build inputs. Native compilation and static PE checks do not establish host runtime behavior. The DLL has not been loaded or executed here. GUI/foobar2000/Electron launch, audio-device initialization, live playback, pipe integration under foobar2000 and exit-race stress tests were not run. The exact commands, outputs, source/binary hashes and final source/binary archive are retained in `review-evidence/spectrum-20261101/component/`.
