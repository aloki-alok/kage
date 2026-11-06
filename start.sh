#!/usr/bin/env bash
# Starts the agent in a background tmux session named after it: the router (restarted if it
# exits), which runs one Agent SDK session per Slack thread, with no prompts.
# KAGE_RUNTIME=tmux opens a Claude Code pane per thread instead, on one of two routes:
#   Plugin route (no prompts): kage installed as a plugin and on your org's approved channel list.
#   Dev route: Claude Code shows a warning screen in each pane; a person confirms it.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${KAGE_ENV:-$HOME/.config/kage/env}"
[[ -f "$ENV_FILE" ]] || { echo "No $ENV_FILE yet. Run kage setup first." >&2; exit 1; }
[[ "$DIR$ENV_FILE" =~ [\'\"\\] ]] && { echo "Move kage or its env file to a path without quotes or backslashes." >&2; exit 1; }
NAME="$(sed -n 's/^KAGE_NAME=//p' "$ENV_FILE")"; NAME="${NAME:-kage}"

if tmux has-session -t "=$NAME" 2>/dev/null; then   # "=" means exact name, not a prefix
  echo "$NAME is already running. See it: kage status"
  exit 0
fi

TOOLS=""
for t in reply edit_message delete_message send_file message_people schedule unschedule schedules; do TOOLS="$TOOLS mcp__kage__$t mcp__plugin_kage_kage__$t"; done
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
  MCP="{\"mcpServers\":{\"kage\":{\"command\":\"$(command -v node)\",\"args\":[\"$DIR/server.ts\"]}}}"
  CLAUDE="claude --mcp-config '$MCP' --allowedTools $TOOLS --dangerously-load-development-channels server:kage"
fi
RUNTIME="$(sed -n 's/^KAGE_RUNTIME=//p' "$ENV_FILE" | tail -1)"   # the hub's env parser keeps the last line too
sdk_loads() { (cd "$DIR" && node -e 'import("@anthropic-ai/claude-agent-sdk").catch(()=>process.exit(1))') 2>/dev/null; }
# Kage runs from its source, so its packages must match package-lock.json. npm stamps node_modules/.package-lock.json
# on each install, so a pull that changes the packages reinstalls them before the hub starts again.
PACKAGES="cd '$DIR' && { [ package-lock.json -ot node_modules/.package-lock.json ] || npm ci --no-audit --no-fund --loglevel=error; }"
bash -c "$PACKAGES" || { echo "npm ci failed: run it in $DIR and read the error." >&2; exit 1; }
AWAKE=""; command -v caffeinate >/dev/null && AWAKE="caffeinate -i"   # keep a Mac from idling to sleep
# Window "router" holds the Slack connection and opens one Claude Code pane per thread (router.ts).
LOOP="while true; do ( $PACKAGES ); $AWAKE node '$DIR/router.ts'; code=\$?; when=\$(date -u +%FT%TZ); printf '%s\\t%s\\n' \"\$when\" \"\$code\" >> '$(dirname "$ENV_FILE")/exits.tsv'; echo \"\$when router exited with code \$code, restarting in 5s (Ctrl-c to stop)\"; sleep 5; done"
# Sessions start in your home folder so they have the same reach as a normal session; KAGE_CWD changes that.
tmux new-session -d -s "$NAME" -n router -c "${KAGE_CWD:-$HOME}" -e "KAGE_ENV=$ENV_FILE" -e "KAGE_CLAUDE=$CLAUDE" "$LOOP"

if [[ $ROUTE == plugin ]] || { [[ $RUNTIME != tmux ]] && sdk_loads; }; then
  echo "$NAME is running, no prompts. See every thread: kage top"
  exit 0
fi
cat <<EOF
$NAME is starting in tmux (dev route). Each thread opens its own Claude Code pane, and each
new pane shows a warning screen for custom channels: attach, go to the threads window (Ctrl-b then n),
press Enter on "I am using this for local development", then Ctrl-b and then d.
To skip that screen, remove KAGE_RUNTIME=tmux from the env file, then kage stop and kage start.
EOF
sleep 2
if [[ -t 1 && -z "${TMUX:-}" ]]; then tmux attach -t "=$NAME"; else echo "Confirm it with: tmux attach -t $NAME"; fi
