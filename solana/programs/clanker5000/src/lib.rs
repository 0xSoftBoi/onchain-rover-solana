//! Clanker 5000 — native-Solana settlement core for The Clanker 500.
//!
//! This is the Solana/Anchor port of the project's two EVM settlement
//! contracts:
//!   * `chain/contracts/RaceEscrow.sol` -> the `race_*` instructions below
//!     (two-driver staked race, USDC held in a per-race PDA vault).
//!   * `contracts/RaceMarket.sol`       -> the `*_market` / `place_bet` /
//!     `claim` instructions (parimutuel betting, one-human-one-bet enforced
//!     by a per-nullifier PDA).
//!
//! Token payments use SPL (USDC, 6 decimals) via CPI, replacing the ERC-20
//! `transferFrom`/`permit` flow. On Solana the driver/bettor signs their own
//! transaction, so the EVM "facilitator relays an EIP-712 authorization"
//! pattern collapses into a direct signer — see `docs/SOLANA_PORT.md`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

// Placeholder program id. Run `anchor keys sync` after the first build to
// replace this with the keypair-derived id (and update Anchor.toml).
declare_id!("4FLTsBUD6iCQo5VBzdCSv8imoCnhttnQ1GQFEHL5iEDD");

/// Maximum lanes in a parimutuel market (guard, courier, plus fruit-obstacle
/// lanes for the show). Mirrors the unbounded EVM mapping with a fixed array
/// so account space is deterministic.
pub const MAX_RACERS: usize = 8;

/// Parimutuel payout `floor(amount * total_pool / win_pool)`, computed in u128.
/// A `u64 * u64` product always fits in a `u128`, so this can never overflow.
/// Returns 0 when the winning pool is empty (no winning bets). Pure function so
/// the money math is unit-testable without a validator (see `mod tests`).
pub fn parimutuel_payout(amount: u64, total_pool: u64, win_pool: u64) -> u64 {
    if win_pool == 0 {
        return 0;
    }
    ((amount as u128) * (total_pool as u128) / (win_pool as u128)) as u64
}

/// $CLANK work-emission reward for ONE verified job, in token base units.
/// `base` is the epoch's `reward_per_job`; bonded stake adds up to **+25%**,
/// diminishing and saturating at 4× the minimum bond; the result is clamped to
/// the epoch's `remaining_cap` so emissions can never exceed the schedule (the
/// hard anti-spiral guard from TOKENOMICS §6/§10). Pure so it is unit-testable
/// without a validator — see `mod tests`. Gating (verified attestation, bond ≥
/// minimum, etc.) lives in `accrue_emissions`; this is only the arithmetic.
pub fn emission_reward(base: u64, bonded: u64, min_bond: u64, remaining_cap: u64) -> u64 {
    let mut reward = base as u128;
    if min_bond > 0 {
        let min_b = min_bond as u128;
        // stake above the minimum, capped at 3× the minimum (i.e. 4× total)
        let excess = (bonded as u128).min(4 * min_b).saturating_sub(min_b);
        // bonus = base × (excess / 3·min_bond) × 25%
        let bonus = reward * excess * 2500 / (3 * min_b * 10_000);
        reward = reward.saturating_add(bonus);
    }
    reward.min(remaining_cap as u128) as u64
}

/// Accumulator scale for staking yield (1e12), the MasterChef-style fixed point
/// for `acc_usdc_per_share`.
pub const ACC_SCALE: u128 = 1_000_000_000_000;

/// Pending USDC yield owed to a staker: `amount × acc_per_share − reward_debt`,
/// where `acc` is USDC-per-share scaled by `ACC_SCALE` and `reward_debt` is the
/// staker's snapshot at their last update. `acc` only ever rises, so this is
/// non-negative. Pure for unit tests (the real-yield core of TOKENOMICS §13.1).
pub fn pending_yield(amount: u64, acc: u128, reward_debt: u128) -> u64 {
    let gross = (amount as u128) * acc / ACC_SCALE;
    gross.saturating_sub(reward_debt).min(u64::MAX as u128) as u64
}

/// Value-aware buyback ceiling (TOKENOMICS §12.2 — "don't buy back above intrinsic
/// value"). Given a price-to-fees ratio `pf_x100` (P/F × 100), spend the full
/// `budget` at/below `cheap_x100`, nothing at/above `rich_x100`, and taper
/// linearly in between. A mis-ordered band (rich <= cheap) returns 0 (safe). Pure
/// so the throttle is unit-testable without a validator.
pub fn buyback_allowance(budget: u64, pf_x100: u64, cheap_x100: u64, rich_x100: u64) -> u64 {
    if rich_x100 <= cheap_x100 {
        return 0;
    }
    if pf_x100 <= cheap_x100 {
        return budget;
    }
    if pf_x100 >= rich_x100 {
        return 0;
    }
    let span = (rich_x100 - cheap_x100) as u128;
    let headroom = (rich_x100 - pf_x100) as u128;
    ((budget as u128) * headroom / span) as u64
}

/// $CLANK slashed from a verifier when a dispute is upheld: `slash_bps` of the
/// bond. The caller clamps this to the verifier's *current* bond (it may have
/// fallen since the dispute opened). Pure for unit tests.
pub fn slash_amount(bonded: u64, slash_bps: u16) -> u64 {
    ((bonded as u128) * (slash_bps as u128) / 10_000) as u64
}

#[program]
pub mod clanker5000 {
    use super::*;

    // ----- Race escrow (port of RaceEscrow.sol) -----------------------------

    /// One-time program configuration. `authority` is the operator (the only
    /// key that can rotate the facilitator), mirroring the EVM `operator`.
    pub fn initialize(ctx: Context<Initialize>, facilitator: Pubkey) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.facilitator = facilitator;
        cfg.treasury = ctx.accounts.treasury_token.key();
        cfg.usdc_mint = ctx.accounts.usdc_mint.key();
        cfg.next_race_id = 0;
        cfg.total_fees_collected = 0;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    /// Open a race for `race_id` (must equal the running counter). Facilitator
    /// only. Creates the race account and its USDC vault.
    pub fn open_race(
        ctx: Context<OpenRace>,
        race_id: u64,
        local_round_id: [u8; 32],
        stake_amount: u64,
        fee_amount: u64,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.facilitator.key(),
            ctx.accounts.config.facilitator,
            ClankerError::NotFacilitator
        );
        require!(stake_amount > 0, ClankerError::BadAmount);
        require!(race_id == ctx.accounts.config.next_race_id, ClankerError::BadRaceId);

        let race = &mut ctx.accounts.race;
        race.race_id = race_id;
        race.status = RaceStatus::Created;
        race.local_round_id = local_round_id;
        race.stake_amount = stake_amount;
        race.fee_amount = fee_amount;
        race.vault = ctx.accounts.vault.key();
        race.created_at = Clock::get()?.unix_timestamp;
        race.bump = ctx.bumps.race;

        ctx.accounts.config.next_race_id = race_id
            .checked_add(1)
            .ok_or(ClankerError::Overflow)?;

