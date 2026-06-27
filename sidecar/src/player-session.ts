/**
 * Player session — a lightweight bearer token bound to a World ID nullifier so a
 * verified human can place many bets/parlays and have quests/stats tracked, without
 * re-running the IDKit proof on every call (the legacy /race/bet still takes a fresh
 * proof; this is the additive multi-action path).
 *
 * NOTE: this is distinct from session.ts (the operator Ledger ceremony). Tokens are
 * HMAC-signed (no JWT dependency), short-TTL, constant-time verified. No funds move
 * client-side — on-chain bets stay relayer-staked — so a bearer token is acceptable.
 *
 * Demo path: under DEMO_MOCK, /player/session can mint a token over a synthesized
 * nullifier WITHOUT calling worldid.verify (which throws when WORLD_APP_ID is unset).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SECRET = process.env.PLAYER_SESSION_SECRET || randomBytes(32).toString("hex");
const TTL_MS = 2 * 60 * 60 * 1000; // 2h

type Payload = { nullifier: string; iat: number; exp: number; demo: boolean };

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function sign(body: string): string {
  return b64url(createHmac("sha256", SECRET).update(body).digest());
}

export function issueToken(nullifier: string, opts: { demo?: boolean } = {}): { token: string; payload: Payload } {
  const now = Date.now();
  const payload: Payload = { nullifier, iat: now, exp: now + TTL_MS, demo: Boolean(opts.demo) };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return { token: `v1.${body}.${sign(body)}`, payload };
}

export function verifyToken(token: string): Payload {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("bad token");
  const [, body, mac] = parts;
  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("bad signature");
  const payload = JSON.parse(unb64url(body).toString("utf8")) as Payload;
  if (!payload.nullifier || typeof payload.exp !== "number" || Date.now() > payload.exp) throw new Error("expired");
  return payload;
}

function bearer(req: any): string | null {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1] : null;
}

/** Require a valid session; sets req.nullifier or 401. */
export function auth(req: any, res: any, next: any) {
  try {
    const t = bearer(req);
    if (!t) return res.status(401).json({ error: "no session — POST /player/session first" });
    req.nullifier = verifyToken(t).nullifier;
    next();
  } catch (e: any) {
    res.status(401).json({ error: String(e?.message ?? e) });
  }
}

/** Attach req.nullifier when a valid token is present, else continue anonymous. */
export function optionalAuth(req: any, _res: any, next: any) {
  try {
    const t = bearer(req);
    if (t) req.nullifier = verifyToken(t).nullifier;
  } catch {
    /* ignore — anonymous */
  }
  next();
}
