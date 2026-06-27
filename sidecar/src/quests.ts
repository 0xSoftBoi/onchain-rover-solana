/**
 * Quests / missions — daily + weekly, table-driven. Progress is bucketed by a period
 * key (daily:<YYYY-MM-DD> / weekly:<ISO-week>) so reset is implicit: a new period is a
 * new bucket = zero progress, no cron. Claims are server-validated and idempotent.
 * Operates on a PlayerProfile in place; the caller persists.
 */
import type { PlayerProfile, Credit } from "./player-store.js";

export type Reward = { type: "points" | "rakeback" | "freebet"; amount: number; currency?: string };
type Quest = {
  id: string;
  cadence: "daily" | "weekly";
  desc: string;
  target: number;
  reward: Reward;
  on: "bet" | "settle";
  match: (ctx: any) => boolean;
  inc: (ctx: any) => number;
};

const one = () => 1;
export const QUESTS: Quest[] = [
  { id: "daily_place_3", cadence: "daily", desc: "Place 3 bets", target: 3, reward: { type: "points", amount: 50 }, on: "bet", match: () => true, inc: one },
  { id: "daily_underdog", cadence: "daily", desc: "Back the underdog", target: 1, reward: { type: "points", amount: 30 }, on: "bet", match: (c) => !!c.isUnderdog, inc: one },
  { id: "daily_prop", cadence: "daily", desc: "Place 2 prop-market bets", target: 2, reward: { type: "points", amount: 40 }, on: "bet", match: (c) => !!c.market && c.market !== "WINNER", inc: one },
  { id: "weekly_wager_50", cadence: "weekly", desc: "Wager 50 USDC this week", target: 50, reward: { type: "rakeback", amount: 1.0, currency: "USDC" }, on: "bet", match: () => true, inc: (c) => Math.max(0, c.stake || 0) },
  { id: "weekly_parlay_win", cadence: "weekly", desc: "Win a parlay", target: 1, reward: { type: "freebet", amount: 1.0, currency: "USDC" }, on: "settle", match: (c) => !!c.won && (c.parlayDepth || 0) >= 2, inc: one },
  { id: "weekly_underdog_win", cadence: "weekly", desc: "Win backing the underdog", target: 1, reward: { type: "rakeback", amount: 2.0, currency: "USDC" }, on: "settle", match: (c) => !!c.won && !!c.isUnderdog, inc: one },
];

function dailyKey(now = Date.now()): string { return "daily:" + new Date(now).toISOString().slice(0, 10); }
function weeklyKey(now = Date.now()): string {
  const d = new Date(now);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `weekly:${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
function keyFor(cadence: "daily" | "weekly"): string { return cadence === "daily" ? dailyKey() : weeklyKey(); }

function bucket(p: PlayerProfile, key: string): Record<string, { progress: number; claimedAt: number | null }> {
  return (p.quests[key] ||= {});
}
function pruneOld(p: PlayerProfile) {
  const keep = new Set([dailyKey(), weeklyKey()]);
  for (const k of Object.keys(p.quests)) if (!keep.has(k)) delete p.quests[k];
}

/** Advance quest progress for an event. Mutates the profile; returns newly-completed ids. */
export function onEvent(p: PlayerProfile, on: "bet" | "settle", ctx: any): string[] {
  pruneOld(p);
  const completed: string[] = [];
  for (const q of QUESTS) {
    if (q.on !== on || !q.match(ctx)) continue;
    const b = bucket(p, keyFor(q.cadence));
    const st = (b[q.id] ||= { progress: 0, claimedAt: null });
    const before = st.progress >= q.target;
    st.progress = Math.min(q.target, st.progress + q.inc(ctx));
    if (!before && st.progress >= q.target) completed.push(q.id);
  }
  return completed;
}

export function view(p: PlayerProfile) {
  pruneOld(p);
  const resetsAt = { daily: Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1), weekly: 0 };
  return {
    points: p.points,
    resetsAt,
    quests: QUESTS.map((q) => {
      const st = (p.quests[keyFor(q.cadence)] || {})[q.id] || { progress: 0, claimedAt: null };
      return { id: q.id, cadence: q.cadence, desc: q.desc, target: q.target, progress: Math.min(st.progress, q.target), complete: st.progress >= q.target, claimed: st.claimedAt != null, reward: q.reward };
    }),
  };
}

/** Claim a completed, unclaimed quest. Idempotent. Mutates profile; caller persists. */
export function claim(p: PlayerProfile, id: string): { ok: boolean; reason?: string; granted?: Reward; points?: number } {
  const q = QUESTS.find((x) => x.id === id);
  if (!q) return { ok: false, reason: "unknown_quest" };
  const b = bucket(p, keyFor(q.cadence));
  const st = b[id];
  if (!st || st.progress < q.target) return { ok: false, reason: "not_complete" };
  if (st.claimedAt != null) return { ok: false, reason: "already_claimed" };
  st.claimedAt = Date.now();
  if (q.reward.type === "points") p.points += q.reward.amount;
  else {
    p.points += Math.round(q.reward.amount * 10); // also nudge the airdrop tally
    const c: Credit = { type: q.reward.type, amount: q.reward.amount, reason: q.id, at: Date.now() };
    p.credits.push(c);
  }
  return { ok: true, granted: q.reward, points: p.points };
}
