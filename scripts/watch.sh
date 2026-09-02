#!/bin/sh
# Live feed of everything said on the board (optionally one project: watch.sh my-project). Ctrl-C to quit.
. "$(dirname "$0")/_common.sh"
up || { echo "board not running: run scripts/start.sh"; exit 1; }
exec $BOARD tail "$@"
