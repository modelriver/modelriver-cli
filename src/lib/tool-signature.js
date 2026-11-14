const crypto = require('crypto');

// Reject calls whose timestamp is more than 5 minutes from now, so an old
// signed call can't be replayed.
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;
const VERSION = 'v2';

/**
 * Checks the signature ModelRiver puts on each hosted tool call.
 *
 * This is not the webhook signature (see WebhookVerifier). A tool call signs
 * the exact bytes of the request body together with the timestamp and the
 * call id:
 *
 *     x-modelriver-signature: v2=hex(HMAC-SHA256(secret, "v2.<timestamp>.<call id>.<raw body>"))
 *
 * While a signing secret is being rotated, the header carries one value per
 * valid secret, comma-separated, newest first; a call is valid when any of
 * them matches.
 *
 * Use the raw body as received. Parsing the JSON and encoding it again
 * changes the bytes and the signature no longer matches.
 */
class ToolSignature {
  /**
   * The hex signature for one call (without the "v2=" prefix).
   * @param {string} secret - the project's tool signing secret
   * @param {string|number} timestamp - x-modelriver-timestamp (Unix seconds)
   * @param {string} callId - x-modelriver-tool-call-id
   * @param {string|Buffer} rawBody - the request body exactly as received
   * @returns {string}
   */
  static sign(secret, timestamp, callId, rawBody) {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(`${VERSION}.${timestamp}.${callId}.`);
    hmac.update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8'));
    return hmac.digest('hex');
  }

  /**
   * The v2 values in an x-modelriver-signature header.
   * @param {string} header - e.g. "v2=abc…" or "v2=abc…,v2=def…"
   * @returns {string[]}
   */
  static parseHeader(header) {
    if (typeof header !== 'string') return [];
    return header
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${VERSION}=`))
      .map((part) => part.slice(VERSION.length + 1));
  }

  /**
   * Is the timestamp (Unix seconds) within `toleranceSeconds` of now?
   * @param {string|number} timestamp
   * @param {object} [options] - {now (ms), toleranceSeconds}
   * @returns {boolean}
   */
  static isTimestampFresh(timestamp, { now = Date.now(), toleranceSeconds = DEFAULT_TOLERANCE_SECONDS } = {}) {
    const text = String(timestamp ?? '').trim();
    if (!/^\d+$/.test(text)) return false;
    const seconds = Number(text);
    if (!Number.isSafeInteger(seconds)) return false;
    return Math.abs(Math.floor(now / 1000) - seconds) <= toleranceSeconds;
  }

  /**
   * Check signature and timestamp separately.
   *
   * @param {object} call
   * @param {string|string[]} call.secret - one secret, or several (e.g. old and new while you rotate)
   * @param {string|number} call.timestamp - x-modelriver-timestamp
   * @param {string} call.callId - x-modelriver-tool-call-id
   * @param {string|Buffer} call.rawBody - the request body exactly as received
   * @param {string} call.signature - x-modelriver-signature
   * @param {object} [options] - {now (ms), toleranceSeconds}
   * @returns {{valid: boolean, signatureValid: boolean, timestampValid: boolean}}
   */
  static check({ secret, timestamp, callId, rawBody, signature }, options = {}) {
    const secrets = (Array.isArray(secret) ? secret : [secret]).filter((s) => typeof s === 'string' && s !== '');
    const given = this.parseHeader(signature);
    let signatureValid = false;

    if (secrets.length > 0 && given.length > 0 && typeof callId === 'string' && callId !== '' && rawBody != null) {
      for (const s of secrets) {
        const expected = this.sign(s, String(timestamp ?? ''), callId, rawBody);
        // Compare against every value, so the time taken doesn't say which matched.
        for (const value of given) {
          if (secureCompare(value, expected)) signatureValid = true;
        }
      }
    }

    const timestampValid = this.isTimestampFresh(timestamp, options);
    return { valid: signatureValid && timestampValid, signatureValid, timestampValid };
  }

  /**
   * Verify a tool call: a matching v2 signature and a timestamp no more than
   * 5 minutes off.
   * @param {object} call - see check()
   * @param {object} [options] - {now (ms), toleranceSeconds}
   * @returns {boolean}
   */
  static verify(call, options = {}) {
    return this.check(call, options).valid;
  }

  /**
   * Verify a call from its headers (any object with lower-case header names,
   * such as Node's req.headers or Express's).
   * @param {object} headers
   * @param {string|Buffer} rawBody
   * @param {string|string[]} secret
   * @param {object} [options] - {now (ms), toleranceSeconds}
   * @returns {boolean}
   */
  static verifyRequest(headers, rawBody, secret, options = {}) {
    const h = headers || {};
    return this.verify({
      secret,
      timestamp: h['x-modelriver-timestamp'],
      callId: h['x-modelriver-tool-call-id'],
      rawBody,
      signature: h['x-modelriver-signature'],
    }, options);
  }
}

function secureCompare(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

ToolSignature.DEFAULT_TOLERANCE_SECONDS = DEFAULT_TOLERANCE_SECONDS;

module.exports = ToolSignature;
