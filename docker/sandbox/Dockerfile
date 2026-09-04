# QA Harness sandbox: Linux desktop + Chromium + VNC + computer-use agent (spec §5.1).
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=800 \
    SCREEN_DEPTH=24 \
    HOME=/home/qa

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc openbox xdotool scrot x11-utils xauth \
      ffmpeg \
      novnc websockify \
      chromium \
      python3 \
      fonts-noto-cjk fonts-dejavu-core \
      ca-certificates curl procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 -s /bin/bash qa

COPY agent.py /opt/agent.py
COPY entrypoint.sh /opt/entrypoint.sh
COPY openbox-rc.xml /etc/xdg/openbox/rc.xml
RUN chmod +x /opt/entrypoint.sh && chown -R qa:qa /home/qa

USER qa
WORKDIR /home/qa

# 6080 noVNC (browser view) · 5900 raw VNC · 8000 computer-use agent API
EXPOSE 6080 5900 8000

HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=10 \
  CMD curl -fsS http://localhost:8000/health || exit 1

ENTRYPOINT ["/opt/entrypoint.sh"]
