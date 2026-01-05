#!/usr/bin/env node

const { Command } = require('commander');
const { listenCommand } = require('./commands/listen');
const { websocketCommand } = require('./commands/websocket');
const { triggerCommand } = require('./commands/trigger');
const { testWebhookCommand } = require('./commands/test-webhook');
const { createWebhook, listWebhooks, verifyWebhook } = require('./commands/webhook');
const config = require('./lib/config');

const program = new Command();

program
  .name('modelriver')
  .description('ModelRiver CLI for testing webhooks and WebSockets from production')
  .version('1.0.0');

// Global options
program
  .option('-k, --api-key <key>', 'ModelRiver API key (or set MODELRIVER_API_KEY)')
  .option('--api-url <url>', 'API base URL (default: https://api.modelriver.com)')
  .option('-p, --project-id <id>', 'Project ID (or set MODELRIVER_PROJECT_ID)');

// Listen command
program
  .command('listen')
  .description('Forward webhooks from production to local server')
  .requiredOption('-f, --forward-to <url>', 'Local server URL to forward webhooks')
  .option('--print', 'Print webhook payloads to console')
  .action((options) => {
    listenCommand({
      ...options,
      apiKey: options.apiKey || program.opts().apiKey,
      apiUrl: options.apiUrl || program.opts().apiUrl
    });
  });

// WebSocket command
program
  .command('websocket')
  .description('Test WebSocket connection to production')
  .option('-w, --workflow <name>', 'Workflow name')
  .option('-m, --message <text>', 'Test message')
  .option('-P, --payload <json>', 'Custom JSON payload')
  .option('-c, --channel-id <id>', 'Existing channel ID (requires --project-id)')
  .option('-v, --verbose', 'Verbose output')
  .action((options) => {
    websocketCommand({
      ...options,
      apiKey: options.apiKey || program.opts().apiKey,
      apiUrl: options.apiUrl || program.opts().apiUrl,
      projectId: options.projectId || program.opts().projectId
    });
  });

// Test Webhook command
program
  .command('test-webhook')
  .description('Test webhook delivery - creates webhook, makes request, waits for response')
  .option('-w, --workflow <name>', 'Workflow name')
  .option('-m, --message <text>', 'Test message')
  .option('-P, --payload <json>', 'Custom JSON payload')
  .option('-u, --webhook-url <url>', 'Webhook URL (if not provided, starts local server on --port)')
  .option('-s, --secret <secret>', 'Webhook secret (optional, auto-generated if not provided)')
  .option('-p, --port <port>', 'Local server port when using local server (default: 3001)')
  .option('-v, --verbose', 'Verbose output')
  .action((options) => {
    testWebhookCommand({
      ...options,
      apiKey: options.apiKey || program.opts().apiKey,
      apiUrl: options.apiUrl || program.opts().apiUrl
    });
  });

// Trigger command
program
  .command('trigger')
  .description('Send test async request')
  .option('-w, --workflow <name>', 'Workflow name')
  .option('-m, --message <text>', 'Test message')
  .option('-P, --payload <json>', 'Custom JSON payload')
  .option('-u, --webhook-url <url>', 'Webhook URL to receive response')
  .option('--print-channel', 'Print channel details')
  .action((options) => {
    triggerCommand({
      ...options,
      apiKey: options.apiKey || program.opts().apiKey,
      apiUrl: options.apiUrl || program.opts().apiUrl
    });
  });

// Webhook commands
const webhookCmd = program
  .command('webhook')
  .description('Webhook management commands');

webhookCmd
  .command('create')
  .description('Create a new webhook')
  .requiredOption('-u, --url <url>', 'Webhook URL')
  .option('-d, --description <text>', 'Description')
  .option('-s, --secret <secret>', 'Custom secret (optional, auto-generated if not provided)')
  .action((options) => {
    createWebhook({
      ...options,
      apiKey: options.apiKey || program.opts().apiKey,
      apiUrl: options.apiUrl || program.opts().apiUrl
    });
  });

webhookCmd
  .command('list')
  .description('List all webhooks')
  .option('-v, --verbose', 'Show detailed information')
  .action((options) => {
    listWebhooks({
      ...options,
      apiKey: options.apiKey || program.opts().apiKey,
      apiUrl: options.apiUrl || program.opts().apiUrl
    });
  });

webhookCmd
  .command('verify')
  .description('Verify webhook signature')
  .requiredOption('-p, --payload <file|json>', 'Payload file path or JSON string')
  .requiredOption('-s, --signature <sig>', 'X-ModelRiver-Signature header value')
  .requiredOption('-t, --timestamp <ts>', 'X-ModelRiver-Timestamp header value')
  .requiredOption('--secret <secret>', 'Webhook secret')
  .action(verifyWebhook);

// Parse arguments
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}


