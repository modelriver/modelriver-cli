# ModelRiver CLI

A command-line tool for testing webhooks and WebSockets from live/production ModelRiver, similar to Stripe CLI.

## Installation

### From npm (when published)

```bash
npm install -g @modelriver/cli
```

### From source

```bash
cd modelriver-cli
npm install
npm link  # Makes `modelriver` command available globally
```

## Configuration

### Environment Variables

Set these environment variables for convenience:

```bash
export MODELRIVER_API_KEY=mr_live_YOUR_API_KEY
export MODELRIVER_API_URL=https://api.modelriver.com  # Optional, defaults to production
```

### Config File

Create a config file at `~/.modelriver/config.json` or `.modelriverrc` in your project:

```json
{
  "api_key": "mr_live_YOUR_API_KEY",
  "api_url": "https://api.modelriver.com"
}
```

**Priority**: CLI arguments > Environment variables > Config file > Defaults

## Commands

### `modelriver listen` - Receive Webhooks via WebSocket

Like Stripe CLI, receive webhook events directly via WebSocket - no public URL needed.

```bash
# Start listening for webhooks (like `stripe listen`)
modelriver listen --print

# Forward to local server
modelriver listen --port 3001 --print

# With custom API key
modelriver listen --api-key mr_live_YOUR_KEY --print

# Forward to external server (without starting local server)
modelriver listen --port 3002 --forward --print
```

**How it works (like Stripe CLI):**
1. Authenticates with your API key
2. Gets a secure WebSocket token (valid for 24 hours)
3. Connects to ModelRiver via WebSocket
4. Receives webhook events in real-time - no public URL or ngrok required!
5. Optionally forwards to local server

**Example Output:**
```
✓ Connecting to ModelRiver...
✓ WebSocket connected
✓ Joined webhook channel

> Ready! Listening for webhook events
> User ID: user-id-123
> Channel: cli_webhooks:user-id-123
> Local port: 3001

> Press Ctrl+C to stop

[2026-01-07 15:20:30] Webhook received via WebSocket:
  Channel ID: abc-123-def
  Status: success
  Data: {"result": "..."}
```

### `modelriver websocket` - Test WebSocket Connection

Test WebSocket connections to production and receive real-time responses.

```bash
# Test with workflow
modelriver websocket --workflow my-workflow --message "Hello from CLI"

# With custom payload
modelriver websocket --workflow my-workflow --payload '{"messages": [{"role": "user", "content": "Test"}]}'

# Connect to existing channel
modelriver websocket --channel-id abc-123 --project-id xyz-789

# Verbose output
modelriver websocket --workflow my-workflow --message "Test" --verbose
```

**Example Output:**
```
✓ Making async request...
✓ Request queued: abc-123-def

> Channel ID: abc-123-def
> Project ID: xyz-789

✓ Connecting to WebSocket...
✓ WebSocket connected
✓ Channel joined

> Waiting for response...

✅ Response received:
{
  "status": "success",
  "data": { ... },
  "meta": { ... }
}
```

### `modelriver trigger` - Send Async Request

Send a test async request and get channel details.

```bash
# Basic trigger
modelriver trigger --workflow my-workflow --message "Test message"

# With custom payload
modelriver trigger --workflow my-workflow --payload '{"messages": [...]}'

# Create webhook to receive response
modelriver trigger --workflow my-workflow --message "Test" --webhook-url https://webhook.site/your-id

# Print channel details
modelriver trigger --workflow my-workflow --message "Test" --print-channel
```

**Example Output:**
```
✓ Async request created

Channel Details
{
  "channel_id": "abc-123-def",
  "project_id": "xyz-789",
  "websocket_url": "wss://api.modelriver.com/socket",
  "websocket_channel": "ai_response:xyz-789:abc-123-def",
  "status": "pending"
}

> Use --webhook-url to automatically receive responses via webhook
> Or use "modelriver websocket" to connect and receive responses
```

