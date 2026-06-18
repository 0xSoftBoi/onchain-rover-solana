import "./env.js";
/**
 * Privy server-wallet custody for the rover fleet.
 *
 * Instead of robot private keys sitting in .env on the host, the signing keys
 * live in Privy's secure TEE. We sign settlement transactions via the Privy API
 * — the host never holds the key. This is the "agent wallet" the Privy AI-Agent
 * track wants, and it's a real custody upgrade, not a swap: settle.ts can route
 * through here (CUSTODY=privy) while the local-key path stays as a fallback.
 *
 * Provision wallets with `npx tsx src/privy-provision.ts`, then set in .env:
 *   PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_WALLET_GUARD, PRIVY_WALLET_COURIER
 * Re-check method signatures against the installed @privy-io/node.
 */
import { PrivyClient } from "@privy-io/node";
import { PublicKey } from "@solana/web3.js";

const APP_ID = process.env.PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;

let _client: PrivyClient | null = null;
export function client(): PrivyClient {
  if (!APP_ID || !APP_SECRET) throw new Error("PRIVY_APP_ID / PRIVY_APP_SECRET not set");
  if (!_client) _client = new PrivyClient({ appId: APP_ID, appSecret: APP_SECRET });
  return _client;
}

const WALLETS: Record<string, { id?: string; addr?: string }> = {
  guard: { id: process.env.PRIVY_WALLET_GUARD, addr: process.env.PRIVY_ADDR_GUARD },
  courier: { id: process.env.PRIVY_WALLET_COURIER, addr: process.env.PRIVY_ADDR_COURIER },
};

export function config() {
  const wallets = Object.fromEntries(
    Object.entries(WALLETS).map(([k, v]) => [k, v.addr ?? null]));
  return {
    configured: Boolean(APP_ID && APP_SECRET),
    custody: process.env.CUSTODY === "privy" ? "privy-tee" : "local-key",
    wallets,
  };
}

/**
 * A Solana signer adapter whose signing happens inside Privy's TEE (no local
 * key on the host). `address` is the wallet's base58 Solana pubkey. Returns
 * `{ publicKey, signTransaction, signMessage }`. The Privy Solana method names
 * are per docs.privy.io/recipes/solana — confirm against the installed
 * @privy-io/node version (kept defensive with `as any`).
 */
export function privyAccount(walletId: string, address: string) {
  const c = client();
  return {
    publicKey: new PublicKey(address),
    /** Sign a base64-serialized Solana transaction in the TEE; returns base64. */
    async signTransaction(txBase64: string): Promise<string> {
      const res: any = await (c.wallets() as any)
        .solana()
        .signTransaction(walletId, { params: { transaction: txBase64 } });
      return res.signed_transaction ?? res.signedTransaction ?? res;
    },
    async signMessage(message: string): Promise<string> {
      const res: any = await (c.wallets() as any)
        .solana()
        .signMessage(walletId, { params: { message } });
      return res.signature ?? res;
    },
  };
}

/** Resolve a robot name to a Privy-backed Solana signer, or null if unprovisioned. */
export function accountFor(name: string) {
  const w = WALLETS[name];
  if (!APP_ID || !APP_SECRET || !w?.id || !w?.addr) return null;
  return privyAccount(w.id, w.addr);
}
