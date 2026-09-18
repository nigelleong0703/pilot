// Standalone bridge connectivity check — proves the extension can reach the
// MCP server's WebSocket without needing a full AI/MCP client.
//
//   node scripts/bridge-check.mjs
//
// It hosts ws://localhost:9234 (same as the real server), waits for the
// extension to connect, then sends a read-only `snapshot` command against the
// active tab and prints the result.
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.MCP_BRIDGE_PORT ?? 9234);
const wss = new WebSocketServer({ port: PORT });

console.log(`[check] hosting ws://localhost:${PORT} — waiting for the extension…`);
console.log('[check] (reload the My Recorder extension and have a normal web page active)');

const WAIT_MS = Number(process.env.CONN_TIMEOUT_MS ?? 25_000);
const timeout = setTimeout(() => {
  console.error(`[check] ❌ no extension connected within ${WAIT_MS / 1000}s.`);
  console.error('        Make sure the extension is reloaded and the browser is open.');
  process.exit(1);
}, WAIT_MS);

wss.on('connection', (ws) => {
  clearTimeout(timeout);
  console.log('[check] ✅ extension connected!');

  const id = randomUUID();
  const cmdTimer = setTimeout(() => {
    console.error('[check] ⚠️  no response to snapshot in 8s (is a normal page active?)');
    process.exit(1);
  }, 8_000);

  ws.on('message', (data) => {
    let res;
    try { res = JSON.parse(data.toString()); } catch { return; }
    // The extension also pushes diagnostic/ACP frames over the same socket
    // (`acp/log`, `acp/*`); only the reply with our request id is the answer.
    if (res.id !== id) return;

    clearTimeout(cmdTimer);
    if (!res.ok) {
      console.error('[check] ⚠️  snapshot error:', res.error);
    } else {
      const nodes = res.result?.nodes ?? [];
      console.log(`[check] ✅ snapshot ok — ${res.result?.title ?? ''}`);
      console.log(`[check]    ${nodes.length} interactive elements on ${res.result?.url ?? ''}`);
      for (const n of nodes.slice(0, 8)) {
        console.log(`[check]      #${n.ref} ${n.role} "${n.label}"`);
      }
    }
    console.log('[check] done — full chain (extension ↔ bridge ↔ page) works.');
    process.exit(0);
  });

  // Give the content script a beat, then ask for a snapshot.
  setTimeout(() => ws.send(JSON.stringify({ id, method: 'snapshot', params: {} })), 600);
});

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[check] ❌ port ${PORT} is already in use — another bridge/server is running.`);
  } else {
    console.error('[check] server error:', err.message);
  }
  process.exit(1);
});