        emit!(RaceOpened { race_id, local_round_id, stake_amount, fee_amount });
        Ok(())
    }

    /// Join a race in `slot` (0 = challenger, 1 = opponent). The driver signs
    /// directly and funds the stake from their own ATA; the fee goes to the
    /// treasury token account.
    pub fn join_race(
        ctx: Context<JoinRace>,
        _race_id: u64,
        slot: u8,
        stake_amount: u64,
        fee_amount: u64,
    ) -> Result<()> {
        require!(slot <= 1, ClankerError::BadSlot);
        let race = &mut ctx.accounts.race;
        require!(
            race.status == RaceStatus::Created || race.status == RaceStatus::Joined,
            ClankerError::BadState
        );
        require!(
            stake_amount == race.stake_amount && fee_amount == race.fee_amount,
            ClankerError::BadAmount
        );

        let driver = ctx.accounts.driver.key();
        if slot == 0 {
            require!(!race.challenger_joined, ClankerError::AlreadyJoined);
            race.challenger = driver;
            race.challenger_joined = true;
        } else {
            require!(!race.opponent_joined, ClankerError::AlreadyJoined);
            require!(driver != race.challenger, ClankerError::BadDriver);
            race.opponent = driver;
            race.opponent_joined = true;
        }

        // Stake -> vault.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.driver_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.driver.to_account_info(),
                },
            ),
            stake_amount,
        )?;

        // Fee -> treasury.
        if fee_amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.driver_token.to_account_info(),
                        to: ctx.accounts.treasury_token.to_account_info(),
                        authority: ctx.accounts.driver.to_account_info(),
                    },
                ),
                fee_amount,
            )?;
            race.fees_collected = race.fees_collected.saturating_add(fee_amount);
            ctx.accounts.config.total_fees_collected = ctx
                .accounts
                .config
                .total_fees_collected
                .saturating_add(fee_amount);
        }

        if race.challenger_joined && race.opponent_joined {
            race.status = RaceStatus::Joined;
        }

        emit!(RaceJoined { race_id: race.race_id, driver, slot, stake_amount, fee_amount });
        Ok(())
    }

    pub fn lock_race(ctx: Context<FacilitatorRace>, _race_id: u64) -> Result<()> {
        let race = &mut ctx.accounts.race;
        require!(
            race.status == RaceStatus::Joined
                && race.challenger_joined
                && race.opponent_joined,
            ClankerError::BadState
        );
        race.status = RaceStatus::Locked;
        race.locked_at = Clock::get()?.unix_timestamp;
        emit!(RaceLocked { race_id: race.race_id });
        Ok(())
    }

    pub fn start_race(ctx: Context<FacilitatorRace>, _race_id: u64) -> Result<()> {
        let race = &mut ctx.accounts.race;
        require!(race.status == RaceStatus::Locked, ClankerError::BadState);
        race.status = RaceStatus::Started;
        race.started_at = Clock::get()?.unix_timestamp;
        emit!(RaceStarted { race_id: race.race_id });
        Ok(())
    }

    pub fn finish_race(
        ctx: Context<FacilitatorRace>,
        _race_id: u64,
        winner_slot: u8,
        proof_hash: [u8; 32],
    ) -> Result<()> {
        require!(winner_slot <= 1, ClankerError::BadSlot);
        let race = &mut ctx.accounts.race;
        require!(race.status == RaceStatus::Started, ClankerError::BadState);
        race.status = RaceStatus::Finished;
        race.winner_slot = winner_slot;
        race.proof_hash = proof_hash;
        race.finished_at = Clock::get()?.unix_timestamp;
        emit!(RaceFinished { race_id: race.race_id, winner_slot, proof_hash });
        Ok(())
    }

    /// Pay the full 2x stake to the winner. `winner_token` must be owned by the
    /// winning slot's driver.
    pub fn settle_race(ctx: Context<SettleRace>, _race_id: u64) -> Result<()> {
        let race = &mut ctx.accounts.race;
        require!(race.status == RaceStatus::Finished, ClankerError::BadState);

        let winner = if race.winner_slot == 0 { race.challenger } else { race.opponent };
        require_keys_eq!(ctx.accounts.winner_token.owner, winner, ClankerError::BadDriver);

        let payout = race
            .stake_amount
            .checked_mul(2)
            .ok_or(ClankerError::Overflow)?;
        race.status = RaceStatus::Settled;

        let bump = ctx.bumps.vault_authority;
        let signer: &[&[&[u8]]] = &[&[VAULT_AUTH_SEED, &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.winner_token.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer,
            ),
            payout,
        )?;

        emit!(RaceSettled { race_id: race.race_id, winner, payout });
        Ok(())
    }

    /// Refund staked drivers and void the race. `challenger_token`/
    /// `opponent_token` must be owned by the respective drivers.
    pub fn cancel_race(ctx: Context<CancelRace>, _race_id: u64, reason: String) -> Result<()> {
        let race = &mut ctx.accounts.race;
        require!(
            matches!(race.status, RaceStatus::Created | RaceStatus::Joined | RaceStatus::Locked | RaceStatus::Started),
            ClankerError::BadState
        );
        race.status = RaceStatus::Canceled;

        let bump = ctx.bumps.vault_authority;
        let signer: &[&[&[u8]]] = &[&[VAULT_AUTH_SEED, &[bump]]];

        if race.challenger_joined && race.stake_amount > 0 {
            require_keys_eq!(
                ctx.accounts.challenger_token.owner,
                race.challenger,
                ClankerError::BadDriver
            );
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.challenger_token.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    signer,
                ),
                race.stake_amount,
            )?;
        }
        if race.opponent_joined && race.stake_amount > 0 {
            require_keys_eq!(
                ctx.accounts.opponent_token.owner,
                race.opponent,
                ClankerError::BadDriver
            );
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.opponent_token.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    signer,
                ),
                race.stake_amount,
            )?;
        }

        emit!(RaceCanceled { race_id: race.race_id, reason });
        Ok(())
    }

    pub fn set_facilitator(ctx: Context<OperatorOnly>, facilitator: Pubkey) -> Result<()> {
        ctx.accounts.config.facilitator = facilitator;
        emit!(FacilitatorChanged { facilitator });
        Ok(())
    }

    // ----- Parimutuel market (port of RaceMarket.sol) -----------------------

    /// Open a parimutuel market. The signer becomes the judge (the guard
    /// robot's wallet that attests the finish); `operator` is the Ledger-
    /// governed key allowed to rotate the judge.
    pub fn open_market(
        ctx: Context<OpenMarket>,
        market_id: u64,
        num_racers: u8,
        operator: Pubkey,
    ) -> Result<()> {
        require!(num_racers as usize <= MAX_RACERS && num_racers > 0, ClankerError::BadRacerCount);
        let m = &mut ctx.accounts.market;
        m.market_id = market_id;
        m.judge = ctx.accounts.judge.key();
        m.operator = operator;
        m.usdc_mint = ctx.accounts.usdc_mint.key();
        m.open = true;
        m.settled = false;
        m.winner = 0;
        m.num_racers = num_racers;
        m.pools = [0u64; MAX_RACERS];
        m.total_pool = 0;
        m.vault = ctx.accounts.vault.key();
        m.settled_at = 0;
        m.winning_proof_hash = [0u8; 32];
        m.walrus_blob_id = String::new();
        m.bump = ctx.bumps.market;
        emit!(MarketOpened { market_id, num_racers });
        Ok(())
    }

    /// Place a single bet. One bet per bettor (enforced by the `bet` PDA) and
    /// one bet per human (enforced by the `nullifier` PDA — a reused World ID
    /// nullifier collides on an already-initialized account and fails).
    pub fn place_bet(
        ctx: Context<PlaceBet>,
        _market_id: u64,
        racer: u8,
        amount: u64,
        world_nullifier: [u8; 32],
    ) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.open && !m.settled, ClankerError::MarketClosed);
        require!(racer < m.num_racers, ClankerError::BadRacer);
        require!(amount > 0, ClankerError::BadAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bettor_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.bettor.to_account_info(),
                },
            ),
            amount,
        )?;

        let bet = &mut ctx.accounts.bet;
        bet.market = m.key();
        bet.bettor = ctx.accounts.bettor.key();
        bet.racer = racer;
        bet.amount = amount;
        bet.claimed = false;
        bet.bump = ctx.bumps.bet;

        ctx.accounts.nullifier.used = true;
        ctx.accounts.nullifier.value = world_nullifier;

        m.pools[racer as usize] = m.pools[racer as usize]
            .checked_add(amount)
            .ok_or(ClankerError::Overflow)?;
        m.total_pool = m.total_pool.checked_add(amount).ok_or(ClankerError::Overflow)?;

        emit!(BetPlaced { market_id: m.market_id, bettor: bet.bettor, racer, amount, world_nullifier });
        Ok(())
    }

    /// Judge settles the market with the Gemini-verified finish proof (sha256
    /// hash + Walrus blob id).
    pub fn settle_market(
        ctx: Context<SettleMarket>,
        _market_id: u64,
        winner: u8,
        proof_hash: [u8; 32],
        walrus_blob_id: String,
    ) -> Result<()> {
        require!(walrus_blob_id.len() <= 64, ClankerError::StringTooLong);
        let m = &mut ctx.accounts.market;
        require!(m.open && !m.settled, ClankerError::BadState);
        require!(winner < m.num_racers, ClankerError::BadRacer);
        m.open = false;
        m.settled = true;
        m.winner = winner;
        // Anchor the finish proof on-chain (parity with `finish_race`'s
        // `race.proof_hash`) so the Walrus blob + verdict hash are queryable
        // state, not just an emitted log.
        m.winning_proof_hash = proof_hash;
        m.walrus_blob_id = walrus_blob_id.clone();
        m.settled_at = Clock::get()?.unix_timestamp;
        emit!(MarketSettled { market_id: m.market_id, winner, proof_hash, walrus_blob_id });
        Ok(())
    }

    /// Claim a pro-rata share of the pool: `stake * total_pool / winning_pool`.
    pub fn claim(ctx: Context<Claim>, _market_id: u64) -> Result<()> {
        let m = &ctx.accounts.market;
        require!(m.settled, ClankerError::NotSettled);
        let bet = &mut ctx.accounts.bet;
        require!(!bet.claimed, ClankerError::AlreadyClaimed);
        require!(bet.racer == m.winner, ClankerError::Lost);

        let payout = parimutuel_payout(bet.amount, m.total_pool, m.pools[m.winner as usize]);
        bet.claimed = true;

        if payout > 0 {
            let market_key = m.key();
            let bump = ctx.bumps.market_vault_authority;
            let seeds: &[&[u8]] = &[MARKET_VAULT_AUTH_SEED, market_key.as_ref(), &[bump]];
            let signer: &[&[&[u8]]] = &[seeds];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.bettor_token.to_account_info(),
                        authority: ctx.accounts.market_vault_authority.to_account_info(),
                    },
                    signer,
                ),
                payout,
            )?;
        }

        emit!(Claimed { market_id: m.market_id, bettor: ctx.accounts.bettor.key(), payout });
        Ok(())
    }

    pub fn set_judge(ctx: Context<SetJudge>, _market_id: u64, new_judge: Pubkey) -> Result<()> {
        ctx.accounts.market.judge = new_judge;
        emit!(JudgeChanged { market_id: ctx.accounts.market.market_id, judge: new_judge });
        Ok(())
    }

    /// Sweep residual vault balance (parimutuel rounding dust) to a recipient
    /// after the claim window. Operator-gated and **time-locked**: callable only
    /// once `CLAIM_WINDOW_SECS` have elapsed since settlement, so winners always
    /// have a guaranteed window to claim before any sweep. Fixes the otherwise
    /// unreclaimable dust from `claim`'s flooring. See docs/MAINNET_READINESS.md §1.
    pub fn sweep_market(ctx: Context<SweepMarket>, _market_id: u64) -> Result<()> {
        let m = &ctx.accounts.market;
        require!(m.settled, ClankerError::MarketNotSettled);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= m.settled_at.checked_add(CLAIM_WINDOW_SECS).ok_or(ClankerError::Overflow)?,
            ClankerError::BadState
        );
        let amount = ctx.accounts.vault.amount;
        if amount > 0 {
            let market_key = m.key();
            let bump = ctx.bumps.market_vault_authority;
            let seeds: &[&[u8]] = &[MARKET_VAULT_AUTH_SEED, market_key.as_ref(), &[bump]];
            let signer: &[&[&[u8]]] = &[seeds];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.recipient.to_account_info(),
                        authority: ctx.accounts.market_vault_authority.to_account_info(),
                    },
                    signer,
                ),
                amount,
            )?;
        }
        emit!(MarketSwept { market_id: m.market_id, amount });
        Ok(())
    }

    // ----- Reputation (port of ReputationRegistry.sol, ERC-8004) ------------

    /// Register who owns `agent_id` (the robot's wallet), so the registry can
    /// reject self-feedback. Mirrors `setAgentOwner` (first writer wins — here
    /// the PDA can only be initialized once).
    pub fn register_agent(ctx: Context<RegisterAgent>, agent_id: u64, owner: Pubkey) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        agent.agent_id = agent_id;
        agent.owner = owner;
        agent.count = 0;
        agent.sum = 0;
        agent.bump = ctx.bumps.agent;
        emit!(AgentRegistered { agent_id, owner });
        Ok(())
    }

    /// The requester rates an agent. The signer must not be the agent owner
    /// ("self-feedback not allowed"). Each feedback is stored in its own PDA
    /// (index = running count), and the agent's running count/sum back the
    /// leaderboard average. Emits `NewFeedback` for indexers/BigQuery.
    #[allow(clippy::too_many_arguments)]
    pub fn give_feedback(
        ctx: Context<GiveFeedback>,
        _agent_id: u64,
        value: i64,
        value_decimals: u8,
        tag1: String,
        tag2: String,
        endpoint: String,
        feedback_uri: String,
        feedback_hash: [u8; 32],
    ) -> Result<()> {
        require!(tag1.len() <= 32 && tag2.len() <= 32, ClankerError::StringTooLong);
        require!(endpoint.len() <= 96 && feedback_uri.len() <= 160, ClankerError::StringTooLong);
        let agent = &mut ctx.accounts.agent;
        require_keys_neq!(ctx.accounts.client.key(), agent.owner, ClankerError::SelfFeedback);

        let index = agent.count;
        let fb = &mut ctx.accounts.feedback;
        fb.agent = agent.key();
        fb.client = ctx.accounts.client.key();
        fb.index = index;
        fb.value = value;
        fb.value_decimals = value_decimals;
        fb.tag1 = tag1.clone();
        fb.tag2 = tag2;
        fb.endpoint = endpoint;
        fb.feedback_uri = feedback_uri;
        fb.feedback_hash = feedback_hash;
        fb.ts = Clock::get()?.unix_timestamp;
        fb.bump = ctx.bumps.feedback;

        agent.count = index.checked_add(1).ok_or(ClankerError::Overflow)?;
        agent.sum = agent
            .sum
            .checked_add(value as i128)
            .ok_or(ClankerError::Overflow)?;

        emit!(NewFeedback {
            agent_id: agent.agent_id,
            client: fb.client,
            feedback_index: index,
            value,
            value_decimals,
            tag1,
            feedback_hash,
        });
        Ok(())
    }

    // ----- EventPass (port of EventPass.sol) --------------------------------

    /// One-time init. `minter` is the guard robot's wallet (the only key that
    /// can mint passes).
    pub fn init_event_pass(ctx: Context<InitEventPass>, minter: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.pass_config;
        c.minter = minter;
        c.next_id = 0;
        c.bump = ctx.bumps.pass_config;
        Ok(())
    }

    /// Mint an access pass to `to` at the auction-settled `price_usdc6`. The
    /// pass is a program-native record (PDA per id); `holds(who)` is an
    /// off-chain getProgramAccounts query filtered by `owner` (the Solana
    /// idiom in place of an ERC-721 balanceOf). Minter only.
    pub fn mint_pass(ctx: Context<MintPass>, pass_id: u64, to: Pubkey, price_usdc6: u64) -> Result<()> {
        let c = &mut ctx.accounts.pass_config;
        require_keys_eq!(ctx.accounts.minter.key(), c.minter, ClankerError::NotMinter);
        require!(pass_id == c.next_id, ClankerError::BadPassId);
        let pass = &mut ctx.accounts.pass;
        pass.id = pass_id;
        pass.owner = to;
        pass.price_usdc6 = price_usdc6;
        pass.bump = ctx.bumps.pass;
        c.next_id = pass_id.checked_add(1).ok_or(ClankerError::Overflow)?;
        emit!(PassMinted { id: pass_id, to, price_usdc6 });
        Ok(())
    }

    // ----- Treasury (port of Treasury.sol) ----------------------------------

    /// Init the fleet treasury. `owner` is the Ledger hardware-wallet address;
    /// the USDC vault is a PDA token account.
    pub fn init_treasury(ctx: Context<InitTreasury>, owner: Pubkey) -> Result<()> {
        let t = &mut ctx.accounts.treasury_config;
        t.owner = owner;
        t.usdc_mint = ctx.accounts.usdc_mint.key();
        t.vault = ctx.accounts.vault.key();
        t.bump = ctx.bumps.treasury_config;
        Ok(())
    }

    /// Withdraw fleet earnings. Owner-gated (the Ledger-held key) — the
    /// governance boundary for the demo climax. Kept minimal so a Ledger Solana
    /// clear-sign renders "Withdraw <amount> USDC to <recipient>".
    pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
        let bump = ctx.bumps.treasury_authority;
        let signer: &[&[&[u8]]] = &[&[TREASURY_AUTH_SEED, &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                    authority: ctx.accounts.treasury_authority.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
        emit!(TreasuryWithdraw { to: ctx.accounts.recipient.key(), amount });
        Ok(())
    }

    pub fn set_treasury_owner(ctx: Context<SetTreasuryOwner>, new_owner: Pubkey) -> Result<()> {
        ctx.accounts.treasury_config.owner = new_owner;
        emit!(TreasuryOwnerChanged { new_owner });
        Ok(())
    }

    // ----- AttestationConsumer (port of AttestationConsumer.sol, Chainlink CRE) --

    /// Init the consensus-verdict gate. `forwarder` is the Chainlink forwarder
    /// authorized to write reports; `Pubkey::default()` (all zeros) = unrestricted
    /// (sim/demo), matching the EVM `forwarder == address(0)` escape hatch.
    pub fn init_attestation(ctx: Context<InitAttestation>, forwarder: Pubkey) -> Result<()> {
        // No zero-key backdoor: a real forwarder (DON authority, or the
        // facilitator key for local/sim) must be set. See docs/MAINNET_READINESS.md §1.
        require_keys_neq!(forwarder, Pubkey::default(), ClankerError::BadForwarder);
        let c = &mut ctx.accounts.attest_config;
        c.owner = ctx.accounts.owner.key();
        c.forwarder = forwarder;
        c.bump = ctx.bumps.attest_config;
        Ok(())
    }

    pub fn set_forwarder(ctx: Context<SetForwarder>, forwarder: Pubkey) -> Result<()> {
        require_keys_neq!(forwarder, Pubkey::default(), ClankerError::BadForwarder);
        ctx.accounts.attest_config.forwarder = forwarder;
        emit!(ForwarderSet { forwarder });
        Ok(())
    }

    /// Land the DON's consensus verdict for a job (keyed by `job_hash` =
    /// sha256/keccak of the job string, computed client-side). The robot's own
    /// claim never settles anything — this is the verdict downstream reads via
    /// `verified`. Reporter MUST be the configured forwarder (no open path).
    pub fn write_attestation(
        ctx: Context<WriteAttestation>,
        _job_hash: [u8; 32],
        job: String,
        score: u64,
        proof_hash: [u8; 32],
    ) -> Result<()> {
        require!(job.len() <= 64, ClankerError::StringTooLong);
        let cfg = &ctx.accounts.attest_config;
        require_keys_eq!(ctx.accounts.reporter.key(), cfg.forwarder, ClankerError::Unauthorized);
        let verified = score >= ATTESTATION_THRESHOLD;
        let a = &mut ctx.accounts.attestation;
        a.score = score;
        a.proof_hash = proof_hash;
        a.timestamp = Clock::get()?.unix_timestamp;
        a.verified = verified;
        a.exists = true;
        a.bump = ctx.bumps.attestation;
        emit!(AttestationVerified { job, score, proof_hash, verified, timestamp: a.timestamp });
        Ok(())
    }

    // ----- $CLANK work-emissions engine (docs/TOKEN_PROGRAM_SPEC.md) ---------

    /// One-time token init. The $CLANK mint must already exist with its mint
    /// authority set to the program PDA `[CLANK_MINT_AUTH_SEED]` — so after this,
    /// **only the program can mint, and only via `accrue_emissions` under the
    /// epoch cap.** Opens emission epoch 0. Genesis/vesting buckets are minted
    /// separately (audited vesting program) before authority is handed to the PDA.
    pub fn init_token(
        ctx: Context<InitToken>,
        epoch0_cap: u64,
        reward_per_job: u64,
        epoch_len: i64,
        decay_num: u64,
        decay_den: u64,
        min_operator_bond: u64,
    ) -> Result<()> {
        require!(decay_den > 0 && decay_num <= decay_den, ClankerError::BadEmissionParams);
        require!(epoch_len > 0 && epoch0_cap <= EMISSION_BUCKET, ClankerError::BadEmissionParams);
        // Mint authority MUST be the program PDA — no human mint path.
        let (mint_auth, mint_auth_bump) =
            Pubkey::find_program_address(&[CLANK_MINT_AUTH_SEED], ctx.program_id);
        let current_auth: Option<Pubkey> = ctx.accounts.clank_mint.mint_authority.into();
        require!(current_auth == Some(mint_auth), ClankerError::BadMintAuthority);

        let tc = &mut ctx.accounts.token_config;
        tc.authority = ctx.accounts.authority.key();
        tc.clank_mint = ctx.accounts.clank_mint.key();
        tc.mint_auth_bump = mint_auth_bump;
        tc.min_operator_bond = min_operator_bond;
        tc.epoch_len = epoch_len;
        tc.decay_num = decay_num;
        tc.decay_den = decay_den;
        tc.current_epoch = 0;
        tc.cumulative_minted = 0;
        tc.bump = ctx.bumps.token_config;

        let ep = &mut ctx.accounts.epoch;
        ep.epoch = 0;
        ep.cap = epoch0_cap;
        ep.minted = 0;
        ep.reward_per_job = reward_per_job;
        ep.start_ts = Clock::get()?.unix_timestamp;
        ep.bump = ctx.bumps.epoch;
        emit!(TokenInitialized { clank_mint: tc.clank_mint, epoch0_cap, reward_per_job });
        Ok(())
    }

    /// Bond $CLANK against an `Agent` identity. Only the agent's owner can bond;
    /// the bond is slashable and is the skin-in-the-game that gates emissions
    /// (`bonded >= min_operator_bond`) and weights the reward (`emission_reward`).
    pub fn bond_operator(ctx: Context<BondOperator>, _agent_id: u64, amount: u64) -> Result<()> {
        require!(amount > 0, ClankerError::BadAmount);
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.agent.owner, ClankerError::NotAgentOwner);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_clank.to_account_info(),
                    to: ctx.accounts.bond_vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        let b = &mut ctx.accounts.operator_bond;
        b.agent = ctx.accounts.agent.key();
        b.owner = ctx.accounts.owner.key();
        b.bonded = b.bonded.checked_add(amount).ok_or(ClankerError::Overflow)?;
        b.bump = ctx.bumps.operator_bond;
        emit!(OperatorBonded { agent: b.agent, owner: b.owner, bonded: b.bonded });
        Ok(())
    }

    /// Mint work emissions for ONE verified job — the anti-gaming core. Mints
    /// $CLANK to the operator only when the five on-chain links all hold:
    ///   1. the job's `Attestation` is oracle-`verified` (score ≥ 70),
    ///   2. a REQUESTER wrote `Feedback` for this agent (and it is not
    ///      self-feedback — the program already forbids that in `give_feedback`),
    ///   3. the operator is bonded ≥ the minimum and the agent's reputation is
    ///      not net-negative,
    ///   4. the current epoch's cap (and the 1B bucket) is not exhausted,
    ///   5. this (agent, job) has not already been claimed (the `JobClaim` PDA
    ///      `init`s once; a second attempt collides and fails).
    /// Facilitator/keeper-gated. v1 simplification: the `Feedback` account is
    /// validated by its fields (agent + non-self client), not bound to `job_hash`
    /// — a stricter binding is a follow-up; the one-shot `JobClaim` bounds abuse.
    pub fn accrue_emissions(
        ctx: Context<AccrueEmissions>,
        agent_id: u64,
        job_hash: [u8; 32],
    ) -> Result<()> {
        let att = &ctx.accounts.attestation;
        let fb = &ctx.accounts.feedback;
        let agent = &ctx.accounts.agent;
        let bond = &ctx.accounts.operator_bond;

        // 1. proof-of-physical-work: oracle-verified, score >= threshold
        require!(att.exists && att.verified && att.score >= ATTESTATION_THRESHOLD, ClankerError::NotVerified);
        // 2. real demand: requester feedback for THIS agent, not self-feedback
        require_keys_eq!(fb.agent, agent.key(), ClankerError::FeedbackMismatch);
        require_keys_neq!(fb.client, agent.owner, ClankerError::SelfFeedback);
        // 3. skin in the game + non-negative reputation
        require_keys_eq!(bond.agent, agent.key(), ClankerError::BondMismatch);
        require!(bond.bonded >= ctx.accounts.token_config.min_operator_bond, ClankerError::Unbonded);
        require!(agent.count == 0 || agent.sum >= 0, ClankerError::BadReputation);
        // 4. current epoch + cap headroom
        require!(ctx.accounts.epoch.epoch == ctx.accounts.token_config.current_epoch, ClankerError::WrongEpoch);
        let remaining = ctx.accounts.epoch.cap.saturating_sub(ctx.accounts.epoch.minted);
        let reward = emission_reward(
            ctx.accounts.epoch.reward_per_job,
            bond.bonded,
            ctx.accounts.token_config.min_operator_bond,
            remaining,
        );
        require!(reward > 0, ClankerError::EpochCapReached);
        require!(
            ctx.accounts.token_config.cumulative_minted.saturating_add(reward) <= EMISSION_BUCKET,
            ClankerError::BucketExhausted
        );

        // mint $CLANK to the operator, signed by the mint-authority PDA
        let bump = ctx.accounts.token_config.mint_auth_bump;
        let signer: &[&[&[u8]]] = &[&[CLANK_MINT_AUTH_SEED, &[bump]]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.clank_mint.to_account_info(),
                    to: ctx.accounts.operator_clank.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                signer,
            ),
            reward,
        )?;

        let ep = &mut ctx.accounts.epoch;
        ep.minted = ep.minted.checked_add(reward).ok_or(ClankerError::Overflow)?;
        let tc = &mut ctx.accounts.token_config;
        tc.cumulative_minted = tc.cumulative_minted.checked_add(reward).ok_or(ClankerError::Overflow)?;

        let jc = &mut ctx.accounts.job_claim;
        jc.agent = agent.key();
        jc.job_hash = job_hash;
        jc.reward = reward;
        jc.bump = ctx.bumps.job_claim;
        emit!(EmissionAccrued { agent_id, epoch: ep.epoch, reward, job_hash });
        Ok(())
    }

    /// Advance to the next emission epoch once the current one's window has
    /// elapsed. Permissionless. The new cap and reward/job both decay by
    /// `decay_num/decay_den` — the published taper (TOKENOMICS §6).
    pub fn roll_epoch(ctx: Context<RollEpoch>, next_epoch_id: u64) -> Result<()> {
        let tc = &mut ctx.accounts.token_config;
        let cur = &ctx.accounts.current_epoch;
        require!(next_epoch_id == cur.epoch + 1, ClankerError::WrongEpoch);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= cur.start_ts + tc.epoch_len, ClankerError::EpochNotOver);
        let next = &mut ctx.accounts.next_epoch;
        next.epoch = next_epoch_id;
        next.cap = ((cur.cap as u128) * (tc.decay_num as u128) / (tc.decay_den as u128)) as u64;
        next.minted = 0;
        next.reward_per_job =
            ((cur.reward_per_job as u128) * (tc.decay_num as u128) / (tc.decay_den as u128)) as u64;
        next.start_ts = now;
        next.bump = ctx.bumps.next_epoch;
        tc.current_epoch = next_epoch_id;
        emit!(EpochRolled { epoch: next.epoch, cap: next.cap, reward_per_job: next.reward_per_job });
        Ok(())
    }

    // ----- $CLANK staking — real (USDC) yield to the security layer ---------

    /// One-time staking init. Creates the CLANK stake vault and the USDC yield
    /// vault (both under one PDA authority), plus the global `StakePool`.
    /// `cooldown_secs` is the unstake delay set on each stake.
    pub fn init_stake_pool(ctx: Context<InitStakePool>, cooldown_secs: i64) -> Result<()> {
        require!(cooldown_secs >= 0, ClankerError::BadAmount);
        let p = &mut ctx.accounts.stake_pool;
        p.clank_mint = ctx.accounts.clank_mint.key();
        p.usdc_mint = ctx.accounts.usdc_mint.key();
        p.stake_vault = ctx.accounts.stake_vault.key();
        p.yield_vault = ctx.accounts.yield_vault.key();
        p.total_staked = 0;
        p.acc_usdc_per_share = 0;
        p.cooldown_secs = cooldown_secs;
        p.bump = ctx.bumps.stake_pool;
        Ok(())
    }

    /// Route USDC into the staker-yield bucket — the **30%-of-fees** real-yield
    /// stream (TOKENOMICS §13.1). Distributes pro-rata by bumping
    /// `acc_usdc_per_share`. Permissionless top-up (more yield only helps).
    pub fn fund_staker_bucket(ctx: Context<FundStakerBucket>, amount: u64) -> Result<()> {
        require!(amount > 0, ClankerError::BadAmount);
        let p = &mut ctx.accounts.stake_pool;
        require!(p.total_staked > 0, ClankerError::NoStakers);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.funder_usdc.to_account_info(),
                    to: ctx.accounts.yield_vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
        )?;
        p.acc_usdc_per_share = p
            .acc_usdc_per_share
            .checked_add((amount as u128) * ACC_SCALE / (p.total_staked as u128))
            .ok_or(ClankerError::Overflow)?;
        emit!(StakerBucketFunded { amount, acc_usdc_per_share: p.acc_usdc_per_share });
        Ok(())
    }

    /// Stake $CLANK. Settles any pending yield first (so the new, larger balance
    /// doesn't retroactively earn), pulls CLANK into the stake vault, and resets
    /// the unstake cooldown.
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, ClankerError::BadAmount);
        let p = &mut ctx.accounts.stake_pool;
        let s = &mut ctx.accounts.stake_account;
        if s.amount > 0 {
            let pend = pending_yield(s.amount, p.acc_usdc_per_share, s.reward_debt);
            s.pending_usdc = s.pending_usdc.checked_add(pend).ok_or(ClankerError::Overflow)?;
        }
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.staker_clank.to_account_info(),
                    to: ctx.accounts.stake_vault.to_account_info(),
                    authority: ctx.accounts.staker.to_account_info(),
                },
            ),
            amount,
        )?;
        s.owner = ctx.accounts.staker.key();
        s.amount = s.amount.checked_add(amount).ok_or(ClankerError::Overflow)?;
        p.total_staked = p.total_staked.checked_add(amount).ok_or(ClankerError::Overflow)?;
        s.reward_debt = (s.amount as u128) * p.acc_usdc_per_share / ACC_SCALE;
        s.unstake_ready_at = Clock::get()?.unix_timestamp + p.cooldown_secs;
        s.bump = ctx.bumps.stake_account;
        emit!(Staked { owner: s.owner, amount, total: s.amount });
        Ok(())
    }

    /// Unstake after the cooldown. Settles pending yield, then returns CLANK from
    /// the stake vault (PDA-signed).
    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        let p = &mut ctx.accounts.stake_pool;
        let s = &mut ctx.accounts.stake_account;
        require!(amount > 0 && amount <= s.amount, ClankerError::BadAmount);
        require!(Clock::get()?.unix_timestamp >= s.unstake_ready_at, ClankerError::CooldownActive);
        let pend = pending_yield(s.amount, p.acc_usdc_per_share, s.reward_debt);
        s.pending_usdc = s.pending_usdc.checked_add(pend).ok_or(ClankerError::Overflow)?;
        let bump = ctx.bumps.stake_vault_authority;
        let signer: &[&[&[u8]]] = &[&[STAKE_VAULT_AUTH_SEED, &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.stake_vault.to_account_info(),
                    to: ctx.accounts.staker_clank.to_account_info(),
                    authority: ctx.accounts.stake_vault_authority.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
        s.amount -= amount;
        p.total_staked = p.total_staked.checked_sub(amount).ok_or(ClankerError::Overflow)?;
        s.reward_debt = (s.amount as u128) * p.acc_usdc_per_share / ACC_SCALE;
        emit!(Unstaked { owner: s.owner, amount, remaining: s.amount });
        Ok(())
    }

    /// Claim accrued USDC yield (settled pending + freshly accrued) from the
    /// yield vault (PDA-signed). Real yield — never minted.
    pub fn claim_staking_yield(ctx: Context<ClaimYield>) -> Result<()> {
        let p = &ctx.accounts.stake_pool;
        let s = &mut ctx.accounts.stake_account;
        let pend = pending_yield(s.amount, p.acc_usdc_per_share, s.reward_debt);
        let payout = s.pending_usdc.checked_add(pend).ok_or(ClankerError::Overflow)?;
        require!(payout > 0, ClankerError::NothingToClaim);
        s.pending_usdc = 0;
        s.reward_debt = (s.amount as u128) * p.acc_usdc_per_share / ACC_SCALE;
        let bump = ctx.bumps.stake_vault_authority;
        let signer: &[&[&[u8]]] = &[&[STAKE_VAULT_AUTH_SEED, &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.yield_vault.to_account_info(),
                    to: ctx.accounts.staker_usdc.to_account_info(),
                    authority: ctx.accounts.stake_vault_authority.to_account_info(),
                },
                signer,
            ),
            payout,
        )?;
        emit!(YieldClaimed { owner: s.owner, amount: payout });
        Ok(())
    }

    // ----- Pit Fund — value-aware buyback (docs/TOKEN_PROGRAM_SPEC.md §5) ----

    /// One-time Pit Fund init: the USDC intake vault + the CLANK holding vault
    /// (both under one PDA authority), plus the buyback policy. `keeper` is the
    /// permissioned market-maker that fills buybacks; the P/F band and per-call
    /// cap implement the value-aware throttle (§12.2).
    pub fn init_pit_fund(
        ctx: Context<InitPitFund>,
        keeper: Pubkey,
        pf_cheap_x100: u64,
        pf_rich_x100: u64,
        max_per_call_usdc: u64,
        min_interval_secs: i64,
        burn_bps: u16,
    ) -> Result<()> {
        require!(pf_rich_x100 > pf_cheap_x100, ClankerError::BadEmissionParams);
        require!(burn_bps <= 10_000 && min_interval_secs >= 0, ClankerError::BadEmissionParams);
        let p = &mut ctx.accounts.pit_fund;
        p.authority = ctx.accounts.authority.key();
        p.keeper = keeper;
        p.usdc_mint = ctx.accounts.usdc_mint.key();
        p.clank_mint = ctx.accounts.clank_mint.key();
        p.usdc_vault = ctx.accounts.usdc_vault.key();
        p.clank_vault = ctx.accounts.clank_vault.key();
        p.usdc_intake = 0;
        p.clank_bought = 0;
        p.clank_burned = 0;
        p.pf_cheap_x100 = pf_cheap_x100;
        p.pf_rich_x100 = pf_rich_x100;
        p.max_per_call_usdc = max_per_call_usdc;
        p.min_interval_secs = min_interval_secs;
        p.burn_bps = burn_bps;
        p.last_buyback_ts = 0;
        p.bump = ctx.bumps.pit_fund;
        Ok(())
    }

    /// Route the **60%-of-fees** buyback share (USDC) into the Pit Fund. Permissionless top-up.
    pub fn fund_pit_fund(ctx: Context<FundPitFund>, amount: u64) -> Result<()> {
        require!(amount > 0, ClankerError::BadAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.funder_usdc.to_account_info(),
                    to: ctx.accounts.usdc_vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
        )?;
        let p = &mut ctx.accounts.pit_fund;
        p.usdc_intake = p.usdc_intake.checked_add(amount).ok_or(ClankerError::Overflow)?;
        emit!(PitFundFunded { amount, usdc_intake: p.usdc_intake });
        Ok(())
    }

    /// Execute one buyback as an **atomic OTC fill** against the keeper/MM: the
    /// program receives `clank_in` $CLANK and pays `usdc_out` USDC in the SAME
    /// instruction (never releases USDC without receiving tokens). Bounded by:
    ///   * the **value-aware P/F throttle** (`buyback_allowance`) computed from the
    ///     keeper-supplied `clank_price_usdc6` and `fees_annualized_usdc6`
    ///     (production: read a Pyth/Switchboard price + on-chain fees — v1 trusts
    ///     the permissioned keeper, bounded by `max_per_call` + `max_price`),
    ///   * a **slippage** ceiling (`max_price_usdc6`),
    ///   * a per-call cap + min interval (a TWAP/%-ADV proxy, §12.5).
    /// Then burns `burn_bps` of the acquired $CLANK (the burn-vs-distribute dial).
    pub fn execute_buyback(
        ctx: Context<ExecuteBuyback>,
        usdc_out: u64,
        clank_in: u64,
        clank_price_usdc6: u64,
        fees_annualized_usdc6: u64,
        max_price_usdc6: u64,
    ) -> Result<()> {
        require!(usdc_out > 0 && clank_in > 0, ClankerError::BadAmount);
        require!(fees_annualized_usdc6 > 0, ClankerError::BadAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx.accounts.pit_fund.last_buyback_ts + ctx.accounts.pit_fund.min_interval_secs,
            ClankerError::CooldownActive
        );

        // P/F × 100: FDV = price × supply_tokens (1e9); pf = FDV / annual_fees.
        let supply_tokens: u128 = (CLANK_TOTAL_SUPPLY / 1_000_000_000) as u128;
        let fdv = (clank_price_usdc6 as u128) * supply_tokens;
        let pf_x100 = (fdv * 100 / (fees_annualized_usdc6 as u128)).min(u64::MAX as u128) as u64;

        // value-aware ceiling
        let allowed = buyback_allowance(
            ctx.accounts.pit_fund.max_per_call_usdc,
            pf_x100,
            ctx.accounts.pit_fund.pf_cheap_x100,
            ctx.accounts.pit_fund.pf_rich_x100,
        );
        require!(allowed > 0 && usdc_out <= allowed, ClankerError::BuybackThrottled);

        // slippage: implied price (USDC 6dp per 1e9-base CLANK) must not exceed max.
        let implied = (usdc_out as u128) * 1_000_000_000 / (clank_in as u128);
        require!(implied <= max_price_usdc6 as u128, ClankerError::BuybackSlippage);

        // CLANK in: keeper -> clank_vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.keeper_clank.to_account_info(),
                    to: ctx.accounts.clank_vault.to_account_info(),
                    authority: ctx.accounts.keeper.to_account_info(),
                },
            ),
            clank_in,
        )?;
        // USDC out: usdc_vault -> keeper (PDA-signed)
        let bump = ctx.bumps.pit_authority;
        let signer: &[&[&[u8]]] = &[&[PIT_AUTH_SEED, &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.usdc_vault.to_account_info(),
                    to: ctx.accounts.keeper_usdc.to_account_info(),
                    authority: ctx.accounts.pit_authority.to_account_info(),
                },
                signer,
            ),
            usdc_out,
        )?;
        // burn the configured share of the acquired $CLANK (PDA-signed)
        let burn_amt = ((clank_in as u128) * (ctx.accounts.pit_fund.burn_bps as u128) / 10_000) as u64;
        if burn_amt > 0 {
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.clank_mint.to_account_info(),
                        from: ctx.accounts.clank_vault.to_account_info(),
                        authority: ctx.accounts.pit_authority.to_account_info(),
                    },
                    signer,
                ),
                burn_amt,
            )?;
        }
        let p = &mut ctx.accounts.pit_fund;
        p.clank_bought = p.clank_bought.checked_add(clank_in).ok_or(ClankerError::Overflow)?;
        p.clank_burned = p.clank_burned.checked_add(burn_amt).ok_or(ClankerError::Overflow)?;
        p.last_buyback_ts = now;
        emit!(BuybackExecuted { usdc_out, clank_in, burned: burn_amt, pf_x100 });
        Ok(())
    }

    /// Governance: retune the buyback band, cap, interval, burn split, or keeper.
    pub fn set_buyback_params(
        ctx: Context<SetBuybackParams>,
        keeper: Pubkey,
        pf_cheap_x100: u64,
        pf_rich_x100: u64,
        max_per_call_usdc: u64,
        min_interval_secs: i64,
        burn_bps: u16,
    ) -> Result<()> {
        require!(pf_rich_x100 > pf_cheap_x100, ClankerError::BadEmissionParams);
        require!(burn_bps <= 10_000 && min_interval_secs >= 0, ClankerError::BadEmissionParams);
        let p = &mut ctx.accounts.pit_fund;
        p.keeper = keeper;
        p.pf_cheap_x100 = pf_cheap_x100;
        p.pf_rich_x100 = pf_rich_x100;
        p.max_per_call_usdc = max_per_call_usdc;
        p.min_interval_secs = min_interval_secs;
        p.burn_bps = burn_bps;
        emit!(BuybackParamsSet { keeper, pf_cheap_x100, pf_rich_x100, burn_bps });
        Ok(())
    }

    // ----- Slashing — bonded verifiers + dispute window (SPEC §6) ------------

    /// One-time slashing init: the $CLANK slash vault (holds verifier bonds and
    /// in-flight challenger bonds) + the `SlashConfig` policy. `authority` is the
    /// dispute resolver (governance/DAO). `slash_bps` is the fraction of a
    /// verifier's bond burned when a dispute is upheld; `challenger_bond` is the
    /// $CLANK a challenger must post (returned if upheld, burned if frivolous).
    pub fn init_slashing(
        ctx: Context<InitSlashing>,
        dispute_window_secs: i64,
        slash_bps: u16,
        challenger_bond: u64,
    ) -> Result<()> {
        require!(slash_bps <= 10_000 && dispute_window_secs >= 0, ClankerError::BadEmissionParams);
        let c = &mut ctx.accounts.slash_config;
        c.authority = ctx.accounts.authority.key();
        c.clank_mint = ctx.accounts.clank_mint.key();
        c.slash_vault = ctx.accounts.slash_vault.key();
        c.dispute_window_secs = dispute_window_secs;
        c.slash_bps = slash_bps;
        c.challenger_bond = challenger_bond;
        c.bump = ctx.bumps.slash_config;
        Ok(())
    }

    /// Bond $CLANK to act as a verifier (forwarder/judge). Slashable; this is the
    /// stake that makes a corrupt verdict cost more than it could steal
    /// (TOKENOMICS §13.2 security budget).
    pub fn bond_verifier(ctx: Context<BondVerifier>, amount: u64) -> Result<()> {
        require!(amount > 0, ClankerError::BadAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.verifier_clank.to_account_info(),
                    to: ctx.accounts.slash_vault.to_account_info(),
                    authority: ctx.accounts.verifier.to_account_info(),
                },
            ),
            amount,
        )?;
        let b = &mut ctx.accounts.verifier_bond;
        b.verifier = ctx.accounts.verifier.key();
        b.bonded = b.bonded.checked_add(amount).ok_or(ClankerError::Overflow)?;
        b.bump = ctx.bumps.verifier_bond;
        emit!(VerifierBonded { verifier: b.verifier, bonded: b.bonded });
        Ok(())
    }

    /// Withdraw verifier bond. Blocked while any dispute against this verifier is
    /// open (you can't exit ahead of a slash).
    pub fn unbond_verifier(ctx: Context<UnbondVerifier>, amount: u64) -> Result<()> {
        let b = &mut ctx.accounts.verifier_bond;
        require!(amount > 0 && amount <= b.bonded, ClankerError::BadAmount);
        require!(b.open_disputes == 0, ClankerError::HasOpenDisputes);
        let bump = ctx.bumps.slash_authority;
        let signer: &[&[&[u8]]] = &[&[SLASH_AUTH_SEED, &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.slash_vault.to_account_info(),
                    to: ctx.accounts.verifier_clank.to_account_info(),
                    authority: ctx.accounts.slash_authority.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
        b.bonded -= amount;
        emit!(VerifierUnbonded { verifier: b.verifier, remaining: b.bonded });
        Ok(())
    }

    /// Open a dispute against a verifier's verdict for `job_hash`. The challenger
    /// posts `challenger_bond` $CLANK into the slash vault; the slash amount is
    /// snapshotted from the verifier's current bond. Starts the resolution window.
    pub fn open_dispute(ctx: Context<OpenDispute>, job_hash: [u8; 32]) -> Result<()> {
        let cfg = &ctx.accounts.slash_config;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.challenger_clank.to_account_info(),
                    to: ctx.accounts.slash_vault.to_account_info(),
                    authority: ctx.accounts.challenger.to_account_info(),
                },
            ),
            cfg.challenger_bond,
        )?;
        let vb = &mut ctx.accounts.verifier_bond;
        vb.open_disputes = vb.open_disputes.checked_add(1).ok_or(ClankerError::Overflow)?;
        let d = &mut ctx.accounts.dispute;
        d.job_hash = job_hash;
        d.verifier = vb.verifier;
        d.challenger = ctx.accounts.challenger.key();
        d.challenger_bond = cfg.challenger_bond;
        d.slash_amount = slash_amount(vb.bonded, cfg.slash_bps);
        d.opened_at = Clock::get()?.unix_timestamp;
        d.resolved = false;
        d.upheld = false;
        d.bump = ctx.bumps.dispute;
        emit!(DisputeOpened { job_hash, verifier: d.verifier, challenger: d.challenger, slash_amount: d.slash_amount });
        Ok(())
    }

    /// Resolve a dispute after its window. Resolver-gated. If **upheld**: burn the
    /// slash amount from the verifier's bond and return the challenger's bond. If
    /// **rejected**: burn the challenger's bond (frivolous-dispute cost). Slashed
    /// $CLANK is always **burned, never paid to the challenger** — so there is no
    /// incentive to false-accuse (SPEC §6).
    pub fn resolve_dispute(ctx: Context<ResolveDispute>, upheld: bool) -> Result<()> {
        require!(!ctx.accounts.dispute.resolved, ClankerError::DisputeResolved);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx.accounts.dispute.opened_at + ctx.accounts.slash_config.dispute_window_secs,
            ClankerError::DisputeWindowActive
        );
        let bump = ctx.bumps.slash_authority;
        let signer: &[&[&[u8]]] = &[&[SLASH_AUTH_SEED, &[bump]]];

        if upheld {
            // burn the slash (clamped to the verifier's current bond)
            let vb = &mut ctx.accounts.verifier_bond;
            let slash = ctx.accounts.dispute.slash_amount.min(vb.bonded);
            if slash > 0 {
                token::burn(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Burn {
                            mint: ctx.accounts.clank_mint.to_account_info(),
                            from: ctx.accounts.slash_vault.to_account_info(),
                            authority: ctx.accounts.slash_authority.to_account_info(),
                        },
                        signer,
                    ),
                    slash,
                )?;
                vb.bonded -= slash;
                vb.slashed = vb.slashed.checked_add(slash).ok_or(ClankerError::Overflow)?;
            }
            // return the challenger's bond
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.slash_vault.to_account_info(),
                        to: ctx.accounts.challenger_clank.to_account_info(),
                        authority: ctx.accounts.slash_authority.to_account_info(),
                    },
                    signer,
                ),
                ctx.accounts.dispute.challenger_bond,
            )?;
        } else {
            // frivolous: burn the challenger's bond
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.clank_mint.to_account_info(),
                        from: ctx.accounts.slash_vault.to_account_info(),
                        authority: ctx.accounts.slash_authority.to_account_info(),
                    },
                    signer,
                ),
                ctx.accounts.dispute.challenger_bond,
            )?;
        }

        let vb = &mut ctx.accounts.verifier_bond;
        vb.open_disputes = vb.open_disputes.saturating_sub(1);
        let d = &mut ctx.accounts.dispute;
        d.resolved = true;
        d.upheld = upheld;
        emit!(DisputeResolved { job_hash: d.job_hash, verifier: d.verifier, upheld });
        Ok(())
    }

    // ----- Governance setters (TOKENOMICS §11 open parameters) ---------------

    /// Retune the emission schedule: min operator bond, epoch length, and the
    /// decay applied to the cap + reward each `roll_epoch`. Governance-gated.
    pub fn set_emission_params(
        ctx: Context<TokenGovern>,
        min_operator_bond: u64,
        epoch_len: i64,
        decay_num: u64,
        decay_den: u64,
    ) -> Result<()> {
        require!(decay_den > 0 && decay_num <= decay_den && epoch_len > 0, ClankerError::BadEmissionParams);
        let tc = &mut ctx.accounts.token_config;
        tc.min_operator_bond = min_operator_bond;
        tc.epoch_len = epoch_len;
        tc.decay_num = decay_num;
        tc.decay_den = decay_den;
        emit!(EmissionParamsSet { min_operator_bond, epoch_len, decay_num, decay_den });
        Ok(())
    }

    /// Rotate the governance authority (e.g. hand off to a DAO/Squads multisig).
    pub fn set_token_authority(ctx: Context<TokenGovern>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.token_config.authority = new_authority;
        emit!(TokenAuthoritySet { new_authority });
        Ok(())
    }

    /// Set the unstake cooldown on the stake pool. Governance-gated via `TokenConfig`.
    pub fn set_stake_cooldown(ctx: Context<SetStakeCooldown>, cooldown_secs: i64) -> Result<()> {
        require!(cooldown_secs >= 0, ClankerError::BadAmount);
        ctx.accounts.stake_pool.cooldown_secs = cooldown_secs;
        emit!(StakeCooldownSet { cooldown_secs });
        Ok(())
    }

    /// Retune slashing policy and/or rotate the dispute resolver. Gated by the
    /// current resolver (`SlashConfig.authority`).
    pub fn set_slash_params(
        ctx: Context<SetSlashParams>,
        dispute_window_secs: i64,
        slash_bps: u16,
        challenger_bond: u64,
        new_resolver: Pubkey,
    ) -> Result<()> {
        require!(slash_bps <= 10_000 && dispute_window_secs >= 0, ClankerError::BadEmissionParams);
        let c = &mut ctx.accounts.slash_config;
        c.dispute_window_secs = dispute_window_secs;
        c.slash_bps = slash_bps;
        c.challenger_bond = challenger_bond;
        c.authority = new_resolver;
        emit!(SlashParamsSet { dispute_window_secs, slash_bps, challenger_bond, new_resolver });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

pub const CONFIG_SEED: &[u8] = b"config";
pub const RACE_SEED: &[u8] = b"race";
pub const VAULT_SEED: &[u8] = b"vault";
pub const VAULT_AUTH_SEED: &[u8] = b"vault_auth";
pub const MARKET_SEED: &[u8] = b"market";
pub const MARKET_VAULT_SEED: &[u8] = b"market_vault";
pub const MARKET_VAULT_AUTH_SEED: &[u8] = b"market_vault_auth";
pub const BET_SEED: &[u8] = b"bet";
pub const NULLIFIER_SEED: &[u8] = b"nullifier";
pub const AGENT_SEED: &[u8] = b"agent";
pub const FEEDBACK_SEED: &[u8] = b"feedback";
pub const PASS_CONFIG_SEED: &[u8] = b"pass_config";
pub const PASS_SEED: &[u8] = b"pass";
pub const TREASURY_CONFIG_SEED: &[u8] = b"treasury_config";
pub const TREASURY_VAULT_SEED: &[u8] = b"treasury_vault";
pub const TREASURY_AUTH_SEED: &[u8] = b"treasury_auth";
pub const ATTEST_CONFIG_SEED: &[u8] = b"attest_config";
pub const ATTEST_SEED: &[u8] = b"attest";

// $CLANK token-engine seeds (docs/TOKEN_PROGRAM_SPEC.md).
pub const TOKEN_CONFIG_SEED: &[u8] = b"token_config";
pub const CLANK_MINT_AUTH_SEED: &[u8] = b"clank_mint_auth";
pub const EPOCH_SEED: &[u8] = b"epoch";
pub const OP_BOND_SEED: &[u8] = b"op_bond";
pub const BOND_VAULT_SEED: &[u8] = b"bond_vault";
pub const BOND_AUTH_SEED: &[u8] = b"bond_auth";
pub const JOB_CLAIM_SEED: &[u8] = b"job_claim";
pub const STAKE_POOL_SEED: &[u8] = b"stake_pool";
pub const STAKE_VAULT_SEED: &[u8] = b"stake_vault";
pub const YIELD_VAULT_SEED: &[u8] = b"yield_vault";
pub const STAKE_VAULT_AUTH_SEED: &[u8] = b"stake_vault_auth";
pub const STAKE_SEED: &[u8] = b"stake";
pub const PIT_FUND_SEED: &[u8] = b"pit_fund";
pub const PIT_USDC_VAULT_SEED: &[u8] = b"pit_usdc_vault";
pub const PIT_CLANK_VAULT_SEED: &[u8] = b"pit_clank_vault";
pub const PIT_AUTH_SEED: &[u8] = b"pit_auth";
pub const SLASH_CONFIG_SEED: &[u8] = b"slash_config";
pub const SLASH_VAULT_SEED: &[u8] = b"slash_vault";
pub const SLASH_AUTH_SEED: &[u8] = b"slash_auth";
pub const VERIF_BOND_SEED: &[u8] = b"verif_bond";
pub const DISPUTE_SEED: &[u8] = b"dispute";

/// Fixed $CLANK supply (1B at 9 decimals) and the 38% work-emissions bucket —
/// the hard ceiling `accrue_emissions` enforces (`cumulative_minted <= BUCKET`).
pub const CLANK_TOTAL_SUPPLY: u64 = 1_000_000_000 * 1_000_000_000;
pub const EMISSION_BUCKET: u64 = CLANK_TOTAL_SUPPLY / 100 * 38;

/// Consensus score required to settle (matches AttestationConsumer.THRESHOLD).
pub const ATTESTATION_THRESHOLD: u64 = 70;

/// Winners have this long after settlement to `claim` before the operator may
/// `sweep_market` residual dust. 7 days.
pub const CLAIM_WINDOW_SECS: i64 = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Accounts: race escrow
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(constraint = treasury_token.mint == usdc_mint.key() @ ClankerError::BadMint)]
    pub treasury_token: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(race_id: u64)]
