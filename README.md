# ModelRiver CLI

A command-line tool for testing webhooks, WebSockets and hosted tools from live/production ModelRiver, similar to Stripe CLI.

## Requirements

- **Node.js 22.12 or later.** Version 2.0 needs Node 22.12+ because its dependencies (chalk, ora, commander) are ESM-only and are loaded with `require()`. On older Node, stay on `@modelriver/cli@1`.

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

## Quick Start

### Step 1: Login (One-Time Setup)

Run the interactive login command to configure your API key and forward URL:

```bash
modelriver login
```

You'll be prompted for:
1. **API Key**: Your ModelRiver API key (starts with `mr_live_` or `mr_test_`)
2. **Forward URL**: Where to forward webhooks on your machine (e.g., `http://localhost:3001/webhook/modelriver`)

This is your local webhook receiver (CLI default port **3001**), not the ModelRiver API port (**4000**).
The URL will be automatically normalized to include `/webhook/modelriver` if needed.

### Step 2: Start Forwarding

After login, simply run:

```bash
modelriver forward
```

That's it! Webhooks will be forwarded to your configured URL.

## Command Aliases

For convenience, the CLI supports short aliases:

| Command | Alias | Description |
|---------|-------|-------------|
| `listen` | `l` | Listen for webhooks |
| `forward` | `f` | Forward using saved config |
| `trigger` | `t` | Send async request |
| `websocket` | `ws` | Test WebSocket connection |
| `callback` | - | Complete event-driven callback |
| `test-webhook` | - | Test webhook delivery end-to-end |

Example:
```bash
modelriver l --print   # Same as: modelriver listen --print
modelriver f           # Same as: modelriver forward
modelriver t -w my-workflow -m "Hello"  # Same as: modelriver trigger ...
```

## Configuration

### Interactive Setup (Recommended)

```bash
modelriver login
```

This saves your configuration to `~/.modelriver/config.json`. The file is written readable only by you (mode `0600`, folder `0700`). Set `MODELRIVER_CONFIG_DIR` to keep it in another folder.

### Environment Variables

Set these environment variables for convenience:

```bash
export MODELRIVER_API_KEY=mr_live_YOUR_API_KEY
export MODELRIVER_API_URL=https://api.modelriver.com  # Optional, defaults to production
```

The API URL must use `https`. Plain `http` is accepted only for `localhost`, `127.0.0.1` and `::1` (a local ModelRiver server).

### Config File

Create a config file at `~/.modelriver/config.json` or `.modelriverrc` in your project:

```json
{
  "api_key": "mr_live_YOUR_API_KEY",
  "api_url": "https://api.modelriver.com",
  "forward_url": "http://localhost:3001/webhook/modelriver"
}
```

**Priority**: CLI arguments > Environment variables > Config file > Defaults

A `.modelriverrc` in the current directory **cannot set `api_url`**; the CLI ignores it and prints a warning. Otherwise a repository you check out could send your API key to a server of its choosing. Set the API URL with `--api-url`, `MODELRIVER_API_URL` or `~/.modelriver/config.json`.

`modelriver tools` also **refuses an `api_key` from a `.modelriverrc`** in the current directory. A cloned repository could plant another account's key there, and that account could then send POST requests to servers on your machine. `tools` takes the key only from `--api-key`, `MODELRIVER_API_KEY` or `~/.modelriver/config.json`.

### Command-line options

Global options (`-k/--api-key`, `--api-url`, `-p/--project-id`) go **before** the command name:

```bash
modelriver -p proj_123 websocket --workflow my-workflow
```

After the command name, each command's own options apply, so `-p` means the port for `listen`, `forward` and `test-webhook`, and the payload for `webhook verify`. Commands that call the API also accept `-k/--api-key` and `--api-url` after the command name, and `websocket` accepts `-p/--project-id`.

The CLI never prints your API key or webhook secrets in full. It shows a masked form such as `mr_live_…a1b2`.

## Commands

### `modelriver login` - Interactive Setup

Configure your API key and forward URL interactively:

```bash
modelriver login
```

Example session:
```
ModelRiver CLI Login
─────────────────────
Configure your ModelRiver CLI credentials.

Enter your ModelRiver API key: mr_live_abc123...
Enter your webhook forward URL (e.g. http://localhost:3001/webhook/modelriver): http://localhost:3001/webhook/modelriver

✓ Configuration saved!

Saved Configuration
───────────────────
✓ API Key: mr_live_abc123...
✓ Forward URL: http://localhost:3001/webhook/modelriver
```

### `modelriver forward` - Quick Webhook Forwarding

Forward webhooks using your saved configuration:

```bash
# Simple - uses saved config from login
modelriver forward

# Override port
modelriver forward --port 4001

# Verbose output
modelriver forward --verbose
```

### `modelriver listen` - Receive Webhooks via WebSocket

Like Stripe CLI, receive webhook events directly via WebSocket - no public URL needed.

