/**
 * Parlay / bet-builder — combine N legs across prop markets into one ticket. All legs
 * must hit. Leg odds are LOCKED at placement (standard parlay UX); combined odds and
 * payout are hard-capped and the liability is the house/treasury's (documented).
 *
 * Validation blocks self-hedging (two legs of one market) and known-correlated legs
 * (e.g. WINNER:guard + FASTEST_LAP:guard). MARGIN is winner-agnostic by design so it
 * stays decorrelated from WINNER.
 */
import { mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import * as markets from "./markets.js";

export type Leg = { marketId: string; type: markets.MarketType; outcome: string; lockedOdds: number };
export type TicketStatus = "open" | "won" | "lost" | "void";
export type Ticket = {
  id: string;
  nullifier: string;
  roundId: string;
  legs: Leg[];
  stake: number;
  combinedOdds: number;
  potentialPayout: number;
  status: TicketStatus;
  payout: number;
  createdAt: number;
  settledAt?: number;
};

export const MAX_LEGS = 8;
export const MAX_ODDS = 1000;
export const MAX_PAYOUT = 10000;

const DATA_DIR = new URL("../data", import.meta.url).pathname;
const journal = join(process.env.PARLAY_DATA_DIR || DATA_DIR, "parlays.jsonl");

const REG = new Map<string, Ticket>();
let loaded = false;
function load() {
  if (loaded) return;
  loaded = true;
  try {
    for (const line of readFileSync(journal, "utf8").split("\n")) {
      if (!line) continue;
      const t = JSON.parse(line) as Ticket;
      if (t?.id) REG.set(t.id, t); // last write wins (status updates re-appended)
    }
  } catch { /* fresh */ }
}
function persist(t: Ticket) {
  mkdirSync(dirname(journal), { recursive: true });
  appendFileSync(journal, `${JSON.stringify(t)}\n`);
}

/** Correlated cross-market outcomes that may not appear together in one ticket. */
function correlated(a: Leg, b: Leg): boolean {
  // winner of the race is heavily correlated with fastest lap by the same side
  const isWF = (x: Leg, y: Leg) => x.type === "WINNER" && y.type === "FASTEST_LAP" && x.outcome === y.outcome;
  return isWF(a, b) || isWF(b, a);
}

export function validate(roundId: string, rawLegs: { marketId: string; outcome: string }[], stake: number): Leg[] {
  if (!Array.isArray(rawLegs) || rawLegs.length < 2) throw new Error("a parlay needs at least 2 legs");
  if (rawLegs.length > MAX_LEGS) throw new Error(`max ${MAX_LEGS} legs`);
  if (!(stake > 0)) throw new Error("stake must be > 0");
  const seenMarkets = new Set<string>();
  const legs: Leg[] = [];
  for (const raw of rawLegs) {
    const m = markets.get(raw.marketId);
    if (!m) throw new Error(`unknown market ${raw.marketId}`);
    if (m.roundId !== roundId) throw new Error("legs must be in the current round");
    if (m.status !== "open") throw new Error(`market ${m.type} is ${m.status} — bets closed`);
    if (!m.outcomes.includes(raw.outcome)) throw new Error(`invalid outcome for ${m.type}`);
    if (seenMarkets.has(m.id)) throw new Error("only one leg per market");
    seenMarkets.add(m.id);
    legs.push({ marketId: m.id, type: m.type, outcome: raw.outcome, lockedOdds: markets.oddsFor(m)[raw.outcome] });
  }
  for (let i = 0; i < legs.length; i++)
    for (let j = i + 1; j < legs.length; j++)
      if (correlated(legs[i], legs[j])) throw new Error("correlated legs not allowed (same side winner + fastest lap)");
  return legs;
}

export function create(nullifier: string, roundId: string, rawLegs: { marketId: string; outcome: string }[], stake: number): Ticket {
  load();
  const legs = validate(roundId, rawLegs, stake);
  const combinedOdds = Math.min(MAX_ODDS, +legs.reduce((a, l) => a * l.lockedOdds, 1).toFixed(2));
  const potentialPayout = +Math.min(MAX_PAYOUT, stake * combinedOdds).toFixed(2);
  const t: Ticket = {
    id: "pl_" + randomUUID().slice(0, 12),
    nullifier, roundId, legs, stake, combinedOdds, potentialPayout,
    status: "open", payout: 0, createdAt: Date.now(),
  };
  REG.set(t.id, t);
  persist(t);
  return t;
}

export function forPlayer(nullifier: string): Ticket[] {
  load();
  return [...REG.values()].filter((t) => t.nullifier === nullifier).sort((a, b) => b.createdAt - a.createdAt);
}

/** Settle every open ticket of a round against the now-settled markets. All legs must
 *  hit; a void/unknown leg market voids that leg (refund-style: treat as auto-hit). */
export function settleForRound(roundId: string): Ticket[] {
  load();
  const settled: Ticket[] = [];
  for (const t of REG.values()) {
    if (t.roundId !== roundId || t.status !== "open") continue;
    let allHit = true, anyVoid = false;
    for (const leg of t.legs) {
      const m = markets.get(leg.marketId);
      const win = m?.winningOutcome ?? null;
      if (win == null) { anyVoid = true; continue; } // voided leg → ignore (refund-ish)
      if (win !== leg.outcome) { allHit = false; break; }
    }
    if (!allHit) { t.status = "lost"; t.payout = 0; }
    else if (anyVoid && t.legs.every((leg) => (markets.get(leg.marketId)?.winningOutcome ?? null) == null)) { t.status = "void"; t.payout = t.stake; }
    else { t.status = "won"; t.payout = t.potentialPayout; }
    t.settledAt = Date.now();
    persist(t);
    settled.push(t);
  }
  return settled;
}

export function publicTicket(t: Ticket) {
  return { id: t.id, roundId: t.roundId, legs: t.legs, stake: t.stake, combinedOdds: t.combinedOdds, potentialPayout: t.potentialPayout, status: t.status, payout: t.payout, createdAt: t.createdAt };
}
