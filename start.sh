#!/usr/bin/env bash
# compat: remove after 2026-12-15 (with old_tmux in setup.sh and stop_old_tmux in service.sh).
# The old login item (dev.kage.start) still runs this file. kage start turns the service on and removes that item.
exec "$(cd "$(dirname "$0")" && pwd)/setup.sh" start