### `modelriver webhook list` - List Webhooks

List all webhooks for your project.

```bash
# List webhooks
modelriver webhook list

# Verbose output
modelriver webhook list --verbose
```

### `modelriver webhook verify` - Verify Signature

Verify a webhook signature locally.

```bash
# From file
modelriver webhook verify \
  --payload webhook.json \
  --signature abc123... \
  --timestamp 1234567890 \
  --secret your-webhook-secret

# From JSON string
modelriver webhook verify \
  --payload '{"channel_id": "...", "data": {...}}' \
  --signature abc123... \
  --timestamp 1234567890 \
  --secret your-webhook-secret
```

## Usage Examples

### Example 1: Listen for Webhooks (like Stripe CLI)

```bash
# Terminal 1: Start listening for webhooks via WebSocket
export MODELRIVER_API_KEY=mr_live_YOUR_KEY
modelriver listen --print

# Terminal 2: Trigger an async AI request
# Webhook events will appear in Terminal 1 via WebSocket (no public URL needed!)
```

### Example 2: Test WebSocket Connection

```bash
export MODELRIVER_API_KEY=mr_live_YOUR_KEY
modelriver websocket --workflow my-workflow --message "Hello from CLI" --verbose
```

### Example 3: Send Test Request and Get Channel Info

```bash
export MODELRIVER_API_KEY=mr_live_YOUR_KEY
modelriver trigger --workflow my-workflow --message "Test" --print-channel
```

## Webhook Payload Format

Webhooks are sent as HTTP POST requests with the following format:

**Body:**
```json
{
  "channel_id": "uuid",
  "timestamp": 1234567890,
  "data": {
    "status": "success|error",
    "data": { ... },
    "meta": { ... }
  }
}
```

**Headers:**
- `X-ModelRiver-Signature`: HMAC-SHA256 hex signature
- `X-ModelRiver-Timestamp`: Unix timestamp string
- `X-ModelRiver-Webhook-Id`: Webhook UUID
- `Content-Type`: `application/json`

## WebSocket Protocol

The CLI connects to ModelRiver WebSockets using the Phoenix protocol:

1. Connect to `wss://api.modelriver.com/socket?token={ws_token}`
2. Join channel: `ai_response:{project_id}:{channel_id}`
3. Listen for `response` event containing the AI response

## Troubleshooting

### "API key is required"

Set the API key via:
- Environment variable: `export MODELRIVER_API_KEY=mr_live_YOUR_KEY`
- CLI flag: `--api-key mr_live_YOUR_KEY`
- Config file: `~/.modelriver/config.json`

### "WebSocket connection failed"

- Verify the API URL is correct
- Check that the `ws_token` hasn't expired (24-hour limit for CLI tokens)
- Check network connectivity
- If using production, ensure you're using `wss://` (secure WebSocket)

### "Webhook signature verification failed"

- Ensure the secret matches exactly (no extra spaces)
- Verify timestamp is recent (within 5 minutes)
- Check that payload structure matches expected format

**Note**: The CLI does not support creating permanent webhooks. Use the ModelRiver dashboard to create webhooks for production use. The CLI only creates temporary webhooks for testing (via `listen` and `test-webhook` commands), which are automatically cleaned up.

## API Endpoints

The CLI uses these ModelRiver API endpoints:

- `POST /v1/ai/async` - Create async request (production)
- `POST /api/v1/ai/async` - Create async request (dev/test)
- `POST /v1/ai/reconnect` - Get reconnect token (production)
- `POST /api/v1/ai/reconnect` - Get reconnect token (dev/test)
- `GET /v1/webhooks` - List webhooks (production)
- `GET /api/v1/webhooks` - List webhooks (dev/test)

## Development

### Running Tests

The CLI includes a Jest test suite. To run the tests:

```bash
npm test
```

Tests cover critical components including:
- Webhook signature verification
- Configuration loading
- API client validation
- Output formatting


## License

MIT


