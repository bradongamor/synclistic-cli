const { createJsonStorePersistence } = require('./json-store-persistence');
const { createCredentialStore } = require('./credential-store');
const { normalizeStoreRecord } = require('../utils/internal-test-mode');
const { normalizeShopDomain } = require('../utils/api-utils');

function normalizeStoreName(name) {
  return String(name || '').trim().toLowerCase();
}

function normalizeStoreUrl(storeUrl) {
  return normalizeShopDomain(storeUrl);
}

function createStoreRepositoryError(code, message, cause) {
  const error = new Error(message);
  error.name = 'StoreRepositoryError';
  error.code = code;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function storeHasLegacyApiKey(store) {
  return typeof store?.api_key === 'string' && store.api_key.trim().length > 0;
}

function toMetadataStore(store) {
  const normalizedStore = normalizeStoreRecord(store || {});
  return {
    store_name: String(normalizedStore.store_name || '').trim(),
    store_url: normalizeStoreUrl(normalizedStore.store_url) || null,
    is_test_store: Boolean(normalizedStore.is_test_store),
    test_store_notes: normalizedStore.test_store_notes || null
  };
}

function toHydratedStore(store, apiKey) {
  return normalizeStoreRecord({
    ...store,
    api_key: apiKey
  });
}

function stripApiKey(store) {
  const { api_key, ...rest } = store || {};
  return toMetadataStore(rest);
}

function ensureValidMetadataStore(store) {
  if (!store.store_name) {
    throw createStoreRepositoryError(
      'INVALID_STORE_NAME',
      'Store metadata requires a non-empty store name.'
    );
  }

  if (!store.store_url) {
    throw createStoreRepositoryError(
      'INVALID_STORE_URL',
      `Store "${store.store_name}" requires a valid normalized store URL.`
    );
  }
}

function assertUniqueStores(stores) {
  const seenNames = new Map();
  const seenUrls = new Map();

  for (const store of stores) {
    ensureValidMetadataStore(store);

    const normalizedName = normalizeStoreName(store.store_name);
    if (seenNames.has(normalizedName)) {
      throw createStoreRepositoryError(
        'DUPLICATE_STORE_NAME',
        `Store name must be unique: "${store.store_name}".`
      );
    }
    seenNames.set(normalizedName, store.store_name);

    const normalizedUrl = normalizeStoreUrl(store.store_url);
    if (seenUrls.has(normalizedUrl)) {
      throw createStoreRepositoryError(
        'DUPLICATE_STORE_URL',
        `Store URL must be unique: "${store.store_url}".`
      );
    }
    seenUrls.set(normalizedUrl, store.store_url);
  }
}

function normalizeStoredRecords(stores) {
  return Array.isArray(stores)
    ? stores.map((store) => normalizeStoreRecord(store))
    : [];
}

function restoreErrorMessage(error, fallback) {
  return error?.message ? `${fallback} ${error.message}` : fallback;
}

function createLegacyHydratedStoreRepository(deps = {}) {
  const loadHydratedStores =
    deps.getStores || (async () => []);
  const persistHydratedStores = deps.saveStores || null;

  async function getAllHydratedStores() {
    return normalizeStoredRecords(await loadHydratedStores());
  }

  async function saveHydratedStores(stores) {
    if (!persistHydratedStores) {
      throw createStoreRepositoryError(
        'STORE_PERSISTENCE_UNAVAILABLE',
        'Saving stores requires a saveStores implementation.'
      );
    }

    return persistHydratedStores(stores.map((store) => normalizeStoreRecord(store)));
  }

  return {
    async getAll() {
      return getAllHydratedStores();
    },

    async findByName(name) {
      const normalizedName = normalizeStoreName(name);
      const stores = await getAllHydratedStores();
      return (
        stores.find((store) => normalizeStoreName(store.store_name) === normalizedName) ||
        null
      );
    },

    async isNameTaken(name) {
      return Boolean(await this.findByName(name));
    },

    async isStoreUrlTaken(storeUrl) {
      const normalizedUrl = normalizeStoreUrl(storeUrl);
      const stores = await getAllHydratedStores();
      return stores.some(
        (store) => normalizeStoreUrl(store.store_url) === normalizedUrl
      );
    },

    async save(store) {
      const normalizedStore = normalizeStoreRecord(store);
      const metadataStore = toMetadataStore(normalizedStore);
      const apiKey = String(normalizedStore.api_key || '').trim();
      const existingStores = await getAllHydratedStores();

      if (!apiKey) {
        throw createStoreRepositoryError(
          'MISSING_STORE_API_KEY',
          `Store "${metadataStore.store_name}" requires an API key.`
        );
      }

      assertUniqueStores([...existingStores.map(stripApiKey), metadataStore]);

      const nextStores = [...existingStores, toHydratedStore(metadataStore, apiKey)];

      if (persistHydratedStores) {
        await saveHydratedStores(nextStores);
      }

      return toHydratedStore(metadataStore, apiKey);
    },

    async removeByName(name) {
      const normalizedName = normalizeStoreName(name);
      const existingStores = await getAllHydratedStores();
      const store = existingStores.find(
        (entry) => normalizeStoreName(entry.store_name) === normalizedName
      );

      if (!store) {
        return null;
      }

      if (persistHydratedStores) {
        const remainingStores = existingStores.filter(
          (entry) => normalizeStoreName(entry.store_name) !== normalizedName
        );
        await saveHydratedStores(remainingStores);
      }

      return store;
    },

    async replaceAll(stores) {
      const normalizedStores = normalizeStoredRecords(stores);
      assertUniqueStores(normalizedStores.map(stripApiKey));

      for (const store of normalizedStores) {
        if (!String(store.api_key || '').trim()) {
          throw createStoreRepositoryError(
            'MISSING_STORE_API_KEY',
            `Store "${store.store_name}" requires an API key.`
          );
        }
      }

      if (persistHydratedStores) {
        await saveHydratedStores(normalizedStores);
      }

      return normalizedStores;
    }
  };
}

function createStoreRepository(deps = {}) {
  if (!deps.storePersistence && !deps.credentialStore && (deps.getStores || deps.saveStores)) {
    return createLegacyHydratedStoreRepository(deps);
  }

  const persistence = deps.storePersistence || createJsonStorePersistence(deps);
  const credentialStore = deps.credentialStore || createCredentialStore(deps);
  const loadStores = deps.getStores || (() => persistence.load());
  const saveStores = deps.saveStores || ((stores) => persistence.save(stores));

  async function persistMetadataStores(stores) {
    await saveStores(stores.map(stripApiKey));
    return stores.map(stripApiKey);
  }

  async function safeDeleteCredential(storeUrl) {
    try {
      await credentialStore.deletePassword(storeUrl);
    } catch (error) {
      return error;
    }
    return null;
  }

  async function restoreCredentialSnapshot(snapshot, touchedUrls) {
    const uniqueUrls = [...new Set(touchedUrls)];

    for (const storeUrl of uniqueUrls) {
      const previousPassword = snapshot.get(storeUrl);
      if (previousPassword) {
        await credentialStore.setPassword(storeUrl, previousPassword);
      } else {
        await safeDeleteCredential(storeUrl);
      }
    }
  }

  async function requireCredential(store) {
    const password = await credentialStore.getPassword(store.store_url);
    if (!password) {
      throw createStoreRepositoryError(
        'STORE_CREDENTIAL_MISSING',
        `Stored credentials for "${store.store_name}" (${store.store_url}) are missing from the system credential store. Remove and re-add the store to restore access.`
      );
    }
    return password;
  }

  async function loadCredentialSnapshot(stores) {
    const snapshot = new Map();

    for (const store of stores) {
      snapshot.set(store.store_url, await requireCredential(store));
    }

    return snapshot;
  }

  async function migrateLegacyStores(stores) {
    const metadataStores = stores.map(stripApiKey);
    const writtenUrls = [];

    assertUniqueStores(metadataStores);

    try {
      for (const store of stores) {
        if (storeHasLegacyApiKey(store)) {
          await credentialStore.setPassword(store.store_url, store.api_key);
          writtenUrls.push(store.store_url);
        }
      }

      await persistMetadataStores(metadataStores);
      return metadataStores;
    } catch (error) {
      await restoreCredentialSnapshot(new Map(), writtenUrls);
      throw createStoreRepositoryError(
        'STORE_CREDENTIAL_MIGRATION_FAILED',
        restoreErrorMessage(error, 'Failed to migrate legacy store credentials.'),
        error
      );
    }
  }

  async function loadMetadataStores() {
    const storedRecords = normalizeStoredRecords(await loadStores());

    if (storedRecords.some(storeHasLegacyApiKey)) {
      return migrateLegacyStores(storedRecords);
    }

    const metadataStores = storedRecords.map(stripApiKey);
    assertUniqueStores(metadataStores);
    return metadataStores;
  }

  return {
    async getAll() {
      const metadataStores = await loadMetadataStores();
      const hydratedStores = [];

      for (const store of metadataStores) {
        hydratedStores.push(toHydratedStore(store, await requireCredential(store)));
      }

      return hydratedStores;
    },

    async findByName(name) {
      const normalizedName = normalizeStoreName(name);
      const metadataStores = await loadMetadataStores();
      const store = metadataStores.find(
        (entry) => normalizeStoreName(entry.store_name) === normalizedName
      );

      if (!store) {
        return null;
      }

      return toHydratedStore(store, await requireCredential(store));
    },

    async isNameTaken(name) {
      const normalizedName = normalizeStoreName(name);
      const metadataStores = await loadMetadataStores();
      return metadataStores.some(
        (store) => normalizeStoreName(store.store_name) === normalizedName
      );
    },

    async isStoreUrlTaken(storeUrl) {
      const normalizedUrl = normalizeStoreUrl(storeUrl);
      const metadataStores = await loadMetadataStores();
      return metadataStores.some(
        (store) => normalizeStoreUrl(store.store_url) === normalizedUrl
      );
    },

    async save(store) {
      const normalizedStore = normalizeStoreRecord(store);
      const metadataStore = toMetadataStore(normalizedStore);
      const apiKey = String(normalizedStore.api_key || '').trim();
      const metadataStores = await loadMetadataStores();

      if (!apiKey) {
        throw createStoreRepositoryError(
          'MISSING_STORE_API_KEY',
          `Store "${metadataStore.store_name}" requires an API key.`
        );
      }

      assertUniqueStores([...metadataStores, metadataStore]);

      await credentialStore.setPassword(metadataStore.store_url, apiKey);

      try {
        await persistMetadataStores([...metadataStores, metadataStore]);
      } catch (error) {
        await safeDeleteCredential(metadataStore.store_url);
        throw createStoreRepositoryError(
          'STORE_SAVE_FAILED',
          restoreErrorMessage(error, `Failed to save store "${metadataStore.store_name}".`),
          error
        );
      }

      return toHydratedStore(metadataStore, apiKey);
    },

    async removeByName(name) {
      const normalizedName = normalizeStoreName(name);
      const metadataStores = await loadMetadataStores();
      const targetStore = metadataStores.find(
        (store) => normalizeStoreName(store.store_name) === normalizedName
      );

      if (!targetStore) {
        return null;
      }

      const apiKey = await requireCredential(targetStore);
      const deleted = await credentialStore.deletePassword(targetStore.store_url);
      if (!deleted) {
        throw createStoreRepositoryError(
          'STORE_CREDENTIAL_DELETE_FAILED',
          `Failed to remove stored credentials for "${targetStore.store_name}".`
        );
      }

      const remainingStores = metadataStores.filter(
        (store) => normalizeStoreName(store.store_name) !== normalizedName
      );

      try {
        await persistMetadataStores(remainingStores);
      } catch (error) {
        await credentialStore.setPassword(targetStore.store_url, apiKey);
        throw createStoreRepositoryError(
          'STORE_REMOVE_FAILED',
          restoreErrorMessage(error, `Failed to remove store "${targetStore.store_name}".`),
          error
        );
      }

      return toHydratedStore(targetStore, apiKey);
    },

    async replaceAll(stores) {
      const normalizedStores = normalizeStoredRecords(stores);
      const metadataStores = normalizedStores.map(toMetadataStore);
      const currentMetadataStores = await loadMetadataStores();
      const currentCredentials = await loadCredentialSnapshot(currentMetadataStores);
      const touchedUrls = [
        ...currentMetadataStores.map((store) => store.store_url),
        ...metadataStores.map((store) => store.store_url)
      ];

      assertUniqueStores(metadataStores);

      for (const [index, store] of normalizedStores.entries()) {
        if (!String(store.api_key || '').trim()) {
          throw createStoreRepositoryError(
            'MISSING_STORE_API_KEY',
            `Store "${metadataStores[index].store_name}" requires an API key.`
          );
        }
      }

      try {
        for (const [index, store] of normalizedStores.entries()) {
          await credentialStore.setPassword(metadataStores[index].store_url, store.api_key);
        }

        const nextUrls = new Set(metadataStores.map((store) => store.store_url));
        for (const currentStore of currentMetadataStores) {
          if (!nextUrls.has(currentStore.store_url)) {
            await credentialStore.deletePassword(currentStore.store_url);
          }
        }

        await persistMetadataStores(metadataStores);
      } catch (error) {
        await restoreCredentialSnapshot(currentCredentials, touchedUrls);
        throw createStoreRepositoryError(
          'STORE_REPLACE_FAILED',
          restoreErrorMessage(error, 'Failed to replace stored store metadata.'),
          error
        );
      }

      return normalizedStores.map((store, index) =>
        toHydratedStore(metadataStores[index], store.api_key)
      );
    }
  };
}

module.exports = {
  createStoreRepository
};
