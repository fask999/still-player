# Playback bridge and private backend lifecycle

`src/main/foobar.js` controls the real foobar2000 / Beefweb 0.10 API. It does not decode audio, play browser audio, install components, edit foobar preferences, launch a backend or terminate a process. `src/main/backend.js` separately manages the explicitly assembled private portable backend. Local music uses foobar; an Apple subscription engine is separate and must pass the coordinator's stop/release barriers.

## Bridge interface

Existing methods remain: `initialize`, `getState`, `librarySnapshot`, `play({locations|paths,startIndex})`, `toggle`, `pause`, `stop`, `next`, `previous`, `seek`, `setVolume`, `setOrder`, queue methods, output methods, `audioDetails`, `capabilities`, `restoreInfo`, `close`, `on` and `off`.

Additional methods:

- `prepareLocations(input)` accepts an array, `{locations:[{path,subsong}]}` or `{paths:[string]}`. It resolves/indexes and verifies exact identities without starting playback. Success is `{prepared:true,count,locations:[{path,subsong}]}`. A failure rejects with the actual permission/indexing/subsong error. This operation has its own context and does not cancel or block playback intents.
- `cancelPending()` synchronously advances the playback generation, cancels older reads/verification and returns a promise for **already-dispatched playback control HTTP requests to really settle**. It does not wait for old playlist creation, import, copying or playback verification. It never sends play, pause or stop itself.
- `bindBackendSession(backend.getSession())` associates the bridge with the manager's exact verified owned process session. Main binds after each successful owned startup/restart. The token is an in-process object, not a serialized renderer payload.
- `markBackendExited(exitEvidence)` permanently terminates this bridge only when its bound session/PID/directory/base URL matches an authenticated manager exit proof. It then ends pending HTTP lifetime fences, aborts obsolete network work and publishes `available:false,state:'unavailable',backendExited:true`. It does not claim a stopped HTTP readback or a DAC release measurement. Plain JSON, a different session, port disappearance, a timeout and an unowned process cannot provide this proof.
- `releaseOutput({signal}={})` cancels pending playback, waits for the control fence, sends a real stop and checks stopped readback, then calls the injected `waitForOutputRelease({output,signal})`. It resolves only when that separate measurement returns `{released:true,evidence}`. A stopped state alone is not release proof.
- `cleanupOwnedDecks()` performs one bounded maintenance pass and returns `{removed:[id],retained:[id]}`. It is normally scheduled automatically after operations; callers do not need to run it on every poll.

Main passes exact `{path,subsong}` values resolved from its own library IDs. Repeated occurrences are preserved. An explicitly unknown `subsong:null` is rejected rather than treated as zero. `startIndex` selects the intended occurrence in sequences such as `[A,B,A]`.

## Intent ordering and transport uncertainty

Each play/toggle/pause/stop/next/previous/seek starts a new generation. Old play work rejects with `code:'STILL_CANCELLED'` and cannot submit another play after a new generation takes over. Reads and polling delays can be aborted. An old playlist creation/copy POST is allowed to finish, with its destination protected until the actual response settles; its remaining work checks the generation before it can play.

Only the final playback-control POSTs share a short transport lane. Materialization, metadata scans, deck construction and the progressing-playback verification are outside it. B/stop/pause/seek therefore do not wait for A's slow copy or eight-second verification. A control POST already dispatched to the backend is different: aborting its socket does not revoke a server-side command, so the next control waits for its actual response and body consumption.

A POST deadline reports `STILL_HTTP_TIMEOUT` to its caller but retains the underlying HTTP settlement fence and resource pins. A server which applies an old play *after that deadline* is still ordered before the subsequent confirmed stop or newer play. A control response which never arrives keeps the fence pending. The app must not claim a completed stop/release or start another engine while that fence is unresolved. The separate shutdown exception is a verified exit of that same owned backend process: once the process is gone, its old HTTP work cannot later execute and the bridge can end its connection lifetime.

