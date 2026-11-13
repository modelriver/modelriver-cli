const { Command } = require('commander');
const config = require('./lib/config');
const { version } = require('../package.json');

function defaultActions() {
  return {
    login: (...args) => require('./commands/login').loginCommand(...args),
    listen: (...args) => require('./commands/listen').listenCommand(...args),
    forward: (...args) => require('./commands/forward').forwardCommand(...args),
    websocket: (...args) => require('./commands/websocket').websocketCommand(...args),
    callback: (...args) => require('./commands/callback').callbackCommand(...args),
    testWebhook: (...args) => require('./commands/test-webhook').testWebhookCommand(...args),
    trigger: (...args) => require('./commands/trigger').triggerCommand(...args),
    tools: (...args) => require('./commands/tools').toolsCommand(...args),
    listWebhooks: (...args) => require('./commands/webhook').listWebhooks(...args),
    verifyWebhook: (...args) => require('./commands/webhook').verifyWebhook(...args),
  };
}

/**
 * Add the API options to a command that talks to ModelRiver, so they work
 * after the command name too (`modelriver tools -k ...`).
 */
function withApiOptions(command) {
  return command
    .option('-k, --api-key <key>', 'ModelRiver API key (or set MODELRIVER_API_KEY)')
    .option('--api-url <url>', 'API base URL (default: https://api.modelriver.com)');
}

/**
 * Build the CLI.
 *
 * Global options go before the command name (`modelriver -k KEY listen`), so
 * each command owns its own short options: `-p` is the port for listen,
 * forward and test-webhook, and the payload for `webhook verify`.
 *
 * @param {object} [actions] - command handlers (tests pass mocks)
 * @returns {Command}
 */
