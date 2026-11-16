const crypto = require('crypto');
const WebhookVerifier = require('./webhook-verifier');

describe('WebhookVerifier', () => {
    const secret = 'test-secret-key-12345';
    const timestamp = String(Math.floor(Date.now() / 1000));
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
            const sig2 = WebhookVerifier.generateSignature(payload, secret, String(Number(timestamp) + 1));

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

    describe('timestamp window', () => {
        const now = 1_763_100_000_000; // ms
        const nowSeconds = String(now / 1000);
        const sign = (ts) => WebhookVerifier.generateSignature(payload, secret, ts);

        it('accepts a timestamp up to 5 minutes old or ahead', () => {
            for (const offset of [0, -300, 300, -299, 120]) {
                const ts = String(now / 1000 + offset);
                expect(WebhookVerifier.verify(sign(ts), payload, secret, ts, { now })).toBe(true);
            }
        });

        it('rejects a correctly signed timestamp more than 5 minutes off', () => {
            for (const offset of [-301, 301, -3600, 86400]) {
                const ts = String(now / 1000 + offset);
                expect(WebhookVerifier.verify(sign(ts), payload, secret, ts, { now })).toBe(false);
                expect(WebhookVerifier.check(sign(ts), payload, secret, ts, { now })).toEqual({
                    valid: false, signatureValid: true, timestampValid: false,
                });
            }
        });

        it('rejects timestamps that are not whole Unix seconds', () => {
            for (const ts of ['', 'abc', '1.5', '-1', `${nowSeconds}000`, ' ']) {
                expect(WebhookVerifier.isTimestampFresh(ts, { now })).toBe(false);
            }
        });

        it('honours a custom tolerance', () => {
            const ts = String(now / 1000 - 30);
            expect(WebhookVerifier.isTimestampFresh(ts, { now, toleranceSeconds: 10 })).toBe(false);
            expect(WebhookVerifier.isTimestampFresh(ts, { now, toleranceSeconds: 60 })).toBe(true);
        });
    });

    describe('secureCompare', () => {
        it('uses crypto.timingSafeEqual', () => {
            const spy = jest.spyOn(crypto, 'timingSafeEqual');
            WebhookVerifier.secureCompare('abc123', 'abc124');
            expect(spy).toHaveBeenCalled();
            spy.mockRestore();
        });

        it('handles multi-byte strings of the same length in characters', () => {
            expect(WebhookVerifier.secureCompare('é', 'e')).toBe(false);
        });

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
