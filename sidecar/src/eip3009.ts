import "./env.js";
/**
 * Gasless settlement over GibberLink — native Solana adaptation.
 *
 * This is the native-Solana-only fork. There is NO EIP-3009 analog on Solana
 * (no pull-payment signed authorization); the Solana model is "user signs the
 * transfer, a relayer pays the fee" (Kora). Until a Kora relayer is stood up
 * (docs/SOLANA_NATIVE_MIGRATION.md §2), the demo "settle over GibberLink" path
 * keeps its robot-to-robot transport choreography but settles with a plain
 * SPL-USDC transfer (`payOnChain`) rather than a relayed authorization.
 *
 * The export name `settleOverGibber` is preserved so index.ts is unchanged.
 */
import { ROBOTS, type RobotName } from "./config.js";
import { payOnChain } from "./solana-chain.js";

/**
 * Buyer -> seller settlement, choreographed over the GibberLink channel.
 *
 * On EVM this carried a signed EIP-3009 authorization (buyer gas $0). On Solana
 * there is no equivalent signed pull-payment, so we (1) keep the GibberLink
 * handshake so the robot-to-robot messaging still demos, and (2) settle the
 * value via a native SPL-USDC transfer. True gasless requires a Kora relayer as
 * fee payer (TODO).
 */
export async function settleOverGibber(
  buyerRole: string, sellerRole: string, amountUsdc: string,
) {
  const buyerUrl = ROBOTS[buyerRole as RobotName]?.url;
  const sellerUrl = ROBOTS[sellerRole as RobotName]?.url;

  // 1. transport a settlement intent over GibberLink (buyer -> peer -> seller),
  //    best-effort: the choreography is the demo, not a precondition for value.
  let transportedOverGibber = false;
  if (buyerUrl && sellerUrl) {
    try {
      const payload = JSON.stringify({ kind: "x402-solana-settle", buyerRole, sellerRole, amountUsdc });
      await fetch(`${buyerUrl}/gibber/send`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload }),
      });
      for (let i = 0; i < 6 && !transportedOverGibber; i++) {
        const r = await (await fetch(`${sellerUrl}/gibber/recv?timeout_secs=6`)).json();
        if (!r.payload) break;
        try { if (JSON.parse(r.payload).kind === "x402-solana-settle") transportedOverGibber = true; } catch {}
      }
    } catch { /* transport is best-effort */ }
  }

  // 2. settle the value natively (SPL-USDC transfer). Kora-relayed gasless TODO.
  const onchain = await payOnChain(buyerRole, sellerRole, amountUsdc);
  return {
    transportedOverGibber,
    gasless: false, // TODO: route via Kora relayer for buyer-gas-$0 settlement
    amountUsdc,
    ...onchain,
  };
}
