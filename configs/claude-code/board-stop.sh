#!/bin/sh
# Stop and SubagentStop. Holds a session that has a board identity and no live
# waiter, so it cannot go idle unreachable. Silent for every other session.
# Installed by board init; the installed directory is baked in for the same
# reason as the inbox hook.
exec node "__BOARD_ROOT__/configs/claude-code/board-stop.js" "$1" "__BOARD_DIR__"
