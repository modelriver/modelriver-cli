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
export MODELRIVER_PROJECT_ID=your-project-id
export MODELRIVER_API_URL=https://api.modelriver.com  # Optional, defaults to production
```

### Config File

Create a config file at `~/.modelriver/config.json` or `.modelriverrc` in your project:

```json
{
  "api_key": "mr_live_YOUR_API_KEY",
  "project_id": "your-project-id",
  "api_url": "https://api.modelriver.com"
}
```

**Priority**: CLI arguments > Environment variables > Config file > Defaults

## Commands

### `modelriver listen` - Forward Webhooks

Forward webhooks from production to your local server.

```bash
# Forward to local server
modelriver listen --forward-to http://localhost:3001/webhook

# Print webhook payloads to console
modelriver listen --forward-to http://localhost:3001/webhook --print

# With custom API key
modelriver listen --forward-to http://localhost:3001/webhook --api-key mr_live_YOUR_KEY
```

**Features:**
- Creates a temporary webhook in your production project
- Forwards all webhooks to your local endpoint
- Verifies HMAC signatures automatically
- Cleans up webhook on exit (Ctrl+C)

**Example Output:**
```
✓ Setting up webhook forwarding...
✓ Webhook forwarding active

> Ready! ModelRiver webhook forwarding is active
> Webhook ID: abc-123-def
> Forwarding to: http://localhost:3001/webhook

> Press Ctrl+C to stop forwarding
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

### `modelriver webhook create` - Create Webhook

Create a new webhook in your project.

```bash
# Create webhook
modelriver webhook create --url https://webhook.site/your-id

# With description
modelriver webhook create --url https://webhook.site/your-id --description "Production webhook"

# With custom secret
modelriver webhook create --url https://webhook.site/your-id --secret my-custom-secret
```

**Important**: Save the secret shown - it's only displayed once!

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

### Example 1: Forward Webhooks to Local Server

```bash
# Terminal 1: Start webhook forwarding
export MODELRIVER_API_KEY=mr_live_YOUR_KEY
modelriver listen --forward-to http://localhost:3001/webhook --print

# Terminal 2: Send async request from production
# Webhooks will appear in Terminal 1
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

### Example 4: Create Webhook from CLI

```bash
export MODELRIVER_API_KEY=mr_live_YOUR_KEY
modelriver webhook create \
  --url https://webhook.site/your-unique-id \
  --description "Production test webhook"
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
- Check that the `ws_token` hasn't expired (5-minute limit)
- Ensure the token hasn't been used (one-time use)
- Check network connectivity

### "Webhook signature verification failed"

- Ensure the secret matches exactly (no extra spaces)
- Verify timestamp is recent (within 5 minutes)
- Check that payload structure matches expected format

### "Failed to create webhook"

- Verify the webhook URL is publicly accessible
- Check that the URL is a valid HTTP/HTTPS endpoint
- Ensure you have permission to create webhooks in the project

## API Endpoints

The CLI uses these ModelRiver API endpoints:

- `POST /api/v1/ai/async` - Create async request
- `POST /api/v1/ai/reconnect` - Get reconnect token
- `GET /api/v1/webhooks` - List webhooks
- `POST /api/v1/webhooks` - Create webhook
- `DELETE /api/v1/webhooks/:id` - Delete webhook

## License

MIT


