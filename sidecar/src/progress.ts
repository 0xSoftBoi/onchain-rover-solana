/**
 * Gameplay write choke-point. Every bet and every settlement flows through here so
 * player totals, the weekly wager race, quests, and achievements can never drift.
 * Achievement unlocks are returned so the caller can emit a broadcast event.
 */
import * as players from "./player-store.js";
import * as season from "./season.js";
import * as quests from "./quests.js";
import * as achievements from "./achievements.js";

export type BetCtx = { stake: number; racer?: string; market?: string; isUnderdog?: boolean; parlay?: boolean };
export type SettleCtx = { won: boolean; stake: number; payout?: number; isUnderdog?: boolean; parlayDepth?: number };
export type Unlock = { id: string; name: string; icon: string; points: number };

/** Record a placed bet (any market or the race winner). */
export function recordBet(nullifier: string, ctx: BetCtx): { unlocked: Unlock[] } {
  const p = players.getOrCreate(nullifier);
  p.totalBets += 1;
  p.totalWagered += Math.max(0, ctx.stake || 0);
  if (ctx.parlay) p.parlayCount += 1;
  quests.onEvent(p, "bet", ctx);
  const unlocked = achievements.check(p);
  players.save(p);
  players.ledger(nullifier, "bet", ctx);
  season.recordWager(nullifier, Math.max(0, ctx.stake || 0));
  return { unlocked };
}

/** Record a settled position outcome. Updates win/loss, P&L, and the streak machine. */
export function recordSettle(nullifier: string, ctx: SettleCtx): { unlocked: Unlock[] } {
  const p = players.getOrCreate(nullifier);
  const payout = Math.max(0, ctx.payout || 0);
  const stake = Math.max(0, ctx.stake || 0);
  if (ctx.won) {
    p.wins += 1;
    p.netPnl += payout - stake;
    p.streak.current += 1;
    p.streak.best = Math.max(p.streak.best, p.streak.current);
    p.biggestWin = Math.max(p.biggestWin, payout);
    if (ctx.isUnderdog) p.underdogWins += 1;
    if (ctx.parlayDepth && ctx.parlayDepth >= 2) p.bestParlayWinDepth = Math.max(p.bestParlayWinDepth, ctx.parlayDepth);
  } else {
    p.losses += 1;
    p.netPnl -= stake;
    p.streak.current = 0;
  }
  quests.onEvent(p, "settle", ctx);
  const unlocked = achievements.check(p);
  players.save(p);
  players.ledger(nullifier, "settle", ctx);
  return { unlocked };
}