```bash
# Start listening for webhooks (like `stripe listen`)
modelriver listen --print
# Or use alias: modelriver l --print

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

**Event-driven example:**
```
[timestamp] Webhook received via WebSocket:
  Channel ID: abc-123-def
  Status: ai_generated (callback required)
  Type: task.ai_generated
  Event: schema_result_ready
  Callback URL: https://api.modelriver.com/v1/callback/abc-123-def
  Customer data: { "ticket_id": "TCK-10042" }
  AI response: { ... }

> Event-driven webhook — complete the flow with a callback:
>   modelriver callback --channel-id abc-123-def --data '{"summary":"..."}'
```

### `modelriver callback` - Complete Event-driven Flows

After `listen` receives a `task.ai_generated` webhook, complete the flow:

```bash
# Using channel ID
modelriver callback \
  --channel-id abc-123-def \
  --data '{"summary":"Escalated to auth","priority":"high"}' \
  --task-id TCK-10042

# Using full callback URL from the webhook
modelriver callback \
  --callback-url "https://api.modelriver.com/v1/callback/abc-123-def" \
  --data '{"summary":"Escalated to auth"}'
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

# With custom payload (workflow can be in --payload or via --workflow)
modelriver trigger --workflow my-workflow --payload '{"messages": [...], "metadata": {"ticket_id":"TCK-1"}}'

# Create webhook to receive response
modelriver trigger --workflow my-workflow --message "Test" --webhook-url https://webhook.site/your-id

# Print channel details
modelriver trigger --workflow my-workflow --message "Test" --print-channel
```

For **event-driven** workflows, after triggering:

```bash
# Terminal 1
modelriver listen --print

# Terminal 2
modelriver trigger --workflow my-event-workflow --message "Test" --print-channel
modelriver callback --channel-id CHANNEL_ID --data '{"enriched":true}'
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

The secret of a webhook created with `--webhook-url` is masked. Add `--show-secret` to print it once in full.

### `modelriver tools` - Test Hosted Tools on Your Machine

With hosted tools, ModelRiver calls your workflow's tool endpoints itself. In production those must be public HTTPS URLs; ModelRiver refuses localhost and private addresses. `modelriver tools` lets you test a tool server running on your laptop: ModelRiver sends the tool calls to the CLI over its WebSocket, and the CLI forwards them to your local server.

```bash
modelriver tools --forward-to http://localhost:3000
```

```
✔ Tool forwarding active

> Session: cts_...
> Project: proj_...
> Expires: 2026-11-15T10:00:00Z
> Forwarding tool calls to http://localhost:3000

Add this to a POST /v1/ai/async request to send its tool calls here:
  "tool_route": {"cli_session": "cts_..."}
```

Then send a request that names the session:

```json
{
  "workflow": "my-workflow-with-tools",
  "messages": [{ "role": "user", "content": "What's the weather in Pune?" }],
  "tool_route": { "cli_session": "cts_..." }
}
```

Each tool call is POSTed to `<forward-to origin><path of the tool's endpoint URL>`. For a tool whose endpoint is `https://tools.example.com/weather?units=metric` and `--forward-to http://localhost:3000`, the call goes to `http://localhost:3000/weather?units=metric`. The body and headers (`x-modelriver-timestamp`, `x-modelriver-tool-call-id`, `x-modelriver-key-id`, `x-modelriver-signature`) are exactly what a live call sends, so your signature check runs unchanged.

The CLI prints one line per call (tool, status, time). Add `--print` to also see each call's arguments and result.

**Options:**
- `--forward-to <url>` (required) - your local tool server. Only the origin is used.
- `--print` - print arguments and results
- `-k, --api-key <key>` - API key. Without it the key comes from `MODELRIVER_API_KEY` or `~/.modelriver/config.json`, never from a `.modelriverrc` in the current directory.
- `--api-url <url>` - API base URL
- `-v, --verbose` - verbose output

**Safety rules:**
- Calls are only forwarded to this machine. The host must be `localhost` or resolve only to `127.0.0.0/8` or `::1`. The CLI checks the resolved address for every call and connects to that checked address. Anything else is refused, and ModelRiver gets a `target_refused` error.
- `http` and `https` are both allowed. Redirects are not followed.
- The CLI waits no longer than the tool's timeout, and stops reading a response once it is larger than the tool's result size limit (`too_large`).
- A request only goes to the CLI when it names the session in `tool_route`. If the CLI is not connected, the request is refused; ModelRiver never falls back to the tool's real URL.
- If the CLI disconnects or stops during a run, new tool calls fail at once as tool unavailable. Only calls already sent to the CLI wait, and time out if no result comes back. On Ctrl+C the CLI answers its in-flight calls with `connection_failed` before it exits.
- The session lasts 24 hours. Treat the session ID like a password while it is valid. If the WebSocket drops, the CLI reconnects with a new token and rejoins the same session. A result that was ready while the CLI was disconnected is sent after the rejoin, as long as the call's timeout hasn't passed.
- Each API key owner can have up to 5 connected tool sessions per project. Opening another one replaces your oldest disconnected session; if all 5 are connected, it is refused until you stop one.
- Response bodies must be UTF-8. For any other body the CLI sends the status code without the body.

