# Test-only real Win32 spectrum pipe plan and recorded result

Status: the leader performed the separately approved single opt-in run on 2026-11-01. It passed Node 1/1, with a 1423 ms actual scenario and no cleanup fallback. This file retains the reviewed procedure below; the pre-execution plan snapshot remains in `review-evidence/spectrum-20261101/real-pipe/plan.md`. No repeat run is requested or implied. See the recorded result section at the end.

## Exact production boundary

Real code/data path under test: extracted production `serialize_snapshot` and `Runtime::pipe_loop` → a real Win32 local named pipe → the unchanged packaged `StillSpectrumReader.exe` → the unchanged `src/main/spectrum-client.js` factory and cache. The server's state adapter supplies fixed synthetic bands and `C:\__STILL_PIPE_FIXTURE__\tone.fixture`; it never reads that path or any media. It does not call FFT, instantiate an SDK service, decode, play, capture, enumerate devices/windows, initialize audio, launch a GUI, or load `foo_still_spectrum.dll`/`shared.dll`.

The standard-library-only `dsp.hpp` is included for `FrameAnalysis`/`Band` types; no analyzer function is called. Fixed 48 log bands use 48000 Hz, 4096 frames, two channels, -24 dBFS where a real bin center belongs to a band and -100 dBFS for empty bands. Timestamp/sequence updates exist solely to satisfy the freshness protocol; these are not measured PCM values.

`extract.js` checks `accepted-inputs.json`, the current accepted `delivery-manifest.json`, and the accepted component source hashes before generating or compiling. At execution, the JS harness rechecks all accepted source/package bytes and all compiled fixture artifacts before creating any child. It checks production byte identity again after cleanup. No accepted production source, DLL, reader, manifest, backend profile or dist artifact is edited.

Four complete production fragments are embedded byte-for-byte, each with unique start/end markers, byte offsets, line number and SHA-256 in `generated/extraction-manifest.json`:

| Fragment | Start marker | End marker (excluded) |
| --- | --- | --- |
| Types/constants | `using Clock = std::chrono::steady_clock;` | `struct SampleJob {` |
| Encoder | `std::string json_string(` | newline + `class Runtime;` |
| DACL/async I/O | `class PipeSecurity {` | newline + `class Runtime :` |
| Complete pipe loop | `    void pipe_loop() noexcept {` | newline + `    const std::string session_;` |

This reuses the actual same-user + SYSTEM DACL, process-token SID use for that ACL only, remote rejection, first-instance flag, outbound-only pipe, connect/write deadline, cancellation drain and bounded 50 ms output drain. No user-account files or credentials are read, and no SID is logged. The adapter adds only fixture state, stdin controls and a self-lifetime deadline. It does not include the entire production component translation unit or any SDK/global registration.

## Build and static checks already performed

Build command: `native/foobar-spectrum/pipe-fixture/build-fixture.ps1`. It invokes existing MSVC v143 HostX64/x64 using fixed native fixture `OutDir`/`IntDir`, an empty `UserRootDir`, disabled directory imports and cleared standard custom-import hooks. It installs nothing. The exact executable/argv are recorded in `review-evidence/spectrum-20261101/real-pipe/build-plan.json`.

The build succeeded with zero warnings/errors. `dumpbin /headers`, `/exports` and `/dependents` confirm an x64 console EXE with only Advapi32/Kernel32, VC runtime and UCRT imports; no `shared.dll`, foobar2000 or media/GUI dependency is linked. Build output stays under `pipe-fixture/build/`; no production packaging step runs.

Compiled fixture: `native/foobar-spectrum/pipe-fixture/build/bin/StillSpectrumPipeFixture.exe`, 218112 bytes. Its reviewed SHA-256 and the exact generated TU/test/generator/template/build/pin hashes are in `compiled-manifest.json`. The default `node --test tests/spectrum-pipe.integration.test.js` check was run with the opt-in flag explicitly disabled: one test skipped, no fixture or reader launch. Syntax checks and static fragment byte-identity checks passed.

