#!/usr/bin/env bash
# Starts the agent's Claude Code session in a background tmux window named after it.
# Claude Code asks you to confirm custom channels on every start, so this attaches you once.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${KAGE_ENV:-$HOME/.config/kage/env}"
[[ -f "$ENV_FILE" ]] || { echo "No $ENV_FILE yet. Run ./setup.sh first." >&2; exit 1; }
NAME="$(sed -n 's/^KAGE_NAME=//p' "$ENV_FILE")"; NAME="${NAME:-kage}"

[[ "$DIR$ENV_FILE" =~ [\'\"\\] ]] && { echo "Move kage or its env file to a path without quotes or backslashes." >&2; exit 1; }
if tmux has-session -t "=$NAME" 2>/dev/null; then   # "=" means exact name, not a prefix
  echo "$NAME is already running. See it: tmux attach -t $NAME   (leave: Ctrl-b then d)"
  exit 0
fi

MCP="{\"mcpServers\":{\"kage\":{\"command\":\"$(command -v node)\",\"args\":[\"$DIR/server.ts\"],\"env\":{\"KAGE_ENV\":\"$ENV_FILE\"}}}}"
AWAKE=""; command -v caffeinate >/dev/null && AWAKE="caffeinate -i"   # keep a Mac awake while it runs
# Starts in your home folder so it has the same reach as a normal session; KAGE_CWD changes that.
tmux new-session -d -s "$NAME" -c "${KAGE_CWD:-$HOME}" \
  "$AWAKE claude --mcp-config '$MCP' --allowedTools mcp__kage__reply --dangerously-load-development-channels server:kage"

cat <<EOF
$NAME is starting in tmux. Claude Code now shows a warning screen for custom channels:
  press Enter on "I am using this for local development", then Ctrl-b and then d to leave it running.
EOF
sleep 2
if [[ -t 1 && -z "${TMUX:-}" ]]; then tmux attach -t "=$NAME"; else echo "Confirm it with: tmux attach -t $NAME"; fi
