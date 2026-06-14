"""
Drive logger — continuously capture a robot's telemetry during a (manual or
autonomous) drive, write a time-series, and print a summary. Use it to record
what actually happened each run so a few runs converge on a demo-ready config.

    python drive_log.py http://172.16.2.151:8000 --secs 60 --label guard-act2
    python drive_log.py http://192.168.55.1:8000 --secs 30          # courier (from USB host)

Polls /telemetry at ~5 Hz -> runs/<label>_<ts>.jsonl, then summarizes motor
activity, odometry travelled, battery sag, lidar closest approach + blocked
frames. Never raises; a dropped frame is skipped.
"""
import argparse
import json
import os
import sys
import time

import requests

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNS = os.path.join(REPO, "runs")


def run(base, secs, label, hz):
    os.makedirs(RUNS, exist_ok=True)
    ts = time.strftime("%Y-%m-%d_%H-%M-%S")
    path = os.path.join(RUNS, f"{label}_{ts}.jsonl")
    period = 1.0 / hz
    n = cmds = blocked = 0
    min_lidar, max_b, min_b = 99.0, 0.0, 99.0
    o0 = olast = None
    print(f"capturing {base} -> {os.path.relpath(path, REPO)} ({secs}s @{hz}Hz)")
    t0 = time.time()
    with open(path, "w") as f:
        while time.time() - t0 < secs:
            try:
                t = requests.get(f"{base}/telemetry", timeout=1.5).json()
            except Exception:
                time.sleep(period); continue
            lid = t.get("lidar") or {}
            row = {"t": round(time.time() - t0, 2), "L": t.get("left_cmd"),
                   "R": t.get("right_cmd"), "odoL": t.get("odometry_left"),
                   "odoR": t.get("odometry_right"), "yaw": t.get("yaw"),
                   "batt": t.get("battery_v"), "lidar_front": lid.get("front_m"),
                   "lidar_min": lid.get("min_m"), "blocked": lid.get("blocked"),
                   "estop": t.get("estop"), "deadman_ok": t.get("deadman_ok")}
            f.write(json.dumps(row) + "\n"); n += 1
            if (row["L"] or 0) or (row["R"] or 0):
                cmds += 1
            if row["lidar_min"] is not None:
                min_lidar = min(min_lidar, row["lidar_min"])
            if row["batt"]:
                max_b = max(max_b, row["batt"]); min_b = min(min_b, row["batt"])
            if row["blocked"]:
                blocked += 1
            if o0 is None and row["odoL"] is not None:
                o0 = (row["odoL"], row["odoR"])
            if row["odoL"] is not None:
                olast = (row["odoL"], row["odoR"])
            time.sleep(period)
    dl = (olast[0] - o0[0]) if o0 else 0
    dr = (olast[1] - o0[1]) if o0 else 0
    print(f"\n=== {label} summary ({n} samples) ===")
    print(f"  motor cmd frames: {cmds}/{n}  ({'DRIVEN' if cmds else 'STATIONARY'})")
    print(f"  odometry delta:   L={dl}  R={dr}")
    if max_b:
        print(f"  battery:          {max_b:.2f}V -> {min_b:.2f}V  (sag {max_b - min_b:.2f}V)")
    print(f"  lidar closest:    {min_lidar:.3f}m   blocked frames: {blocked}/{n}")
    print(f"  time-series:      {os.path.relpath(path, REPO)}")
    return path


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("base", help="robot api base url, e.g. http://172.16.2.151:8000")
    ap.add_argument("--secs", type=float, default=60)
    ap.add_argument("--label", default="drive")
    ap.add_argument("--hz", type=float, default=5)
    a = ap.parse_args()
    run(a.base, a.secs, a.label, a.hz)
