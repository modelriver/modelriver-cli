const WebhookVerifier = require('./webhook-verifier');

describe('WebhookVerifier', () => {
    const secret = 'test-secret-key-12345';
    const timestamp = '1704825600';
    const payload = { status: 'success', name: 'Test User' };

    describe('generateSignature', () => {
        it('should generate a consistent HMAC-SHA256 signature', () => {
            const sig1 = WebhookVerifier.generateSignature(payload, secret, timestamp);
            const sig2 = WebhookVerifier.generateSignature(payload, secret, timestamp);

            expect(sig1).toBe(sig2);
            expect(typeof sig1).toBe('string');
            expect(sig1.length).toBe(64); // SHA256 hex is 64 chars
        });

        it('should produce different signatures for different payloads', () => {
            const sig1 = WebhookVerifier.generateSignature(payload, secret, timestamp);
            const sig2 = WebhookVerifier.generateSignature({ different: 'data' }, secret, timestamp);

            expect(sig1).not.toBe(sig2);
        });

        it('should produce different signatures for different secrets', () => {
            const sig1 = WebhookVerifier.generateSignature(payload, secret, timestamp);
            const sig2 = WebhookVerifier.generateSignature(payload, 'different-secret', timestamp);

            expect(sig1).not.toBe(sig2);
        });

        it('should produce different signatures for different timestamps', () => {
            const sig1 = WebhookVerifier.generateSignature(payload, secret, timestamp);
            const sig2 = WebhookVerifier.generateSignature(payload, secret, '1704825601');

            expect(sig1).not.toBe(sig2);
        });
    });

    describe('verify', () => {
        it('should return true for valid signatures', () => {
            const signature = WebhookVerifier.generateSignature(payload, secret, timestamp);
            const isValid = WebhookVerifier.verify(signature, payload, secret, timestamp);

            expect(isValid).toBe(true);
        });

        it('should return false for tampered payloads', () => {
            const signature = WebhookVerifier.generateSignature(payload, secret, timestamp);
            const tamperedPayload = { ...payload, name: 'Hacker' };
            const isValid = WebhookVerifier.verify(signature, tamperedPayload, secret, timestamp);

            expect(isValid).toBe(false);
        });

        it('should return false for wrong secret', () => {
            const signature = WebhookVerifier.generateSignature(payload, secret, timestamp);
            const isValid = WebhookVerifier.verify(signature, payload, 'wrong-secret', timestamp);

            expect(isValid).toBe(false);
        });

        it('should return false for wrong timestamp', () => {
            const signature = WebhookVerifier.generateSignature(payload, secret, timestamp);
            const isValid = WebhookVerifier.verify(signature, payload, secret, 'wrong-timestamp');

            expect(isValid).toBe(false);
        });
    });

    describe('secureCompare', () => {
        it('should return true for equal strings', () => {
            expect(WebhookVerifier.secureCompare('abc123', 'abc123')).toBe(true);
        });

        it('should return false for different strings', () => {
            expect(WebhookVerifier.secureCompare('abc123', 'xyz789')).toBe(false);
        });

        it('should return false for different length strings', () => {
            expect(WebhookVerifier.secureCompare('short', 'muchlongerstring')).toBe(false);
        });

        it('should return false for non-string inputs', () => {
            expect(WebhookVerifier.secureCompare(null, 'string')).toBe(false);
            expect(WebhookVerifier.secureCompare('string', undefined)).toBe(false);
            expect(WebhookVerifier.secureCompare(123, 456)).toBe(false);
        });
    });
});
