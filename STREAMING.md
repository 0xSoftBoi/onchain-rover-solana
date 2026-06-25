# 🏁 CLANKER 500 — streaming & broadcast guide

The livestream kit in [`site/`](site/) is three self-contained pages (pure HTML/CSS/JS, no build).
Serve the folder and point OBS at the URLs.

```bash
cd site && python3 -m http.server 8080
```

| View | URL | Use |
|---|---|---|
| **Broadcast** | `http://localhost:8080/broadcast.html` | Full-screen auto-cycling show (grid cams · bet/predict · standings). Capture or use as a full-screen Browser Source. |
| **Overlay** | `http://localhost:8080/overlay.html` | **Transparent** scorebug + ticker + alerts to layer over your own camera feed. |
| **Dashboard** | `http://localhost:8080/` | The instrument/kiosk dashboard. |

By default both run on a self-contained **mock feed** (`clanker-mock.js`). Append `?api=<sidecar-url>`
to bind to a live sidecar; the connection badge flips to **Live sidecar** (and **Reconnecting…** if polls drop).

## OBS setup
1. **Sources → + → Browser**. URL = one of the above. **Width 1920 · Height 1080 · FPS 30** (match your canvas).
2. Place the **overlay** above your camera source. Transparency is automatic (page background is `transparent`).
3. Uncheck **Shutdown source when not visible** so data keeps flowing.
4. Weak encoder? Add **`?lite=1`** (kills decorative animation). The page also pauses polling/animation when the source is hidden (best-effort; `?freeze=0` disables that).

## Query flags

### Broadcast (`broadcast.html`)
| Flag | Effect |
|---|---|
| `?api=<url>` | Bind to a live sidecar instead of the mock. |
| `?actions=<url>` / `?blink=1` | Turn the bet/tip QRs into Solana Action (Blink) links — see below. |
| `?lite=1` | Strip decorative infinite animation (encoder-friendly). |
| `?clean=1` | Minimal mode: drop heavy livery; hide scorebug/ticker during the settle beat. |
| `?cb=1` | Colorblind-safe palette (guard → blue; blue/orange/red axis). |
| `?vertical=1` | 9:16 layout for Shorts/TikTok capture. |
| `?osd=1` | FPV-style cam telemetry OSD (P1/P2 · signal · est. speed). |
| `?freeze=0` | Disable the Page-Visibility pause (fallback if OBS CEF misbehaves). |
| `?season=reset` / `?backers=reset` | Clear the persisted season / backers wall. |

### Overlay (`overlay.html`)
| Flag | Effect |
|---|---|
| `?api=<url>` | Bind to a live sidecar. |
| `?bar=top` | Move the scorebug to the top. |
| `?bug=0` · `?clock=0` · `?sound=0` | Hide the brand bug / clock / mute audio. |
| `?sponsors=1` | Show the rotating sponsor pill. |
| `?demo=1` | Fire test moments/pilot/floaters on a timer (for framing). |
| `?lite=1` · `?cb=1` · `?freeze=0` | As above. |

Combine freely, e.g. `overlay.html?bar=top&clock=0&cb=1`.

## Operator hotkeys (broadcast)
| Key | Action |
|---|---|
| `n` / `→` | Next scene |
| `p` / `←` | Previous scene |
| `m` | Fire a test takeover (verify alerts on air) |
| `c` | Toggle clean mode |
| `l` | Toggle lite mode |

## Sound
The broadcast/overlay synthesize audio cues (settle ka-ching, photo-finish cheer, bet blip, lock).
Browsers block autoplay until a gesture — click once in a preview tab; **OBS browser sources auto-unlock**.
A faint 🔊 toggle (top-left) mutes; `?sound=0` disables.

## Solana Blinks (bet/tip from a QR or tweet)
Set **`?actions=<sidecar-origin>`** (or `window.CLANKER_ACTIONS`) so the "Tip the Fleet" QR encodes a
`solana-action:` URL a Blink-aware wallet (Phantom/Backpack/Solflare, dial.to) can sign. This needs the
sidecar **Actions API**: `GET /actions.json`, `GET/POST /api/actions/tip` (clean account-only USDC
transfer), `GET/POST /api/actions/bet` (requires a World-ID-verified nullifier — wallet Blinks can't run
the IDKit widget, so the on-site World-ID flow stays the primary bet path).
