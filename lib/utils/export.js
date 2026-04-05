const { requireWithFallback } = require('./require-package');

const syncCore = requireWithFallback(
  require,
  '@synclistic/sync-core',
  '../../../packages/sync-core'
);

module.exports = {
  exportObjects: syncCore.exportObjects,
  importObjects: syncCore.importObjects,
  readExportFile: syncCore.readExportFile,
  listExportFiles: syncCore.listExportFiles,
  VALID_OBJECT_TYPES: syncCore.VALID_EXPORT_OBJECT_TYPES,
  VALID_EXPORT_OBJECT_TYPES: syncCore.VALID_EXPORT_OBJECT_TYPES,
  DEFAULT_OUTPUT_DIR: syncCore.DEFAULT_OUTPUT_DIR
};
