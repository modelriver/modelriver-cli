const path = require('path');
const { execFileSync } = require('child_process');

const PARSER = path.join(__dirname, '..', 'test', 'support', 'parse-argv.js');

// Parse argv with the real CLI definition and mocked command handlers.
// (A child process, because Jest cannot load the ESM-only commander.)
function parse(...argv) {
  const out = JSON.parse(execFileSync(process.execPath, [PARSER, ...argv], { encoding: 'utf8' }));
  if (out.error) throw new Error(out.error);
  return { calls: out.calls, globals: out.globals };
}

describe('CLI option parsing', () => {
  it('gives `webhook verify -p` to the payload, not the global project ID', () => {
    const { calls, globals } = parse('webhook', 'verify', '-p', '{"a":1}', '-s', 'sig', '-t', '123', '--secret', 'whsec');
    expect(calls.verifyWebhook).toEqual({ payload: '{"a":1}', signature: 'sig', timestamp: '123', secret: 'whsec' });
    expect(globals.projectId).toBeUndefined();
  });

  it.each([
    ['listen', 'listen'],
    ['l', 'listen'],
    ['forward', 'forward'],
    ['test-webhook', 'testWebhook'],
  ])('gives `%s -p` to the port', (command, action) => {
    const { calls, globals } = parse(command, '-p', '4000');
    expect(calls[action].port).toBe('4000');
    expect(globals.projectId).toBeUndefined();
  });

  it('reads global options before the command', () => {
    const { calls } = parse('-p', 'proj_1', '-k', 'mr_test_global', 'websocket', '-w', 'wf');
    expect(calls.websocket).toMatchObject({ projectId: 'proj_1', apiKey: 'mr_test_global', workflow: 'wf' });
  });

  it('accepts --project-id after websocket', () => {
    const { calls } = parse('websocket', '--channel-id', 'abc-123', '--project-id', 'xyz-789');
    expect(calls.websocket).toMatchObject({ channelId: 'abc-123', projectId: 'xyz-789' });
  });

  it('accepts --api-key and --api-url after tools', () => {
    const { calls } = parse('tools', '--forward-to', 'http://localhost:3000', '-k', 'mr_test_x', '--api-url', 'http://localhost:4000');
    expect(calls.tools).toMatchObject({
      forwardTo: 'http://localhost:3000',
      apiKey: 'mr_test_x',
      apiUrl: 'http://localhost:4000',
    });
  });

  it('passes test-webhook --secret as `secret`', () => {
    const { calls } = parse('test-webhook', '--secret', 'whsec_custom', '-u', 'https://example.com/hook');
    expect(calls.testWebhook).toMatchObject({ secret: 'whsec_custom', webhookUrl: 'https://example.com/hook' });
  });

  it('refuses the global -p after a command that has no -p', () => {
    expect(() => parse('trigger', '-p', 'proj_1')).toThrow(/unknownOption/);
  });

  it('still requires --forward-to for tools itself', () => {
    expect(() => parse('tools')).toThrow(/commander\.error/);
    expect(() => parse('tools', '--print')).toThrow(/commander\.error/);
  });

  it('parses tools approve and reject (and its alias decline) without --forward-to', () => {
    expect(parse('tools', 'approve', 'tc_1', '--end-user', 'user_812').calls.toolsApprove)
      .toMatchObject({ callId: 'tc_1', endUser: 'user_812' });
    expect(parse('tools', 'reject', 'tc_2', '--end-user', 'u 2').calls.toolsReject)
      .toMatchObject({ callId: 'tc_2', endUser: 'u 2' });
    expect(parse('tools', 'decline', 'tc_3', '--end-user', 'u3').calls.toolsReject)
      .toMatchObject({ callId: 'tc_3', endUser: 'u3' });
  });

  it('requires --end-user to approve or reject, and a call id', () => {
    expect(() => parse('tools', 'approve', 'tc_1')).toThrow(/missingMandatoryOptionValue/);
    expect(() => parse('tools', 'reject', '--end-user', 'u')).toThrow(/missingArgument/);
  });

  it('parses tools show, with API options before or after the subcommand', () => {
    expect(parse('tools', 'show', 'tc_1', '-k', 'mr_test_after').calls.toolsShow)
      .toMatchObject({ callId: 'tc_1', apiKey: 'mr_test_after' });
    expect(parse('tools', '-k', 'mr_test_before', '--api-url', 'http://localhost:4000', 'show', 'tc_1').calls.toolsShow)
      .toMatchObject({ callId: 'tc_1', apiKey: 'mr_test_before', apiUrl: 'http://localhost:4000' });
    expect(parse('-k', 'mr_test_global', 'tools', 'approve', 'tc_1', '--end-user', 'u').calls.toolsApprove)
      .toMatchObject({ apiKey: 'mr_test_global' });
  });

  it('parses websocket --end-user and --cli-session', () => {
    const { calls } = parse('websocket', '-w', 'wf', '--end-user', 'user_812', '--cli-session', 'cts_abc');
    expect(calls.websocket).toMatchObject({ workflow: 'wf', endUser: 'user_812', cliSession: 'cts_abc' });
  });
});
