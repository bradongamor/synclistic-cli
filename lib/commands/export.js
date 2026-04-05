const inquirer = require('inquirer');
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');
const { exportObjects, VALID_EXPORT_OBJECT_TYPES, DEFAULT_OUTPUT_DIR } = require('../utils/export');
const { createStoreRepository } = require('../store/store-repository');
const { attachCommandResult, toExitCode } = require('./command-result');

function exportCommand(program, deps = {}) {
  program
    .command('export [objects...]')
    .description('Export objects from a Shopify store to JSON files')
    .option('-s, --store <store>', 'Store name to export from')
    .option('-o, --output <path>', 'Output directory for export files')
    .option('-a, --all', 'Export all supported object types')
    .option('-v, --verbose', 'Enable verbose logging')
    .action(async (objects, options, command) => {
      const result = await handleExport(objects, options, deps);
      return attachCommandResult(command, result);
    });
}

async function handleExport(objects, options, deps = {}) {
  const log = deps.logger || logger;
  const prompt = deps.prompt || inquirer.prompt;
  const storeRepository = deps.storeRepository || createStoreRepository(deps);
  const exportObjectsFn = deps.exportObjects || exportObjects;

  try {
    if (options.verbose) {
      log.setVerbose(true);
    }

    const stores = await storeRepository.getAll();

    if (stores.length === 0) {
      log.error('Export', 'No stores configured. Use "synclistic add store" to add a store.');
      return { exitCode: 1 };
    }

    let selectedStore;

    if (options.store) {
      selectedStore = await storeRepository.findByName(options.store);
      if (!selectedStore) {
        log.error('Export', `Store "${options.store}" not found.`);
        log.info('Export', 'Available stores: ' + stores.map(s => s.store_name).join(', '));
        return { exitCode: 1 };
      }
    } else {
      const { store } = await prompt([{
        type: 'list',
        name: 'store',
        message: 'Select the store to export from:',
        choices: stores.map(store => ({ name: store.store_name, value: store }))
      }]);
      selectedStore = store;
    }

    let objectsToExport = objects;

    if (options.all) {
      objectsToExport = [...VALID_EXPORT_OBJECT_TYPES];
    } else if (objectsToExport.length === 0) {
      const { selectedObjects } = await prompt([{
        type: 'checkbox',
        name: 'selectedObjects',
        message: 'Select the objects to export:',
        choices: VALID_EXPORT_OBJECT_TYPES.map(obj => ({
          name: obj.charAt(0).toUpperCase() + obj.slice(1),
          value: obj
        })),
        loop: false,
        validate: (answer) => {
          if (answer.length < 1) {
            return 'You must choose at least one object type to export.';
          }
          return true;
        }
      }]);
      objectsToExport = selectedObjects;
    }

    const invalidObjects = objectsToExport.filter(
      (obj) => !VALID_EXPORT_OBJECT_TYPES.includes(obj.toLowerCase())
    );
    if (invalidObjects.length > 0) {
      log.error('Export', `Invalid object types: ${invalidObjects.join(', ')}`);
      log.info('Export', `Valid object types are: ${VALID_EXPORT_OBJECT_TYPES.join(', ')}`);
      return { exitCode: 1 };
    }

    objectsToExport = objectsToExport.map(obj => obj.toLowerCase());

    let outputDir = options.output;
    if (!outputDir) {
      const defaultPath = path.join(os.homedir(), DEFAULT_OUTPUT_DIR);
      const { outputPath: promptedPath } = await prompt([{
        type: 'input',
        name: 'outputPath',
        message: 'Enter output directory for export files:',
        default: defaultPath
      }]);
      outputDir = promptedPath;
    }

    let outputPath;
    if (path.isAbsolute(outputDir)) {
      outputPath = outputDir;
    } else if (outputDir.startsWith('~')) {
      outputPath = path.join(os.homedir(), outputDir.slice(1));
    } else {
      outputPath = path.join(os.homedir(), outputDir);
    }

    log.info('Export', `Exporting ${objectsToExport.join(', ')} from ${selectedStore.store_name}`);
    log.info('Export', `Output directory: ${outputPath}`);

    const exportRun = await exportObjectsFn(selectedStore, objectsToExport, outputPath, { logger: log });
    const results = exportRun.results.filter((result) => result.status === 'success');

    if (results.length === 0) {
      log.warn('Export', 'No objects were exported.');
      return { exitCode: 1, exportRun };
    }

    log.success('Export', '✅ Export completed successfully!');
    log.info('Export', `Exported ${results.length} file(s):`);
    results.forEach((result) => {
      log.info('Export', `  - ${result.objectType}: ${result.count} items → ${result.filepath}`);
    });

    return {
      exitCode: toExitCode(exportRun.success),
      exportRun
    };
  } catch (error) {
    log.error('Export', error.message);
    log.error('Export', '❌ Export failed');
    return { exitCode: 1, error };
  }
}

module.exports = exportCommand;
