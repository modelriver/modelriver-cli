const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const { watchExpiry, handleToolCall, describeResult, formatBody, toolLabel, resolveApiKey, ToolCallRelay } = require('./tools');
const { Config } = require('../lib/config');
const CLIWebSocketClient = require('../lib/cli-websocket-client');
const { PushError } = CLIWebSocketClient;

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

describe('tools command: handleToolCall', () => {
  let server;
  let origin;
  let received;
  let log;
  let err;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
        if (req.url.startsWith('/slow')) return; // never answers
        if (req.url.startsWith('/binary')) {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]));
        }
        if (req.url.startsWith('/delay')) {
          setTimeout(() => { res.writeHead(200); res.end('{"late":true}'); }, 100);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ forecast: 'sunny', secret_result: 'R-123' }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    received = null;
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    err = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    err.mockRestore();
  });

  const call = (overrides = {}) => ({
    call_id: 'call_9',
    reply_ref: 'rr_9',
    tool: 'get_weather',
    path: '/tools/weather',
    body: '{"arguments":{"city":"Pune","api_token":"A-456"}}',
    headers: { 'content-type': 'application/json', 'x-modelriver-signature': 'v2=abc' },
    timeout_ms: 2000,
    max_result_bytes: 4096,
    ...overrides,
  });

  const fakeWs = (impl = async () => ({})) => ({ push: jest.fn(impl) });
  const printed = () => [...log.mock.calls, ...err.mock.calls].flat().join('\n');

  it('forwards the call and sends tool_result with the reply_ref', async () => {
    const wsClient = fakeWs();
    await handleToolCall(call(), { wsClient, topic: 'cli_tools:cts_1', origin });

    expect(received.url).toBe('/tools/weather');
    expect(received.body).toBe(call().body);
    expect(wsClient.push).toHaveBeenCalledWith(
      'cli_tools:cts_1',
      'tool_result',
      { reply_ref: 'rr_9', status: 200, body: JSON.stringify({ forecast: 'sunny', secret_result: 'R-123' }) },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
  });

  it('prints one line with tool, status and time, but no arguments or results without --print', async () => {
    await handleToolCall(call(), { wsClient: fakeWs(), topic: 't', origin });
    const out = printed();
    expect(out).toMatch(/get_weather → 200 \d+ms/);
    expect(out).not.toContain('A-456');
    expect(out).not.toContain('R-123');
  });

  it('prints arguments and results with --print', async () => {
    await handleToolCall(call(), { wsClient: fakeWs(), topic: 't', origin, print: true });
    const out = printed();
    expect(out).toContain('A-456');
    expect(out).toContain('R-123');
  });

  it('prints what the model or the endpoint wrote as plain text: no control characters reach the terminal', () => {
    const ESC = String.fromCharCode(27);
    const CSI = String.fromCharCode(0x9b);
    expect(formatBody(`${ESC}[2Jplain ${CSI}31m text`)).toBe('\\u001b[2Jplain \\u009b31m text');
    expect(formatBody(JSON.stringify({ note: `a${CSI}b` }))).toBe('{\n  "note": "a\\u009bb"\n}');
    expect(formatBody('{"ok":true}')).toBe('{\n  "ok": true\n}');

    const line = describeResult({ tool: `get${ESC}[31m_weather`, effect: 'write' }, { status: 200, ms: 3 });
    expect(line).toContain('get\\u001b[31m_weather [write] → 200 3ms');
    expect(line).not.toContain(ESC);
  });

  it('sends the error code with status 0 on timeout', async () => {
    const wsClient = fakeWs();
    await handleToolCall(call({ path: '/slow', timeout_ms: 100 }), { wsClient, topic: 't', origin });
    expect(wsClient.push.mock.calls[0][2]).toEqual({ reply_ref: 'rr_9', error: 'timeout' });
  });

  it('sends too_large when the response is over max_result_bytes', async () => {
    const wsClient = fakeWs();
    await handleToolCall(call({ max_result_bytes: 10 }), { wsClient, topic: 't', origin });
    expect(wsClient.push.mock.calls[0][2]).toEqual({ reply_ref: 'rr_9', error: 'too_large' });
  });

  it('sends target_refused without making a request when the target is not loopback', async () => {
    const wsClient = fakeWs();
    const lookup = jest.fn(async () => [{ address: '203.0.113.7', family: 4 }]);
    await handleToolCall(call(), { wsClient, topic: 't', origin: 'http://tools.example.com:3000', lookup });
    expect(received).toBeNull();
    expect(wsClient.push.mock.calls[0][2]).toEqual({ reply_ref: 'rr_9', error: 'target_refused' });
  });

  it('logs, but does not throw, when the server refuses the result', async () => {
    const wsClient = fakeWs(async () => { throw new Error('unknown_reply_ref'); });
    await expect(handleToolCall(call(), { wsClient, topic: 't', origin })).resolves.toMatchObject({ status: 200 });
    expect(printed()).toContain('unknown_reply_ref');
  });

  it('sends connection_failed when the call has a header Node refuses', async () => {
    const wsClient = fakeWs();
    const bad = call({ headers: { 'content-type': 'application/json', 'x-bad': 'a\nb' } });
    await expect(handleToolCall(bad, { wsClient, topic: 't', origin })).resolves.toMatchObject({ error: 'connection_failed' });
    expect(received).toBeNull();
    expect(wsClient.push.mock.calls[0][2]).toEqual({ reply_ref: 'rr_9', error: 'connection_failed' });
  });

  it('sends the status with body null when the response is not UTF-8', async () => {
    const wsClient = fakeWs();
    await handleToolCall(call({ path: '/binary' }), { wsClient, topic: 't', origin });
    expect(wsClient.push.mock.calls[0][2]).toEqual({ reply_ref: 'rr_9', status: 200, body: null });
    expect(printed()).toContain('not valid UTF-8');
  });

  it('still replies when forwarding throws', async () => {
    const wsClient = fakeWs();
    // A lookup that throws something other than a DNS error.
    const lookup = () => { throw new TypeError('boom'); };
    await handleToolCall(call(), { wsClient, topic: 't', origin: 'http://tools.test:1', lookup });
    expect(wsClient.push).toHaveBeenCalledTimes(1);
    expect(wsClient.push.mock.calls[0][2].reply_ref).toBe('rr_9');
    expect(wsClient.push.mock.calls[0][2].error).toBeDefined();
  });

  it('ignores a tool_call without a reply_ref', async () => {
    const wsClient = fakeWs();
    await expect(handleToolCall({ tool: 'x' }, { wsClient, topic: 't', origin })).resolves.toBeNull();
    expect(wsClient.push).not.toHaveBeenCalled();
  });

  it('describes errors with their HTTP status when there is one', () => {
    expect(describeResult('t', { status: 200, error: 'too_large', ms: 5 })).toMatch(/t → too_large \(HTTP 200\) 5ms/);
    expect(describeResult('t', { status: 0, error: 'timeout', ms: 5 })).toMatch(/t → timeout 5ms/);
  });

  it('marks calls to a tool that changes something when the server sends effect "write"', async () => {
    await handleToolCall(call({ tool: 'cancel_order', effect: 'write' }), { wsClient: fakeWs(), topic: 't', origin, print: true });
    const out = printed();
    expect(out).toMatch(/→ cancel_order \[write\] POST \/tools\/weather/);
    expect(out).toMatch(/cancel_order \[write\] → 200 \d+ms/);
  });

  it('shows calls as before when effect is "read" or missing', async () => {
    await handleToolCall(call({ effect: 'read' }), { wsClient: fakeWs(), topic: 't', origin });
    await handleToolCall(call(), { wsClient: fakeWs(), topic: 't', origin });
    const out = printed();
    expect(out).not.toContain('[write]');
    expect(out.match(/get_weather → 200 \d+ms/g)).toHaveLength(2);
    expect(toolLabel({ tool: 'x', effect: 'other' })).toBe('x');
    expect(describeResult({ tool: 'x', effect: 'write' }, { status: 200, ms: 1 })).toMatch(/x \[write\] → 200 1ms/);
  });

  it('forwards the body unchanged whatever the effect (the CLI never re-sends or alters a call)', async () => {
    const wsClient = fakeWs();
    await handleToolCall(call({ effect: 'write' }), { wsClient, topic: 't', origin });
    expect(received.body).toBe(call().body);
    expect(wsClient.push).toHaveBeenCalledTimes(1);
  });
});

