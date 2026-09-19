#!/usr/bin/env bash
# One-command install for Pilot:
#   1. download the latest extension build and unpack it for "Load unpacked"
#   2. install the MCP server (`pilot-mcp`) globally
#   3. register it with every agent detected on the machine (codex/claude/opencode)
#
#   curl -fsSL https://raw.githubusercontent.com/nigelleong0703/pilot/main/scripts/install.sh | bash
#
# Env: PILOT_HOME (default: ~/.pilot/app)
set -euo pipefail

REPO="nigelleong0703/pilot"
DEST="${PILOT_HOME:-$HOME/.pilot/app}"
OUT="$DEST/chrome-mv3"

echo "→ Fetching the latest Pilot release…"
JSON=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")
ZIP_URL=$(printf '%s' "$JSON" | grep -o '"browser_download_url": *"[^"]*chrome\.zip"' | head -1 | cut -d '"' -f4 || true)
TGZ_URL=$(printf '%s' "$JSON" | grep -o '"browser_download_url": *"[^"]*pilot-mcp-[^"]*\.tgz"' | head -1 | cut -d '"' -f4 || true)

if [ -z "${ZIP_URL:-}" ]; then
  echo "✗ No extension .zip found in the latest release: https://github.com/$REPO/releases"
  exit 1
fi

# 1. Extension -----------------------------------------------------------------
mkdir -p "$DEST"
echo "→ Extension: $ZIP_URL"
curl -fL "$ZIP_URL" -o "$DEST/pilot.zip"
rm -rf "$OUT" && mkdir -p "$OUT"
unzip -oq "$DEST/pilot.zip" -d "$OUT"
echo "  unpacked → $OUT"

# 2. MCP server ----------------------------------------------------------------
if [ -n "${TGZ_URL:-}" ] && command -v npm >/dev/null 2>&1; then
  echo "→ Installing the MCP server (pilot-mcp)…"
  if npm install -g "$TGZ_URL" >/dev/null 2>&1; then
    echo "  installed"
  else
    echo "  ⚠ failed — install manually:  npm install -g $TGZ_URL"
  fi
fi

# 3. Register with detected agents ---------------------------------------------
register() {
  local label="$1" cmd="$2"
  command -v "$cmd" >/dev/null 2>&1 || return 0
  echo "→ Registering with $label…"
  case "$cmd" in
    codex)    "$cmd" mcp add pilot --env PILOT_EXTENSION_PATH="$OUT" -- pilot-mcp >/dev/null 2>&1 || true ;;
    claude)   "$cmd" mcp add pilot --scope user --env PILOT_EXTENSION_PATH="$OUT" -- pilot-mcp >/dev/null 2>&1 || true ;;
    opencode) "$cmd" mcp add pilot --env PILOT_EXTENSION_PATH="$OUT" -- pilot-mcp >/dev/null 2>&1 || true ;;
  esac
  echo "  done — restart $label to load the browser tools"
}
register "Codex" codex
register "Claude Code" claude
register "OpenCode" opencode

echo
echo "✅ Installed."
echo "   Extension: $OUT"
echo "   Load it: chrome://extensions → Developer mode → Load unpacked → $OUT"
