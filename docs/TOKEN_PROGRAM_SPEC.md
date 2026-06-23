# $CLANK token program spec — additive instructions for `clanker5000`

Engineering spec that turns [`TOKENOMICS.md`](../TOKENOMICS.md) into concrete Anchor
code. **Everything here is additive** — it extends the existing `clanker5000`
program (Anchor 0.31, Agave 4.0.3) without touching the shipped race / market /
reputation / pass / treasury / attestation instructions. Nothing goes live until the
genesis event (§7 of the tokenomics doc); until then this is dormant code behind the
points season.

Grounded in the program's existing conventions: `CONFIG_SEED = b"config"`,
`VAULT_SEED`/`VAULT_AUTH_SEED`, per-entity PDA USDC vaults with a PDA authority +
`invoke_signed` CPI, `#[account] #[derive(InitSpace)]`, `ctx.bumps.*`, u128 math for
payouts, and `Config.total_fees_collected` as the live revenue meter.

---

## 1. The mint: classic SPL, not Token-2022

**Recommendation: a classic SPL mint for $CLANK.** The token's thesis explicitly
includes being **CEX-listable and wallet-universal** (TOKENOMICS §15); classic SPL is
the maximally-compatible choice and every venue/MM/DEX handles it without caveats.

Token-2022 was considered for an automatic transfer-fee or a transfer-hook
"burn-on-use." Rejected because:

- A **transfer-hook runs on *every* transfer** and can't cleanly express "burn X%
  *only* on premium actions" — that logic belongs in the specific consuming
  instructions, not on all CLANK movement.
- Token-2022 support across CEXs/MMs is still uneven in 2026; for a token whose value
  case depends on listability, that's an avoidable tail.

**Burn-on-use is therefore explicit**: the instructions that consume CLANK
(`mint_pass` when paid in CLANK, priority-dispatch, reputation-boost) call
`token::burn` for the burn share and route the rest. No magic — auditable burns at
the call site.

- **Supply:** fixed **1,000,000,000** (9 decimals). Genesis buckets (§6) minted once
  at `init_token` into vesting escrows; the emission bucket is minted *only* by
  `accrue_emissions` under the epoch cap. After genesis, **mint authority is a PDA
  the program controls** — no human can mint.
- **Mint authority PDA:** `seeds = [b"clank_mint_auth"]`. **Freeze authority: none**
  (set to `None` at init — a freezable token is a listing and trust liability).

---

## 2. New state (PDAs)

| Account | Seeds | Purpose |
|---|---|---|
| `TokenConfig` | `[b"token_config"]` | clank_mint, mint_auth_bump, fee-split (buyback/staker/ops bps), emission params, cumulative_minted, current_epoch, pf_band, governance authority. |
| `EmissionEpoch` | `[b"epoch", epoch_u64]` | `cap`, `minted`, `reward_per_job`, `start_ts`. Roll creates the next at `prior.cap × decay`. |
| `StakePool` | `[b"stake_pool"]` | `total_staked`, `acc_usdc_per_share` (1e12-scaled), `last_update`, `staker_bucket_balance`. |
| `StakeAccount` | `[b"stake", owner]` | `amount`, `role` (Plain/Verifier/Operator), `reward_debt`, `staked_at`, `unstake_ready_at`. |
| `OperatorBond` | `[b"op_bond", agent (Agent PDA)]` | `bonded`, `slashed`, links a bond to an `Agent` identity; gates emissions. |
| `VerifierBond` | `[b"vf_bond", verifier]` | bond for a forwarder/judge; slashable on disputed verdict. |
| `PitFund` | `[b"pit_fund"]` | `usdc_intake`, `clank_bought`, `clank_burned`, `last_buyback_ts`, `min_out_bps`, `max_pct_adv`. |
| CLANK vaults | `[b"clank_vault", purpose]` | program-owned CLANK token accounts (stake vault, pit-fund holding) under a vault-authority PDA, mirroring the existing USDC `VAULT_AUTH_SEED` pattern. |

`TokenConfig` is the new sibling of the existing `Config`; it does **not** modify
`Config` (avoids a migration of the live account).

---

## 3. New instructions

