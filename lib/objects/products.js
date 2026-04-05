const { buildAdminGraphqlUrl, graphqlRequest } = require('../utils/api-utils');
const logger = require('../utils/logger');
const inquirer = require('inquirer');
const { getCollectionMap } = require('./collections');
const { extractFilenameFromUrl, normalizeFilename } = require('./media');

const productsQuery = `
  query($cursor: String) {
    products(first: 250, after: $cursor) {
      edges {
        node {
          id
          title
          handle
          createdAt
          descriptionHtml
          vendor
          productType
          category {
            id
          }
          status
          seo {
            title
            description
          }
          templateSuffix
          tags
          options(first: 10) {
            name
            position
            values
          }
          collections(first: 50) {
            edges {
              node {
                id
                handle
              }
            }
          }
          resourcePublicationsV2(first: 50) {
             edges {
               node {
                 publication {
                   id
                   name
                 }
                 publishDate
               }
             }
           }
          variants(first: 250) {
            edges {
              node {
                id
                title
                price
                compareAtPrice
                sku
                barcode
                inventoryPolicy
                taxable
                taxCode
                selectedOptions {
                  name
                  value
                }
                media(first: 10) {
                  nodes {
                    __typename
                    ... on MediaImage {
                      image {
                        url
                      }
                    }
                  }
                }
                image {
                  url
                }
                inventoryItem {
                  tracked
                  requiresShipping
                  unitCost {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
          images(first: 10) {
            edges {
              node {
                src
                altText
              }
            }
          }
          media(first: 10) {
            nodes {
              __typename
              ... on MediaImage {
                image {
                  url
                }
              }
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

const productQuery = `
  query($id: ID!) {
    product(id: $id) {
      variants(first: 250) {
        edges {
          node {
            id
            title
            price
            compareAtPrice
            sku
            barcode
            inventoryPolicy
            taxable
            taxCode
            selectedOptions {
              name
              value
            }
            media(first: 10) {
              nodes {
                __typename
                ... on MediaImage {
                  image {
                    url
                  }
                }
              }
            }
            image {
              url
            }
            inventoryItem {
              tracked
              requiresShipping
              unitCost {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  }
`;

const productSummariesQuery = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
      }
    }
  }
`;

const productUpdateMutation = `
  mutation productUpdate($input: ProductInput!, $media: [CreateMediaInput!]) {
    productUpdate(input: $input, media: $media) {
      product {
        id
        title
        tags
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const productOptionsCreateMutation = `
  mutation productOptionsCreate($productId: ID!, $options: [OptionCreateInput!]!, $variantStrategy: ProductOptionCreateVariantStrategy) {
    productOptionsCreate(productId: $productId, options: $options, variantStrategy: $variantStrategy) {
      product {
        id
        options {
          id
          name
          position
          values
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const productOptionUpdateMutation = `
  mutation productOptionUpdate($productId: ID!, $option: OptionUpdateInput!, $optionValuesToAdd: [OptionValueCreateInput!]) {
    productOptionUpdate(productId: $productId, option: $option, optionValuesToAdd: $optionValuesToAdd) {
      product {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const publicationsQuery = `
  query($cursor: String) {
    publications(first: 100, after: $cursor) {
      edges {
        node {
          id
          name
          # Add catalog { type } if needing to filter by app/channel type
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

function normalizeProductId(id) {
  if (!id) {
    return null;
  }

  const trimmed = String(id).trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('gid://shopify/Product/')) {
    return trimmed;
  }

  if (/^\d+$/.test(trimmed)) {
    return `gid://shopify/Product/${trimmed}`;
  }

  return trimmed;
}

function parseProductIdList(value, { allowEmpty }) {
  if (value === undefined || value === null) {
    return null;
  }

  const raw = String(value).split(',');
  const result = [];

  for (const item of raw) {
    const trimmed = item.trim();
    if (!trimmed) {
      if (allowEmpty) {
        result.push(null);
        continue;
      }
      logger.error('Products', 'Source product IDs cannot be empty.');
      return null;
    }

    result.push(normalizeProductId(trimmed));
  }

  return result;
}

async function syncProducts(sourceStore, destinationStore, options = {}) {
  const sourceUrl = buildAdminGraphqlUrl(sourceStore);
  const destUrl = buildAdminGraphqlUrl(destinationStore);

  const sourceHeaders = {
    'X-Shopify-Access-Token': sourceStore.api_key,
  };

  const destHeaders = {
    'X-Shopify-Access-Token': destinationStore.api_key,
  };

  try {
    // Get destination collection map first
    logger.info('Products', 'Fetching destination collection map...');
    const destCollectionMap = await getCollectionMap(destinationStore);
    logger.info('Products', `Found ${destCollectionMap.size} collections in destination map.`);

    // Get publication maps and create ID mapping
    logger.info('Products', 'Fetching publication maps...');
    const [sourcePublicationMap, destPublicationMap] = await Promise.all([
      getPublicationMap(sourceStore),
      getPublicationMap(destinationStore)
    ]);
    logger.info('Products', `Found ${sourcePublicationMap.size} source publications, ${destPublicationMap.size} destination publications.`);
    
    const publicationIdMap = new Map();
    sourcePublicationMap.forEach((sourceId, sourceName) => {
      if (destPublicationMap.has(sourceName)) {
        publicationIdMap.set(sourceId, destPublicationMap.get(sourceName));
      } else {
        logger.warn('Products', `Source publication "${sourceName}" (ID: ${sourceId}) not found by name in destination store. It will not be synced for products.`);
      }
    });
    logger.info('Products', `Created mapping for ${publicationIdMap.size} publications based on matching names.`);

    let createdCount = 0;
    let updatedCount = 0;
    let deletedCount = 0;

    const sourceProductIds = parseProductIdList(options.sourceProductIds, { allowEmpty: false });
    if (options.sourceProductIds && !sourceProductIds) {
      return;
    }

    const destinationProductIds = parseProductIdList(options.destinationProductIds, { allowEmpty: true });
    if (options.destinationProductIds && !destinationProductIds) {
      return;
    }

    const isProductIdSync = Boolean(sourceProductIds || destinationProductIds);

    let sourceProducts;
    let destProducts;

    if (isProductIdSync) {
      logger.info('Products', `Fetching source products by ID from ${sourceStore.store_name}...`);
      try {
        sourceProducts = await getProductsByIds(sourceStore, sourceProductIds);
        logger.info('Products', `Fetched ${sourceProducts.length} products from source.`);
      } catch (fetchError) {
        logger.error('Products', `Failed to fetch products from source ${sourceStore.store_name}: ${fetchError.message}`);
        throw fetchError;
      }

      logger.info('Products', `Fetching destination products by ID from ${destinationStore.store_name}...`);
      try {
        const destinationIds = destinationProductIds ? destinationProductIds.filter(Boolean) : [];
        destProducts = await getProductsByIds(destinationStore, destinationIds);
        logger.info('Products', `Fetched ${destProducts.length} products from destination.`);
      } catch (fetchError) {
        logger.error('Products', `Failed to fetch products from destination ${destinationStore.store_name}: ${fetchError.message}`);
        destProducts = [];
        logger.warn('Products', 'Proceeding with empty destination product list due to fetch error.');
      }

      if (!sourceProductIds || sourceProductIds.length === 0) {
        logger.error('Products', 'Product ID sync requires at least one source product ID.');
        return;
      }

      if (destinationProductIds && destinationProductIds.length !== sourceProductIds.length) {
        logger.error('Products', 'Destination product IDs must match the number of source product IDs.');
        return;
      }

      const sourceProductMap = new Map(sourceProducts.map(product => [product.id, product]));
      const destProductMap = new Map(destProducts.map(product => [product.id, product]));

      const pairs = sourceProductIds.map((sourceId, index) => ({
        sourceId,
        destinationId: destinationProductIds ? destinationProductIds[index] : null
      }));

      const selectedSourceProducts = [];
      const selectedDestProducts = [];

      for (const pair of pairs) {
        const sourceProduct = sourceProductMap.get(pair.sourceId);
        if (!sourceProduct) {
          logger.error('Products', `Source product ID not found: ${pair.sourceId}`);
          return;
        }
        selectedSourceProducts.push(sourceProduct);

        if (pair.destinationId) {
          const destProduct = destProductMap.get(pair.destinationId);
          if (!destProduct) {
            logger.error('Products', `Destination product ID not found: ${pair.destinationId}`);
            return;
          }
          selectedDestProducts.push(destProduct);
        }
      }

      sourceProducts = selectedSourceProducts;
      destProducts = selectedDestProducts;
    } else {
      // Get products from source store
      logger.info('Products', `Fetching products from source: ${sourceStore.store_name}...`);
      try {
        sourceProducts = await getAllProducts(sourceStore);
        logger.info('Products', `Fetched ${sourceProducts.length} products from source.`);
      } catch (fetchError) {
        logger.error('Products', `Failed to fetch products from source ${sourceStore.store_name}: ${fetchError.message}`);
        throw fetchError;
      }
      
      // Get products from destination store
      logger.info('Products', `Fetching products from destination: ${destinationStore.store_name}...`);
      try {
        destProducts = await getAllProducts(destinationStore);
        logger.info('Products', `Fetched ${destProducts.length} products from destination.`);
      } catch (fetchError) {
        logger.error('Products', `Failed to fetch products from destination ${destinationStore.store_name}: ${fetchError.message}`);
        destProducts = []; 
        logger.warn('Products', 'Proceeding with empty destination product list due to fetch error.');
      }
    }

    logger.counts('Products', sourceStore.store_name, sourceProducts.length, destinationStore.store_name, destProducts.length);
    
    // Flush logger before starting intensive loop
    await logger.flush(); 

    // Create/Update products from source
    if (isProductIdSync) {
      const destById = new Map(destProducts.map(product => [product.id, product]));
      const pairs = sourceProductIds.map((sourceId, index) => ({
        sourceId,
        destinationId: destinationProductIds ? destinationProductIds[index] : null
      }));

      for (const pair of pairs) {
        const sourceProduct = sourceProducts.find(product => product.id === pair.sourceId);
        const destProduct = pair.destinationId ? destById.get(pair.destinationId) : null;

        try {
          if (destProduct) {
            if (!options.createOnly) {
              logger.operation('Products', 'Updating', sourceProduct.title, sourceProduct.handle);
              const fullSourceProduct = await getFullProductDetails(sourceStore, sourceProduct.id);
              const updated = await updateProduct(destinationStore, destProduct.id, fullSourceProduct, destCollectionMap, publicationIdMap);
              if (updated) {
                updatedCount++;
              }
            }
          } else {
            if (!options.updateOnly) {
              logger.operation('Products', 'Creating', sourceProduct.title, sourceProduct.handle);
              const fullSourceProduct = await getFullProductDetails(sourceStore, sourceProduct.id);
              const createdId = await createProduct(destinationStore, fullSourceProduct, destCollectionMap, publicationIdMap);
              if (createdId) {
                createdCount++;
              }
            }
          }
        } catch (productError) {
          logger.error('Products', `Error processing "${sourceProduct.title}": ${productError.message}`);
        }
      }
    } else {
      for (const sourceProduct of sourceProducts) {
        const destProduct = destProducts.find(p => p.handle === sourceProduct.handle);

      try {
        if (destProduct) {
          if (!options.createOnly) {
             logger.operation('Products', 'Updating', sourceProduct.title, sourceProduct.handle);
            const fullSourceProduct = await getFullProductDetails(sourceStore, sourceProduct.id);
            const updated = await updateProduct(destinationStore, destProduct.id, fullSourceProduct, destCollectionMap, publicationIdMap);
            if (updated) { 
              updatedCount++;
            } 
          }
        } else {
          if (!options.updateOnly) {
            logger.operation('Products', 'Creating', sourceProduct.title, sourceProduct.handle);
            const fullSourceProduct = await getFullProductDetails(sourceStore, sourceProduct.id);
            const createdId = await createProduct(destinationStore, fullSourceProduct, destCollectionMap, publicationIdMap);
            if (createdId) { 
              createdCount++;
            } 
          }
        }
      } catch (productError) {
        logger.error('Products', `Error processing "${sourceProduct.title}": ${productError.message}`);
      }
      }
    }
    
    // Delete products that exist in destination but not in source
    if (!isProductIdSync && options.cleanDestination && !options.createOnly && !options.updateOnly) {
      logger.info('Products', 'Checking for items to remove from destination...');
      const sourceHandles = new Set(sourceProducts.map(p => p.handle));
      for (const destProduct of destProducts) {
        if (!sourceHandles.has(destProduct.handle)) {
          logger.operation('Products', 'Deleting', destProduct.title, destProduct.handle);
          try {
            await deleteProduct(destinationStore, destProduct.id);
            deletedCount++;
          } catch (deleteError) {
            logger.error('Products', `Error deleting "${destProduct.title}": ${deleteError.message}`);
          }
        }
      }
    }

    logger.completed('Products', createdCount, updatedCount, deletedCount);
  } catch (error) {
    logger.failed('Products', error);
  }
}

function collectProductImageUrls(productData) {
  return extractMediaImageUrls(productData?.media?.nodes || []);
}

function collectVariantImageUrls(productData) {
  const urls = [];
  (productData?.variants?.edges || []).forEach(edge => {
    urls.push(...extractVariantImageUrls(edge.node));
  });
  return urls;
}

function collectAllProductImageUrls(productData) {
  const urls = [
    ...collectProductImageUrls(productData),
    ...collectVariantImageUrls(productData)
  ];
  return Array.from(new Set(urls.filter(Boolean)));
}

async function prepareMediaInput(productData) {
  const mediaInput = [];
  const imageUrls = collectAllProductImageUrls(productData);
  const processedFilenames = new Set();
  const altTextByFilename = new Map();
  (productData?.images?.edges || []).forEach(edge => {
    const filename = normalizeFilename(extractFilenameFromUrl(edge.node.src));
    if (filename) {
      altTextByFilename.set(filename, edge.node.altText || '');
    }
  });

  logger.verbose('Products', `Source media URLs (${imageUrls.length}): ${imageUrls.join(', ')}`);

  for (const srcUrl of imageUrls) {
    const rawFilename = extractFilenameFromUrl(srcUrl);
    const srcFilename = normalizeFilename(rawFilename);
    if (!srcFilename) {
      logger.warn('Products', `Skipping media with no filename for URL: ${srcUrl}`);
      continue;
    }
    if (processedFilenames.has(srcFilename)) {
      logger.verbose('Products', `Skipping duplicate media entry for ${srcFilename}`);
      continue;
    }
    const altText = altTextByFilename.get(srcFilename) || '';
    logger.verbose('Products', `Media source filename: ${rawFilename} -> ${srcFilename}`);
    logger.verbose('Products', `Using source URL for ${srcFilename}`);
    mediaInput.push({
      mediaContentType: 'IMAGE',
      originalSource: srcUrl,
      alt: altText || srcFilename
    });
    processedFilenames.add(srcFilename);
  }
  return mediaInput;
}

async function prepareMediaInputForUpdate(productData, existingMediaMap) {
  const mediaInput = [];
  const imageUrls = collectAllProductImageUrls(productData);
  const processedFilenames = new Set();
  const altTextByFilename = new Map();

  (productData?.images?.edges || []).forEach(edge => {
    const filename = normalizeFilename(extractFilenameFromUrl(edge.node.src));
    if (filename) {
      altTextByFilename.set(filename, edge.node.altText || '');
    }
  });

  for (const srcUrl of imageUrls) {
    const rawFilename = extractFilenameFromUrl(srcUrl);
    const srcFilename = normalizeFilename(rawFilename);
    if (!srcFilename) {
      logger.warn('Products', `Skipping media with no filename for URL: ${srcUrl}`);
      continue;
    }
    if (processedFilenames.has(srcFilename)) {
      logger.verbose('Products', `Skipping duplicate media entry for ${srcFilename}`);
      continue;
    }

    if (existingMediaMap?.has(srcFilename)) {
      logger.verbose('Products', `Media already on product for ${srcFilename}, skipping add.`);
      processedFilenames.add(srcFilename);
      continue;
    }

    const altText = altTextByFilename.get(srcFilename) || '';
    logger.verbose('Products', `Media source filename: ${rawFilename} -> ${srcFilename}`);
    logger.verbose('Products', `Using source URL for ${srcFilename}`);
    mediaInput.push({
      mediaContentType: 'IMAGE',
      originalSource: srcUrl,
      alt: altText
    });
    processedFilenames.add(srcFilename);
  }

  return mediaInput;
}

function buildProductOptions(productData) {
  const options = productData?.options || [];
  if (options.length > 0) {
    return options.map(option => {
      let values = option.values || [];
      if (values.length === 0) {
        const derivedValues = new Set();
        (productData?.variants?.edges || []).forEach(edge => {
          (edge.node.selectedOptions || []).forEach(selectedOption => {
            if (selectedOption.name === option.name) {
              derivedValues.add(selectedOption.value);
            }
          });
        });
        values = Array.from(derivedValues);
      }

      return {
        name: option.name,
        values: values.map(value => ({ name: value }))
      };
    });
  }

  const fallbackValues = [...new Set((productData?.variants?.edges || []).map(edge => edge.node.title))]
    .map(value => ({ name: value }));

  return fallbackValues.length > 0
    ? [{ name: 'Title', values: fallbackValues }]
    : [];
}

function normalizeProductOptions(productData) {
  const rawOptions = buildProductOptions(productData);
  return rawOptions.map((option, index) => ({
    name: option.name,
    position: option.position ?? (index + 1),
    values: (option.values || []).map(value => value.name ?? value)
  }));
}

async function syncProductOptions(store, productId, sourceProductData, existingOptions = []) {
  const url = buildAdminGraphqlUrl(store);
  const headers = { 'X-Shopify-Access-Token': store.api_key };

  const sourceOptions = normalizeProductOptions(sourceProductData);
  if (sourceOptions.length === 0) {
    return;
  }

  const existingByPosition = new Map(
    (existingOptions || [])
      .slice()
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map(option => [option.position, option])
  );

  const optionsToCreate = [];

  for (const sourceOption of sourceOptions) {
    const existingOption = existingByPosition.get(sourceOption.position);
    if (!existingOption) {
      optionsToCreate.push({
        name: sourceOption.name,
        position: sourceOption.position,
        values: sourceOption.values.map(value => ({ name: value }))
      });
      continue;
    }

    const existingValues = new Set(existingOption.values || []);
    const optionValuesToAdd = sourceOption.values
      .filter(value => !existingValues.has(value))
      .map(value => ({ name: value }));

    const shouldRename = existingOption.name !== sourceOption.name;
    if (!shouldRename && optionValuesToAdd.length === 0) {
      continue;
    }

    const result = await graphqlRequest(
      url,
      productOptionUpdateMutation,
      {
        productId,
        option: {
          id: existingOption.id,
          name: sourceOption.name,
          position: sourceOption.position
        },
        optionValuesToAdd
      },
      headers
    );

    if (result.productOptionUpdate.userErrors.length > 0) {
      const errorMessages = result.productOptionUpdate.userErrors.map(e => e.message).join(', ');
      logger.error('Products', `Error updating option "${sourceOption.name}" for product ${productId}: ${errorMessages}`, result.productOptionUpdate.userErrors);
    }
  }

  if (optionsToCreate.length > 0) {
    const result = await graphqlRequest(
      url,
      productOptionsCreateMutation,
      {
        productId,
        options: optionsToCreate,
        variantStrategy: 'LEAVE_AS_IS'
      },
      headers
    );

    if (result.productOptionsCreate.userErrors.length > 0) {
      const errorMessages = result.productOptionsCreate.userErrors.map(e => e.message).join(', ');
      logger.error('Products', `Error creating product options for ${productId}: ${errorMessages}`, result.productOptionsCreate.userErrors);
    }
  }
}

function buildOptionValuesFromVariant(variantNode) {
  if (variantNode?.optionValues?.length) {
    return variantNode.optionValues;
  }

  if (variantNode?.selectedOptions?.length) {
    return variantNode.selectedOptions.map(option => ({
      optionName: option.name,
      name: option.value
    }));
  }

  return [{ name: variantNode.title, optionName: 'Title' }];
}

function getSelectedOptionsKey(selectedOptions = []) {
  return selectedOptions
    .map(option => `${option.name}:${option.value}`)
    .sort()
    .join('|');
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function getProductsByIds(store, ids) {
  const filteredIds = (ids || []).filter(Boolean);
  if (filteredIds.length === 0) {
    return [];
  }

  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const batches = chunkArray(filteredIds, 50);
  const products = [];

  for (const batch of batches) {
    const result = await graphqlRequest(url, productSummariesQuery, { ids: batch }, headers);
    const nodes = result?.nodes || [];
    nodes.forEach(node => {
      if (node && node.id) {
        products.push(node);
      }
    });
  }

  return products;
}

function collectMetafields(ownerId, metafieldsConnection) {
  const edges = metafieldsConnection?.edges || [];
  return edges.map(edge => ({
    ownerId,
    namespace: edge.node.namespace,
    key: edge.node.key,
    value: edge.node.value,
    type: edge.node.type
  }));
}

async function setMetafields(store, metafields) {
  if (!metafields || metafields.length === 0) {
    return;
  }

  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const batches = chunkArray(metafields, 25);
  for (const batch of batches) {
    const result = await graphqlRequest(url, mutation, { metafields: batch }, headers);
    if (result.metafieldsSet.userErrors.length > 0) {
      const errorMessages = result.metafieldsSet.userErrors.map(e => `(${e.field?.join(' -> ') || 'general'}) ${e.message}`).join('; ');
      logger.error('Products', `Error setting metafields: ${errorMessages}`, result.metafieldsSet.userErrors);
    }
  }
}

function buildVariantIdMap(variantEdges) {
  const skuMap = new Map();
  const optionsMap = new Map();
  const titleMap = new Map();

  variantEdges.forEach(edge => {
    const node = edge.node;
    if (node.sku) {
      skuMap.set(node.sku, node.id);
      return;
    }

    if (node.selectedOptions?.length) {
      optionsMap.set(getSelectedOptionsKey(node.selectedOptions), node.id);
      return;
    }

    if (node.title) {
      titleMap.set(node.title, node.id);
    }
  });

  return { skuMap, optionsMap, titleMap };
}

function extractMediaImageUrls(mediaNodes = []) {
  return mediaNodes
    .filter(node => node.__typename === 'MediaImage')
    .map(node => node.image?.url)
    .filter(Boolean);
}

function extractVariantImageUrls(variantNode) {
  const mediaUrls = extractMediaImageUrls(variantNode.media?.nodes || []);
  if (mediaUrls.length > 0) {
    return mediaUrls;
  }

  if (variantNode.image?.url) {
    return [variantNode.image.url];
  }

  return [];
}

async function getProductMediaMap(store, productId) {
  const url = buildAdminGraphqlUrl(store);
  const headers = { 'X-Shopify-Access-Token': store.api_key };

  const query = `
    query($id: ID!) {
      product(id: $id) {
        media(first: 250) {
          nodes {
            __typename
            id
            ... on MediaImage {
              alt
              image {
                url
              }
            }
          }
        }
      }
    }
  `;

  const result = await graphqlRequest(url, query, { id: productId }, headers);
  const nodes = result?.product?.media?.nodes || [];
  logger.verbose('Products', `Product media count for ${productId}: ${nodes.length}`);
  logger.verbose('Products', `Destination media URLs for ${productId}: ${nodes.map(node => node.image?.url).filter(Boolean).join(', ')}`);
  const map = new Map();
  nodes.forEach(node => {
    if (node.__typename !== 'MediaImage') {
      return;
    }
    const urlValue = node.image?.url || null;
    const rawFilename = extractFilenameFromUrl(urlValue) || node.alt || null;
    if (!rawFilename) {
      logger.verbose('Products', `Product media missing filename for media ID ${node.id}`);
      return;
    }
    const filename = normalizeFilename(rawFilename);
    if (!filename) {
      logger.verbose('Products', `Product media filename normalization failed for ${rawFilename}`);
      return;
    }
    if (map.has(filename)) {
      logger.warn('Products', `Duplicate media filename detected on product ${productId}: ${filename}. Using first occurrence.`);
      return;
    }
    logger.verbose('Products', `Product media filename: ${rawFilename} -> ${filename}`);
    map.set(filename, node.id);
  });
  return map;
}

async function waitForProductMediaReady(store, productId, expectedCount) {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const mediaMap = await getProductMediaMap(store, productId);
    if (mediaMap.size >= expectedCount) {
      logger.verbose('Products', `Product media ready for ${productId}: ${mediaMap.size}/${expectedCount}`);
      return;
    }
    const delayMs = 2000 * attempt;
    logger.warn('Products', `Waiting for product media readiness (${mediaMap.size}/${expectedCount}) on ${productId}, retrying in ${delayMs}ms...`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  logger.warn('Products', `Timed out waiting for product media readiness on ${productId}.`);
}

async function getProductVariantsWithMedia(store, productId) {
  const url = buildAdminGraphqlUrl(store);
  const headers = { 'X-Shopify-Access-Token': store.api_key };

  const query = `
    query($id: ID!) {
      product(id: $id) {
        variants(first: 250) {
          edges {
            node {
              id
              title
              sku
              selectedOptions {
                name
                value
              }
              media(first: 10) {
                nodes {
                  __typename
                  id
                  ... on MediaImage {
                    image {
                      url
                    }
                  }
                }
              }
              image {
                url
              }
            }
          }
        }
      }
    }
  `;

  const result = await graphqlRequest(url, query, { id: productId }, headers);
  return result?.product?.variants?.edges || [];
}

async function syncVariantMediaAssignments(store, productId, sourceProductData) {
  const mediaMap = await getProductMediaMap(store, productId);
  const destVariantEdges = await getProductVariantsWithMedia(store, productId);

  const destVariantMap = {
    skuMap: new Map(),
    optionsMap: new Map(),
    titleMap: new Map()
  };

  destVariantEdges.forEach(edge => {
    const node = edge.node;
    if (node.sku) {
      destVariantMap.skuMap.set(node.sku, node);
      return;
    }

    if (node.selectedOptions?.length) {
      destVariantMap.optionsMap.set(getSelectedOptionsKey(node.selectedOptions), node);
      return;
    }

    if (node.title) {
      destVariantMap.titleMap.set(node.title, node);
    }
  });

  for (const sourceEdge of sourceProductData.variants?.edges || []) {
    const sourceNode = sourceEdge.node;
    let destNode = null;

    if (sourceNode.sku && destVariantMap.skuMap.has(sourceNode.sku)) {
      destNode = destVariantMap.skuMap.get(sourceNode.sku);
    } else if (sourceNode.selectedOptions?.length) {
      const key = getSelectedOptionsKey(sourceNode.selectedOptions);
      destNode = destVariantMap.optionsMap.get(key) || null;
    } else if (sourceNode.title && destVariantMap.titleMap.has(sourceNode.title)) {
      destNode = destVariantMap.titleMap.get(sourceNode.title);
    }

    if (!destNode) {
      continue;
    }

    const desiredUrls = extractVariantImageUrls(sourceNode);
    const desiredMediaIds = new Set();
    desiredUrls.forEach(urlValue => {
      const rawFilename = extractFilenameFromUrl(urlValue);
      const filename = normalizeFilename(rawFilename);
      const mediaId = mediaMap.get(filename);
      if (mediaId) {
        desiredMediaIds.add(mediaId);
      } else {
        logger.warn('Products', `No destination media found for variant image ${filename} on product ${sourceProductData.handle || sourceProductData.title}.`);
      }
    });

    const existingMediaIds = new Set(
      extractMediaImageUrls(destNode.media?.nodes || []).map(urlValue => {
        const rawFilename = extractFilenameFromUrl(urlValue);
        const filename = normalizeFilename(rawFilename);
        return mediaMap.get(filename);
      }).filter(Boolean)
    );

    const toAppend = [...desiredMediaIds].filter(id => !existingMediaIds.has(id));
    const toDetach = [...existingMediaIds].filter(id => !desiredMediaIds.has(id));

    if (toAppend.length > 0) {
      await appendMediaToVariant(store, productId, destNode.id, toAppend);
    }

    if (toDetach.length > 0) {
      await detachMediaFromVariant(store, destNode.id, toDetach);
    }
  }
}

function buildSourceVariantIndexes(sourceVariantEdges) {
  const skuSet = new Set();
  const optionsKeySet = new Set();
  const titleSet = new Set();

  sourceVariantEdges.forEach(edge => {
    const node = edge.node;
    if (node.sku) {
      skuSet.add(node.sku);
      return;
    }

    if (node.selectedOptions?.length) {
      optionsKeySet.add(getSelectedOptionsKey(node.selectedOptions));
      return;
    }

    if (node.title) {
      titleSet.add(node.title);
    }
  });

  return { skuSet, optionsKeySet, titleSet };
}

async function createProduct(store, productData, destCollectionMap, publicationIdMap) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const createProductMutation = `
    mutation createProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) {
        product {
          id
          tags
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const productOptions = buildProductOptions(productData);

  const mediaInput = await prepareMediaInput(productData);

  // Map source collections to IDs using the destination map
  const sourceCollectionHandles = productData.collections?.edges?.map(edge => edge.node.handle) || [];
  const collectionsToJoin = sourceCollectionHandles
    .map(handle => destCollectionMap.get(handle))
    .filter(id => id);

  if (sourceCollectionHandles.length > 0 && collectionsToJoin.length !== sourceCollectionHandles.length) {
    logger.verbose('Products', `Product "${productData.title}" belongs to ${sourceCollectionHandles.length} collections but only ${collectionsToJoin.length} exist in destination. Run 'synclistic sync collections' first to sync all collections.`);
  }

  // Prepare publications input - Map source publication IDs to destination IDs
  const sourcePublications = productData.resourcePublicationsV2?.edges || [];
  const publicationsToPublishInput = sourcePublications
    .map(edge => {
      const sourcePubId = edge.node.publication.id;
      const destPubId = publicationIdMap.get(sourcePubId);
      if (destPubId) {
        return {
          publicationId: destPubId,
          publishDate: edge.node.publishDate
        };
      }
      return null;
    })
    .filter(input => input !== null);

  // Variables for creating the product shell with options and media
  const variables = {
    product: { 
      title: productData.title,
      handle: productData.handle,
      descriptionHtml: productData.descriptionHtml,
      vendor: productData.vendor,
      productType: productData.productType,
      category: productData.category?.id || null,
      status: productData.status,
      seo: productData.seo,
      templateSuffix: productData.templateSuffix,
      tags: productData.tags,
      collectionsToJoin: collectionsToJoin,
      productOptions: productOptions
    },
    media: mediaInput
  };

  const result = await graphqlRequest(url, createProductMutation, variables, headers);
  
  if (result.productCreate.userErrors.length > 0) {
    const errorMessages = result.productCreate.userErrors.map(e => e.message).join(', ');
    logger.error('Products', `Error creating product shell "${productData.title}": ${errorMessages}`, result.productCreate.userErrors);
    return null; // Indicate failure
  } 

  const productId = result.productCreate.product.id;
  logger.success('Products', `Product shell created successfully: ${productData.title} (ID: ${productId})`);

  // Publish to channels after product creation
  if (publicationsToPublishInput.length > 0) {
     await publishProductToChannels(store, productId, publicationsToPublishInput);
  } else {
     logger.verbose('Products', `No mapped publications to publish for new product ${productId}`);
  }

  await createVariantsForProduct(store, productId, productData.variants.edges);

  await syncVariantMediaAssignments(store, productId, productData);
  await syncMetafieldsForNewProduct(store, productId, productData);

  return productId;
}

async function createVariantsForProduct(store, productId, variantEdges) {
  if (!variantEdges || variantEdges.length === 0) {
    logger.info('Products', `No variants to create for product ID: ${productId}`);
    return; 
  }

  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const createVariantsMutation = `
    mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
      productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
        productVariants {
          id
          title
          sku
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variantInputs = variantEdges.map(edge => {
    // Get cost from the nested unitCost if available, otherwise from direct cost
    const cost = edge.node.inventoryItem?.unitCost?.amount ?? edge.node.inventoryItem?.cost;
    return {
      price: edge.node.price,
      compareAtPrice: edge.node.compareAtPrice,
      barcode: edge.node.barcode,
      inventoryPolicy: edge.node.inventoryPolicy,
      taxable: edge.node.taxable,
      taxCode: edge.node.taxCode,
      inventoryItem: {
        cost: cost,
        tracked: edge.node.inventoryItem?.tracked,
        sku: edge.node.sku,
        requiresShipping: edge.node.inventoryItem?.requiresShipping
      },
      optionValues: buildOptionValuesFromVariant(edge.node)
    };
  });

  const variables = {
    productId: productId,
    variants: variantInputs,
    strategy: "REMOVE_STANDALONE_VARIANT"
  };

  const result = await graphqlRequest(url, createVariantsMutation, variables, headers);

  if (result.productVariantsBulkCreate.userErrors.length > 0) {
    const errorMessages = result.productVariantsBulkCreate.userErrors.map(e => e.message).join(', ');
    logger.error('Products', `Error bulk creating variants for product ID ${productId}: ${errorMessages}`, result.productVariantsBulkCreate.userErrors);
  } else {
    const createdCount = result.productVariantsBulkCreate.productVariants?.length || 0;
    logger.success('Products', `Successfully created ${createdCount} variants for product ID: ${productId}`);
  }
}

async function syncMetafieldsForNewProduct(store, productId, sourceProductData) {
  const destProduct = await graphqlRequest(
    buildAdminGraphqlUrl(store),
    productQuery,
    { id: productId },
    { 'X-Shopify-Access-Token': store.api_key }
  );

  const destVariants = destProduct?.product?.variants?.edges || [];
  const variantIdMaps = buildVariantIdMap(destVariants);

  const metafields = [];
  metafields.push(...collectMetafields(productId, sourceProductData.metafields));

  (sourceProductData.variants?.edges || []).forEach(edge => {
    let destVariantId = null;
    if (edge.node.sku && variantIdMaps.skuMap.has(edge.node.sku)) {
      destVariantId = variantIdMaps.skuMap.get(edge.node.sku);
    } else if (edge.node.selectedOptions?.length) {
      const key = getSelectedOptionsKey(edge.node.selectedOptions);
      destVariantId = variantIdMaps.optionsMap.get(key) || null;
    } else if (edge.node.title && variantIdMaps.titleMap.has(edge.node.title)) {
      destVariantId = variantIdMaps.titleMap.get(edge.node.title);
    }

    if (!destVariantId) {
      return;
    }

    metafields.push(...collectMetafields(destVariantId, edge.node.metafields));
  });

  await setMetafields(store, metafields);
}

async function syncMetafieldsForExistingProduct(store, productId, sourceProductData, variantIdMap) {
  const metafields = [];
  metafields.push(...collectMetafields(productId, sourceProductData.metafields));

  (sourceProductData.variants?.edges || []).forEach(edge => {
    const destVariantId = variantIdMap.get(edge.node.id);
    if (!destVariantId) {
      return;
    }

    metafields.push(...collectMetafields(destVariantId, edge.node.metafields));
  });

  await setMetafields(store, metafields);
}

async function updateProduct(store, productId, sourceProductData, destCollectionMap, publicationIdMap) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  // First get existing product details, including variants and collections
  const fullProductQuery = `
    query($id: ID!) {
      product(id: $id) {
        category {
          id
        }
        vendor
        productType
        status
        seo {
          title
          description
        }
        options(first: 10) {
          id
          name
          position
          values
        }
        collections(first: 50) {
          edges {
            node {
              id
              handle
            }
          }
        }
        variants(first: 250) {
          edges {
            node {
              id
              title
              price
              compareAtPrice
              sku
              barcode
              inventoryPolicy
              taxable
              taxCode
              selectedOptions {
                name
                value
              }
              inventoryItem {
                tracked
                requiresShipping
                unitCost {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
        resourcePublicationsV2(first: 50) {
          edges {
            node {
              publication {
                id
                name
              }
              publishDate
            }
          }
        }
      }
    }
  `;
  const existingProduct = await graphqlRequest(url, fullProductQuery, { id: productId }, headers);
  const existingVariants = existingProduct.product.variants.edges;
  const existingCollections = existingProduct.product.collections.edges.map(edge => edge.node);
  const existingPublications = existingProduct.product.resourcePublicationsV2.edges.map(edge => edge.node.publication);
  const existingPublicationIds = new Set(existingPublications.map(p => p.id));
  const existingMediaMap = await getProductMediaMap(store, productId);

  // Collection Handling
  // Identify collections to join (in source but not destination)
  const sourceCollectionHandles = sourceProductData.collections?.edges?.map(edge => edge.node.handle) || [];
  const existingCollectionHandles = existingCollections.map(coll => coll.handle);
  
  // We need destination collection IDs based on source handles. Use the provided map.
  const collectionsToJoinIds = sourceCollectionHandles
    .filter(handle => !existingCollectionHandles.includes(handle))
    .map(handle => destCollectionMap.get(handle))
    .filter(id => id);

  // Identify collections to leave (on product in destination but not in source data)
  const collectionsToLeaveIds = existingCollections
    .filter(coll => !sourceCollectionHandles.includes(coll.handle))
    .map(coll => coll.id);

  // Variant Handling
  // Bulk update is generally better.
  const variantsToUpdate = [];
  const variantsToCreate = [];
  const variantsToDelete = [];

  const sourceVariantIndexes = buildSourceVariantIndexes(sourceProductData.variants.edges);

  const variantIdMap = new Map();

  sourceProductData.variants.edges.forEach(sourceEdge => {
    let existingVariant = null;
    if (sourceEdge.node.sku) {
      existingVariant = existingVariants.find(
        existingEdge => existingEdge.node.sku && existingEdge.node.sku === sourceEdge.node.sku
      );
    } else {
      logger.warn('Products', `Variant missing SKU for product ${sourceProductData.handle || sourceProductData.title}. Falling back to selectedOptions/title matching.`);
    }
    if (!existingVariant && sourceEdge.node.selectedOptions?.length) {
      const sourceOptionsKey = getSelectedOptionsKey(sourceEdge.node.selectedOptions);
      existingVariant = existingVariants.find(existingEdge =>
        getSelectedOptionsKey(existingEdge.node.selectedOptions) === sourceOptionsKey
      );
    }
    if (!existingVariant) {
      existingVariant = existingVariants.find(existingEdge => existingEdge.node.title === sourceEdge.node.title);
    }

    const variantPayload = {
      price: sourceEdge.node.price,
      compareAtPrice: sourceEdge.node.compareAtPrice,
      sku: sourceEdge.node.sku,
      barcode: sourceEdge.node.barcode,
      inventoryPolicy: sourceEdge.node.inventoryPolicy,
      taxable: sourceEdge.node.taxable,
      taxCode: sourceEdge.node.taxCode,
      inventoryItem: {
        cost: sourceEdge.node.inventoryItem?.unitCost?.amount,
        tracked: sourceEdge.node.inventoryItem?.tracked,
        requiresShipping: sourceEdge.node.inventoryItem?.requiresShipping,
      },
      optionValues: buildOptionValuesFromVariant(sourceEdge.node),
    };

    if (existingVariant) {
      variantsToUpdate.push({
        id: existingVariant.node.id,
        ...variantPayload
      });
      variantIdMap.set(sourceEdge.node.id, existingVariant.node.id);
    } else {
      // For bulk create, we don't provide an ID
      variantsToCreate.push(variantPayload);
    }
  });

  existingVariants.forEach(existingEdge => {
    const node = existingEdge.node;
    if (node.sku && sourceVariantIndexes.skuSet.has(node.sku)) {
      return;
    }

    if (!node.sku && node.selectedOptions?.length) {
      const key = getSelectedOptionsKey(node.selectedOptions);
      if (sourceVariantIndexes.optionsKeySet.has(key)) {
        return;
      }
    }

    if (!node.sku && (!node.selectedOptions || node.selectedOptions.length === 0) && node.title) {
      if (sourceVariantIndexes.titleSet.has(node.title)) {
        return;
      }
    }

    variantsToDelete.push(node.id);
  });

  // Publication Handling
  const sourcePublications = sourceProductData.resourcePublicationsV2?.edges || [];
  const mappedDestPublicationIds = new Set();
  const publicationsToPublishInput = [];

  sourcePublications.forEach(edge => {
    const sourcePubId = edge.node.publication.id;
    const destPubId = publicationIdMap.get(sourcePubId);
    if (destPubId) {
      mappedDestPublicationIds.add(destPubId);
      if (!existingPublicationIds.has(destPubId)) {
        // Only publish if not already published in destination
        publicationsToPublishInput.push({
          publicationId: destPubId,
          publishDate: edge.node.publishDate
        });
      }
    }
  });

  // Determine publications to unpublish (exist in destination but not in mapped source list)
  const publicationsToUnpublishInput = existingPublications
      .filter(pub => !mappedDestPublicationIds.has(pub.id))
      .map(pub => ({ publicationId: pub.id }));

  const input = {
    id: productId,
    title: sourceProductData.title,
    descriptionHtml: sourceProductData.descriptionHtml,
    vendor: sourceProductData.vendor,
    productType: sourceProductData.productType,
    category: sourceProductData.category?.id || null,
    status: sourceProductData.status,
    seo: sourceProductData.seo,
    templateSuffix: sourceProductData.templateSuffix,
    tags: sourceProductData.tags,
    collectionsToJoin: collectionsToJoinIds,
    collectionsToLeave: collectionsToLeaveIds,
  };

  const media = await prepareMediaInputForUpdate(sourceProductData, existingMediaMap);

  const updateResult = await graphqlRequest(url, productUpdateMutation, { input, media }, headers);

  if (updateResult.productUpdate.userErrors.length > 0) {
     const errorMessages = updateResult.productUpdate.userErrors.map(e => e.message).join(', ');
     logger.error('Products', `Error updating product core details for "${sourceProductData.title}" (ID: ${productId}): ${errorMessages}`, updateResult.productUpdate.userErrors);
  } else {
     logger.success('Products', `Successfully updated core details for product: ${sourceProductData.title} (ID: ${productId})`);
  }

    await detachProductMediaNotInSource(store, productId, sourceProductData);

  if (media.length > 0) {
    await waitForProductMediaReady(store, productId, media.length);
  }

  await syncProductOptions(store, productId, sourceProductData, existingProduct.product.options);

  if (variantsToUpdate.length > 0) {
    await bulkUpdateVariants(store, productId, variantsToUpdate);
  }

  if (variantsToCreate.length > 0) {
    // Note: createVariantsForProduct uses productVariantsBulkCreate which REPLACES existing variants by default.
    // We might need a different strategy or individual creations if mixing updates and creates.
    // For simplicity here, let's assume we handle creates separately or adjust the create strategy.
    // A safer approach might be to use productVariantCreate mutation individually.
    logger.info('Products', `Creating ${variantsToCreate.length} new variants for product ID: ${productId}`);
    // This will use the REMOVE_STANDALONE_VARIANT strategy by default, be careful.
    await createVariantsForProduct(store, productId, variantsToCreate.map(v => ({ node: v })));
  }

  if (variantsToDelete.length > 0) {
    await bulkDeleteVariants(store, productId, variantsToDelete);
  }

  await syncVariantMediaAssignments(store, productId, sourceProductData);
  await syncMetafieldsForExistingProduct(store, productId, sourceProductData, variantIdMap);
  
  await updateProductPublications(store, productId, publicationsToPublishInput, publicationsToUnpublishInput);

  // Return true if the core update didn't have errors, false otherwise
  return updateResult.productUpdate.userErrors.length === 0; 
}

async function dedupeProducts(store) {
  logger.info('Products', `Deduplicating products in ${store.store_name}...`);
  
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  try {
    const allProducts = await getAllProducts(store);
    logger.info('Products', `Found ${allProducts.length} products.`);

    const groupedProducts = groupProductsByTitle(allProducts);
    const duplicates = Object.values(groupedProducts).filter(group => group.length > 1);

    const totalDuplicates = duplicates.reduce((sum, group) => sum + group.length - 1, 0);
    logger.info('Products', `Found ${duplicates.length} groups of duplicate products.`);
    logger.info('Products', `Total number of duplicate products to be deleted: ${totalDuplicates}`);

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Are you sure you want to delete ${totalDuplicates} duplicate products?`,
        default: false
      }
    ]);

    if (!confirm) {
      logger.info('Products', 'Deduplication cancelled.');
      return;
    }

    for (const group of duplicates) {
      // Sort the group by createdAt (oldest first)
      group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const [keepProduct, ...duplicatesToRemove] = group;
      logger.info('Products', `Keeping oldest product: ${keepProduct.title} (ID: ${keepProduct.id}, Created: ${keepProduct.createdAt})`);
      
      for (const duplicate of duplicatesToRemove) {
        logger.operation('Products', 'Deleting', duplicate.title, `ID: ${duplicate.id}, Created: ${duplicate.createdAt}`);
        await deleteProduct(store, duplicate.id);
      }
    }

    logger.completed('Products', totalDuplicates);
  } catch (error) {
    logger.failed('Products', error);
  }
}

function groupProductsByTitle(products) {
  return products.reduce((acc, product) => {
    const title = product.title.toLowerCase().trim();
    if (!acc[title]) {
      acc[title] = [];
    }
    acc[title].push(product);
    return acc;
  }, {});
}

async function getAllProducts(store) {
  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;

  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  while (hasNextPage) {
    const variables = {
      cursor: cursor,
    };

    const data = await graphqlRequest(url, productsQuery, variables, headers);

    allProducts = allProducts.concat(data.products.edges.map(edge => edge.node));

    hasNextPage = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
  }

  return allProducts;
}

async function deleteProduct(store, productId) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const mutation = `
    mutation deleteProduct($id: ID!) {
      productDelete(input: { id: $id }) {
        deletedProductId
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = { id: productId };

  try {
    const result = await graphqlRequest(url, mutation, variables, headers);
    if (result.productDelete.userErrors.length > 0) {
      throw new Error(JSON.stringify(result.productDelete.userErrors));
    }
    return result.productDelete.deletedProductId;
  } catch (error) {
    throw new Error(`Failed to delete product: ${error.message}`);
  }
}

// Helper Functions (Need Implementation)

// Fetches full product details (including publications not in the main query)
async function getFullProductDetails(store, productId) {
  // Define a comprehensive query for a single product
  const detailedProductQuery = `
    query getSingleProduct($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        createdAt
        descriptionHtml
        templateSuffix
        tags
        vendor # Added vendor
        status # Added status
        productType # Added product type
        category {
          id
        }
        seo {
          title
          description
        }
        metafields(first: 100) {
          edges {
            node {
              namespace
              key
              value
              type
            }
          }
        }
        options(first: 10) { # Added options
            id
            name
            position
            values
        }
        collections(first: 50) { 
          edges { node { id handle } }
        }
        resourcePublicationsV2(first: 50) { 
           edges { 
             node { 
               publication { id name } 
               publishDate 
             }
           }
         }
        variants(first: 250) {
          edges {
            node {
              id
              title
              price
              compareAtPrice
              sku 
              barcode 
              position 
              inventoryPolicy
              inventoryQuantity
              taxable
              taxCode
              selectedOptions {
                name
                value
              }
              media(first: 10) {
                nodes {
                  __typename
                  ... on MediaImage {
                    image {
                      url
                    }
                  }
                }
              }
              image {
                url
              }
              metafields(first: 100) {
                edges {
                  node {
                    namespace
                    key
                    value
                    type
                  }
                }
              }
              inventoryItem { 
                id 
                tracked
                unitCost { 
                  amount 
                  currencyCode 
                }
                requiresShipping
                sku
                measurement { # Correct location for weight
                  weight {
                    value # e.g., 10.5
                    unit # e.g., KILOGRAMS
                  }
                }
              }
              presentmentPrices(first: 20) {
                edges {
                  node {
                    price { amount currencyCode }
                    compareAtPrice { amount currencyCode }
                  }
                }
              }
            }
          }
        }
        images(first: 50) { # Increased limit slightly
          edges { node { id src altText } } # Added ID
        }
        media(first: 250) {
          nodes {
            __typename
            ... on MediaImage {
              image {
                url
              }
            }
          }
        }
        # Add other fields if needed: seo, metafields, etc.
      }
    }
  `;

  const url = buildAdminGraphqlUrl(store);
  const headers = { 'X-Shopify-Access-Token': store.api_key };
  
  try {
      const result = await graphqlRequest(url, detailedProductQuery, { id: productId }, headers);
      if (!result.product) {
          logger.error('Products', `Failed to fetch full details for product ID ${productId}. Response:`, result);
          throw new Error(`Product with ID ${productId} not found or error during fetch.`);
      }
      return result.product;
  } catch (error) {
      logger.error('Products', `Error in getFullProductDetails for ID ${productId}: ${error.message}`);
      throw error;
  }
}

// Bulk updates variants using productVariantsBulkUpdate mutation
async function bulkUpdateVariants(store, productId, variantsToUpdate) {
  if (!variantsToUpdate || variantsToUpdate.length === 0) {
    return;
  }

  const url = buildAdminGraphqlUrl(store);
  const headers = { 'X-Shopify-Access-Token': store.api_key };

  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          # Add other fields if needed upon return, e.g., title, sku
          sku 
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  // Map the input data to the correct structure for ProductVariantsBulkInput
  const formattedVariants = variantsToUpdate.map(v => ({
    id: v.id,
    price: v.price,
    barcode: v.barcode,
    compareAtPrice: v.compareAtPrice,
    inventoryPolicy: v.inventoryPolicy,
    taxable: v.taxable,
    taxCode: v.taxCode,
    optionValues: v.optionValues,
    inventoryItem: {
      sku: v.sku,
      cost: v.inventoryItem?.cost,
      tracked: v.inventoryItem?.tracked,
      requiresShipping: v.inventoryItem?.requiresShipping
      // Add requiresShipping if needed: requiresShipping: v.inventoryItem?.requiresShipping
    },
    // Option values are NOT typically updated in bulk update, only used for matching/creation
    // Add metafields if needed: metafields: v.metafields,
    // Add inventoryQuantities if managing multi-location inventory: inventoryQuantities: v.inventoryQuantities
  }));

  const variables = { 
    productId: productId, 
    variants: formattedVariants 
  }; 

  try {
    const result = await graphqlRequest(url, mutation, variables, headers);
    
    if (result.productVariantsBulkUpdate.userErrors.length > 0) {
      const errorMessages = result.productVariantsBulkUpdate.userErrors.map(e => `(${e.field?.join(' -> ') || 'general'}) ${e.message}`).join('; ');
      logger.error('Products', `Error bulk updating variants for product ID ${productId}: ${errorMessages}`, result.productVariantsBulkUpdate.userErrors);
    } else {
      const updatedCount = result.productVariantsBulkUpdate.productVariants?.length || 0;
      logger.success('Products', `Successfully bulk updated ${updatedCount} variants for product ID: ${productId}`);
    }
  } catch (error) {
      logger.error('Products', `Failed mutation for bulk updating variants for product ID ${productId}: ${error.message}`);
      throw error;
  }
}

// Deletes variants that are not present in source
async function bulkDeleteVariants(store, productId, variantIds) {
  if (!variantIds || variantIds.length === 0) {
    return;
  }

  const url = buildAdminGraphqlUrl(store);
  const headers = { 'X-Shopify-Access-Token': store.api_key };

  const mutation = `
    mutation productVariantsBulkDelete($productId: ID!, $variants: [ID!]!) {
      productVariantsBulkDelete(productId: $productId, variants: $variants) {
        product {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    productId: productId,
    variants: variantIds
  };

  try {
    const result = await graphqlRequest(url, mutation, variables, headers);
    if (result.productVariantsBulkDelete.userErrors.length > 0) {
      const errorMessages = result.productVariantsBulkDelete.userErrors.map(e => `(${e.field?.join(' -> ') || 'general'}) ${e.message}`).join('; ');
      logger.error('Products', `Error bulk deleting variants for product ID ${productId}: ${errorMessages}`, result.productVariantsBulkDelete.userErrors);
    } else {
      logger.success('Products', `Successfully deleted ${variantIds.length} variants for product ID: ${productId}`);
    }
  } catch (error) {
    logger.error('Products', `Failed mutation for bulk deleting variants for product ID ${productId}: ${error.message}`);
    throw error;
  }
}

async function appendMediaToVariant(store, productId, variantId, mediaIds) {
  const url = buildAdminGraphqlUrl(store);
  const headers = { 'X-Shopify-Access-Token': store.api_key };

  const mutation = `
    mutation productVariantAppendMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
      productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
        userErrors {
          field
          message
        }
      }
    }
  `;

  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await graphqlRequest(
      url,
      mutation,
      {
        productId,
        variantMedia: [{ variantId, mediaIds }]
      },
      headers
    );

    if (result.productVariantAppendMedia.userErrors.length === 0) {
      return;
    }

    const errorMessages = result.productVariantAppendMedia.userErrors
      .map(e => `(${e.field?.join(' -> ') || 'general'}) ${e.message}`)
      .join('; ');

    if (errorMessages.includes('Non-ready media') && attempt < maxAttempts) {
      const delayMs = 3000 * attempt;
      logger.warn('Products', `Media not ready for variant ${variantId}, retrying in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      continue;
    }

    logger.error('Products', `Error appending media to variant ${variantId}: ${errorMessages}`, result.productVariantAppendMedia.userErrors);
    return;
  }
}

async function detachMediaFromVariant(store, variantId, mediaIds) {
  const url = buildAdminGraphqlUrl(store);
  const headers = { 'X-Shopify-Access-Token': store.api_key };

  const mutation = `
    mutation productVariantDetachMedia($variantId: ID!, $mediaIds: [ID!]!) {
      productVariantDetachMedia(variantId: $variantId, mediaIds: $mediaIds) {
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await graphqlRequest(url, mutation, { variantId, mediaIds }, headers);
  if (result.productVariantDetachMedia.userErrors.length > 0) {
    const errorMessages = result.productVariantDetachMedia.userErrors.map(e => `(${e.field?.join(' -> ') || 'general'}) ${e.message}`).join('; ');
    logger.error('Products', `Error detaching media from variant ${variantId}: ${errorMessages}`, result.productVariantDetachMedia.userErrors);
  }
}

async function detachProductMediaNotInSource(store, productId, sourceProductData) {
  const sourceFilenames = new Set(
    collectAllProductImageUrls(sourceProductData)
      .map(urlValue => normalizeFilename(extractFilenameFromUrl(urlValue)))
      .filter(Boolean)
  );

  if (sourceFilenames.size === 0) {
    return;
  }

  const mediaMap = await getProductMediaMap(store, productId);
  const mediaIdsToRemove = [];

  mediaMap.forEach((mediaId, filename) => {
    if (!sourceFilenames.has(filename)) {
      mediaIdsToRemove.push(mediaId);
    }
  });

  if (mediaIdsToRemove.length === 0) {
    return;
  }

  const url = buildAdminGraphqlUrl(store);
  const headers = { 'X-Shopify-Access-Token': store.api_key };

  const mutation = `
    mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await graphqlRequest(url, mutation, { productId, mediaIds: mediaIdsToRemove }, headers);
  if (result.productDeleteMedia.userErrors.length > 0) {
    const errorMessages = result.productDeleteMedia.userErrors.map(e => `(${e.field?.join(' -> ') || 'general'}) ${e.message}`).join('; ');
    logger.error('Products', `Error detaching product media for product ID ${productId}: ${errorMessages}`, result.productDeleteMedia.userErrors);
  } else {
    logger.success('Products', `Detached ${mediaIdsToRemove.length} product media items for product ID: ${productId}`);
  }
}

// Updates product publications using publishablePublish/Unpublish mutations
async function updateProductPublications(store, productId, publicationsToPublish, publicationsToUnpublish) {
  const url = buildAdminGraphqlUrl(store);
  const headers = { 'X-Shopify-Access-Token': store.api_key };

  // Publish
  if (publicationsToPublish.length > 0) {
    const publishMutation = `
      mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          publishable { __typename }
          userErrors { field message }
        }
      }
    `;
    try {
       const variables = { id: productId, input: publicationsToPublish };
       const result = await graphqlRequest(url, publishMutation, variables, headers);
       if (result.publishablePublish.userErrors.length > 0) {
         const errorMessages = result.publishablePublish.userErrors.map(e => e.message).join(', ');
         logger.error('Products', `Error publishing product ID ${productId}: ${errorMessages}`, result.publishablePublish.userErrors);
       } else {
         logger.success('Products', `Successfully published product ID ${productId} to ${publicationsToPublish.length} publications.`);
       }
    } catch (error) {
       logger.error('Products', `Failed publish mutation for product ID ${productId}: ${error.message}`);
    }
  }

  // Unpublish
  if (publicationsToUnpublish.length > 0) {
    const unpublishMutation = `
     mutation publishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
       publishableUnpublish(id: $id, input: $input) {
         publishable { __typename }
         userErrors { field message }
       }
     }
   `;
    try {
       const variables = { id: productId, input: publicationsToUnpublish };
       const result = await graphqlRequest(url, unpublishMutation, variables, headers);
        if (result.publishableUnpublish.userErrors.length > 0) {
         const errorMessages = result.publishableUnpublish.userErrors.map(e => e.message).join(', ');
         logger.error('Products', `Error unpublishing product ID ${productId}: ${errorMessages}`, result.publishableUnpublish.userErrors);
       } else {
         logger.success('Products', `Successfully unpublished product ID ${productId} from ${publicationsToUnpublish.length} publications.`);
       }
    } catch (error) {
       logger.error('Products', `Failed unpublish mutation for product ID ${productId}: ${error.message}`);
    }
  }
}

// Publishes a newly created product to specified channels
async function publishProductToChannels(store, productId, publications) {
  if (!publications || publications.length === 0) return;
  const url = buildAdminGraphqlUrl(store);
  const headers = { 'X-Shopify-Access-Token': store.api_key };
  const mutation = `
    mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable { __typename }
        userErrors { field message }
      }
    }
  `;
  try {
    const variables = { id: productId, input: publications }; 
    logger.verbose('Products', `Publishing new product ${productId} to ${publications.length} publications...`);
    const result = await graphqlRequest(url, mutation, variables, headers);
    if (result.publishablePublish.userErrors.length > 0) {
       const errorMessages = result.publishablePublish.userErrors.map(e => e.message).join(', ');
       logger.error('Products', `Error publishing product ID ${productId} to channels: ${errorMessages}`, result.publishablePublish.userErrors);
     } else {
       logger.success('Products', `Successfully published product ID ${productId} to ${publications.length} channels.`);
     }
  } catch (error) {
    logger.error('Products', `Failed publish mutation for new product ID ${productId}: ${error.message}`);
  }
}

// New Helper Functions

/**
 * Fetches all publications from a store and returns a map of name -> id.
 * @param {object} store - The store configuration object.
 * @returns {Promise<Map<string, string>>}
 */
async function getPublicationMap(store) {
  let publicationMap = new Map();
  let hasNextPage = true;
  let cursor = null;

  const url = buildAdminGraphqlUrl(store);
  const headers = { 'X-Shopify-Access-Token': store.api_key };

  logger.info('Publications', `Fetching publications from ${store.store_name}...`);

  while (hasNextPage) {
    const variables = { cursor: cursor };
    try {
      const data = await graphqlRequest(url, publicationsQuery, variables, headers);
      if (!data.publications) {
        logger.error('Publications', `Invalid response structure received from ${store.store_name}`, data);
        throw new Error(`Invalid response structure when fetching publications from ${store.store_name}.`);
      }
      data.publications.edges.forEach(edge => {
        if (edge.node && edge.node.name && edge.node.id) {
           publicationMap.set(edge.node.name, edge.node.id);
        } else {
           logger.warn('Publications', `Skipping publication without name or ID: ${JSON.stringify(edge.node)}`);
        }
      });
      hasNextPage = data.publications.pageInfo.hasNextPage;
      cursor = data.publications.pageInfo.endCursor;
    } catch (error) {
      logger.error('Publications', `Error fetching publications page from ${store.store_name}: ${error.message}`);
      throw error; 
    }
  }
  logger.info('Publications', `Finished fetching ${publicationMap.size} publications from ${store.store_name}.`);
  return publicationMap;
}

module.exports = {
  syncProducts,
  productsQuery,
  dedupeProducts,
  deleteProduct,
  normalizeProductId,
  parseProductIdList,
  getAllProducts,
  getProductsByIds,
  getFullProductDetails,
  getPublicationMap,
  createProduct,
  updateProduct
};