describe('ToolCallRelay: results across reconnects and Ctrl+C', () => {
  let server;
  let origin;
  let log;
  let err;
  let slowClosed = 0;
  let hits = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits.push(req.url);
        if (req.url.startsWith('/slow')) {
          // never answers; note when the CLI drops the connection
          res.on('close', () => { slowClosed += 1; });
          return;
        }
        const wait = req.url.startsWith('/delay') ? 100 : 0;
        setTimeout(() => { res.writeHead(200); res.end('{"ok":true}'); }, wait);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    err = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    err.mockRestore();
  });

  const call = (overrides = {}) => ({
    reply_ref: 'rr_1', tool: 'get_weather', path: '/tools/weather', body: '{}', headers: {}, timeout_ms: 2000, ...overrides,
  });

  // A stand-in for CLIWebSocketClient whose joined state the test controls.
  function fakeClient() {
    const ws = {
      joined: true,
      isJoined: () => ws.joined,
      push: jest.fn(async () => ({})),
    };
    return ws;
  }

  it('keeps a result while not joined and sends it after the rejoin', async () => {
    const ws = fakeClient();
    ws.joined = false;
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });

    await relay.handle(call());
    expect(ws.push).not.toHaveBeenCalled();
    expect(relay.inFlight.get('rr_1').state).toBe('queued');

    ws.joined = true;
    await relay.flush();
    expect(ws.push).toHaveBeenCalledWith('t', 'tool_result', { reply_ref: 'rr_1', status: 200, body: '{"ok":true}' }, expect.any(Object));
    expect(relay.inFlight.size).toBe(0);
  });

  it('keeps a result whose push failed because the socket closed, and resends it after the rejoin', async () => {
    const ws = fakeClient();
    ws.push.mockImplementationOnce(async () => {
      ws.joined = false;
      throw new PushError('WebSocket disconnected', { reason: 'disconnected' });
    });
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });

    await relay.handle(call());
    expect(ws.push).toHaveBeenCalledTimes(1);
    expect(relay.inFlight.get('rr_1').state).toBe('queued');

    ws.joined = true;
    await relay.flush();
    expect(ws.push).toHaveBeenCalledTimes(2);
    expect(ws.push.mock.calls[1][2]).toEqual({ reply_ref: 'rr_1', status: 200, body: '{"ok":true}' });
  });

  it('drops a kept result at the call deadline', async () => {
    const ws = fakeClient();
    ws.joined = false;
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });

    await relay.handle(call({ timeout_ms: 150 }));
    await waitFor(() => relay.inFlight.size === 0);
    ws.joined = true;
    await relay.flush();
    expect(ws.push).not.toHaveBeenCalled();
    expect(err.mock.calls.flat().join('\n')).toMatch(/Dropped the result for get_weather/);
  });

  it('does not retry a result the server refused (unknown_reply_ref)', async () => {
    const ws = fakeClient();
    ws.push.mockImplementation(async () => {
      throw new PushError('refused', { reason: 'error', reply: { status: 'error', response: { reason: 'unknown_reply_ref' } } });
    });
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });
    await relay.handle(call());
    await relay.flush();
    expect(ws.push).toHaveBeenCalledTimes(1);
    expect(relay.inFlight.size).toBe(0);
  });

  it('treats {status: "already_answered"} as done: no warning, no resend', async () => {
    const ws = fakeClient();
    ws.push.mockImplementation(async () => ({ status: 'already_answered' }));
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });
    await relay.handle(call());
    await relay.flush();
    expect(ws.push).toHaveBeenCalledTimes(1);
    expect(relay.inFlight.size).toBe(0);
    const out = [...log.mock.calls, ...err.mock.calls].flat().join('\n');
    expect(out).not.toMatch(/did not accept|already|no longer waiting/);
  });

  it('notes unknown_reply_ref quietly and never resends it, even if the channel is down by then', async () => {
    const ws = fakeClient();
    ws.push.mockImplementation(async () => {
      ws.joined = false; // the socket drops while the server waited ~2 s
      throw new PushError('refused', { reason: 'error', reply: { status: 'error', response: { reason: 'unknown_reply_ref' } } });
    });
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });
    await relay.handle(call());
    expect(relay.inFlight.size).toBe(0); // not queued for after a rejoin
    ws.joined = true;
    await relay.flush();
    expect(ws.push).toHaveBeenCalledTimes(1);
    const out = log.mock.calls.flat().join('\n');
    expect(out).toMatch(/no longer waiting for the result of get_weather \(it timed out, or was not sent to this session\)/);
    expect(out).not.toMatch(/did not accept/);
  });

  it('a result resent after a rejoin is done once the server answers already_answered', async () => {
    const ws = fakeClient();
    ws.push
      .mockImplementationOnce(async () => {
        ws.joined = false;
        throw new PushError('WebSocket disconnected', { reason: 'disconnected' });
      })
      .mockImplementationOnce(async () => ({ status: 'already_answered' }));
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });
    await relay.handle(call());
    ws.joined = true;
    await relay.flush();
    expect(ws.push).toHaveBeenCalledTimes(2);
    expect(relay.inFlight.size).toBe(0);
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/did not accept/);
  });

  it('never forwards the same message twice (repeated reply_ref)', async () => {
    hits = [];
    const ws = fakeClient();
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });
    const c = call({ reply_ref: 'rr_dup', call_id: 'tc_dup', path: '/dup' });
    await Promise.all([relay.handle(c), relay.handle({ ...c })]);
    await relay.handle({ ...c }); // again after it was answered
    expect(hits.filter((u) => u === '/dup')).toHaveLength(1);
    expect(ws.push).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join('\n')).toMatch(/Ignored a repeated tool_call for get_weather \(call tc_dup\)/);
  });

  it('never forwards the same call_id twice, and answers the repeat with connection_failed', async () => {
    hits = [];
    const ws = fakeClient();
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });
    await relay.handle(call({ reply_ref: 'rr_a', call_id: 'tc_same', path: '/same', effect: 'write' }));
    const second = await relay.handle(call({ reply_ref: 'rr_b', call_id: 'tc_same', path: '/same', effect: 'write' }));
    expect(hits.filter((u) => u === '/same')).toHaveLength(1);
    expect(second).toMatchObject({ error: 'connection_failed', repeated: true });
    expect(ws.push.mock.calls.map((c) => c[2])).toEqual([
      { reply_ref: 'rr_a', status: 200, body: '{"ok":true}' },
      { reply_ref: 'rr_b', error: 'connection_failed' },
    ]);
    expect(log.mock.calls.flat().join('\n')).toMatch(/Not forwarding get_weather \[write\] \(call tc_same\) again/);
  });

  it('warns that a write call that timed out locally may already have run', async () => {
    const ws = fakeClient();
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });
    await relay.handle(call({ reply_ref: 'rr_t', call_id: 'tc_t', tool: 'cancel_order', effect: 'write', path: '/slow', timeout_ms: 100 }));
    const out = log.mock.calls.flat().join('\n');
    expect(out).toMatch(/This tool changes something: the call may already have run/);
    expect(ws.push.mock.calls[0][2]).toEqual({ reply_ref: 'rr_t', error: 'timeout' });
  });

  it('does not warn about a read call that timed out', async () => {
    const relay = new ToolCallRelay({ wsClient: fakeClient(), topic: 't', origin });
    await relay.handle(call({ reply_ref: 'rr_tr', effect: 'read', path: '/slow', timeout_ms: 100 }));
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/may already have run/);
  });

  it('on a takeover, aborts open local requests without replying and warns for write calls', async () => {
    const ws = fakeClient();
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });
    const closedBefore = slowClosed;
    const pending = relay.handle(call({ reply_ref: 'rr_x', call_id: 'tc_x', tool: 'cancel_order', effect: 'write', path: '/slow', timeout_ms: 5000 }));
    await waitFor(() => relay.inFlight.size === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    relay.abortInFlight();
    await expect(pending).resolves.toMatchObject({ error: 'connection_failed', aborted: true });
    await waitFor(() => slowClosed > closedBefore);
    expect(ws.push).not.toHaveBeenCalled();
    const out = log.mock.calls.flat().join('\n');
    expect(out).toMatch(/Stopped cancel_order \[write\] \(call tc_x\) before your server answered\./);
    expect(out).toMatch(/may already have run on your server/);
  });

  it('a call that arrives after Ctrl+C is not forwarded, and is answered as not sent (never as a failed send)', async () => {
    const ws = fakeClient();
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });
    await relay.shutdown();
    const before = hits.length;

    const result = await relay.handle(call({ reply_ref: 'rr_late', call_id: 'tc_late', effect: 'write' }));

    expect(hits.length).toBe(before); // nothing reached the local server
    // target_refused: ModelRiver records the call as not sent. connection_failed
    // would make a write call's outcome "unknown", as if it might have run.
    expect(ws.push).toHaveBeenCalledWith('t', 'tool_result', { reply_ref: 'rr_late', error: 'target_refused' }, expect.anything());
    expect(result).toMatchObject({ error: 'target_refused' });
  });

  it('on Ctrl+C replies connection_failed for calls still being forwarded, within the cap', async () => {
    const ws = fakeClient();
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });
    // The forward times out on its own after 300 ms, well after the shutdown.
    const pending = relay.handle(call({ reply_ref: 'rr_slow', path: '/slow', timeout_ms: 300 }));
    await waitFor(() => relay.inFlight.size === 1);

    const started = Date.now();
    await relay.shutdown(1000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ws.push).toHaveBeenCalledWith('t', 'tool_result', { reply_ref: 'rr_slow', error: 'connection_failed' }, expect.any(Object));

    // The local request was aborted, not left to time out.
    await expect(pending).resolves.toMatchObject({ error: 'connection_failed', aborted: true });
    expect(ws.push).toHaveBeenCalledTimes(1); // no second reply
  });

  it('on Ctrl+C aborts the local request and says a write call may already have run', async () => {
    const ws = fakeClient();
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });
    const closedBefore = slowClosed;
    const pending = relay.handle(call({ reply_ref: 'rr_w', call_id: 'tc_w', tool: 'cancel_order', effect: 'write', path: '/slow', timeout_ms: 5000 }));
    await waitFor(() => relay.inFlight.size === 1);
    await new Promise((resolve) => setTimeout(resolve, 50)); // the request reaches the server

    const started = Date.now();
    await relay.shutdown(1000);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ error: 'connection_failed', aborted: true });
    await waitFor(() => slowClosed > closedBefore); // the local server saw the connection go

    const out = log.mock.calls.flat().join('\n');
    expect(out).toMatch(/Stopped cancel_order \[write\] \(call tc_w\)/);
    expect(out).toMatch(/may already have run on your server/);
    expect(out).toMatch(/unknown/);
    expect(ws.push).toHaveBeenCalledWith('t', 'tool_result', { reply_ref: 'rr_w', error: 'connection_failed' }, expect.any(Object));
  });

  it('on Ctrl+C does not warn about a write for a read tool', async () => {
    const ws = fakeClient();
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });
    const pending = relay.handle(call({ reply_ref: 'rr_r', effect: 'read', path: '/slow', timeout_ms: 5000 }));
    await waitFor(() => relay.inFlight.size === 1);
    await relay.shutdown(1000);
    await pending;
    const out = log.mock.calls.flat().join('\n');
    expect(out).toMatch(/Stopped get_weather \(call/);
    expect(out).not.toMatch(/may already have run/);
  });

  it('on Ctrl+C without an effect from the server, says the call may have run if the tool changes something', async () => {
    const ws = fakeClient();
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });
    const pending = relay.handle(call({ reply_ref: 'rr_n', path: '/slow', timeout_ms: 5000 }));
    await waitFor(() => relay.inFlight.size === 1);
    await relay.shutdown(1000);
    await pending;
    expect(log.mock.calls.flat().join('\n')).toMatch(/If this tool changes something, the call may already have run/);
  });

  it('on Ctrl+C gives up after the cap when the server does not answer', async () => {
    const ws = fakeClient();
    ws.push.mockImplementation(() => new Promise(() => {}));
    const relay = new ToolCallRelay({ wsClient: ws, topic: 't', origin });
    const pending = relay.handle(call({ path: '/slow', timeout_ms: 300 }));
    await waitFor(() => relay.inFlight.size === 1);

    const started = Date.now();
    await relay.shutdown(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeLessThan(1000);
    await pending;
  });

  it('with a real socket: a result ready while reconnecting is sent after the rejoin', async () => {
    const messages = [];
    let connections = 0;
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => wss.on('listening', resolve));
    const url = `ws://127.0.0.1:${wss.address().port}/cli`;
    wss.on('connection', (socket) => {
      connections += 1;
      const thisConnection = connections;
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'heartbeat') return;
        messages.push({ ...msg, connection: thisConnection });
        socket.send(JSON.stringify({ topic: msg.topic, event: 'phx_reply', ref: msg.ref, payload: { status: 'ok', response: {} } }));
        if (msg.event === 'phx_join' && thisConnection === 1) {
          socket.send(JSON.stringify({ topic: msg.topic, event: 'tool_call', ref: null, payload: call({ path: '/delay' }) }));
          // Drop the socket while the call is being forwarded.
          setTimeout(() => socket.terminate(), 20);
        }
      });
    });

    const wsClient = new CLIWebSocketClient(url, 'tok-1', false, {
      // Slow token refresh: the result (ready after ~100 ms) arrives while disconnected.
      refreshToken: () => new Promise((resolve) => setTimeout(() => resolve({ ws_token: 'tok-2' }), 300)),
      reconnectDelayMs: 10,
      maxReconnectAttempts: Infinity,
    });
    const topic = 'cli_tools:5d6e';
    const relay = new ToolCallRelay({ wsClient, topic, origin });
    wsClient.on('tool_call', (c, t) => { if (t === topic) relay.handle(c); });
    wsClient.onClient('rejoin', (t) => { if (t === topic) relay.flush(); });

    try {
      await wsClient.connect();
      await wsClient.join(topic, { session_token: 'cts_x' });

      const result = await waitFor(() => messages.find((m) => m.event === 'tool_result'));
      expect(result.connection).toBe(2);
      expect(result.payload).toEqual({ reply_ref: 'rr_1', status: 200, body: '{"ok":true}' });
      const joins = messages.filter((m) => m.event === 'phx_join');
      expect(joins.map((m) => m.connection)).toEqual([1, 2]);
      expect(log.mock.calls.flat().join('\n')).toMatch(/will be sent after reconnecting/);
    } finally {
      wsClient.close();
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
    }
  });
});

