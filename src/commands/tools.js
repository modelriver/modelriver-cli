const ApiClient = require('../lib/api-client');
const CLIWebSocketClient = require('../lib/cli-websocket-client');
const config = require('../lib/config');
const {
  ForwardTargetError,
  parseForwardTarget,
  resolveLoopback,
  callTimeoutMs,
  forwardToolCall,
} = require('../lib/tool-forwarder');
const Logger = require('../utils/logger');
const Formatter = require('../utils/formatter');

const RESULT_PUSH_TIMEOUT_MS = 15000;
// How long Ctrl+C waits for the server to take the last replies.
const SHUTDOWN_REPLY_CAP_MS = 1000;

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
 * Forwards the server's tool calls and sends back their results.
 *
 * Every call is answered exactly once. A result that can't be sent because the
 * socket is down or the channel is rejoining is kept and sent after the rejoin,
 * until the call's deadline (its timeout_ms from arrival); then it is dropped,
 * because the server has stopped waiting for it.
 */
class ToolCallRelay {
  /**
   * @param {object} ctx - {wsClient, topic, origin, print, lookup, now}
   */
  constructor({ wsClient, topic, origin, print = false, lookup, now = Date.now }) {
    this.wsClient = wsClient;
    this.topic = topic;
    this.origin = origin;
    this.print = print;
    this.lookup = lookup;
    this.now = now;
    this.stopping = false;
    // reply_ref -> {call, deadline, state: forwarding|sending|queued|answered, reply, timer, sending}
    this.inFlight = new Map();
  }

  canSend() {
    const ws = this.wsClient;
    return typeof ws.isJoined === 'function' ? ws.isJoined(this.topic) : true;
  }

  /**
   * Handle one `tool_call`: forward it, then send `tool_result`.
   * Never rejects.
   * @param {object} call - tool_call payload
   * @returns {Promise<object|null>} the forward result
   */
  async handle(call) {
    if (!call || typeof call !== 'object' || typeof call.reply_ref !== 'string') {
      Logger.warning('Ignored a tool_call without a reply_ref');
      return null;
    }

    const entry = {
      call,
      deadline: this.now() + callTimeoutMs(call),
      state: 'forwarding',
      reply: null,
      timer: null,
      sending: null,
    };
    this.inFlight.set(call.reply_ref, entry);

    if (this.stopping) {
      const result = { status: 0, body: null, error: 'connection_failed', message: 'The CLI is stopping', ms: 0 };
      await this.send(entry, { reply_ref: call.reply_ref, error: 'connection_failed' });
      return result;
    }

    if (this.print) {
      safely(() => {
        Logger.log(`\n→ ${call.tool || '(unknown tool)'} POST ${call.path} (call ${call.call_id || '?'})`);
        Logger.log(`  Arguments: ${formatBody(call.body)}`);
      });
    }

    let result;
    try {
      result = await forwardToolCall(call, { origin: this.origin, lookup: this.lookup });
    } catch (error) {
      result = { status: 0, body: null, error: 'connection_failed', message: error.message, ms: 0 };
    }

    // Ctrl+C already answered this call.
    if (entry.state === 'answered') return result;

    safely(() => this.logResult(call, result));

    // The server takes either {reply_ref, status, body} or {reply_ref, error}.
    const reply = result.error
      ? { reply_ref: call.reply_ref, error: result.error }
      : { reply_ref: call.reply_ref, status: result.status, body: result.body };

    await this.send(entry, reply);
    return result;
  }

  logResult(call, result) {
    const line = describeResult(call.tool, result);
    if (result.error) {
      Logger.error(line);
    } else if (result.status >= 200 && result.status < 300) {
      Logger.success(line);
    } else {
      Logger.warning(line);
    }
    if (result.message) Logger.log(`  ${result.message}`);

    if (this.print && result.body !== null && result.body !== undefined) {
      Logger.log(`  Result: ${formatBody(result.body)}`);
    }
  }

