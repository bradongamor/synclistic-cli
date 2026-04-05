const { buildAdminGraphqlUrl, graphqlRequest } = require('../utils/api-utils');
const logger = require('../utils/logger');

// Query to fetch collections with pagination
const collectionsQuery = `
  query($cursor: String) {
    collections(first: 250, after: $cursor) {
      edges {
        node {
          id
          handle
          title
          descriptionHtml
          templateSuffix
          sortOrder
          image {
            url
            altText
          }
          seo {
            title
            description
          }
          ruleSet {
            appliedDisjunctively
            rules {
              column
              relation
              condition
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// Mutation to create a new manual collection
const collectionCreateMutation = `
  mutation collectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        id
        handle
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Mutation to update an existing collection
const collectionUpdateMutation = `
  mutation collectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        handle
        title
        updatedAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Mutation to delete a collection
const collectionDeleteMutation = `
  mutation collectionDelete($input: CollectionDeleteInput!) {
    collectionDelete(input: $input) {
      deletedCollectionId
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Fetches all collections from a store with pagination.
 * @param {object} store - The store configuration object.
 * @returns {Promise<Array<object>>} - A promise that resolves to an array of collection nodes.
 */
async function getAllCollections(store) {
  let allCollections = [];
  let hasNextPage = true;
  let cursor = null;

  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  logger.info('Collections', `Fetching all collections from ${store.store_name}...`);

  while (hasNextPage) {
    const variables = {
      cursor: cursor,
    };

    try {
      const data = await graphqlRequest(url, collectionsQuery, variables, headers);
      if (!data.collections) {
        logger.error('Collections', `Invalid response structure received from ${store.store_name}`, data);
        throw new Error(`Invalid response structure when fetching collections from ${store.store_name}.`);
      }
      allCollections = allCollections.concat(data.collections.edges.map(edge => edge.node));
      hasNextPage = data.collections.pageInfo.hasNextPage;
      cursor = data.collections.pageInfo.endCursor;
      logger.verbose('Collections', `Fetched page of collections, hasNextPage: ${hasNextPage}`);
    } catch (error) {
      logger.error('Collections', `Error fetching collections page from ${store.store_name}: ${error.message}`);
      throw error; // Re-throw to stop the process if a page fails
    }
  }

  logger.info('Collections', `Finished fetching ${allCollections.length} collections from ${store.store_name}.`);
  return allCollections;
}

/**
 * Creates a map of collection handles to their IDs.
 * @param {object} store - The store configuration object.
 * @returns {Promise<Map<string, string>>} - A promise that resolves to a Map of handle -> ID.
 */
async function getCollectionMap(store) {
  const collections = await getAllCollections(store);
  const map = new Map();
  collections.forEach(collection => {
    if (collection.handle) {
      map.set(collection.handle, collection.id);
    } else {
       logger.warn('Collections', `Collection found without a handle in ${store.store_name} (ID: ${collection.id}, Title: ${collection.title}). Skipping map entry.`);
    }
  });
  return map;
}

/**
 * Deletes a collection from a store.
 * @param {object} store - The store configuration object.
 * @param {string} collectionId - The ID of the collection to delete.
 * @param {string} collectionHandle - The handle of the collection (for logging).
 * @param {string} collectionTitle - The title of the collection (for logging).
 * @returns {Promise<string|null>} - The deleted ID or null if failed.
 */
async function deleteCollection(store, collectionId, collectionHandle, collectionTitle) {
  const url = buildAdminGraphqlUrl(store);
  const headers = { 'X-Shopify-Access-Token': store.api_key };
  const variables = { input: { id: collectionId } };

  logger.operation('Collections', 'Deleting', collectionTitle, `(ID: ${collectionId}, Handle: ${collectionHandle})`);

  try {
    const result = await graphqlRequest(url, collectionDeleteMutation, variables, headers);
    if (result.collectionDelete.userErrors.length > 0) {
      const errorMessages = result.collectionDelete.userErrors.map(e => e.message).join(', ');
      logger.error('Collections', `Error deleting collection "${collectionTitle}" (ID: ${collectionId}): ${errorMessages}`, result.collectionDelete.userErrors);
      return null;
    } else {
      logger.success('Collections', `Deleted collection: ${collectionTitle} (ID: ${result.collectionDelete.deletedCollectionId})`);
      return result.collectionDelete.deletedCollectionId;
    }
  } catch (error) {
    logger.error('Collections', `Failed mutation for deleting collection "${collectionTitle}" (ID: ${collectionId}): ${error.message}`);
    return null;
  }
}

/**
 * Synchronizes collections between two stores.
 * Creates collections in the destination store that exist in the source but not the destination.
 * Note: Does not currently update existing collections or handle smart collections.
 * @param {object} sourceStore - The source store configuration object.
 * @param {object} destinationStore - The destination store configuration object.
 * @param {object} options - Sync options (e.g., { createOnly: false }).
 * @param {object} options - Sync options (e.g., { createOnly: false, updateOnly: false, cleanDestination: false }).
 * @returns {Promise<Map<string, string>>} - A promise that resolves to the collection map of the destination store.
 */
async function syncCollections(sourceStore, destinationStore, options = { createOnly: false, updateOnly: false, cleanDestination: false }) {
  logger.info('Collections', `Starting collection sync from ${sourceStore.store_name} to ${destinationStore.store_name}...`);

  const destUrl = buildAdminGraphqlUrl(destinationStore);
  const destHeaders = {
    'X-Shopify-Access-Token': destinationStore.api_key,
  };

  try {
    // Get collections from both stores
    const sourceCollections = await getAllCollections(sourceStore);
    const destCollections = await getAllCollections(destinationStore);
    const destCollectionMap = new Map(destCollections.map(c => [c.handle, c])); // Map by handle for quick lookup
    const sourceCollectionHandles = new Set(sourceCollections.map(c => c.handle)); // Set of source handles for delete check

    logger.counts('Collections', sourceStore.store_name, sourceCollections.length, destinationStore.store_name, destCollections.length);

    let createdCount = 0;
    let updatedCount = 0;
    let deletedCount = 0;

    // Create/Update collections
    for (const sourceCollection of sourceCollections) {
      if (!sourceCollection.handle) {
         logger.warn('Collections', `Skipping source collection without handle (ID: ${sourceCollection.id}, Title: ${sourceCollection.title})`);
         continue;
      }
      
      const destCollection = destCollectionMap.get(sourceCollection.handle);

      if (!destCollection) {
         if (!options.updateOnly) { 
            logger.operation('Collections', 'Creating', sourceCollection.title, sourceCollection.handle);
            try {
              const variables = {
                input: {
                  title: sourceCollection.title,
                  handle: sourceCollection.handle,
                  descriptionHtml: sourceCollection.descriptionHtml,
                  templateSuffix: sourceCollection.templateSuffix,
                  sortOrder: sourceCollection.sortOrder,
                  image: sourceCollection.image ? { src: sourceCollection.image.url, altText: sourceCollection.image.altText } : undefined,
                  seo: sourceCollection.seo ? { title: sourceCollection.seo.title, description: sourceCollection.seo.description } : undefined,
                  ruleSet: sourceCollection.ruleSet ? {
                      appliedDisjunctively: sourceCollection.ruleSet.appliedDisjunctively,
                      rules: sourceCollection.ruleSet.rules.map(r => ({ column: r.column, relation: r.relation, condition: r.condition }))
                  } : undefined,
                }
              };
              const result = await graphqlRequest(destUrl, collectionCreateMutation, variables, destHeaders);
              if (result.collectionCreate.userErrors.length > 0) {
                const errorMessages = result.collectionCreate.userErrors.map(e => e.message).join(', ');
                logger.error('Collections', `Error creating collection "${sourceCollection.title}": ${errorMessages}`, result.collectionCreate.userErrors);
              } else {
                logger.success('Collections', `Created collection: ${result.collectionCreate.collection.title} (Handle: ${result.collectionCreate.collection.handle})`);
                createdCount++;
                // Add the newly created collection to our map for immediate use if needed later in the same run
                destCollectionMap.set(result.collectionCreate.collection.handle, result.collectionCreate.collection);
              }
            } catch (createError) {
              logger.error('Collections', `Failed mutation for creating collection "${sourceCollection.title}": ${createError.message}`);
            }
         }
      } else {
        // Update Collection 
        if (!options.createOnly) {
            const changes = {};
            if (sourceCollection.title !== destCollection.title) changes.title = sourceCollection.title;
            if (sourceCollection.descriptionHtml !== destCollection.descriptionHtml) changes.descriptionHtml = sourceCollection.descriptionHtml;
            if (sourceCollection.templateSuffix !== destCollection.templateSuffix) changes.templateSuffix = sourceCollection.templateSuffix;
            if (sourceCollection.sortOrder !== destCollection.sortOrder) changes.sortOrder = sourceCollection.sortOrder;
            // Basic image check (more robust might check URL and altText separately)
            if (JSON.stringify(sourceCollection.image) !== JSON.stringify(destCollection.image)) {
               changes.image = sourceCollection.image ? { src: sourceCollection.image.url, altText: sourceCollection.image.altText } : null; // Use null to remove image
            }
            // Basic SEO check
            if (JSON.stringify(sourceCollection.seo) !== JSON.stringify(destCollection.seo)) {
               changes.seo = sourceCollection.seo ? { title: sourceCollection.seo.title, description: sourceCollection.seo.description } : undefined;
            }
            // Basic RuleSet check (assumes order doesn't matter for rules comparison)
            // A more robust check would compare rules individually regardless of order.
            if (JSON.stringify(sourceCollection.ruleSet) !== JSON.stringify(destCollection.ruleSet)) {
               changes.ruleSet = sourceCollection.ruleSet ? {
                 appliedDisjunctively: sourceCollection.ruleSet.appliedDisjunctively,
                 rules: sourceCollection.ruleSet.rules.map(r => ({ column: r.column, relation: r.relation, condition: r.condition }))
               } : null; // Use null to convert to manual if source has no ruleset?
            }

            if (Object.keys(changes).length > 0) {
                logger.operation('Collections', 'Updating', sourceCollection.title, sourceCollection.handle);
                try {
                    const variables = {
                        input: {
                            id: destCollection.id, // IMPORTANT: Include ID for update
                            ...changes
                        }
                    };
                    const result = await graphqlRequest(destUrl, collectionUpdateMutation, variables, destHeaders);
                    if (result.collectionUpdate.userErrors.length > 0) {
                        const errorMessages = result.collectionUpdate.userErrors.map(e => e.message).join(', ');
                        logger.error('Collections', `Error updating collection "${sourceCollection.title}": ${errorMessages}`, result.collectionUpdate.userErrors);
                    } else {
                        logger.success('Collections', `Updated collection: ${result.collectionUpdate.collection.title} (Handle: ${result.collectionUpdate.collection.handle})`);
                        updatedCount++;
                    }
                } catch (updateError) {
                    logger.error('Collections', `Failed mutation for updating collection "${sourceCollection.title}": ${updateError.message}`);
                }
            } else {
                logger.verbose('Collections', `No changes detected for: ${sourceCollection.title} (${sourceCollection.handle})`);
            }
        }
      }
    }
    
    // Delete Collections 
    if (options.cleanDestination && !options.createOnly && !options.updateOnly) {
        logger.info('Collections', 'Checking for collections to remove from destination...');
        for (const destCollection of destCollections) {
            if (destCollection.handle && !sourceCollectionHandles.has(destCollection.handle)) {
               const deletedId = await deleteCollection(destinationStore, destCollection.id, destCollection.handle, destCollection.title);
               if(deletedId) deletedCount++;
            }
        }
    }

    logger.completed('Collections', createdCount, updatedCount, deletedCount);

    // Re-generate the map from the potentially updated destCollectionMap
    const finalDestMap = new Map();
    destCollectionMap.forEach((collection, handle) => {
      finalDestMap.set(handle, collection.id);
    });
    return finalDestMap;

  } catch (error) {
    logger.failed('Collections', error);
    throw error; // Propagate the error
  }
}

module.exports = {
  syncCollections,
  getAllCollections,
  getCollectionMap,
  deleteCollection,
}; 
