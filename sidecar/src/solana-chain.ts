/**
 * Solana settlement backend (CHAIN_BACKEND=solana) — the native-Solana
 * counterpart of chain.ts. Drives the `clanker5000` Anchor program
 * (solana/programs/clanker5000) instead of the EVM RaceEscrow.
 *
 * It mirrors chain.ts's function surface so chain-backend.ts can dispatch to
 * either backend. Lifecycle transitions (open/lock/start/finish/settle/cancel)
 * are signed by the facilitator keypair. `join_race` is signed by the driver:
 * in production the driver's phone wallet signs the instruction built by
 * buildRaceEntryRequest; for local/dev runs a dev keypair is loaded from
 * SOLANA_DEV_KEYS_DIR. See docs/SOLANA_PORT.md.
 *
 * Requires the program IDL at src/generated/clanker5000.json (produced by
 * `anchor build`) and src/generated/contracts.solana.json (deployment).
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import { type Idl } from "@coral-xyz/anchor";
// anchor 0.30 exposes BN only on the CJS default export, not the ESM namespace, so a
// named `import { BN }` crashes under Node ESM (tsx). Bind the value + type explicitly.
const BN = (anchor as unknown as { default: { BN: typeof import("@coral-xyz/anchor").BN } }).default.BN;
type BN = InstanceType<typeof import("@coral-xyz/anchor").BN>;
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
} from "@solana/spl-token";

import type { DriverSlot, Round } from "./rounds.js";
import { solanaChainConfig, publicSolanaChainConfig } from "./solana-config.js";
import { priorityPreInstructions } from "./helius.js";

export { solanaChainConfig as localChainConfig, publicSolanaChainConfig as publicLocalChainConfig };

const enc = new TextEncoder();
const RACE_DECIMALS = 6;

// ---- low-level helpers -----------------------------------------------------

function parseSecretKey(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  // base58
  return Keypair.fromSecretKey(anchor.utils.bytes.bs58.decode(trimmed));
}

function facilitatorKeypair(): Keypair {
  const raw = process.env.FACILITATOR_SECRET_KEY;
  if (!raw) throw new Error("FACILITATOR_SECRET_KEY required for Solana settlement writes");
  return parseSecretKey(raw);
}

function connection(): Connection {
  return new Connection(solanaChainConfig().rpcUrl, "confirmed");
}

let cachedProgram: anchor.Program<Idl> | null = null;
function program(): anchor.Program<Idl> {
  if (cachedProgram) return cachedProgram;
  const idlUrl = new URL("./generated/clanker5000.json", import.meta.url);
  if (!fs.existsSync(idlUrl)) {
    throw new Error(
      "clanker5000 IDL missing; run `anchor build` and copy target/idl/clanker5000.json to sidecar/src/generated/clanker5000.json"
    );
  }
  const idl = JSON.parse(fs.readFileSync(idlUrl, "utf8"));
  const cfg = solanaChainConfig();
  idl.address = cfg.programId; // honor configured/deployed id
  const wallet = new anchor.Wallet(facilitatorKeypair());
  const provider = new anchor.AnchorProvider(connection(), wallet, { commitment: "confirmed" });
  // Untyped Program: avoids needing generated TS types in the sidecar build.
  cachedProgram = new (anchor.Program as any)(idl, provider) as anchor.Program<Idl>;
  return cachedProgram;
}

function pid(): PublicKey {
  return new PublicKey(solanaChainConfig().programId);
}
function usdcMint(): PublicKey {
  return new PublicKey(solanaChainConfig().usdcMint);
}
function leU64(n: number | bigint | string): Buffer {
  return new BN(n.toString()).toArrayLike(Buffer, "le", 8);
}
function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("config")], pid())[0];
}
function racePda(raceId: number | bigint | string): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("race"), leU64(raceId)], pid())[0];
}
function vaultPda(race: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("vault"), race.toBuffer()], pid())[0];
}
function vaultAuthPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("vault_auth")], pid())[0];
}
function ata(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(usdcMint(), owner);
}

function units(value: string): BN {
  const [whole, frac = ""] = String(value).split(".");
  const fracPadded = (frac + "0".repeat(RACE_DECIMALS)).slice(0, RACE_DECIMALS);
  return new BN(`${whole}${fracPadded}`.replace(/^0+(?=\d)/, ""));
}
function slotToIndex(slot: DriverSlot): number {
  return slot === "challenger" ? 0 : 1;
}
function proofBytes(round: Round): number[] {
  const explicit = String(round.proofHash ?? "").replace(/^0x/, "");
  const hex = /^[a-fA-F0-9]{64}$/.test(explicit)
    ? explicit
    : createHash("sha256").update(JSON.stringify(round.proof ?? {})).digest("hex");
  return Array.from(Buffer.from(hex, "hex"));
}
function driverKeypair(wallet: string): Keypair | null {
  const dir = process.env.SOLANA_DEV_KEYS_DIR;
  if (!dir) return null;
  const file = `${dir}/${wallet}.json`;
  if (!fs.existsSync(file)) return null;
  return parseSecretKey(fs.readFileSync(file, "utf8"));
}

// ---- lifecycle (facilitator-signed) ---------------------------------------

export async function openRoundOnChain(round: Round) {
  if (round.chainRaceId) return { raceId: round.chainRaceId, tx: round.txHashes?.open ?? "" };
  const p = program();
  const cfg = await (p.account as any).config.fetch(configPda());
  const raceId: BN = cfg.nextRaceId;
  const race = racePda(raceId.toString());
  const localRoundId = Array.from(createHash("sha256").update(round.id).digest());
  const tx = await (p.methods as any)
    .openRace(raceId, localRoundId, units(round.stakeUsdc), units(round.feeUsdc))
    .accounts({
      config: configPda(),
      facilitator: facilitatorKeypair().publicKey,
      race,
      vault: vaultPda(race),
      vaultAuthority: vaultAuthPda(),
      usdcMint: usdcMint(),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  return { raceId: raceId.toString(), tx };
}

/**
 * Build the join instruction for the driver's wallet to sign. On Solana the
 * driver is a transaction signer (no EIP-712 typed data / ERC-2612 permit), so
 * this returns a serialized instruction the phone wallet signs and submits.
 */
