// Runs the real `modelriver tools show|approve|reject` and `modelriver
// websocket` commands against a mock ModelRiver API.
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const CLI = path.join(__dirname, '..', 'bin', 'modelriver');
const API_KEY = 'mr_test_e2e_abcdefghijklmnopqrstuvwxyz';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function run(args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, MODELRIVER_API_KEY: API_KEY },
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${timeoutMs}ms. Output:\n${output}`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

describe('modelriver tools show|approve|reject (end to end)', () => {
  let api;
  let requests;
  let answer; // (req, body) => [status, body, headers?]

  beforeEach(async () => {
    requests = [];
    api = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        const [status, data, headers = {}] = answer(req, body);
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(typeof data === 'string' ? data : JSON.stringify(data));
      });
    });
    await listen(api);
  });

  afterEach(async () => {
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
  });

  const apiUrl = () => `http://localhost:${api.address().port}`;

  it('approve sends {"end_user": {"id": ...}} with the API key and prints the decision', async () => {
    answer = () => [200, { id: 'tc_3f2a9c1d5b7e4a6f8c0d1e2b', status: 'approved', decided_at: '2026-11-14T10:05:00Z', channel_id: 'ch_1' }];
    const { code, output } = await run(['tools', 'approve', 'tc_3f2a9c1d5b7e4a6f8c0d1e2b', '--end-user', 'user_812', '--api-url', apiUrl()]);

    expect(code).toBe(0);
    expect(requests).toEqual([{
      method: 'POST', url: '/api/v1/ai/tool-calls/tc_3f2a9c1d5b7e4a6f8c0d1e2b/approve', auth: `Bearer ${API_KEY}`, body: { end_user: { id: 'user_812' } },
    }]);
    expect(output).toContain('Approved tc_3f2a9c1d5b7e4a6f8c0d1e2b at 2026-11-14T10:05:00Z');
    expect(output).toContain('Request (channel): ch_1');
    expect(output).toContain('this call runs once');
  });

  it('reject (and decline) call the reject endpoint', async () => {
    answer = () => [200, { id: 'tc_0a1b2c3d4e5f60718293a4b5', status: 'rejected', decided_at: '2026-11-14T10:06:00Z', channel_id: 'ch_1' }];
    const first = await run(['tools', 'reject', 'tc_0a1b2c3d4e5f60718293a4b5', '--end-user', 'u 2', '--api-url', apiUrl()]);
    const second = await run(['tools', 'decline', 'tc_0a1b2c3d4e5f60718293a4b5', '--end-user', 'u 2', '--api-url', apiUrl()]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(requests.map((r) => r.url)).toEqual(['/api/v1/ai/tool-calls/tc_0a1b2c3d4e5f60718293a4b5/reject', '/api/v1/ai/tool-calls/tc_0a1b2c3d4e5f60718293a4b5/reject']);
    expect(requests[0].body).toEqual({ end_user: { id: 'u 2' } });
    expect(first.output).toContain('Declined tc_0a1b2c3d4e5f60718293a4b5');
    expect(first.output).toContain('will not run');
  });

  it('refuses anything that is not a tool call id, without calling the API', async () => {
    answer = () => [200, {}];
    for (const id of ['../../cli/connect', 'tc_1', 'TC_3F2A9C1D5B7E4A6F8C0D1E2B', `${'tc_3f2a9c1d5b7e4a6f8c0d1e2b'}x`]) {
      const approve = await run(['tools', 'approve', id, '--end-user', 'u', '--api-url', apiUrl()]);
      expect(approve.code).toBe(1);
      expect(approve.output).toMatch(/is not a tool call id \(expected "tc_" followed by 24 hex characters\)/);
    }
    const show = await run(['tools', 'show', 'nope', '--api-url', apiUrl()]);
    expect(show.code).toBe(1);
    expect(requests).toEqual([]);
  }, 20000);

  it.each([
    [400, { error: 'end_user_required', message: 'end_user.id is required and must be text.', details: {} }, {}, /end_user_required[\s\S]*--end-user/],
    [404, { error: 'tool_call_not_found', message: 'No call waiting for approval has this id.', details: {} }, {}, /tool_call_not_found/],
    [409, { error: 'end_user_mismatch', message: 'This call belongs to a different end_user.', details: { code: 'end_user_mismatch' } }, {}, /different end user/],
    [409, { error: 'tool_call_already_decided', message: 'This call was already rejected.', details: { status: 'rejected' } }, {}, /already rejected; nothing changed/],
    [410, { error: 'tool_approval_expired', message: 'x', details: {} }, {}, /not run \(tool_approval_expired\)/],
    [429, { error: 'Rate limit exceeded', retry_after: 7 }, { 'retry-after': '7' }, /Rate limited[\s\S]*Try again in 7 seconds/],
  ])('maps HTTP %i to a clear error and exits 1', async (status, body, headers, expected) => {
    answer = () => [status, body, headers];
    const { code, output } = await run(['tools', 'approve', 'tc_3f2a9c1d5b7e4a6f8c0d1e2b', '--end-user', 'user_812', '--api-url', apiUrl()]);
    expect(code).toBe(1);
    expect(output).toMatch(expected);
  });

  it('show prints the prompt, the shown arguments and the commands for a pending call', async () => {
    answer = () => [200, {
      id: 'tc_3f2a9c1d5b7e4a6f8c0d1e2b', status: 'pending', tool: 'cancel_order', prompt: 'Cancel this order?',
      arguments: { order_id: '1041', note: '\u001b[2Jhi' }, expires_at: '2026-11-14T10:20:00Z', decided_at: null, channel_id: 'ch_1',
    }];
    const { code, output } = await run(['tools', 'show', 'tc_3f2a9c1d5b7e4a6f8c0d1e2b', '--api-url', apiUrl()]);

    expect(code).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/api/v1/ai/tool-calls/tc_3f2a9c1d5b7e4a6f8c0d1e2b', auth: `Bearer ${API_KEY}` });
    expect(output).toContain('Call tc_3f2a9c1d5b7e4a6f8c0d1e2b: pending');
    expect(output).toContain('Tool: cancel_order');
    expect(output).toContain('Prompt: Cancel this order?');
    expect(output).toContain('order_id: 1041');
    expect(output).toContain('note: \\u001b[2Jhi'); // shown, not run by the terminal
    expect(output).not.toContain('\u001b[2J');
    expect(output).toContain('modelriver tools approve tc_3f2a9c1d5b7e4a6f8c0d1e2b --end-user <end user id>');
  });

  it('show reports a call it cannot find', async () => {
    answer = () => [404, { error: 'tool_call_not_found', message: 'No call waiting for approval has this id.', details: {} }];
    const { code, output } = await run(['tools', 'show', 'tc_ffffffffffffffffffffffff', '--api-url', apiUrl()]);
    expect(code).toBe(1);
    expect(output).toMatch(/tool_call_not_found/);
  });
});

