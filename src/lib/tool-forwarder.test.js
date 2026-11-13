const http = require('http');
const {
  ForwardTargetError,
  decodeUtf8,
  isLoopbackAddress,
  parseForwardTarget,
  resolveLoopback,
  buildTargetUrl,
  forwardToolCall,
} = require('./tool-forwarder');

function lookupReturning(...addresses) {
  return jest.fn(async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
}

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '127.1.2.3', '127.255.255.255', '::1', '0:0:0:0:0:0:0:1', '[::1]', '::ffff:127.0.0.1'])(
    'accepts %s',
    (address) => expect(isLoopbackAddress(address)).toBe(true)
  );

  it.each(['10.0.0.1', '192.168.1.10', '169.254.169.254', '8.8.8.8', '0.0.0.0', '::', '::2', '::ffff:8.8.8.8', '::ffff:10.0.0.1', '[::ffff:10.0.0.1]', '::ffff:0a00:0001', 'fe80::1', 'localhost', '', null])(
    'refuses %s',
    (address) => expect(isLoopbackAddress(address)).toBe(false)
  );
});

describe('parseForwardTarget', () => {
  it('keeps only the origin', () => {
    const target = parseForwardTarget('http://localhost:3000/some/path');
    expect(target.origin).toBe('http://localhost:3000');
    expect(target.hostname).toBe('localhost');
    expect(target.ignoredPath).toBe(true);
  });

  it('accepts https and bracketed IPv6', () => {
    const target = parseForwardTarget('https://[::1]:8443');
    expect(target.hostname).toBe('::1');
    expect(target.ignoredPath).toBe(false);
  });

  it('refuses other schemes, credentials and junk', () => {
    expect(() => parseForwardTarget('ftp://localhost')).toThrow(ForwardTargetError);
    expect(() => parseForwardTarget('file:///etc/passwd')).toThrow(ForwardTargetError);
    expect(() => parseForwardTarget('http://user:pw@localhost:3000')).toThrow(ForwardTargetError);
    expect(() => parseForwardTarget('localhost:3000')).toThrow(ForwardTargetError);
    expect(() => parseForwardTarget('not a url')).toThrow(ForwardTargetError);
  });
});

