const Table = require('cli-table3');
const logger = require('../utils/logger');

function scopesCommand(program) {
  program
    .command('scopes')
    .description('List required Shopify Admin API scopes for each sync operation')
    .action(listScopes);
}

function listScopes() {
  const scopes = {
    articles: {
      read: ['read_online_store_articles'],
      write: ['write_online_store_articles'],
      operations: ['List articles', 'Create articles', 'Update articles']
    },
    blogs: {
      read: ['read_online_store_blogs'],
      write: ['write_online_store_blogs'],
      operations: ['List blogs', 'Create blogs', 'Update blogs']
    },
    collections: {
      read: ['read_products', 'read_publications'],
      write: ['write_products', 'write_publications'],
      operations: ['List collections', 'Create collections', 'Update collections', 'Delete collections', 'Sync sales channels']
    },
    media: {
      read: ['read_product_listings', 'read_files'],
      write: ['write_product_listings', 'write_files'],
      operations: ['List product media', 'Create product media', 'List/Create generic files']
    },
    pages: {
      read: ['read_online_store_pages', 'read_themes'],
      write: ['write_online_store_pages'],
      operations: ['List pages', 'Create pages', 'Update pages']
    },
    products: {
      read: ['read_products', 'read_publications', 'read_inventory'],
      write: ['write_products', 'write_publications', 'write_inventory'],
      operations: ['List products', 'Create products', 'Update products', 'Delete products', 'Sync sales channels', 'Sync inventory']
    },
    menus: {
      read: ['read_online_store_navigation'],
      write: ['write_online_store_navigation'],
      operations: ['List menus', 'Create menu items', 'Update menu items']
    },
    themes: {
      read: ['read_themes'],
      write: ['write_themes'],
      operations: ['List themes', 'Read theme files', 'Upsert theme files', 'Delete theme files']
    }
  };

  const table = new Table({
    head: ['Object', 'Operations', 'Required Scopes'],
    colWidths: [15, 45, 40],
    wordWrap: true
  });

  for (const [object, details] of Object.entries(scopes)) {
    table.push([
      object,
      details.operations.join('\n'),
      [...new Set([...details.read, ...details.write])].join('\n')
    ]);
  }

  logger.info('Scopes', '\nRequired Shopify Admin API Scopes for Sync Operations:\n');
  // Keep console.log for table output as it's formatted specifically for console display
  console.log(table.toString());

  logger.info('Scopes', '\nNote: These scopes should be enabled in your Shopify Admin API access token.');
  logger.info('Scopes', 'You can manage these in your Shopify Partner Dashboard under App Setup > API credentials.');
  logger.info('Scopes', 'Theme write access may require protected theme access approval from Shopify.');
}

module.exports = scopesCommand; 
