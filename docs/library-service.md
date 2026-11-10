# Local library service

`src/main/library.js` is CommonJS. It exports `createLibraryService`, `AUDIO_EXTENSIONS`, `canonicalPath`, and `trackId`. The service uses `music-metadata@12.3.2` through dynamic import. It never writes audio tags, deletes audio, starts playback, or automatically searches a drive.

Browsing source and actual playback are separate. This service remains the local library only; Apple IDs/results are not inserted here or mapped to same-named local records. Native imports persist before backend access checks. New backend directories can remain pending until an explicit play safely reloads the owned backend; library import itself never stops playback.

The one-time `scripts/seed-library.js` workflow plans a captured real existing-playlist snapshot without writing, then (only with explicit execution) calls this service in a temporary data stage. It reads actual file validity/metadata/covers, verifies every playlist occurrence/order and atomically creates a new `library.json` without replacing an existing one. The source migration retained 12 lists / 324 occurrences / 217 unique valid files and 92 covers. Packaged data is seeded separately; credentials and arbitrary app data are not copied. Runtime no longer needs the original foobar instance or its playlist database.

Create with `createLibraryService({dataDir,onUpdate,shell,supportsSubsongs:true,coverTransform,cueInspector})`. The two optional injected functions are documented in [media import and covers](media-import-and-covers.md); neither grants playback authority. `initialize()` must finish before consumers use the getters. `list()`, `getTrack(id)` and `getTracks(ids)` are synchronous, detached committed snapshots; using `await` on them also works. `getTrack` returns null for an unknown ID. `getTracks` preserves requested order and duplicates, omitting unknown IDs. Legacy callers retain full-snapshot mutation results and `onUpdate(snapshot)` after successful saves.

The desktop uses `createLibraryService({returnDeltas:true,onDelta})`: explicit `initialize()` and `list()` provide current full snapshots, while mutation responses and callbacks contain affected canonical tracks, removals and optional membership/list/folder changes. Snapshot cursors are `eventCursors.library|metadata.{streamId,sequence}`; delta IDs are `library|metadata:<streamId>:<sequence>`. Status-only persistence failures use a same-revision patch. Internal readiness fulfills without retaining the initial full snapshot; it does not clone the whole library on the first delta-mode mutation.

All other service methods are asynchronous:

- `initialize()`, `importFiles(paths)`, `importFolder(path)`, `refresh()`, `remove(ids)`, `reveal(id)`, `close()`.
- `createPlaylist(name)`, `renamePlaylist(id,name)`, `deletePlaylist(id)`.
- `setPlaylistTracks(id,ids)` preserves the exact supplied occurrence order, including duplicates. Unknown IDs are omitted.
- `addPlaylistTracks(id,ids)` appends only identities not already present. It preserves any existing duplicate occurrences.
- `removePlaylistTracks(id,ids)` removes all occurrences of each requested identity.
- `removePlaylistItem(id,index)` removes one occurrence by zero-based index. `movePlaylistItem(id,fromIndex,toIndex)` moves one occurrence to its final zero-based index.
- `importFoobar(snapshot)` imports the bridge's read-only snapshot described below.

## Files and metadata

Track IDs are a deterministic SHA-256 digest of normalized absolute path plus subsong. Windows paths compare without case. Regular imported files default to subsong 0. Explicitly unknown source subsongs remain null and have a separate identity; they are never silently treated as zero. Audio records deduplicate by identity, while saved playlist occurrences do not deduplicate.

Supported import extensions include FLAC, MP3, M4A/M4B/MP4, AAC, WAV, AIFF, Ogg, Opus, WavPack, DSF, DFF, APE, Musepack, WMA, TAK, TTA, AC3, DTS, CAF, ALAC, CUE and ISO. An accepted extension does not promise that either the metadata parser or the actual foobar installation can decode it.

The parser reads title, artist, album, album artist, duration, track/disc number, year, genre, codec, sample rate, bit depth and channels. Unknown properties remain empty strings or null; the only fallback is the actual filename for title. `valid` means that the path currently exists as a regular file. Missing/non-file paths have `valid:false` and an `error`. Metadata failures preserve the filename or actual foobar snapshot fields and report `metadataError`/`error`; an accessible file remains eligible for real foobar decoding. `metadataSource` identifies `filename`, `file`, `cue`, or `foobar2000`. `supported` and `playbackUnsupportedReason` independently express whether the exact selection is available. Direct CUE imports can use an injected read-only backend discovery adapter after strict file/reference preflight; no TRACK number is guessed as a subsong. Without successful discovery they remain explicitly unsupported. ISO containers still need a verified existing foobar entry. Unresolved source subsongs cannot be played. A record tied to an inspected CUE publishes `cueTrack:true`, including an actual backend identity at a referenced audio path with subsong 0; consumers must not apply whole-file lyrics to that selection.

Embedded JPEG, PNG, GIF and WebP covers are identified from their bytes, deduplicated by content hash, and saved below `dataDir/covers`, with a 20 MiB byte admission limit. Embedded art has priority over a finite list of same-directory sidecar names (`cover`, `folder`, `front`, `album`, each with jpg/jpeg/png/webp/gif). Sidecars additionally require readable dimensions within the byte/pixel limits and independent regular files with no linked ancestry. Public URLs remain `still-cover://art/<sha256>.<extension>`; `coverUrl` is the original, and `coverThumbnailUrl`/`coverLargeUrl` request 96/768-pixel maximum edges via the injected processor. Failed/unavailable processing safely falls back to the original URL and does not record a successful derivative recipe. Cached successful variants use source hash, edge, quality and processor version and can be reused after restart. The desktop owner supplies the restricted protocol handler; the library never exposes arbitrary cover paths or tag-provided filenames. Unsupported embedded image types remain an empty cover URL. Audio and source images are opened for reading only.

