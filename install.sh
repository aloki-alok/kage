#!/usr/bin/env bash
# Installs Kage with one line, no git needed:
#   curl -fsSL https://raw.githubusercontent.com/aloki-alok/kage/main/install.sh | bash
# It downloads the code, installs its packages, puts `kage` on your PATH, then starts the setup.
# Run it again to update: your settings in ~/.config/kage stay as they are.
set -euo pipefail
REPO=aloki-alok/kage
REF="${KAGE_REF:-main}"
DIR="${KAGE_DIR:-$HOME/.local/share/kage}"   # the code
BIN="${KAGE_BIN:-$HOME/.local/bin}"          # where the kage command goes

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "Checking tools"
command -v curl >/dev/null && command -v tar >/dev/null || die "curl and tar are required."
command -v node >/dev/null || die "Node.js 22.18 or newer is required: https://nodejs.org (macOS: brew install node)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || die "Node $(node -v) is too old: Kage needs 22.18 or newer (macOS: brew upgrade node)."
command -v tmux >/dev/null || say "No tmux: fine, unless you set KAGE_RUNTIME=tmux."
command -v claude >/dev/null || die "Claude Code is required: https://code.claude.com/docs/en/quickstart"

# A git checkout is someone's working copy: updating it is git's job, not ours.
[[ -d "$DIR/.git" ]] && die "$DIR is a git checkout. Update it there with git pull."

say "Downloading Kage ($REF) to $DIR"
mkdir -p "$DIR"
# KAGE_TARBALL: a local .tar.gz instead of GitHub, for testing this script.
if [[ -n "${KAGE_TARBALL:-}" ]]; then tar -xzf "$KAGE_TARBALL" --strip-components=1 -C "$DIR"
else curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz --strip-components=1 -C "$DIR"; fi

say "Installing packages"
(cd "$DIR" && npm ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error)

mkdir -p "$BIN" && ln -sf "$DIR/setup.sh" "$BIN/kage"
# Add the folder to PATH once, in the shell the person uses, unless it is already there.
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) rc="$HOME/.$(basename "${SHELL:-bash}")rc"
     if ! grep -qs "$BIN" "$rc"; then
       printf '\n# Kage command\nexport PATH="%s:$PATH"\n' "$BIN" >> "$rc"
       say "Added $BIN to PATH in $rc."
     fi
     say "Open a new terminal to type kage, or run: export PATH=\"$BIN:\$PATH\"" ;;
esac

if [[ -f "${KAGE_ENV:-$HOME/.config/kage/env}" ]]; then
  say "Kage is up to date. If it is running, kage restart picks up the new code."
elif [[ -r /dev/tty ]]; then
  say "Setting up"
  # Under curl | bash, stdin is this script, so the setup questions read the terminal instead.
  "$BIN/kage" setup </dev/tty
else
  say "Installed. Run kage setup to connect it to Slack."
fi
