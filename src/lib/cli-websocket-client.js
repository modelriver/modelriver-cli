const WebSocket = require('ws');
const Logger = require('../utils/logger');
const { checkWebSocketUrl, normalizeWebSocketUrl } = require('../utils/url-helpers');

const DEFAULT_PUSH_TIMEOUT_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_RECONNECT_DELAY_MS = 30000;

/**
 * Error for a push the server answered with `status: "error"`, or that got no
 * answer in time. `reply` holds the server's reply payload when there was one.
 */
class PushError extends Error {
  constructor(message, { reply = null, reason = 'error' } = {}) {
    super(message);
    this.name = 'PushError';
    this.reply = reply;
    this.reason = reason;
  }
}

/**
 * Phoenix channel client (V1 JSON serializer) used by the CLI.
 *
 * - `push(topic, event, payload)` sends a message with a unique ref and returns a
 *   promise settled by the matching `phx_reply` (or a timeout).
 * - Several topics can be joined on one socket.
 * - After an unexpected disconnect it reconnects with backoff. When a
 *   `refreshToken` function is given it is called first, so a fresh token (and
 *   WebSocket URL) is used, and every joined topic is joined again.
 */
class CLIWebSocketClient {
  /**
   * @param {string} websocketUrl
   * @param {string} token
   * @param {boolean} verbose
   * @param {object} [options]
   * @param {Function} [options.refreshToken] - async () => ({ws_token, websocket_url})
   * @param {number} [options.pushTimeoutMs]
   * @param {number} [options.maxReconnectAttempts]
   * @param {number} [options.reconnectDelayMs] - first backoff step
   * @param {number} [options.heartbeatIntervalMs]
   */
  constructor(websocketUrl, token, verbose = false, options = {}) {
    // ws:// on port 443 or a modelriver.com host means wss://
    this.websocketUrl = normalizeWebSocketUrl(websocketUrl);
    this.token = token;
    this.verbose = verbose;
    this.refreshToken = options.refreshToken || null;
    this.pushTimeoutMs = options.pushTimeoutMs || DEFAULT_PUSH_TIMEOUT_MS;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.reconnectDelay = options.reconnectDelayMs || 1000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || HEARTBEAT_INTERVAL_MS;

    this.ws = null;
    this.ref = 0;
    this.pending = new Map(); // ref -> {resolve, reject, timer, topic, event}
    this.topics = new Map(); // topic -> join payload
    this.joined = new Set(); // topics joined on the current socket
    this.listeners = {};
    this.eventHandlers = new Map(); // event -> Set<handler(payload, topic)>
    this.heartbeatInterval = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.hasConnected = false;
    this.closing = false;

    // Kept for callers that read it (listen.js); the last topic joined.
    this.channel = null;
  }

  /** @returns {string} a ref not used before on this client */
  nextRef() {
    this.ref += 1;
    return String(this.ref);
  }

  buildUrl() {
    // Throws unless the URL is wss (ws is allowed only for localhost).
    checkWebSocketUrl(this.websocketUrl);
    // Phoenix WebSocket endpoint requires /websocket suffix for raw WebSocket connections
    let wsUrl = this.websocketUrl;
    if (!wsUrl.endsWith('/websocket')) {
      wsUrl = wsUrl.replace(/\/?$/, '/websocket');
    }
    const separator = wsUrl.includes('?') ? '&' : '?';
    return `${wsUrl}${separator}token=${encodeURIComponent(this.token)}`;
  }

  /**
   * Connect to the WebSocket.
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = this.buildUrl();
      } catch (error) {
        reject(error);
        return;
      }

      if (this.verbose) {
        Logger.info(`Connecting to WebSocket: ${url.split('?')[0]}`);
      }

      const ws = new WebSocket(url);
      this.ws = ws;
      let opened = false;

      ws.on('open', () => {
        opened = true;
        this.hasConnected = true;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        resolve();
      });

      ws.on('error', (error) => {
        if (!opened) {
          reject(error);
        } else if (this.verbose) {
          Logger.warning(`WebSocket error: ${error.message}`);
        }
      });

      ws.on('message', (data) => {
        // A message still arriving on an older socket (one we have replaced
        // with a new connection) is ignored: it must not act on this one.
        if (this.ws !== ws) return;
        this.handleMessage(data);
      });

      ws.on('close', (code, reason) => {
        if (this.ws !== ws) return; // an older socket closing late
        this.stopHeartbeat();
        this.joined.clear();
        this.rejectPending('WebSocket disconnected');

        if (!opened) {
          reject(new Error(`WebSocket closed before it opened (code ${code})`));
        }

        if (this.listeners.close) {
          this.listeners.close(code, reason);
        }

        // A normal close (1000) from the server is final: no reconnect.
        const willReconnect = !this.closing && this.hasConnected && code !== 1000;
        this.emit('close', code, reason ? reason.toString() : '', willReconnect);
        if (willReconnect) {
          this.scheduleReconnect();
        }
      });
    });
  }

  /**
   * Schedule one reconnect attempt with exponential backoff.
   */
  scheduleReconnect() {
    if (this.closing || this.reconnectTimer) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      Logger.error('WebSocket reconnect failed too many times. Giving up.');
      this.emit('reconnect_failed');
      return;
    }

