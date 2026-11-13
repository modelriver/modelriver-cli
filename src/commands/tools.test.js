const http = require('http');
const { handleToolCall, describeResult } = require('./tools');

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

  it('sends the error code with status 0 on timeout', async () => {
    const wsClient = fakeWs();
    await handleToolCall(call({ path: '/slow', timeout_ms: 100 }), { wsClient, topic: 't', origin });
    expect(wsClient.push.mock.calls[0][2]).toEqual({ reply_ref: 'rr_9', status: 0, body: null, error: 'timeout' });
  });

  it('sends too_large when the response is over max_result_bytes', async () => {
    const wsClient = fakeWs();
    await handleToolCall(call({ max_result_bytes: 10 }), { wsClient, topic: 't', origin });
    expect(wsClient.push.mock.calls[0][2]).toMatchObject({ reply_ref: 'rr_9', body: null, error: 'too_large' });
  });

  it('sends target_refused without making a request when the target is not loopback', async () => {
    const wsClient = fakeWs();
    const lookup = jest.fn(async () => [{ address: '203.0.113.7', family: 4 }]);
    await handleToolCall(call(), { wsClient, topic: 't', origin: 'http://tools.example.com:3000', lookup });
    expect(received).toBeNull();
    expect(wsClient.push.mock.calls[0][2]).toEqual({ reply_ref: 'rr_9', status: 0, body: null, error: 'target_refused' });
  });

  it('logs, but does not throw, when the server refuses the result', async () => {
    const wsClient = fakeWs(async () => { throw new Error('unknown_reply_ref'); });
    await expect(handleToolCall(call(), { wsClient, topic: 't', origin })).resolves.toMatchObject({ status: 200 });
    expect(printed()).toContain('unknown_reply_ref');
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
});
