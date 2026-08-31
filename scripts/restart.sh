#!/bin/sh
# Restart the background service (agents will re-join automatically on their next call).
. "$(dirname "$0")/_common.sh"
$BOARD service restart
