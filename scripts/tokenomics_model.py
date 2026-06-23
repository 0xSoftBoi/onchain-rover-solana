#!/usr/bin/env python3
"""
Clanker 5000 — $CLANK emission-cap & buyback model.

Models the full token economics over a 6-year horizon, all params tunable at top:
  1. The emission CAP schedule (a decaying ceiling on what CAN be minted).
  2. WORK-DRIVEN actual emissions (jobs x reward/job, clamped to the cap).
  3. The fee-funded BUYBACK (Pit Fund), in USD and as % of market cap.
  4. The FLIP to net-deflationary: the year buyback-burn (tokens) >= emissions.
TradFi lens:
  5. Net shareholder yield (gross buyback yield - emission dilution).
  6. Sum-of-the-parts valuation (segment P/F multiples -> blended -> implied FDV).
  7. Per-rover unit economics (operator franchise P&L, payback, ROIC).
  8. Staking APR (real USDC yield) + security-budget adequacy.
  9. DCF (distributable CF, triangulated terminal, crypto discount band).
 10. Monte Carlo fair value (50k trials; percentiles, P(>ref), driver tornado).

Run:  python3 scripts/tokenomics_model.py
Everything prints as GitHub-flavored markdown tables.
"""
import random
import math

# ─────────────────────────────────────────────────────────────────────────────
# PARAMETERS  (every one of these is meant to be governance-tunable)
# ─────────────────────────────────────────────────────────────────────────────
TOTAL_SUPPLY      = 1_000_000_000      # fixed $CLANK supply
EMISSION_BUCKET   = 0.38 * TOTAL_SUPPLY  # 380M reserved for work emissions
DECAY             = 0.65               # each year's cap = 65% of the prior year
YEARS             = 6
WEEKS_PER_YEAR    = 52                  # weekly epochs, Hivemapper-style

# Work model: verified jobs/yr and the decaying per-job CLANK reward.
# (reward/job falls over time — early operators earn more, standard DePIN taper.)
REWARD0_CLANK     = 200.0              # CLANK per verified job, year 1
REWARD_DECAY      = 0.65               # reward/job decays at the same rate as cap

JOBS_BASE = [50_000, 150_000, 400_000, 800_000, 1_200_000, 1_600_000]
JOBS_BULL = [j * 6 for j in JOBS_BASE]   # bull = 6x the verified-job throughput

# Buyback model: blended take-rate on GMV, and the Pit Fund's cut of fees.
BLENDED_TAKE      = 0.04               # 4% blended across hire/race/bet/pilot/pass
PITFUND_SHARE     = 0.60               # 60% of fees -> Pit Fund buyback (rest: yield+ops)

# Gross marketplace volume (USD) per scenario, per year.
GMV = {
    "Bear":     [250_000,   600_000,   1_200_000,  2_000_000,  3_000_000,  4_000_000],
    "Base":     [1_000_000, 3_000_000, 8_000_000,  18_000_000, 32_000_000, 50_000_000],
    "Bull":     [5_000_000, 18_000_000,50_000_000, 110_000_000,200_000_000,320_000_000],
}

# Reference price band for converting USD<->CLANK (the reflexive part — shown as a band).
# Mid corresponds to a $50M FDV at 1B supply.
PRICE_BAND = {"low": 0.02, "mid": 0.05, "high": 0.20}
REF_FDV_PRICE = PRICE_BAND["mid"]      # used for the "% of mcap" buyback comparison


def fmt(n, dp=0):
    return f"{n:,.{dp}f}"


def emission_caps():
    c1 = EMISSION_BUCKET * (1 - DECAY)         # year-1 cap; geometric sum -> bucket
    return [c1 * DECAY**y for y in range(YEARS)]


def actual_emissions(jobs):
    caps = emission_caps()
    rows, cum = [], 0.0
    for y in range(YEARS):
        reward = REWARD0_CLANK * REWARD_DECAY**y
        demand = jobs[y] * reward                 # work-driven mint demand
        minted = min(demand, caps[y])             # clamp to the cap (pro-rate if over)
        cum += minted
        rows.append({
            "year": y + 1, "jobs": jobs[y], "reward": reward,
            "demand": demand, "cap": caps[y], "minted": minted,
            "cum": cum, "util": minted / caps[y],
        })
    return rows


def print_cap_schedule():
    caps = emission_caps()
    cum = 0.0
    print("### 1. Emission CAP schedule (the ceiling — not a target)\n")
    print("| Year | Annual cap (CLANK) | Weekly cap | Cumulative | % of 1B supply |")
    print("|---|--:|--:|--:|--:|")
    for y in range(YEARS):
        cum += caps[y]
        print(f"| {y+1} | {fmt(caps[y])} | {fmt(caps[y]/WEEKS_PER_YEAR)} "
              f"| {fmt(cum)} | {fmt(100*cum/TOTAL_SUPPLY,1)}% |")
    tail = EMISSION_BUCKET - cum
    print(f"\n*Caps decay at {int(DECAY*100)}%/yr. Years 1–{YEARS} cover "
          f"{fmt(100*cum/EMISSION_BUCKET,1)}% of the 380M bucket; "
          f"~{fmt(tail)} CLANK ({fmt(100*tail/TOTAL_SUPPLY,2)}% of supply) tails out after.*\n")


