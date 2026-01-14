// Mock fs to prevent reading from actual ~/.modelriver/config.json
jest.mock('fs', () => ({
    existsSync: jest.fn(() => false),
    readFileSync: jest.fn(() => '{}'),
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn(),
}));

describe('ApiClient', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.resetModules();
        // Re-apply the mock after resetModules
        jest.doMock('fs', () => ({
            existsSync: jest.fn(() => false),
            readFileSync: jest.fn(() => '{}'),
            writeFileSync: jest.fn(),
            mkdirSync: jest.fn(),
        }));
        process.env = { ...originalEnv };
        // Clear any config env vars first
        delete process.env.MODELRIVER_API_KEY;
        // Then set a valid API key for tests that need it
        process.env.MODELRIVER_API_KEY = 'mr_live_validtestkey123';
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('constructor validation', () => {
        it('should throw error when API key is missing', () => {
            delete process.env.MODELRIVER_API_KEY;
            const ApiClient = require('./api-client');

            expect(() => new ApiClient(null, 'https://api.modelriver.com'))
                .toThrow('API key is required');
        });

        it('should throw error for invalid API key format', () => {
            const ApiClient = require('./api-client');

            expect(() => new ApiClient('invalid-key-format', 'https://api.modelriver.com'))
                .toThrow('Invalid API key format');
        });

        it('should accept mr_live_ prefixed keys', () => {
            const ApiClient = require('./api-client');

            expect(() => new ApiClient('mr_live_abc123', 'https://api.modelriver.com'))
                .not.toThrow();
        });

        it('should accept mr_test_ prefixed keys', () => {
            const ApiClient = require('./api-client');

            expect(() => new ApiClient('mr_test_abc123', 'https://api.modelriver.com'))
                .not.toThrow();
        });
    });

    describe('apiPath detection', () => {
        it('should use /v1 for production URLs', () => {
            const ApiClient = require('./api-client');
            const client = new ApiClient('mr_live_test123', 'https://api.modelriver.com');

            expect(client.apiPath).toBe('/v1');
        });

        it('should use /v1 for *.modelriver.com subdomains', () => {
            const ApiClient = require('./api-client');
            const client = new ApiClient('mr_live_test123', 'https://staging.modelriver.com');

            expect(client.apiPath).toBe('/v1');
        });

        it('should use /api/v1 for localhost', () => {
            const ApiClient = require('./api-client');
            const client = new ApiClient('mr_live_test123', 'http://localhost:4000');

            expect(client.apiPath).toBe('/api/v1');
        });

        it('should use /api/v1 for non-production URLs', () => {
            const ApiClient = require('./api-client');
            const client = new ApiClient('mr_live_test123', 'http://my-dev-server.local');

            expect(client.apiPath).toBe('/api/v1');
        });
    });

    describe('URL normalization', () => {
        it('should strip trailing slashes from API URL', () => {
            const ApiClient = require('./api-client');
            const client = new ApiClient('mr_live_test123', 'https://api.modelriver.com/');

            expect(client.apiUrl).toBe('https://api.modelriver.com');
        });
    });
});
