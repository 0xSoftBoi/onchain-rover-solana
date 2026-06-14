"""
Run logger — capture comparable data each test run so a few runs converge on a
demo-ready config. Never raises (a dead endpoint is a null field, not a crash).

    python run_log.py snapshot "act1 try3"     # capture current state -> runs/
    python run_log.py snapshot "act1 try3" --note "courier veered right, batt low"
    python run_log.py compare                   # cross-run table (spot what drifted)
    python run_log.py note "fixed odom scale to 0.00012"

Each snapshot records, timestamped:
  - calibration env in effect (odom scale, steer/lat sign, drive invert, gyro)
  - demo_doctor board (what was up/down)
  - per-rover telemetry: battery_v, accel, gyro, odom, current action
  - which autonomy backends are live (nomad/stub, robobrain/stub)
  - tail of the policy/brain server logs (steer behaviour) if present

Compare across runs to see, e.g., "steering drifts right when batt < 11V".
"""
import json
import os
import sys
import time

import demo_doctor as dr   # reuse endpoints + health/telemetry checks

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNS_DIR = os.environ.get("RUNS_DIR", os.path.join(REPO, "runs"))
INDEX = os.path.join(RUNS_DIR, "index.jsonl")
DEMO_RUN = os.path.join(REPO, ".demo-run")   # demo_up.sh logs

# Per-unit calibration that changes behaviour run-to-run — the usual suspects.
CALIB_VARS = ["ROVER_ODOM_SCALE", "NAV_STEER_SIGN", "NAV_LAT_SIGN",
              "ROVER_DRIVE_INVERT", "ROVER_GYRO_SCALE", "ROVER_NAV",
              "ROVER_CRUISE", "BRAIN_GOAL"]


def _stamp():
    # local wall-clock, filesystem-safe
    return time.strftime("%Y-%m-%d_%H-%M-%S")


def _telemetry(base):
    ok, data, err = dr._get(f"{base}/telemetry", timeout=4)
    if ok and isinstance(data, dict):
        return data
    return {"error": err or "no telemetry"}


def _backend(base):
    ok, data, _ = dr._get(f"{base}/health", timeout=3)
    return (data or {}).get("backend") if ok else None


def _logtail(path, n=12):
    try:
        with open(path) as f:
            return [ln.rstrip() for ln in f.readlines()[-n:]]
    except Exception:
        return []


def snapshot(label, note=None):
    os.makedirs(RUNS_DIR, exist_ok=True)
    ts = _stamp()
    # demo_doctor board (reuse its checks, capture instead of printing)
    board = {}
    for name, fn in dr.build_checks():
        try:
            ok, detail, critical = fn()
        except Exception as e:
            ok, detail, critical = False, f"errored: {str(e)[:60]}", False
        board[name] = {"ok": ok, "detail": detail, "critical": critical}

    rec = {
        "ts": ts,
        "label": label,
        "note": note,
        "calibration": {k: os.environ.get(k) for k in CALIB_VARS if os.environ.get(k)},
        "backends": {"nav": _backend(dr.NAV_SERVER),
                     "brain": _backend(dr.BRAIN_SERVER) if dr.BRAIN_SERVER else None},
        "rovers": {"guard": _telemetry(dr.GUARD), "courier": _telemetry(dr.COURIER)},
        "doctor": board,
        "doctor_ok": sum(1 for v in board.values() if v["ok"]),
        "doctor_total": len(board),
        "logs": {"nav": _logtail(os.path.join(DEMO_RUN, "nav.log")),
                 "brain": _logtail(os.path.join(DEMO_RUN, "brain.log"))},
    }
    # per-run file + compact index row
    path = os.path.join(RUNS_DIR, f"{ts}_{label.replace(' ', '-')}.json")
    with open(path, "w") as f:
        json.dump(rec, f, indent=2)
    row = {k: rec[k] for k in ("ts", "label", "note", "calibration", "backends",
                               "doctor_ok", "doctor_total")}
    row["batt"] = {r: rec["rovers"][r].get("battery_v") for r in ("guard", "courier")}
    with open(INDEX, "a") as f:
        f.write(json.dumps(row) + "\n")
    print(f"✓ snapshot → {os.path.relpath(path, REPO)}")
    print(f"  doctor {rec['doctor_ok']}/{rec['doctor_total']} ok · "
          f"batt guard={rec['rovers']['guard'].get('battery_v')} "
          f"courier={rec['rovers']['courier'].get('battery_v')} · "
          f"nav={rec['backends']['nav']} brain={rec['backends']['brain']}")
    return rec


def note(text):
    os.makedirs(RUNS_DIR, exist_ok=True)
    with open(INDEX, "a") as f:
        f.write(json.dumps({"ts": _stamp(), "label": "NOTE", "note": text}) + "\n")
    print(f"✓ note logged: {text}")


def compare():
    if not os.path.exists(INDEX):
        print("no runs yet — capture one with: python run_log.py snapshot <label>")
        return
    rows = [json.loads(l) for l in open(INDEX) if l.strip()]
    print(f"\n{'time':17} {'label':16} {'ok':>5} {'g.batt':>7} {'c.batt':>7} {'nav':>8}  note")
    print("─" * 88)
    for r in rows:
        if r.get("label") == "NOTE":
            print(f"{r['ts']:17} {'· note':16} {'':>5} {'':>7} {'':>7} {'':>8}  {r.get('note','')}")
            continue
        b = r.get("batt", {})
        nav = (r.get("backends") or {}).get("nav") or "-"
        ok = f"{r.get('doctor_ok','?')}/{r.get('doctor_total','?')}"
        print(f"{r['ts']:17} {r.get('label','')[:16]:16} {ok:>5} "
              f"{str(b.get('guard','-')):>7} {str(b.get('courier','-')):>7} {nav:>8}  {r.get('note') or ''}")
    print()


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__); return
    cmd = argv[0]
    if cmd == "snapshot":
        label = argv[1] if len(argv) > 1 and not argv[1].startswith("--") else "run"
        note_txt = None
        if "--note" in argv:
            note_txt = " ".join(argv[argv.index("--note") + 1:])
        snapshot(label, note_txt)
    elif cmd == "note":
        note(" ".join(argv[1:]))
    elif cmd == "compare":
        compare()
    else:
        print(f"unknown command: {cmd}\n"); print(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
