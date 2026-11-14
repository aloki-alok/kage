#!/usr/bin/env bash
# The kage command. `./setup.sh link` puts it on PATH as `kage`; `kage help` lists every command.
# Commands live in the COMMANDS table below and in the case at the bottom; core/cli-help.test.ts
# checks that the two list the same names.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"  # readlink: works when run through the kage link
ENV_FILE="${KAGE_ENV:-$HOME/.config/kage/env}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# group|name|arguments|what it does|example. `kage help` prints it grouped; `kage help <name>` prints one.
COMMANDS='Set up|setup||Walk through the first setup, one step at a time|kage setup
Set up|check||Check that node 22.18+ and claude are installed (and tmux, for KAGE_RUNTIME=tmux)|kage check
Set up|app|[name]|Write the Slack app for the name you tag, and open the link that creates it|kage app kage
Set up|save|[name]|Paste the three Slack tokens into hidden prompts; each is checked with Slack|kage save
Set up|doctor||Check every part, and print the command that fixes each problem|kage doctor
Set up|link||Put the kage command on your PATH (~/.local/bin/kage)|./setup.sh link
Set up|service|on or off|Let macOS or Linux keep Kage running: back after a crash, a reboot or a login|kage service on
Run|start|[kagelet]|Start Kage in the background (turns the service on the first time). With a kagelet: run it again after kage stop|kage start
Run|stop|[thread or kagelet] [--now or --cut-running]|Stop Kage once every running turn ends, or now with --cut-running. With a thread (link, place or key): end only its session, after its turn or --now. With a kagelet: pause it and keep its file|kage stop support
Run|restart|[--cut-running]|Restart the hub once every running turn ends; new messages wait and run after it|kage restart
Run|reload||Read the settings file again with no restart: who may tag Kage changes at once|kage reload
Run|status||One look at every session and what it is doing|kage status
Run|logs|[lines or -f]|The last lines of the hub log (80 unless you say), or -f to follow it|kage logs -f
Run|run||Run the hub in the foreground for a supervisor other than launchd or systemd (Docker: --init); output goes to kage logs|kage run
Run|cost|[days]|What each thread spent, most first (1 day unless you say)|kage cost 7
Run|dream|undo|Put the memory back to how it was before the last weekly dream|kage dream undo
Watch|schedules||Every schedule and reply watch, in every thread|kage schedules
Watch|top||The live console: every thread, its feed, attach and stop, by mouse or keys|kage top
Watch|watch|[place]|Follow every step every session takes, as it happens|kage watch support
Watch|attach|[place or link]|Take a thread into this terminal, by its place or its Slack link in quotes; Kage gets it back when you quit|kage attach "https://example.slack.com/archives/C0123ABC/p1700000000123456"
People|add|<person>, <app id> <owner> or kagelet <name>|Let a person tag Kage (a mention, member id, email, name or @handle), or an agent with the person or agent it answers to. kagelet <name> writes a paused starter file for a kagelet|kage add priya
People|remove|<person or app id>|Take a person or an agent off the list; whoever answers to them goes too|kage remove priya
People|list||Who may tag Kage besides you: each person, with their agents under them. Then the kagelets Kage manages: schedule, last and next run, cost today|kage list
People|tell|<place> <message>|Tell a thread something as you; its session takes it after the current turn|kage tell support use the staging db
People|call||Kage phones you, and the call can do anything you can (needs KAGE_CALL_COMMAND)|kage call'

cmd_help() {
  local B= R=; [[ -t 1 ]] && B=$'\033[1m' R=$'\033[0m'
  if [[ -n "${1:-}" ]]; then
    local row; row="$(printf '%s\n' "$COMMANDS" | awk -F'|' -v n="$1" '$2==n')"
    [[ -n $row ]] || unknown "$1"
    IFS='|' read -r _ n a d e <<<"$row"
    printf "${B}kage %s${R} %s\n  %s\n  Example: %s\n" "$n" "$a" "$d" "$e"
    return
  fi
  printf "${B}kage${R}  tag @kage in Slack, and your own Claude Code does the work on this machine.\n"
  local group="" g n a d e
  while IFS='|' read -r g n a d e; do
    [[ $g == "$group" ]] || { printf "\n${B}%s${R}\n" "$g"; group=$g; }
    printf '  %-28s %s\n' "$n${a:+ $a}" "$d"
  done <<<"$COMMANDS"
  printf '\nkage help <command> shows one command with an example. Settings: docs/settings.md\n'
}

