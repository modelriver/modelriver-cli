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

The API URL must use `https`. Plain `http` is accepted only for `localhost`, `127.0.0.0/8` and `::1` (a local ModelRiver server).

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

`modelriver tools` also **refuses an `api_key` from a `.modelriverrc`** in the current directory. A cloned repository could plant another account's key there, and that account could then send POST requests to servers on your machine. `tools` takes the key only from `--api-key`, `MODELRIVER_API_KEY` or `~/.modelriver/config.json`. For the same reason `modelriver login` never offers a `.modelriverrc` key as its default (pressing Enter would save it to `config.json`); its default comes only from `MODELRIVER_API_KEY` or `config.json`.

The API URL saved in `~/.modelriver/config.json` (for example by `modelriver login --api-url`) is used in every folder, also where a `.modelriverrc` is present.

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

# Hosted tools: say who the request is for, and send its tool calls to `modelriver tools`
modelriver websocket --workflow my-workflow --message "Cancel order 1041" \
  --end-user user_812 --cli-session cts_...

# Verbose output
modelriver websocket --workflow my-workflow --message "Test" --verbose
```

- `--end-user <id>` adds `"end_user": {"id": "<id>"}` to the request, unless `--payload` already has an `end_user`. Workflows with hosted tools need one.
- `--cli-session <cts_id>` adds `"tool_route": {"cli_session": "<cts_id>"}`, unless `--payload` already has a `tool_route`.

The command waits 5 minutes for the response. When a call to a tool that changes something waits for approval, it prints the call and the commands that decide it, and keeps waiting until the last waiting call expires, plus 5 minutes for the request to carry on (never more than 65 minutes per round of approvals; a later round that waits again extends it the same way). It also shows each decision. It exits with code 1 when the wait ends or the connection closes before a response, and when ModelRiver refuses the request (it then prints the error code, message and details, and for a `429` how long to wait). The WebSocket URL from the server must use `wss://` (a `ws://` URL on port 443 or a `modelriver.com` host is treated as `wss://`); only `localhost`, `127.0.0.0/8` and `::1` may use `ws://`.

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
Or send one and follow it (approvals included) from another terminal:
  modelriver websocket -w <workflow> -m "..." --end-user <id> --cli-session cts_...
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
- `--print` - print arguments and results. Calls to a tool that changes something are marked `[write]` when the server says so.
- `--new-session` - open a new session instead of rejoining the one saved on this machine (see "Restarting" below).
- `-k, --api-key <key>` - API key. Without it the key comes from `MODELRIVER_API_KEY` or `~/.modelriver/config.json`, never from a `.modelriverrc` in the current directory.
- `--api-url <url>` - API base URL
- `-v, --verbose` - verbose output

**Safety rules:**
- Calls are only forwarded to this machine. The host must be `localhost` or resolve only to `127.0.0.0/8` or `::1`. The CLI checks the resolved address for every call and connects to that checked address. Anything else is refused, and ModelRiver gets a `target_refused` error.
- `http` and `https` are both allowed. Redirects are not followed.
- The CLI waits no longer than the tool's timeout, and stops reading a response once it is larger than the tool's result size limit (`too_large`).
- A request only goes to the CLI when it names the session in `tool_route`. If the CLI is not connected, the request is refused; ModelRiver never falls back to the tool's real URL.
- If the CLI disconnects or stops during a run, new tool calls fail at once as tool unavailable. Only calls already sent to the CLI wait, and time out if no result comes back. On Ctrl+C the CLI answers its in-flight calls with `connection_failed` before it exits; a call that arrives after Ctrl+C is not forwarded and is answered `target_refused`, so ModelRiver records it as not sent.
- The session lasts 24 hours. Treat the session ID like a password while it is valid. When it reaches its expiry time, the CLI says the session expired and exits with code 1; start `modelriver tools` again for a new session ID. If the WebSocket drops, the CLI reconnects with a new token and rejoins the same session. A result that was ready while the CLI was disconnected is sent after the rejoin, as long as the call's timeout hasn't passed, and ModelRiver takes it if the call is still waiting. ModelRiver uses the first result it gets for a call; a later copy (the CLI may have sent one just before the connection dropped) is answered `already_answered` and changes nothing. If the call stopped waiting first, the CLI notes that ModelRiver is no longer waiting for it, and the call is recorded as timed out (as unknown, for a tool that changes something). The CLI never forwards a call to your server twice.
- **Restarting.** The session is saved in `~/.modelriver/tool-sessions.json` (readable only by you: `0600`, in a `0700` folder). Start `modelriver tools` again with the same API key, API URL and `--forward-to` origin, also after it was killed, and it rejoins that session instead of opening a new one, as long as the session has at least an hour left. With less than an hour left it opens a new one (with a new ID), so a restarted CLI never runs on a session about to end. Requests that already name the session keep working, and a call that was waiting for approval reaches the restarted CLI once it is approved. The session ID is printed in full only when the session is opened; after a restart it is shown as `cts_…1234`. If the saved session can no longer be joined (it expired or was removed), the CLI says so and opens a new one, with a new ID. If hosted tools is off for the organization, it stops with that message and keeps the saved session for later. `--new-session` always opens a new one. Several CLIs can start and stop at the same time: every change to the file is made under a lock (`tool-sessions.json.lock`; a lock left by a CLI that crashed is taken over at once, or after 5 seconds when it came from another machine sharing the folder), and a CLI only removes its own session's record, never a newer one another CLI saved. If the file or its folder is readable by others when it is read, the CLI tightens it back to `0600`/`0700`.
- **Never twice, across restarts too.** The file also lists the calls the CLI has handed to your server (the latest 1000 per session), written before each call goes out. A restarted CLI answers any of them `connection_failed` without forwarding it. ModelRiver itself never sends a call again: a call that was in flight when the CLI was killed is not re-sent after the restart. It times out, and for a tool that changes something its outcome is recorded as unknown.
- One connection per session. Starting a second `modelriver tools` with the same API key and `--forward-to` rejoins the same session, so it takes over from the first. If another connection joins the same session, it takes over: ModelRiver sends the tool calls there, and this CLI stops and says so instead of reconnecting.
- The WebSocket URL the server gives must use `wss://`. Only `localhost`, `127.0.0.0/8` and `::1` may use `ws://`.
- Each API key owner can have up to 5 connected tool sessions per project. Opening another one replaces your oldest disconnected session; if all 5 are connected, it is refused until you stop one.
- Response bodies must be UTF-8. For any other body the CLI sends the status code without the body.

