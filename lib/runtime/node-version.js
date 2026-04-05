const MINIMUM_NODE_MAJOR = 20;

function getNodeMajor(version = process.versions.node) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  return Number.isInteger(major) ? major : null;
}

function isSupportedNodeVersion(version = process.versions.node) {
  const major = getNodeMajor(version);
  return major !== null && major >= MINIMUM_NODE_MAJOR;
}

function getUnsupportedNodeVersionMessage(version = process.versions.node) {
  return `Synclistic CLI requires Node.js ${MINIMUM_NODE_MAJOR} or newer. Current version: ${version}.`;
}

function ensureSupportedNodeVersion(deps = {}) {
  const version = deps.version || process.versions.node;
  const stderr = deps.stderr || process.stderr;

  if (isSupportedNodeVersion(version)) {
    return true;
  }

  stderr.write(`${getUnsupportedNodeVersionMessage(version)}\n`);
  return false;
}

module.exports = {
  MINIMUM_NODE_MAJOR,
  ensureSupportedNodeVersion,
  getNodeMajor,
  getUnsupportedNodeVersionMessage,
  isSupportedNodeVersion
};
