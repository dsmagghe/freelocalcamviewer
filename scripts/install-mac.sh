#!/usr/bin/env bash
#
# Install FreeLocalCamViewer as a macOS LaunchAgent so it boots with the user
# session and stays running. Re-run with a different port to change it.
#
# Usage:  scripts/install-mac.sh [port]
# Default port: 8088
#
set -euo pipefail

PORT="${1:-8088}"
LABEL="be.openview.freelocalcamviewer"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE_BIN="$(command -v node || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found in PATH. Install Node 18+ first (brew install node)." >&2
  exit 1
fi
if [[ ! -f "$DIR/server.js" ]]; then
  echo "error: server.js not found in $DIR" >&2
  exit 1
fi
mkdir -p "$DIR/data" "$HOME/Library/LaunchAgents"

# launchd doesn't inherit your shell PATH, so anything spawned via Node
# (notably ffmpeg, which RTSP-grab needs) must be findable here.
PATH_VALUE="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${DIR}/server.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>${PORT}</string>
    <key>HOST</key><string>0.0.0.0</string>
    <key>DB_PATH</key><string>${DIR}/data/cameras.db</string>
    <key>PATH</key><string>${PATH_VALUE}</string>
  </dict>
  <key>WorkingDirectory</key><string>${DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DIR}/data/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${DIR}/data/launchd.err.log</string>
</dict>
</plist>
EOF

# Reload if it was previously installed.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo
echo "✓ Installed as LaunchAgent."
echo "  Plist:   $PLIST"
echo "  Port:    $PORT"
echo "  Logs:    $DIR/data/launchd.{out,err}.log"
echo
echo "Open  →  http://localhost:${PORT}"
echo "Stop  →  launchctl unload $PLIST"
echo "Change port  →  scripts/install-mac.sh <new-port>"
echo "Uninstall    →  scripts/uninstall-mac.sh"
