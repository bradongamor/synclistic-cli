const { buildAdminGraphqlUrl, fetchRequest, graphqlRequest } = require('../utils/api-utils');
const logger = require('../utils/logger');

const getAllFilesQuery = `
  query GetAllFiles($first: Int, $after: String) {
    files(first: $first, after: $after) {
      edges {
        node {
          __typename
          id
          alt
          createdAt
          fileStatus
          updatedAt

          ... on MediaImage {
            mimeType
            image {
              url
            }
            imageOriginalSource: originalSource {
              url
            }
          }
          ... on Video {
            filename
            videoOriginalSource: originalSource {
              url
              mimeType
              format
            }
          }
          ... on GenericFile {
            url
            mimeType
            originalFileSize
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

const createFileMutation = `
  mutation fileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
        alt
        createdAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const updateFileMutation = `
  mutation UpdateFile($input: [FileUpdateInput!]!) {
    fileUpdate(files: $input) {
      files {
        id
        alt
        updatedAt
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

const deleteFileMutation = `
  mutation fileDelete($input: [ID!]!) {
    fileDelete(fileIds: $input) {
      deletedFileIds
      userErrors {
        message
      }
    }
  }
`;

const stagedUploadsCreateMutation = `
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function getAllFiles(store) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  let allFiles = [];
  let hasNextPage = true;
  let after = null;

  while (hasNextPage) {
    const variables = {
      first: 250,
      after: after,
    };

    const data = await graphqlRequest(url, getAllFilesQuery, variables, headers);

    allFiles = allFiles.concat(data.files.edges.map(edge => edge.node));

    hasNextPage = data.files.pageInfo.hasNextPage;
    after = data.files.pageInfo.endCursor;
  }

  return allFiles;
}

// Function to fetch file and get blob + size
async function fetchFileBlob(sourceUrl) {
  logger.verbose('Media', `Fetching file content from: ${sourceUrl}`);
  const fileResponse = await fetch(sourceUrl);
  if (!fileResponse.ok) {
    throw new Error(`Failed to fetch file from ${sourceUrl}: ${fileResponse.statusText}`);
  }
  const fileBlob = await fileResponse.blob();
  logger.verbose('Media', `Fetched file blob. Size: ${fileBlob.size}`);
  return fileBlob;
}

