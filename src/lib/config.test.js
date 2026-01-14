// We need to test the Config class, but it's exported as a singleton instance.
// We'll test the behavior through environment variables.

// Mock fs to prevent reading from actual ~/.modelriver/config.json
jest.mock('fs', () => ({
    existsSync: jest.fn(() => false),
    readFileSync: jest.fn(() => '{}'),
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn(),
}));

describe('Config', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        // Reset modules to get fresh Config instance
        jest.resetModules();
        // Re-apply the mock after resetModules
        jest.doMock('fs', () => ({
            existsSync: jest.fn(() => false),
            readFileSync: jest.fn(() => '{}'),
            writeFileSync: jest.fn(),
            mkdirSync: jest.fn(),
        }));
        process.env = { ...originalEnv };
        // Clear any config-related env vars
        delete process.env.MODELRIVER_API_KEY;
        delete process.env.MODELRIVER_API_URL;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('getApiKey', () => {
        it('should read API key from MODELRIVER_API_KEY env var', () => {
            process.env.MODELRIVER_API_KEY = 'mr_live_test123';
            const config = require('./config');

            expect(config.getApiKey()).toBe('mr_live_test123');
        });

        it('should return undefined when API key not set', () => {
            delete process.env.MODELRIVER_API_KEY;
            const config = require('./config');

            expect(config.getApiKey()).toBeFalsy();
        });
    });

    describe('getApiUrl', () => {
        it('should return default URL when not set', () => {
            delete process.env.MODELRIVER_API_URL;
            const config = require('./config');

            expect(config.getApiUrl()).toBe('https://api.modelriver.com');
        });

        it('should read API URL from MODELRIVER_API_URL env var', () => {
            process.env.MODELRIVER_API_URL = 'http://localhost:4000';
            const config = require('./config');

            expect(config.getApiUrl()).toBe('http://localhost:4000');
        });
    });

    describe('getWebSocketUrl', () => {
        it('should convert https:// to wss://', () => {
            process.env.MODELRIVER_API_URL = 'https://api.modelriver.com';
            const config = require('./config');

            expect(config.getWebSocketUrl()).toBe('wss://api.modelriver.com');
        });

        it('should convert http:// to ws://', () => {
            process.env.MODELRIVER_API_URL = 'http://localhost:4000';
            const config = require('./config');

            expect(config.getWebSocketUrl()).toBe('ws://localhost:4000');
        });
    });

    describe('get', () => {
        it('should prioritize env vars over defaults', () => {
            process.env.MODELRIVER_CUSTOM_KEY = 'env-value';
            const config = require('./config');

            expect(config.get('custom-key', 'default-value')).toBe('env-value');
        });

        it('should return default when env var not set', () => {
            delete process.env.MODELRIVER_MISSING_KEY;
            const config = require('./config');

            expect(config.get('missing-key', 'fallback')).toBe('fallback');
        });
    });
});
