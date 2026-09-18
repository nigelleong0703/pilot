# Browser Extension

A Chrome/Edge MV3 extension that lets your local AI (Claude) drive the browser directly, and records your actions as reusable skill steps.

---

## How it works

```
Claude (AI) ──stdio──► MCP server ──ws:9235──► Bridge daemon ──ws:9234──► Extension ──► Page
```

- **Extension** — loads in Edge/Chrome, holds the WebSocket to the daemon, injects content scripts, captures screenshots
- **Bridge daemon** — one long-lived Node.js process that brokers between the extension and any number of Claude sessions
- **MCP server** — thin stdio process Claude launches per session; auto-spawns the daemon if it isn't running

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 18 or later |
| Edge or Chrome | 109 or later |
| Claude Code CLI | any recent version |

---

## 1. Install the browser extension

1. Open **`edge://extensions`** (or `chrome://extensions`)
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select this folder:
   ```
   browser-extension\.output\chrome-mv3
   ```
5. The extension card should appear as **"Browser Extension"**

> After any rebuild, click **Reload** on the extension card to pick up changes.

---

## 2. Set up the MCP server

```bash
cd mcp-server
npm install
npm run build
```

This compiles `src/index.ts` and `src/bridge-daemon.ts` into `dist/`.

---

## 3. Register with Claude CLI

Run this once — it adds the server to your user-level config so every project can use it:

```bash
claude mcp add browser-extension --scope user -- node "FULL_PATH\browser-extension\mcp-server\dist\index.js"
```

Replace `FULL_PATH` with the actual absolute path. Example for this install:

```bash
claude mcp add browser-extension --scope user -- node "C:\Users\5207000046\OneDrive - Sony\Desktop\local agent\browser-extension\mcp-server\dist\index.js"
```

Verify:

```bash
claude mcp list
# browser-extension: ... ✓ Connected
```

---

## 4. (Optional) Name your session

Each Claude session gets its own browser tab group labeled `s-xxxxxx` by default. To give it a meaningful name, add `MCP_SESSION_LABEL` to the server registration in `~/.claude.json`:

```json
"browser-extension": {
  "command": "node",
  "args": ["C:\\...\\mcp-server\\dist\\index.js"],
  "env": {
    "MCP_SESSION_LABEL": "work"
  }
}
```

The tab group in Edge will then show **Browser Extension · work**.

---

## 5. (Optional) Auto-start the daemon on login