describe('tools command: resolveApiKey', () => {
  let cwd;
  let cwdSpy;
  const writeRc = (data) => fs.writeFileSync(path.join(cwd, '.modelriverrc'), JSON.stringify(data));
  const writeHome = (data) => {
    fs.mkdirSync(process.env.MODELRIVER_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MODELRIVER_CONFIG_DIR, 'config.json'), JSON.stringify(data));
  };

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'modelriver-rc-'));
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(process.env.MODELRIVER_CONFIG_DIR, { recursive: true, force: true });
    delete process.env.MODELRIVER_API_KEY;
  });

  it('refuses an API key that only a .modelriverrc in the current directory provides', () => {
    writeRc({ api_key: 'mr_live_planted_by_a_repo_0000' });
    const cfg = new Config();
    expect(cfg.getLocalRcApiKey()).toBe('mr_live_planted_by_a_repo_0000');
    expect(() => resolveApiKey(undefined, cfg)).toThrow(/does not use the API key in .*\.modelriverrc/);
    expect(() => resolveApiKey(undefined, cfg)).toThrow(/--api-key/);
  });

  it('uses ~/.modelriver/config.json instead of the .modelriverrc key', () => {
    writeHome({ api_key: 'mr_live_home_key_1111' });
    writeRc({ api_key: 'mr_live_planted_by_a_repo_0000' });
    const result = resolveApiKey(undefined, new Config());
    expect(result).toMatchObject({ apiKey: 'mr_live_home_key_1111', ignoredLocalKey: true });
  });

  it('prefers --api-key, then MODELRIVER_API_KEY', () => {
    writeRc({ api_key: 'mr_live_planted_by_a_repo_0000' });
    process.env.MODELRIVER_API_KEY = 'mr_live_env_key_2222';
    const cfg = new Config();
    expect(resolveApiKey('mr_live_flag_key_3333', cfg)).toMatchObject({ apiKey: 'mr_live_flag_key_3333', source: '--api-key' });
    expect(resolveApiKey(undefined, cfg)).toMatchObject({ apiKey: 'mr_live_env_key_2222', source: 'MODELRIVER_API_KEY' });
  });

  it('asks for a key when there is none at all', () => {
    expect(() => resolveApiKey(undefined, new Config())).toThrow(/API key is required/);
  });
});

