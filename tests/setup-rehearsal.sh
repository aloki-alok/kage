#!/usr/bin/env bash
# Rehearse a first install and setup as a new person sees it, from this checkout's working tree (uncommitted
# changes included). Run it in a real terminal: tests/setup-rehearsal.sh
# Everything happens in a throwaway HOME. Slack is a stand-in on 127.0.0.1 that hands out fake tokens, and
# open, launchctl and tmux are stand-ins too, so your real Kage, its LaunchAgent and its tmux session are never touched.
set -euo pipefail
[[ $(uname -s) == Darwin ]] || { echo "The rehearsal stands in for launchd, so it runs on macOS only." >&2; exit 1; }
{ : </dev/tty; } 2>/dev/null || { echo "Run it in a terminal: the setup asks you questions." >&2; exit 1; }
repo="$(cd "$(dirname "$0")/.." && pwd)"
root="$(mktemp -d "${TMPDIR:-/tmp}/kage-rehearsal.XXXXXX")"
home="$root/home" shims="$root/shims"
mkdir -p "$home" "$shims"
slack_pid=""
cleanup() {
  [[ -n $slack_pid ]] && kill "$slack_pid" 2>/dev/null
  [[ -f $root/hub.pid ]] && kill "$(cat "$root/hub.pid")" 2>/dev/null
  rm -rf "$root"
}
trap cleanup EXIT

# The stand-in Slack prints its port on its first line.
node "$repo/tests/fake-slack.ts" > "$root/slack.port" &
slack_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [[ -s $root/slack.port ]] && break; sleep 0.1; done
port="$(head -1 "$root/slack.port")"
[[ -n $port ]] || { echo "The stand-in Slack did not start." >&2; exit 1; }

# open: a Slack page goes to the stand-in, anything else opens as usual.
cat > "$shims/open" <<SH
#!/bin/sh
case "\$1" in https://api.slack.com/*) exec /usr/bin/open "http://127.0.0.1:$port/\${1#https://api.slack.com/}" ;; esac
exec /usr/bin/open "\$@"
SH
# tmux: no session exists here, so the service never stops your real one.
printf '#!/bin/sh\nexit 1\n' > "$shims/tmux"
# launchctl: bootstrap starts a stand-in hub that says connected after 3 s, as the real hub writes its status line.
cat > "$shims/launchctl" <<SH
#!/bin/bash
pidf="$root/hub.pid"
alive() { [[ -f \$pidf ]] && kill -0 "\$(cat "\$pidf")" 2>/dev/null; }
case "\$1" in
  print) alive && echo "state = running" && exit 0; exit 113 ;;
  bootstrap|kickstart)
    alive && exit 0
    name="\$(basename "\${!#}" .plist)"; name="\${name##*.}"
    sh -c 'sleep 3; printf "connected %s pid %s as @%s\n" "\$(date -u +%FT%TZ)" "\$\$" "\$1" > "$home/.config/kage/status"; exec sleep 86400' _ "\$name" &
    echo \$! > "\$pidf" ;;
  bootout) alive && kill "\$(cat "\$pidf")"; rm -f "\$pidf" ;;
esac
exit 0
SH
chmod +x "$shims/open" "$shims/tmux" "$shims/launchctl"

# The working tree as the tarball the install line would download.
(cd "$repo" && git ls-files -z -co --exclude-standard | tar --null -T - -s ',^,kage/,' -czf "$root/kage.tar.gz")

printf '\033[2mRehearsal in %s. Slack is a stand-in at http://127.0.0.1:%s\033[0m\n\n' "$root" "$port"
env -i HOME="$home" PATH="$shims:$PATH" TERM="${TERM:-xterm-256color}" COLORTERM="${COLORTERM:-}" LANG="${LANG:-en_US.UTF-8}" \
  SHELL=/bin/zsh npm_config_cache="$HOME/.npm" KAGE_TARBALL="$root/kage.tar.gz" KAGE_SLACK_API="http://127.0.0.1:$port/api" \
  bash "$repo/install.sh"
printf '\n\033[2mRehearsal over. Its folder is deleted, and nothing outside it changed.\033[0m\n'
