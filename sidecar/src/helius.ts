/**
 * Helius integration — used within the FREE tier budget (1M credits/mo, 10 RPS
 * RPC, 2 RPS DAS API; standard WebSockets included; LaserStream/webhooks are
 * paid). See docs/HELIUS.md. Set HELIUS_API_KEY in the env; the keyed URL is
 * only ever used server-side (never handed to clients — see solana-config.ts).
 *
 * What we use on free tier, and why it's "smart":
 *  - getPriorityFeeEstimate  -> land settlement/x402 txs reliably without
 *    overpaying (dynamic compute-unit price instead of a hardcoded guess).
 *  - DAS getAssetsByOwner    -> rich asset/NFT holder queries in one call
 *    (e.g. if EventPass graduates to a Metaplex NFT), cheaper than scanning.
 *  - We DON'T poll: prefer one-shot reads + standard WS subscriptions, and we
 *    cache the fee estimate briefly to stay well under the 10 RPS cap.
 */
import { ComputeBudgetProgram, type TransactionInstruction } from "@solana/web3.js";
import { heliusRpcUrl } from "./solana-config.js";

export function heliusConfigured(): boolean {
  return Boolean(process.env.HELIUS_API_KEY);
}

function rpc(cluster: string): string {
  const url = heliusRpcUrl(cluster);
  if (!url) throw new Error("HELIUS_API_KEY not set");
  return url;
}

async function heliusCall<T = any>(cluster: string, method: string, params: unknown): Promise<T> {
  const res = await fetch(rpc(cluster), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "clanker5000", method, params }),
  });
  const json: any = await res.json();
  if (json.error) throw new Error(`Helius ${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result as T;
}

type PriorityLevel = "Min" | "Low" | "Medium" | "High" | "VeryHigh" | "UnsafeMax";

// Cache fee estimates for 10s — one estimate covers a burst of settlement txs
// and keeps us far under the 10 RPS free-tier cap.
let _feeCache: { at: number; level: string; fee: number } | null = null;

/**
 * Estimate the priority fee (micro-lamports per CU) for a base58 serialized tx.
 * Returns 0 (skip priority fee) if Helius isn't configured, so callers can use
 * this unconditionally. `nowMs` is passed in because Date.now() is avoided in
 * deterministic contexts; defaults to wall clock here (sidecar runtime is fine).
 */
export async function priorityFeeMicroLamports(
  serializedTxBase58: string,
  cluster: string,
  level: PriorityLevel = "Medium",
  nowMs: number = Date.now(),
): Promise<number> {
  if (!heliusConfigured()) return 0;
  if (_feeCache && _feeCache.level === level && nowMs - _feeCache.at < 10_000) {
    return _feeCache.fee;
  }
  const r = await heliusCall<{ priorityFeeEstimate: number }>(cluster, "getPriorityFeeEstimate", [
    { transaction: serializedTxBase58, options: { priorityLevel: level, recommended: true } },
  ]);
  const fee = Math.max(0, Math.round(r?.priorityFeeEstimate ?? 0));
  _feeCache = { at: nowMs, level, fee };
  return fee;
}

/**
 * ComputeBudget pre-instructions for an Anchor `.preInstructions([...])` call:
 * a CU limit + the Helius-estimated price. Use on settlement writes so they
 * land under congestion. Falls back to a sane fixed price when Helius is off.
 */
export async function priorityPreInstructions(
  serializedTxBase58: string | null,
  cluster: string,
  computeUnitLimit = 200_000,
  level: PriorityLevel = "Medium",
): Promise<TransactionInstruction[]> {
  let micros = 1_000; // fallback floor
  if (serializedTxBase58 && heliusConfigured()) {
    try {
      const est = await priorityFeeMicroLamports(serializedTxBase58, cluster, level);
      if (est > 0) micros = est;
    } catch {
      /* fall back to the floor on any Helius hiccup */
    }
  }
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micros }),
  ];
}

/**
 * DAS: assets owned by `owner` (the modern way to read NFT/token holdings in a
 * single call). Useful if EventPass graduates to a Metaplex asset. Free tier
 * caps DAS at 2 RPS — call sparingly, never in a tight loop.
 */
export async function getAssetsByOwner(owner: string, cluster: string, page = 1, limit = 100) {
  return heliusCall(cluster, "getAssetsByOwner", {
    ownerAddress: owner,
    page,
    limit,
    options: { showFungible: false, showZeroBalance: false },
  });
}
