#!/bin/bash
# Boots the virtual desktop, the VNC bridge and the computer-use agent.
set -euo pipefail

GEOM="${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}"
echo "[sandbox] starting Xvfb ${DISPLAY} ${GEOM}"
Xvfb "${DISPLAY}" -screen 0 "${GEOM}" -ac +extension RANDR >/tmp/xvfb.log 2>&1 &

for i in $(seq 1 50); do
  xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break
  sleep 0.2
done

echo "[sandbox] starting window manager"
openbox >/tmp/openbox.log 2>&1 &

echo "[sandbox] starting VNC server"
x11vnc -display "${DISPLAY}" -forever -shared -nopw -quiet -rfbport 5900 >/tmp/x11vnc.log 2>&1 &

echo "[sandbox] starting noVNC on 6080"
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &

if [ "${START_BROWSER:-1}" = "1" ]; then
  echo "[sandbox] starting Chromium"
  chromium \
    --no-sandbox --disable-dev-shm-usage --disable-gpu \
    --no-first-run --no-default-browser-check --disable-infobars \
    --disable-features=TranslateUI,ChromeWhatsNewUI \
    --start-maximized --window-position=0,0 \
    --window-size="${SCREEN_WIDTH},${SCREEN_HEIGHT}" \
    "${START_URL:-about:blank}" >/tmp/chromium.log 2>&1 &
fi

echo "[sandbox] starting computer-use agent on 8000"
exec python3 /opt/agent.py
