const { WebSocketServer } = require('ws');
const WebSocketClient = require('./websocket-client');

describe('WebSocketClient (websocket command)', () => {
  it('refuses a server-given ws:// URL for a host other than localhost', async () => {
    const client = new WebSocketClient('ws://api.example.com/socket', 'tok');
    await expect(client.connect()).rejects.toThrow(/must use wss/);
    expect(client.ws).toBeNull();
  });

  it('passes other events to their listener, and still passes response events on', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => wss.on('listening', resolve));
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.event !== 'phx_join') return;
        socket.send(JSON.stringify({ topic: msg.topic, event: 'phx_reply', ref: msg.ref, payload: { status: 'ok', response: {} } }));
        socket.send(JSON.stringify({ topic: msg.topic, event: 'tool_state', ref: null, payload: { calls: [] } }));
        socket.send(JSON.stringify({ topic: msg.topic, event: 'tool_approval_required', ref: null, payload: { id: 'tc_1' } }));
        socket.send(JSON.stringify({ topic: msg.topic, event: 'response', ref: null, payload: { status: 'success' } }));
      });
    });

    const client = new WebSocketClient(`ws://127.0.0.1:${wss.address().port}/socket`, 'tok');
    const seen = [];
    const responded = new Promise((resolve) => client.onResponse(resolve));
    client.onEvent('tool_state', (p) => seen.push(['tool_state', p]));
    client.onEvent('tool_approval_required', (p) => seen.push(['tool_approval_required', p]));
    try {
      await client.connect();
      await client.joinChannel('ai_response:p:c');
      await expect(responded).resolves.toEqual({ status: 'success' });
      expect(seen).toEqual([['tool_state', { calls: [] }], ['tool_approval_required', { id: 'tc_1' }]]);
      // Events with a listener print themselves, not the generic line.
      expect(log.mock.calls.flat().join('\n')).not.toMatch(/received event: tool_approval_required/);
    } finally {
      client.close();
      wss.close();
      log.mockRestore();
    }
  });
});