If the actual control connection is lost, execution order is unknowable. The bridge fails closed with `STILL_TRANSPORT_UNCERTAIN`: subsequent play/control commands and `cancelPending()` reject, potentially referenced decks stay protected, `capabilities().playback` becomes false and state includes `controlUncertain:true` with an explanation. A fresh GET is a point-in-time observation; it cannot prove a disconnected older request was withdrawn. Recovery requires safely exiting the old owned backend and establishing a new process/session with a new bridge instance. No volume/output workaround or retry clears this condition.

Queue mutations have their own ordered lane and also retain actual timed-out POST settlement. A late queue/add cannot overtake a confirmed queue/clear. Queue preparation does not block urgent playback controls.

State reads have monotonically increasing sequence numbers. Both events **and return values** discard an older response once a newer state was accepted, preventing a caller from re-emitting a stale playing snapshot after stop. A 202/204 is never playback proof: play must read back the expected path/subsong in playing state and observe advancing position. Missing/indexing failures, frozen position, HTTP errors and output selection failures stay explicit.

## Source cache, batching and deck ownership

Source metadata is cached by playlist ID, title and item count. Location lookup uses cached path/subsong maps rather than rebuilding a full-library index on each play. Before copying, the requested source indexes are read back in bounded ranges. A same-count reorder invalidates the affected cache and retries resolution once. The completed deck's full occurrence order and subsongs are checked again before play; mismatches reject and invalidate the source caches.

Beefweb's foobar adapter converts selected item indexes to a bit mask (`player_playlists.cpp`, `copyPlaylistItems`). Therefore arbitrary index order and duplicates cannot be assumed to survive a single request. The bridge batches **strictly increasing runs within the same source playlist**, up to 500 indexes per request. `[A,B,A]` is copied as `[A,B]` then `[A]`; reversed or interleaved source sequences split where required. Typical already-ordered playlists use a small number of batch requests.

Each play uses an immutable STILL deck. Cleanup never clears a deck or shifts its item indexes. Only exact `STILL · Playback … [instanceId]` titles belonging to this bridge identity can be removed; renamed lists and other STILL instance identities are preserved. Identity is persisted before creation. Pending creations are protected by unique title even before their returned ID is known. Timed-out copies and controls retain pins until actual settlement.

Before each deletion, cleanup rereads active-item and queue references and checks its own operation pins and exact title. A stopped backend's remaining active-item reference is conservatively protected too. The persistent import/queue source store is never cleaned by deck maintenance. The default retains two additional unreferenced decks, plus all active/queued/pending decks; each pass removes at most four (configurable 1–10). More passes are scheduled when needed. Playback/source scans skip historical STILL deck items, so accumulated old decks do not cause repeated history-item scans. Original user lists and backend queue entries are never edited by cleanup. Concurrent external user edits are outside the bridge's transaction model; the API does not offer an atomic queue-check-and-delete operation.

## Path permissions and native imports

New paths are loaded only through Beefweb's permitted music roots, using `{async:true,replace:false,play:false}` into STILL's source store, followed by exact path/subsong readback. Empty `GET /browser/roots` rejects before a mutating request and names the required directory/configuration (`musicDirs` is an array of absolute directory strings). Empty roots are re-read on retry, so a manual correction is not held in a negative cache. A genuine 403 remains visible with the real backend response and configured-root diagnostics; it does not trigger a CLI fallback.

Existing playlist entries can still be copied even when Beefweb exposes no filesystem roots. The basic `/add` CLI cannot name an immutable playlist ID and is affected by Shell Integration target preferences; it is intentionally unused. Neither a denied import nor a backend failure causes component installation, original-profile changes or an alternative local decoder.

For the private bundle, native import first calls `backend.preparePaths({paths,deferRestart:true})`. This only records pending roots in memory. Import does not stop music, write backend configuration or restart the backend. Main reports pending/restart status while retaining the indexed library. At the next explicit play requiring a reload, the coordinator cancels older work, waits for the true control fence, confirms stop, then calls `backend.ensureStarted({paths,allowRestart:true,signal})`. Only the private profile and this manager's own process may be reloaded.