describe('modelriver websocket: approvals (end to end)', () => {
  let api;
  let wss;

  afterEach(async () => {
    if (wss) for (const ws of wss.clients) ws.terminate();
    if (api) {
      api.closeAllConnections();
      await new Promise((resolve) => api.close(resolve));
    }
  });

  async function startApi({ websocketUrl, onJoin }) {
    const posted = [];
    api = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/v1/ai/async') {
          posted.push(JSON.parse(body));
          res.writeHead(200);
          return res.end(JSON.stringify({
            channel_id: 'ch_1', project_id: 'p_1', ws_token: 'ws-tok', status: 'pending',
            websocket_channel: 'ai_response:p_1:ch_1',
            websocket_url: websocketUrl(api.address().port),
          }));
        }
        res.writeHead(404);
        return res.end('{}');
      });
    });
    wss = new WebSocketServer({ server: api });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.event !== 'phx_join') return;
        ws.send(JSON.stringify({ topic: msg.topic, event: 'phx_reply', ref: msg.ref, payload: { status: 'ok', response: {} } }));
        onJoin((event, payload) => ws.send(JSON.stringify({ topic: msg.topic, event, ref: null, payload })));
      });
    });
    await listen(api);
    return posted;
  }

  it('sends --end-user and --cli-session, shows the approval and its decision, then the response', async () => {
    const posted = await startApi({
      websocketUrl: (port) => `ws://127.0.0.1:${port}/socket`,
      onJoin: (send) => {
        send('tool_state', { round: 1, max_rounds: 3, calls: [] });
        send('tool_approval_required', {
          id: 'tc_9', name: 'cancel_order', label: 'Cancelling the order', round: 1, prompt: 'Cancel this order? This can\'t be undone.',
          arguments: { order_id: '1041' }, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        });
        setTimeout(() => {
          send('tool_approval_resolved', { id: 'tc_9', name: 'cancel_order', round: 1, decision: 'approved' });
          send('response', { status: 'success', data: { answer: 'Cancelled.' } });
        }, 100);
      },
    });

    const { code, output } = await run([
      'websocket', '-w', 'support', '-m', 'Cancel order 1041',
      '--end-user', 'user_812', '--cli-session', 'cts_AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      '--api-url', `http://localhost:${api.address().port}`, '--verbose',
    ]);

    expect(code).toBe(0);
    expect(posted[0]).toMatchObject({
      workflow: 'support', end_user: { id: 'user_812' }, tool_route: { cli_session: 'cts_AbCdEfGhIjKlMnOpQrStUvWxYz012345' },
    });
    expect(output).toContain('Waiting for approval: cancel_order (call tc_9)');
    expect(output).toContain('Label: Cancelling the order');
    // --verbose prints the payload, but never the session token
    expect(output).toContain('"cli_session": "cts_…2345"');
    expect(output).not.toContain('AbCdEfGhIjKl');
    expect(output).toContain('Prompt: Cancel this order? This can\'t be undone.');
    expect(output).toContain('order_id: 1041');
    expect(output).toContain('modelriver tools approve tc_9 --end-user user_812');
    expect(output).toContain('modelriver tools reject tc_9 --end-user user_812');
    expect(output).toContain('cancel_order (call tc_9): approved; it runs now');
    expect(output).toContain('Response received');
    expect(output).toContain('Cancelled.');
  }, 15000);

  it('refuses a ws:// URL for another host from the server', async () => {
    await startApi({ websocketUrl: () => 'ws://api.example.com/socket', onJoin: () => {} });
    const { code, output } = await run([
      'websocket', '-w', 'support', '--api-url', `http://localhost:${api.address().port}`,
    ]);
    expect(code).toBe(1);
    expect(output).toMatch(/must use wss/);
  }, 15000);

  it('exits 1 when the socket closes before a response (a call may still wait for approval)', async () => {
    await startApi({
      websocketUrl: (port) => `ws://127.0.0.1:${port}/socket`,
      onJoin: (send) => {
        send('tool_approval_required', {
          id: 'tc_9', name: 'cancel_order', label: null, round: 1, prompt: 'Cancel this order?',
          arguments: {}, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        });
        setTimeout(() => { for (const ws of wss.clients) ws.close(); }, 100);
      },
    });

    const { code, output } = await run([
      'websocket', '-w', 'support', '--api-url', `http://localhost:${api.address().port}`,
    ]);

    expect(code).toBe(1);
    expect(output).toContain('WebSocket closed before response received');
    expect(output).toContain('modelriver websocket --channel-id ch_1 --project-id p_1');
  }, 15000);

  it('says why when a channel can no longer be followed, instead of connecting without a token', async () => {
    // The mock API answers 404 {} to /ai/reconnect, as for a finished request.
    await startApi({ websocketUrl: (port) => `ws://127.0.0.1:${port}/socket`, onJoin: () => {} });

    const { code, output } = await run([
      'websocket', '--channel-id', 'ch_1', '--project-id', 'p_1',
      '--api-url', `http://localhost:${api.address().port}`,
    ]);

    expect(code).toBe(1);
    expect(output).toContain('Failed to get reconnect token');
    expect(output).toMatch(/gave no token for this channel/);
    expect(wss.clients.size).toBe(0);
  }, 15000);
});
