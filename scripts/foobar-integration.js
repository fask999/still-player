'use strict';
// Compatibility entry point; default invocation prints a plan without controlling audio.
const { main } = require('./foobar-audio-acceptance');
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
