/**
 * Gameplay write choke-point. Every bet and every settlement flows through here so
 * player totals (and, in Phase 2, the weekly wager race + quests + achievements)
 * can never drift apart. Keep all per-human side-effects in this one module.
 */
import * as players from "./player-store.js";

export type BetCtx = { stake: number; racer?: string; market?: string; isUnderdog?: boolean; parlay?: boolean };
export type SettleCtx = { won: boolean; stake: number; payout?: number; isUnderdog?: boolean; parlayDepth?: number };

/** Record a placed bet (any market or the race winner). */
export function recordBet(nullifier: string, ctx: BetCtx) {
  const p = players.getOrCreate(nullifier);
  p.totalBets += 1;
  p.totalWagered += Math.max(0, ctx.stake || 0);
  if (ctx.parlay) p.parlayCount += 1;
  players.save(p);
  players.ledger(nullifier, "bet", ctx);
  // Phase 2 extension point: season.recordWager(), quests.onEvent("bet"), achievements.check()
  return { profile: p };
}

/** Record a settled position outcome. Updates win/loss, P&L, and the streak machine. */
export function recordSettle(nullifier: string, ctx: SettleCtx) {
  const p = players.getOrCreate(nullifier);
  const payout = Math.max(0, ctx.payout || 0);
  const stake = Math.max(0, ctx.stake || 0);
  if (ctx.won) {
    p.wins += 1;
    const profit = payout - stake;
    p.netPnl += profit;
    p.streak.current += 1;
    p.streak.best = Math.max(p.streak.best, p.streak.current);
    p.biggestWin = Math.max(p.biggestWin, payout);
    if (ctx.isUnderdog) p.underdogWins += 1;
  } else {
    p.losses += 1;
    p.netPnl -= stake;
    p.streak.current = 0;
  }
  players.save(p);
  players.ledger(nullifier, "settle", ctx);
  // Phase 2 extension point: quests.onEvent("settle"), achievements.check() -> emit unlock events
  return { profile: p, unlocked: [] as string[] };
}
