<div align="center">

# 🏁 THE ONCHAIN ROVER
### *Clanker 5000 · Rover Grand Prix*

> **"Every agent at this hackathon lives behind a screen. Ours has a body, a bank account, a reputation — and a human who holds the keys."**

<br>

[![Solana Native](https://img.shields.io/badge/Solana-Native-14F195?style=for-the-badge&logo=solana&logoColor=black)](https://solana.com)
[![Two Rovers](https://img.shields.io/badge/Rovers-2%20on%20track-FFD400?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTIxIDZIMTlWNEgxM1Y2SDExVjRINVY2SDNWMTRDM..." )](.)
[![SPL USDC Stakes](https://img.shields.io/badge/Stakes-SPL%20USDC-00D061?style=for-the-badge)](.)
[![World ID](https://img.shields.io/badge/World%20ID-Sybil--proof-E10600?style=for-the-badge)](.)
[![Anchor Program](https://img.shields.io/badge/Anchor-0.31%20%2F%20Agave%204.0-9945FF?style=for-the-badge)](.)

</div>

---

## 🤖 What It Is

Every AI agent at this hackathon is trapped behind a screen. We gave two of them
bodies — real robots you **hire over HTTP**, that earn an on-chain reputation and
get paid in USDC for provable work.

They negotiate with each other in chirps, settle their own bets, and their treasury
opens only when a human signs on a Ledger. Then we let the crowd pay to pilot them
and bet on the race.

---

## 🔧 The Product

Two autonomous rovers (Jetson Orin NX, onboard LLM) as full economic actors:

- **`guard.roverfleet.sol` + `courier.roverfleet.sol`** — SNS fleet identity; records
  point each name at its ERC-8004-style on-chain agent identity
- **Hiring = an HTTP request.** A `402 Payment Required` is answered with a USDC
  micropayment (**x402** on Solana, gas paid via Kora relayer in USDC) — no invoice,
  no human in the loop. The robot takes the job the instant the payment clears.
- Every job returns **trustless proof**: photo + on-device vision verdict, stored
  on **Walrus**, hash anchored in an ERC-8004-style reputation record written by the
  REQUESTER (contract forbids self-feedback)
- Two reputation surfaces: the rover's **local Solana** rep, plus a network-wide rank
  over **mainnet** on a live **leaderboard**. Skill-tagged ("98% as guard, 91% as courier").
- A **World-ID-verified human stands behind each robot** (AgentBook), and the
  treasury moves only when a human clear-signs on a **Ledger**

---

## 💸 The Flywheel

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   hire (x402 / SPL-USDC)  →  robot acts  →  vision verifies    │
│          ▲                                          │           │
│   on-chain rank  ◄──  ERC-8004-style rep  ◄──  requester rates │
│                                                                 │
│   Proof earns reputation. Reputation earns rank.               │
│   Rank earns the next hire. Remove one sponsor → loop breaks.  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

> [!IMPORTANT]
> Every sponsor is a load-bearing organ in this loop — not a logo on the slide.

---

## 🎬 The Demo — Race Program

### 🏎️ Act 1 · The Checkpoint `[0:00 – 1:30]`

| # | Beat | What happens on-chain |
|---|------|----------------------|
| 1 | **Hire** | Software agent hires COURIER over x402 for a delivery | SPL-USDC micropayment clears instantly |
| 2 | **Approach** | Courier drives to GUARD; they greet in speech, recognize each other as AI, **switch to GibberLink** — chirping wallet + signed challenge as data-over-sound | — |
| 3 | **Denied** | Guard verifies on-chain (ERC-8004-style? human-backed? holds pass?) → **DENIED** | Program instruction checked |
| 4 | **Negotiate** | Two robots run a live **Dutch auction over GibberLink** → courier pays USDC robot-to-robot → pass minted → **ADMITTED** | `mint_pass` on-chain |
| 5 | **Proof** | Task done → vision verdict → Walrus proof → requester writes ERC-8004-style feedback → leaderboard ticks live | `give_feedback` |
| 6 | **Climax** | Fleet earnings won't move until a human clear-signs the withdrawal on a physical **Ledger** — robots earn all day, only a person cashes out | `withdraw_treasury` |

---

### 🏆 Act 2 · Rover GP `[1:30 – end]`

| Feature | Mechanic | The magic |
|---------|----------|-----------|
| **Pay to Pilot** | $1 x402 session | WebRTC video (~250ms, NVENC on Jetson) + WebSocket joystick @20Hz; when money stops, robot stops |
| **Bet** | QR → live odds → World ID | One bet per human — sybil-broken via nullifier PDA; instant wallet, SPL-USDC on Solana, bet in <60s |
| **Robots settle the market** | ArUco lap detection, overhead cam | GUARD attests the finish: vision-verified photo hash + Walrus blobId go on-chain in `settle_market`; judge role rotatable only via Ledger-signed governance |

> [!TIP]
> The crowd is **inside the market**. Every spectator with a phone is a participant. That's the race.

---

## 🏎️ Sponsors — Every One Load-Bearing

| Sponsor | What it IS | Breaks without it? |
|---------|-----------|-------------------|
| **SNS** | Fleet identity & discovery (`.sol` names → ERC-8004-style records) | No discovery |
| **Kora / SPL-USDC** | Wages & bets: gasless x402, USDC-as-gas on Solana | Can't pay $0.50 jobs |
| **World ID** | Human-backing + one-bet-per-human nullifiers | Sybil-farmed |
| **ERC-8004-style + Leaderboard** | On-chain résumé + rank | No inter-agent trust |
| **Walrus (Sui)** | Immutable proof storage, read-back verified | "Trust me" proofs |
| **On-device vision** | Perception + verification verdict | Robot can't see/prove |
| **Ledger** | Treasury/judge governance, clear-sign | Rogue-agent drain |
| **Switchboard On-Demand** | A DON independently re-verifies the robot's work (median consensus → on-chain); self-claims never settle | Robot grades its own homework |
| **Privy** | Robot signing keys live in a TEE, not on the host; Solana tx signed in-enclave | Stolen host = drained fleet |
| **Dynamic** | Instant visitor wallets | No 60s onboarding |
| **Blink** | Consumer deposit on-ramp | No top-up for normies |

---

## ✅ What's Real

> [!NOTE]
> Live on-chain right now — not mocked, not stubbed.

- Real SPL-USDC settlements on Solana, including a tx signed **inside a Privy TEE** — keys never on the host
- EventPass minted, ERC-8004-style feedback written by the requester, Walrus proofs read back and hash-matched
- A Treasury withdrawal physically gated by a **Ledger** (owner transferred to the device, clear-signed)
- `GET /attest` serving a verified **85/100** score for a **Switchboard DON** to consume
- The physical loop proven end-to-end: NL task → LLM plan → drive → photo proof

Two writes need only a login to fire — every contract is already deployed and we ship **no mock fallback**, so there's zero ambiguity about what's real vs. simulated.

**Monorepo:** `robot/` (Python on Jetsons) · `sidecar/` (TS crypto rails) · `solana/programs/clanker5000` (one Anchor program)

<div align="center">

🏁 ──────────────────── *Proof earns rank. Rank earns the hire.* ──────────────────── 🏁

</div>

<details>
<summary>⚙️ One Anchor Program — 24 instructions, 6 sponsors replaced by 1 program</summary>

One Anchor program (`clanker5000`) replaces what used to be six Solidity contracts:

- **Race escrow** — `initialize · open_race · join_race · lock_race · start_race · finish_race · settle_race · cancel_race · set_facilitator`
- **Parimutuel market** — `open_market · place_bet · settle_market · claim · set_judge`
- **Reputation** — `register_agent · give_feedback` (running avg, self-feedback rejected)
- **EventPass** — `init_event_pass · mint_pass`
- **Treasury** — `init_treasury · withdraw_treasury · set_treasury_owner`
- **Attestation** — `init_attestation · set_forwarder · write_attestation`

Stakes live in per-race PDA token vaults. One-human-one-bet is structural: a `nullifier` PDA seeded by the World ID nullifier `init`s once; a reused nullifier collides and fails.

</details>
