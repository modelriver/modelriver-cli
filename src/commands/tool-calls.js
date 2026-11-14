const ApiClient = require('../lib/api-client');
const Logger = require('../utils/logger');
const {
  plainText,
  formatArguments,
  approvalCommands,
  describeToolCallError,
} = require('../utils/tool-approvals');

/**
 * The API key for `tools show|approve|reject`: the same sources as
 * `modelriver tools` (never a .modelriverrc in the current directory).
 */
function apiKeyFor(options) {
  // Loaded here: tools.js pulls in the WebSocket client, which these
  // commands don't need.
  const { resolveApiKey } = require('./tools');
  return resolveApiKey(options.apiKey).apiKey;
}

function fail(message, hint) {
  Logger.error(message);
  if (hint) Logger.warning(`> ${hint}`);
  process.exit(1);
}

/**
 * Report a network failure or 5xx and exit.
 */
function failRequest(error) {
  if (error.response) {
    fail(`ModelRiver answered HTTP ${error.response.status}. Try again shortly.`);
  } else if (error.request) {
    fail('No response from ModelRiver. Check your network connection and API URL.');
  } else {
    fail(error.message);
  }
}

/**
 * Lines describing a call from GET /v1/ai/tool-calls/:call_id.
 * @param {object} view - {id, status, tool, prompt, arguments, expires_at, decided_at, channel_id}
 * @returns {string[]}
 */
function describeToolCallView(view) {
  const v = view || {};
  const lines = [
    `Call ${plainText(v.id || '?')}: ${plainText(v.status || 'unknown')}`,
    `  Tool: ${plainText(v.tool || '(unknown)')}`,
    `  Prompt: ${plainText(v.prompt ?? '')}`,
    '  Arguments shown to the end user:',
    ...formatArguments(v.arguments, '    '),
    `  Expires: ${plainText(v.expires_at || 'unknown')}`,
  ];
  if (v.decided_at) lines.push(`  Decided: ${plainText(v.decided_at)}`);
  if (v.channel_id) lines.push(`  Request (channel): ${plainText(v.channel_id)}`);
  return lines;
}

/**
 * modelriver tools show <call_id>
 *
 * Prints a call that waits for approval: the prompt and the arguments the
 * end user sees, nothing else.
 */
async function showToolCallCommand(options) {
  const { callId, apiUrl } = options;
  let response;
  try {
    const apiClient = new ApiClient(apiKeyFor(options), apiUrl);
    response = await apiClient.getToolCall(callId);
  } catch (error) {
    return failRequest(error);
  }

  if (response.status !== 200) {
    const { message, hint } = describeToolCallError(response);
    return fail(message, hint);
  }

  Logger.log(describeToolCallView(response.data).join('\n'));
  if (response.data && response.data.status === 'pending') {
    const commands = approvalCommands(response.data.id || callId);
    Logger.log('\nDecide it with:');
    Logger.log(`  ${commands.approve}`);
    Logger.log(`  ${commands.reject}`);
  }
}

const DECIDED = {
  approve: {
    verb: 'Approved',
    next: 'The request carries on once every waiting call of its round is decided; this call runs once.',
  },
  reject: {
    verb: 'Declined',
    next: 'The call will not run. The model is told the user declined it.',
  },
};

/**
 * modelriver tools approve|reject <call_id> --end-user <id>
 *
 * Sends the end user's decision, as the customer's backend would.
 * @param {"approve"|"reject"} decision
 * @param {object} options - {callId, endUser, apiKey, apiUrl}
 */
async function decideToolCallCommand(decision, options) {
  const { callId, endUser, apiUrl } = options;
  if (typeof endUser !== 'string' || endUser.trim() === '') {
    return fail('--end-user is required: the end_user.id the request was sent with.');
  }

  let response;
  try {
    const apiClient = new ApiClient(apiKeyFor(options), apiUrl);
    response = await apiClient.decideToolCall(callId, decision, endUser);
  } catch (error) {
    return failRequest(error);
  }

  if (response.status !== 200) {
    const { message, hint } = describeToolCallError(response, { decision });
    return fail(message, hint);
  }

  const data = response.data || {};
  const { verb, next } = DECIDED[decision];
  Logger.success(`${verb} ${plainText(data.id || callId)}${data.decided_at ? ` at ${plainText(data.decided_at)}` : ''}`);
  if (data.channel_id) Logger.info(`> Request (channel): ${plainText(data.channel_id)}`);
  Logger.log(next);
}

module.exports = {
  showToolCallCommand,
  decideToolCallCommand,
  describeToolCallView,
};