# Bare kage: the few commands used every day. kage help has the rest.
cmd_short() {
  local n d
  for n in status top logs schedules cost doctor; do
    d="$(printf '%s\n' "$COMMANDS" | awk -F'|' -v n="$n" '$2==n {print $4}')"
    printf '  kage %-12s %s\n' "$n" "$d"
  done
  printf '\nkage help lists all %s commands.\n' "$(printf '%s\n' "$COMMANDS" | wc -l | tr -d ' ')"
}

unknown() {
  local guess; guess="$(node -e 'import("./core/cli-help.ts").then(m=>{const s=m.suggest(process.argv[1],process.argv.slice(2));if(s)console.log(s)})' "$1" $(printf '%s\n' "$COMMANDS" | cut -d'|' -f2) 2>/dev/null || true)"
  printf 'No command "%s".%s Run kage help for the list.\n' "$1" "${guess:+ Did you mean kage $guess?}" >&2
  exit 2
}

# Before kage stop or restart: the hub takes no new turns and this waits until every running turn ends,
# naming each thread (cli/quiet.ts). --cut-running cuts them instead. Inside Kage, --force is needed, and it cuts:
# waiting would wait on this very session.
quiet_first() {
  local cmd=$1 force="" cut="" a; shift
  for a in "$@"; do case $a in --force) force=1 ;; --cut-running) cut=--cut-running ;; *) die "kage $cmd takes --cut-running, or --force inside Kage." ;; esac; done
  if [[ -n "${KAGE_CLAUDE:-}" ]]; then
    [[ -n $force ]] || die "This shell runs inside Kage, so kage $cmd would end this session too. Run kage $cmd --force to do it anyway."
    cut=--cut-running
  fi
  running || return 0
  node cli/quiet.ts $cut
}

kage_name() { NAME="$(env_get KAGE_NAME)"; NAME="${NAME:-kage}"; }
# A hub started before the service existed runs in a tmux session (start.sh). kage service on moves it.
old_tmux() { command -v tmux >/dev/null && tmux has-session -t "=$NAME" 2>/dev/null; }
running() { kage_name; ./service.sh running 2>/dev/null || old_tmux; }
LOG="$(dirname "$ENV_FILE")/hub.log"

cmd_start() {
  kage_name
  if ./service.sh installed; then ./service.sh start
  else ./service.sh on || return 1; fi
  echo "$NAME is starting. Check it in 20 s: kage doctor"
  if [[ "$(env_get KAGE_RUNTIME)" == tmux && "$(env_get KAGE_ROUTE)" != plugin ]]; then
    echo "Threads open as tmux panes (dev route): each new pane shows a warning screen. Confirm it in tmux attach -t $NAME."
  fi
}

cmd_stop() {
  kage_name
  quiet_first stop "$@"
  if ./service.sh installed; then ./service.sh stop
  elif old_tmux; then tmux kill-session -t "=$NAME"
  else echo "$NAME is not running."; return 0; fi
  echo "Stopped $NAME. It stays down until kage start or the next login (Linux: the next boot). Each thread resumes its conversation on its next tag."
}

# A change to KAGE_ROUTE, KAGE_RUNTIME, KAGE_CWD or KAGE_MEMORY needs kage stop, then kage start.
cmd_restart() {
  quiet_first restart "$@"
  running || { echo "$NAME is not running. Start it: kage start"; return 1; }
  if ./service.sh installed; then ./service.sh restart && echo "Restarted the hub; it is back in about 10 s. Open sessions resume on their next tag."; return; fi
  # The old tmux loop starts the hub again 5 s after it exits.
  local pid; pid="$(awk '{print $4}' "$(dirname "$ENV_FILE")/status" 2>/dev/null || true)"
  # The status file outlives the hub; never kill a pid that is now some other program.
  if [[ -n $pid ]] && ps -p "$pid" -o command= 2>/dev/null | grep -q 'router.ts'; then
    kill "$pid" && echo "Restarted the hub; it is back in about 10 s. Open sessions resume on their next tag."
  else
    echo "The hub is between restarts. Wait 10 s, then kage status." >&2; return 1
  fi
}

cmd_status() {
  running || { echo "$NAME is not running. Start it: kage start"; return 1; }
  echo "Kage $(running_version)"
  node cli/top.ts --once
}

