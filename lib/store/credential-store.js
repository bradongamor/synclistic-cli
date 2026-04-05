const { Entry } = require('@napi-rs/keyring');
const { normalizeShopDomain } = require('../utils/api-utils');

const STORE_CREDENTIAL_SERVICE = 'synclistic';
const LEGACY_STORE_CREDENTIAL_SERVICES = ['synclistic-cli'];

class CredentialStoreError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'CredentialStoreError';
    this.code = code;
    if (cause) {
      this.cause = cause;
    }
  }
}

function createCredentialStore(deps = {}) {
  const EntryClass = deps.EntryClass || Entry;
  const serviceName = deps.serviceName || STORE_CREDENTIAL_SERVICE;
  const legacyServiceNames = deps.legacyServiceNames || LEGACY_STORE_CREDENTIAL_SERVICES;
  const createEntry =
    deps.createEntry ||
    ((storeUrl) => new EntryClass(serviceName, normalizeShopDomain(storeUrl)));

  function resolveAccount(storeUrl) {
    const normalizedStoreUrl = normalizeShopDomain(storeUrl);
    if (!normalizedStoreUrl) {
      throw new CredentialStoreError(
        'INVALID_STORE_URL',
        'A valid normalized store URL is required for credential storage.'
      );
    }
    return normalizedStoreUrl;
  }

  function wrapError(code, account, action, error) {
    return new CredentialStoreError(
      code,
      `Failed to ${action} credentials for "${account}": ${error.message}`,
      error
    );
  }

  return {
    serviceName,

    getAccount(storeUrl) {
      return resolveAccount(storeUrl);
    },

    async setPassword(storeUrl, password) {
      const account = resolveAccount(storeUrl);
      if (!password) {
        throw new CredentialStoreError(
          'MISSING_PASSWORD',
          `Credentials for "${account}" require a non-empty password.`
        );
      }

      try {
        createEntry(account).setPassword(password);
        return account;
      } catch (error) {
        throw wrapError('CREDENTIAL_STORE_WRITE_FAILED', account, 'store', error);
      }
    },

    async getPassword(storeUrl) {
      const account = resolveAccount(storeUrl);

      try {
        const currentPassword = createEntry(account).getPassword() ?? null;
        if (currentPassword) {
          return currentPassword;
        }

        for (const legacyServiceName of legacyServiceNames) {
          const legacyPassword =
            new EntryClass(legacyServiceName, account).getPassword() ?? null;
          if (legacyPassword) {
            return legacyPassword;
          }
        }

        return null;
      } catch (error) {
        throw wrapError('CREDENTIAL_STORE_READ_FAILED', account, 'read', error);
      }
    },

    async deletePassword(storeUrl) {
      const account = resolveAccount(storeUrl);

      try {
        const deleted = Boolean(createEntry(account).deletePassword());
        let deletedLegacy = false;

        for (const legacyServiceName of legacyServiceNames) {
          deletedLegacy =
            Boolean(new EntryClass(legacyServiceName, account).deletePassword()) ||
            deletedLegacy;
        }

        return deleted || deletedLegacy;
      } catch (error) {
        throw wrapError('CREDENTIAL_STORE_DELETE_FAILED', account, 'delete', error);
      }
    }
  };
}

module.exports = {
  LEGACY_STORE_CREDENTIAL_SERVICES,
  CredentialStoreError,
  STORE_CREDENTIAL_SERVICE,
  createCredentialStore
};
