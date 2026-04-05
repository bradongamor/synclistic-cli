const { graphqlRequest } = require('../utils/api-utils');
const logger = require('../utils/logger');

const metaobjectsQuery = ``;

async function syncMetaobjects(sourceStore, destinationStore, options = {}) {
  // Implementation to be added
  logger.warn('Metaobjects', 'Syncing metaobjects is not implemented yet.');
}

module.exports = {
  syncMetaobjects,
  metaobjectsQuery
};
