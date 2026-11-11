'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {promotionFromJson, candidateContext, artifactName, assetNames} = require('../scripts/release-public');
const {verifyTagEvent, verifyPromotion, makeClient, publishVerified} = require('../scripts/release-public-api');
const {sha256} = require('../scripts/package-public');
const {loadRecipe} = require('../scripts/prepare-release-tools');
const policy = loadRecipe(), commit = 'a'.repeat(40), digest = 'b'.repeat(64);
const promotion = () => ({schemaVersion: 1, version: '1.1.0', commit, candidate_run_id: 10, candidate_run_attempt: 1, artifact_id: 20, artifact_digest: `sha256:${digest}`, setup_sha256: digest, source_snapshot_sha256: digest, release_info_sha256: digest});
test('promotion requires canonical bounded exact JSON, no duplicate keys or omitted artifact/run attempt pins', () => {
  assert.equal(promotionFromJson(JSON.stringify(promotion())).artifact_id, 20);
  for (const value of [{...promotion(), extra: 'ignored'}, {...promotion(), artifact_digest: 'sha256:wrong'}, {...promotion(), candidate_run_attempt: '1'}, {...promotion(), artifact_id: -1}]) assert.throws(() => promotionFromJson(JSON.stringify(value)));
  assert.throws(() => promotionFromJson(JSON.stringify(promotion(), null, 2)), /canonical/);
  assert.throws(() => promotionFromJson(JSON.stringify(promotion()).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')), /canonical/);
  assert.throws(() => promotionFromJson(JSON.stringify(promotion()) + ';process.exit()'));
  assert.throws(() => promotionFromJson(' '.repeat(4097)));
});
test('candidate identity binds version/own repo/full commit/ref/workflow and cannot accept PR or fork context', () => {
  const env = {GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: policy.repository, GITHUB_REPOSITORY_ID: String(policy.repositoryId), GITHUB_REF: 'refs/heads/release-candidate/1.1.0', GITHUB_SHA: commit, GITHUB_WORKFLOW_SHA: commit, GITHUB_ACTOR: 'fask999', GITHUB_WORKFLOW_REF: `${policy.repository}/${policy.candidateWorkflow}@refs/heads/release-candidate/1.1.0`, GITHUB_RUN_ID: '10', GITHUB_RUN_ATTEMPT: '1'};
  assert.equal(candidateContext(env, '1.1.0', commit, policy).runId, 10);
  for (const altered of [{GITHUB_EVENT_NAME: 'pull_request'}, {GITHUB_REPOSITORY: 'fork/still-player'}, {GITHUB_REF: 'refs/heads/main'}, {GITHUB_WORKFLOW_SHA: 'c'.repeat(40)}]) assert.throws(() => candidateContext({...env, ...altered}, '1.1.0', commit, policy));
  assert.equal(artifactName('1.1.0', commit), `still-public-1.1.0-${commit}`);
  assert.equal(assetNames('1.1.0').length, 5);
});
test('tag admission requires new unforced own actor/repo and a precise version tag', () => {
  const event = {created: true, forced: false, deleted: false, before: '0'.repeat(40), after: commit, ref: 'refs/tags/v1.1.0', sender: {login: 'fask999'}, repository: {id: policy.repositoryId, full_name: policy.repository, fork: false}};
  const env = {GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: policy.repository, GITHUB_ACTOR: 'fask999', GITHUB_TRIGGERING_ACTOR: 'fask999', GITHUB_REF: event.ref};
  assert.equal(verifyTagEvent(event, env, policy), 'v1.1.0');
  for (const bad of [{forced: true}, {created: false}, {deleted: true}, {sender: {login: 'untrusted'}}, {repository: {...event.repository, fork: true}}, {ref: 'refs/tags/latest'}]) assert.throws(() => verifyTagEvent({...event, ...bad}, env, policy));
  assert.throws(() => verifyTagEvent(event, {...env, GITHUB_TRIGGERING_ACTOR: 'untrusted'}, policy));
});
test('artifact ZIP uses the JSON media type; release asset readback uses binary', async () => {
  const token = 'SYNTHETIC-NEVER-A-REAL-TOKEN';
  for (const [method, endpoint, accept, redirect] of [
    ['downloadArtifact', 'actions/artifacts/20/zip', 'application/vnd.github+json', true],
    ['downloadReleaseAsset', 'releases/assets/20', 'application/octet-stream', true],
    ['downloadReleaseAsset', 'releases/assets/20', 'application/octet-stream', false]
  ]) {
    const calls = [];
    const client = makeClient({token, fetcher: async (url, options) => {
      calls.push({url, options});
      if (calls.length === 2) return new Response('BYTES');
      if (options.headers.Accept !== accept) return new Response('invalid media', {status: 415});
      return redirect ? new Response(null, {status: 302, headers: {location: 'https://release-assets.githubusercontent.com/fixed'}}) : new Response('BYTES');
    }});
    assert.equal((await client[method]('owner/repo', 20)).toString(), 'BYTES');
    assert.equal(calls[0].url, `https://api.github.com/repos/owner/repo/${endpoint}`);
    assert.equal(calls[0].options.redirect, 'manual');
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
    assert.equal(calls[0].options.headers.Accept, accept);
    assert.equal(calls.length, redirect ? 2 : 1);
    if (redirect) {
      assert.equal(calls[1].url, 'https://release-assets.githubusercontent.com/fixed');
      assert.equal(calls[1].options.headers, undefined);
      assert.equal(calls[1].options.redirect, 'error');
    }
    await assert.rejects(client.write('POST', '/repos/owner/repo/releases', {}), /Read-only/);
    await assert.rejects(client[method]('owner/repo/injected', 20), /download identity/);
    await assert.rejects(client[method]('owner/repo', '20/zip'), /download identity/);
    assert.equal(calls.length, redirect ? 2 : 1);
  }
});
test('artifact response rejects the wrong status and unsafe redirect without exposing storage details', async () => {
  const token = 'SYNTHETIC-ARTIFACT';
  for (const status of [200, 301, 410, 415]) {
    const client = makeClient({token, fetcher: async () => new Response('private error body', {status})});
    await assert.rejects(client.downloadArtifact('owner/repo', 20), new RegExp(`^Error: GitHub API GET Actions artifact ZIP failed: HTTP ${status}$`));
  }
  for (const location of [null, 'http://objects.githubusercontent.com/path', 'https://github.com:8080/path',
    'https://x@github.com/path', 'https://objects.githubusercontent.com/path#fragment', 'https://github.com.bad.invalid/path?secret=redacted']) {
    let calls = 0;
    const client = makeClient({token, fetcher: async () => {
      calls++;
      return new Response(null, {status: 302, headers: location ? {location} : {}});
    }});
    await assert.rejects(client.downloadArtifact('owner/repo', 20), /^Error: Unapproved artifact\/asset download host$/);
    assert.equal(calls, 1);
  }
});
const releaseBase = `/repos/${policy.repository}`, releaseTag = 'v1.1.0';
const repositoryIdentity = {id: policy.repositoryId, full_name: policy.repository, fork: false, permissions: {push: true}};
const pageRows = Array.from({length: 100}, (_, index) => ({id: index + 1, tag_name: `v0.0.${index}`, draft: false}));
const releasePageLink = (page, rel) => `<https://api.github.com/repositories/${policy.repositoryId}/releases?per_page=100&page=${page}>; rel="${rel}"`;
function releaseListingFixture({repository = repositoryIdentity, pages = [], writable = true, notesResponse, currentRef} = {}) {
  const calls = [], token = 'SYNTHETIC-RELEASE-LIST';
  const client = makeClient({token, writable, fetcher: async (url, options) => {
    calls.push({url, method: options.method});
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'manual');
    if (url === `https://api.github.com${releaseBase}`) return Response.json(repository);
    if (url === `https://api.github.com${releaseBase}/releases/generate-notes`) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), {tag_name: releaseTag, target_commitish: commit});
      return notesResponse || Response.json({name: 'fixture release notes', body: 'discarded'});
    }
    if (currentRef && url === `https://api.github.com${releaseBase}/git/ref/tags/${releaseTag}`) return Response.json(currentRef);
    const page = pages.find((_, index) => url === `https://api.github.com${releaseBase}/releases?per_page=100&page=${index + 1}`);
    if (!page) assert.fail(`Unexpected GitHub call ${options.method} ${url}`);
    return Response.json(page.rows, {status: page.status || 200, headers: page.link === undefined ? {} : {link: page.link}});
  }});
  return {calls, client};
}
test('draft and published matches on the second release page are rejected before any write', async () => {
  const result = {policy, base: releaseBase, tagName: releaseTag, tagSha: commit, promotion: promotion(), verified: {assets: {}}};
  for (const draft of [true, false]) {
    const {calls, client} = releaseListingFixture({pages: [
      {rows: pageRows, link: [releasePageLink(2, 'next'), releasePageLink(2, 'last')].join(', ')},
      {rows: [{id: 101, tag_name: releaseTag, draft}], link: [releasePageLink(1, 'prev'), releasePageLink(1, 'first')].join(', ')}
    ]});
    await assert.rejects(publishVerified(result, client, {log: () => {}}), /existing release/);
    assert.deepEqual(calls.map(call => call.method), ['GET', 'GET', 'GET']);
    assert.match(calls[2].url, /page=2$/);
  }
});
test('release listing consumes all proven pages and refuses denied permission or uncertain pagination', async () => {
  const terminal = {rows: [{id: 101, tag_name: 'v0.1.0', draft: true}], link: releasePageLink(1, 'prev')};
  const first = {rows: pageRows, link: [releasePageLink(2, 'next'), releasePageLink(2, 'last')].join(', ')};
  const result = {policy, base: releaseBase, tagName: releaseTag, promotion: promotion()};
  const valid = releaseListingFixture({pages: [first, terminal]});
  await valid.client.assertNoRelease(policy, releaseTag, commit);
  assert.deepEqual(valid.calls.map(call => call.method), ['GET', 'GET', 'GET', 'POST']);
  for (const repository of [{...repositoryIdentity, permissions: {push: false}}, {...repositoryIdentity, permissions: {push: 'true'}}, {...repositoryIdentity, id: 100}]) {
    const {calls, client} = releaseListingFixture({repository});
    await assert.rejects(publishVerified(result, client), /push permission/);
    assert.equal(calls.length, 1);
  }
  const readOnly = releaseListingFixture({writable: false});
  await assert.rejects(publishVerified(result, readOnly.client), /write-authorized/);
  assert.deepEqual(readOnly.calls, []);
  for (const [pages, expected] of [
    [[{...first, status: 403}], /HTTP 403/],
    [[first, {...terminal, status: 404}], /HTTP 404/],
    [[first, {...terminal, status: 206}], /HTTP 206/],
    [[{...first, link: first.link.replace('api.github.com', 'bad.invalid')}], /Untrusted release pagination/],
    [[{...first, link: first.link.replace(`/repositories/${policy.repositoryId}`, '/repositories/123')}], /Untrusted release pagination/],
    [[{...first, link: first.link.replace('per_page=100', 'per_page=50')}], /Untrusted release pagination/],
    [[{...first, link: releasePageLink(2, 'unexpected')}], /Unknown release pagination/],
    [[{...first, link: releasePageLink(3, 'next')}], /Inconsistent release pagination/],
    [[{...first, link: [releasePageLink(2, 'next'), releasePageLink(21, 'last')].join(', ')}], /pagination bound/],
    [[first, {...terminal, link: undefined}], /Unknown release pagination/],
    [[first, {...terminal, rows: []}], /Incomplete or unknown release listing/],
    [[{...first, link: [releasePageLink(2, 'next'), releasePageLink(3, 'last')].join(', ')}, terminal], /Incomplete or unknown release listing/],
    [[first, {...terminal, rows: pageRows.slice(0, 1)}], /repeated release/],
    [[{rows: [{id: 1, tag_name: 'v0.0.1'}]}], /Unknown or repeated release/]
  ]) {
    const {calls, client} = releaseListingFixture({pages});
    await assert.rejects(publishVerified(result, client), expected);
    assert.ok(calls.every(call => call.method === 'GET'));
  }
});
test('missing optional repository permission uses a bounded no-persistence GitHub write-capability probe', async () => {
  const repository = {...repositoryIdentity, permissions: undefined}, pages = [{rows: []}];
  const accepted = releaseListingFixture({repository, pages});
  await accepted.client.assertNoRelease(policy, releaseTag, commit);
  assert.deepEqual(accepted.calls.map(call => call.method), ['GET', 'GET', 'POST']);
  assert.match(accepted.calls[2].url, /\/releases\/generate-notes$/);
  const result = {policy, base: releaseBase, tagName: releaseTag, promotion: promotion()};
  for (const [notesResponse, expected] of [
    [Response.json({}, {status: 401}), /HTTP 401/],
    [Response.json({}, {status: 403}), /HTTP 403/],
    [Response.json({name: 'unexpected', body: ''}, {status: 201}), /HTTP 201/],
    [Response.json({name: 'unexpected'}), /Cannot confirm release write capability/],
    [new Response('invalid-private-text'), /^Error: GitHub API returned invalid JSON$/],
    [Response.json({name: '', body: 'x'.repeat(1024 * 1024)}), /exceeds bound/]
  ]) {
    const {calls, client} = releaseListingFixture({repository, pages, notesResponse});
    await assert.rejects(publishVerified(result, client), expected);
    assert.deepEqual(calls.map(call => call.method), ['GET', 'GET', 'POST']);
    assert.match(calls[2].url, /\/releases\/generate-notes$/);
  }
  const changed = releaseListingFixture({repository, pages, currentRef: {ref: `refs/tags/${releaseTag}`, object: {type: 'tag', sha: 'e'.repeat(40)}}});
  await assert.rejects(publishVerified({...result, tagSha: commit}, changed.client), /Tag changed before draft creation/);
  assert.deepEqual(changed.calls.map(call => call.method), ['GET', 'GET', 'POST', 'GET']);
  assert.match(changed.calls[3].url, /\/git\/ref\/tags\/v1\.1\.0$/);
});

function directoryFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'still-release-protocol-'));
  t.after(() => {assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase()); assert.ok(path.basename(root).startsWith('still-release-protocol-')); fs.rmSync(root, {recursive: true, force: true});});
  return root;
}
function tinyArchive() {
  const name = Buffer.from('fixture.txt'), bytes = Buffer.from('DATA'), crc = zlib.crc32(bytes), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt32LE(crc, 14); local.writeUInt32LE(4, 18); local.writeUInt32LE(4, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc, 16); central.writeUInt32LE(4, 20); central.writeUInt32LE(4, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + 4, 16);
  return Buffer.concat([local, name, bytes, central, name, end]);
}
test('promotion selects exact artifact ID and workflow attempt; rerun/latest/fork/digest drift is never substituted', async t => {
  const root = directoryFixture(t), archive = tinyArchive(), p = {...promotion(), artifact_digest: `sha256:${sha256(archive)}`}, tagSha = 'd'.repeat(40), base = `/repos/${policy.repository}`;
  const event = {created: true, forced: false, deleted: false, before: '0'.repeat(40), after: commit, ref: 'refs/tags/v1.1.0', sender: {login: 'fask999'}, repository: {id: policy.repositoryId, full_name: policy.repository, fork: false}};
  const env = {GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: policy.repository, GITHUB_ACTOR: 'fask999', GITHUB_SHA: commit, GITHUB_WORKFLOW_SHA: commit, GITHUB_REF: event.ref};
  const refKey = `${base}/git/ref/tags/v1.1.0`, tagKey = `${base}/git/tags/${tagSha}`;
  const response = {
    [base]: {id: policy.repositoryId, full_name: policy.repository, fork: false},
    [refKey]: {ref: event.ref, object: {type: 'tag', sha: tagSha}},
    [tagKey]: {sha: tagSha, tag: 'v1.1.0', object: {type: 'commit', sha: commit}, message: JSON.stringify(p)},
    [`${base}/actions/runs/10/attempts/1`]: {id: 10, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'push', head_sha: commit, head_branch: 'release-candidate/1.1.0', path: policy.candidateWorkflow, repository: {id: policy.repositoryId}, head_repository: {id: policy.repositoryId}, actor: {login: 'fask999'}},
    [`${base}/actions/artifacts/20`]: {id: 20, name: artifactName('1.1.0', commit), expired: false, digest: p.artifact_digest, size_in_bytes: archive.length, workflow_run: {id: 10, head_sha: commit, repository_id: policy.repositoryId, head_repository_id: policy.repositoryId}}
  };
  let checks = 0;
  const client = {
    get: async endpoint => {assert.ok(Object.hasOwn(response, endpoint), 'No latest/list endpoint may be requested'); return response[endpoint];},
    downloadArtifact: async (repository, artifactId) => {assert.equal(repository, policy.repository); assert.equal(artifactId, 20); return archive;}
  };
  const gitResults = {'rev-parse --verify refs/tags/v1.1.0^{tag}': tagSha, 'rev-parse HEAD': commit, 'status --porcelain --untracked-files=normal': ''};
  const runGit = (command, args) => {assert.equal(command, 'git'); assert.ok(Object.hasOwn(gitResults, args.join(' '))); return {status: 0, stdout: gitResults[args.join(' ')]};};
  const options = {event, env, client, runGit, outputDirectory: path.join(root, 'valid'), verifyBundle: (_target, opts) => {checks++; assert.equal(opts.expected.artifact_id, 20); return {assets: {}};}};
  const result = await verifyPromotion(options);
  assert.equal(result.artifact.id, 20); assert.equal(checks, 1);
  assert.equal(result.tagSha, tagSha); assert.equal(result.promotion.commit, commit);
  const handoff = {...env, STILL_VERIFIED_TAG_OBJECT: result.tagSha, STILL_VERIFIED_TAG_COMMIT: result.promotion.commit};
  await verifyPromotion({...options, event: {...event, after: tagSha}, env: handoff, writable: true, outputDirectory: path.join(root, 'valid-object-after')});
  const invalid = {...options, outputDirectory: path.join(root, 'invalid'), verifyBundle: () => assert.fail('Invalid provenance must not reach bundle validation')};
  for (const altered of [
    {event: {...event, after: 'e'.repeat(40)}},
    {env: {...env, GITHUB_SHA: tagSha}},
    {env: {...env, GITHUB_WORKFLOW_SHA: 'e'.repeat(40)}},
    {writable: true},
    {writable: true, env: {...handoff, STILL_VERIFIED_TAG_COMMIT: 'e'.repeat(40)}}
  ]) await assert.rejects(verifyPromotion({...invalid, ...altered}));
  const differentTag = 'f'.repeat(40);
  response[refKey] = {ref: event.ref, object: {type: 'tag', sha: differentTag}};
  response[`${base}/git/tags/${differentTag}`] = {...response[tagKey], sha: differentTag};
  await assert.rejects(verifyPromotion({...invalid, env: handoff, writable: true}), /differs from the read-only verification job/);
  await assert.rejects(verifyPromotion(invalid), /Checked-out tag object/);
  response[refKey] = {ref: event.ref, object: {type: 'tag', sha: tagSha}};
  gitResults['rev-parse HEAD'] = differentTag;
  await assert.rejects(verifyPromotion(invalid), /clean source commit differs/);
  gitResults['rev-parse HEAD'] = commit;
  response[refKey] = {ref: event.ref, object: {type: 'commit', sha: commit}};
  await assert.rejects(verifyPromotion(invalid), /exact annotated tag object/);
  response[refKey] = {ref: event.ref, object: {type: 'tag', sha: tagSha}};
  const artifactKey = `${base}/actions/artifacts/20`, runKey = `${base}/actions/runs/10/attempts/1`;
  for (const [key, patch] of [[artifactKey, {id: 21}], [artifactKey, {digest: `sha256:${'0'.repeat(64)}`}], [artifactKey, {workflow_run: {...response[artifactKey].workflow_run, head_repository_id: 999}}], [runKey, {run_attempt: 2}], [runKey, {event: 'pull_request'}], [runKey, {conclusion: 'failure'}], [runKey, {path: '.github/workflows/other.yml'}]]) {
    const original = response[key]; response[key] = {...original, ...patch};
    await assert.rejects(verifyPromotion(invalid));
    response[key] = original;
  }
});

