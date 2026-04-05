const inquirer = require('inquirer');
const logger = require('../utils/logger');
const { attachCommandResult } = require('./command-result');
const { createStoreRepository } = require('../store/store-repository');

function removeCommand(program, deps = {}) {
  const remove = program
    .command('remove')
    .description('Remove Synclistic resources');

  remove
    .command('store')
    .description('Remove a Shopify store')
    .action(async (...args) => {
      const command = args[args.length - 1];
      const result = await removeStore(deps);
      return attachCommandResult(command, result);
    });
}

async function removeStore(deps = {}) {
  const log = deps.logger || logger;
  const prompt = deps.prompt || inquirer.prompt;
  const storeRepository = deps.storeRepository || createStoreRepository(deps);

  try {
    const stores = await storeRepository.getAll();
    if (stores.length === 0) {
      log.info('Store', 'No stores found to remove.');
      return { exitCode: 0, removed: null };
    }

    const { storeToRemove } = await prompt([
      {
        type: 'list',
        name: 'storeToRemove',
        message: 'Select the store to remove:',
        choices: stores.map(store => ({ name: store.store_name, value: store }))
      }
    ]);

    const removedStore = await storeRepository.removeByName(storeToRemove.store_name);
    if (!removedStore) {
      log.error('Store', `Store "${storeToRemove.store_name}" could not be removed because it no longer exists.`);
      return { exitCode: 1, removed: null };
    }

    log.success('Store', `Store "${removedStore.store_name}" has been removed successfully.`);
    return { exitCode: 0, removed: removedStore };
  } catch (error) {
    log.error('Store', `Error: ${error.message}`);
    return { exitCode: 1, error };
  }
}

module.exports = removeCommand;
