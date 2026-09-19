# Pilot — MCP server & bridge daemon

Lets a local AI agent **drive the browser** through the Pilot extension, and
replay recorded skills. This package is the Node side of Pilot: a thin stdio
**MCP server** plus a long-lived **bridge daemon**.

## Architecture (broker model)

One long-lived **bridge daemon** owns the connection to the extension. Every
agent session's **MCP server** is a thin client of that daemon — the same model
Claude in Chrome uses, so sessions don't fight over the extension port.

```
agent A → mcp-server ─┐
agent B → mcp-server ─┼─► bridge daemon ──ws://9234──► extension ──► page
agent C → mcp-server ─┘   (clients on ws://9235)
```

- **9234** — daemon ⇄ extension (the extension connects here; auto-reconnects).
- **9235** — daemon ⇄ MCP-server clients.
- If no daemon is running, the first MCP server **auto-spawns** one (detached).

> All sessions share one browser; don't drive the same tab from two agents at once.

## Install

```bash
npm install -g @nigelleong0703/pilot-mcp     # published package
# or from source:  cd mcp-server && npm install && npm run build
```

## Register with your agent

```bash
codex    mcp add pilot --env PILOT_EXTENSION_PATH="$HOME/.pilot/app/chrome-mv3" -- pilot-mcp
claude   mcp add pilot --scope user --env PILOT_EXTENSION_PATH="$HOME/.pilot/app/chrome-mv3" -- pilot-mcp
opencode mcp add pilot --env PILOT_EXTENSION_PATH="$HOME/.pilot/app/chrome-mv3" -- pilot-mcp
```

`PILOT_EXTENSION_PATH` lets the daemon **auto-launch a browser** with the
extension when none is open. (Skip it if the extension is already installed in
your normal browser.)

## Tools

**Browser control**

| Tool | Notes |
|---|---|
| `browser_list_tabs` | Tabs in the "Pilot" group + your active tab |
| `browser_new_tab` | Open a URL in a new Pilot tab (only for genuine multi-tab work) |
| `browser_navigate` | Navigate the Pilot workspace tab |
| `browser_snapshot` | Interactive elements with numeric `ref`s |
| `browser_click` | By `ref`, CSS `selector`, or visible `text` (all frames) |
| `browser_type` | By `ref`/`selector`/field `match`, optional `submit` |
| `browser_select_option` | Choose an option in a `<select>` |
| `browser_get_text` | Visible text across every frame (incl. cross-origin iframes) |
| `browser_screenshot` | Viewport shot; `grid:true` overlays a labelled 100px coordinate grid |

**Coordinate / keyboard fallback** (when the DOM & a11y tree can't identify an element):

| Tool | Notes |
|---|---|
| `browser_click_at` | Click at viewport pixel `{x,y}` (native CDP input) |
| `browser_type_text` | Insert text into the focused element |
| `browser_key` | Press Enter / Tab / Escape / arrows / PageUp·Down / Home / End / Space |
| `browser_scroll` | Mouse-wheel scroll `{dy,dx,x,y}` |

Typical fallback: `browser_screenshot({grid:true})` → read coordinates →
`browser_click_at` → `browser_type_text` / `browser_key`.

**Skills**

| Tool | Notes |
|---|---|
| `save_skill` | Persist a skill and auto-export it to every installed agent |
| `list_skills` | List saved skills (`deterministic:true` when it has replay actions) |
| `get_skill` | Read a skill in full (steps, actions with `why`/`live`, version, changelog) |
| `update_skill` | Refine a skill and re-export it everywhere (bumps the version) |
| `browser_run_skill` | Replay a saved skill in one call; pauses before `live` steps |

**Recorder:** `recorder_start`, `recorder_stop`, `recorder_get_steps`.

## Configuration (environment)

| Var | Purpose |
|---|---|
| `MCP_BRIDGE_PORT` / `MCP_BRIDGE_CLIENT_PORT` | Override 9234 / 9235 |
| `PILOT_EXTENSION_PATH` | Extension folder for auto-launch |
| `PILOT_BROWSER_BIN` | Browser executable to launch (auto-detected otherwise) |
| `PILOT_BROWSER_HEADLESS=1` | Launch the auto-started browser headless |
| `PILOT_NO_AUTOLAUNCH=1` | Disable auto-launch |
| `PILOT_AGENT_CWD` | Neutral working dir for the ACP agent (default `~/.pilot/cwd`) |
| `ACP_<AGENT>_CMD` / `ACP_<AGENT>_ARGS` | Override an agent's binary / args |

## Running the daemon

```bash
node dist/bridge-daemon.js      # usually unnecessary — auto-spawned
```

Start it at login:

- **macOS** — add a `launchd` LaunchAgent pointing at `node <abs>/dist/bridge-daemon.js`.
- **Linux** — `scripts/install-autostart.ps1` is Windows-only; use a systemd `--user` unit.
- **Windows** — `powershell -File scripts\install-autostart.ps1` (Task Scheduler, no admin),
  or a Windows service via [NSSM](https://nssm.cc).

Logs: `~/.pilot/daemon.log`.

## Data

- Skills: `~/.pilot/skills/` (with `.versions/` archives)
- Chat transcripts: `~/.browser-extension-agent/sessions/`
- Daemon log: `~/.pilot/daemon.log`

See the root [README](../README.md) for the full picture.
