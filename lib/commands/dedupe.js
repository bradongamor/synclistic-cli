const inquirer = require('inquirer');
const { dedupeProducts } = require('../objects/products');
const { dedupePages } = require('../objects/pages');
const { dedupeArticles } = require('../objects/articles');
const { dedupeBlogs } = require('../objects/blogs');
const { dedupeMenus } = require('../objects/menus');
const logger = require('../utils/logger');
const { createStoreRepository } = require('../store/store-repository');

function dedupeCommand(program, deps = {}) {
  program
    .command('dedupe [objects...]')
    .description('Deduplicate objects in a Shopify store')
    .option('-s, --store <store>', 'Store name')
    .action(async (...args) => {
      const [objects, options, command] = args;
      const result = await dedupeObjects(objects, options, deps);
      command._synclisticResult = result;
      if (command.parent) {
        command.parent._synclisticResult = result;
      }
      return result;
    });
}

async function dedupeObjects(objects, options, deps = {}) {
  const log = deps.logger || logger;
  const prompt = deps.prompt || inquirer.prompt;
  const storeRepository = deps.storeRepository || createStoreRepository(deps);

  try {
    const stores = await storeRepository.getAll();
    if (stores.length === 0) {
      log.error('Dedupe', 'No stores found. Please add a store first.');
      return { exitCode: 1, reason: 'missing-stores' };
    }

    const validObjects = ['products', 'pages', 'articles', 'blogs', 'menus'];

    // Prompt for objects if not provided
    if (objects.length === 0) {
      const { selectedObjects } = await prompt([
        {
          type: 'checkbox',
          name: 'selectedObjects',
          message: 'Select the objects to deduplicate:',
          choices: validObjects,
          validate: (answer) => {
            if (answer.length < 1) {
              return 'You must choose at least one object to deduplicate.';
            }
            return true;
          },
        },
      ]);
      objects = selectedObjects;
    }

    const invalidObjects = objects.filter(obj => !validObjects.includes(obj));

    if (invalidObjects.length > 0) {
      log.error('Dedupe', `Invalid object types: ${invalidObjects.join(', ')}`);
      log.info('Dedupe', `Valid object types are: ${validObjects.join(', ')}`);
      return { exitCode: 1, reason: 'invalid-objects' };
    }

    let store;
    if (options.store) {
      store = await storeRepository.findByName(options.store);
      if (!store) {
        log.error('Dedupe', `Store "${options.store}" not found.`);
        return { exitCode: 1, reason: 'store-not-found' };
      }
    } else {
      const { selectedStore } = await prompt([{
        type: 'list',
        name: 'selectedStore',
        message: 'Select the store to deduplicate:',
        choices: stores.map(store => ({ name: store.store_name, value: store }))
      }]);
      store = selectedStore;
    }

    log.info('Dedupe', `Deduplicating ${objects.join(', ')} in ${store.store_name}`);
    
    for (const object of objects) {
      switch (object) {
        case 'products':
          await dedupeProducts(store);
          break;
        case 'pages':
          await dedupePages(store);
          break;
        case 'articles':
          await dedupeArticles(store);
          break;
        case 'blogs':
          await dedupeBlogs(store);
          break;
        case 'menus':
          await dedupeMenus(store);
          break;
        default:
          log.warn('Dedupe', `Deduplicating ${object} is not implemented yet.`);
      }
    }

    log.success('Dedupe', 'Deduplication completed successfully!');
    return { exitCode: 0, store, objects };
  } catch (error) {
    log.error('Dedupe', `Error: ${error.message}`);
    return { exitCode: 1, error };
  }
}

module.exports = dedupeCommand;