```powershell
cd mcp-server
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

Registers a Windows Task Scheduler entry (no admin required) so the daemon is ready before you open Claude.

---

## MCP tools reference

### Browser control

| Tool | Description |
|---|---|
| `browser_navigate` | Navigate to a URL |
| `browser_snapshot` | List all interactive elements with numbered refs |
| `browser_click` | Click an element by ref or CSS selector |
| `browser_type` | Type text into an input by ref or CSS selector |
| `browser_get_text` | Get the full visible text of the page |
| `browser_screenshot` | Capture a JPEG screenshot of the viewport |

**Typical flow:**
```
browser_navigate → browser_snapshot → browser_click / browser_type → browser_screenshot
```

### Recorder control

| Tool | Description |
|---|---|
| `recorder_start` | Begin recording user actions (clears any previous recording) |
| `recorder_stop` | Stop recording |
| `recorder_get_steps` | Return recorded steps as JSON (use to build skills) |

---

## Side panel UI

Click the **Browser Extension** toolbar icon to open the side panel.

| Indicator | Meaning |
|---|---|
| ⦿ **MCP connected** (green) | Daemon running, extension connected |
| ⦿ **offline** (grey) | Daemon not running or extension not loaded |
| **idle** | Not recording |
| **recording** (red dot) | Recording is active |

Buttons: **Start** · **Stop** · **Clear** · **Export JSON**

---

## Architecture

### Ports

| Port | Purpose |
|---|---|
| 9234 | Daemon ↔ Extension WebSocket |
| 9235 | Daemon ↔ MCP servers WebSocket |

### Multi-session isolation

Each Claude session gets a fresh browser tab in its own colored **tab group** in the tab strip (`Browser Extension · <label>`). Multiple Claude windows never share a tab.

### Connection stability

- Background service worker holds the WebSocket to the daemon
- Offscreen document (`offscreen.html`) keeps the extension process alive
- `chrome.alarms` fires every 30 s as a secondary keepalive
- Auto-reconnects every 3 s on disconnect
- First MCP session auto-spawns the daemon if it's not running

---

## Agent Chat (ACP) — chat in the side panel, drive the page

The side panel now has a **Chat** tab. It is an [ACP](https://agentclientprotocol.com)
front end: you chat with Claude directly in the browser, and the agent drives the
current tab through the same `browser_*` tools. The daemon runs the agent as a
subprocess and hands it the browser MCP.

```
side panel (Chat) --acp/*--> daemon --stdio--> claude-code-acp --> Claude
                               |                      |
                               |                      +--MCP--> index.js --> extension --> page
                               +--commands--> extension --> page
```

### Prerequisites

Nothing extra to install — the ACP agent (`@zed-industries/claude-code-acp`) is a
**bundled dependency** of `mcp-server`, so a normal `npm install` in that folder
pulls it in. The daemon runs it via `node` (no global install, no PATH entry).

- **Auth:** it uses your **existing Claude Code login** — if you already use Claude
  Code you're set, no separate `claude /login` needed. (Only the isolated-config-dir
  option below needs its own one-time login.)
- **Git Bash** must be installed (the agent requires it on Windows). The daemon
  auto-detects `bash.exe`; override with `CLAUDE_CODE_GIT_BASH_PATH` if needed.
- The daemon must **not** run inside another Claude Code session (it unsets
  `CLAUDECODE` for the agent automatically; just don't launch it from `claude`).
- To use a different ACP agent instead of the bundled one, set `ACP_AGENT_CMD`.

### Using it

1. Rebuild and reload (see below), open the side panel, pick the **Chat** tab.
2. Type a message — the first one starts a session. The agent can navigate,
   snapshot, click, type, and screenshot the active tab.
3. Tool calls that need approval show an **Allow / Reject** prompt.
4. Conversations are saved per session under `~/.browser-extension-agent/sessions/`
   and are listed in the **History…** dropdown.

### Recorder → skill

On the **Recorder** tab, record some actions, then press **Make skill**. The steps
are handed to the chat agent, which authors a reusable, parameterized skill.

### Tool isolation (optional but recommended)

`claude-code-acp` inherits your *global* Claude Code MCP servers (e.g. playwright,
terminator), so the agent may reach for those instead of this extension's browser
tools. To give it **only** the extension's browser MCP, point it at a dedicated
config dir and log in there once:

```bash
# one-time: create + authenticate an isolated config dir
set CLAUDE_CONFIG_DIR=%USERPROFILE%\.browser-extension-agent\claude-cfg
claude /login

# then run the daemon with:
set ACP_CLAUDE_CONFIG_DIR=%USERPROFILE%\.browser-extension-agent\claude-cfg
```

Without this, chat still works — the agent just has your other MCP tools available too.

### Environment knobs

| Var | Purpose |
|---|---|
| `ACP_AGENT_CMD` | Agent binary (default `claude-code-acp[.cmd]`) — swap for another ACP agent |
| `ACP_CLAUDE_CONFIG_DIR` | Isolated config dir so only the browser MCP loads |
| `CLAUDE_CODE_GIT_BASH_PATH` | Explicit path to `bash.exe` if auto-detect fails |

---

## Troubleshooting

**Side panel shows "offline"**
1. Confirm the extension is enabled in `edge://extensions`
2. Open any web page (wakes the service worker)
3. Wait ~5 s for auto-reconnect, or click Reload on the extension card

**"Bridge not ready yet" in Claude**
The daemon is still starting. Retry after 2–3 s. To start it manually:
```bash
node "mcp-server\dist\bridge-daemon.js"
```

**Snapshot / click fails with "Receiving end does not exist"**
The page navigated and tore down the content script. The extension auto-reinjects it — retry the tool call once.

**Extension won't load on Sony-managed Edge**
Developer mode may be blocked by policy. Ask IT to set:
```
HKLM\SOFTWARE\Policies\Microsoft\Edge\DeveloperToolsAvailability = 1
```

---

## Rebuilding after code changes

```bash
# In browser-extension/ root — rebuilds the extension
npm run build

# In mcp-server/ — rebuilds the Node.js server
npm run build

# Then reload the extension in edge://extensions
```
