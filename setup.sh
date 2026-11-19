#!/usr/bin/env bash
# The kage command. `./setup.sh link` puts it on PATH as `kage`; `kage help` lists every command.
# Commands live in the COMMANDS table below and in the case at the bottom; core/tests/cli-help.test.ts
# checks that the two list the same names.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"  # readlink: works when run through the kage link
ENV_FILE="${KAGE_ENV:-$HOME/.config/kage/env}"
HUB_NODE_OPTIONS="${NODE_OPTIONS:-}"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--disable-warning=ExperimentalWarning"

if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
  RED=$'\033[38;2;255;77;61m' GOLD=$'\033[38;2;255;215;94m' GREEN=$'\033[38;2;127;208;138m' DIM=$'\033[2m' OFF=$'\033[0m'
else RED='' GOLD='' GREEN='' DIM='' OFF=''; fi
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
says() { printf '%s◆%s %s\n' "$RED" "$OFF" "$*"; }
point() { printf '  %s›%s %s\n' "$RED" "$OFF" "$*"; }
quietly() { printf '  %s%s%s\n' "$DIM" "$*" "$OFF"; }
next() { printf '%s%s%s %s%s%s\n' "$DIM" "$1" "$OFF" "$GOLD" "$2" "$OFF"; }
tells() { if [[ -t 2 && -z ${NO_COLOR:-} ]]; then printf '\033[38;2;255;77;61m◆\033[0m %s\n' "$*"; else printf '◆ %s\n' "$*"; fi >&2; }
die() { tells "$*"; exit 1; }

# group|name|arguments|what it does|example. `kage help` prints it grouped; `kage help <name>` prints one.
COMMANDS='Set up|setup||Walk through the first setup, one step at a time|kage setup
Set up|check||Check that node 22.18+ and claude are installed (and tmux, for KAGE_RUNTIME=tmux)|kage check
Set up|app|[name]|Write the Slack app for the name you tag, and open the link that creates it|kage app kage
Set up|save|[name]|Paste the three Slack tokens into hidden prompts; each is checked with Slack|kage save
Set up|claude-login||Save the Claude login Kage runs on, so its sessions use their own seat. Get the token with claude setup-token, signed in as Kage|kage claude-login
Set up|doctor||Check every part, and print the command that fixes each problem|kage doctor
Set up|slack|upgrade|Add the Slack scopes Kage needs and the app lacks: adds them to the app manifest with one Slack configuration token (or prints the lines to paste), then opens Reinstall and waits|kage slack upgrade
Set up|link||Put the kage command on your PATH (~/.local/bin/kage)|./setup.sh link
Set up|service|on or off|Let macOS or Linux keep Kage running: back after a crash, a reboot or a login|kage service on
Run|start|[kagelet]|Start Kage in the background (turns the service on the first time). With a kagelet: run it again after kage stop|kage start
Run|stop|[thread or kagelet] [--now or --cut-running]|Stop Kage once every running turn ends, or now with --cut-running. With a thread (link, place or key): end only its session, after its turn or --now. With a kagelet: pause it and keep its file|kage stop support
Run|restart|[--cut-running]|Restart the hub once every running turn ends; new messages wait and run after it|kage restart
Run|update|[--stable]|Pull the newest Kage now (or the latest release with --stable) and restart into it at the next quiet moment; local changes are left as they are|kage update
Run|reload||Read the settings files again with no restart: who may tag Kage changes at once|kage reload
Run|set|key value|Change one setting in config.json, such as harness.maxSessions. A list is JSON|kage set harness.maxSessions 6
Run|status||One look at every session and what it is doing|kage status
Run|logs|[lines, -f or kagelet]|Follow the hub log live, with the steps of every session (tools, replies), like tail -f. A number prints that many lines and exits. With a kagelet: its last runs, newest first, with cost, ok or failed, and its report|kage logs 200
Run|run||Run the hub in the foreground for a supervisor other than launchd or systemd (Docker: --init); output goes to kage logs|kage run
Run|cost|[days]|What each thread spent, most first (1 day unless you say)|kage cost 7
Run|telemetry|[show]|What this Kage sends and where: on or off, the endpoint, and the next batch with show|kage telemetry show
Run|stats|[days]|Spend per day and per connector, runs, refusals, turn time and hub starts (7 days unless you say)|kage stats 30
Run|release|[--dry-run]|Tag the next version on main, publish its notes and move the stable tag that installs follow (repo admin only). --dry-run prints the version and notes and changes nothing|kage release --dry-run
Run|dream|undo|Put the memory back to how it was before the last weekly dream|kage dream undo
Watch|schedules||Every schedule and reply watch, in every thread|kage schedules
Watch|top||The live console: every thread, its feed, attach and stop, by mouse or keys|kage top
Watch|watch|[place]|Follow every step every session takes, as it happens|kage watch support
Watch|attach|[place or link]|Take a thread into this terminal, by its place or its Slack link in quotes; Kage gets it back when you quit|kage attach "https://example.slack.com/archives/C0123ABC/p1700000000123456"
People|add|<person>, <app id> <owner>, kagelet <name> or browser|Let a person tag Kage (a mention, member id, email, name or @handle), or an agent with the person or agent it answers to. kagelet <name> writes a paused starter file for a kagelet. browser turns Kage in Chrome on and prints the token for its extension|kage add priya
People|remove|<person or app id>|Take a person or an agent off the list; whoever answers to them goes too|kage remove priya
People|list||Who may tag Kage besides you: each person, with their agents under them. Then the kagelets Kage manages: schedule, last and next run, cost today|kage list
People|tell|<place> <message>|Tell a thread something as you; its session takes it after the current turn|kage tell support use the staging db
People|relay|allow <place or key>, deny <same> or list|Let one thread use the SSM relay (ssh to hosts behind AWS SSM) though a teammate asked for its work. list shows who may|kage relay allow prod-monitor
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