## Backend manager interface

```js
const backend = createBackendManager({
  backendDir: path.join(runtimeRoot, 'backend', 'foobar2000'),
  probePath: path.join(appResourceRoot, 'scripts', 'foobar-coreaudio-probe.exe')
});
const descriptor = await backend.initialize({start: true});
const foobar = createFoobarService({
  foobarDir: descriptor.foobarDir,
  baseUrl: descriptor.baseUrl,
  dataDir,
  pollIntervalMs: 0,
  waitForOutputRelease: args => backend.waitForOutputRelease(args)
});
if (backend.getSession()) foobar.bindBackendSession(backend.getSession());
```

`initialize({start:true}={})` / `ensureStarted(options)` verifies the private manifest/configuration, exact executable and listening PID, then reuses or starts only that private installation with `/hide`. Ready requires the real Beefweb version and configured music roots to read back. A different port owner, non-loopback listener, modified immutable file or private process without a ready listener rejects rather than attaching to or starting another instance. `initialize({start:false})` is read-only and returns an unavailable descriptor on failure; smoke and explicit external diagnostic overrides use this mode.

`getInfo()` is synchronous and returns `{available,managed,owned,pid,foobarDir,baseUrl,status,error,backendId,musicDirs,pendingRoots,restartRequired,privateUseOnly,originalProfileModified:false}`. `preparePaths({paths,deferRestart:true})` returns `{prepared,pending,restartRequired,configuredRoots,pendingRoots}`. It is a trusted main-process API, fed by the native picker or library IDs; it is not an IPC that accepts arbitrary renderer paths. New roots arriving during a configuration write remain pending. New startup requests' paths are not discarded.

`ensureStarted({paths,allowRestart:true,signal})` can apply pending directories only after a stopped readback and only to a process this manager started. Existing reused instances are not exited for a reload. A nonempty or unreadable backend queue also blocks reload, preserving its item references instead of implicitly losing them on process exit. Signal checks occur after asynchronous reads and before exit/config publication/spawn; cancelled old preparations cannot subsequently spawn or publish another playback intent. An already-dispatched `/exit` cannot be revoked and remains a lifecycle barrier before a replacement can start.

`getSession()` returns an authenticated token only after the exact owned PID, private path, listening port and API readback were verified. `close()` exits only a process this manager personally started after checking that identity. It dispatches the original unmodified binary's `/exit` and observes the process independently of the CLI response. An owned child-process exit handle or a separate exact-PID query proving absence can supply `exitEvidence`; absence from an executable-filtered list alone cannot. It never force-kills or exits the user's original installation and does not exit a merely reused instance. A failed close returns an error with ownership retained and permits a later explicit user quit attempt; it does not automatically retry `/exit`. Normal lifecycle does not write startup volume, choose a fallback output, alter DSP or auto-play an audio file.

Shutdown must not await an unresolved HTTP fence before allowing the owned backend to exit:

```js
const coordinatorDone = coordinator.close(); // synchronously cancel; observe rejection immediately
coordinatorDone.catch(() => {});
const result = await backend.close();         // independent, bounded graceful-exit verification
if (result.exitEvidence) foobar.markBackendExited(result.exitEvidence);
await coordinatorDone;
await foobar.close();
```

If the owned process remains alive or its identity/exit cannot be proved, backend close rejects and no bridge fence is discarded. Main keeps or restores a visible error window and cannot report a successful shutdown. A successful process-exit proof is the causal endpoint for pending HTTP; it is not the shared/exclusive CoreAudio proof required for switching to another live engine. The old bridge remains disposed and must not be reused for a new process.

## Measured cross-engine handoff

`backend.waitForOutputRelease({output,endpointId?,timeoutMs=2500,signal})` runs the fixed CoreAudio probe in `shared` mode. Shared `IAudioClient.Initialize` succeeding on the exact selected endpoint after local stop establishes that an exclusive owner is no longer preventing shared access at that time. The probe process has exited and released its COM handles before success is returned. ASIO/default/ambiguous device IDs cannot be silently substituted.

