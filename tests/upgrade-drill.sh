#!/usr/bin/env bash
# The upgrade a teammate makes (#312): install the previous release with its own install line, keep an old-style env
# file, move to this checkout's commit with `kage update --stable`, then check the settings and `kage doctor`.
# Run from the repo root of the candidate. Nothing here reaches GitHub: origin is a local bare copy of this repo.
#   tests/upgrade-drill.sh [previous tag]    the default is the newest v* tag before HEAD
# KAGE_DRILL_PATH: the PATH the kage commands get (CI passes a minimal one). node and a stand-in claude are added to it.
set -euo pipefail
say() { printf '\n== %s\n' "$*"; }
die() { printf 'upgrade drill FAILED: %s\n' "$*" >&2; exit 1; }

repo="$PWD"
candidate="$(git rev-parse HEAD)"
prev="${1:-$(git tag --merged HEAD --no-contains HEAD --sort=-v:refname --list 'v*' | head -1)}"
[[ -n $prev ]] || die "no earlier v* tag to upgrade from (CI needs fetch-depth: 0)"
prev_sha="$(git rev-parse "$prev^{commit}")"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
home="$root/home" bin="$root/bin" origin="$root/origin.git" dir="$root/home/.local/share/kage"
mkdir -p "$home/.config/kage" "$bin"
# Claude Code is not installed on CI: the installer and the doctor only look for it on PATH.
printf '#!/bin/sh\necho 1.0.0\n' > "$bin/claude"; chmod +x "$bin/claude"
drill_path="$bin:$(dirname "$(command -v node)"):${KAGE_DRILL_PATH:-$PATH}"
run() { env -i HOME="$home" PATH="$drill_path" SHELL=/bin/bash LANG=C.UTF-8 "$@"; }

say "Previous release $prev, candidate ${candidate:0:7}"
git clone -q --bare --no-tags "$repo" "$origin"
say "A teammate's env file from before config.json, with their own keys (#300)"
cat > "$home/.config/kage/env" <<'ENV'
KAGE_NAME=drill
SLACK_APP_TOKEN=xapp-drill-not-real
SLACK_USER_TOKEN=xoxp-drill-not-real
SLACK_BOT_TOKEN=xoxb-drill-not-real
KAGE_MAX_SESSIONS=3
KAGE_SHARED_TOOLS=mcp__slack__slack_read_
KAGE_MAX_SPECIALISTS=2
KAGE_AUTO_UPDATE=off
MY_TOOL_API_KEY=drill-key-1234
MY_PLAIN_FLAG=on
ENV
chmod 600 "$home/.config/kage/env"
cp "$home/.config/kage/env" "$root/env.before"
# What a teammate saw before this release: main and stable on the previous release, installed by its own install line.
git -C "$origin" update-ref refs/heads/main "$prev_sha"
git -C "$origin" tag -f stable "$prev_sha" >/dev/null
git show "$prev:install.sh" > "$root/install.sh"
run KAGE_GIT_URL="file://$origin" bash "$root/install.sh" </dev/null || die "the $prev install line failed"
[[ -L $home/.local/bin/kage ]] || die "the install put no kage command in ~/.local/bin"


say "The release moves stable to the candidate, and the teammate runs kage update --stable"
git -C "$origin" fetch -q "$repo" "+$candidate:refs/heads/main"
git -C "$origin" tag -f stable "$candidate" >/dev/null
(cd "$dir" && run "$home/.local/bin/kage" update --stable) || die "kage update --stable failed"
[[ "$(git -C "$dir" rev-parse HEAD)" == "$candidate" ]] || die "the checkout is on $(git -C "$dir" rev-parse --short HEAD), not ${candidate:0:7}"

say "The hub's first start imports the env file and loads"
# Its fake Slack tokens keep it from connecting, so it runs a few seconds and is stopped. Its log says what it did.
(cd "$dir" && run node hub.ts > "$root/hub.out" 2>&1 & pid=$!; sleep 20; kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null) || true
log="$(cat "$home/.config/kage/hub.log" "$root/hub.out" 2>/dev/null || true)"
grep -q 'imported the env file' <<<"$log" || { printf '%s\n' "$log" | tail -30; die "the hub did not import the env file"; }
! grep -Eq 'could not (load|import|export)|ERR_MODULE_NOT_FOUND' <<<"$log" || { printf '%s\n' "$log" | tail -30; die "the hub could not start on the new code"; }
(cd "$dir" && run node tests/upgrade-env-kept.ts "$home/.config/kage" "$root/env.before") || die "a setting was lost in the import"

say "kage doctor"
# CI has no Slack or service, so those lines fail. The drill fails only when a check group could not run or node crashed.
out="$(cd "$dir" && run "$home/.local/bin/kage" doctor 2>&1)" && code=0 || code=$?
printf '%s\n' "$out"
[[ $code -le 1 ]] || die "kage doctor exited $code"
grep -q '^ok *tools:' <<<"$out" || die "kage doctor printed no ok tools line"
! grep -Eq 'the check did not run|ERR_[A-Z_]+|^ *at .*\.(ts|js):[0-9]+' <<<"$out" || die "kage doctor crashed or skipped a check group"
say "upgrade drill passed: $prev to ${candidate:0:7}"
