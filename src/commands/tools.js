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
const { plainText } = require('../utils/tool-approvals');
const { maskSessionToken } = require('../utils/secrets');
const ToolSessionStore = require('../lib/tool-session-store');

const RESULT_PUSH_TIMEOUT_MS = 15000;
// How many call ids and reply refs a session remembers, so a repeated
// tool_call is never forwarded twice (oldest forgotten first).
const SEEN_LIMIT = 10000;
// How long Ctrl+C waits for the server to take the last replies.
const SHUTDOWN_REPLY_CAP_MS = 1000;

/**
 * Format a body for --print: pretty JSON when it parses, text otherwise.
 * The model wrote the arguments and the endpoint wrote the result, so both
 * are shown as plain text: control characters can't drive the terminal.
 */
function formatBody(body) {
  if (body === null || body === undefined) return '(none)';
  if (typeof body !== 'string') return plainText(Formatter.json(body));
  try {
    return plainText(Formatter.json(JSON.parse(body)));
  } catch (error) {
    return plainText(body);
  }
}

/**
 * The tool's name, marked when the server says the tool changes something.
 * Calls without an `effect` (older servers) are shown as before.
 * @param {object} call - tool_call payload
 */
function toolLabel(call) {
  const name = plainText((call && call.tool) || '(unknown tool)');
  return call && call.effect === 'write' ? `${name} [write]` : name;
}

/**
 * One output line per call: time, tool, status (or error), duration.
 * @param {string|object} toolOrCall - the tool name, or the tool_call payload
 * @param {object} result
 */
