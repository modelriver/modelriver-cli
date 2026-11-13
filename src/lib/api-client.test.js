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
            const client = new ApiClient('mr_live_test123', 'https://my-dev-server.local');

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

    describe('API URL scheme', () => {
        it.each(['http://localhost:4000', 'http://127.0.0.1:4000', 'http://[::1]:4000', 'https://api.modelriver.com'])(
            'accepts %s',
            (url) => {
                const ApiClient = require('./api-client');
                expect(() => new ApiClient('mr_live_test123', url)).not.toThrow();
            }
        );

        it.each(['http://api.modelriver.com', 'http://my-dev-server.local', 'http://10.0.0.5:4000', 'ftp://localhost', 'not-a-url'])(
            'refuses %s',
            (url) => {
                const ApiClient = require('./api-client');
                expect(() => new ApiClient('mr_live_test123', url)).toThrow(/API URL/);
            }
        );
    });

    describe('secrets in debug output', () => {
        it('never prints the API key or a prefix of it', async () => {
            process.env.DEBUG = '1';
            const log = jest.spyOn(console, 'log').mockImplementation(() => {});
            const ApiClient = require('./api-client');
            const key = 'mr_live_abcdefghijklmnopqrstuvwxyz0123456789';
            const client = new ApiClient(key, 'https://api.modelriver.com');
            client.client.post = jest.fn(async () => ({ status: 200, data: { ws_token: 't' } }));
            await client.connectCLI();

            const printed = log.mock.calls.flat().join('\n');
            expect(printed).not.toContain(key.slice(8, 20));
            log.mockRestore();
        });
    });

    describe('sendCallback', () => {
        it('refuses to send the API key to another host', async () => {
            const axios = require('axios');
            const post = jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {} });
            const ApiClient = require('./api-client');
            const client = new ApiClient('mr_live_test123', 'https://api.modelriver.com');

            await expect(client.sendCallback('https://attacker.example.com/v1/callback/abc', {}))
                .rejects.toThrow(/Refusing to send your API key to https:\/\/attacker\.example\.com/);
            await expect(client.sendCallback('http://api.modelriver.com/v1/callback/abc', {}))
                .rejects.toThrow(/Refusing/);
            await expect(client.sendCallback('https://api.modelriver.com.attacker.example/v1/callback/abc', {}))
                .rejects.toThrow(/Refusing/);
            expect(post).not.toHaveBeenCalled();
            post.mockRestore();
        });

        it('sends to the configured API host without following redirects', async () => {
            const axios = require('axios');
            const post = jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
            const ApiClient = require('./api-client');
            const client = new ApiClient('mr_live_test123', 'https://api.modelriver.com');

            await client.sendCallback('https://api.modelriver.com/v1/callback/abc', { data: {} });
            expect(post).toHaveBeenCalledWith(
                'https://api.modelriver.com/v1/callback/abc',
                { data: {} },
                expect.objectContaining({
                    headers: expect.objectContaining({ Authorization: 'Bearer mr_live_test123' }),
                    maxRedirects: 0,
                })
            );
            post.mockRestore();
        });
    });
});
