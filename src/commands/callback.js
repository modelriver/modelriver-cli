const ApiClient = require('../lib/api-client');
const Logger = require('../utils/logger');
const Formatter = require('../utils/formatter');

async function callbackCommand(options) {
  const {
    channelId,
    callbackUrl,
    data,
    taskId,
    metadata,
    payload,
    apiKey,
    apiUrl,
  } = options;

  if (!callbackUrl && !channelId) {
    Logger.error('Error: --channel-id or --callback-url is required');
    process.exit(1);
  }

  let body;

  try {
    if (payload) {
      body = JSON.parse(payload);
    } else {
      body = {};

      if (data) {
        body.data = typeof data === 'string' ? JSON.parse(data) : data;
      }

      if (taskId) {
        body.task_id = taskId;
      }

      if (metadata) {
        body.metadata =
          typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
      }
    }
  } catch (error) {
    Logger.error(`Invalid JSON: ${error.message}`);
    process.exit(1);
  }

  if (body.data !== undefined && (typeof body.data !== 'object' || Array.isArray(body.data))) {
    Logger.error('Error: "data" must be a JSON object');
    process.exit(1);
  }

  try {
    const apiClient = new ApiClient(apiKey, apiUrl);
    const targetUrl =
      callbackUrl ||
      `${apiClient.apiUrl}${apiClient.apiPath}/callback/${channelId}`;

    const spinner = Logger.spinner(`Sending callback to ${targetUrl}...`);
    spinner.start();

    const response = await apiClient.sendCallback(targetUrl, body);

    if (response.status >= 400) {
      spinner.fail('Callback failed');
      Logger.error(response.data?.error || response.data?.message || `HTTP ${response.status}`);
      if (response.data) {
        console.log(Formatter.json(response.data));
      }
      process.exit(1);
    }

    spinner.succeed('Callback accepted');
    console.log(Formatter.json(response.data));
  } catch (error) {
    Logger.error(error.message);
    process.exit(1);
  }
}

module.exports = { callbackCommand };
