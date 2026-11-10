# Media import and local covers

This document describes the library-side contract added on 2026-11-08. Library verification uses synthetic fixtures. The leader also completed a CEO-approved non-UI probe of the production Electron `nativeImage` adapter, described below. Main-process injection and real foobar CUE discovery remain separate, incomplete integration work. Passing either a library fixture or the image-adapter probe does not establish that a running native backend can inspect a particular CUE. These checks use no GUI, real music, account, audio device or playback.

## Constructor and DTO

```js
const library = createLibraryService({
  dataDir,
  // Optional main-process nativeImage adapter; no new native dependency.
  coverTransform: async (bytes, {maxEdge, quality}) => transformedBytesOrNull,
  // Optional backend adapter; it must not play, select a source or modify a queue.
  cueInspector: async request => ({verified: true, items: actualBackendItems}),
});
```

`coverTransform` receives a copy of the source bytes and `{maxEdge:96|768,quality:82}`. It may return a Buffer/Uint8Array, `null`, or reject. A successful output must have recognized JPEG/PNG/GIF/WebP bytes and parseable positive dimensions no larger than the requested edge; outputs above 8 MiB are refused. The adapter must not modify the source file. The versioned recipe is currently version 1; changing the processing algorithm/contract requires bumping that version.

Tracks retain `coverUrl` for the content-addressed original and additionally expose `coverThumbnailUrl`, `coverLargeUrl` and `coverSource:'embedded'|'sidecar'|''`. Each URL uses the existing restricted `still-cover://art/<sha256>.<jpg|png|gif|webp>` route. Thumbnail and large URLs can equal the original when it already fits, the processor is unavailable, dimensions are unsupported or processing fails. Those fallback URLs are not evidence that an image was resized. No random query parameters or expanded protocol paths are introduced.

Only records with a saved inspected CUE association expose `cueTrack:true`. The identity can be the CUE path or a referenced audio path, including subsong 0. This flag lets lyrics and other consumers avoid treating a CUE segment as the whole physical audio file. Private CUE association/authorization paths and cache recipes are omitted from public DTOs. Existing foobar identities keep their original `source:'foobar2000'` and `sourceScope:'existing-playlists'`; a newly verified direct CUE record uses `source:'cue'`, `sourceScope:'explicit-import'` and CUE metadata. The library never changes the browsing or player source.

## Sidecar admission and refresh

Embedded art has priority. With no embedded art, only the audio file's own directory is checked, in this order: `cover`, `folder`, `front`, `album`; for each basename, `jpg`, `jpeg`, `png`, `webp`, `gif`. These are literal lowercase names (Windows filesystem matching is case-insensitive). No directory-wide image search, parent-directory search, network lookup or tag-supplied filename is used. The actual bytes determine the saved format, so PNG bytes in `cover.jpg` produce a `.png` cache URL. SVG and unknown formats are refused.

Sources are at most 20 MiB. New sidecars require readable dimensions, maximum edge 16384 and at most 40×1024×1024 pixels. Unknown/truncated dimension headers and images above these pixel limits are refused before the processor and before publishing a sidecar URL. PNG IHDR, JPEG SOF, GIF logical-screen and WebP VP8/VP8L/VP8X dimensions are inspected with bounded parsing. This is format/header admission, not a claim that every compressed payload is fully decodable. The native decoder can still refuse it.

Sidecar and CUE file reads reject symlinks/junctions in every directory ancestor, linked final paths and files with multiple hardlinks. They use finite positional reads, read-only open flags and exact file identity/size/mtime/ctime checks before and after reading. CUE references receive the same regular-file/ancestry checks. These checks do not claim protection against a privileged actor replacing ancestor directories between filesystem syscalls.

Embedded extraction also has a 20 MiB input limit. Existing recognized embedded/original URLs remain compatible even when their dimensions cannot be parsed; unknown/oversized dimensions never enter `coverTransform`. This compatibility fallback can still return the original embedded URL, so the limits on newly admitted sidecars are stricter than the historical embedded display contract.

Refresh checks sidecar bytes independently of the audio size/mtime fast path. Addition, content replacement, rename to another admitted name and removal are detected even when the audio file is unchanged and the sidecar preserves its size/mtime. There is no filesystem watcher. The original audio parser still reuses unchanged audio size/mtime, so embedded/tag changes preserving both properties retain the documented historical limitation.

Successful derivative recipes persist privately with source SHA-256, maximum edge, quality and processing version. On restart, the library verifies the referenced cache bytes/hash and dimensions before reuse. A changed source hash cannot reuse another source's recipe. In-memory derivative work is bounded to 32 recipe keys. Original bytes are retained separately and never overwritten by resized output.

## CUE preflight and backend proof

An explicit file import permits only same-directory CUE references. An explicit folder import permits references inside that selected root's subtree. Relative `..` components are rejected even if they would return inside the selected root. Absolute paths outside the authorization root, drive-relative/device/ADS syntax, non-audio extensions, links and missing references are rejected. No reference file is opened as audio during preflight; only its bounded metadata/identity is inspected. The backend adapter must limit native ingestion to the admitted CUE and references.

