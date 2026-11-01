# Local metadata cover integration

The original Sol worker / high implementation was handed to Sol worker / xhigh for the bounded transport/deadline repair. This owner controls `src/main/metadata-covers.js`, `tests/metadata-covers.test.js` and this document; repair evidence uses `artwork-metadata-repair-*`. Other agents own main integration and presentation.

```js
const covers = createMetadataCoverService({
  cacheDirectory: path.join(dataDir, 'cover-metadata-cache'),
  artworkUrlFor: url => artwork.urlFor(url),
  userAgent: 'STILL/1.0.0 (<actual maintainer HTTPS contact URL or email>)',
  onChange: () => emitLibrary(),
});
void covers.initialize(); // cache I/O must not delay playback/bootstrap
covers.decorateSnapshot(library.list()); // always use current records
covers.decorateTrack(currentTrack);
await covers.close(); // shutdown only; cancels background queries
```

The four methods and original constructor options remain compatible. An optional `userAgent` enables live MusicBrainz requests; no real contact was supplied with the repository, so it defaults empty and new lookups report `source-unavailable` without any network request. Do not fill it with a made-up contact. Existing valid CAA mappings remain available offline without that contact. The fixture tests use an explicitly fictional contact only with injected mock fetches.

Decorators are synchronous, immutable and preserve every existing nonempty coverUrl. Statuses: initializing, missing-metadata, source-unavailable, queued, queue-full, matched, no-match, ambiguous, low-confidence, failed, cache-unavailable, closed. Only MusicBrainz release search is enabled. There is no iTunes Search or other fallback branch. The v1 iTunes index is ignored; new v2 entries contain canonical artist/album, provider/source, releaseId/sourceUrl and timestamps.

A full release title and combined artist-credit (including credited names/join phrases) must equal the indexed album and albumArtist (else artist), ignoring only NFC Unicode, case and whitespace. Edition/version text remains significant. Different release IDs are ambiguous. Truncated search results, invalid release UUIDs or disambiguation that the indexed metadata cannot establish produce low-confidence. No translation, fuzzy match, track-title search or edition stripping occurs.

A successful mapping constructs exactly `https://coverartarchive.org/release/<lowercase RFC UUID v1-v5 with valid variant>/front-500`. No image URL from search JSON is accepted. `artworkUrlFor` receives this fixed URL and must return `still-apple-art://art/<64hex>`; otherwise no cover is shown. The separate artwork service owns image fetching, bounded official redirects and offline image cache. A matched release does not prove a front image exists; the front-500 endpoint can return 404.

Source information: `coverMetadataSource: {provider: 'Cover Art Archive', source: 'musicbrainz', releaseId, sourceUrl: 'https://musicbrainz.org/release/<uuid>'}`. It is data for the integrator, not an instruction to navigate or add a purchase badge. No link is opened by this module.

Limits: 2 real transport slots, 32 waiting, at least 1000ms between MusicBrainz request starts, 8-second logical query/body deadline, 1MiB response/8192 body reads, 512 index entries and 2MiB serialized index. A timed-out transport continues to occupy its slot until the actual fetch, body read and body cancellation settle. Ignoring AbortSignal cannot start additional transports beyond two. If both transports ignore cancellation indefinitely, queued work remains bounded and waits; the service does not fake physical release. Each timed-out logical query publishes its failed result at most once, and late successful transport completion cannot replace that result or notify again. `close()` aborts and waits for logical jobs/cache I/O, but does not await a transport which ignores cancellation; late completions after close cannot cache, notify, or start queued work.

Negative metadata no-match/ambiguity/low-confidence cooldown is 24h; transient metadata lookup failure cooldown is 1h. These metadata cooldowns are separate from image download failures: a known/matched release remains a valid fixed image registration even if its image GET failed. Queries have fixed HTTPS origin, no credentials, no redirects and a meaningful User-Agent. No scheduled polling. Cache writes use exclusive temporary files and atomic replacement, reject symlink/junction directory ancestry and linked index files, and do not alter library/tag/audio files. Filesystem checks do not claim protection against a privileged attacker replacing ancestor paths between syscalls.

Official sources: https://musicbrainz.org/doc/MusicBrainz_API , https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting , https://musicbrainz.org/doc/Cover_Art_Archive/API , https://musicbrainz.org/doc/Cover_Art_Archive . MusicBrainz states noncommercial API use is free and requires application/contact identification with one request per second. CAA exposes a public cover repository and asks users to respect artist/label rights; availability does not imply images are license-free. Earlier iTunes source evidence is preserved as historical evidence; its promotional badge conditions led to its removal from automatic lookup.

## Indexed MusicBrainz release IDs (enabled without search)

An indexed track may carry `musicbrainzAlbumId` or `musicbrainzReleaseId`, each a single strictly canonical lowercase UUID (version 1–5, valid RFC variant). These refer to a release, not a release group. A valid ID synchronously registers the fixed CAA front-500 URL with zero metadata network calls and no User-Agent/contact requirement. Both fields may coexist only if identical. Malformed, array-valued, noncanonical or conflicting IDs yield internal invalid-release-id/ambiguous statuses and no registration/search. Failed artwork registration reports artwork-unavailable. These internal codes should not become permanent UI copy. Existing embedded/local coverUrl always takes priority. Direct IDs are already part of indexed metadata; this module neither scans audio/tags for them nor persists them back to the library. A direct mapping alone does not prove an image is available or cached. Missing IDs keep the default search-unconfigured/source-unavailable behavior; optional MusicBrainz search remains disabled without a real compliant User-Agent.

## Image retry / refresh contract

`artwork.urlFor(publicUrl)` is stable: retries reuse exactly the same opaque `still-apple-art://art/<64hex>` URL. Every failed artwork protocol response has `Cache-Control: no-store` and `Pragma: no-cache`. The image service never caches a negative download result in memory or on disk; the next `handleRequest` for the same registered URL may fetch and succeed after recovery. Its successful disk/offline cache path is unchanged. An unknown-ID 404 can likewise succeed at that same ID after its canonical public URL is registered.

Main and renderer refresh should issue a new image request for that stable URL when the user retries or the image is rendered again. A renderer that remembers an image error must clear that local failed state and request the URL again; the service cannot cause an already-failed DOM image to reload by itself. Do not append random query cache-busters or expand the protocol route. Transport/queue limits still apply, including retention of a slot for an adapter that has not physically settled after cancellation.
