# Testing ModelRiver CLI with Production

This guide explains how to test the CLI against the live ModelRiver production environment.

## Prerequisites

1. **API Key**: You need a valid API key from [ModelRiver Console](https://console.modelriver.com).
   - Key should start with `mr_live_` or `mr_test_`.
2. **Node.js 22.12 or later** (`node --version`). CLI 2.0 does not run on older Node.

## Setup (Terminal 1)

First, we need to configure the CLI and start listening for webhooks.

1. **Install and Link Global Command**:
   ```bash
   cd modelriver-cli
   npm install
   npm link
   ```

2. **Login**:
   Run the login command to save your credentials.
   ```bash
   modelriver login
   ```
   - **API Key**: Paste your `mr_live_...` key.
   - **Forward URL**: Enter `http://localhost:4000` (or your local server URL).
   
   *Tip: The CLI will automatically append `/webhook/modelriver` to your URL.*

3. **Start Forwarding**:
   Now, start the specific command to listen for webhooks and forward them.
   ```bash
   modelriver forward
   ```
   
   **You should see:**
   ```
   ✓ Configuration loaded
   ✓ Connectivity verified
   ✓ WebSocket connected
   > Ready! Listening for webhook events...
   ```
   *Keep this terminal open!*

## Trigger Events (Terminal 2)

Open a **new terminal window**. We will use this to trigger events that Terminal 1 will receive.

### Option A: Quick Test (Async Trigger)

Send a test message to a workflow to trigger a response.

```bash
modelriver trigger -w my-workflow -m "Hello from Terminal 2"
```

**What happens:**
1. **Terminal 2**: Takes the request and sends it to ModelRiver API.
2. **ModelRiver Cloud**: Processes the request.
3. **Terminal 1**: Receives the webhook event via WebSocket and prints it.
   ```
   [2024-03-20 10:00:00] Webhook received:
     Status: success
     Data: { ... }
   ```

### Option B: Full WebSocket Test

Test the bidirectional WebSocket connection.

```bash
modelriver websocket -w my-workflow -m "Direct WebSocket Test" --verbose
```

**What happens:**
1. **Terminal 2**: Connects directly to ModelRiver WebSocket, sends message, and waits for response.
2. **Terminal 2**: Prints the response when it arrives.

### Option C: Manual Webhook Verification

Simulate a webhook verification locally to test signature checking.

```bash
# Create a dummy payload
echo '{"test": "data"}' > payload.json

# Run verification (you'll need a real signature from a previous listener output)
modelriver webhook verify \
  --payload payload.json \
  --signature <SIGNATURE_FROM_TERM_1> \
  --timestamp <TIMESTAMP_FROM_TERM_1> \
  --secret <SECRET_FROM_TERM_1>
```

### Option D: Hosted tools on localhost

Test a tool server running on your machine with a workflow that has hosted tools turned on.

1. **Terminal 1** - start your tool server, e.g. on port 3000.
2. **Terminal 2** - start forwarding:
   ```bash
   modelriver tools --forward-to http://localhost:3000 --print
   ```
   Copy the session ID it prints.
3. **Terminal 3** - send a request that names the session:
   ```bash
   modelriver trigger --workflow my-tools-workflow \
     --payload '{"messages":[{"role":"user","content":"Weather in Pune?"}],"tool_route":{"cli_session":"cts_..."}}'
   ```

**What happens:**
1. ModelRiver runs the model. When it asks for a tool, ModelRiver sends the call to Terminal 2.
2. **Terminal 2** POSTs the call to `http://localhost:3000<tool path>` with the signed body and headers, prints `get_weather → 200 35ms` (plus arguments and result with `--print`), and sends the result back.
3. Stop Terminal 2 mid-run (Ctrl+C): a call it was forwarding gets `connection_failed`, the next call fails at once as tool unavailable, and nothing is sent to the tool's real URL. A call already sent to a CLI that lost its connection without stopping times out.

Checks worth doing:
- `modelriver tools --forward-to http://example.com` is refused (not loopback).
- A tool that sleeps longer than its timeout shows `timeout`; one that returns more than its result size limit shows `too_large`.
- A tool that returns a non-UTF-8 body (e.g. raw image bytes) sends its status with no body.
- In a folder with a `.modelriverrc` that sets `api_key`, `modelriver tools` refuses to start unless you pass `--api-key`, set `MODELRIVER_API_KEY`, or have a key in `~/.modelriver/config.json`.
- Up to 5 connected sessions per API key owner per project. A sixth `modelriver tools` while 5 are connected is refused; disconnected sessions are replaced, oldest first.
- Your production tool endpoint rejects a call whose body has `request.via == "cli"` (the CLI session receives the full signed call, so production must not accept calls meant for it).

## Troubleshooting

- **Login Issues**: If `modelriver forward` fails, try running `modelriver login` again to ensure your key is correct.
- **Node version**: `SyntaxError` or `ERR_REQUIRE_ESM` means Node is older than 22.12. Upgrade Node.
- **API URL must use https**: only `localhost`, `127.0.0.1` and `::1` may use `http://`. A `.modelriverrc` in the current directory cannot set `api_url`.
- **Connection Failed**: Check your internet connection. Ensure `MODELRIVER_API_URL` is NOT set to localhost if testing production (it defaults to production).
- **No Webhooks**: Ensure the workflow you are triggering actually sends a response/webhook.