  /**
   * Send a reply now, or keep it for after the rejoin.
   */
  async send(entry, reply) {
    entry.reply = reply;
    if (entry.state === 'answered') return;
    if (!this.canSend()) {
      this.queue(entry);
      return;
    }

    entry.state = 'sending';
    entry.sending = this.wsClient.push(this.topic, 'tool_result', reply, { timeoutMs: RESULT_PUSH_TIMEOUT_MS });
    try {
      await entry.sending;
      this.complete(entry);
    } catch (error) {
      if (entry.state === 'answered') return;
      const reason = refusalReason(error);
      const lostConnection = (error && error.reason === 'disconnected') || reason === 'unmatched topic';
      if (lostConnection || !this.canSend()) {
        // The socket closed (or the channel is rejoining) before the server
        // replied; send it again once the channel is back.
        if (this.canSend() && reason !== 'unmatched topic' && !entry.retriedAtOnce) {
          entry.retriedAtOnce = true;
          await this.send(entry, reply);
        } else {
          this.queue(entry);
        }
        return;
      }
      Logger.warning(`  The server did not accept the result for ${entry.call.tool || 'this call'}: ${error.message}`);
      this.complete(entry);
    }
  }

  queue(entry) {
    const left = entry.deadline - this.now();
    if (left <= 0) {
      this.drop(entry);
      return;
    }
    if (entry.state !== 'queued') {
      Logger.warning(`  Not connected; the result for ${entry.call.tool || 'this call'} will be sent after reconnecting.`);
    }
    entry.state = 'queued';
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.drop(entry), left);
  }

  drop(entry) {
    if (entry.state === 'answered') return;
    Logger.error(`  Dropped the result for ${entry.call.tool || 'this call'}: not reconnected before its ${callTimeoutMs(entry.call)}ms deadline.`);
    this.complete(entry);
  }

  complete(entry) {
    clearTimeout(entry.timer);
    entry.state = 'answered';
    if (this.inFlight.get(entry.call.reply_ref) === entry) {
      this.inFlight.delete(entry.call.reply_ref);
    }
  }

  /**
   * The channel is joined again: send every result that was kept.
   * @returns {Promise<void>}
   */
  flush() {
    const queued = [...this.inFlight.values()].filter((entry) => entry.state === 'queued');
    return Promise.all(queued.map((entry) => {
      clearTimeout(entry.timer);
      return this.send(entry, entry.reply);
    })).then(() => undefined);
  }

  /**
   * Ctrl+C: answer what is still open, best effort, within capMs. Calls still
   * being forwarded get {error: "connection_failed"}; kept results are sent.
   * @param {number} [capMs]
   * @returns {Promise<void>}
   */
  async shutdown(capMs = SHUTDOWN_REPLY_CAP_MS) {
    this.stopping = true;
    const waits = [];
    for (const entry of [...this.inFlight.values()]) {
      if (entry.state === 'answered') continue;
      if (entry.state === 'sending') {
        waits.push(entry.sending);
        continue;
      }
      const reply = entry.state === 'forwarding'
        ? { reply_ref: entry.call.reply_ref, error: 'connection_failed' }
        : entry.reply;
      clearTimeout(entry.timer);
      entry.state = 'answered';
      this.inFlight.delete(entry.call.reply_ref);
      if (this.canSend()) {
        waits.push(this.wsClient.push(this.topic, 'tool_result', reply, { timeoutMs: capMs }));
      }
    }
    if (waits.length === 0) return;

    let timer;
    await Promise.race([
      Promise.allSettled(waits),
      new Promise((resolve) => { timer = setTimeout(resolve, capMs); }),
    ]);
    clearTimeout(timer);
  }
}

function safely(fn) {
  try {
    fn();
  } catch (error) {
    // Output must never stop a reply from being sent.
  }
}

/** The `reason` from a refused push's reply, if there is one. */
function refusalReason(error) {
  const response = error && error.reply && error.reply.response;
  return response && typeof response === 'object' ? response.reason : undefined;
}

/**
 * Handle one `tool_call` with a one-off relay (used by tests).
 * @param {object} call - tool_call payload
 * @param {object} ctx - {wsClient, topic, origin, print, lookup}
 * @returns {Promise<object|null>} the forward result
 */
function handleToolCall(call, ctx) {
  return new ToolCallRelay(ctx).handle(call);
}

/**
 * The API key `tools` may use: --api-key, MODELRIVER_API_KEY or
 * ~/.modelriver/config.json. Never a .modelriverrc in the current directory:
 * a cloned repository could plant another account's key there, and that
 * account could then send POST requests to servers on your machine.
 *
 * @param {string} [flagKey] - --api-key
 * @param {object} [cfg] - Config instance
 * @returns {{apiKey: string, source: string, ignoredLocalKey: boolean}}
 */