function describeResult(toolOrCall, result) {
  const time = Formatter.timestamp(new Date());
  const label = typeof toolOrCall === 'object' && toolOrCall !== null
    ? toolLabel(toolOrCall)
    : plainText(toolOrCall || '(unknown tool)');
  const outcome = result.error
    ? `${result.error}${result.status ? ` (HTTP ${result.status})` : ''}`
    : `${result.status}`;
  return `[${time}] ${label} → ${outcome} ${result.ms}ms`;
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
   * @param {object} ctx - {wsClient, topic, origin, print, lookup, now,
   *   forwarded, onForward}. `forwarded` lists call ids an earlier run of
   *   this session already handed to the local server; `onForward(callId)`
   *   is called before each new call is forwarded, so it can be saved.
   */
  constructor({ wsClient, topic, origin, print = false, lookup, now = Date.now, forwarded = [], onForward = null }) {
    this.wsClient = wsClient;
    this.topic = topic;
    this.origin = origin;
    this.print = print;
    this.lookup = lookup;
    this.now = now;
    this.stopping = false;
    // Every call_id and reply_ref this session has seen: a call is
    // forwarded to the local server at most once.
    this.seenCallIds = new Set(forwarded);
    this.seenReplyRefs = new Set();
    this.onForward = onForward;
    // reply_ref -> {call, deadline, state: forwarding|sending|queued|answered, reply, timer, sending, controller}
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

    // The same message again: the first copy answers it.
    if (this.seenReplyRefs.has(call.reply_ref)) {
      safely(() => Logger.warning(`Ignored a repeated tool_call for ${toolLabel(call)} (call ${call.call_id || '?'}); it was already forwarded.`));
      return null;
    }
    remember(this.seenReplyRefs, call.reply_ref);

    // The same call under a new reply_ref: never forward it twice. Answer
    // without sending it, so the server doesn't wait for nothing.
    if (typeof call.call_id === 'string' && call.call_id !== '') {
      if (this.seenCallIds.has(call.call_id)) {
        safely(() => Logger.warning(`Not forwarding ${toolLabel(call)} (call ${call.call_id}) again: this session already forwarded it once. Sent connection_failed.`));
        const entry = this.track(call);
        await this.send(entry, { reply_ref: call.reply_ref, error: 'connection_failed' });
        return { status: 0, body: null, error: 'connection_failed', message: 'Repeated call, not forwarded', ms: 0, repeated: true };
      }
      remember(this.seenCallIds, call.call_id);
    }

    const entry = this.track(call);

    if (this.stopping) {
      // Not forwarded, so answered as refused: ModelRiver then records the
      // call as not sent. connection_failed would mean "sent, no answer",
      // which for a tool that changes something is recorded as unknown.
      const result = { status: 0, body: null, error: 'target_refused', message: 'The CLI is stopping', ms: 0 };
      await this.send(entry, { reply_ref: call.reply_ref, error: 'target_refused' });
      return result;
    }

    if (this.print) {
      safely(() => {
        Logger.log(`\n→ ${toolLabel(call)} POST ${plainText(call.path)} (call ${plainText(call.call_id || '?')})`);
        Logger.log(`  Arguments: ${formatBody(call.body)}`);
      });
    }

    // Saved before the call leaves, so a CLI restarted on this session
    // knows it went out and never forwards it again.
    if (this.onForward && typeof call.call_id === 'string' && call.call_id !== '') {
      safely(() => this.onForward(call.call_id));
    }

    let result;
    try {
      result = await forwardToolCall(call, { origin: this.origin, lookup: this.lookup, signal: entry.controller.signal });
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

  /** Start tracking a call until it is answered. */
  track(call) {
    const entry = {
      call,
      deadline: this.now() + callTimeoutMs(call),
      state: 'forwarding',
      reply: null,
      timer: null,
      sending: null,
      // Ctrl+C (or a takeover) aborts the local request through this.
      controller: new AbortController(),
    };
    this.inFlight.set(call.reply_ref, entry);
    return entry;
  }

  logResult(call, result) {
    const line = describeResult(call, result);
    if (result.error) {
      Logger.error(line);
    } else if (result.status >= 200 && result.status < 300) {
      Logger.success(line);
    } else {
      Logger.warning(line);
    }
    if (result.message) Logger.log(`  ${plainText(result.message)}`);
    // A local timeout: the server may have done the work without answering.
    if (result.error === 'timeout') warnMayHaveRun(call);

    if (this.print && result.body !== null && result.body !== undefined) {
      Logger.log(`  Result: ${formatBody(result.body)}`);
    }
  }

  /**
   * Ctrl+C stopped a call before the local server answered.
   */
  warnStopped(call, replied = true) {
    Logger.warning(`  Stopped ${toolLabel(call)} (call ${call.call_id || '?'}) before your server answered${replied ? '; sent connection_failed' : ''}.`);
    warnMayHaveRun(call);
  }

  /**
   * Another connection took over the session: abort every local request
   * still open (its channel is gone, so nothing is sent back) and say which
   * calls may already have run.
   */
  abortInFlight() {
    this.stopping = true;
    for (const entry of [...this.inFlight.values()]) {
      clearTimeout(entry.timer);
      const forwarding = entry.state === 'forwarding';
      entry.state = 'answered';
      this.inFlight.delete(entry.call.reply_ref);
      if (forwarding) {
        entry.controller.abort();
        safely(() => this.warnStopped(entry.call, false));
      }
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
      // {status: "received"}, or {status: "already_answered"} when ModelRiver
      // already took a result for this call (a copy sent before a reconnect
      // got there first). Either way the call is done.
      await entry.sending;
      this.complete(entry);
    } catch (error) {
      if (entry.state === 'answered') return;
      const reason = refusalReason(error);
      if (reason === 'unknown_reply_ref') {
        // The call is no longer waiting: it timed out, or was never sent to
        // this session. Sending again can't help, so this is final.
        Logger.log(`  ModelRiver is no longer waiting for the result of ${entry.call.tool || 'this call'} (it timed out, or was not sent to this session).`);
        this.complete(entry);
        return;
      }
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
   * being forwarded have their local request aborted and get
   * {error: "connection_failed"}; kept results are sent.
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
      const forwarding = entry.state === 'forwarding';
      const reply = forwarding
        ? { reply_ref: entry.call.reply_ref, error: 'connection_failed' }
        : entry.reply;
      clearTimeout(entry.timer);
      entry.state = 'answered';
      this.inFlight.delete(entry.call.reply_ref);
      if (forwarding) {
        // Stop the local request first, so nothing more is read from it.
        entry.controller.abort();
        safely(() => this.warnStopped(entry.call));
      }
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

/**
 * Say that a call which got no answer may still have run on the local
 * server, unless the server says the tool only reads.
 */
function warnMayHaveRun(call) {
  if (call.effect === 'write') {
    Logger.warning('  This tool changes something: the call may already have run on your server. ' +
      'ModelRiver records its outcome as unknown and never sends it again.');
  } else if (call.effect !== 'read') {
    // No effect from the server (older servers): it may be either kind.
    Logger.warning('  If this tool changes something, the call may already have run on your server. ' +
      'ModelRiver records its outcome as unknown and never sends it again.');
  }
}

/** Add to a bounded set, forgetting the oldest entry when full. */
function remember(set, value) {
  set.add(value);
  if (set.size > SEEN_LIMIT) set.delete(set.values().next().value);
}

function safely(fn) {
  try {
    fn();
  } catch (error) {
    // Output must never stop a reply from being sent.
  }
}

/**
 * Why ModelRiver refused to (re)join the tool session, for people. The
 * channel answers `unauthorized` for every reason, so all of them are named.
 * @param {Error} error - from join()
 * @returns {string|null} null when the join failed some other way
 */
function joinRefusedHint(error) {
  if (refusalReason(error) !== 'unauthorized') return null;
  return 'ModelRiver refused the tool session: hosted tools are turned off for this organization, ' +
    'or the session has expired or belongs to another API key. ' +
    'Run "modelriver tools" again; if it is refused again, ask for hosted tools to be turned on.';
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

// setTimeout can't wait longer than this (about 24.8 days).
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Call onExpired once expiresAt has passed.
 * @param {string} expiresAt - ISO 8601 time
 * @param {Function} onExpired
 * @param {object} [options] - {now} for tests
 * @returns {Function|null} cancel, or null when expiresAt can't be read
 */
function watchExpiry(expiresAt, onExpired, { now = Date.now } = {}) {
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  let timer = null;
  const check = () => {
    const left = at - now();
    if (left <= 0) {
      timer = null;
      onExpired();
      return;
    }
    timer = setTimeout(check, Math.min(left, MAX_TIMER_MS));
  };
  check();
  return () => clearTimeout(timer);
}

/**
 * modelriver tools --forward-to <url> [--print]
 *
 * Opens a CLI tool session and forwards each tool call the server sends for
 * it to a server on this machine.
 */
async function toolsCommand(options) {
  const { apiUrl, forwardTo, print, verbose, newSession } = options;

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

    // A session this machine opened earlier for the same API key and local
    // server is joined again, so requests that name it keep working after a
    // restart. Its token stays in the config folder and is never printed.
    const store = new ToolSessionStore();
    const storeKey = ToolSessionStore.keyFor({ apiUrl: apiClient.apiUrl, apiKey, origin: target.origin });
    let saved = null;
    if (!newSession) {
      try {
        saved = store.load(storeKey);
      } catch (error) {
        saved = null;
      }
    }

    let session = null;
    let reused = false;
    if (!saved) {
      spinner.text = 'Opening tool session...';
      session = await apiClient.createToolSession();
    }

    spinner.text = 'Connecting to WebSocket...';
    wsClient = new CLIWebSocketClient(connectResponse.websocket_url, connectResponse.ws_token, Boolean(verbose), {
      // Each reconnect needs a fresh token; the tool session stays the same.
      refreshToken: () => apiClient.connectCLI(),
      maxReconnectAttempts: Infinity,
    });
    await wsClient.connect();

    // The session whose record this CLI may change in the session file.
    let ownSessionId = saved ? saved.session_id : session.session_id;
    let warnedNotSaved = false;
    const relay = new ToolCallRelay({
      wsClient,
      // The topic holds the session's database ID; the cts_ token is only
      // sent in the join params, which the server checks.
      topic: saved ? saved.channel : session.channel,
      origin: target.origin,
      print,
      forwarded: saved ? saved.forwarded : [],
      onForward: (callId) => {
        try {
          store.addForwarded(storeKey, callId, ownSessionId);
        } catch (error) {
          if (!warnedNotSaved) {
            warnedNotSaved = true;
            Logger.warning(`> Could not record forwarded calls in ${store.file} (${error.message}). A restarted CLI won't know about calls this one forwarded.`);
          }
        }
      },
    });

    // Subscribe before joining: the server may send a tool_call right behind
    // the join reply, and it would be lost if nobody listened yet. Only calls
    // on this session's topic are handled.
    wsClient.on('tool_call', (call, callTopic) => {
      if (relay.topic === null || callTopic !== relay.topic) return;
      relay.handle(call);
    });

    if (saved) {
      spinner.text = 'Rejoining your tool session...';
      try {
        await wsClient.join(saved.channel, { session_token: saved.session_id });
        session = saved;
        reused = true;
      } catch (error) {
        // "unauthorized": the session expired or was removed, or hosted tools
        // was turned off. Anything else (a timeout) is a real failure.
        if (refusalReason(error) !== 'unauthorized') throw error;
        relay.topic = null;
        spinner.stop();
        Logger.warning(`> The saved tool session (${maskSessionToken(saved.session_id)}) can no longer be joined; opening a new one. Requests that named the old session need the new ID.`);
        spinner.start();
        spinner.text = 'Opening tool session...';
        session = await apiClient.createToolSession();
        // Forgotten only once a new session exists. If opening one fails too
        // (hosted tools is off for the organization, say), the saved session
        // is kept, so it can be rejoined when that is put right.
        // Only if it is still the one this CLI tried: another CLI with
        // --new-session may have saved a newer one under the same key.
        try { store.remove(storeKey, saved.session_id); } catch (removeError) { /* nothing saved to remove */ }
        ownSessionId = session.session_id;
        relay.topic = session.channel;
        relay.seenCallIds.clear();
      }
    }
    const topic = session.channel;

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
      if (refusalReason(error) === 'unauthorized') {
        try { store.remove(storeKey, session.session_id); } catch (removeError) { /* nothing saved to remove */ }
      }
      fail(joinRefusedHint(error) ||
        `Could not rejoin the tool session (${error.message}). It may have expired; run "modelriver tools" again.`);
    });

    // One socket per session: when another connection joins this session,
    // the server pushes `replaced` to this one and closes its channel. Stop,
    // rather than rejoin and fight the newer connection for the session.
    wsClient.on('replaced', (_payload, replacedTopic) => {
      if (replacedTopic !== topic) return;
      relay.abortInFlight();
      fail('Another connection took over this tool session (another "modelriver tools" using the same session). ' +
        'Tool calls now go there, so this one has stopped.');
    });

    wsClient.onClient('channel_close', (closedTopic) => {
      if (closedTopic !== topic) return;
      fail('The server closed the tool session. Run "modelriver tools" again for a new one.');
    });

    if (!reused) {
      spinner.text = 'Joining tool channel...';
      // join() keeps the params, so a rejoin after a reconnect sends them again.
      await wsClient.join(topic, { session_token: session.session_id });
      try {
        // With the calls forwarded so far: one can arrive right behind the
        // join, before this line runs.
        store.save(storeKey, session, [...relay.seenCallIds]);
      } catch (error) {
        spinner.stop();
        Logger.warning(`> Could not save the session in ${store.file} (${error.message}). A restarted CLI will open a new session.`);
        spinner.start();
      }
    }
    started = true;
    // A result that was ready before the join was complete goes out now.
    relay.flush();

    spinner.succeed('Tool forwarding active');

    if (reused) {
      // Never printed in full again: it was shown once, when it was opened.
      Logger.success(`\n> Session: ${maskSessionToken(session.session_id)} (rejoined: the session this machine already had)`);
    } else {
      Logger.success(`\n> Session: ${session.session_id}`);
    }
    if (session.project_id) {
      Logger.info(`> Project: ${session.project_id}`);
    }
    if (session.expires_at) {
      Logger.info(`> Expires: ${session.expires_at}`);
    }
    Logger.info(`> Forwarding tool calls to ${target.origin}`);
    if (reused) {
      Logger.log('\nRequests that already name this session in "tool_route" keep working; calls waiting for approval');
      Logger.log('are sent here once approved. The session ID was printed when the session was opened.');
      Logger.log('For a new session (and a new ID), start again with --new-session.');
    } else {
      Logger.log('\nAdd this to a POST /v1/ai/async request to send its tool calls here:');
      Logger.log(`  "tool_route": {"cli_session": "${session.session_id}"}`);
      Logger.log('Or send one and follow it (approvals included) from another terminal:');
      Logger.log(`  modelriver websocket -w <workflow> -m "..." --end-user <id> --cli-session ${session.session_id}`);
      Logger.log('\nThe session ID works like a password while it is valid. Do not commit or share it.');
      Logger.log(`It is saved in ${store.file} (readable only by you), so starting "modelriver tools" again with the`);
      Logger.log('same API key and --forward-to rejoins this session.');
    }
    Logger.warning('> Press Ctrl+C to stop\n');

    // At expires_at the session stops working; say so and stop rather than
    // stay "active" on a dead session.
    watchExpiry(session.expires_at, () => {
      relay.abortInFlight();
      fail(`This tool session expired (${session.expires_at}). Start "modelriver tools" again for a new session ID.`);
    });

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
    const joinHint = joinRefusedHint(error);
    if (joinHint) {
      Logger.warning(`> ${joinHint}`);
    } else if (error.response?.status === 401) {
      Logger.warning('> Check your API key (modelriver login, or --api-key).');
    } else if (error.response?.status === 403 || error.response?.status === 404) {
      Logger.warning('> Hosted tools may not be enabled for this project, or the server does not support CLI tool sessions yet.');
    } else if (error.response?.status === 429) {
      // Either the session limit, or ModelRiver's rate limiter (another body).
      const body = error.response.data && typeof error.response.data === 'object' ? error.response.data : {};
      if (body.error === 'too_many_cli_tool_sessions') {
        Logger.warning('> You already have 5 connected tool sessions for this project. Stop one and try again.');
      } else {
        const retry = body.retry_after ?? error.response.headers?.['retry-after'];
        Logger.warning(retry !== undefined && retry !== null
          ? `> Rate limited by ModelRiver. Try again in ${plainText(retry)} seconds.`
          : '> Rate limited by ModelRiver. Try again shortly.');
      }
    }
    if (wsClient) wsClient.close();
    process.exit(1);
  }
}

module.exports = { watchExpiry, toolsCommand, handleToolCall, describeResult, formatBody, toolLabel, resolveApiKey, ToolCallRelay };
