/**
 * Per-human player store — keyed by World ID nullifier, the one-human identity
 * that already gates betting (worldid.ts). This is the persistence foundation
 * for parlays, the weekly wager race, quests, and achievements.
 *
 * Production-grade within this repo's conventions: file-based, atomic writes,
 * mirroring race-store.ts. The raw nullifier is a stable pseudonymous human id,
 * so it is NEVER used as a path component (the directory is sha256(nullifier))
 * and never returned to clients (callers project a masked handle). Swap to a DB
 * later behind this same API.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type Credit = { type: "rakeback" | "freebet" | "points"; amount: number; reason: string; at: number };

export type PlayerProfile = {
  schema: "clanker500.player.v1";
  nullifier: string;
  joinedAt: number;
  lastSeenAt: number;
  totalBets: number;
  totalWagered: number;
  wins: number;
  losses: number;
  netPnl: number;
  biggestWin: number;
  parlayCount: number;
  underdogWins: number;
  bestParlayWinDepth: number;
  points: number;
  streak: { current: number; best: number };
  achievements: Record<string, number>; // id -> unlockedAt
  quests: Record<string, Record<string, { progress: number; claimedAt: number | null }>>; // periodKey -> id -> state
  credits: Credit[];
};

const DEFAULT_DATA_DIR = new URL("../data/players", import.meta.url).pathname;
const dataDir = process.env.PLAYER_DATA_DIR || DEFAULT_DATA_DIR;

/** Filesystem-safe, privacy-preserving directory key for a nullifier. */
function keyOf(nullifier: string): string {
  return createHash("sha256").update(String(nullifier)).digest("hex").slice(0, 32);
}
function playerDir(nullifier: string) {
  return join(dataDir, keyOf(nullifier));
}
function profileFile(nullifier: string) {
  return join(playerDir(nullifier), "profile.json");
}
function ledgerFile(nullifier: string) {
  return join(playerDir(nullifier), "ledger.jsonl");
}

function ensureDir(file: string) {
  mkdirSync(dirname(file), { recursive: true });
}
function writeJsonAtomic(file: string, value: unknown) {
  ensureDir(file);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function fresh(nullifier: string): PlayerProfile {
  const now = Date.now();
  return {
    schema: "clanker500.player.v1",
    nullifier,
    joinedAt: now,
    lastSeenAt: now,
    totalBets: 0,
    totalWagered: 0,
    wins: 0,
    losses: 0,
    netPnl: 0,
    biggestWin: 0,
    parlayCount: 0,
    underdogWins: 0,
    bestParlayWinDepth: 0,
    points: 0,
    streak: { current: 0, best: 0 },
    achievements: {},
    quests: {},
    credits: [],
  };
}

export function getOrCreate(nullifier: string): PlayerProfile {
  const existing = readJson<PlayerProfile>(profileFile(nullifier));
  if (existing && existing.nullifier) {
    // forward-compat: backfill any fields added after this profile was written
    return { ...fresh(nullifier), ...existing, joinedAt: existing.joinedAt ?? Date.now() };
  }
  const p = fresh(nullifier);
  save(p);
  return p;
}

export function save(p: PlayerProfile) {
  p.lastSeenAt = Date.now();
  writeJsonAtomic(profileFile(p.nullifier), p);
}

export function ledger(nullifier: string, kind: string, payload: unknown) {
  const f = ledgerFile(nullifier);
  ensureDir(f);
  appendFileSync(f, `${JSON.stringify({ atMs: Date.now(), kind, payload })}\n`);
}

/** Load every player profile (for aggregate standings / wager-race seeding sweeps). */
export function loadAll(): PlayerProfile[] {
  try {
    return readdirSync(dataDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[a-f0-9]{1,64}$/.test(e.name))
      .map((e) => readJson<PlayerProfile>(join(dataDir, e.name, "profile.json")))
      .filter((p): p is PlayerProfile => Boolean(p?.nullifier));
  } catch {
    return [];
  }
}

/** Public, privacy-safe projection: never leak the raw nullifier. */
export function maskHandle(nullifier: string): string {
  const s = String(nullifier).replace(/^0x/i, "");
  if (s.length <= 8) return "0x" + s;
  return "0x" + s.slice(0, 4) + "…" + s.slice(-2);
}

export function summary(p: PlayerProfile) {
  return {
    handle: maskHandle(p.nullifier),
    joinedAt: p.joinedAt,
    totalBets: p.totalBets,
    totalWagered: +p.totalWagered.toFixed(2),
    wins: p.wins,
    losses: p.losses,
    netPnl: +p.netPnl.toFixed(2),
    points: p.points,
    streak: p.streak,
    achievements: Object.keys(p.achievements).length,
    credits: p.credits,
  };
}
