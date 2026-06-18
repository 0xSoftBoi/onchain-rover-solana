/**
 * Local dev wallets — native Solana. Generates deterministic-per-process Solana
 * Keypairs for the two driver slots and persists their secret keys (JSON byte
 * arrays) to SOLANA_DEV_KEYS_DIR, keyed by base58 pubkey, so solana-chain.ts
 * (driverKeypair / bettor signing) can load and sign join_race for local runs.
 *
 * This is the Solana analog of the old EVM private-key dev wallets. There is no
 * EIP-712 typed data on Solana: the driver simply signs the join instruction.
 * signLocalDevRaceEntry therefore just ensures the keypair is on disk where
 * joinRoundOnChain expects it, and returns a compatible shape for index.ts.
 *
 * Exports preserved for index.ts: LOCAL_DEV_PRIVATE_KEYS, localDevWallet,
 * localDevWallets, signLocalDevRaceEntry.
 */
import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

import type { DriverSlot } from "./rounds.js";

const bs58 = anchor.utils.bytes.bs58;

// Fixed dev seeds (32 bytes each) so the same pubkeys recur across restarts —
// the Solana equivalent of the well-known EVM dev private keys.
const DEV_SEEDS: Record<DriverSlot, Uint8Array> = {
  challenger: seed(0x11),
  opponent: seed(0x22),
};

function seed(fill: number): Uint8Array {
  return Uint8Array.from(new Array(32).fill(fill));
}

const accounts: Record<DriverSlot, Keypair> = {
  challenger: Keypair.fromSeed(DEV_SEEDS.challenger),
  opponent: Keypair.fromSeed(DEV_SEEDS.opponent),
};

/** Base58 secret keys for the dev slots (the Solana analog of the EVM keys). */
export const LOCAL_DEV_PRIVATE_KEYS: Record<DriverSlot, string> = {
  challenger: bs58.encode(accounts.challenger.secretKey),
  opponent: bs58.encode(accounts.opponent.secretKey),
};

function devKeysDir(): string | null {
  return process.env.SOLANA_DEV_KEYS_DIR ?? null;
}

/** Persist a slot's secret key to SOLANA_DEV_KEYS_DIR/<pubkey>.json (byte array). */
function persistKey(slot: DriverSlot): string {
  const kp = accounts[slot];
  const pubkey = kp.publicKey.toBase58();
  const dir = devKeysDir();
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${pubkey}.json`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
    }
  }
  return pubkey;
}

export function localDevWallet(slot: DriverSlot) {
  const pubkey = persistKey(slot);
  return {
    slot,
    address: pubkey,
    displayName: slot,
  };
}

export function localDevWallets() {
  return {
    challenger: localDevWallet("challenger"),
    opponent: localDevWallet("opponent"),
  };
}

/**
 * Ensure the dev keypair for `slot` is on disk where joinRoundOnChain loads it,
 * then return a shape compatible with the index.ts join flow. On Solana the
 * driver signs the join instruction itself (no entry/permit typed data), so the
 * signature fields are informational placeholders; joinRoundOnChain signs with
 * the persisted keypair.
 */
export async function signLocalDevRaceEntry(
  slot: DriverSlot,
  // The Solana buildRaceEntryRequest shape ({ chain, slot, instruction }); unused
  // because the driver keypair signs join_race directly in joinRoundOnChain.
  _request: unknown,
) {
  const pubkey = persistKey(slot);
  const note = `solana:join_race signed by ${pubkey} via SOLANA_DEV_KEYS_DIR`;
  return {
    entrySignature: note,
    permitSignature: note,
    entryDeadline: String(Math.floor(Date.now() / 1000) + 3600),
    permitDeadline: String(Math.floor(Date.now() / 1000) + 3600),
  };
}