pub struct OpenRace<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub facilitator: Signer<'info>,
    #[account(
        init,
        payer = facilitator,
        space = 8 + Race::INIT_SPACE,
        seeds = [RACE_SEED, &race_id.to_le_bytes()],
        bump
    )]
    pub race: Account<'info, Race>,
    #[account(
        init,
        payer = facilitator,
        seeds = [VAULT_SEED, race.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over all race vaults; never holds data.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(constraint = usdc_mint.key() == config.usdc_mint @ ClankerError::BadMint)]
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(race_id: u64)]
pub struct JoinRace<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [RACE_SEED, &race_id.to_le_bytes()], bump = race.bump)]
    pub race: Account<'info, Race>,
    #[account(mut)]
    pub driver: Signer<'info>,
    #[account(mut, constraint = driver_token.owner == driver.key() @ ClankerError::BadDriver)]
    pub driver_token: Account<'info, TokenAccount>,
    #[account(mut, address = race.vault @ ClankerError::BadVault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, address = config.treasury @ ClankerError::BadTreasury)]
    pub treasury_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(race_id: u64)]
pub struct FacilitatorRace<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        constraint = facilitator.key() == config.facilitator @ ClankerError::NotFacilitator
    )]
    pub facilitator: Signer<'info>,
    #[account(mut, seeds = [RACE_SEED, &race_id.to_le_bytes()], bump = race.bump)]
    pub race: Account<'info, Race>,
}

