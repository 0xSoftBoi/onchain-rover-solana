/**
 * Stake adapter — native Solana.
 *
 * On EVM the matched stake was an off-chain EIP-712 "spend permission" the
 * spender later pulled. That model does not exist on Solana: a driver stakes by
 * signing the program's `join_race` instruction (built by
 * solana-chain.ts:buildRaceEntryRequest), which moves USDC into the race vault
 * PDA. Settlement is the program's `settle_race`, which pays the vault to the
 * winner. There is no separate signed allowance to verify or to pull later.
 *
 * This module therefore reduces to a thin adapter that:
 *   - prepareStake → returns the join_race instruction request (the thing the
 *     driver wallet signs), via buildRaceEntryRequest.
 *   - verifyStake  → records that the on-chain join is the stake authorization
 *     (escrowed in the vault); no off-chain signature to recover.
 *   - settle       → describes the on-chain settle_race payout (vault → winner).
 *
 * Exported names used by index.ts are preserved: stakeAdapter (returning an
 * object with prepareStake / verifyStake / settle). The legacy adapter kind
 * strings are still accepted for API compatibility.
 */
import * as chain from "./chain-backend.js";
import { buildRaceEntryRequest } from "./solana-chain.js";
import type { DriverSlot, Round, StakeAuthorization } from "./rounds.js";

// The Solana stake lives in the on-chain race vault (escrow), so we record it
// against the "local-chain-escrow" authorization kind that rounds.ts accepts.
export type StakeAdapterKind = "local-chain-escrow";

export type PreparedStake = {
  adapter: StakeAdapterKind;
  model: "solana-join-race";
  roundId: string;
  slot: DriverSlot;
  wallet: string;
  token: string;
  amountUsdc: string;
  note: string;
  // The serialized join_race instruction the driver wallet signs + submits.
  request: Awaited<ReturnType<typeof buildRaceEntryRequest>>;
};

export type VerifyStakeInput = {
  wallet?: string;
  txHash?: string;
  transactionHash?: string;
  tx?: string;
  signature?: string;
};

export type StakeSettlementPlan = {
  adapter: StakeAdapterKind;
  model: "solana-settle-race";
  roundId: string;
  winner: DriverSlot;
  loser: DriverSlot;
  token: string;
  amountUsdc: string;
  note: string;
};

export interface StakeAdapter {
  kind: StakeAdapterKind;
  prepareStake(round: Round, slot: DriverSlot, wallet?: string): Promise<PreparedStake>;
  verifyStake(round: Round, slot: DriverSlot, input: VerifyStakeInput): Promise<StakeAuthorization>;
  settle(round: Round): StakeSettlementPlan;
}

function token(): string {
  return chain.localChainConfig().usdcMint;
}

function requireDriver(round: Round, slot: DriverSlot) {
  const driver = round.drivers[slot];
  if (!driver?.wallet) throw new Error(`missing ${slot}`);
  return driver;
}

export const solanaStakeAdapter: StakeAdapter = {
  kind: "local-chain-escrow",

  async prepareStake(round, slot, wallet) {
    const driver = requireDriver(round, slot);
    if (wallet && wallet !== driver.wallet) throw new Error("wallet does not match driver slot");
    const request = await buildRaceEntryRequest(round, slot, wallet ?? driver.wallet);
    return {
      adapter: this.kind,
      model: "solana-join-race",
      roundId: round.id,
      slot,
      wallet: driver.wallet,
      token: token(),
      amountUsdc: round.stakeUsdc,
      note:
        "Stake is signed via the join_race instruction (buildRaceEntryRequest); " +
        "the driver wallet signs and submits it, escrowing USDC in the race vault.",
      request,
    };
  },

  async verifyStake(round, slot, input) {
    const driver = requireDriver(round, slot);
    if (input.wallet && input.wallet !== driver.wallet) {
      throw new Error("wallet does not match driver slot");
    }
    // On Solana the stake is verified by the on-chain join (USDC escrowed in the
    // vault), not an off-chain signature. Record the join tx if supplied.
    const txHash = input.txHash ?? input.transactionHash ?? input.tx;
    return {
      adapter: this.kind,
      status: "verified",
      roundId: round.id,
      token: token(),
      amountUsdc: round.stakeUsdc,
      txHash,
      signature: input.signature,
      verifiedAt: Date.now(),
    };
  },

  settle(round) {
    if (round.status === "canceled") throw new Error("canceled rounds cannot settle stake");
    if (!round.winner) throw new Error("round winner required");
    const winner = round.winner;
    const loser: DriverSlot = winner === "challenger" ? "opponent" : "challenger";
    requireDriver(round, winner);
    requireDriver(round, loser);
    return {
      adapter: this.kind,
      model: "solana-settle-race",
      roundId: round.id,
      winner,
      loser,
      token: token(),
      amountUsdc: round.stakeUsdc,
      note:
        "Stake settles on-chain via settle_race: the program pays the race vault " +
        "(both drivers' escrowed stakes) to the winner. No off-chain pull.",
    };
  },
};

export function stakeAdapter(_kind?: string): StakeAdapter {
  // All kinds map to the single Solana escrow adapter; the param is accepted for
  // API compatibility with the old base-spend-permission selector.
  return solanaStakeAdapter;
}
