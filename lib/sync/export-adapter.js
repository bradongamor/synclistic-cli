const os = require('os');
const path = require('path');
const { exportObjects, VALID_EXPORT_OBJECT_TYPES, DEFAULT_OUTPUT_DIR } = require('../utils/export');

function resolveExportPath(outputPath = DEFAULT_OUTPUT_DIR) {
  if (path.isAbsolute(outputPath)) {
    return outputPath;
  }

  if (outputPath.startsWith('~')) {
    return path.join(os.homedir(), outputPath.slice(1));
  }

  return path.join(os.homedir(), outputPath);
}

function createExportBeforeSyncAdapter(logger, deps = {}) {
  const exportObjectsFn = deps.exportObjects || exportObjects;

  return async function exportBeforeSync({ config }) {
    const exportableObjects = config.orderedObjects.filter((objectType) =>
      VALID_EXPORT_OBJECT_TYPES.includes(objectType)
    );

    if (exportableObjects.length === 0) {
      logger.warn('Sync', 'No exportable object types selected, skipping export');
      return;
    }

    const outputPath = resolveExportPath(config.outputPath || DEFAULT_OUTPUT_DIR);

    logger.info('Sync', '📦 Exporting destination store data before sync...');
    logger.info('Sync', `Export path: ${outputPath}`);

    try {
      const exportRun = await exportObjectsFn(
        config.destination,
        exportableObjects,
        outputPath,
        { logger }
      );

      const exportResults = exportRun.results.filter((result) => result.status === 'success');

      logger.success(
        'Sync',
        `✅ Exported ${exportResults.length} object type(s) from ${config.destination.store_name}`
      );
      exportResults.forEach((result) => {
        logger.info('Sync', `  - ${result.objectType}: ${result.count} items`);
      });

      if (!exportRun.success) {
        throw new Error(exportRun.errors.join('; ') || 'Export failed');
      }
    } catch (error) {
      logger.error('Sync', `Failed to export destination store: ${error.message}`);
      if (config.exportFailureBehavior !== 'continue') {
        logger.info('Sync', 'Sync cancelled.');
        throw error;
      }
      logger.warn('Sync', 'Continuing with sync despite export failure.');
    }
  };
}

module.exports = {
  createExportBeforeSyncAdapter,
  resolveExportPath
};
