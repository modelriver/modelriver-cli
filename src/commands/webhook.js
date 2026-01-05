const fs = require('fs');
const ApiClient = require('../lib/api-client');
const WebhookVerifier = require('../lib/webhook-verifier');
const Logger = require('../utils/logger');
const Formatter = require('../utils/formatter');

async function createWebhook(options) {
  const { url, description, secret, apiKey, apiUrl } = options;

  if (!url) {
    Logger.error('Error: --url is required');
    process.exit(1);
  }

  try {
    const apiClient = new ApiClient(apiKey, apiUrl);
    const spinner = Logger.spinner('Creating webhook...');
    spinner.start();

    const webhookData = { url };
    if (description) webhookData.description = description;
    if (secret) webhookData.secret = secret;

    const response = await apiClient.createWebhook(webhookData);

    spinner.succeed('Webhook created');
    Logger.success(`\n> Webhook ID: ${response.id}`);
    Logger.success(`> URL: ${response.url}`);
    Logger.warning(`> Secret: ${response.secret}`);
    Logger.warning('> Save this secret - it won\'t be shown again!');

  } catch (error) {
    Logger.error(error.response?.data?.error || error.message);
    if (error.response?.data?.details) {
      Logger.error(`Details: ${error.response.data.details}`);
    }
    process.exit(1);
  }
}

async function listWebhooks(options) {
  const { verbose, apiKey, apiUrl } = options;

  try {
    const apiClient = new ApiClient(apiKey, apiUrl);
    const spinner = Logger.spinner('Fetching webhooks...');
    spinner.start();

    const webhooks = await apiClient.listWebhooks();

    spinner.succeed(`Found ${webhooks.length} webhook(s)`);

    if (webhooks.length === 0) {
      Logger.info('\n> No webhooks found');
      return;
    }

    if (verbose) {
      Logger.section('\nWebhooks');
      webhooks.forEach((webhook, index) => {
        console.log(`\n${index + 1}. ${webhook.id}`);
        console.log(`   URL: ${webhook.url}`);
        console.log(`   Description: ${webhook.description || 'N/A'}`);
        console.log(`   Enabled: ${webhook.enabled ? 'Yes' : 'No'}`);
        console.log(`   Created: ${new Date(webhook.inserted_at).toISOString()}`);
      });
    } else {
      const headers = ['ID', 'URL', 'Description', 'Enabled'];
      const rows = webhooks.map(w => [
        w.id.substring(0, 8) + '...',
        w.url.length > 40 ? w.url.substring(0, 37) + '...' : w.url,
        w.description || 'N/A',
        w.enabled ? 'Yes' : 'No'
      ]);
      console.log('\n' + Formatter.table(headers, rows));
    }

  } catch (error) {
    Logger.error(error.response?.data?.error || error.message);
    if (error.response?.data?.details) {
      Logger.error(`Details: ${error.response.data.details}`);
    }
    process.exit(1);
  }
}

async function verifyWebhook(options) {
  const { payload, signature, timestamp, secret } = options;

  if (!payload || !signature || !timestamp || !secret) {
    Logger.error('Error: --payload, --signature, --timestamp, and --secret are all required');
    process.exit(1);
  }

  try {
    // Read payload from file or use as JSON string
    let payloadData;
    if (fs.existsSync(payload)) {
      const content = fs.readFileSync(payload, 'utf8');
      payloadData = JSON.parse(content);
    } else {
      payloadData = JSON.parse(payload);
    }

    // Extract data from payload (webhook format)
    const webhookData = payloadData.data || payloadData;

    // Verify signature
    const isValid = WebhookVerifier.verify(
      signature,
      webhookData,
      secret,
      timestamp
    );

    if (isValid) {
      Logger.success('✓ Signature is valid');
      process.exit(0);
    } else {
      Logger.error('✗ Signature is invalid');
      process.exit(1);
    }

  } catch (error) {
    Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  createWebhook,
  listWebhooks,
  verifyWebhook
};


