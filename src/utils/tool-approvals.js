// Helpers for hosted-tools calls that wait for the end user's approval:
// showing them as plain text, the commands that decide them, how long to
// keep following a paused request, and what the approval API's errors mean.

// A request waits for approval at most an hour; a far-off expires_at (a
// wrong clock) can't keep the CLI waiting longer. After the last approval
// expires, give the server this long to resume and answer. Same numbers as
// the JS SDK (RESUMABLE_REQUEST_MAX_AGE_MS, APPROVAL_RESUME_MARGIN_MS).
const MAX_APPROVAL_WAIT_MS = 60 * 60 * 1000;
const APPROVAL_RESUME_MARGIN_MS = 5 * 60 * 1000;

// C0 controls except tab and new line, DEL, C1 controls, the Unicode line and
// paragraph separators, and invisible or direction-changing characters that
// could make approval text read differently from what it says: zero-width
// characters and marks (U+200B-U+200F, U+2060-U+2064, U+FEFF, U+061C) and
// bidi embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * Show a value as plain text. Text the model or the tool wrote must not be
 * able to drive the terminal, so control characters (ANSI escapes included)
 * are shown as \uXXXX; new lines and tabs are kept. Non-text values are
 * shown as JSON.
 * @param {*} value
 * @returns {string}
 */
function plainText(value) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else if (value === undefined) {
    text = '';
  } else {
    try {
      text = JSON.stringify(value);
    } catch (error) {
      text = String(value);
    }
  }
  return text.replace(CONTROL_CHARS, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/**
 * The arguments shown to the end user, one per line, values in full.
 * @param {object} args
 * @param {string} [indent]
 * @returns {string[]}
 */
function formatArguments(args, indent = '  ') {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length === 0) {
    return [`${indent}(none shown)`];
  }
  return Object.entries(args).map(([key, value]) => {
    const text = plainText(value).replace(/\n/g, `\n${indent}  `);
    return `${indent}${plainText(key)}: ${text}`;
  });
}

/**
 * Quote a value for a POSIX shell, when it needs it.
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_.:@%+=/-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The commands that approve or decline a call.
 * @param {string} callId
 * @param {string} [endUserId] - the request's end_user.id, when known
 * @returns {{approve: string, reject: string, show: string}}
 */
function approvalCommands(callId, endUserId) {
  const id = shellQuote(plainText(callId));
  const user = endUserId ? shellQuote(plainText(endUserId)) : '<end user id>';
  return {
    approve: `modelriver tools approve ${id} --end-user ${user}`,
    reject: `modelriver tools reject ${id} --end-user ${user}`,
    show: `modelriver tools show ${id}`,
  };
}

/**
 * Lines describing one call that waits for approval (a
 * `tool_approval_required` event, or an `awaiting_approval` call in
 * `tool_state`).
 * @param {object} call - {id, name, label, prompt, arguments, expires_at}
 * @param {object} [options] - {endUserId}
 * @returns {string[]}
 */
function describeApprovalRequired(call, { endUserId } = {}) {
  const c = call || {};
  const commands = approvalCommands(c.id || '<call id>', endUserId);
  return [
    `Waiting for approval: ${plainText(c.name || '(unknown tool)')} (call ${plainText(c.id || '?')})`,
    // The tool's progress label, when it has one (e.g. "Cancelling the order…")
    ...(typeof c.label === 'string' && c.label.trim() !== '' ? [`  Label: ${plainText(c.label)}`] : []),
    `  Prompt: ${plainText(c.prompt ?? '')}`,
    '  Arguments shown to the end user:',
    ...formatArguments(c.arguments, '    '),
    `  Expires: ${plainText(c.expires_at || 'unknown')}`,
    '  Decide it with:',
    `    ${commands.approve}`,
    `    ${commands.reject}`,
  ];
}

const DECISION_TEXT = {
  approved: 'approved; it runs now',
  rejected: 'declined; it was not run',
  expired: 'not decided in time; it was not run',
};

/**
 * One line for a `tool_approval_resolved` event.
 * @param {object} event - {id, name, decision}
 * @returns {string}
 */
