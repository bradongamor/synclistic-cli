#!/usr/bin/env node

const { ensureSupportedNodeVersion } = require('../lib/runtime/node-version');

if (!ensureSupportedNodeVersion()) {
  process.exitCode = 1;
  return;
}

require('../lib/index.js');
