const logger = require('../utils/logger');
const { DEFAULT_OUTPUT_DIR } = require('../utils/export');
const { executeSyncCommand } = require('../sync/run-command');
const { attachCommandResult } = require('./command-result');

function syncCommand(program, deps = {}) {
  program
    .command('sync [objects...]')
    .description('Sync objects between two Shopify stores')
    .option('-f, --from <source>', 'Source store name')
    .option('-t, --to <destination>', 'Destination store name')
    .option('-c, --clean-destination', 'Remove destination objects that do not exist in source', false)
    .option('--create-only', 'Only create new objects that exist in source but not in destination')
    .option('--update-only', 'Only update existing objects that exist in both stores')
    .option('--sync-mode <mode>', 'Sync mode: create-and-update | create | update', 'create-and-update')
    .option('--source-products-ids <ids>', 'Source product IDs (numeric or gid, comma-separated)')
    .option('--destination-products-ids <ids>', 'Destination product IDs (numeric or gid, comma-separated; empty entries allowed)')
    .option('--theme-sync-mode <mode>', 'Theme sync mode: dependencies | full', 'dependencies')
    .option('--destination-theme-id <id>', 'Destination theme ID override (defaults to the published theme)')
    .option('--missing-template-policy <policy>', 'Missing template policy: clear | keep | error', 'clear')
    .option('-e, --export', 'Export destination store data before syncing')
    .option('-o, --output <path>', 'Output directory for export files (used with --export)', DEFAULT_OUTPUT_DIR)
    .option('--on-export-failure <behavior>', 'Export failure behavior: continue | fail', 'fail')
    .option('-v, --verbose', 'Enable verbose logging')
    .action(async (objects, options, command) => {
      const result = await executeSyncCommand(objects, options, {
        logger,
        ...deps
      });
      return attachCommandResult(command, result);
    });
}

module.exports = syncCommand;
