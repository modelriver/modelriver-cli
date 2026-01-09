const WebSocket = require('ws');

class CLIWebSocketClient {
  constructor(websocketUrl, token, verbose = false) {
    this.websocketUrl = websocketUrl;
    this.token = token;
    this.verbose = verbose;
    this.ws = null;
    this.channel = null;
    this.listeners = {};
    this.heartbeatInterval = null;
    this.heartbeatRef = 0;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000; // Start with 1 second
  }

  /**
   * Connect to WebSocket
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      // Phoenix WebSocket endpoint requires /websocket suffix for raw WebSocket connections
      let wsUrl = this.websocketUrl;
      if (!wsUrl.endsWith('/websocket')) {
        wsUrl = wsUrl.replace(/\/?$/, '/websocket');
      }
      const url = `${wsUrl}?token=${encodeURIComponent(this.token)}`;

      if (this.verbose) {
        const Logger = require('../utils/logger');
        Logger.info(`Connecting to WebSocket: ${url.replace(this.token, 'TOKEN')}`);
      }

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.startHeartbeat();
        resolve();
      });

      this.ws.on('error', (error) => {
        this.stopHeartbeat();
        if (this.reconnectAttempts === 0) {
          reject(error);
        }
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code, reason) => {
        this.stopHeartbeat();
        if (this.listeners.close) {
          this.listeners.close(code, reason);
        }
        // Attempt reconnection if not intentional close
        if (code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.attemptReconnect();
        }
      });
    });
  }

  /**
   * Attempt to reconnect to WebSocket
   */
  attemptReconnect() {
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);

    const Logger = require('../utils/logger');
    Logger.warning(`WebSocket closed. Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.CLOSED) {
        this.connect()
          .then(() => {
            Logger.success('WebSocket reconnected');
            // Rejoin channel if we had one
            if (this.channel) {
              this.joinChannel(this.channel).catch(err => {
                Logger.error(`Failed to rejoin channel: ${err.message}`);
              });
            }
          })
          .catch(err => {
            Logger.error(`Reconnection failed: ${err.message}`);
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
              this.attemptReconnect();
            }
          });
      }
    }, delay);
  }

  /**
   * Start sending Phoenix heartbeats
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.heartbeatRef++;
        const heartbeat = JSON.stringify({
          topic: 'phoenix',
          event: 'heartbeat',
          payload: {},
          ref: `heartbeat-${this.heartbeatRef}`
        });
        this.ws.send(heartbeat);
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop sending heartbeats
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Join a Phoenix channel (CLI webhook channel)
   * @param {string} channelName - Channel name (e.g., "cli_webhooks:user_id")
   * @returns {Promise<object>} - Join response
   */
  joinChannel(channelName) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket is not connected'));
        return;
      }

      const joinRef = '1';

      const joinMsg = JSON.stringify({
        topic: channelName,
        event: 'phx_join',
        payload: {},
        ref: joinRef
      });

      let resolved = false;

      const handleJoinResponse = (data) => {
        if (resolved) return;

        try {
          const msg = JSON.parse(data.toString());
          if (msg.event === 'phx_reply' && msg.ref === joinRef && msg.topic === channelName) {
            resolved = true;
            this.ws.removeListener('message', handleJoinResponse);

            if (msg.payload.status === 'ok') {
              this.channel = channelName;
              resolve(msg.payload);
            } else {
              reject(new Error(`Failed to join channel: ${msg.payload.response || 'Unknown error'}`));
            }
          }
        } catch (error) {
          // Ignore parse errors
        }
      };

      this.ws.on('message', handleJoinResponse);
      this.ws.send(joinMsg);

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.ws.removeListener('message', handleJoinResponse);
          reject(new Error('Channel join timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Handle incoming WebSocket messages
   * @param {Buffer} data - Message data
   */
  handleMessage(data) {
    try {
      const msgStr = data.toString();
      const msg = JSON.parse(msgStr);

      const Logger = require('../utils/logger');

      // Handle webhook events
      if (msg.event === 'webhook') {
        if (this.verbose) {
          Logger.info(`\n📨 Webhook event received on channel: ${msg.topic}`);
        }
        if (this.listeners.webhook) {
          this.listeners.webhook(msg.payload);
        }
      } else if (msg.event === 'phx_reply') {
        // Handle join responses
        if (this.listeners.join) {
          this.listeners.join(msg);
        }
      } else if (this.verbose && msg.event !== 'heartbeat') {
        Logger.info(`Received event: ${msg.event} on topic: ${msg.topic}`);
      }
    } catch (error) {
      if (this.verbose) {
        const Logger = require('../utils/logger');
        Logger.warning(`Failed to parse WebSocket message: ${error.message}`);
      }
    }
  }

  /**
   * Listen for webhook events
   * @param {Function} callback - Callback function
   */
  onWebhook(callback) {
    this.listeners.webhook = callback;
  }

  /**
   * Listen for close events
   * @param {Function} callback - Callback function
   */
  onClose(callback) {
    this.listeners.close = callback;
  }

  /**
   * Close WebSocket connection
   */
  close() {
    if (this.ws) {
      this.ws.close(1000, 'CLI shutdown');
      this.stopHeartbeat();
    }
  }
}

module.exports = CLIWebSocketClient;