export async function buildRaceEntryRequest(round: Round, slot: DriverSlot, wallet?: string) {
  if (!round.chainRaceId) throw new Error("open the round on-chain first");
  const driver = round.drivers[slot];
  if (!driver?.wallet) throw new Error(`missing ${slot}`);
  if (wallet && wallet !== driver.wallet) throw new Error("wallet does not match driver slot");
  const cfg = solanaChainConfig();
  const driverPk = new PublicKey(driver.wallet);
  const race = racePda(round.chainRaceId);
  const p = program();
  const ix = await (p.methods as any)
    .joinRace(new BN(round.chainRaceId), slotToIndex(slot), units(round.stakeUsdc), units(round.feeUsdc))
    .accounts({
      config: configPda(),
      race,
      driver: driverPk,
      driverToken: ata(driverPk),
      vault: vaultPda(race),
      treasuryToken: new PublicKey(cfg.treasury),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return {
    chain: { cluster: cfg.cluster, rpcUrl: cfg.publicRpcUrl, name: "Clanker500 Solana", programId: cfg.programId },
    slot,
    instruction: {
      programId: ix.programId.toBase58(),
      keys: ix.keys.map((k: any) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
      data: Buffer.from(ix.data).toString("base64"),
    },
  };
}

/**
 * Submit the driver's join. Production: the phone signs the instruction from
 * buildRaceEntryRequest. For local/dev runs we load the driver keypair from
 * SOLANA_DEV_KEYS_DIR and sign here (mirrors the EVM ALLOW_LOCAL_DEV_WALLETS path).
 */
export async function joinRoundOnChain(opts: {
  round: Round;
  slot: DriverSlot;
  entrySignature?: string;
  permitSignature?: string;
  entryDeadline?: string | number | bigint;
  permitDeadline?: string | number | bigint;
}) {
  if (!opts.round.chainRaceId) throw new Error("open the round on-chain first");
  const driver = opts.round.drivers[opts.slot];
  if (!driver?.wallet) throw new Error(`missing ${opts.slot}`);
  const signer = driverKeypair(driver.wallet);
  if (!signer) {
    throw new Error(
      "Solana join_race must be signed by the driver wallet; submit the instruction from buildRaceEntryRequest, or set SOLANA_DEV_KEYS_DIR for local dev"
    );
  }
  const p = program();
  const driverPk = signer.publicKey;
  const race = racePda(opts.round.chainRaceId);
  const tx = await (p.methods as any)
    .joinRace(new BN(opts.round.chainRaceId), slotToIndex(opts.slot), units(opts.round.stakeUsdc), units(opts.round.feeUsdc))
    .accounts({
      config: configPda(),
      race,
      driver: driverPk,
      driverToken: ata(driverPk),
      vault: vaultPda(race),
      treasuryToken: new PublicKey(solanaChainConfig().treasury),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([signer])
    .rpc();
  return { tx };
}

async function facilitatorRace(round: Round, method: string, extraArgs: unknown[] = []) {
  const raceId = requireChainRaceId(round);
  const p = program();
  const tx = await (p.methods as any)[method](new BN(raceId), ...extraArgs)
    .accounts({
      config: configPda(),
      facilitator: facilitatorKeypair().publicKey,
      race: racePda(raceId),
    })
    .rpc();
  return { tx };
}

export async function lockRoundOnChain(round: Round) {
  return facilitatorRace(round, "lockRace");
}
export async function startRoundOnChain(round: Round) {
  return facilitatorRace(round, "startRace");
}
export async function finishRoundOnChain(round: Round) {
  if (!round.winner) throw new Error("round winner required");
  return facilitatorRace(round, "finishRace", [slotToIndex(round.winner), proofBytes(round)]);
}

export async function settleRoundOnChain(round: Round) {
  if (!round.winner) throw new Error("round winner required");
  const raceId = requireChainRaceId(round);
  const winnerWallet = round.drivers[round.winner]?.wallet;
  if (!winnerWallet) throw new Error("winner wallet missing");
  const race = racePda(raceId);
  const p = program();
  const tx = await (p.methods as any)
    .settleRace(new BN(raceId))
    .accounts({
      config: configPda(),
      facilitator: facilitatorKeypair().publicKey,
      race,
      vault: vaultPda(race),
      vaultAuthority: vaultAuthPda(),
      winnerToken: ata(new PublicKey(winnerWallet)),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions(await priorityPreInstructions(null, solanaChainConfig().cluster))
    .rpc();
  return { tx };
}

export async function cancelRoundOnChain(round: Round, reason = "canceled") {
  const raceId = requireChainRaceId(round);
  const race = racePda(raceId);
  const fac = facilitatorKeypair().publicKey;
  const challengerWallet = round.drivers.challenger?.wallet;
  const opponentWallet = round.drivers.opponent?.wallet;
  const p = program();
  const tx = await (p.methods as any)
    .cancelRace(new BN(raceId), reason)
    .accounts({
      config: configPda(),
      facilitator: fac,
      race,
      vault: vaultPda(race),
      vaultAuthority: vaultAuthPda(),
      // Not-joined slots are ignored on-chain; fall back to the facilitator ATA.
      challengerToken: ata(challengerWallet ? new PublicKey(challengerWallet) : fac),
      opponentToken: ata(opponentWallet ? new PublicKey(opponentWallet) : fac),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  return { tx };
}

// ---- reads / faucet --------------------------------------------------------

export async function localChainHealth() {
  const cfg = solanaChainConfig();
  const conn = connection();
  const [slot, programInfo] = await Promise.all([
    conn.getSlot(),
    conn.getAccountInfo(pid()),
  ]);
  return {
    ok: programInfo !== null,
    chainId: cfg.cluster,
    blockNumber: slot.toString(),
    raceEscrow: cfg.programId,
    raceToken: cfg.usdcMint,
    escrowDeployed: programInfo !== null,
    tokenDeployed: (await conn.getAccountInfo(usdcMint())) !== null,
  };
}

export async function localTreasuryInfo() {
  const cfg = solanaChainConfig();
  const conn = connection();
  let balanceUnits = "0";
  try {
    const acct = await getAccount(conn, new PublicKey(cfg.treasury));
    balanceUnits = acct.amount.toString();
  } catch {
    /* treasury token account not yet created */
  }
  const config = await (program().account as any).config.fetch(configPda()).catch(() => null);
  const totalFeesUnits = config ? config.totalFeesCollected.toString() : "0";
  return {
    treasury: cfg.treasury,
    raceToken: cfg.usdcMint,
    balanceUnits,
    balance: formatUnits(balanceUnits),
    totalFeesUnits,
    totalFees: formatUnits(totalFeesUnits),
  };
}

export async function fundLocalWallet(wallet: string, amount = "100") {
  const raw = process.env.SOLANA_MINT_AUTHORITY_SECRET_KEY;
  if (!raw) throw new Error("SOLANA_MINT_AUTHORITY_SECRET_KEY required for local faucet");
  const authority = parseSecretKey(raw);
  const conn = connection();
  const owner = new PublicKey(wallet);
  const dest = await getOrCreateAssociatedTokenAccount(conn, authority, usdcMint(), owner);
  const value = units(amount);
  const tx = await mintTo(conn, authority, usdcMint(), dest.address, authority, BigInt(value.toString()));
  const acct = await getAccount(conn, dest.address);
  return {
    wallet,
    tx,
    amount,
    amountUnits: value.toString(),
    balance: formatUnits(acct.amount.toString()),
    balanceUnits: acct.amount.toString(),
  };
}

function formatUnits(raw: string): string {
  const n = BigInt(raw);
  const base = 10n ** BigInt(RACE_DECIMALS);
  return `${n / base}.${(n % base).toString().padStart(RACE_DECIMALS, "0")}`;
}
function requireChainRaceId(round: Round): string {
  if (!round.chainRaceId) throw new Error("round is not open on-chain");
  return round.chainRaceId;
}

// ---- EventPass (port of EventPass.sol) -------------------------------------

function passConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("pass_config")], pid())[0];
}
function passPda(passId: number | bigint | string): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("pass"), leU64(passId)], pid())[0];
}

/** Guard (facilitator) mints an access pass at the auction-settled price. */
export async function mintEventPass(to: string, priceUsdc6: string) {
  const p = program();
  const cfg = await (p.account as any).passConfig.fetch(passConfigPda());
  const passId: BN = cfg.nextId;
  const tx = await (p.methods as any)
    .mintPass(passId, new PublicKey(to), units(priceUsdc6))
    .accounts({
      passConfig: passConfigPda(),
      minter: facilitatorKeypair().publicKey,
      pass: passPda(passId.toString()),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return { id: passId.toString(), to, priceUsdc6, tx };
}

/** holds(who): off-chain getProgramAccounts query (Solana idiom for balanceOf). */
export async function eventPassHolds(owner: string) {
  // Pass layout: discriminator(8) + id(8) + owner(32) -> owner offset = 16.
  const passes = await (program().account as any).pass.all([
    { memcmp: { offset: 16, bytes: owner } },
  ]);
  return {
    owner,
    holds: passes.length > 0,
    count: passes.length,
    passes: passes.map((a: any) => ({
      id: a.account.id.toString(),
      priceUsdc6: a.account.priceUsdc6.toString(),
    })),
  };
}

// ---- Treasury (port of Treasury.sol) ---------------------------------------

function treasuryConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("treasury_config")], pid())[0];
}
function treasuryVaultPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("treasury_vault")], pid())[0];
}
function treasuryAuthPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("treasury_auth")], pid())[0];
}

