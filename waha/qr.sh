#!/bin/sh
# Links your phone to Kage's WhatsApp bridge: starts WAHA's default session, shows its QR code, and waits until it works.
# Run it after the container is up (docker compose -f waha/compose.yaml up -d). Steps: docs/settings.md, "WhatsApp".
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONF=$(dirname "${KAGE_ENV:-$HOME/.config/kage/env}")
URL=$(cd "$ROOT" && node cli/config.ts get connectors.whatsapp.wahaUrl 2>/dev/null || true)
URL=${URL:-http://127.0.0.1:3198}
KEY=$(sed -n 's/^WAHA_API_KEY=//p' "$CONF/waha/.env" 2>/dev/null || true)
die() { echo "kage: $*" >&2; exit 1; }
[ -n "$KEY" ] || die "no WAHA_API_KEY in $CONF/waha/.env. Add the waha keys to secrets.json, then run kage restart."

api() { curl -sS --max-time 10 -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' "$@"; }
# One field of a JSON answer on stdin, or nothing.
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s)[process.argv[1]]??""))}catch{}})' "$1"; }
status() { api "$URL/api/sessions/default" 2>/dev/null | field status; }

api "$URL/ping" >/dev/null 2>&1 || die "the bridge does not answer at $URL. Start it: docker compose -f $ROOT/waha/compose.yaml up -d"
s=$(status)
[ "$s" = WORKING ] && { echo "ok: WhatsApp is already linked and WORKING."; exit 0; }

echo "WhatsApp does not allow unofficial clients such as WAHA, so the number you link can be banned."
echo "Link a number only if you accept that risk."
printf 'Type yes to link a phone: '
read -r answer || answer=
[ "$answer" = yes ] || die "nothing linked."

case "$s" in
  '') api -X POST "$URL/api/sessions" -d '{"name":"default","start":true}' >/dev/null ;;
  STOPPED) api -X POST "$URL/api/sessions/default/start" >/dev/null ;;
  FAILED) api -X POST "$URL/api/sessions/default/restart" >/dev/null ;;
esac

# The code changes about every 20 s, so show the newest one until the phone links (about 3 minutes at most).
tries=0 shown=-10
while [ $tries -lt 90 ]; do
  s=$(status)
  [ "$s" = WORKING ] && { echo "ok: WhatsApp linked. Run kage doctor to check it."; exit 0; }
  if [ "$s" = SCAN_QR_CODE ] && [ $((tries - shown)) -ge 10 ]; then
    shown=$tries
    code=$(api "$URL/api/default/auth/qr?format=raw" | field value)
    echo "On your phone: WhatsApp > Settings > Linked devices > Link a device, then scan this code."
    if command -v qrencode >/dev/null 2>&1 && [ -n "$code" ]; then qrencode -t ansiutf8 "$code"
    else
      png="${TMPDIR:-/tmp}/kage-waha-qr.png"
      api -H 'Accept: image/png' "$URL/api/default/auth/qr?format=image" -o "$png"
      echo "The code is in $png (install qrencode to see it here)."
      if command -v open >/dev/null 2>&1; then open "$png"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$png" >/dev/null 2>&1 || true; fi
    fi
  fi
  tries=$((tries + 1))
  sleep 2
done
die "the session is $(status), not WORKING. Run this script again, or docker logs kage-waha to see why."
