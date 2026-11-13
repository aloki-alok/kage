#!/usr/bin/env bash
# Lets the OS keep the hub alive: a LaunchAgent on macOS, a systemd user unit on Linux. Both run node on hub.ts
# at login (Linux: at boot, with linger), append its output to hub.log, and follow one rule: a non-zero exit
# (a crash, or 75 for a self-update) restarts it within 10 s, and exit 0 (kage stop, a second hub) stays down.
# Usage: ./service.sh on | off | start | stop | restart | running | installed | kind
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${KAGE_ENV:-$HOME/.config/kage/env}"
NAME="$(sed -n 's/^KAGE_NAME=//p' "$ENV_FILE" 2>/dev/null | tail -1)"; NAME="${NAME:-kage}"
# Pinned at install, as hub.ts reads it: a different folder would forget every thread.
WORK="${KAGE_CWD:-$HOME}"
LABEL="dev.kage.hub.$NAME"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT="kage-$NAME.service"
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT"
GUI="gui/$(id -u)"
LOG="$(dirname "$ENV_FILE")/hub.log"
NODE="$(command -v node || true)"

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
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/hub.ts</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATH</string>
    <key>KAGE_ENV</key><string>$ENV_FILE</string>
    <key>KAGE_CWD</key><string>$WORK</string>
  </dict>
  <key>WorkingDirectory</key><string>$WORK</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
}

# systemd reads % as a specifier, so every % in a path is doubled.
unit_text() {
  local p="${PATH//%/%%}" e="${ENV_FILE//%/%%}" w="${WORK//%/%%}" d="${DIR//%/%%}" n="${NODE//%/%%}" l="${LOG//%/%%}"
  cat <<EOF
[Unit]
Description=Kage hub ($NAME)
StartLimitIntervalSec=0

[Service]
ExecStart="$n" "$d/hub.ts"
WorkingDirectory=$w
Environment="PATH=$p" "KAGE_ENV=$e" "KAGE_CWD=$w"
StandardOutput=append:$l
StandardError=append:$l
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
  [[ "$DIR$ENV_FILE$WORK$PATH$NODE" =~ [\'\"\\\&\<\>] ]] && { echo "Move kage, its env file or KAGE_CWD, and every PATH folder, to paths without quotes, backslashes, & or angle brackets." >&2; exit 1; }
  [[ -n $NODE ]] || { echo "node is not on PATH." >&2; exit 1; }
  # Run from a pane of the old tmux session, stopping that session would end this script before the service starts.
  if [[ -n "${TMUX:-}" && "$(tmux display-message -p '#S' 2>/dev/null)" == "$NAME" ]]; then
    echo "Run this from a terminal outside the tmux session $NAME." >&2; exit 1
  fi
  # Kage runs from its source, so its packages must match package-lock.json. npm stamps node_modules/.package-lock.json on each install.
  (cd "$DIR" && { [[ package-lock.json -ot node_modules/.package-lock.json ]] || npm ci --no-audit --no-fund --loglevel=error; }) \
    || { echo "npm ci failed: run it in $DIR and read the error." >&2; exit 1; }
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
