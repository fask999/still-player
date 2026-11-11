# Public release candidate and promotion

Only the authorized repository maintainer pushes candidate refs and annotated
version tags. These scripts do not create or push either kind of ref, change
repository visibility, change project licensing, run the application, register
system media controls, or invoke an uninstaller.

## Candidate

An exact `release-candidate/<version>` push runs the Windows candidate workflow
with `contents: read`. The branch version must match `package.json`; checkout
must be clean and its complete commit SHA must match the workflow/source SHA.
Official actions use complete reviewed commit SHAs and checkout does not retain
credentials. No release-write token is exposed to tool preparation or builds.

`installer/release-tools.json` fixes portable Node 24.22.1, Electron 45.1.0,
NSIS 3.13, the 7-Zip bootstrap CLI and the original 26.06 binary archive by
URL, length and SHA-256. ZIP entries are validated before extraction; paths,
links, case collisions, bounds and CRCs are checked. Electron's 73 leaves and
NSIS's 441 files must match the reviewed lists. The official foobar installer
retains its exact hash and Authenticode publisher. The component licenses and
complete same-version 7-Zip source archive are retained. Reviewed production
native binaries are checked byte-for-byte and are never recompiled by CI.

Dev dependencies and a separate clean production stage use the committed
lockfile with lifecycle scripts disabled and an empty controlled npm config.
The production tree must match the reviewed 14 packages and 343 leaf hashes.
Source lint/tests/build checks and isolated non-UI native fixtures precede the
public package and Setup build. Fixtures use controlled paths and fake
registration reads; they do not install the product or operate the desktop.

The immutable artifact is named `still-public-<version>-<full-commit-SHA>`.
The upload step packages it as a ZIP with Zlib compression level 6.
Its only namespaces are the closed `public/` directory and these five files
under `release/`: Setup EXE, `SHA256SUMS.txt`, `BUILD-INFO.json`,
`INSTALLER-INFO.json`, `RELEASE-INFO.json`. Compiler logs, QA logs, evidence,
credentials, source toolchains, user data, profiles and expanded foobar core
are not uploaded. The complete public directory is for candidate inspection;
only the five release files become Release assets.

## Exact-byte acceptance

Download the artifact by its numeric artifact ID and retain the corresponding
Actions artifact metadata JSON from the API. Before downloading, check that
`size_in_bytes` fits the authorized downloader's limit of 536,870,912 bytes.
Check out the exact clean source commit, then run the read-only archive
verifier into a fresh directory:

```powershell
node scripts/release-public.js inspect artifact.zip artifact-metadata.json tools/accepted-candidate
```

The verifier checks the actual archive digest, closed namespace, every file,
version, clean source commit and metadata. It writes a compact canonical
`tools/accepted-candidate.promotion.json` beside the extracted tree. This is
only a proposed tag message, not proof of installation or playback. The CEO
must independently verify the Setup hash and complete the separately authorized
non-UI installation acceptance before using it.

After that acceptance the CEO creates a new annotated `v<version>` tag whose
message is exactly this JSON and whose target is the candidate commit. No
extra keys, pretty-printing, duplicate keys, shell syntax or issue/comment
instructions are accepted. The message binds `schemaVersion`, `version`,
`commit`, `candidate_run_id`, `candidate_run_attempt`, `artifact_id`,
`artifact_digest`, `setup_sha256`, `source_snapshot_sha256`, and
`release_info_sha256`. Artifact ID and digest are essential: another attempt
of the same commit can produce different Setup bytes.

## Publication

The first tag job is read-only (`contents: read`, `actions: read`). It requires
an authorized own-repository new, non-forced annotated tag push, checks the
exact tag object and its direct target commit against the API and clean
checkout, and passes both complete SHAs to the publication job. GitHub's
workflow SHAs must match the target commit. The push payload's `after` must
match that commit or the already verified tag object. The job checks the exact
successful candidate workflow attempt and downloads only the bound artifact
ID. PR/fork artifacts, another workflow, another ref, expired artifacts,
changed digests and any namespace/hash mismatch are rejected. It never
searches for the latest run.

Only the dependent API publication job has `contents: write` and `actions:
read`; `GH_TOKEN` is set only for its API step. That step requires the same
tag object and commit from the first job and re-verifies the same immutable
candidate. It does no build, npm install, native compilation or artifact
execution. Before creating a draft, it checks the complete authenticated
release listing up to 20 pages. An existing release or draft with the tag,
an unknown page, or an explicit denial of push permission stops publication.
After the listing succeeds, the same token must pass GitHub's release notes
generation endpoint, which requires `contents: write` and saves no notes.
The job discards the generated text and checks the tag again. It then
creates one draft, uploads exactly five assets, downloads and hashes every
remote asset, checks tag identity again, and makes the draft public. A failure
leaves the own draft for CEO review. No release, asset or tag is automatically
deleted, resumed or overwritten.

The Actions artifact ZIP request uses GitHub's JSON media type and expects the
archive redirect. The release asset byte check uses the binary media type and
handles a direct response or a redirect. Storage requests receive no API token.
[Actions artifact download](https://docs.github.com/en/rest/actions/artifacts#download-an-artifact)
and [release asset download](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)
describe the two responses.

### Recovery for the fixed v1.1.0 tag

The original tag's verification run returned HTTP 415 before publication.
The authorized maintainer can atomically push the reviewed repair commit to
`main` and create `release-recovery/v1.1.0` at that same commit. The workflow
admits only the first attempt of a new, non-forced push by the authorized
maintainer in the original repository. It checks that both remote branches
still point to the clean repair checkout and uses the same concurrency group
as the original tag.

Both jobs independently check out the original `v1.1.0` tag under an ignored
path for byte comparison. The verifier checks its exact tag object, clean
target `6954d1158129ff509a134c738229158ee3c7f770`, and the original promotion
message bytes. It downloads and verifies artifact `13733581362` from run
`42750789913`, attempt 1, with the same five assets and digest pins. This
recovery needs no tag change or rebuild. The write job rechecks both branches
and the tag before creating the draft and before publishing. A pre-existing
release or draft stops publication. This path accepts no other tag, candidate,
or workflow input.

Record the recovery Actions run and the five published asset hashes when
GitHub has completed them. Keep the local verifier, isolated native fixtures,
installation and playback results tied to their respective evidence.
