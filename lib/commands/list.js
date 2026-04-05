const logger = require('../utils/logger');
const { attachCommandResult } = require('./command-result');
const { createStoreRepository } = require('../store/store-repository');

function listCommand(program, deps = {}) {
  const list = program
    .command('list')
    .description('List Synclistic resources');

  list
    .command('stores')
    .description('List all stored Shopify stores')
    .action(async (...args) => {
      const command = args[args.length - 1];
      const result = await listStores(deps);
      return attachCommandResult(command, result);
    });
}

async function listStores(deps = {}) {
  const log = deps.logger || logger;
  const table = deps.table || console.table;
  const storeRepository = deps.storeRepository || createStoreRepository(deps);

  try {
    const stores = await storeRepository.getAll();
    if (stores.length === 0) {
      log.info('Stores', 'No stores found.');
    } else {
      const displayStores = stores.map(({ api_key, ...rest }) => rest);
      table(displayStores);
    }
    return { exitCode: 0, stores };
  } catch (error) {
    log.error('Stores', `Error: ${error.message}`);
    return { exitCode: 1, error };
  }
}

module.exports = listCommand;
