const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const { CONFIG_DIR_MODE, CONFIG_FILE_MODE } = config;

const FILE_NAME = 'tool-sessions.json';
// A saved session with less than this left is not rejoined; a new one is
// opened instead, so a restarted CLI doesn't run on a session about to end.
const REUSE_MIN_REMAINING_MS = 60 * 60 * 1000;
// Every read-modify-write of the file holds <file>.lock (created with O_EXCL),
// so several CLIs writing at once don't lose each other's records.
const LOCK_STALE_MS = 10 * 1000; // a lock this old was left by a crashed CLI
const LOCK_TIMEOUT_MS = 5 * 1000;
const LOCK_RETRY_MIN_MS = 5;
const LOCK_RETRY_MAX_MS = 100;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
// How many forwarded call ids are kept per session (oldest forgotten first).
const FORWARDED_LIMIT = 1000;

/**
 * The `modelriver tools` sessions this machine opened, so a CLI that was
 * stopped or restarted rejoins the session it had instead of opening a new
 * one: requests that already name the session keep working.
 *
 * Kept in <config dir>/tool-sessions.json (default ~/.modelriver), readable
 * only by you (0600, in a 0700 folder): a session token works like a
 * password while it is valid. Each session is filed under a hash of the API
 * URL, the API key and the --forward-to origin, so it is only reused for the
 * same account and the same local server. The API key itself is not stored.
 *
 * Each record also lists the calls already forwarded to the local server, so
 * a restarted CLI never forwards one of them a second time.
 */
class ToolSessionStore {
  /**
   * @param {object} [options]
   * @param {string} [options.dir] - folder for the file (default: the config folder)
   * @param {Function} [options.now] - () => ms since epoch
   * @param {number} [options.lockTimeoutMs] - how long to wait for the lock
   */
  constructor({ dir = config.getConfigDir(), now = Date.now, lockTimeoutMs = LOCK_TIMEOUT_MS } = {}) {
    this.lockTimeoutMs = lockTimeoutMs;
    this.dir = dir;
    this.file = path.join(dir, FILE_NAME);
    this.lockFile = `${this.file}.lock`;
    this.now = now;
  }

  /**
   * Make the folder 0700 and the file 0600 if they are looser (an older CLI,
   * a copy or a restore may have left them readable by others).
   */
  tightenPermissions() {
    for (const [target, mode] of [[this.dir, CONFIG_DIR_MODE], [this.file, CONFIG_FILE_MODE]]) {
      try {
        const stat = fs.statSync(target);
        if ((stat.mode & 0o777) !== mode) fs.chmodSync(target, mode);
      } catch (error) {
        // Missing, or not ours to change: nothing to do.
      }
    }
  }

