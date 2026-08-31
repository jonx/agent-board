#!/bin/sh
# Update the board to the latest code: pull, install deps, run the tests, restart the service.
. "$(dirname "$0")/_common.sh"
cd "$ROOT" || exit 1
git pull --ff-only || exit 1
npm install --no-audit --no-fund || exit 1
npm test || { echo "tests failed — NOT restarting the service"; exit 1; }
$BOARD service restart 2>/dev/null || echo "(no service installed; if you run 'board serve' by hand, restart it)"
echo "updated to $(git log --oneline -1)"
