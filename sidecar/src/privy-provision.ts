import "./env.js";
/**
 * Provision Privy server wallets for the fleet (ed25519 Solana keypairs held in
 * Privy's TEE). Run once:  npx tsx src/privy-provision.ts
 * Needs PRIVY_APP_ID + PRIVY_APP_SECRET (Privy dashboard → app settings).
 * Prints wallet ids + base58 addresses — add to .env:
 *   PRIVY_WALLET_GUARD=<id>   PRIVY_ADDR_GUARD=<pubkey>
 *   PRIVY_WALLET_COURIER=<id> PRIVY_ADDR_COURIER=<pubkey>
 * Then fund the printed addresses with SPL-USDC and set CUSTODY=privy to route
 * signing through the enclave.
 */
import { client } from "./privy.js";

const wallets = client().wallets();
for (const role of ["guard", "courier"]) {
  const w: any = await wallets.create({ chain_type: "solana" } as any);
  console.log(`${role}: id=${w.id ?? w.walletId}  address=${w.address}`);
}
console.log("\nAdd the ids + addresses to .env (PRIVY_WALLET_* / PRIVY_ADDR_*),");
console.log("fund the addresses with SPL-USDC, then set CUSTODY=privy.");
