const axios = require('axios');
const config = require('./config');
const { checkApiUrl } = require('../utils/url-helpers');

function createAuthHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

class ApiClient {
  constructor(apiKey = null, apiUrl = null) {
    this.apiKey = apiKey || config.getApiKey();
    if (!this.apiKey) {
      throw new Error('API key is required. Set MODELRIVER_API_KEY env var or use --api-key flag.');
    }

    // Validate API key format
    if (!this.apiKey.startsWith('mr_live_') && !this.apiKey.startsWith('mr_test_')) {
      throw new Error('Invalid API key format. API keys must start with "mr_live_" or "mr_test_".');
    }

    // Throws unless the URL is https (http is allowed only for localhost).
    this.apiUrl = checkApiUrl(apiUrl || config.getApiUrl());

    // Determine API path: /v1 in production (api.modelriver.com), /api/v1 in dev/test
    try {
      const apiUrlObj = new URL(this.apiUrl);
      const isProduction = apiUrlObj.hostname === 'api.modelriver.com' ||
        apiUrlObj.hostname.endsWith('.modelriver.com');
      this.apiPath = isProduction ? '/v1' : '/api/v1';
    } catch (e) {
      // Fallback to dev path if URL parsing fails
      this.apiPath = '/api/v1';
    }

    this.client = axios.create({
      baseURL: this.apiUrl,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      validateStatus: function (status) {
        return status < 500; // Don't throw on 4xx errors, we'll handle them
      }
    });
  }


  /**
   * Create async AI request
   * @param {object} payload - Request payload {workflow, messages, format?}
   * @returns {Promise<object>} - Response with channel_id, ws_token, etc.
   */
  async createAsyncRequest(payload) {
    const response = await this.client.post(`${this.apiPath}/ai/async`, payload);

    // Check for error status codes
    if (response.status >= 400) {
      const error = new Error(`Request failed with status ${response.status}`);
      error.response = response;
      throw error;
    }

    return response.data;
  }

  /**
   * Get reconnect token for existing channel
   * @param {string} channelId - Channel ID
   * @returns {Promise<object>} - Response with ws_token
   */
  async reconnectAsync(channelId) {
    const response = await this.client.post(`${this.apiPath}/ai/reconnect`, {
      channel_id: channelId
    });
    return response.data;
  }

  /**
   * List all webhooks for the project
   * @returns {Promise<Array>} - Array of webhook objects
   */
  async listWebhooks() {
    const response = await this.client.get(`${this.apiPath}/webhooks`);
    return response.data.webhooks || [];
  }

  /**
   * Get a specific webhook
   * @param {string} webhookId - Webhook ID
   * @returns {Promise<object>} - Webhook object
   */
  async getWebhook(webhookId) {
    const response = await this.client.get(`${this.apiPath}/webhooks/${webhookId}`);
    return response.data;
  }

  /**
   * Create a new webhook
   * @param {object} webhook - {url, description?, secret?}
   * @returns {Promise<object>} - Created webhook with secret
   */
  async createWebhook(webhook) {
    const response = await this.client.post(`${this.apiPath}/webhooks`, webhook);
    return response.data;
  }

  /**
   * Update a webhook
   * @param {string} webhookId - Webhook ID
   * @param {object} updates - {url?, description?, enabled?, secret?}
   * @returns {Promise<object>} - Updated webhook
   */
  async updateWebhook(webhookId, updates) {
    const response = await this.client.put(`${this.apiPath}/webhooks/${webhookId}`, updates);
    return response.data;
  }

  /**
   * Delete a webhook
   * @param {string} webhookId - Webhook ID
   * @returns {Promise<void>}
   */
  async deleteWebhook(webhookId) {
    await this.client.delete(`${this.apiPath}/webhooks/${webhookId}`);
  }

  /**
   * Connect CLI and get WebSocket token
   * @returns {Promise<object>} - {ws_token, websocket_url, project_id, user_id, channel}
   */
  async connectCLI() {
    try {
      const url = `${this.apiPath}/cli/connect`;
      
      if (process.env.DEBUG || this.verbose) {
        console.log('[DEBUG] Making request to:', `${this.apiUrl}${url}`);
      }

      const response = await this.client.post(url, {});
      
      if (response.status >= 400) {
        const errorMsg = response.data?.error || response.data?.message || `HTTP ${response.status}`;
        const error = new Error(`Failed to connect CLI: ${errorMsg}`);
        error.response = response;
        throw error;
      }

      return response.data;
    } catch (error) {
      // Handle network errors or axios errors
      if (error.response) {
        // Server responded with error
        const errorMsg = error.response.data?.error || error.response.data?.message || `HTTP ${error.response.status}`;
        const newError = new Error(`Failed to connect CLI: ${errorMsg}`);
        newError.response = error.response;
        throw newError;
      } else if (error.request) {
        // Request was made but no response received
        throw new Error(`Failed to connect CLI: No response from server. Is the backend running?`);
      } else {
        // Something else happened
        throw new Error(`Failed to connect CLI: ${error.message}`);
      }
    }
  }

  /**
   * Open a CLI tool session. Tool calls for this session are sent to the CLI
   * over the WebSocket channel the response names.
   * @returns {Promise<object>} - {session_id (the cts_ token), channel, expires_at, project_id}
   */
  async createToolSession() {
    const url = `${this.apiPath}/cli/tool-sessions`;
    let response;
    try {
      response = await this.client.post(url, {});
    } catch (error) {
      if (error.response) {
        response = error.response;
      } else if (error.request) {
        throw new Error('Failed to open tool session: No response from server. Is the backend running?');
      } else {
        throw new Error(`Failed to open tool session: ${error.message}`);
      }
    }

    if (response.status >= 400) {
      const errorMsg = response.data?.message || response.data?.error?.message || response.data?.error || `HTTP ${response.status}`;
      const error = new Error(`Failed to open tool session: ${typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg)}`);
      error.response = response;
      throw error;
    }

    const data = response.data || {};
    if (typeof data.session_id !== 'string' || !data.session_id) {
      throw new Error('Failed to open tool session: the server did not return a session_id');
    }
    if (typeof data.channel !== 'string' || !data.channel.startsWith('cli_tools:')) {
      throw new Error('Failed to open tool session: the server did not return a cli_tools channel');
    }
    return data;
  }

  /**
   * Is this URL on the configured API host (same scheme, host and port)?
   * @param {string} url
   * @returns {boolean}
   */
  isApiOrigin(url) {
    try {
      return new URL(url).origin === new URL(this.apiUrl).origin;
    } catch (error) {
      return false;
    }
  }

  /**
   * Send an event-driven callback to complete a pending channel.
   * @param {string} callbackUrl - Full callback URL from webhook payload
   * @param {object} body - Callback payload { data?, task_id?, metadata? }
   * @returns {Promise<object>} - Axios-like response { status, data }
   */
  async sendCallback(callbackUrl, body) {
    // The API key goes only to the configured API host, never to a URL taken
    // from a webhook payload that points somewhere else.
    if (!this.isApiOrigin(callbackUrl)) {
      let origin = callbackUrl;
      try { origin = new URL(callbackUrl).origin; } catch (error) { /* keep as given */ }
      throw new Error(
        `Refusing to send your API key to ${origin}: callback URLs must be on the configured API host (${new URL(this.apiUrl).origin}). ` +
        'Use --channel-id, or set --api-url to match.'
      );
    }

    const response = await axios.post(callbackUrl, body, {
      headers: createAuthHeaders(this.apiKey),
      maxRedirects: 0,
      validateStatus: (status) => status < 500,
    });

    return response;
  }
}

module.exports = ApiClient;


