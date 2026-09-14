#!/bin/sh
# SessionStart, UserPromptSubmit and PostToolUse. Bounded check, no polling loop.
# Installed by board init; Node handles JSON, cursor locking and atomic writes.
exec node "__BOARD_ROOT__/configs/claude-code/board-inbox.js" "$1"