async function createFile(store, fileInput) {
  logger.verbose('Media', 'Creating file with input:', fileInput);

  // Extract filename and extension from the originalSource URL if not provided
  const originalFilename = fileInput.originalSource.split('/').pop().split('?')[0];
  const filename = fileInput.filename || originalFilename;
  
  // Determine MIME type based on file extension
  const extension = filename.split('.').pop().toLowerCase();
  const mimeTypeMap = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'mp4': 'video/mp4',
    'mov': 'video/quicktime',
    'webm': 'video/webm',
    'pdf': 'application/pdf',
    'json': 'application/json',
    'js': 'application/javascript',
    'css': 'text/css',
    'csv': 'text/csv',
    'txt': 'text/plain',
    'html': 'text/html',
    'xml': 'application/xml',
    'zip': 'application/zip',
    'glb': 'model/gltf-binary',
    'gltf': 'model/gltf+json',
    'usdz': 'model/vnd.usdz+zip',
  };
  const mimeType = mimeTypeMap[extension] || 'application/octet-stream';

  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'tiff', 'tif', 'bmp'];
  const videoExtensions = ['mp4', 'mov', 'webm', 'avi', 'm4v'];
  const model3dExtensions = ['glb', 'gltf', 'usdz'];

  let resourceType;
  let contentType;

  if (imageExtensions.includes(extension)) {
    resourceType = "IMAGE";
    contentType = "IMAGE";
  } else if (videoExtensions.includes(extension)) {
    resourceType = "VIDEO";
    contentType = "VIDEO";
  } else if (model3dExtensions.includes(extension)) {
    resourceType = "MODEL_3D";
    contentType = "MODEL_3D";
  } else {
    resourceType = "FILE";
    contentType = "FILE";
  }

  logger.verbose('Media', `Prepared data:`, { filename, mimeType, resourceType, contentType });

  try {
    // Fetch file content first to get size 
    const fileBlob = await fetchFileBlob(fileInput.originalSource);
    const fileSize = fileBlob.size.toString(); // Get size and convert to string
    logger.verbose('Media', `Determined file size: ${fileSize} bytes for ${filename}`);
    
    const stagedUploadInput = { filename, mimeType, resource: resourceType };
    if (resourceType === 'VIDEO' || resourceType === 'MODEL_3D') {
       stagedUploadInput.fileSize = fileSize;
    }
    if (resourceType === 'FILE' || resourceType === 'VIDEO' || resourceType === 'MODEL_3D') {
       stagedUploadInput.httpMethod = 'POST';
    }
    
    const stagedTarget = await createStagedUpload(store, stagedUploadInput);
    
    if (!stagedTarget) {
      throw new Error('stagedUploadsCreate mutation returned no staged target');
    }
    logger.verbose('Media', 'Staged target created:', stagedTarget);
    
    logger.verbose('Media', `Attempting upload with staged target: ${JSON.stringify(stagedTarget, null, 2)}`);
    if (!stagedTarget || !stagedTarget.url) {
      logger.error('Media', 'Staged target is invalid or missing URL before calling uploadFileToStagedTarget!');
      // Potentially throw error here if needed, or let uploadFileToStagedTarget handle it
    }

    // Pass the fetched fileBlob to upload function 
    const resourceUrl = await uploadFileToStagedTarget(stagedTarget, fileBlob, resourceType); 
    logger.verbose('Media', `File uploaded to staged target, resourceUrl:`, resourceUrl);

    const url = buildAdminGraphqlUrl(store);
    const headers = {
      'X-Shopify-Access-Token': store.api_key,
      'Content-Type': 'application/json',
    };

    const fileInputObject = {
      alt: fileInput.alt,
      contentType: contentType,
      originalSource: resourceUrl,
    };

    if (contentType !== 'VIDEO' && contentType !== 'MODEL_3D') {
      fileInputObject.duplicateResolutionMode = "RAISE_ERROR"; 
    }

    const variables = {
      files: [fileInputObject]
    };
    
    logger.verbose('Media', 'Calling fileCreate with variables:', JSON.stringify(variables, null, 2));
    const data = await graphqlRequest(url, createFileMutation, variables, headers);
    
    if (data.fileCreate.userErrors && data.fileCreate.userErrors.length > 0) {
      logger.error('Media', `Error creating file: ${JSON.stringify(data.fileCreate.userErrors)}`);
      return data.fileCreate;
    }

    const createdFile = data.fileCreate.files[0];
    logger.verbose('Media', `File created successfully: ${createdFile.id}`);

    return data.fileCreate;
  } catch (error) {
    logger.error('Media', 'Error in createFile function:');
    logger.error('Media', `Message: ${error.message}`);
    logger.error('Media', `Stack: ${error.stack}`);
    throw error;
  }
}

async function updateFile(store, fileInput) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const variables = {
    input: [fileInput]  // Note: We're now passing an array
  };

  logger.verbose('Media', 'Calling updateFile mutation...');
  const data = await graphqlRequest(url, updateFileMutation, variables, headers);
  
  // Add error handling for updateFile response
  if (data.fileUpdate.userErrors && data.fileUpdate.userErrors.length > 0) {
      const errors = data.fileUpdate.userErrors.map(error => `(${error.field?.join('.') || 'general'}) ${error.message}`).join(', ');
      logger.error('Media', `Failed to update file: ${errors}`);
      // Decide whether to throw or just log and return payload with errors
      // For consistency with createFile, let's return the payload
      // throw new Error(`Failed to update file: ${errors}`); 
      return data.fileUpdate; // Return payload containing errors
  }
  
  // TODO: Check if data.fileUpdate.files exists and has elements?
  logger.verbose('Media', 'File update mutation completed.');

  return data.fileUpdate;
}

