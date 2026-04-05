const inquirer = require('inquirer');
const { evaluateDestructiveSyncAccess } = require('../utils/internal-test-mode');
const { requireWithFallback } = require('../utils/require-package');

const {
  getSyncOrder,
  UNSUPPORTED_SYNC_OBJECT_TYPES,
  VALID_SYNC_OBJECT_TYPES,
  validateSyncConfig
} = requireWithFallback(
  require,
  '@synclistic/sync-core',
  '../../../packages/sync-core'
);

const SUPPORTED_SYNC_OBJECT_TYPES = VALID_SYNC_OBJECT_TYPES.filter(
  (objectType) => !UNSUPPORTED_SYNC_OBJECT_TYPES.includes(objectType)
);

function logValidationErrors(logger, errors) {
  for (const error of errors) {
    logger.error('Sync', error.message);

    if (error.code === 'INVALID_OBJECT_TYPES') {
      logger.info('Sync', `Supported sync objects are: ${SUPPORTED_SYNC_OBJECT_TYPES.join(', ')}`);
    } else if (error.code === 'INVALID_SYNC_MODE') {
      logger.info('Sync', 'Valid sync modes are: create-and-update, create, update');
    } else if (error.code === 'INVALID_EXPORT_FAILURE_BEHAVIOR') {
      logger.info('Sync', 'Valid values are: continue, fail');
    } else if (error.code === 'INVALID_THEME_SYNC_MODE') {
      logger.info('Sync', 'Valid theme sync modes are: dependencies, full');
    } else if (error.code === 'INVALID_MISSING_TEMPLATE_POLICY') {
      logger.info('Sync', 'Valid missing template policies are: clear, keep, error');
    }
  }
}

function buildSyncRequest(objects, options) {
  return {
    objects: Array.isArray(objects) ? objects : [],
    from: options.from,
    to: options.to,
    cleanDestination: Boolean(options.cleanDestination),
    createOnly: Boolean(options.createOnly),
    updateOnly: Boolean(options.updateOnly),
    syncMode: options.syncMode || 'create-and-update',
    sourceProductIds: options.sourceProductsIds,
    destinationProductIds: options.destinationProductsIds,
    themeSyncMode: options.themeSyncMode || 'dependencies',
    destinationThemeId: options.destinationThemeId || null,
    missingTemplatePolicy: options.missingTemplatePolicy || 'clear',
    exportBeforeSync: Boolean(options.export),
    outputPath: options.output,
    exportFailureBehavior: options.onExportFailure || 'fail',
    verbose: Boolean(options.verbose)
  };
}

function createExitResult(exitCode, extras = {}) {
  return {
    ok: exitCode === 0,
    exitCode,
    ...extras
  };
}

function buildStoreChoices(stores) {
  return stores.map((store) => ({ name: store.store_name, value: store }));
}

function rejectUnsupportedObjectTypes(objects, logger) {
  const normalizedObjects = Array.isArray(objects)
    ? objects.map((objectType) => String(objectType).toLowerCase())
    : [];
  const unsupportedObjects = normalizedObjects.filter((objectType) =>
    UNSUPPORTED_SYNC_OBJECT_TYPES.includes(objectType)
  );

  if (unsupportedObjects.length === 0) {
    return null;
  }

  logger.error('Sync', `Unsupported object types: ${unsupportedObjects.join(', ')}`);
  logger.info('Sync', `Supported sync objects are: ${SUPPORTED_SYNC_OBJECT_TYPES.join(', ')}`);

  return createExitResult(1, {
    reason: 'unsupported-object-types',
    unsupportedObjectTypes: unsupportedObjects
  });
}

