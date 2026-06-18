/**
 * Reputation — native Solana (own clanker5000 Anchor reputation).
 *
 * This is the native-Solana-only fork: the ERC-8004 viem client (Sepolia) is
 * replaced by the program's `register_agent` / `give_feedback` instructions.
 * Export names are preserved so importers (index.ts) are unchanged; bodies
 * delegate to solana-chain.ts. See docs/SOLANA_NATIVE_MIGRATION.md §4.
 *
 * 🚨 The requester (facilitator key) must NOT be the agent owner — the program
 * rejects self-feedback, exactly as ERC-8004 did.
 */
import {
  registerAgentOnChain,
  giveFeedbackOnChain,
  repSummaryOnChain,
} from "./solana-chain.js";

/**
 * Register an agent on-chain.
 *
 * Adapted signature note: the EVM version took (agentURI, ownerKey) and minted
 * an auto-incremented agentId from the registration event. The Solana program
 * uses an explicit numeric agentId + an owner pubkey. We keep the same exported
 * name/arity: `agentURI` carries the numeric agentId (a trailing integer, e.g.
 * "agent://…/0" -> 0; default 0) and `owner` is the owner's base58 pubkey.
 */
export async function registerAgent(agentURI: string, owner: string) {
  const m = String(agentURI).match(/(\d+)\s*$/);
  const agentId = m ? Number(m[1]) : 0;
  return registerAgentOnChain(agentId, owner);
}

export async function giveFeedback(opts: {
  agentId: number; score: number; skill: string;
  blobId?: string; sha256?: string;
}) {
  return giveFeedbackOnChain(opts);
}

export async function summary(agentId: number) {
  return repSummaryOnChain(agentId);
}
