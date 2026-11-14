const ApiClient = require('../lib/api-client');
const WebSocketClient = require('../lib/websocket-client');
const config = require('../lib/config');
const Logger = require('../utils/logger');
const Formatter = require('../utils/formatter');
const { normalizeWebSocketUrl } = require('../utils/url-helpers');
const { redactRequestPayload } = require('../utils/secrets');
const {
  plainText,
  describeApprovalRequired,
  describeApprovalResolved,
  followDeadline,
} = require('../utils/tool-approvals');
const {
  buildCallbackHint,
  isFinalWebSocketStatus,
  isIntermediateWebSocketStatus,
} = require('../utils/webhook-payload');

// How long to wait for a response when nothing is waiting for approval.
const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Add --end-user and --cli-session to a request payload, unless it already
 * says them.
 */
function addToolOptions(requestPayload, { endUser, cliSession }) {
  if (endUser && !requestPayload.end_user) {
    requestPayload.end_user = { id: endUser };
  }
  if (cliSession && !requestPayload.tool_route) {
    requestPayload.tool_route = { cli_session: cliSession };
  }
  return requestPayload;
}

/**
 * What to print when ModelRiver refuses the request: the status, then the
 * error code, message and details it sent (details as JSON), and for a 429
 * how long to wait. Text from the server is shown as plain text.
 * @param {number} status
 * @param {object|string} data - response body
 * @param {object} [headers] - response headers (lower-case names)
 * @returns {string[]}
 */
function requestFailureLines(status, data, headers = {}) {
  const lines = [`Request failed with status code ${status}`];
  let body = {};
  if (typeof data === 'string') {
    body = { message: data };
  } else if (data && typeof data === 'object') {
    body = data;
  }

  if (body.error) lines.push(`Error: ${plainText(body.error)}`);
  if (body.message) lines.push(`Message: ${plainText(body.message)}`);
  const details = body.details;
  const hasDetails = details && (typeof details !== 'object' || Object.keys(details).length > 0);
  if (hasDetails) lines.push(`Details: ${plainText(details)}`);

  if (status === 429) {
    const retry = body.retry_after ?? (headers && headers['retry-after']);
    if (retry !== undefined && retry !== null) lines.push(`Try again in ${plainText(retry)} seconds.`);
  }
  return lines;
}

/**
 * Follows a request's hosted-tools approvals: prints each call that waits
 * for approval (and the commands that decide it) and each decision, and
 * keeps the wait going while calls wait. Pure apart from `print` and `now`,
 * so it can be tested without a socket.
 */
class ApprovalFollower {
  /**
   * @param {object} options - {endUserId, print(lines, kind), onDeadline(ms), now}
   */
  constructor({ endUserId, print, onDeadline, now = Date.now }) {
    this.endUserId = endUserId;
    this.print = print;
    this.onDeadline = onDeadline;
    this.now = now;
    this.deadline = now() + RESPONSE_TIMEOUT_MS;
    this.waiting = new Map(); // call id -> expires_at
    this.shown = new Set(); // call ids already printed
  }

  required(call) {
    if (!call || typeof call !== 'object') return;
    const id = call.id || '?';
    this.waiting.set(id, call.expires_at);
    if (!this.shown.has(id)) {
      this.shown.add(id);
      this.print(describeApprovalRequired(call, { endUserId: this.endUserId }), 'required');
    }
    this.extend(followDeadline(this.deadline, [...this.waiting.values()], this.now()));
  }

  resolved(event) {
    if (!event || typeof event !== 'object') return;
    this.waiting.delete(event.id);
    this.print([describeApprovalResolved(event)], 'resolved');
    // The request carries on from here: allow it the usual time to answer.
    this.extend(this.now() + RESPONSE_TIMEOUT_MS);
  }

  /** `tool_state` on join: calls already waiting when we joined. */
  state(payload) {
    const calls = payload && Array.isArray(payload.calls) ? payload.calls : [];
    calls.filter((c) => c && c.status === 'awaiting_approval').forEach((c) => this.required(c));
  }

  isWaiting() {
    return this.waiting.size > 0;
  }

  extend(deadline) {
    if (deadline > this.deadline) {
      this.deadline = deadline;
      if (this.onDeadline) this.onDeadline(deadline);
    }
  }
}