#[derive(Accounts)]
#[instruction(race_id: u64)]
pub struct SettleRace<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = facilitator.key() == config.facilitator @ ClankerError::NotFacilitator)]
    pub facilitator: Signer<'info>,
    #[account(mut, seeds = [RACE_SEED, &race_id.to_le_bytes()], bump = race.bump)]
    pub race: Account<'info, Race>,
    #[account(mut, address = race.vault @ ClankerError::BadVault)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over all race vaults.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub winner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(race_id: u64)]
pub struct CancelRace<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = facilitator.key() == config.facilitator @ ClankerError::NotFacilitator)]
    pub facilitator: Signer<'info>,
    #[account(mut, seeds = [RACE_SEED, &race_id.to_le_bytes()], bump = race.bump)]
    pub race: Account<'info, Race>,
    #[account(mut, address = race.vault @ ClankerError::BadVault)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over all race vaults.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub challenger_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub opponent_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OperatorOnly<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = authority.key() == config.authority @ ClankerError::NotOperator)]
    pub authority: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Accounts: parimutuel market
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct OpenMarket<'info> {
    #[account(
        init,
        payer = judge,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub judge: Signer<'info>,
    #[account(
        init,
        payer = judge,
        seeds = [MARKET_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market_vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: per-market PDA authority over the betting vault.
    #[account(seeds = [MARKET_VAULT_AUTH_SEED, market.key().as_ref()], bump)]
    pub market_vault_authority: UncheckedAccount<'info>,
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(market_id: u64, racer: u8, amount: u64, world_nullifier: [u8; 32])]
pub struct PlaceBet<'info> {
    #[account(mut, seeds = [MARKET_SEED, &market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(mut, constraint = bettor_token.owner == bettor.key() @ ClankerError::BadDriver)]
    pub bettor_token: Account<'info, TokenAccount>,
    #[account(mut, address = market.vault @ ClankerError::BadVault)]
    pub vault: Account<'info, TokenAccount>,
    // One bet per bettor: init fails if this PDA already exists.
    #[account(
        init,
        payer = bettor,
        space = 8 + Bet::INIT_SPACE,
        seeds = [BET_SEED, market.key().as_ref(), bettor.key().as_ref()],
        bump
    )]
    pub bet: Account<'info, Bet>,
    // One human per market: init fails if this nullifier was already used.
    #[account(
        init,
        payer = bettor,
        space = 8 + Nullifier::INIT_SPACE,
        seeds = [NULLIFIER_SEED, market.key().as_ref(), &world_nullifier],
        bump
    )]
    pub nullifier: Account<'info, Nullifier>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct SettleMarket<'info> {
    #[account(mut, seeds = [MARKET_SEED, &market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(constraint = judge.key() == market.judge @ ClankerError::NotJudge)]
    pub judge: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct Claim<'info> {
    #[account(seeds = [MARKET_SEED, &market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(
        mut,
        seeds = [BET_SEED, market.key().as_ref(), bettor.key().as_ref()],
        bump = bet.bump,
        constraint = bet.bettor == bettor.key() @ ClankerError::BadDriver
    )]
    pub bet: Account<'info, Bet>,
    #[account(mut, address = market.vault @ ClankerError::BadVault)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: per-market PDA authority over the betting vault.
    #[account(seeds = [MARKET_VAULT_AUTH_SEED, market.key().as_ref()], bump)]
    pub market_vault_authority: UncheckedAccount<'info>,
    #[account(mut, constraint = bettor_token.owner == bettor.key() @ ClankerError::BadDriver)]
    pub bettor_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct SetJudge<'info> {
    #[account(mut, seeds = [MARKET_SEED, &market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(constraint = operator.key() == market.operator @ ClankerError::NotOperator)]
    pub operator: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct SweepMarket<'info> {
    #[account(seeds = [MARKET_SEED, &market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(constraint = operator.key() == market.operator @ ClankerError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(mut, address = market.vault @ ClankerError::BadVault)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: per-market PDA authority over the betting vault.
    #[account(seeds = [MARKET_VAULT_AUTH_SEED, market.key().as_ref()], bump)]
    pub market_vault_authority: UncheckedAccount<'info>,
    #[account(mut, constraint = recipient.mint == market.usdc_mint @ ClankerError::BadMint)]
    pub recipient: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// Accounts: reputation
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(agent_id: u64)]
pub struct RegisterAgent<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Agent::INIT_SPACE,
        seeds = [AGENT_SEED, &agent_id.to_le_bytes()],
        bump
    )]
    pub agent: Account<'info, Agent>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_id: u64)]
