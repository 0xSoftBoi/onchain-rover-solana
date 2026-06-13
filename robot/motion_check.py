"""
Camera-based motion + direction check — no human needed. Grabs frames from the
robot's own /stream before/after a drive and uses dense optical flow to decide:
  - did it MOVE?            (mean flow magnitude over threshold)
  - which DIRECTION?        (radial divergence: scene expands = FORWARD,
                             contracts = BACKWARD; net vertical/horizontal too)

Runs ON the Jetson (has OpenCV). Drives via the local API so it shares the one
camera/serial cleanly.

    python motion_check.py forward        # drive forward, report what the camera saw
    python motion_check.py spin
"""
import sys
import time

import cv2
import numpy as np
import requests

import os
API = os.environ.get("ROBOT_API", "http://localhost:8000")
CMDS = {
    "forward": {"left": 0.3, "right": 0.3},
    "backward": {"left": -0.3, "right": -0.3},
    "spin": {"left": 0.3, "right": -0.3},
}


def grab():
    """One grayscale frame from the MJPEG stream, downscaled for fast flow."""
    with requests.get(f"{API}/stream", stream=True, timeout=8) as r:
        buf = b""
        for chunk in r.iter_content(4096):
            buf += chunk
            a = buf.find(b"\xff\xd8"); b = buf.find(b"\xff\xd9", a + 2)
            if a != -1 and b != -1:
                arr = np.frombuffer(buf[a:b + 2], np.uint8)
                img = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
                return cv2.resize(img, (320, 240)) if img is not None else None
            if len(buf) > 2_000_000:
                return None


def drive(cmd, secs):
    t0 = time.time()
    while time.time() - t0 < secs:
        requests.post(f"{API}/drive", json=CMDS[cmd], timeout=2)
        time.sleep(0.08)
    requests.post(f"{API}/stop", timeout=2)


def analyze(a, b):
    flow = cv2.calcOpticalFlowFarneback(a, b, None, 0.5, 3, 21, 3, 5, 1.2, 0)
    fx, fy = flow[..., 0], flow[..., 1]
    mag = np.sqrt(fx**2 + fy**2)
    h, w = a.shape
    ys, xs = np.mgrid[0:h, 0:w]
    rx, ry = xs - w / 2, ys - h / 2
    rnorm = np.sqrt(rx**2 + ry**2) + 1e-6
    radial = (fx * rx + fy * ry) / rnorm          # >0 outward (forward looming)
    return {"moved": float(mag.mean()),
            "radial": float(radial.mean()),        # + forward, - backward
            "dx": float(fx.mean()), "dy": float(fy.mean())}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "forward"
    a = grab()
    if a is None:
        print("no frame"); return
    drive(cmd, 1.4)
    time.sleep(0.2)
    b = grab()
    if b is None:
        print("no frame after"); return
    r = analyze(a, b)
    moved = r["moved"] > 1.2          # px/frame avg; tune if needed
    if cmd == "spin":
        verdict = f"{'SPUN' if moved else 'no motion'} (h-flow dx={r['dx']:+.2f})"
    else:
        direction = "FORWARD" if r["radial"] > 0 else "BACKWARD"
        verdict = f"{'MOVED ' + direction if moved else 'NO MOTION'}"
    print(f"cmd={cmd}  moved_mag={r['moved']:.2f}  radial={r['radial']:+.3f}  "
          f"dx={r['dx']:+.2f} dy={r['dy']:+.2f}  ->  {verdict}")


if __name__ == "__main__":
    main()
