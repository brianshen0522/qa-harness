#!/usr/bin/env python3
"""
Computer-use agent for the QA Harness sandbox.

Exposes the action set of the `execution_step` schema over plain HTTP so the
Agent Worker can drive the desktop. Standard library only, so the image builds
without a package index.
"""
import base64
import hashlib
import json
import os
import shlex
import signal
import socket
import struct
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DISPLAY = os.environ.get("DISPLAY", ":99")
WIDTH = int(os.environ.get("SCREEN_WIDTH", "1280"))
HEIGHT = int(os.environ.get("SCREEN_HEIGHT", "800"))
PORT = int(os.environ.get("AGENT_PORT", "8000"))
SETTLE_MS = int(os.environ.get("ACTION_SETTLE_MS", "350"))

ENV = {**os.environ, "DISPLAY": DISPLAY}
_lock = threading.Lock()

RECORDING_PATH = "/tmp/recording.mp4"
# A runaway recorder would fill the container's disk; a case that runs this long
# has other problems anyway.
RECORDING_MAX_SEC = int(os.environ.get("RECORDING_MAX_SEC", "1800"))
_recorder = {"proc": None, "started": 0.0}


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

CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))


class CdpError(RuntimeError):
    pass


class Cdp:
    """
    A tiny Chrome DevTools Protocol client over a hand-rolled WebSocket, so the
    agent can read the real DOM and drive the page reliably. Stdlib only, to keep
    the image buildable without a package index. One connection to one page
    target, guarded by a lock because the agent is threaded.
    """

    def __init__(self):
        self._sock = None
        self._id = 0
        self._lock = threading.Lock()
        self._target_id = None

    # ----- connection -----

    def _http_targets(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json", timeout=5) as r:
            return json.loads(r.read().decode())

    def _pick_page(self):
        pages = [t for t in self._http_targets() if t.get("type") == "page"]
        if not pages:
            raise CdpError("no page target in Chrome")
        # Prefer a real page over the about:blank/newtab shell if both exist.
        real = [p for p in pages if not p.get("url", "").startswith("about:")]
        return (real or pages)[0]

    def _connect(self):
        page = self._pick_page()
        self._target_id = page["id"]
        ws_url = page["webSocketDebuggerUrl"]
        # ws://127.0.0.1:9222/devtools/page/<id>
        _, _, rest = ws_url.partition("://")
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        port = int(port or 80)

        sock = socket.create_connection((host, port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        handshake = (
            f"GET /{path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        sock.sendall(handshake.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = sock.recv(4096)
            if not chunk:
                raise CdpError("Chrome closed the socket during the handshake")
            resp += chunk
        if b" 101 " not in resp.split(b"\r\n", 1)[0]:
            raise CdpError(f"unexpected handshake response: {resp[:80]!r}")
        self._sock = sock
        self._buf = resp.split(b"\r\n\r\n", 1)[1]

    def _ensure(self):
        if self._sock is None:
            self._connect()

    def _reset(self):
        try:
            if self._sock:
                self._sock.close()
        except OSError:
            pass
        self._sock = None
        self._buf = b""

    # ----- websocket framing (client masks; server does not) -----

    def _send_frame(self, payload: bytes):
        header = bytearray([0x81])  # FIN + text
        n = len(payload)
        mask = os.urandom(4)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self._sock.sendall(bytes(header) + masked)

    def _recv_exact(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise CdpError("Chrome closed the connection")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _recv_frame(self) -> bytes:
        b0, b1 = self._recv_exact(2)
        opcode = b0 & 0x0F
        length = b1 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._recv_exact(8))[0]
        data = self._recv_exact(length)
        if opcode == 0x8:  # close
            raise CdpError("Chrome sent a close frame")
        if opcode in (0x9, 0xA):  # ping/pong: ignore and read the next frame
            return self._recv_frame()
        return data

    # ----- commands -----

    def call(self, method: str, params: dict = None, timeout: float = 30.0) -> dict:
        with self._lock:
            for attempt in (1, 2):
                try:
                    self._ensure()
                    self._id += 1
                    mid = self._id
                    self._send_frame(json.dumps({"id": mid, "method": method, "params": params or {}}).encode())
                    deadline = time.time() + timeout
                    while time.time() < deadline:
                        msg = json.loads(self._recv_frame().decode("utf-8", "replace"))
                        if msg.get("id") == mid:
                            if "error" in msg:
                                raise CdpError(msg["error"].get("message", str(msg["error"])))
                            return msg.get("result", {})
                        # Events (Page.loadEventFired etc.) are skipped here.
                    raise CdpError(f"timed out waiting for {method}")
                except (OSError, CdpError) as exc:
                    self._reset()
                    if attempt == 2:
                        raise CdpError(f"{method}: {exc}")
        raise CdpError("unreachable")

    def evaluate(self, expression: str, timeout: float = 30.0):
        result = self.call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
            timeout=timeout,
        )
        if result.get("exceptionDetails"):
            exc = result["exceptionDetails"]
            raise CdpError(exc.get("exception", {}).get("description") or exc.get("text", "JS exception"))
        return result.get("result", {}).get("value")


_cdp = Cdp()

# React controls its inputs, so assigning .value does nothing the framework sees.
# Going through the native setter and firing input/change is what actually sticks.
FILL_JS = r"""
(() => {
  const SELECTOR = %s, VALUE = %s;
  const nodes = [...document.querySelectorAll('input, textarea, select')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  });
  let el = null;
  if (typeof SELECTOR === 'number') {
    el = nodes[SELECTOR] || null;
  } else {
    const needle = String(SELECTOR).toLowerCase();
    el = nodes.find((n) =>
      [n.name, n.id, n.getAttribute('type'), n.getAttribute('placeholder'), n.getAttribute('aria-label')]
        .filter(Boolean).some((a) => a.toLowerCase().includes(needle))) || null;
  }
  if (!el) return { ok: false, error: 'no matching field' };
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
    : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  el.focus();
  setter.call(el, VALUE);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, name: el.name || el.id || null, type: el.getAttribute('type') || el.tagName.toLowerCase() };
})()
"""


def act_cdp_fill(p):
    selector = p.get("field")
    if selector is None:
        raise ValueError("fill needs a field (index or name/type/placeholder substring)")
    value = p.get("value", "")
    res = _cdp.evaluate(FILL_JS % (json.dumps(selector), json.dumps(str(value))))
    if not res or not res.get("ok"):
        raise CdpError((res or {}).get("error", "fill failed"))
    return res


# Clicks a link, button or role=button by its visible text. Returns whether the
# URL changed, so the crawler can tell navigation from an in-place update.
CLICK_JS = r"""
(() => {
  const NEEDLE = %s.toLowerCase(), EXACT = %s;
  const before = location.href;
  const cands = [...document.querySelectorAll('a, button, [role="button"], [role="tab"], [role="menuitem"], input[type="submit"]')];
  const vis = (el) => { const r = el.getBoundingClientRect(); return (r.width > 0 || r.height > 0); };
  const text = (el) => (el.innerText || el.value || el.textContent || '').trim().toLowerCase();
  let el = cands.find((c) => vis(c) && (EXACT ? text(c) === NEEDLE : text(c).includes(NEEDLE)));
  if (!el) return { ok: false, error: 'no matching control' };
  el.scrollIntoView({ block: 'center' });
  el.click();
  return { ok: true, before, text: (el.innerText || el.value || '').trim().slice(0, 80) };
})()
"""


def act_cdp_click(p):
    text = p.get("text")
    if not text:
        raise ValueError("click needs text")
    res = _cdp.evaluate(CLICK_JS % (json.dumps(str(text)), json.dumps(bool(p.get("exact", False)))))
    if not res or not res.get("ok"):
        raise CdpError((res or {}).get("error", "click failed"))
    settle_for_spa(p.get("wait_ms"))
    after = _cdp.evaluate("location.href")
    res["navigated"] = after != res.get("before")
    res["url"] = after
    return res


def act_cdp_key(p):
    """Dispatch a single key via CDP — mainly Escape, to close a modal."""
    key = p.get("key", "Escape")
    codes = {
        "Escape": {"key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27},
        "Enter": {"key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13},
        "Tab": {"key": "Tab", "code": "Tab", "windowsVirtualKeyCode": 9},
    }
    spec = codes.get(key, codes["Escape"])
    _cdp.call("Input.dispatchKeyEvent", {"type": "keyDown", **spec})
    _cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", **spec})
    settle(250)
    return {"key": key}


def act_cdp_reset(_):
    """Clear cookies and storage so the next identity starts from a clean session.
    Without this, one identity's login leaks into the next and the permission
    matrix is a lie."""
    _cdp.call("Network.enable")
    _cdp.call("Network.clearBrowserCookies")
    _cdp.call("Network.clearBrowserCache")
    try:
        origin = _cdp.evaluate("location.origin")
        if origin:
            _cdp.call("Storage.clearDataForOrigin", {
                "origin": origin,
                "storageTypes": "local_storage,indexeddb,websql,service_workers,cache_storage",
            })
    except CdpError:
        pass
    return {"cleared": True}


def act_cdp_current(_):
    """Just the URL and title, cheap, for the crawler to track where a click went."""
    return _cdp.evaluate("({url: location.href, path: location.pathname + location.search, title: document.title})")




# The page probe: everything about the current page we can read deterministically.
# Runs in the page so it sees the rendered DOM, not the initial HTML.
PAGE_PROBE_JS = r"""
(() => {
  const seen = new Set();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  };
  const txt = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const links = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    if (!href || href.startsWith('javascript:')) continue;
    const key = href + '|' + txt(a);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ href, text: txt(a), visible: visible(a) });
  }
  const forms = [...document.querySelectorAll('form')].map((f) => ({
    action: f.action || null,
    method: (f.method || 'get').toLowerCase(),
    fields: [...f.querySelectorAll('input,select,textarea')].map((el) => ({
      name: el.name || el.id || null,
      type: (el.getAttribute('type') || el.tagName.toLowerCase()),
      required: el.required || false,
      label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').slice(0, 80) || null,
    })),
  }));
  // Interactive controls that are not links or form submits: the SPA hangs a lot
  // of navigation off buttons and role=button, so they matter for the map.
  const controls = [];
  const cseen = new Set();
  for (const el of document.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"]')) {
    if (!visible(el)) continue;
    const t = txt(el);
    if (!t || cseen.has(t)) continue;
    cseen.add(t);
    controls.push({ text: t, role: el.getAttribute('role') || 'button', disabled: el.disabled || false });
  }
  const landmarks = [...document.querySelectorAll('[role], nav, main, header, footer, aside')]
    .map((el) => el.getAttribute('role') || el.tagName.toLowerCase());
  // Overlay/dialog detection: covers the common UI libraries plus a generic
  // "big fixed high-z-index layer" fallback. This is how the crawler tells a
  // modal opening from a link navigating.
  const dialogSel = '[role="dialog"],[aria-modal="true"],dialog[open],.modal,.ReactModal__Content,.ant-modal,.MuiDialog-container,[class*="modal"],[class*="Modal"],[class*="drawer"],[class*="Drawer"]';
  let dialogs = 0;
  for (const el of document.querySelectorAll(dialogSel)) {
    if (visible(el)) dialogs++;
  }
  let overlay = false;
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if ((s.position === 'fixed' || s.position === 'absolute') && Number(s.zIndex) >= 1000 && visible(el)) {
      const r = el.getBoundingClientRect();
      if (r.width > window.innerWidth * 0.3 && r.height > window.innerHeight * 0.3) { overlay = true; break; }
    }
  }
  // Visible alerts / errors / toasts / validation text. Without this the agent
  // cannot read "Invalid credentials." and keeps retrying an action that already
  // failed — the judge sees it in the screenshot, the agent never does.
  const messages = [];
  const mseen = new Set();
  const pushMsg = (el, kind) => {
    if (!visible(el)) return;
    const t = txt(el);
    if (!t || t.length > 300 || mseen.has(t)) return;
    mseen.add(t);
    messages.push({ text: t.slice(0, 200), kind });
  };
  for (const el of document.querySelectorAll('[role="alert"],[role="status"],[aria-live],output')) pushMsg(el, 'alert');
  for (const el of document.querySelectorAll(
    '[class*="error"],[class*="Error"],[class*="alert"],[class*="Alert"],[class*="toast"],[class*="Toast"],[class*="invalid"],[class*="danger"],[class*="warning"],[class*="Warning"],[class*="notice"]'
  )) pushMsg(el, 'text');
  // Native constraint validation ("Please fill out this field").
  for (const el of document.querySelectorAll('input,select,textarea')) {
    try {
      if (el.willValidate && !el.validity.valid && el.validationMessage) {
        const t = (el.name || el.id || el.type || 'field') + ': ' + el.validationMessage;
        if (!mseen.has(t)) { mseen.add(t); messages.push({ text: t.slice(0, 200), kind: 'validation' }); }
      }
    } catch (e) { /* some elements throw on validity access */ }
  }
  const headings = [...document.querySelectorAll('h1,h2,h3')].map((h) => txt(h)).filter(Boolean).slice(0, 30);
  const body = document.body;
  return {
    url: location.href,
    path: location.pathname + location.search + location.hash,
    title: document.title,
    headings,
    links,
    forms,
    controls,
    messages: messages.slice(0, 10),
    landmarks: [...new Set(landmarks)],
    // Cheap layout signals for the RWD scan (stage C).
    scrollWidth: body ? body.scrollWidth : 0,
    clientWidth: document.documentElement.clientWidth,
    textLength: (body ? (body.innerText || '') : '').length,
    dialogs,
    overlay,
  };
})()
"""


def act_dom_snapshot(_):
    data = _cdp.evaluate(PAGE_PROBE_JS)
    if data is None:
        raise CdpError("page probe returned nothing")
    return {"page": data}


def act_cdp_navigate(p):
    url = p.get("url")
    if not url:
        raise ValueError("navigate needs a url")
    _cdp.call("Page.enable")
    _cdp.call("Page.navigate", {"url": url}, timeout=45)
    # Wait for the SPA to actually paint something, not just for the document.
    settle_for_spa(p.get("wait_ms"))
    return act_dom_snapshot(None)


def act_set_viewport(p):
    """RWD scan (stage C): override the layout viewport without resizing Xvfb."""
    width = clamp(p.get("width") or WIDTH, 200, 4096)
    height = clamp(p.get("height") or HEIGHT, 200, 4096)
    mobile = bool(p.get("mobile", width < 768))
    _cdp.call("Emulation.setDeviceMetricsOverride", {
        "width": width, "height": height, "deviceScaleFactor": 1, "mobile": mobile,
    })
    settle(400)
    return {"width": width, "height": height, "mobile": mobile}


def act_clear_viewport(_):
    _cdp.call("Emulation.clearDeviceMetricsOverride")
    return {"cleared": True}


def settle_for_spa(wait_ms=None):
    """Give a client-rendered page time to mount; polls rather than fixed-sleeps."""
    time.sleep((wait_ms or 600) / 1000)
    for _ in range(20):
        try:
            ready = _cdp.evaluate("document.readyState === 'complete' && document.body && document.body.innerText.length > 0")
            if ready:
                break
        except CdpError:
            pass
        time.sleep(0.25)



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


def _stop_recorder(timeout=20):
    """SIGINT rather than kill: ffmpeg needs it to write the moov atom, and an
    mp4 without one will not play."""
    proc = _recorder.get("proc")
    if proc is None:
        return None
    try:
        proc.send_signal(signal.SIGINT)
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    finally:
        _recorder["proc"] = None
    return proc


def act_record_start(p):
    _stop_recorder()
    if os.path.exists(RECORDING_PATH):
        os.remove(RECORDING_PATH)
    fps = clamp(p.get("fps") or 5, 1, 30)
    argv = [
        "ffmpeg", "-nostdin", "-y",
        "-f", "x11grab", "-video_size", f"{WIDTH}x{HEIGHT}", "-framerate", str(fps),
        "-i", DISPLAY, "-t", str(RECORDING_MAX_SEC),
        # yuv420p is what browsers can play, and it needs even dimensions.
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        RECORDING_PATH,
    ]
    log = open("/tmp/ffmpeg.log", "wb")
    proc = subprocess.Popen(argv, env=ENV, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    _recorder.update(proc=proc, started=time.time())
    return {"recording": True, "fps": fps}


def act_record_stop(_):
    started = _recorder.get("started") or time.time()
    proc = _stop_recorder()
    size = os.path.getsize(RECORDING_PATH) if os.path.exists(RECORDING_PATH) else 0
    return {
        "recording": False,
        "was_recording": proc is not None,
        "bytes": size,
        "duration_ms": int((time.time() - started) * 1000),
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
    "record_start": act_record_start,
    "record_stop": act_record_stop,
    "dom_snapshot": act_dom_snapshot,
    "cdp_navigate": act_cdp_navigate,
    "cdp_fill": act_cdp_fill,
    "cdp_click": act_cdp_click,
    "cdp_current": act_cdp_current,
    "cdp_key": act_cdp_key,
    "cdp_reset": act_cdp_reset,
    "set_viewport": act_set_viewport,
    "clear_viewport": act_clear_viewport,
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

    def _send_file(self, path, content_type):
        if not os.path.exists(path):
            return self._send(404, {"ok": False, "error": "no recording"})
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with open(path, "rb") as fh:
            while True:
                chunk = fh.read(1 << 20)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def do_GET(self):
        if self.path.rstrip("/") == "/recording":
            # Streamed rather than base64'd into JSON: a few minutes of screen is
            # tens of megabytes, and the worker only needs the bytes.
            return self._send_file(RECORDING_PATH, "video/mp4")
        if self.path.rstrip("/") in ("/health", ""):
            healthy = subprocess.run(["xdpyinfo"], env=ENV, capture_output=True).returncode == 0
            return self._send(200 if healthy else 503, {
                "ok": healthy, "display": DISPLAY, "width": WIDTH, "height": HEIGHT,
                "actions": sorted(ACTIONS),
                "recording": _recorder.get("proc") is not None,
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