describe('resolveLoopback', () => {
  it('accepts loopback IP literals without a DNS lookup', async () => {
    const lookup = jest.fn();
    await expect(resolveLoopback('127.0.0.1', lookup)).resolves.toMatchObject({ address: '127.0.0.1', family: 4 });
    await expect(resolveLoopback('[::1]', lookup)).resolves.toMatchObject({ address: '::1', family: 6 });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('checks IPv4-mapped IPv6 addresses by their IPv4 part', async () => {
    await expect(resolveLoopback('::ffff:127.0.0.1')).resolves.toMatchObject({ address: '::ffff:127.0.0.1', family: 6 });
    await expect(resolveLoopback('[::ffff:10.0.0.1]')).rejects.toThrow(ForwardTargetError);
    await expect(resolveLoopback('mapped.test', lookupReturning('::ffff:10.0.0.1'))).rejects.toThrow(/::ffff:10\.0\.0\.1.*not loopback/);
    await expect(resolveLoopback('mapped.test', lookupReturning('::ffff:127.0.0.1'))).resolves.toMatchObject({ address: '::ffff:127.0.0.1' });
  });

  it('refuses non-loopback IP literals', async () => {
    await expect(resolveLoopback('10.1.2.3')).rejects.toThrow(/not a loopback address/);
    await expect(resolveLoopback('169.254.169.254')).rejects.toThrow(ForwardTargetError);
  });

  it('accepts a hostname that resolves only to loopback', async () => {
    const lookup = lookupReturning('::1', '127.0.0.1');
    const resolved = await resolveLoopback('localhost', lookup);
    expect(resolved.addresses.map((a) => a.address)).toEqual(['::1', '127.0.0.1']);
    expect(lookup).toHaveBeenCalledWith('localhost', expect.objectContaining({ all: true }));
  });

  it('refuses a hostname that resolves to a public IP', async () => {
    const lookup = lookupReturning('93.184.216.34');
    await expect(resolveLoopback('localtest.example.com', lookup)).rejects.toThrow(/93\.184\.216\.34.*not loopback/);
  });

  it('refuses a hostname that resolves to loopback and a public IP', async () => {
    const lookup = lookupReturning('127.0.0.1', '93.184.216.34');
    await expect(resolveLoopback('mixed.example.com', lookup)).rejects.toThrow(ForwardTargetError);
  });

  it('checks "localhost" too, not just its name', async () => {
    const lookup = lookupReturning('192.168.1.5');
    await expect(resolveLoopback('localhost', lookup)).rejects.toThrow(ForwardTargetError);
  });

  it('refuses names that do not resolve', async () => {
    const lookup = jest.fn(async () => { const e = new Error('nope'); e.code = 'ENOTFOUND'; throw e; });
    await expect(resolveLoopback('missing.invalid', lookup)).rejects.toThrow(/ENOTFOUND/);
  });
});

describe('buildTargetUrl', () => {
  const origin = 'http://localhost:3000';

  it('joins origin and path, keeping the query', () => {
    expect(buildTargetUrl(origin, '/tools/weather?units=metric').href).toBe('http://localhost:3000/tools/weather?units=metric');
  });

  it.each(['//evil.example.com/x', 'http://evil.example.com/', '@evil.example.com', 'tools/x', '/\\evil.example.com', '', null])(
    'refuses path %p',
    (path) => expect(() => buildTargetUrl(origin, path)).toThrow(ForwardTargetError)
  );
});

describe('decodeUtf8', () => {
  it('decodes valid UTF-8 exactly, keeping a BOM', () => {
    expect(decodeUtf8(Buffer.from('Zürich ✓', 'utf8'))).toBe('Zürich ✓');
    expect(decodeUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x41]))).toBe('\ufeffA');
    expect(decodeUtf8(Buffer.alloc(0))).toBe('');
  });

  it('returns null instead of replacing bad bytes', () => {
    expect(decodeUtf8(Buffer.from([0x41, 0xff, 0x42]))).toBeNull();
    expect(decodeUtf8(Buffer.from([0xe2, 0x82]))).toBeNull(); // cut-off sequence
  });
});

