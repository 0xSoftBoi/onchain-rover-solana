/**
 * Robot wallets = Privy SERVER wallets on Solana (TEE-held ed25519 keypairs;
 * the host never holds the secret). Visitor/bettor wallets = embedded wallets on
 * the web/ side. Native-Solana fork: chain_type is "solana" (was "ethereum").
 * Method names per docs.privy.io/recipes/solana — confirm against the installed
 * @privy-io/node version.
 */
import { PrivyClient } from "@privy-io/node";

const privy = new PrivyClient({
  appId: process.env.PRIVY_APP_ID!,
  appSecret: process.env.PRIVY_APP_SECRET!,
});

export async function createRobotWallet() {
  const wallet = await privy.wallets().create({ chain_type: "solana" });
  return { walletId: wallet.id, address: wallet.address };
}

/** Sign a base64-serialized Solana transaction inside the Privy TEE. */
export async function signTransaction(walletId: string, txBase64: string) {
  return (privy.wallets() as any).solana().signTransaction(walletId, {
    params: { transaction: txBase64 },
  });
}

export async function signMessage(walletId: string, message: string) {
  return (privy.wallets() as any).solana().signMessage(walletId, {
    params: { message },
  });
}