kage_name() { NAME="$(cfg_get name)"; NAME="${NAME:-kage}"; }
# compat: remove after 2026-12-15: a hub started before the service existed runs in a tmux session (start.sh). kage service on moves it.
old_tmux() { command -v tmux >/dev/null && tmux has-session -t "=$NAME" 2>/dev/null; }
running() { kage_name; ./service.sh running 2>/dev/null || old_tmux; }
# The hub writes the status file (connectors/slack.ts): its first word is the socket's state, its fourth the hub's pid.
connected() {
  local st; st="$(dirname "$ENV_FILE")/status"
  [[ -f $st && $(awk '{print $1}' "$st") == connected ]] && ps -p "$(awk '{print $4}' "$st")" >/dev/null 2>&1
}
LOG="$(dirname "$ENV_FILE")/hub.log"

cmd_start() {
  kage_name
  if ./service.sh installed; then ./service.sh start
  else ./service.sh on || return 1; fi
  says "Starting up. Give me about 20 seconds."
  next "Check on me:" "kage doctor"
  if [[ "$(cfg_get harness.runtime)" == tmux && "$(cfg_get harness.route)" != plugin ]]; then
    echo "Threads open as tmux panes (dev route): each new pane shows a warning screen. Confirm it in tmux attach -t $NAME."
  fi
}

cmd_stop() {
  kage_name
  quiet_first stop "$@"
  if ./service.sh installed; then ./service.sh stop
  elif old_tmux; then tmux kill-session -t "=$NAME"
  else says "I'm not running."; return 0; fi
  says "Stopped. I stay down until kage start or your next login."
  quietly "Each thread picks up where it left off when someone tags me."
}

