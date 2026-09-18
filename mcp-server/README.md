# My Recorder — MCP server

Lets a local AI **drive the browser directly** through the My Recorder
extension, and pull recordings to refine into skills.

## Architecture (broker model)

A single long-lived **bridge daemon** owns the connection to the browser
extension; each Claude session's MCP server is a thin **client** of the daemon.
This is the same model Claude in Chrome uses (one persistent app the extension
pairs to, shared by every conversation) — so multiple sessions no longer fight
over the extension's port.

```
session A → mcp-server ─┐
session B → mcp-server ─┼─► bridge daemon ──ws://9234──► extension ──► page
session C → mcp-server ─┘   (clients on ws://9235)
```

- **9234** — the daemon's port for the extension (the extension connects here, unchanged).
- **9235** — the daemon's port for MCP-server clients.
- If no daemon is running, the first MCP server **auto-spawns** one (detached) —
  so it works with zero setup. For an always-on daemon, install it at logon or
  as a service (below).

> Caveat: all sessions share one browser, so two driving the same tab at once
> still collide *logically*. Run one active driver at a time.

## Tools exposed

| Tool | What it does |
|------|--------------|
| `browser_navigate` | Open a URL in the active tab |
| `browser_snapshot` | List visible interactive elements, each with a numeric `ref` |
| `browser_click` | Click by `ref` (preferred) or CSS `selector` |
| `browser_type` | Type into an input by `ref`/`selector`, optional `submit` |
| `browser_get_text` | Visible text of the active tab |
| `browser_screenshot` | JPEG screenshot of the viewport |
| `recorder_start` / `recorder_stop` | Control action recording |
| `recorder_get_steps` | Recorded steps (type, label, value, selector, url) → build skills |

Typical loop: `browser_snapshot` → read refs → `browser_click` / `browser_type` → repeat.

## Build

```bash
cd mcp-server
npm install
npm run build      # -> dist/index.js + dist/bridge-daemon.js
```

## Running the daemon (3 levels)

1. **Nothing to do (auto-spawn).** The first MCP server launches the daemon
   detached; it outlives the session. Good enough for most use.
2. **Autostart at logon (no admin)** — recommended for always-on:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
   Start-ScheduledTask -TaskName MyRecorderBridge       # start now, no logoff
   # uninstall: ... install-autostart.ps1 -Uninstall
   ```
3. **True Windows service (needs admin)** via [NSSM](https://nssm.cc):
   ```powershell
   nssm install MyRecorderBridge "C:\Program Files\nodejs\node.exe" "<abs>\mcp-server\dist\bridge-daemon.js"
   nssm start MyRecorderBridge
   ```
   A session-0 service is fine here — the daemon only hosts `localhost`
   sockets, which the browser can reach across sessions.

Run the daemon manually for debugging: `node dist/bridge-daemon.js`

## Register with your AI client

**Claude Code (CLI):**
```bash
claude mcp add my-recorder -- node "C:\\Users\\5207000046\\OneDrive - Sony\\Desktop\\local agent\\my-recorder\\mcp-server\\dist\\index.js"
```

**Claude Desktop / any client using `mcpServers` JSON config:**
```json
{
  "mcpServers": {
    "my-recorder": {
      "command": "node",
      "args": [
        "C:\\Users\\5207000046\\OneDrive - Sony\\Desktop\\local agent\\my-recorder\\mcp-server\\dist\\index.js"
      ]
    }
  }
}
```

The client launches the server over stdio; the server opens `ws://localhost:9234`.
The extension connects to that port automatically (auto-reconnects every 3s).

> Change the port with the `MCP_BRIDGE_PORT` env var — but it must match the
> extension's `BRIDGE_PORT` in `lib/protocol.ts` (rebuild the extension if changed).

## Checklist before use

1. **Build & load the extension** (`npm run build` in the project root → load
   `.output/chrome-mv3`). Reload it after any rebuild.
2. **Reload open tabs** once so the content script attaches.
3. **Register the MCP server** (above) and restart your AI client.
4. Ask your AI to call `browser_snapshot` — if it returns elements, the bridge is live.

### Connection status
- "Browser extension not connected" → the browser/extension isn't running, or
  the port is blocked. Open the browser; the extension reconnects on its own.
