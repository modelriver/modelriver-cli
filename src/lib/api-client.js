const axios = require('axios');
const config = require('./config');

class ApiClient {
  constructor(apiKey = null, apiUrl = null) {
    this.apiKey = apiKey || config.getApiKey();
    this.apiUrl = (apiUrl || config.getApiUrl()).replace(/\/$/, '');

    if (!this.apiKey) {
      throw new Error('API key is required. Set MODELRIVER_API_KEY env var or use --api-key flag.');
    }

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
}

module.exports = ApiClient;


