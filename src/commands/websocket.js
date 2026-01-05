const ApiClient = require('../lib/api-client');
const WebSocketClient = require('../lib/websocket-client');
const config = require('../lib/config');
const Logger = require('../utils/logger');
const Formatter = require('../utils/formatter');

/**
 * Normalize WebSocket URL for production environments
 * Converts ws:// to wss:// for port 443 or production domains
 */
function normalizeWebSocketUrl(url) {
  if (!url) return url;

  try {
    // Handle URLs like 'ws://api.modelriver.com:443/socket'
    // Convert to 'wss://api.modelriver.com/socket'
    const wsUrl = new URL(url);

    // If port is 443, use wss:// and remove port
    if (wsUrl.port === '443') {
      wsUrl.protocol = 'wss:';
      wsUrl.port = ''; // Remove port for standard https
    }

    // If it's a production domain (ends with modelriver.com), ensure wss://
    if (wsUrl.hostname.endsWith('modelriver.com') && wsUrl.protocol === 'ws:') {
      wsUrl.protocol = 'wss:';
    }

    return wsUrl.toString().replace(/\/$/, ''); // Remove trailing slash
  } catch (e) {
    // If URL parsing fails, return original
    return url;
  }
}

async function websocketCommand(options) {
  const { workflow, message, payload, channelId, projectId, apiKey, apiUrl, verbose } = options;

  let wsToken, websocketChannel, websocketUrl, channelIdToUse, projectIdToUse;

  try {
    const apiClient = new ApiClient(apiKey, apiUrl);

    if (channelId && projectId) {
      // Connect to existing channel
      const spinner = Logger.spinner('Getting reconnect token...');
      spinner.start();

      try {
        const reconnectResponse = await apiClient.reconnectAsync(channelId);
        wsToken = reconnectResponse.ws_token;
        websocketChannel = reconnectResponse.websocket_channel;
        websocketUrl = normalizeWebSocketUrl(reconnectResponse.websocket_url || config.getWebSocketUrl());
        channelIdToUse = channelId;
        projectIdToUse = projectId;

        spinner.succeed(`Reconnect token obtained for channel ${channelId}`);
      } catch (error) {
        spinner.fail('Failed to get reconnect token');
        Logger.error(error.response?.data?.message || error.message);
        process.exit(1);
      }
    } else if (workflow) {
      // Make async request first
      const spinner = Logger.spinner('Making async request...');
      spinner.start();

      try {
        const requestPayload = payload
          ? JSON.parse(payload)
          : {
            workflow,
            messages: [{ role: 'user', content: message || 'Test from CLI' }]
          };

        if (verbose) {
          Logger.info(`\n> API URL: ${apiClient.apiUrl}`);
          Logger.info(`> Workflow: ${workflow}`);
          Logger.info(`> Payload: ${JSON.stringify(requestPayload, null, 2)}`);
        }

        const response = await apiClient.createAsyncRequest(requestPayload);

        wsToken = response.ws_token;
        websocketChannel = response.websocket_channel;
        websocketUrl = normalizeWebSocketUrl(response.websocket_url || config.getWebSocketUrl());
        channelIdToUse = response.channel_id;
        projectIdToUse = response.project_id;

        spinner.succeed(`Request queued: ${channelIdToUse}`);
        Logger.info(`\n> Channel ID: ${channelIdToUse}`);
        Logger.info(`> Project ID: ${projectIdToUse}`);
      } catch (error) {
        spinner.fail('Failed to create async request');

        if (error.response) {
          // HTTP error response
          const status = error.response.status;
          let data = error.response.data;

          // Handle case where response.data is a plain string
          if (typeof data === 'string') {
            data = { message: data };
          }

          Logger.error(`Request failed with status code ${status}`);

          // Log full response for debugging
          if (verbose) {
            Logger.info(`\nFull error response: ${JSON.stringify(data, null, 2)}`);
            Logger.info(`Response headers: ${JSON.stringify(error.response.headers, null, 2)}`);
          }

          if (data?.error) {
            Logger.error(`Error: ${data.error}`);
          }
          if (data?.message) {
            Logger.error(`Message: ${data.message}`);
          }
          if (data?.details) {
            Logger.error(`Details: ${data.details}`);
          }

          // If response is just "Forbidden" string, provide more context
          if (typeof error.response.data === 'string' && error.response.data === 'Forbidden') {
            Logger.warning('\nReceived plain "Forbidden" response - this may indicate:');
            Logger.warning('- Host header mismatch (API expects specific host)');
            Logger.warning('- Route not matching expected pattern');
            Logger.warning('- Middleware blocking the request');
          }

          if (status === 403) {
            Logger.warning('\nPossible causes:');
            Logger.warning('1. API key is invalid or revoked');
            Logger.warning('2. API key does not have access to this project');
            Logger.warning('3. Workflow does not exist or is not accessible');
            Logger.warning('4. API key does not have required providers enabled');
            Logger.warning('\nTo fix:');
            Logger.warning('- Verify your API key in the ModelRiver dashboard');
            Logger.warning('- Check that the workflow name is correct (case-sensitive)');
            Logger.warning('- Ensure the API key has access to the project');
            Logger.warning('- Run with --verbose to see full error details');
          } else if (status === 401) {
            Logger.error('Authentication failed - API key is invalid or missing');
            Logger.warning('Check that MODELRIVER_API_KEY is set correctly');
          }
        } else if (error.request) {
          Logger.error('No response received from server');
          Logger.error('Check your network connection and API URL');
          if (verbose) {
            Logger.info(`Request was: ${error.config?.method?.toUpperCase()} ${error.config?.url}`);
          }
        } else {
          Logger.error(`Error: ${error.message}`);
        }

        process.exit(1);
      }
    } else {
      Logger.error('Error: --workflow or (--channel-id and --project-id) required');
      process.exit(1);
    }

    // Connect to WebSocket
    const connectSpinner = Logger.spinner('Connecting to WebSocket...');
    connectSpinner.start();

    if (verbose) {
      Logger.info(`\n> WebSocket URL: ${websocketUrl.replace(wsToken, '***')}`);
      Logger.info(`> Channel: ${websocketChannel}`);
    }

    const wsClient = new WebSocketClient(websocketUrl, wsToken, verbose);

    try {
      await wsClient.connect();
      connectSpinner.succeed('WebSocket connected');

      // Join channel
      const joinSpinner = Logger.spinner('Joining channel...');
      joinSpinner.start();

      try {
        await wsClient.joinChannel(websocketChannel);
        joinSpinner.succeed('Channel joined');
        Logger.warning('\n> Waiting for response...\n');
      } catch (error) {
        joinSpinner.fail('Failed to join channel');
        Logger.error(error.message);
        wsClient.close();
        process.exit(1);
      }

      // Set up response listener BEFORE waiting (to catch responses that arrive quickly)
      let responseReceived = false;
      
      // Timeout after 5 minutes
      const timeoutId = setTimeout(() => {
        if (!responseReceived) {
          Logger.error('\n❌ Timeout: No response received after 5 minutes');
          Logger.error('   Possible causes:');
          Logger.error('   1. Workflow is still processing (try waiting longer)');
          Logger.error('   2. Workflow failed on the server (check server logs)');
          Logger.error('   3. Server did not broadcast the response');
          wsClient.close();
          process.exit(1);
        }
      }, 5 * 60 * 1000);

      wsClient.onResponse((payload) => {
        responseReceived = true;
        clearTimeout(timeoutId);
        Logger.success('\n✅ Response received:\n');
        console.log(Formatter.json(payload));
        wsClient.close();
        process.exit(0);
      });

      if (verbose) {
        Logger.info('✅ Response listener registered and ready');
        Logger.info('⏳ Waiting for server to send "response" event...');
        Logger.info('   (This may take a while for production workflows)');
      }

      wsClient.onClose(() => {
        clearTimeout(timeoutId);
        if (!responseReceived) {
          Logger.warning('\n> WebSocket closed before response received');
          Logger.warning('   The server may have closed the connection without sending a response.');
          Logger.warning('   Check server logs or try the request again.');
        }
      });

    } catch (error) {
      connectSpinner.fail('WebSocket connection failed');
      Logger.error(error.message);
      process.exit(1);
    }

  } catch (error) {
    Logger.error(`Unexpected error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { websocketCommand };


