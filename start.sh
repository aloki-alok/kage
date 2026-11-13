#!/usr/bin/env bash
# The old login item (dev.kage.start) still runs this file. kage start turns the service on and removes that item.
exec "$(cd "$(dirname "$0")" && pwd)/setup.sh" start
