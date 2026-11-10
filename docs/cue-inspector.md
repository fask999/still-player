# Isolated CUE metadata discovery

`src/main/cue-inspector.js` discovers the actual CUE locations reported by the
fixed foobar2000/Beefweb runtime. It does not derive a subsong from `TRACK`, assume
subsong zero, copy a user profile, or use the application's playback manager.
The returned items contain the real backend path, subsong and metadata columns.

```js
const inspector = createCueInspector({runtimeRoot, dataDir, enabled: !smokeMode, onProgress});
const result = await inspector.inspect({
  path, references, trackCount, authorizationRoot, encoding, contentHash
}, {signal});
await inspector.close();
```

Construction is lazy and performs no filesystem or process I/O. `inspect` and
`close` are the instance's only methods. The optional `AbortSignal` cancels one
inspection; `close` cancels the active operation, rejects queued operations and
waits for its real lifecycle fences. Disabled/smoke mode never prepares a core.

The request comes from `createCueReader`. The inspector independently rereads the
CUE and all references, checks the encoding, SHA-256, AUDIO count and exact
reference list, and retains the reader's file-identity recheck. Paths must be
canonical absolute regular files without links or hardlinks inside the explicitly
authorized subtree. The CUE limits remain 1 MiB, 99 AUDIO tracks and 32 references.
On Windows, discovery checks the full paths of the CUE, its references and
the isolated core's component destinations before creating the workspace or
opening the native holder. Paths that exceed 259 characters fail with an
actionable message instead of starting an instance that cannot load its plugin.

## Read lease required during native ingestion

Before preparing or launching a metadata profile, the selected application
runtime must supply `src/main/cue-read-lease.js` with this contract:

```js
createCueReadLease({runtimeRoot, request, signal, onLost}) // Promise<lease>
isVerifiedCueReadLease(lease, {request})                 // branded identity check
lease.check()                                          // rejects if no longer held
lease.close()                                          // waits for physical holder exit
```

The holder must acquire verified Windows read handles to the original CUE and
every original reference, denying writes and replacement/deletion, together with
the directory handles needed to keep those authorized names stable. Its brand
must bind the entire request, including exact roots, references and CUE hash.
File and directory identities must be verified before granting the lease; an
unknown identity or incompatible existing writer must fail closed. A shadow CUE
with a different path does not satisfy this contract.

If acquisition fails after creating a holder, its failure must wait for the
exact child close or report `cleanupPending:true` with its retained controller.
The inspector retains that controller and blocks subsequent work and successful
`close`; a pre-READY failure cannot hide an unfinished holder lifetime.

`signal` may cancel acquisition. Once acquired, it must **not** release the
handles automatically when that signal aborts. Cancellation invalidates the
lease brand and `check`, and reports `onLost`, while the native handles remain
held. `onLost` invalidates discovery.
The inspector holds the lease through the metadata Job's actual child exit and
empty-tree proof. It then rechecks the original files and explicitly closes the
holder. A failed Job exit keeps the manager and lease strongly referenced and
blocks future runs. An unproven holder exit also blocks success. A module that is
missing or cannot produce a verified lease yields
`ERR_CUE_INSPECTOR_LEASE_UNAVAILABLE`, before an extractor or metadata Job starts.
Hash checks alone never enable a production success branch.

If a startup fails before HTTP verification, only that manager's successful
close and exact native creation, child-exit and empty-Job observations can
authorize disposal of the failed run's isolated resources. This disposal does
not report a verified discovery or supply any playback release evidence.

The holder manifest at `native/cue-read-lease/bin/runtime-manifest.json` must be
authorized by the application's fourth runtime registry pin,
`cueReadLeaseManifest`. Its fixed `StillCueReadLease.exe` and `NOTICE.txt` pins,
the manifest, and the lease/backend/bootstrap JavaScript sources are included in
the inspector's before/after resource-identity and hash checks. A neighboring
manifest cannot authorize itself.

## Profile and process isolation

Each run creates only `dataDir/cue-indexer/<new UUID>/data`, with its backend at
`data/backend/foobar2000`. No existing workspace or profile is adopted. The
bootstrap must use schema 2 `extract-original-installer`; the interactive
installer branch is rejected. It prepares the pinned original official installer
resources locally, with `musicDirs` set only to this request's authorized root.
The distributed application continues to ship the original setup resource rather
than an expanded portable core.

`runtimeRoot` is a trusted main-process argument. Fixed sibling bootstrap/backend
modules are loaded with `createRequire(runtimeRoot/package.json)`, with their
resolved source paths checked against that root. No live process, fetch or brand
DI is exposed by the inspector. Production passes the installed application
root. A separate non-UI acceptance harness must verify the entire frozen package
before selecting a diagnostic runtime root.

All immutable core files and the exact fresh profile file set are checked before
launch. The manager requires public provenance and its fixed public file list,
refuses an existing matching executable/port owner, and uses `startStopped:false`.
The formal native launcher therefore starts the fresh owned process with
`/hide`, never a pre-identity `/stop`. A verified manager-created session must
match this executable, profile, backend ID, PID, loopback port and authorized
roots before any inspector mutation.

The inspector requires two actual stopped/empty-queue readbacks. It never sends
play, stop, volume, queue, source, client configuration, system media-key, power,
or main-playlist commands. Before each allowed POST it rechecks the formal
manager's process/port ownership, workspace, original input files and read lease.

## Null output and limited RPC

The only eligible output provider is the built-in SDK `output_id_null`,
`EEEB07DE-C2C8-44C2-985C-C85856D96DA1`, declared in the vendored official SDK's
`foobar2000/SDK/output.cpp`. A live Beefweb `output` device must enumerate that
provider plus a valid device GUID, with exactly one matching tuple. The inspector
uses the enumerated device GUID and reads back the same active tuple. A name such
as “Null”, a zero device GUID, a default output or an unknown physical DAC cannot
grant this permission.

