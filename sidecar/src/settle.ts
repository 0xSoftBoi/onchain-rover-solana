/**
 * On-chain settlement — native Solana (clanker5000 Anchor program).
 *
 * This is the native-Solana-only fork: the EVM/Arc viem settlement client has
 * been removed. Every function here is a thin delegation to solana-chain.ts,
 * preserving the exact export names/signatures the importers rely on
 * (index.ts, preflight.ts, session.ts, go-live.ts) so nothing else changes.
 *
 *   pay()            -> payOnChain (SPL-USDC transfer)
 *   mintPass()       -> mintEventPass (program-native pass)
 *   holdsPass()      -> eventPassHolds(...).holds (the checkpoint gate)
 *   giveFeedback()   -> giveFeedbackOnChain (own Anchor reputation)
 *   openRaceOnChain  -> openMarketOnChain (parimutuel market)
 *   betOnChain       -> placeBetOnChain
 *   settleRaceOnChain-> settleMarketOnChain
 *   treasuryInfo()   -> treasuryBalance() (program PDA USDC vault)
 *   repSummary()     -> repSummaryOnChain()
 *   buildWithdrawTx()-> buildTreasuryWithdraw (unsigned ix for Ledger clear-sign)
 *
 * See docs/SOLANA_NATIVE_MIGRATION.md (sections 1, 4, 5, 6).
 */
import {
  usdcBalanceOf,
  payOnChain,
  mintEventPass,
  eventPassHolds,
  giveFeedbackOnChain,
  openMarketOnChain,
  placeBetOnChain,
  settleMarketOnChain,
  treasuryBalance,
  buildTreasuryWithdraw,
  submitSignedSolanaTx,
  repSummaryOnChain,
} from "./solana-chain.js";

/** USDC (6dp) balance of an address. */
export async function usdcBalance(addr: string): Promise<bigint> {
  return usdcBalanceOf(addr);
}

/** payer -> payee: transfer the negotiated USDC amount (SPL-USDC). */
export async function pay(from: string, to: string, amountUsdc: string) {
  return payOnChain(from, to, amountUsdc);
}

/** Mint the EventPass to the buyer, recording the negotiated price on-chain. */
export async function mintPass(to: string, priceUsdc: string) {
  return mintEventPass(to, priceUsdc);
}

/** Does this address hold an EventPass? (the checkpoint gate) */
export async function holdsPass(addr: string): Promise<boolean> {
  return (await eventPassHolds(addr)).holds;
}

/**
 * The requester rates an agent after a completed job, tagged by skill, with the
 * Walrus proof URI + hash. Feeds the leaderboard.
 */
export async function giveFeedback(opts: {
  agentId: number; score: number; skill: string;
  blobId?: string; sha256?: string;
}) {
  return giveFeedbackOnChain(opts);
}

/** Facilitator (judge) opens a parimutuel market. Returns the raceId. */
export async function openRaceOnChain(numRacers = 2) {
  return openMarketOnChain(numRacers);
}

/**
 * Place a REAL on-chain parimutuel bet for a World-ID-verified human (the
 * nullifier is stored on-chain as the sybil guard).
 */
export async function betOnChain(raceId: number, racerIdx: number, amountUsdc: string, nullifier: string) {
  return placeBetOnChain(raceId, racerIdx, amountUsdc, nullifier);
}

/** Facilitator settles the market on-chain with the verified finish proof. */
export async function settleRaceOnChain(raceId: number, winnerIdx: number, sha256: string, blobId: string) {
  return settleMarketOnChain(raceId, winnerIdx, sha256, blobId);
}

/**
 * Build the UNSIGNED treasury-withdraw instruction for an external Ledger
 * Solana wallet to clear-sign. The sidecar never holds the treasury owner key.
 * `to` is the recipient USDC token account; `from` is accepted for signature
 * compatibility with the old EVM call but is unused (the owner is read from the
 * on-chain treasury config).
 */
export async function buildWithdrawTx(_from: string, to: string, amountUsdc: string) {
  return buildTreasuryWithdraw(to, amountUsdc);
}

/**
 * EVM had an {r,s,v} re-serialize + sendRawTransaction step. On Solana the
 * Ledger returns a fully-signed transaction, so the sidecar just forwards it.
 * Accepts the base64 signed tx as a string or `{ signedTx }` (the old EVM
 * `{r,s,v}` second arg is ignored). See docs/SOLANA_NATIVE_MIGRATION.md §6.
 */
export async function broadcastSigned(signed: string | { signedTx?: string }, _sig?: unknown) {
  const b64 = typeof signed === "string" ? signed : signed?.signedTx;
  if (!b64) {
    throw new Error(
      "broadcastSigned expects a base64 Ledger-signed Solana transaction (string or { signedTx })",
    );
  }
  return submitSignedSolanaTx(b64);
}

/** Program treasury PDA USDC vault balance. */
export async function treasuryInfo() {
  const balance = await treasuryBalance();
  return { deployed: true, ...balance };
}

export async function repSummary(agentId: number) {
  return repSummaryOnChain(agentId);
}