| Instruction | Gate | Does |
|---|---|---|
| `init_token(params)` | authority (one-time) | create `TokenConfig`, set mint authority to PDA, mint genesis buckets to vesting escrows, open epoch 0. |
| `stake(amount, role)` | signer | CPI CLANK → stake vault; settle pool; set `unstake_ready_at` cooldown on later unstake. |
| `unstake(amount)` | signer, after cooldown | settle pending yield, CPI CLANK back. |
| `claim_staking_yield()` | signer | pay USDC from staker bucket pro-rata via `acc_usdc_per_share`. |
| `fund_staker_bucket(amount)` | facilitator | route the **30% staker split** of fees (USDC) into `StakePool.staker_bucket_balance`, bump `acc_usdc_per_share`. |
| `bond_operator(agent_id, amount)` | agent owner | lock CLANK against an `Agent`; required ≥ `min_operator_bond` to earn emissions. |
| `accrue_emissions(agent_id, attestation, feedback)` | facilitator/keeper | **the work-emissions hook — see §4.** mint CLANK to the operator for one *verified* job, clamped to epoch cap. |
| `roll_epoch()` | permissionless after `start_ts + epoch_len` | finalize epoch, open next at `cap × decay`. |
| `request_buyback(max_usdc, min_clank_out)` | keeper, value-aware | release Pit-Fund USDC to the swap executor under slippage + %-ADV caps — **see §5.** |
| `settle_buyback(clank_in, burn_bps)` | keeper | record bought CLANK; burn `burn_bps`, route remainder to stakers or treasury per policy. |
| `slash(target_bond, amount, reason)` | dispute-resolver, after window | reduce a bond; burn or send to an insurance vault. |
| `set_fee_split / set_emission_params / set_pf_band / set_governance` | governance | tune the §11 open parameters. |

---

## 4. The emissions hook (the anti-gaming core)

Emissions exist *only* for cryptographically-verified physical work. The instruction
reads the already-shipped `Attestation` and `Feedback` PDAs and refuses to mint
otherwise — proof-of-physical-work enforced by the oracle, not self-reported.

```rust
pub fn accrue_emissions(ctx: Context<AccrueEmissions>, agent_id: u64) -> Result<()> {
    let att = &ctx.accounts.attestation;     // existing Attestation PDA
    let fb  = &ctx.accounts.feedback;         // existing Feedback PDA (requester-written)
    let ep  = &mut ctx.accounts.epoch;
    let bond = &ctx.accounts.operator_bond;
    let agent = &ctx.accounts.agent;          // existing Agent PDA (running rep avg)

    // 1. Proof-of-physical-work: oracle-verified, score >= 70.
    require!(att.verified && att.score >= 70, ClankError::NotVerified);
    // 2. Real demand: a REQUESTER wrote feedback, and it is not self-feedback
    //    (the program already rejects self-feedback in give_feedback).
    require!(fb.agent == agent.key() && fb.client != agent.owner, ClankError::NoFeedback);
    // 3. Skin in the game: operator is bonded.
    require!(bond.bonded >= ctx.accounts.token_config.min_operator_bond, ClankError::Unbonded);
    // 4. One accrual per job: the per-job claim PDA `init`s once (collision = double-claim fail).

    // reward = reward_per_job × reputation_weight × stake_weight, clamped to cap.
    let rep_w = reputation_weight(agent.sum, agent.count);    // 0..1.25, skill/quality
    let stk_w = stake_weight(bond.bonded);                    // diminishing returns
    let gross = (ep.reward_per_job as u128) * rep_w / SCALE * stk_w / SCALE;
    let remaining = ep.cap.saturating_sub(ep.minted);
    let reward = (gross as u64).min(remaining);               // pro-rate at the cap
    require!(reward > 0, ClankError::EpochCapReached);

    ep.minted += reward;
    ctx.accounts.token_config.cumulative_minted += reward;
    require!(ctx.accounts.token_config.cumulative_minted <= EMISSION_BUCKET,
             ClankError::BucketExhausted);

    // mint CLANK to the operator, signed by the mint-authority PDA
    let seeds: &[&[&[u8]]] = &[&[b"clank_mint_auth", &[ctx.accounts.token_config.mint_auth_bump]]];
    token::mint_to(ctx.accounts.mint_ctx().with_signer(seeds), reward)?;
    emit!(EmissionAccrued { agent_id, reward, epoch: ep.epoch, job: att.key() });
    Ok(())
}
```

Invariant chain: **`verified` + non-self `Feedback` + bonded operator + epoch cap +
1B bucket cap.** Remove any link and the subsidy can be farmed; all five are
on-chain.

---

