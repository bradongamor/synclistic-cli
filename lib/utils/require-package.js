function requireWithFallback(requireFn, packageName, fallbackPath) {
  try {
    return requireFn(packageName);
  } catch (error) {
    if (
      error?.code !== 'MODULE_NOT_FOUND' ||
      !String(error.message || '').includes(`'${packageName}'`)
    ) {
      throw error;
    }

    return requireFn(fallbackPath);
  }
}

module.exports = {
  requireWithFallback
};
