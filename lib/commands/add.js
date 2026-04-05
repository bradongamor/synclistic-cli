const inquirer = require('inquirer');
const validator = require('validator');
const logger = require('../utils/logger');
const { attachCommandResult } = require('./command-result');
const { createStoreRepository } = require('../store/store-repository');
const { getInternalTestModeConfig } = require('../utils/internal-test-mode');
const { normalizeShopDomain } = require('../utils/api-utils');

function addCommand(program, deps = {}) {
  const add = program
    .command('add')
    .description('Add resources to Synclistic');

  add
    .command('store')
    .description('Add a new Shopify store')
    .action(async (...args) => {
      const command = args[args.length - 1];
      const result = await addStore(deps);
      return attachCommandResult(command, result);
    });
}

async function addStore(deps = {}) {
  const log = deps.logger || logger;
  const storeRepository = deps.storeRepository || createStoreRepository(deps);
  const prompt = deps.prompt || inquirer.prompt;

  try {
    const storeDetails = await promptStoreDetails(
      storeRepository,
      prompt,
      getInternalTestModeConfig(deps.env || process.env)
    );
    const normalizedStoreDetails = {
      ...storeDetails,
      store_url: normalizeShopDomain(storeDetails.store_url)
    };
    await storeRepository.save(normalizedStoreDetails);
    log.success('Store', 'Store added successfully!');
    return { exitCode: 0, store: normalizedStoreDetails };
  } catch (error) {
    log.error('Store', `Error: ${error.message}`);
    return { exitCode: 1, error };
  }
}

async function promptStoreDetails(
  storeRepository,
  prompt = inquirer.prompt,
  internalTestConfig = getInternalTestModeConfig()
) {
  const questions = [
    {
      type: 'input',
      name: 'store_name',
      message: 'Enter the store name:',
      validate: async (input) => {
        if (!input) return 'Store name cannot be empty';
        if (await storeRepository.isNameTaken(input)) {
          return 'Store name must be unique';
        }
        return true;
      }
    },
    {
      type: 'input',
      name: 'store_url',
      message: 'Enter the store URL:',
      validate: async (input) => {
        const normalizedDomain = normalizeShopDomain(input);
        if (!normalizedDomain || !validator.isFQDN(normalizedDomain)) {
          return 'Please enter a valid URL';
        }
        if (await storeRepository.isStoreUrlTaken(normalizedDomain)) {
          return 'Store URL must be unique';
        }
        return true;
      }
    },
    {
      type: 'password',
      name: 'api_key',
      message: 'Enter the API key:',
      mask: '*',
      validate: async (input) => (!input ? 'API key cannot be empty' : true)
    }
  ];

  if (internalTestConfig.enabled && internalTestConfig.isOperatorAllowlisted) {
    questions.push(
      {
        type: 'confirm',
        name: 'is_test_store',
        message: 'Mark this store as a test store?',
        default: false
      },
      {
        type: 'input',
        name: 'test_store_notes',
        message: 'Optional internal test-store notes:',
        when: (answers) => Boolean(answers.is_test_store)
      }
    );
  }

  return prompt(questions);
}

module.exports = addCommand;