## 5. Buyback execution (the honest part)

The Pit Fund must buy CLANK on-market without self-front-running. Solana realities:

- **No synchronous "market buy" primitive.** Either CPI into a DEX (Orca/Raydium
  pool, or Jupiter — heavy CU) or use a **permissioned keeper** the program
  authorizes under hard bounds. Recommended v1: **keeper pattern.**
- `request_buyback` releases USDC to the keeper only if: `min_clank_out` (slippage
  bound) is set, the trade is ≤ `max_pct_adv` of trailing volume (TWAP/%-ADV cap per
  TOKENOMICS §12.5), and a **Pyth/Switchboard CLANK price** sanity-bounds the fill.
  `settle_buyback` records the realized CLANK and burns/routes it. All flows are
  accounted in `PitFund`; nothing is custodial-discretionary.
- **Value-aware throttle (§12.2):** size is a function of **price-to-fees**. Read
  `Config.total_fees_collected` (annualized) and the oracle price; if P/F is below
  the cheap band → full buyback; if rich → throttle and divert to USDC
  reserve / staker yield. This is the one mechanism a tradfi reviewer insisted on,
  and both inputs are already on-chain.

---

## 6. Invariants & audit checklist

- **Fixed supply:** `cumulative_minted ≤ EMISSION_BUCKET`; genesis minted once;
  mint authority is the PDA and nothing else; freeze authority `None`.
- **Per-epoch cap binds:** `epoch.minted ≤ epoch.cap`; `roll_epoch` is the only way
  to raise headroom and it *decays* the cap.
- **Emissions ⇐ proof:** `accrue_emissions` cannot mint without a verified
  attestation + non-self feedback + bonded operator + a one-shot per-job claim PDA.
- **Staking yield is real:** paid in **USDC** from the staker bucket, never minted —
  no reflexive printing, cleaner Howey posture (§12.5).
- **Slashing has a dispute window** before funds move; slashed CLANK is burned or
  insured, never paid to the slasher (no incentive to false-accuse).
- **Buyback bounded:** slippage `min_out`, `%-ADV` cap, oracle price sanity, full
  on-chain accounting; no discretionary custody.
- **Treasury boundary preserved:** USDC still leaves only via the existing
  Ledger/Squads-gated `withdraw_treasury`.
- **Use audited vesting** (Streamflow / Bonfida) for core & ecosystem buckets —
  don't roll your own cliff/linear logic.
- **Reentrancy:** N/A on Solana, but check account-substitution on every PDA
  (`has_one`, `seeds`+`bump`, mint/owner constraints) — the usual Anchor hygiene.

---

## 7. Build order & status

1. `init_token` + `TokenConfig` + `EmissionEpoch` epoch 0 — **✅ implemented.**
2. `bond_operator` + `OperatorBond` + `accrue_emissions` + `roll_epoch` (the DePIN
   engine, gated on the existing attestation/feedback) — **✅ implemented.**
3. `init_stake_pool` / `stake` / `unstake` / `claim_staking_yield` /
   `fund_staker_bucket` (staking live, **USDC** yield from real fees) —
   **✅ implemented.**
4. `PitFund` + `init_pit_fund` / `fund_pit_fund` / `execute_buyback` /
   `set_buyback_params` (value-aware buyback) — **✅ implemented.**
5. `VerifierBond` + `open_dispute` / `resolve_dispute` + dispute window (security
   layer) — **✅ implemented.**
6. Governance setters (`set_emission_params`, `set_token_authority`,
   `set_stake_cooldown`, `set_slash_params`; plus the pre-existing
   `set_buyback_params` / `set_facilitator` / `set_forwarder` /
   `set_treasury_owner`) — **✅ implemented.** Then: external audit,
   audited-vesting integration, and genesis wiring — *non-code, remaining.*

> **All six engineering steps are implemented.** 22 new $CLANK instructions
> extend the program from 25 → 47 instructions, fully additive. Fee *routing*
> (the 60/30/10 split) stays facilitator-driven off-chain — the on-chain
> `fund_pit_fund` / `fund_staker_bucket` accept the routed amounts — so there is
> no on-chain `set_fee_split`; governance instead tunes the parameters that *are*
> on-chain (emission schedule, bonds, cooldown, slash policy, buyback band).
> What remains is **non-code**: a security audit, wiring an audited vesting
> program (Streamflow/Bonfida) for the genesis buckets, and the genesis event.

