const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const { CONFIG_DIR_MODE, CONFIG_FILE_MODE } = config;

const FILE_NAME = 'tool-sessions.json';
// A session about to expire isn't worth rejoining.
const EXPIRY_MARGIN_MS = 60 * 1000;
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
   */
  constructor({ dir = config.getConfigDir(), now = Date.now } = {}) {
    this.dir = dir;
    this.file = path.join(dir, FILE_NAME);
    this.now = now;
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
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const sessions = data && typeof data === 'object' && data.sessions;
      return sessions && typeof sessions === 'object' && !Array.isArray(sessions) ? sessions : {};
    } catch (error) {
      // No file yet, or one that can't be read: nothing saved.
      return {};
    }
  }

  writeAll(sessions) {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true, mode: CONFIG_DIR_MODE });
    }
    fs.chmodSync(this.dir, CONFIG_DIR_MODE);

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

  isUsable(record) {
    if (!record || typeof record !== 'object') return false;
    if (typeof record.session_id !== 'string' || !record.session_id.startsWith('cts_')) return false;
    if (typeof record.channel !== 'string' || !record.channel.startsWith('cli_tools:')) return false;
    const expires = Date.parse(record.expires_at);
    return Number.isFinite(expires) && expires - this.now() > EXPIRY_MARGIN_MS;
  }

  /**
   * The saved session for this key, if it has not expired.
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
    const sessions = this.readAll();
    for (const [name, record] of Object.entries(sessions)) {
      if (!this.isUsable(record)) delete sessions[name];
    }
    sessions[key] = {
      session_id: session.session_id,
      channel: session.channel,
      expires_at: session.expires_at,
      project_id: session.project_id,
      forwarded: forwarded.filter((id) => typeof id === 'string').slice(-FORWARDED_LIMIT),
    };
    this.writeAll(sessions);
  }

  /**
   * Record that a call was handed to the local server, before it is sent.
   * @param {string} key
   * @param {string} callId
   */
  addForwarded(key, callId) {
    const sessions = this.readAll();
    const record = sessions[key];
    if (!record || typeof record !== 'object') return;
    const forwarded = Array.isArray(record.forwarded) ? record.forwarded : [];
    forwarded.push(callId);
    record.forwarded = forwarded.slice(-FORWARDED_LIMIT);
    this.writeAll(sessions);
  }

  /**
   * Forget a session that can no longer be joined.
   * @param {string} key
   */
  remove(key) {
    const sessions = this.readAll();
    if (!(key in sessions)) return;
    delete sessions[key];
    this.writeAll(sessions);
  }
}

module.exports = ToolSessionStore;
module.exports.FILE_NAME = FILE_NAME;
module.exports.FORWARDED_LIMIT = FORWARDED_LIMIT;
module.exports.EXPIRY_MARGIN_MS = EXPIRY_MARGIN_MS;
