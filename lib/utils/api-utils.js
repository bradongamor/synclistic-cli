const { requireWithFallback } = require('./require-package');

const {
  fetchRequest,
  graphqlRequest,
  buildAdminGraphqlUrl,
  normalizeShopDomain
} = requireWithFallback(
  require,
  '@synclistic/shopify-client/api',
  '../../../packages/shopify-client/api'
);

module.exports = {
  buildAdminGraphqlUrl,
  fetchRequest,
  graphqlRequest,
  normalizeShopDomain
};
