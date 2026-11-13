/**
 * Show a secret without revealing it: known prefix (mr_live_, mr_test_) plus
 * the last 4 characters, e.g. "mr_live_…a1b2". Short or unknown values are
 * shown as "****".
 * @param {string} value
 * @returns {string}
 */
function maskSecret(value) {
  if (!value || typeof value !== 'string') return '(not set)';
  const prefix = ['mr_live_', 'mr_test_'].find((p) => value.startsWith(p)) || '';
  const rest = value.slice(prefix.length);
  if (rest.length < 16) return `${prefix}****`;
  return `${prefix}…${rest.slice(-4)}`;
}

module.exports = { maskSecret };
