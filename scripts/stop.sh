#!/bin/sh
# Stop and remove the background service (data in ~/.agent-board is kept).
. "$(dirname "$0")/_common.sh"
$BOARD service uninstall
