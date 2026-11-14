// Tests for URL helper utilities
const { normalizeWebhookUrl, extractPort, isValidApiKeyFormat, parseForwardUrl } = require('./url-helpers');

describe('URL Helpers', () => {
    describe('normalizeWebhookUrl', () => {
        it('should add /webhook/modelriver to base URL', () => {
            expect(normalizeWebhookUrl('http://localhost:4000'))
                .toBe('http://localhost:4000/webhook/modelriver');
        });

        it('should add /modelriver to URL ending with /webhook', () => {
            expect(normalizeWebhookUrl('http://localhost:4000/webhook'))
                .toBe('http://localhost:4000/webhook/modelriver');
        });

        it('should not modify URL already ending with /webhook/modelriver', () => {
            expect(normalizeWebhookUrl('http://localhost:4000/webhook/modelriver'))
                .toBe('http://localhost:4000/webhook/modelriver');
        });

        it('should handle trailing slashes', () => {
            expect(normalizeWebhookUrl('http://localhost:4000/'))
                .toBe('http://localhost:4000/webhook/modelriver');
        });

        it('should handle URLs with port', () => {
            expect(normalizeWebhookUrl('http://localhost:3001'))
                .toBe('http://localhost:3001/webhook/modelriver');
        });

        it('should handle https URLs', () => {
            expect(normalizeWebhookUrl('https://myserver.com'))
                .toBe('https://myserver.com/webhook/modelriver');
        });

        it('should return empty for falsy input', () => {
            expect(normalizeWebhookUrl('')).toBeFalsy();
            expect(normalizeWebhookUrl(null)).toBeFalsy();
            expect(normalizeWebhookUrl(undefined)).toBeFalsy();
        });
    });

    describe('extractPort', () => {
        it('should extract port from URL with explicit port', () => {
            expect(extractPort('http://localhost:4000')).toBe(4000);
            expect(extractPort('http://localhost:3001/webhook')).toBe(3001);
        });

        it('should return 80 for http without port', () => {
            expect(extractPort('http://example.com')).toBe(80);
        });

        it('should return 443 for https without port', () => {
            expect(extractPort('https://example.com')).toBe(443);
        });

        it('should return null for invalid URLs', () => {
            expect(extractPort('not-a-url')).toBeNull();
            expect(extractPort('')).toBeNull();
        });
    });

    describe('isValidApiKeyFormat', () => {
        it('should accept mr_live_ prefixed keys', () => {
            expect(isValidApiKeyFormat('mr_live_abc123xyz')).toBe(true);
        });

        it('should accept mr_test_ prefixed keys', () => {
            expect(isValidApiKeyFormat('mr_test_abc123xyz')).toBe(true);
        });

        it('should reject keys without valid prefix', () => {
            expect(isValidApiKeyFormat('invalid_key')).toBe(false);
            expect(isValidApiKeyFormat('mr_invalid_key')).toBe(false);
            expect(isValidApiKeyFormat('abc123')).toBe(false);
        });

        it('should reject empty or falsy keys', () => {
            expect(isValidApiKeyFormat('')).toBe(false);
            expect(isValidApiKeyFormat(null)).toBe(false);
            expect(isValidApiKeyFormat(undefined)).toBe(false);
        });
    });

    describe('parseForwardUrl', () => {
        it('should parse localhost URL with port', () => {
            const result = parseForwardUrl('http://localhost:4000/webhook/modelriver');
            expect(result).toEqual({
                hostname: 'localhost',
                port: 4000,
                path: '/webhook/modelriver',
                protocol: 'http'
            });
        });

        it('should parse external URL with port', () => {
            const result = parseForwardUrl('http://myserver.com:3001/webhook/modelriver');
            expect(result).toEqual({
                hostname: 'myserver.com',
                port: 3001,
                path: '/webhook/modelriver',
                protocol: 'http'
            });
        });

        it('should default to port 80 for http without explicit port', () => {
            const result = parseForwardUrl('http://example.com/webhook/modelriver');
            expect(result.port).toBe(80);
            expect(result.hostname).toBe('example.com');
        });

        it('should default to port 443 for https without explicit port', () => {
            const result = parseForwardUrl('https://example.com/webhook/modelriver');
            expect(result.port).toBe(443);
            expect(result.protocol).toBe('https');
        });

        it('should handle URLs with different paths', () => {
            const result = parseForwardUrl('http://localhost:5000/custom/path');
            expect(result.path).toBe('/custom/path');
        });

        it('should return null for empty or falsy input', () => {
            expect(parseForwardUrl('')).toBeNull();
            expect(parseForwardUrl(null)).toBeNull();
            expect(parseForwardUrl(undefined)).toBeNull();
        });

        it('should handle URLs without protocol by defaulting to http', () => {
            const result = parseForwardUrl('myserver:4000/webhook/modelriver');
            expect(result).toEqual({
                hostname: 'myserver',
                port: 4000,
                path: '/webhook/modelriver',
                protocol: 'http'
            });
        });

        it('should return null for invalid URLs', () => {
            expect(parseForwardUrl('http://invalid url with spaces')).toBeNull();
            expect(parseForwardUrl('just text with spaces')).toBeNull();
        });
    });
});

