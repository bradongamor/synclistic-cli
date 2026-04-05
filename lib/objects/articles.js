const { buildAdminGraphqlUrl, graphqlRequest } = require('../utils/api-utils');
const logger = require('../utils/logger');
const inquirer = require('inquirer');

const articlesQuery = `
  query($cursor: String) {
    articles(first: 250, after: $cursor) {
      edges {
        node {
          author {
            name
          }
          blog {
            id
            handle
            title
          }
          id
          title
          handle
          body
          image {
            url
            altText
          }
          publishedAt
          tags
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const articleCreateMutation = `
  mutation articleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article {
        author {
          name
        }
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

const articleUpdateMutation = `
  mutation articleUpdate($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article {
        author {
          name
        }
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

async function syncArticles(sourceStore, destinationStore, options = {}) {
  try {
    // Get source store blogs
    const sourceBlogsData = await graphqlRequest(
      buildAdminGraphqlUrl(sourceStore),
      `query {
        blogs(first: 250) {
          edges {
            node {
              id
              handle
              title
            }
          }
        }
      }`,
      {},
      { 'X-Shopify-Access-Token': sourceStore.api_key }
    );

    logger.verbose('Articles', 'Source store blogs:');
    sourceBlogsData.blogs.edges.forEach(edge => {
      logger.verbose('Articles', `- ${edge.node.title} (${edge.node.handle})`);
    });

    // Get destination store blogs
    const destBlogsData = await graphqlRequest(
      buildAdminGraphqlUrl(destinationStore),
      `query {
        blogs(first: 250) {
          edges {
            node {
              id
              handle
              title
            }
          }
        }
      }`,
      {},
      { 'X-Shopify-Access-Token': destinationStore.api_key }
    );

    logger.verbose('Articles', 'Destination store blogs:');
    destBlogsData.blogs.edges.forEach(edge => {
      logger.verbose('Articles', `- ${edge.node.title} (${edge.node.handle})`);
    });

    const destBlogs = new Map(
      destBlogsData.blogs.edges.map(edge => [edge.node.handle, edge.node.id])
    );

    // Get articles and check for missing blogs
    const sourceArticles = await getArticlesForStore(sourceStore);
    const destArticles = await getArticlesForStore(destinationStore);

    logger.counts('Articles', sourceStore.store_name, sourceArticles.length, destinationStore.store_name, destArticles.length);

    const missingBlogs = new Set();
    sourceArticles.forEach(article => {
      if (!destBlogs.has(article.blog.handle)) {
        missingBlogs.add(article.blog);
      }
    });

    if (missingBlogs.size > 0) {
      logger.error('Articles', 'Cannot sync articles. The following blogs are missing from the destination store:');
      missingBlogs.forEach(blog => logger.error('Articles', `- ${blog.title} (${blog.handle})`));
      logger.info('Articles', '\nPlease run the blog sync first using the syncBlogs command.');
      return;
    }

    // Proceed with article sync if all blogs exist
    for (const sourceArticle of sourceArticles) {
      const destArticle = destArticles.find(a => a.handle === sourceArticle.handle);
      const blogId = destBlogs.get(sourceArticle.blog.handle);

      try {
        if (destArticle) {
          if (!options.createOnly) {
            logger.operation('Articles', 'Updating', sourceArticle.title, sourceArticle.handle);
            await updateArticle(destinationStore, destArticle.id, sourceArticle, blogId);
          }
        } else {
          if (!options.updateOnly) {
            logger.operation('Articles', 'Creating', sourceArticle.title, sourceArticle.handle);
            await createArticle(destinationStore, sourceArticle, blogId);
          }
        }
      } catch (articleError) {
        // If creation fails due to handle conflict, try updating instead
        if (articleError.message.includes("Handle has already been taken") && !options.updateOnly) {
          logger.warn('Articles', `Handle conflict detected, attempting update for: ${sourceArticle.title}`);
          const conflictingArticle = destArticles.find(a => a.handle === sourceArticle.handle);
          if (conflictingArticle) {
            await updateArticle(destinationStore, conflictingArticle.id, sourceArticle, blogId);
          }
        } else {
          logger.error('Articles', `Error processing "${sourceArticle.title}": ${articleError.message}`);
        }
      }
    }

    // Delete articles that exist in destination but not in source
    if (options.cleanDestination && !options.createOnly && !options.updateOnly) {
      logger.info('Articles', 'Checking for articles to remove...');
      for (const destArticle of destArticles) {
        const sourceArticle = sourceArticles.find(a => a.handle === destArticle.handle);
        if (!sourceArticle) {
          logger.operation('Articles', 'Deleting', destArticle.title, destArticle.handle);
          try {
            await deleteArticle(destinationStore, destArticle.id);
          } catch (deleteError) {
            logger.error('Articles', `Error deleting "${destArticle.title}": ${deleteError.message}`);
          }
        }
      }
    }

    logger.completed('Articles', sourceArticles.length);
  } catch (error) {
    logger.failed('Articles', error);
  }
}

async function getArticlesForStore(store) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  let allArticles = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const data = await graphqlRequest(url, articlesQuery, { cursor }, headers);
    allArticles = [...allArticles, ...data.articles.edges.map(edge => edge.node)];
    
    hasNextPage = data.articles.pageInfo.hasNextPage;
    cursor = data.articles.pageInfo.endCursor;
  }

  return allArticles;
}

async function createArticle(store, articleData, blogId) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const variables = {
    article: {
      author: {
        name: articleData.author.name
      },
      title: articleData.title,
      body: articleData.body,
      handle: articleData.handle,
      tags: articleData.tags,
      blogId: blogId
    }
  };

  if (articleData.image?.url) {
    variables.article.image = {
      url: articleData.image.url,
      altText: articleData.image.altText
    };
  }

  const result = await graphqlRequest(url, articleCreateMutation, variables, headers);
  
  if (result.articleCreate.userErrors.length > 0) {
    throw new Error(`Error creating article: ${JSON.stringify(result.articleCreate.userErrors)}`);
  }

  return result.articleCreate.article;
}

async function updateArticle(store, articleId, articleData, blogId) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const variables = {
    id: articleId,
    article: {
      author: {
        name: articleData.author.name
      },
      title: articleData.title,
      body: articleData.body,
      tags: articleData.tags,
      blogId: blogId,
      publishDate: articleData.publishedAt,
      image: articleData.image?.url ? {
        url: articleData.image.url,
        altText: articleData.image.altText
      } : null
    }
  };

  const result = await graphqlRequest(url, articleUpdateMutation, variables, headers);
  
  if (result.articleUpdate.userErrors.length > 0) {
    throw new Error(`Error updating article: ${JSON.stringify(result.articleUpdate.userErrors)}`);
  }

  return result.articleUpdate.article;
}

async function dedupeArticles(store) {
  logger.info('Articles', `Deduplicating articles in ${store.store_name}...`);

  try {
    const allArticles = await getArticlesForStore(store);
    logger.info('Articles', `Found ${allArticles.length} articles.`);

    const groupedArticles = groupArticlesByTitleAndBlog(allArticles);
    const duplicates = Object.values(groupedArticles).filter(group => group.length > 1);

    const totalDuplicates = duplicates.reduce((sum, group) => sum + group.length - 1, 0);
    logger.info('Articles', `Found ${duplicates.length} groups of duplicate articles.`);
    logger.info('Articles', `Total number of duplicate articles to be deleted: ${totalDuplicates}`);

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Are you sure you want to delete ${totalDuplicates} duplicate articles?`,
        default: false
      }
    ]);

    if (!confirm) {
      logger.info('Articles', 'Deduplication cancelled.');
      return;
    }

    for (const group of duplicates) {
      // Sort the group by createdAt (oldest first)
      group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const [keepArticle, ...duplicatesToRemove] = group;
      logger.info('Articles', `Keeping oldest article: ${keepArticle.title} (Blog: ${keepArticle.blog.title}, ID: ${keepArticle.id}, Created: ${keepArticle.createdAt})`);
      
      for (const duplicate of duplicatesToRemove) {
        logger.operation('Articles', 'Deleting', duplicate.title, `Blog: ${duplicate.blog.title}, ID: ${duplicate.id}, Created: ${duplicate.createdAt}`);
        await deleteArticle(store, duplicate.id);
      }
    }

    logger.completed('Articles', totalDuplicates);
  } catch (error) {
    logger.failed('Articles', error);
  }
}

function groupArticlesByTitleAndBlog(articles) {
  return articles.reduce((acc, article) => {
    // Group by both title and blog handle to avoid deleting articles with same title in different blogs
    const key = `${article.title.toLowerCase().trim()}|${article.blog.handle}`;
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(article);
    return acc;
  }, {});
}

async function deleteArticle(store, articleId) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const mutation = `
    mutation deleteArticle($id: ID!) {
      articleDelete(id: $id) {
        deletedArticleId
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = { id: articleId };

  try {
    const result = await graphqlRequest(url, mutation, variables, headers);
    if (result.articleDelete.userErrors.length > 0) {
      throw new Error(JSON.stringify(result.articleDelete.userErrors));
    }
    return result.articleDelete.deletedArticleId;
  } catch (error) {
    throw new Error(`Failed to delete article: ${error.message}`);
  }
}

module.exports = {
  syncArticles,
  articlesQuery,
  dedupeArticles,
  deleteArticle
};
