#!/usr/bin/env bash
set -Eeuo pipefail
mkdir -p /data/profile /app/logs /app/.runtime
# A kernel lock survives PID namespace differences and is released even on SIGKILL.
exec 9>/data/profile/.automation.lock
if ! flock -n 9; then
  echo '浏览器资料正在被另一个容器使用。' >&2
  exit 73
fi
# Only remove Chromium's stale symlinks while holding the exclusive profile lock.
for name in SingletonLock SingletonSocket SingletonCookie; do
  if [[ -L "/data/profile/$name" ]]; then unlink "/data/profile/$name"; fi
done

services=()
app_pid=''
cleaned=0
cleanup() {
  if (( cleaned )); then return; fi
  cleaned=1
  trap '' TERM INT
  if [[ -n "$app_pid" ]]; then
    kill -TERM "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  for pid in "${services[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  # x11vnc can hang after Xvfb disappears. The app/browser has already closed;
  # bound desktop cleanup so a crashed app actually exits and Docker restarts.
  for ((i=0; i<20; i++)); do
    alive=0
    for pid in "${services[@]}"; do if kill -0 "$pid" 2>/dev/null; then alive=1; fi; done
    if (( ! alive )); then break; fi
    sleep 0.1
  done
  for pid in "${services[@]}"; do if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi; done
  for pid in "${services[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 0' TERM INT

mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
Xvfb "$DISPLAY" -screen 0 1360x1000x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
services+=("$!")
ready=0
for ((i=0; i<50; i++)); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.2
done
if (( ! ready )); then cat /tmp/xvfb.log >&2; echo '虚拟显示器未能启动。' >&2; exit 1; fi
openbox --sm-disable >/tmp/openbox.log 2>&1 &
services+=("$!")
x11vnc -display "$DISPLAY" -localhost -rfbport 5900 -forever -shared -nopw -noxdamage >/tmp/x11vnc.log 2>&1 &
services+=("$!")
websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 >/tmp/novnc.log 2>&1 &
services+=("$!")
echo "浏览器画面：http://localhost:${VNC_PORT:-7080}/vnc.html；战斗控制：http://localhost:${CONTROL_PORT:-7081}。首次在面板绑定人物，挂机默认停止。"
"$@" &
app_pid=$!
echo "$app_pid" >/tmp/travel-app.pid
set +e
wait -n "$app_pid" "${services[@]}"
result=$?
set -e
if kill -0 "$app_pid" 2>/dev/null; then
  echo '桌面服务意外退出，停止脚本并交由 Docker 恢复。' >&2
  exit 1
fi
exit "$result"