pub struct GiveFeedback<'info> {
    #[account(mut, seeds = [AGENT_SEED, &agent_id.to_le_bytes()], bump = agent.bump)]
    pub agent: Account<'info, Agent>,
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(
        init,
        payer = client,
        space = 8 + Feedback::INIT_SPACE,
        seeds = [FEEDBACK_SEED, agent.key().as_ref(), &agent.count.to_le_bytes()],
        bump
    )]
    pub feedback: Account<'info, Feedback>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Accounts: EventPass + Treasury
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitEventPass<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + PassConfig::INIT_SPACE,
        seeds = [PASS_CONFIG_SEED],
        bump
    )]
    pub pass_config: Account<'info, PassConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pass_id: u64)]
pub struct MintPass<'info> {
    #[account(mut, seeds = [PASS_CONFIG_SEED], bump = pass_config.bump)]
    pub pass_config: Account<'info, PassConfig>,
    #[account(mut)]
    pub minter: Signer<'info>,
    #[account(
        init,
        payer = minter,
        space = 8 + Pass::INIT_SPACE,
        seeds = [PASS_SEED, &pass_id.to_le_bytes()],
        bump
    )]
    pub pass: Account<'info, Pass>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitTreasury<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + TreasuryConfig::INIT_SPACE,
        seeds = [TREASURY_CONFIG_SEED],
        bump
    )]
    pub treasury_config: Account<'info, TreasuryConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        seeds = [TREASURY_VAULT_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = treasury_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over the treasury vault.
    #[account(seeds = [TREASURY_AUTH_SEED], bump)]
    pub treasury_authority: UncheckedAccount<'info>,
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    #[account(seeds = [TREASURY_CONFIG_SEED], bump = treasury_config.bump)]
    pub treasury_config: Account<'info, TreasuryConfig>,
    #[account(constraint = owner.key() == treasury_config.owner @ ClankerError::NotOwner)]
    pub owner: Signer<'info>,
    #[account(mut, address = treasury_config.vault @ ClankerError::BadVault)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over the treasury vault.
    #[account(seeds = [TREASURY_AUTH_SEED], bump)]
    pub treasury_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub recipient: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetTreasuryOwner<'info> {
    #[account(mut, seeds = [TREASURY_CONFIG_SEED], bump = treasury_config.bump)]
    pub treasury_config: Account<'info, TreasuryConfig>,
    #[account(constraint = owner.key() == treasury_config.owner @ ClankerError::NotOwner)]
    pub owner: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Accounts: AttestationConsumer
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitAttestation<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + AttestConfig::INIT_SPACE,
        seeds = [ATTEST_CONFIG_SEED],
        bump
    )]
    pub attest_config: Account<'info, AttestConfig>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetForwarder<'info> {
    #[account(mut, seeds = [ATTEST_CONFIG_SEED], bump = attest_config.bump)]
    pub attest_config: Account<'info, AttestConfig>,
    #[account(constraint = owner.key() == attest_config.owner @ ClankerError::NotOwner)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(job_hash: [u8; 32])]
pub struct WriteAttestation<'info> {
    #[account(seeds = [ATTEST_CONFIG_SEED], bump = attest_config.bump)]
    pub attest_config: Account<'info, AttestConfig>,
    #[account(mut)]
    pub reporter: Signer<'info>,
    // Upsert: re-reporting the same job overwrites the verdict (matches EVM).
    #[account(
        init_if_needed,
        payer = reporter,
        space = 8 + Attestation::INIT_SPACE,
        seeds = [ATTEST_SEED, &job_hash],
        bump
    )]
    pub attestation: Account<'info, Attestation>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Accounts: $CLANK token-emissions engine
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitToken<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + TokenConfig::INIT_SPACE,
        seeds = [TOKEN_CONFIG_SEED],
        bump
    )]
    pub token_config: Account<'info, TokenConfig>,
    #[account(
        init,
        payer = authority,
        space = 8 + EmissionEpoch::INIT_SPACE,
        seeds = [EPOCH_SEED, &0u64.to_le_bytes()],
        bump
    )]
    pub epoch: Account<'info, EmissionEpoch>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub clank_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_id: u64)]
