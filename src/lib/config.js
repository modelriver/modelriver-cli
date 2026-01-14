const fs = require('fs');
const path = require('path');
const os = require('os');

class Config {
  constructor() {
    this.configFile = this.findConfigFile();
    this.config = this.loadConfig();
  }

  findConfigFile() {
    // Check for .modelriverrc in current directory
    const localRc = path.join(process.cwd(), '.modelriverrc');
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

    try {
      const content = fs.readFileSync(this.configFile, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      return {};
    }
  }

  get(key, defaultValue = null) {
    // Priority: env var > config file > default
    const envKey = `MODELRIVER_${key.toUpperCase().replace(/-/g, '_')}`;

    if (process.env[envKey]) {
      return process.env[envKey].trim();
    }

    const configKey = key.replace(/-/g, '_');
    if (this.config[configKey]) {
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

    // Create directory if it doesn't exist
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

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

    // Write to file
    fs.writeFileSync(configPath, JSON.stringify(mergedConfig, null, 2), 'utf8');

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


