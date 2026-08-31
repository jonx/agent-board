# shared by the scripts — not meant to be run directly
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOARD="node $ROOT/bin/board.js"
BOARD_URL="${BOARD_URL:-http://127.0.0.1:7777}"
up() { curl -sf --max-time 2 "$BOARD_URL/api/projects" >/dev/null 2>&1; }