`importFolder` recursively indexes only that explicitly supplied directory, saves its absolute path in `folders`, and skips child directory/file symlinks and junctions. A realpath visited set prevents loops. `refresh` checks existing records, retains missing entries and their playlist occurrences, and discovers new files only inside remembered explicit folders. Removing a record only removes the index and saved references, never the underlying file. Removed identities are remembered so refresh and startup imports do not resurrect them; an explicit file/folder reimport can restore them.

Unchanged audio files reuse metadata based on size and modification time. One foobar snapshot reads each identity once, and a bounded per-operation cache shares physical container parses across subsongs. Unchanged subsequent source snapshots merge actual source fields without reopening audio. Embedded/audio-tag changes which preserve both size and modification time still require a fresh import after removing the index, or a real filesystem timestamp update. Sidecar candidates are checked independently, so refresh detects additions, replacements (including same-size/same-mtime bytes), renames and removal without reparsing unchanged audio. CUE refresh rechecks the text, references and exact saved verification; changed CUE/reference identity requires discovery again. There is no filesystem watcher. Inaccessible child directories are skipped, while an inaccessible explicitly imported root rejects the import. Discovery and indexing are sequential to avoid opening an unbounded number of files; very large initial imports can take time.

## Existing foobar playlists

The expected bridge payload is:

```js
{
  source: 'foobar2000', scope: 'existing-playlists',
  mediaLibraryEnumeration: false,
  playlists: [{
    id: 'backend-id', name: 'Actual playlist name', ownedByStill: false,
    items: [{path: 'D:\\Music\\album.cue', subsong: 1, supported: true,
      title: 'Actual subsong title', artist: 'Actual artist', duration: 123.4}]
  }]
}
```

Optional `tracks` are also accepted. Item properties use the canonical Track field names. This imports local absolute paths only, including missing paths; network radio URLs are outside this local-file index. `ownedByStill` playlists are skipped, keeping the temporary playback material/queue out of saved user playlists. Entries and imported saved copies carry `source:'foobar2000'` and `sourceScope:'existing-playlists'`; this is not a claim to enumerate foobar's complete media library. The bridge's exact path plus subsong is retained. Actual source fields take precedence over container-wide title/duration for subsong entries; metadata parser support is not required for a verified source entry.

Original foobar playlists are never changed. Each source playlist creates one saved, editable copy with a stable `foobar_...` ID and `sourcePlaylistId`; occurrences and order are preserved. Subsequent startup snapshots can update track metadata and discover new records but do not overwrite the user's saved-copy edits or recreate a deleted copy. Saved playlist playback must pass the full occurrence sequence to the bridge and use an occurrence index when selecting a repeated entry. A track ID alone cannot distinguish two occurrences of the same identity.

## Storage and checks

State is `dataDir/library.json` (schema version 2). Writes use a unique same-directory temporary file, file sync, and atomic rename. Failed saves roll back committed memory and publish a read-only status patch. Invalid user operations do not lock storage. Corrupt JSON/schema/normalization and explicit reset preserve complete original bytes before empty-index replacement; backup or replacement failure leaves the original and reports a read-only fallback. Tracks, folders, saved copies, removal tombstones and imported-copy history survive restarts. There is one service writer per data directory; concurrent external processes editing the same JSON are unsupported.

Cover collection is an explicit closed-state operation. It rechecks committed original/thumbnail/large variant references, retained active/user URLs, managed path/content identity and the current database instance before each deletion. Every published variant is also conservatively retained while the service is open. The normal-shutdown integration admits it only after a successful owned exit and related drains, with a default logical budget of 250 ms and at most 64 deletion admissions. An already-issued physical unlink may outlive that budget: its real lifetime remains tracked, timeout does not claim cancellation or success, and pending work uses the existing read-only recovery path without duplicate collection.

Maintenance-plan `dev`/`ino` values are decimal strings so JSON does not lose 64-bit FileID precision; `bytes` remains a safe Number. Authorization retains the original BigInt witness privately, and no public JSON or IPC payload contains BigInt values. The plan representation alone does not grant deletion authority.

Known corrupt/reset recovery-name families directly under the data root conservatively block all cover GC across restarts, including unfamiliar suffixes, temporary/user-kept names, links or directories in those families. An unreadable/unknown directory also prevents deletion. The guard is rechecked before admission; it neither parses bad JSON nor scans archived directories or changes recovery copies. Orphans may therefore continue occupying space. See [recovery and cache safety](recovery-and-cache-safety.md): moving only the recovery JSON releases this guard but does not archive its images or make them rebuildable. Ordinary refresh can reuse unchanged size/mtime records, so restoring only JSON does not automatically re-extract covers.

Run `node --test tests/library.test.js` and `node --check src/main/library.js`. Tests create real temporary PCM WAV files with RIFF and embedded ID3 tags, verify actual parser output and image bytes, and confirm audio bytes remain unchanged. They also cover persistence, missing/malformed audio, stable Windows IDs, symlink loops, duplicate occurrence order, exact subsong identity, incremental metadata reads, and failed-save rollback. Each fixture cleans up only its own verified temporary directory under `tests`.

Desktop native imports use the complete `AUDIO_EXTENSIONS` set for their file filter. After this service commits the index, main may ask the backend to prepare/check imported locations without starting playback. That IPC snapshot can carry `importReport:{indexedCount,backendPrepared,warnings}`; these diagnostics are not persisted as library records. A backend access rejection never rolls back a successfully saved local index. See [desktop integration](build-and-integration.md) and the [manual setup/restore guide](foobar-install-restore.md).
