#!/usr/bin/env bash
# macOS: start the agent when you log in. Usage: ./autostart.sh on | off
# Use it with the plugin route; the dev route waits on a screen nobody is there to confirm.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="dev.kage.start"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

case "${1:-}" in
  on)
    mkdir -p "$(dirname "$PLIST")"
    # launchd starts with a bare PATH; give it the one this shell has so node, claude and tmux resolve.
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$DIR/start.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/kage-start.log</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/kage-start.log</string>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "On: starts at login. Log: ~/Library/Logs/kage-start.log" ;;
  off)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Off." ;;
  *) echo "Usage: $0 on | off" >&2; exit 1 ;;
esac