def print_emissions(name, rows):
    print(f"### 2{('a' if name=='Base' else 'b')}. Work-driven emissions — {name} case\n")
    print("| Year | Verified jobs | Reward/job (CLANK) | Mint demand | Cap | "
          "Actually minted | Cap used | Cumulative |")
    print("|---|--:|--:|--:|--:|--:|--:|--:|")
    for r in rows:
        flag = " ⚠️cap binds" if r["demand"] > r["cap"] else ""
        print(f"| {r['year']} | {fmt(r['jobs'])} | {fmt(r['reward'],1)} | "
              f"{fmt(r['demand'])} | {fmt(r['cap'])} | {fmt(r['minted'])}{flag} | "
              f"{fmt(100*r['util'],0)}% | {fmt(r['cum'])} |")
    print()


def print_buyback():
    print("### 3. Fee-funded buyback (the Pit Fund), in USD\n")
    print(f"*Blended take-rate {int(BLENDED_TAKE*100)}% on GMV; "
          f"{int(PITFUND_SHARE*100)}% of fees routed to on-market $CLANK buybacks. "
          f"USD figures are price-independent. '% of mcap' assumes ${REF_FDV_PRICE} "
          f"(=${fmt(REF_FDV_PRICE*TOTAL_SUPPLY/1e6,0)}M FDV) for comparison with "
          f"Hyperliquid's ~7%/yr.*\n")
    for scen, gmv in GMV.items():
        print(f"**{scen}**\n")
        print("| Year | GMV (USD) | Protocol fees | Pit Fund buyback/yr | "
              "CLANK bought @ $0.05 | Buyback as % of $50M mcap |")
        print("|---|--:|--:|--:|--:|--:|")
        for y in range(YEARS):
            fees = gmv[y] * BLENDED_TAKE
            buy = fees * PITFUND_SHARE
            tokens = buy / REF_FDV_PRICE
            pct = 100 * buy / (REF_FDV_PRICE * TOTAL_SUPPLY)
            print(f"| {y+1} | {fmt(gmv[y])} | {fmt(fees)} | {fmt(buy)} | "
                  f"{fmt(tokens)} | {fmt(pct,2)}% |")
        print()


def print_flip():
    print("### 4. Net supply: when does buyback-burn overtake emissions?\n")
    print("*If 100% of bought-back $CLANK is burned, net mint = emissions − buyback-burn. "
          "Buyback tokens depend on price (reflexive), so shown across the price band. "
          "Emissions use the **Base** work case.*\n")
    rows = actual_emissions(JOBS_BASE)
    for label, price in PRICE_BAND.items():
        print(f"**Buyback at ${price}/CLANK — Base GMV**\n")
        print("| Year | Emissions (CLANK) | Buyback-burn (CLANK) | Net supply Δ | Status |")
        print("|---|--:|--:|--:|---|")
        cum_net = 0.0
        flipped = None
        for y in range(YEARS):
            buy = GMV["Base"][y] * BLENDED_TAKE * PITFUND_SHARE
            burn = buy / price
            net = rows[y]["minted"] - burn
            cum_net += net
            status = "inflationary" if net > 0 else "**deflationary**"
            if net <= 0 and flipped is None:
                flipped = y + 1
            print(f"| {y+1} | {fmt(rows[y]['minted'])} | {fmt(burn)} | "
                  f"{fmt(net)} | {status} |")
        msg = f"flips net-deflationary in **year {flipped}**" if flipped else \
              "stays net-inflationary through year 6 (emissions still seeding supply)"
        print(f"\n*At ${price}: {msg}. Cumulative net supply change over "
              f"{YEARS}y: {fmt(cum_net)} CLANK.*\n")


# ─────────────────────────────────────────────────────────────────────────────
# TRADFI LENS  — treat the token as an equity-like claim on cash flows.
# ─────────────────────────────────────────────────────────────────────────────

# Sum-of-the-parts: not all revenue deserves the same multiple. Weights = share
# of mature-state fees; multiples = defensible P/F by revenue quality.
SOTP = {  # segment: (share of fees, price-to-fees multiple)
    "Labor / hire fees (Uber-like, durable)":      (0.45, 18.0),
    "Betting rake (DraftKings-like, regulated)":   (0.25, 6.0),
    "Pay-to-pilot sessions (entertainment)":       (0.20, 4.0),
    "Passes / SNS / other (one-off)":              (0.10, 2.0),
}

# Per-rover unit economics (the operator's franchise P&L).
ROVER_CAPEX = 2_000           # Waveshare UGV + Jetson Orin NX, ballpark
ROVER = {  # year-label: (jobs/rover/yr, price/job USD, opex/yr, reward/job CLANK)
    "Year 1 (subsidy era)":  (600,  20.0, 4_000,  200.0),
    "Year 4 (fee era)":      (3_000, 14.0, 10_000, 35.0),
}