pub struct BondOperator<'info> {
    #[account(seeds = [TOKEN_CONFIG_SEED], bump = token_config.bump)]
    pub token_config: Account<'info, TokenConfig>,
    #[account(seeds = [AGENT_SEED, &agent_id.to_le_bytes()], bump = agent.bump)]
    pub agent: Account<'info, Agent>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        constraint = owner_clank.mint == token_config.clank_mint @ ClankerError::BadMint,
        constraint = owner_clank.owner == owner.key() @ ClankerError::BadDriver
    )]
    pub owner_clank: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        seeds = [BOND_VAULT_SEED, agent.key().as_ref()],
        bump,
        token::mint = clank_mint,
        token::authority = bond_authority
    )]
    pub bond_vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over all bond vaults; never holds data.
    #[account(seeds = [BOND_AUTH_SEED], bump)]
    pub bond_authority: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + OperatorBond::INIT_SPACE,
        seeds = [OP_BOND_SEED, agent.key().as_ref()],
        bump
    )]
    pub operator_bond: Account<'info, OperatorBond>,
    #[account(address = token_config.clank_mint @ ClankerError::BadMint)]
    pub clank_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(agent_id: u64, job_hash: [u8; 32])]
pub struct AccrueEmissions<'info> {
    #[account(mut, seeds = [TOKEN_CONFIG_SEED], bump = token_config.bump)]
    pub token_config: Account<'info, TokenConfig>,
    #[account(
        mut,
        seeds = [EPOCH_SEED, &token_config.current_epoch.to_le_bytes()],
        bump = epoch.bump
    )]
    pub epoch: Account<'info, EmissionEpoch>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, constraint = facilitator.key() == config.facilitator @ ClankerError::NotFacilitator)]
    pub facilitator: Signer<'info>,
    #[account(seeds = [AGENT_SEED, &agent_id.to_le_bytes()], bump = agent.bump)]
    pub agent: Account<'info, Agent>,
    #[account(seeds = [OP_BOND_SEED, agent.key().as_ref()], bump = operator_bond.bump)]
    pub operator_bond: Account<'info, OperatorBond>,
    #[account(seeds = [ATTEST_SEED, &job_hash], bump = attestation.bump)]
    pub attestation: Account<'info, Attestation>,
    /// Any genuine requester `Feedback` PDA for this agent (fields checked in-handler).
    pub feedback: Account<'info, Feedback>,
    #[account(mut, address = token_config.clank_mint @ ClankerError::BadMint)]
    pub clank_mint: Account<'info, Mint>,
    /// CHECK: PDA $CLANK mint authority; signs the mint via seeds.
    #[account(seeds = [CLANK_MINT_AUTH_SEED], bump = token_config.mint_auth_bump)]
    pub mint_authority: UncheckedAccount<'info>,
    #[account(mut, constraint = operator_clank.mint == token_config.clank_mint @ ClankerError::BadMint)]
    pub operator_clank: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = facilitator,
        space = 8 + JobClaim::INIT_SPACE,
        seeds = [JOB_CLAIM_SEED, agent.key().as_ref(), &job_hash],
        bump
    )]
    pub job_claim: Account<'info, JobClaim>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(next_epoch_id: u64)]
pub struct RollEpoch<'info> {
    #[account(mut, seeds = [TOKEN_CONFIG_SEED], bump = token_config.bump)]
    pub token_config: Account<'info, TokenConfig>,
    #[account(
        seeds = [EPOCH_SEED, &token_config.current_epoch.to_le_bytes()],
        bump = current_epoch.bump
    )]
    pub current_epoch: Account<'info, EmissionEpoch>,
    #[account(
        init,
        payer = payer,
        space = 8 + EmissionEpoch::INIT_SPACE,
        seeds = [EPOCH_SEED, &next_epoch_id.to_le_bytes()],
        bump
    )]
    pub next_epoch: Account<'info, EmissionEpoch>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Accounts: $CLANK staking
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitStakePool<'info> {
    #[account(init, payer = payer, space = 8 + StakePool::INIT_SPACE, seeds = [STAKE_POOL_SEED], bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init, payer = payer, seeds = [STAKE_VAULT_SEED], bump,
        token::mint = clank_mint, token::authority = stake_vault_authority
    )]
    pub stake_vault: Account<'info, TokenAccount>,
    #[account(
        init, payer = payer, seeds = [YIELD_VAULT_SEED], bump,
        token::mint = usdc_mint, token::authority = stake_vault_authority
    )]
    pub yield_vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over the stake + yield vaults; never holds data.
    #[account(seeds = [STAKE_VAULT_AUTH_SEED], bump)]
    pub stake_vault_authority: UncheckedAccount<'info>,
    pub clank_mint: Account<'info, Mint>,
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundStakerBucket<'info> {
    #[account(mut, seeds = [STAKE_POOL_SEED], bump = stake_pool.bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(
        mut,
        constraint = funder_usdc.owner == funder.key() @ ClankerError::BadDriver,
        constraint = funder_usdc.mint == stake_pool.usdc_mint @ ClankerError::BadMint
    )]
    pub funder_usdc: Account<'info, TokenAccount>,
    #[account(mut, address = stake_pool.yield_vault @ ClankerError::BadVault)]
    pub yield_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut, seeds = [STAKE_POOL_SEED], bump = stake_pool.bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(
        mut,
        constraint = staker_clank.owner == staker.key() @ ClankerError::BadDriver,
        constraint = staker_clank.mint == stake_pool.clank_mint @ ClankerError::BadMint
    )]
    pub staker_clank: Account<'info, TokenAccount>,
    #[account(mut, address = stake_pool.stake_vault @ ClankerError::BadVault)]
    pub stake_vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed, payer = staker, space = 8 + StakeAccount::INIT_SPACE,
        seeds = [STAKE_SEED, staker.key().as_ref()], bump
    )]
    pub stake_account: Account<'info, StakeAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut, seeds = [STAKE_POOL_SEED], bump = stake_pool.bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(
        mut,
        constraint = staker_clank.owner == staker.key() @ ClankerError::BadDriver,
        constraint = staker_clank.mint == stake_pool.clank_mint @ ClankerError::BadMint
    )]
    pub staker_clank: Account<'info, TokenAccount>,
    #[account(mut, address = stake_pool.stake_vault @ ClankerError::BadVault)]
    pub stake_vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over the stake vault.
    #[account(seeds = [STAKE_VAULT_AUTH_SEED], bump)]
    pub stake_vault_authority: UncheckedAccount<'info>,
    #[account(
        mut, seeds = [STAKE_SEED, staker.key().as_ref()], bump = stake_account.bump,
        constraint = stake_account.owner == staker.key() @ ClankerError::NotAgentOwner
    )]
    pub stake_account: Account<'info, StakeAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimYield<'info> {
    #[account(seeds = [STAKE_POOL_SEED], bump = stake_pool.bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(
        mut,
        constraint = staker_usdc.owner == staker.key() @ ClankerError::BadDriver,
        constraint = staker_usdc.mint == stake_pool.usdc_mint @ ClankerError::BadMint
    )]
    pub staker_usdc: Account<'info, TokenAccount>,
    #[account(mut, address = stake_pool.yield_vault @ ClankerError::BadVault)]
    pub yield_vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over the yield vault.
    #[account(seeds = [STAKE_VAULT_AUTH_SEED], bump)]
    pub stake_vault_authority: UncheckedAccount<'info>,
    #[account(
        mut, seeds = [STAKE_SEED, staker.key().as_ref()], bump = stake_account.bump,
        constraint = stake_account.owner == staker.key() @ ClankerError::NotAgentOwner
    )]
    pub stake_account: Account<'info, StakeAccount>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// Accounts: Pit Fund (value-aware buyback)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitPitFund<'info> {
    #[account(init, payer = authority, space = 8 + PitFund::INIT_SPACE, seeds = [PIT_FUND_SEED], bump)]
    pub pit_fund: Account<'info, PitFund>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init, payer = authority, seeds = [PIT_USDC_VAULT_SEED], bump,
        token::mint = usdc_mint, token::authority = pit_authority
    )]
    pub usdc_vault: Account<'info, TokenAccount>,
    #[account(
        init, payer = authority, seeds = [PIT_CLANK_VAULT_SEED], bump,
        token::mint = clank_mint, token::authority = pit_authority
    )]
    pub clank_vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over the Pit Fund vaults; never holds data.
    #[account(seeds = [PIT_AUTH_SEED], bump)]
    pub pit_authority: UncheckedAccount<'info>,
    pub usdc_mint: Account<'info, Mint>,
    pub clank_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundPitFund<'info> {
    #[account(mut, seeds = [PIT_FUND_SEED], bump = pit_fund.bump)]
    pub pit_fund: Account<'info, PitFund>,
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(
        mut,
        constraint = funder_usdc.owner == funder.key() @ ClankerError::BadDriver,
        constraint = funder_usdc.mint == pit_fund.usdc_mint @ ClankerError::BadMint
    )]
    pub funder_usdc: Account<'info, TokenAccount>,
    #[account(mut, address = pit_fund.usdc_vault @ ClankerError::BadVault)]
    pub usdc_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExecuteBuyback<'info> {
    #[account(mut, seeds = [PIT_FUND_SEED], bump = pit_fund.bump)]
    pub pit_fund: Account<'info, PitFund>,
    #[account(constraint = keeper.key() == pit_fund.keeper @ ClankerError::Unauthorized)]
    pub keeper: Signer<'info>,
    #[account(
        mut,
        constraint = keeper_clank.owner == keeper.key() @ ClankerError::BadDriver,
        constraint = keeper_clank.mint == pit_fund.clank_mint @ ClankerError::BadMint
    )]
    pub keeper_clank: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = keeper_usdc.owner == keeper.key() @ ClankerError::BadDriver,
        constraint = keeper_usdc.mint == pit_fund.usdc_mint @ ClankerError::BadMint
    )]
    pub keeper_usdc: Account<'info, TokenAccount>,
    #[account(mut, address = pit_fund.usdc_vault @ ClankerError::BadVault)]
    pub usdc_vault: Account<'info, TokenAccount>,
    #[account(mut, address = pit_fund.clank_vault @ ClankerError::BadVault)]
    pub clank_vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over the Pit Fund vaults.
    #[account(seeds = [PIT_AUTH_SEED], bump)]
    pub pit_authority: UncheckedAccount<'info>,
    #[account(mut, address = pit_fund.clank_mint @ ClankerError::BadMint)]
    pub clank_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetBuybackParams<'info> {
    #[account(mut, seeds = [PIT_FUND_SEED], bump = pit_fund.bump)]
    pub pit_fund: Account<'info, PitFund>,
    #[account(constraint = authority.key() == pit_fund.authority @ ClankerError::NotOwner)]
    pub authority: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Accounts: slashing
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitSlashing<'info> {
    #[account(init, payer = authority, space = 8 + SlashConfig::INIT_SPACE, seeds = [SLASH_CONFIG_SEED], bump)]
    pub slash_config: Account<'info, SlashConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init, payer = authority, seeds = [SLASH_VAULT_SEED], bump,
        token::mint = clank_mint, token::authority = slash_authority
    )]
    pub slash_vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over the slash vault; never holds data.
    #[account(seeds = [SLASH_AUTH_SEED], bump)]
    pub slash_authority: UncheckedAccount<'info>,
    pub clank_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct BondVerifier<'info> {
    #[account(seeds = [SLASH_CONFIG_SEED], bump = slash_config.bump)]
    pub slash_config: Account<'info, SlashConfig>,
    #[account(mut)]
    pub verifier: Signer<'info>,
    #[account(
        mut,
        constraint = verifier_clank.owner == verifier.key() @ ClankerError::BadDriver,
        constraint = verifier_clank.mint == slash_config.clank_mint @ ClankerError::BadMint
    )]
    pub verifier_clank: Account<'info, TokenAccount>,
    #[account(mut, address = slash_config.slash_vault @ ClankerError::BadVault)]
    pub slash_vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed, payer = verifier, space = 8 + VerifierBond::INIT_SPACE,
        seeds = [VERIF_BOND_SEED, verifier.key().as_ref()], bump
    )]
    pub verifier_bond: Account<'info, VerifierBond>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnbondVerifier<'info> {
    #[account(seeds = [SLASH_CONFIG_SEED], bump = slash_config.bump)]
    pub slash_config: Account<'info, SlashConfig>,
    #[account(mut)]
    pub verifier: Signer<'info>,
    #[account(
        mut,
        constraint = verifier_clank.owner == verifier.key() @ ClankerError::BadDriver,
        constraint = verifier_clank.mint == slash_config.clank_mint @ ClankerError::BadMint
    )]
    pub verifier_clank: Account<'info, TokenAccount>,
    #[account(mut, address = slash_config.slash_vault @ ClankerError::BadVault)]
    pub slash_vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over the slash vault.
    #[account(seeds = [SLASH_AUTH_SEED], bump)]
    pub slash_authority: UncheckedAccount<'info>,
    #[account(
        mut, seeds = [VERIF_BOND_SEED, verifier.key().as_ref()], bump = verifier_bond.bump,
        constraint = verifier_bond.verifier == verifier.key() @ ClankerError::NotAgentOwner
    )]
    pub verifier_bond: Account<'info, VerifierBond>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(job_hash: [u8; 32])]
