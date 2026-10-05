#!/bin/sh
# One hook script for Claude Code AND Codex CLI (their hook schemas are identical).
# Events handled: SessionStart, UserPromptSubmit (inject a short board summary),
# Stop (nudge the agent back once if the board still expects something from it).
#
# Degrades gracefully everywhere: no node, no curl, no server, odd stdin, old CLI
# versions, unknown events -> exit 0 silently. It must never break a session.
#
# Usage: board-hook.sh [PROJECT] [PROVIDER]
#   PROJECT  optional; resolved from the hook's cwd via the board when omitted
#   PROVIDER optional; defaults to claude (codex configs pass codex)
set -f
PROJECT="$1"; PROVIDER="${2:-claude}"
BOARD_URL="${BOARD_URL:-http://127.0.0.1:7777}"
command -v curl >/dev/null 2>&1 || exit 0
command -v node >/dev/null 2>&1 || NODE_MISSING=1

input=$(cat 2>/dev/null) || exit 0
field() { # field <name>  (string fields only; tolerates missing node)
  if [ -n "$NODE_MISSING" ]; then printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
  else printf '%s' "$input" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d)[process.argv[1]];if(v!=null&&typeof v!=="object")process.stdout.write(String(v))}catch{}})' "$1" 2>/dev/null
  fi
}
EVENT=$(field hook_event_name); [ -n "$EVENT" ] || exit 0
SID=$(field session_id); [ -n "$SID" ] || SID=default
CWD=$(field cwd)

# Resolve the project: explicit argument, else ask the board which project owns this directory.
if [ -z "$PROJECT" ] && [ -n "$CWD" ]; then
  enc=$(printf '%s' "$CWD" | sed 's/ /%20/g')
  PROJECT=$(curl -sf --max-time 2 "$BOARD_URL/api/hook/project?cwd=$enc" 2>/dev/null | sed -n 's/.*"project":"\([^"]*\)".*/\1/p')
fi
[ -n "$PROJECT" ] || exit 0

case "$EVENT" in
  SessionStart)
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BOARD_URL/api/projects" 2>/dev/null)
    if [ "$code" != "200" ]; then
      if command -v board >/dev/null 2>&1; then
        port=$(printf '%s' "$BOARD_URL" | sed -n 's#.*:\([0-9][0-9]*\)/*$#\1#p'); [ -n "$port" ] || port=7777
        nohup board serve --port "$port" >/dev/null 2>&1 &
        echo "[board] server was down; started it. If the board MCP tools are unavailable, reconnect (/mcp)."
      fi
      exit 0
    fi
    echo "[board] Team board active for project '$PROJECT' (you are provider '$PROVIDER'). Start with board_status, then board_inbox; deal with waiting_on_you before new work. See the board section of CLAUDE.md / AGENTS.md."
    ;;

  UserPromptSubmit)
    # Counters only: the agent fetches content itself with board_inbox (cheaper than pasting previews).
    cur_dir="${TMPDIR:-/tmp}/agent-board-cursors"; mkdir -p "$cur_dir" 2>/dev/null
    cur_file="$cur_dir/$PROJECT-$SID"
    since=$(cat "$cur_file" 2>/dev/null || echo 0)
    out=$(curl -sf --max-time 2 "$BOARD_URL/api/projects/$PROJECT/messages?since=$since&limit=1" 2>/dev/null) || exit 0
    last=$(printf '%s' "$out" | sed -n 's/.*"last_id":\([0-9]*\).*/\1/p'); [ -n "$last" ] || exit 0
    echo "$last" > "$cur_file" 2>/dev/null
    [ "$last" -gt "$since" ] 2>/dev/null || exit 0
    n=$((last - since))
    echo "[board] $n new message(s) on '$PROJECT' since you last looked. Call board_inbox before continuing."
    ;;

  Stop)
    # Never loop: if this stop is already the result of a hook nudge, let it through.
    active=$(field stop_hook_active)
    [ "$active" = "true" ] && exit 0
    out=$(curl -sf --max-time 3 "$BOARD_URL/api/hook/stop?project=$PROJECT&provider=$PROVIDER" 2>/dev/null) || exit 0
    case "$out" in *'"block":true'*) ;; *) exit 0 ;; esac
    [ -n "$NODE_MISSING" ] && exit 0   # cannot emit safe JSON without node; let the stop pass
    printf '%s' "$out" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=JSON.parse(d);if(r.block&&r.reason)console.log(JSON.stringify({decision:"block",reason:r.reason}))}catch{}})' 2>/dev/null
    ;;
esac
exit 0
