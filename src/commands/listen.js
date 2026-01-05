const express = require('express');
const ApiClient = require('../lib/api-client');
const WebhookVerifier = require('../lib/webhook-verifier');
const Logger = require('../utils/logger');
const Formatter = require('../utils/formatter');

async function listenCommand(options) {
  const { forwardTo, apiKey, apiUrl, print } = options;

  if (!forwardTo) {
    Logger.error('Error: --forward-to is required');
    process.exit(1);
  }

  // Validate forwardTo URL
  try {
    new URL(forwardTo);
  } catch (error) {
    Logger.error('Error: --forward-to must be a valid URL');
    process.exit(1);
  }

  const spinner = Logger.spinner('Setting up webhook forwarding...');
  spinner.start();

  let apiClient;
  let webhookId;
  let webhookSecret;

  try {
    apiClient = new ApiClient(apiKey, apiUrl);

    // Create temporary webhook
    const webhookResponse = await apiClient.createWebhook({
      url: forwardTo,
      description: 'CLI temporary webhook (auto-created)'
    });

    webhookId = webhookResponse.id;
    webhookSecret = webhookResponse.secret;

    spinner.succeed('Webhook forwarding active');
    
    Logger.success('\n> Ready! ModelRiver webhook forwarding is active');
    Logger.info(`> Webhook ID: ${webhookId}`);
    Logger.info(`> Forwarding to: ${forwardTo}`);
    Logger.warning('\n> Press Ctrl+C to stop forwarding\n');

    // Start local Express server to receive and forward webhooks
    const app = express();
    app.use(express.json());

    app.post('*', (req, res) => {
      const signature = req.headers['x-modelriver-signature'];
      const timestamp = req.headers['x-modelriver-timestamp'];
      const webhookIdHeader = req.headers['x-modelriver-webhook-id'];

      const { channel_id, timestamp: payloadTimestamp, data } = req.body;

      // Verify signature
      let isValid = false;
      if (signature && timestamp && data) {
        isValid = WebhookVerifier.verify(
          signature,
          data,
          webhookSecret,
          timestamp
        );
      }

      if (print) {
        const timestampStr = Formatter.timestamp(new Date());
        Logger.log(`\n[${timestampStr}] Webhook received:`);
        Logger.log(`  Channel ID: ${channel_id || 'N/A'}`);
        Logger.log(`  Status: ${data?.status || 'N/A'}`);
        Logger.log(`  Signature: ${isValid ? '✓ Valid' : '✗ Invalid'}`);
        if (data?.data) {
          Logger.log(`  Data: ${Formatter.json(data.data)}`);
        }
        if (data?.meta) {
          Logger.log(`  Meta: ${Formatter.json(data.meta)}`);
        }
      }

      // Always return 200 to acknowledge receipt
      res.status(200).json({ received: true, verified: isValid });
    });

    const forwardUrl = new URL(forwardTo);
    const port = forwardUrl.port || (forwardUrl.protocol === 'https:' ? 443 : 80);
    const host = forwardUrl.hostname;

    // For local forwarding, we'll start a server on the specified port
    // If it's a remote URL, we just log that webhooks will be sent there
    if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.')) {
      // Local server
      const server = app.listen(port, host, () => {
        Logger.success(`> Local server listening on ${forwardTo}`);
      });

      // Cleanup on exit
      const cleanup = async () => {
        Logger.warning('\n\n> Cleaning up...');
        try {
          await apiClient.deleteWebhook(webhookId);
          Logger.success('> Webhook removed');
        } catch (error) {
          Logger.error(`> Failed to remove webhook: ${error.message}`);
          Logger.warning('> You may need to delete it manually from the dashboard');
        }
        server.close();
        process.exit(0);
      };

      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
    } else {
      // Remote URL - just log that webhooks will be sent there
      Logger.info(`> Webhooks will be sent to: ${forwardTo}`);
      Logger.warning('\n> Note: Make sure the remote server is accessible and can receive POST requests');
      
      const cleanup = async () => {
        Logger.warning('\n\n> Cleaning up...');
        try {
          await apiClient.deleteWebhook(webhookId);
          Logger.success('> Webhook removed');
        } catch (error) {
          Logger.error(`> Failed to remove webhook: ${error.message}`);
          Logger.warning('> You may need to delete it manually from the dashboard');
        }
        process.exit(0);
      };

      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
    }

  } catch (error) {
    spinner.fail('Failed to setup webhook forwarding');
    Logger.error(error.response?.data?.error || error.message);
    if (error.response?.data?.details) {
      Logger.error(`Details: ${error.response.data.details}`);
    }
    process.exit(1);
  }
}

module.exports = { listenCommand };


