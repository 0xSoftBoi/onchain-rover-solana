# Clanker 5000 — mainnet readiness & next steps

This program escrows and pays out **real USDC** (race stakes, parimutuel bets,
treasury). Going to mainnet is a security + operations + **legal** undertaking,
not a redeploy. This is the ordered plan.

> Context: after the **$270M Drift exploit (Apr 2026)** the Solana Foundation
> stood up an Incident Response Network (OtterSec, Neodyme, Squads, Asymmetric
> Research, ZeroShadow). Bar for money-handling programs is high. Sources at the
> bottom.

---

## 0. Hard blockers (do NOT deploy to mainnet without these)

1. **Professional security audit** of `clanker5000` (it custodies funds).
2. **Verifiable build** published (`solana-verify`) so the on-chain bytecode
   provably matches this repo.
3. **Upgrade authority on a Squads v4 multisig** (+ timelock) — never a single
   hot keypair.
4. **Legal review of the betting mechanic** — parimutuel wagering with real USDC
   is regulated gambling in most jurisdictions (see §5). This may gate the whole
   product, not just the deploy.
5. **Real Circle USDC mint** (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) —
   not a test mint; reconcile the 6dp assumptions.

---

## 1. Security

**Audit.** Engage one (ideally two) of the established Solana firms: **OtterSec,
Neodyme, Zellic, Sec3, Offside Labs, Zenith, Accretion**. Budget realistically
**4–8 weeks lead time** and a five-figure+ engagement; book early. Ship them a
frozen commit + this repo + threat model.

