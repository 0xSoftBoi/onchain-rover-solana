/**
 * Settlement backend dispatcher. Routes the local-chain race lifecycle to the
 * EVM RaceEscrow (chain.ts, default) or the native-Solana clanker5000 program
 * (solana-chain.ts) based on CHAIN_BACKEND.
 *
 *   CHAIN_BACKEND=evm     (default) — existing Hardhat/Arc viem path, untouched
 *   CHAIN_BACKEND=solana            — Anchor program via @coral-xyz/anchor
 *
 * Call sites use `import * as chain from "./chain-backend.js"`. The Solana
 * module is lazy-imported so the EVM path never loads the Solana runtime.
 * See docs/SOLANA_PORT.md.
 */
import * as evm from "./chain.js";
import { solanaChainConfig, publicSolanaChainConfig } from "./solana-config.js";
import type { TypedDataEnvelope } from "./chain.js";

export type { TypedDataEnvelope };

const SOLANA = (process.env.CHAIN_BACKEND ?? "evm").toLowerCase() === "solana";

type Solana = typeof import("./solana-chain.js");
let solanaMod: Solana | null = null;
async function solana(): Promise<Solana> {
  if (!solanaMod) solanaMod = await import("./solana-chain.js");
  return solanaMod;
}

// ---- sync config getters (EVM-shaped type for caller compatibility) --------

export function localChainConfig(): ReturnType<typeof evm.localChainConfig> {
  if (SOLANA) return solanaChainConfig() as unknown as ReturnType<typeof evm.localChainConfig>;
  return evm.localChainConfig();
}

export function publicLocalChainConfig(): ReturnType<typeof evm.publicLocalChainConfig> {
  if (SOLANA) return publicSolanaChainConfig() as unknown as ReturnType<typeof evm.publicLocalChainConfig>;
  return evm.publicLocalChainConfig();
}

// ---- async lifecycle / reads -----------------------------------------------

export async function localChainHealth(): ReturnType<typeof evm.localChainHealth> {
  return SOLANA ? ((await solana()).localChainHealth() as unknown as ReturnType<typeof evm.localChainHealth>) : evm.localChainHealth();
}

export async function openRoundOnChain(
  ...args: Parameters<typeof evm.openRoundOnChain>
): ReturnType<typeof evm.openRoundOnChain> {
  return SOLANA ? ((await solana()).openRoundOnChain(...args) as unknown as ReturnType<typeof evm.openRoundOnChain>) : evm.openRoundOnChain(...args);
}

export async function buildRaceEntryRequest(
  ...args: Parameters<typeof evm.buildRaceEntryRequest>
): ReturnType<typeof evm.buildRaceEntryRequest> {
  return SOLANA
    ? ((await solana()).buildRaceEntryRequest(...args) as unknown as ReturnType<typeof evm.buildRaceEntryRequest>)
    : evm.buildRaceEntryRequest(...args);
}

export async function joinRoundOnChain(
  ...args: Parameters<typeof evm.joinRoundOnChain>
): ReturnType<typeof evm.joinRoundOnChain> {
  return SOLANA ? ((await solana()).joinRoundOnChain(...args) as unknown as ReturnType<typeof evm.joinRoundOnChain>) : evm.joinRoundOnChain(...args);
}

export async function lockRoundOnChain(
  ...args: Parameters<typeof evm.lockRoundOnChain>
): ReturnType<typeof evm.lockRoundOnChain> {
  return SOLANA ? ((await solana()).lockRoundOnChain(...args) as unknown as ReturnType<typeof evm.lockRoundOnChain>) : evm.lockRoundOnChain(...args);
}

export async function startRoundOnChain(
  ...args: Parameters<typeof evm.startRoundOnChain>
): ReturnType<typeof evm.startRoundOnChain> {
  return SOLANA ? ((await solana()).startRoundOnChain(...args) as unknown as ReturnType<typeof evm.startRoundOnChain>) : evm.startRoundOnChain(...args);
}

export async function finishRoundOnChain(
  ...args: Parameters<typeof evm.finishRoundOnChain>
): ReturnType<typeof evm.finishRoundOnChain> {
  return SOLANA ? ((await solana()).finishRoundOnChain(...args) as unknown as ReturnType<typeof evm.finishRoundOnChain>) : evm.finishRoundOnChain(...args);
}

export async function settleRoundOnChain(
  ...args: Parameters<typeof evm.settleRoundOnChain>
): ReturnType<typeof evm.settleRoundOnChain> {
  return SOLANA ? ((await solana()).settleRoundOnChain(...args) as unknown as ReturnType<typeof evm.settleRoundOnChain>) : evm.settleRoundOnChain(...args);
}

export async function cancelRoundOnChain(
  ...args: Parameters<typeof evm.cancelRoundOnChain>
): ReturnType<typeof evm.cancelRoundOnChain> {
  return SOLANA ? ((await solana()).cancelRoundOnChain(...args) as unknown as ReturnType<typeof evm.cancelRoundOnChain>) : evm.cancelRoundOnChain(...args);
}

export async function localTreasuryInfo(): ReturnType<typeof evm.localTreasuryInfo> {
  return SOLANA ? ((await solana()).localTreasuryInfo() as unknown as ReturnType<typeof evm.localTreasuryInfo>) : evm.localTreasuryInfo();
}

export async function fundLocalWallet(
  ...args: Parameters<typeof evm.fundLocalWallet>
): ReturnType<typeof evm.fundLocalWallet> {
  return SOLANA ? ((await solana()).fundLocalWallet(...args) as unknown as ReturnType<typeof evm.fundLocalWallet>) : evm.fundLocalWallet(...args);
}
