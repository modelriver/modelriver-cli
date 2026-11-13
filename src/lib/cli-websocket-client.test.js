const { WebSocketServer } = require('ws');
const CLIWebSocketClient = require('./cli-websocket-client');
const { PushError } = CLIWebSocketClient;

/**
 * A small Phoenix-like server. `onMessage(msg, socket)` decides how to answer;
 * the default replies ok to everything.
 */
function startServer() {
  const state = {
    connections: [],
    messages: [],
    tokens: [],
    onMessage: (msg, socket) => reply(socket, msg, 'ok', {}),
  };
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (socket, req) => {
    state.tokens.push(new URL(req.url, 'http://x').searchParams.get('token'));
    state.connections.push(socket);
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      state.messages.push(msg);
      state.onMessage(msg, socket);
    });
  });
  return new Promise((resolve) => wss.on('listening', () => {
    state.wss = wss;
    state.url = `ws://127.0.0.1:${wss.address().port}/cli`;
    resolve(state);
  }));
}

function reply(socket, msg, status, response) {
  socket.send(JSON.stringify({ topic: msg.topic, event: 'phx_reply', ref: msg.ref, payload: { status, response } }));
}

function waitFor(check, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('CLIWebSocketClient', () => {
  let server;
  let client;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    if (client) client.close();
    client = null;
    for (const socket of server.connections) socket.terminate();
    await new Promise((resolve) => server.wss.close(resolve));
  });

  it('connects to <url>/websocket with the token', async () => {
    client = new CLIWebSocketClient(server.url, 'tok-1');
    await client.connect();
    expect(server.tokens).toEqual(['tok-1']);
  });

  it('gives every push a unique ref and settles each by its own reply', async () => {
    const held = [];
    server.onMessage = (msg, socket) => held.push({ msg, socket });

    client = new CLIWebSocketClient(server.url, 'tok');
    await client.connect();

    const a = client.push('cli_tools:s1', 'tool_result', { n: 1 });
    const b = client.push('cli_tools:s1', 'tool_result', { n: 2 });
    const c = client.push('cli_tools:s1', 'tool_result', { n: 3 });

    await waitFor(() => held.length === 3);
    const refs = held.map((h) => h.msg.ref);
    expect(new Set(refs).size).toBe(3);

    // Answer out of order; each promise gets its own reply.
    for (const { msg, socket } of [held[2], held[0], held[1]]) {
      reply(socket, msg, 'ok', { echo: msg.payload.n });
    }

    await expect(a).resolves.toEqual({ echo: 1 });
    await expect(b).resolves.toEqual({ echo: 2 });
    await expect(c).resolves.toEqual({ echo: 3 });
    expect(client.pending.size).toBe(0);
  });

  it('ignores replies with an unknown ref or the wrong topic', async () => {
    let socketRef;
    server.onMessage = (msg, socket) => {
      socketRef = socket;
      socket.send(JSON.stringify({ topic: msg.topic, event: 'phx_reply', ref: '999', payload: { status: 'ok', response: 'wrong ref' } }));
      socket.send(JSON.stringify({ topic: 'other:topic', event: 'phx_reply', ref: msg.ref, payload: { status: 'ok', response: 'wrong topic' } }));
      reply(socket, msg, 'ok', 'right');
    };

    client = new CLIWebSocketClient(server.url, 'tok');
    await client.connect();
    await expect(client.push('cli_tools:s1', 'tool_result', {})).resolves.toBe('right');
    expect(socketRef).toBeDefined();
  });

  it('rejects with PushError holding the reply when the server answers error', async () => {
    server.onMessage = (msg, socket) => reply(socket, msg, 'error', { reason: 'unknown_reply_ref' });

    client = new CLIWebSocketClient(server.url, 'tok');
    await client.connect();

    const error = await client.push('cli_tools:s1', 'tool_result', {}).catch((e) => e);
    expect(error).toBeInstanceOf(PushError);
    expect(error.reason).toBe('error');
    expect(error.reply).toEqual({ status: 'error', response: { reason: 'unknown_reply_ref' } });
    expect(error.message).toMatch(/unknown_reply_ref/);
  });

  it('rejects on timeout and forgets the ref', async () => {
    server.onMessage = () => {};

    client = new CLIWebSocketClient(server.url, 'tok');
    await client.connect();

    const error = await client.push('cli_tools:s1', 'tool_result', {}, { timeoutMs: 50 }).catch((e) => e);
    expect(error).toBeInstanceOf(PushError);
    expect(error.reason).toBe('timeout');
    expect(client.pending.size).toBe(0);
  });

  it('rejects at once when not connected', async () => {
    client = new CLIWebSocketClient(server.url, 'tok');
    await expect(client.push('t', 'e', {})).rejects.toMatchObject({ reason: 'disconnected' });
  });

  it('joins several topics and routes events to handlers', async () => {
    client = new CLIWebSocketClient(server.url, 'tok');
    await client.connect();
    await client.join('cli_webhooks:u1');
    await client.join('cli_tools:s1', { a: 1 });

    expect([...client.topics.keys()]).toEqual(['cli_webhooks:u1', 'cli_tools:s1']);
    const joins = server.messages.filter((m) => m.event === 'phx_join');
    expect(joins.map((m) => m.topic)).toEqual(['cli_webhooks:u1', 'cli_tools:s1']);
    expect(joins[1].payload).toEqual({ a: 1 });

    const seen = [];
    client.on('tool_call', (payload, topic) => seen.push({ payload, topic }));
    const webhooks = [];
    client.onWebhook((payload) => webhooks.push(payload));

    const socket = server.connections[0];
    socket.send(JSON.stringify({ topic: 'cli_tools:s1', event: 'tool_call', ref: null, payload: { call_id: 'c1' } }));
    socket.send(JSON.stringify({ topic: 'cli_webhooks:u1', event: 'webhook', ref: null, payload: { channel_id: 'ch' } }));

    await waitFor(() => seen.length === 1 && webhooks.length === 1);
    expect(seen[0]).toEqual({ payload: { call_id: 'c1' }, topic: 'cli_tools:s1' });
    expect(webhooks[0]).toEqual({ channel_id: 'ch' });
  });

  it('reports a refused join with the server reason', async () => {
    server.onMessage = (msg, socket) => reply(socket, msg, 'error', { reason: 'session_expired' });
    client = new CLIWebSocketClient(server.url, 'tok');
    await client.connect();
    await expect(client.join('cli_tools:s1')).rejects.toThrow('Failed to join channel: session_expired');
    expect(client.topics.size).toBe(0);
  });

  it('keeps joinChannel working for existing callers', async () => {
    client = new CLIWebSocketClient(server.url, 'tok');
    await client.connect();
    await client.joinChannel('cli_webhooks:u1');
    expect(client.channel).toBe('cli_webhooks:u1');
  });

  it('on reconnect, fetches a fresh token and rejoins every topic', async () => {
    const refreshToken = jest.fn(async () => ({ ws_token: 'tok-2', websocket_url: server.url }));
    client = new CLIWebSocketClient(server.url, 'tok-1', false, {
      refreshToken,
      reconnectDelayMs: 10,
      maxReconnectAttempts: 3,
    });
    const warn = jest.spyOn(console, 'log').mockImplementation(() => {});

    await client.connect();
    await client.join('cli_webhooks:u1');
    await client.join('cli_tools:s1');

    // A push in flight when the socket drops is rejected, not left hanging.
    server.onMessage = (msg, socket) => {
      if (msg.event === 'tool_result') return;
      reply(socket, msg, 'ok', {});
    };
    const inFlight = client.push('cli_tools:s1', 'tool_result', {});
    await waitFor(() => server.messages.some((m) => m.event === 'tool_result'));

    const reconnected = new Promise((resolve) => client.onClient('reconnect', resolve));
    server.connections[0].terminate();

    await expect(inFlight).rejects.toMatchObject({ reason: 'disconnected' });
    await reconnected;
    await waitFor(() => server.messages.filter((m) => m.event === 'phx_join').length === 4);

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(server.tokens).toEqual(['tok-1', 'tok-2']);
    const rejoined = server.messages.filter((m) => m.event === 'phx_join').slice(2).map((m) => m.topic);
    expect(rejoined.sort()).toEqual(['cli_tools:s1', 'cli_webhooks:u1']);

    // Refs keep increasing across the reconnect.
    const refs = server.messages.map((m) => Number(m.ref));
    expect(new Set(refs).size).toBe(refs.length);
    warn.mockRestore();
  });

  it('does not reconnect after close()', async () => {
    const refreshToken = jest.fn(async () => ({ ws_token: 'tok-2' }));
    client = new CLIWebSocketClient(server.url, 'tok-1', false, { refreshToken, reconnectDelayMs: 10 });
    await client.connect();
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(refreshToken).not.toHaveBeenCalled();
    expect(server.tokens).toEqual(['tok-1']);
  });
});
