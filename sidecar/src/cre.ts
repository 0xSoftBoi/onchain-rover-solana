import "./env.js";
/**
 * Attestation / off-chain verdict — native Solana (program AttestationConsumer).
 *
 * This is the native-Solana-only fork: the Chainlink CRE consumer (Sepolia via
 * viem) is replaced by the clanker5000 program's `write_attestation` /
 * attestation account. Export names are preserved (`config`, `latest`) so
 * importers (index.ts) are unchanged; bodies delegate to solana-chain.ts.
 * `writeAttestation` / `isVerified` are re-exported for the write/gate paths.
 * See docs/SOLANA_NATIVE_MIGRATION.md §7.
 */
import { writeAttestation, getAttestation, isVerified } from "./solana-chain.js";

const JOB = process.env.CRE_JOB ?? "demo-1";

export function config() {
  return {
    configured: true,
    job: JOB,
    chain: "solana",
    threshold: 70,
    backend: "clanker5000-attestation",
  };
}

export async function latest() {
  try {
    const a = await getAttestation(JOB);
    return { configured: true, ...a };
  } catch (e: any) {
    return { configured: true, job: JOB, error: e.message };
  }
}

export { writeAttestation, getAttestation, isVerified };
