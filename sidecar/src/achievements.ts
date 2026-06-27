/**
 * Achievements — permanent milestones + the win-streak machine. Pure checks over a
 * PlayerProfile; unlocks are set-once (idempotent) and award points that feed the
 * $CLANK airdrop tally. The caller persists the profile and emits an unlock event.
 */
import type { PlayerProfile } from "./player-store.js";

type Tier = "bronze" | "silver" | "gold";
type Achievement = { id: string; name: string; icon: string; tier: Tier; points: number; hint: string; check: (p: PlayerProfile) => boolean };

export const ACHIEVEMENTS: Achievement[] = [
  { id: "first_bet", name: "First Bet", icon: "🎟️", tier: "bronze", points: 10, hint: "Place your first bet", check: (p) => p.totalBets >= 1 },
  { id: "high_roller", name: "High Roller", icon: "💎", tier: "gold", points: 100, hint: "Wager $100 total", check: (p) => p.totalWagered >= 100 },
  { id: "parlay_legend", name: "Parlay Legend", icon: "🎰", tier: "gold", points: 75, hint: "Win a 3+ leg parlay", check: (p) => (p.bestParlayWinDepth || 0) >= 3 },
  { id: "hot_streak_3", name: "Hot Streak ×3", icon: "🔥", tier: "silver", points: 30, hint: "Win 3 in a row", check: (p) => p.streak.best >= 3 },
  { id: "hot_streak_5", name: "Hot Streak ×5", icon: "🔥🔥", tier: "gold", points: 60, hint: "Win 5 in a row", check: (p) => p.streak.best >= 5 },
  { id: "underdog_hero", name: "Underdog Hero", icon: "🐴", tier: "silver", points: 50, hint: "Win 3 underdog bets", check: (p) => p.underdogWins >= 3 },
];

/** Unlock any newly-earned achievements. Mutates profile; returns the newly-unlocked. */
export function check(p: PlayerProfile): { id: string; name: string; icon: string; points: number }[] {
  const newly: { id: string; name: string; icon: string; points: number }[] = [];
  for (const a of ACHIEVEMENTS) {
    if (p.achievements[a.id]) continue;
    if (a.check(p)) {
      p.achievements[a.id] = Date.now();
      p.points += a.points;
      newly.push({ id: a.id, name: a.name, icon: a.icon, points: a.points });
    }
  }
  return newly;
}

export function view(p: PlayerProfile) {
  const unlocked = ACHIEVEMENTS.filter((a) => p.achievements[a.id]).map((a) => ({ id: a.id, name: a.name, icon: a.icon, tier: a.tier, at: p.achievements[a.id], points: a.points }));
  const locked = ACHIEVEMENTS.filter((a) => !p.achievements[a.id]).map((a) => ({ id: a.id, name: a.name, icon: a.icon, tier: a.tier, hint: a.hint, points: a.points }));
  return { points: p.points, streak: p.streak, unlocked, locked, airdropPoints: p.points };
}