function createProgram(actions = defaultActions()) {
  const program = new Command();

  program
    .name('modelriver')
    .description('ModelRiver CLI for testing webhooks, WebSockets and hosted tools from production')
    .version(version)
    .enablePositionalOptions();

  // Global options
  program
    .option('-k, --api-key <key>', 'ModelRiver API key (or set MODELRIVER_API_KEY)')
    .option('--api-url <url>', 'API base URL (default: https://api.modelriver.com)')
    .option('-p, --project-id <id>', 'Project ID (or set MODELRIVER_PROJECT_ID)');

  const api = (options) => ({
    apiKey: options.apiKey || program.opts().apiKey,
    apiUrl: options.apiUrl || program.opts().apiUrl || config.getApiUrl(),
  });

  // Login command - interactive setup
  program
    .command('login')
    .description('Configure your ModelRiver API key and forward URL interactively')
    .action((options) => actions.login(options));

  // Listen command with alias 'l'
  withApiOptions(program
    .command('listen')
    .alias('l')
    .description('Forward webhooks from production to local server via WebSocket'))
    .option('-p, --port <port>', 'Local server port (default: 3001)')
    .option('-f, --forward', 'Forward to external server (do not start internal server)')
    .option('--print', 'Print webhook payloads to console')
    .option('-v, --verbose', 'Verbose output')
    .action((options) => actions.listen({ ...options, ...api(options) }));

  // Forward command with alias 'f' - simplified webhook forwarding
  program
    .command('forward')
    .alias('f')
    .description('Forward webhooks using saved configuration (shortcut for listen --forward --print)')
    .option('-p, --port <port>', 'Override target port')
    .option('-v, --verbose', 'Verbose output')
    .action((options) => actions.forward(options));

  // WebSocket command with alias 'ws'
  withApiOptions(program
    .command('websocket')
    .alias('ws')
    .description('Test WebSocket connection to production'))
    .option('-p, --project-id <id>', 'Project ID (or set MODELRIVER_PROJECT_ID)')
    .option('-w, --workflow <name>', 'Workflow name')
    .option('-m, --message <text>', 'Test message')
    .option('-P, --payload <json>', 'Custom JSON payload')
    .option('-c, --channel-id <id>', 'Existing channel ID (requires --project-id)')
    .option('-v, --verbose', 'Verbose output')
    .action((options) => actions.websocket({
      ...options,
      ...api(options),
      projectId: options.projectId || program.opts().projectId,
    }));

  // Callback command - complete event-driven flows
  withApiOptions(program
    .command('callback')
    .description('Send an event-driven callback to complete a pending channel'))
    .option('-c, --channel-id <id>', 'Channel ID from trigger/listen output')
    .option('--callback-url <url>', 'Full callback URL from webhook payload')
    .option('-d, --data <json>', 'Callback data object JSON')
    .option('-P, --payload <json>', 'Full callback payload JSON')
    .option('--task-id <id>', 'Optional task ID')
    .option('--metadata <json>', 'Optional metadata object JSON')
    .action((options) => actions.callback({ ...options, ...api(options) }));

  // Test Webhook command
  withApiOptions(program
    .command('test-webhook')
    .description('Test webhook delivery - creates webhook, makes request, waits for response'))
    .option('-w, --workflow <name>', 'Workflow name')
    .option('-m, --message <text>', 'Test message')
    .option('-P, --payload <json>', 'Custom JSON payload')
    .option('-u, --webhook-url <url>', 'Webhook URL (if not provided, starts local server on --port)')
    .option('-s, --secret <secret>', 'Webhook secret (optional, auto-generated if not provided)')
    .option('--show-secret', 'Print the new webhook secret in full (hidden by default)')
    .option('-p, --port <port>', 'Local server port when using local server (default: 3001)')
    .option('-v, --verbose', 'Verbose output')
    .action((options) => actions.testWebhook({ ...options, ...api(options) }));

  // Trigger command with alias 't'
  withApiOptions(program
    .command('trigger')
    .alias('t')
    .description('Send test async request'))
    .option('-w, --workflow <name>', 'Workflow name')
    .option('-m, --message <text>', 'Test message')
    .option('-P, --payload <json>', 'Custom JSON payload')
    .option('-u, --webhook-url <url>', 'Webhook URL to receive response')
    .option('--print-channel', 'Print channel details')
    .option('--show-secret', 'Print the new webhook secret in full (hidden by default)')
    .action((options) => actions.trigger({ ...options, ...api(options) }));

  // Tools command - send hosted tool calls to a server on this machine
  withApiOptions(program
    .command('tools')
    .description('Forward hosted tool calls to a tool server on this machine (localhost only)'))
    .requiredOption('--forward-to <url>', 'Local tool server origin, e.g. http://localhost:3000 (localhost, 127.0.0.0/8 or ::1)')
    .option('--print', 'Print each call\'s arguments and result')
    .option('-v, --verbose', 'Verbose output')
    .addHelpText('after', `
Opens a CLI tool session and prints its ID. Send a request with
  "tool_route": {"cli_session": "<session id>"}
and ModelRiver sends that request's tool calls here. Each call is POSTed to
<forward-to origin><path of the tool's endpoint URL> with the same body and
signature headers a live call has, so your signature check runs unchanged.

The API key comes from --api-key, MODELRIVER_API_KEY or ~/.modelriver/config.json,
never from a .modelriverrc in the current directory.`)
    .action((options) => actions.tools({ ...options, ...api(options) }));

  // Webhook commands
  const webhookCmd = program
    .command('webhook')
    .description('Webhook management commands (read-only and verification)');

  withApiOptions(webhookCmd
    .command('list')
    .description('List all webhooks'))
    .option('-v, --verbose', 'Show detailed information')
    .action((options) => actions.listWebhooks({ ...options, ...api(options) }));

  webhookCmd
    .command('verify')
    .description('Verify webhook signature')
    .requiredOption('-p, --payload <file|json>', 'Payload file path or JSON string')
    .requiredOption('-s, --signature <sig>', 'X-ModelRiver-Signature header value')
    .requiredOption('-t, --timestamp <ts>', 'X-ModelRiver-Timestamp header value')
    .requiredOption('--secret <secret>', 'Webhook secret')
    .action((options, command) => actions.verifyWebhook(options, command));

  return program;
}

module.exports = { createProgram };