# kage update: move this checkout to origin's main (or the stable release with --stable) and restart into it now,
# without waiting for auto-update or a quiet moment. Only a fast-forward: local changes or commits are refused.
cmd_update() {
  local ref=origin/main old new
  [[ "${1:-}" == --stable ]] && ref=stable
  [[ -z "${1:-}" || "${1:-}" == --stable ]] || die "kage update takes nothing, or --stable for the latest release."
  [[ -z "${KAGE_CLAUDE:-}" ]] || die "This shell runs inside Kage, so kage update would end this session too. Run it in your own terminal."
  [[ -d .git ]] || die "This install is not a git checkout. Run the install line again to update it."
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "This checkout has local changes, so it was left as it is: $(git status --porcelain --untracked-files=no | awk '{print $2}' | tr '\n' ' ')"
  # --force: the stable tag moves with each release, and git keeps a moved tag's old copy without it.
  git fetch -q --force origin main --tags
  [[ "$(git rev-list --count "$ref..HEAD")" == 0 ]] || die "This checkout has commits that are not on $ref, so it was left as it is."
  old="$(git rev-parse --short HEAD)"
  [[ "$(git rev-parse HEAD)" != "$(git rev-parse "$ref^{commit}")" ]] || { says "I'm already on the newest version."; return; }
  # A running hub restarts into the new code at its next quiet moment and runs npm ci itself first (hub/updates.ts), so update
  # never drains: a drain held every new message until each running turn ended (#309). No node runs after the merge, because
  # node beside the hub's npm ci crashes on a half-deleted package (#302); running is asked first for that reason.
  local packages="" up=""
  git diff --quiet HEAD "$ref" -- package-lock.json || packages=1
  running && up=1
  git merge -q --ff-only "$ref"
  new="$(git rev-parse --short HEAD)"
  says "Got the new version. ${DIM}($new)${OFF}"
  if [[ -n $up ]]; then quietly "I'll switch over when I'm not in the middle of anything${packages:+, after I install what it needs}."; fi
  whats_new "$old..$new"
  [[ -n $up ]] && return
  if [[ -n $packages ]]; then
    quietly "Installing what the new version needs."
    npm ci --no-audit --no-fund --loglevel=error || die "Installing failed. Run npm ci in $PWD, then kage start."
  fi
  echo; next "I'm not running. Start me:" "kage start"
}

sentence() { [[ $1 == kage\ * ]] && printf %s "$1" || printf %s "$(printf %s "${1:0:1}" | tr '[:lower:]' '[:upper:]')${1:1}"; }

# What a person gets from an update: the feat and fix commits, without their type, scope or PR number.
whats_new() {
  local new fixed
  new="$(git log --format=%s "$1" | sed -nE 's/^feat(\([^)]*\))?!?: //p' | sed -E 's/ \(#[0-9]+\)$//')"
  fixed="$(git log --format=%s "$1" | sed -nE 's/^fix(\([^)]*\))?!?: //p' | sed -E 's/ \(#[0-9]+\)$//')"
  if [[ -z $new && -z $fixed ]]; then quietly "Only changes under the hood this time."; return; fi
  if [[ -n $new ]]; then echo; echo "  What's new for you"; while IFS= read -r l; do point "$(sentence "$l")"; done <<<"$new"; fi
  if [[ -n $fixed ]]; then echo; echo "  Fixed"; while IFS= read -r l; do point "$(sentence "$l")"; done <<<"$fixed"; fi
}

# A change to KAGE_ROUTE, KAGE_RUNTIME, KAGE_CWD or KAGE_MEMORY needs kage stop, then kage start.
cmd_restart() {
  quiet_first restart "$@"
  running || { says "I'm not running."; next "Start me:" "kage start"; return 1; }
  if ./service.sh installed; then ./service.sh restart && says "Restarting. I'll be back in about 10 seconds."; return; fi
  # The old tmux loop starts the hub again 5 s after it exits.
  local pid; pid="$(awk '{print $4}' "$(dirname "$ENV_FILE")/status" 2>/dev/null || true)"
  # The status file outlives the hub; never kill a pid that is now some other program.
  if [[ -n $pid ]] && ps -p "$pid" -o command= 2>/dev/null | grep -q 'router.ts'; then
    kill "$pid" && says "Restarting. I'll be back in about 10 seconds."
  else
    tells "I'm between restarts. Give me 10 seconds, then try kage status."; return 1
  fi
}

