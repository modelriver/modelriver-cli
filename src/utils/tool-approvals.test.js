const {
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
} = require('./tool-approvals');

describe('tool approvals: showing calls as plain text', () => {
  it('shows control characters (ANSI escapes included) as \\uXXXX, keeps new lines and tabs', () => {
    expect(plainText('\u001b[31mred\u001b[0m')).toBe('\\u001b[31mred\\u001b[0m');
    expect(plainText('a\nb\tc\rd')).toBe('a\nb\tc\\u000dd');
    expect(plainText('\u009b2J')).toBe('\\u009b2J');
  });

  it.each([
    ['U+202E right-to-left override', '\u202e'],
    ['U+202A left-to-right embedding', '\u202a'],
    ['U+2066 left-to-right isolate', '\u2066'],
    ['U+2069 pop directional isolate', '\u2069'],
    ['U+200B zero-width space', '\u200b'],
    ['U+200F right-to-left mark', '\u200f'],
    ['U+2028 line separator', '\u2028'],
    ['U+2029 paragraph separator', '\u2029'],
    ['U+FEFF zero-width no-break space', '\ufeff'],
    ['U+2060 word joiner', '\u2060'],
    ['U+061C Arabic letter mark', '\u061c'],
  ])('escapes the hidden or bidi character %s', (_label, ch) => {
    const code = ch.charCodeAt(0).toString(16).padStart(4, '0');
    expect(plainText(`pay${ch}100`)).toBe(`pay\\u${code}100`);
  });

  it('shows a reversed-text trick literally, in arguments too', () => {
    // Would display as "amount: 100 USD" while the text says something else.
    const tricky = 'DSU 001 :tnuoma\u202e';
    expect(plainText(tricky)).toBe('DSU 001 :tnuoma\\u202e');
    expect(formatArguments({ note: '\u2066hidden\u2069' })).toEqual(['  note: \\u2066hidden\\u2069']);
  });

  it('leaves ordinary non-ASCII text alone', () => {
    expect(plainText('Zürich — 東京 — مرحبا ✓')).toBe('Zürich — 東京 — مرحبا ✓');
  });

  it('shows non-text values as JSON', () => {
    expect(plainText(1041)).toBe('1041');
    expect(plainText({ a: [1, 'x'] })).toBe('{"a":[1,"x"]}');
    expect(plainText(null)).toBe('null');
    expect(plainText(true)).toBe('true');
  });

  it('lists every argument in full, multi-line values indented', () => {
    const long = 'x'.repeat(500);
    expect(formatArguments({ order_id: '1041', amount: 12.5, note: `one\ntwo`, long }, '  ')).toEqual([
      '  order_id: 1041',
      '  amount: 12.5',
      '  note: one\n    two',
      `  long: ${long}`,
    ]);
    expect(formatArguments({}, '  ')).toEqual(['  (none shown)']);
    expect(formatArguments(undefined, '  ')).toEqual(['  (none shown)']);
  });

  it('quotes values for the shell only when needed', () => {
    expect(shellQuote('user_812')).toBe('user_812');
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("o'neil; rm -rf ~")).toBe("'o'\\''neil; rm -rf ~'");
    expect(shellQuote('$(whoami)')).toBe("'$(whoami)'");
  });

  it('builds the approve and reject commands, with a placeholder when the end user is unknown', () => {
    expect(approvalCommands('tc_1', 'user 812')).toEqual({
      approve: "modelriver tools approve tc_1 --end-user 'user 812'",
      reject: "modelriver tools reject tc_1 --end-user 'user 812'",
      show: 'modelriver tools show tc_1',
    });
    expect(approvalCommands('tc_1').approve).toBe('modelriver tools approve tc_1 --end-user <end user id>');
  });

  it('describes a call waiting for approval: tool, prompt, shown arguments, expiry and commands', () => {
    const lines = describeApprovalRequired({
      id: 'tc_9',
      name: 'cancel_order',
      prompt: 'Cancel this order? This can\'t be undone.',
      arguments: { order_id: '1041' },
      expires_at: '2026-11-14T10:20:00Z',
    }, { endUserId: 'user_812' }).join('\n');
    expect(lines).toContain('Waiting for approval: cancel_order (call tc_9)');
    expect(lines).toContain('Prompt: Cancel this order? This can\'t be undone.');
    expect(lines).toContain('order_id: 1041');
    expect(lines).toContain('Expires: 2026-11-14T10:20:00Z');
    expect(lines).toContain('modelriver tools approve tc_9 --end-user user_812');
    expect(lines).toContain('modelriver tools reject tc_9 --end-user user_812');
  });

  it('shows the label when the event has one, and leaves it out when it is null', () => {
    const base = { id: 'tc_9', name: 'cancel_order', prompt: 'P', arguments: {}, expires_at: 'E' };
    expect(describeApprovalRequired({ ...base, label: 'Cancelling the order\u2026' }).join('\n')).toContain('Label: Cancelling the order\u2026');
    expect(describeApprovalRequired({ ...base, label: null }).join('\n')).not.toContain('Label:');
  });

  it('describes each decision', () => {
    expect(describeApprovalResolved({ id: 'tc_9', name: 'cancel_order', decision: 'approved' })).toBe('cancel_order (call tc_9): approved; it runs now');
    expect(describeApprovalResolved({ id: 'tc_9', name: 'cancel_order', decision: 'rejected' })).toMatch(/declined; it was not run/);
    expect(describeApprovalResolved({ id: 'tc_9', name: 'cancel_order', decision: 'expired' })).toMatch(/not decided in time; it was not run/);
  });
});

