'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const child = require('node:child_process');
const originalSpawn = child.spawn;
const { installTestEffectGuard } = require('../test-effect-guard.cjs');

// Never recursively launch test runners if default discovery imports this file.
if (require.main === module && !process.env.NODE_TEST_CONTEXT && !process.env.NODE_TEST_WORKER_ID) {
  const state = installTestEffectGuard();
  assert.equal(state.active, false);
  assert.strictEqual(child.spawn, originalSpawn);
  const { run } = require('node:test');
  let passed = 0, failed = 0;
  const stream = run({ files: [path.join(__dirname, 'worker.cjs')], isolation: 'process', concurrency: 1 });
  stream.on('test:pass', () => { passed++; });
  stream.on('test:fail', event => { failed++; process.stderr.write(`${event.data?.name || event.name}\n`); });
  stream.on('end', () => {
    assert.ok(passed >= 9, 'The unpatched parent must run the guarded worker tests');
    assert.equal(failed, 0);
    process.stdout.write(`${JSON.stringify({ parentGuardActive: state.active, parentSpawnUnchanged: child.spawn === originalSpawn,
      workerPassed: passed, workerFailed: failed })}\n`);
  });
  stream.resume();
}
