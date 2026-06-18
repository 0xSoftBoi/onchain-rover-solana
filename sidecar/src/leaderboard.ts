/**
 * Fleet leaderboard — native Solana (on-chain reputation accounts).
 *
 * This is the native-Solana-only fork: the BigQuery-over-ERC-8004 + Sepolia RPC
 * leaderboard is replaced by reads over the clanker5000 reputation PDAs. Export
 * names are preserved (`fleetFeedback`, `mainnetRanking`) so importers
 * (index.ts) are unchanged; bodies delegate to solana-chain.ts.
 * See docs/SOLANA_NATIVE_MIGRATION.md §10.
 */
import { agentRanking, fleetReputation } from "./solana-chain.js";

/** Per-agent reputation summary for the fleet (jobs + avgScore + skills). */
export async function fleetFeedback(agentIds: Array<string | number | bigint>) {
  return fleetReputation(agentIds);
}

/** Ecosystem-wide ranking — reads the program's agent reputation accounts. */
export async function mainnetRanking(limit = 20) {
  return agentRanking(limit);
}
