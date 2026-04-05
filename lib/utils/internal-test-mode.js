const { normalizeShopDomain } = require('./api-utils');

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function parseEmailAllowlist(value) {
  return String(value || "")
    .split(",")
    .map((entry) => normalizeEmail(entry))
    .filter(Boolean);
}

function isEnabled(value) {
  return String(value || "")
    .trim()
    .toLowerCase() === 'true';
}

function normalizeNotes(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeBoolean(value) {
  return value === true || String(value || '').trim().toLowerCase() === 'true';
}

function normalizeStoreRecord(store) {
  if (!store || typeof store !== 'object') {
    return store;
  }

  return {
    ...store,
    store_url: normalizeShopDomain(store.store_url) || store.store_url || null,
    is_test_store: normalizeBoolean(store.is_test_store || store.isTestStore),
    test_store_notes: normalizeNotes(store.test_store_notes || store.testStoreNotes)
  };
}

function getInternalTestModeConfig(env = process.env) {
  const enabled = isEnabled(
    env.SYNCLISTIC_INTERNAL_TEST_MODE || env.INTERNAL_TEST_MODE
  );
  const operatorEmail = normalizeEmail(
    env.SYNCLISTIC_OPERATOR_EMAIL || env.INTERNAL_TEST_OPERATOR_EMAIL
  );
  const allowlistedEmails = parseEmailAllowlist(
    env.SYNCLISTIC_INTERNAL_TEST_USER_EMAILS || env.INTERNAL_TEST_USER_EMAILS
  );

  return {
    enabled,
    operatorEmail,
    allowlistedEmails,
    isOperatorAllowlisted:
      Boolean(operatorEmail) && allowlistedEmails.includes(operatorEmail)
  };
}

function evaluateDestructiveSyncAccess(destinationStore, env = process.env) {
  const config = getInternalTestModeConfig(env);

  if (!config.enabled) {
    return {
      ok: false,
      code: 'internal_mode_disabled',
      message:
        'Destructive sync is disabled because SYNCLISTIC_INTERNAL_TEST_MODE is not enabled.'
    };
  }

  if (!config.operatorEmail) {
    return {
      ok: false,
      code: 'missing_operator_email',
      message:
        'Destructive sync is disabled because SYNCLISTIC_OPERATOR_EMAIL is not configured.'
    };
  }

  if (!config.isOperatorAllowlisted) {
    return {
      ok: false,
      code: 'operator_not_allowlisted',
      message:
        'Destructive sync is disabled because SYNCLISTIC_OPERATOR_EMAIL is not in SYNCLISTIC_INTERNAL_TEST_USER_EMAILS.'
    };
  }

  if (!normalizeStoreRecord(destinationStore)?.is_test_store) {
    return {
      ok: false,
      code: 'destination_not_test_store',
      message:
        'Destructive sync is only allowed when the destination store is explicitly marked as a test store.'
    };
  }

  return {
    ok: true,
    config
  };
}

module.exports = {
  evaluateDestructiveSyncAccess,
  getInternalTestModeConfig,
  normalizeStoreRecord
};