# The version the hub read at its start (router.ts writes it), and the version of the code on disk.
running_version() { cat "$(dirname "$ENV_FILE")/version" 2>/dev/null || echo unknown; }
disk_version() { node -e 'import("./runtime/auto-update.ts").then(m=>console.log(m.version(process.cwd())))'; }
cmd_version() {
  local disk run; disk="$(disk_version)"; run="$(running_version)"
  echo "kage $disk"
  if running && [[ $run != unknown && $run != "$disk" ]]; then echo "The hub still runs $run. It restarts into the new code once every session is quiet."; fi
}

cmd_logs() {
  kage_name
  if [[ "${1:-}" == -f ]]; then [[ -f $LOG ]] || die "No hub log yet: $LOG"; exec tail -n 40 -f "$LOG"; fi
  local n="${1:-80}"; [[ $n =~ ^[0-9]+$ ]] || die "kage logs takes a number of lines, like kage logs 200, or -f to follow"
  if [[ -f $LOG ]]; then tail -n "$n" "$LOG"; return; fi
  # A hub from start.sh logs only to its tmux window, about 2,000 lines; the blank rows below the last line are dropped.
  old_tmux || { echo "No hub log yet. Start it: kage start"; return 1; }
  tmux capture-pane -p -J -t "=$NAME:router" -S - | grep -v '^$' | tail -n "$n"
}

valid_name() {
  NAME="$(printf '%s' "${1:-kage}" | tr '[:upper:]' '[:lower:]')"
  [[ "$NAME" =~ ^[a-z][a-z0-9-]{1,20}$ ]] || die "Use a short lowercase word: letters, digits, dashes."
}

cmd_check() {
  command -v node >/dev/null || die "Node.js 22.18 or newer is required: https://nodejs.org"
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
    || die "Node $(node -v) is too old: Kage runs TypeScript directly, which needs Node 22.18+."
  command -v claude >/dev/null || die "Claude Code is required: https://code.claude.com/docs/en/quickstart"
  local tm=""
  if [[ "$(env_get KAGE_RUNTIME)" == tmux ]]; then
    command -v tmux >/dev/null || die "tmux is required for KAGE_RUNTIME=tmux (macOS: brew install tmux)"
    tm=", tmux"
  fi
  echo "ok: node $(node -v), $(claude --version | head -1)$tm"
}