**Program-specific risks to harden first** (so the audit isn't spent on basics):
- **Parimutuel payout** (`claim`) floors `amount × total_pool / win_pool`; the
  rounding **dust** accumulates in the market vault and is currently
  unreclaimable. Decide: sweep-to-treasury instruction, or accept + document.
- **Facilitator trust** — the facilitator key drives the whole race lifecycle
  (open/lock/start/finish/settle). On mainnet that key is a powerful role: put it
  behind a hardened signer (Privy TEE / HSM), and scope what it can do.
- **Attestation forwarder** — `write_attestation` has a zero-key sim escape hatch
  (`forwarder == default → any reporter`). **Disable that on mainnet**: set the
  forwarder to the real Switchboard authority; never ship the open path.
- **Treasury authority** — `withdraw_treasury` is owner-gated; the owner MUST be
  a Ledger/Squads signer, never the sidecar.
- **Self-feedback / sybil** — reputation rejects self-feedback; betting uses a
  World ID nullifier PDA. Verify World ID proofs **server-side against the real
  verifier** before `place_bet`, and confirm the nullifier derivation.
- **Arithmetic** — checked math is used; the auditor should confirm no
  unchecked casts in payout/fee paths.
- **PDA/account validation** — confirm every `Account<>` constraint (mint, vault,
  owner) so a caller can't substitute a look-alike account.

**Internal hardening before the audit:**
- Add a **fuzz / invariant suite** (e.g. **Trident** for Anchor) covering the
  payout math, the one-bet-per-human invariant, and vault solvency
  (vault balance ≥ sum of claimable). The repo already has `cargo test` unit
  tests for `parimutuel_payout` and `anchor test` 3/3 — extend, don't replace.
- **Verifiable build**: `solana-verify build` + publish; after deploy, run the
  remote verify job (mainnet only) so `verify` shows source ↔ on-chain match.

---

## 2. Deployment & operations

- **sbpf version: v2.** Mainnet has **not** enabled SBPFv3 (SIMD-0178 inactive)
  or Loader-v4 (SIMD-0167 inactive). Build with **`cargo build-sbf --arch v2`**
  (done — `e_flags=0x2`). Re-check the feature gates at deploy time; move to v3
  only once mainnet activates it.
- **Upgrade authority → Squads v4.** Deploy with a throwaway authority, then
  `set-upgrade-authority` to a Squads multisig. All future upgrades go through
  multisig (+ timelock). Keep a documented "make immutable" option for when the
  program stabilizes.
- **RPC: paid tier.** The free Helius tier (10 RPS) makes even *deploys* crawl;
  production needs a paid Helius/Triton plan (staked sends, higher RPS, webhooks
  for indexing/monitoring). See [`HELIUS.md`](./HELIUS.md).
- **Deploy cost is real money:** ~4.6 SOL rent for the program + priority fees.
  Fund the deployer; use `--use-rpc` + a buffer (see [`DEPLOY_SOLANA.md`](./DEPLOY_SOLANA.md)).
- **Priority fees** are already wired on settlement writes
  (`helius.ts:priorityPreInstructions`) — keep them; tune levels under real
  congestion.
- **Monitoring & circuit breakers:** Helius webhooks (paid) on program logs →
  alerting; a Squads-gated "pause" path or timelock for emergency response.

---

## 3. External integrations to productionize

Each is scaffolded but needs a real account/key/funding on mainnet:

| Integration | Mainnet action |
|---|---|
| **USDC** | Use Circle's real mint; for cross-chain, wire **CCTP V2** (Solana supported). |
| **RPC / data** | Paid Helius/Triton; move indexing to webhooks/LaserStream. |
| **Kora gasless** | Self-host a hardened Kora relayer (fee-payer key custody) or a managed one; set the token allowlist. |
| **Switchboard** | Create the On-Demand feed/function; set the program `forwarder` to its authority; remove the sim escape hatch. |
| **Privy** | Production app + server-wallet policy; TEE custody for the facilitator key. |
| **SNS** | Register the real `roverfleet.sol` (+ subdomains) — costs SOL; set agent-context records. |
| **World ID** | Production app id + action; verify proofs server-side. |
| **Walrus** | Mainnet publisher/aggregator; pin retention for proofs. |
| **Treasury** | Owner = Ledger or Squads; rehearse the clear-sign withdraw on device. |

---

## 4. Testing path to mainnet

1. **Devnet soak** (in progress) — deploy v2, run full race + market + payout +
   treasury withdraw end-to-end against live devnet, with the real sidecar.
2. **Load / e2e** — many concurrent bettors (nullifier contention), settlement
   under priority-fee congestion.
3. **Fuzz/invariant** suite green (Trident).
4. **Audit** + fix + re-review.
5. **Mainnet deploy** (verifiable build) → transfer authority to Squads →
   remote-verify → smoke test with capped stakes → open up.

---

## 5. Legal & compliance (the real gate)

**This is likely the biggest non-technical blocker.** Real-money parimutuel
betting is **regulated gambling** in most jurisdictions, and moving USDC for
others can trigger **money-transmission / AML / KYC** obligations.

- Get **specialist crypto/gaming counsel** before any mainnet real-money launch.
- Decide jurisdiction, geofencing, age/KYC, and whether bets are play-money vs
  real-value.
- The **x402 wages / EventPass** (paying to hire/pilot a robot) are commercial
  payments — lighter, but still review.
- Consider a **regulatory-safe mainnet v1**: hire/pilot/reputation/treasury live
  with USDC, but the **betting market disabled or play-money** until licensing is
  sorted. The program already separates these (escrow/market are distinct
  instruction groups), so you can launch a subset.

---

## Recommended sequence

1. Finish **devnet soak** on sbpf v2 (deploying now).
2. Add **fuzz/invariant** tests + close the dust/forwarder/facilitator items.
3. **Legal review** in parallel (long pole) — decide the v1 product surface.
4. **Audit** (book now; 4–8 wk lead).
5. **Verifiable build** + **Squads** upgrade authority + paid RPC + monitoring.
6. Productionize external integrations (§3).
7. **Mainnet deploy** (capped) → verify → gradual open-up.

---

### Sources
- Verified builds: https://solana.com/docs/programs/verified-builds ·
  https://solana.com/developers/guides/advanced/verified-builds
- Squads v4: https://github.com/Squads-Protocol/v4 ·
  https://github.com/solana-developers/verify-squads
- 2026 audit/security checklist: https://www.zealynx.io/blogs/solana-2026-security ·
  https://dev.to/ohmygod/solana-program-security-checklist-14-critical-checks-before-you-deploy-to-mainnet-2d66
- Audit firms / IR network: https://github.com/solana-labs/security-audits ·
  https://www.coindesk.com/tech/2026/04/07/solana-foundation-unveils-security-overhaul-days-after-usd270-million-drift-exploit
- Feature gates checked live via `solana feature status` (devnet enables SBPFv3;
  mainnet does not — build sbpf **v2**).
