const crypto = require('crypto');

// Reject webhooks whose timestamp is more than 5 minutes from now, so an old
// signed delivery can't be replayed.
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

class WebhookVerifier {
  /**
   * Generate HMAC-SHA256 signature for webhook payload
   * Matches backend implementation in lib/modelriver/workers/webhook_delivery_worker.ex
   */
  static generateSignature(payload, secret, timestamp) {
    // Create signature payload: timestamp.json_payload
    const jsonPayload = JSON.stringify(payload);
    const signaturePayload = `${timestamp}.${jsonPayload}`;

    // Generate HMAC-SHA256
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(signaturePayload);
    return hmac.digest('hex');
  }

  /**
   * Is the timestamp (Unix seconds) within `toleranceSeconds` of now?
   * @param {string|number} timestamp
   * @param {object} [options]
   * @param {number} [options.now] - current time in ms (tests)
   * @param {number} [options.toleranceSeconds]
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
   * @returns {{valid: boolean, signatureValid: boolean, timestampValid: boolean}}
   */
  static check(providedSignature, payload, secret, timestamp, options = {}) {
    const expectedSignature = this.generateSignature(payload, secret, timestamp);
    const signatureValid = this.secureCompare(providedSignature, expectedSignature);
    const timestampValid = this.isTimestampFresh(timestamp, options);
    return { valid: signatureValid && timestampValid, signatureValid, timestampValid };
  }

  /**
   * Verify webhook signature and that the timestamp is no more than 5 minutes off.
   * @param {string} providedSignature - Signature from X-ModelRiver-Signature header
   * @param {object} payload - The payload.data object from webhook body
   * @param {string} secret - Webhook secret
   * @param {string|number} timestamp - Timestamp from X-ModelRiver-Timestamp header (Unix seconds)
   * @param {object} [options] - {now, toleranceSeconds}
   * @returns {boolean} - True if signature is valid and the timestamp is fresh
   */
  static verify(providedSignature, payload, secret, timestamp, options = {}) {
    return this.check(providedSignature, payload, secret, timestamp, options).valid;
  }

  /**
   * Constant-time comparison to prevent timing attacks
   */
  static secureCompare(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') {
      return false;
    }

    const a = Buffer.from(left, 'utf8');
    const b = Buffer.from(right, 'utf8');
    if (a.length !== b.length) {
      return false;
    }

    return crypto.timingSafeEqual(a, b);
  }
}

WebhookVerifier.DEFAULT_TOLERANCE_SECONDS = DEFAULT_TOLERANCE_SECONDS;

module.exports = WebhookVerifier;
