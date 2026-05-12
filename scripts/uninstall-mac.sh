#!/usr/bin/env bash
#
# Stop and remove the FreeLocalCamViewer LaunchAgent.
#
set -euo pipefail
LABEL="be.openview.freelocalcamviewer"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [[ -f "$PLIST" ]]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ Uninstalled. Camera DB and logs in ./data/ are kept."
else
  echo "Not installed (no $PLIST)."
fi
