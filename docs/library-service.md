# Local library service

`src/main/library.js` is CommonJS. It exports `createLibraryService`, `AUDIO_EXTENSIONS`, `canonicalPath`, and `trackId`. The service uses `music-metadata@12.3.2` through dynamic import. It never writes audio tags, deletes audio, starts playback, or automatically searches a drive.

Browsing source and actual playback are separate. This service remains the local library only; Apple IDs/results are not inserted here or mapped to same-named local records. Native imports persist before backend access checks. New backend directories can remain pending until an explicit play safely reloads the owned backend; library import itself never stops playback.

The one-time `scripts/seed-library.js` workflow plans a captured real existing-playlist snapshot without writing, then (only with explicit execution) calls this service in a temporary data stage. It reads actual file validity/metadata/covers, verifies every playlist occurrence/order and atomically creates a new `library.json` without replacing an existing one. The source migration retained 12 lists / 324 occurrences / 217 unique valid files and 92 covers. Packaged data is seeded separately; credentials and arbitrary app data are not copied. Runtime no longer needs the original foobar instance or its playlist database.

Create with `createLibraryService({dataDir,onUpdate,shell,supportsSubsongs:true})`. `initialize()` must finish before consumers use the getters. `list()`, `getTrack(id)` and `getTracks(ids)` are synchronous, detached committed snapshots; using `await` on them also works. `getTrack` returns null for an unknown ID. `getTracks` preserves requested order and duplicates, omitting unknown IDs. Mutations serialize and return the full `{tracks,playlists,folders}` snapshot after saving. `onUpdate(snapshot)` runs only after a successful save.

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

The parser reads title, artist, album, album artist, duration, track/disc number, year, genre, codec, sample rate, bit depth and channels. Unknown properties remain empty strings or null; the only fallback is the actual filename for title. `valid` means that the path currently exists as a regular file. Missing/non-file paths have `valid:false` and an `error`. Metadata failures preserve the filename or actual foobar snapshot fields and report `metadataError`/`error`; an accessible file remains eligible for real foobar decoding. `metadataSource` identifies `filename`, `file`, or `foobar2000`. `supported` and `playbackUnsupportedReason` independently express whether the exact selection is available: directly imported CUE/ISO containers need a verified foobar subsong entry, and unresolved source subsongs cannot be played.

Embedded JPEG, PNG, GIF and WebP covers are identified from their bytes, deduplicated by content hash, and saved below `dataDir/covers`. Public URLs are `still-cover://art/<sha256>.<extension>`. The desktop owner supplies the restricted protocol handler; the library never exposes arbitrary cover paths or tag-provided filenames. Unsupported embedded image types remain an empty cover URL. Audio files are opened for reading only.

`importFolder` recursively indexes only that explicitly supplied directory, saves its absolute path in `folders`, and skips child directory/file symlinks and junctions. A realpath visited set prevents loops. `refresh` checks existing records, retains missing entries and their playlist occurrences, and discovers new files only inside remembered explicit folders. Removing a record only removes the index and saved references, never the underlying file. Removed identities are remembered so refresh and startup imports do not resurrect them; an explicit file/folder reimport can restore them.

Unchanged files reuse metadata based on size and modification time. One foobar snapshot reads each identity once, and a bounded per-operation cache shares physical container parses across subsongs. Unchanged subsequent source snapshots merge actual source fields without reopening audio. Thus changes which preserve both size and modification time require a fresh import after removing the index, or a real filesystem timestamp update. There is no filesystem watcher. Inaccessible child directories are skipped, while an inaccessible explicitly imported root rejects the import. Discovery and indexing are sequential to avoid opening an unbounded number of files; very large initial imports can take time.

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

State is `dataDir/library.json` (schema version 2). Writes use a unique same-directory temporary file, file sync, and atomic rename. Failed saves roll back memory and publish no update. Corrupt saved JSON is retained and reported instead of being replaced. Tracks, folders, saved copies, removal tombstones and imported-copy history survive restarts. There is one service writer per data directory; concurrent external processes editing the same JSON are unsupported. Unreferenced cover files are retained rather than risking deletion of another import's art.

Run `node --test tests/library.test.js` and `node --check src/main/library.js`. Tests create real temporary PCM WAV files with RIFF and embedded ID3 tags, verify actual parser output and image bytes, and confirm audio bytes remain unchanged. They also cover persistence, missing/malformed audio, stable Windows IDs, symlink loops, duplicate occurrence order, exact subsong identity, incremental metadata reads, and failed-save rollback. Each fixture cleans up only its own verified temporary directory under `tests`.

Desktop native imports use the complete `AUDIO_EXTENSIONS` set for their file filter. After this service commits the index, main may ask the backend to prepare/check imported locations without starting playback. That IPC snapshot can carry `importReport:{indexedCount,backendPrepared,warnings}`; these diagnostics are not persisted as library records. A backend access rejection never rolls back a successfully saved local index. See [desktop integration](build-and-integration.md) and the [manual setup/restore guide](foobar-install-restore.md).