`backend.waitForExclusiveAccess({output,endpointId?,timeoutMs=2500,signal})` runs `exclusive-check 48000 32` for the reverse handoff. This private build uses 48 kHz / 32-bit / stereo PCM only as the no-Start availability validation format. It requires process exit 0, matching endpoint and requested format, `IsFormatSupported` S_OK, successful exclusive Initialize, `ready:true`, `released:true` and `startCalled:false`. Unsupported or mismatched format readback rejects immediately, without another format or device fallback. Only DEVICE_IN_USE following the exact supported-format preflight is retried within the bound. The tool performs no audio Start and releases immediately. Evidence includes `validationFormat:{sampleRate:48000,bits:32,channels:2}` and `actualDacRate:null`.

The DX1 endpoint's real [support matrix](../scripts/foobar-evidence/acceptance-1793332191087/format-support-matrix.json) reports 48 kHz/24-bit Extensible PCM as `0x88890008` and 48 kHz/32-bit Extensible PCM as S_OK. The follow-up [exclusive-check step](../scripts/foobar-evidence/acceptance-1793332324229/result.json), named `coreAudio:exclusive-check:48000`, records explicit 32-bit preflight S_OK, Initialize S_OK, `ready/released:true`, and `startCalled:false`; its source fixture remains 16-bit and `actualDacRate` remains null. These individual measurements support the validation-format choice; they are not a claim that every step of that acceptance run passed. The validation container does not describe the track's bit depth, foobar's configured output conversion or the DAC's actual received format. No foobar output, DSP, volume or source parameters are changed by this check.

The 32-bit source adaptation passed `node --test tests/backend.test.js tests/foobar-shutdown.test.js` (**23/23**), both changed JavaScript syntax checks, and `node scripts/build.js`. Its fixture rejects 16/24-bit readback, unsupported/non-S_OK preflight, failed Initialize, incomplete release and nonzero success exits without fallback; it also keeps DAC rate unknown and verifies that no foobar request is issued. The full repository suite was not rerun for this bounded adaptation. The running V1 package was neither modified nor restarted.

Both return `{released:true,evidence}` only with their stated measurement. Browsing a Local/Apple source tab calls neither method. The playback coordinator performs these barriers only for explicit cross-engine playback. The probe executable and its C# source are packaged app assets; they are not changes to foobar's binary and are not in the reviewed 106-file backend seed manifest.

## Recorded checks and remaining integration evidence

On 2026-10-30, relevant backend/bridge tests passed, including delayed A→B/stop/pause/seek, backend application of timed-out old play, lost-socket fail-closed behavior, same-count source edits, duplicate/subsong order, queue-reference lifetime, pending-root write races and physical-probe schema validation. Shutdown fixtures additionally hold a loopback play response while the simulated backend is playing: only an authenticated matching owned-process exit releases coordinator/bridge disposal; a live process, forged evidence and an old session cannot. The final repository run passed **224 tests**; syntax/completeness/asset build checks passed. Backend/bridge tests use HTTP fixtures, fake process adapters, fake executable bytes and real temporary SQLite files; they do not launch a real backend or touch a device. Fixture HTTP ports are selected above legacy browser-reserved ranges after an ephemeral-port `bad port` failure was observed.

The one authorized private assembly is recorded in `docs/evidence/backend-private-reviewed-manifest-20261030.json` and `backend-private-copy-verification-20261030.json`: 106 files, 100 immutable hashes verified, consistent read-only SQLite snapshot, original playlist file bytes unchanged, and all 159 original backup records matching their fixed manifest. This assembly did not start the backend. Real hidden startup, missing-EsLyric-panel behavior, same-machine process isolation, real DAC release and real playback are acceptance checks for the sole audio tester after explicit authorization. The observed original UI module was `foo_ui_std.dll` with EsLyric, not a verified Columns UI installation; no guessed UI GUID was written.