describe('tool approvals: how long to keep following', () => {
  const now = Date.parse('2026-11-14T10:00:00Z');

  it('waits until the latest expiry plus 5 minutes', () => {
    const deadline = followDeadline(now + 5 * 60 * 1000, ['2026-11-14T10:10:00Z', '2026-11-14T10:20:00Z'], now);
    expect(deadline).toBe(Date.parse('2026-11-14T10:20:00Z') + APPROVAL_RESUME_MARGIN_MS);
  });

  it('never waits more than 65 minutes from now, whatever expires_at says', () => {
    const deadline = followDeadline(now, ['2026-11-20T00:00:00Z'], now);
    expect(deadline).toBe(now + MAX_APPROVAL_WAIT_MS + APPROVAL_RESUME_MARGIN_MS);
    expect(deadline - now).toBe(65 * 60 * 1000);
  });

  it('never moves the deadline earlier, and ignores unreadable times', () => {
    const current = now + 30 * 60 * 1000;
    expect(followDeadline(current, ['2026-11-14T10:01:00Z'], now)).toBe(current);
    expect(followDeadline(current, ['not a time'], now)).toBe(current);
    expect(followDeadline(current, [], now)).toBe(current);
  });
});

describe('tool approvals: API errors', () => {
  const res = (status, data, headers = {}) => ({ status, data, headers });

  it('explains end_user_required and end_user_invalid', () => {
    for (const code of ['end_user_required', 'end_user_invalid']) {
      const { message, hint } = describeToolCallError(res(400, { error: code, message: 'end_user.id is required and must be text.', details: {} }));
      expect(message).toContain(code);
      expect(message).toContain('end_user.id is required');
      expect(hint).toMatch(/--end-user/);
    }
  });

  it('explains tool_call_not_found', () => {
    const { message, hint } = describeToolCallError(res(404, { error: 'tool_call_not_found', message: 'x', details: {} }));
    expect(message).toMatch(/tool_call_not_found/);
    expect(hint).toMatch(/Playground calls are decided in the console/);
  });

  it('says so when a 404 is not from the approval API (an older server, or a wrong --api-url)', () => {
    for (const body of [{ errors: { detail: 'Not Found' } }, 'Not Found', undefined]) {
      const { message, hint } = describeToolCallError(res(404, body));
      expect(message).not.toMatch(/tool_call_not_found/);
      expect(message).toMatch(/HTTP 404/);
      expect(hint).toMatch(/--api-url/);
    }
  });

  it('explains end_user_mismatch', () => {
    const { message, hint } = describeToolCallError(res(409, { error: 'end_user_mismatch', message: 'x', details: { code: 'end_user_mismatch' } }));
    expect(message).toMatch(/different end user/);
    expect(hint).toMatch(/--end-user/);
  });

  it('explains tool_call_already_decided with details.status', () => {
    const { message, hint } = describeToolCallError(
      res(409, { error: 'tool_call_already_decided', message: 'This call was already rejected.', details: { status: 'rejected' } }),
      { decision: 'approve' }
    );
    expect(message).toBe('This call was already rejected; nothing changed (tool_call_already_decided).');
    expect(hint).toMatch(/stopped request/);
    expect(describeToolCallError(res(409, { error: 'tool_call_already_decided', details: { status: 'approved' } }), { decision: 'reject' }).message)
      .toMatch(/already approved/);
  });

  it('explains tool_approval_expired', () => {
    expect(describeToolCallError(res(410, { error: 'tool_approval_expired' })).message).toMatch(/passed, so it was not run/);
  });

  it('gives the retry time on 429, from the body or the Retry-After header', () => {
    expect(describeToolCallError(res(429, { error: 'Rate limit exceeded', retry_after: 12 })).hint).toBe('Try again in 12 seconds.');
    expect(describeToolCallError(res(429, {}, { 'retry-after': '30' })).hint).toBe('Try again in 30 seconds.');
    expect(describeToolCallError(res(429, 'Too Many Requests')).hint).toBe('Try again shortly.');
  });

  it('points at the API key on 401 and 403, and shows anything else as it is', () => {
    expect(describeToolCallError(res(401, { error: 'Unauthorized' })).hint).toMatch(/API key/);
    expect(describeToolCallError(res(422, { error: 'odd', message: 'Odd' })).message).toBe('Request failed with HTTP 422: odd (Odd)');
  });

  it('never prints control characters from the server', () => {
    const { message } = describeToolCallError(res(400, { error: 'end_user_invalid', message: '\u001b]0;pwned\u0007' }));
    expect(message).not.toMatch(/\u001b/);
  });
});