const recoveryRef = 'refs/heads/release-recovery/v1.1.0';
const mainRef = 'refs/heads/main';
function gitRefEndpoint(ref) {return `${releaseBase}/git/ref/${ref.slice('refs/'.length)}`;}
test('v1.1.0 recovery reaches only the accepted artifact after verifying both checkouts and refs', async t => {
  const root = directoryFixture(t), sourceRoot = path.join(root, 'tools', 'release-recovery-source'), recoveryCommit = 'f'.repeat(40);
  fs.mkdirSync(path.join(root, 'installer'));
  fs.copyFileSync(path.join(__dirname, '../installer/release-tools.json'), path.join(root, 'installer', 'release-tools.json'));
  fs.mkdirSync(sourceRoot, {recursive: true});
  const fixed = {
    schemaVersion: 1, version: '1.1.0', commit: '6954d1158129ff509a134c738229158ee3c7f770',
    candidate_run_id: 42750789913, candidate_run_attempt: 1, artifact_id: 13733581362,
    artifact_digest: 'sha256:76f50da8706e831b67a169a43f60a8214536f8ce46811944bde27ffbef687698',
    setup_sha256: '3e996df89bc3a119b9227fb5db8c4f4a4034ac5e0c0dfc8ad859c0a351d19759',
    source_snapshot_sha256: '00a247b3aae9c337cffad85ba8aacf99033477fd2ae80e9d7807d9d223418ca8',
    release_info_sha256: 'ba811a3c1a26cfab2b63dba8bd57213cf051a0072bd77edfaf3aceccd93ca0bd'
  };
  const tagSha = '63019947608a858732215453ad6e8dee989b331a', tagRef = 'refs/tags/v1.1.0';
  const tagEndpoint = `${releaseBase}/git/tags/${tagSha}`, mainEndpoint = gitRefEndpoint(mainRef), branchEndpoint = gitRefEndpoint(recoveryRef);
  const event = {created: true, forced: false, deleted: false, before: '0'.repeat(40), after: recoveryCommit, ref: recoveryRef, sender: {login: 'fask999'}, repository: {id: policy.repositoryId, full_name: policy.repository, fork: false}};
  const env = {
    GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: policy.repository, GITHUB_REPOSITORY_ID: String(policy.repositoryId),
    GITHUB_ACTOR: 'fask999', GITHUB_TRIGGERING_ACTOR: 'fask999', GITHUB_REF: recoveryRef, GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: recoveryCommit, GITHUB_WORKFLOW_SHA: recoveryCommit, GITHUB_WORKFLOW_REF: `${policy.repository}/.github/workflows/release-publish.yml@${recoveryRef}`
  };
  const response = {
    [releaseBase]: {...repositoryIdentity, default_branch: 'main'},
    [branchEndpoint]: {ref: recoveryRef, object: {type: 'commit', sha: recoveryCommit}},
    [mainEndpoint]: {ref: mainRef, object: {type: 'commit', sha: recoveryCommit}},
    [gitRefEndpoint(tagRef)]: {ref: tagRef, object: {type: 'tag', sha: tagSha}},
    [tagEndpoint]: {sha: tagSha, tag: 'v1.1.0', object: {type: 'commit', sha: fixed.commit}, message: JSON.stringify(fixed)},
    [`${releaseBase}/actions/runs/42750789913/attempts/1`]: {id: 42750789913, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'push',
      head_sha: fixed.commit, head_branch: 'release-candidate/1.1.0', path: policy.candidateWorkflow, repository: {id: policy.repositoryId},
      head_repository: {id: policy.repositoryId}, actor: {login: 'fask999'}},
    [`${releaseBase}/actions/artifacts/13733581362`]: {id: 13733581362, name: artifactName('1.1.0', fixed.commit), expired: false,
      digest: fixed.artifact_digest, size_in_bytes: 348541699, workflow_run: {id: 42750789913, head_sha: fixed.commit, repository_id: policy.repositoryId, head_repository_id: policy.repositoryId}}
  };
  const downloads = [], reads = [];
  const archiveFixtureBoundary = new Error('Fixture stops at exact approved archive download');
  const client = {
    get: async endpoint => {reads.push(endpoint); assert.ok(Object.hasOwn(response, endpoint)); return response[endpoint];},
    downloadArtifact: async (repository, id) => {downloads.push([repository, id]); throw archiveFixtureBoundary;}
  };
  const tagBytes = Buffer.from(`object ${fixed.commit}\ntype commit\ntag v1.1.0\n\n${JSON.stringify(fixed)}\n`);
  const git = {
    [root]: {'rev-parse HEAD': recoveryCommit, 'status --porcelain --untracked-files=normal': ''},
    [sourceRoot]: {'rev-parse HEAD': fixed.commit, 'status --porcelain --untracked-files=normal': '',
      [`rev-parse --verify ${tagRef}^{tag}`]: tagSha, [`cat-file tag ${tagSha}`]: tagBytes}
  };
  const runGit = (command, args, {cwd}) => {
    assert.equal(command, 'git');
    assert.ok(Object.hasOwn(git, cwd));
    assert.ok(Object.hasOwn(git[cwd], args.join(' ')));
    return {status: 0, stdout: git[cwd][args.join(' ')]};
  };
  const options = {root, event, env, client, runGit, verifyBundle: () => assert.fail('Archive is a download-boundary fixture')};
  const handoff = {...env, STILL_VERIFIED_TAG_OBJECT: tagSha, STILL_VERIFIED_TAG_COMMIT: fixed.commit};
  for (const mode of [{}, {writable: true, env: handoff}]) {
    await assert.rejects(verifyPromotion({...options, ...mode}), error => error === archiveFixtureBoundary);
    assert.deepEqual(reads.splice(0), [releaseBase, branchEndpoint, mainEndpoint, gitRefEndpoint(tagRef), tagEndpoint,
      `${releaseBase}/actions/runs/42750789913/attempts/1`, `${releaseBase}/actions/artifacts/13733581362`]);
    assert.deepEqual(downloads.splice(0), [[policy.repository, 13733581362]]);
  }
  for (const fields of [{created: false}, {forced: true}, {deleted: true}, {before: commit}, {after: commit},
    {sender: {login: 'someone-else'}}, {repository: {...event.repository, fork: true}}]) {
    await assert.rejects(verifyPromotion({...options, event: {...event, ...fields}}), /authorized first push/);
  }
  for (const fields of [{GITHUB_RUN_ATTEMPT: '2'}, {GITHUB_REPOSITORY_ID: '999'}, {GITHUB_TRIGGERING_ACTOR: 'someone-else'},
    {GITHUB_WORKFLOW_REF: 'other'}, {GITHUB_WORKFLOW_SHA: commit}, {GITHUB_REF: mainRef}, {GITHUB_SHA: fixed.commit}]) {
    await assert.rejects(verifyPromotion({...options, env: {...env, ...fields}}), /authorized first push/);
  }
  await assert.rejects(verifyPromotion({...options, writable: true, env: {...handoff, STILL_VERIFIED_TAG_COMMIT: commit}}), /differs from the read-only verification job/);
  for (const [key, altered, message] of [
    [releaseBase, {...response[releaseBase], default_branch: 'different'}, /default branch differs/],
    [mainEndpoint, {...response[mainEndpoint], object: {type: 'commit', sha: commit}}, /must both identify/],
    [branchEndpoint, {...response[branchEndpoint], ref: mainRef}, /must both identify/],
    [gitRefEndpoint(tagRef), {ref: tagRef, object: {type: 'commit', sha: fixed.commit}}, /exact annotated tag object/],
    [tagEndpoint, {...response[tagEndpoint], message: JSON.stringify({...fixed, artifact_id: 20})}, /canonical promotion differs/]
  ]) {
    const original = response[key];
    response[key] = altered;
    await assert.rejects(verifyPromotion(options), message);
    response[key] = original;
  }
  git[root]['rev-parse HEAD'] = commit;
  await assert.rejects(verifyPromotion(options), /Clean recovery checkout/);
  git[root]['rev-parse HEAD'] = recoveryCommit;
  git[sourceRoot]['rev-parse HEAD'] = commit;
  await assert.rejects(verifyPromotion(options), /Checked-out tag object or clean source commit differs/);
  git[sourceRoot]['rev-parse HEAD'] = fixed.commit;
  git[sourceRoot][`cat-file tag ${tagSha}`] = Buffer.concat([tagBytes, Buffer.from('\n')]);
  await assert.rejects(verifyPromotion(options), /Local tag message does not match the accepted promotion bytes/);
  assert.deepEqual(downloads, []);
});
test('only a new own draft with five remotely rehashed assets may become public', async t => {
  const root = directoryFixture(t), names = assetNames('1.1.0'), assets = {};
  for (const name of names) {const bytes = Buffer.from(`ACCEPTED ${name}`); fs.writeFileSync(path.join(root, name), bytes); assets[name] = {bytes: bytes.length, sha256: sha256(bytes)};}
  const accepted = {policy, base: `/repos/${policy.repository}`, tagName: 'v1.1.0', tagSha: commit, promotion: promotion(), verified: {releaseRoot: root, assets}};
  async function exercise({corrupt = false, recovery = false, changedRecoveryAt} = {}) {
    const writes = [], stored = [];
    const recoveryCommit = recovery || changedRecoveryAt ? 'f'.repeat(40) : null;
    let published = false, mainReads = 0;
    const client = {
      assertNoRelease: async () => {},
      get: async endpoint => {
        if (endpoint === gitRefEndpoint(recoveryRef)) return {ref: recoveryRef, object: {type: 'commit', sha: recoveryCommit}};
        if (endpoint === gitRefEndpoint(mainRef)) return {ref: mainRef, object: {type: 'commit', sha: ++mainReads === changedRecoveryAt ? commit : recoveryCommit}};
        if (endpoint === gitRefEndpoint('refs/tags/v1.1.0')) return {ref: 'refs/tags/v1.1.0', object: {type: 'tag', sha: commit}};
        if (endpoint.endsWith('/releases/42')) return {id: 42, draft: true, tag_name: 'v1.1.0', assets: stored.map(x => ({id: x.id, name: x.name, size: x.bytes.length, state: 'uploaded'}))};
        throw new Error('Unexpected read endpoint');
      },
      downloadReleaseAsset: async (repository, id) => {
        assert.equal(repository, policy.repository);
        const item = stored.find(x => x.id === id);
        return corrupt && item === stored[0] ? Buffer.from('CORRUPT') : item.bytes;
      },
      upload: async (_repository, releaseId, name, bytes) => {assert.equal(releaseId, 42); const item = {id: 100 + stored.length, name, bytes}; stored.push(item); return {id: item.id, name, size: bytes.length, state: 'uploaded'};},
      write: async (method, endpoint, body) => {writes.push({method, endpoint, body}); if (method === 'POST') return {id: 42, draft: true, tag_name: 'v1.1.0', assets: []}; published = true; return {id: 42, draft: false, tag_name: 'v1.1.0'};}
    };
    const attempt = publishVerified({...accepted, recoveryCommit}, client, {log: () => {}});
    if (changedRecoveryAt) await assert.rejects(attempt, /must both identify the verified recovery commit/);
    else if (corrupt) await assert.rejects(attempt, /Remote asset bytes differ/);
    else await attempt;
    const mayPublish = !corrupt && !changedRecoveryAt;
    assert.equal(published, mayPublish);
    assert.equal(writes.filter(x => x.method === 'POST').length, changedRecoveryAt === 1 ? 0 : 1);
    assert.equal(writes.some(x => x.method === 'DELETE'), false);
    assert.equal(writes.filter(x => x.method === 'PATCH').length, mayPublish ? 1 : 0);
    if (changedRecoveryAt === 1) return;
    const draft = writes.find(x => x.method === 'POST').body;
    assert.equal(draft.draft, true);
    assert.ok(draft.body.startsWith('STILL · 静室是一款独立 Windows 音乐播放器。'));
    assert.ok(draft.body.includes(`\`${names[0]}\``));
    assert.equal(draft.body.split('### 主要功能\n\n')[1].split('\n\n')[0].split('\n').filter(line => line.startsWith('- ')).length, 5);
    assert.ok(draft.body.includes(`[使用指南](https://github.com/${policy.repository}/blob/${accepted.tagName}/docs/public-user-guide.md)`));
    assert.ok(draft.body.endsWith(`构建来自固定 CI 候选运行 10 的第 1 次尝试，Artifact 20，源码 \`${commit}\`。`));
  }
  await exercise();
  await exercise({corrupt: true});
  await exercise({recovery: true});
  await exercise({changedRecoveryAt: 1});
  await exercise({changedRecoveryAt: 2});
});
