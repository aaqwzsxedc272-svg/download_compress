#!/usr/bin/env bash
# Keep a Codespace (or any idle-stopping host) awake while a long encode runs.
#
# GitHub counts terminal output as activity, so a line every few minutes in a
# second terminal is enough. Run it while you compress:
#
#   ./scripts/keepalive.sh            # every 4 minutes, stop with Ctrl+C
#   ./scripts/keepalive.sh 60         # every 60 seconds
#
# The app itself already prints a [keep-alive] line every 45 seconds while a job
# is running, so this is only needed if you restarted it with HEARTBEAT_SECONDS=0.
set -u
EVERY="${1:-240}"
echo "Keep-alive: printing a line every ${EVERY}s. Leave this terminal open; Ctrl+C to stop."
i=0
while true; do
  i=$((i + 1))
  printf '[keepalive %s] %s still here\n' "$i" "$(date -u '+%H:%M:%S UTC')"
  sleep "$EVERY"
done