    this.reconnectAttempts += 1;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS
    );
    const limit = Number.isFinite(this.maxReconnectAttempts) ? `/${this.maxReconnectAttempts}` : '';
    Logger.warning(`WebSocket closed. Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}${limit})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect();
    }, delay);
  }

  async reconnect() {
    if (this.closing) return;

    if (this.refreshToken) {
      try {
        const fresh = await this.refreshToken();
        // Check a new URL before using it; a bad one keeps the old URL and
        // counts as a failed attempt.
        const freshUrl = fresh && fresh.websocket_url ? normalizeWebSocketUrl(fresh.websocket_url) : null;
        if (freshUrl) checkWebSocketUrl(freshUrl);
        if (fresh && fresh.ws_token) this.token = fresh.ws_token;
        if (freshUrl) this.websocketUrl = freshUrl;
      } catch (error) {
        Logger.error(`Could not get a new WebSocket token: ${error.message}`);
        this.scheduleReconnect();
        return;
      }
    }

    try {
      // A failed connect closes its socket, and the close handler schedules
      // the next attempt.
      await this.connect();
    } catch (error) {
      if (this.verbose) Logger.error(`Reconnection failed: ${error.message}`);
      return;
    }

    Logger.success('WebSocket reconnected');
    this.emit('reconnect');

    for (const [topic, payload] of this.topics) {
      this.rejoin(topic, payload);
    }
  }

  /**
   * Join a topic again (after a reconnect or a channel crash). Emits "rejoin"
   * (topic) on success and "rejoin_error" (topic, error) on failure.
   */
  rejoin(topic, payload) {
    return this.join(topic, payload).then(
      () => this.emit('rejoin', topic),
      (error) => {
        Logger.error(`Failed to rejoin ${topic}: ${error.message}`);
        this.emit('rejoin_error', topic, error);
      }
    );
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (!this.isOpen()) return;
      this.push('phoenix', 'heartbeat', {}).catch((error) => {
        if (error.reason === 'timeout' && this.ws) {
          // No heartbeat reply: the connection is dead. Closing it starts a reconnect.
          Logger.warning('No heartbeat reply from server; reconnecting.');
          this.ws.terminate();
        }
      });
    }, this.heartbeatIntervalMs);
    if (this.heartbeatInterval.unref) this.heartbeatInterval.unref();
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  isOpen() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  /**
   * Send a message and wait for the server's reply to it.
   * @param {string} topic
   * @param {string} event
   * @param {object} payload
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<object>} the reply's `response` when status is "ok"
   */
  push(topic, event, payload = {}, { timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) {
        reject(new PushError('WebSocket is not connected', { reason: 'disconnected' }));
        return;
      }

      const ref = this.nextRef();
      const timer = setTimeout(() => {
        if (this.pending.delete(ref)) {
          reject(new PushError(`No reply to "${event}" on ${topic}`, { reason: 'timeout' }));
        }
      }, timeoutMs || this.pushTimeoutMs);

      this.pending.set(ref, { resolve, reject, timer, topic, event });

      try {
        this.ws.send(JSON.stringify({ topic, event, payload, ref }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(ref);
        reject(new PushError(`Failed to send "${event}": ${error.message}`, { reason: 'disconnected' }));
      }
    });
  }

  /**
   * Join a Phoenix channel and remember it so it is joined again after a reconnect.
   * @param {string} topic
   * @param {object} [payload]
   * @returns {Promise<object>} the join reply's response
   */
  async join(topic, payload = {}) {
    try {
      this.joined.delete(topic);
      const response = await this.push(topic, 'phx_join', payload);
      this.topics.set(topic, payload);
      this.joined.add(topic);
      this.channel = topic;
      return response;
    } catch (error) {
      if (error.reason === 'timeout') {
        throw new PushError('Channel join timeout', { reason: 'timeout' });
      }
      const detail = error.reply ? describeReply(error.reply) : error.message;
      throw new PushError(`Failed to join channel: ${detail}`, { reply: error.reply, reason: error.reason });
    }
  }

  /**
   * Is the topic joined on the current socket (not disconnected or rejoining)?
   * @param {string} topic
   */
  isJoined(topic) {
    return this.isOpen() && this.joined.has(topic);
  }

  /**
   * Join a Phoenix channel (CLI webhook channel). Kept for existing callers.
   * @param {string} channelName - e.g. "cli_webhooks:user_id"
   * @returns {Promise<object>}
   */
  joinChannel(channelName) {
    return this.join(channelName, {});
  }

  /**
   * Handle incoming WebSocket messages
   * @param {Buffer|string} data
   */
  handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (error) {
      if (this.verbose) {
        Logger.warning(`Failed to parse WebSocket message: ${error.message}`);
      }
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    if (msg.event === 'phx_reply') {
      this.handleReply(msg);
      return;
    }

    if (msg.event === 'phx_error' || msg.event === 'phx_close') {
      if (this.topics.has(msg.topic)) {
        this.joined.delete(msg.topic);
        Logger.warning(`Channel ${msg.topic} ${msg.event === 'phx_error' ? 'crashed' : 'was closed by the server'}`);
        this.emit('channel_' + msg.event.replace('phx_', ''), msg.topic);
        if (msg.event === 'phx_error' && !this.closing) {
          this.rejoin(msg.topic, this.topics.get(msg.topic));
        } else if (msg.event === 'phx_close') {
          this.topics.delete(msg.topic);
        }
      }
      return;
    }

    if (msg.event === 'webhook') {
      if (this.verbose) {
        Logger.info(`\n📨 Webhook event received on channel: ${msg.topic}`);
      }
      if (this.listeners.webhook) {
        this.listeners.webhook(msg.payload);
      }
    }

    const handlers = this.eventHandlers.get(msg.event);
    if (handlers && handlers.size > 0) {
      for (const handler of handlers) {
        try {
          handler(msg.payload, msg.topic);
        } catch (error) {
          Logger.error(`Error handling "${msg.event}": ${error.message}`);
        }
      }
    } else if (this.verbose && msg.event !== 'webhook') {
      Logger.info(`Received event: ${msg.event} on topic: ${msg.topic}`);
    }
  }

  handleReply(msg) {
    const entry = msg.ref != null ? this.pending.get(String(msg.ref)) : null;
    if (!entry || entry.topic !== msg.topic) return;

    this.pending.delete(String(msg.ref));
    clearTimeout(entry.timer);

    const reply = msg.payload || {};
    if (reply.status === 'ok') {
      // Joined from this moment. The server may send a message right behind
      // the join reply, and it is handled before join()'s caller runs again:
      // an answer to it must be sendable.
      if (entry.event === 'phx_join') this.joined.add(entry.topic);
      entry.resolve(reply.response ?? {});
    } else {
      entry.reject(new PushError(
        `"${entry.event}" on ${entry.topic} was refused: ${describeReply(reply)}`,
        { reply, reason: reply.status || 'error' }
      ));
    }
  }

  rejectPending(message) {
    for (const [ref, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new PushError(message, { reason: 'disconnected' }));
      this.pending.delete(ref);
    }
  }

  /**
   * Subscribe to a server event (any topic).
   * @param {string} event
   * @param {Function} handler - (payload, topic) => void
   * @returns {Function} unsubscribe
   */
  on(event, handler) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
    this.eventHandlers.get(event).add(handler);
    return () => this.eventHandlers.get(event).delete(handler);
  }

  emit(name, ...args) {
    const handlers = this.eventHandlers.get(`client:${name}`);
    if (!handlers) return;
    for (const handler of handlers) handler(...args);
  }

  /**
   * Listen for client lifecycle events: "close" (code, reason, willReconnect),
   * "reconnect", "reconnect_failed", "rejoin" (topic), "rejoin_error" (topic, error),
   * "channel_error" (topic), "channel_close" (topic).
   */
  onClient(name, handler) {
    return this.on(`client:${name}`, handler);
  }

  /**
   * Listen for webhook events
   * @param {Function} callback
   */
  onWebhook(callback) {
    this.listeners.webhook = callback;
  }

  /**
   * Listen for close events
   * @param {Function} callback
   */
  onClose(callback) {
    this.listeners.close = callback;
  }

  /**
   * Close the WebSocket connection; no reconnect follows.
   */
  close() {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.rejectPending('WebSocket closed');
    if (this.ws) {
      this.ws.close(1000, 'CLI shutdown');
    }
  }
}

function describeReply(reply) {
  const response = reply && reply.response;
  if (!response) return 'Unknown error';
  if (typeof response === 'string') return response;
  return response.reason || response.error || response.message || JSON.stringify(response);
}

module.exports = CLIWebSocketClient;
module.exports.PushError = PushError;