**Protect your production endpoints:** the CLI session receives each tool call exactly as signed, so a valid signature alone doesn't prove a call came from a live run. Calls meant for the CLI have `request.via == "cli"` in their body. Production tool endpoints should reject those.

Errors the CLI can send back for a call: `timeout`, `connection_failed`, `too_large`, `target_refused`.

#### Tools that change something

A tool marked as changing something (refund an order, send an email) never runs on the model's say-so alone. ModelRiver pauses the request and asks the request's end user first. Only an approved call is sent to `modelriver tools`, and it is sent once.

1. Start `modelriver tools` and leave it running.
2. In another terminal, send a request that names the session and an end user, and follow it:

   ```bash
   modelriver websocket -w my-workflow -m "Cancel order 1041" --end-user user_812 --cli-session cts_...
   ```

3. When the model calls the tool, the request waits. `modelriver websocket` shows what the end user would see, and the commands that decide it:

   ```
   ⚠ Waiting for approval: cancel_order (call tc_3f2a9c1d5b7e4a6f8c0d1e2b)
     Prompt: Cancel this order? This can't be undone.
     Arguments shown to the end user:
       order_id: 1041
     Expires: 2026-11-14T10:20:00Z
     Decide it with:
       modelriver tools approve tc_3f2a9c1d5b7e4a6f8c0d1e2b --end-user user_812
       modelriver tools reject tc_3f2a9c1d5b7e4a6f8c0d1e2b --end-user user_812
   ```

4. Approve or decline it, as your backend would for its user:

   ```bash
   modelriver tools approve tc_3f2a9c1d5b7e4a6f8c0d1e2b --end-user user_812
   modelriver tools reject  tc_3f2a9c1d5b7e4a6f8c0d1e2b --end-user user_812   # or: decline
   modelriver tools show    tc_3f2a9c1d5b7e4a6f8c0d1e2b                        # prompt and shown arguments
   ```

   These call `POST /v1/ai/tool-calls/:call_id/approve` (or `/reject`) with `{"end_user": {"id": "..."}}`, and `GET /v1/ai/tool-calls/:call_id`, with your API key. `--end-user` must be the `end_user.id` the request was sent with. Prompts and arguments are printed as plain text: control characters, and invisible or direction-changing characters (zero-width characters, bidi embeddings, overrides and isolates such as U+202E, U+FEFF), show as `\uXXXX`, so text from the model can't drive your terminal or make an approval read differently from what it says.

