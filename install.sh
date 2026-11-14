#!/usr/bin/env bash
# Installs Kage with one line:
#   curl -fsSL https://raw.githubusercontent.com/aloki-alok/kage/main/install.sh | bash
# It gets the code, installs its packages, puts `kage` on your PATH, then starts the setup.
# With git, the code is a git checkout of main, which updates itself to origin's stable tag (KAGE_AUTO_UPDATE). Without git, it is
# a tarball, which updates only when you run this again. Your settings in ~/.config/kage stay as they are.
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

mkdir -p "$DIR"
# KAGE_TARBALL: a local .tar.gz instead of GitHub, for testing the tarball route. KAGE_GIT_URL: the same for git.
if [[ -e "$DIR/.git" ]]; then
  # A checkout updates by fast-forward only, so a working copy with its own commits or edits stops here.
  say "Updating the git checkout in $DIR"
  git -C "$DIR" pull -q --ff-only origin "$REF" || die "$DIR has changes of its own, so it was left as it is. Update it there with git pull."
elif command -v git >/dev/null && [[ -z "${KAGE_TARBALL:-}" ]]; then
  # A clone next to the folder, then its .git moves in: a fresh folder and an old tarball install take the
  # same route, and a tarball install keeps node_modules. A file the tarball had that main dropped stays, unused.
  say "Getting Kage ($REF) with git into $DIR"
  # The clone sits inside the folder, so the move stays on one disk and cannot leave half a .git behind.
  tmp="$(mktemp -d "$DIR/.kage-clone.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  git clone -q --depth 1 --no-checkout --branch "$REF" "${KAGE_GIT_URL:-https://github.com/$REPO.git}" "$tmp/kage"
  mv "$tmp/kage/.git" "$DIR/.git"
  git -C "$DIR" reset -q --hard
else
  say "Downloading Kage ($REF) to $DIR (no git, so it updates only when you run this again)"
  if [[ -n "${KAGE_TARBALL:-}" ]]; then tar -xzf "$KAGE_TARBALL" --strip-components=1 -C "$DIR"
  else curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz --strip-components=1 -C "$DIR"; fi
fi

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
