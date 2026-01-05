const http = require('http');
const ApiClient = require('../lib/api-client');
const WebhookVerifier = require('../lib/webhook-verifier');
const Logger = require('../utils/logger');
const Formatter = require('../utils/formatter');

async function testWebhookCommand(options) {
  const { workflow, message, payload, webhookSecret, port, verbose, apiKey, apiUrl, webhookUrl } = options;

  let server;
  let webhookId;
  let receivedWebhook = null;
  let webhookPromiseResolver;
  let apiClient;

  const webhookPromise = new Promise((resolve) => {
    webhookPromiseResolver = resolve;
  });

  const cleanup = async () => {
    if (server) {
      server.close();
    }
    if (webhookId && apiClient) {
      try {
        await apiClient.deleteWebhook(webhookId);
        if (verbose) {
          Logger.info('> Cleaned up webhook');
        }
      } catch (error) {
        // Ignore cleanup errors
        if (verbose) {
          Logger.warning(`> Warning: Failed to cleanup webhook: ${error.message}`);
        }
      }
    }
  };

  process.on('SIGINT', async () => {
    Logger.warning('\n\n> Interrupted. Cleaning up...');
    await cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });

  try {
    apiClient = new ApiClient(apiKey, apiUrl);

    // Determine webhook URL - use provided URL or create local server
    const serverPort = port || 3001;
    let finalWebhookUrl = webhookUrl;
    let isNgrokUrl = false;

    // Check if provided URL is ngrok (for local server mode with ngrok)
    if (finalWebhookUrl) {
      try {
        const urlObj = new URL(finalWebhookUrl);
        // Detect ngrok URLs (ngrok.io, ngrok-free.app, ngrok-free.dev domains)
        isNgrokUrl = urlObj.hostname.includes('ngrok.io') || 
                     urlObj.hostname.includes('ngrok-free.app') || 
                     urlObj.hostname.includes('ngrok-free.dev');
        
        // If it's ngrok, extract the port from the path or use default
        // ngrok forwards to localhost, so we need to start a local server
        if (isNgrokUrl) {
          // Extract port from URL path if specified (e.g., ngrok.io:8080 -> 8080)
          // Otherwise use default port
          Logger.info(`\n🔗 Detected ngrok URL - will start local server to receive webhooks`);
        }
      } catch (e) {
        // Invalid URL, will be caught later
      }
    }

    if (!finalWebhookUrl || isNgrokUrl) {
      // No URL provided OR ngrok URL provided - start local server
      // Start local HTTP server to receive webhooks
      server = http.createServer((req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', chunk => {
            body += chunk.toString();
          });
          req.on('end', () => {
            try {
              const webhookPayload = JSON.parse(body);
              const signature = req.headers['x-modelriver-signature'];
              const timestamp = req.headers['x-modelriver-timestamp'];
              const webhookIdHeader = req.headers['x-modelriver-webhook-id'];

              // Verify signature if secret provided
              let signatureValid = null;
              if (webhookSecret && signature && timestamp) {
                signatureValid = WebhookVerifier.verify(
                  signature,
                  webhookPayload.data,
                  webhookSecret,
                  timestamp
                );
              }

              if (verbose) {
                Logger.info(`\n📨 Webhook received:`);
                Logger.info(`   Webhook ID: ${webhookIdHeader}`);
                Logger.info(`   Channel ID: ${webhookPayload.channel_id}`);
                Logger.info(`   Signature: ${signatureValid === null ? 'Not verified' : (signatureValid ? '✓ Valid' : '✗ Invalid')}`);
              }

              receivedWebhook = {
                headers: {
                  signature,
                  timestamp,
                  webhookId: webhookIdHeader
                },
                payload: webhookPayload,
                signatureValid
              };

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ received: true }));

              if (webhookPromiseResolver) {
                webhookPromiseResolver(receivedWebhook);
              }
            } catch (error) {
              Logger.error(`Error processing webhook: ${error.message}`);
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid payload' }));
            }
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise((resolve, reject) => {
        server.listen(serverPort, '127.0.0.1', (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      // Set finalWebhookUrl - keep ngrok URL if provided, otherwise use localhost
      if (isNgrokUrl) {
        // ngrok URL provided - keep it, server will receive webhooks forwarded by ngrok
        Logger.success(`\n✅ Local webhook server listening on http://localhost:${serverPort}/webhook`);
        Logger.info(`📡 Webhooks will be received via ngrok: ${finalWebhookUrl}`);
        Logger.info(`   Make sure ngrok is running and forwarding to port ${serverPort}\n`);
      } else {
        // No URL provided - use localhost
        finalWebhookUrl = `http://localhost:${serverPort}/webhook`;
        
        Logger.success(`\n✅ Local webhook server listening on http://localhost:${serverPort}/webhook`);
        Logger.warning('\n⚠️  IMPORTANT: For production testing, expose this server using ngrok:');
        Logger.warning(`   1. In another terminal, run: ngrok http ${serverPort}`);
        Logger.warning('   2. Copy the ngrok HTTPS URL (e.g., https://abc123.ngrok.io)');
        Logger.warning('   3. Stop this command (Ctrl+C) and run again with:');
        Logger.warning(`      --webhook-url https://your-ngrok-url.ngrok.io/webhook\n`);
        Logger.warning('   Alternatively, use an external service like webhook.site:\n');
        Logger.warning(`      --webhook-url https://webhook.site/your-unique-id\n`);
      }
    }

    // Create webhook pointing to the URL
    const spinner = Logger.spinner('Creating webhook...');
    spinner.start();

    try {
      const webhookData = { url: finalWebhookUrl };
      if (webhookSecret) webhookData.secret = webhookSecret;

      const webhookResponse = await apiClient.createWebhook({
        ...webhookData,
        description: 'CLI test webhook (auto-created)'
      });

      webhookId = webhookResponse.id;
      const actualSecret = webhookResponse.secret;
      
      spinner.succeed('Webhook created');
      Logger.info(`\n> Webhook ID: ${webhookId}`);
      Logger.info(`> URL: ${finalWebhookUrl}`);
      if (actualSecret) {
        Logger.warning(`> Secret: ${actualSecret}`);
        Logger.warning('> Save this secret - it won\'t be shown again!');
        if (!webhookSecret) {
          Logger.info('\n💡 Tip: Use --secret next time to set a custom secret');
        }
      }

      // Make async request
      const requestSpinner = Logger.spinner('Making async request...');
      requestSpinner.start();

      const requestPayload = payload
        ? JSON.parse(payload)
        : {
            workflow,
            messages: [{ role: 'user', content: message || 'Test webhook from CLI' }]
          };

      if (verbose) {
        Logger.info(`\n> API URL: ${apiClient.apiUrl}`);
        Logger.info(`> Workflow: ${workflow}`);
        Logger.info(`> Payload: ${JSON.stringify(requestPayload, null, 2)}`);
      }

      const asyncResponse = await apiClient.createAsyncRequest(requestPayload);
      requestSpinner.succeed(`Request queued: ${asyncResponse.channel_id}`);
      
      Logger.info(`\n> Channel ID: ${asyncResponse.channel_id}`);
      Logger.info(`> Project ID: ${asyncResponse.project_id}`);
      
      if (server) {
        Logger.info(`\n⏳ Waiting for webhook on local server (timeout: 5 minutes)...`);
        
        // Wait for webhook (with timeout) - only if we have a local server
        const timeoutId = setTimeout(() => {
          Logger.error('\n❌ Timeout: No webhook received after 5 minutes');
          Logger.error('   Possible causes:');
          Logger.error('   1. Workflow is still processing');
          Logger.error('   2. Webhook URL is not accessible from production server');
          Logger.error('   3. If using local server, make sure ngrok is running and webhook URL is correct');
          Logger.error('   4. Webhook delivery failed (check server logs)');
          cleanup();
          process.exit(1);
        }, 5 * 60 * 1000);

        const webhook = await webhookPromise;
        clearTimeout(timeoutId);

        // Display received webhook
        Logger.success('\n✅ Webhook received!\n');
        console.log(Formatter.json(webhook.payload.data));

        if (verbose) {
          if (webhook.signatureValid !== null) {
            Logger.info(`\n> Signature: ${webhook.signatureValid ? '✓ Valid' : '✗ Invalid'}`);
          }
          Logger.info(`> Received at: ${new Date().toISOString()}`);
          Logger.info(`> Webhook ID: ${webhook.headers.webhookId}`);
          Logger.info(`> Channel ID: ${webhook.payload.channel_id}`);
        }

        cleanup();
        process.exit(0);
      } else {
        // No local server - webhook URL was provided (external service)
        Logger.warning('\n⚠️  Webhook created with external URL');
        Logger.warning('   The webhook will be sent to the provided URL');
        Logger.warning('   Check your webhook endpoint to see the response');
        Logger.info(`\n> Webhook will be sent to: ${finalWebhookUrl}`);
        Logger.info(`> Channel ID: ${asyncResponse.channel_id}`);
        Logger.info('\n💡 Tip: Use without --webhook-url to start a local server that receives webhooks');
        cleanup();
        process.exit(0);
      }

    } catch (error) {
      spinner.fail('Failed to create webhook');
      if (error.response) {
        Logger.error(error.response.data?.error || error.message);
        if (error.response.data?.details) {
          Logger.error(`Details: ${error.response.data.details}`);
        }
      } else {
        Logger.error(error.message);
      }
      await cleanup();
      process.exit(1);
    }

  } catch (error) {
    Logger.error(error.message);
    await cleanup();
    process.exit(1);
  }
}

module.exports = { testWebhookCommand };

