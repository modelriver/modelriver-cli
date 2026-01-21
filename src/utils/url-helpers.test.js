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

        it('should return null for invalid URLs', () => {
            expect(parseForwardUrl('not-a-url')).toBeNull();
            expect(parseForwardUrl('just-text')).toBeNull();
        });
    });
});
