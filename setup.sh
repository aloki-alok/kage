#!/usr/bin/env bash
# Sets Kage up. With no argument it walks a person through every step.
# An agent runs the steps one at a time (see AGENTS.md):
#   ./setup.sh check            tools present and new enough
#   ./setup.sh app [name]       write the Slack app manifest and print the link that creates the app
#   ./setup.sh save [name]      ask for the three Slack tokens (hidden), check them, save them
#   ./setup.sh doctor           check every part and print the fix for anything wrong
#   ./setup.sh top              full-screen console: every thread, attach, stop
#   ./setup.sh teammate list | add <who> | remove <who>   who else may tag it (name, @handle or id)
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE="${KAGE_ENV:-$HOME/.config/kage/env}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

valid_name() {
  NAME="$(printf '%s' "${1:-kage}" | tr '[:upper:]' '[:lower:]')"
  [[ "$NAME" =~ ^[a-z][a-z0-9-]{1,20}$ ]] || die "Use a short lowercase word: letters, digits, dashes."
}

cmd_check() {
  command -v node >/dev/null || die "Node.js 22.18 or newer is required: https://nodejs.org"
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
    || die "Node $(node -v) is too old: Kage runs TypeScript directly, which needs Node 22.18+."
  command -v claude >/dev/null || die "Claude Code is required: https://code.claude.com/docs/en/quickstart"
  command -v tmux >/dev/null || die "tmux is required (macOS: brew install tmux)"
  echo "ok: node $(node -v), $(claude --version | head -1), tmux"
}

cmd_app() {
  valid_name "${1:-}"
  KAGE_NAME="$NAME" node manifest.ts > slack-manifest.json
  URL="https://api.slack.com/apps?new_app=1&manifest_json=$(node -e 'process.stdout.write(encodeURIComponent(require("fs").readFileSync("slack-manifest.json","utf8")))')"
  (open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true) &
  cat <<EOF
Manifest: $PWD/slack-manifest.json
Create link (opened in the browser if possible):
$URL

In the browser:
  1. Pick your workspace, then click Next and Create.
     (If the form is empty, choose "From a manifest" and paste slack-manifest.json.)
  2. Basic Information > App-Level Tokens > Generate: any name, scope connections:write.
     Copy the token (xapp-...).
  3. Install App > Install to Workspace > Allow.
     Copy the User OAuth Token (xoxp-...) and the Bot User OAuth Token (xoxb-...).
If Slack says the app needs approval, a workspace admin has to approve it once.
EOF
}

slack_check() {  # $1 token: prints the Slack user id (or "ok"), fails with Slack's error
  local api=auth.test; [[ "$1" == xapp-* ]] && api=apps.connections.open
  # The header goes in on stdin, so the token never shows in `ps`.
  printf 'header = "Authorization: Bearer %s"\n' "$1" | curl -s -X POST "https://slack.com/api/$api" -K - \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(!r.ok){console.error("Slack says: "+r.error);process.exit(1)}console.log(r.user_id||"ok")})'
}

env_get() { [[ -f "$ENV_FILE" ]] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 || true; }

cmd_save() {
  valid_name "${1:-$(env_get KAGE_NAME)}"
  # Tokens arrive on stdin in any order, one per line or space separated. Each is sorted by its prefix.
  local APP="" USR="" BOT="" t input
  if [[ -t 0 ]]; then  # a person at a terminal: hidden prompts, so the tokens never show
    local a u b
    read -r -s -p "App-level token (xapp-...): " a; echo
    read -r -s -p "User OAuth token (xoxp-...): " u; echo
    read -r -s -p "Bot token (xoxb-...): " b; echo
    input="$a $u $b"
  else
    input="$(cat)"
  fi
  for t in $input; do
    case "$t" in xapp-*) APP=$t ;; xoxp-*) USR=$t ;; xoxb-*) BOT=$t ;; *) die "Not a Slack token: ${t:0:5}..." ;; esac
  done
  [[ -n $APP && -n $USR && -n $BOT ]] || die "Need all three tokens on stdin: xapp-..., xoxp-..., xoxb-..."
  slack_check "$APP" >/dev/null || die "App-level token (xapp-) rejected."
  local OWNER; OWNER="$(slack_check "$USR")" || die "User token (xoxp-) rejected."
  slack_check "$BOT" >/dev/null || die "Bot token (xoxb-) rejected."

  mkdir -p "$(dirname "$ENV_FILE")" && chmod 700 "$(dirname "$ENV_FILE")"
  umask 077
  # Keep any other settings already in the file (KAGE_ROUTE, KAGE_TEAMMATES).
  local keep=""; [[ -f "$ENV_FILE" ]] && keep="$(grep -vE '^(KAGE_NAME|SLACK_APP_TOKEN|SLACK_USER_TOKEN|SLACK_BOT_TOKEN)=' "$ENV_FILE" || true)"
  { printf 'KAGE_NAME=%s\nSLACK_APP_TOKEN=%s\nSLACK_USER_TOKEN=%s\nSLACK_BOT_TOKEN=%s\n' "$NAME" "$APP" "$USR" "$BOT"
    if [[ -n $keep ]]; then printf '%s\n' "$keep"; fi; } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "ok: saved to $ENV_FILE (mode 600) for @$NAME, owner $OWNER"
}

