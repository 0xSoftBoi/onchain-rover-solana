# Rover Harness

Rust race-mode service for one Jetson rover. It is the hardware boundary for
serial control, pilot tokens, deadman safety, speed caps, and telemetry.

## Local simulation

```bash
cd robot-harness
cargo run -- --mode sim --role courier --listen 127.0.0.1:8000
```

Authorize a pilot token:

```bash
curl -s http://127.0.0.1:8000/pilot/authorize \
  -H 'content-type: application/json' \
  -d '{"token":"dev","ttl_secs":120,"speed_mode":"medium"}'
```

Health:

```bash
curl -s http://127.0.0.1:8000/health
```

## Jetson serial mode

Stop the stock Waveshare app first so only this service owns `/dev/ttyTHS1`.

```bash
pgrep -f '[a]pp.py' | xargs -r kill
cd robot-harness
ROBOT_ROLE=courier ROVER_MODE=serial ROVER_SERIAL_PORT=/dev/ttyTHS1 \
  cargo run --release -- --listen 0.0.0.0:8000
```

## API

- `GET /health`
- `POST /pilot/authorize`
- `POST /pilot/speed-mode`
- `POST /drive`
- `POST /stop`
- `WS /ws/drive`
- `WS /ws/telemetry`

Drive commands are clamped server-side by the session speed mode:

- `low`: `0.15`
- `medium`: `0.25`
- `high`: `0.35`

The deadman stops motors when drive commands go stale.
