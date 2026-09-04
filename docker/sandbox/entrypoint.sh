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
  # Turn off the password manager before the first launch. Otherwise Chrome's
  # "Save password?" bubble pops up after any login and sits on top of the page,
  # covering form fields and buttons — it corrupts the live view and every
  # screenshot the agent takes. Flags alone are unreliable across versions, so
  # seed the profile's Preferences too (the durable switch).
  PROFILE_DIR=/home/qa/chrome-profile
  mkdir -p "${PROFILE_DIR}/Default"
  cat > "${PROFILE_DIR}/Default/Preferences" <<'PREFS'
{"credentials_enable_service":false,"credentials_enable_autosignin":false,"profile":{"password_manager_enabled":false,"password_manager_leak_detection":false},"autofill":{"enabled":false,"credit_card_enabled":false,"profile_enabled":false}}
PREFS
  chromium \
    --no-sandbox --disable-dev-shm-usage --disable-gpu \
    --no-first-run --no-default-browser-check --disable-infobars \
    --user-data-dir="${PROFILE_DIR}" \
    --disable-features=TranslateUI,ChromeWhatsNewUI,PasswordLeakDetection,AutofillServerCommunication,PasswordManagerOnboarding \
    --disable-save-password-bubble --password-store=basic \
    --disable-session-crashed-bubble --hide-crash-restore-bubble \
    --remote-debugging-port=9222 --remote-allow-origins=* \
    --start-maximized --window-position=0,0 \
    --window-size="${SCREEN_WIDTH},${SCREEN_HEIGHT}" \
    "${START_URL:-about:blank}" >/tmp/chromium.log 2>&1 &
fi

echo "[sandbox] starting computer-use agent on 8000"
exec python3 /opt/agent.py
