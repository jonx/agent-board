#!/bin/sh
# Repository-local hook; portable across checkouts.
board_checkout=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$board_checkout/configs/claude-code/board-inbox.js" "$1"
