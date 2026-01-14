# ModelRiver CLI - Complete Test Cases

This guide provides step-by-step test cases to verify the CLI is working correctly.

---

## Test Case 1: Login Command (API Key Masking)

**Purpose**: Verify login works and API key is masked in prompts.

**Terminal 1**:
```bash
cd modelriver-cli
modelriver login
```

**Expected Output**:
- API Key shown as `mr_live_...xxxx` (masked, not full key)
- Prompt shows masked default: `Enter your ModelRiver API key (mr_live_...xxxx):`
- After save: `✓ Configuration saved!`

**Pass Criteria**: ✅ API key is masked, never shown in full.

---

## Test Case 2: Forward Command (Quick Start)

**Purpose**: Verify webhook forwarding works with saved config.

**Terminal 1**:
```bash
modelriver forward
```

**Expected Output**:
```
ℹ Using saved configuration:
ℹ   Forward URL: http://localhost:4000/webhook/modelriver
ℹ   Target Port: 4000

✔ Webhook forwarding active
✓ > Ready! ModelRiver webhook forwarding is active
```

**Pass Criteria**: ✅ Shows "Ready! ModelRiver webhook forwarding is active"

---

## Test Case 3: Trigger + Receive Webhook (End-to-End)

**Purpose**: Verify the full webhook flow works.

### Terminal 1 (Listener)
```bash
modelriver forward
```
Keep this running. It will receive webhooks.

### Terminal 2 (Trigger)
```bash
modelriver trigger --workflow prod --message "Hello from test"
```

**Expected Output in Terminal 1**:
```
[timestamp] Webhook received via WebSocket:
  Channel ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  Status: success
  Data: { ... }
```

**Expected Output in Terminal 2**:
```
✔ Async request created
> Channel ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
> Project ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**Pass Criteria**: ✅ Terminal 1 receives the webhook. Terminal 2 shows request created.

---

## Test Case 4: Command Aliases

**Purpose**: Verify short aliases work.

**Commands to test**:
```bash
modelriver l --help    # Should show listen help
modelriver f --help    # Should show forward help
modelriver t --help    # Should show trigger help
modelriver ws --help   # Should show websocket help
```

**Pass Criteria**: ✅ All aliases display correct help for their full commands.

---

## Test Case 5: URL Normalization

**Purpose**: Verify URLs are auto-normalized to `/webhook/modelriver`.

**Test**:
1. Run `modelriver login`
2. Enter URL as `http://localhost:4000` (without path)
3. Check saved config shows `http://localhost:4000/webhook/modelriver`

**Pass Criteria**: ✅ URL is normalized to include `/webhook/modelriver`.

---

## Quick Verification Commands

Run these to quickly verify CLI is working:

```bash
# Check version
modelriver --version

# Check all commands
modelriver --help

# Check login works
modelriver login

# Check forward works (after login)
modelriver forward
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "No API key configured" | Run `modelriver login` first |
| "Failed to forward webhook" | Normal if no local server on port 4000. Webhook was still received! |
| "Invalid API key" | Check if `MODELRIVER_API_KEY` env var is set. Run `unset MODELRIVER_API_KEY` |
