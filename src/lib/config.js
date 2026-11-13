const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
// Keys a .modelriverrc in the current directory may not set. A checked-out
// repository could otherwise send your API key to a server of its choosing.
const LOCAL_RC_FORBIDDEN_KEYS = ['api_url', 'api-url'];

class Config {
  constructor() {
    this.configFile = this.findConfigFile();
    this.config = this.loadConfig();
  }

  findConfigFile() {
    // Check for .modelriverrc in current directory
    const localRc = this.getLocalRcPath();
    if (fs.existsSync(localRc)) {
      return localRc;
    }

    // Check for ~/.modelriver/config.json
    const homeConfig = path.join(os.homedir(), '.modelriver', 'config.json');
    if (fs.existsSync(homeConfig)) {
      return homeConfig;
    }

    return null;
  }

  loadConfig() {
    if (!this.configFile) {
      return {};
    }

    let loaded;
    try {
      const content = fs.readFileSync(this.configFile, 'utf8');
      loaded = JSON.parse(content);
    } catch (error) {
      return {};
    }
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
      return {};
    }

    if (this.configFile === this.getLocalRcPath()) {
      const ignored = LOCAL_RC_FORBIDDEN_KEYS.filter((key) => key in loaded);
      if (ignored.length > 0) {
        for (const key of ignored) delete loaded[key];
        this.ignoredLocalKeys = ignored;
        console.warn(
          `⚠ Ignoring ${ignored.join(', ')} in ${this.configFile}: a .modelriverrc in the current ` +
          'directory may not change the API URL. Use --api-url or MODELRIVER_API_URL instead.'
        );
      }
    }

    return loaded;
  }

  getLocalRcPath() {
    return path.join(process.cwd(), '.modelriverrc');
  }

  get(key, defaultValue = null) {
    // Priority: env var > config file > default
    const envKey = `MODELRIVER_${key.toUpperCase().replace(/-/g, '_')}`;

    if (process.env[envKey]) {
      return process.env[envKey].trim();
    }

    const configKey = key.replace(/-/g, '_');
    if (typeof this.config[configKey] === 'string' && this.config[configKey]) {
      return this.config[configKey].trim();
    }

    return defaultValue;
  }

  getApiKey() {
    return this.get('api-key') || this.get('api_key');
  }

  getProjectId() {
    return this.get('project-id') || this.get('project_id');
  }

  getApiUrl() {
    return this.get('api-url', 'https://api.modelriver.com') || this.get('api_url', 'https://api.modelriver.com');
  }

  getForwardUrl() {
    return this.get('forward-url') || this.get('forward_url');
  }

  getWebSocketUrl() {
    const apiUrl = this.getApiUrl();
    // Convert http:// to ws:// and https:// to wss://
    if (apiUrl.startsWith('https://')) {
      return apiUrl.replace('https://', 'wss://');
    }
    return apiUrl.replace('http://', 'ws://');
  }

  /**
   * Get the path to the home config file
   * @returns {string} - Path to ~/.modelriver/config.json
   */
  getHomeConfigPath() {
    return path.join(os.homedir(), '.modelriver', 'config.json');
  }

  /**
   * Save configuration to ~/.modelriver/config.json
   * @param {object} configData - Configuration object to save
   */
  saveConfig(configData) {
    const configDir = path.join(os.homedir(), '.modelriver');
    const configPath = this.getHomeConfigPath();

    // The folder is readable only by you (0700), the file too (0600).
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: CONFIG_DIR_MODE });
    }
    fs.chmodSync(configDir, CONFIG_DIR_MODE);

    // Load existing config and merge
    let existingConfig = {};
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf8');
        existingConfig = JSON.parse(content);
      } catch (error) {
        // Ignore parse errors, start fresh
      }
    }

    // Merge with new config data
    const mergedConfig = { ...existingConfig, ...configData };

    // Write a new file with mode 0600 and move it into place, so the API key
    // is never in a file other users can read, even for a moment.
    const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(mergedConfig, null, 2), { encoding: 'utf8', mode: CONFIG_FILE_MODE, flag: 'wx' });
      fs.chmodSync(tmpPath, CONFIG_FILE_MODE);
      fs.renameSync(tmpPath, configPath);
    } catch (error) {
      try { fs.unlinkSync(tmpPath); } catch (cleanupError) { /* already gone */ }
      throw error;
    }

    // Reload config
    this.configFile = configPath;
    this.config = mergedConfig;
  }

  /**
   * Save a single configuration value
   * @param {string} key - Configuration key
   * @param {string} value - Configuration value
   */
  save(key, value) {
    const configKey = key.replace(/-/g, '_');
    this.saveConfig({ [configKey]: value });
  }
}

module.exports = new Config();
module.exports.Config = Config;
module.exports.CONFIG_DIR_MODE = CONFIG_DIR_MODE;
module.exports.CONFIG_FILE_MODE = CONFIG_FILE_MODE;


