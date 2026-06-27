/**
 * Prop markets — multiple parimutuel markets per race beyond the single race-winner
 * pool in race.ts. Each market is its own pool set with the SAME parimutuel odds math
 * (pariOdds) so display, betting, and settlement can never diverge.
 *
 * Markets: WINNER (guard|courier), MARGIN (blowout|photo — winner-AGNOSTIC gap size,
 * so it's decorrelated from WINNER for parlays), FASTEST_LAP (guard|courier),
 * DNF (clean|dnf). Settlement source per type is the race outcome + per-slot finish
 * times/telemetry in real mode; synthesized under DEMO_MOCK.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

export type MarketType = "WINNER" | "MARGIN" | "FASTEST_LAP" | "DNF";
export type MarketStatus = "open" | "locked" | "settled";
export type Market = {
  id: string;
  roundId: string;
  type: MarketType;
  label: string;
  outcomes: string[];
  pools: Record<string, number>;
  total: number;
  status: MarketStatus;
  winningOutcome?: string | null;
  settledAt?: number;
};

export const RAKE = 0.05;

/** Parimutuel decimal odds — identical formula to race.ts:147-150. Single source. */
export function pariOdds(poolOnOutcome: number, total: number): number {
  return poolOnOutcome > 0 ? +(total / poolOnOutcome).toFixed(2) : 1;
}

const DATA_DIR = new URL("../data/races", import.meta.url).pathname;
const dir = process.env.RACE_DATA_DIR || DATA_DIR;
const file = (roundId: string) => join(dir, safeId(roundId), "markets.json");
function safeId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error("unsafe round id");
  return id;
}
function writeAtomic(f: string, v: unknown) {
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`);
  renameSync(tmp, f);
}
function read(roundId: string): Market[] | null {
  try { return JSON.parse(readFileSync(file(roundId), "utf8")) as Market[]; } catch { return null; }
}

const REG = new Map<string, Market[]>();
const byId = new Map<string, Market>();

function index(roundId: string, markets: Market[]) {
  REG.set(roundId, markets);
  for (const m of markets) byId.set(m.id, m);
}
function persist(roundId: string) {
  const ms = REG.get(roundId);
  if (ms) writeAtomic(file(roundId), ms);
}

const DEFS: { type: MarketType; label: string; outcomes: string[] }[] = [
  { type: "WINNER", label: "Race Winner", outcomes: ["guard", "courier"] },
  { type: "MARGIN", label: "Winning Margin", outcomes: ["blowout", "photo"] },
  { type: "FASTEST_LAP", label: "Fastest Lap", outcomes: ["guard", "courier"] },
  { type: "DNF", label: "Did Not Finish", outcomes: ["clean", "dnf"] },
];

/** Deterministic-ish seed pools (so demo odds look alive and stay stable per round). */
function seedPools(roundId: string, type: MarketType, outcomes: string[]): Record<string, number> {
  const h = createHash("sha256").update(roundId + type).digest();
  const pools: Record<string, number> = {};
  outcomes.forEach((o, i) => { pools[o] = 2 + (h[i] % 7); });
  return pools;
}

export function ensureMarkets(roundId: string, opts: { seed?: boolean } = {}): Market[] {
  if (REG.has(roundId)) return REG.get(roundId)!;
  const fromDisk = read(roundId);
  if (fromDisk) { index(roundId, fromDisk); return fromDisk; }
  const markets: Market[] = DEFS.map((d) => {
    const pools = opts.seed ? seedPools(roundId, d.type, d.outcomes) : Object.fromEntries(d.outcomes.map((o) => [o, 0]));
    const total = Object.values(pools).reduce((a, b) => a + b, 0);
    return { id: `${d.type.toLowerCase()}-${roundId}`, roundId, type: d.type, label: d.label, outcomes: d.outcomes, pools, total, status: "open" as MarketStatus, winningOutcome: null };
  });
  index(roundId, markets);
  persist(roundId);
  return markets;
}

export function get(marketId: string): Market | undefined { return byId.get(marketId); }
export function marketsFor(roundId: string): Market[] { return REG.get(roundId) ?? ensureMarkets(roundId); }

export function oddsFor(m: Market): Record<string, number> {
  const o: Record<string, number> = {};
  for (const out of m.outcomes) o[out] = pariOdds(m.pools[out] ?? 0, m.total);
  return o;
}

export function viewMarket(m: Market) {
  return { id: m.id, type: m.type, label: m.label, outcomes: m.outcomes, pools: m.pools, total: +m.total.toFixed(2), odds: oddsFor(m), status: m.status, winningOutcome: m.winningOutcome ?? null };
}
export function view(roundId: string) {
  const ms = marketsFor(roundId);
  return { roundId, status: ms[0]?.status ?? "open", markets: ms.map(viewMarket) };
}

export function placeMarketBet(marketId: string, outcome: string, stake: number) {
  const m = byId.get(marketId);
  if (!m) throw new Error("unknown market");
  if (m.status !== "open") throw new Error(`market ${m.status} — bets closed`);
  if (!m.outcomes.includes(outcome)) throw new Error("invalid outcome");
  if (!(stake > 0)) throw new Error("stake must be > 0");
  m.pools[outcome] = (m.pools[outcome] ?? 0) + stake;
  m.total += stake;
  persist(m.roundId);
  return m;
}

export function lockAll(roundId: string) {
  for (const m of marketsFor(roundId)) if (m.status === "open") m.status = "locked";
  persist(roundId);
}

/** Settle every market for a round. winner is the race winner; mock synthesizes the
 *  prop outcomes (margin/fastest-lap/dnf) until per-slot finish times are captured. */
export function settleAll(roundId: string, ctx: { winner?: string; mock?: boolean }): Market[] {
  const ms = marketsFor(roundId);
  const h = createHash("sha256").update(roundId + "settle").digest();
  for (const m of ms) {
    if (m.status === "settled") continue;
    let outcome: string | null = null;
    if (m.type === "WINNER") outcome = ctx.winner ?? null;
    else if (ctx.mock) {
      if (m.type === "MARGIN") outcome = h[0] % 2 ? "photo" : "blowout";
      else if (m.type === "FASTEST_LAP") outcome = ctx.winner ?? (h[1] % 2 ? "courier" : "guard");
      else if (m.type === "DNF") outcome = h[2] % 5 === 0 ? "dnf" : "clean";
    }
    // real mode without per-slot timing/DNF telemetry → leave null (treated as void/refund)
    m.winningOutcome = outcome;
    m.status = "settled";
    m.settledAt = Date.now();
  }
  persist(roundId);
  return ms;
}
