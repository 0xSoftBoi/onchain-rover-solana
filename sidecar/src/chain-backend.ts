/**
 * Settlement backend — native Solana only.
 *
 * This is the native-Solana-only fork: the EVM RaceEscrow client (chain.ts) has
 * been removed and the clanker5000 Anchor program (solana-chain.ts) is the sole
 * backend. Call sites use `import * as chain from "./chain-backend.js"`; the
 * same exported names are preserved so importers (index.ts, rounds.ts) are
 * unchanged.
 *
 * `CHAIN_BACKEND` now defaults to `solana`; the only non-default value is `evm`,
 * which is no longer supported here and is treated as Solana.
 * See docs/SOLANA_NATIVE_MIGRATION.md.
 */
import {
  openRoundOnChain,
  buildRaceEntryRequest,
  joinRoundOnChain,
  lockRoundOnChain,
  startRoundOnChain,
  finishRoundOnChain,
  settleRoundOnChain,
  cancelRoundOnChain,
  localChainHealth,
  localTreasuryInfo,
  fundLocalWallet,
} from "./solana-chain.js";
import { solanaChainConfig, publicSolanaChainConfig } from "./solana-config.js";
import type { TypedDataEnvelope } from "./chain-types.js";

export type { TypedDataEnvelope };

// ---- sync config getters ---------------------------------------------------

export function localChainConfig() {
  return solanaChainConfig();
}

export function publicLocalChainConfig() {
  return publicSolanaChainConfig();
}

// ---- async lifecycle / reads (direct re-exports of the Solana client) ------

export {
  openRoundOnChain,
  buildRaceEntryRequest,
  joinRoundOnChain,
  lockRoundOnChain,
  startRoundOnChain,
  finishRoundOnChain,
  settleRoundOnChain,
  cancelRoundOnChain,
  localChainHealth,
  localTreasuryInfo,
  fundLocalWallet,
};