The private client permits only bounded metadata/state GETs and three POST forms:

1. Select the verified Null tuple.
2. Create `STILL CUE Indexer [<run UUID>]` with `setCurrent:false` and read back its
   unique identity and empty contents.
3. Add the one original CUE to that shadow playlist with
   `{async:true, replace:false, play:false}`.

It polls the actual expanded playlist with the application's 13 metadata columns.
Two consecutive complete identical pages are required. The number of items must
equal the preflight AUDIO count; every pair must have a real nonnegative integer
subsong and a path equal to the original CUE or an authorized reference. Duplicate
pairs, foreign paths, missing identity/decoding metadata and extra tracks fail.
No synthetic subsong is substituted for an incomplete or unsupported result.

Stopped state, empty queue and the Null tuple are checked throughout. Before
delivery, source resources, immutable isolated code and original media identities
are checked again. `verified:true` is returned only after formal branded child
and Job-tree exit proofs and completion of the read-lease close fence.

## Bounds and cleanup

The main application constructs one inspector under its existing application
single-instance lock, and awaits `close()` before replacing it. This one object
permits at most one active run and 16 accepted active/queued requests. Discovery
has a 60-second deadline; individual RPCs have a 2-second deadline and a 1 MiB
streamed-response cap. Cancellation/deadline prevents late verified delivery and
new mutations. Cleanup can outlast the discovery deadline while waiting for the
actual extractor/Job/holder close; a timeout, missing PID, kill or successful HTTP
response is never substituted for exit evidence.

The cache permits at most four retained entries, 128 MiB, 2,048 inspected tree
entries and 32 directory levels, reserving 32 MiB before each new run. Directory
enumeration itself is streamed and capped. The fixed core plus staged
components must fit that run reservation. Unknown cache entries consume the
quota and are retained.

Only a workspace created by this object can be removed. The in-memory directory
identity and a unique ownership marker must still match. After complete process
exit, the whole tree is inspected for links, hardlinks and unknown file types
before the first removal. Each file/directory identity and ancestry is rechecked
before individual `unlink`/empty `rmdir` calls. There is no recursive `rm`, no
cleanup of prior-process workspaces, and no deletion of source media. Successful
runs remove their own cache so later authorized folders can still be discovered.
Any uncertainty retains the remaining files and produces a bounded failure.

## Verification evidence

`tests/cue-inspector.test.js` uses complete synthetic runtime modules, response
streams and identity brands under the default effect guard. It never runs a
native program, opens a socket, or accesses a real audio device. Tests cover real
reported (deliberately nonsequential) subsong propagation, repeated fresh runs,
quiet/Null/authorization failures, input and resource mutation, unsupported and
duplicate/foreign results, bounded queue/response/cache resources, cancellation,
deadlines, mandatory read leases, late results, and missing process/holder exits.

Task logs are retained under
`review-evidence/20261108-public-release/cue-inspector/`. Fake tests are not
evidence of real foobar2000 decoding, read-lock enforcement, main-instance
continuity, cross-profile playback, GUI behavior or listening quality. Those
non-UI acceptance steps require the separately reviewed native holder and an
explicitly scheduled run using only self-generated CUE/WAV samples. No GUI or
audio-device test is performed by the unit suite.

## Non-UI A/B acceptance runner

`scripts/verify-cue-inspector.js` prints its plan without filesystem or process
effects by default. `--check` requires a reviewed new candidate directory under
this repository's `dist`, plus its exact `--build-sha256`. It checks every package
file against `BUILD-INFO.json`, rejects links/extra files, and requires all four
runtime asset pins and the new inspector/lease modules. Candidate r6 is explicitly
rejected by this runner; its original pinned baseline stays separate and intact.

`--run` additionally requires explicit `--type-id` and `--device-id` for the
approved shared output and verifies the tuple in the new main session before
selecting it. Each run uses a fresh UUID and a short, isolated QA data root.
Directory A contains a self-generated 90-second silent PCM WAV. Directory B
contains another zero WAV and the original two-track 45/45-second CUE. The fresh
owned main backend authorizes only A throughout discovery.

The main player uses the candidate's `createFoobarSessionService` and
`createPlaybackCoordinator`. The CUE import runs through the production library
and inspector, and playback uses the production read-lease guard. During
discovery, bounded read-only snapshots
include every actual playlist item, the queue, active identity, source, output,
roots and Beefweb config identity/hash, with advancing main playback position.
The convenience `librarySnapshot` is deliberately insufficient here because it
omits items in owned playlists.

Only after the indexer and holder have completed their exit fences does the
runner explicitly request the returned second CUE identity. It calls the pure
`prepareLocalPlaybackLifecycle` export of `main.js` through the coordinator's
`beforeStart` hook. The existing pending-root mechanism stops/retires the old
owned main process, applies B, verifies the old child/tree exit, and connects a
new session before playing. It never calls `main.run`, imports Electron, changes
roots directly over HTTP, or substitutes a guessed subsong. Real title, duration,
path/subsong and advancing CUE playback are required.

Cleanup awaits the indexer and the exact current main child/tree. Failed exit
proof retains both the owning objects and CLI process; logging failures and
observer exceptions cannot bypass this retention path. `SIGINT`/`SIGTERM` request
cancellation and fenced cleanup. Results remain in
`cue-inspector/native-runs/<UUID>` and sample data in the ignored
`review-evidence/cue-qa/<UUID>` directory. The successful Windows run verified
main playback continuity during CUE import, exact second-track playback in a
new main session, and all participating exit fences. It used silent fixtures
and shared output. It does not establish installer, UI or exclusive playback
behavior.
