// Runs the real `modelriver tools` command against a mock ModelRiver API,
// Phoenix socket and local tool server.
const fs = require('fs');
const http = require('http');
const os = require('os');
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
    expect(output).toContain('Project: p1');
  }, 15000);

  // Mock API + socket; `onJoin(ws, msg)` runs after an ok join reply.
  async function startApi(onJoin = () => {}) {
    const hits = [];
    api = http.createServer((req, res) => {
      hits.push(req.url);
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
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'heartbeat') return;
        ws.send(JSON.stringify({ topic: msg.topic, event: 'phx_reply', ref: msg.ref, payload: { status: 'ok', response: {} } }));
        if (msg.event === 'phx_join') onJoin(ws, msg);
      });
    });
    await listen(api);
    return hits;
  }

  function runCli(args, { env = {}, cwd } = {}) {
    child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code, output })));
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`CLI did not exit. Output:\n${output}`)), 10000).unref());
    return Promise.race([exited, timeout]);
  }

  it('refuses an API key that comes from a .modelriverrc in the current directory', async () => {
    const hits = await startApi();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'modelriver-cloned-repo-'));
    try {
      fs.writeFileSync(path.join(repo, '.modelriverrc'), JSON.stringify({ api_key: 'mr_live_planted_key_0123456789' }));
      const { code, output } = await runCli(
        ['tools', '--forward-to', 'http://localhost:3000', '--api-url', `http://localhost:${api.address().port}`],
        { cwd: repo }
      );
      expect(code).toBe(1);
      expect(output).toMatch(/does not use the API key in .*\.modelriverrc/);
      expect(output).not.toContain('mr_live_planted_key_0123456789');
      expect(hits).toEqual([]); // never talked to the API
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 15000);

  it('on Ctrl+C answers a call still in flight with connection_failed, then exits', async () => {
    // A tool server that never answers.
    toolServer = http.createServer(() => {});
    await listen(toolServer);
    const results = [];
    let callForwarded;
    const forwarded = new Promise((resolve) => { callForwarded = resolve; });
    toolServer.on('request', () => callForwarded());

    await startApi((ws, msg) => {
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString());
        if (m.event === 'tool_result') results.push(m.payload);
      });
      ws.send(JSON.stringify({
        topic: msg.topic, event: 'tool_call', ref: null,
        payload: { reply_ref: 'rr_ctrl_c', tool: 'slow_tool', path: '/slow', body: '{}', headers: {}, timeout_ms: 60000 },
      }));
    });

    const run = runCli(
      ['tools', '--forward-to', `http://localhost:${toolServer.address().port}`, '--api-url', `http://localhost:${api.address().port}`],
      { env: { MODELRIVER_API_KEY: 'mr_test_e2e_abcdefghijklmnopqrstuvwxyz' } }
    );
    await forwarded;
    const sent = Date.now();
    child.kill('SIGINT');
    const { code, output } = await run;

    expect(code).toBe(0);
    expect(Date.now() - sent).toBeLessThan(3000);
    expect(results).toEqual([{ reply_ref: 'rr_ctrl_c', error: 'connection_failed' }]);
    expect(output).toContain('Stopping tool forwarding');
  }, 15000);

  it('exits non-zero when the server closes the socket normally (code 1000)', async () => {
    await startApi((ws) => setTimeout(() => ws.close(1000, 'session ended'), 50));
    const { code, output } = await runCli(
      ['tools', '--forward-to', 'http://localhost:3000', '--api-url', `http://localhost:${api.address().port}`],
      { env: { MODELRIVER_API_KEY: 'mr_test_e2e_abcdefghijklmnopqrstuvwxyz' } }
    );
    expect(output).toContain('Tool forwarding active');
    expect(output).toMatch(/server closed the connection \(code 1000: session ended\)/);
    expect(code).toBe(1);
  }, 15000);
});
