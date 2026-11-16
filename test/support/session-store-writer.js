// Writes to a ToolSessionStore from its own process, for the concurrency test.
// Usage: node session-store-writer.js <dir> <writer name> <count> <shared key> <start at ms>
const ToolSessionStore = require('../../src/lib/tool-session-store');

const [dir, name, count, sharedKey, startAt] = process.argv.slice(2);
const store = new ToolSessionStore({ dir, lockTimeoutMs: 20000 });

// Start together, so the writers overlap.
while (Date.now() < Number(startAt)) { /* wait */ }

const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
for (let i = 0; i < Number(count); i += 1) {
  store.save(`${name}-${i}`, {
    session_id: `cts_${name}_${i}_0123456789abcdef`,
    channel: `cli_tools:${name}-${i}`,
    expires_at: expires,
  });
  store.addForwarded(sharedKey, `call_${name}_${i}`);
}
