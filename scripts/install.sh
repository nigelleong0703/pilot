#!/usr/bin/env bash
# Easy install: download the latest Pilot extension build from GitHub Releases
# and unpack it where you can "Load unpacked" in Chrome/Edge.
#
#   curl -fsSL https://raw.githubusercontent.com/nigelleong0703/pilot/main/scripts/install.sh | bash
#
# Env: PILOT_HOME (default: ~/.pilot/app)
set -euo pipefail

REPO="nigelleong0703/pilot"
DEST="${PILOT_HOME:-$HOME/.pilot/app}"
OUT="$DEST/chrome-mv3"

echo "→ Finding the latest Pilot release…"
URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -o '"browser_download_url": *"[^"]*chrome\.zip"' \
  | head -1 | cut -d '"' -f4 || true)

if [ -z "${URL:-}" ]; then
  echo "✗ No release .zip found. Download one manually from:"
  echo "  https://github.com/$REPO/releases"
  exit 1
fi

mkdir -p "$OUT"
echo "→ Downloading $URL"
curl -fL "$URL" -o "$DEST/pilot.zip"
rm -rf "$OUT" && mkdir -p "$OUT"
echo "→ Unpacking to $OUT"
unzip -oq "$DEST/pilot.zip" -d "$OUT"

echo
echo "✅ Extension ready: $OUT"
echo
echo "Next:"
echo "  1) Open  chrome://extensions  (or edge://extensions)"
echo "  2) Turn on 'Developer mode' (top-right)"
echo "  3) Click 'Load unpacked' and select:"
echo "       $OUT"
echo
echo "  4) Install the agent bridge (MCP server):"
echo "       npm install -g https://github.com/$REPO/releases/latest/download/pilot-mcp-1.0.0.tgz"
echo "     then register it with your agent (PILOT_EXTENSION_PATH lets Pilot"
echo "     auto-launch a browser), e.g.:"
echo "       codex mcp add pilot --env PILOT_EXTENSION_PATH=$OUT -- pilot-mcp"
