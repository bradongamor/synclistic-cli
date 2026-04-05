const fs = require('fs').promises;
const os = require('os');
const path = require('path');

function getConfigDir() {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;

  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'synclistic'
    );
  }

  return path.join(xdgConfigHome || path.join(os.homedir(), '.config'), 'synclistic');
}

const CONFIG_DIR = getConfigDir();
const STORES_FILE = path.join(CONFIG_DIR, 'stores.json');

function createJsonStorePersistence(deps = {}) {
  const fsPromises = deps.fs || fs;

  async function ensureConfigDir() {
    try {
      await fsPromises.mkdir(CONFIG_DIR, { mode: 0o700, recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  return {
    async load() {
      try {
        await ensureConfigDir();
        const data = await fsPromises.readFile(STORES_FILE, 'utf8');
        return JSON.parse(data).stores;
      } catch (error) {
        if (error.code === 'ENOENT') {
          return [];
        }

        throw error;
      }
    },

    async save(stores) {
      await ensureConfigDir();
      const data = JSON.stringify({ stores }, null, 2);
      await fsPromises.writeFile(STORES_FILE, data, {
        mode: 0o600,
        encoding: 'utf8'
      });
    }
  };
}

module.exports = {
  CONFIG_DIR,
  STORES_FILE,
  createJsonStorePersistence
};
