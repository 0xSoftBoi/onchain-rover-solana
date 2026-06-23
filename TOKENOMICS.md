# 🏁 $CLANK — Tokenomics of the Clanker 5000 robot economy

### A work token for a robot labor market, with a Hyperliquid-style revenue→buyback engine bolted onto a DePIN proof-of-physical-work core.

> **One line:** robots earn USDC for *verified* physical work; the protocol skims
> a thin fee on every job, race, and bet; that real revenue autonomously buys
> back **$CLANK**; and $CLANK is what secures the proof layer, rewards the robots
> that actually show up, and governs the network. No VC, no private sale, no
> token you're forced to hold just to hire a robot.

*`$CLANK` is a working name — pick the final ticker before any launch. Numbers
below are a starting proposal, not a commitment; every parameter is meant to be
governance-tunable.*

---

## Executive summary (read this first)

**The thesis in one breath.** Clanker 5000 is a marketplace where AI agents hire
physical robots over HTTP for *cryptographically verified* work, paid in USDC.
$CLANK is the equity-like layer on top: it secures the proof oracle (slashable
stake), rewards the robots that show up (capped emissions), and returns the
protocol's real fee revenue to owners via an autonomous buyback. It blends the two
token models the market actually respects — **Hyperliquid** (real fees → on-market
buyback, no VCs, community-first) and **DePIN burn-and-mint** (tokens minted only
for verified physical work) — while keeping **all usage in USDC** so nobody is
forced to hold a volatile token to hire a robot.

**What the model says (all reproducible in [`scripts/tokenomics_model.py`](scripts/tokenomics_model.py)):**

| Question | Answer |
|---|---|
| **Fair value today** | Median **~$3.5M FDV**, mean ~$8.6M, P95 ~$27M (50k-trial Monte Carlo, audited 15x multiple). Right-skewed venture shape. |
| **What drives it** | **Execution — terminal GMV — dominates** every financial knob combined (§14 tornado). You can't tokenomics your way to value; get the robots hired. |
| **Is it accretive?** | Net shareholder yield (buyback − dilution) is **negative yrs 1–4** (subsidy phase, stated openly) and **flips positive yr 6 / yr 4** as emissions taper below fee growth. The crossover *is* the thesis. |
| **What's it really earning?** | Bottom-up, **hire fees are 78% of revenue; betting is 22% of volume but only 9% of fees** (thin rake) → defensible blended **P/F ≈ 15x**, Hyperliquid territory. |
| **Biggest risk** | **Regulatory, not mechanical** — gambling licensing on the bet rake + staking-yield Howey exposure. Both are *structurable* (§15). |
| **Emission safety** | Hard per-epoch cap that **actually binds** from yr 4 (Base); ~139M minted over 6y (~14% of supply); trends net-deflationary as fees compound. |

**The three non-obvious recommendations:**

1. **Launch at a deliberately *low* FDV (~$10–20M, not $50M).** Same fees over a
   smaller cap make buyback-yield and staking-APR 2.5–5× more attractive *and* let
   the community — not insiders — capture the re-rating upside. The honest move and
   the Hyperliquid-ethos move are the same move (§14).
2. **Ring-fence the betting rake into a licensed entity.** It's ~FDV-neutral
   (median +4%), removes the gambling tail from the token, and makes $CLANK
   Howey-cleaner and CEX-listable — the labor market becomes un-killable by a
   betting-enforcement action (§15).
3. **Make the buyback value-aware (P/F-throttled), not a blind bid.** Buy hard when
   cheap vs. fees, divert to reserve/real-yield when rich — capital allocation, not
   a reflexive pump (§12.2).

**The shape of the bet:** underwrite the *labor market* (durable, 78% of fees, 18x
multiple); treat the buyback as the return-of-capital *policy*, not the thesis; and
launch only after real fees exist, so you sell realized cash flow into a lower
discount rate instead of hope into a high one. **Read on for the mechanism design
(§0–9), the numbers (§10), and the full tradfi workup (§12–16).**

### Contents

**Design** — §0 Principles · §1 Program substrate · §2 Why a token · §3 Utility ·
§4 Revenue · §5 Pit Fund buyback · §6 Supply & emissions · §7 Launch · §8 Flywheel ·
§9 Anti-gaming
**Numbers** — §10 Emission cap & buyback model · §11 Open parameters
**TradFi workup** — §12 Valuation lens (equity reframe, net-of-dilution, SOTP,
risk register) · §13 Staking APR & DCF · §14 Monte Carlo fair value · §15 Legal
ring-fence of the betting rake · §16 GMV decomposition & fee-mix audit

---

## 0. Design principles (why this is "positive like Hyperliquid")

The two token models the market actually respects right now are **Hyperliquid**
(real fees, no VCs, fees flow to the community via an autonomous buyback) and the
**DePIN burn-and-mint** networks like **Helium** and **Hivemapper** (tokens are
minted for *real physical work* and burned by *real demand*). Clanker 5000 is
unusual in that it is **both at once**: it is a fee-generating marketplace *and* a
fleet of physical machines doing attested work. So we borrow the best of each and
refuse the worst of each.

