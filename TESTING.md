# Testing ModelRiver CLI with Production

This guide explains how to test the CLI against the live ModelRiver production environment.

## Prerequisites

1. **API Key**: You need a valid API key from [ModelRiver Console](https://console.modelriver.com).
   - Key should start with `mr_live_` or `mr_test_`.
2. **Node.js**: Ensure you have Node.js installed.

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

## Troubleshooting

- **Login Issues**: If `modelriver forward` fails, try running `modelriver login` again to ensure your key is correct.
- **Connection Failed**: Check your internet connection. Ensure `MODELRIVER_API_URL` is NOT set to localhost if testing production (it defaults to production).
- **No Webhooks**: Ensure the workflow you are triggering actually sends a response/webhook.
