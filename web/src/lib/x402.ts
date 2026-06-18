/**
 * x402 client for Solana (the browser side of sidecar/src/solana-x402.ts).
 *
 * On a 402, the sidecar returns an `accepts` payment-requirements object
 * (scheme "exact", payTo = treasury USDC token account, maxAmountRequired in
 * 6dp units). We pay by sending a real SPL-USDC transfer to `payTo`, then retry
 * the request with `X-PAYMENT: base64(JSON({ transaction: <signature> }))`.
 * The gate verifies the settled transfer on-chain.
 */
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { USDC_MINT } from "../config";

const usdc = (units: bigint) => (Number(units) / 1e6).toFixed(6);

export type PayWallet = {
  publicKey: PublicKey;
  sendTransaction: (tx: Transaction, conn: Connection) => Promise<string>;
};

export type PayInfo = { amountUsdc?: string; signature?: string };

/**
 * Fetch a (possibly) x402-gated route. If it answers 402, pay the required
 * SPL-USDC and retry once. `onPay` is called with progress for UI. Returns the
 * final Response (200 on success).
 */
export async function x402Fetch(
  url: string,
  init: RequestInit,
  conn: Connection,
  wallet: PayWallet,
  onPay?: (info: PayInfo) => void,
): Promise<Response> {
  const first = await fetch(url, init);
  if (first.status !== 402) return first;

  const body = await first.json().catch(() => ({}));
  const req = body?.accepts?.[0];
  if (!req?.payTo || !req?.maxAmountRequired) {
    throw new Error("402 response missing payment requirements");
  }
  const units = BigInt(req.maxAmountRequired);
  const payTo = new PublicKey(req.payTo); // treasury USDC token account
  const amountUsdc = req?.extra?.amountUsdc ?? (Number(units) / 1e6).toString();
  onPay?.({ amountUsdc });

  const fromAta = getAssociatedTokenAddressSync(USDC_MINT, wallet.publicKey);

  // Pre-check balance so we fail with a clear message instead of a wallet reject.
  let have = 0n;
  try {
    have = (await getAccount(conn, fromAta)).amount;
  } catch {
    throw new Error("no USDC token account for this wallet — fund it first");
  }
  if (have < units) {
    throw new Error(`insufficient USDC: have ${usdc(have)}, need ${usdc(units)}`);
  }

  // Minimal, legible tx (one transfer) + a small priority fee so it lands.
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    createTransferInstruction(fromAta, payTo, wallet.publicKey, units),
  );
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;

  // Simulate before prompting Phantom — catch failures up front, no surprise sign.
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    throw new Error(`payment would fail: ${JSON.stringify(sim.value.err)}`);
  }

  const signature = await wallet.sendTransaction(tx, conn);
  await conn.confirmTransaction(signature, "confirmed");
  onPay?.({ amountUsdc, signature });

  const header = btoa(
    JSON.stringify({
      transaction: signature,
      payer: wallet.publicKey.toBase58(),
      network: req.network,
      x402Version: body?.x402Version ?? 2,
    }),
  );
  return fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), "X-PAYMENT": header },
  });
}