describe('tools command: watchExpiry', () => {
  it('calls back once the expiry time has passed', async () => {
    const onExpired = jest.fn();
    const cancel = watchExpiry(new Date(Date.now() + 80).toISOString(), onExpired);
    expect(typeof cancel).toBe('function');
    expect(onExpired).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('calls back at once for a time already past', () => {
    const onExpired = jest.fn();
    watchExpiry('2020-01-01T00:00:00Z', onExpired);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled, and ignores a missing or unreadable time', async () => {
    const onExpired = jest.fn();
    watchExpiry(new Date(Date.now() + 50).toISOString(), onExpired)();
    expect(watchExpiry(undefined, onExpired)).toBeNull();
    expect(watchExpiry('not a date', onExpired)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('waits in steps when the expiry is beyond what setTimeout allows', () => {
    jest.useFakeTimers();
    try {
      let now = Date.parse('2026-01-01T00:00:00Z');
      const onExpired = jest.fn();
      watchExpiry(new Date(now + 40 * 24 * 3600 * 1000).toISOString(), onExpired, { now: () => now });
      now += 2 ** 31 - 1;
      jest.advanceTimersByTime(2 ** 31 - 1);
      expect(onExpired).not.toHaveBeenCalled();
      now += 40 * 24 * 3600 * 1000;
      jest.runOnlyPendingTimers();
      expect(onExpired).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
