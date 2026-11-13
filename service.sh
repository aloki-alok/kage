#!/usr/bin/env bash
# Lets the OS keep the hub alive: a LaunchAgent on macOS, a systemd user unit on Linux. Both run run.sh at
# login (Linux: at boot, with linger), and both follow one rule: a non-zero exit (a crash, or 75 for a
# self-update) restarts it within 10 s, and exit 0 (kage stop, a second hub) stays down.
# Usage: ./service.sh on | off | start | stop | restart | running | installed | kind
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${KAGE_ENV:-$HOME/.config/kage/env}"
NAME="$(sed -n 's/^KAGE_NAME=//p' "$ENV_FILE" 2>/dev/null | tail -1)"; NAME="${NAME:-kage}"
# Pinned at install, as run.sh reads it: a different folder would forget every thread.
WORK="${KAGE_CWD:-$HOME}"
LABEL="dev.kage.hub.$NAME"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT="kage-$NAME.service"
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT"
GUI="gui/$(id -u)"

kind() {
  case "$(uname -s)" in
    Darwin) echo launchd ;;
    Linux) if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then echo systemd; else echo none; fi ;;
    *) echo none ;;
  esac
}

# launchd starts with a bare PATH, so the one this shell has goes in, for node, claude and tmux.
plist_text() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$DIR/run.sh</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATH</string>
    <key>KAGE_ENV</key><string>$ENV_FILE</string>
    <key>KAGE_CWD</key><string>$WORK</string>
  </dict>
  <key>WorkingDirectory</key><string>$WORK</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(dirname "$ENV_FILE")/service.log</string>
  <key>StandardErrorPath</key><string>$(dirname "$ENV_FILE")/service.log</string>
</dict></plist>
EOF
}

unit_text() {
  cat <<EOF
[Unit]
Description=Kage hub ($NAME)
StartLimitIntervalSec=0

[Service]
ExecStart="$DIR/run.sh"
WorkingDirectory=$WORK
Environment="PATH=$PATH" "KAGE_ENV=$ENV_FILE" "KAGE_CWD=$WORK"
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
}

# The hub that start.sh ran in tmux stops before the service starts: a new hub that finds it answering would exit.
stop_old_tmux() {
  if command -v tmux >/dev/null && tmux has-session -t "=$NAME" 2>/dev/null; then
    tmux kill-session -t "=$NAME" && echo "Stopped the old tmux session $NAME."
  fi
}
# The old login item goes last, after the service is up: when it is what ran start.sh, unloading it ends this script.
remove_old_login_item() {
  local old="$HOME/Library/LaunchAgents/dev.kage.start.plist"
  # Only the login item of this same Kage folder: another checkout on this Mac keeps its own.
  if [[ -f $old ]] && grep -q "$DIR/start.sh" "$old"; then
    launchctl bootout "$GUI/dev.kage.start" 2>/dev/null || true
    rm -f "$old" && echo "Removed the old login item (dev.kage.start)."
  fi
}

on() {
  [[ "$DIR$ENV_FILE$WORK" =~ [\'\"\\\&\<\>] ]] && { echo "Move kage, its env file or KAGE_CWD to a path without quotes, backslashes, & or angle brackets." >&2; exit 1; }
  case "$(kind)" in
    launchd)
      stop_old_tmux
      mkdir -p "$(dirname "$PLIST")"
      plist_text >"$PLIST"
      launchctl bootout "$GUI/$LABEL" 2>/dev/null || true
      launchctl bootstrap "$GUI" "$PLIST"
      echo "On: macOS keeps $NAME running and starts it at login (LaunchAgent $LABEL)."
      remove_old_login_item ;;
    systemd)
      stop_old_tmux
      mkdir -p "$(dirname "$UNIT_FILE")"
      unit_text >"$UNIT_FILE"
      systemctl --user daemon-reload
      systemctl --user enable --now "$UNIT" 2>&1 | grep -v '^Created symlink' || true
      echo "On: systemd keeps $NAME running (user unit $UNIT)."
      [[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" == yes ]] \
        || echo "To start it at boot with no login, run once: sudo loginctl enable-linger $(id -un)" ;;
    *) echo "No launchd or systemd user session here. Run kage run under your own supervisor (Docker needs --init)." >&2; exit 1 ;;
  esac
}

off() {
  case "$(kind)" in
    launchd) launchctl bootout "$GUI/$LABEL" 2>/dev/null || true; rm -f "$PLIST" ;;
    systemd) systemctl --user disable --now "$UNIT" 2>/dev/null || true; rm -f "$UNIT_FILE"; systemctl --user daemon-reload ;;
  esac
  echo "Off: $NAME is stopped and no longer starts by itself."
}

installed() { [[ -f $PLIST || -f $UNIT_FILE ]]; }

running() {
  case "$(kind)" in
    launchd) launchctl print "$GUI/$LABEL" 2>/dev/null | grep -q 'state = running' ;;
    systemd) systemctl --user is-active --quiet "$UNIT" ;;
    *) return 1 ;;
  esac
}

# launchd: stop unloads the job, so it stays down until kage start or the next login.
start() {
  installed || { echo "The service is off. Turn it on: kage service on" >&2; exit 1; }
  case "$(kind)" in
    launchd) launchctl print "$GUI/$LABEL" >/dev/null 2>&1 && launchctl kickstart "$GUI/$LABEL" || launchctl bootstrap "$GUI" "$PLIST" ;;
    systemd) systemctl --user start "$UNIT" ;;
  esac
}
stop() {
  case "$(kind)" in
    launchd) launchctl bootout "$GUI/$LABEL" 2>/dev/null || true ;;
    systemd) systemctl --user stop "$UNIT" ;;
  esac
}
restart() {
  case "$(kind)" in
    launchd) launchctl kickstart -k "$GUI/$LABEL" ;;
    systemd) systemctl --user restart "$UNIT" ;;
  esac
}

# Sourced by the tests, which call plist_text and unit_text.
[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0
case "${1:-}" in
  on|off|start|stop|restart|running|installed|kind) "$1" ;;
  *) echo "Usage: kage service on | off" >&2; exit 2 ;;
esac
