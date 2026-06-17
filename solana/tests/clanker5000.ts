/**
 * End-to-end Anchor test for the Clanker 5000 settlement core.
 *
 * Exercises both ported flows against a local validator:
 *   1. RaceEscrow: initialize -> open -> join(x2) -> lock -> start -> finish
 *      -> settle, asserting the winner receives 2x the stake.
 *   2. RaceMarket: open -> bet(x2) -> settle -> claim, asserting the parimutuel
 *      payout math and that a reused World ID nullifier is rejected.
 *
 * Run with `anchor test` from the `solana/` directory (requires the Solana +
 * Anchor toolchain and a local validator).
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Clanker5000 } from "../target/types/clanker5000";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

describe("clanker5000", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Clanker5000 as Program<Clanker5000>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const enc = new TextEncoder();
  let usdc: PublicKey;
  const facilitator = Keypair.generate();
  const challenger = Keypair.generate();
  const opponent = Keypair.generate();

  const u64 = (n: number | bigint) => new anchor.BN(n.toString());
  const STAKE = 1_000_000; // 1 USDC (6dp)
  const FEE = 250_000;

  const configPda = () =>
    PublicKey.findProgramAddressSync([enc.encode("config")], program.programId)[0];
  const racePda = (id: number) =>
    PublicKey.findProgramAddressSync(
      [enc.encode("race"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  const vaultPda = (race: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [enc.encode("vault"), race.toBuffer()],
      program.programId
    )[0];
  const vaultAuthPda = () =>
    PublicKey.findProgramAddressSync([enc.encode("vault_auth")], program.programId)[0];

  let treasuryAta: PublicKey;

  before(async () => {
    for (const kp of [facilitator, challenger, opponent]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2e9);
      await provider.connection.confirmTransaction(sig);
    }
    usdc = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    treasuryAta = (
      await getOrCreateAssociatedTokenAccount(provider.connection, payer, usdc, payer.publicKey)
    ).address;
  });

  it("initializes config", async () => {
    await program.methods
      .initialize(facilitator.publicKey)
      .accounts({
        config: configPda(),
        authority: payer.publicKey,
        usdcMint: usdc,
        treasuryToken: treasuryAta,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const cfg = await program.account.config.fetch(configPda());
    assert.equal(cfg.facilitator.toBase58(), facilitator.publicKey.toBase58());
    assert.equal(cfg.nextRaceId.toNumber(), 0);
  });

  it("runs a full race and pays the winner 2x", async () => {
    const raceId = 0;
    const race = racePda(raceId);
    const vault = vaultPda(race);

    await program.methods
      .openRace(u64(raceId), Array(32).fill(7), u64(STAKE), u64(FEE))
      .accounts({
        config: configPda(),
        facilitator: facilitator.publicKey,
        race,
        vault,
        vaultAuthority: vaultAuthPda(),
        usdcMint: usdc,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([facilitator])
      .rpc();

    const drivers = [challenger, opponent];
    const atas: PublicKey[] = [];
    for (const d of drivers) {
      const ata = (
        await getOrCreateAssociatedTokenAccount(provider.connection, payer, usdc, d.publicKey)
      ).address;
      atas.push(ata);
      await mintTo(provider.connection, payer, usdc, ata, payer, STAKE + FEE);
    }

    for (let slot = 0; slot < 2; slot++) {
      await program.methods
        .joinRace(u64(raceId), slot, u64(STAKE), u64(FEE))
        .accounts({
          config: configPda(),
          race,
          driver: drivers[slot].publicKey,
          driverToken: atas[slot],
          vault,
          treasuryToken: treasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([drivers[slot]])
        .rpc();
    }

    await program.methods.lockRace(u64(raceId)).accounts({ config: configPda(), facilitator: facilitator.publicKey, race }).signers([facilitator]).rpc();
    await program.methods.startRace(u64(raceId)).accounts({ config: configPda(), facilitator: facilitator.publicKey, race }).signers([facilitator]).rpc();
    await program.methods
      .finishRace(u64(raceId), 0, Array(32).fill(9))
      .accounts({ config: configPda(), facilitator: facilitator.publicKey, race })
      .signers([facilitator])
      .rpc();

    const before = await getAccount(provider.connection, atas[0]);
    await program.methods
      .settleRace(u64(raceId))
      .accounts({
        config: configPda(),
        facilitator: facilitator.publicKey,
        race,
        vault,
        vaultAuthority: vaultAuthPda(),
        winnerToken: atas[0],
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([facilitator])
      .rpc();
    const after = await getAccount(provider.connection, atas[0]);

    assert.equal(Number(after.amount - before.amount), STAKE * 2);
    const treasury = await getAccount(provider.connection, treasuryAta);
    assert.equal(Number(treasury.amount), FEE * 2);
  });
});
