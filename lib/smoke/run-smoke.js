const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { requireWithFallback } = require('../utils/require-package');

const { exportObjects, importObjects, OBJECT_EXECUTORS } = requireWithFallback(
  require,
  '@synclistic/sync-core',
  '../../../packages/sync-core'
);

const { executeSyncCommand } = require('../sync/run-command');

const REQUIRED_ENV_VARS = Object.freeze([
  'SYNCLISTIC_SMOKE_SOURCE_NAME',
  'SYNCLISTIC_SMOKE_SOURCE_URL',
  'SYNCLISTIC_SMOKE_SOURCE_TOKEN',
  'SYNCLISTIC_SMOKE_DESTINATION_NAME',
  'SYNCLISTIC_SMOKE_DESTINATION_URL',
  'SYNCLISTIC_SMOKE_DESTINATION_TOKEN'
]);

const SUPPORTED_SMOKE_OBJECT_TYPES = Object.freeze(Object.keys(OBJECT_EXECUTORS));

function buildStore(env, prefix) {
  return {
    store_name: env[`SYNCLISTIC_SMOKE_${prefix}_NAME`],
    store_url: env[`SYNCLISTIC_SMOKE_${prefix}_URL`],
    api_key: env[`SYNCLISTIC_SMOKE_${prefix}_TOKEN`]
  };
}

function getSmokeConfig(env = process.env) {
  const missing = REQUIRED_ENV_VARS.filter((name) => !env[name]);

  return {
    missing,
    source: buildStore(env, 'SOURCE'),
    destination: buildStore(env, 'DESTINATION'),
    outputPath:
      env.SYNCLISTIC_SMOKE_OUTPUT_PATH ||
      path.join(os.tmpdir(), 'synclistic-smoke-exports')
  };
}

async function runSmoke(deps = {}) {
  const env = deps.env || process.env;
  const log = deps.logger || console;
  const exportObjectsFn = deps.exportObjects || exportObjects;
  const importObjectsFn = deps.importObjects || importObjects;
  const executeSync = deps.executeSyncCommand || executeSyncCommand;
  const fsPromises = deps.fs || fs;
  const config = getSmokeConfig(env);

  if (config.missing.length > 0) {
    const message = `Skipping smoke run; missing env vars: ${config.missing.join(', ')}`;
    if (typeof log.warn === 'function') {
      log.warn(message);
    }
    return {
      skipped: true,
      success: true,
      missing: config.missing,
      steps: []
    };
  }

  await fsPromises.mkdir(config.outputPath, { recursive: true });

  const steps = [];
  const storeRepository = {
    async getAll() {
      return [config.source, config.destination];
    },
    async findByName(name) {
      return [config.source, config.destination].find(
        (store) => store.store_name.toLowerCase() === String(name).toLowerCase()
      );
    }
  };

  async function runSyncStep(objects) {
    const resolution = await executeSync(objects, {
      from: config.source.store_name,
      to: config.destination.store_name,
      syncMode: 'create-and-update',
      cleanDestination: false,
      verbose: false
    }, {
      storeRepository
    });

    steps.push({
      type: 'sync',
      objects,
      exitCode: resolution.exitCode,
      success: resolution.ok
    });

    if (!resolution.ok) {
      throw new Error(`Smoke sync failed for ${objects.join(', ')}`);
    }
  }

  for (const objectType of SUPPORTED_SMOKE_OBJECT_TYPES) {
    await runSyncStep([objectType]);
  }

  const exportRun = await exportObjectsFn(config.source, ['pages'], config.outputPath);
  steps.push({
    type: 'export',
    success: exportRun.success,
    errors: exportRun.errors
  });
  if (!exportRun.success || exportRun.results.length === 0) {
    throw new Error('Smoke export failed');
  }

  const importRun = await importObjectsFn(config.destination, exportRun.results[0].filepath, {});
  steps.push({
    type: 'import',
    success: importRun.success,
    errors: importRun.errors
  });
  if (!importRun.success) {
    throw new Error('Smoke import failed');
  }

  return {
    skipped: false,
    success: true,
    missing: [],
    steps
  };
}

module.exports = {
  REQUIRED_ENV_VARS,
  SUPPORTED_SMOKE_OBJECT_TYPES,
  getSmokeConfig,
  runSmoke
};