async function deleteFile(store, fileId) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
  };

  const variables = {
    input: [fileId]
  };

  const data = await graphqlRequest(url, deleteFileMutation, variables, headers);
  
  if (data.fileDelete.userErrors && data.fileDelete.userErrors.length > 0) {
    const errors = data.fileDelete.userErrors.map(error => error.message).join(', ');
    logger.error('Media', `Failed to delete file: ${errors}`);
    throw new Error(errors);
  }

  if (data.fileDelete.deletedFileIds && data.fileDelete.deletedFileIds.length > 0) {
    logger.verbose('Media', `Successfully deleted file: ${fileId}`);
  } else {
    logger.warn('Media', `No files were deleted for ID: ${fileId}`);
  }

  return data.fileDelete;
}

async function createStagedUpload(store, { filename, mimeType, resource, fileSize, httpMethod }) {
  const url = buildAdminGraphqlUrl(store);
  const headers = {
    'X-Shopify-Access-Token': store.api_key,
    'Content-Type': 'application/json',
  };

  const inputPayload = {
    filename,
    mimeType,
    resource: resource
  };
  
  if (fileSize !== undefined) {
     inputPayload.fileSize = fileSize;
  }
  
  if (httpMethod !== undefined) {
     inputPayload.httpMethod = httpMethod;
  }

  const variables = {
    input: [inputPayload]
  };
  
  logger.verbose('Media', 'Calling stagedUploadsCreate with variables:', JSON.stringify(variables, null, 2));

  const data = await graphqlRequest(url, stagedUploadsCreateMutation, variables, headers);
  
  if (!data) {
    logger.error('Media', 'graphqlRequest returned null or undefined for stagedUploadsCreate mutation.');
    throw new Error('Failed to get response from stagedUploadsCreate mutation');
  }

  logger.verbose('Media', `Full response from stagedUploadsCreate mutation: ${JSON.stringify(data, null, 2)}`);

  if (data.stagedUploadsCreate.userErrors && data.stagedUploadsCreate.userErrors.length > 0) {
    logger.error('Media', 'UserErrors in stagedUploadsCreate response:', data.stagedUploadsCreate.userErrors);
    throw new Error(`Error creating staged upload: ${JSON.stringify(data.stagedUploadsCreate.userErrors)}`);
  }

  if (!data.stagedUploadsCreate.stagedTargets || data.stagedUploadsCreate.stagedTargets.length === 0) {
    logger.error('Media', 'No stagedTargets found in the stagedUploadsCreate response.');
    throw new Error('No staged targets returned from stagedUploadsCreate mutation');
  }

  const stagedTarget = data.stagedUploadsCreate.stagedTargets[0];
  logger.verbose('Media', 'Staged target received:', stagedTarget); // Log received target

  return stagedTarget;
}

