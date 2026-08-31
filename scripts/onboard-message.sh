#!/bin/sh
# Print the message to paste into an agent session that is already running, so it joins the board.
# Usage: onboard-message.sh <project> [provider]   (provider: claude | codex | gemini …, default claude)
. "$(dirname "$0")/_common.sh"
[ -z "$1" ] && { echo "usage: onboard-message.sh <project> [provider]"; exit 1; }
provider="${2:-claude}"
sed -n '/^---$/,$p' "$ROOT/docs/ONBOARD_EXISTING.md" | tail -n +2 \
  | sed -e "s#{PROJECT}#$1#g" -e "s#{BOARD_ROOT}#$ROOT#g" -e "s#{BOARD_CMD}#node $ROOT/bin/board.js#g" -e "s#{PROVIDER}#$provider#g"
if command -v pbcopy >/dev/null 2>&1; then
  sed -n '/^---$/,$p' "$ROOT/docs/ONBOARD_EXISTING.md" | tail -n +2 \
    | sed -e "s#{PROJECT}#$1#g" -e "s#{BOARD_ROOT}#$ROOT#g" -e "s#{BOARD_CMD}#node $ROOT/bin/board.js#g" -e "s#{PROVIDER}#$provider#g" | pbcopy
  echo; echo "(copied to the clipboard — paste it into the agent's chat)" >&2
fi
