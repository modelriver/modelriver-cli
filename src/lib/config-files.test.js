// Uses the real file system in a temporary config folder and working directory.
// test/support/isolate-home.js also guards against touching the real ~/.modelriver.
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Config files', () => {
  const originalEnv = process.env;
  let home;
  let cwd;
  let cwdSpy;
  let warnSpy;

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
    process.env.MODELRIVER_CONFIG_DIR = path.join(home, '.modelriver');
    delete process.env.MODELRIVER_API_KEY;
    delete process.env.MODELRIVER_API_URL;
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
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

  it('reads api_url from the home config even when a .modelriverrc is in use', () => {
    const dir = path.join(home, '.modelriver');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ api_url: 'http://localhost:4000' }));
    fs.writeFileSync(path.join(cwd, '.modelriverrc'), JSON.stringify({ forward_url: 'http://localhost:5000', api_url: 'https://attacker.example.com' }));

    const config = loadConfig();
    expect(config.getApiUrl()).toBe('http://localhost:4000');
    expect(config.getForwardUrl()).toBe('http://localhost:5000'); // the rc still applies otherwise

    process.env.MODELRIVER_API_URL = 'https://env.modelriver.com';
    expect(config.getApiUrl()).toBe('https://env.modelriver.com');
  });

  it('offers login only a saved or environment forward URL, never a .modelriverrc one', () => {
    fs.writeFileSync(path.join(cwd, '.modelriverrc'), JSON.stringify({ forward_url: 'https://elsewhere.example.com/hook' }));
    const config = loadConfig();
    expect(config.getForwardUrl()).toBe('https://elsewhere.example.com/hook'); // still used in this folder
    expect(config.getSavedForwardUrl()).toBeNull();

    const dir = path.join(home, '.modelriver');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ forward_url: 'http://localhost:3001/hook' }));
    expect(loadConfig().getSavedForwardUrl()).toBe('http://localhost:3001/hook');

    process.env.MODELRIVER_FORWARD_URL = 'http://localhost:4444/hook';
    expect(loadConfig().getSavedForwardUrl()).toBe('http://localhost:4444/hook');
  });

  it('uses the API URL that saveConfig (login --api-url) just wrote, with a .modelriverrc present', () => {
    fs.writeFileSync(path.join(cwd, '.modelriverrc'), JSON.stringify({ forward_url: 'http://localhost:5000' }));
    const config = loadConfig();
    expect(config.getApiUrl()).toBe('https://api.modelriver.com');
    config.saveConfig({ api_url: 'http://localhost:4000' });
    expect(config.getApiUrl()).toBe('http://localhost:4000');
    expect(loadConfig().getApiUrl()).toBe('http://localhost:4000');
  });

  it('ignores non-string values instead of crashing', () => {
    fs.writeFileSync(path.join(cwd, '.modelriverrc'), JSON.stringify({ api_key: 42 }));
    const config = loadConfig();
    expect(config.getApiKey()).toBeFalsy();
  });

  it('falls back to <home>/.modelriver when MODELRIVER_CONFIG_DIR is not set', () => {
    delete process.env.MODELRIVER_CONFIG_DIR;
    const homeSpy = jest.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const config = loadConfig();
      expect(config.getConfigDir()).toBe(path.join(home, '.modelriver'));
    } finally {
      homeSpy.mockRestore();
    }
  });
});

describe('test isolation guard', () => {
  // os.userInfo() reads the account database, not the patched os.homedir().
  const realConfigDir = path.join(os.userInfo().homedir, '.modelriver');

  it('makes os.homedir() throw', () => {
    expect(() => os.homedir()).toThrow(/real home folder/);
  });

  it('points the config folder at a temp folder', () => {
    jest.resetModules();
    const config = require('./config');
    expect(config.getConfigDir()).toBe(process.env.MODELRIVER_CONFIG_DIR);
    expect(config.getConfigDir().startsWith(realConfigDir)).toBe(false);
    expect(process.env.HOME).not.toBe(os.userInfo().homedir);
  });

  it('gives child processes started without an env the temp config folder', () => {
    const { execFileSync, spawnSync } = require('child_process');
    const script = 'process.stdout.write(JSON.stringify([process.env.MODELRIVER_CONFIG_DIR, process.env.HOME]))';
    const expected = JSON.stringify([process.env.MODELRIVER_CONFIG_DIR, process.env.HOME]);
    expect(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })).toBe(expected);
    expect(spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' }).stdout).toBe(expected);
    expect(spawnSync(process.execPath, ['-e', script]).stdout.toString()).toBe(expected);
    expect(process.env.HOME).not.toBe(os.userInfo().homedir);
  });

  it('refuses any file access inside the real ~/.modelriver', () => {
    const file = path.join(realConfigDir, 'config.json');
    expect(() => fs.existsSync(file)).toThrow(/real home folder/);
    expect(() => fs.readFileSync(file)).toThrow(/real home folder/);
    expect(() => fs.writeFileSync(file, '{}')).toThrow(/real home folder/);
    expect(() => fs.renameSync('/tmp/x', file)).toThrow(/real home folder/);
    expect(() => fs.chmodSync(realConfigDir, 0o700)).toThrow(/real home folder/);
  });

  it('refuses saveConfig when the config folder resolves to the real one', () => {
    process.env.MODELRIVER_CONFIG_DIR = realConfigDir;
    try {
      jest.resetModules();
      expect(() => require('./config').saveConfig({ api_key: 'mr_live_nope_nope_nope_nope' })).toThrow(/real home folder/);
    } finally {
      process.env.MODELRIVER_CONFIG_DIR = path.join(os.tmpdir(), 'unused');
    }
  });
});