function describeApprovalResolved(event) {
  const e = event || {};
  const what = DECISION_TEXT[e.decision] || plainText(e.decision || 'decided');
  return `${plainText(e.name || '(unknown tool)')} (call ${plainText(e.id || '?')}): ${what}`;
}

/**
 * Until when to keep following a request. While calls wait for approval
 * that is the latest expires_at (at most an hour from now) plus a margin for
 * the server to resume; it never moves earlier.
 * @param {number} current - the deadline so far (ms since epoch)
 * @param {Array<string>} expiresAts - ISO times of the calls waiting
 * @param {number} [now]
 * @returns {number}
 */
function followDeadline(current, expiresAts, now = Date.now()) {
  const times = (expiresAts || []).map((t) => Date.parse(t)).filter(Number.isFinite);
  if (times.length === 0) return current;
  const latest = Math.min(Math.max(...times), now + MAX_APPROVAL_WAIT_MS);
  return Math.max(current, latest + APPROVAL_RESUME_MARGIN_MS);
}

/**
 * What an error from the approval API means, for people.
 * @param {object} response - {status, data, headers}
 * @param {object} [context] - {decision: "approve"|"reject"|undefined}
 * @returns {{message: string, hint: (string|null)}}
 */
function describeToolCallError(response, { decision } = {}) {
  const status = response && response.status;
  const data = (response && response.data) || {};
  const body = typeof data === 'object' ? data : {};
  const code = typeof body.error === 'string' ? body.error : null;
  const serverMessage = typeof body.message === 'string' ? plainText(body.message) : null;
  const details = body.details && typeof body.details === 'object' ? body.details : {};
  const withServer = (text) => (serverMessage ? `${text} (${serverMessage})` : text);

  if (status === 400 && (code === 'end_user_required' || code === 'end_user_invalid')) {
    return {
      message: withServer(`The end user is missing or not valid: ${code}`),
      hint: 'Pass --end-user with the end_user.id the request was sent with.',
    };
  }
  if (status === 404 && code !== 'tool_call_not_found') {
    // Not the approval API's own 404: this server has no such route.
    return {
      message: 'ModelRiver has no tool-call approval API at this address (HTTP 404).',
      hint: 'Check --api-url. An older server, or one without hosted tools, does not have it.',
    };
  }
  if (status === 404) {
    return {
      message: 'No call waiting for approval has this id (tool_call_not_found).',
      hint: 'Check the call id and that the API key belongs to the request\'s project. ' +
        'Playground calls are decided in the console, and a call that needed no approval is not found either.',
    };
  }
  if (status === 409 && code === 'end_user_mismatch') {
    return {
      message: 'This call belongs to a different end user (end_user_mismatch).',
      hint: 'Pass --end-user with the end_user.id the request was sent with.',
    };
  }
  if (status === 409 && code === 'tool_call_already_decided') {
    const current = typeof details.status === 'string' ? plainText(details.status) : 'decided';
    return {
      message: `This call was already ${current}; nothing changed (tool_call_already_decided).`,
      hint: current === 'rejected' && decision === 'approve'
        ? 'A stopped request declines its waiting calls too.'
        : null,
    };
  }
  if (status === 410) {
    return {
      message: 'The time to decide on this call has passed, so it was not run (tool_approval_expired).',
      hint: null,
    };
  }
  if (status === 429) {
    const header = response.headers && (response.headers['retry-after'] || response.headers['Retry-After']);
    const retry = body.retry_after ?? header;
    return {
      message: 'Rate limited by ModelRiver.',
      hint: retry !== undefined && retry !== null ? `Try again in ${plainText(retry)} seconds.` : 'Try again shortly.',
    };
  }
  if (status === 401 || status === 403) {
    return {
      message: withServer(`The API key was refused (HTTP ${status}).`),
      hint: 'Check your API key (modelriver login, or --api-key).',
    };
  }
  return {
    message: withServer(`Request failed with HTTP ${status}${code ? `: ${plainText(code)}` : ''}`),
    hint: null,
  };
}

module.exports = {
  MAX_APPROVAL_WAIT_MS,
  APPROVAL_RESUME_MARGIN_MS,
  plainText,
  formatArguments,
  shellQuote,
  approvalCommands,
  describeApprovalRequired,
  describeApprovalResolved,
  followDeadline,
  describeToolCallError,
};
