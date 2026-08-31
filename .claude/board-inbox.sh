#!/bin/sh
# Prints unread board messages for <project> <agent> (peek only; the agent marks them read via board_inbox).
# Usage: board-inbox.sh PROJECT AGENT   — copy to <project>/.claude/board-inbox.sh
BOARD_URL="${BOARD_URL:-http://127.0.0.1:7777}"
out=$(curl -sf --max-time 2 "$BOARD_URL/api/inbox?project=$1&agent=$2&limit=20") || exit 0
unread=$(printf '%s' "$out" | sed -n 's/.*"unread":\([0-9]*\).*/\1/p')
[ -z "$unread" ] || [ "$unread" = "0" ] && exit 0
echo "[board] $unread unread message(s) on project $1 — call board_inbox before continuing. Preview:"
printf '%s' "$out" | head -c 3000; echo
