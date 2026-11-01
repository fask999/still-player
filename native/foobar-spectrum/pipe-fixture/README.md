# Real Win32 pipe fixture

Test-only transport fixture; never installed or packaged as a player component. It mechanically embeds accepted production encoder, security/I/O and pipe-loop fragments, then supplies fixed synthetic bands for a fictional track. It executes neither SDK/FFT/audio work nor a foobar2000 host.

The leader's single separately approved opt-in run passed on 2026-11-01: Node 1/1, 1423 ms scenario. It verified real pipe reads through the unchanged production reader and actual client, paused/no-data clearing, recovery, OS-server-PID mismatch rejection despite JSON claiming the expected PID, normal server disappearance and exact owned-process exits. All production input hashes remained unchanged.

Server A/B and the direct reader exited normally with code 0. The client helper exited by SIGTERM from the existing production `dispose()` behavior (stdin EOF then immediate owned-child kill); no graceful exit is claimed for it. There was no harness fallback kill and every owned child had an observed final close.

Backend WeakSet branding uses all-injected fake spawn/fetch/system-inspection/execFile behavior and fake executable bytes in an isolated temporary directory. That is explicit branding simulation, not genuine backend verification. The reader, client, OS pipe and embedded production fragments are real. No backend executable, GUI or audio device was started.

See [PLAN.md](PLAN.md) for argv/PID binding, source identity, cleanup and limits. The exact execution command/log, child records, input and compiled hashes, extraction manifest, PE checks and independent reviews are in `review-evidence/spectrum-20261101/real-pipe/`.

Importing the integration test or running the ordinary test suite starts nothing from this fixture: `tests/spectrum-pipe.integration.test.js` skips unless `STILL_SPECTRUM_REAL_PIPE_FIXTURE=1` is explicitly supplied. A repeat native run requires a new dispatcher instruction; this recorded passing run is complete.

This is transport/lifecycle evidence only. It does not validate real SDK component loading, PCM acquisition, DSP mathematics, playback callbacks, host exit races, device formats or audible output. No production revision was needed or made.
