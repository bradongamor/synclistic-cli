#!/usr/bin/env node

const { ensureSupportedNodeVersion } = require('../lib/runtime/node-version');
const { runSmoke } = require('../lib/smoke/run-smoke');

if (!ensureSupportedNodeVersion()) {
  process.exitCode = 1;
  return;
}

runSmoke()
  .then((result) => {
    if (result.skipped) {
      process.exitCode = 0;
      return;
    }

    process.exitCode = result.success ? 0 : 1;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
