'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {ROOT, regularBytes, sha256, assertNoLinks} = require('./package-public');
const {loadRecipe} = require('./prepare-release-tools');
const {artifactName, gitState, promotionFromJson, verifyCandidateDirectory} = require('./release-public');
const {COMMIT, integer, safeZipEntries, writeEntries, assertNames} = require('./release-public-integrity');
const API_VERSION = '2026-03-10';
const RELEASE_PAGE_SIZE = 100;
const MAX_RELEASE_PAGES = 20;

function releasePageLinks(link, base, repositoryId, page) {
  if (link === null && page === 1) return {};
  const links = {};
  for (const part of (link || '').split(',')) {
    const match = /^<([^<>\s]+)>;\s*rel="(next|prev|first|last)"$/.exec(part.trim());
    if (!match || Object.hasOwn(links, match[2])) throw new Error('Unknown release pagination Link');
    const url = new URL(match[1]);
    const keys = [...url.searchParams.keys()].sort();
    const value = url.searchParams.get('page');
    if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash ||
        ![`${base}/releases`, `/repositories/${repositoryId}/releases`].includes(url.pathname) ||
        keys.join(',') !== 'page,per_page' || url.searchParams.get('per_page') !== String(RELEASE_PAGE_SIZE) || !/^[1-9]\d*$/.test(value || '')) throw new Error('Untrusted release pagination Link');
    links[match[2]] = integer(value, 'release page');
  }
  if ((links.next !== undefined && links.next !== page + 1) ||
      (links.prev !== undefined && (page === 1 || links.prev !== page - 1)) ||
      (links.first !== undefined && links.first !== 1) ||
      (links.last !== undefined && links.last < (links.next || page))) throw new Error('Inconsistent release pagination Link');
  return links;
}