def print_shareholder_yield():
    print("### 5. Net shareholder yield (buyback − dilution), the tradfi headline\n")
    print("*A buyback only helps holders **net of** the emissions diluting them — "
          "the same test that makes HYPE accretive (revenue grew faster than "
          "dilution). Gross buyback yield − emission dilution = net shareholder "
          f"yield. At ${REF_FDV_PRICE}/CLANK, ${fmt(REF_FDV_PRICE*TOTAL_SUPPLY/1e6,0)}M FDV.*\n")
    for scen, jobs in (("Base", JOBS_BASE), ("Bull", JOBS_BULL)):
        gmv = GMV[scen]
        em = actual_emissions(jobs)
        print(f"**{scen}**\n")
        print("| Year | Gross buyback yield | Emission dilution | "
              "**Net shareholder yield** |")
        print("|---|--:|--:|--:|")
        flip = None
        for y in range(YEARS):
            buy = gmv[y] * BLENDED_TAKE * PITFUND_SHARE
            gross = buy / (REF_FDV_PRICE * TOTAL_SUPPLY)              # % of mcap
            dil = em[y]["minted"] / TOTAL_SUPPLY                       # % of supply
            net = gross - dil
            if net > 0 and flip is None:
                flip = y + 1
            print(f"| {y+1} | {fmt(100*gross,2)}% | {fmt(100*dil,2)}% | "
                  f"{'**+' if net>0 else ''}{fmt(100*net,2)}%{'**' if net>0 else ''} |")
        msg = f"net yield turns **positive in year {flip}**" if flip else \
              "net yield stays negative through year 6 (still in the subsidy phase)"
        print(f"\n*{scen}: {msg}.*\n")


def print_sotp():
    print("### 6. Sum-of-the-parts: a defensible FDV off forward fees\n")
    blended = sum(w * m for w, m in SOTP.values())
    print("| Revenue segment | Share of fees | P/F multiple | Contribution |")
    print("|---|--:|--:|--:|")
    for seg, (w, m) in SOTP.items():
        print(f"| {seg} | {fmt(100*w,0)}% | {fmt(m,0)}x | {fmt(w*m,1)}x |")
    print(f"| **Blended** | 100% | | **{fmt(blended,1)}x** |\n")
    print(f"*Blended P/F ≈ {fmt(blended,1)}x. Implied FDV = {fmt(blended,1)}x × "
          "annual fees. Year-6 fees per scenario:*\n")
    print("| Scenario | Year-6 fees | Implied FDV @ blended P/F | vs $50M reference |")
    print("|---|--:|--:|--:|")
    for scen, gmv in GMV.items():
        fees = gmv[-1] * BLENDED_TAKE
        fdv = fees * blended
        rich = fdv / (REF_FDV_PRICE * TOTAL_SUPPLY)
        print(f"| {scen} | {fmt(fees)} | {fmt(fdv)} | {fmt(rich,2)}x |")
    print(f"\n*A ${fmt(REF_FDV_PRICE*TOTAL_SUPPLY/1e6,0)}M reference FDV sits between "
          "Base and Bull year-6 fees — i.e. the market would be pricing a "
          "Base-plus trajectory, not today's run-rate. Honest, not cheap.*\n")


def print_rover_economics():
    print("### 7. Per-rover unit economics (the operator's franchise)\n")
    print(f"*Rover capex ≈ ${fmt(ROVER_CAPEX)} (Waveshare UGV + Jetson Orin NX). "
          f"Emissions valued at ${REF_FDV_PRICE}/CLANK.*\n")
    print("| | Jobs/yr | USDC revenue (net of take) | Emissions value | Opex | "
          "Net income | Payback | Emissions % of income |")
    print("|---|--:|--:|--:|--:|--:|--:|--:|")
    for label, (jobs, price, opex, reward) in ROVER.items():
        usdc = jobs * price * (1 - BLENDED_TAKE)
        emis = jobs * reward * REF_FDV_PRICE
        net = usdc + emis - opex
        payback_mo = ROVER_CAPEX / net * 12 if net > 0 else float("inf")
        emis_pct = 100 * emis / (usdc + emis) if (usdc + emis) > 0 else 0
        print(f"| {label} | {fmt(jobs)} | {fmt(usdc)} | {fmt(emis)} | {fmt(opex)} | "
              f"{fmt(net)} | {fmt(payback_mo,1)} mo | {fmt(emis_pct,0)}% |")
    print("\n*Capex is recovered in weeks — the binding constraint is **utilization "
          "(jobs/rover)**, a demand problem, not a capex one. Emissions are ~34% of "
          "operator income in year 1 (subsidy doing its job) and ~13% by year 4 "
          "(real fees take over) — the franchise-level mirror of the macro taper.*\n")


# ─────────────────────────────────────────────────────────────────────────────
# STAKING APR  &  DCF  — what a staker earns, and what the cash flows are worth.
# ─────────────────────────────────────────────────────────────────────────────