export async function treasuryBalance() {
  const conn = connection();
  let balanceUnits = "0";
  try {
    const acct = await getAccount(conn, treasuryVaultPda());
    balanceUnits = acct.amount.toString();
  } catch {
    /* vault not yet created */
  }
  return { vault: treasuryVaultPda().toBase58(), balanceUnits, balance: formatUnits(balanceUnits) };
}

/**
 * Build the owner-gated withdrawal instruction for the Ledger to clear-sign.
 * The sidecar never holds the treasury owner key — withdrawal is gated on a
 * physical Ledger Solana signature, mirroring the EVM ERC-7730 flow.
 */
export async function buildTreasuryWithdraw(recipientTokenAccount: string, amount: string) {
  const p = program();
  const cfg = await (p.account as any).treasuryConfig.fetch(treasuryConfigPda());
  const ix = await (p.methods as any)
    .withdrawTreasury(units(amount))
    .accounts({
      treasuryConfig: treasuryConfigPda(),
      owner: new PublicKey(cfg.owner),
      vault: treasuryVaultPda(),
      treasuryAuthority: treasuryAuthPda(),
      recipient: new PublicKey(recipientTokenAccount),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return {
    owner: new PublicKey(cfg.owner).toBase58(),
    amount,
    instruction: {
      programId: ix.programId.toBase58(),
      keys: ix.keys.map((k: any) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
      data: Buffer.from(ix.data).toString("base64"),
    },
  };
}

/**
 * Submit a Ledger-signed Solana transaction (base64 of the fully-signed,
 * serialized tx) and confirm it. Replaces the EVM `broadcastSigned` r,s,v
 * re-serialize step: on Solana the wallet returns a complete signed transaction,
 * so the sidecar only deserializes and forwards it. Pair with
 * `buildTreasuryWithdraw` (which returns the instruction the Ledger signs).
 */
export async function submitSignedSolanaTx(signedTxBase64: string) {
  const conn = connection();
  const raw = Buffer.from(signedTxBase64, "base64");
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
  const bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  return { tx: sig };
}

// ---- AttestationConsumer (port of AttestationConsumer.sol, Chainlink CRE) ---

function attestConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("attest_config")], pid())[0];
}
function attestationPda(jobHash: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("attest"), jobHash], pid())[0];
}
function jobHashOf(job: string): Buffer {
  return createHash("sha256").update(job).digest();
}

