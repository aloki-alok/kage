#!/usr/bin/env bash
# One-time setup: checks tools, installs deps, creates your Slack app, saves your tokens.
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE="${KAGE_ENV:-$HOME/.config/kage/env}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "1/4  Checking tools"
command -v node >/dev/null || die "Node.js 22.18 or newer is required: https://nodejs.org"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || die "Node $(node -v) is too old: Kage runs TypeScript directly, which needs Node 22.18+."
command -v claude >/dev/null || die "Claude Code is required: https://code.claude.com/docs/en/quickstart"
command -v tmux >/dev/null || die "tmux is required (macOS: brew install tmux)"
echo "node $(node -v), claude $(claude --version | head -1), tmux ok"
npm ci --silent --no-audit --no-fund
echo "dependencies installed"

say "2/4  Pick a name"
read -r -p "What do you call it in Slack? [kage] " NAME
NAME="$(printf '%s' "${NAME:-kage}" | tr '[:upper:]' '[:lower:]')"
[[ "$NAME" =~ ^[a-z][a-z0-9-]{1,20}$ ]] || die "Use a short lowercase word: letters, digits, dashes."

say "3/4  Create your Slack app"
MANIFEST="$(KAGE_NAME="$NAME" node manifest.ts)"
printf '%s\n' "$MANIFEST" > slack-manifest.json
URL="https://api.slack.com/apps?new_app=1&manifest_json=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$MANIFEST")"
cat <<EOF
A browser tab opens with the app form already filled in.
  1. Pick your workspace, then click Next and Create.
     (If the form is empty, choose "From a manifest" and paste slack-manifest.json.)
  2. Basic Information > App-Level Tokens > Generate: any name, scope connections:write.
     Copy the token (xapp-...).
  3. Install App > Install to Workspace > Allow.
     Copy the User OAuth Token (xoxp-...) and the Bot User OAuth Token (xoxb-...).
If Slack says the app needs approval, a workspace admin has to approve it once.
EOF
(open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || echo "Open: $URL") &
read -r -p "Press Enter when you have the three tokens. "

say "4/4  Save your tokens"
check() {  # $1 token, $2 expected prefix: prints the Slack user id or fails
  [[ "$1" == "$2"* ]] || die "That token should start with $2"
  local api=auth.test; [[ "$2" == xapp-* ]] && api=apps.connections.open
  # The header goes in on stdin, so the token never shows in `ps`.
  printf 'header = "Authorization: Bearer %s"\n' "$1" | curl -s -X POST "https://slack.com/api/$api" -K - \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(!r.ok){console.error("Slack says: "+r.error);process.exit(1)}console.log(r.user_id||"ok")})'
}
trim() { printf '%s' "$1" | tr -d '[:space:]'; }   # pasted tokens often carry a space or newline
read -r -s -p "App-level token (xapp-...): " APP; echo; APP="$(trim "$APP")"
check "$APP" xapp- >/dev/null || die "App token rejected."
read -r -s -p "User OAuth token (xoxp-...): " USR; echo; USR="$(trim "$USR")"
OWNER="$(check "$USR" xoxp-)" || die "User token rejected."
read -r -s -p "Bot token (xoxb-...): " BOT; echo; BOT="$(trim "$BOT")"
check "$BOT" xoxb- >/dev/null || die "Bot token rejected."

mkdir -p "$(dirname "$ENV_FILE")" && chmod 700 "$(dirname "$ENV_FILE")"
umask 077
printf 'KAGE_NAME=%s\nSLACK_APP_TOKEN=%s\nSLACK_USER_TOKEN=%s\nSLACK_BOT_TOKEN=%s\n' "$NAME" "$APP" "$USR" "$BOT" > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "Saved to $ENV_FILE (only you can read it). Owner: $OWNER"

say "Done. Start it with ./start.sh"
