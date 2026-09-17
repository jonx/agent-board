#!/bin/sh
# Background waiter installed by board init: exits when the board has a new
# notification for this agent, which re-invokes an idle session. Read-only.
# usage: board-wait.sh <agent-name>      (run it as a background task)
exec node "__BOARD_ROOT__/configs/claude-code/board-wait.js" "__BOARD_PROJECT__" "$1"
