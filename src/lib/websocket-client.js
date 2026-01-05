const WebSocket = require('ws');

class WebSocketClient {
  constructor(websocketUrl, token, verbose = false) {
    this.websocketUrl = websocketUrl;
    this.token = token;
    this.verbose = verbose;
    this.ws = null;
    this.channel = null;
    this.listeners = {};
    this.heartbeatInterval = null;
    this.heartbeatRef = 0;
  }

  /**
   * Connect to WebSocket
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      const url = `${this.websocketUrl}/websocket?token=${encodeURIComponent(this.token)}`;

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        // Start sending heartbeats every 30 seconds (Phoenix default is 30s)
        this.startHeartbeat();
        resolve();
      });

      this.ws.on('error', (error) => {
        this.stopHeartbeat();
        reject(error);
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', () => {
        this.stopHeartbeat();
        if (this.listeners.close) {
          this.listeners.close();
        }
      });
    });
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
   * Join a Phoenix channel
   * @param {string} channelName - Channel name (e.g., "ai_response:project_id:channel_id")
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

      // Set up a temporary listener for the join response
      // This will process the response and then be removed
      const handleJoinResponse = (data) => {
        if (resolved) return;

        try {
          const msg = JSON.parse(data.toString());
          // Look for the join response (phx_reply with our ref)
          if (msg.event === 'phx_reply' && msg.ref === joinRef && msg.topic === channelName) {
            resolved = true;
            // Remove this listener - handleMessage() will continue processing other messages
            this.ws.removeListener('message', handleJoinResponse);
            
            if (msg.payload.status === 'ok') {
              this.channel = channelName;
              resolve(msg.payload);
            } else {
              reject(new Error(`Failed to join channel: ${msg.payload.response || 'Unknown error'}`));
            }
          }
        } catch (error) {
          // Ignore parse errors, wait for next message
        }
      };

      // Add listener for join response
      // The handleMessage() listener in connect() will also be called, but won't match
      this.ws.on('message', handleJoinResponse);
      
      this.ws.send(joinMsg);

      // Timeout after 10 seconds
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

      const Logger = require('../utils/logger'); // Lazy load to avoid circular dependency if any

      // Log all events for debugging purposes (except heartbeats and phx_reply unless verbose)
      if (this.verbose) {
        // In verbose mode, log ALL messages including raw JSON
        if (msg.event !== 'heartbeat') {
          Logger.info(`\n📨 Received WebSocket message:`);
          Logger.info(`   Event: ${msg.event}`);
          Logger.info(`   Topic: ${msg.topic}`);
          Logger.info(`   Payload keys: ${msg.payload ? Object.keys(msg.payload).join(', ') : 'none'}`);
          if (msg.event === 'response') {
            Logger.info(`   ✅ This is a RESPONSE event!`);
          }
        }
      } else {
        // In non-verbose mode, only log non-standard events
        if (msg.event !== 'phx_reply' && msg.event !== 'heartbeat' && msg.event !== 'response') {
          Logger.info(`received event: ${msg.event} on topic: ${msg.topic}`);
        }
      }

      // Handle response events
      if (msg.event === 'response') {
        if (this.verbose) {
          Logger.info(`\n✅ Processing response event...`);
        }
        if (this.listeners.response) {
          this.listeners.response(msg.payload);
        } else if (this.verbose) {
          Logger.warning(`⚠️  Response event received but no listener registered!`);
        }
      } else if (msg.event === 'phx_reply') {
        // Handle join responses
        if (this.listeners.join) {
          this.listeners.join(msg);
        }
      }
    } catch (error) {
      // Log parse errors in verbose mode
      if (this.verbose) {
        const Logger = require('../utils/logger');
        Logger.warning(`Failed to parse WebSocket message: ${error.message}`);
      }
    }
  }

  /**
   * Listen for response events
   * @param {Function} callback - Callback function
   */
  onResponse(callback) {
    this.listeners.response = callback;
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
      this.ws.close();
    }
  }
}

module.exports = WebSocketClient;

