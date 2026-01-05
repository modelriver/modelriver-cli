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
      return process.env[envKey];
    }

    const configKey = key.replace(/-/g, '_');
    if (this.config[configKey]) {
      return this.config[configKey];
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

  getWebSocketUrl() {
    const apiUrl = this.getApiUrl();
    // Convert http:// to ws:// and https:// to wss://
    if (apiUrl.startsWith('https://')) {
      return apiUrl.replace('https://', 'wss://');
    }
    return apiUrl.replace('http://', 'ws://');
  }
}

module.exports = new Config();