**Protect your production endpoints:** the CLI session receives each tool call exactly as signed, so a valid signature alone doesn't prove a call came from a live run. Calls meant for the CLI have `request.via == "cli"` in their body. Production tool endpoints should reject those.

Errors the CLI can send back for a call: `timeout`, `connection_failed`, `too_large`, `target_refused`.

### `modelriver test-webhook` - Test Webhook Delivery End-to-End

Test the complete webhook flow - creates a webhook, makes an async request, and waits for the webhook response:

```bash
# Start local server and test webhook delivery
modelriver test-webhook --workflow my-workflow --message "Test"

# Use custom webhook URL (e.g., your local server or webhook.site)
modelriver test-webhook --workflow my-workflow --message "Test" --webhook-url http://localhost:4000/webhook/modelriver

# With custom secret and port
modelriver test-webhook --workflow my-workflow --message "Test" --port 3002 --secret my-secret

# Verbose output
modelriver test-webhook --workflow my-workflow --message "Test" --verbose
```

**Options:**
- `-w, --workflow <name>` - Workflow name (required)
- `-m, --message <text>` - Test message
- `-P, --payload <json>` - Custom JSON payload
- `-u, --webhook-url <url>` - Webhook URL (starts local server on --port if not provided)
- `-s, --secret <secret>` - Webhook secret (auto-generated if not provided)
- `-p, --port <port>` - Local server port (default: 3001)
- `-v, --verbose` - Verbose output

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

### Example 4: Event-driven Workflow End-to-End

```bash
# Terminal 1: Listen for webhooks
export MODELRIVER_API_KEY=mr_live_YOUR_KEY
modelriver listen --print

# Terminal 2: Trigger + callback
modelriver trigger \
  --workflow my-event-workflow \
  --payload '{"messages":[{"role":"user","content":"Test"}],"metadata":{"ticket_id":"TCK-1"}}' \
  --print-channel

# After Terminal 1 shows task.ai_generated:
modelriver callback --channel-id CHANNEL_ID --data '{"summary":"Done"}'
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

### "tools: ... is not loopback"

`modelriver tools` only forwards to this machine. Use `http://localhost:<port>`, `http://127.0.0.1:<port>` or `http://[::1]:<port>`. If your tool server runs in a container or VM, publish its port on localhost.

### "API URL must use https"

Use an `https://` API URL. Only `localhost`, `127.0.0.1` and `::1` may use `http://`.

### "Webhook signature verification failed"

- Ensure the secret matches exactly (no extra spaces)
- Verify timestamp is recent (within 5 minutes). The CLI rejects signatures whose timestamp is more than 5 minutes from now, as a receiver should; `modelriver webhook verify` says so when only the timestamp is the problem
- Check that payload structure matches expected format

**Note**: The CLI does not support creating permanent webhooks. Use the ModelRiver dashboard to create webhooks for production use. The CLI only creates temporary webhooks for testing (via `listen` and `test-webhook` commands), which are automatically cleaned up.

## API Endpoints

The CLI uses these ModelRiver API endpoints:

**Production** (`https://api.modelriver.com`):
- `POST /v1/ai/async` - Create async AI request
- `POST /v1/ai/reconnect` - Get reconnect token for existing channel
- `GET /v1/webhooks` - List all webhooks
- `POST /v1/webhooks` - Create a new webhook
- `DELETE /v1/webhooks/:id` - Delete a webhook
- `POST /v1/cli/connect` - Connect CLI and get WebSocket token
- `POST /v1/cli/tool-sessions` - Open a CLI tool session (`modelriver tools`)
- `POST /v1/callback/:channel_id` - Complete event-driven callback

**Development** (localhost or custom API URL):
- Same endpoints but with `/api/v1` prefix instead of `/v1`

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
- Event-driven webhook payload helpers
- Tool forwarding: loopback-only targets (including names that resolve to public IPs), exact body and headers, timeouts and size limits
- WebSocket client: push/reply refs, several topics, reconnect with a fresh token
- Config file permissions and the `.modelriverrc` `api_url` rule

The tests never touch your real `~/.modelriver`: `test/support/isolate-home.js` points `MODELRIVER_CONFIG_DIR` and `HOME` at a temp folder for every test file, makes `os.homedir()` throw, and fails any file access inside the real `~/.modelriver`.

Tests run on Node 22.12+. chalk and ora are ESM-only, and Jest can only `require()` ESM on Node 24.9+, so the tests map them to small stand-ins in `test/support/`.


## License

MIT


