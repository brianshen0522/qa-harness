#!/usr/bin/env python3
"""
Computer-use agent for the QA Harness sandbox.

Exposes the action set of the `execution_step` schema over plain HTTP so the
Agent Worker can drive the desktop. Standard library only, so the image builds
without a package index.
"""
import base64
import json
import os
import shlex
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DISPLAY = os.environ.get("DISPLAY", ":99")
WIDTH = int(os.environ.get("SCREEN_WIDTH", "1280"))
HEIGHT = int(os.environ.get("SCREEN_HEIGHT", "800"))
PORT = int(os.environ.get("AGENT_PORT", "8000"))
SETTLE_MS = int(os.environ.get("ACTION_SETTLE_MS", "350"))

ENV = {**os.environ, "DISPLAY": DISPLAY}
_lock = threading.Lock()


def run(argv, timeout=20):
    p = subprocess.run(argv, env=ENV, capture_output=True, timeout=timeout)
    return p.returncode, p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")


def xdo(*args, timeout=20):
    code, out, err = run(["xdotool", *args], timeout=timeout)
    if code != 0:
        raise RuntimeError(f"xdotool {' '.join(args)} failed: {err.strip() or out.strip()}")
    return out


def settle(ms=None):
    time.sleep((SETTLE_MS if ms is None else ms) / 1000)


def clamp(v, lo, hi):
    return max(lo, min(int(v), hi))


# ---------- actions ----------

def act_screenshot(_):
    path = "/tmp/shot.png"
    code, _out, err = run(["scrot", "-o", "-p", path], timeout=25)
    if code != 0:
        raise RuntimeError(f"scrot failed: {err.strip()}")
    with open(path, "rb") as fh:
        data = fh.read()
    return {"image": base64.b64encode(data).decode(), "media_type": "image/png",
            "width": WIDTH, "height": HEIGHT, "bytes": len(data)}


def _point(p):
    return clamp(p.get("x", 0), 0, WIDTH - 1), clamp(p.get("y", 0), 0, HEIGHT - 1)


def act_move(p):
    x, y = _point(p)
    xdo("mousemove", str(x), str(y))
    settle(80)
    return {"x": x, "y": y}


def act_click(p):
    x, y = _point(p)
    button = str(int(p.get("button", 1)))
    xdo("mousemove", str(x), str(y))
    settle(80)
    xdo("click", button)
    settle()
    return {"x": x, "y": y, "button": int(button)}


def act_double_click(p):
    x, y = _point(p)
    xdo("mousemove", str(x), str(y))
    settle(80)
    xdo("click", "--repeat", "2", "--delay", "80", "1")
    settle()
    return {"x": x, "y": y}


def act_right_click(p):
    return act_click({**p, "button": 3})


def act_type(p):
    text = p.get("text", "")
    if not isinstance(text, str):
        raise ValueError("text must be a string")
    if text:
        xdo("type", "--delay", "12", "--", text, timeout=max(20, len(text) // 20))
    settle()
    return {"typed": len(text)}


def act_key(p):
    key = p.get("key", "")
    if not key:
        raise ValueError("key is required")
    # xdotool syntax: Return, Tab, ctrl+l, alt+F4 ...
    xdo("key", "--clearmodifiers", key)
    settle()
    return {"key": key}


_SCROLL_BUTTON = {"up": "4", "down": "5", "left": "6", "right": "7"}


def act_scroll(p):
    direction = str(p.get("direction", "down")).lower()
    if direction not in _SCROLL_BUTTON:
        raise ValueError(f"direction must be one of {list(_SCROLL_BUTTON)}")
    amount = clamp(p.get("amount", 3), 1, 25)
    if "x" in p or "y" in p:
        x, y = _point(p)
        xdo("mousemove", str(x), str(y))
    xdo("click", "--repeat", str(amount), "--delay", "40", _SCROLL_BUTTON[direction])
    settle()
    return {"direction": direction, "amount": amount}


def act_navigate(p):
    url = p.get("url", "")
    if not url.startswith(("http://", "https://", "about:", "file://")):
        raise ValueError("url must start with http://, https://, about: or file://")
    # Opens a tab in the running Chromium, or starts one if it died.
    subprocess.Popen(
        ["chromium", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", url],
        env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    settle(1500)
    return {"url": url}


def act_run_command(p):
    command = p.get("command", "")
    if not command:
        raise ValueError("command is required")
    timeout = clamp(p.get("timeout", 30), 1, 120)
    try:
        proc = subprocess.run(["bash", "-lc", command], env=ENV, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"exit_code": None, "stdout": "", "stderr": f"timed out after {timeout}s", "timed_out": True}
    return {
        "exit_code": proc.returncode,
        "stdout": proc.stdout.decode("utf-8", "replace")[-8000:],
        "stderr": proc.stderr.decode("utf-8", "replace")[-4000:],
        "timed_out": False,
    }


def act_cursor(_):
    out = xdo("getmouselocation", "--shell")
    vals = dict(line.split("=", 1) for line in out.strip().splitlines() if "=" in line)
    return {"x": int(vals.get("X", 0)), "y": int(vals.get("Y", 0))}


ACTIONS = {
    "screenshot": act_screenshot,
    "click": act_click,
    "double_click": act_double_click,
    "right_click": act_right_click,
    "move": act_move,
    "type": act_type,
    "key": act_key,
    "scroll": act_scroll,
    "navigate": act_navigate,
    "run_command": act_run_command,
    "cursor": act_cursor,
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # container logs stay readable

    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            healthy = subprocess.run(["xdpyinfo"], env=ENV, capture_output=True).returncode == 0
            return self._send(200 if healthy else 503, {
                "ok": healthy, "display": DISPLAY, "width": WIDTH, "height": HEIGHT,
                "actions": sorted(ACTIONS),
            })
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        name = self.path.strip("/")
        action = ACTIONS.get(name)
        if not action:
            return self._send(404, {"ok": False, "error": f"unknown action '{name}'",
                                    "actions": sorted(ACTIONS)})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            params = json.loads(self.rfile.read(length) or b"{}") if length else {}
        except Exception as exc:
            return self._send(400, {"ok": False, "error": f"bad JSON body: {exc}"})

        started = time.time()
        try:
            # Input actions must not interleave, or clicks land in the wrong place.
            with _lock:
                result = action(params)
            return self._send(200, {"ok": True, "action": name,
                                    "duration_ms": int((time.time() - started) * 1000), **result})
        except Exception as exc:
            return self._send(200, {"ok": False, "action": name, "error": f"{type(exc).__name__}: {exc}",
                                    "duration_ms": int((time.time() - started) * 1000)})


if __name__ == "__main__":
    print(f"[agent] listening on :{PORT} display={DISPLAY} {WIDTH}x{HEIGHT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
