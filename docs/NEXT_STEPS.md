# Pilot — Next Steps

_Snapshot of where the browser extension ("Pilot") stands and what to build next._
_Updated: 2026-08-21 (all previously-proposed next tasks implemented; agents + BYO expanded)_

---

## ✅ Done & working

- **Agent chat in the side panel** (assistant-ui base) driving the page, powered by an
  **ACP agent** (`claude-code-acp`) run by the daemon. Streaming is **text-only** (stable).
- **Renamed** everything to **Pilot**.
- **Acts on your current tab** (not a sandbox tab); each turn is prefixed with the page URL+title,
  and the tab is **pinned + grouped for the turn** so switching tabs mid-task can't misfire.
- **Recorder → skill**: record actions → agent authors a skill → **auto-exported to every AI agent
  installed on the machine** (Claude Code `~/.claude/skills`, Codex `~/.codex/prompts`, pi `~/.pi/skills`).
- **`+` menu**: fire a saved/agent-native skill (with **parameter prompts** for declared inputs),
  **upload image**, **upload document**.
- **Agent registry + picker** (Claude / Gemini / Codex / pi / OpenCode / Qwen / Kimi / Grok / Custom),
  persisted to `chrome.storage`. The custom slot runs any ACP harness via its command + args.
- **Bring-your-own-model** (Settings): provider + model + API key + optional base URL, injected into the
  chosen agent as its standard provider env vars (and `--provider`/`--model` flags for pi/qwen, `--model`
  for opencode). Works with Pi, OpenCode, Qwen, Kimi, Claude (`ANTHROPIC_API_KEY`+`ANTHROPIC_BASE_URL`),
  Gemini (`GEMINI_API_KEY`). Key stored in `chrome.storage` (not encrypted).
- **Composer redesign**: inline **model · reasoning-effort** control ("Sonnet · Medium") in the
  composer bar; **History** (past chats, view transcript + Continue), **New chat**, and a **⋮ menu**
  (Skills / Settings) in the header. Effort = Low/Medium/High → 2k/4k/8k thinking tokens.
- **Skills manager** (⋮ → Skills): list saved skills, **rename / delete** (removes exported copies).
- **Page perception (Claude-like)**: **CDP is the default** (native accessibility tree + debugger banner,
  like Claude in Chrome), with automatic **DOM fallback** when the debugger can't attach. In DOM mode each
  turn also sends a **viewport screenshot** ("capturing page") so the model sees the page visually.
- **Tab grouping (persistent per-session)**: the driven tab lives in a colored **"Pilot"** group for the
  whole chat session (Claude-style); a new chat clears it. Users can drag more tabs in and the agent works
  across them (`browser_list_tabs` + `tabId` targeting on every browser tool).
- **Multi-tab workflows**: `browser_list_tabs` returns the Pilot group's tabs; `navigate`/`snapshot`/
  `click`/`type`/`selectOption`/`get_text`/`screenshot` all accept an optional `tabId`.
- **Tool isolation**: Claude sessions get `tools: []` (all built-in Bash/Edit/TodoWrite/WebSearch/…
  tools removed, so only the `browser` MCP tools exist) + `allowedTools: ['mcp__browser']` — the same
  "curated browser-only toolset" shape Claude in Chrome uses. `disallowedTools` alone isn't relied on
  (claude-agent-acp silently overwrites it — #294/#334). Codex ignores `_meta.systemPrompt`, so its
  Pilot instructions go through `CODEX_CONFIG.developer_instructions` (the ai-sdk harness channel).
  The extra `ToolSearch` step is gone.
- **CDP page control** (native accessibility tree + input events) with automatic **DOM fallback**.
- **Connection rearchitecture (the big fix):** the WebSocket now lives in the **offscreen document**,
  not the service worker. Verified: the connection survives the SW's 30s idle death.
- **Daemon** auto-starts (Startup-folder launcher) and logs to `~/.pilot/daemon.log`.

---

## 🔎 Agent MCP verification (done 2026-08-21)

| Agent | Client MCP in `session/new`? | Notes |
|---|---|---|
| Claude (`claude-code-acp`) | ✅ | Bundled adapter; stdio. Used everywhere. |
| Gemini (`gemini --experimental-acp`) | ✅ | Accepts stdio MCP servers in `session/new`/`session/load` (also HTTP/SSE since Dec 2025). `--acp` is the newer flag. |
| Codex (`npx --yes @agentclientprotocol/codex-acp`) | ✅ | Supports client stdio + HTTP MCP in `session/new`. Now launched via `npx` so it works without a global install. |
| pi (`pi-acp`) | ⚠️ **No** | pi-acp accepts `mcpServers` but does **not** wire them through to pi (pi has no native MCP); some builds *reject* non-empty `mcpServers`. Fix: `pi-acp` now launches **without** the browser MCP. To give pi the page tools, install the community `pi-mcp-adapter` extension (`pi install npm:pi-mcp-adapter`) and configure the MCP server there. |
| OpenCode (`opencode acp`) | ✅ (likely) | Ships ACP itself + MCP-native; expected to accept client MCP. **Not yet live-verified.** |
| Qwen (`qwen --acp`) | ✅ (likely) | Alibaba; ships ACP itself. **Not yet live-verified.** |
| Kimi (`kimi acp`) | ✅ (likely) | Moonshot; ships ACP itself. **Not yet live-verified.** |
| Grok (`grok agent stdio`) | ✅ (likely) | xAI; ships ACP itself. **Not yet live-verified.** |

> New agents (OpenCode/Qwen/Kimi/Grok) are registered with `mcp: true` but unverified — if an adapter
> rejects client MCP servers, flip its `mcp` flag to `false` (it'll still chat, just without page tools).

---

## ⚠️ Known caveats

- **Reloads must fully take** — use *Remove + Load unpacked* if a plain Reload seems stale.
- **pi** can't drive the page until the `pi-mcp-adapter` extension is installed (see above).
- **CDP** can't attach to `edge://` / store pages (fine — those aren't real web pages).
- **Continue a chat** resumes the agent's context but the side panel shows a fresh thread (transcript
  is viewable in History first).
- **On the debugger banner:** research (2026-08-21) confirms Claude in Chrome holds the `debugger`
  permission and *does* show its banner while automating. We now **match that**: **CDP is the default**
  page mode (banner shown), with DOM as the opt-in banner-free mode.

---

## 🛠️ Backlog / ideas (not yet done)

- Dedicated **"Pilot tab"** mode (the other half of decision #2) — currently group-on-use only.
- **Elicitation forms** (ACP native) instead of `window.prompt` when firing parameterized skills.
- Surfacing agent **reasoning/thoughts** in the UI as a collapsible block (effort is wired; rendering isn't).
- Skipping the **auto-screenshot** for image-heavy workflows (already a Settings toggle).