async function uploadFileToStagedTarget(stagedTarget, fileBlob, resourceType) { 
  logger.verbose('Media', `Uploading file blob (type: ${resourceType}) to staged target...`);

  if (!stagedTarget || !stagedTarget.url) { 
    throw new Error('Invalid staged target provided to upload function');
  }

  try {
    let uploadResponse;
    
    if (resourceType === 'IMAGE') {
      logger.verbose('Media', 'Using PUT method for image upload');
      const headers = {
          'Content-Type': stagedTarget.parameters?.find(p => p.name.toLowerCase() === 'content-type')?.value || fileBlob.type || 'application/octet-stream',
      };
      const aclParam = stagedTarget.parameters?.find(p => p.name.toLowerCase() === 'acl');
      if (aclParam) {
          headers.acl = aclParam.value;
      }
      
      uploadResponse = await fetch(stagedTarget.url, {
        method: 'PUT',
        body: fileBlob,
        headers: headers,
      });
      
    } else if (resourceType === 'VIDEO' || resourceType === 'FILE' || resourceType === 'MODEL_3D') {
      logger.verbose('Media', `Using POST method with FormData for ${resourceType} upload`);
      
      const formData = new FormData();
      if (!stagedTarget.parameters || stagedTarget.parameters.length === 0) {
          throw new Error('Staged target parameters are missing, cannot prepare upload form.');
      }
      const keyParam = stagedTarget.parameters.find(p => p.name === 'key');
      if (!keyParam || !keyParam.value) {
          throw new Error('Staged target parameters missing required \'key\'.');
      }

      stagedTarget.parameters.forEach(param => {
          formData.append(param.name, param.value);
      });
      
      const uploadFilename = keyParam.value.split('/').pop(); 
      formData.append('file', fileBlob, uploadFilename);

      uploadResponse = await fetch(stagedTarget.url, {
        method: 'POST',
        body: formData,
      });
      
    } else {
        throw new Error(`Unsupported resource type for upload: ${resourceType}`);
    }

    // Common response handling 
    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      logger.error('Media', 'Upload failed:', { status: uploadResponse.status, statusText: uploadResponse.statusText, body: errorText });
      throw new Error(`Failed to upload file (${uploadResponse.status}): ${uploadResponse.statusText}. Details: ${errorText}`);
    }

    logger.verbose('Media', 'File uploaded successfully to staged target.');
    
    if (!stagedTarget.resourceUrl) {
        logger.error('Media', 'Staged target is missing resourceUrl after successful upload.', stagedTarget);
        throw new Error('Upload succeeded but resourceUrl is missing from staged target.');
    }
    return stagedTarget.resourceUrl;
  } catch (error) {
    logger.error('Media', 'Error during file upload:', error);
    throw error;
  }
}

