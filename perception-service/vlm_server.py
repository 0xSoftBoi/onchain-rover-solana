"""
Laptop VLM perception service — Phase 3, RAM-gate dodge.

Runs the heavy vision-language model on the LAPTOP (lots of RAM) instead of the
Jetson (~2.5 GB shared). The rover's DimOS agent calls this over HTTP as a
`look` / `locate` / `recall` skill. The service pulls one frame from the robot's
MJPEG /stream, runs the VLM, and keeps a spatial memory of what's been seen so
"drive to the package I saw by the door" works.

Zero framework deps (stdlib http.server + requests). VLM backend = Ollama vision
model on the laptop (moondream/llava), with a stub fallback so the plumbing runs
before a model is pulled.

    ollama pull moondream            # on the laptop (or llava)
    VLM_MODEL=moondream python vlm_server.py     # serves :4031
"""
import base64
import json
import os
import re
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

PORT = int(os.environ.get("VLM_PORT", "4031"))
OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434")
VLM_MODEL = os.environ.get("VLM_MODEL", "moondream")
DB = os.environ.get("VLM_DB", "/tmp/rover_spatial_memory.db")

_db = sqlite3.connect(DB, check_same_thread=False)
_db.execute("CREATE TABLE IF NOT EXISTS obs (id INTEGER PRIMARY KEY, ts REAL, "
            "label TEXT, description TEXT)")
_db.commit()


# --- frame source ----------------------------------------------------------
def grab_frame(robot_url, timeout=8):
    """Pull ONE JPEG from the robot's MJPEG /stream. Returns bytes or None."""
    try:
        with requests.get(f"{robot_url}/stream", stream=True, timeout=timeout) as r:
            buf = b""
            for chunk in r.iter_content(4096):
                buf += chunk
                a = buf.find(b"\xff\xd8")           # JPEG SOI
                b = buf.find(b"\xff\xd9", a + 2)     # JPEG EOI
                if a != -1 and b != -1:
                    return buf[a:b + 2]
                if len(buf) > 2_000_000:
                    return None
    except Exception:
        return None


# --- VLM backend -----------------------------------------------------------
def vlm(image_bytes, prompt):
    """Ask the laptop VLM about an image. Ollama vision -> text. Stub if no model."""
    if not image_bytes:
        return "(no image)"
    b64 = base64.b64encode(image_bytes).decode()
    try:
        r = requests.post(f"{OLLAMA}/api/generate", json={
            "model": VLM_MODEL, "prompt": prompt, "images": [b64],
            "stream": False, "options": {"temperature": 0.2},
        }, timeout=90)
        if r.status_code == 404:
            return f"(VLM model '{VLM_MODEL}' not pulled — `ollama pull {VLM_MODEL}`)"
        return r.json().get("response", "").strip()
    except Exception as e:
        return f"(VLM unavailable: {str(e)[:80]})"


def _image_from(req):
    """Resolve image bytes from {image_b64} or {robot_url}."""
    if req.get("image_b64"):
        return base64.b64decode(req["image_b64"])
    if req.get("robot_url"):
        return grab_frame(req["robot_url"])
    return None


# --- skills ----------------------------------------------------------------
def look(req):
    """Describe / answer a question about what the rover sees now."""
    img = _image_from(req)
    q = req.get("question", "Describe the scene in one sentence.")
    return {"answer": vlm(img, q), "had_image": img is not None}


def locate(req):
    """Find a target -> {present, confidence, x_frac} (feeds seek)."""
    img = _image_from(req)
    target = req.get("target", "the object")
    ans = vlm(img, f"Is '{target}' visible? If yes, give its horizontal position "
                    f"as a fraction 0=left 1=right and a confidence 0-1. "
                    f"Reply exactly: present=<yes|no> x=<0..1> conf=<0..1>")
    present = "yes" in ans.lower() and "present=no" not in ans.lower()
    x = re.search(r"x\s*=\s*([0-9.]+)", ans)
    c = re.search(r"conf\s*=\s*([0-9.]+)", ans)
    return {"present": present,
            "x_frac": float(x.group(1)) if x else 0.5,
            "confidence": float(c.group(1)) if c else (0.6 if present else 0.0),
            "raw": ans}


def observe(req):
    """Look + REMEMBER: describe the scene and store it in spatial memory."""
    img = _image_from(req)
    label = req.get("label", "")
    desc = vlm(img, "Describe what you see in detail: objects, people, colors, "
                    "and roughly where they are. One or two sentences.")
    cur = _db.execute("INSERT INTO obs (ts, label, description) VALUES (?,?,?)",
                      (time.time(), label, desc))
    _db.commit()
    return {"id": cur.lastrowid, "label": label, "description": desc}


def recall(req):
    """Recall past observations matching a query (keyword overlap ranking)."""
    query = req.get("query", "").lower()
    terms = set(re.findall(r"\w+", query))
    rows = _db.execute("SELECT id, ts, label, description FROM obs "
                       "ORDER BY ts DESC LIMIT 200").fetchall()
    scored = []
    for rid, ts, label, desc in rows:
        words = set(re.findall(r"\w+", f"{label} {desc}".lower()))
        score = len(terms & words)
        if score:
            scored.append((score, ts, {"id": rid, "ts": ts, "label": label,
                                       "description": desc}))
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return {"matches": [m for _, _, m in scored[:5]], "count": len(scored)}


ROUTES = {"/look": look, "/locate": locate, "/observe": observe, "/recall": recall}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "model": VLM_MODEL, "backend": OLLAMA})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        fn = ROUTES.get(self.path)
        if not fn:
            return self._send(404, {"error": "unknown skill"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            self._send(200, fn(req))
        except Exception as e:
            self._send(500, {"error": str(e)[:160]})

    def log_message(self, *a):
        pass  # quiet


if __name__ == "__main__":
    print(f"VLM perception service on :{PORT} (model={VLM_MODEL} via {OLLAMA})")
    print(f"skills: {', '.join(ROUTES)} · spatial memory: {DB}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
