const { buildAdminGraphqlUrl, graphqlRequest } = require('../utils/api-utils');
const logger = require('../utils/logger');
const inquirer = require('inquirer');

const menusQuery = `
  query {
    menus(first: 250) {
      edges {
        node {
          id
          handle
          title
          items {
            id
            title
            url
            type
            resourceId
            items {
              id
              title
              url
              type
              resourceId
            }
          }
        }
      }
    }
  }
`;

const menuCreateMutation = `
  mutation menuCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
    menuCreate(title: $title, handle: $handle, items: $items) {
      menu {
        id
        handle
        items {
          id
          title
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const menuUpdateMutation = `
  mutation menuUpdate($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, items: $items) {
      menu {
        id
        handle
        items {
          id
          title
          url
          type
          resourceId
          items {
            id
            title
            url
            type
            resourceId
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const pagesQuery = `
  query($cursor: String) {
    pages(first: 250, after: $cursor) {
      edges {
        node {
          id
          handle
          title
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const blogByHandleQuery = `
  query blogByHandle($handle: String!) {
    blogs(first: 1, query: $handle) {
      edges {
        node {
          id
          handle
        }
      }
    }
  }
`;

async function syncMenus(sourceStore, destinationStore, options = {}) {
  try {
    // Get menus from source store
    const sourceMenus = await getMenuItems(sourceStore);
    
    // Log source menu items
    sourceMenus.forEach(menu => {
      logger.verbose('Menus', `Menu: ${menu.title} (${menu.handle})`);
      menu.items.forEach(item => {
        logger.verbose('Menus', `  - ${item.title} (${item.url || item.type})`);
        if (item.items) {
          item.items.forEach(subItem => {
            logger.verbose('Menus', `    • ${subItem.title} (${subItem.url || subItem.type})`);
          });
        }
      });
    });

    // Get menus from destination store
    const destMenus = await getMenuItems(destinationStore);
    
    // Log destination menu items
    destMenus.forEach(menu => {
      logger.verbose('Menus', `Menu: ${menu.title} (${menu.handle})`);
      menu.items.forEach(item => {
        logger.verbose('Menus', `  - ${item.title} (${item.url || item.type})`);
        if (item.items) {
          item.items.forEach(subItem => {
            logger.verbose('Menus', `    • ${subItem.title} (${subItem.url || subItem.type})`);
          });
        }
      });
    });

    logger.counts('Menus', sourceStore.store_name, sourceMenus.length, destinationStore.store_name, destMenus.length);

    // Handle menu updates and creations
    for (const sourceMenu of sourceMenus) {
      const destMenu = destMenus.find(m => m.handle === sourceMenu.handle);
      try {
        if (destMenu) {
          if (!options.createOnly) {
            logger.operation('Menus', 'Updating', sourceMenu.title, sourceMenu.handle);
            await updateMenuItem(destinationStore, destMenu.id, sourceMenu);
          }
        } else {
          if (!options.updateOnly) {
            logger.operation('Menus', 'Creating', sourceMenu.title, sourceMenu.handle);
            await createMenuItem(destinationStore, sourceMenu);
          }
        }
      } catch (menuError) {
        logger.error('Menus', `Error processing "${sourceMenu.title}": ${menuError.message}`);
      }
    }

    // Delete menus that exist in destination but not in source
    if (options.cleanDestination && !options.createOnly && !options.updateOnly) {
      logger.info('Menus', 'Checking for menus to remove...');
      for (const destMenu of destMenus) {
        const sourceMenu = sourceMenus.find(m => m.handle === destMenu.handle);
        if (!sourceMenu) {
          logger.operation('Menus', 'Deleting', destMenu.title, destMenu.handle);
          try {
            await deleteMenuItem(destinationStore, destMenu.id);
          } catch (deleteError) {
            logger.error('Menus', `Error deleting "${destMenu.title}": ${deleteError.message}`);
          }
        }
      }
    }

    logger.completed('Menus', sourceMenus.length);
  } catch (error) {
    logger.failed('Menus', error);
  }
}

async function getMenuItems(store) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const data = await graphqlRequest(url, menusQuery, {}, headers);
  return data.menus.edges.map(edge => ({
    ...edge.node,
    menuHandle: edge.node.handle,
    menuTitle: edge.node.title
  }));
}

async function createMenuItem(store, menuItemData) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  // Fetch destination pages (needed for transforming items)
  logger.info('Menus', '(Create) Fetching pages from destination store...');
  const destPages = await getPages(store);
  logger.info('Menus', `(Create) Found ${destPages.length} pages.`);

  // Transform items using the same logic as update
  // Pass an empty array for existingItems as it's a creation
  const transformedItems = await transformMenuItems(store, menuItemData.items, [], { destPages });

  const variables = {
    title: menuItemData.title,
    handle: menuItemData.handle,
    items: transformedItems
  };

  logger.verbose('Menus', '(Create) Sending create with variables:', JSON.stringify(variables, null, 2));

  const result = await graphqlRequest(url, menuCreateMutation, variables, headers);

  if (result.menuCreate.userErrors.length > 0) {
    logger.error('Menus', '(Create) Menu creation failed with errors:');
    result.menuCreate.userErrors.forEach(error => {
      logger.error('Menus', `(Create) Field: ${error.field}, Message: ${error.message}`);
    });
    throw new Error(`Error creating menu: ${JSON.stringify(result.menuCreate.userErrors)}`);
  }

  logger.success('Menus', `(Create) Menu "${menuItemData.title}" created successfully`);
  return result.menuCreate.menu;
}

function findMatchingMenuItem(sourceItem, destItems) {
  return destItems.find(item => item.title === sourceItem.title);
}

async function getPages(store) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };
  
  const result = await graphqlRequest(url, pagesQuery, {}, headers);
  return result.pages.edges.map(edge => edge.node);
}

// Add findBlogByHandle back
async function findBlogByHandle(store, handle) {
  if (!handle) {
    logger.warn('Menus', '[Debug] findBlogByHandle called with null/empty handle.');
    return null;
  }
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };
  const variables = { handle };
  try {
    logger.verbose('Menus', `[Debug] Querying for blog with handle: "${handle}"`);
    const result = await graphqlRequest(url, blogByHandleQuery, variables, headers);
    // Check if edges exist and the handle matches exactly (query might return partial matches)
    const matchingBlog = result?.blogs?.edges?.find(edge => edge?.node?.handle === handle);
    if (matchingBlog) {
        logger.verbose('Menus', `[Debug] Found blog by handle "${handle}": ID ${matchingBlog.node.id}`);
        return matchingBlog.node;
    } else {
        logger.verbose('Menus', `[Debug] Blog not found by handle "${handle}" in destination store.`);
        return null;
    }
  } catch (error) {
    logger.error('Menus', `[Debug] Failed to query blog by handle "${handle}": ${error.message}`);
    return null; // Ensure null is returned on error
  }
}

// Modify transformMenuItem signature (add store, async)
async function transformMenuItem(store, sourceItem, existingItem = null, destPages = []) {
  logger.verbose('Menus', `Processing menu item: "${sourceItem.title}" (Type: ${sourceItem.type}, URL: ${sourceItem.url || 'N/A'})`);

  const transformedItem = {
    title: sourceItem.title
  };

  const sourceType = sourceItem.type;
  const sourceUrl = sourceItem.url;

  // Handle page links
  if (sourceType === 'PAGE' || (sourceUrl && sourceUrl.startsWith('/pages/'))) {
    logger.verbose('Menus', `Handling as PAGE type.`);
    const pageHandle = sourceUrl ? sourceUrl.split('/pages/')[1] : null;
    const destPage = pageHandle ? destPages.find(page => page.handle === pageHandle) : null;

    if (destPage) {
      logger.verbose('Menus', `Found matching destination page: ${destPage.title} (ID: ${destPage.id}). Setting type=PAGE, resourceId=${destPage.id}`);
      transformedItem.type = 'PAGE';
      transformedItem.resourceId = destPage.id;
    } else {
      logger.warn('Menus', `Destination page not found for handle: ${pageHandle}. Falling back to HTTP link.`);
      transformedItem.type = 'HTTP';
      transformedItem.url = sourceUrl;
    }
  } else if (sourceType === 'BLOG' || (sourceUrl && sourceUrl.startsWith('/blogs/'))) {
    logger.verbose('Menus', `Handling as BLOG type.`);
    const blogHandle = sourceUrl ? sourceUrl.split('/blogs/')[1].split('/')[0] : null;
    const destBlog = await findBlogByHandle(store, blogHandle);

    if (destBlog) {
      logger.verbose('Menus', `Found matching destination blog: ${destBlog.handle} (ID: ${destBlog.id}). Setting type=BLOG, resourceId=${destBlog.id}`);
      transformedItem.type = 'BLOG';
      transformedItem.resourceId = destBlog.id;
    } else {
      logger.warn('Menus', `Destination blog not found for handle: ${blogHandle}. Falling back to HTTP link.`);
      transformedItem.type = 'HTTP';
      transformedItem.url = sourceUrl;
    }
  } else if (sourceType === 'FRONTPAGE') {
    logger.verbose('Menus', `Handling as FRONTPAGE type.`);
    transformedItem.type = 'FRONTPAGE';
    // No URL or resourceId needed for FRONTPAGE
  } else if (sourceType === 'CUSTOMER_ACCOUNT_PAGE') {
    logger.verbose('Menus', `Handling as CUSTOMER_ACCOUNT_PAGE type.`);
    transformedItem.type = 'CUSTOMER_ACCOUNT_PAGE';
    // NOTE (2025-04-20): Linking to standard customer account pages (like Orders)
    // currently fails with "customer_account_page not found" regardless of whether
    // we provide the source resourceId, the source URL, both, or neither.
    // This might be an API limitation related to classic vs. new customer accounts.
    // Reverting to sending all fields from source as the least bad option for now.
    if (sourceUrl) {
        transformedItem.url = sourceUrl;
    } else {
        logger.warn('Menus', `Source item type is CUSTOMER_ACCOUNT_PAGE but URL is missing.`);
    }
    if (sourceItem.resourceId) {
        transformedItem.resourceId = sourceItem.resourceId;
    } else {
        logger.warn('Menus', `Source item type is CUSTOMER_ACCOUNT_PAGE but resourceId is missing.`);
    }
  } else if (sourceType === 'SHOP_POLICY') {
    logger.verbose('Menus', `Handling as SHOP_POLICY type.`);
    // Shop policies usually require a resourceId lookup similar to Pages/Blogs.
    // Falling back to HTTP until lookup is implemented.
    logger.warn('Menus', `Shop policy lookup not implemented for URL: ${sourceUrl}. Falling back to HTTP link.`);
    transformedItem.type = 'HTTP';
    transformedItem.url = sourceUrl;
  } else if (sourceType === 'HTTP') {
    logger.verbose('Menus', `Handling as HTTP type.`);
    transformedItem.type = 'HTTP';
    transformedItem.url = sourceUrl;
  } else {
    // Catch-all for other types (like COLLECTION, PRODUCT, SEARCH etc.) or items without URL
    logger.warn('Menus', `Handling as unhandled type (${sourceType}) or item without URL. Falling back to HTTP link.`);
    // These might require resourceId lookups as well
    transformedItem.type = 'HTTP';
    transformedItem.url = sourceUrl || '#'; // Use '#' as fallback if no URL
  }

  if (existingItem) {
    transformedItem.id = existingItem.id;
    logger.verbose('Menus', `Applying existing item ID: ${existingItem.id}`);
  }

  logger.verbose('Menus', `Final transformed item: ${JSON.stringify(transformedItem)}`);
  return transformedItem;
}

// Modify transformMenuItems signature (add store, async)
async function transformMenuItems(store, sourceItems, existingItems = [], destResources = {}) {
  const { destPages = [] } = destResources; // Keep destPages extraction
  // Use Promise.all to handle async calls within the map
  return await Promise.all(sourceItems.map(async sourceItem => {
    const existingItem = findMatchingMenuItem(sourceItem, existingItems);
    // Pass store and only destPages to transformMenuItem
    const transformedItem = await transformMenuItem(store, sourceItem, existingItem, destPages); // Pass store

    if (sourceItem.items?.length > 0) {
      logger.verbose('Menus', `Processing ${sourceItem.items.length} submenu items for "${sourceItem.title}":`);
      // Recursively call with store and await the result
      transformedItem.items = await transformMenuItems(
        store,
        sourceItem.items,
        existingItem ? existingItem.items || [] : [],
        { destPages } // Pass destPages down
      );
    }

    return transformedItem;
  }));
}

async function updateMenuItem(store, menuId, menuItemData) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  // Get existing menu data
  const existingMenuData = await graphqlRequest(url, menusQuery, {}, headers);
  const existingMenu = existingMenuData.menus.edges
    .find(edge => edge.node.id === menuId)?.node;

  // Get all pages from destination store
  logger.info('Menus', 'Fetching pages from destination store...');
  const destPages = await getPages(store);
  logger.info('Menus', `Found ${destPages.length} pages in destination store`);

  logger.verbose('Menus', `Updating menu: ${menuItemData.title}`);
  
  const variables = {
    id: menuId,
    title: menuItemData.title,
    items: await transformMenuItems(store, menuItemData.items, existingMenu.items, { destPages })
  };

  logger.verbose('Menus', 'Sending update with variables:', JSON.stringify(variables, null, 2));

  const result = await graphqlRequest(url, menuUpdateMutation, variables, headers);
  
  if (result.menuUpdate.userErrors.length > 0) {
    logger.error('Menus', 'Menu update failed with errors:');
    result.menuUpdate.userErrors.forEach(error => {
      logger.error('Menus', `Field: ${error.field}, Message: ${error.message}`);
    });
    throw new Error(`Error updating menu: ${JSON.stringify(result.menuUpdate.userErrors)}`);
  }

  logger.success('Menus', 'Menu update completed successfully');
  return result.menuUpdate.menu;
}

async function deleteMenuItem(store, menuId) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const menuDeleteMutation = `
    mutation menuDelete($id: ID!) {
      menuDelete(id: $id) {
        deletedMenuId
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await graphqlRequest(url, menuDeleteMutation, { id: menuId }, headers);
  
  if (result.menuDelete.userErrors.length > 0) {
    throw new Error(`Error deleting menu: ${JSON.stringify(result.menuDelete.userErrors)}`);
  }

  logger.success('Menus', 'Menu deleted successfully');
  return result.menuDelete.deletedMenuId;
}

async function dedupeMenus(store) {
  logger.info('Menus', `Deduplicating menus in ${store.store_name}...`);

  try {
    const allMenus = await getMenuItems(store);
    logger.info('Menus', `Found ${allMenus.length} menus.`);

    const groupedMenus = groupMenusByTitle(allMenus);
    const duplicates = Object.values(groupedMenus).filter(group => group.length > 1);

    const totalDuplicates = duplicates.reduce((sum, group) => sum + group.length - 1, 0);
    logger.info('Menus', `Found ${duplicates.length} groups of duplicate menus.`);
    logger.info('Menus', `Total number of duplicate menus to be deleted: ${totalDuplicates}`);

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Are you sure you want to delete ${totalDuplicates} duplicate menus?`,
        default: false
      }
    ]);

    if (!confirm) {
      logger.info('Menus', 'Deduplication cancelled.');
      return;
    }

    for (const group of duplicates) {
      // Sort the group by createdAt (oldest first)
      group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const [keepMenu, ...duplicatesToRemove] = group;
      logger.info('Menus', `Keeping oldest menu: ${keepMenu.title} (ID: ${keepMenu.id}, Created: ${keepMenu.createdAt})`);
      
      for (const duplicate of duplicatesToRemove) {
        logger.operation('Menus', 'Deleting', duplicate.title, `ID: ${duplicate.id}, Created: ${duplicate.createdAt}`);
        await deleteMenuItem(store, duplicate.id);
      }
    }

    logger.completed('Menus', totalDuplicates);
  } catch (error) {
    logger.failed('Menus', error);
  }
}

function groupMenusByTitle(menus) {
  return menus.reduce((acc, menu) => {
    const title = menu.title.toLowerCase().trim();
    if (!acc[title]) {
      acc[title] = [];
    }
    acc[title].push(menu);
    return acc;
  }, {});
}

module.exports = {
  syncMenus,
  menusQuery,
  dedupeMenus,
  getMenuItems,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  getPages,
  findBlogByHandle
};