describe('forwardToolCall', () => {
  let server;
  let origin;
  let handler;
  let received;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
        handler(req, res);
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
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"temp":21}');
    };
  });

  const baseCall = () => ({
    call_id: 'call_1',
    reply_ref: 'ref_1',
    tool: 'get_weather',
    path: '/tools/weather?units=metric',
    // Odd spacing and key order on purpose: it must arrive byte for byte.
    body: '{"tool":"get_weather",  "arguments":{"city":"Zürich"},"a":1}',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-modelriver-timestamp': '1763100000',
      'x-modelriver-tool-call-id': 'call_1',
      'x-modelriver-key-id': 'key_abc',
      'x-modelriver-signature': 'v2=deadbeef',
    },
    timeout_ms: 2000,
    max_result_bytes: 1024,
  });

  it('POSTs the exact body and headers to origin + path and returns the response', async () => {
    const call = baseCall();
    const result = await forwardToolCall(call, { origin });

    expect(result).toMatchObject({ status: 200, body: '{"temp":21}' });
    expect(result.error).toBeUndefined();
    expect(typeof result.ms).toBe('number');

    expect(received.method).toBe('POST');
    expect(received.url).toBe('/tools/weather?units=metric');
    expect(received.body).toBe(call.body);
    expect(received.headers['content-length']).toBe(String(Buffer.byteLength(call.body)));
    for (const [name, value] of Object.entries(call.headers)) {
      expect(received.headers[name]).toBe(value);
    }
  });

  it('does not let the server message override host or content-length', async () => {
    const call = baseCall();
    call.headers.host = 'evil.example.com';
    call.headers['content-length'] = '1';
    await forwardToolCall(call, { origin });
    expect(received.headers.host).toBe(new URL(origin).host);
    expect(received.body).toBe(call.body);
  });

  it('passes non-2xx statuses through', async () => {
    handler = (req, res) => { res.writeHead(422); res.end('{"error":"bad city"}'); };
    await expect(forwardToolCall(baseCall(), { origin })).resolves.toMatchObject({ status: 422, body: '{"error":"bad city"}' });
  });

  it('does not follow redirects', async () => {
    handler = (req, res) => { res.writeHead(302, { location: 'http://example.com/' }); res.end(); };
    const result = await forwardToolCall(baseCall(), { origin });
    expect(result).toMatchObject({ status: 302, body: '' });
  });

  it('replies timeout when the endpoint is slower than timeout_ms', async () => {
    handler = (req, res) => { setTimeout(() => { if (!res.destroyed) { res.writeHead(200); res.end('late'); } }, 1000); };
    const call = { ...baseCall(), timeout_ms: 100 };
    const result = await forwardToolCall(call, { origin });
    expect(result).toMatchObject({ status: 0, body: null, error: 'timeout' });
    expect(result.ms).toBeLessThan(900);
  });

  it('replies timeout when the body never finishes', async () => {
    handler = (req, res) => { res.writeHead(200); res.write('{"partial":'); };
    const result = await forwardToolCall({ ...baseCall(), timeout_ms: 150 }, { origin });
    expect(result).toMatchObject({ status: 0, body: null, error: 'timeout' });
  });

  it('stops reading past max_result_bytes and replies too_large', async () => {
    handler = (req, res) => { res.writeHead(200); res.end('x'.repeat(5000)); };
    const result = await forwardToolCall({ ...baseCall(), max_result_bytes: 1000 }, { origin });
    expect(result).toMatchObject({ status: 200, body: null, error: 'too_large' });
  });

  it('accepts a response exactly max_result_bytes long', async () => {
    handler = (req, res) => { res.writeHead(200); res.end('y'.repeat(1000)); };
    const result = await forwardToolCall({ ...baseCall(), max_result_bytes: 1000 }, { origin });
    expect(result).toMatchObject({ status: 200, body: 'y'.repeat(1000) });
  });

  it('caps max_result_bytes at the server limit of 256 KB', async () => {
    handler = (req, res) => { res.writeHead(200); res.end('z'.repeat(256 * 1024 + 1)); };
    const result = await forwardToolCall({ ...baseCall(), max_result_bytes: 10 * 1024 * 1024 }, { origin });
    expect(result.error).toBe('too_large');
  });

  it('sends the status with a null body when the response is not valid UTF-8', async () => {
    handler = (req, res) => { res.writeHead(200); res.end(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])); };
    const result = await forwardToolCall(baseCall(), { origin });
    expect(result).toMatchObject({ status: 200, body: null });
    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/not valid UTF-8/);
  });

  it.each([
    ['a header value with a newline', { 'x-bad': 'a\r\nx-injected: 1' }],
    ['a header name with a space', { 'bad header': 'x' }],
  ])('replies connection_failed (and does not throw) for %s', async (_label, extra) => {
    const call = baseCall();
    Object.assign(call.headers, extra);
    const result = await forwardToolCall(call, { origin });
    expect(result).toMatchObject({ status: 0, body: null, error: 'connection_failed' });
    expect(result.message).toMatch(/Could not send the request/);
    expect(received).toBeNull();
  });

  it('replies connection_failed when nothing listens', async () => {
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));

    const result = await forwardToolCall(baseCall(), { origin: `http://127.0.0.1:${port}` });
    expect(result).toMatchObject({ status: 0, body: null, error: 'connection_failed' });
  });

  it('replies target_refused when the host resolves to a public IP', async () => {
    const lookup = lookupReturning('93.184.216.34');
    const result = await forwardToolCall(baseCall(), { origin: 'http://rebind.example.com:3000', lookup });
    expect(result).toMatchObject({ status: 0, body: null, error: 'target_refused' });
    expect(received).toBeNull();
  });

  it('replies target_refused for a path that leaves the origin', async () => {
    const result = await forwardToolCall({ ...baseCall(), path: '//evil.example.com/x' }, { origin });
    expect(result).toMatchObject({ status: 0, error: 'target_refused' });
    expect(received).toBeNull();
  });

  it('connects to the address it checked, not a second DNS answer', async () => {
    const port = new URL(origin).port;
    let calls = 0;
    const lookup = jest.fn(async () => {
      calls += 1;
      return calls === 1
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }];
    });
    const result = await forwardToolCall(baseCall(), { origin: `http://tools.test:${port}`, lookup });
    expect(result.status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(received.headers.host).toBe(`tools.test:${port}`);
  });
});
