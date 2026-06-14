# web/

This directory is reserved for a future standalone partner frontend. It is not
the active Clanker500 operator UI.

The current browser surfaces ship from `sidecar/public/` and are served by the
sidecar on `:4021`:

- `round.html` / `lobby.html`: operator race board and phone links.
- `field.html`: field preflight and stage readiness.
- `pilot.html`: legacy camera-first pilot UI.
- `pilot-react.html`: React pilot UI with WebRTC control and WebSocket fallback.
- `finish-camera.html`: browser finish detector and manual trigger.
- `ledger.html`: Ledger clear-signing surface.
- `wall.html`, `broadcast.html`, `race.html`, `show-links.html`: demo and show
  surfaces.

If a Next.js partner app is revived here, keep it as a client of the sidecar
routes instead of reimplementing race state or robot control. The minimum
contract to consume is:

- `GET /field/preflight`
- `GET /race/rounds`
- `GET /race/round/:id`
- `POST /race/round/:id/pilot/session`
- `POST /pilot/webrtc/offer`
- `GET /robot/:robot/stream`
- `GET /race/round/:id/evidence`
- `GET /race/round/:id/telemetry-trace`
