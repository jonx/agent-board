#!/bin/sh
# Everything that actually needs you (decisions waiting, threads you are in), across all projects.
# Answer with:  board ok <thread>   |   board no <thread> "reason"
. "$(dirname "$0")/_common.sh"
up || { echo "board not running — run scripts/start.sh"; exit 1; }
exec $BOARD todo