> **Implemented in `programs/clanker5000/src/lib.rs` (steps 1–3):**
> - *Emissions (1–2):* `init_token` / `bond_operator` / `accrue_emissions` /
>   `roll_epoch`; state `TokenConfig`, `EmissionEpoch`, `OperatorBond`,
>   `JobClaim`; pure `emission_reward()`. The hook reuses the shipped
>   `Attestation` / `Agent` / `Feedback` accounts unchanged.
> - *Staking (3):* `init_stake_pool` / `stake` / `unstake` /
>   `claim_staking_yield` / `fund_staker_bucket`; state `StakePool`,
>   `StakeAccount`; MasterChef-style `acc_usdc_per_share` accounting with the pure
>   `pending_yield()` helper; yield paid in **USDC, never minted** (TOKENOMICS
>   §13.1); unstake cooldown.
>
> - *Buyback (4):* `init_pit_fund` / `fund_pit_fund` / `execute_buyback` /
>   `set_buyback_params`; state `PitFund`; pure `buyback_allowance()` (the
>   value-aware P/F throttle, §12.2). `execute_buyback` is an **atomic OTC fill**
>   against a permissioned keeper — USDC out and $CLANK in settle in one
>   instruction (no off-chain trust gap), bounded by the P/F band + slippage
>   ceiling + per-call cap/interval, then burns `burn_bps` of the acquired
>   $CLANK. (v1: price/fees are keeper-supplied & bounded; production reads a
>   Pyth/Switchboard oracle + on-chain fees.)
>
> - *Slashing (5):* `init_slashing` / `bond_verifier` / `unbond_verifier` /
>   `open_dispute` / `resolve_dispute`; state `SlashConfig`, `VerifierBond`,
>   `Dispute`; pure `slash_amount()`. Verifiers bond slashable $CLANK; a
>   challenger posts a bond and opens a dispute (snapshotting the slash); after
>   the window a resolver upholds (burn the slash, return the challenger bond) or
>   rejects (burn the frivolous challenger bond). **Slashed $CLANK is always
>   burned, never paid to the challenger** — no false-accusation incentive.
>   Unbonding is blocked while disputes are open.
>
> **Verification: `cargo test --lib` → 20/20 pass** (cap-clamp, stake-bonus
> saturation, yield pro-rata + solvency, buyback taper + monotonic-in-P/F, slash
> ≤ bond invariants); **`cargo build-sbf` → BPF builds clean.** All additive — no
> migration of live program state.

Each step is independently testable on the local validator the same way the existing
`anchor test` 3/3 suite runs, and each maps 1:1 to a section of `TOKENOMICS.md`.

### Testing status

- **Pure logic — `cargo test --lib` → 20/20 pass.** `parimutuel_payout`,
  `emission_reward`, `pending_yield`, `buyback_allowance`, `slash_amount` and their
  invariants (cap-clamp, +25% bonus saturation, yield pro-rata + solvency, buyback
  taper monotonic-in-P/F, slash ≤ bond).
- **BPF — `cargo build-sbf` → builds clean** (~938 KB `.so`).
- **Integration — `anchor test` → 5/5 pass** (the 3 existing race/market tests +
  2 new token suites in
  [`solana/tests/token_integration.ts`](../solana/tests/token_integration.ts),
  executed on a local validator against real BPF):
  *(1)* staking — `init_stake_pool → stake → fund_staker_bucket →
  claim_staking_yield`, asserting the sole staker collects the full USDC yield;
  *(2)* emissions — `register_agent → init_attestation → write_attestation(80) →
  give_feedback(requester) → init_token → bond_operator → accrue_emissions`,
  asserting $CLANK is minted (base + 25% bond bonus) **only** after the full proof
  chain, and that a second accrual for the same job is rejected (the `JobClaim`
  PDA collides). Account sets use `accountsStrict`. The emissions suite is robust
  to the singleton `config` (init-if-fresh, then `set_facilitator`).
  > Toolchain note: needs a native `anchor-cli 0.31.1` (the npm shim is
  > mispackaged and the 0.31.0 npm build is broken) — install the prebuilt
  > `anchor-0.31.1-x86_64-unknown-linux-gnu` to `~/.cargo/bin/anchor` (or
  > `avm install 0.31.1`). `anchor build` regenerates the IDL (47 instructions);
  > copy it to `sidecar/src/generated/clanker5000.json` for clients.