# Fee split (must sum to 1): buyback / staker-yield / ops. Mirrors §5's 60/30/10.
SPLIT_BUYBACK   = 0.60
SPLIT_STAKER    = 0.30          # paid as REAL yield in USDC (defensible, non-reflexive)
SPLIT_OPS       = 0.10
ACCRUAL_SHARE   = SPLIT_BUYBACK + SPLIT_STAKER   # share of fees accruing to holders

# Circulating-supply schedule (fraction of 1B), excluding still-locked buckets.
AIRDROP, LIQUIDITY = 0.30, 0.02          # unlocked at TGE
CORE, ECOSYSTEM    = 0.20, 0.10          # vested over time
CORE_VEST_YEARS    = (2, 3, 4)           # 1-yr cliff, then linear years 2–4
ECO_VEST_YEARS     = (1, 2, 3, 4)        # linear years 1–4

STAKE_PARTICIPATION = [0.20, 0.40, 0.60]  # % of circulating that is staked (sweep)
PEAK_ESCROW_USD     = 50_000              # largest single settlement a verifier gates

# DCF
DISCOUNT_RATES   = [0.25, 0.35, 0.45]     # crypto cost of equity band
TERMINAL_GROWTH  = 0.04                   # Gordon-growth terminal rate
EXIT_PF          = 10.6                   # blended P/F from SOTP (§12.3)


def circulating(scen):
    """End-of-year circulating supply (CLANK) per year for a scenario."""
    jobs = JOBS_BULL if scen == "Bull" else JOBS_BASE
    em = actual_emissions(jobs)
    out = []
    base = (AIRDROP + LIQUIDITY) * TOTAL_SUPPLY
    for y in range(1, YEARS + 1):
        core = CORE * TOTAL_SUPPLY * sum(1 for yr in CORE_VEST_YEARS if yr <= y) / len(CORE_VEST_YEARS)
        eco = ECOSYSTEM * TOTAL_SUPPLY * sum(1 for yr in ECO_VEST_YEARS if yr <= y) / len(ECO_VEST_YEARS)
        out.append(base + core + eco + em[y - 1]["cum"])
    return out


def print_staking_apr():
    print("### 8. Staking APR — real (USDC) yield to the security layer\n")
    print(f"*Stakers bond $CLANK to secure the verifier/attestation layer "
          f"(slashable) and receive **{int(SPLIT_STAKER*100)}% of fees as real "
          f"USDC yield** (not reflexive emissions). "
          f"APR = staker fee pool ÷ (participation × circulating × ${REF_FDV_PRICE}).*\n")
    circ = circulating("Base")
    print("**Base case, 40% of circulating staked**\n")
    print("| Year | Fees | Staker pool (USDC) | Circulating | Staked value (USD) | "
          "Staking APR |")
    print("|---|--:|--:|--:|--:|--:|")
    for y in range(YEARS):
        fees = GMV["Base"][y] * BLENDED_TAKE
        pool = fees * SPLIT_STAKER
        staked_val = 0.40 * circ[y] * REF_FDV_PRICE
        apr = pool / staked_val
        print(f"| {y+1} | {fmt(fees)} | {fmt(pool)} | {fmt(circ[y])} | "
              f"{fmt(staked_val)} | {fmt(100*apr,2)}% |")
    print("\n**Year-6 APR vs. staking participation** (more stakers ⇒ thinner yield)\n")
    print("| Participation | Base APR | Bull APR | + if buyback distributed not burned |")
    print("|---|--:|--:|--:|")
    cb, cu = circulating("Base"), circulating("Bull")
    for p in STAKE_PARTICIPATION:
        fb = GMV["Base"][-1] * BLENDED_TAKE
        fu = GMV["Bull"][-1] * BLENDED_TAKE
        apr_b = fb * SPLIT_STAKER / (p * cb[-1] * REF_FDV_PRICE)
        apr_u = fu * SPLIT_STAKER / (p * cu[-1] * REF_FDV_PRICE)
        # upside: if the 60% buyback were streamed to stakers instead of burned
        apr_b_full = fb * ACCRUAL_SHARE / (p * cb[-1] * REF_FDV_PRICE)
        print(f"| {int(p*100)}% | {fmt(100*apr_b,2)}% | {fmt(100*apr_u,2)}% | "
              f"Base → {fmt(100*apr_b_full,2)}% |")
    # security-budget adequacy
    staked_low = 0.20 * cb[0] * REF_FDV_PRICE
    print(f"\n*__Security budget check:__ at 20% participation in year 1, staked "
          f"value ≈ ${fmt(staked_low)} vs. a peak single settlement of "
          f"${fmt(PEAK_ESCROW_USD)} — a {fmt(staked_low/PEAK_ESCROW_USD,0)}× cushion. "
          "A corrupt verdict must risk far more (slashable stake) than it could "
          "steal, so the attestation layer is economically secured. The check that "
          "must hold every epoch: staked value ≫ peak value-at-risk.*\n")


