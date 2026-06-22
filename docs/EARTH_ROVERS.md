# Earth Rovers integration (FrodoBots SDK)

Drive a **real [FrodoBots Earth Rover](https://github.com/frodobots-org/earth-rovers-sdk)**
(openClaw branch) as a Clanker 5000 fleet robot. "Hire a physical robot over
HTTP" — now the physical robot can be a globally-distributed Earth Rover.

## How it fits

The Earth Rovers SDK is a separate Python/Hypercorn service (`:8000`) with its
own API + auth. Our sidecar drives robots over a different contract
(`/drive {token,left,right}`, `/pilot/authorize`, `/health`). `earth-rover.ts`
bridges the two:

```
phone pilot ──► sidecar ──► POST /earthrover/drive {left,right}
                              └─► diffToTwist ─► Earth Rovers POST /control {command:{linear,angular,lamp}}
```

`earthRoverRouter()` (mounted at **`/earthrover`**) speaks our robot contract and
translates each call to the SDK:

| Our contract | → Earth Rovers SDK |
|---|---|
| `POST /earthrover/drive {left,right}` | `POST /control` (differential → twist) |
| `POST /earthrover/pilot/authorize` | (no-op; SDK self-auths) |
| `GET /earthrover/health` | `GET /data` reachability |
| `GET /earthrover/data` | `GET /data` (battery/gps/orientation/…) |
| `GET /earthrover/screenshot` | `GET /v2/screenshot` |
| `POST /earthrover/speak {text}` | `POST /speak` |
| `POST /earthrover/command {text}` | **openClaw** natural-language → `/control` / `/prompt` / `/speak` |

So an Earth Rover plugs into the **existing pilot/drive/telemetry/estop flow**
with zero changes to `robot-link.ts`.

## Run it

1. Stand up the Earth Rovers SDK (its own repo): set `SDK_API_TOKEN`
   (https://my.frodobots.com/owner/settings) + `BOT_SLUG` in *its* `.env`, then
   `hypercorn main:app --reload` (→ `:8000`).
2. In our sidecar `.env`: `EARTH_ROVER_URL=http://127.0.0.1:8000`.
3. Make a fleet robot an Earth Rover — point its URL at the adapter:
   `GUARD_URL=http://127.0.0.1:4021/earthrover`.
4. Hire/pilot guard as usual; drive commands now move the real Earth Rover.

## openClaw — natural-language control

`POST /earthrover/command { "text": "forward" }` maps a phrase to a rover action
(`forward|back|left|right|stop`, `look` → Gemini vision caption, `say <text>` →
TTS). This is the openClaw idea (a chat/AI-agent gateway) wired into the fleet;
an autonomous agent can also call `earth-rover.ts` (`control`, `promptVision`,
`speak`, `startMission`) directly.

## Notes / next

- **Camera**: `/v2/screenshot` returns base64 frames; the UI can poll
  `/earthrover/screenshot`. Streaming MJPEG (to match the harness camera proxy)
  is a follow-up (frame→MJPEG bridge).
- **Missions**: `startMission` / `checkpoints` / `endMission` are wired in the
  client; surface them in the operator UI when running Earth Rover missions.
- **Settlement** is unchanged — hiring/piloting an Earth Rover still pays x402
  SPL-USDC and settles through the clanker5000 program.
