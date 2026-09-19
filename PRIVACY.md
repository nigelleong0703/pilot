# Privacy Policy — Pilot

_Last updated: 2026-09-19_

Pilot is a local developer tool. **The developer does not collect, store, or
transmit any of your data.** There is no analytics, no telemetry, and no remote
server operated by the project.

## What runs where

- **The extension** runs in your browser. It reads the page you ask the agent to
  act on (accessibility tree and/or DOM) and sends input events — all locally.
- **The bridge daemon / MCP server** run on your own machine. They broker between
  the browser and the AI agent you choose. They talk to `localhost` only.
- **The AI agent** is a program you install and configure (e.g. Claude Code, Codex,
  OpenCode). Page content and your prompts are sent **only to that agent and its
  model provider**, under your own account and their terms — not to the Pilot
  project.

## What is stored on your machine

- Skills: `~/.pilot/skills/`
- Chat transcripts: `~/.browser-extension-agent/sessions/`
- Daemon log: `~/.pilot/daemon.log`
- Extension settings (including any API key you enter) are stored in the browser's
  `chrome.storage.local`. Keys are **not encrypted** — do not use keys you cannot
  revoke.

You can delete any of these at any time. Removing the extension and the `~/.pilot`
and `~/.browser-extension-agent` folders removes all Pilot data.

## Network connections

- The extension connects only to `ws://localhost:9234` (its local daemon).
- The daemon connects to `localhost` and launches the AI agent you configured; any
  outbound network traffic is the agent's, to the provider you chose.
- Speech-to-text (the mic button) uses the browser's built-in Web Speech API, which
  may send audio to your browser vendor's speech service. No audio is stored by
  Pilot.

## Permissions

- **debugger** — reads the accessibility tree and sends native input via the Chrome
  DevTools Protocol. Equivalent to `DOM` mode, which is available in Settings and
  does not use the debugger.
- **host permissions (`<all_urls>`)** — required to operate on whatever page you
  point the agent at.
- **tabs / tabGroups / scripting / offscreen / storage / sidePanel / alarms** — used
  to group the tab Pilot drives, inject the overlay/content script, hold the local
  WebSocket in an offscreen document, and store settings.

## Contact

Questions or issues: <https://github.com/nigelleong0703/pilot/issues>
