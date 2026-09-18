# Pilot — Next Steps

_Snapshot of where the browser extension ("Pilot") stands and what to build next._
_Date: 2026-08-20_

---

## ✅ Done & working

- **Agent chat in the side panel** (assistant-ui base) driving the page, powered by an
  **ACP agent** (`claude-code-acp`) run by the daemon. Streaming is **text-only** (stable).
- **Renamed** everything to **Pilot**.
- **Acts on your current tab** (not a sandbox tab); each turn is prefixed with the page URL+title,
  and the tab is **pinned for the turn** so switching tabs mid-task can't misfire.
- **Recorder → skill**: record actions → agent authors a skill → **auto-exported to every AI agent
  installed on the machine** (Claude Code `~/.claude/skills`, Codex `~/.codex/prompts`, pi `~/.pi/skills`).
- **`+` menu**: fire a saved/agent-native skill, **upload image**, **upload document**.
- **Agent registry + picker** (Claude / Gemini / Codex / pi / Custom), persisted to `chrome.storage`.
- **Model picker + thinking toggle** in Settings.
- **CDP page control** (native accessibility tree + input events) with automatic **DOM fallback**.
- **Connection rearchitecture (the big fix):** the WebSocket now lives in the **offscreen document**,
  not the service worker. The SW only executes CDP/DOM commands on demand. **Verified:** the
  connection survives the SW's 30s idle death, and commands still run (SW wakes on demand). This
  killed the whole class of freezes/crashes.
- **Daemon** auto-starts (Startup-folder launcher, since Task Scheduler is blocked by org policy)
  and logs to `~/.pilot/daemon.log`.

---

## 🔑 Decisions to lock first

1. **Page perception mode (the debugger banner).**
   Verified: CDP (`chrome.debugger`) is what shows the *"Pilot is debugging this browser"* banner.
   Claude for Chrome has the `debugger` permission too, but for ordinary page reads it **doesn't
   attach** — it uses a **screenshot (`captureVisibleTab`) + content script**, so no banner.
   → **Proposed default: DOM + screenshot (no banner, Claude-like). CDP stays opt-in.**
2. **Tab grouping.** Claude groups its tabs under a colored **"Claude"** group (`tabGroups` permission).
   Pilot currently doesn't. → **Group-on-use** (put the driven tab in a "Pilot" group) **or** a
   **dedicated Pilot tab**? _Pick one._
3. **Composer layout.** Match Claude's inline **model · effort** control (e.g. "Opus 4.6 · Medium")
   vs. keeping model/effort in Settings.

---

## 🛠️ Next tasks (proposed order)

### 1. Match Claude's page perception (no banner)
- Make **DOM the default** page mode (background + settings agree).
- Add **screenshot "seeing"**: capture `captureVisibleTab` and send it to the model as an image
  (Claude's "Capturing page") so it perceives visually, not just as an element list.
- Keep **CDP as an explicit opt-in** (banner is expected there).

### 2. Tab grouping (match Claude)
- Re-add the **`tabGroups`** permission.
- **Group-on-use**: when Pilot acts, place the tab in a colored **"Pilot"** group; leave/clean up
  when done. (Or dedicated-tab mode, per decision #2.)

### 3. Composer redesign (match Claude)
- **Inline model + reasoning-effort** dropdown in the composer bar ("Opus 4.6 · Medium").
- Header controls: **history (past chats)**, **new chat**, **⋮ menu**.
- Reasoning effort as **Low / Medium / High** (map to thinking-token budget), replacing the on/off toggle.

### 4. Tighten tool isolation
- Stop the agent's extra **`ToolSearch`** step — refine `allowedTools` / how the browser MCP is
  exposed so the browser tools are used directly.

### 5. Verify other agents actually drive the page
- Confirm **Codex / Gemini / pi** adapters support **client MCP servers in `session/new`**
  (required for them to use Pilot's `browser_*` tools). Wire the exact launch commands per agent.

### 6. Skills polish
- Parameterized inputs when firing a skill (prompt for variables, or ACP **elicitation** forms).
- Small skills-manager view (rename / delete / see exports).

---

## ⚠️ Known caveats
- **Reloads must fully take** — use *Remove + Load unpacked* if a plain Reload seems stale.
- **Non-Claude agents** need their own login/PATH and MCP-in-session support to drive the page.
- CDP can't attach to `edge://` / store pages (fine — those aren't real web pages).
