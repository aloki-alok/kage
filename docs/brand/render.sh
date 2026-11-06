#!/usr/bin/env bash
# Renders docs/brand/brand.html into the PNGs the README and Slack use. Needs Google Chrome and a network (Google Fonts).
set -euo pipefail
cd "$(dirname "$0")"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
shot() { "$chrome" --headless=new --hide-scrollbars --force-device-scale-factor="$3" --default-background-color=00000000 --virtual-time-budget=8000 --window-size="$2" --screenshot="$PWD/$1.png" "file://$PWD/brand.html#$1" 2>/dev/null; }
shot icon-light 512,512 1
shot icon-dark 512,512 1
shot hero-light 1280,560 2
shot hero-dark 1280,560 2
shot og 1200,630 1   # copy to og.png on the gh-pages branch
ls -la ./*.png