cmd_status() {
  running || { says "I'm not running."; next "Start me:" "kage start"; return 1; }
  node cli/status.ts
}

# The version the hub read at its start (hub/router.ts writes it), and the version of the code on disk.
running_version() { cat "$(dirname "$ENV_FILE")/version" 2>/dev/null || echo unknown; }
disk_version() { node -e 'import("./runtime/auto-update.ts").then(m=>console.log(m.version(process.cwd())))'; }
cmd_version() {
  local disk run; disk="$(disk_version)"; run="$(running_version)"
  echo "kage $disk"
  if running && [[ $run != unknown && $run != "$disk" ]]; then quietly "I'm still running ${run%% *}. I'll switch over when I'm not in the middle of anything."; fi
}

cmd_logs() {
  kage_name
  # No argument (or -f): follow the hub log and every session's steps live, like tail -f (cli/watch.ts --hub).
  # A number prints that many lines of the hub log and exits.
  if [[ -z "${1:-}" || "${1:-}" == -f ]]; then [[ -f $LOG ]] || die "No hub log yet: $LOG"; exec node cli/watch.ts --hub; fi
  local n="$1"; [[ $n =~ ^[0-9]+$ ]] || die "kage logs follows the log live. Give a number, like kage logs 200, to print that many lines and exit"
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
  if [[ "$(cfg_get harness.runtime)" == tmux ]]; then
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

# Settings come from config.json and secrets.json (cli/config.ts); an unset one prints nothing.
cfg_get() { node cli/config.ts get "$1" 2>/dev/null || true; }
has_settings() { [[ -f "$(dirname "$ENV_FILE")/config.json" || -f "$ENV_FILE" ]]; }

cmd_save() {
  valid_name "${1:-$(cfg_get name)}"
  # Tokens arrive on stdin in any order, one per line or space separated. Each is sorted by its prefix.
  local APP="" USR="" BOT="" t input
  if [[ -t 0 ]]; then  # a person at a terminal: hidden prompts, so the tokens never show
    local a u b
    a="$(node cli/ask-secret.ts app "App-level token (xapp-...): ")" || exit 1
    u="$(node cli/ask-secret.ts user "User OAuth token (xoxp-...): ")" || exit 1
    b="$(node cli/ask-secret.ts bot "Bot token (xoxb-...): ")" || exit 1
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
  # The tokens go to secrets.json and the name to config.json; every other setting stays (cli/config.ts). printf is a
  # builtin, so the tokens never show in `ps`.
  printf '%s %s %s\n' "$APP" "$USR" "$BOT" | node cli/config.ts save "$NAME" || die "Could not write the settings in $(dirname "$ENV_FILE")."
  says "Saved. I'm @$NAME, and I answer to you ($OWNER)."
  quietly "The tokens are in $(dirname "$ENV_FILE")/secrets.json, readable only by you."
}

# Kage's own Claude login, so its sessions use their own seat. The prompt is hidden, so the token never shows on screen or in ps.
cmd_claude_login() {
  local t
  if [[ -t 0 ]]; then
    tells "Run claude setup-token signed in as my own Claude account, then paste the token it prints."
    t="$(node cli/ask-secret.ts claude "Claude token (sk-ant-oat...): ")" || exit 1
  else
    t="$(cat)"
  fi
  umask 077
  printf '%s\n' "$t" | node cli/config.ts save-claude || exit 1
  says "Saved. I'll switch to this Claude login when I'm not in the middle of anything."
}

cmd_interactive() {
  say "1/5  Checking tools"; cmd_check
  say "2/5  Pick a name"; read -r -p "What do you call it in Slack? [kage] " n; valid_name "$n"
  say "3/5  Create your Slack app"; cmd_app "$NAME"
  read -r -p "Press Enter when you have the three tokens. "
  say "4/5  Save your tokens"; cmd_save "$NAME"
  say "5/5  Start it"; cmd_start >/dev/null
  # The first start installs the Agent SDK before the hub runs, so the wait covers only the connect.
  local wait="${KAGE_SETUP_WAIT:-90}" i
  echo "Waiting for Slack to connect (up to $wait s)..."
  for ((i = 0; i < wait; i += 2)); do connected && break; sleep 2; done
  connected || die "Not connected to Slack after $wait s. Run kage doctor: it names the fix for each problem."
  echo; says "Connected to Slack. Tag @$NAME in any thread to try it."
  command -v kage >/dev/null || echo "To type kage from anywhere, run ./setup.sh link once."
}

# Help comes first, so "kage add --help" never reaches a command that would act on it.
[[ "${1:-}" == --version ]] && { cmd_version; exit 0; }
for a in "$@"; do [[ $a == -h || $a == --help ]] && { [[ $1 == "$a" || $1 == help ]] && cmd_help || cmd_help "$1"; exit 0; }; done

case "${1:-}" in
  "") if has_settings; then { running && says "I'm running." || { says "I'm not running."; next "Start me:" "kage start"; }; echo; cmd_short; }; else cmd_interactive; fi ;;
  help) cmd_help "${2:-}" ;;
  setup) cmd_interactive ;;
  check) cmd_check ;;
  app) cmd_app "${2:-}" ;;
  save) cmd_save "${2:-}" ;;
  claude-login) cmd_claude_login ;;
  doctor) node cli/doctor/run.ts ;;
  slack) node cli/slack.ts "${2:-}" ;;
  link) mkdir -p ~/.local/bin && ln -sf "$PWD/setup.sh" ~/.local/bin/kage && says "Done. You can type kage from anywhere (it needs ~/.local/bin on your PATH)." ;;
  service) ./service.sh "${2:-}" ;;
  run) NODE_OPTIONS="$HUB_NODE_OPTIONS" exec node hub.ts ;;
  # A kagelet's name: resume it (cli/stop.ts). Otherwise the hub.
  start) if [[ $# -gt 1 ]]; then node cli/stop.ts --resume "${@:2}"; else cmd_start; fi ;;
  # A thread (any word that is not a flag) or --now: one session (cli/stop.ts). Otherwise the whole hub.
  stop) if [[ " ${*:2} " == *" --now "* ]] || { [[ $# -gt 1 ]] && printf '%s\n' "${@:2}" | grep -qv '^--'; }; then node cli/stop.ts "${@:2}"; else cmd_stop "${@:2}"; fi ;;
  restart) cmd_restart "${@:2}" ;;
  update) cmd_update "${@:2}" ;;
  reload) node cli/reload.ts ;;
  set) node cli/config.ts set "${@:2}" ;;
  status) cmd_status ;;
  # A kagelet's name (it starts with a letter): its runs (cli/kagelet-logs.ts). Otherwise the hub log.
  logs) if [[ ${2:-} =~ ^[a-z] ]]; then node cli/kagelet-logs.ts "$2"; else cmd_logs "${2:-}"; fi ;;
  cost) node cli/cost.ts "${@:2}" ;;
  stats) node cli/stats.ts "${@:2}" ;;
  telemetry) node cli/telemetry.ts "${@:2}" ;;
  schedules) node cli/schedules.ts ;;
  release) node cli/release.ts "${@:2}" ;;
  dream) node cli/dream.ts "${@:2}" ;;
  top) node cli/top.ts "${@:2}" ;;
  watch) node cli/watch.ts "${@:2}" ;;
  attach) node cli/attach.ts "${@:2}" ;;
  tell) node cli/tell.ts "${@:2}" ;;
  relay) node cli/relay.ts "${@:2}" ;;
  add) node cli/registry.ts "$@" ;;
  remove) node cli/registry.ts "$@" ;;
  list) node cli/registry.ts "$@" ;;
  call) node cli/call.ts ;;
  export-crons) node cli/export-crons.ts "${@:2}" ;;   # one-time move of CronCreate jobs out of tmux panes; not in help
  *) unknown "$1" ;;
esac
