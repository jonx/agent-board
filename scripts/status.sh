#!/bin/sh
# Is the board running? Which projects exist, and what is waiting for me?
. "$(dirname "$0")/_common.sh"
if up; then echo "✔ board running at $BOARD_URL"; else echo "✘ board NOT running — run scripts/start.sh"; exit 1; fi
echo; echo "projects (id, name, waiting-for-you, active threads, path):"; $BOARD projects
echo; echo "log: $($BOARD verify)"
