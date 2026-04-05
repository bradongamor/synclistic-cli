const inquirer = require('inquirer');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const { importObjects, listExportFiles, readExportFile } = require('../utils/export');
const { createStoreRepository } = require('../store/store-repository');
const { attachCommandResult, toExitCode } = require('./command-result');

function importCommand(program, deps = {}) {
  program
    .command('import <path>')
    .description('Import objects from export files into a Shopify store')
    .option('-s, --store <store>', 'Target store name for import')
    .option('--dry-run', 'Preview what would be imported without making changes')
    .option('--create-only', 'Only create new objects, skip updates')
    .option('--update-only', 'Only update existing objects, skip creates')
    .option('-v, --verbose', 'Enable verbose logging')
    .action(async (importPath, options, command) => {
      const result = await handleImport(importPath, options, deps);
      return attachCommandResult(command, result);
    });
}

async function handleImport(importPath, options, deps = {}) {
  const log = deps.logger || logger;
  const prompt = deps.prompt || inquirer.prompt;
  const fsPromises = deps.fs || fs;
  const storeRepository = deps.storeRepository || createStoreRepository(deps);
  const importObjectsFn = deps.importObjects || importObjects;
  const listExportFilesFn = deps.listExportFiles || listExportFiles;
  const readExportFileFn = deps.readExportFile || readExportFile;

  try {
    if (options.verbose) {
      log.setVerbose(true);
    }

    if (options.createOnly && options.updateOnly) {
      log.error('Import', '--create-only and --update-only cannot be used together');
      return { exitCode: 1 };
    }

    let resolvedPath;
    if (path.isAbsolute(importPath)) {
      resolvedPath = importPath;
    } else if (importPath.startsWith('~')) {
      resolvedPath = path.join(os.homedir(), importPath.slice(1));
    } else {
      resolvedPath = path.join(os.homedir(), importPath);
    }

    try {
      await fsPromises.access(resolvedPath);
    } catch {
      log.error('Import', `Path not found: ${resolvedPath}`);
      return { exitCode: 1 };
    }

    const stats = await fsPromises.stat(resolvedPath);
    let filesToImport = [];
    let previewInfo = [];

    if (stats.isDirectory()) {
      const files = await listExportFilesFn(resolvedPath);
      if (files.length === 0) {
        log.error('Import', 'No valid export files found in directory');
        return { exitCode: 1 };
      }
      filesToImport = files;
      previewInfo = files.map(f => `  - ${f.objectType}: ${f.count} items (from ${f.storeName})`);
    } else {
      const exportData = await readExportFileFn(resolvedPath);
      filesToImport = [{
        filepath: resolvedPath,
        objectType: exportData.objectType,
        storeName: exportData.storeName,
        count: exportData.count,
        createdAt: exportData.createdAt
      }];
      previewInfo = [`  - ${exportData.objectType}: ${exportData.count} items (from ${exportData.storeName})`];
    }

    log.info('Import', `Found export file(s) to import:`);
    previewInfo.forEach(line => log.info('Import', line));

    const stores = await storeRepository.getAll();

    if (stores.length === 0) {
      log.error('Import', 'No stores configured. Use "synclistic add store" to add a store.');
      return { exitCode: 1 };
    }

    let selectedStore;

    if (options.store) {
      selectedStore = await storeRepository.findByName(options.store);
      if (!selectedStore) {
        log.error('Import', `Store "${options.store}" not found.`);
        log.info('Import', 'Available stores: ' + stores.map(s => s.store_name).join(', '));
        return { exitCode: 1 };
      }
    } else {
      const { store } = await prompt([{
        type: 'list',
        name: 'store',
        message: 'Select the target store for import:',
        choices: stores.map(store => ({ name: store.store_name, value: store }))
      }]);
      selectedStore = store;
    }

    if (options.dryRun) {
      log.info('Import', '\n🔍 DRY RUN MODE - No changes will be made\n');
    }

    if (!options.dryRun) {
      const sourceStores = [...new Set(filesToImport.map(f => f.storeName))];
      const warningMsg = sourceStores.length === 1 
        ? `This will import data from "${sourceStores[0]}" into "${selectedStore.store_name}".`
        : `This will import data from multiple sources into "${selectedStore.store_name}".`;

      const { confirm } = await prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `${warningMsg} Continue?`,
        default: false
      }]);

      if (!confirm) {
        log.info('Import', 'Import cancelled.');
        return { exitCode: 0 };
      }
    }

    const importOptions = {
      dryRun: options.dryRun,
      createOnly: options.createOnly,
      updateOnly: options.updateOnly
    };

    log.info('Import', `\nImporting into ${selectedStore.store_name}...`);

    const importRun = await importObjectsFn(selectedStore, resolvedPath, importOptions, { logger: log, fs: fsPromises });
    const results = importRun.results;

    if (options.dryRun) {
      log.success('Import', '\n✅ Dry run completed - no changes were made');
    } else {
      const hasErrors = results.some((result) => result.error || result.errors > 0);
      if (hasErrors) {
        log.warn('Import', '\n⚠️ Import completed with some errors');
      } else {
        log.success('Import', '\n✅ Import completed successfully!');
      }
    }

    log.info('Import', '\nSummary:');
    results.forEach((result) => {
      if (result.error) {
        log.error('Import', `  ${result.filepath}: ${result.error}`);
      } else if (result.dryRun) {
        const previewFile = filesToImport.find((file) => file.filepath === result.filepath);
        const count = previewFile ? previewFile.count : 0;
        log.info('Import', `  ${result.objectType}: ${count} items would be processed`);
      } else {
        const parts = [];
        if (result.created !== undefined) parts.push(`${result.created} created`);
        if (result.updated !== undefined) parts.push(`${result.updated} updated`);
        if (result.skipped !== undefined && result.skipped > 0) parts.push(`${result.skipped} skipped`);
        if (result.errors !== undefined && result.errors > 0) parts.push(`${result.errors} errors`);
        log.info('Import', `  ${result.objectType}: ${parts.join(', ')}`);
      }
    });

    return {
      exitCode: options.dryRun ? 0 : toExitCode(importRun.success),
      importRun
    };
  } catch (error) {
    log.error('Import', error.message);
    log.error('Import', '❌ Import failed');
    return { exitCode: 1, error };
  }
}

module.exports = importCommand;