/**
 * Land a consensus verdict for a job. In production the Chainlink DON's
 * forwarder signs this; for sim/demo the facilitator reports (allowed when the
 * configured forwarder is the default/zero key).
 */
export async function writeAttestation(job: string, score: number, proofHashHex?: string) {
  const p = program();
  const jh = jobHashOf(job);
  const hex = (proofHashHex ?? "").replace(/^0x/, "");
  const proof = /^[a-fA-F0-9]{64}$/.test(hex)
    ? Array.from(Buffer.from(hex, "hex"))
    : new Array(32).fill(0);
  const tx = await (p.methods as any)
    .writeAttestation(Array.from(jh), job, new BN(score), proof)
    .accounts({
      attestConfig: attestConfigPda(),
      reporter: facilitatorKeypair().publicKey,
      attestation: attestationPda(jh),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return { job, score, verified: score >= 70, tx };
}

export async function getAttestation(job: string) {
  const acct = await (program().account as any).attestation.fetchNullable(attestationPda(jobHashOf(job)));
  if (!acct) return { job, exists: false, verified: false };
  return {
    job,
    exists: true,
    verified: acct.verified,
    score: acct.score.toString(),
    proofHash: Buffer.from(acct.proofHash).toString("hex"),
    timestamp: acct.timestamp.toString(),
  };
}

/** The gate downstream settlement reads (mint/payment/reputation). */
export async function isVerified(job: string): Promise<boolean> {
  return (await getAttestation(job)).verified;
}

// ---- Leaderboard (re-point of leaderboard.ts to the on-chain reputation) ----

function agentPda(agentId: number | bigint | string): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("agent"), leU64(agentId)], pid())[0];
}