async function resolveSyncCommandRequest(request, deps) {
  const logger = deps.logger;
  const prompt = deps.prompt || inquirer.prompt;
  const storeRepository = deps.storeRepository;
  const stores = await storeRepository.getAll();
  const isProductIdSync = Boolean(
    request.sourceProductIds || request.destinationProductIds
  );

  if ((request.from && !request.to) || (!request.from && request.to)) {
    const missing = request.from ? '-t, --to' : '-f, --from';
    logger.error('Sync', `Missing required option: ${missing}`);
    logger.info('Sync', 'When specifying a source or destination store, both must be provided.');
    logger.info('Sync', 'Example: synclistic sync products -f sourceStore -t destStore');
    return createExitResult(1, { reason: 'missing-store-option-pair' });
  }

  if (isProductIdSync) {
    if (!request.from || !request.to) {
      logger.error('Sync', 'Single product sync requires both --from and --to store options.');
      return createExitResult(1, { reason: 'product-id-sync-missing-stores' });
    }
    if (!request.sourceProductIds) {
      logger.error('Sync', 'Product ID sync requires --source-products-ids.');
      return createExitResult(1, { reason: 'product-id-sync-missing-source-ids' });
    }
  }

  let sourceStore = null;
  let destinationStore = null;

  if (request.from) {
    sourceStore = stores.find(
      (store) => store.store_name.toLowerCase() === request.from.toLowerCase()
    );
    if (!sourceStore) {
      logger.error('Sync', `Source store "${request.from}" not found.`);
      logger.info('Sync', 'Available stores: ' + stores.map((store) => store.store_name).join(', '));
      return createExitResult(1, { reason: 'source-store-not-found' });
    }
  }

  if (request.to) {
    destinationStore = stores.find(
      (store) => store.store_name.toLowerCase() === request.to.toLowerCase()
    );
    if (!destinationStore) {
      logger.error('Sync', `Destination store "${request.to}" not found.`);
      logger.info('Sync', 'Available stores: ' + stores.map((store) => store.store_name).join(', '));
      return createExitResult(1, { reason: 'destination-store-not-found' });
    }
  }

  const remainingStores = stores.filter(
    (store) =>
      (!sourceStore || store.store_name !== sourceStore.store_name) &&
      (!destinationStore || store.store_name !== destinationStore.store_name)
  );

  if (!sourceStore && !destinationStore && stores.length < 2) {
    logger.error('Sync', 'You need at least two stores to perform a sync operation.');
    logger.info('Sync', 'Use "synclistic add store" to add more stores.');
    return createExitResult(1, { reason: 'not-enough-stores' });
  }

  if (!sourceStore && stores.length < 1) {
    logger.error('Sync', 'No stores available to use as source.');
    logger.info('Sync', 'Use "synclistic add store" to add a store.');
    return createExitResult(1, { reason: 'missing-source-store' });
  }

  if (!destinationStore && remainingStores.length < 1) {
    logger.error('Sync', 'No stores available to use as destination.');
    if (stores.length < 2) {
      logger.info('Sync', 'Use "synclistic add store" to add another store.');
    } else {
      logger.info('Sync', 'Available stores: ' + remainingStores.map((store) => store.store_name).join(', '));
    }
    return createExitResult(1, { reason: 'missing-destination-store' });
  }

  const storeChoices = buildStoreChoices(stores);

  if (!sourceStore) {
    const response = await prompt([
      {
        type: 'list',
        name: 'source',
        message: 'Select the source store:',
        choices: storeChoices
      }
    ]);
    sourceStore = response.source;
  }

  if (!destinationStore) {
    const response = await prompt([
      {
        type: 'list',
        name: 'destination',
        message: 'Select the destination store:',
        choices: storeChoices.filter((choice) => choice.value !== sourceStore)
      }
    ]);
    destinationStore = response.destination;
  }

  let selectedObjects = request.objects;
  if (selectedObjects.length === 0) {
    if (isProductIdSync) {
      selectedObjects = ['products'];
    } else {
      const response = await prompt([
        {
          type: 'checkbox',
          name: 'selectedObjects',
          message: 'Select the objects to sync:',
          choices: SUPPORTED_SYNC_OBJECT_TYPES.map(
            (objectType) => objectType.charAt(0).toUpperCase() + objectType.slice(1)
          ),
          filter: (choices) => choices.map((choice) => choice.toLowerCase()),
          loop: false,
          validate: (answer) => {
            if (answer.length < 1) {
              return 'You must choose at least one object to sync.';
            }
            return true;
          }
        }
      ]);
      selectedObjects = response.selectedObjects;
    }
  }

  const unsupportedSelection = rejectUnsupportedObjectTypes(selectedObjects, logger);
  if (unsupportedSelection) {
    return unsupportedSelection;
  }

  const validation = validateSyncConfig({
    objects: selectedObjects,
    source: sourceStore,
    destination: destinationStore,
    createOnly: request.createOnly,
    updateOnly: request.updateOnly,
    syncMode: request.syncMode,
    cleanDestination: request.cleanDestination,
    exportBeforeSync: request.exportBeforeSync,
    outputPath: request.outputPath,
    exportFailureBehavior: request.exportFailureBehavior,
    themeSyncMode: request.themeSyncMode,
    destinationThemeId: request.destinationThemeId,
    missingTemplatePolicy: request.missingTemplatePolicy,
    sourceProductIds: request.sourceProductIds,
    destinationProductIds: request.destinationProductIds,
    verbose: request.verbose
  });

  if (!validation.valid) {
    logValidationErrors(logger, validation.errors);
    return createExitResult(1, {
      reason: 'validation-failed',
      validationErrors: validation.errors
    });
  }

  if (request.cleanDestination) {
    const access = evaluateDestructiveSyncAccess(destinationStore, deps.env || process.env);
    if (!access.ok) {
      logger.error('Sync', access.message);
      return createExitResult(1, {
        reason: 'destructive-sync-not-allowed',
        destructiveSyncError: access
      });
    }
  }

  return createExitResult(0, {
    request: {
      ...request,
      objects: selectedObjects
    },
    config: validation.normalizedConfig,
    orderedObjects: getSyncOrder(validation.normalizedConfig.objects)
  });
}

module.exports = {
  SUPPORTED_SYNC_OBJECT_TYPES,
  VALID_SYNC_OBJECT_TYPES,
  buildSyncRequest,
  createExitResult,
  logValidationErrors,
  resolveSyncCommandRequest
};
