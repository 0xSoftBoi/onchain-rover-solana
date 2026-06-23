/**
 * Integration tests for the $CLANK token engine (docs/TOKEN_PROGRAM_SPEC.md),
 * exercised against a local validator — same harness as `clanker5000.ts`.
 *
 *   1. Staking: init_stake_pool -> stake -> fund_staker_bucket ->
 *      claim_staking_yield, asserting the single staker receives the full USDC
 *      yield (the MasterChef acc_usdc_per_share path + PDA-signed payout).
 *   2. Emissions: the anti-gaming chain — register_agent -> init_attestation ->
 *      write_attestation(score>=70) -> give_feedback (requester, not self) ->
 *      init_token -> bond_operator -> accrue_emissions, asserting $CLANK is
 *      minted to the operator only when every proof link holds.
 *
 * Run with `anchor test` (requires an anchor-cli matching the installed native
 * toolchain). NOTE: the emissions suite initializes the singleton `config` PDA
 * with its own facilitator; if combined on one validator with `clanker5000.ts`
 * (which also inits `config`), run this file against a fresh validator.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Clanker5000 } from "../target/types/clanker5000";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  setAuthority,
  AuthorityType,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

describe("clanker5000 — $CLANK token engine", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Clanker5000 as Program<Clanker5000>;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const enc = new TextEncoder();
  const u64 = (n: number | bigint) => new anchor.BN(n.toString());
  const le8 = (n: number) => new anchor.BN(n).toArrayLike(Buffer, "le", 8);
  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  const airdrop = async (kp: Keypair) => {
    const sig = await provider.connection.requestAirdrop(kp.publicKey, 2e9);
    await provider.connection.confirmTransaction(sig);
  };
  const bal = async (ata: PublicKey) =>
    Number((await getAccount(provider.connection, ata)).amount);

  // ---- staking ------------------------------------------------------------
  describe("staking yields real USDC", () => {
    const stakePool = pda([enc.encode("stake_pool")]);
    const stakeVault = pda([enc.encode("stake_vault")]);
    const yieldVault = pda([enc.encode("yield_vault")]);
    const stakeVaultAuthority = pda([enc.encode("stake_vault_auth")]);
    const staker = Keypair.generate();
    const stakeAccount = pda([enc.encode("stake"), staker.publicKey.toBuffer()]);

    let clank: PublicKey, usdc: PublicKey;
    let stakerClank: PublicKey, stakerUsdc: PublicKey, payerUsdc: PublicKey;
    const STAKE_AMT = 1_000_000_000; // 1 CLANK (9dp)
    const YIELD_AMT = 500_000; // 0.5 USDC (6dp)

    before(async () => {
      await airdrop(staker);
      clank = await createMint(provider.connection, payer, payer.publicKey, null, 9);
      usdc = await createMint(provider.connection, payer, payer.publicKey, null, 6);
      stakerClank = (
        await getOrCreateAssociatedTokenAccount(provider.connection, payer, clank, staker.publicKey)
      ).address;
      stakerUsdc = (
        await getOrCreateAssociatedTokenAccount(provider.connection, payer, usdc, staker.publicKey)
      ).address;
      payerUsdc = (
        await getOrCreateAssociatedTokenAccount(provider.connection, payer, usdc, payer.publicKey)
      ).address;
      await mintTo(provider.connection, payer, clank, stakerClank, payer, STAKE_AMT);
      await mintTo(provider.connection, payer, usdc, payerUsdc, payer, YIELD_AMT);
    });

    it("init -> stake -> fund -> claim pays the staker the full yield", async () => {
      await program.methods
        .initStakePool(u64(0)) // cooldown 0 for the test
        .accountsStrict({
          stakePool,
          payer: payer.publicKey,
          stakeVault,
          yieldVault,
          stakeVaultAuthority,
          clankMint: clank,
          usdcMint: usdc,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      await program.methods
        .stake(u64(STAKE_AMT))
        .accountsStrict({
          stakePool,
          staker: staker.publicKey,
          stakerClank,
          stakeVault,
          stakeAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([staker])
        .rpc();

      // fund the 30%-of-fees yield bucket
      await program.methods
        .fundStakerBucket(u64(YIELD_AMT))
        .accountsStrict({
          stakePool,
          funder: payer.publicKey,
          funderUsdc: payerUsdc,
          yieldVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const before = await bal(stakerUsdc);
      await program.methods
        .claimStakingYield()
        .accountsStrict({
          stakePool,
          staker: staker.publicKey,
          stakerUsdc,
          yieldVault,
          stakeVaultAuthority,
          stakeAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([staker])
        .rpc();

      // sole staker collects the entire funded yield
      assert.equal((await bal(stakerUsdc)) - before, YIELD_AMT);
    });
  });

  // ---- emissions ----------------------------------------------------------
  describe("emissions require verified work", () => {
    const facilitator = Keypair.generate();
    const operator = Keypair.generate();
    const requester = Keypair.generate();
    const AGENT_ID = 42;
    const JOB = Array(32).fill(9);

    const configPda = pda([enc.encode("config")]);
    const tokenConfig = pda([enc.encode("token_config")]);
    const epoch0 = pda([enc.encode("epoch"), le8(0)]);
    const clankMintAuth = pda([enc.encode("clank_mint_auth")]);
    const agent = pda([enc.encode("agent"), le8(AGENT_ID)]);
    const attestConfig = pda([enc.encode("attest_config")]);
    const attestation = pda([enc.encode("attest"), Buffer.from(JOB)]);
    const feedback = pda([enc.encode("feedback"), agent.toBuffer(), le8(0)]);
    const opBond = pda([enc.encode("op_bond"), agent.toBuffer()]);
    const bondVault = pda([enc.encode("bond_vault"), agent.toBuffer()]);
    const bondAuthority = pda([enc.encode("bond_auth")]);
    const jobClaim = pda([enc.encode("job_claim"), agent.toBuffer(), Buffer.from(JOB)]);

    const REWARD_PER_JOB = 200_000_000; // 0.2 CLANK base
    const MIN_BOND = 100;
    const BOND = 1_000_000_000; // 1 CLANK
    let clank: PublicKey, usdc: PublicKey;
    let operatorClank: PublicKey, treasuryUsdc: PublicKey;

    before(async () => {
      for (const kp of [facilitator, operator, requester]) await airdrop(kp);
      // CLANK mint: seed the operator's bond, THEN hand mint authority to the PDA
      clank = await createMint(provider.connection, payer, payer.publicKey, null, 9);
      usdc = await createMint(provider.connection, payer, payer.publicKey, null, 6);
      operatorClank = (
        await getOrCreateAssociatedTokenAccount(provider.connection, payer, clank, operator.publicKey)
      ).address;
      treasuryUsdc = (
        await getOrCreateAssociatedTokenAccount(provider.connection, payer, usdc, payer.publicKey)
      ).address;
      await mintTo(provider.connection, payer, clank, operatorClank, payer, BOND);
      await setAuthority(
        provider.connection, payer, clank, payer, AuthorityType.MintTokens, clankMintAuth
      );
    });

    it("mints $CLANK only after a verified, requester-rated job", async () => {
      // config is a singleton PDA; init it if fresh, then ensure OUR facilitator
      // is set (both possible via the shared provider wallet = config.authority).
      try {
        await program.methods
          .initialize(facilitator.publicKey)
          .accountsStrict({
            config: configPda,
            authority: payer.publicKey,
            usdcMint: usdc,
            treasuryToken: treasuryUsdc,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch {
        /* already initialized by another suite on this validator */
      }
      await program.methods
        .setFacilitator(facilitator.publicKey)
        .accountsStrict({ config: configPda, authority: payer.publicKey })
        .rpc();

      await program.methods
        .registerAgent(u64(AGENT_ID), operator.publicKey)
        .accountsStrict({ agent, payer: payer.publicKey, systemProgram: SystemProgram.programId })
        .rpc();

      // 1) oracle verdict (score >= 70), reported by the forwarder=facilitator
      await program.methods
        .initAttestation(facilitator.publicKey)
        .accountsStrict({ attestConfig, owner: payer.publicKey, systemProgram: SystemProgram.programId })
        .rpc();
      await program.methods
        .writeAttestation(JOB, "deliver", u64(80), JOB)
        .accountsStrict({
          attestConfig,
          reporter: facilitator.publicKey,
          attestation,
          systemProgram: SystemProgram.programId,
        })
        .signers([facilitator])
        .rpc();

      // 2) requester feedback (client != agent.owner — not self-feedback)
      await program.methods
        .giveFeedback(u64(AGENT_ID), u64(100), 0, "guard", "", "http://x", "rate", JOB)
        .accountsStrict({
          agent,
          client: requester.publicKey,
          feedback,
          systemProgram: SystemProgram.programId,
        })
        .signers([requester])
        .rpc();

      // 3) token engine + operator bond
      await program.methods
        .initToken(u64(1_000_000_000_000), u64(REWARD_PER_JOB), u64(86_400), u64(65), u64(100), u64(MIN_BOND))
        .accountsStrict({
          tokenConfig,
          epoch: epoch0,
          authority: payer.publicKey,
          clankMint: clank,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await program.methods
        .bondOperator(u64(AGENT_ID), u64(BOND))
        .accountsStrict({
          tokenConfig,
          agent,
          owner: operator.publicKey,
          ownerClank: operatorClank,
          bondVault,
          bondAuthority,
          operatorBond: opBond,
          clankMint: clank,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([operator])
        .rpc();

      // 4) accrue — the only path that mints $CLANK
      const before = await bal(operatorClank);
      await program.methods
        .accrueEmissions(u64(AGENT_ID), JOB)
        .accountsStrict({
          tokenConfig,
          epoch: epoch0,
          config: configPda,
          facilitator: facilitator.publicKey,
          agent,
          operatorBond: opBond,
          attestation,
          feedback,
          clankMint: clank,
          mintAuthority: clankMintAuth,
          operatorClank,
          jobClaim,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([facilitator])
        .rpc();

      // base 0.2 CLANK + 25% stake bonus (bond 1 CLANK vs min 100) = 0.25 CLANK
      const minted = (await bal(operatorClank)) - before;
      assert.equal(minted, REWARD_PER_JOB * 1.25);

      // a second accrual for the same job must fail (JobClaim PDA already exists)
      let reused = false;
      try {
        await program.methods
          .accrueEmissions(u64(AGENT_ID), JOB)
          .accountsStrict({
            tokenConfig, epoch: epoch0, config: configPda, facilitator: facilitator.publicKey,
            agent, operatorBond: opBond, attestation, feedback, clankMint: clank,
            mintAuthority: clankMintAuth, operatorClank, jobClaim,
            tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          })
          .signers([facilitator])
          .rpc();
      } catch {
        reused = true;
      }
      assert.isTrue(reused, "double-claim of the same job must be rejected");
    });
  });
});
