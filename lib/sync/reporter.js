const OBJECT_EMOJIS = Object.freeze({
  products: '🛍️',
  pages: '📄',
  media: '🖼️',
  blogs: '📝',
  articles: '📰',
  metafields: '🏷️',
  metaobjects: '🔧',
  'selling plans': '💰',
  menus: '📋',
  collections: '📁'
});

function createCliReporter(logger) {
  return {
    info() {},
    warn(message) {
      logger.warn('Sync', message);
    },
    error(message) {
      logger.error('Sync', message);
    },
    objectStarted(objectType) {
      logger.info('Sync', `${OBJECT_EMOJIS[objectType] || '📦'} Syncing ${objectType}...`);
    },
    objectFinished() {}
  };
}

module.exports = {
  createCliReporter,
  OBJECT_EMOJIS
};
