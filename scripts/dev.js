'use strict';
const {spawn} = require('node:child_process');
const path = require('node:path');
const executable = require('electron');
const environment = {...process.env};
delete environment.ELECTRON_RUN_AS_NODE;
const args = [];
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === '--smoke') environment.STILL_SMOKE_TEST = '1';
  else if (argument === '--smoke-lyrics-fixture') {environment.STILL_SMOKE_TEST = '1'; environment.STILL_SMOKE_LYRICS_FIXTURE = '1';}
  else if (argument === '--smoke-plan' || argument === '--data-dir') {
    const value = process.argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    environment[argument === '--smoke-plan' ? 'STILL_SMOKE_PLAN' : 'STILL_DATA_DIR'] = path.resolve(value);
    if (argument === '--smoke-plan') environment.STILL_SMOKE_TEST = '1';
  } else args.push(argument);
}
if (environment.STILL_SMOKE_TEST === '1' && !environment.STILL_DATA_DIR) throw new Error('Choose an explicit smoke data directory with --data-dir or STILL_DATA_DIR');
const child = spawn(executable, [path.resolve(__dirname, '..'), ...args], {stdio: 'inherit', env: environment, windowsHide: false});
child.on('error', error => {console.error(error.message); process.exitCode = 1;});
child.on('exit', code => {process.exitCode = code ?? 1;});
