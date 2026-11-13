const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

// The server refuses tool results over 256 KB, so never read more than that.
const SERVER_RESULT_LIMIT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;

// Headers the CLI sets itself instead of copying from the server's message.
const HEADERS_SET_BY_CLI = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-connection',
  'te',
  'trailer',
]);

class ForwardTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForwardTargetError';
  }
}

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/**
 * True for 127.0.0.0/8, ::1 and IPv4-mapped loopback (::ffff:127.x.x.x).
 * @param {string} address
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  let addr = address.trim().toLowerCase();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);

  const family = net.isIP(addr);
  if (family === 0) return false;
  try {
    return LOOPBACK.check(addr, family === 4 ? 'ipv4' : 'ipv6');
  } catch (error) {
    return false;
  }
}

/**
 * Parse and check the --forward-to URL. Only the origin is used.
 * @param {string} forwardTo
 * @returns {{url: URL, origin: string, hostname: string, ignoredPath: boolean}}
 */
function parseForwardTarget(forwardTo) {
  let url;
  try {
    url = new URL(forwardTo);
  } catch (error) {
    throw new ForwardTargetError(`"${forwardTo}" is not a valid URL (example: http://localhost:3000)`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ForwardTargetError(`--forward-to must use http or https, not ${url.protocol.replace(':', '')}`);
  }
  if (url.username || url.password) {
    throw new ForwardTargetError('--forward-to must not contain a username or password');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return {
    url,
    origin: url.origin,
    hostname,
    ignoredPath: (url.pathname && url.pathname !== '/') || Boolean(url.search),
  };
}

/**
 * Resolve a hostname and check that every address it resolves to is loopback.
 * @param {string} hostname
 * @param {Function} [lookup] - dns.promises.lookup-compatible
 * @returns {Promise<{address: string, family: number, addresses: Array}>} the
 *   checked addresses (the first one, and all of them for Happy Eyeballs)
 */
async function resolveLoopback(hostname, lookup = dns.promises.lookup) {
  const host = hostname.replace(/^\[|\]$/g, '');

  if (net.isIP(host)) {
    if (!isLoopbackAddress(host)) {
      throw new ForwardTargetError(`${host} is not a loopback address; the CLI only forwards tool calls to this machine`);
    }
    const entry = { address: host, family: net.isIP(host) };
    return { ...entry, addresses: [entry] };
  }

  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new ForwardTargetError(`Could not resolve ${host}: ${error.code || error.message}`);
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new ForwardTargetError(`Could not resolve ${host}`);
  }

  const outside = addresses.filter((entry) => !isLoopbackAddress(entry.address));
  if (outside.length > 0) {
    throw new ForwardTargetError(
      `${host} resolves to ${outside.map((e) => e.address).join(', ')}, which is not loopback; ` +
      'the CLI only forwards tool calls to localhost, 127.0.0.0/8 or ::1'
    );
  }

  const checked = addresses.map((e) => ({ address: e.address, family: e.family || net.isIP(e.address) }));
  return { ...checked[0], addresses: checked };
}

/**
 * Build the URL a tool call goes to: the forward origin plus the call's path.
 * @returns {URL}
 */
function buildTargetUrl(origin, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new ForwardTargetError(`Refusing tool call path "${path}"; it must start with a single "/"`);
  }
  const target = new URL(path, origin);
  if (target.origin !== origin) {
    throw new ForwardTargetError(`Refusing tool call path "${path}"; it leaves ${origin}`);
  }
  return target;
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, min), max);
}

function copyHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [name, value] of Object.entries(headers)) {
    const lower = String(name).toLowerCase();
    if (HEADERS_SET_BY_CLI.has(lower)) continue;
    if (value === undefined || value === null) continue;
    out[lower] = String(value);
  }
  return out;
}

/**
 * Forward one tool call to the local endpoint.
 *
 * @param {object} call - the server's `tool_call` payload
 * @param {object} options
 * @param {string} options.origin - forward origin, e.g. http://localhost:3000
 * @param {Function} [options.lookup] - dns.promises.lookup-compatible (tests)
 * @returns {Promise<{status: number, body: (string|null), error?: string, ms: number, url?: string, message?: string}>}
 */
async function forwardToolCall(call, { origin, lookup } = {}) {
  const started = Date.now();
  const done = (result) => ({ ...result, ms: Date.now() - started });

  const timeoutMs = clampNumber(call.timeout_ms, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  const maxBytes = clampNumber(call.max_result_bytes, SERVER_RESULT_LIMIT_BYTES, 1, SERVER_RESULT_LIMIT_BYTES);

  let target;
  let resolved;
  try {
    target = buildTargetUrl(origin, call.path);
    resolved = await resolveLoopback(target.hostname, lookup);
  } catch (error) {
    return done({ status: 0, body: null, error: 'target_refused', message: error.message });
  }

  const body = typeof call.body === 'string' ? call.body : JSON.stringify(call.body ?? null);
  const bodyBuffer = Buffer.from(body, 'utf8');
  const headers = copyHeaders(call.headers);
  headers['content-length'] = String(bodyBuffer.length);
  headers.host = target.host;

  const transport = target.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(done({ ...result, url: target.href }));
    };

    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'POST',
      headers,
      agent: false,
      // Connect to the address that was checked, so a second DNS answer can't
      // send the call somewhere else.
      lookup: (_hostname, opts, cb) => {
        if (opts && opts.all) {
          cb(null, resolved.addresses);
        } else {
          cb(null, resolved.address, resolved.family);
        }
      },
    }, (res) => {
      const chunks = [];
      let received = 0;

      res.on('data', (chunk) => {
        if (settled) return;
        received += chunk.length;
        if (received > maxBytes) {
          finish({
            status: res.statusCode,
            body: null,
            error: 'too_large',
            message: `Response is larger than ${maxBytes} bytes`,
          });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', (error) => {
        finish({ status: 0, body: null, error: 'connection_failed', message: error.message });
      });
      res.on('aborted', () => {
        finish({ status: 0, body: null, error: 'connection_failed', message: 'Response aborted' });
      });
    });

    const timer = setTimeout(() => {
      finish({ status: 0, body: null, error: 'timeout', message: `No complete response within ${timeoutMs}ms` });
      req.destroy();
    }, timeoutMs);

    req.on('error', (error) => {
      finish({ status: 0, body: null, error: 'connection_failed', message: error.code || error.message });
    });

    req.end(bodyBuffer);
  });
}

module.exports = {
  ForwardTargetError,
  SERVER_RESULT_LIMIT_BYTES,
  isLoopbackAddress,
  parseForwardTarget,
  resolveLoopback,
  buildTargetUrl,
  forwardToolCall,
};
