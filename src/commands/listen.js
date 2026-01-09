const express = require('express');
const ApiClient = require('../lib/api-client');
const CLIWebSocketClient = require('../lib/cli-websocket-client');
const WebhookVerifier = require('../lib/webhook-verifier');
const Logger = require('../utils/logger');
const Formatter = require('../utils/formatter');

async function listenCommand(options) {
  let { apiKey, apiUrl, print, port, verbose, forward } = options;
  const forwardOnly = forward === true;

  const spinner = Logger.spinner('Setting up webhook forwarding...');
  spinner.start();

  let apiClient;
  let wsClient;
  let localPort = port || 3001;
  let webhookSecret = null;

  try {
    // Validate API key
    if (!apiKey) {
      const config = require('../lib/config');
      apiKey = config.getApiKey();
    }

    if (!apiKey) {
      spinner.fail('API key is required');
      Logger.error('API key is not set. Please set MODELRIVER_API_KEY environment variable or use --api-key flag.');

      // Check if this is localhost for better error message
      const isLocalhost = apiUrl && (
        apiUrl.includes('localhost') ||
        apiUrl.includes('127.0.0.1') ||
        apiUrl.includes('0.0.0.0')
      );

      if (isLocalhost) {
        Logger.warning('\n> Quick fix for localhost:');
        Logger.warning('> 1. Log in at http://localhost:4000');
        Logger.warning('> 2. Create a project if you don\'t have one');
        Logger.warning('> 3. Go to Project Settings > API Keys and create a new key');
        Logger.warning('> 4. Or run this script to create a test key:');
        Logger.warning('>    mix run scripts/create_test_api_key.exs USER_EMAIL');
        Logger.warning('> 5. Then set it:');
        Logger.warning('>    export MODELRIVER_API_KEY=your_key_here');
      } else {
        Logger.warning('\n> To fix this:');
        Logger.warning('> 1. Set MODELRIVER_API_KEY environment variable:');
        Logger.warning('>    export MODELRIVER_API_KEY=mr_live_YOUR_KEY');
        Logger.warning('> 2. Or use --api-key flag:');
        Logger.warning('>    modelriver listen --api-key mr_live_YOUR_KEY');
        Logger.warning('> 3. Get your API key from https://console.modelriver.com');
      }
      process.exit(1);
    }

    // Validate API key format
    if (!apiKey.startsWith('mr_live_') && !apiKey.startsWith('mr_test_')) {
      spinner.fail('Invalid API key format');
      Logger.error(`API key must start with "mr_live_" or "mr_test_". Got: ${apiKey.substring(0, 20)}...`);
      Logger.warning('> Make sure you copied the full API key from the dashboard');
      process.exit(1);
    }

    apiClient = new ApiClient(apiKey, apiUrl);

    // Debug: Show API key info if verbose
    if (verbose) {
      Logger.info(`> API URL: ${apiUrl}`);
      Logger.info(`> API Path: ${apiClient.apiPath}`);
      Logger.info(`> API Key (first 30 chars): ${apiKey.substring(0, 30)}...`);
    }

    // Step 1: Get CLI WebSocket token
    spinner.text = 'Connecting to ModelRiver...';

    const connectResponse = await apiClient.connectCLI();
    const { ws_token, websocket_url, user_id, channel } = connectResponse;

    spinner.text = 'Connecting to WebSocket...';

    // Step 2: Connect to WebSocket
    wsClient = new CLIWebSocketClient(websocket_url, ws_token, verbose || false);

    try {
      await wsClient.connect();
    } catch (error) {
      spinner.fail('WebSocket connection failed');
      Logger.error(error.message);
      process.exit(1);
    }

    spinner.text = 'Joining webhook channel...';

    // Step 3: Join CLI webhook channel
    try {
      await wsClient.joinChannel(channel);
    } catch (error) {
      spinner.fail('Failed to join channel');
      Logger.error(error.message);
      wsClient.close();
      process.exit(1);
    }

    // Step 4: Get webhook secret for signature verification
    // We'll use the first webhook's secret if available, or generate a default
    try {
      const webhooks = await apiClient.listWebhooks();
      if (webhooks.length > 0) {
        webhookSecret = webhooks[0].secret;
      }
    } catch (error) {
      // If we can't get webhook secret, we'll skip verification
      Logger.warning('Could not retrieve webhook secret for verification');
    }

    spinner.succeed('Webhook forwarding active');

    Logger.success('\n> Ready! ModelRiver webhook forwarding is active');
    Logger.info(`> User ID: ${user_id}`);
    Logger.info(`> Channel: ${channel}`);
    Logger.info(`> Local port: ${localPort}`);
    if (webhookSecret) {
      Logger.warning(`> Webhook secret: ${webhookSecret}`);
      Logger.warning('> Save this secret for webhook-test-server!\n');
    }
    Logger.warning('> Press Ctrl+C to stop forwarding\n');

    // Step 5: Start local Express server (only if not forwarding to external server)
    let server = null;
    if (!forwardOnly) {
      const app = express();
      app.use(express.json());

      app.post('*', (req, res) => {
        const signature = req.headers['x-modelriver-signature'];
        const timestamp = req.headers['x-modelriver-timestamp'];
        const webhookIdHeader = req.headers['x-modelriver-webhook-id'];

        const { channel_id, timestamp: payloadTimestamp, data } = req.body;

        // Verify signature if we have a secret
        let isValid = null;
        if (webhookSecret && signature && timestamp && data) {
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
          if (isValid !== null) {
            Logger.log(`  Signature: ${isValid ? '✓ Valid' : '✗ Invalid'}`);
          }
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

      server = app.listen(localPort, 'localhost', () => {
        Logger.success(`> Local server listening on http://localhost:${localPort}/webhook`);
      });
    } else {
      Logger.success(`> Forwarding webhooks to http://localhost:${localPort}/webhook`);
    }

    // Step 6: Listen for webhook events from WebSocket
    wsClient.onWebhook((webhookPayload) => {
      const { channel_id, timestamp, data, signature } = webhookPayload;

      if (print) {
        const timestampStr = Formatter.timestamp(new Date());
        Logger.log(`\n[${timestampStr}] Webhook received via WebSocket:`);
        Logger.log(`  Channel ID: ${channel_id || 'N/A'}`);
        Logger.log(`  Status: ${data?.status || 'N/A'}`);
        if (signature && webhookSecret) {
          const isValid = WebhookVerifier.verify(
            signature,
            data,
            webhookSecret,
            timestamp.toString()
          );
          Logger.log(`  Signature: ${isValid ? '✓ Valid' : '✗ Invalid'}`);
        }
        if (data?.data) {
          Logger.log(`  Data: ${Formatter.json(data.data)}`);
        }
        if (data?.meta) {
          Logger.log(`  Meta: ${Formatter.json(data.meta)}`);
        }
      }

      // Forward to local server
      const http = require('http');
      const postData = JSON.stringify({
        channel_id,
        timestamp,
        data
      });

      const options = {
        hostname: 'localhost',
        port: localPort,
        path: '/webhook',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'X-ModelRiver-Signature': signature || '',
          'X-ModelRiver-Timestamp': timestamp.toString(),
          'X-ModelRiver-Webhook-Id': webhookPayload.webhook_id || ''
        }
      };

      const req = http.request(options, (res) => {
        // Webhook forwarded successfully
        if (print) {
          Logger.info(`  → Forwarded to local server (status: ${res.statusCode})`);
        }
      });

      req.on('error', (error) => {
        Logger.error(`Failed to forward webhook to local server: ${error.message}`);
      });

      req.write(postData);
      req.end();
    });

    // Handle WebSocket close
    wsClient.onClose((code, reason) => {
      Logger.warning(`\n> WebSocket connection closed (code: ${code})`);
      if (reason) {
        Logger.warning(`> Reason: ${reason}`);
      }
    });

    // Cleanup on exit
    const cleanup = async () => {
      Logger.warning('\n\n> Cleaning up...');
      try {
        if (wsClient) {
          wsClient.close();
          Logger.info('> WebSocket connection closed');
        }
      } catch (error) {
        Logger.error(`> Failed to cleanup: ${error.message}`);
      }
      if (server) {
        server.close();
      }
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

  } catch (error) {
    spinner.fail('Failed to setup webhook forwarding');
    Logger.error(error.message);

    // Provide helpful error messages
    if (error.message.includes('API key is required')) {
      Logger.warning('\n> To fix this:');
      Logger.warning('> 1. Set MODELRIVER_API_KEY environment variable:');
      Logger.warning('>    export MODELRIVER_API_KEY=mr_live_YOUR_KEY');
      Logger.warning('> 2. Or use --api-key flag:');
      Logger.warning('>    modelriver listen --api-key mr_live_YOUR_KEY');
      Logger.warning('> 3. Create an API key in the ModelRiver dashboard if you don\'t have one');
    } else if (error.message.includes('Invalid API key format')) {
      Logger.warning('\n> API keys must start with "mr_live_" or "mr_test_"');
      Logger.warning('> Example: mr_live_abc123...');
    } else if (error.response?.status === 401) {
      Logger.warning('\n> Authentication failed. Possible causes:');
      Logger.warning('> 1. API key is invalid or revoked');
      Logger.warning('> 2. API key doesn\'t exist in the database');
      Logger.warning('> 3. API key format is incorrect');
      Logger.warning('> Check your API key in the ModelRiver dashboard');
    } else if (error.response?.status === 403) {
      Logger.warning('\n> Access forbidden. Possible causes:');
      Logger.warning('> 1. Backend code not deployed (if testing against production)');
      Logger.warning('> 2. Route not available on this server');
      Logger.warning('> 3. Server needs to be restarted to load new routes');
    }

    if (error.response?.data) {
      Logger.error(`\nServer response: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    if (error.response?.status) {
      Logger.error(`HTTP Status: ${error.response.status}`);
    }
    if (wsClient) {
      wsClient.close();
    }
    process.exit(1);
  }
}

module.exports = { listenCommand };


