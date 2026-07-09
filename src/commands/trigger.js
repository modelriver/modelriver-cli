const ApiClient = require('../lib/api-client');
const Logger = require('../utils/logger');
const Formatter = require('../utils/formatter');

async function triggerCommand(options) {
  const { workflow, message, payload, webhookUrl, apiKey, apiUrl, printChannel } = options;

  if (!workflow && !payload) {
    Logger.error('Error: --workflow or --payload is required');
    process.exit(1);
  }

  try {
    const apiClient = new ApiClient(apiKey, apiUrl);

    const spinner = Logger.spinner('Sending async request...');
    spinner.start();

    const requestPayload = payload
      ? JSON.parse(payload)
      : {
          workflow,
          messages: [{ role: 'user', content: message || 'Test from CLI' }]
        };

    // Allow --workflow with --payload when payload omits workflow
    if (workflow && !requestPayload.workflow) {
      requestPayload.workflow = workflow;
    }

    if (!requestPayload.workflow) {
      spinner.fail('Workflow required');
      Logger.error('Provide --workflow or include "workflow" in --payload JSON');
      process.exit(1);
    }

    const response = await apiClient.createAsyncRequest(requestPayload);

    spinner.succeed('Async request created');

    if (printChannel || !webhookUrl) {
      Logger.section('Channel Details');
      console.log(Formatter.json({
        channel_id: response.channel_id,
        project_id: response.project_id,
        websocket_url: response.websocket_url,
        websocket_channel: response.websocket_channel,
        status: response.status
      }));
    }

    if (webhookUrl) {
      Logger.section('Creating Webhook');
      const webhookSpinner = Logger.spinner('Creating webhook...');
      webhookSpinner.start();

      try {
        const webhookResponse = await apiClient.createWebhook({
          url: webhookUrl,
          description: 'CLI test webhook'
        });

        webhookSpinner.succeed('Webhook created');
        Logger.success(`\n> Webhook ID: ${webhookResponse.id}`);
        Logger.warning(`> Secret: ${webhookResponse.secret}`);
        Logger.warning('> Save this secret - it won\'t be shown again!');
        Logger.info(`\n> Response will be sent to: ${webhookUrl}`);
      } catch (error) {
        webhookSpinner.fail('Failed to create webhook');
        Logger.error(error.response?.data?.error || error.message);
      }
    } else {
      Logger.info('\n> Use --webhook-url to automatically receive responses via webhook');
      Logger.info('> Or use "modelriver websocket" to connect and receive responses');
      Logger.info('> For event-driven workflows, complete with: modelriver callback --channel-id <id> --data \'{...}\'');
    }

  } catch (error) {
    Logger.error(error.response?.data?.error || error.message);
    if (error.response?.data?.details) {
      Logger.error(`Details: ${error.response.data.details}`);
    }
    process.exit(1);
  }
}

module.exports = { triggerCommand };