CUE text is at most 1 MiB, each line at most 8192 characters, with at most 32 distinct FILE references and 99 ordered unique AUDIO tracks. Strict UTF-8 is tried first, UTF-16LE/BE requires a BOM, and non-BOM invalid UTF-8 can fall back to strict GB18030 (including GBK-compatible text). Invalid/control bytes and Unicode line-separator characters are rejected. CRLF, CR and LF are all parsed as line endings, so a FILE directive cannot hide after a bare CR.

The directive allowlist is REM, CATALOG, FILE, FLAGS, INDEX, ISRC, PERFORMER, POSTGAP, PREGAP, SONGWRITER, TITLE and TRACK. CDTEXTFILE, INCLUDE and unknown directives are refused to avoid native reads of unapproved files. FILE types are WAVE, MP3, AIFF or FLAC, with an explicit audio-extension allowlist. Unsupported encodings/grammar remain unsupported; parser acceptance is not native decode proof.

The adapter receives this exact data-only request:

```js
{
  path: 'absolute selected album.cue',
  references: ['absolute preflight-approved audio path'],
  trackCount: 2,
  authorizationRoot: 'absolute selected folder, or the CUE directory',
  encoding: 'utf-8', // or utf-16le, utf-16be, gb18030
  contentHash: '64 lowercase hex SHA-256 of original CUE bytes',
}
```

It returns `{verified:true,items:[{path,subsong,supported:true,title?,artist?,album?,duration?,...}]}` only after actual backend readback. The returned count must equal `trackCount`. Every item path must be the exact CUE path or one of the admitted reference paths; every subsong must be a non-negative safe integer, every item explicitly supported, and every path+subsong identity unique. The library does not derive a subsong from TRACK number, item position, CUE timestamps or a filename. The CUE bytes and all reference identities are checked again after discovery and after metadata/cover preparation before the atomic library commit.

The backend capability must discover unknown exact identities. Existing `prepareLocations` can only validate identities already supplied by its caller and therefore cannot substitute for CUE discovery. The adapter must neither start playback, change a user queue/playlist, switch source nor restart a playing backend. If a safe native discovery facility is unavailable, it must reject or return an unverified result. Main/backend integration is responsible for honoring the supplied encoding and refusing discovery when it cannot establish safe ingestion/readback.

Absent/failed/partial/foreign/duplicate/unverified discovery produces an explicitly unsupported CUE record; an accessible regular CUE remains `valid:true`. It never produces invented split-track records. Previously imported existing foobar entries keep their original identities and source; retaining those entries does not mean that a new direct CUE discovery succeeded.

Refresh redoes CUE/reference preflight. Saved exact verification can be reused only while the CUE hash, reference identities and track count still agree. Removed identities remain tombstoned during refresh, while surviving verified identities can remain available without a discovery adapter. An explicit reimport with a partial saved set performs discovery again so it can restore removed exact identities. Changed CUE/reference state without usable discovery becomes unsupported. Existing saved playlist occurrences are retained when their tracks become unsupported or missing.

## Persistence, GC and checks

Library changes remain one atomic library transaction. A failed `library.json` commit restores published records, order, playlists and tombstones and publishes the existing read-only status. Cache files already created by the failed operation can become ordinary managed orphans; failure never deletes source audio/images or recovery copies.

Original, thumbnail, large and private successful-recipe URLs all enter committed cover references. Every published variant is retained while the service is open. Normal shutdown collection retains its existing owned-exit/drain/deadline/maxDeletes requirements and exact private identity/database checks. Known corrupt/reset recovery-name families still conservatively block all cover collection; adding variants does not broaden any deletion authority. See [recovery and cache safety](recovery-and-cache-safety.md).

Library verification commands (no GUI):

```powershell
node --test tests/library-media-import.test.js tests/library.test.js tests/library-covers.test.js tests/library-delta.test.js tests/library-recovery.test.js
node node_modules/eslint/bin/eslint.js src/main/library.js src/main/library-metadata.js src/main/library-storage.js src/main/local-covers.js src/main/cue-import.js src/main/media-file-safety.js tests/library-media-import.test.js --max-warnings=0
```

The 2026-11-08 library regression run passed 118/118 tests, including source read-only behavior, sidecar changes, transform fallback, cross-restart recipe reuse, exact CUE identities, encoding/traversal/CR/CDTEXTFILE/link restrictions, tombstones, rollback and all existing recovery/GC checks. Complete library logs are under `review-evidence/20261108-feature-media/library-*`.

The leader separately ran the CEO-approved, non-UI Electron 45.1.0 probe against production `createNativeCoverTransform(nativeImage)`. A self-authored 1200×800 transparent PNG produced 96×64 and 768×512 variants; actual native re-decode confirmed those dimensions and preserved alpha, and the source SHA-256 remained unchanged. The JPEG branch also produced a re-decodable 96×64 result at quality 78 without changing its source; malformed/truncated image bytes, excessive dimensions and an invalid edge returned `null`. Evidence: [result JSON](../review-evidence/20261108-feature-media/native-cover-probe-30a78d58-068a-467c-b39b-3f396aec872e/result.json), [stdout](../review-evidence/20261108-feature-media/native-cover-probe-stdout.log), and [probe script](../review-evidence/20261108-feature-media/native-cover-transform-probe.cjs). The probe created no BrowserWindow/webContents and used no audio. It establishes the adapter behavior for those fixtures; it is not GUI/screenshot acceptance. Main injection and real CUE discovery are still incomplete, so this adapter result does not establish complete product behavior.