1. **The token is not the unit of account. USDC is.** You hire a robot, pay to
   pilot, and bet in **SPL-USDC** — exactly as the program does today. Nobody is
   forced to buy a volatile token to use the network. (This is the single most
   common DePIN failure: gating *usage* behind the speculative asset. We don't.)
   $CLANK sits *on top* as the coordination, security, and value-capture layer.
2. **Value capture comes from revenue, not inflation.** Like Hyperliquid's
   Assistance Fund — which uses **>99% of trading fees to buy HYPE on the open
   market** and has spent **$1.3B+** doing so — Clanker's **Pit Fund** uses real
   USDC fees to buy $CLANK on-market. The token's floor is throughput, not hype.
3. **Emissions are paid only for *attested* work.** A robot cannot farm tokens by
   claiming it did a job. Rewards require a **Switchboard On-Demand verdict
   (threshold 70)** plus **requester feedback** (the program *forbids
   self-feedback*). This is our proof-of-physical-work, and it's enforced by an
   oracle, not a self-report. It's the Hivemapper lesson — *reward real value
   creation, not manufactured engagement* — made structural.
4. **Community-first supply, no VC overhang.** Hyperliquid put **76%+** of supply
   in community hands and took **zero** outside venture money; the genesis
   airdrop was **31%, fully unlocked**. We mirror that posture: the people who
   piloted, bet, operated robots, and built get the majority; insiders vest
   behind a cliff; there is no private round to dump on retail.
5. **Token launches *after* product-market fit, not before.** Hyperliquid ran for
   a year and earned real fees before TGE. We run a **points season** on live
   USDC volume first, then do a retroactive genesis. No token at the hackathon —
   a *credible commitment* to one.

---

## 1. What already exists in the program (the substrate)

This isn't a greenfield token bolted to a whitepaper. The `clanker5000` Anchor
program already meters everything a token needs to attach to:

| Primitive in `programs/clanker5000/src/lib.rs` | What it gives the token |
|---|---|
| `Config.total_fees_collected` + per-race `fee_amount → treasury_token` | **A live revenue meter.** Every `join_race` already routes a fee to the treasury. This is the Pit Fund's intake. |
| Parimutuel market (`open_market`/`place_bet`/`settle_market`/`claim`) | A second revenue line: add a thin **protocol rake** on the pool (see §4). |
| Reputation registry (`register_agent`/`give_feedback`, running avg, self-feedback rejected) | The **work-quality oracle** that weights emissions. Reputation × stake = dispatch priority. |
| Attestation (`write_attestation`, forwarder-gated, threshold 70) | **Proof-of-physical-work.** Emissions key off `verified`, never off the robot's own claim. |
| EventPass (`mint_pass`, price recorded) + Dutch-auction pricing | A burn sink: passes can be minted with $CLANK, partly burned. |
| World ID nullifier PDA (one-human-one-bet) | **Sybil resistance** on the human side, already structural. |
| Treasury (`withdraw_treasury`, owner-gated by Ledger/Squads) | The **governance boundary** — the human-held key that the token's treasury policy ultimately answers to. |

So the token doesn't require re-architecting anything. It plugs into fee flows,
the reputation running-average, and the attestation gate that are already shipped
and `anchor test`-green.

---

## 2. Why a token at all? (the honest answer)

A robot labor market has three coordination problems that USDC alone doesn't
solve, and a token solves cleanly:

- **Who do you trust to verify work?** The proof layer (attestation forwarder,
  the guard's `judge` role in the market) needs to be *economically* secured, so
  a corrupt verdict costs the verifier money. → **Stake-to-verify, slash-on-fraud.**
- **How do you bootstrap robot supply before demand exists?** Early operators
  take a risk buying a $2k rover with no guarantee of jobs. → **Work emissions**
  subsidize the cold-start, then taper as real fees take over (the DePIN
  bootstrap, done with a hard cap so it can't spiral).
- **Who decides the fee schedule, the emission curve, what robots get listed?**
  → **Governance**, weighted by skin-in-the-game (staked $CLANK), not by USDC
  balance (which is just "who's richest today").

If a mechanism doesn't map to one of those three, it doesn't get a token. No
"governance theater," no utility-by-decree.

---

## 3. $CLANK utility (every line is real, none decorative)

1. **Stake-to-verify (security).** Verifiers — the Switchboard forwarder
   operators and the race `judge`/guard role — bond $CLANK. A verdict that's
   later proven wrong (contradicted by a quorum / successful dispute) is
   **slashed**. This turns "trustless proof" from a slogan into a bonded
   guarantee. Maps directly to `set_forwarder` / `write_attestation` /
   `set_judge`.
2. **Stake-for-fee-share (the Hyperliquid move).** Stakers back the network and
   receive the buyback flow (see §5). Staking also unlocks **fee discounts** on
   hires/pilots (HYPE-style tiered fees) and **dispatch priority**.
3. **Operator bond + reputation weight.** To register an agent that *earns
   emissions*, an operator bonds $CLANK against its `register_agent` identity.
   Fake proofs / fraud (caught by the requester-feedback + attestation pair) slash
   the bond. **Dispatch priority ∝ reputation × stake**, so good actors with skin
   in the game get hired first.
4. **Work emissions (the DePIN engine).** Robots earn $CLANK for each
   *attestation-verified* job, scaled by reputation and skill rarity — capped per
   epoch (§6).
5. **Burn sinks (real demand).** Premium network actions — priority dispatch,
   reputation-boost listings, EventPass minting, named-fleet SNS vanity — are
   paid partly in $CLANK and **partly burned**, à la Hivemapper's burn-on-use.
6. **Governance.** Fee parameters, emission schedule, treasury allocation,
   verifier set, and the robot/skill allowlist. Vote weight = staked $CLANK
   (optionally time-locked, ve-style, so long-term alignment outvotes mercenary
   capital).

---

## 4. Revenue: where the USDC actually comes from

Every one of these is a route the sidecar/program already runs in USDC. The
token adds a thin protocol take-rate on top (all parameters governance-set;
illustrative values below):

| Revenue line | Source | Illustrative protocol take |
|---|---|---|
| **Hire fee** | x402 `/task` — hire a robot for a job | 2–5% of job price |
| **Race entry fee** | existing `fee_amount` on `join_race` | flat per-entry, already wired |
| **Bet rake** | new: thin cut of the parimutuel `total_pool` on `settle_market` | 1–2% (kept low — parimutuel is fragile) |
| **Pilot sessions** | $1 x402 pay-to-pilot sessions | 5–10% of session |
| **Pass sales** | Dutch-auction EventPass | small % of clearing price |

**Crucially, take-rates are low.** Hyperliquid's edge is that it's *cheap* and
the volume is real; a greedy rake kills the flywheel. The protocol wins on
throughput, not margin.

---

## 5. Value accrual: the Pit Fund (our Assistance Fund)

```
hire / race / bet / pilot / pass  ──fees──▶  Treasury (USDC, Ledger-governed)
                                                   │
                              policy split (governance-set, e.g. 60/30/10)
                                ┌──────────────────┼───────────────────┐
                                ▼                  ▼                    ▼
                          PIT FUND            STAKER YIELD          OPS / GRANTS
                     buys $CLANK on-market   (paid in USDC or       (fleet upkeep,
                     → distributes to         bought-back $CLANK)    audits, growth)
                     stakers and/or burns
```

- The **Pit Fund** is Clanker's **Assistance Fund**: an autonomous program that
  takes the protocol's USDC fee revenue and **buys $CLANK on the open market**,
  continuously, proportional to volume. Buy pressure tracks *usage*, not
  sentiment — exactly the property that makes HYPE's buyback respected ($1.3B+
  spent, ~7%-of-mcap annualized pace).
- Bought-back $CLANK can be **(a) streamed to stakers** as real yield or
  **(b) burned**. Hyperliquid's community is literally voting on burning the
  Assistance Fund's stack (~13% of supply); we make the **burn-vs-distribute
  split a governance dial** from day one rather than an afterthought.
- The split between Pit Fund / staker yield / ops is **on-chain and
  Ledger-bounded** — it can't be drained, because moving treasury still requires
  the human clear-sign that's already the climax of the demo (`withdraw_treasury`,
  owner = Ledger/Squads). The token's economics inherit that human governance
  boundary for free.

This is the whole positive thesis in one sentence: **the more useful the robots
are, the more USDC flows, the more $CLANK the protocol buys back — and the robots
themselves are the ones earning it.**

---

## 6. Supply, allocation & emissions

### Fixed supply: 1,000,000,000 $CLANK

Community-first, mirroring the distribution posture markets reward. **No VC
allocation. No private sale.**

| Bucket | % | Notes |
|---|---:|---|
| **Genesis retro airdrop** | **30%** | Fully unlocked at TGE. To real users by *Pit Crew points* (§7): pilots who paid, bettors, robot operators by verified jobs, builders. Mirrors HYPE's 31% unlocked genesis. |
| **Work emissions & community rewards** | **38%** | The DePIN engine — paid over years to robots/operators for *attested* work, plus ongoing usage rewards. Echoes HYPE's ~38.9% "future emissions." |
| **Core contributors** | **20%** | 1-year cliff, then multi-year linear vest. Aligned, not dominant. |
| **Ecosystem & treasury** | **10%** | Grants, audits, fleet expansion, integrations — Ledger/Squads-governed. |
| **Liquidity bootstrap** | **2%** | DEX liquidity + market-making. No lockups needed to *use* the network. |

### Emissions = burn-and-mint equilibrium, with a hard epoch cap

Straight from the Helium/Hivemapper playbook, because uncapped work-emissions are
how DePIN tokens die:

- **Mint:** each epoch, verified jobs mint $CLANK to the robots/operators that did
  them, weighted by `reputation × stake × skill-rarity`. **Hard cap per epoch** —
  if real work exceeds the cap, rewards pro-rate down; printing never runs away.
- **Burn:** premium actions (§3.5) and a slice of fees burn $CLANK. As real demand
  grows, burn rises toward (and ideally past) emission — the network trends
  **deflationary on its own usage**, not on promises.
- **Taper:** emission cap **decays on a published schedule** (e.g. halving-style),
  so subsidy funds the cold-start and then hands off to the Pit Fund (real-revenue)
  flywheel. Emissions are training wheels; buybacks are the engine.

---

## 7. Launch sequence (credible, not extractive)

Hyperliquid's sequencing is half of why it's trusted: **earn first, distribute
retroactively, never pre-sell.**

1. **Now → mainnet:** ship the program, run real USDC volume (hires, races, bets,
   pilots). **No token.** This doc is the commitment.
2. **Pit Crew Season (points):** every paid action and every *verified* robot job
   accrues non-transferable **points**, transparently logged from on-chain events
   (the program already emits `RaceJoined`, `NewFeedback`, attestation writes,
   etc.). World ID keeps the human side one-person-one-identity; the attestation
   gate keeps the robot side honest.
3. **Genesis event:** snapshot points → **30% airdrop, fully unlocked**, to the
   people and robots who actually generated the volume. Liquidity seeded same day.
4. **Steady state:** Pit Fund buybacks begin immediately (they're funded by the
   fees already flowing); work emissions begin under the epoch cap; governance
   goes live.

---

## 8. The flywheel (token-aware version of the one in the README)

```
        hire / pilot / bet (USDC)  ─────────────▶  protocol fees
              ▲                                          │
              │                                          ▼
   more demand, cheaper service                    PIT FUND buys $CLANK
              ▲                                          │
              │                                          ▼
   more verified robot capacity  ◀──  operators stake $CLANK & deploy rovers
              ▲                                          │
              │                                          ▼
   work emissions (capped) + buyback yield  ◀──  attested jobs raise reputation
```

The original flywheel was *proof → reputation → rank → next hire*. The token adds
the missing economic arrow: **proof → reputation → rank → next hire → fees →
buyback → more operators stake & deploy → more capacity → cheaper service → more
demand.** Every loop now funds the next.

---

## 9. Anti-gaming & failure modes (the part most token docs skip)

| Risk | Mitigation (mostly already in the program) |
|---|---|
| **Fake jobs farming emissions** | Emissions require an **attestation verdict (threshold 70) + requester feedback**; **self-feedback is rejected on-chain**. The robot's own claim settles nothing. |
| **Sybil operators / wash-hiring** | Operator **bond + slashing**; reputation is requester-attested; World ID gates the human side (one-human-one-bet PDA already enforced). |
| **Corrupt verifiers** | **Stake-to-verify + slash** on disputed verdicts; verifier set is governance-managed, not fixed. |
| **Emission spiral (the classic DePIN death)** | **Hard per-epoch cap + scheduled taper**; burn sinks scale with real demand; subsidy hands off to revenue buybacks. |
| **Mercenary governance capture** | Time-locked / ve-weighted votes so long-term stakers outvote flash capital; treasury moves still gated by the **Ledger/Squads** human key. |
| **Token required to use network (DePIN footgun)** | Deliberately avoided — **all usage stays in USDC**; $CLANK is opt-in for staking/earning/governing. |
| **Buyback unsustainable if volume dies** | Buyback is a *function of* fees, not a fixed promise — it shrinks gracefully with volume instead of draining a reserve. |

---

## 10. The numbers: emission cap & buyback model

Modeled in [`scripts/tokenomics_model.py`](scripts/tokenomics_model.py) — every
parameter at the top of that file is tunable; re-run to regenerate these tables.
Six-year horizon, weekly epochs. Headline takeaways first, then the tables.

**What the model shows:**

1. **The cap is a real constraint, not decoration.** Caps decay 65%/yr from a
   133M year-1 ceiling. In the **Base** case, work-driven mint demand *exceeds the
   cap from year 4* — so the anti-spiral guard actually binds and rewards pro-rate
   down. In **Bull** it binds from year 2. In **Bear** it never binds. Exactly the
   behavior you want: the cap is slack when work is scarce and bites when work is
   hot.
2. **Actual emissions stay modest.** Base case mints **~139M over 6 years (~14% of
   supply, ~37% of the 380M bucket)** — the rest of the bucket tails out slowly or
   is never minted if work never materializes. You can't over-issue into weak
   demand.
3. **Buyback scales with *usage*, not sentiment.** Base reaches **$1.2M/yr (2.4% of
   a $50M mcap)** by year 6. Bull reaches **Hyperliquid territory — ~9.6% of mcap
   in year 5, ~15% in year 6** (HYPE runs ~7%/yr). Bear stays negligible —
   correctly, the buyback shrinks gracefully instead of draining a reserve to fake
   buy pressure.
4. **It flips net-deflationary as emissions taper and fees compound.** In the Base
   case, net supply (emissions − buyback-burn) turns negative around **year 5–6**
   at a $0.02–$0.05 reference price. The reflexive twist is a *feature*: a **low**
   token price makes the USD-funded buyback burn **more** tokens, which is a
   natural floor; a high price burns fewer but the network is already healthy.

### Emission CAP schedule (the ceiling)

| Year | Annual cap (CLANK) | Weekly cap | Cumulative | % of 1B |
|---|--:|--:|--:|--:|
| 1 | 133,000,000 | 2,557,692 | 133,000,000 | 13.3% |
| 2 | 86,450,000 | 1,662,500 | 219,450,000 | 21.9% |
| 3 | 56,192,500 | 1,080,625 | 275,642,500 | 27.6% |
| 4 | 36,525,125 | 702,406 | 312,167,625 | 31.2% |
| 5 | 23,741,331 | 456,564 | 335,908,956 | 33.6% |
| 6 | 15,431,865 | 296,767 | 351,340,822 | 35.1% |

*Years 1–6 cover 92.5% of the 380M bucket; ~28.7M (2.9% of supply) tails out after.*

### Work-driven emissions — Base case (cap binds from year 4)

| Year | Verified jobs | Reward/job | Mint demand | Cap | Actually minted | Cap used |
|---|--:|--:|--:|--:|--:|--:|
| 1 | 50,000 | 200.0 | 10,000,000 | 133,000,000 | 10,000,000 | 8% |
| 2 | 150,000 | 130.0 | 19,500,000 | 86,450,000 | 19,500,000 | 23% |
| 3 | 400,000 | 84.5 | 33,800,000 | 56,192,500 | 33,800,000 | 60% |
| 4 | 800,000 | 54.9 | 43,940,000 | 36,525,125 | **36,525,125** ⚠️ | 100% |
| 5 | 1,200,000 | 35.7 | 42,841,500 | 23,741,331 | **23,741,331** ⚠️ | 100% |
| 6 | 1,600,000 | 23.2 | 37,129,300 | 15,431,865 | **15,431,865** ⚠️ | 100% |

*Reward/job decays 35%/yr (early operators earn more). ⚠️ = demand exceeded cap, rewards pro-rated down. 6-yr total minted: ~139M CLANK.*

### Buyback as % of market cap (vs. Hyperliquid's ~7%/yr)

4% blended take-rate, 60% of fees → on-market buyback, $50M reference mcap.

| Year | Bear | Base | Bull |
|---|--:|--:|--:|
| 1 | 0.01% | 0.05% | 0.24% |
| 2 | 0.03% | 0.14% | 0.86% |
| 3 | 0.06% | 0.38% | 2.40% |
| 4 | 0.10% | 0.86% | 5.28% |
| 5 | 0.14% | 1.54% | **9.60%** |
| 6 | 0.19% | 2.40% | **15.36%** |

*Bull (yr 5–6) reaches and exceeds HYPE's ~7%/yr. Base builds steadily; Bear stays tiny — buyback is a function of real fees, so it never pretends.*

### Net-deflationary flip (Base GMV, 100% of buyback burned)

| Ref price | Flip year | 6-yr cumulative net supply Δ |
|---|--:|--:|
| $0.02 | **year 5** | +4.6M CLANK |
| $0.05 | **year 6** | +85.2M CLANK |
| $0.20 | none (mild inflation) | +125.6M CLANK |

*Lower price ⇒ earlier flip (cheap buybacks burn more tokens — the reflexive floor). The full per-year table is in the script output.*

> **Honest caveat:** the two hard anchors are **buyback in USD** (fee-derived,
> price-independent) and **emissions in CLANK** (schedule/work-derived). Buyback
> *in token terms* is reflexive — it depends on price — so the flip above is shown
> across a price band rather than as a single line.

---

## 11. Open parameters for the team to set

These are genuine decisions, not defaults to rubber-stamp:

- Final **ticker** and whether the token is **native SPL** vs. a Token-2022 mint
  (Token-2022 transfer-hooks could enforce the burn-on-use elegantly).
- Exact **take-rates** per revenue line, and the **treasury split**
  (Pit Fund / staker yield / ops).
- **Burn vs. distribute** default for bought-back $CLANK (governance dial, but
  needs a launch value).
- **Emission cap + taper schedule** (cold-start aggressiveness vs. longevity).
- **ve-lock** parameters for governance, if any.
- Whether stakers are paid yield in **USDC** (simpler, less reflexive) or
  **bought-back $CLANK** (more reflexive, more upside) — or a blend.
- The **value-aware buyback** throttle (§12.2) — the P/F band at which buybacks
  scale up vs. divert to a USDC reserve.

---

## 12. A tradfi lens: cash flows, capital return, and what a diligence memo flags

Strip the crypto vocabulary and a serious analyst sees a **marketplace business
that returns capital to owners**. Judged that way, most of the romance falls away
and three hard questions remain: *Is the capital return real net of dilution? What
are the cash flows worth? What kills it?* This section answers each with numbers
(all from [`scripts/tokenomics_model.py`](scripts/tokenomics_model.py)) and refuses
the comfortable framing where it deserves to be refused.

### 12.1 Read the token as equity

| Token-world term | TradFi equivalent | So the analyst asks… |
|---|---|---|
| FDV / market cap | Equity value | What multiple of cash flow is this? |
| Protocol fees | Revenue | Recurring? Diversified? What quality? |
| Pit Fund buyback + burn | Share repurchase / capital return | Accretive, or buying high? |
| Work emissions | Stock-based comp (dilution) | Does revenue outgrow dilution? |
| Staking yield | Dividend | Funded by cash flow or by printing? |
| Treasury (Ledger-gated) | Balance-sheet + board control | Who can actually move it? |

Everything below follows from taking that table literally.

### 12.2 Capital return is only real **net of dilution** — and the discipline to not overpay

The single most important tradfi correction to §5: **a buyback that runs while
emissions dilute faster is not capital return — it's a treadmill.** The test that
makes Hyperliquid genuinely accretive is that *revenue (buyback) has grown faster
than dilution*. So we compute **net shareholder yield = gross buyback yield −
emission dilution** (at the $0.05 / $50M reference):

| Year | Base net yield | Bull net yield |
|---|--:|--:|
| 1 | −0.95% | −5.76% |
| 2 | −1.81% | −7.78% |
| 3 | −3.00% | −3.22% |
| 4 | −2.79% | **+1.63%** |
| 5 | −0.84% | **+7.23%** |
| 6 | **+0.86%** | **+13.82%** |

**The honest read:** years 1–4 are *dilutive* — the network is paying operators to
show up, exactly as intended, and a holder who buys at TGE expecting day-one yield
is mispricing it. Net yield flips positive in **year 6 (Base) / year 4 (Bull)**, as
emissions taper while fees compound. That crossover *is* the investment thesis;
everything before it is venture risk, and the doc should say so out loud.

**The Buffett rule, mechanized.** The standard critique of HYPE-style buybacks is
that they *"front-load demand and buy at high multiples"* — value-destructive if the
token is already rich. A repurchase only creates value **below intrinsic value**. So
make the buyback **value-aware** rather than a blind bid: scale buyback intensity to
the **price-to-fees (P/F) band**.

- **P/F low (cheap vs. cash flow):** route the full Pit Fund share into buybacks.
- **P/F rich:** throttle buybacks, divert the diverted USDC into a **reserve / real
  (USDC) staker yield / growth**, and let the burn slow.

This converts the buyback from a reflexive pump into **disciplined capital
allocation** — and it's enforceable on-chain because the program already meters
both inputs (`total_fees_collected` and a price oracle). It's the one mechanism
change a tradfi reviewer would *insist* on. (Added to §11's open parameters.)

### 12.3 What are the cash flows worth? (sum-of-the-parts, not one multiple)

Not all revenue earns the same multiple. A diligence memo segments it:

| Revenue segment | Share | P/F | Why that multiple |
|---|--:|--:|---|
| Labor / hire fees | 45% | **18x** | Uber-like marketplace, recurring, durable agent demand |
| Betting rake | 25% | **6x** | DraftKings-like; high-margin but **gambling → regulatory + cyclical discount** |
| Pay-to-pilot | 20% | **4x** | Entertainment/novelty, low durability |
| Passes / SNS / other | 10% | **2x** | One-off |
| **Blended** | 100% | **≈10.6x** | |

At ≈10.6x blended P/F, **implied FDV = 10.6 × annual fees**:

| Scenario | Year-6 fees | Implied FDV | vs. $50M reference |
|---|--:|--:|--:|
| Bear | $160K | $1.7M | 0.03x |
| Base | $2.0M | $21.2M | 0.42x |
| Bull | $12.8M | $135.7M | 2.71x |

So a **$50M reference FDV is *not* cheap** — it prices a Base-plus trajectory, well
ahead of run-rate. Comps frame the multiples: Coinbase trades ~8x sales; Hyperliquid
commands ~15x revenue *because* of the buyback. A pre-PMF robot network does not yet
deserve the HYPE premium, which is why §7 launches the token **after** fees exist,
not before — you earn the multiple, you don't assume it.

> **Revised in §16:** the 25% betting weight here is a *GMV-ish* guess. The
> bottom-up fee-mix audit (§16.2) shows betting is only **9% of fees** (thin rake),
> lifting the defensible blended multiple to **~15x**. The 10.6x used in §13/§14 is
> therefore *conservative* — read those valuations as a floor.

### 12.4 Quality of earnings — the revenue mix is a feature *and* a liability

The segmentation isn't cosmetic. **A quarter of mature-state revenue is gambling
rake.** That cuts both ways: it's high-margin and sticky, but it carries the lowest
multiple and the highest regulatory beta. The durable, premium-multiple line is the
**labor market** (agents hiring robots for provable work) — so the equity story
should be sold as *"a robot labor market that happens to host a betting pit,"* not
the reverse. Mix-shift toward hire fees is the single biggest lever on the blended
multiple, and it's strategy, not tokenomics.

### 12.5 The risk register a tradfi diligence memo opens with

| Risk | Severity | The honest position |
|---|---|---|
| **Securities (Howey) on staking-for-yield** | High | The SEC's **March 2026 framework** treats *protocol staking* (receipts for staked non-security assets + protocol-defined rewards) as generally **not** a securities offering. Our exposure is "stake → buyback-funded yield," which leans toward *profit from others' efforts.* **Mitigant:** frame staking as **securing the verifier/attestation layer (work, slashable)**, pay yield from **fees not new issuance**, and decentralize the foundation early. |
| **Gambling licensing (parimutuel rake)** | High | Real-money wagering on physical races is **regulated gambling.** World ID (one-human-one-bet) helps with responsible-gaming/KYC but is **not** a license. Needs geofencing + a licensing path (MGA/UKGC/Curaçao or US-state-by-state) — or the rake stays a demo, not a revenue line. |
| **Money transmission / MSB** | Medium | The non-custodial program likely isn't an MSB, but the **sidecar/facilitator + Kora relayer** moving USDC could trigger MTL/MSB analysis. Keep custody in the program PDAs; keep the operator a pure relayer. |
| **AML / sanctions** | Medium | World ID = proof-of-personhood, **not** OFAC screening. Betting payouts create screening obligations. |
| **Buyback sustainability** | Medium | Buyback is *mechanically tied to volume* — the same structural risk flagged at Hyperliquid. It shrinks gracefully (it's a function, not a reserve draw), but the equity story **cannot rest on buyback in the Bear case** (0.2% of mcap — negligible). |
| **Reflexivity / execution** | Medium | Buying ~15% of mcap/yr (Bull yr6 = $7.7M) into a thin book is self-front-running. Execute via **TWAP with a max-%-of-ADV cap**, never market-buys. Margin of safety comes from **fixed supply + no VC overhang + capped dilution**, not from the bid. |

### 12.6 Unit economics — the operator is a franchisee, and capex isn't the risk

| | Jobs/yr | USDC rev (net) | Emissions value | Opex | Net income | Payback | Emissions % |
|---|--:|--:|--:|--:|--:|--:|--:|
| Year 1 (subsidy) | 600 | $11,520 | $6,000 | $4,000 | $13,520 | **1.8 mo** | 34% |
| Year 4 (fee era) | 3,000 | $40,320 | $5,250 | $10,000 | $35,570 | **0.7 mo** | 12% |

A ~$2,000 rover pays back in **weeks**, so **capex is not the constraint —
utilization is.** Getting jobs *to* the rover is a demand problem, which is exactly
what emissions (early) and buyback-backed token value (later) exist to solve.
Emissions are **~34% of operator income in year 1** and **~12% by year 4** — the
franchise-level mirror of the macro taper, and proof the subsidy is *bootstrapping*
supply, not permanently propping it.

### 12.7 The one-paragraph IC summary

A fixed-supply, no-VC token over a marketplace that **returns real USDC fees to
owners via a value-aware buyback**, with dilution that **demonstrably tapers below
revenue growth** (net shareholder yield flips positive yr4–6). Fair value is
**~10x forward fees** — sum-of-the-parts, discounted for a gambling-revenue
quarter — so the $50M reference prices Base-plus execution, not run-rate. The real
risks are **regulatory (gambling + staking-yield), not mechanical**, and the
downside is bounded by structure (no overhang, capped emissions) rather than by the
bid. **Underwrite the labor market; treat the buyback as the return-of-capital
policy, not the thesis.**

---

## 13. Staking economics & DCF — the yield and the price

The capstone two questions: *what does a staker actually earn*, and *what are the
cash flows worth today*. Both run off the same circulating-supply schedule (airdrop
+ liquidity unlocked at TGE; core 20% on a 1-yr cliff then vesting yrs 2–4;
ecosystem 10% over yrs 1–4; plus cumulative emissions). All in
[`scripts/tokenomics_model.py`](scripts/tokenomics_model.py).

### 13.1 Staking APR is *real yield*, and it's deliberately modest

Stakers bond $CLANK to secure the verifier/attestation layer (slashable) and
receive **30% of fees as USDC** — real yield, not reflexive token emissions. Paying
in USDC is the choice that keeps staking on the safe side of the Howey line (§12.5)
and out of a reflexive yield-from-printing spiral.

**Base case, 40% of circulating staked:**

| Year | Fees | Staker pool (USDC) | Staked value | **Staking APR** |
|---|--:|--:|--:|--:|
| 1 | $40K | $12K | $7.1M | 0.17% |
| 3 | $320K | $96K | $11.8M | 0.81% |
| 4 | $720K | $216K | $14.4M | 1.50% |
| 5 | $1.28M | $384K | $14.9M | 2.58% |
| 6 | $2.0M | $600K | $15.2M | **3.95%** |

**Year-6 APR vs. participation** (yield is a spread over the staked base):

| Participation | Base APR | Bull APR | Base, *if buyback distributed not burned* |
|---|--:|--:|--:|
| 20% | 7.91% | 42.75% | 23.72% |
| 40% | **3.95%** | 21.37% | 11.86% |
| 60% | 2.64% | 14.25% | 7.91% |

Two honest reads:

- **The APR is modest because it's real.** ~2–8% USDC yield in the Base case isn't
  a 400% farm — it's a dividend funded by actual fees, which is exactly why it
  doesn't evaporate. Bull throws off 14–43% because fees, not emissions, are
  carrying it.
- **Burn vs. distribute is the big yield dial.** Streaming the 60% buyback to
  stakers instead of burning it roughly **triples** headline APR (3.95% → 11.86% at
  40%). But burning accrues value to *every* holder (cleaner for Howey, less
  reflexive), while distributing concentrates it on stakers (juicier, but more
  security-like and price-reflexive). This is the §11 governance lever, quantified.

### 13.2 The security budget sets the *floor* on APR

Here's the tradfi inversion most token docs miss: **minimum viable APR isn't set by
what holders want — it's set by what's needed to keep the verifier layer
honest.** A staker's bond must risk more (slashable) than a corrupt verdict could
steal. At just 20% participation in year 1, staked value ≈ **$3.55M against a
$50K peak settlement — a ~71× cushion.** The invariant that must hold every epoch:
**staked value ≫ peak value-at-risk.** If natural fee-funded APR is ever too thin
to attract that minimum stake, you bridge it with early (tapering) emissions or a
higher staker split — security comes first, yield optimization second.

### 13.3 DCF — fair value today, not the forward number

Distributable cash flow = **89% of fees** (buyback + staker yield; ops is cost).
Terminal value triangulated two ways — exit multiple (P/F 10.6x) and Gordon growth
(g = 4%) — then everything discounted at a **crypto cost of equity of 25–45%**
(high beta + execution + regulatory risk).

| Scenario | Discount | PV explicit | PV terminal (avg) | **Implied FDV** | Implied price |
|---|--:|--:|--:|--:|--:|
| Base | 25% | $1.36M | $3.95M | **$5.3M** | $0.0053 |
| Base | 35% | $0.95M | $2.25M | **$3.2M** | $0.0032 |
| Base | 45% | $0.69M | $1.39M | **$2.1M** | $0.0021 |
| Bull | 25% | $8.48M | $25.3M | **$33.7M** | $0.0337 |
| Bull | 35% | $5.92M | $14.4M | **$20.3M** | $0.0203 |
| Bull | 45% | $4.28M | $8.9M | **$13.2M** | $0.0132 |

**Base-case sensitivity — implied FDV:**

| Discount ↓ / Exit P/F → | 6x | 10.6x | 16x |
|---|--:|--:|--:|
| 25% | $4.1M | $5.3M | $6.7M |
| 35% | $2.4M | $3.2M | $4.1M |
| 45% | $1.6M | $2.1M | $2.7M |

**The conclusion you can't dress up:** §12.3's $21.2M was a *year-6 forward* value;
discounting that stream to *today* at a 35% hurdle, **Base supports only single-digit
millions of FDV now**, and even **Bull lands at ~$20M.** The $50M reference price
($0.05) clears DCF fair value **only on a Bull trajectory at a sub-30% discount
rate** — i.e. it's a price you pay for *growth optionality and narrative*, not for
discounted cash flow. A tradfi reviewer signs off only by underwriting the Bull case
*and* the regulatory execution that lets the fees actually exist. That's the whole
point of launching the token **after** PMF (§7): you want to be selling realized
fees into a lower discount rate, not selling the hope of them at 45%.

---

## 14. Monte Carlo — a probabilistic fair value (and what it implies for launch)

Three point scenarios hide the shape of the risk. This runs the §9/§13 DCF engine
**50,000 times**, sampling the five inputs that actually move value: terminal-year
GMV (lognormal, $50M median = Base), take-rate, discount rate, exit P/F, and a
**binary regulatory hit** (12% chance of a 50% cash-flow impairment — the gambling/
securities tail from §12.5, priced rather than hand-waved).

| Percentile | Implied FDV | Implied price |
|---|--:|--:|
| P5 | $0.3M | $0.0003 |
| P10 | $0.5M | $0.0005 |
| P25 | $1.2M | $0.0012 |
| **P50 (median)** | **$3.0M** | **$0.0030** |
| P75 | $7.4M | $0.0074 |
| P90 | $16.6M | $0.0166 |
| P95 | $27.0M | $0.0270 |
| **Mean** | **$7.3M** | **$0.0073** |

**Probabilities:** P(FDV ≥ $10M) = **18%** · P(FDV ≥ $50M reference) = **2%** ·
P(FDV ≥ $100M) ≈ **0%**

**What drives the spread** (|correlation| with ln FDV — the tornado):

| Input | Influence |
|---|--:|
| **Terminal GMV (execution)** | █████████████████ 0.57 |
| Regulatory hit | █████ 0.17 |
| Discount rate | ████ 0.14 |
| Take-rate | ██ 0.08 |
| Exit P/F | ██ 0.08 |

**The three reads:**

1. **Execution is ~everything.** Terminal GMV swamps every financial knob combined.
   You cannot tokenomics your way to value — get the robots hired. Discount rate,
   multiple, and even the regulatory tail are all second-order to *does the
   marketplace actually do volume.* That's the right conclusion for a builder to
   internalize.
2. **The distribution is venture-shaped** — median $3.0M, mean $7.3M, P95 $27M. A
   few big outcomes drag the mean above the median; most paths are modest. This is
   normal for an early network and argues for *position sizing*, not for false
   precision.
3. **The $50M reference is a ~2% price.** The denominator I used throughout §10/§13
   ($0.05, $50M FDV) is an *aggressive* valuation — DCF-fair value today is
   single-digit millions. I kept it as a fixed yardstick for comparability, but the
   honest fair-value anchor is the distribution above.

### The constructive flip — launch *low*, the Hyperliquid way

That the reference is rich cuts a *positive* way too, and it's the most important
practical takeaway. **The same $50M denominator that overstates fair value also
understates the yield and buyback metrics** in §10 and §13 — because those divide
fee flows by market cap. If the token launches nearer DCF value (say a ~$10–20M
FDV) instead of $50M:

- **buyback-as-%-of-mcap** and **staking APR** are **2.5–5× higher** than the §10/§13
  tables show (same USD fees, smaller denominator);
- the community captures the re-rating **upside** as fees grow into the valuation —
  exactly Hyperliquid's playbook: launch at a fair/low FDV with no VC overhang and
  let *users*, not insiders, own the appreciation.

So the model doesn't just value the token — it argues for a **deliberately modest
launch FDV**. Pricing it richly would hand the upside away and depress the very
yield metrics that make the token attractive. Launching it cheap is both the
financially honest move *and* the community-first one. The two are the same move.

---

## 15. Legal-structuring memo — ring-fencing the betting rake

> *Not legal advice — a structuring framework for counsel to pressure-test. The
> point is to stop ~25% of revenue from contaminating the token and dragging the
> whole valuation.*

### 15.1 Why this is the highest-leverage legal move

Three independent analyses above all point at the same place: the betting rake is
the **lowest-multiple revenue (6x vs. 18x for labor), the biggest Monte Carlo tail,
and the #1 diligence flag.** A token that is a *direct claim on unlicensed gambling
revenue* is hard to list on a compliant exchange, leans toward a security, and can
be killed wholesale by a single gambling-enforcement action — taking the **healthy
75% labor-market business down with it.** Ring-fencing severs that contagion.

### 15.2 The honest threshold problem: you run the races

A neutral prediction market (Polymarket, Kalshi) bets on **exogenous, verifiable**
events the operator can't influence — which is what lets it argue it's a *derivative*
under CFTC oversight rather than gambling. **We run and judge our own robot races.**
That is an integrity and conflict-of-interest surface: it looks less like a
prediction market and more like a house-run book, which is the *worse* regulatory
characterization. Any structure has to neutralize that first, or nothing else
matters.

**Mitigants that must be structural, not promised:**

- **Independent settlement:** the outcome is set by the **Switchboard DON verdict
  (threshold 70)** off the guard's Walrus-anchored finish photo — not by the
  operator. The program already forbids the racer's own claim from settling.
- **No operator/insider position:** operators, the foundation, and robot owners are
  **contractually barred from betting** (on-chain allowlist exclusion).
- **Parimutuel, not house-banked:** bettors bet **against each other**; the protocol
  takes a flat **service fee**, never a position or a house edge. Parimutuel is a
  distinct, more favorably treated category (the horse-racing model) than
  house-banked sports betting.
- **One-human-one-bet via World ID** + bet caps + responsible-gaming limits.

### 15.3 The regulatory fork

| Path | What it is | Fit for us |
|---|---|---|
| **A. Gambling license** | State-by-state (US) or offshore (MGA / UKGC / Curaçao) operator license | **Most honest fit** for betting on self-run races. Offshore + geofencing is the pragmatic v1. |
| **B. CFTC prediction-market / DCM** | Event contracts as federally-regulated derivatives (Kalshi, Polymarket Nov-2025 DCM) | **Weak fit** while we run the races — self-influence undercuts the "neutral derivative" claim. A *later* option if races become independently-sanctioned events. |
| **C. Free-to-play / sweepstakes** | No real-money wagering; entertainment overlay | Fallback that keeps the demo and the labor market clean if licensing slips. |

### 15.4 The recommended structure — isolate, license, and pay a clean fee up

```
   ┌─────────────────────────────┐         ┌──────────────────────────────┐
   │  Protocol / Foundation      │         │  RaceBook NewCo (licensed)   │
   │  $CLANK · labor market ·    │         │  MGA/Curaçao operator        │
   │  reputation · treasury      │         │  KYC/AML · geofencing ·      │
   │                             │◄────────│  responsible gaming · the    │
   │  accrues a LICENSE/DATA fee │ license │  betting front-end           │
   │  (clean, recurring)         │  fee up │                              │
   └──────────────┬──────────────┘         └───────────────┬──────────────┘
                  │ both call permissionless                │ calls market ix
                  ▼ on-chain program (neutral software)     ▼ for in-scope users
            ┌────────────────────────────────────────────────────┐
            │  clanker5000 program — market ix are neutral infra  │
            │  (anyone can call; the licensed entity gates WHO)   │
            └────────────────────────────────────────────────────┘
```

- **The on-chain market instructions are neutral, permissionless software.** The
  **licensed NewCo** is the *operator* that gates which users (jurisdiction, KYC,
  age, caps) may place bets through a compliant front-end. The Foundation/labor side
  never touches gambling revenue directly.
- **Revenue conversion — the key trick:** the rake accrues to the **licensed
  entity**, which pays an **arms-length license/data fee up to the protocol
  treasury.** At the token level, "gambling rake" becomes **"software/data licensing
  income"** — higher quality, recurring, and one step removed from the regulated
  activity.
- **Geofencing & sequencing:** launch offshore (Curaçao/MGA) with **IP + World ID
  geofencing** excluding prohibited jurisdictions (US states without a path, etc.);
  watch **MiCA** (EU licensing from July 2026); keep the **CFTC/DCM path** as a
  later option only if races become independently sanctioned.

### 15.5 The quantified trade (from the model)

| | Betting in token | **Ring-fenced** |
|---|--:|--:|
| Blended P/F | 10.6x on 100% of fees | **12.1x on 85%** (rake → 12x license fee) |
| Forward FDV | 100% | **~97% — essentially flat** |
| Median FDV (MC) | $2.96M | **$3.09M** |
| P10 downside (MC) | $0.52M | **$0.56M** |
| Gambling tail on the token | 12% × 50% haircut | **removed (sits in NewCo)** |

**The trade is nearly free.** You give up ~3% of forward value and 25% of *gross*
revenue, and in exchange: a higher multiple on cleaner income, a lifted downside,
**no gambling tail on the token**, a Howey-cleaner asset (§12.5), and a token a
compliant exchange will actually list. The labor market — the premium-multiple,
durable 75% — becomes **un-killable by a betting enforcement action.** This is the
rare structuring move that's both more conservative *and* roughly value-neutral, so
there's no real reason not to do it.

### 15.6 One-paragraph counsel brief

*Stand up a licensed offshore operator entity (Curaçao/MGA v1) for the parimutuel
market; keep the on-chain market instructions as neutral permissionless software the
entity merely gates access to; settle outcomes via the independent DON oracle and
bar all insiders from betting; convert the rake into an arms-length license fee paid
up to the protocol treasury so the token accrues licensing income, not gambling
revenue; geofence aggressively and revisit a CFTC/DCM path only if races become
independently sanctioned. Net effect: the token is value-neutral, materially
de-risked, and listable.*

---

## 16. GMV decomposition — auditing the one number that matters

The Monte Carlo (§14) showed **execution — terminal GMV — dominates fair value**,
which makes the single blended GMV figure the weakest assumption in the whole model.
So this replaces it with a **bottom-up unit build** and then does the move a tradfi
analyst never skips: apply **per-line take-rates** to turn volumes into a *fee* mix,
and check it against the SOTP weights in §12.3.

### 16.1 Bottom-up reconciles with top-down

GMV built from real drivers — fleet × hires/rover × price, races × bettors × bet
size, $1 pilots, passes × price:

| Year | Hire | Betting | Pilot | Passes+Race | **Bottom-up total** | Top-down Base | Ratio |
|---|--:|--:|--:|--:|--:|--:|--:|
| 1 | $0.47M | $0.17M | $0.04M | $0.05M | **$0.73M** | $1.0M | 0.73x |
| 3 | $4.80M | $2.70M | $0.45M | $0.34M | **$8.29M** | $8.0M | 1.04x |
| 4 | $13.2M | $5.85M | $1.00M | $0.66M | **$20.7M** | $18.0M | 1.15x |
| 6 | $39.5M | $12.6M | $2.60M | $1.50M | **$56.2M** | $50.0M | 1.12x |

The two methods bracket each other within ~25% every year (bottom-up runs slightly
*hotter* at scale). The top-down scenario isn't a fantasy — it's reachable with a
~950-rover fleet doing ~3,200 jobs each at $13. **That** is the assumption to argue
about, and now it's explicit instead of buried in one number.

### 16.2 The fee-mix audit — the model's biggest finding

GMV mix ≠ fee mix, because take-rates differ wildly by line (hire 4%, betting just
1.5%, pilot 8%). Applying them to year-6:

| Line | % of **GMV** | Take | % of **FEES** |
|---|--:|--:|--:|
| Hire (labor) | 70% | 4.0% | **78%** |
| Betting | 22% | 1.5% | **9%** |
| Pilot | 5% | 8.0% | **10%** |
| Passes / race | 3% | — | **3%** |

**Betting is 22% of GMV but only 9% of fees** — its rake is deliberately thin (§4),
so it barely contributes to token-accruing revenue. Hire fees are **78% of fees.**
This corrects §12.3, which assumed a 25% betting weight and so *overstated the
gambling drag.* The realized fee mix gives a blended **P/F ≈ 15.1x — Hyperliquid
territory, not 10.6x.** Two consequences, pulling in opposite directions but both
good:

1. **Fair value is higher than §13/§14 modeled.** Re-running the Monte Carlo at the
   audited ~15x multiple mode lifts **median FDV $2.96M → $3.49M (~+18%)** and mean
   $7.3M → $8.6M. (Muted because the exit multiple is only half the terminal value;
   Gordon growth is unchanged.) The single biggest upward revision in the model —
   and it came from *decomposing a number*, not from optimism.
2. **The ring-fence case (§15) gets stronger, not weaker.** You process **22% of GMV
   as gambling volume for only 9% of fees** — large regulatory surface, tiny
   reward. Isolating betting in a licensed entity sheds disproportionate risk per
   dollar of fee given up. The two analyses reinforce each other.

### 16.3 What this changes

- The defensible launch multiple is **~15x, not ~10.6x** — closer to HYPE, justified
  by a *labor-fee-dominated* mix rather than asserted.
- **Mix-shift toward hire fees is the master lever** (§12.4 said this; the
  decomposition proves it): labor already carries 78% of fees and the highest
  multiple, so growth in agent-hiring compounds value faster than anything else.
- The assumptions now worth defending in diligence are concrete and few: **fleet
  growth, jobs-per-rover (utilization), and the per-line take-rates.** Everything
  downstream — valuation, yield, the flip — follows from those.

---

## 17. From design to code

The economics above are fully specified; turning them into Anchor instructions is an
**additive** extension of the live `clanker5000` program — no change to the shipped
race / market / reputation / pass / treasury / attestation code. The engineering spec
lives in **[`docs/TOKEN_PROGRAM_SPEC.md`](docs/TOKEN_PROGRAM_SPEC.md)** and covers:

- **Classic SPL, not Token-2022** — chosen for CEX/wallet universality (the §15
  listability thesis); burn-on-use done explicitly at the call site, not via a
  transfer hook.
- **New PDAs** (`TokenConfig`, `EmissionEpoch`, `StakePool`/`StakeAccount`,
  `OperatorBond`/`VerifierBond`, `PitFund`) that sit beside the existing `Config`
  without migrating it.
- **The emissions hook** — `accrue_emissions` mints only against a *verified*
  `Attestation` (score ≥ 70) + a non-self `Feedback` + a bonded operator + the epoch
  cap: §9's anti-gaming made structural, reusing accounts the program already writes.
- **Value-aware buyback** via a bounded keeper (slippage / %-ADV / oracle caps),
  sized off the on-chain `total_fees_collected` and a price oracle (§12.2).
- **Real-yield staking** in USDC (non-reflexive, Howey-cleaner), slashing with a
  dispute window, fixed-supply invariants, and a 6-step build order that mirrors
  §0–16.

---

## Sources & inspiration

**Hyperliquid (revenue→buyback, community-first, no VC):**
- [Hyperliquid Tokenomics — $65M/mo holder revenue (Tokenomics.com)](https://tokenomics.com/articles/hyperliquid-tokenomics-how-hype-captures-65m-monthly-in-holder-revenue)
- [Hyperliquid allocation breakdown & vesting (Tokenomist.ai)](https://www.tokenomist.ai/hyperliquid/tokenomics)
- [Why HYPE is different: inside the buyback (crypto.news)](https://crypto.news/why-hype-is-different-inside-hyperliquids-buyback/)
- [Hyperliquid's $1B buyback machine — is it sustainable? (DL News)](https://www.dlnews.com/articles/defi/hyperliquid-hype-token-buyback-1bn-but-is-it-sustainable/)
- [Proposal to burn 13% of supply from the Assistance Fund (The Defiant)](https://thedefiant.io/news/tokens/hyperliquid-proposes-burning-13-percent-of-circulating-token-supply)

**DePIN work-token design (burn-and-mint, proof-of-physical-work, emission caps):**
- [7 Helium + Hivemapper tokenomics lessons that last (Hash Block)](https://medium.com/@connect.hashblock/7-helium-hivemapper-tokenomics-lessons-that-actually-last-5eecf3cd4b89)
- [DePIN tokenomics 101: a guide for builders (Hilary H. Brown)](https://medium.com/@hilary.h.brown/depin-tokenomics-101-a-guide-for-builders-4a854ff8de21)
- [DePIN tokenomics (academic survey, Frontiers in Blockchain)](https://www.frontiersin.org/journals/blockchain/articles/10.3389/fbloc.2025.1644115/full)
- [Solana DePIN in 2026: Helium, Render, Hivemapper (Grey Area Labs)](https://greyarealabs.co/2026/03/23/solana-depin-2026/)

**TradFi lens — valuation, capital return, regulation:**
- [Token valuation: price-to-fees, real yield, net-of-dilution (DeFi Opportunity)](https://medium.com/the-defi-opportunity/token-valuation-methods-6592761b21af)
- [DeFi revenue tokens: fees, burns & buybacks > TVL (CryptoDaily)](https://cryptodaily.co.uk/2026/05/defi-revenue-tokens-fees-burns-buybacks-over-tvl)
- [Hyperliquid investment thesis & 15x revenue multiple (OAK Research)](https://oakresearch.io/en/reports/protocols/hyperliquid-hype-investment-thesis-the-house-of-finance)
- [Buyback sustainability critique — volume-tied, fee-compression risk (DL News)](https://www.dlnews.com/articles/defi/hyperliquid-hype-token-buyback-1bn-but-is-it-sustainable/)
- [Coinbase public comps (~8x sales) (Multiples.vc)](https://multiples.vc/public-comps/coinbase-valuation-multiples)
- [SEC March 2026 framework: securities laws & crypto / staking under Howey (WilmerHale)](https://www.wilmerhale.com/en/insights/client-alerts/20260324-the-secs-new-framework-for-crypto-assets-under-howey)
- [SEC clarifies securities laws applied to crypto assets (Latham Fintech & Digital Assets)](https://www.fintechanddigitalassets.com/2026/04/sec-clarifies-the-application-of-the-securities-laws-to-cryptoassets/)

**Betting structure & ring-fencing (§15):**
- [Is Polymarket legal in the US — CFTC DCM vs state gambling, federal preemption (Gambling Insider)](https://www.gamblinginsider.com/in-depth/106291/is-polymarket-legal-in-the-us)
- [Polymarket receives CFTC approval / Amended Order of Designation (The Bulldog Law)](https://www.thebulldog.law/polymarket-receives-cftc-approval-to-resume-us-operations-after-years-offshore)
- [Prediction-market license types — how to launch a legal platform (Legal Bison)](https://legalbison.com/blog/prediction-market-license-types-regulatory-guide/)
- [How to launch a prediction-market app: regulatory architecture (Global Law Experts)](https://globallawexperts.com/how-to-launch-a-prediction-market-app-regulatory-architecture-market-realities/)
