const { requireWithFallback } = require('./require-package');

const { SYNC_DEPENDENCIES, getSyncOrder } = requireWithFallback(
  require,
  '@synclistic/sync-core',
  '../../../packages/sync-core'
);

module.exports = {
  syncDependencies: SYNC_DEPENDENCIES,
  getSyncOrder
};
