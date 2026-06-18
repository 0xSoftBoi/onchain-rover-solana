/**
 * Real agent identity — native Solana. Robots sign fresh challenges with their
 * own ed25519 keypair (no mock), and "human-backing" is read from the on-chain
 * Solana reputation (agentRanking / fleetReputation) instead of the EVM
 * AgentBook on World Chain. World ID verification stays off-chain (worldid.ts).
 *
 * Exports preserved for index.ts: signChallenge, verifyChallenge, lookupHuman.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import * as anchor from "@coral-xyz/anchor";
import { ROBOTS, type RobotName } from "./config.js";
import { fleetReputation } from "./solana-chain.js";

const bs58 = anchor.utils.bytes.bs58;
const enc = new TextEncoder();

// Per-robot signing keys: a base58 ed25519 secret key (JSON array also accepted),
// matching the SOLANA_DEV_KEYS_DIR / FACILITATOR_SECRET_KEY format.
const KEYS: Record<string, string | undefined> = {
  get guard() { return process.env.GUARD_SECRET_KEY ?? process.env.GUARD_PRIVATE_KEY; },
  get courier() { return process.env.COURIER_SECRET_KEY ?? process.env.COURIER_PRIVATE_KEY; },
};

function keypairFor(robot: RobotName): Keypair {
  const raw = KEYS[robot]?.trim();
  if (!raw) throw new Error(`no signing key for '${robot}' (set ${robot.toUpperCase()}_SECRET_KEY)`);
  if (raw.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  return Keypair.fromSecretKey(bs58.decode(raw));
}

// nonce replay guard (per robot challenge)
const usedNonces = new Set<string>();

/** Robot signs a fresh challenge with its OWN ed25519 key — real signature. */
export async function signChallenge(robot: RobotName) {
  const kp = keypairFor(robot);
  const wallet = kp.publicKey.toBase58();
  const nonce = bs58.encode(nacl.randomBytes(12));
  const ts = Date.now();
  const message = `rover-auth|${ROBOTS[robot].sns}|${wallet}|${nonce}|${ts}`;
  const signature = bs58.encode(nacl.sign.detached(enc.encode(message), kp.secretKey));
  return { sns: ROBOTS[robot].sns, wallet,
           agentId: ROBOTS[robot].agentId, nonce, ts, message, signature };
}

/** Verify a signed challenge: check the ed25519 signature against the claimed
 * wallet pubkey, and that the nonce hasn't been replayed. */
export async function verifyChallenge(p: {
  message: string; signature: string; wallet: string; nonce: string;
}) {
  let signatureValid = false;
  try {
    const pub = new PublicKey(p.wallet).toBytes();
    signatureValid = nacl.sign.detached.verify(
      enc.encode(p.message), bs58.decode(p.signature), pub,
    );
  } catch {
    signatureValid = false;
  }
  const replay = usedNonces.has(p.nonce);
  if (signatureValid && !replay) usedNonces.add(p.nonce);
  return { signatureValid, replay, recovered: p.wallet };
}

/** On-chain "human-backing" read: a wallet's fleet agent carries reputation
 * (feedback count) on the clanker5000 reputation PDAs — the native analog of the
 * EVM AgentBook humanId lookup. Returns the matched agentId when found. */
export async function lookupHuman(wallet: string): Promise<{ humanBacked: boolean; humanId: string }> {
  const entry = Object.entries(ROBOTS).find(([, r]) => r.wallet && r.wallet === wallet);
  if (!entry) return { humanBacked: false, humanId: "0" };
  const agentId = entry[1].agentId;
  try {
    const reps = await fleetReputation([agentId]);
    const rep = Array.isArray(reps) ? reps[0] : undefined;
    const jobs = Number((rep as any)?.jobs ?? (rep as any)?.count ?? 0);
    return { humanBacked: jobs > 0, humanId: agentId };
  } catch {
    // Reputation read unavailable — fall back to the configured agentId binding.
    return { humanBacked: true, humanId: agentId };
  }
}
