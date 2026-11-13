// Uses the real file system in a temporary HOME and working directory.
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Config files', () => {
  const originalEnv = process.env;
  let home;
  let cwd;
  let cwdSpy;
  let warnSpy;
  let homeSpy;

  function loadConfig() {
    jest.resetModules();
    const config = require('./config');
    // Never let these tests write to the real ~/.modelriver.
    if (!config.getHomeConfigPath().startsWith(home + path.sep)) {
      throw new Error(`Refusing to run: config path ${config.getHomeConfigPath()} is outside the temp home`);
    }
    return config;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-cwd-'));
    process.env = { ...originalEnv };
    homeSpy = jest.spyOn(os, 'homedir').mockReturnValue(home);
    delete process.env.MODELRIVER_API_KEY;
    delete process.env.MODELRIVER_API_URL;
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    homeSpy.mockRestore();
    warnSpy.mockRestore();
    process.env = originalEnv;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const mode = (p) => fs.statSync(p).mode & 0o777;

  it('writes the config file 0600 inside a 0700 folder', () => {
    const config = loadConfig();
    config.saveConfig({ api_key: 'mr_live_secret_value_123456' });

    const dir = path.join(home, '.modelriver');
    const file = path.join(dir, 'config.json');
    expect(mode(dir)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ api_key: 'mr_live_secret_value_123456' });
    expect(fs.readdirSync(dir)).toEqual(['config.json']); // no temp file left behind
  });

  it('tightens an existing folder and file that are too open', () => {
    const dir = path.join(home, '.modelriver');
    const file = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(file, JSON.stringify({ forward_url: 'http://localhost:3001' }), { mode: 0o644 });
    fs.chmodSync(file, 0o644);

    const config = loadConfig();
    config.save('api-key', 'mr_live_secret_value_123456');

    expect(mode(dir)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      forward_url: 'http://localhost:3001',
      api_key: 'mr_live_secret_value_123456',
    });
  });

  it('ignores api_url in a .modelriverrc in the current directory, with a warning', () => {
    fs.writeFileSync(path.join(cwd, '.modelriverrc'), JSON.stringify({
      api_url: 'https://attacker.example.com',
      'api-url': 'https://attacker.example.com',
      forward_url: 'http://localhost:4000',
    }));

    const config = loadConfig();
    expect(config.getApiUrl()).toBe('https://api.modelriver.com');
    expect(config.getForwardUrl()).toBe('http://localhost:4000');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Ignoring api_url, api-url/));
  });

  it('still reads api_url from the home config', () => {
    const dir = path.join(home, '.modelriver');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ api_url: 'https://staging.modelriver.com' }));

    const config = loadConfig();
    expect(config.getApiUrl()).toBe('https://staging.modelriver.com');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('ignores non-string values instead of crashing', () => {
    fs.writeFileSync(path.join(cwd, '.modelriverrc'), JSON.stringify({ api_key: 42 }));
    const config = loadConfig();
    expect(config.getApiKey()).toBeFalsy();
  });
});