def print_dcf():
    print("### 9. DCF — what the cash flows are worth **today**\n")
    print(f"*Distributable cash flow = **{int(ACCRUAL_SHARE*100)}% of fees** "
          "(buyback + staker yield; ops excluded as cost). Two terminal methods "
          "triangulated: exit multiple (P/F = "
          f"{EXIT_PF}x) and Gordon growth (g = {int(TERMINAL_GROWTH*100)}%). "
          "Implied FDV = PV(explicit 6y CF) + PV(terminal).*\n")
    print("| Scenario | Discount rate | PV explicit | PV terminal (exit) | "
          "PV terminal (Gordon) | Implied FDV (avg) | Implied price |")
    print("|---|--:|--:|--:|--:|--:|--:|")
    for scen in ("Base", "Bull"):
        fees = [GMV[scen][y] * BLENDED_TAKE for y in range(YEARS)]
        cf = [f * ACCRUAL_SHARE for f in fees]
        for r in DISCOUNT_RATES:
            pv_explicit = sum(cf[y] / (1 + r) ** (y + 1) for y in range(YEARS))
            df6 = 1 / (1 + r) ** YEARS
            tv_exit = EXIT_PF * fees[-1] * df6
            tv_gordon = cf[-1] * (1 + TERMINAL_GROWTH) / (r - TERMINAL_GROWTH) * df6
            fdv = pv_explicit + (tv_exit + tv_gordon) / 2
            print(f"| {scen} | {int(r*100)}% | {fmt(pv_explicit)} | {fmt(tv_exit)} | "
                  f"{fmt(tv_gordon)} | **{fmt(fdv)}** | ${fmt(fdv/TOTAL_SUPPLY,4)} |")
    print("\n**Base-case sensitivity — implied FDV (avg terminal)**\n")
    print("| Discount ↓ / Exit P/F → | 6x | 10.6x | 16x |")
    print("|---|--:|--:|--:|")
    feesB = [GMV["Base"][y] * BLENDED_TAKE for y in range(YEARS)]
    cfB = [f * ACCRUAL_SHARE for f in feesB]
    for r in DISCOUNT_RATES:
        row = [f"{int(r*100)}%"]
        for pf in (6.0, 10.6, 16.0):
            pv = sum(cfB[y] / (1 + r) ** (y + 1) for y in range(YEARS))
            df6 = 1 / (1 + r) ** YEARS
            tv_exit = pf * feesB[-1] * df6
            tv_g = cfB[-1] * (1 + TERMINAL_GROWTH) / (r - TERMINAL_GROWTH) * df6
            row.append(fmt(pv + (tv_exit + tv_g) / 2))
        print("| " + " | ".join(row) + " |")
    print(f"\n*Reconciliation: §12.3's $21.2M is a **year-6 forward** value; the DCF "
          "discounts that stream to **today**. At a 35% crypto hurdle, **Base "
          "supports single-digit millions of FDV now** — a $50M valuation requires "
          "the **Bull** trajectory *and* a sub-30% discount rate. You buy the "
          "growth, not the run-rate.*\n")


# ─────────────────────────────────────────────────────────────────────────────
# MONTE CARLO  — a probabilistic fair value instead of three point scenarios.
# ─────────────────────────────────────────────────────────────────────────────
MC_TRIALS         = 50_000
MC_SEED           = 42
GMV6_MEDIAN       = 50_000_000     # median terminal-year GMV (= Base yr6); lognormal
GMV6_SIGMA        = 1.30           # log-dispersion: ~P10 $9M … ~P90 $270M
TAKE_TRI          = (0.03, 0.05, 0.04)   # (low, high, mode) blended take-rate
DISCOUNT_TRI      = (0.25, 0.45, 0.35)   # crypto cost of equity
EXIT_PF_TRI       = (6.0, 16.0, 10.6)    # terminal P/F
REG_HIT_PROB      = 0.12           # P(serious gambling/securities enforcement event)
REG_HIT_HAIRCUT   = 0.50           # cash-flow multiplier if it happens

# year-1..6 ramp shape, normalized to the terminal year (preserves the S-curve)
_RAMP = [g / GMV["Base"][-1] for g in GMV["Base"]]


def _pct(sorted_vals, q):
    i = q * (len(sorted_vals) - 1)
    lo, hi = int(math.floor(i)), int(math.ceil(i))
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (i - lo)


def _pearson(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sx = sum((x - mx) ** 2 for x in xs) ** 0.5
    sy = sum((y - my) ** 2 for y in ys) ** 0.5
    if sx == 0 or sy == 0:
        return 0.0
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)


