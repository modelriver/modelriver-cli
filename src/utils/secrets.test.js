const { maskSecret } = require('./secrets');

describe('maskSecret', () => {
  it('shows only the known key prefix and the last 4 characters', () => {
    expect(maskSecret('mr_live_abcdefghijklmnopqrstuvwxyz')).toBe('mr_live_…wxyz');
    expect(maskSecret('mr_test_abcdefghijklmnopqrstuvwxyz')).toBe('mr_test_…wxyz');
  });

  it('shows no prefix of other secrets', () => {
    const masked = maskSecret('whsec_0123456789abcdefghij');
    expect(masked).toBe('…ghij');
    expect(masked).not.toContain('whsec');
  });

  it('hides short values entirely', () => {
    expect(maskSecret('mr_live_short')).toBe('mr_live_****');
    expect(maskSecret('abc')).toBe('****');
  });

  it('handles missing values', () => {
    expect(maskSecret('')).toBe('(not set)');
    expect(maskSecret(undefined)).toBe('(not set)');
  });
});

describe('maskSessionToken and redactRequestPayload', () => {
  const { maskSessionToken, redactRequestPayload } = require('./secrets');

  it('masks a cts_ session token', () => {
    expect(maskSessionToken('cts_AbCdEfGhIjKlMnOpQrStUvWxYz012345')).toBe('cts_…2345');
    expect(maskSessionToken('cts_short')).toBe('cts_****');
    expect(maskSessionToken(undefined)).toBe('(not set)');
  });

  it('masks tool_route.cli_session and leaves the rest, without changing the original', () => {
    const payload = { workflow: 'wf', end_user: { id: 'user_812' }, tool_route: { cli_session: 'cts_AbCdEfGhIjKlMnOpQrStUvWxYz012345' } };
    const shown = redactRequestPayload(payload);
    expect(shown).toEqual({ workflow: 'wf', end_user: { id: 'user_812' }, tool_route: { cli_session: 'cts_…2345' } });
    expect(payload.tool_route.cli_session).toBe('cts_AbCdEfGhIjKlMnOpQrStUvWxYz012345');
    expect(JSON.stringify(shown)).not.toContain('AbCdEfGh');
    expect(redactRequestPayload({ workflow: 'wf' })).toEqual({ workflow: 'wf' });
  });
});
