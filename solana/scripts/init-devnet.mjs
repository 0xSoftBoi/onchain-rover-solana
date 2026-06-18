/**
 * One-time on-chain bootstrap for the deployed clanker5000 program on devnet.
 *
 * Creates a devnet USDC mint, runs every one-time init instruction
 * (initialize / init_treasury / init_event_pass / init_attestation), registers
 * the two fleet agents and seeds a reputation feedback (so the Leaderboard shows
 * real data), then writes sidecar/src/generated/contracts.solana.json.
 *
 * Run:  cd solana && node scripts/init-devnet.mjs
 * Needs: ~/.config/solana/id.json funded on devnet (the deployer = facilitator).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const RPC = process.env.SOLANA_RPC_URL
  ?? "https://devnet.helius-rpc.com/?api-key=e91e890f-f668-43a3-9d9f-39122e323e50";
const enc = new TextEncoder();
const OUT_PATH = new URL("../../sidecar/src/generated/contracts.solana.json", import.meta.url);

const idl = JSON.parse(fs.readFileSync(new URL("../target/idl/clanker5000.json", import.meta.url), "utf8"));
const PROGRAM_ID = new PublicKey(idl.address);

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))),
);
const conn = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const leU64 = (n) => new BN(n).toArrayLike(Buffer, "le", 8);
const configPda = pda([enc.encode("config")]);
const treasuryConfigPda = pda([enc.encode("treasury_config")]);
const treasuryVaultPda = pda([enc.encode("treasury_vault")]);
const treasuryAuthPda = pda([enc.encode("treasury_auth")]);
const treasuryConfigVault = treasuryVaultPda;
const passConfigPda = pda([enc.encode("pass_config")]);
const attestConfigPda = pda([enc.encode("attest_config")]);
const agentPda = (id) => pda([enc.encode("agent"), leU64(id)]);
const feedbackPda = (agent, idx) => pda([enc.encode("feedback"), agent.toBuffer(), leU64(idx)]);

async function step(name, fn) {
  try {
    const sig = await fn();
    console.log(`✓ ${name}${sig ? `  ${sig}` : ""}`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/already in use|already been processed|custom program error: 0x0\b/.test(msg)) {
      console.log(`• ${name} (already done)`);
    } else {
      console.log(`✗ ${name}: ${msg.split("\n")[0]}`);
    }
  }
}

console.log(`deployer/facilitator: ${deployer.publicKey.toBase58()}`);
console.log(`program: ${PROGRAM_ID.toBase58()}\n`);

// 1. USDC mint (6dp) + the fee-treasury token account (deployer's ATA).
// Idempotent: reuse the mint/treasury already recorded in contracts.solana.json
// (the program's config is locked to the first mint — never create a second).
let mint, treasuryAta;
const existing = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, "utf8")) : null;
if (existing?.usdcMint && existing?.treasury) {
  mint = new PublicKey(existing.usdcMint);
  treasuryAta = new PublicKey(existing.treasury);
  console.log(`• reusing mint ${mint.toBase58()} + treasury ${treasuryAta.toBase58()}`);
} else {
  await step("create USDC mint (6dp)", async () => {
    mint = await createMint(conn, deployer, deployer.publicKey, null, 6);
    return mint.toBase58();
  });
  await step("create treasury USDC ATA + mint 1000 test USDC", async () => {
    const ata = await getOrCreateAssociatedTokenAccount(conn, deployer, mint, deployer.publicKey);
    treasuryAta = ata.address;
    await mintTo(conn, deployer, mint, treasuryAta, deployer, 1_000_000_000n); // 1000 USDC
    return treasuryAta.toBase58();
  });
}

// 2. initialize config (facilitator = deployer).
await step("initialize (config)", () =>
  program.methods.initialize(deployer.publicKey).accounts({
    config: configPda,
    authority: deployer.publicKey,
    usdcMint: mint,
    treasuryToken: treasuryAta,
    systemProgram: SystemProgram.programId,
  }).rpc());

// 3. init_treasury (owner = deployer; PDA USDC vault).
await step("init_treasury", () =>
  program.methods.initTreasury(deployer.publicKey).accounts({
    treasuryConfig: treasuryConfigPda,
    payer: deployer.publicKey,
    vault: treasuryConfigVault,
    treasuryAuthority: treasuryAuthPda,
    usdcMint: mint,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  }).rpc());

// 4. init_event_pass (minter = deployer).
await step("init_event_pass", () =>
  program.methods.initEventPass(deployer.publicKey).accounts({
    passConfig: passConfigPda,
    payer: deployer.publicKey,
    systemProgram: SystemProgram.programId,
  }).rpc());

// 5. init_attestation (forwarder = deployer; must be non-default).
await step("init_attestation", () =>
  program.methods.initAttestation(deployer.publicKey).accounts({
    attestConfig: attestConfigPda,
    owner: deployer.publicKey,
    systemProgram: SystemProgram.programId,
  }).rpc());

// 6. Register the two fleet agents (owners distinct from the facilitator so
//    give_feedback — which rejects self-feedback — works).
const guardOwner = Keypair.generate().publicKey;
const courierOwner = Keypair.generate().publicKey;
await step("register_agent 0 (guard)", () =>
  program.methods.registerAgent(new BN(0), guardOwner).accounts({
    agent: agentPda(0), payer: deployer.publicKey, systemProgram: SystemProgram.programId,
  }).rpc());
await step("register_agent 1 (courier)", () =>
  program.methods.registerAgent(new BN(1), courierOwner).accounts({
    agent: agentPda(1), payer: deployer.publicKey, systemProgram: SystemProgram.programId,
  }).rpc());

// 7. Seed a couple of feedbacks (client = deployer != agent owner) so the
//    Leaderboard renders real data.
for (const [agentId, score] of [[0, 92], [1, 78]]) {
  await step(`give_feedback agent ${agentId} (score ${score})`, async () => {
    const agent = agentPda(agentId);
    const acct = await program.account.agent.fetch(agent);
    const idx = acct.count;
    return program.methods
      .giveFeedback(new BN(agentId), new BN(score), 0, "delivery", "starred", "", "", new Array(32).fill(0))
      .accounts({ agent, client: deployer.publicKey, feedback: feedbackPda(agent, idx), systemProgram: SystemProgram.programId })
      .rpc();
  });
}

// 8. Write the sidecar deployment config.
const out = {
  cluster: "devnet",
  rpcUrl: "https://api.devnet.solana.com",
  programId: PROGRAM_ID.toBase58(),
  usdcMint: mint.toBase58(),
  facilitator: deployer.publicKey.toBase58(),
  treasury: treasuryAta.toBase58(),
  defaults: { stakeUnits: "1000000", feeUnits: "250000" },
};
const outPath = new URL("../../sidecar/src/generated/contracts.solana.json", import.meta.url);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`\n✓ wrote contracts.solana.json:\n${JSON.stringify(out, null, 2)}`);