def run_monte_carlo(reg_prob=REG_HIT_PROB, haircut_on_hit=REG_HIT_HAIRCUT,
                    gmv_scale=1.0, exit_pf_tri=EXIT_PF_TRI,
                    discount_tri=DISCOUNT_TRI):
    rng = random.Random(MC_SEED)
    mu = math.log(GMV6_MEDIAN)
    fdvs = []
    samples = {"GMV (terminal)": [], "Take-rate": [], "Discount rate": [],
               "Exit P/F": [], "Regulatory hit": []}
    for _ in range(MC_TRIALS):
        gmv6 = math.exp(rng.gauss(mu, GMV6_SIGMA)) * gmv_scale
        take = rng.triangular(*TAKE_TRI)
        r = rng.triangular(*discount_tri)
        pf = rng.triangular(*exit_pf_tri)
        hit = rng.random() < reg_prob
        haircut = haircut_on_hit if hit else 1.0

        fees = [gmv6 * f * take for f in _RAMP]
        cf = [f * ACCRUAL_SHARE * haircut for f in fees]
        pv_explicit = sum(cf[y] / (1 + r) ** (y + 1) for y in range(YEARS))
        df6 = 1 / (1 + r) ** YEARS
        tv_exit = pf * fees[-1] * haircut * df6
        tv_gordon = cf[-1] * (1 + TERMINAL_GROWTH) / (r - TERMINAL_GROWTH) * df6
        fdv = pv_explicit + (tv_exit + tv_gordon) / 2

        fdvs.append(fdv)
        samples["GMV (terminal)"].append(gmv6)
        samples["Take-rate"].append(take)
        samples["Discount rate"].append(r)
        samples["Exit P/F"].append(pf)
        samples["Regulatory hit"].append(1.0 if hit else 0.0)
    return fdvs, samples


def print_monte_carlo():
    fdvs, samples = run_monte_carlo()
    s = sorted(fdvs)
    n = len(s)
    ref_fdv = REF_FDV_PRICE * TOTAL_SUPPLY
    mean = sum(s) / n

    print(f"### 10. Monte Carlo fair value ({fmt(MC_TRIALS)} trials, seed {MC_SEED})\n")
    print("*Samples the five inputs that actually move value: terminal GMV "
          f"(lognormal, ${fmt(GMV6_MEDIAN/1e6,0)}M median), take-rate, discount "
          "rate, exit P/F, and a binary **regulatory hit** "
          f"({int(REG_HIT_PROB*100)}% chance of a {int((1-REG_HIT_HAIRCUT)*100)}% "
          "cash-flow impairment). Same DCF engine as §9.*\n")
    print("| Percentile | Implied FDV | Implied price |")
    print("|---|--:|--:|")
    for label, q in [("P5", .05), ("P10", .10), ("P25", .25), ("P50 (median)", .50),
                     ("P75", .75), ("P90", .90), ("P95", .95)]:
        v = _pct(s, q)
        print(f"| {label} | {fmt(v)} | ${fmt(v/TOTAL_SUPPLY,4)} |")
    print(f"| **Mean** | **{fmt(mean)}** | **${fmt(mean/TOTAL_SUPPLY,4)}** |")

    p_ref = sum(1 for v in s if v >= ref_fdv) / n
    p_100 = sum(1 for v in s if v >= 100e6) / n
    p_10 = sum(1 for v in s if v >= 10e6) / n
    print(f"\n**Probabilities:** "
          f"P(FDV ≥ $10M) = {fmt(100*p_10,0)}% · "
          f"P(FDV ≥ $50M reference) = {fmt(100*p_ref,0)}% · "
          f"P(FDV ≥ $100M) = {fmt(100*p_100,0)}%\n")

    # tornado: |correlation| of each input vs ln(FDV)
    lnf = [math.log(v) for v in fdvs]
    tor = sorted(((abs(_pearson(samples[k], lnf)), k) for k in samples),
                 reverse=True)
    print("**What drives the spread (|corr| with ln FDV):**\n")
    print("| Input | Influence |")
    print("|---|--:|")
    for c, k in tor:
        bar = "█" * max(1, round(c * 30))
        print(f"| {k} | {bar} {fmt(c,2)} |")
    print(f"\n*Median ${fmt(_pct(s,.5)/1e6,1)}M, mean ${fmt(mean/1e6,1)}M — "
          "right-skewed, the venture-outcome shape (a few big wins drag the mean "
          f"above the median). The $50M reference clears only ~{fmt(100*p_ref,0)}% "
          "of the time: this is a growth/optionality price, and **terminal GMV "
          "(execution) dominates the outcome** — discount rate and multiple are "
          "second-order, and the regulatory tail is real but not the main driver "
          "of dispersion.*\n")


# ─────────────────────────────────────────────────────────────────────────────
# RING-FENCE  — isolate the betting rake in a licensed entity; the token accrues
# a clean license fee instead of raw gambling revenue. Quantify the trade.
# ─────────────────────────────────────────────────────────────────────────────
# Token-accruing revenue mix BEFORE ring-fencing (= SOTP in §12.3).
SOTP_BEFORE = SOTP
# AFTER: betting rake (25% @ 6x) leaves the token; it returns as a clean license
# fee worth ~40% of the former rake, at a SaaS-like 12x. Other lines unchanged.
LICENSE_FEE_RETENTION = 0.40
LICENSE_FEE_PF        = 12.0


def _blended_pf(segments):
    tot = sum(w for w, _ in segments.values())
    return sum((w / tot) * m for w, m in segments.values())


