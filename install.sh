#!/usr/bin/env bash
# Installs Kage with one line:
#   curl -fsSL https://raw.githubusercontent.com/aloki-alok/kage/main/install.sh | bash
# It gets the code, installs its packages, puts `kage` on your PATH, then starts the setup.
# With git, the code is a git checkout of main, which updates itself to origin's stable tag (autoUpdate in config.json). Without git, it is
# a tarball, which updates only when you run this again. Your settings in ~/.config/kage stay as they are.
set -euo pipefail
REPO=aloki-alok/kage
REF="${KAGE_REF:-main}"
DIR="${KAGE_DIR:-$HOME/.local/share/kage}"   # the code
BIN="${KAGE_BIN:-$HOME/.local/bin}"          # where the kage command goes

# The same rail and marks as kage setup, which runs next: teal for Kage's work, amber for what needs the person.
if [[ -t 1 ]]; then MARK=$'\033[38;2;45;190;160m✦\033[0m' WAIT=$'\033[38;2;230;145;40m◆\033[0m' DIM=$'\033[2m' OFF=$'\033[0m'
else MARK='✦' WAIT='◆' DIM='' OFF=''; fi
say() { printf '  %s  %-12s %s%s%s\n' "$MARK" "$1" "$DIM" "${2:-}" "$OFF"; }
die() { printf '  %s  %s\n' "$WAIT" "$*" >&2; exit 1; }
short() { local t='~'; if [[ $1 == "$HOME" || $1 == "$HOME"/* ]]; then printf '%s' "$t${1#"$HOME"}"; else printf '%s' "$1"; fi; }

command -v curl >/dev/null && command -v tar >/dev/null || die "curl and tar are required."

mkdir -p "$DIR"
# KAGE_TARBALL: a local .tar.gz instead of GitHub, for testing the tarball route. KAGE_GIT_URL: the same for git.
if [[ -e "$DIR/.git" ]]; then
  # A checkout updates by fast-forward only, so a working copy with its own commits or edits stops here.
  say "Updating" "$(short "$DIR")"
  git -C "$DIR" pull -q --ff-only origin "$REF" || die "$DIR has changes of its own, so it was left as it is. Update it there with git pull."
elif command -v git >/dev/null && [[ -z "${KAGE_TARBALL:-}" ]]; then
  # A clone next to the folder, then its .git moves in: a fresh folder and an old tarball install take the
  # same route, and a tarball install keeps node_modules. A file the tarball had that main dropped stays, unused.
  say "Getting Kage" "$(short "$DIR")"
  # The clone sits inside the folder, so the move stays on one disk and cannot leave half a .git behind.
  tmp="$(mktemp -d "$DIR/.kage-clone.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  git clone -q --depth 1 --no-checkout --branch "$REF" "${KAGE_GIT_URL:-https://github.com/$REPO.git}" "$tmp/kage"
  mv "$tmp/kage/.git" "$DIR/.git"
  git -C "$DIR" reset -q --hard
else
  say "Getting Kage" "$(short "$DIR") (no git, so it updates when you run this again)"
  if [[ -n "${KAGE_TARBALL:-}" ]]; then tar -xzf "$KAGE_TARBALL" --strip-components=1 -C "$DIR"
  else curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz --strip-components=1 -C "$DIR"; fi
fi

# setup.sh check holds the one Node and Claude Code check (#120).
"$DIR/setup.sh" check >/dev/null || exit 1
npm_out="$(cd "$DIR" && npm ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error 2>&1)" \
  || die "npm ci failed in $(short "$DIR"):"$'\n'"$npm_out"
say "Packages" "ready"

mkdir -p "$BIN" && ln -sf "$DIR/setup.sh" "$BIN/kage"
# Add the folder to PATH once, in the shell the person uses, unless it is already there.
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) rc="$HOME/.$(basename "${SHELL:-bash}")rc"
     if ! grep -qs "$BIN" "$rc"; then
       printf '\n# Kage command\nexport PATH="%s:$PATH"\n' "$BIN" >> "$rc"
       say "PATH" "kage added in $(short "$rc"), for new terminals"
     fi ;;
esac

if [[ -f "${KAGE_ENV:-$HOME/.config/kage/env}" || -f "$(dirname "${KAGE_ENV:-$HOME/.config/kage/env}")/config.json" ]]; then
  say "Up to date" "If Kage is running, kage restart picks up the new code."
# A coding agent's shell has no terminal: /dev/tty passes -r there but fails to open, so test the open itself.
elif { : </dev/tty; } 2>/dev/null; then
  # Under curl | bash, stdin is this script, so the setup questions read the terminal instead.
  "$BIN/kage" setup </dev/tty
else
  echo "Installed. To connect it to Slack, run kage setup in a terminal."
  echo "Coding agent: follow $DIR/CLAUDE.md from step 1."
fi
