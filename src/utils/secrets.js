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

/**
 * Show a `modelriver tools` session token (cts_…) without revealing it:
 * "cts_…" plus the last 4 characters.
 * @param {string} value
 * @returns {string}
 */
function maskSessionToken(value) {
  if (!value || typeof value !== 'string') return '(not set)';
  const rest = value.startsWith('cts_') ? value.slice(4) : value;
  if (rest.length < 16) return 'cts_****';
  return `cts_…${rest.slice(-4)}`;
}

/**
 * A copy of a request payload that is safe to print: the CLI session token
 * in tool_route is masked.
 * @param {object} payload
 * @returns {object}
 */
function redactRequestPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const copy = { ...payload };
  if (copy.tool_route && typeof copy.tool_route === 'object' && 'cli_session' in copy.tool_route) {
    copy.tool_route = { ...copy.tool_route, cli_session: maskSessionToken(copy.tool_route.cli_session) };
  }
  return copy;
}

module.exports = { maskSecret, maskSessionToken, redactRequestPayload };
