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

// Session expiry a day from now (a fixed date would make the CLI's expiry
// exit fire once that date has passed).
function inADay() {
  return new Date(Date.now() + 24 * 3600 * 1000).toISOString();
}

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
        return res.end(JSON.stringify({ session_id: TOKEN, channel: CHANNEL, expires_at: inADay(), project_id: 'p1' }));
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
                ? { status: 'ok', response: { session_id: '5d6e7f80', expires_at: inADay() } }
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
        return res.end(JSON.stringify({ session_id: TOKEN, channel: CHANNEL, expires_at: inADay(), project_id: 'p1' }));
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

  describe('restarting the CLI', () => {
    const ToolSessionStore = require('../src/lib/tool-session-store');
    const API_KEY = 'mr_test_e2e_abcdefghijklmnopqrstuvwxyz';
    const OLD_TOKEN = 'cts_old_session_token_0123456789abcd';
    const OLD_CHANNEL = 'cli_tools:5d6e7f80-aaaa-bbbb-cccc-00000000000f';
    let sessionPosts;
    let joins;
    let results;
    let toolHits;

    // Mock API, socket and tool server. `onJoin(ws, msg, nth)` runs after
    // each accepted join; joins of `refuse` topics get "unauthorized".
    async function startAll({ onJoin = () => {}, refuse = [], sessionsOff = false, expiresAt = inADay } = {}) {
      sessionPosts = 0;
      joins = [];
      results = [];
      toolHits = [];
      toolServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          toolHits.push(JSON.parse(body).id);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
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
          sessionPosts += 1;
          if (sessionsOff) {
            res.writeHead(404);
            return res.end(JSON.stringify({ message: 'Hosted tools are not available for this organization' }));
          }
          res.writeHead(201);
          return res.end(JSON.stringify({ session_id: TOKEN, channel: CHANNEL, expires_at: expiresAt(), project_id: 'p1' }));
        }
        res.writeHead(404);
        return res.end('{}');
      });
      wss = new WebSocketServer({ server: api });
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.event === 'heartbeat') return;
          if (msg.event === 'phx_join') {
            joins.push({ topic: msg.topic, payload: msg.payload });
            if (refuse.includes(msg.topic)) {
              ws.send(JSON.stringify({ topic: msg.topic, event: 'phx_reply', ref: msg.ref, payload: { status: 'error', response: { reason: 'unauthorized' } } }));
              return;
            }
            ws.send(JSON.stringify({ topic: msg.topic, event: 'phx_reply', ref: msg.ref, payload: { status: 'ok', response: {} } }));
            onJoin(ws, msg, joins.length);
            return;
          }
          if (msg.event === 'tool_result') results.push(msg.payload);
          ws.send(JSON.stringify({ topic: msg.topic, event: 'phx_reply', ref: msg.ref, payload: { status: 'ok', response: { status: 'received' } } }));
        });
      });
      await listen(api);
    }

    const toolCall = (ws, topic, callId, replyRef) => ws.send(JSON.stringify({
      topic, event: 'tool_call', ref: null,
      payload: {
        call_id: callId, reply_ref: replyRef, tool: 'cancel_order', effect: 'write', path: '/tools/cancel',
        body: JSON.stringify({ id: callId }), headers: { 'content-type': 'application/json' }, timeout_ms: 2000, max_result_bytes: 1024,
      },
    }));

    const cliArgs = (extra = []) => [
      'tools', '--forward-to', `http://localhost:${toolServer.address().port}`,
      '--api-url', `http://localhost:${api.address().port}`, ...extra,
    ];

    function start(args) {
      child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, MODELRIVER_API_KEY: API_KEY } });
      const run = { output: '' };
      child.stdout.on('data', (d) => { run.output += d; });
      child.stderr.on('data', (d) => { run.output += d; });
      return run;
    }

    async function until(check, what, run) {
      const deadline = Date.now() + 8000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. CLI output:\n${run ? run.output : ''}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    async function kill() {
      const exited = new Promise((resolve) => child.on('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }

    const storeKey = () => ToolSessionStore.keyFor({
      apiUrl: `http://localhost:${api.address().port}`, apiKey: API_KEY, origin: `http://localhost:${toolServer.address().port}`,
    });

    it('rejoins the session it had, without printing its ID again, and never forwards a call twice', async () => {
      await startAll({
        onJoin: (ws, msg, nth) => {
          if (nth === 1) {
            toolCall(ws, msg.topic, 'tc_one', 'rr_1');
          } else {
            // The server never sends a call again. If one did come back
            // under a new reply_ref, it must not reach the local server.
            toolCall(ws, msg.topic, 'tc_one', 'rr_2');
            toolCall(ws, msg.topic, 'tc_two', 'rr_3');
          }
        },
      });

      const first = start(cliArgs());
      await until(() => results.length === 1, 'the first result', first);
      expect(first.output).toContain(`"tool_route": {"cli_session": "${TOKEN}"}`);
      expect(first.output).toMatch(/starting "modelriver tools" again[\s\S]*rejoins this session/);
      await kill(); // killed, not stopped: nothing is cleaned up

      const second = start(cliArgs());
      await until(() => results.length === 3, 'the results of the second run', second);
      await until(() => second.output.includes('--new-session'), 'the startup text', second);

      expect(sessionPosts).toBe(1); // no second session was opened
      expect(joins).toEqual([
        { topic: CHANNEL, payload: { session_token: TOKEN } },
        { topic: CHANNEL, payload: { session_token: TOKEN } },
      ]);
      expect(toolHits).toEqual(['tc_one', 'tc_two']); // tc_one reached the server once
      expect(results).toEqual([
        { reply_ref: 'rr_1', status: 200, body: '{"ok":true}' },
        { reply_ref: 'rr_2', error: 'connection_failed' },
        { reply_ref: 'rr_3', status: 200, body: '{"ok":true}' },
      ]);
      expect(second.output).toContain('Session: cts_…6789 (rejoined');
      expect(second.output).not.toContain(TOKEN);
      expect(second.output).toMatch(/Not forwarding cancel_order \[write\] \(call tc_one\) again/);
    }, 30000);

    it('opens a new session, and says so, when the saved one can no longer be joined', async () => {
      await startAll({ refuse: [OLD_CHANNEL] });
      const store = new ToolSessionStore();
      store.save(storeKey(), { session_id: OLD_TOKEN, channel: OLD_CHANNEL, expires_at: new Date(Date.now() + 2 * 3600 * 1000).toISOString(), project_id: 'p1' });

      const run = start(cliArgs());
      await until(() => run.output.includes('Press Ctrl+C'), 'the CLI to start', run);

      expect(joins.map((join) => join.topic)).toEqual([OLD_CHANNEL, CHANNEL]);
      expect(sessionPosts).toBe(1);
      expect(run.output).toMatch(/saved tool session \(cts_…abcd\) can no longer be joined; opening a new one/);
      expect(run.output).not.toContain(OLD_TOKEN);
      expect(run.output).toContain(`"tool_route": {"cli_session": "${TOKEN}"}`);
      // The new session replaced the old one on disk.
      expect(store.load(storeKey())).toMatchObject({ session_id: TOKEN, channel: CHANNEL });
    }, 30000);

    it('keeps the saved session when a new one cannot be opened either', async () => {
      // Hosted tools switched off for the organization: the join is refused
      // and so is a new session. The saved one must survive for later.
      await startAll({ refuse: [OLD_CHANNEL], sessionsOff: true });
      const store = new ToolSessionStore();
      store.save(storeKey(), { session_id: OLD_TOKEN, channel: OLD_CHANNEL, expires_at: new Date(Date.now() + 2 * 3600 * 1000).toISOString(), project_id: 'p1' });

      const run = start(cliArgs());
      const code = await new Promise((resolve) => child.on('exit', resolve));

      expect(code).toBe(1);
      expect(sessionPosts).toBe(1);
      expect(run.output).toContain('Hosted tools are not available');
      expect(run.output).not.toContain(OLD_TOKEN);
      expect(store.load(storeKey())).toMatchObject({ session_id: OLD_TOKEN, channel: OLD_CHANNEL });
    }, 30000);

    it('opens a new session instead of rejoining a saved one with less than an hour left', async () => {
      await startAll();
      const store = new ToolSessionStore();
      store.save(storeKey(), { session_id: OLD_TOKEN, channel: OLD_CHANNEL, expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), project_id: 'p1' });

      const run = start(cliArgs());
      await until(() => run.output.includes('Press Ctrl+C'), 'the CLI to start', run);

      expect(joins.map((join) => join.topic)).toEqual([CHANNEL]);
      expect(sessionPosts).toBe(1);
      expect(run.output).toContain(`"tool_route": {"cli_session": "${TOKEN}"}`);
      expect(store.load(storeKey())).toMatchObject({ session_id: TOKEN });
    }, 30000);

    it('says the session expired and exits non-zero when it reaches expires_at', async () => {
      await startAll({ expiresAt: () => new Date(Date.now() + 1500).toISOString() });
      const run = start(cliArgs(['--new-session']));
      const exited = new Promise((resolve) => child.on('exit', resolve));
      await until(() => run.output.includes('Tool forwarding active'), 'the CLI to start', run);

      const code = await exited;
      expect(code).toBe(1);
      expect(run.output).toMatch(/This tool session expired \(.+\)\. Start "modelriver tools" again for a new session ID\./);
    }, 30000);

    it('--new-session opens a new session even when one is saved', async () => {
      await startAll();
      const store = new ToolSessionStore();
      store.save(storeKey(), { session_id: OLD_TOKEN, channel: OLD_CHANNEL, expires_at: new Date(Date.now() + 2 * 3600 * 1000).toISOString(), project_id: 'p1' });

      const run = start(cliArgs(['--new-session']));
      await until(() => run.output.includes('Press Ctrl+C'), 'the CLI to start', run);

      expect(joins.map((join) => join.topic)).toEqual([CHANNEL]);
      expect(sessionPosts).toBe(1);
      expect(run.output).not.toContain(OLD_TOKEN);
      expect(store.load(storeKey())).toMatchObject({ session_id: TOKEN });
    }, 30000);

    it('keeps the saved sessions in a file only the owner can read', async () => {
      await startAll();
      const run = start(cliArgs());
      await until(() => run.output.includes('Press Ctrl+C'), 'the CLI to start', run);

      const file = new ToolSessionStore().file;
      expect(fs.readFileSync(file, 'utf8')).toContain(TOKEN);
      expect(fs.readFileSync(file, 'utf8')).not.toContain(API_KEY);
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }, 30000);
  });

  it('says why when ModelRiver refuses the join (hosted tools turned off, or the session is gone)', async () => {
    api = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v1/cli/connect') {
        res.writeHead(200);
        return res.end(JSON.stringify({ ws_token: 'ws-tok', websocket_url: `ws://127.0.0.1:${api.address().port}/cli` }));
      }
      res.writeHead(201);
      return res.end(JSON.stringify({ session_id: TOKEN, channel: CHANNEL, expires_at: inADay(), project_id: 'p1' }));
    });
    wss = new WebSocketServer({ server: api });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        const payload = msg.event === 'phx_join'
          ? { status: 'error', response: { reason: 'unauthorized' } }
          : { status: 'ok', response: {} };
        ws.send(JSON.stringify({ topic: msg.topic, event: 'phx_reply', ref: msg.ref, payload }));
      });
    });
    await listen(api);

    const { code, output } = await runCli(
      ['tools', '--forward-to', 'http://localhost:3000', '--api-url', `http://localhost:${api.address().port}`],
      { env: { MODELRIVER_API_KEY: 'mr_test_e2e_abcdefghijklmnopqrstuvwxyz' } }
    );

    expect(code).toBe(1);
    expect(output).toContain('Failed to start tool forwarding');
    expect(output).toMatch(/hosted tools are turned off for this organization/);
    expect(output).not.toContain(TOKEN);
  }, 15000);

  // A 429 when opening the session: the body says which limit it was.
  async function startRefusingApi(status, body, headers = {}) {
    api = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v1/cli/connect') {
        res.writeHead(200);
        return res.end(JSON.stringify({ ws_token: 'ws-tok', websocket_url: `ws://127.0.0.1:${api.address().port}/cli` }));
      }
      res.writeHead(status, headers);
      return res.end(JSON.stringify(body));
    });
    await listen(api);
  }

  it('says to stop a session when all 5 are connected (429 too_many_cli_tool_sessions)', async () => {
    await startRefusingApi(429, {
      error: 'too_many_cli_tool_sessions',
      message: 'You already have 5 modelriver tools sessions connected in this project. Stop one, then start again.',
    });
    const { code, output } = await runCli(
      ['tools', '--forward-to', 'http://localhost:3000', '--api-url', `http://localhost:${api.address().port}`, '-k', 'mr_live_test_key_0123456789abcdef']
    );
    expect(code).toBe(1);
    expect(output).toContain('You already have 5 connected tool sessions for this project');
    expect(output).not.toContain('Rate limited');
  }, 15000);

  it('says how long to wait when the 429 is the rate limiter\'s, not the session limit', async () => {
    await startRefusingApi(429, { error: 'Rate limit exceeded', message: 'Too many requests', retry_after: 12 }, { 'retry-after': '12' });
    const { code, output } = await runCli(
      ['tools', '--forward-to', 'http://localhost:3000', '--api-url', `http://localhost:${api.address().port}`, '-k', 'mr_live_test_key_0123456789abcdef']
    );
    expect(code).toBe(1);
    expect(output).toContain('Rate limited by ModelRiver. Try again in 12 seconds.');
    expect(output).not.toContain('5 connected tool sessions');
  }, 15000);

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

  it('stops, without rejoining, when another connection takes over the session (replaced)', async () => {
    let joins = 0;
    await startApi((ws, msg) => {
      joins += 1;
      setTimeout(() => {
        // What the server sends the older socket: `replaced`, then the channel closes.
        ws.send(JSON.stringify({ topic: msg.topic, event: 'replaced', ref: null, payload: { reason: 'replaced' } }));
        ws.send(JSON.stringify({ topic: msg.topic, event: 'phx_close', ref: msg.ref, payload: {} }));
      }, 50);
    });
    const { code, output } = await runCli(
      ['tools', '--forward-to', 'http://localhost:3000', '--api-url', `http://localhost:${api.address().port}`],
      { env: { MODELRIVER_API_KEY: 'mr_test_e2e_abcdefghijklmnopqrstuvwxyz' } }
    );
    expect(output).toContain('Tool forwarding active');
    expect(output).toMatch(/Another connection took over this tool session/);
    expect(output).not.toMatch(/server closed the tool session/);
    expect(code).toBe(1);
    expect(joins).toBe(1);
  }, 15000);

  it('on replaced, aborts a write call in progress and warns it may have run', async () => {
    let forwarded;
    const reached = new Promise((resolve) => { forwarded = resolve; });
    let localClosed = false;
    toolServer = http.createServer((req, res) => { res.on('close', () => { localClosed = true; }); forwarded(); });
    await listen(toolServer);
    let sendReplaced;
    await startApi((ws, msg) => {
      ws.send(JSON.stringify({
        topic: msg.topic, event: 'tool_call', ref: null,
        payload: { call_id: 'tc_r', reply_ref: 'rr_r', tool: 'cancel_order', effect: 'write', path: '/slow', body: '{}', headers: {}, timeout_ms: 30000 },
      }));
      sendReplaced = () => ws.send(JSON.stringify({ topic: msg.topic, event: 'replaced', ref: null, payload: { reason: 'replaced' } }));
    });
    const run = runCli(
      ['tools', '--forward-to', `http://localhost:${toolServer.address().port}`, '--api-url', `http://localhost:${api.address().port}`],
      { env: { MODELRIVER_API_KEY: 'mr_test_e2e_abcdefghijklmnopqrstuvwxyz' } }
    );
    await reached;
    sendReplaced();
    const { code, output } = await run;
    expect(code).toBe(1);
    expect(output).toMatch(/Stopped cancel_order \[write\] \(call tc_r\) before your server answered/);
    expect(output).toMatch(/may already have run on your server/);
    expect(output).toMatch(/Another connection took over this tool session/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(localClosed).toBe(true);
  }, 15000);

  it('marks a call to a write tool with the server\'s effect field', async () => {
    toolServer = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{"ok":true}'); }); });
    await listen(toolServer);
    let answered;
    const done = new Promise((resolve) => { answered = resolve; });
    await startApi((ws, msg) => {
      ws.on('message', (data) => {
        if (JSON.parse(data.toString()).event === 'tool_result') answered();
      });
      ws.send(JSON.stringify({
        topic: msg.topic, event: 'tool_call', ref: null,
        payload: {
          call_id: 'tc_w', reply_ref: 'rr_w', tool: 'cancel_order', effect: 'write', path: '/tools/cancel',
          body: '{}', headers: {}, timeout_ms: 2000, max_result_bytes: 1024,
        },
      }));
    });
    const run = runCli(
      ['tools', '--forward-to', `http://localhost:${toolServer.address().port}`, '--api-url', `http://localhost:${api.address().port}`],
      { env: { MODELRIVER_API_KEY: 'mr_test_e2e_abcdefghijklmnopqrstuvwxyz' } }
    );
    await done;
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill('SIGINT');
    const { output } = await run;
    expect(output).toMatch(/cancel_order \[write\] → 200 \d+ms/);
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
