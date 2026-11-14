const fs = require('fs');
const os = require('os');
const path = require('path');
const ToolSessionStore = require('./tool-session-store');

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

  it('does not return a session that has expired, or is about to', () => {
    const key = keyOf();
    store.save(key, session({ expires_at: new Date(T0 + 10 * 60 * 1000).toISOString() }));
    expect(store.load(key)).not.toBeNull();

    now = T0 + 9 * 60 * 1000 + 30 * 1000; // 30 seconds left
    expect(store.load(key)).toBeNull();
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
});
