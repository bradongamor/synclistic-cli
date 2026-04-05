const {
  CONFIG_DIR,
  STORES_FILE
} = require('../store/json-store-persistence');
const { createStoreRepository } = require('../store/store-repository');

const repository = createStoreRepository();

async function getStores() {
  return repository.getAll();
}

async function saveStoreDetails(storeDetails) {
  return repository.save(storeDetails);
}

async function saveStores(stores) {
  return repository.replaceAll(stores);
}

module.exports = {
  getStores,
  saveStoreDetails,
  saveStores,
  CONFIG_DIR,
  STORES_FILE
};