async function syncMedia(sourceStore, destinationStore, options = {}) {
  try {
    logger.info('Media', `Fetching media files from ${sourceStore.store_name}...`);
    const sourceFiles = await getAllFiles(sourceStore);
    logger.info('Media', `Found ${sourceFiles.length} files in ${sourceStore.store_name}`);

    logger.info('Media', `Fetching media files from ${destinationStore.store_name}...`);
    const destFiles = await getAllFiles(destinationStore);
    logger.info('Media', `Found ${destFiles.length} files in ${destinationStore.store_name}`);

    logger.counts('Media', sourceStore.store_name, sourceFiles.length, destinationStore.store_name, destFiles.length);

    const getFileInfo = (fileNode) => {
      if (!fileNode) return null;
      let originalSourceUrl, filename, mimeType;

      if (fileNode.__typename === 'MediaImage') {
        originalSourceUrl = fileNode.image?.url || fileNode.imageOriginalSource?.url;
        filename = fileNode.filename;
        mimeType = fileNode.mimeType;
      } else if (fileNode.__typename === 'Video') {
        originalSourceUrl = fileNode.videoOriginalSource?.url;
        filename = fileNode.filename;
        mimeType = fileNode.videoOriginalSource?.mimeType;
      } else if (fileNode.__typename === 'GenericFile') {
        originalSourceUrl = fileNode.url;
        filename = fileNode.filename;
        mimeType = fileNode.mimeType;
      } else {
        logger.warn('Media', `Unsupported file type: ${fileNode.__typename} with ID ${fileNode.id}`);
        return null;
      }

      if (!originalSourceUrl && !filename) {
        logger.warn('Media', `Skipping file ${fileNode.id} due to missing source URL or filename`);
        return null;
      }
      
      if (!filename && originalSourceUrl) {
         filename = originalSourceUrl.split('/').pop().split('?')[0];
      }
      
      if (!filename) {
         logger.warn('Media', `Could not determine filename for file ${fileNode.id}`);
         return null;
      }
      
      const normalizedFilename = normalizeFilename(filename) || filename;
      const extension = normalizedFilename.split('.').pop().toLowerCase();
      const baseName = normalizedFilename.slice(0, -(extension.length + 1));

      return {
        id: fileNode.id,
        typename: fileNode.__typename,
        alt: fileNode.alt,
        originalSourceUrl: originalSourceUrl,
        filename: normalizedFilename,
        baseName: baseName,
        extension: extension,
        mimeType: mimeType
      };
    };

    // Create/Update files from source
    for (const sourceFileNode of sourceFiles) {
      const sourceFileInfo = getFileInfo(sourceFileNode);
      if (!sourceFileInfo) continue; // Skip if info couldn't be extracted

      const destFileNode = destFiles.find(destNode => {
        const destFileInfo = getFileInfo(destNode);
        if (!destFileInfo) return false;
        return sourceFileInfo.baseName === destFileInfo.baseName && sourceFileInfo.extension === destFileInfo.extension;
      });

      const destFileInfo = getFileInfo(destFileNode);

      if (!destFileInfo) {
        if (!options.updateOnly) {
          logger.operation('Media', 'Creating', sourceFileInfo.filename);
          
          let createContentType = 'IMAGE';
          if (sourceFileInfo.typename === 'Video') {
             createContentType = 'VIDEO';
          } else if (sourceFileInfo.typename === 'GenericFile') {
             createContentType = 'FILE';
          }
          
          const fileInput = {
            alt: sourceFileInfo.alt,
            contentType: createContentType,
            originalSource: sourceFileInfo.originalSourceUrl,
            filename: sourceFileInfo.filename
          };

          try {
            const result = await createFile(destinationStore, fileInput);
            if (result.files && result.files[0]) {
              logger.verbose('Media', `File created successfully: ${result.files[0].id}`);
            }
          } catch (error) {
            logger.error('Media', `Error creating file ${sourceFileInfo.filename}: ${error.message}`);
          }
        }
      } else if (sourceFileInfo.alt !== destFileInfo.alt) {
        // File exists, check if update is needed (currently only checks alt text)
        // TODO: Add checks for other relevant differences if needed (e.g., file content update?)
        if (!options.createOnly) {
          logger.operation('Media', 'Updating', destFileInfo.filename);
          // Update alt text - this works for both MediaImage and Video as alt is on the File interface
          await updateFile(destinationStore, {
            id: destFileInfo.id,
            alt: sourceFileInfo.alt
          });
        }
      } else {
        // File exists and seems up-to-date based on current checks
        logger.verbose('Media', `File already exists and is up to date: ${destFileInfo.filename}`);
      }
    }

    // Delete files that exist in destination but not in source
    if (options.cleanDestination && !options.createOnly && !options.updateOnly) {
      logger.info('Media', 'Checking for files to remove...');
      let deletedCount = 0;
      let errorCount = 0;

      for (const destFileNode of destFiles) {
        const destFileInfo = getFileInfo(destFileNode);
        if (!destFileInfo) continue; // Skip if info couldn't be extracted

        // Find corresponding source file based on filename
        const sourceFileExists = sourceFiles.some(sourceNode => {
          const sourceFileInfo = getFileInfo(sourceNode);
          return sourceFileInfo && 
                 sourceFileInfo.baseName === destFileInfo.baseName && 
                 sourceFileInfo.extension === destFileInfo.extension;
        });

        if (!sourceFileExists) {
          // Source file not found, delete destination file
          logger.operation('Media', 'Deleting', destFileInfo.filename);
          try {
            await deleteFile(destinationStore, destFileInfo.id);
            deletedCount++;
          } catch (deleteError) {
            logger.error('Media', `Error deleting file "${destFileInfo.filename}": ${deleteError.message}`);
            errorCount++;
          }
        }
      }

      if (deletedCount > 0 || errorCount > 0) {
        logger.info('Media', `Deletion summary: ${deletedCount} files deleted, ${errorCount} errors`);
      } else {
        logger.info('Media', 'No files needed to be deleted');
      }
    }

    logger.completed('Media', sourceFiles.length);
  } catch (error) {
    logger.failed('Media', error);
  }
}