cmd_app() {
  valid_name "${1:-}"
  KAGE_NAME="$NAME" node cli/manifest.ts > slack-manifest.json
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

  (cmd_check >/dev/null 2>&1) && pass "tools: node 22.18+, claude" || fail "tools: run kage check for the missing one"
  if [[ ! -f "$ENV_FILE" ]]; then
    fail "tokens: no $ENV_FILE. Run kage app, then kage save"
  else
    [[ "$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE")" == 600 ]] && pass "token file is private (600)" || fail "token file: run chmod 600 $ENV_FILE"
    local k
    for k in SLACK_APP_TOKEN SLACK_USER_TOKEN SLACK_BOT_TOKEN; do
      slack_check "$(env_get $k)" >/dev/null 2>&1 && pass "$k accepted by Slack" || fail "$k: missing or rejected. Run kage save again"
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
      || fail "org approval missing: an org Owner adds kage to allowedChannelPlugins (README, 'Run threads as tmux panes instead')"
  else
    note "dev route: Claude Code shows a warning screen on each start, and a person confirms it"
  fi

  if ./service.sh installed; then
    ./service.sh running && pass "the service keeps $NAME running" || fail "the service is on but $NAME is stopped: kage start"
  elif old_tmux; then
    fail "$NAME runs in tmux, which does not bring it back after a reboot or a kill: kage service on"
  else
    fail "not running: kage start"
  fi
  if [[ "$(./service.sh kind)" == systemd && "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]]; then
    fail "it starts only once you log in: sudo loginctl enable-linger $(id -un)"
  fi
  local boots; boots="$(awk -v t=$(( $(date +%s) - 86400 )) '$1 > t' "$(dirname "$ENV_FILE")/boots" 2>/dev/null | wc -l | tr -d ' ')"
  (( boots > 5 )) && note "the hub started $boots times in 24 h: kage logs shows why"
  [[ "$(uname -s)" == Darwin ]] && note "with the lid closed this Mac sleeps, and Kage is offline until it wakes"
  local st="$(dirname "$ENV_FILE")/status"
  if [[ -f $st ]] && ps -p "$(awk '{print $4}' "$st")" >/dev/null 2>&1 && [[ $(awk '{print $1}' "$st") == connected ]]; then
    pass "connected to Slack: $(cat "$st")"
    pass "runs Kage $(running_version)"
  else
    fail "not connected to Slack yet: wait 20 s after start, or run kage logs to see why"
  fi
  # The same rules as core/auto-update.ts, so a person sees why this install stays on its version.
  if [[ "$(env_get KAGE_AUTO_UPDATE)" == off ]]; then note "auto-update is off (KAGE_AUTO_UPDATE=off)"
  elif [[ ! -e .git ]]; then note "no auto-update: not a git checkout. Rerun the install line to make it one"
  elif [[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" != main ]]; then note "no auto-update: on branch $(git rev-parse --abbrev-ref HEAD 2>/dev/null), not main"
  elif [[ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]]; then note "no auto-update: the checkout has uncommitted changes"
  fi
  command -v kage >/dev/null || note "kage is not on your PATH: run ./setup.sh link to type kage <command> anywhere"
  [[ $bad == 0 ]] && echo "All good. Tag @$NAME in Slack to try it." || return 1
}

cmd_interactive() {
  say "1/4  Checking tools"; cmd_check
  say "2/4  Pick a name"; read -r -p "What do you call it in Slack? [kage] " n; valid_name "$n"
  say "3/4  Create your Slack app"; cmd_app "$NAME"
  read -r -p "Press Enter when you have the three tokens. "
  say "4/4  Save your tokens"; cmd_save "$NAME"
  say "Done. Start it with kage start (run ./setup.sh link first to put kage on your PATH)"
}

# Help comes first, so "kage add --help" never reaches a command that would act on it.
[[ "${1:-}" == --version ]] && { cmd_version; exit 0; }
for a in "$@"; do [[ $a == -h || $a == --help ]] && { [[ $1 == "$a" || $1 == help ]] && cmd_help || cmd_help "$1"; exit 0; }; done

case "${1:-}" in
  "") if [[ -f "$ENV_FILE" ]]; then { running && echo "$NAME is running." || echo "$NAME is not running. Start it: kage start"; echo; cmd_short; }; else cmd_interactive; fi ;;
  help) cmd_help "${2:-}" ;;
  setup) cmd_interactive ;;
  check) cmd_check ;;
  app) cmd_app "${2:-}" ;;
  save) cmd_save "${2:-}" ;;
  doctor) cmd_doctor ;;
  link) mkdir -p ~/.local/bin && ln -sf "$PWD/setup.sh" ~/.local/bin/kage && echo "ok: run kage from anywhere (needs ~/.local/bin on PATH)" ;;
  service) ./service.sh "${2:-}" ;;
  run) exec node hub.ts ;;
  # A kagelet's name: resume it (cli/stop.ts). Otherwise the hub.
  start) if [[ $# -gt 1 ]]; then node cli/stop.ts --resume "${@:2}"; else cmd_start; fi ;;
  # A thread (any word that is not a flag) or --now: one session (cli/stop.ts). Otherwise the whole hub.
  stop) if [[ " ${*:2} " == *" --now "* ]] || { [[ $# -gt 1 ]] && printf '%s\n' "${@:2}" | grep -qv '^--'; }; then node cli/stop.ts "${@:2}"; else cmd_stop "${@:2}"; fi ;;
  restart) cmd_restart "${@:2}" ;;
  reload) node cli/reload.ts ;;
  status) cmd_status ;;
  logs) cmd_logs "${2:-}" ;;
  cost) node cli/cost.ts "${@:2}" ;;
  schedules) node cli/schedules.ts ;;
  dream) node cli/dream.ts "${@:2}" ;;
  top) node cli/top.ts "${@:2}" ;;
  watch) node cli/watch.ts "${@:2}" ;;
  attach) node cli/attach.ts "${@:2}" ;;
  tell) node cli/tell.ts "${@:2}" ;;
  add) node cli/registry.ts "$@" ;;
  remove) node cli/registry.ts "$@" ;;
  list) node cli/registry.ts "$@" ;;
  call) node cli/call.ts ;;
  export-crons) node cli/export-crons.ts "${@:2}" ;;   # one-time move of CronCreate jobs out of tmux panes; not in help
  *) unknown "$1" ;;
esac