function resolveApiKey(flagKey, cfg = config) {
  const localKey = cfg.getLocalRcApiKey();
  if (flagKey) return { apiKey: flagKey, source: '--api-key', ignoredLocalKey: Boolean(localKey) };

  const trusted = cfg.getTrustedApiKey();
  if (trusted) return { apiKey: trusted.key, source: trusted.source, ignoredLocalKey: Boolean(localKey) };

  if (localKey) {
    throw new Error(
      `"modelriver tools" does not use the API key in ${cfg.getLocalRcPath()}.\n` +
      'A .modelriverrc can come with any repository you clone, and its key decides which account ' +
      'sends tool calls to servers on this machine. Pass your own key with --api-key, set ' +
      'MODELRIVER_API_KEY, or run "modelriver login".'
    );
  }
  throw new Error('API key is required. Set MODELRIVER_API_KEY, use --api-key, or run "modelriver login".');
}

/**
 * modelriver tools --forward-to <url> [--print]
 *
 * Opens a CLI tool session and forwards each tool call the server sends for
 * it to a server on this machine.
 */
async function toolsCommand(options) {
  const { apiUrl, forwardTo, print, verbose } = options;

  let apiKey;
  try {
    const resolved = resolveApiKey(options.apiKey);
    apiKey = resolved.apiKey;
    if (resolved.ignoredLocalKey) {
      Logger.warning(`> Ignoring the API key in ${config.getLocalRcPath()}; "modelriver tools" uses ${resolved.source}.`);
    }
  } catch (error) {
    Logger.error(error.message);
    process.exit(1);
  }

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
  let started = false;
  const fail = (message) => {
    Logger.error(message);
    if (wsClient) wsClient.close();
    process.exit(1);
  };

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

    const relay = new ToolCallRelay({ wsClient, topic, origin: target.origin, print });

    // Subscribe before joining: the server may send a tool_call right behind
    // the join reply, and it would be lost if nobody listened yet. Only calls
    // on this session's topic are handled.
    wsClient.on('tool_call', (call, callTopic) => {
      if (callTopic !== topic) return;
      relay.handle(call);
    });

    // Results kept while disconnected go out once the channel is back.
    wsClient.onClient('rejoin', (rejoined) => {
      if (rejoined === topic) relay.flush();
    });

    // A close the client won't recover from (e.g. the server closed with
    // code 1000) would otherwise leave the CLI "active" on a dead socket.
    wsClient.onClient('close', (code, reason, willReconnect) => {
      if (willReconnect || wsClient.closing || !started) return;
      fail(`The server closed the connection (code ${code}${reason ? `: ${reason}` : ''}). Run "modelriver tools" again for a new session.`);
    });

    wsClient.onClient('reconnect_failed', () => {
      fail('Could not reconnect to ModelRiver. Run "modelriver tools" again for a new session.');
    });

    wsClient.onClient('rejoin_error', (failedTopic, error) => {
      if (failedTopic !== topic) return;
      fail(`Could not rejoin the tool session (${error.message}). It may have expired; run "modelriver tools" again.`);
    });

    wsClient.onClient('channel_close', (closedTopic) => {
      if (closedTopic !== topic) return;
      fail('The server closed the tool session. Run "modelriver tools" again for a new one.');
    });

    spinner.text = 'Joining tool channel...';
    // join() keeps the params, so a rejoin after a reconnect sends them again.
    await wsClient.join(topic, joinParams);
    started = true;

    spinner.succeed('Tool forwarding active');

    Logger.success(`\n> Session: ${session.session_id}`);
    if (session.project_id) {
      Logger.info(`> Project: ${session.project_id}`);
    }
    if (session.expires_at) {
      Logger.info(`> Expires: ${session.expires_at}`);
    }
    Logger.info(`> Forwarding tool calls to ${target.origin}`);
    Logger.log('\nAdd this to a POST /v1/ai/async request to send its tool calls here:');
    Logger.log(`  "tool_route": {"cli_session": "${session.session_id}"}`);
    Logger.log('\nThe session ID works like a password while it is valid. Do not commit or share it.');
    Logger.warning('> Press Ctrl+C to stop\n');

    let stopping = false;
    const cleanup = async () => {
      if (stopping) process.exit(130); // second Ctrl+C: leave now
      stopping = true;
      Logger.warning('\n> Stopping tool forwarding...');
      try {
        await relay.shutdown();
      } finally {
        wsClient.close();
        process.exit(0);
      }
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
    } else if (error.response?.status === 429) {
      Logger.warning('> You already have 5 connected tool sessions for this project. Stop one and try again.');
    }
    if (wsClient) wsClient.close();
    process.exit(1);
  }
}

module.exports = { toolsCommand, handleToolCall, describeResult, resolveApiKey, ToolCallRelay };