def print_ringfence():
    print("### 11. Ring-fencing the betting rake — the quantified trade\n")
    before = _blended_pf(SOTP_BEFORE)
    # rebuild the after-mix: drop betting, add a license-fee line
    after_segments = {k: v for k, v in SOTP_BEFORE.items() if "Betting" not in k}
    after_segments["Betting license fee (clean, recurring)"] = (
        0.25 * LICENSE_FEE_RETENTION, LICENSE_FEE_PF)
    after = _blended_pf(after_segments)
    token_fee_base = sum(w for w, _ in after_segments.values())  # vs 1.0 before

    print("**Blended P/F (token-accruing revenue):**\n")
    print(f"- Before: **{fmt(before,1)}x** on 100% of fees "
          "(incl. a 25% gambling rake at 6x).")
    print(f"- After:  **{fmt(after,1)}x** on {fmt(100*token_fee_base,0)}% of fees "
          "(rake replaced by a license fee at "
          f"{fmt(LICENSE_FEE_PF,0)}x; gambling risk now sits in the licensed sub).")
    print(f"- Forward FDV ≈ {fmt(after,1)}x × {fmt(token_fee_base,2)} vs "
          f"{fmt(before,1)}x × 1.00 → **{fmt(100*after*token_fee_base/before,0)}% "
          "of the un-fenced value — essentially flat, but de-risked.**\n")

    # Monte Carlo: token with betting in (baseline) vs ring-fenced.
    base_fdvs, _ = run_monte_carlo()
    rf_fdvs, _ = run_monte_carlo(
        reg_prob=0.03,                       # gambling tail leaves the token
        gmv_scale=0.75 + 0.25 * LICENSE_FEE_RETENTION,   # betting → thin license fee
        discount_tri=(0.22, 0.42, 0.32),     # cleaner asset, ~3pt lower hurdle
    )
    b, rf = sorted(base_fdvs), sorted(rf_fdvs)
    ref = REF_FDV_PRICE * TOTAL_SUPPLY
    print("**Monte Carlo on the token (betting-in vs ring-fenced):**\n")
    print("| Metric | Betting in token | **Ring-fenced** |")
    print("|---|--:|--:|")
    print(f"| Median FDV | {fmt(_pct(b,.5))} | **{fmt(_pct(rf,.5))}** |")
    print(f"| Mean FDV | {fmt(sum(b)/len(b))} | **{fmt(sum(rf)/len(rf))}** |")
    print(f"| P10 (downside) | {fmt(_pct(b,.10))} | **{fmt(_pct(rf,.10))}** |")
    print(f"| P(FDV ≥ $10M) | {fmt(100*sum(1 for v in b if v>=10e6)/len(b),0)}% | "
          f"**{fmt(100*sum(1 for v in rf if v>=10e6)/len(rf),0)}%** |")
    print(f"| P(FDV ≥ $50M) | {fmt(100*sum(1 for v in b if v>=ref)/len(b),0)}% | "
          f"**{fmt(100*sum(1 for v in rf if v>=ref)/len(rf),0)}%** |")
    print("\n*Ring-fencing is roughly **FDV-neutral on the median** — you trade 25% "
          "of revenue for a cleaner 12x license fee and a ~3pt lower discount rate "
          "— while **lifting the downside (P10)** and removing the gambling tail "
          "from the token entirely. The real prize is qualitative: Howey-clean, "
          "CEX-listable, and the labor market can't be killed by a betting "
          "enforcement action.*\n")


# ─────────────────────────────────────────────────────────────────────────────
# GMV DECOMPOSITION — bottom-up unit build, to audit the top-down GMV and the
# SOTP fee-mix. Per-line take-rates turn volumes into a FEE mix (the real test).
# ─────────────────────────────────────────────────────────────────────────────
# Base-case activity drivers, one array per year (1..6).
DRV = {
    "rovers":       [40, 90, 200, 400, 700, 950],
    "hires_rover":  [650, 950, 1500, 2200, 2800, 3200],
    "hire_price":   [18, 17, 16, 15, 14, 13],
    "races":        [600, 1500, 3000, 5000, 7000, 9000],
    "racers":       [4, 4, 5, 6, 6, 6],
    "entry_fee":    [5, 5, 6, 6, 7, 7],
    "bettors":      [35, 55, 75, 90, 95, 100],
    "avg_bet":      [8, 10, 12, 13, 14, 14],
    "pilots":       [40_000, 150_000, 450_000, 1_000_000, 1_800_000, 2_600_000],
    "passes":       [1_500, 4_000, 9_000, 16_000, 24_000, 32_000],
    "pass_price":   [25, 25, 28, 30, 32, 35],
}
# Per-line take-rate (§4) and the P/F multiple that line's FEES deserve.
LINE = {  # name: (take-rate, P/F multiple)
    "Hire (labor)":  (0.04, 18.0),
    "Race entry":    (0.05, 10.0),
    "Betting":       (0.015, 6.0),
    "Pilot":         (0.08, 4.0),
    "Passes":        (0.03, 2.0),
}


def gmv_lines(y):
    """Bottom-up GMV by line for year index y (0..5)."""
    d = DRV
    return {
        "Hire (labor)": d["rovers"][y] * d["hires_rover"][y] * d["hire_price"][y],
        "Race entry":   d["races"][y] * d["racers"][y] * d["entry_fee"][y],
        "Betting":      d["races"][y] * d["bettors"][y] * d["avg_bet"][y],
        "Pilot":        d["pilots"][y] * 1.0,
        "Passes":       d["passes"][y] * d["pass_price"][y],
    }


