const { ApprovalFollower, addToolOptions, requestFailureLines, RESPONSE_TIMEOUT_MS } = require('./websocket');

describe('websocket command: following approvals', () => {
  const T0 = Date.parse('2026-11-14T10:00:00Z');
  const MIN = 60 * 1000;

  function follower({ endUserId = 'user_812', now = () => T0 } = {}) {
    const printed = [];
    const deadlines = [];
    const f = new ApprovalFollower({
      endUserId,
      now,
      print: (lines, kind) => printed.push({ kind, text: lines.join('\n') }),
      onDeadline: (d) => deadlines.push(d),
    });
    return { f, printed, deadlines };
  }

  const waiting = (id, expiresAt) => ({
    id, name: 'cancel_order', round: 1, prompt: 'Cancel this order?', arguments: { order_id: '1041' }, expires_at: expiresAt,
  });

  it('waits 5 minutes for a response when nothing waits for approval', () => {
    const { f, deadlines } = follower();
    expect(f.deadline).toBe(T0 + RESPONSE_TIMEOUT_MS);
    expect(f.isWaiting()).toBe(false);
    expect(deadlines).toEqual([]);
  });

  it('prints a call waiting for approval with the commands for its end user, and waits past its expiry', () => {
    const { f, printed, deadlines } = follower();
    f.required(waiting('tc_1', '2026-11-14T10:10:00Z'));

    expect(printed).toHaveLength(1);
    expect(printed[0].kind).toBe('required');
    expect(printed[0].text).toContain('Waiting for approval: cancel_order (call tc_1)');
    expect(printed[0].text).toContain('Prompt: Cancel this order?');
    expect(printed[0].text).toContain('order_id: 1041');
    expect(printed[0].text).toContain('Expires: 2026-11-14T10:10:00Z');
    expect(printed[0].text).toContain('modelriver tools approve tc_1 --end-user user_812');
    expect(printed[0].text).toContain('modelriver tools reject tc_1 --end-user user_812');

    expect(f.isWaiting()).toBe(true);
    expect(f.deadline).toBe(Date.parse('2026-11-14T10:10:00Z') + 5 * MIN);
    expect(deadlines).toEqual([f.deadline]);
  });

  it('follows the latest of several expiries, capped at 65 minutes', () => {
    const { f } = follower();
    f.required(waiting('tc_1', '2026-11-14T10:10:00Z'));
    f.required(waiting('tc_2', '2026-11-14T10:40:00Z'));
    expect(f.deadline).toBe(Date.parse('2026-11-14T10:45:00Z'));

    f.required(waiting('tc_3', '2026-11-15T10:00:00Z'));
    expect(f.deadline).toBe(T0 + 65 * MIN);
  });

  it('prints each waiting call once, even when tool_state repeats it', () => {
    const { f, printed } = follower();
    f.required(waiting('tc_1', '2026-11-14T10:10:00Z'));
    f.state({ calls: [{ ...waiting('tc_1', '2026-11-14T10:10:00Z'), status: 'awaiting_approval' }, { id: 'tc_0', status: 'done' }] });
    expect(printed).toHaveLength(1);
  });

  it('picks up calls already waiting from tool_state on join', () => {
    const { f, printed } = follower({ endUserId: null });
    f.state({ round: 1, calls: [{ ...waiting('tc_7', '2026-11-14T10:30:00Z'), status: 'awaiting_approval' }, { id: 'tc_8', status: 'approved' }] });
    expect(printed).toHaveLength(1);
    expect(printed[0].text).toContain('modelriver tools approve tc_7 --end-user <end user id>');
    expect(f.deadline).toBe(Date.parse('2026-11-14T10:35:00Z'));
    f.state(undefined);
    f.state({ calls: 'nope' });
  });

  it('prints decisions and gives the resumed request the usual time to answer', () => {
    let now = T0;
    const { f, printed } = follower({ now: () => now });
    f.required(waiting('tc_1', '2026-11-14T10:10:00Z'));
    const before = f.deadline;

    now = T0 + 8 * MIN;
    f.resolved({ id: 'tc_1', name: 'cancel_order', round: 1, decision: 'approved' });
    expect(printed[1]).toEqual({ kind: 'resolved', text: 'cancel_order (call tc_1): approved; it runs now' });
    expect(f.isWaiting()).toBe(false);
    // never earlier than before
    expect(f.deadline).toBe(Math.max(before, now + RESPONSE_TIMEOUT_MS));

    now = T0 + 20 * MIN;
    f.resolved({ id: 'tc_2', name: 'refund', decision: 'expired' });
    expect(printed[2].text).toMatch(/refund \(call tc_2\): not decided in time; it was not run/);
    expect(f.deadline).toBe(now + RESPONSE_TIMEOUT_MS);
  });
});

describe('websocket command: --end-user and --cli-session', () => {
  it('adds end_user and tool_route to the request when it has none', () => {
    expect(addToolOptions({ workflow: 'wf' }, { endUser: 'user_812', cliSession: 'cts_1' })).toEqual({
      workflow: 'wf', end_user: { id: 'user_812' }, tool_route: { cli_session: 'cts_1' },
    });
  });

  it('keeps what a --payload already says', () => {
    const payload = { workflow: 'wf', end_user: { id: 'from_payload', claims: { plan: 'pro' } }, tool_route: { cli_session: 'cts_p' } };
    expect(addToolOptions({ ...payload }, { endUser: 'flag', cliSession: 'cts_flag' })).toEqual(payload);
    expect(addToolOptions({ workflow: 'wf' }, {})).toEqual({ workflow: 'wf' });
  });
});

describe('websocket command: a refused request', () => {
  it('shows details as JSON, never as [object Object]', () => {
    const lines = requestFailureLines(429, {
      error: 'tool_approvals_limited',
      message: 'This project already has 50 requests waiting for approval, the most it can have at once. Try again when one is decided.',
      details: { limit: 50 },
    }, { 'retry-after': '30' });
    expect(lines).toEqual([
      'Request failed with status code 429',
      'Error: tool_approvals_limited',
      'Message: This project already has 50 requests waiting for approval, the most it can have at once. Try again when one is decided.',
      'Details: {"limit":50}',
      'Try again in 30 seconds.',
    ]);
  });

  it('takes the retry time from the rate limiter body when it has one', () => {
    const lines = requestFailureLines(429, { error: 'Rate limit exceeded', message: 'Too many requests', retry_after: 7 }, {});
    expect(lines[lines.length - 1]).toBe('Try again in 7 seconds.');
  });

  it('says why a CLI session was refused', () => {
    const lines = requestFailureLines(409, {
      error: 'cli_session_not_connected',
      message: 'The CLI session is not connected. Start `modelriver tools` again, or remove tool_route to call the endpoints.',
      details: { code: 'cli_session_not_connected' },
    });
    expect(lines.join('\n')).toMatch(/cli_session_not_connected[\s\S]*Start `modelriver tools` again/);
  });

  it('handles a plain text body and an empty one', () => {
    expect(requestFailureLines(403, 'Forbidden')).toEqual(['Request failed with status code 403', 'Message: Forbidden']);
    expect(requestFailureLines(404, undefined)).toEqual(['Request failed with status code 404']);
  });

  it('shows text from the server as plain text', () => {
    const lines = requestFailureLines(400, { message: 'bad \u001b[31mred' });
    expect(lines[1]).toBe('Message: bad \\u001b[31mred');
  });
});
