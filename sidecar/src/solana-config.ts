/**
 * Lightweight Solana deployment config — no Anchor/web3 imports, so the
 * dispatcher can read it synchronously without pulling the heavy Solana
 * runtime into the default (EVM) path.
 *
 * Mirrors the shape of generated/contracts.local.json for the Solana backend.
 * See docs/SOLANA_PORT.md.
 */
import fs from "node:fs";

const deploymentUrl = new URL("./generated/contracts.solana.json", import.meta.url);

export type SolanaDeployment = {
  cluster: string;
  rpcUrl: string;
  programId: string;
  usdcMint: string;
  facilitator: string;
  treasury: string; // treasury USDC token account
  defaults: { stakeUnits: string; feeUnits: string };
};

export type SolanaChainConfig = {
  cluster: string;
  rpcUrl: string;
  publicRpcUrl: string;
  sidecarUrl: string;
  programId: string;
  usdcMint: string;
  facilitator: string;
  treasury: string;
  defaultStakeUnits: string;
  defaultFeeUnits: string;
};

export function readSolanaDeployment(): SolanaDeployment {
  if (!fs.existsSync(deploymentUrl)) {
    throw new Error(
      "Solana deployment missing; build/deploy the clanker5000 program and write sidecar/src/generated/contracts.solana.json (see docs/SOLANA_PORT.md)"
    );
  }
  return JSON.parse(fs.readFileSync(deploymentUrl, "utf8"));
}

/** Helius RPC URL for a cluster, or null if no key. Free tier: 10 RPS, 1M
 *  credits/mo (DAS API capped at 2 RPS) — see docs/HELIUS.md. */
export function heliusRpcUrl(cluster: string): string | null {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return null;
  const net = cluster.includes("main") ? "mainnet" : "devnet";
  return `https://${net}.helius-rpc.com/?api-key=${key}`;
}
/** Keyless public endpoint for a cluster — safe to hand to phone/frontend. */
function publicClusterRpc(cluster: string): string {
  return cluster.includes("main")
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com";
}

export function solanaChainConfig(): SolanaChainConfig {
  const d = readSolanaDeployment();
  const cluster = process.env.SOLANA_CLUSTER ?? d.cluster;
  // Backend RPC: explicit override > keyed Helius (if HELIUS_API_KEY set) > deploy default.
  const rpcUrl = process.env.SOLANA_RPC_URL ?? heliusRpcUrl(cluster) ?? d.rpcUrl;
  return {
    cluster,
    rpcUrl,
    // NEVER expose the keyed Helius URL to clients — fall back to a keyless public RPC.
    publicRpcUrl: process.env.PUBLIC_SOLANA_RPC_URL ?? publicClusterRpc(cluster),
    sidecarUrl: process.env.PUBLIC_SIDECAR_URL ?? "",
    programId: process.env.SOLANA_PROGRAM_ID ?? d.programId,
    usdcMint: process.env.SOLANA_USDC_MINT ?? d.usdcMint,
    facilitator: process.env.SOLANA_FACILITATOR ?? d.facilitator,
    treasury: process.env.SOLANA_TREASURY ?? d.treasury,
    defaultStakeUnits: d.defaults.stakeUnits,
    defaultFeeUnits: d.defaults.feeUnits,
  };
}

export function publicSolanaChainConfig() {
  const cfg = solanaChainConfig();
  return {
    cluster: cfg.cluster,
    rpcUrl: cfg.publicRpcUrl,
    backendRpcUrl: cfg.rpcUrl,
    sidecarUrl: cfg.sidecarUrl,
    programId: cfg.programId,
    usdcMint: cfg.usdcMint,
    facilitator: cfg.facilitator,
    treasury: cfg.treasury,
    defaultStakeUnits: cfg.defaultStakeUnits,
    defaultFeeUnits: cfg.defaultFeeUnits,
  };
}
