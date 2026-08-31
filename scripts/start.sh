#!/bin/sh
# Make sure the board is running (as a background service that survives reboots), then open the UI.
. "$(dirname "$0")/_common.sh"
if up; then echo "board already running at $BOARD_URL"; else
  echo "installing/starting the background service…"; $BOARD service install
  for i in 1 2 3 4 5 6 7 8 9 10; do up && break; sleep 0.5; done
  up && echo "board is up at $BOARD_URL" || { echo "still not reachable — check ~/.agent-board/server.log"; exit 1; }
fi
$BOARD open
