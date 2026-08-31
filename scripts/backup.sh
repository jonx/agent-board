#!/bin/sh
# Copy the database to ~/.agent-board/backups/board-<date>.db (consistent copy, works while the board runs).
DATA="${BOARD_DATA:-$HOME/.agent-board}"
mkdir -p "$DATA/backups"
out="$DATA/backups/board-$(date +%Y%m%d-%H%M%S).db"
sqlite3 "$DATA/board.db" ".backup '$out'" && echo "backup written: $out" && ls -1 "$DATA/backups" | tail -5
