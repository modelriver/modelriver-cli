/**
 * Helpers for standard vs event-driven webhook payloads.
 */

function isEventDrivenWebhook(data) {
  return Boolean(data && data.type === 'task.ai_generated');
}

function resolveCallbackUrl(webhookPayload) {
  if (!webhookPayload) {
    return null;
  }

  const { data, callback_url: topLevelCallbackUrl } = webhookPayload;

  return topLevelCallbackUrl || data?.callback_url || null;
}

function getWebhookStatusLabel(data) {
  if (!data) {
    return 'N/A';
  }

  if (isEventDrivenWebhook(data)) {
    return 'ai_generated (callback required)';
  }

  return data.status || 'N/A';
}

function getCustomerData(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const customerData = data.customer_data || data.ai_response?.customer_data;
  if (!customerData || typeof customerData !== 'object') {
    return null;
  }

  return Object.keys(customerData).length > 0 ? customerData : null;
}

// `_apiKey` is accepted for older callers but never printed: the hint always
// refers to $MODELRIVER_API_KEY so no part of the key ends up in terminal logs.
function buildCallbackHint(callbackUrl, channelId, _apiKey) {
  if (!callbackUrl && !channelId) {
    return null;
  }

  const keyHint = '$MODELRIVER_API_KEY';

  const lines = [
    '> Event-driven webhook — complete the flow with a callback:',
  ];

  if (channelId) {
    lines.push(
      `>   modelriver callback --channel-id ${channelId} --data '{"summary":"..."}'`
    );
  }

  if (callbackUrl) {
    if (channelId) {
      lines.push('> Or:');
    }
    lines.push(
      `>   modelriver callback --callback-url "${callbackUrl}" --data '{"summary":"..."}'`
    );
    lines.push(
      `>   curl -X POST "${callbackUrl}" \\`,
      `>     -H "Authorization: Bearer ${keyHint}" \\`,
      `>     -H "Content-Type: application/json" \\`,
      `>     -d '{"data":{"enriched":true},"task_id":"your-task-id"}'`
    );
  }

  return lines.join('\n');
}

function printWebhookDetails(webhookPayload, options = {}) {
  const {
    Logger,
    Formatter,
    WebhookVerifier,
    webhookSecret,
    signature,
    timestamp,
    apiKey,
    label = 'Webhook received',
  } = options;

  const { channel_id, data } = webhookPayload;
  const callbackUrl = resolveCallbackUrl(webhookPayload);
  const timestampStr = Formatter.timestamp(new Date());

  Logger.log(`\n[${timestampStr}] ${label}:`);
  Logger.log(`  Channel ID: ${channel_id || 'N/A'}`);
  Logger.log(`  Status: ${getWebhookStatusLabel(data)}`);

  if (isEventDrivenWebhook(data)) {
    Logger.log(`  Type: ${data.type}`);
    Logger.log(`  Event: ${data.event || 'N/A'}`);

    if (callbackUrl) {
      Logger.log(`  Callback URL: ${callbackUrl}`);
    }

    const customerData = getCustomerData(data);
    if (customerData) {
      Logger.log(`  Customer data: ${Formatter.json(customerData)}`);
    }

    if (data.ai_response) {
      Logger.log(`  AI response: ${Formatter.json(data.ai_response)}`);
    }

    const hint = buildCallbackHint(callbackUrl, channel_id, apiKey);
    if (hint) {
      Logger.warning(`\n${hint}\n`);
    }
  } else {
    if (signature && webhookSecret && data) {
      const result = WebhookVerifier.check(
        signature,
        data,
        webhookSecret,
        String(timestamp)
      );
      let label = '✗ Invalid';
      if (result.valid) label = '✓ Valid';
      else if (result.signatureValid) label = '✗ Timestamp more than 5 minutes off';
      Logger.log(`  Signature: ${label}`);
    }

    if (data?.data) {
      Logger.log(`  Data: ${Formatter.json(data.data)}`);
    }

    if (data?.meta) {
      Logger.log(`  Meta: ${Formatter.json(data.meta)}`);
    }
  }
}

function isIntermediateWebSocketStatus(status) {
  return status === 'ai_generated' || status === 'step_received' || status === 'pending';
}

function isFinalWebSocketStatus(status) {
  return status === 'completed' || status === 'success' || status === 'error';
}

module.exports = {
  isEventDrivenWebhook,
  resolveCallbackUrl,
  getCustomerData,
  getWebhookStatusLabel,
  buildCallbackHint,
  printWebhookDetails,
  isIntermediateWebSocketStatus,
  isFinalWebSocketStatus,
};
