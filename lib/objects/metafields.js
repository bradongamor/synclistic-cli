const { graphqlRequest } = require('../utils/api-utils');
const logger = require('../utils/logger');

const metafieldsQuery = ``;

async function syncMetafields(sourceStore, destinationStore, options = {}) {
  // Implementation to be added
  logger.warn('Metafields', 'Syncing metafields is not implemented yet.');
}

module.exports = {
  syncMetafields,
  metafieldsQuery
};
