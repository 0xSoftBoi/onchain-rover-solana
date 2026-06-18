/**
 * clanker5000 program client (browser, read-only + wallet-signed instructions).
 *
 * Reads (leaderboard, race/market state) go through Anchor with the committed
 * IDL. For writes that the program gates to a driver/bettor signer (join_race,
 * place_bet), the sidecar computes the PDAs/accounts and returns a serialized
 * instruction (buildRaceEntryRequest); we reconstruct it and the connected
 * wallet signs + sends. No server key touches the user's funds.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import idl from "../idl/clanker5000.json";
import { PROGRAM_ID } from "../config";

export type SidecarIx = {
  programId: string;
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64
};

export type SendWallet = {
  publicKey: PublicKey;
  sendTransaction: (tx: Transaction, conn: Connection) => Promise<string>;
};

/** Read-only Anchor program (no wallet needed for account fetches). */
export function readProgram(connection: Connection): anchor.Program<anchor.Idl> {
  const withAddr = { ...(idl as any), address: PROGRAM_ID.toBase58() };
  const provider = { connection } as unknown as anchor.Provider;
  return new (anchor.Program as any)(withAddr, provider);
}

export type AgentRank = {
  agentId: string;
  owner: string;
  jobs: number;
  avgScore: number | null;
};

/** Rank agents by the on-chain reputation accounts (count, then avg). */
export async function agentRanking(
  connection: Connection,
  limit = 20,
): Promise<AgentRank[]> {
  const program = readProgram(connection);
  const agents = await (program.account as any).agent.all();
  return agents
    .map((a: any): AgentRank => {
      const jobs = Number(a.account.count.toString());
      const sum = Number(a.account.sum.toString());
      return {
        agentId: a.account.agentId.toString(),
        owner: a.account.owner.toBase58(),
        jobs,
        avgScore: jobs ? sum / jobs : null,
      };
    })
    .sort((x: AgentRank, y: AgentRank) => y.jobs - x.jobs || (y.avgScore ?? 0) - (x.avgScore ?? 0))
    .slice(0, limit);
}

/** Rebuild a web3 instruction from the sidecar's serialized shape. */
export function ixFromSidecar(ix: SidecarIx): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.keys.map((k) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

/** Build a tx from instructions, have the wallet sign + send, and confirm. */
export async function sendInstructions(
  connection: Connection,
  wallet: SendWallet,
  ixs: TransactionInstruction[],
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sig = await wallet.sendTransaction(tx, connection);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}
