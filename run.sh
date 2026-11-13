#!/usr/bin/env bash
# Runs the hub once, in the foreground, for a supervisor: launchd or systemd (service.sh), or your own (kage run).
# The supervisor's rule: a non-zero exit restarts it, and exit 0 (kage stop, a second hub) stays down.
# Everything after the log line below goes to hub.log, so a hub that crashes while it loads still leaves the reason.
# 3 starts in 10 minutes DM the owner, at most once an hour. This script sends it, because a bad pull can stop
# the hub before any of its code runs.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${KAGE_ENV:-$HOME/.config/kage/env}"
CONF="$(dirname "$ENV_FILE")"
[[ -f "$ENV_FILE" ]] || { echo "No $ENV_FILE yet. Run kage setup first." >&2; exit 0; }
[[ "$DIR$ENV_FILE" =~ [\'\"\\] ]] && { echo "Move kage or its env file to a path without quotes or backslashes." >&2; exit 0; }
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }

LOG="$CONF/hub.log"
# The supervisor never holds the file open, so moving it is safe.
[[ -f "$LOG" ]] && (( $(wc -c <"$LOG") > 10 * 1024 * 1024 )) && mv -f "$LOG" "$LOG.1"
last="$(tail -n 5 "$LOG" 2>/dev/null)"   # how the run before this one ended
exec >>"$LOG" 2>&1

# Boots of the last day stay in the file, for the doctor. The alert counts the last 10 minutes.
BOOTS="$CONF/boots" now="$(date +%s)"
{ awk -v t=$((now - 86400)) '$1 > t' "$BOOTS" 2>/dev/null; echo "$now"; } >"$BOOTS.new" && mv -f "$BOOTS.new" "$BOOTS"
boots="$(awk -v t=$((now - 600)) '$1 > t' "$BOOTS" | wc -l | tr -d ' ')"
echo "$(date -u +%FT%TZ) run.sh: hub start $boots in the last 10 minutes"

API="${KAGE_SLACK_API:-https://slack.com/api}"
slack() {  # $1 method, $2 token, then curl data args. The token goes in on stdin, so it never shows in ps.
  local m=$1 t=$2; shift 2
  printf 'header = "Authorization: Bearer %s"\n' "$t" | curl -s -m 10 -X POST "$API/$m" -K - "$@"
}
if (( boots >= 3 )) && (( now - $(cat "$CONF/crash-dm-at" 2>/dev/null || echo 0) >= 3600 )); then
  owner="$(slack auth.test "$(env_get SLACK_USER_TOKEN)" | sed -n 's/.*"user_id":"\([^"]*\)".*/\1/p')"
  text="$(printf 'Kage started %s times in 10 minutes, so it is probably crashing. The last lines of its log:\n```\n%s\n```\nRun kage logs for more.' "$boots" "$last")"
  if [[ -n $owner ]] && slack chat.postMessage "$(env_get SLACK_BOT_TOKEN)" --data-urlencode "channel=$owner" --data-urlencode "text=$text" | grep -q '"ok":true'; then
    echo "$now" >"$CONF/crash-dm-at"
  else
    echo "run.sh: could not DM the owner about the restarts"
  fi
fi

# Kage runs from its source, so its packages must match package-lock.json. npm stamps node_modules/.package-lock.json on each install.
cd "$DIR" && { [[ package-lock.json -ot node_modules/.package-lock.json ]] || npm ci --no-audit --no-fund --loglevel=error; } \
  || { echo "npm ci failed: run it in $DIR and read the error."; exit 1; }

# Sessions see the supervisor's environment, not your shell's. Exports they need go in session.env, which must be private.
SESSION_ENV="$CONF/session.env"
if [[ -f "$SESSION_ENV" ]]; then
  if [[ "$(stat -c %a "$SESSION_ENV" 2>/dev/null || stat -f %Lp "$SESSION_ENV")" == 600 ]]; then set -a; . "$SESSION_ENV"; set +a
  else echo "run.sh: $SESSION_ENV is not private, so it was skipped. Run chmod 600 on it."; fi
fi

# The command that starts Claude Code for a tmux pane. A session inherits it, which is how kage commands know they run inside Kage.
TOOLS=""
for t in reply edit_message delete_message send_file message_people schedule unschedule schedules; do TOOLS="$TOOLS mcp__kage__$t mcp__plugin_kage_kage__$t"; done
# Kage keeps its own memory (core/guards.ts memoryDirs reads the same default).
MEM="$(env_get KAGE_MEMORY)"; MEM="${MEM:-$CONF/memory}"
[[ "$MEM" =~ [\'\"\\] ]] && { echo "Move KAGE_MEMORY to a path without quotes or backslashes."; exit 0; }
mkdir -p "$MEM"
TOOLS="$TOOLS --disallowedTools CronCreate CronDelete CronList --settings '{\"autoMemoryDirectory\":\"$MEM\"}'"   # rides on TOOLS so both routes get it
# The plugin route only works once your org approves the channel, so it is opt-in: KAGE_ROUTE=plugin in the env file.
if [[ "$(env_get KAGE_ROUTE)" == plugin ]]; then
  KAGE_CLAUDE="claude --channels plugin:kage@kage --allowedTools $TOOLS"
else
  MCP="{\"mcpServers\":{\"kage\":{\"command\":\"$(command -v node)\",\"args\":[\"$DIR/server.ts\"]}}}"
  KAGE_CLAUDE="claude --mcp-config '$MCP' --allowedTools $TOOLS --dangerously-load-development-channels server:kage"
fi
export KAGE_ENV="$ENV_FILE" KAGE_CLAUDE

# Sessions work in your home folder, so they have the reach of a normal session; KAGE_CWD changes that.
# Claude Code files transcripts by folder, so a different folder would forget every thread.
cd "${KAGE_CWD:-$HOME}" || exit 1
exec node "$DIR/router.ts"