## Authorized run command, only after dispatcher approval

```powershell
$env:STILL_SPECTRUM_REAL_PIPE_FIXTURE = '1'
node --test tests/spectrum-pipe.integration.test.js
```

Only this explicit flag enables native child creation. Ordinary test runs skip. The Node harness is the existing Node runtime; the fixture and production reader are console children with `windowsHide:true`, `shell:false`, no detachment. Each returned child object is recorded with its exact executable, argv, PID, spawn time, stdin-end calls, kill calls and final observed `close` code/signal. No `process.pid + 1`, guessed PID, process enumeration, `taskkill`, PID-based kill, arbitrary executable or real backend PID is used.

All executable paths below are absolute at runtime, resolved inside this workspace. `A`/`B` below denote actual `child.pid` values returned from the corresponding harness spawn, never constants.

| Step | Exact executable/argv or operation | Proof / assertion |
| --- | --- | --- |
| 1 | Fixture EXE `['--self']` → A | Its endpoint uses `GetCurrentProcessId()`. Wait for a fixture-only startup line identifying `pid === targetPid === A`. |
| 2 | Packaged production reader `['--pid', String(A), '--interval-ms', '50']` | A real connection must yield a running frame with OS-verified `serverPid === A`, matching fictional track and 48 bands. |
| 3 | End only that direct reader's stdin | Observe exact reader exit code 0 and null signal within 2800 ms; no kill is allowed for a passing direct-EOF case. |
| 4 | Brand-only backend simulation in an isolated temporary fixture directory | Create fake foobar bytes/config/manifest, then call the real `createBackendManager` with **all** spawn/fetch/inspectSystem/execFile hooks injected. Fake spawn returns an EventEmitter carrying owned PID A; it never launches the fake file. This reaches the production WeakSet brand without exporting or bypassing it. It is explicitly **not genuine backend validation**, no socket/Beefweb/device access. |
| 5 | Actual `createSpectrumClient`, spawn wrapper recording then delegating to `nativeSpawn` | Production client itself selects only packaged reader `['--pid', String(A), '--interval-ms', '50']`. The wrapper does not fabricate or modify stdout/read streams. With the fixed playing context, wait for actual client running/48 bands. |
| 6 | Send A `pause\n`; then `resume\n` | The context stays playing, so native paused output must clear client bands and rates; real running output must restore them. |
| 7 | Send A `nodata\n`; then `resume\n` | Native unavailable/no-pcm must clear the actual client; running output must restore it again. |
| 8 | Send A `hold\n` | A joins its real production pipe worker and acknowledges `held`; its process remains live but the endpoint is closed. |
| 9 | Fixture EXE `['--spoof-owned-fixture-pid', String(A), '--expect-fixture-exe', FIXTURE_EXE]` → B | B queries **only explicit owned A** with `PROCESS_QUERY_LIMITED_INFORMATION`, verifies A is still active and its image path equals this exact fixture EXE. B then binds A's name, while the OS server PID is B. The adapter intentionally passes A as production serializer `backendPid`, so JSON also claims A. This is a substantive kernel-identity regression: without kernel validation, otherwise-valid JSON/context would pass. |
| 10 | Actual production reader remains bound to A | Require `server-pid-mismatch` and empty client bands; record expected A, actual B and forged JSON claim A. No fabricated reader envelope is injected. |
| 11 | Send B `quit\n`; observe B exit 0/null; send A `resume\n` | The correct OS server identity A must restore running output. |
| 12 | Send A `quit\n`; observe A exit 0/null | The production reader sees EOF/disappearance, then actual client becomes component-not-connected with empty bands/rates. |
| 13 | Call unchanged `client.dispose()` | Production code does stdin.end plus immediate child.kill for **its own returned reader**. Record the actual exit code/signal and kill call without claiming graceful EOF. This known production disposal termination is distinct from a harness timeout fallback. |

