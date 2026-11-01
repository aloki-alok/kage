#!/usr/bin/env bash
# Starts the agent's Claude Code session in a background tmux window named after it, and
# restarts Claude Code if it ever exits.
#   Plugin route (no prompts): kage installed as a plugin and on your org's approved channel list.
#   Dev route (fallback): Claude Code shows a warning screen on each start; confirm it once.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${KAGE_ENV:-$HOME/.config/kage/env}"
[[ -f "$ENV_FILE" ]] || { echo "No $ENV_FILE yet. Run ./setup.sh first." >&2; exit 1; }
[[ "$DIR$ENV_FILE" =~ [\'\"\\] ]] && { echo "Move kage or its env file to a path without quotes or backslashes." >&2; exit 1; }
NAME="$(sed -n 's/^KAGE_NAME=//p' "$ENV_FILE")"; NAME="${NAME:-kage}"

if tmux has-session -t "=$NAME" 2>/dev/null; then   # "=" means exact name, not a prefix
  echo "$NAME is already running. See it: tmux attach -t $NAME   (leave: Ctrl-b then d)"
  exit 0
fi

TOOLS="mcp__kage__reply mcp__plugin_kage_kage__reply"
# The plugin route only works once your org approves the channel, so it is opt-in: KAGE_ROUTE=plugin in the env file.
if [[ "$(sed -n "s/^KAGE_ROUTE=//p" "$ENV_FILE")" == plugin ]]; then
  ROUTE=plugin
  CLAUDE="claude --channels plugin:kage@kage --allowedTools $TOOLS"
else
  ROUTE=dev
  MCP="{\"mcpServers\":{\"kage\":{\"command\":\"$(command -v node)\",\"args\":[\"$DIR/dist/server.js\"]}}}"
  CLAUDE="claude --mcp-config '$MCP' --allowedTools $TOOLS --dangerously-load-development-channels server:kage"
fi
AWAKE=""; command -v caffeinate >/dev/null && AWAKE="caffeinate -i"   # keep a Mac from idling to sleep
# KAGE_SESSION marks the one session allowed to hold the Slack connection (see server.ts).
LOOP="export KAGE_SESSION=1 KAGE_ENV='$ENV_FILE'; while true; do $AWAKE $CLAUDE; echo '$NAME exited, restarting in 5s (Ctrl-c to stop)'; sleep 5; done"
# Starts in your home folder so it has the same reach as a normal session; KAGE_CWD changes that.
tmux new-session -d -s "$NAME" -c "${KAGE_CWD:-$HOME}" "$LOOP"

if [[ $ROUTE == plugin ]]; then
  echo "$NAME is running (plugin route, no prompts). See it: tmux attach -t $NAME"
  exit 0
fi
cat <<EOF
$NAME is starting in tmux (dev route). Claude Code shows a warning screen for custom channels:
  press Enter on "I am using this for local development", then Ctrl-b and then d to leave it running.
To skip that screen for good, see "Start without prompts" in the README.
EOF
sleep 2
if [[ -t 1 && -z "${TMUX:-}" ]]; then tmux attach -t "=$NAME"; else echo "Confirm it with: tmux attach -t $NAME"; fi
