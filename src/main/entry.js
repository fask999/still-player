'use strict';
// Product entry: the pure logger/traps precede every application module import.
const {createRuntimeLog, installRuntimeFailureHandlers} = require('./runtime-log');
async function launch() {
  const log = createRuntimeLog();
  const failures = installRuntimeFailureHandlers({log, onFatal: async () => {}});
  // A module-load failure rejects launch and reaches this already-installed
  // unhandledRejection trap. No application-owned process exists at this point.
  const {run} = require('./main');
  await run({runtimeBoundary: {log, failures}});
}
if (require.main === module || (process.versions.electron && process.type === 'browser')) void launch();
module.exports = {launch};
