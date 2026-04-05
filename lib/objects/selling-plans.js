const { graphqlRequest } = require('../utils/api-utils');
const logger = require('../utils/logger');

const sellingPlansQuery = ``;

async function syncSellingPlans(sourceStore, destinationStore, options = {}) {
  // Implementation to be added
  logger.warn('Selling Plans', 'Syncing selling plans is not implemented yet.');
}

module.exports = {
  syncSellingPlans,
  sellingPlansQuery
};