  ensureDir() {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true, mode: CONFIG_DIR_MODE });
    }
    fs.chmodSync(this.dir, CONFIG_DIR_MODE);
  }

  /**
   * Run fn while holding the lock file, so no other CLI reads or writes the
   * session file in between. Works across processes: the lock is created
   * with O_EXCL. A lock older than LOCK_STALE_MS is taken over.
   * @param {Function} fn
   * @returns {*} fn's result
   */
  withLock(fn) {
    this.ensureDir();
    const deadline = Date.now() + this.lockTimeoutMs;
    let wait = LOCK_RETRY_MIN_MS;
    for (;;) {
      let fd;
      try {
        fd = fs.openSync(this.lockFile, 'wx', CONFIG_FILE_MODE);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (this.removeStaleLock()) continue;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for ${this.lockFile}; another "modelriver tools" is holding it`);
        }
        sleepSync(wait + Math.floor(Math.random() * wait));
        wait = Math.min(wait * 2, LOCK_RETRY_MAX_MS);
        continue;
      }

      try {
        fs.writeSync(fd, `${process.pid}\n`);
      } finally {
        fs.closeSync(fd);
      }
      try {
        return fn();
      } finally {
        try { fs.unlinkSync(this.lockFile); } catch (error) { /* already gone */ }
      }
    }
  }

  /**
   * Remove the lock file if it is stale. It is first moved aside and checked
   * again, so a lock another CLI took a moment ago is not removed by mistake.
   * @returns {boolean} true when a stale lock was removed
   */
  removeStaleLock() {
    let stat;
    try {
      stat = fs.statSync(this.lockFile);
    } catch (error) {
      return error.code === 'ENOENT'; // released meanwhile: try again now
    }
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false;

    const aside = `${this.lockFile}.stale.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(this.lockFile, aside);
    } catch (error) {
      return error.code === 'ENOENT';
    }
    try {
      const moved = fs.statSync(aside);
      if (moved.ino !== stat.ino) {
        // Another CLI replaced the stale lock with its own in between: put it back.
        try { fs.linkSync(aside, this.lockFile); } catch (error) { /* a newer lock exists */ }
      }
    } finally {
      try { fs.unlinkSync(aside); } catch (error) { /* already gone */ }
    }
    return true;
  }

  /**
   * The name a session is filed under.
   * @param {object} what - {apiUrl, apiKey, origin}
   * @returns {string}
   */
  static keyFor({ apiUrl, apiKey, origin }) {
    return crypto
      .createHash('sha256')
      .update([apiUrl, apiKey, origin].map((part) => String(part || '')).join('\0'))
      .digest('hex');
  }

  readAll() {
    this.tightenPermissions();
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const sessions = data && typeof data === 'object' && data.sessions;
      return sessions && typeof sessions === 'object' && !Array.isArray(sessions) ? sessions : {};
    } catch (error) {
      // No file yet, or one that can't be read: nothing saved.
      return {};
    }
  }

  // Call only inside withLock().
  writeAll(sessions) {
    this.ensureDir();

    // Written as a new 0600 file and moved into place, so the tokens are never
    // in a file other users can read, even for a moment.
    const tmpPath = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, sessions }, null, 2), {
        encoding: 'utf8', mode: CONFIG_FILE_MODE, flag: 'wx',
      });
      fs.chmodSync(tmpPath, CONFIG_FILE_MODE);
      fs.renameSync(tmpPath, this.file);
    } catch (error) {
      try { fs.unlinkSync(tmpPath); } catch (cleanupError) { /* already gone */ }
      throw error;
    }
  }

  /**
   * Milliseconds the record has left, or -Infinity when it isn't a session.
   */
  remainingMs(record) {
    if (!record || typeof record !== 'object') return -Infinity;
    if (typeof record.session_id !== 'string' || !record.session_id.startsWith('cts_')) return -Infinity;
    if (typeof record.channel !== 'string' || !record.channel.startsWith('cli_tools:')) return -Infinity;
    const expires = Date.parse(record.expires_at);
    return Number.isFinite(expires) ? expires - this.now() : -Infinity;
  }

  /** Worth rejoining: at least an hour left. */
  isUsable(record) {
    return this.remainingMs(record) >= REUSE_MIN_REMAINING_MS;
  }

  /**
   * The saved session for this key, if it has at least an hour left.
   * @param {string} key - from keyFor()
   * @returns {{session_id: string, channel: string, expires_at: string, project_id: (string|undefined), forwarded: string[]}|null}
   */
  load(key) {
    const record = this.readAll()[key];
    if (!this.isUsable(record)) return null;
    return {
      session_id: record.session_id,
      channel: record.channel,
      expires_at: record.expires_at,
      project_id: record.project_id,
      forwarded: Array.isArray(record.forwarded) ? record.forwarded.filter((id) => typeof id === 'string') : [],
    };
  }

  /**
   * Save a session the CLI has joined. Expired sessions are dropped from the
   * file at the same time.
   * @param {string} key
   * @param {object} session - {session_id, channel, expires_at, project_id}
   * @param {string[]} [forwarded] - calls already handed to the local server
   *   (one can arrive right behind the join, before the session is saved)
   */
  save(key, session, forwarded = []) {
    this.withLock(() => {
      const sessions = this.readAll();
      // Only expired ones: a session with little time left may still be in
      // use by another CLI.
      for (const [name, record] of Object.entries(sessions)) {
        if (this.remainingMs(record) <= 0) delete sessions[name];
      }
      sessions[key] = {
        session_id: session.session_id,
        channel: session.channel,
        expires_at: session.expires_at,
        project_id: session.project_id,
        forwarded: forwarded.filter((id) => typeof id === 'string').slice(-FORWARDED_LIMIT),
      };
      this.writeAll(sessions);
    });
  }

  /**
   * Record that a call was handed to the local server, before it is sent.
   * @param {string} key
   * @param {string} callId
   * @param {string} [sessionId] - only record it if the saved session is still
   *   this one (another CLI may have saved a newer one under the same key)
   */
  addForwarded(key, callId, sessionId) {
    this.withLock(() => {
      const sessions = this.readAll();
      const record = sessions[key];
      if (!record || typeof record !== 'object') return;
      if (sessionId !== undefined && record.session_id !== sessionId) return;
      const forwarded = Array.isArray(record.forwarded) ? record.forwarded : [];
      forwarded.push(callId);
      record.forwarded = forwarded.slice(-FORWARDED_LIMIT);
      this.writeAll(sessions);
    });
  }

  /**
   * Forget a session that can no longer be joined.
   * @param {string} key
   * @param {string} [sessionId] - only remove the record if it is still this
   *   session; another CLI (--new-session) may have saved a newer one under
   *   the same key
   * @returns {boolean} whether a record was removed
   */
  remove(key, sessionId) {
    return this.withLock(() => {
      const sessions = this.readAll();
      if (!(key in sessions)) return false;
      if (sessionId !== undefined && (!sessions[key] || sessions[key].session_id !== sessionId)) return false;
      delete sessions[key];
      this.writeAll(sessions);
      return true;
    });
  }
}

module.exports = ToolSessionStore;
module.exports.FILE_NAME = FILE_NAME;
module.exports.FORWARDED_LIMIT = FORWARDED_LIMIT;
module.exports.REUSE_MIN_REMAINING_MS = REUSE_MIN_REMAINING_MS;
module.exports.LOCK_STALE_MS = LOCK_STALE_MS;