No backend executable is ever launched, including the temporary fake one. Manager cleanup calls only the injected fake execFile, which emits the simulated EventEmitter's exit; it never stops A or any OS process. The temporary directory's fixed prefix is checked before recursive removal. All real fixture/reader children remain separately owned and tracked.

## Limits and cleanup

Each phase has at most 2800 ms. The main phase deadline is 20 s; each fixture also self-exits with failure code 124 at 25 s, and the harness has a 26 s per-child lifetime guard. Each child must be observed closed in less than 30 s. The Node test timeout is 40 s, below the 45 s total cap. Expected runtime is a few seconds.

Cleanup always runs in `finally`, disposes the actual client, then drains exact owned children in reverse order. Servers get `quit\n` followed by stdin EOF; readers get stdin EOF. It waits 1800 ms for a graceful close. Only if that times out may it invoke the saved `kill('SIGKILL')` on that exact child object, record `harnessFallback:true`, mark the test **failed**, and wait at most another 1000 ms for the exact final close code/signal. Concurrent cleanup is coalesced per child. Any unobserved close, timeout, overlong lifetime, protocol parse error, nonzero A/B/direct-reader exit or production byte change fails the test. No kill operation targets a numeric PID or process not returned to this harness.

Passing direct reader EOF and A/B quit must be normal code-0 exits. The actual client's existing immediate termination is recorded honestly and may produce a signal/nonzero exit; that alone is not relabeled as a harness failure or graceful exit. Any harness-required fallback kill is always a failure.

Runtime evidence is `review-evidence/spectrum-20261101/real-pipe/real-pipe-result.json`, including every child's exact path/argv/PID/exit and all semantic phase results. The leader's single approved run produced it; no further native execution was performed for this documentation update. Any discovered production defect must be reported to the leader; this test-only task does not authorize changing accepted production bytes.

## What this cannot establish

This test verifies the real OS pipe, kernel-server-PID rejection, production encoder/reader/client protocol and owned process lifecycle. It does not establish real foobar2000 SDK loading, PCM acquisition, FFT mathematics, playback-event accuracy, audio-thread behavior, device rates, audible output or host shutdown behavior. Backend WeakSet branding is intentionally simulated, not a new claim of genuine backend verification.

## Recorded single-run result

The leader ran the reviewed opt-in command once at `2026-11-01T03:57:13.904Z`. Node reported 1/1 passed; the actual scenario ended at `03:57:15.327Z` (1423 ms). Running frames, native paused/no-data clearing, both recoveries, real kernel-PID mismatch rejection with JSON falsely claiming A, correct-PID recovery and server-exit clearing all passed. The result reports `productionUnchanged:true`, `failures:[]`, and no harness fallback or orphaned child.

| Exact owned process | PID | Observed close | Lifetime |
| --- | ---: | --- | ---: |
| Fixture server A | 28032 | code 0, signal null | 1203 ms |
| Direct production reader | 8036 | code 0, signal null after stdin EOF | 211 ms |
| Actual client-owned production reader | 35036 | code null, SIGTERM | 1142 ms |
| Fixture server B | 40184 | code 0, signal null | 56 ms |

B's true kernel PID was 40184 while its endpoint and adapter-supplied JSON PID claimed still-live owned A (28032). The actual production reader emitted `server-pid-mismatch`, and actual client bands/rates were empty. The client-owned reader's SIGTERM came from the unchanged production `dispose()` implementation's single immediate kill after stdin EOF; it is not a graceful-exit claim or a harness timeout fallback. A, B and the direct reader needed no kill.

The fake backend spawn and fake execFile were only injected EventEmitter operations; no fake or real foobar2000 executable was run. No production source, DLL, reader, manifest, profile, backend or dist artifact changed. Independent final review of the recorded run is owned by the leader/Reviewer; this documentation adds no runtime acceptance claims beyond the recorded fixture boundary.
