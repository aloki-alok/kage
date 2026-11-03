#!/usr/bin/env bash
# Starts the agent in a background tmux session named after it: the router (restarted if it
# exits), which runs one Agent SDK session per Slack thread, with no prompts.
# KAGE_RUNTIME=tmux opens a Claude Code pane per thread instead, on one of two routes:
#   Plugin route (no prompts): kage installed as a plugin and on your org's approved channel list.
#   Dev route: Claude Code shows a warning screen in each pane; a person confirms it.
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

TOOLS=""
for t in reply edit_message delete_message schedule unschedule schedules; do TOOLS="$TOOLS mcp__kage__$t mcp__plugin_kage_kage__$t"; done
# Kage keeps its own memory (core/guards.ts memoryDirs reads the same default).
MEM="$(sed -n 's/^KAGE_MEMORY=//p' "$ENV_FILE")"; MEM="${MEM:-$(dirname "$ENV_FILE")/memory}"
[[ "$MEM" =~ [\'\"\\] ]] && { echo "Move KAGE_MEMORY to a path without quotes or backslashes." >&2; exit 1; }
mkdir -p "$MEM"
TOOLS="$TOOLS --disallowedTools CronCreate CronDelete CronList --settings '{\"autoMemoryDirectory\":\"$MEM\"}'"   # rides on TOOLS so both routes get it
# The plugin route only works once your org approves the channel, so it is opt-in: KAGE_ROUTE=plugin in the env file.
if [[ "$(sed -n "s/^KAGE_ROUTE=//p" "$ENV_FILE")" == plugin ]]; then
  ROUTE=plugin
  CLAUDE="claude --channels plugin:kage@kage --allowedTools $TOOLS"
else
  ROUTE=dev
  MCP="{\"mcpServers\":{\"kage\":{\"command\":\"$(command -v node)\",\"args\":[\"$DIR/dist/server.js\"]}}}"
  CLAUDE="claude --mcp-config '$MCP' --allowedTools $TOOLS --dangerously-load-development-channels server:kage"
fi
RUNTIME="$(sed -n 's/^KAGE_RUNTIME=//p' "$ENV_FILE" | tail -1)"   # the hub's env parser keeps the last line too
sdk_loads() { (cd "$DIR" && node -e 'import("@anthropic-ai/claude-agent-sdk").catch(()=>process.exit(1))') 2>/dev/null; }
# Threads run inside the hub on the Agent SDK, which is not bundled: install it once.
if [[ $RUNTIME != tmux ]] && ! sdk_loads; then
  echo "Installing the Agent SDK (once)..."
  (cd "$DIR" && npm ci --no-audit --no-fund --loglevel=error) || echo "npm ci failed, so threads open as tmux panes." >&2
fi
AWAKE=""; command -v caffeinate >/dev/null && AWAKE="caffeinate -i"   # keep a Mac from idling to sleep
# Window "router" holds the Slack connection and opens one Claude Code pane per thread (router.ts).
LOOP="while true; do $AWAKE node '$DIR/dist/router.js'; echo 'router exited, restarting in 5s (Ctrl-c to stop)'; sleep 5; done"
# Sessions start in your home folder so they have the same reach as a normal session; KAGE_CWD changes that.
tmux new-session -d -s "$NAME" -n router -c "${KAGE_CWD:-$HOME}" -e "KAGE_ENV=$ENV_FILE" -e "KAGE_CLAUDE=$CLAUDE" "$LOOP"

if [[ $ROUTE == plugin ]] || { [[ $RUNTIME != tmux ]] && sdk_loads; }; then
  echo "$NAME is running, no prompts. See every thread: ./setup.sh top"
  exit 0
fi
cat <<EOF
$NAME is starting in tmux (dev route). Each thread opens its own Claude Code pane, and each
new pane shows a warning screen for custom channels: attach, go to the threads window (Ctrl-b then n),
press Enter on "I am using this for local development", then Ctrl-b and then d.
To skip that screen, remove KAGE_RUNTIME=tmux from the env file and restart.
EOF
sleep 2
if [[ -t 1 && -z "${TMUX:-}" ]]; then tmux attach -t "=$NAME"; else echo "Confirm it with: tmux attach -t $NAME"; fi