/** Rank agents by the clanker5000 reputation accounts (count, then avg). */
export async function agentRanking(limit = 20) {
  const agents = await (program().account as any).agent.all();
  return agents
    .map((a: any) => {
      const count = Number(a.account.count.toString());
      const sum = Number(a.account.sum.toString());
      return {
        agentId: a.account.agentId.toString(),
        owner: a.account.owner.toBase58(),
        jobs: count,
        avgScore: count ? sum / count : null,
      };
    })
    .sort((x: any, y: any) => y.jobs - x.jobs || (y.avgScore ?? 0) - (x.avgScore ?? 0))
    .slice(0, limit);
}

export async function fleetReputation(agentIds: Array<string | number | bigint>) {
  return Promise.all(
    agentIds.map(async (id) => {
      const acct = await (program().account as any).agent.fetchNullable(agentPda(id));
      const count = acct ? Number(acct.count.toString()) : 0;
      const sum = acct ? Number(acct.sum.toString()) : 0;
      return { agentId: id.toString(), jobs: count, avgScore: count ? sum / count : null };
    })
  );
}

// ---- Reputation writes (port of ReputationRegistry.giveFeedback) ------------

/** Register who owns an agent id (first writer wins; the PDA inits once). */
export async function registerAgentOnChain(agentId: number, owner: string) {
  const p = program();
  const tx = await (p.methods as any)
    .registerAgent(new BN(agentId), new PublicKey(owner))
    .accounts({
      agent: agentPda(agentId),
      payer: facilitatorKeypair().publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return { agentId: String(agentId), owner, tx };
}

/**
 * The requester rates an agent after a completed job, tagged by skill, with the
 * Walrus proof URI + hash. Mirrors settle.ts:giveFeedback. The facilitator key
 * is the requester here; it must NOT be the agent owner (program rejects
 * self-feedback), so register the agent owner as a distinct key.
 */
export async function giveFeedbackOnChain(opts: {
  agentId: number;
  score: number;
  skill: string;
  blobId?: string;
  sha256?: string;
}) {
  const p = program();
  const agent = agentPda(opts.agentId);
  const acct = await (p.account as any).agent.fetch(agent);
  const index: BN = acct.count;
  const feedback = PublicKey.findProgramAddressSync(
    [enc.encode("feedback"), agent.toBuffer(), index.toArrayLike(Buffer, "le", 8)],
    pid()
  )[0];
  const hex = (opts.sha256 ?? "").replace(/^0x/, "");
  const feedbackHash = /^[a-fA-F0-9]{64}$/.test(hex)
    ? Array.from(Buffer.from(hex, "hex"))
    : new Array(32).fill(0);
  const tx = await (p.methods as any)
    .giveFeedback(
      new BN(opts.agentId),
      new BN(opts.score),
      0, // value_decimals
      opts.skill.slice(0, 32),
      "starred",
      "", // endpoint
      opts.blobId ? `walrus://${opts.blobId}`.slice(0, 160) : "",
      feedbackHash
    )
    .accounts({
      agent,
      client: facilitatorKeypair().publicKey,
      feedback,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return { agentId: String(opts.agentId), score: opts.score, tx };
}

export async function repSummaryOnChain(agentId: number) {
  const acct = await (program().account as any).agent.fetchNullable(agentPda(agentId));
  const count = acct ? Number(acct.count.toString()) : 0;
  const sum = acct ? Number(acct.sum.toString()) : 0;
  return { count, avg: count ? sum / count : 0 };
}

// ---- Parimutuel market (port of RaceMarket.sol) ----------------------------

function marketPda(marketId: number | bigint | string): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("market"), leU64(marketId)], pid())[0];
}
function marketVaultPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("market_vault"), market.toBuffer()], pid())[0];
}
function marketVaultAuthPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("market_vault_auth"), market.toBuffer()], pid())[0];
}
function betPda(market: PublicKey, bettor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode("bet"), market.toBuffer(), bettor.toBuffer()],
    pid()
  )[0];
}
function nullifierPda(market: PublicKey, nullifier32: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode("nullifier"), market.toBuffer(), nullifier32],
    pid()
  )[0];
}

