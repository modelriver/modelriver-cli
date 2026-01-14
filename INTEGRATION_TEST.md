# ModelRiver Full Integration Test

This guide walks you through testing the complete webhook flow using:
- **Terminal 1**: `webhook-test-server` (receives and displays webhooks)
- **Terminal 2**: `modelriver-cli` (forwards webhooks from production)
- **Terminal 3**: `modelriver-cli` (triggers AI requests)

---

## Prerequisites

1. ✅ `modelriver-cli` is installed and logged in (`modelriver login`)
2. ✅ `webhook-test-server` is installed (`npm install`)
3. ✅ You have a valid workflow in ModelRiver production (e.g., `prod`)

---

## Terminal Setup

### Terminal 1: Start Webhook Test Server

```bash
cd webhook-test-server
npm start
```

**Expected Output:**
```
Webhook Test Server listening on port 3001
Webhook endpoint: POST http://localhost:3001/webhook
Web interface: http://localhost:3001
```

📌 **Leave this terminal running!**
📌 **Open browser to http://localhost:3001 to see webhooks in real-time**

---

### Terminal 2: Start CLI Webhook Forwarding

```bash
cd modelriver-cli
modelriver listen --port 3001 --forward --print
```

**What this does:**
- Connects to ModelRiver production via WebSocket
- Forwards received webhooks to `localhost:3001/webhook`
- Prints webhooks to console as they arrive

**Expected Output:**
```
✓ Webhook forwarding active
✓ > Ready! ModelRiver webhook forwarding is active
ℹ > User ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ℹ > Channel: cli_webhooks:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ℹ > Local port: 3001
⚠ > Press Ctrl+C to stop forwarding
✓ > Forwarding webhooks to http://localhost:3001/webhook
```

📌 **Leave this terminal running!**

---

### Terminal 3: Trigger an AI Request

```bash
cd modelriver-cli
modelriver trigger --workflow prod --message "Hello from integration test"
```

**Replace `prod` with your actual workflow name!**

**Expected Output:**
```
✔ Async request created

Channel Details
{
  "channel_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "project_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  ...
}
```

---

## What Happens (The Flow)

```
┌─────────────────┐    1. Trigger Request    ┌─────────────────────┐
│   Terminal 3    │ ──────────────────────►  │  ModelRiver Prod    │
│  (CLI trigger)  │                          │   (Cloud Server)    │
└─────────────────┘                          └─────────┬───────────┘
                                                       │
                                             2. AI Processing
                                                       │
                                                       ▼
┌─────────────────┐    3. WebSocket Push     ┌─────────────────────┐
│   Terminal 2    │ ◄──────────────────────  │  ModelRiver Prod    │
│ (CLI listener)  │                          │   (Sends Webhook)   │
└────────┬────────┘                          └─────────────────────┘
         │
         │ 4. HTTP POST to localhost:3001/webhook
         ▼
┌─────────────────┐
│   Terminal 1    │
│ (webhook-test-  │
│    server)      │
└─────────────────┘
         │
         │ 5. Displays in Web UI
         ▼
┌─────────────────┐
│    Browser      │
│ localhost:3001  │
└─────────────────┘
```

---

## Verify Success

### ✅ Terminal 1 (webhook-test-server)
Should show:
```
[timestamp] Received webhook:
  Webhook ID: xxxxxxxx
  Channel ID: xxxxxxxx
  Status: success
  Data: { ... }
```

### ✅ Terminal 2 (CLI listener)
Should show:
```
[timestamp] Webhook received via WebSocket:
  Channel ID: xxxxxxxx
  Status: success
  Data: { ... }
  → Forwarded to local server (status: 200)
```

### ✅ Terminal 3 (CLI trigger)
Should show:
```
✔ Async request created
```

### ✅ Browser (http://localhost:3001)
Should display the webhook with all data!

---

## Quick Reference Commands

| Terminal | Directory | Command |
|----------|-----------|---------|
| 1 | webhook-test-server | `npm start` |
| 2 | modelriver-cli | `modelriver listen --port 3001 --forward --print` |
| 3 | modelriver-cli | `modelriver trigger -w prod -m "Test"` |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "No API key configured" | Run `modelriver login` in Terminal 2 or 3 |
| Terminal 2 shows "Failed to forward" | Make sure Terminal 1 is running first |
| No webhook in browser | Check Terminal 2 received it. Check Terminal 1 logs |
| Signature verification failed | Set `WEBHOOK_SECRET` env var in Terminal 1 |
