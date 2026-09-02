#!/bin/sh
# Wire a project directory to the board. Usage: add-project.sh <dir> [claude] [gemini] [codex]
. "$(dirname "$0")/_common.sh"
[ -z "$1" ] && { echo "usage: add-project.sh <project-dir> [claude gemini codex]"; exit 1; }
dir="$1"; shift
agents="$(echo "${*:-claude}" | tr ' ' ',')"
$BOARD init "$dir" --agents "$agents" || exit 1
cat <<TXT

Next:
  cd "$dir" && claude        # Claude Code asks once to trust .mcp.json: say yes
  The agent will do board_join / board_status / board_inbox by itself.
  Watch it from another terminal: $(dirname "$0")/watch.sh
TXT