/** World ID nullifier_hash (a 0x… field element) -> 32 LE bytes for the PDA seed. */
function nullifierBytes(nullifier: string): Buffer {
  return new BN(nullifier.replace(/^0x/, ""), nullifier.startsWith("0x") ? 16 : 10)
    .toArrayLike(Buffer, "le", 32);
}

/** Facilitator (judge) opens a parimutuel market. Returns the marketId. */
export async function openMarketOnChain(numRacers = 2) {
  const p = program();
  // Derive the next market id from existing market accounts (the program keys
  // markets by caller-supplied id; we use a monotonic count).
  const existing = await (p.account as any).market.all();
  const marketId = existing.length;
  const market = marketPda(marketId);
  const fac = facilitatorKeypair().publicKey;
  const tx = await (p.methods as any)
    .openMarket(new BN(marketId), numRacers, fac)
    .accounts({
      market,
      judge: fac,
      vault: marketVaultPda(market),
      marketVaultAuthority: marketVaultAuthPda(market),
      usdcMint: usdcMint(),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  return { raceId: marketId, marketId, tx };
}

/**
 * Place a parimutuel bet. The Solana program enforces one-bet-per-bettor (a
 * `bet` PDA seeded by the bettor) and one-human-one-bet (a `nullifier` PDA), so
 * — unlike the EVM relayer that staked every bet from one treasury wallet — the
 * bettor must sign. Production: the human's phone wallet signs the instruction.
 * Local/dev: the bettor keypair is loaded from SOLANA_DEV_KEYS_DIR (same model
 * as join_race). `bettorWallet` defaults to the World-ID-bound dev wallet.
 */
export async function placeBetOnChain(
  marketId: number,
  racerIdx: number,
  amountUsdc: string,
  nullifier: string,
  bettorWallet?: string
) {
  const p = program();
  const market = marketPda(marketId);
  const signer = bettorWallet ? driverKeypair(bettorWallet) : null;
  if (!signer) {
    throw new Error(
      "Solana place_bet must be signed by the bettor wallet (one-bet-per-bettor PDA); " +
        "submit the human's signed instruction, or set SOLANA_DEV_KEYS_DIR + bettorWallet for local dev"
    );
  }
  const null32 = nullifierBytes(nullifier);
  const tx = await (p.methods as any)
    .placeBet(new BN(marketId), racerIdx, units(amountUsdc), Array.from(null32))
    .accounts({
      market,
      bettor: signer.publicKey,
      bettorToken: ata(signer.publicKey),
      vault: marketVaultPda(market),
      bet: betPda(market, signer.publicKey),
      nullifier: nullifierPda(market, null32),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([signer])
    .rpc();
  return { tx };
}

/** Judge settles the market with the Gemini-verified finish proof. */
export async function settleMarketOnChain(
  marketId: number,
  winnerIdx: number,
  sha256: string,
  blobId: string
) {
  const p = program();
  const hex = (sha256 || "").replace(/^0x/, "");
  const proof = /^[a-fA-F0-9]{64}$/.test(hex)
    ? Array.from(Buffer.from(hex, "hex"))
    : new Array(32).fill(0);
  const tx = await (p.methods as any)
    .settleMarket(new BN(marketId), winnerIdx, proof, (blobId || "").slice(0, 64))
    .accounts({
      market: marketPda(marketId),
      judge: facilitatorKeypair().publicKey,
    })
    .preInstructions(await priorityPreInstructions(null, solanaChainConfig().cluster))
    .rpc();
  return { tx };
}

// ---- USDC payments (port of the Arc ERC-20 transfer in settle.ts) -----------

/** SPL-USDC (6dp) balance of a wallet's associated token account. */
export async function usdcBalanceOf(wallet: string): Promise<bigint> {
  try {
    const acct = await getAccount(connection(), ata(new PublicKey(wallet)));
    return acct.amount;
  } catch {
    return 0n;
  }
}

/**
 * Transfer the negotiated USDC from one fleet wallet to another (the native
 * equivalent of settle.ts:pay's Arc ERC-20 transfer). Signed by the `from`
 * wallet's keypair (loaded from SOLANA_DEV_KEYS_DIR) or, when `from` is the
 * facilitator, by the facilitator key. Gas is SOL (not USDC-as-gas).
 */
export async function payOnChain(from: string, to: string, amountUsdc: string) {
  const t0 = Date.now();
  const conn = connection();
  const fac = facilitatorKeypair();
  const fromKp = from === fac.publicKey.toBase58() ? fac : driverKeypair(from);
  if (!fromKp) {
    throw new Error(`no Solana keypair for '${from}' (set SOLANA_DEV_KEYS_DIR or sign client-side)`);
  }
  const toPk = new PublicKey(to);
  const dest = await getOrCreateAssociatedTokenAccount(conn, fromKp, usdcMint(), toPk);
  const value = units(amountUsdc);
  const tx = await transfer(
    conn,
    fromKp,
    ata(fromKp.publicKey),
    dest.address,
    fromKp,
    BigInt(value.toString())
  );
  return { tx, status: "success" as const, from, to, amountUsdc, ms: Date.now() - t0 };
}

// ─── Solana Actions / Blinks: unsigned-transaction builders ──────────────────
// A Blink client (wallet / dial.to) POSTs {account} and expects a base64 unsigned
// transaction back to sign. These wrap existing instruction-building in a v0 tx.

/** Compile instructions into a base64-serialized unsigned v0 transaction. */
export async function buildUnsignedTransaction(
  instructions: TransactionInstruction[],
  feePayer: PublicKey,
): Promise<string> {
  const conn = connection();
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  return Buffer.from(tx.serialize()).toString("base64");
}

/** Raw SPL-USDC transfer from an owner's ATA to a destination token account. */
export function buildSplTransferInstruction(
  owner: PublicKey,
  destTokenAccount: PublicKey,
  amountUsdc: string,
): TransactionInstruction {
  return createTransferInstruction(
    ata(owner),
    destTokenAccount,
    owner,
    BigInt(units(amountUsdc).toString()),
    [],
    TOKEN_PROGRAM_ID,
  );
}

/** Tip the fleet treasury — account-only USDC transfer (the clean Blink path). */
export async function buildActionTipTx(account: string, amountUsdc: string): Promise<string> {
  const payer = new PublicKey(account);
  const ix = buildSplTransferInstruction(payer, treasuryVaultPda(), amountUsdc);
  return buildUnsignedTransaction([ix], payer);
}

/** Unsigned `place_bet` instruction — mirrors placeBetOnChain but returns the ix. */
export async function buildPlaceBetInstruction(
  marketId: number,
  racerIdx: number,
  amountUsdc: string,
  nullifier: string,
  bettor: PublicKey,
): Promise<TransactionInstruction> {
  const p = program();
  const market = marketPda(marketId);
  const null32 = nullifierBytes(nullifier);
  return await (p.methods as any)
    .placeBet(new BN(marketId), racerIdx, units(amountUsdc), Array.from(null32))
    .accounts({
      market,
      bettor,
      bettorToken: ata(bettor),
      vault: marketVaultPda(market),
      bet: betPda(market, bettor),
      nullifier: nullifierPda(market, null32),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** Bet Action — requires a World-ID-verified nullifier (wallet Blinks can't mint one). */
export async function buildActionBetTx(
  account: string,
  marketId: number,
  racerIdx: number,
  amountUsdc: string,
  nullifier: string,
): Promise<string> {
  const bettor = new PublicKey(account);
  const ix = await buildPlaceBetInstruction(marketId, racerIdx, amountUsdc, nullifier, bettor);
  return buildUnsignedTransaction([ix], bettor);
}

/** Treasury USDC token account (tip destination), base58. */
export function treasuryVaultAddress(): string {
  return treasuryVaultPda().toBase58();
}
