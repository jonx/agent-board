#!/bin/sh
# Open the human UI in the browser.
. "$(dirname "$0")/_common.sh"
up || { echo "board not running — run scripts/start.sh"; exit 1; }
$BOARD open
