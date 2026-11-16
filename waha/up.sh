#!/bin/sh
# Starts Kage's WhatsApp bridge with the ports and the config folder from Kage's settings, so the container and the hub agree.
# Run it again after you change connectors.whatsapp.wahaUrl or connectors.whatsapp.hookPort. Steps: docs/settings.md, "WhatsApp".
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
get() { (cd "$ROOT" && node cli/config.ts get "$1" 2>/dev/null) || true; }
# The defaults match connectors/whatsapp.ts: wahaUrl http://127.0.0.1:3198, hookPort 3199.
URL=$(get connectors.whatsapp.wahaUrl)
WAHA_PORT=$(node -e 'const u=new URL(process.argv[1]);process.stdout.write(u.port||(u.protocol==="https:"?"443":"80"))' "${URL:-http://127.0.0.1:3198}")
WAHA_HOOK_PORT=$(get connectors.whatsapp.hookPort)
WAHA_HOOK_PORT=${WAHA_HOOK_PORT:-3199}
# The same config folder as the hub and qr.sh: the folder of KAGE_ENV.
WAHA_CONF=$(dirname "${KAGE_ENV:-$HOME/.config/kage/env}")
[ -f "$WAHA_CONF/waha/.env" ] || { echo "kage: no $WAHA_CONF/waha/.env. Add the waha keys to secrets.json, then run kage restart." >&2; exit 1; }
export WAHA_PORT WAHA_HOOK_PORT WAHA_CONF
echo "WAHA API on 127.0.0.1:$WAHA_PORT, Kage's webhook on port $WAHA_HOOK_PORT, keys from $WAHA_CONF/waha/.env"
exec docker compose -f "$ROOT/waha/compose.yaml" up -d "$@"