async function websocketCommand(options) {
  const { workflow, message, payload, channelId, projectId, apiKey, apiUrl, verbose, endUser, cliSession } = options;

  let wsToken, websocketChannel, websocketUrl, channelIdToUse, projectIdToUse;
  let endUserId = endUser;

  try {
    const apiClient = new ApiClient(apiKey, apiUrl);

    if (channelId && projectId) {
      // Connect to existing channel
      const spinner = Logger.spinner('Getting reconnect token...');
      spinner.start();

      try {
        const reconnectResponse = await apiClient.reconnectAsync(channelId);
        // A 4xx doesn't throw: without a token there is nothing to connect with.
        if (!reconnectResponse || typeof reconnectResponse.ws_token !== 'string' || !reconnectResponse.ws_token) {
          const reason = reconnectResponse && typeof reconnectResponse.message === 'string'
            ? plainText(reconnectResponse.message)
            : 'ModelRiver gave no token for this channel. The request may have finished, or the channel ID is wrong.';
          throw new Error(reason);
        }
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

        // Allow --workflow with --payload when payload omits workflow
        if (workflow && !requestPayload.workflow) {
          requestPayload.workflow = workflow;
        }
        addToolOptions(requestPayload, { endUser, cliSession });
        if (requestPayload.end_user && typeof requestPayload.end_user.id === 'string') {
          endUserId = requestPayload.end_user.id;
        }

        if (!requestPayload.workflow) {
          spinner.fail('Workflow required');
          Logger.error('Provide --workflow or include "workflow" in --payload JSON');
          process.exit(1);
        }

        if (verbose) {
          Logger.info(`\n> API URL: ${apiClient.apiUrl}`);
          Logger.info(`> Workflow: ${requestPayload.workflow}`);
          // The CLI session token works like a password: never print it.
          Logger.info(`> Payload: ${JSON.stringify(redactRequestPayload(requestPayload), null, 2)}`);
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

          const [first, ...rest] = requestFailureLines(status, data, error.response.headers);
          Logger.error(first);

          // Log full response for debugging
          if (verbose) {
            Logger.info(`\nFull error response: ${plainText(JSON.stringify(data, null, 2))}`);
            Logger.info(`Response headers: ${plainText(JSON.stringify(error.response.headers, null, 2))}`);
          }

          rest.forEach((line) => Logger.error(line));

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

      // Set up the listeners BEFORE joining (to catch events that arrive quickly)
      let responseReceived = false;
      let sawIntermediateEvent = false;

      // Wait 5 minutes for the response; while tool calls wait for approval,
      // until the last approval expires (at most an hour) plus 5 minutes.
      let timeoutId = null;
      const onTimeout = () => {
        if (!responseReceived) {
          Logger.error(approvals.isWaiting()
            ? '\n❌ Timeout: No response after the approval window ended'
            : `\n❌ Timeout: No response received after ${Math.round((approvals.deadline - startedAt) / 60000)} minutes`);
          if (approvals.isWaiting()) {
            Logger.error('   Calls were still waiting for approval. Check them with: modelriver tools show <call_id>');
          } else if (sawIntermediateEvent) {
            Logger.error('   Event-driven flow is waiting for a backend callback.');
            Logger.error(`   Complete it with: modelriver callback --channel-id ${channelIdToUse} --data '{"summary":"..."}'`);
          } else {
            Logger.error('   Possible causes:');
            Logger.error('   1. Workflow is still processing (try waiting longer)');
            Logger.error('   2. Workflow failed on the server (check server logs)');
            Logger.error('   3. Server did not broadcast the response');
          }
          wsClient.close();
          process.exit(1);
        }
      };
      const armTimeout = (deadline) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(onTimeout, Math.max(0, deadline - Date.now()));
      };
      const startedAt = Date.now();
      const approvals = new ApprovalFollower({
        endUserId,
        print: (lines, kind) => {
          if (kind === 'required') {
            Logger.warning(`\n${lines[0]}`);
            Logger.log(lines.slice(1).join('\n'));
          } else {
            Logger.info(lines.join('\n'));
          }
        },
        onDeadline: (deadline) => {
          armTimeout(deadline);
          if (verbose) Logger.info(`> Waiting for the response until ${new Date(deadline).toISOString()}`);
        },
      });
      armTimeout(approvals.deadline);

      wsClient.onEvent('tool_approval_required', (event) => approvals.required(event));
      wsClient.onEvent('tool_approval_resolved', (event) => approvals.resolved(event));
      wsClient.onEvent('tool_state', (state) => approvals.state(state));

      wsClient.onResponse((payload) => {
        const status = payload?.status;

        if (isIntermediateWebSocketStatus(status)) {
          sawIntermediateEvent = true;
          Logger.warning(`\n⏳ Event-driven update (${status})`);
          Logger.info(`> Channel ID: ${payload.channel_id || channelIdToUse}`);
          if (payload.event_name) {
            Logger.info(`> Event: ${payload.event_name}`);
          }
          if (payload.message) {
            Logger.info(`> Message: ${payload.message}`);
          }

          const callbackUrl = `${apiClient.apiUrl}${apiClient.apiPath}/callback/${channelIdToUse}`;
          const hint = buildCallbackHint(callbackUrl, channelIdToUse, apiClient.apiKey);
          if (hint) {
            Logger.warning(`\n${hint}\n`);
          }

          if (verbose) {
            Logger.info(`Intermediate payload: ${Formatter.json(payload)}`);
          }
          return;
        }

        if (!isFinalWebSocketStatus(status) && status) {
          if (verbose) {
            Logger.info(`Received non-final status "${status}", waiting for completion...`);
          }
          return;
        }

        responseReceived = true;
        clearTimeout(timeoutId);
        Logger.success('\n✅ Response received:\n');
        // The model wrote the answer: control characters must not reach the terminal.
        console.log(plainText(Formatter.json(payload)));
        wsClient.close();
        process.exit(0);
      });

      // Join only now that every listener is in place: the server sends
      // tool_state (calls already waiting for approval) right after the join.
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

      if (verbose) {
        Logger.info('✅ Response listener registered and ready');
        Logger.info('⏳ Waiting for server to send "response" event...');
        Logger.info('   (This may take a while for production workflows)');
      }

      wsClient.onClose(() => {
        clearTimeout(timeoutId);
        if (!responseReceived) {
          // No response: a script waiting on this command must not read it as success.
          process.exitCode = 1;
          Logger.warning('\n> WebSocket closed before response received');
          Logger.warning('   The server may have closed the connection without sending a response.');
          Logger.warning('   Check server logs or try the request again.');
          if (channelIdToUse && projectIdToUse) {
            Logger.warning(`   Follow it again with: modelriver websocket --channel-id ${channelIdToUse} --project-id ${projectIdToUse}`);
          }
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

module.exports = { websocketCommand, ApprovalFollower, addToolOptions, requestFailureLines, RESPONSE_TIMEOUT_MS };


