/**
 * Earth Rovers SDK integration — drive a real FrodoBots Earth Rover as a Clanker
 * fleet robot. (https://github.com/frodobots-org/earth-rovers-sdk, openClaw branch)
 *
 * The Earth Rovers SDK is a separate Python/Hypercorn service on :8000 with its
 * own auth (SDK_API_TOKEN + BOT_SLUG in *its* .env). It speaks a different API
 * than our Jetson harness:
 *   POST /control {command:{linear,angular,lamp}}   (twist, not differential)
 *   GET  /data                                       (battery/gps/orientation/…)
 *   GET  /v2/screenshot, /v2/front, /v2/rear         (base64 frames)
 *   POST /speak {text}                               (TTS)   POST /prompt (vision)
 *   POST /start-mission · /end-mission · /checkpoints-list · …
 *
 * `earthRoverRouter()` exposes OUR robot contract (/drive {token,left,right},
 * /pilot/authorize, /health, …) and translates to the SDK, so an Earth Rover
 * plugs straight into the existing pilot/drive/telemetry/estop flow: just point
 * a robot's URL at this adapter, e.g. GUARD_URL=http://127.0.0.1:4021/earthrover.
 *
 * Plus `command()` — the openClaw idea: natural-language → rover control.
 */
import "./env.js";
import { Router } from "express";

const BASE = () => process.env.EARTH_ROVER_URL ?? "http://127.0.0.1:8000";
const clamp = (n: number) => Math.max(-1, Math.min(1, Number.isFinite(n) ? n : 0));

async function sdk<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`earth-rover ${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

// ---- typed SDK client -------------------------------------------------------

export const control = (linear: number, angular: number, lamp = 0) =>
  sdk("POST", "/control", { command: { linear: clamp(linear), angular: clamp(angular), lamp: lamp ? 1 : 0 } });
export const data = () => sdk("GET", "/data");
export const screenshot = () => sdk("GET", "/v2/screenshot");
export const front = () => sdk("GET", "/v2/front");
export const rear = () => sdk("GET", "/v2/rear");
export const speak = (text: string) => sdk("POST", "/speak", { text });
export const promptVision = () => sdk("POST", "/prompt", {});
export const startMission = () => sdk("POST", "/start-mission");
export const endMission = () => sdk("POST", "/end-mission");
export const checkpoints = () => sdk("GET", "/checkpoints-list");

/** Differential drive (left,right ∈ [-1,1]) → Earth Rovers twist (linear,angular). */
export function diffToTwist(left: number, right: number) {
  return { linear: clamp((left + right) / 2), angular: clamp((right - left) / 2) };
}

/**
 * openClaw-style natural-language control: map a phrase to a rover action.
 * Intentionally simple + safe (a real agent can call control()/promptVision()
 * directly). Returns what it did.
 */
export async function command(text: string) {
  const t = String(text || "").toLowerCase().trim();
  if (/\b(stop|halt|brake|freeze)\b/.test(t)) return { action: "stop", ...(await control(0, 0)) };
  if (/\b(forward|ahead|go|drive on)\b/.test(t)) return { action: "forward", ...(await control(0.6, 0)) };
  if (/\b(back|reverse|backward)\b/.test(t)) return { action: "reverse", ...(await control(-0.5, 0)) };
  if (/\bleft\b/.test(t)) return { action: "left", ...(await control(0.2, -0.6)) };
  if (/\bright\b/.test(t)) return { action: "right", ...(await control(0.2, 0.6)) };
  if (/\b(look|see|describe|what.*see)\b/.test(t)) return { action: "vision", ...(await promptVision()) };
  const say = t.match(/\b(?:say|speak)\s+(.+)$/);
  if (say) return { action: "speak", ...(await speak(say[1])) };
  return { action: "unknown", text, hint: "try: forward|back|left|right|stop|look|say <text>" };
}

// ---- adapter router: OUR robot contract -> Earth Rovers SDK -----------------

export function earthRoverRouter(): Router {
  const r = Router();

  // Pilot tokens are managed by our sidecar; the SDK auths itself. Accept + ok.
  r.post("/pilot/authorize", (_req, res) => res.json({ ok: true, backend: "earthrover" }));

  r.get("/health", async (_req, res) => {
    try {
      await data();
      res.json({ ok: true, backend: "earthrover", url: BASE() });
    } catch (e) {
      res.status(503).json({ ok: false, error: (e as Error).message });
    }
  });

  // Sidecar drive: differential {left,right} -> Earth Rovers twist /control.
  r.post("/drive", async (req, res) => {
    const { left = 0, right = 0 } = req.body ?? {};
    const { linear, angular } = diffToTwist(Number(left), Number(right));
    try {
      res.json(await control(linear, angular));
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  r.get("/data", async (_req, res) => {
    try { res.json(await data()); } catch (e) { res.status(502).json({ error: (e as Error).message }); }
  });
  r.get("/screenshot", async (_req, res) => {
    try { res.json(await screenshot()); } catch (e) { res.status(502).json({ error: (e as Error).message }); }
  });
  r.post("/speak", async (req, res) => {
    try { res.json(await speak(String(req.body?.text ?? ""))); } catch (e) { res.status(502).json({ error: (e as Error).message }); }
  });
  // openClaw: POST /earthrover/command { text }
  r.post("/command", async (req, res) => {
    try { res.json(await command(String(req.body?.text ?? ""))); } catch (e) { res.status(502).json({ error: (e as Error).message }); }
  });

  return r;
}
