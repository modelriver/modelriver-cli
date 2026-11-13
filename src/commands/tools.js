const ApiClient = require('../lib/api-client');
const CLIWebSocketClient = require('../lib/cli-websocket-client');
const {
  ForwardTargetError,
  parseForwardTarget,
  resolveLoopback,
  forwardToolCall,
} = require('../lib/tool-forwarder');
const Logger = require('../utils/logger');
const Formatter = require('../utils/formatter');

const RESULT_PUSH_TIMEOUT_MS = 15000;

/**
 * Format a body for --print: pretty JSON when it parses, text otherwise.
 */
function formatBody(body) {
  if (body === null || body === undefined) return '(none)';
  if (typeof body !== 'string') return Formatter.json(body);
  try {
    return Formatter.json(JSON.parse(body));
  } catch (error) {
    return body;
  }
}

/**
 * One output line per call: time, tool, status (or error), duration.
 */
function describeResult(toolName, result) {
  const time = Formatter.timestamp(new Date());
  const outcome = result.error
    ? `${result.error}${result.status ? ` (HTTP ${result.status})` : ''}`
    : `${result.status}`;
  return `[${time}] ${toolName || '(unknown tool)'} → ${outcome} ${result.ms}ms`;
}

/**
 * Handle one `tool_call` from the server: forward it, then send `tool_result`
 * and wait for the server to accept it.
 *
 * @param {object} call - tool_call payload
 * @param {object} ctx - {wsClient, topic, origin, print, lookup}
 * @returns {Promise<object>} the forward result
 */
async function handleToolCall(call, { wsClient, topic, origin, print = false, lookup }) {
  if (!call || typeof call !== 'object' || typeof call.reply_ref !== 'string') {
    Logger.warning('Ignored a tool_call without a reply_ref');
    return null;
  }

  if (print) {
    Logger.log(`\n→ ${call.tool || '(unknown tool)'} POST ${call.path} (call ${call.call_id || '?'})`);
    Logger.log(`  Arguments: ${formatBody(call.body)}`);
  }

  const result = await forwardToolCall(call, { origin, lookup });

  const line = describeResult(call.tool, result);
  if (result.error) {
    Logger.error(line);
    if (result.message) Logger.log(`  ${result.message}`);
  } else if (result.status >= 200 && result.status < 300) {
    Logger.success(line);
  } else {
    Logger.warning(line);
  }

  if (print && result.body !== null && result.body !== undefined) {
    Logger.log(`  Result: ${formatBody(result.body)}`);
  }

  // The server takes either {reply_ref, status, body} or {reply_ref, error}.
  const reply = result.error
    ? { reply_ref: call.reply_ref, error: result.error }
    : { reply_ref: call.reply_ref, status: result.status, body: result.body };

  try {
    await wsClient.push(topic, 'tool_result', reply, { timeoutMs: RESULT_PUSH_TIMEOUT_MS });
  } catch (error) {
    Logger.warning(`  The server did not accept the result for ${call.tool || 'this call'}: ${error.message}`);
  }

  return result;
}

/**
 * modelriver tools --forward-to <url> [--print]
 *
 * Opens a CLI tool session and forwards each tool call the server sends for
 * it to a server on this machine.
 */
async function toolsCommand(options) {
  const { apiKey, apiUrl, forwardTo, print, verbose } = options;

  // Check the target before touching the network.
  let target;
  try {
    target = parseForwardTarget(forwardTo);
    await resolveLoopback(target.hostname);
  } catch (error) {
    Logger.error(error.message);
    if (error instanceof ForwardTargetError) {
      Logger.warning('> Tool calls are only forwarded to this machine: localhost, 127.0.0.0/8 or ::1.');
      Logger.warning('> Example: modelriver tools --forward-to http://localhost:3000');
    }
    process.exit(1);
  }

  if (target.ignoredPath) {
    Logger.warning(`> Only the origin of --forward-to is used (${target.origin}); each call keeps the path of the tool's endpoint URL.`);
  }

  const spinner = Logger.spinner('Connecting to ModelRiver...');
  spinner.start();

  let wsClient;
  try {
    const apiClient = new ApiClient(apiKey, apiUrl);
    if (verbose) apiClient.verbose = true;

    const connectResponse = await apiClient.connectCLI();

    spinner.text = 'Opening tool session...';
    const session = await apiClient.createToolSession();
    // The topic holds the session's database ID; the cts_ token is only sent
    // in the join params, which the server checks.
    const topic = session.channel;
    const joinParams = { session_token: session.session_id };

    spinner.text = 'Connecting to WebSocket...';
    wsClient = new CLIWebSocketClient(connectResponse.websocket_url, connectResponse.ws_token, Boolean(verbose), {
      // Each reconnect needs a fresh token; the tool session stays the same.
      refreshToken: () => apiClient.connectCLI(),
      maxReconnectAttempts: Infinity,
    });
    await wsClient.connect();

    spinner.text = 'Joining tool channel...';
    // join() keeps the params, so a rejoin after a reconnect sends them again.
    await wsClient.join(topic, joinParams);

    spinner.succeed('Tool forwarding active');

    Logger.success(`\n> Session: ${session.session_id}`);
    if (session.expires_at) {
      Logger.info(`> Expires: ${session.expires_at}`);
    }
    Logger.info(`> Forwarding tool calls to ${target.origin}`);
    Logger.log('\nAdd this to a POST /v1/ai/async request to send its tool calls here:');
    Logger.log(`  "tool_route": {"cli_session": "${session.session_id}"}`);
    Logger.log('\nThe session ID works like a password while it is valid. Do not commit or share it.');
    Logger.warning('> Press Ctrl+C to stop\n');

    wsClient.on('tool_call', (call) => {
      handleToolCall(call, { wsClient, topic, origin: target.origin, print }).catch((error) => {
        Logger.error(`Tool call failed: ${error.message}`);
      });
    });

    wsClient.onClient('rejoin_error', (failedTopic, error) => {
      if (failedTopic !== topic) return;
      Logger.error(`Could not rejoin the tool session (${error.message}). It may have expired; run "modelriver tools" again.`);
      wsClient.close();
      process.exit(1);
    });

    wsClient.onClient('channel_close', (closedTopic) => {
      if (closedTopic !== topic) return;
      Logger.error('The server closed the tool session. Run "modelriver tools" again for a new one.');
      wsClient.close();
      process.exit(1);
    });

    const cleanup = () => {
      Logger.warning('\n> Stopping tool forwarding...');
      if (wsClient) wsClient.close();
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  } catch (error) {
    spinner.fail('Failed to start tool forwarding');
    Logger.error(error.message);
    if (error.response?.status === 401) {
      Logger.warning('> Check your API key (modelriver login, or --api-key).');
    } else if (error.response?.status === 403 || error.response?.status === 404) {
      Logger.warning('> Hosted tools may not be enabled for this project, or the server does not support CLI tool sessions yet.');
    }
    if (wsClient) wsClient.close();
    process.exit(1);
  }
}

module.exports = { toolsCommand, handleToolCall, describeResult };