pub struct OpenDispute<'info> {
    #[account(seeds = [SLASH_CONFIG_SEED], bump = slash_config.bump)]
    pub slash_config: Account<'info, SlashConfig>,
    #[account(mut)]
    pub challenger: Signer<'info>,
    #[account(
        mut,
        constraint = challenger_clank.owner == challenger.key() @ ClankerError::BadDriver,
        constraint = challenger_clank.mint == slash_config.clank_mint @ ClankerError::BadMint
    )]
    pub challenger_clank: Account<'info, TokenAccount>,
    #[account(mut, address = slash_config.slash_vault @ ClankerError::BadVault)]
    pub slash_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [VERIF_BOND_SEED, verifier_bond.verifier.as_ref()], bump = verifier_bond.bump)]
    pub verifier_bond: Account<'info, VerifierBond>,
    #[account(
        init, payer = challenger, space = 8 + Dispute::INIT_SPACE,
        seeds = [DISPUTE_SEED, &job_hash, verifier_bond.verifier.as_ref()], bump
    )]
    pub dispute: Account<'info, Dispute>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(seeds = [SLASH_CONFIG_SEED], bump = slash_config.bump)]
    pub slash_config: Account<'info, SlashConfig>,
    #[account(constraint = authority.key() == slash_config.authority @ ClankerError::NotOwner)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [DISPUTE_SEED, &dispute.job_hash, dispute.verifier.as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Account<'info, Dispute>,
    #[account(
        mut, seeds = [VERIF_BOND_SEED, dispute.verifier.as_ref()], bump = verifier_bond.bump
    )]
    pub verifier_bond: Account<'info, VerifierBond>,
    #[account(mut, address = slash_config.slash_vault @ ClankerError::BadVault)]
    pub slash_vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority over the slash vault.
    #[account(seeds = [SLASH_AUTH_SEED], bump)]
    pub slash_authority: UncheckedAccount<'info>,
    #[account(mut, address = slash_config.clank_mint @ ClankerError::BadMint)]
    pub clank_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = challenger_clank.owner == dispute.challenger @ ClankerError::BadDriver,
        constraint = challenger_clank.mint == slash_config.clank_mint @ ClankerError::BadMint
    )]
    pub challenger_clank: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// Accounts: governance setters
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct TokenGovern<'info> {
    #[account(
        mut, seeds = [TOKEN_CONFIG_SEED], bump = token_config.bump,
        constraint = authority.key() == token_config.authority @ ClankerError::NotOwner
    )]
    pub token_config: Account<'info, TokenConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetStakeCooldown<'info> {
    #[account(mut, seeds = [STAKE_POOL_SEED], bump = stake_pool.bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(
        seeds = [TOKEN_CONFIG_SEED], bump = token_config.bump,
        constraint = authority.key() == token_config.authority @ ClankerError::NotOwner
    )]
    pub token_config: Account<'info, TokenConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetSlashParams<'info> {
    #[account(
        mut, seeds = [SLASH_CONFIG_SEED], bump = slash_config.bump,
        constraint = authority.key() == slash_config.authority @ ClankerError::NotOwner
    )]
    pub slash_config: Account<'info, SlashConfig>,
    pub authority: Signer<'info>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub facilitator: Pubkey,
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,
    pub next_race_id: u64,
    pub total_fees_collected: u64,
    pub bump: u8,
}

// ----- $CLANK token-engine state (sibling of Config; no Config migration) ---

