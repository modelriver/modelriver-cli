const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ToolSessionStore = require('./tool-session-store');

const WRITER = path.join(__dirname, '..', '..', 'test', 'support', 'session-store-writer.js');

describe('ToolSessionStore', () => {
  const T0 = Date.parse('2026-11-14T10:00:00Z');
  const TOKEN = 'cts_AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  const session = (overrides = {}) => ({
    session_id: TOKEN,
    channel: 'cli_tools:5d6e7f80-aaaa-bbbb-cccc-000000000001',
    expires_at: '2026-11-15T10:00:00Z',
    project_id: 'p1',
    ...overrides,
  });
  const keyOf = (overrides = {}) => ToolSessionStore.keyFor({
    apiUrl: 'https://api.modelriver.com', apiKey: 'mr_live_abcdefghijklmnopqrstuvwxyz', origin: 'http://localhost:3000', ...overrides,
  });

  let dir;
  let now;
  let store;

  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mr-tool-sessions-')), '.modelriver');
    now = T0;
    store = new ToolSessionStore({ dir, now: () => now });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it('returns a saved session, with nothing forwarded yet', () => {
    const key = keyOf();
    expect(store.load(key)).toBeNull();
    store.save(key, session());
    expect(store.load(key)).toEqual({ ...session(), forwarded: [] });
  });

  it('keeps the file and its folder readable only by the owner', () => {
    store.save(keyOf(), session());
    if (process.platform !== 'win32') {
      expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
    // No temp file is left next to it.
    expect(fs.readdirSync(dir)).toEqual(['tool-sessions.json']);
  });

  it('never stores the API key, and files a session per API URL, API key and local server', () => {
    const key = keyOf();
    store.save(key, session());
    const text = fs.readFileSync(store.file, 'utf8');
    expect(text).not.toContain('mr_live_abcdefghijklmnopqrstuvwxyz');
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    expect(store.load(keyOf({ origin: 'http://localhost:4000' }))).toBeNull();
    expect(store.load(keyOf({ apiKey: 'mr_live_another_key_0123456789abcd' }))).toBeNull();
    expect(store.load(keyOf({ apiUrl: 'http://localhost:4000' }))).toBeNull();
  });

  it('does not return a session with less than an hour left', () => {
    const key = keyOf();
    store.save(key, session({ expires_at: new Date(T0 + 3 * 60 * 60 * 1000).toISOString() }));
    expect(store.load(key)).not.toBeNull();

    now = T0 + 2 * 60 * 60 * 1000; // exactly an hour left: still rejoined
    expect(store.load(key)).not.toBeNull();

    now = T0 + 2 * 60 * 60 * 1000 + 1000; // 59:59 left
    expect(store.load(key)).toBeNull();

    now = T0 + 4 * 60 * 60 * 1000; // expired
    expect(store.load(key)).toBeNull();
  });

  it('keeps another key\'s session with under an hour left (another CLI may be using it), but drops expired ones', () => {
    const other = keyOf({ origin: 'http://localhost:4000' });
    store.save(other, session({ session_id: 'cts_short_session_token_0123456789ab', expires_at: new Date(T0 + 30 * 60 * 1000).toISOString() }));
    store.save(keyOf(), session());
    expect(fs.readFileSync(store.file, 'utf8')).toContain('cts_short_session_token');
  });

  it('drops expired sessions from the file when another one is saved', () => {
    const old = keyOf({ origin: 'http://localhost:4000' });
    store.save(old, session({ session_id: 'cts_old_session_token_0123456789abcd', expires_at: new Date(T0 + 5 * 60 * 1000).toISOString() }));
    now = T0 + 60 * 60 * 1000;
    store.save(keyOf(), session());
    expect(fs.readFileSync(store.file, 'utf8')).not.toContain('cts_old_session_token');
  });

  it('remembers the calls forwarded, the newest 1000', () => {
    const key = keyOf();
    store.save(key, session());
    store.addForwarded(key, 'tc_a');
    store.addForwarded(key, 'tc_b');
    expect(new ToolSessionStore({ dir, now: () => now }).load(key).forwarded).toEqual(['tc_a', 'tc_b']);

    for (let i = 0; i < ToolSessionStore.FORWARDED_LIMIT; i += 1) store.addForwarded(key, `tc_${i}`);
    const { forwarded } = store.load(key);
    expect(forwarded).toHaveLength(ToolSessionStore.FORWARDED_LIMIT);
    expect(forwarded).not.toContain('tc_a');
    expect(forwarded[forwarded.length - 1]).toBe(`tc_${ToolSessionStore.FORWARDED_LIMIT - 1}`);
  });

  it('saves a session together with the calls already forwarded on it', () => {
    const key = keyOf();
    store.save(key, session(), ['tc_early']);
    store.addForwarded(key, 'tc_later');
    expect(store.load(key).forwarded).toEqual(['tc_early', 'tc_later']);
  });

  it('saving a new session for the same key starts its forwarded list again', () => {
    const key = keyOf();
    store.save(key, session());
    store.addForwarded(key, 'tc_a');
    store.save(key, session({ session_id: 'cts_new_session_token_0123456789abcd' }));
    expect(store.load(key)).toMatchObject({ session_id: 'cts_new_session_token_0123456789abcd', forwarded: [] });
  });

  it('forgets a session', () => {
    const key = keyOf();
    store.save(key, session());
    store.remove(key);
    expect(store.load(key)).toBeNull();
    expect(fs.readFileSync(store.file, 'utf8')).not.toContain(TOKEN);
    store.remove(key); // nothing to do
    store.addForwarded(key, 'tc_a'); // nothing to add to
    expect(store.load(key)).toBeNull();
  });

  it('treats a file it cannot read, or a record of the wrong shape, as nothing saved', () => {
    const key = keyOf();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(store.file, 'not json');
    expect(store.load(key)).toBeNull();

    fs.writeFileSync(store.file, JSON.stringify({ sessions: { [key]: { session_id: 'not-a-token', channel: 'cli_webhooks:1', expires_at: '2026-11-15T10:00:00Z' } } }));
    expect(store.load(key)).toBeNull();

    store.save(key, session());
    expect(store.load(key)).not.toBeNull();
  });

  describe('several CLIs at once', () => {
    it('keeps every record when several processes write at the same time', async () => {
      const SHARED = 'shared';
      // A long-lived session every writer adds forwarded calls to.
      new ToolSessionStore({ dir }).save(SHARED, session({ session_id: 'cts_shared_session_0123456789abcd', expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }));

      const WRITERS = 6;
      const EACH = 15;
      const startAt = Date.now() + 500;
      const runs = Array.from({ length: WRITERS }, (_, n) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [WRITER, dir, `w${n}`, String(EACH), SHARED, String(startAt)], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${n} failed: ${stderr}`))));
      }));
      await Promise.all(runs);

      const reader = new ToolSessionStore({ dir });
      const all = reader.readAll();
      for (let n = 0; n < WRITERS; n += 1) {
        for (let i = 0; i < EACH; i += 1) {
          expect(all[`w${n}-${i}`]).toMatchObject({ session_id: `cts_w${n}_${i}_0123456789abcdef` });
        }
      }
      expect(Object.keys(all)).toHaveLength(WRITERS * EACH + 1);
      expect(all[SHARED].forwarded).toHaveLength(WRITERS * EACH);
      expect(fs.existsSync(reader.lockFile)).toBe(false);
      expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp') || f.includes('.stale'))).toEqual([]);
    }, 30000);

    it('takes over a lock left by a crashed CLI (older than 10 s)', () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(store.lockFile, '99999\n');
      const old = (Date.now() - 20 * 1000) / 1000;
      fs.utimesSync(store.lockFile, old, old);

      store.save(keyOf(), session());
      expect(store.load(keyOf())).not.toBeNull();
      expect(fs.existsSync(store.lockFile)).toBe(false);
    });

    it('waits for a lock another CLI holds, then gives up with a clear error', () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(store.lockFile, '99999\n');
      const waiting = new ToolSessionStore({ dir, now: () => now, lockTimeoutMs: 150 });
      const started = Date.now();
      expect(() => waiting.save(keyOf(), session())).toThrow(/Timed out waiting for .*tool-sessions\.json\.lock/);
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
      expect(fs.existsSync(store.lockFile)).toBe(true); // not ours to remove
      expect(waiting.load(keyOf())).toBeNull();
    });
  });

  it('tightens the folder to 0700 and the file to 0600 when it reads them', () => {
    store.save(keyOf(), session());
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(store.file, 0o644);

    expect(store.load(keyOf())).not.toBeNull();
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  });

  it('removes a record only while it is still the given session', () => {
    const key = keyOf();
    store.save(key, session());
    // Another CLI (--new-session) saved a newer session under the same key.
    store.save(key, session({ session_id: 'cts_newer_session_token_0123456789' }));

    expect(store.remove(key, TOKEN)).toBe(false);
    expect(store.load(key)).toMatchObject({ session_id: 'cts_newer_session_token_0123456789' });

    store.addForwarded(key, 'call_from_the_old_cli', TOKEN);
    expect(store.load(key).forwarded).toEqual([]);
    store.addForwarded(key, 'call_from_the_new_cli', 'cts_newer_session_token_0123456789');
    expect(store.load(key).forwarded).toEqual(['call_from_the_new_cli']);

    expect(store.remove(key, 'cts_newer_session_token_0123456789')).toBe(true);
    expect(store.load(key)).toBeNull();
  });
});
