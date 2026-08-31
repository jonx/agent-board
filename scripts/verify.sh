#!/bin/sh
# Check the append-only message log (hash chain) is intact.
. "$(dirname "$0")/_common.sh"
up || { echo "board not running — run scripts/start.sh"; exit 1; }
$BOARD verify
