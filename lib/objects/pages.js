const { buildAdminGraphqlUrl, graphqlRequest } = require('../utils/api-utils');
const logger = require('../utils/logger');
const inquirer = require('inquirer');

const pagesQuery = `
  query($cursor: String) {
    pages(first: 250, after: $cursor) {
      edges {
        node {
          id
          title
          handle
          bodySummary
          body
          templateSuffix
          createdAt
          updatedAt
          publishedAt
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const pageCreateMutation = `
  mutation pageCreate($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page {
        id
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const pageUpdateMutation = `
  mutation pageUpdate($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page {
        id
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function syncPages(sourceStore, destinationStore, options = {}) {
  const sourceUrl = buildAdminGraphqlUrl(sourceStore);
  const destUrl = buildAdminGraphqlUrl(destinationStore);

  const sourceHeaders = {
    'X-Shopify-Access-Token': sourceStore.api_key,
  };

  const destHeaders = {
    'X-Shopify-Access-Token': destinationStore.api_key,
  };

  try {
    // Get all pages from source store
    const sourcePages = await getAllPages(sourceStore);
    
    // Get all pages from destination store
    const destPages = await getAllPages(destinationStore);

    logger.counts('Pages', sourceStore.store_name, sourcePages.length, destinationStore.store_name, destPages.length);

    // Create/Update pages from source
    for (const sourcePage of sourcePages) {
      const destPage = destPages.find(p => p.handle === sourcePage.handle);

      try {
        if (destPage) {
          if (!options.createOnly) {
            logger.operation('Pages', 'Updating', sourcePage.title, sourcePage.handle);
            await updatePage(destinationStore, destPage.id, sourcePage);
          }
        } else {
          if (!options.updateOnly) {
            logger.operation('Pages', 'Creating', sourcePage.title, sourcePage.handle);
            await createPage(destinationStore, sourcePage);
          }
        }
      } catch (pageError) {
        logger.error('Pages', `Error processing "${sourcePage.title}": ${pageError.message}`);
      }
    }

    // Delete pages that exist in destination but not in source
    if (options.cleanDestination && !options.createOnly && !options.updateOnly) {
      logger.info('Pages', 'Checking for pages to remove...');
      for (const destPage of destPages) {
        const sourcePage = sourcePages.find(p => p.handle === destPage.handle);
        if (!sourcePage) {
          logger.operation('Pages', 'Deleting', destPage.title, destPage.handle);
          try {
            await deletePage(destinationStore, destPage.id);
          } catch (deleteError) {
            logger.error('Pages', `Error deleting "${destPage.title}": ${deleteError.message}`);
          }
        }
      }
    }

    logger.completed('Pages', sourcePages.length);
  } catch (error) {
    logger.failed('Pages', error);
  }
}

async function getAllPages(store) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  let allPages = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const variables = {
      cursor: cursor,
    };

    const data = await graphqlRequest(url, pagesQuery, variables, headers);
    allPages = allPages.concat(data.pages.edges.map(edge => edge.node));

    hasNextPage = data.pages.pageInfo.hasNextPage;
    cursor = data.pages.pageInfo.endCursor;
  }

  return allPages;
}

async function createPage(store, pageData) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const variables = {
    page: {
      title: pageData.title,
      handle: pageData.handle,
      body: pageData.body,
      templateSuffix: pageData.templateSuffix,
      isPublished: pageData.publishedAt !== null
    }
  };

  const result = await graphqlRequest(url, pageCreateMutation, variables, headers);
  
  if (result.pageCreate.userErrors.length > 0) {
    throw new Error(`Error creating page: ${JSON.stringify(result.pageCreate.userErrors)}`);
  }

  return result.pageCreate.page;
}

async function updatePage(store, pageId, pageData) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const variables = {
    id: pageId,
    page: {
      title: pageData.title,
      body: pageData.body,
      templateSuffix: pageData.templateSuffix,
      isPublished: pageData.publishedAt !== null
    }
  };

  const result = await graphqlRequest(url, pageUpdateMutation, variables, headers);
  
  if (result.pageUpdate.userErrors.length > 0) {
    throw new Error(`Error updating page: ${JSON.stringify(result.pageUpdate.userErrors)}`);
  }

  return result.pageUpdate.page;
}

async function dedupePages(store) {
  logger.info('Pages', `Deduplicating pages in ${store.store_name}...`);

  try {
    const allPages = await getAllPages(store);
    logger.info('Pages', `Found ${allPages.length} pages.`);

    const groupedPages = groupPagesByTitle(allPages);
    const duplicates = Object.values(groupedPages).filter(group => group.length > 1);

    const totalDuplicates = duplicates.reduce((sum, group) => sum + group.length - 1, 0);
    logger.info('Pages', `Found ${duplicates.length} groups of duplicate pages.`);
    logger.info('Pages', `Total number of duplicate pages to be deleted: ${totalDuplicates}`);

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Are you sure you want to delete ${totalDuplicates} duplicate pages?`,
        default: false
      }
    ]);

    if (!confirm) {
      logger.info('Pages', 'Deduplication cancelled.');
      return;
    }

    for (const group of duplicates) {
      // Sort the group by createdAt (oldest first)
      group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const [keepPage, ...duplicatesToRemove] = group;
      logger.info('Pages', `Keeping oldest page: ${keepPage.title} (ID: ${keepPage.id}, Created: ${keepPage.createdAt})`);
      
      for (const duplicate of duplicatesToRemove) {
        logger.operation('Pages', 'Deleting', duplicate.title, `ID: ${duplicate.id}, Created: ${duplicate.createdAt}`);
        await deletePage(store, duplicate.id);
      }
    }

    logger.completed('Pages', totalDuplicates);
  } catch (error) {
    logger.failed('Pages', error);
  }
}

function groupPagesByTitle(pages) {
  return pages.reduce((acc, page) => {
    const title = page.title.toLowerCase().trim();
    if (!acc[title]) {
      acc[title] = [];
    }
    acc[title].push(page);
    return acc;
  }, {});
}

async function deletePage(store, pageId) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const mutation = `
    mutation deleteOnlinePage($id: ID!) {
      pageDelete(id: $id) {
        deletedPageId
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = { id: pageId };

  try {
    const result = await graphqlRequest(url, mutation, variables, headers);
    if (result.pageDelete.userErrors.length > 0) {
      throw new Error(JSON.stringify(result.pageDelete.userErrors));
    }
    return result.pageDelete.deletedPageId;
  } catch (error) {
    throw new Error(`Failed to delete page: ${error.message}`);
  }
}

module.exports = {
  syncPages,
  pagesQuery,
  dedupePages
};
