/**
 * Weekly wager race — a prize-pool leaderboard ranking humans by USDC wagered within
 * a week. Production-grade rollover: the week id is DERIVED FROM THE CLOCK (never a
 * stateful counter), and reconcile() is idempotent — guarded by a persisted `closed`
 * flag + an append-only winners.jsonl de-duped by weekId, so a crash/restart can never
 * double-pay or wedge. Prize pool accrues a declared rake % of wager volume (the Pit
 * Fund concept); rewards are an auditable ledger, not silent auto-payouts.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { maskHandle } from "./player-store.js";

const MOCK = process.env.DEMO_MOCK === "1";
const DEMO_WEEK_MS = 90_000;            // 90s "weeks" under DEMO_MOCK so a rollover is visible
const RAKE_TO_POOL = 0.10;              // 10% of wager volume funds the prize pool
const PRIZE_SPLIT = [0.5, 0.3, 0.2];    // top-3 split

type Entry = { wagered: number; net: number; bets: number; lastAt: number };
type Week = {
  schema: "clanker500.wager-race.v1";
  weekId: string;
  startsAt: number;
  endsAt: number;
  closed: boolean;
  poolBaseUsdc: number;
  rakeAccruedUsdc: number;
  entries: Record<string, Entry>;
};

const DATA_DIR = new URL("../data/seasons", import.meta.url).pathname;
const dir = process.env.SEASON_DATA_DIR || DATA_DIR;
const currentFile = join(dir, "current.json");
const winnersFile = join(dir, "winners.jsonl");

function writeAtomic(f: string, v: unknown) {
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`);
  renameSync(tmp, f);
}
function readJson<T>(f: string): T | null {
  try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return null; }
}

function isoWeekId(now: number): string {
  const d = new Date(now);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7;        // Mon=0
  t.setUTCDate(t.getUTCDate() - day + 3);     // nearest Thursday
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
function weekId(now: number): string {
  return MOCK ? "DEMO-" + Math.floor(now / DEMO_WEEK_MS) : isoWeekId(now);
}
function bounds(now: number): { startsAt: number; endsAt: number } {
  if (MOCK) {
    const startsAt = Math.floor(now / DEMO_WEEK_MS) * DEMO_WEEK_MS;
    return { startsAt, endsAt: startsAt + DEMO_WEEK_MS };
  }
  const d = new Date(now);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
  const startsAt = monday.getTime();
  return { startsAt, endsAt: startsAt + 7 * 86400000 };
}

function freshWeek(now: number, poolBase = 0): Week {
  const { startsAt, endsAt } = bounds(now);
  return { schema: "clanker500.wager-race.v1", weekId: weekId(now), startsAt, endsAt, closed: false, poolBaseUsdc: poolBase, rakeAccruedUsdc: 0, entries: {} };
}

function alreadyLedgered(wid: string): boolean {
  try { return readFileSync(winnersFile, "utf8").split("\n").some((l) => l && JSON.parse(l).weekId === wid); }
  catch { return false; }
}

function rank(entries: Record<string, Entry>) {
  return Object.entries(entries)
    .map(([nullifier, e]) => ({ nullifier, ...e }))
    .sort((a, b) => b.wagered - a.wagered);
}

function closeWeek(week: Week) {
  const pool = +(week.poolBaseUsdc + week.rakeAccruedUsdc).toFixed(2);
  const ranked = rank(week.entries);
  const winners = ranked.slice(0, PRIZE_SPLIT.length).map((r, i) => ({
    nullifier: r.nullifier, handle: maskHandle(r.nullifier), rank: i + 1, wagered: +r.wagered.toFixed(2), prize: +(pool * PRIZE_SPLIT[i]).toFixed(2),
  }));
  if (!alreadyLedgered(week.weekId)) {
    mkdirSync(dirname(winnersFile), { recursive: true });
    appendFileSync(winnersFile, `${JSON.stringify({ schema: "clanker500.wager-race-settle.v1", weekId: week.weekId, closedAt: Date.now(), pool, distributed: winners.reduce((a, w) => a + w.prize, 0), winners })}\n`);
  }
  week.closed = true;
}

/** Idempotent rollover. Safe to call on boot, on every read, and on an interval. */
export function reconcile(now = Date.now()): Week {
  let week = readJson<Week>(currentFile);
  if (!week) { week = freshWeek(now); writeAtomic(currentFile, week); return week; }
  let guard = 0;
  while (week.weekId !== weekId(now) && guard++ < 520) {
    if (!week.closed) closeWeek(week);
    week = freshWeek(week.endsAt + 1, 0);   // advance one period at a time so missed weeks ledger honestly
  }
  writeAtomic(currentFile, week);
  return week;
}

/** Seed synthetic rivals under DEMO_MOCK so the board is populated for reviewers. */
function seedIfDemo(week: Week) {
  if (!MOCK) return week;
  if (Object.keys(week.entries).length >= 4) return week;
  const rivals = ["demo:rival-ace", "demo:rival-nova", "demo:rival-pax", "demo:rival-zee"];
  rivals.forEach((n, i) => {
    if (!week.entries[n]) week.entries[n] = { wagered: 40 - i * 8 + (i % 2 ? 3 : 0), net: 6 - i * 2, bets: 12 - i * 2, lastAt: Date.now() };
  });
  week.rakeAccruedUsdc = Math.max(week.rakeAccruedUsdc, Object.values(week.entries).reduce((a, e) => a + e.wagered, 0) * RAKE_TO_POOL);
  writeAtomic(currentFile, week);
  return week;
}

export function recordWager(nullifier: string, stake: number, net = 0) {
  const week = reconcile();
  const e = (week.entries[nullifier] ||= { wagered: 0, net: 0, bets: 0, lastAt: 0 });
  e.wagered += Math.max(0, stake);
  e.net += net;
  e.bets += 1;
  e.lastAt = Date.now();
  week.rakeAccruedUsdc += Math.max(0, stake) * RAKE_TO_POOL;
  writeAtomic(currentFile, week);
}

export function view(myNullifier?: string) {
  const week = seedIfDemo(reconcile());
  const pool = +(week.poolBaseUsdc + week.rakeAccruedUsdc).toFixed(2);
  const ranked = rank(week.entries);
  const standings = ranked.slice(0, 10).map((r, i) => ({
    rank: i + 1, handle: maskHandle(r.nullifier), wagered: +r.wagered.toFixed(2), net: +r.net.toFixed(2),
    prize: i < PRIZE_SPLIT.length ? +(pool * PRIZE_SPLIT[i]).toFixed(2) : 0,
  }));
  let myRank = null;
  if (myNullifier) {
    const idx = ranked.findIndex((r) => r.nullifier === myNullifier);
    if (idx >= 0) myRank = { rank: idx + 1, handle: maskHandle(myNullifier), wagered: +ranked[idx].wagered.toFixed(2), prize: idx < PRIZE_SPLIT.length ? +(pool * PRIZE_SPLIT[idx]).toFixed(2) : 0 };
  }
  return { weekId: week.weekId, startsAt: week.startsAt, endsAt: week.endsAt, now: Date.now(), prizePool: pool, currency: "USDC", prizeSplit: PRIZE_SPLIT, standings, myRank, seeded: MOCK };
}
