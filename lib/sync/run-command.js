const { requireWithFallback } = require('../utils/require-package');

const { runSync } = requireWithFallback(
  require,
  '@synclistic/sync-core',
  '../../../packages/sync-core'
);
const { createStoreClient } = requireWithFallback(
  require,
  '@synclistic/shopify-client',
  '../../../packages/shopify-client'
);

const logger = require('../utils/logger');
const { createStoreRepository } = require('./store-repository');
const { createCliReporter } = require('./reporter');
const { createExportBeforeSyncAdapter } = require('./export-adapter');
const { buildSyncRequest, createExitResult, resolveSyncCommandRequest } = require('./resolve-config');
const { toExitCode } = require('../commands/command-result');

async function executeSyncCommand(objects, options, deps = {}) {
  const syncLogger = deps.logger || logger;

  if (options.verbose) {
    syncLogger.setVerbose(true);
  }

  try {
    const request = buildSyncRequest(objects, options);
    const resolution = await resolveSyncCommandRequest(request, {
      logger: syncLogger,
      prompt: deps.prompt,
      env: deps.env,
      storeRepository: deps.storeRepository || createStoreRepository(deps)
    });

    if (!resolution.ok) {
      return resolution;
    }

    syncLogger.info(
      'Sync',
      `Sync order based on dependencies: ${resolution.orderedObjects.join(' → ')}`
    );
    syncLogger.info(
      'Sync',
      `Starting sync from ${resolution.config.source.store_name} to ${resolution.config.destination.store_name}`
    );

    const reporter = deps.reporter || createCliReporter(syncLogger);
    const result = await runSync(resolution.config, {
      reporter,
      exportBeforeSync:
        deps.exportBeforeSync || createExportBeforeSyncAdapter(syncLogger, deps),
      executeObject: deps.executeObject,
      clientFactory: deps.clientFactory || createStoreClient
    });

    if (result.errors.length > 0) {
      syncLogger.warn('Sync', '⚠️ Sync completed with some errors');
    } else {
      syncLogger.success('Sync', '✅ Sync completed successfully!');
    }

    return createExitResult(toExitCode(result.success), {
      result
    });
  } catch (error) {
    syncLogger.error('Sync', error.message);
    syncLogger.error('Sync', '❌ Sync failed to complete');
    return createExitResult(1, {
      reason: 'sync-command-failed',
      error
    });
  }
}

module.exports = {
  executeSyncCommand
};