function makeClient({token, writable = false, fetcher = fetch} = {}) {
  if (!token || /[\r\n]/.test(token)) throw new Error('A scoped API token is required');
  const headers = {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'STILL-exact-artifact-release'};
  async function request(method, endpoint, body, {binary = false, releasePage, expectedStatus, maxJsonBytes = 8 * 1024 ** 2} = {}) {
    if (!endpoint.startsWith('/repos/') || endpoint.includes('..') || endpoint.includes('?')) throw new Error('Invalid fixed GitHub API endpoint');
    if (method !== 'GET' && !writable) throw new Error('Read-only promotion verifier cannot write');
    const query = releasePage === undefined ? '' : `?per_page=${RELEASE_PAGE_SIZE}&page=${releasePage}`;
    const response = await fetcher(`https://api.github.com${endpoint}${query}`, {method, redirect: 'manual', headers: {...headers, ...(body ? {'Content-Type': 'application/json'} : {}), ...(binary ? {Accept: 'application/octet-stream'} : {})}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000)});
    if (binary && [301, 302, 303, 307, 308].includes(response.status)) {
      const url = new URL(response.headers.get('location'));
      if (url.protocol !== 'https:' || url.username || url.password || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname) && !/^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname)) throw new Error('Unapproved artifact/asset download host');
      // Never forward the repository token to a signed storage URL.
      const download = await fetcher(url.href, {redirect: 'error', signal: AbortSignal.timeout(120000)});
      if (!download.ok) throw new Error(`GitHub storage download failed: HTTP ${download.status}`);
      return boundedBytes(download, 2 * 1024 ** 3);
    }
    if (!response.ok || (expectedStatus !== undefined && response.status !== expectedStatus)) throw new Error(`GitHub API ${method} failed: HTTP ${response.status}`);
    if (binary) return boundedBytes(response, 2 * 1024 ** 3);
    const bytes = await boundedBytes(response, maxJsonBytes);
    let data;
    try {data = JSON.parse(bytes.toString('utf8'));}
    catch {throw new Error('GitHub API returned invalid JSON');}
    return releasePage === undefined ? data : {data, link: response.headers.get('link')};
  }
  return {
    get: (endpoint, {binary} = {}) => request('GET', endpoint, undefined, {binary}),
    assertNoRelease: async ({repository, repositoryId}, tagName, commit) => {
      if (!writable || !COMMIT.test(commit) || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new Error('A write-authorized release listing is required');
      const base = `/repos/${repository}`, identity = await request('GET', base, undefined, {expectedStatus: 200});
      if (identity?.id !== repositoryId || identity.full_name !== repository || identity.fork !== false ||
          (identity.permissions?.push !== undefined && identity.permissions.push !== true)) throw new Error('Repository identity or reported push permission differs');
      const seen = new Set();
      let last;
      for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
        const {data, link} = await request('GET', `${base}/releases`, undefined, {releasePage: page, expectedStatus: 200});
        const links = releasePageLinks(link, base, repositoryId, page);
        if (links.last !== undefined && last !== undefined && last !== links.last) throw new Error('Release pagination changed during listing');
        last = links.last ?? last;
        if (!Array.isArray(data) || data.length > RELEASE_PAGE_SIZE || (page > 1 && data.length === 0) || (links.next && data.length !== RELEASE_PAGE_SIZE) ||
            (last !== undefined && Boolean(links.next) !== (page < last))) throw new Error('Incomplete or unknown release listing page');
        for (const release of data) {
          if (!release || !Number.isSafeInteger(release.id) || release.id < 1 || typeof release.tag_name !== 'string' || typeof release.draft !== 'boolean' || seen.has(release.id)) throw new Error('Unknown or repeated release in listing');
          seen.add(release.id);
          if (release.tag_name === tagName) throw new Error('An existing release/draft for this tag must be handled by the CEO; no automatic resume');
        }
        if (!links.next) {
          // GitHub requires Contents: write for this endpoint and does not save the generated notes.
          const notes = await request('POST', `${base}/releases/generate-notes`, {tag_name: tagName, target_commitish: commit}, {expectedStatus: 200, maxJsonBytes: 1024 * 1024});
          if (typeof notes?.name !== 'string' || typeof notes.body !== 'string') throw new Error('Cannot confirm release write capability from generated notes response');
          return;
        }
        if (last > MAX_RELEASE_PAGES) break;
      }
      throw new Error('Release listing exceeds the reviewed pagination bound');
    },
    write: (method, endpoint, body) => request(method, endpoint, body),
    upload: async (repository, releaseId, name, bytes) => {
      if (!writable || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new Error('Invalid release upload authority');
      integer(releaseId, 'draft release ID');
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Invalid closed asset name');
      const url = `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
      const response = await fetcher(url, {method: 'POST', redirect: 'error', headers: {...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length)}, body: bytes, signal: AbortSignal.timeout(120000)});
      if (!response.ok) throw new Error(`GitHub asset upload failed: HTTP ${response.status}`);
      return JSON.parse((await boundedBytes(response, 1024 * 1024)).toString('utf8'));
    }
  };
}
async function boundedBytes(response, maximum) {
  if (!response.body) throw new Error('Missing API/download response body');
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {total += chunk.length; if (total > maximum) throw new Error('API/download response exceeds bound'); chunks.push(chunk);}
  return Buffer.concat(chunks);
}
function verifyTagEvent(event, env, policy) {
  if (env.GITHUB_EVENT_NAME !== 'push' || event.created !== true || event.forced !== false || event.deleted !== false || event.before !== '0'.repeat(40) ||
      env.GITHUB_REPOSITORY !== policy.repository || event.repository?.full_name !== policy.repository || event.repository?.id !== policy.repositoryId || event.repository?.fork !== false ||
      !policy.allowedActors.includes(env.GITHUB_ACTOR) || !policy.allowedActors.includes(env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR) || !policy.allowedActors.includes(event.sender?.login) ||
      !/^refs\/tags\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(event.ref || '') || env.GITHUB_REF !== event.ref || !COMMIT.test(event.after || '')) throw new Error('Release requires an authorized new non-forced annotated tag push');
  return event.ref.slice('refs/tags/'.length);
}
function verifyTagCheckout(root, ref, tagSha, commit, runGit) {
  const localTag = runGit('git', ['rev-parse', '--verify', `${ref}^{tag}`], {cwd: root, encoding: 'utf8', windowsHide: true});
  if (localTag.error || localTag.status !== 0 || localTag.stdout.trim() !== tagSha || gitState(root, runGit) !== commit) throw new Error('Checked-out tag object or clean source commit differs');
}
async function verifyPromotion({root = ROOT, event, env = process.env, client, writable = false, outputDirectory, runGit = spawnSync, verifyBundle = verifyCandidateDirectory} = {}) {
  const policy = loadRecipe(root), tagName = verifyTagEvent(event, env, policy), base = `/repos/${policy.repository}`;
  const repository = await client.get(base);
  if (repository.id !== policy.repositoryId || repository.full_name !== policy.repository || repository.fork) throw new Error('Release repository identity differs');
  const ref = await client.get(`${base}/git/ref/tags/${encodeURIComponent(tagName)}`);
  if (ref.ref !== event.ref || ref.object?.type !== 'tag' || !COMMIT.test(ref.object.sha || '')) throw new Error('Release ref must identify an exact annotated tag object');
  const tag = await client.get(`${base}/git/tags/${ref.object.sha}`);
  if (tag.sha !== ref.object.sha || tag.tag !== tagName || tag.object?.type !== 'commit' || !COMMIT.test(tag.object.sha)) throw new Error('Tag is not a direct annotated commit promotion');
  const promotion = promotionFromJson(tag.message);
  if (`v${promotion.version}` !== tagName || promotion.commit !== tag.object.sha || env.GITHUB_SHA !== promotion.commit || env.GITHUB_WORKFLOW_SHA !== promotion.commit) throw new Error('Annotated tag version/commit differs');
  if (event.after !== tag.sha && event.after !== promotion.commit) throw new Error('Push SHA differs from the verified tag object and target commit');
  if (writable && (env.STILL_VERIFIED_TAG_OBJECT !== tag.sha || env.STILL_VERIFIED_TAG_COMMIT !== promotion.commit)) throw new Error('Tag object or commit differs from the read-only verification job');
  verifyTagCheckout(root, event.ref, tag.sha, promotion.commit, runGit);
  const run = await client.get(`${base}/actions/runs/${promotion.candidate_run_id}/attempts/${promotion.candidate_run_attempt}`);
  if (run.id !== promotion.candidate_run_id || run.run_attempt !== promotion.candidate_run_attempt || run.status !== 'completed' || run.conclusion !== 'success' || run.event !== 'push' ||
      run.head_sha !== promotion.commit || run.head_branch !== `release-candidate/${promotion.version}` || run.path !== policy.candidateWorkflow || run.repository?.id !== policy.repositoryId || run.head_repository?.id !== policy.repositoryId ||
      !policy.allowedActors.includes(run.actor?.login) || !policy.allowedActors.includes(run.triggering_actor?.login || run.actor?.login)) throw new Error('Exact candidate workflow attempt is not an approved successful own-repository push');
  const artifact = await client.get(`${base}/actions/artifacts/${promotion.artifact_id}`);
  if (artifact.id !== promotion.artifact_id || artifact.expired !== false || artifact.name !== artifactName(promotion.version, promotion.commit) || artifact.digest !== promotion.artifact_digest ||
      artifact.workflow_run?.id !== promotion.candidate_run_id || artifact.workflow_run?.head_sha !== promotion.commit || artifact.workflow_run?.repository_id !== policy.repositoryId || artifact.workflow_run?.head_repository_id !== policy.repositoryId ||
      !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 || artifact.size_in_bytes > 2 * 1024 ** 3) throw new Error('Exact candidate artifact identity/digest differs');
  const archive = await client.get(`${base}/actions/artifacts/${promotion.artifact_id}/zip`, {binary: true});
  if (archive.length !== artifact.size_in_bytes || `sha256:${sha256(archive)}` !== promotion.artifact_digest) throw new Error('Downloaded artifact ZIP differs from the accepted digest');
  const target = assertNoLinks(outputDirectory || path.join(root, 'tools/release-promotion-candidate'), {allowMissing: true});
  writeEntries(safeZipEntries(archive), target);
  const verified = verifyBundle(target, {sourceRoot: root, expected: promotion, policy});
  return {policy, base, tagName, tagSha: tag.sha, promotion, artifact, verified, outputDirectory: target};
}
async function publishVerified(result, client, {log = value => process.stdout.write(`${value}\n`)} = {}) {
  const {policy, base, tagName, tagSha, promotion, verified} = result;
  await client.assertNoRelease(policy, tagName, promotion.commit);
  const currentRef = await client.get(`${base}/git/ref/tags/${encodeURIComponent(tagName)}`);
  if (currentRef.ref !== `refs/tags/${tagName}` || currentRef.object?.type !== 'tag' || currentRef.object.sha !== tagSha) throw new Error('Tag changed before draft creation');
  const release = await client.write('POST', `${base}/releases`, {tag_name: tagName, target_commitish: promotion.commit, name: `STILL ${promotion.version}`, draft: true, prerelease: false,
    body: `STILL · 静室是一款独立 Windows 音乐播放器。

### 安装

需要 Windows 10 或更新版本（x64）及 .NET Framework 4.8 或更新版本。下载并运行 \`STILL-${promotion.version}-Setup-x64.exe\`。首次启动会使用原封不动的官方 foobar2000 安装文件自动准备独立播放内核，无需预装 Node.js 或 foobar2000。

### 主要功能

- 支持 CUE 原生子曲导入。
- 支持原文、译文与内嵌歌词，并可实时调整歌词偏移。
- 读取内嵌封面和同目录封面，使用分级缓存。
- 记住窗口位置，可设置播放时防止系统睡眠与定时停止。
- 支持 Windows 媒体控件和媒体键。

### 音频与兼容性

- USB DAC 授权可选择硬件实例或本机当前 Windows 端点。范围取决于 Windows 能核验的身份和当前连接，所选操作须由用户审阅并确认，结果以实际验证为准。
- Apple Music 官方网页会话需要 Microsoft Edge WebView2 Runtime，经 Windows 系统音频输出。本版尚未提供可验证的 Apple Music 独占输出。

### 校验与指南

Setup 未签名，Windows 可能显示未知发布者。请用 \`SHA256SUMS.txt\` 校验下载文件。

[使用指南](https://github.com/${policy.repository}/blob/${tagName}/docs/public-user-guide.md)

构建来自固定 CI 候选运行 ${promotion.candidate_run_id} 的第 ${promotion.candidate_run_attempt} 次尝试，Artifact ${promotion.artifact_id}，源码 \`${promotion.commit}\`。`});
  integer(release.id, 'new draft release ID');
  if (release.tag_name !== tagName || release.draft !== true || release.assets?.length) throw new Error('New draft identity is unexpected; retain for manual review');
  log(`Created own draft release ${release.id}; failures retain it for CEO review.`);
  const uploaded = [];
  for (const [name, expected] of Object.entries(verified.assets)) {
    const bytes = regularBytes(verified.releaseRoot, name);
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error('Accepted asset changed before upload; own draft retained');
    const asset = await client.upload(policy.repository, release.id, name, bytes);
    if (!Number.isSafeInteger(asset.id) || asset.name !== name || asset.size !== expected.bytes || asset.state !== 'uploaded') throw new Error('Uploaded asset metadata differs; own draft retained');
    uploaded.push({id: asset.id, name, ...expected});
  }
  const remote = await client.get(`${base}/releases/${release.id}`);
  if (remote.draft !== true || remote.tag_name !== tagName || remote.id !== release.id) throw new Error('Draft state changed before verification');
  assertNames((remote.assets || []).map(asset => asset.name), Object.keys(verified.assets), 'remote five-asset release namespace');
  for (const expected of uploaded) {
    const asset = remote.assets.find(item => item.id === expected.id && item.name === expected.name);
    if (!asset || asset.size !== expected.bytes || asset.state !== 'uploaded') throw new Error('Remote asset identity/size differs; own draft retained');
    const bytes = await client.get(`${base}/releases/assets/${asset.id}`, {binary: true});
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256 || asset.digest && asset.digest !== `sha256:${expected.sha256}`) throw new Error('Remote asset bytes differ; own draft retained');
  }
  const finalRef = await client.get(`${base}/git/ref/tags/${encodeURIComponent(tagName)}`);
  if (finalRef.ref !== `refs/tags/${tagName}` || finalRef.object?.type !== 'tag' || finalRef.object.sha !== tagSha) throw new Error('Tag changed before publication; own draft retained');
  const published = await client.write('PATCH', `${base}/releases/${release.id}`, {draft: false});
  if (published.id !== release.id || published.draft !== false || published.tag_name !== tagName) throw new Error('Publication response differs; manual review required');
  log(`Published verified release ${release.id}.`);
  return {id: release.id, assets: uploaded.map(asset => ({id: asset.id, name: asset.name, sha256: asset.sha256}))};
}
async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || !['verify', 'publish'].includes(args[0])) throw new Error('Usage: node scripts/release-public-api.js verify|publish');
  if (!process.env.GITHUB_EVENT_PATH) throw new Error('A fixed Actions push event file is required');
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const writable = args[0] === 'publish';
  const token = writable ? process.env.GH_TOKEN : process.env.GH_READ_TOKEN;
  const client = makeClient({token, writable});
  const result = await verifyPromotion({event, client, writable});
  if (writable) await publishVerified(result, client);
  else {
    if (!process.env.GITHUB_OUTPUT) throw new Error('A fixed Actions step output file is required');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag_object_sha=${result.tagSha}\ntag_commit_sha=${result.promotion.commit}\n`);
    process.stdout.write(`Exact promotion verified: run ${result.promotion.candidate_run_id}, artifact ${result.promotion.artifact_id}.\n`);
  }
}
if (require.main === module) main().catch(error => {process.stderr.write(`${error.message}\n`); process.exitCode = 1;});
module.exports = {makeClient, boundedBytes, verifyTagEvent, verifyPromotion, publishVerified};
