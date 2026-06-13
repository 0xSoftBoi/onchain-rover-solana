#!/usr/bin/env python3
"""Tiny physical drive smoke for robot-harness.

This script intentionally refuses to run unless ALLOW_PHYSICAL_MOTION=1 is set.
Use it only when the robot is lifted, blocked, or otherwise safe to move.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a gated robot-harness drive smoke.")
    parser.add_argument("--url", default=os.environ.get("ROVER_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--left", type=float, default=float(os.environ.get("SMOKE_LEFT", "0.05")))
    parser.add_argument("--right", type=float, default=float(os.environ.get("SMOKE_RIGHT", "0.05")))
    parser.add_argument(
        "--duration-ms",
        type=int,
        default=int(os.environ.get("SMOKE_DURATION_MS", "250")),
    )
    parser.add_argument(
        "--speed-mode",
        choices=("low", "medium", "high"),
        default=os.environ.get("SMOKE_SPEED_MODE", "low"),
    )
    parser.add_argument(
        "--min-odometry-delta",
        type=float,
        default=float(os.environ.get("SMOKE_MIN_ODOMETRY_DELTA", "0.0001")),
    )
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("SMOKE_TIMEOUT", "5")))
    return parser.parse_args()


def request_json(base_url: str, method: str, path: str, timeout: float, payload: Any = None) -> Any:
    data = None
    headers = {"accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["content-type"] = "application/json"

    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} failed with HTTP {error.code}: {body}") from error


def odometry_total(sensors: Any) -> float:
    odometry = sensors.get("odometry") if isinstance(sensors, dict) else None
    if not isinstance(odometry, dict):
        raise RuntimeError(f"sensors response missing odometry: {sensors!r}")
    left = odometry.get("left")
    right = odometry.get("right")
    if not isinstance(left, (int, float)) or not isinstance(right, (int, float)):
        raise RuntimeError(f"odometry values are not numeric: {odometry!r}")
    return abs(float(left)) + abs(float(right))


def main() -> int:
    if os.environ.get("ALLOW_PHYSICAL_MOTION") != "1":
        print("refusing to move: set ALLOW_PHYSICAL_MOTION=1 after making the robot safe", file=sys.stderr)
        return 2

    args = parse_args()
    token = f"smoke-{int(time.time())}-{os.getpid()}"
    stopped = False

    health = request_json(args.url, "GET", "/health", args.timeout)
    if health.get("estop"):
        raise RuntimeError("robot estop is active; reset it explicitly before running motion smoke")

    before = request_json(args.url, "GET", "/sensors", args.timeout)
    before_total = odometry_total(before)

    request_json(
        args.url,
        "POST",
        "/pilot/authorize",
        args.timeout,
        {"token": token, "ttl_secs": 5, "speed_mode": args.speed_mode},
    )

    try:
        request_json(
            args.url,
            "POST",
            "/drive",
            args.timeout,
            {"token": token, "left": args.left, "right": args.right},
        )
        time.sleep(max(args.duration_ms, 1) / 1000)
    finally:
        try:
            request_json(args.url, "POST", "/motors/stop", args.timeout)
            stopped = True
        except Exception as error:  # noqa: BLE001
            print(f"warning: stop failed: {error}", file=sys.stderr)

    after = request_json(args.url, "GET", "/sensors", args.timeout)
    after_total = odometry_total(after)
    delta = abs(after_total - before_total)

    print(
        json.dumps(
            {
                "ok": delta >= args.min_odometry_delta and stopped,
                "url": args.url,
                "speed_mode": args.speed_mode,
                "left": args.left,
                "right": args.right,
                "duration_ms": args.duration_ms,
                "before_odometry_total": before_total,
                "after_odometry_total": after_total,
                "delta": delta,
                "stopped": stopped,
            },
            indent=2,
            sort_keys=True,
        )
    )

    if delta < args.min_odometry_delta:
        raise RuntimeError(
            f"odometry did not change enough: delta={delta:.6f}, "
            f"min={args.min_odometry_delta:.6f}"
        )
    if not stopped:
        raise RuntimeError("stop command did not complete")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001
        print(f"drive smoke failed: {error}", file=sys.stderr)
        raise SystemExit(1)