describe('checkApiUrl', () => {
  const { checkApiUrl, isLocalApiHost } = require('./url-helpers');

  it('accepts https anywhere and strips a trailing slash', () => {
    expect(checkApiUrl('https://api.modelriver.com/')).toBe('https://api.modelriver.com');
  });

  it('accepts http only for localhost, 127.0.0.0/8 and ::1 (the hosts ws:// is allowed for)', () => {
    expect(checkApiUrl('http://localhost:4000')).toBe('http://localhost:4000');
  });

  it('cuts an API path the CLI adds itself back to the base URL', () => {
    expect(checkApiUrl('http://localhost:4000/api')).toBe('http://localhost:4000');
    expect(checkApiUrl('http://localhost:4000/api/')).toBe('http://localhost:4000');
    expect(checkApiUrl('http://localhost:4000/api/v1')).toBe('http://localhost:4000');
    expect(checkApiUrl('https://api.modelriver.com/v1')).toBe('https://api.modelriver.com');
    expect(checkApiUrl('https://staging.example.com/modelriver')).toBe('https://staging.example.com/modelriver');
    expect(checkApiUrl('http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000');
    expect(checkApiUrl('http://[::1]:4000')).toBe('http://[::1]:4000');
    expect(() => checkApiUrl('http://10.0.0.1:4000')).toThrow(/must use https/);
    expect(() => checkApiUrl('http://0.0.0.0:4000')).toThrow(/must use https/);
    expect(() => checkApiUrl('http://localhost.attacker.example')).toThrow(/must use https/);
    expect(() => checkApiUrl('http://api.modelriver.com')).toThrow(/must use https/);
  });

  it('refuses other schemes and invalid URLs', () => {
    expect(() => checkApiUrl('ws://localhost:4000')).toThrow(/must use https/);
    expect(() => checkApiUrl('api.modelriver.com')).toThrow(/Invalid API URL/);
  });

  it('knows the local hosts', () => {
    expect(isLocalApiHost('LOCALHOST')).toBe(true);
    expect(isLocalApiHost('[::1]')).toBe(true);
    expect(isLocalApiHost('0.0.0.0')).toBe(false);
    // the same hosts as for ws://
    expect(isLocalApiHost('127.0.0.2')).toBe(true);
    expect(isLocalApiHost('127.0.0.1.nip.io')).toBe(false);
    expect(checkApiUrl('http://127.0.0.2:4000')).toBe('http://127.0.0.2:4000');
  });
});

describe('checkWebSocketUrl', () => {
  const { checkWebSocketUrl, isLoopbackHost } = require('./url-helpers');

  it('accepts wss for any host', () => {
    expect(checkWebSocketUrl('wss://api.modelriver.com/socket')).toBe('wss://api.modelriver.com/socket');
  });

  it('accepts ws only for localhost, 127.0.0.0/8 and ::1', () => {
    expect(checkWebSocketUrl('ws://localhost:4000/socket')).toBe('ws://localhost:4000/socket');
    expect(checkWebSocketUrl('ws://127.0.0.1:4000/socket')).toBe('ws://127.0.0.1:4000/socket');
    expect(checkWebSocketUrl('ws://127.4.5.6/socket')).toBe('ws://127.4.5.6/socket');
    expect(checkWebSocketUrl('ws://[::1]:4000/socket')).toBe('ws://[::1]:4000/socket');
  });

  it('refuses ws for any other host, other schemes, and invalid URLs', () => {
    expect(() => checkWebSocketUrl('ws://api.modelriver.com/socket')).toThrow(/must use wss/);
    expect(() => checkWebSocketUrl('ws://localhost.evil.com/socket')).toThrow(/must use wss/);
    expect(() => checkWebSocketUrl('ws://10.0.0.5/socket')).toThrow(/must use wss/);
    expect(() => checkWebSocketUrl('http://localhost/socket')).toThrow(/must use wss/);
    expect(() => checkWebSocketUrl('not a url')).toThrow(/invalid WebSocket URL/);
  });

  it('knows loopback hosts', () => {
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.nip.io')).toBe(false);
  });
});

describe('normalizeWebSocketUrl', () => {
  const { normalizeWebSocketUrl, checkWebSocketUrl } = require('./url-helpers');

  it('upgrades ws:// on port 443 or a modelriver.com host to wss://, which then passes the check', () => {
    expect(normalizeWebSocketUrl('ws://api.modelriver.com:443/socket')).toBe('wss://api.modelriver.com/socket');
    expect(normalizeWebSocketUrl('ws://api.modelriver.com/socket')).toBe('wss://api.modelriver.com/socket');
    expect(normalizeWebSocketUrl('ws://example.com:443/socket')).toBe('wss://example.com/socket');
    expect(checkWebSocketUrl(normalizeWebSocketUrl('ws://api.modelriver.com/socket'))).toBe('wss://api.modelriver.com/socket');
  });

  it('leaves other URLs as they are (the check then decides)', () => {
    expect(normalizeWebSocketUrl('ws://localhost:4000/socket')).toBe('ws://localhost:4000/socket');
    expect(normalizeWebSocketUrl('ws://evilmodelriver.com/socket')).toBe('ws://evilmodelriver.com/socket');
    expect(normalizeWebSocketUrl('wss://api.modelriver.com/socket/')).toBe('wss://api.modelriver.com/socket/');
    expect(normalizeWebSocketUrl('nope')).toBe('nope');
    expect(normalizeWebSocketUrl(undefined)).toBeUndefined();
  });
});
