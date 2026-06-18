/**
 * Gasless settlement via Kora — the native-Solana replacement for EIP-3009
 * `transferWithAuthorization` (see docs/SOLANA_NATIVE_MIGRATION.md §2).
 *
 * Kora (Solana Foundation) is a relayer/signer node that acts as the transaction
 * fee payer, so users transact without holding SOL and pay fees in an allowlisted
 * SPL token (USDC). It speaks JSON-RPC; this is a thin typed client. Stand up a
 * Kora node (github.com/solana-foundation/kora) and set:
 *   KORA_RPC_URL   — the Kora node JSON-RPC endpoint
 *   KORA_API_KEY   — optional bearer/api key if the node requires one
 *
 * Method names follow the Kora JSON-RPC surface; confirm against the running
 * node version (kept defensive — unknown shapes pass through).
 */
import "./env.js";

const KORA_RPC_URL = process.env.KORA_RPC_URL ?? "";
const KORA_API_KEY = process.env.KORA_API_KEY ?? "";

export function configured(): boolean {
  return Boolean(KORA_RPC_URL);
}

async function rpc<T = any>(method: string, params: unknown = {}): Promise<T> {
  if (!KORA_RPC_URL) throw new Error("KORA_RPC_URL not set (stand up a Kora relayer)");
  const res = await fetch(KORA_RPC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(KORA_API_KEY ? { authorization: `Bearer ${KORA_API_KEY}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json: any = await res.json();
  if (json.error) throw new Error(`Kora ${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result as T;
}

/** Relayer config: fee-payer pubkey + the SPL tokens accepted for fee payment. */
export async function getConfig() {
  return rpc("getConfig");
}

/** SPL tokens the relayer will accept as the fee currency (e.g. USDC). */
export async function getSupportedTokens(): Promise<string[]> {
  const r: any = await rpc("getSupportedTokens");
  return r?.tokens ?? r ?? [];
}

/** Estimate the fee (in the chosen SPL token) for a base64 transaction. */
export async function estimateFee(txBase64: string, feeToken?: string) {
  return rpc("estimateTransactionFee", { transaction: txBase64, fee_token: feeToken });
}

/**
 * Co-sign a base64 transaction as fee payer and return it for the user to add
 * their signature (or fully signed if the user already signed). Use when you
 * want to broadcast yourself.
 */
export async function signTransaction(txBase64: string, feeToken?: string) {
  return rpc<{ signed_transaction: string }>("signTransaction", {
    transaction: txBase64,
    fee_token: feeToken,
  });
}

/** Co-sign as fee payer AND broadcast; returns the signature. */
export async function signAndSendTransaction(txBase64: string, feeToken?: string) {
  return rpc<{ signature: string }>("signAndSendTransaction", {
    transaction: txBase64,
    fee_token: feeToken,
  });
}
