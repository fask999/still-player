'use strict';
const path = require('node:path');
const { INTEGRATION_SUITES } = require('../tests/helpers/test-effect-guard.cjs');
// Source auditing may read an explicitly provided SDK; it never receives the
// native suites' effect-guard bypass and cannot launch a compiler or helper.
const RUNNER_SUITES = Object.freeze({ ...INTEGRATION_SUITES, 'spectrum-sdk-source': 'spectrum-component.test.js' });
const ROOT = path.resolve(__dirname, '..');

function invalidArguments() {
  return Object.assign(new Error('Use --suite <allowlisted-suite> and optional --execute'), { code: 'STILL_INTEGRATION_ARGUMENTS' });
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw invalidArguments();
  let suite, execute = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--suite') {
      if (suite !== undefined || !Object.hasOwn(RUNNER_SUITES, argv[index + 1])) throw invalidArguments();
      suite = argv[++index];
    } else if (argument === '--execute' && !execute) execute = true;
    else throw invalidArguments();
  }
  if (!suite) throw invalidArguments();
  return { suite, execute };
}

function createPlan(options) {
  if (!options || !Object.hasOwn(RUNNER_SUITES, options.suite) || typeof options.execute !== 'boolean') throw invalidArguments();
  const testFile = `tests/${RUNNER_SUITES[options.suite]}`;
  const environment = { STILL_TEST_INTEGRATION: '1', STILL_TEST_INTEGRATION_SUITE: options.suite };
  if (options.suite === 'spectrum-pipe') environment.STILL_SPECTRUM_REAL_PIPE_FIXTURE = '1';
  return { suite: options.suite, execute: options.execute, testFile,
    nodeArguments: ['--test', testFile], environment };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  // Reject the entire argument list before printing, resolving a spawn default
  // or launching anything. Plan mode is always the default.
  const plan = createPlan(parseArgs(argv));
  const print = dependencies.print || (value => process.stdout.write(`${JSON.stringify(value)}\n`));
  print(plan);
  if (!plan.execute) return { ...plan, status: 'planned', exitCode: 0 };

  const env = { ...(dependencies.env || process.env) };
  for (const name of ['STILL_TEST_INTEGRATION', 'STILL_TEST_INTEGRATION_SUITE', 'STILL_SPECTRUM_REAL_PIPE_FIXTURE']) delete env[name];
  Object.assign(env, plan.environment);
  const spawn = dependencies.spawn || require('node:child_process').spawn;
  const outcome = await new Promise(resolve => {
    let child;
    try {
      child = spawn(process.execPath, plan.nodeArguments, {
        cwd: ROOT, env, windowsHide: true, shell: false, stdio: 'inherit'
      });
    } catch { resolve({ exitCode: 1 }); return; }
    child.once('error', () => resolve({ exitCode: 1 }));
    child.once('close', (code, signal) => resolve({ exitCode: !signal && Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1 }));
  });
  return { ...plan, status: outcome.exitCode === 0 ? 'completed' : 'failed', ...outcome };
}

if (require.main === module) {
  main().then(result => { process.exitCode = result.exitCode; }, () => {
    process.stderr.write('Integration runner rejected the request. Use --suite <allowlisted-suite> and optional --execute.\n');
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, createPlan, main, RUNNER_SUITES };