#[account]
#[derive(InitSpace)]
pub struct TokenConfig {
    pub authority: Pubkey,        // governance
    pub clank_mint: Pubkey,
    pub mint_auth_bump: u8,
    pub min_operator_bond: u64,
    pub epoch_len: i64,           // seconds per emission epoch
    pub decay_num: u64,           // cap & reward decay by decay_num/decay_den
    pub decay_den: u64,
    pub current_epoch: u64,
    pub cumulative_minted: u64,   // invariant: <= EMISSION_BUCKET
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct EmissionEpoch {
    pub epoch: u64,
    pub cap: u64,                 // hard ceiling on this epoch's mint
    pub minted: u64,
    pub reward_per_job: u64,
    pub start_ts: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct OperatorBond {
    pub agent: Pubkey,            // the Agent PDA this bond backs
    pub owner: Pubkey,
    pub bonded: u64,              // slashable $CLANK
    pub slashed: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct JobClaim {
    pub agent: Pubkey,
    pub job_hash: [u8; 32],
    pub reward: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct StakePool {
    pub clank_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub stake_vault: Pubkey,           // CLANK held
    pub yield_vault: Pubkey,           // USDC held for distribution
    pub total_staked: u64,
    pub acc_usdc_per_share: u128,      // scaled by ACC_SCALE
    pub cooldown_secs: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct StakeAccount {
    pub owner: Pubkey,
    pub amount: u64,
    pub reward_debt: u128,             // amount × acc at last update
    pub pending_usdc: u64,             // settled-but-unclaimed yield
    pub unstake_ready_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PitFund {
    pub authority: Pubkey,             // governance
    pub keeper: Pubkey,                // permissioned buyback executor / MM
    pub usdc_mint: Pubkey,
    pub clank_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub clank_vault: Pubkey,
    pub usdc_intake: u64,
    pub clank_bought: u64,
    pub clank_burned: u64,
    pub pf_cheap_x100: u64,            // full buyback at/below this P/F×100
    pub pf_rich_x100: u64,             // zero buyback at/above this P/F×100
    pub max_per_call_usdc: u64,        // per-call ceiling (%-ADV proxy)
    pub min_interval_secs: i64,
    pub burn_bps: u16,                 // share of acquired $CLANK to burn
    pub last_buyback_ts: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SlashConfig {
    pub authority: Pubkey,             // dispute resolver (governance/DAO)
    pub clank_mint: Pubkey,
    pub slash_vault: Pubkey,
    pub dispute_window_secs: i64,
    pub slash_bps: u16,                // fraction of a bond burned when upheld
    pub challenger_bond: u64,          // $CLANK a challenger posts
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct VerifierBond {
    pub verifier: Pubkey,
    pub bonded: u64,                   // slashable $CLANK in the slash vault
    pub slashed: u64,
    pub open_disputes: u32,            // can't unbond while > 0
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Dispute {
    pub job_hash: [u8; 32],
    pub verifier: Pubkey,
    pub challenger: Pubkey,
    pub challenger_bond: u64,
    pub slash_amount: u64,             // snapshot at open
    pub opened_at: i64,
    pub resolved: bool,
    pub upheld: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Race {
    pub race_id: u64,
    pub status: RaceStatus,
    pub local_round_id: [u8; 32],
    pub challenger: Pubkey,
    pub opponent: Pubkey,
    pub challenger_joined: bool,
    pub opponent_joined: bool,
    pub stake_amount: u64,
    pub fee_amount: u64,
    pub fees_collected: u64,
    pub winner_slot: u8,
    pub proof_hash: [u8; 32],
    pub created_at: i64,
    pub locked_at: i64,
    pub started_at: i64,
    pub finished_at: i64,
    pub vault: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub market_id: u64,
    pub judge: Pubkey,
    pub operator: Pubkey,
    pub usdc_mint: Pubkey,
    pub open: bool,
    pub settled: bool,
    pub winner: u8,
    pub num_racers: u8,
    pub pools: [u64; MAX_RACERS],
    pub total_pool: u64,
    pub vault: Pubkey,
    pub settled_at: i64,
    pub winning_proof_hash: [u8; 32],
    #[max_len(64)]
    pub walrus_blob_id: String,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Bet {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub racer: u8,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Nullifier {
    pub used: bool,
    pub value: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct Agent {
    pub agent_id: u64,
    pub owner: Pubkey,
    pub count: u64,
    pub sum: i128,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Feedback {
    pub agent: Pubkey,
    pub client: Pubkey,
    pub index: u64,
    pub value: i64,
    pub value_decimals: u8,
    #[max_len(32)]
    pub tag1: String,
    #[max_len(32)]
    pub tag2: String,
    #[max_len(96)]
    pub endpoint: String,
    #[max_len(160)]
    pub feedback_uri: String,
    pub feedback_hash: [u8; 32],
    pub ts: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PassConfig {
    pub minter: Pubkey,
    pub next_id: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Pass {
    pub id: u64,
    pub owner: Pubkey,
    pub price_usdc6: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct TreasuryConfig {
    pub owner: Pubkey,
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AttestConfig {
    pub owner: Pubkey,
    pub forwarder: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Attestation {
    pub score: u64,
    pub proof_hash: [u8; 32],
    pub timestamp: i64,
    pub verified: bool,
    pub exists: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum RaceStatus {
    Created,
    Joined,
    Locked,
    Started,
    Finished,
    Settled,
    Canceled,
}

impl Default for RaceStatus {
    fn default() -> Self {
        RaceStatus::Created
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct RaceOpened {
    pub race_id: u64,
    pub local_round_id: [u8; 32],
    pub stake_amount: u64,
    pub fee_amount: u64,
}
#[event]
pub struct RaceJoined {
    pub race_id: u64,
    pub driver: Pubkey,
    pub slot: u8,
    pub stake_amount: u64,
    pub fee_amount: u64,
}
#[event]
pub struct RaceLocked {
    pub race_id: u64,
}
#[event]
pub struct RaceStarted {
    pub race_id: u64,
}
#[event]
pub struct RaceFinished {
    pub race_id: u64,
    pub winner_slot: u8,
    pub proof_hash: [u8; 32],
}
#[event]
pub struct RaceSettled {
    pub race_id: u64,
    pub winner: Pubkey,
    pub payout: u64,
}
#[event]
pub struct RaceCanceled {
    pub race_id: u64,
    pub reason: String,
}
#[event]
pub struct FacilitatorChanged {
    pub facilitator: Pubkey,
}
#[event]
pub struct MarketOpened {
    pub market_id: u64,
    pub num_racers: u8,
}
#[event]
pub struct BetPlaced {
    pub market_id: u64,
    pub bettor: Pubkey,
    pub racer: u8,
    pub amount: u64,
    pub world_nullifier: [u8; 32],
}
#[event]
pub struct MarketSettled {
    pub market_id: u64,
    pub winner: u8,
    pub proof_hash: [u8; 32],
    pub walrus_blob_id: String,
}
#[event]
pub struct Claimed {
    pub market_id: u64,
    pub bettor: Pubkey,
    pub payout: u64,
}
#[event]
pub struct MarketSwept {
    pub market_id: u64,
    pub amount: u64,
}
#[event]
pub struct JudgeChanged {
    pub market_id: u64,
    pub judge: Pubkey,
}
#[event]
pub struct AgentRegistered {
    pub agent_id: u64,
    pub owner: Pubkey,
}
#[event]
pub struct NewFeedback {
    pub agent_id: u64,
    pub client: Pubkey,
    pub feedback_index: u64,
    pub value: i64,
    pub value_decimals: u8,
    pub tag1: String,
    pub feedback_hash: [u8; 32],
}
#[event]
pub struct PassMinted {
    pub id: u64,
    pub to: Pubkey,
    pub price_usdc6: u64,
}
#[event]
pub struct TokenInitialized {
    pub clank_mint: Pubkey,
    pub epoch0_cap: u64,
    pub reward_per_job: u64,
}
#[event]
pub struct OperatorBonded {
    pub agent: Pubkey,
    pub owner: Pubkey,
    pub bonded: u64,
}
#[event]
pub struct EmissionAccrued {
    pub agent_id: u64,
    pub epoch: u64,
    pub reward: u64,
    pub job_hash: [u8; 32],
}
#[event]
pub struct EpochRolled {
    pub epoch: u64,
    pub cap: u64,
    pub reward_per_job: u64,
}
#[event]
pub struct StakerBucketFunded {
    pub amount: u64,
    pub acc_usdc_per_share: u128,
}
#[event]
pub struct Staked {
    pub owner: Pubkey,
    pub amount: u64,
    pub total: u64,
}
#[event]
pub struct Unstaked {
    pub owner: Pubkey,
    pub amount: u64,
    pub remaining: u64,
}
#[event]
pub struct YieldClaimed {
    pub owner: Pubkey,
    pub amount: u64,
}
#[event]
pub struct PitFundFunded {
    pub amount: u64,
    pub usdc_intake: u64,
}
#[event]
pub struct BuybackExecuted {
    pub usdc_out: u64,
    pub clank_in: u64,
    pub burned: u64,
    pub pf_x100: u64,
}
#[event]
pub struct BuybackParamsSet {
    pub keeper: Pubkey,
    pub pf_cheap_x100: u64,
    pub pf_rich_x100: u64,
    pub burn_bps: u16,
}
#[event]
pub struct VerifierBonded {
    pub verifier: Pubkey,
    pub bonded: u64,
}
#[event]
pub struct VerifierUnbonded {
    pub verifier: Pubkey,
    pub remaining: u64,
}
#[event]
pub struct DisputeOpened {
    pub job_hash: [u8; 32],
    pub verifier: Pubkey,
    pub challenger: Pubkey,
    pub slash_amount: u64,
}
#[event]
pub struct DisputeResolved {
    pub job_hash: [u8; 32],
    pub verifier: Pubkey,
    pub upheld: bool,
}
#[event]
pub struct EmissionParamsSet {
    pub min_operator_bond: u64,
    pub epoch_len: i64,
    pub decay_num: u64,
    pub decay_den: u64,
}
#[event]
pub struct TokenAuthoritySet {
    pub new_authority: Pubkey,
}
#[event]
pub struct StakeCooldownSet {
    pub cooldown_secs: i64,
}
#[event]
pub struct SlashParamsSet {
    pub dispute_window_secs: i64,
    pub slash_bps: u16,
    pub challenger_bond: u64,
    pub new_resolver: Pubkey,
}
#[event]
pub struct TreasuryWithdraw {
    pub to: Pubkey,
    pub amount: u64,
}
#[event]
pub struct TreasuryOwnerChanged {
    pub new_owner: Pubkey,
}
#[event]
pub struct ForwarderSet {
    pub forwarder: Pubkey,
}
#[event]
pub struct AttestationVerified {
    pub job: String,
    pub score: u64,
    pub proof_hash: [u8; 32],
    pub verified: bool,
    pub timestamp: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum ClankerError {
    #[msg("caller is not the facilitator")]
    NotFacilitator,
    #[msg("caller is not the operator")]
    NotOperator,
    #[msg("caller is not the judge")]
    NotJudge,
    #[msg("invalid race state for this action")]
    BadState,
    #[msg("slot must be 0 or 1")]
    BadSlot,
    #[msg("driver invalid for this slot")]
    BadDriver,
    #[msg("amount does not match the race terms")]
    BadAmount,
    #[msg("race id does not match the running counter")]
    BadRaceId,
    #[msg("driver already joined this slot")]
    AlreadyJoined,
    #[msg("wrong mint")]
    BadMint,
    #[msg("wrong vault account")]
    BadVault,
    #[msg("wrong treasury account")]
    BadTreasury,
    #[msg("market is closed")]
    MarketClosed,
    #[msg("market not settled")]
    NotSettled,
    #[msg("bet already claimed")]
    AlreadyClaimed,
    #[msg("bet did not pick the winner")]
    Lost,
    #[msg("invalid racer index")]
    BadRacer,
    #[msg("racer count out of range")]
    BadRacerCount,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("self-feedback not allowed")]
    SelfFeedback,
    #[msg("string field exceeds max length")]
    StringTooLong,
    #[msg("caller is not the pass minter")]
    NotMinter,
    #[msg("pass id does not match the running counter")]
    BadPassId,
    #[msg("caller is not the treasury owner (Ledger approval required)")]
    NotOwner,
    #[msg("reporter is not the authorized forwarder")]
    Unauthorized,
    #[msg("forwarder must not be the zero key")]
    BadForwarder,
    #[msg("market is not settled")]
    MarketNotSettled,
    #[msg("invalid emission parameters")]
    BadEmissionParams,
    #[msg("$CLANK mint authority must be the program PDA")]
    BadMintAuthority,
    #[msg("caller does not own this agent")]
    NotAgentOwner,
    #[msg("job is not oracle-verified")]
    NotVerified,
    #[msg("feedback does not match this agent")]
    FeedbackMismatch,
    #[msg("operator bond does not match this agent")]
    BondMismatch,
    #[msg("operator bond below the minimum")]
    Unbonded,
    #[msg("agent reputation is net-negative")]
    BadReputation,
    #[msg("wrong or stale emission epoch")]
    WrongEpoch,
    #[msg("emission epoch cap reached")]
    EpochCapReached,
    #[msg("emission bucket exhausted")]
    BucketExhausted,
    #[msg("emission epoch window not over")]
    EpochNotOver,
    #[msg("no stakers to distribute to")]
    NoStakers,
    #[msg("unstake cooldown still active")]
    CooldownActive,
    #[msg("nothing to claim")]
    NothingToClaim,
    #[msg("buyback throttled by the value-aware band or per-call cap")]
    BuybackThrottled,
    #[msg("buyback price exceeds the slippage ceiling")]
    BuybackSlippage,
    #[msg("verifier has open disputes; cannot unbond")]
    HasOpenDisputes,
    #[msg("dispute resolution window still active")]
    DisputeWindowActive,
    #[msg("dispute already resolved")]
    DisputeResolved,
}

// ---------------------------------------------------------------------------
// Unit tests (pure logic — run with `cargo test`, no validator required)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{
        buyback_allowance, emission_reward, parimutuel_payout, pending_yield, slash_amount,
        ACC_SCALE,
    };

    #[test]
    fn slash_is_a_bps_fraction_of_the_bond() {
        assert_eq!(slash_amount(10_000, 5_000), 5_000); // 50%
        assert_eq!(slash_amount(10_000, 10_000), 10_000); // 100%
        assert_eq!(slash_amount(10_000, 0), 0);
        assert_eq!(slash_amount(0, 5_000), 0);
    }

    // INVARIANT: a slash never exceeds the bond (so burning it can't underflow
    // the vault), and never overflows on a large bond.
    #[test]
    fn slash_never_exceeds_bond() {
        for bonded in [0u64, 1, 1_000, u64::MAX] {
            for bps in [0u16, 1, 2_500, 10_000] {
                assert!(slash_amount(bonded, bps) <= bonded, "slash > bond at {bonded}/{bps}");
            }
        }
    }

    #[test]
    fn buyback_full_when_cheap_zero_when_rich() {
        // band: full at/below 10x (1000), zero at/above 25x (2500).
        assert_eq!(buyback_allowance(1_000, 800, 1_000, 2_500), 1_000); // cheap -> full
        assert_eq!(buyback_allowance(1_000, 1_000, 1_000, 2_500), 1_000); // at cheap -> full
        assert_eq!(buyback_allowance(1_000, 2_500, 1_000, 2_500), 0); // at rich -> 0
        assert_eq!(buyback_allowance(1_000, 3_000, 1_000, 2_500), 0); // above rich -> 0
    }

    #[test]
    fn buyback_tapers_linearly_in_the_band() {
        // midpoint of [1000, 2500] is 1750 -> half the budget.
        assert_eq!(buyback_allowance(1_000, 1_750, 1_000, 2_500), 500);
        // a misconfigured band (rich <= cheap) is safe (spends nothing).
        assert_eq!(buyback_allowance(1_000, 1_500, 2_000, 2_000), 0);
    }

    // INVARIANT: the value-aware ceiling never increases as the token gets richer
    // (higher P/F) — you never buy back MORE at a higher multiple.
    #[test]
    fn buyback_allowance_is_monotonic_non_increasing_in_pf() {
        let mut prev = u64::MAX;
        for pf in [500u64, 1_000, 1_300, 1_750, 2_200, 2_500, 4_000] {
            let a = buyback_allowance(1_000, pf, 1_000, 2_500);
            assert!(a <= prev, "allowance rose with P/F at {pf}");
            prev = a;
        }
    }

    #[test]
    fn yield_zero_until_pool_funded() {
        // No distributions yet (acc == 0) -> nothing owed.
        assert_eq!(pending_yield(1_000, 0, 0), 0);
    }

    #[test]
    fn yield_is_amount_times_acc_minus_debt() {
        // Pool distributed 5 USDC/share since the staker's snapshot of debt=0.
        let acc = 5 * ACC_SCALE;
        assert_eq!(pending_yield(1_000, acc, 0), 5_000);
        // A staker who joined at this acc (debt = 1_000*acc) is owed nothing yet.
        assert_eq!(pending_yield(1_000, acc, 1_000 * acc), 0);
    }

    // INVARIANT: two stakers splitting one funding event get paid in proportion
    // to stake, and the sum never exceeds what was funded (no over-distribution).
    #[test]
    fn yield_splits_pro_rata_and_is_solvent() {
        let (a, b) = (3_000u64, 1_000u64); // 75% / 25% of a 4_000-share pool
        let funded = 800u64;
        let acc = (funded as u128) * ACC_SCALE / ((a + b) as u128); // both joined at debt 0
        let pa = pending_yield(a, acc, 0);
        let pb = pending_yield(b, acc, 0);
        assert_eq!(pa, 600); // 75% of 800
        assert_eq!(pb, 200); // 25% of 800
        assert!(pa + pb <= funded, "over-distributed the yield pool");
    }

    #[test]
    fn emission_clamps_to_remaining_cap() {
        // A near-full epoch pro-rates the reward down to the headroom.
        assert_eq!(emission_reward(1_000, 0, 0, 500), 500);
        assert_eq!(emission_reward(1_000, 0, 0, 0), 0);
    }

    #[test]
    fn emission_base_when_no_min_bond() {
        // min_bond == 0 disables the stake bonus -> flat base reward.
        assert_eq!(emission_reward(1_000, 9_999, 0, u64::MAX), 1_000);
    }

    #[test]
    fn emission_stake_bonus_saturates_at_25_percent() {
        // bond == min -> no bonus; bond >= 4x min -> full +25%, never more.
        assert_eq!(emission_reward(1_000, 1_000, 1_000, u64::MAX), 1_000);
        assert_eq!(emission_reward(1_000, 4_000, 1_000, u64::MAX), 1_250);
        assert_eq!(emission_reward(1_000, 40_000, 1_000, u64::MAX), 1_250);
        // bond below the minimum earns no bonus (gating happens in the handler).
        assert_eq!(emission_reward(1_000, 500, 1_000, u64::MAX), 1_000);
    }

    // INVARIANT: more bond never reduces the reward, and it is bounded by +25%.
    #[test]
    fn emission_bonus_is_monotonic_and_bounded() {
        let mut prev = 0u64;
        for bond in [1_000u64, 1_500, 2_000, 3_000, 4_000, 8_000] {
            let r = emission_reward(1_000, bond, 1_000, u64::MAX);
            assert!(r >= prev, "reward not monotonic in bond at {bond}");
            prev = r;
        }
        assert!(prev <= 1_250, "bonus exceeded the +25% cap");
    }

    #[test]
    fn empty_winning_pool_pays_zero() {
        // No bets on the winning lane -> nobody can claim against an empty pool.
        assert_eq!(parimutuel_payout(100, 500, 0), 0);
    }

    #[test]
    fn sole_winner_takes_the_whole_pool() {
        // One winner staked the entire winning pool -> they get every lamport.
        assert_eq!(parimutuel_payout(100, 250, 100), 250);
    }

    #[test]
    fn pro_rata_split_is_exact_when_divisible() {
        // total 300, winning lane 200 split 120/80 -> 180/120, summing to total.
        assert_eq!(parimutuel_payout(120, 300, 200), 180);
        assert_eq!(parimutuel_payout(80, 300, 200), 120);
        assert_eq!(180 + 120, 300);
    }

    #[test]
    fn flooring_never_overpays_the_vault() {
        // total 1000, winning lane = three equal 1-unit bets -> floor(1000/3)=333.
        let each = parimutuel_payout(1, 1000, 3);
        assert_eq!(each, 333);
        // Dust (1000 - 999 = 1) stays in the vault; payouts never exceed it.
        assert!(3 * each <= 1000);
    }

    #[test]
    fn no_overflow_at_u64_extremes() {
        // amount == win_pool so payout == total_pool even at the u64 ceiling;
        // the intermediate u128 product (2^64-1)^2 cannot overflow.
        assert_eq!(parimutuel_payout(u64::MAX, u64::MAX, u64::MAX), u64::MAX);
    }

    // INVARIANT (vault solvency + bounded dust): across many pool shapes, the sum
    // of all winners' floored payouts never exceeds total_pool, and the residual
    // dust left for `sweep_market` is strictly < the number of winning bets (each
    // floor loses < 1 unit). This is what makes sweep_market safe — it only ever
    // moves genuine rounding dust, never claimable funds.
    #[test]
    fn vault_is_solvent_and_dust_is_bounded() {
        for extra in [0u64, 1, 2, 5, 7, 13, 100, 999, 1_000_001] {
            for n in 1u64..=8 {
                let each = 1_000_000u64;
                let win_pool = n * each;
                let total_pool = win_pool + extra; // losers add `extra` to the pot
                let sum: u128 = (0..n)
                    .map(|_| parimutuel_payout(each, total_pool, win_pool) as u128)
                    .sum();
                assert!(sum <= total_pool as u128, "overpaid vault: {sum} > {total_pool}");
                let dust = total_pool as u128 - sum;
                assert!(dust < n as u128, "dust {dust} >= winners {n}");
            }
        }
    }

    // INVARIANT (monotonicity): a larger stake never yields a smaller payout for
    // the same pools — no incentive inversion.
    #[test]
    fn payout_is_monotonic_in_stake() {
        let (total, win) = (10_000_000u64, 4_000_000u64);
        let mut prev = 0u64;
        for stake in [1u64, 1_000, 10_000, 100_000, 1_000_000, 4_000_000] {
            let p = parimutuel_payout(stake, total, win);
            assert!(p >= prev, "payout not monotonic at stake {stake}");
            prev = p;
        }
    }
}