What to expect:
- **Keep `modelriver tools` running while a call waits.** The wait lasts as long as the workflow's approval timeout (10 minutes by default, at most an hour). If the CLI isn't connected when the call is approved, the call is not sent, and ModelRiver records it as not run (`tool_unavailable`). It never falls back to the tool's real URL.
- **Once, never retried.** An approved call reaches your server at most once. ModelRiver never retries a tool that changes something, and the CLI remembers every call of the session: a repeated `tool_call` (same `reply_ref` or same call id) is never forwarded again; a repeat under a new `reply_ref` is answered `connection_failed`.
- **Unknown outcomes.** If the call may have reached your server but no answer says what happened (a timeout, a dropped connection, a `5xx`, a response larger than the result size limit, or Ctrl+C), ModelRiver records the outcome as unknown and tells the model not to claim it succeeded. A `4xx` stays an error: your tool refused the call. A `2xx` whose body isn't a JSON object or array counts as done: the call is recorded as `ok`, and the model is told the action ran but its result could not be read.
- **Ctrl+C mid-call.** The CLI aborts its request to your server and answers `connection_failed`. Your server may already have done the work, so the CLI warns that the call may have run, and ModelRiver records it as unknown.
- **Timeouts and takeovers.** When your server doesn't answer within the tool's timeout, or another connection takes over the session mid-call, the CLI stops waiting and warns that the call may already have run.
- **Declined or expired calls** are not run. The model is told, and the request carries on.
- **Errors from approve/reject:** `end_user_required` / `end_user_invalid` (pass `--end-user`), `tool_call_not_found` (wrong id, another project's call, a Playground call, or a call that needed no approval), `end_user_mismatch` (another end user's call), `tool_call_already_decided` (with the decision it already has), `tool_approval_expired`, and `429` with the number of seconds to wait. Repeating the same decision is fine.

#### Check the tool signature

Your tool server should check `x-modelriver-signature` on every call. The CLI includes a checker you can use from Node:

```js
const ToolSignature = require('@modelriver/cli/tool-signature');

app.post('/tools/cancel-order', express.raw({ type: 'application/json' }), (req, res) => {
  // req.body is the raw body (a Buffer): check it before parsing
  if (!ToolSignature.verifyRequest(req.headers, req.body, process.env.MODELRIVER_TOOL_SECRET)) {
    return res.status(401).json({ error: { message: 'Bad signature' } });
  }
  const call = JSON.parse(req.body);
  // ...
});
```

It checks `v2=hex(HMAC-SHA256(secret, "v2.<timestamp>.<call id>.<raw body>"))` against every value in the header (there are two, comma-separated, while a secret is being rotated), and rejects a timestamp more than 300 seconds from now. Pass an array of secrets to accept an old and a new one. Use the raw body: parsing the JSON and encoding it again changes the bytes. `ToolSignature.check(...)` reports the signature and the timestamp separately. This is not the webhook signature; `modelriver webhook verify` checks webhooks only.

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
4. For hosted tools, also `tool_state` (sent on join), `tool_approval_required` and `tool_approval_resolved`

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

### "Refusing WebSocket URL ...: it must use wss"

The server gave a WebSocket URL with plain `ws://` for a host other than this machine. The CLI refuses it so its token and your tool calls are never sent unencrypted. Check `--api-url`; a local ModelRiver server on `localhost` may use `ws://`.

### "API URL must use https"

Use an `https://` API URL. Only `localhost`, `127.0.0.0/8` and `::1` may use `http://`.

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
- `GET /v1/ai/tool-calls/:call_id` - Show a call waiting for approval (`modelriver tools show`)
- `POST /v1/ai/tool-calls/:call_id/approve` and `/reject` - Decide it (`modelriver tools approve|reject`)
- `POST /v1/callback/:channel_id` - Complete event-driven callback

**Development** (localhost or custom API URL):
- Same endpoints but with `/api/v1` prefix instead of `/v1`

## Development

### Pointing the CLI at a local ModelRiver server

For working on ModelRiver itself: save your local server's URL once, and every command uses it.

```bash
modelriver login --api-url http://localhost:4000
```

`--api-url` isn't listed in `modelriver login --help`. Only https URLs, or http to localhost, 127.0.0.0/8 or ::1, are accepted. `MODELRIVER_API_URL` or `--api-url` on a command still override the saved URL. The saved URL applies in every folder, including ones with a `.modelriverrc`. To go back to production, run `modelriver login --api-url https://api.modelriver.com`.

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
- Tool forwarding: loopback-only targets (including names that resolve to public IPs), exact body and headers, timeouts and size limits, Ctrl+C aborting the local request
- Tool approvals: approve/reject/show requests and error messages, following a paused request, plain-text output
- The v2 tool signature, against the documented test value
- WebSocket client: push/reply refs, several topics, reconnect with a fresh token
- Config file permissions and the `.modelriverrc` `api_url` rule
- `modelriver login`: what it asks, the saved `--api-url`, and the Quick Start

The tests never touch your real `~/.modelriver`: `test/support/isolate-home.js` points `MODELRIVER_CONFIG_DIR` and `HOME` at a temp folder for every test file, makes `os.homedir()` throw, fails any file access inside the real `~/.modelriver`, and gives child processes the tests start (without their own `env`) that temp environment too.

Tests run on Node 22.12+. chalk and ora are ESM-only, and Jest can only `require()` ESM on Node 24.9+, so the tests map them to small stand-ins in `test/support/`.


## License

MIT