def print_gmv_decomp():
    print("### 12. GMV decomposition — bottom-up, and the FEE-mix audit\n")
    print("*Replaces the single blended GMV with a unit build (fleet × hires × "
          "price, races × bettors × bet, $1 pilots, passes). Reconciled to the "
          "top-down Base scenario.*\n")
    print("| Year | Hire | Race entry | Betting | Pilot | Passes | **Total** | "
          "Top-down Base | Ratio |")
    print("|---|--:|--:|--:|--:|--:|--:|--:|--:|")
    for y in range(YEARS):
        g = gmv_lines(y)
        tot = sum(g.values())
        td = GMV["Base"][y]
        print(f"| {y+1} | {fmt(g['Hire (labor)'])} | {fmt(g['Race entry'])} | "
              f"{fmt(g['Betting'])} | {fmt(g['Pilot'])} | {fmt(g['Passes'])} | "
              f"**{fmt(tot)}** | {fmt(td)} | {fmt(tot/td,2)}x |")
    # year-6 GMV mix vs FEE mix
    g6 = gmv_lines(YEARS - 1)
    gtot = sum(g6.values())
    fees6 = {k: g6[k] * LINE[k][0] for k in g6}
    ftot = sum(fees6.values())
    print("\n**Year-6 GMV mix vs. FEE mix** (low-rake lines shrink in fee terms):\n")
    print("| Line | GMV | % of GMV | Take | Fees | **% of fees** |")
    print("|---|--:|--:|--:|--:|--:|")
    for k in g6:
        print(f"| {k} | {fmt(g6[k])} | {fmt(100*g6[k]/gtot,0)}% | "
              f"{fmt(100*LINE[k][0],1)}% | {fmt(fees6[k])} | "
              f"**{fmt(100*fees6[k]/ftot,0)}%** |")
    print(f"| **Total** | {fmt(gtot)} | 100% | | {fmt(ftot)} | 100% |")
    # corrected blended P/F from the realized fee mix
    blended = sum((fees6[k] / ftot) * LINE[k][1] for k in g6)
    print(f"\n*__The audit result:__ betting is **{fmt(100*g6['Betting']/gtot,0)}% "
          f"of GMV but only {fmt(100*fees6['Betting']/ftot,0)}% of FEES** "
          "(its rake is thin), while hire fees are "
          f"**{fmt(100*fees6['Hire (labor)']/ftot,0)}% of fees.** So §12.3's 25% "
          "betting weight overstated the gambling drag: the realized fee mix gives "
          f"a blended **P/F ≈ {fmt(blended,1)}x** — Hyperliquid territory, not "
          "10.6x. Two consequences: fair value is **higher** than §13/§14 modeled "
          "(re-run below), and the ring-fence case is **stronger** — you carry "
          "large gambling *volume* for tiny *fees*.*\n")
    # MC re-run at the corrected multiple
    base, _ = run_monte_carlo()
    corr, _ = run_monte_carlo(exit_pf_tri=(8.0, 20.0, blended))
    b, c = sorted(base), sorted(corr)
    ref = REF_FDV_PRICE * TOTAL_SUPPLY
    print(f"**Monte Carlo re-run at the audited multiple (mode {fmt(blended,1)}x):**\n")
    print("| Metric | §14 (10.6x mode) | **Audited (~15x mode)** |")
    print("|---|--:|--:|")
    print(f"| Median FDV | {fmt(_pct(b,.5))} | **{fmt(_pct(c,.5))}** |")
    print(f"| Mean FDV | {fmt(sum(b)/len(b))} | **{fmt(sum(c)/len(c))}** |")
    print(f"| P(FDV ≥ $50M) | {fmt(100*sum(1 for v in b if v>=ref)/len(b),0)}% | "
          f"**{fmt(100*sum(1 for v in c if v>=ref)/len(c),0)}%** |")
    upl = _pct(c, .5) / _pct(b, .5) - 1
    print(f"\n*The audited mix lifts median fair value **~{fmt(100*upl,0)}%** — a "
          "real upward revision that came from **decomposing one number**, not from "
          "optimism (it's muted because the exit multiple is only half the terminal "
          "value; Gordon growth is unchanged). Caveat: the fee mix is sensitive to "
          "the per-line take-rates (§4) — those are the assumptions to defend.*\n")


if __name__ == "__main__":
    print("# $CLANK emission-cap & buyback — model output\n")
    print_cap_schedule()
    print_emissions("Base", actual_emissions(JOBS_BASE))
    print_emissions("Bull", actual_emissions(JOBS_BULL))
    print_buyback()
    print_flip()
    print("\n---\n## TradFi lens\n")
    print_shareholder_yield()
    print_sotp()
    print_rover_economics()
    print_staking_apr()
    print_dcf()
    print_monte_carlo()
    print_ringfence()
    print_gmv_decomp()
