#!/usr/bin/env bash
set -euo pipefail
kill -0 "$(cat /tmp/travel-app.pid)"
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1
curl --fail --silent --max-time 3 http://127.0.0.1:6080/vnc.html >/dev/null
if [ -n "${CONTROL_PORT:-}" ]; then
  curl --fail --silent --max-time 3 "http://127.0.0.1:${CONTROL_PORT}/health" >/dev/null
fi
