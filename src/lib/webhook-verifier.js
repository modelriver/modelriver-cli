const crypto = require('crypto');

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
   * Verify webhook signature
   * @param {string} providedSignature - Signature from X-ModelRiver-Signature header
   * @param {object} payload - The payload.data object from webhook body
   * @param {string} secret - Webhook secret
   * @param {string|number} timestamp - Timestamp from X-ModelRiver-Timestamp header
   * @returns {boolean} - True if signature is valid
   */
  static verify(providedSignature, payload, secret, timestamp) {
    const expectedSignature = this.generateSignature(payload, secret, timestamp);
    return this.secureCompare(providedSignature, expectedSignature);
  }

  /**
   * Constant-time comparison to prevent timing attacks
   * Matches backend implementation
   */
  static secureCompare(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') {
      return false;
    }

    if (left.length !== right.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < left.length; i++) {
      result |= left.charCodeAt(i) ^ right.charCodeAt(i);
    }

    return result === 0;
  }
}

module.exports = WebhookVerifier;


