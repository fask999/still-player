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
test('API client read-only mode cannot write and never forwards a token to artifact storage', async () => {
  const calls = [], token = 'SYNTHETIC-NEVER-A-REAL-TOKEN';
  const client = makeClient({token, fetcher: async (url, options) => {calls.push({url, options}); return calls.length === 1 ? new Response(null, {status: 302, headers: {location: 'https://release-assets.githubusercontent.com/fixed'}}) : new Response('ZIP');}});
  assert.equal((await client.get('/repos/owner/repo/actions/artifacts/20/zip', {binary: true})).toString(), 'ZIP');
  assert.match(calls[0].options.headers.Authorization, /SYNTHETIC/); assert.equal(calls[1].options.headers, undefined);
  await assert.rejects(client.write('POST', '/repos/owner/repo/releases', {}), /Read-only/);
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
    [`${base}/actions/artifacts/20`]: {id: 20, name: artifactName('1.1.0', commit), expired: false, digest: p.artifact_digest, size_in_bytes: archive.length, workflow_run: {id: 10, head_sha: commit, repository_id: policy.repositoryId, head_repository_id: policy.repositoryId}},
    [`${base}/actions/artifacts/20/zip`]: archive
  };
  let checks = 0;
  const client = {get: async endpoint => {assert.ok(Object.hasOwn(response, endpoint), 'No latest/list endpoint may be requested'); return response[endpoint];}};
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

test('only a new own draft with five remotely rehashed assets may become public', async t => {
  const root = directoryFixture(t), names = assetNames('1.1.0'), assets = {};
  for (const name of names) {const bytes = Buffer.from(`ACCEPTED ${name}`); fs.writeFileSync(path.join(root, name), bytes); assets[name] = {bytes: bytes.length, sha256: sha256(bytes)};}
  const accepted = {policy, base: `/repos/${policy.repository}`, tagName: 'v1.1.0', tagSha: commit, promotion: promotion(), verified: {releaseRoot: root, assets}};
  async function exercise(corrupt) {
    const writes = [], stored = []; let published = false;
    const client = {
      assertNoRelease: async () => {},
      get: async endpoint => {
        if (endpoint.includes('/git/ref/')) return {ref: 'refs/tags/v1.1.0', object: {type: 'tag', sha: commit}};
        if (endpoint.endsWith('/releases/42')) return {id: 42, draft: true, tag_name: 'v1.1.0', assets: stored.map(x => ({id: x.id, name: x.name, size: x.bytes.length, state: 'uploaded'}))};
        if (endpoint.includes('/releases/assets/')) {const item = stored.find(x => x.id === Number(endpoint.split('/').at(-1))); return corrupt && item === stored[0] ? Buffer.from('CORRUPT') : item.bytes;}
        throw new Error('Unexpected read endpoint');
      },
      upload: async (_repository, releaseId, name, bytes) => {assert.equal(releaseId, 42); const item = {id: 100 + stored.length, name, bytes}; stored.push(item); return {id: item.id, name, size: bytes.length, state: 'uploaded'};},
      write: async (method, endpoint, body) => {writes.push({method, endpoint, body}); if (method === 'POST') return {id: 42, draft: true, tag_name: 'v1.1.0', assets: []}; published = true; return {id: 42, draft: false, tag_name: 'v1.1.0'};}
    };
    if (corrupt) await assert.rejects(publishVerified(accepted, client, {log: () => {}}), /Remote asset bytes differ/);
    else await publishVerified(accepted, client, {log: () => {}});
    assert.equal(published, !corrupt); assert.equal(writes.filter(x => x.method === 'POST').length, 1); assert.equal(writes.some(x => x.method === 'DELETE'), false);
    assert.equal(writes.filter(x => x.method === 'PATCH').length, corrupt ? 0 : 1);
    const draft = writes.find(x => x.method === 'POST').body;
    assert.equal(draft.draft, true);
    assert.ok(draft.body.startsWith('STILL · 静室是一款独立 Windows 音乐播放器。'));
    assert.ok(draft.body.includes(`\`${names[0]}\``));
    assert.equal(draft.body.split('### 主要功能\n\n')[1].split('\n\n')[0].split('\n').filter(line => line.startsWith('- ')).length, 5);
    assert.ok(draft.body.includes(`[使用指南](https://github.com/${policy.repository}/blob/${accepted.tagName}/docs/public-user-guide.md)`));
    assert.ok(draft.body.endsWith(`构建来自固定 CI 候选运行 10 的第 1 次尝试，Artifact 20，源码 \`${commit}\`。`));
  }
  await exercise(false); await exercise(true);
});