function extractFilenameFromUrl(url) {
  if (!url) return null;
  return url.split('/').pop().split('?')[0];
}

function normalizeFilename(filename) {
  if (!filename) return null;
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) {
    return filename;
  }
  const base = filename.slice(0, lastDot);
  const extension = filename.slice(lastDot + 1).toLowerCase();
  const normalizedBase = base
    .replace(/[_-]\d+[_-][0-9a-f]{6,}(?:-[0-9a-f]{4,}){0,3}$/i, '')
    .replace(/[_-][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '')
    .replace(/[-_][0-9a-f]{8}$/i, '');
  return `${normalizedBase}.${extension}`;
}

function findMatchingFile(filename, files) {
  if (!filename || !files) return null;
  const normalizedSource = normalizeFilename(filename);
  if (!normalizedSource) return null;

  const sourceLower = normalizedSource.toLowerCase();
  const sourceHasExt = normalizedSource.includes('.');
  const sourceDot = normalizedSource.lastIndexOf('.');
  const sourceBase = sourceHasExt ? normalizedSource.slice(0, sourceDot) : normalizedSource;
  const sourceExt = sourceHasExt ? normalizedSource.slice(sourceDot + 1).toLowerCase() : null;

  let bestMatch = null;
  let bestScore = Number.POSITIVE_INFINITY;

  files.forEach(f => {
    const destFilename = f.filename
      || f.image?.filename
      || extractFilenameFromUrl(f.image?.url || f.imageOriginalSource?.url || f.url || f.videoOriginalSource?.url);
    const destAlt = f.alt || null;

    if (!destFilename && !destAlt) return;

    const normalizedDest = destFilename ? normalizeFilename(destFilename) : null;
    const normalizedAlt = destAlt ? normalizeFilename(destAlt) : null;

    let score = null;

    if (destFilename) {
      const destNameLower = destFilename.toLowerCase();
      const destDot = destFilename.lastIndexOf('.');
      const destBase = destDot !== -1 ? destFilename.slice(0, destDot) : destFilename;
      const destExt = destDot !== -1 ? destFilename.slice(destDot + 1).toLowerCase() : null;

      if (sourceExt && destExt && destExt !== sourceExt) {
        // Extension mismatch; ignore this filename candidate.
      } else {
        const destBaseLower = destBase.toLowerCase();
        const sourceBaseLower = sourceBase.toLowerCase();
        const suffix = destBaseLower.startsWith(sourceBaseLower)
          ? destBaseLower.slice(sourceBaseLower.length)
          : null;

        if (sourceLower === destNameLower) {
          score = 0;
        } else if (destBaseLower === sourceBaseLower) {
          score = 1;
        } else if (suffix && /^[_-][0-9a-f_-]{6,}$/i.test(suffix)) {
          score = 2;
        }
      }
    }

    if (score === null && normalizedDest) {
      const destLower = normalizedDest.toLowerCase();
      if (destLower === sourceLower) {
        score = 3;
      }
    }

    if (score === null && normalizedAlt) {
      const altLower = normalizedAlt.toLowerCase();
      if (altLower === sourceLower || altLower === sourceBase.toLowerCase()) {
        score = 4;
      }
    }

    if (score !== null && score < bestScore) {
      bestScore = score;
      bestMatch = f;
    }
  });

  return bestMatch;
}

function getFileUrl(file) {
  if (!file) return null;
  return file.image?.url || file.imageOriginalSource?.url || file.url || file.videoOriginalSource?.url;
}

module.exports = {
  syncMedia,
  getAllFiles,
  createFile,
  updateFile,
  deleteFile,
  extractFilenameFromUrl,
  normalizeFilename,
  findMatchingFile,
  getFileUrl
};
