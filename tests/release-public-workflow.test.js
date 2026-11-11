'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
test('candidate is own push-only read permission, exact action pins, clean resource closure and no publish token', () => {
  const source = read('.github/workflows/release-candidate.yml');
  assert.match(source, /branches: \['release-candidate\/\*\*'\]/);
  assert.match(source, /permissions:\s+contents: read/);
  assert.doesNotMatch(source, /contents: write|GH_TOKEN|pull_request_target|workflow_run|issue_comment/);
  for (const match of source.matchAll(/uses:\s+([^\s#]+)/g)) assert.match(match[1], /^actions\/[a-z-]+@[a-f0-9]{40}$/);
  assert.match(source, /persist-credentials: false/);
  for (const file of ['prepare-release-tools-node.ps1', 'prepare-release-tools.js', 'prepare-release-tools-nonui.js', 'nonui-fixture.ps1', 'release-public.js candidate']) assert.ok(source.includes(file));
  assert.match(source, /overwrite: false/); assert.match(source, /if-no-files-found: error/);
  assert.match(source, /^\s+compression-level: 6$/m);
  assert.doesNotMatch(source, /csc|msbuild|dotnet build|Start-Process.*Still/i);
});
test('publish separates read verification and write API promotion, never builds or invokes installers', () => {
  const source = read('.github/workflows/release-publish.yml'), readonly = source.slice(source.indexOf('  verify-promotion:'), source.indexOf('  publish:')), write = source.slice(source.indexOf('  publish:'));
  assert.match(readonly, /contents: read/); assert.match(readonly, /actions: read/); assert.doesNotMatch(readonly, /contents: write|GH_TOKEN:/);
  assert.match(readonly, /tag_object_sha: \$\{\{ steps\.verify\.outputs\.tag_object_sha \}\}/);
  assert.match(readonly, /tag_commit_sha: \$\{\{ steps\.verify\.outputs\.tag_commit_sha \}\}/);
  assert.match(readonly, /id: verify[\s\S]+release-public-api\.js verify/);
  assert.match(write, /needs: verify-promotion/); assert.match(write, /contents: write/); assert.match(write, /actions: read/);
  assert.match(write, /STILL_VERIFIED_TAG_OBJECT: \$\{\{ needs\.verify-promotion\.outputs\.tag_object_sha \}\}/);
  assert.match(write, /STILL_VERIFIED_TAG_COMMIT: \$\{\{ needs\.verify-promotion\.outputs\.tag_commit_sha \}\}/);
  assert.equal((write.match(/GH_TOKEN:/g) || []).length, 1);
  assert.match(write, /release-public-api\.js publish/);
  assert.doesNotMatch(source, /npm|package-public|build-installer|pull_request_target|issue_comment|Start-Process|Uninstall\.exe/);
  for (const match of source.matchAll(/uses:\s+([^\s#]+)/g)) assert.match(match[1], /^actions\/[a-z-]+@[a-f0-9]{40}$/);
  assert.equal((source.match(/persist-credentials: false/g) || []).length, 4);
  assert.match(source, /push:\s+branches: \['release-recovery\/v1\.1\.0'\]\s+tags: \['v\*'\]/);
  assert.match(source, /group: public-release-\$\{\{ github\.ref == 'refs\/heads\/release-recovery\/v1\.1\.0' && 'refs\/tags\/v1\.1\.0' \|\| github\.ref \}\}/);
  for (const job of [readonly, write]) {
    assert.match(job, /if: github\.ref == 'refs\/heads\/release-recovery\/v1\.1\.0'[\s\S]+ref: refs\/tags\/v1\.1\.0\s+path: tools\/release-recovery-source/);
  }
  assert.doesNotMatch(source, /workflow_dispatch|repository_dispatch|pull_request/);
});
test('portable Node bootstrap fixes official source/bytes and validates every ZIP entry before extract', () => {
  const source = read('scripts/prepare-release-tools-node.ps1');
  assert.match(source, /d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5/);
  assert.ok(source.indexOf('Get-FileHash') < source.indexOf('ExtractToDirectory'));
  assert.ok(source.indexOf('foreach ($entry in $zip.Entries)') < source.indexOf('ExtractToDirectory'));
  assert.match(source, /ReparsePoint/); assert.match(source, /HashSet/);
  assert.doesNotMatch(source, /ExecutionPolicy|Set-ExecutionPolicy|RunAs|Uninstall/i);
  assert.match(read('.github/workflows/ci.yml'), /node-version: '24\.22\.1'/);
});
