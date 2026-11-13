// Runs the real `modelriver tools` command against a mock ModelRiver API,
// Phoenix socket and local tool server.
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const CLI = path.join(__dirname, '..', 'bin', 'modelriver');
const TOKEN = 'cts_mock_session_token_0123456789';
const CHANNEL = 'cli_tools:5d6e7f80-aaaa-bbbb-cccc-000000000001';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

describe('modelriver tools (end to end)', () => {
  let toolServer;
  let api;
  let wss;
  let child;
  const frames = [];
  const toolRequests = [];

  afterEach(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    if (wss) for (const ws of wss.clients) ws.terminate();
    for (const server of [api, toolServer]) {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });

  it('joins the returned channel with session_token and answers tool_call with tool_result', async () => {
    toolServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        toolRequests.push({ url: req.url, body, signature: req.headers['x-modelriver-signature'] });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"temp":21}');
      });
    });
    await listen(toolServer);

    api = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v1/cli/connect') {
        res.writeHead(200);
        return res.end(JSON.stringify({ ws_token: 'ws-tok', websocket_url: `ws://127.0.0.1:${api.address().port}/cli` }));
      }
      if (req.url === '/api/v1/cli/tool-sessions') {
        res.writeHead(201);
        return res.end(JSON.stringify({ session_id: TOKEN, channel: CHANNEL, expires_at: '2026-11-15T00:00:00Z', project_id: 'p1' }));
      }
      res.writeHead(404);
      return res.end('{}');
    });
    wss = new WebSocketServer({ server: api });
    await listen(api);

    const done = new Promise((resolve) => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.event === 'heartbeat') return;
          frames.push(msg);

          if (msg.event === 'phx_join') {
            const ok = msg.payload && msg.payload.session_token === TOKEN;
            ws.send(JSON.stringify({
              topic: msg.topic, event: 'phx_reply', ref: msg.ref,
              payload: ok
                ? { status: 'ok', response: { session_id: '5d6e7f80', expires_at: '2026-11-15T00:00:00Z' } }
                : { status: 'error', response: { reason: 'unauthorized' } },
            }));
            if (ok) {
              ws.send(JSON.stringify({
                topic: msg.topic, event: 'tool_call', ref: null,
                payload: {
                  call_id: 'call_1', reply_ref: 'rr_1', tool: 'get_weather', path: '/tools/weather',
                  body: '{"arguments":{"city":"Pune"}}',
                  headers: { 'content-type': 'application/json', 'x-modelriver-signature': 'v2=abc' },
                  timeout_ms: 2000, max_result_bytes: 1024,
                },
              }));
            }
          } else if (msg.event === 'tool_result') {
            ws.send(JSON.stringify({ topic: msg.topic, event: 'phx_reply', ref: msg.ref, payload: { status: 'ok', response: { status: 'received' } } }));
            resolve();
          }
        });
      });
    });

    child = spawn(process.execPath, [
      CLI, 'tools',
      '--forward-to', `http://localhost:${toolServer.address().port}`,
      '--api-url', `http://localhost:${api.address().port}`,
    ], { env: { ...process.env, MODELRIVER_API_KEY: 'mr_test_e2e_abcdefghijklmnopqrstuvwxyz' } });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });

    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`No tool_result within 10s. Frames: ${JSON.stringify(frames)}\nCLI output:\n${output}`)), 10000);
    });
    try {
      await Promise.race([done, timedOut]);
    } finally {
      clearTimeout(timer);
    }

    const join = frames.find((m) => m.event === 'phx_join');
    expect(join.topic).toBe(CHANNEL);
    expect(join.payload).toEqual({ session_token: TOKEN });

    expect(toolRequests).toEqual([{ url: '/tools/weather', body: '{"arguments":{"city":"Pune"}}', signature: 'v2=abc' }]);

    const result = frames.find((m) => m.event === 'tool_result');
    expect(result.topic).toBe(CHANNEL);
    expect(result.payload).toEqual({ reply_ref: 'rr_1', status: 200, body: '{"temp":21}' });

    expect(output).toContain(`"tool_route": {"cli_session": "${TOKEN}"}`);
  }, 15000);
});
