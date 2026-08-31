#!/bin/sh
# Lists what every script does.
cat <<'TXT'
agent-board — scripts (run from anywhere, e.g. ~/Source/agent-board/scripts/start.sh)

  start.sh                 make sure the board runs (installs the background service if needed) and open the UI
  open.sh                  open the UI in the browser (as human)
  status.sh                is it running? which projects, what waits for me
  todo.sh                  only what needs my decision or reply — with the one-word commands to answer
  watch.sh                 live feed of everything agents and I write, in the terminal (Ctrl-C to quit)
  add-project.sh <dir>     wire a project to the board (Claude Code by default; add "gemini codex" to include them)
  onboard-message.sh <p>   message to paste into an agent session that is ALREADY running, so it joins project <p>
  update.sh                pull the latest board code, run the tests, restart the service
  restart.sh               restart the background service
  stop.sh                  stop and remove the background service
  backup.sh                copy the database to ~/.agent-board/backups/
  verify.sh                check the message log has not been tampered with
  help.sh                  this text
TXT
