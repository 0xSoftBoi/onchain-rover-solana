/**
 * Naming resolution — native Solana (SNS / Bonfida `.sol`).
 *
 * This is the native-Solana-only fork: ENS (Sepolia/mainnet via viem) has been
 * replaced by SNS. This module keeps its original export names (`resolve`,
 * `fleet`) so importers (index.ts) are unchanged, and delegates to sns.ts.
 * See docs/SOLANA_NATIVE_MIGRATION.md §3.
 */
import * as sns from "./sns.js";

/** Resolve a fleet (sub)domain live: owner + agent-context record. */
export async function resolve(name: string) {
  return sns.resolve(name);
}

export async function fleet() {
  return sns.fleet();
}
