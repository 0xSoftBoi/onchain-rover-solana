/**
 * Session authorization — the OPENING Ledger ceremony (bookends the withdraw).
 *
 * Native Solana: before the robots do anything, a human operator signs an
 * "Authorize Clanker500 fleet" message with their Solana wallet (Ledger Solana
 * app / phone wallet). It's GASLESS (a signed message, not a transaction) so it
 * can't fail on fees/RPC mid-demo; the sidecar verifies the ed25519 signature
 * and unlocks the show. Symmetric with the closing treasury withdraw: autonomous
 * robots, human-held keys — human authority at both ends.
 *
 * The message is a deterministic plain-text string (no EIP-712 typed data) so it
 * serializes cleanly to the browser and back, and renders legibly on the device.
 *
 * Exports preserved for index.ts: authMessage, issue, verify, status, reset.
 */
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import * as anchor from "@coral-xyz/anchor";

const bs58 = anchor.utils.bytes.bs58;
const enc = new TextEncoder();

const EVENT = process.env.DEMO_EVENT || "Solana Breakpoint 2026";
const FLEET = "guard.roverfleet.sol + courier.roverfleet.sol";

type State = { authorized: boolean; operator?: string; event?: string; at?: number };
let state: State = { authorized: false };
let issued: { operator: string; message: string; event: string; issuedAt: string } | null = null;

/** Build the plain-text authorization message the operator's wallet signs. */
export function authMessage(operator: string) {
  // Validate the operator is a real Solana pubkey.
  const op = new PublicKey(operator).toBase58();
  const issuedAt = new Date().toISOString();
  const message = [
    "Clanker500 — Authorize fleet",
    `operator: ${op}`,
    `fleet: ${FLEET}`,
    `event: ${EVENT}`,
    "action: Authorize fleet to operate and earn for this session",
    `issuedAt: ${issuedAt}`,
  ].join("\n");
  return { operator: op, message, event: EVENT, issuedAt };
}

/** Issue a fresh message for `operator` and remember it for verification. */
export function issue(operator: string) {
  if (!operator) throw new Error("operator address required");
  issued = authMessage(operator);
  return issued;
}

/** Verify the wallet signature against the last-issued message; unlock on success. */
export async function verify(signature: string) {
  if (!issued) throw new Error("request the authorization message first");
  let ok = false;
  try {
    const pub = new PublicKey(issued.operator).toBytes();
    ok = nacl.sign.detached.verify(enc.encode(issued.message), bs58.decode(signature), pub);
  } catch {
    ok = false;
  }
  if (ok) {
    state = { authorized: true, operator: issued.operator, event: issued.event, at: Date.now() };
  }
  return { ok, ...state };
}

export function status() {
  return state;
}

export function reset() {
  state = { authorized: false };
  issued = null;
  return state;
}
