const { buildAdminGraphqlUrl, graphqlRequest } = require('../utils/api-utils');
const logger = require('../utils/logger');
const inquirer = require('inquirer');

const blogsQuery = `
  query($cursor: String) {
    blogs(first: 250, after: $cursor) {
      edges {
        node {
          id
          title
          handle
          createdAt
          articles(first: 250) {
            edges {
              node {
                id
                title
                handle
                body
                publishedAt
                tags
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

const blogCreateMutation = `
  mutation blogCreate($blog: BlogCreateInput!) {
    blogCreate(blog: $blog) {
      blog {
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

const blogUpdateMutation = `
  mutation blogUpdate($id: ID!, $blog: BlogUpdateInput!) {
    blogUpdate(id: $id, blog: $blog) {
      blog {
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

async function syncBlogs(sourceStore, destinationStore, options = {}) {
  const sourceUrl = buildAdminGraphqlUrl(sourceStore);
  const destUrl = buildAdminGraphqlUrl(destinationStore);

  const sourceHeaders = {
    'X-Shopify-Access-Token': sourceStore.api_key,
  };

  const destHeaders = {
    'X-Shopify-Access-Token': destinationStore.api_key,
  };

  try {
    const sourceData = await graphqlRequest(sourceUrl, blogsQuery, {}, sourceHeaders);
    const sourceBlogs = sourceData.blogs.edges.map(edge => edge.node);
    const destData = await graphqlRequest(destUrl, blogsQuery, {}, destHeaders);
    const destBlogs = destData.blogs.edges.map(edge => edge.node);

    logger.counts('Blogs', sourceStore.store_name, sourceBlogs.length, destinationStore.store_name, destBlogs.length);

    // Create/Update blogs from source
    for (const sourceBlog of sourceBlogs) {
      const destBlog = destBlogs.find(b => b.handle === sourceBlog.handle);

      try {
        if (destBlog) {
          if (!options.createOnly) {
            logger.operation('Blogs', 'Updating', sourceBlog.title, sourceBlog.handle);
            await updateBlog(destinationStore, destBlog.id, sourceBlog);
          }
        } else {
          if (!options.updateOnly) {
            logger.operation('Blogs', 'Creating', sourceBlog.title, sourceBlog.handle);
            await createBlog(destinationStore, sourceBlog);
          }
        }
      } catch (blogError) {
        logger.error('Blogs', `Error processing "${sourceBlog.title}": ${blogError.message}`);
      }
    }

    // Delete blogs that exist in destination but not in source
    if (options.cleanDestination && !options.createOnly && !options.updateOnly) {
      logger.info('Blogs', 'Checking for blogs to remove...');
      for (const destBlog of destBlogs) {
        const sourceBlog = sourceBlogs.find(b => b.handle === destBlog.handle);
        if (!sourceBlog) {
          logger.operation('Blogs', 'Deleting', destBlog.title, destBlog.handle);
          try {
            await deleteBlog(destinationStore, destBlog.id);
          } catch (deleteError) {
            logger.error('Blogs', `Error deleting "${destBlog.title}": ${deleteError.message}`);
          }
        }
      }
    }

    logger.completed('Blogs', sourceBlogs.length);
  } catch (error) {
    logger.failed('Blogs', error);
  }
}

async function createBlog(store, blogData) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const variables = {
    blog: {
      title: blogData.title,
      handle: blogData.handle
    }
  };

  const result = await graphqlRequest(url, blogCreateMutation, variables, headers);
  
  if (result.blogCreate.userErrors.length > 0) {
    throw new Error(`Error creating blog: ${JSON.stringify(result.blogCreate.userErrors)}`);
  }

  return result.blogCreate.blog;
}

async function updateBlog(store, blogId, blogData) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const variables = {
    id: blogId,
    blog: {
      title: blogData.title
    }
  };

  const result = await graphqlRequest(url, blogUpdateMutation, variables, headers);
  
  if (result.blogUpdate.userErrors.length > 0) {
    throw new Error(`Error updating blog: ${JSON.stringify(result.blogUpdate.userErrors)}`);
  }

  return result.blogUpdate.blog;
}

async function dedupeBlogs(store) {
  logger.info('Blogs', `Deduplicating blogs in ${store.store_name}...`);

  try {
    const url = buildAdminGraphqlUrl(store);
    const headers = {
      'X-Shopify-Access-Token': store.api_key,
    };

    const data = await graphqlRequest(url, blogsQuery, {}, headers);
    const allBlogs = data.blogs.edges.map(edge => edge.node);
    logger.info('Blogs', `Found ${allBlogs.length} blogs.`);

    const groupedBlogs = groupBlogsByTitle(allBlogs);
    const duplicates = Object.values(groupedBlogs).filter(group => group.length > 1);

    const totalDuplicates = duplicates.reduce((sum, group) => sum + group.length - 1, 0);
    logger.info('Blogs', `Found ${duplicates.length} groups of duplicate blogs.`);
    logger.info('Blogs', `Total number of duplicate blogs to be deleted: ${totalDuplicates}`);

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Are you sure you want to delete ${totalDuplicates} duplicate blogs?`,
        default: false
      }
    ]);

    if (!confirm) {
      logger.info('Blogs', 'Deduplication cancelled.');
      return;
    }

    for (const group of duplicates) {
      // Sort the group by createdAt (oldest first)
      group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const [keepBlog, ...duplicatesToRemove] = group;
      logger.info('Blogs', `Keeping oldest blog: ${keepBlog.title} (ID: ${keepBlog.id}, Created: ${keepBlog.createdAt})`);
      
      for (const duplicate of duplicatesToRemove) {
        logger.operation('Blogs', 'Deleting', duplicate.title, `ID: ${duplicate.id}, Created: ${duplicate.createdAt}`);
        await deleteBlog(store, duplicate.id);
      }
    }

    logger.completed('Blogs', totalDuplicates);
  } catch (error) {
    logger.failed('Blogs', error);
  }
}

function groupBlogsByTitle(blogs) {
  return blogs.reduce((acc, blog) => {
    const title = blog.title.toLowerCase().trim();
    if (!acc[title]) {
      acc[title] = [];
    }
    acc[title].push(blog);
    return acc;
  }, {});
}

async function deleteBlog(store, blogId) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const mutation = `
    mutation deleteBlog($id: ID!) {
      blogDelete(id: $id) {
        deletedBlogId
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = { id: blogId };

  try {
    const result = await graphqlRequest(url, mutation, variables, headers);
    if (result.blogDelete.userErrors.length > 0) {
      throw new Error(JSON.stringify(result.blogDelete.userErrors));
    }
    return result.blogDelete.deletedBlogId;
  } catch (error) {
    throw new Error(`Failed to delete blog: ${error.message}`);
  }
}

module.exports = {
  syncBlogs,
  blogsQuery,
  deleteBlog
};
