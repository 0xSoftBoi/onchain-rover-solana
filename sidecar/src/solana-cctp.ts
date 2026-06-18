/**
 * Circle CCTP V2 — native USDC cross-chain in/out of Solana (burn-and-mint, 1:1,
 * no liquidity pools). Lets the fleet treasury move USDC between Solana and EVM
 * chains. See docs/SOLANA_NATIVE_MIGRATION.md §1 (CCTP row).
 *
 * Flow (Solana -> other chain):
 *   1. depositForBurn on Solana's TokenMessengerMinter (burns USDC, emits a msg)
 *   2. poll Circle's Iris attestation API for the message attestation
 *   3. receiveMessage on the destination chain (mints USDC)
 * Inbound (other chain -> Solana) is the mirror: receiveMessage on Solana.
 *
 * This is a thin config + client scaffold. Wiring the on-chain CPIs needs the
 * CCTP program IDLs (TokenMessengerMinter + MessageTransmitter); confirm program
 * IDs + domain ids against developers.circle.com/cctp before mainnet use.
 */
import "./env.js";

// CCTP domain ids (Circle): Solana = 5; Ethereum = 0; Base = 6; Arc = (per Circle).
export const CCTP_DOMAINS = { solana: 5, ethereum: 0, base: 6 } as const;

// Iris attestation API (V2). Devnet/testnet uses the sandbox host.
export function irisBase(): string {
  return process.env.CCTP_IRIS_URL
    ?? (process.env.SOLANA_CLUSTER?.includes("main")
      ? "https://iris-api.circle.com"
      : "https://iris-api-sandbox.circle.com");
}

/**
 * Poll Circle's Iris API for a message attestation by its hash (emitted by the
 * source-chain burn). Returns the attestation bytes once `status === "complete"`.
 */
export async function fetchAttestation(messageHash: string, timeoutMs = 120_000): Promise<string> {
  const url = `${irisBase()}/v2/messages?messageHash=${messageHash}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(url);
    if (res.ok) {
      const j: any = await res.json();
      const m = j?.messages?.[0];
      if (m?.status === "complete" && m?.attestation && m.attestation !== "PENDING") {
        return m.attestation;
      }
    }
    await new Promise((r) => setTimeout(r, 4_000));
  }
  throw new Error("CCTP attestation timed out");
}

/**
 * TODO (needs CCTP program IDLs): build + send `depositForBurn` on Solana's
 * TokenMessengerMinter to burn `amountUsdc` and target `destinationDomain` +
 * `mintRecipient`. Returns the message hash to feed `fetchAttestation`. Left as
 * a typed stub so the treasury bridge flow is wired end-to-end once the CCTP
 * Anchor clients are added.
 */
export async function depositForBurn(_opts: {
  amountUsdc: string;
  destinationDomain: number;
  mintRecipient: string; // 32-byte (base58/hex) recipient on the destination chain
}): Promise<{ messageHash: string; tx: string }> {
  throw new Error(
    "CCTP depositForBurn not yet wired — add the TokenMessengerMinter IDL/client " +
      "(see developers.circle.com/cctp). Config + attestation polling are ready.",
  );
}