cmd_doctor() {
  local bad=0
  pass() { printf 'ok    %s\n' "$*"; }
  fail() { printf 'FAIL  %s\n' "$*"; bad=1; }
  note() { printf 'note  %s\n' "$*"; }

  (cmd_check >/dev/null 2>&1) && pass "tools: node 22.18+, claude, tmux" || fail "tools: run ./setup.sh check for the missing one"
  if [[ ! -f "$ENV_FILE" ]]; then
    fail "tokens: no $ENV_FILE. Run ./setup.sh app, then ./setup.sh save"
  else
    [[ "$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE")" == 600 ]] && pass "token file is private (600)" || fail "token file: run chmod 600 $ENV_FILE"
    local k
    for k in SLACK_APP_TOKEN SLACK_USER_TOKEN SLACK_BOT_TOKEN; do
      slack_check "$(env_get $k)" >/dev/null 2>&1 && pass "$k accepted by Slack" || fail "$k: missing or rejected. Run ./setup.sh save again"
    done
  fi
  NAME="$(env_get KAGE_NAME)"; NAME="${NAME:-kage}"

  if [[ "$(env_get KAGE_RUNTIME)" != tmux ]]; then
    node -e 'import("@anthropic-ai/claude-agent-sdk").catch(()=>process.exit(1))' 2>/dev/null && pass "threads run on the Agent SDK, no prompts" \
      || fail "Agent SDK does not load: run npm ci, then restart (until then threads open as tmux panes)"
  elif [[ "$(env_get KAGE_ROUTE)" == plugin ]]; then
    claude plugin list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).some(p=>p.id==="kage@kage"&&p.enabled)?0:1))' \
      && pass "plugin kage@kage installed and enabled" \
      || fail "plugin: run claude plugin marketplace add \"$PWD\" && claude plugin install kage@kage"
    node -e 'const f=process.env.HOME+"/.claude/remote-settings.json";let s={};try{s=require(f)}catch{};process.exit((s.allowedChannelPlugins||[]).some(p=>p.marketplace==="kage"&&p.plugin==="kage")?0:1)' \
      && pass "your Claude org approves the kage channel" \
      || fail "org approval missing: an org Owner adds kage to allowedChannelPlugins (README, Start without prompts)"
  else
    note "dev route: Claude Code shows a warning screen on each start, and a person confirms it"
  fi

  if tmux has-session -t "=$NAME" 2>/dev/null; then pass "tmux session $NAME is running"; else fail "not running: ./start.sh"; fi
  local st="$(dirname "$ENV_FILE")/status"
  if [[ -f $st ]] && ps -p "$(awk '{print $4}' "$st")" >/dev/null 2>&1; then
    pass "connected to Slack: $(cat "$st")"
  else
    fail "not connected to Slack yet: wait 20 s after start, or tmux attach -t $NAME to see why"
  fi
  [[ $bad == 0 ]] && echo "All good. Tag @$NAME in Slack to try it." || return 1
}

cmd_interactive() {
  say "1/4  Checking tools"; cmd_check
  say "2/4  Pick a name"; read -r -p "What do you call it in Slack? [kage] " n; valid_name "$n"
  say "3/4  Create your Slack app"; cmd_app "$NAME"
  read -r -p "Press Enter when you have the three tokens. "
  say "4/4  Save your tokens"; cmd_save "$NAME"
  say "Done. Start it with ./start.sh"
}

case "${1:-}" in
  "") cmd_interactive ;;
  check) cmd_check ;;
  app) cmd_app "${2:-}" ;;
  save) cmd_save "${2:-}" ;;
  doctor) cmd_doctor ;;
  teammate) node teammate.ts "${@:2}" ;;
  watch) node watch.ts "${@:2}" ;;
  top) node top.ts "${@:2}" ;;
  attach) node attach.ts "${@:2}" ;;
  export-crons) node export-crons.ts "${@:2}" ;;
  *) die "Usage: $0 [check | app [name] | save [name] | doctor | teammate list|add|remove | top | watch [place] | attach [place]]" ;;
esac
