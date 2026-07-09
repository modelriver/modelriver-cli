const {
  isEventDrivenWebhook,
  resolveCallbackUrl,
  getCustomerData,
  getWebhookStatusLabel,
  buildCallbackHint,
  isIntermediateWebSocketStatus,
  isFinalWebSocketStatus,
} = require('../src/utils/webhook-payload');

describe('webhook-payload utils', () => {
  test('detects event-driven webhooks', () => {
    expect(isEventDrivenWebhook({ type: 'task.ai_generated' })).toBe(true);
    expect(isEventDrivenWebhook({ status: 'success' })).toBe(false);
    expect(isEventDrivenWebhook(null)).toBe(false);
  });

  test('resolves callback URL from top-level or nested payload', () => {
    expect(
      resolveCallbackUrl({
        callback_url: 'http://localhost:4000/api/v1/callback/abc',
        data: {},
      })
    ).toBe('http://localhost:4000/api/v1/callback/abc');

    expect(
      resolveCallbackUrl({
        data: { callback_url: 'http://localhost:4000/api/v1/callback/nested' },
      })
    ).toBe('http://localhost:4000/api/v1/callback/nested');

    expect(resolveCallbackUrl(null)).toBe(null);
  });

  test('reads customer_data from top-level or ai_response', () => {
    expect(
      getCustomerData({
        customer_data: { ticket_id: 'TCK-1' },
      })
    ).toEqual({ ticket_id: 'TCK-1' });

    expect(
      getCustomerData({
        ai_response: { customer_data: { user_name: 'Alice' } },
      })
    ).toEqual({ user_name: 'Alice' });

    expect(getCustomerData({ customer_data: {} })).toBe(null);
    expect(getCustomerData({ status: 'success' })).toBe(null);
  });

  test('formats webhook status labels', () => {
    expect(getWebhookStatusLabel({ type: 'task.ai_generated' })).toBe(
      'ai_generated (callback required)'
    );
    expect(getWebhookStatusLabel({ status: 'success' })).toBe('success');
    expect(getWebhookStatusLabel(null)).toBe('N/A');
  });

  test('builds callback hints without hardcoding localhost', () => {
    const hint = buildCallbackHint(
      'https://api.modelriver.com/v1/callback/abc',
      'abc',
      'mr_live_secretkey'
    );

    expect(hint).toContain('modelriver callback --channel-id abc');
    expect(hint).toContain('https://api.modelriver.com/v1/callback/abc');
    expect(hint).not.toContain('localhost:4000');
  });

  test('classifies websocket statuses', () => {
    expect(isIntermediateWebSocketStatus('ai_generated')).toBe(true);
    expect(isIntermediateWebSocketStatus('step_received')).toBe(true);
    expect(isFinalWebSocketStatus('completed')).toBe(true);
    expect(isFinalWebSocketStatus('success')).toBe(true);
    expect(isFinalWebSocketStatus('error')).toBe(true);
  });
});
