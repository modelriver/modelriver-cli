// Runs the real `modelriver login` with answers on stdin, in the temp home
// folder test/support/isolate-home.js sets up (MODELRIVER_CONFIG_DIR).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'modelriver');
const API_KEY = 'mr_live_login_test_abcdefghijklmnopqrstuvwxyz';

function configPath() {
  return path.join(process.env.MODELRIVER_CONFIG_DIR, 'config.json');
}

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
}

// Answers the prompts one line at a time as each prompt appears, so readline
// sees every answer.
function login(args, answers, env = {}, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } });
    let output = '';
    let answered = 0;
    const onData = (d) => {
      output += d;
      while (answered < answers.length && (output.match(/(?:key|\)): /g) || []).length > answered) {
        child.stdin.write(`${answers[answered]}\n`);
        answered += 1;
      }
      if (answered === answers.length) child.stdin.end();
      if (answers.length === 0) child.stdin.end();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`login did not exit. Output:\n${output}`));
    }, 10000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

describe('modelriver login (end to end)', () => {
  beforeEach(() => {
    fs.rmSync(configPath(), { force: true });
  });

  it('asks only for the API key and forward URL, and saves no API URL', async () => {
    const run = await login(['login'], [API_KEY, '']);

    expect(run.code).toBe(0);
    expect(run.output).not.toMatch(/API URL/);
    expect(readConfig()).toMatchObject({ api_key: API_KEY });
    expect(readConfig()).not.toHaveProperty('api_url');
    expect(fs.statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  it('saves --api-url without asking, so later commands use it', async () => {
    const run = await login(['login', '--api-url', 'http://localhost:4000/'], [API_KEY, '']);

    expect(run.code).toBe(0);
    expect(run.output).toContain('API URL: http://localhost:4000');
    expect(readConfig().api_url).toBe('http://localhost:4000');
  });

  it('keeps a saved API URL when login runs again without the flag', async () => {
    await login(['login', '--api-url', 'http://127.0.0.1:4000'], [API_KEY, '']);
    const second = await login(['login'], ['', ''], { MODELRIVER_API_URL: 'https://api.modelriver.com' });

    expect(second.code).toBe(0);
    expect(second.output).toContain('API URL: http://127.0.0.1:4000');
    expect(second.output).toMatch(/MODELRIVER_API_URL is set/);
    expect(readConfig().api_url).toBe('http://127.0.0.1:4000');
  });

  it('refuses a plain-http --api-url that is not this machine, and saves nothing', async () => {
    const run = await login(['login', '--api-url', 'http://api.example.com'], [API_KEY]);

    expect(run.code).toBe(1);
    expect(run.output).toMatch(/must use https/);
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it('does not list --api-url in its help', async () => {
    const run = await login(['login', '--help'], []);

    expect(run.output).not.toContain('--api-url');
  });

  it('lists hosted tools in the Quick Start', async () => {
    const run = await login(['login'], [API_KEY, '']);

    expect(run.output).toContain('modelriver tools --forward-to http://localhost:3000');
    expect(run.output).toContain('modelriver tools approve <call_id> --end-user <id>');
  });
});

describe('modelriver login in a folder with a .modelriverrc', () => {
  const RC_KEY = 'mr_live_planted_by_a_repo_0123456789';
  const HOME_KEY = 'mr_live_my_own_saved_key_9876543210';
  let repo;

  beforeEach(() => {
    fs.rmSync(configPath(), { force: true });
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'modelriver-cloned-repo-'));
    fs.writeFileSync(path.join(repo, '.modelriverrc'), JSON.stringify({ api_key: RC_KEY }));
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('does not offer the rc key as the default, so Enter does not save it', async () => {
    const run = await login(['login'], ['', ''], {}, { cwd: repo });

    expect(run.code).toBe(1);
    expect(run.output).toContain('API key is required');
    expect(run.output).toMatch(/Ignoring the API key in .*\.modelriverrc/);
    expect(run.output).not.toContain('…6789'); // not even masked
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it('offers the key already in config.json instead, and keeps it on Enter', async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ api_key: HOME_KEY }));

    const run = await login(['login'], ['', ''], {}, { cwd: repo });

    expect(run.code).toBe(0);
    expect(run.output).toContain('…3210');
    expect(readConfig().api_key).toBe(HOME_KEY);
  });

  it('saves --api-url there too, and later commands in that folder use it', async () => {
    const run = await login(['login', '--api-url', 'http://localhost:4000'], [API_KEY, ''], {}, { cwd: repo });
    expect(run.code).toBe(0);
    expect(readConfig().api_url).toBe('http://localhost:4000');

    // Runs in the rc folder: the saved URL must win over the default.
    const { execFileSync } = require('child_process');
    const url = execFileSync(process.execPath, ['-e', 'process.stdout.write(require(process.argv[1]).getApiUrl())', path.join(__dirname, '..', 'src', 'lib', 'config.js')], { cwd: repo, encoding: 'utf8' });
    expect(url).toBe('http://localhost:4000');
  });
});
