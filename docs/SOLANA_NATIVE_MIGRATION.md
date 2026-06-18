# Clanker 5000 — native-Solana migration decision record (2026)

This is the engineering decision record for replacing **all** remaining EVM
pieces of The Onchain Rover with native-Solana equivalents. It pairs with
[`SOLANA_PORT.md`](./SOLANA_PORT.md) (the per-component status tracker): that
file says *what is done*; this file says *which Solana library/protocol to use,
why, and the exact gotchas* — grounded in a 2026 sourced research pass.

> **Research provenance.** Claims tagged **[confirmed]** survived a 3-vote
> adversarial verification pass with primary sources. Claims tagged
> **[sourced]** have a primary source but the verification vote was inconclusive
> (rate-limited during the research run, *not* refuted) — treat them as strong
> leads to confirm against the cited doc before depending on them.

---

## 0. Baseline toolchain

| Decision | Choice | Notes |
|---|---|---|
| Validator/CLI | **Agave** client; `solana-cli` 3.0.x in the 2026 docs snapshot (Agave v4.x is latest) **[sourced]** | "Solana Labs" client is retired; everything is Agave/Anza now. |
| Anchor | Repo is on **0.30.1**. 2026 stable is **0.31.x / 0.32.x** (exact version did not survive verification) | Upgrade is optional; 0.30.1 builds fine. If upgrading, run `avm install` + re-gen IDL. |
| Token program | **classic SPL-Token** for USDC | Mainnet USDC is a classic SPL mint. Token-2022 is only needed if we want confidential transfers / transfer hooks — we don't, for USDC. x402 `@x402/svm` v2 and Kora both *also* support Token-2022, so this stays forward-compatible. |
| Off-chain client | **`@solana/web3.js` v1 + `@coral-xyz/anchor`** (already in `sidecar/`) | `@solana/kit` (formerly web3.js v2) exists and a `@solana/web3-compat` bridge is **[sourced]** but unverified. No reason to migrate the sidecar client now — Anchor's ecosystem still rides web3.js v1. |

**Build note for this repo:** the committed `solana/Cargo.lock` pins
`zeroize_derive 1.5.0` / `indexmap 2.14.0`, which require Rust **edition 2024**
(unbuildable on the documented 1.79 toolchain). Build locally with rustc ≥ 1.85,
or pin those two crates down. See `SOLANA_PORT.md`.

---

## 1. USDC payments + x402 paid-route gating

**Replaces:** ERC-20 `transferFrom` / EIP-2612 `permit`; Circle `x402-batching` gate.

- **x402 is chain-agnostic and has an official Solana path** supporting all SPL
  tokens (Token-2022 via the v2 `svm` package). The **`exact`** scheme (pay a
  specific amount) is implemented and is the *only* scheme on Solana — `upto`
  remains EVM-only as of 2026. **[confirmed]**
- **SDK: Corbits / Faremeter** — `@faremeter/payment-solana`, `@faremeter/fetch`,
  `@faremeter/info`, plus `@solana/web3.js` + `@solana/spl-token`. Facilitators:
  **Coinbase CDP** and **PayAI**. **[confirmed]**
- **Wire format (v2):** CAIP-2 chain id `solana:<chainId>`, `PAYMENT-SIGNATURE`
  header, `x402Version: 2`. The official Solana intro guide still shows v1
  `X-PAYMENT` naming — **standardize on v2 headers.** **[confirmed]**
- **Cross-chain USDC in/out:** **Circle CCTP V2** on Solana (Standard + Fast
  Transfer + Forwarding Service), native 1:1 burn-and-mint, no liquidity pools.
  **[confirmed]**

**Status in repo:** `solana-x402.ts` already implements an SPL-USDC `exact`
gate (`solanaPaymentGate`) wired into `/task`, `/pilot/:robot/start`, race-join.
**Action:** align its headers to x402 **v2** (`PAYMENT-SIGNATURE`, CAIP-2,
`x402Version: 2`); optionally adopt the Faremeter packages instead of the
hand-rolled gate to track the spec.

**Plain transfers** (the `settle.ts:pay` Arc ERC-20 transfer) → SPL transfer via
`@solana/spl-token`. Landed this pass as `solana-chain.ts:payOnChain`.

---

## 2. Gasless settlement (EIP-3009 replacement)

**Replaces:** `eip3009.ts` (`transferWithAuthorization` over GibberLink).

- **Use Kora** (Solana Foundation) — the canonical fee-abstraction relayer. A
  Kora signer node acts as the **fee payer** so users transact without holding
  SOL and pay fees in USDC/SPL; exposed over **JSON-RPC** with a policy engine
  (`allowed_spl_paid_tokens` allowlist). It is the gasless backend the x402
  facilitators already use. Audited by Runtime Verification. **[confirmed]**
- There is **no EIP-3009 analog** on Solana (no pull-payment signed
  authorization). The Solana model is: user signs the transfer instruction, a
  relayer (Kora) pays the network fee. Durable nonces cover the offline/delayed
  co-signing case.

**Action:** retire `eip3009.ts` for Solana mode; stand up a Kora relayer and
point the gasless path at its JSON-RPC. The GibberLink transport (signed-auth
gossip between robots) has no on-chain Solana dependency — keep it only if the
product still wants robot-to-robot settlement messaging.

---

## 3. Naming + identity (ENS → SNS)

**Replaces:** `ens.ts`, `register-ens.ts`, the ENS bits of `identity.ts`.

- **SNS / Bonfida `.sol`**, SDK **`@bonfida/sns-sdk`** (repo `Bonfida/sns-sdk`).
  **[sourced]** Resolution already landed in `sns.ts` (resolves
  `guard/courier.roverfleet.sol` owner + an agent-context record).
- **Registration + subdomains + records** is the open piece: SNS supports
  programmatic subdomain creation and record writes (the SNS Records v2 program),
  which is the analog of ENS subnames + ENSIP-25 text records.

**Action:** implement `roverfleet.sol` subdomain registration + an
agent-context record in a `register-sns.ts` (mirror of `register-ens.ts`) using
`@bonfida/sns-sdk`. Confirm the exact record-write call against the SDK docs
before wiring (vote was rate-limited, not refuted).

---

## 4. Reputation (ERC-8004)

**Replaces:** `ReputationRegistry.sol`, `erc8004.ts`, BigQuery leaderboard.

- **Keep our own Anchor reputation** (in `clanker5000`: `register_agent` /
  `give_feedback`, per-agent + per-feedback PDAs, running count/sum,
  `NewFeedback` event). It is already the on-chain source of truth and the
  leaderboard reads it directly (`agentRanking` / `fleetReputation`).
- For ecosystem interop, **`QuantuLabs/8004-solana`** is a direct ERC-8004 port
  (identity via Metaplex Core + reputation "ATOM Engine", TS SDK, live program
  ids). **[sourced]** Treat as a *reference / interop target*, not a dependency —
  it's a small project (a competing `Woody4618/s8004` also exists), so there is
  no single canonical Solana reputation standard yet in 2026.

**Status in repo:** program ✅; leaderboard read ✅. **Landed this pass:**
sidecar write wrappers `registerAgentOnChain` / `giveFeedbackOnChain` /
`repSummaryOnChain` in `solana-chain.ts` (the `erc8004.ts` / `settle.ts`
equivalents). **Gotcha:** `give_feedback` rejects self-feedback, so the
requester key (facilitator) must differ from the agent owner key.

---

## 5. EventPass (ERC-721 → Solana NFT)

**Replaces:** `EventPass.sol`, `deploy-eventpass.ts`.

- The program already records passes natively (`mint_pass`, PDA per id,
  `eventPassHolds` via `getProgramAccounts`) — sufficient for the gate and the
  cheapest option (no NFT framework).
- If a *real, walletable* NFT is wanted: research did **not** confirm a winner
  between **Metaplex Core** (`@metaplex-foundation/mpl-core`, next-gen single-
  account NFT) and **Bubblegum v2 cNFTs** (`@metaplex-foundation/mpl-bubblegum`,
  cheapest at scale but limited 2026 wallet/marketplace support and needs a DAS
  RPC). Both claims were rate-limited, not refuted.

**Recommendation:** keep the program-native pass for the demo gate; if a
collectible is required, **Metaplex Core** for a small fixed run, **Bubblegum
v2** only if minting thousands and a DAS RPC is available. Confirm costs/SDK
against Metaplex docs first.

---

## 6. Treasury + governance (Ledger clear-sign)

**Replaces:** `Treasury.sol`, `treasury-ledger.ts`, `ledger-handover.ts`.

- Program treasury is ✅ (`init_treasury` / `withdraw_treasury` /
  `set_treasury_owner`, PDA USDC vault). `buildTreasuryWithdraw` already returns
  the unsigned instruction for an external owner to sign.
- **Owner = a Ledger Solana address** (single-sig clear-sign) or, for real
  governance, a **Squads v4 multisig** (`Squads-Protocol/v4`) as the treasury
  owner. **[sourced]** Ledger exposes a Solana signer
  (`developers.ledger.com/.../signers/solana`) **[sourced]**.

**Gotchas / open items:**
- Solana Ledger **clear-signing** maturity is the risk — historically Solana
  txs blind-sign on Ledger. Confirm whether the current Solana Ledger app
  renders a human-readable `withdraw_treasury` (this drives whether the demo
  "climax" shows a clear-signed amount or a blind blob).
- The **submit flow differs from EVM**: there is no `r,s,v` re-serialize +
  `broadcastSigned`. The Ledger signs the serialized Solana transaction; the
  sidecar submits it via `sendRawTransaction`. `settle.ts:buildWithdrawTx` /
  `broadcastSigned` need a Solana-native replacement (`buildTreasuryWithdraw`
  exists; a `submitSignedSolanaTx` helper is still TODO).

---

## 7. Attestation / off-chain verdict (Chainlink CRE replacement)

**Replaces:** `AttestationConsumer.sol`, `cre.ts`, `cre-workflow/`.

- Program consumer is ✅ (`init_attestation` / `set_forwarder` /
  `write_attestation`, threshold 70, forwarder-gated). Sidecar reads/writes
  exist (`writeAttestation` / `getAttestation` / `isVerified`).
- **Off-chain compute → on-chain verdict:** **Switchboard On-Demand**
  (`@switchboard-xyz/on-demand`) is the native Solana primitive for custom
  off-chain compute feeding an on-chain value — the closest analog to a CRE
  workflow. **[sourced]** Chainlink on Solana is primarily **Data Streams**
  (`smartcontractkit/chainlink-data-streams-solana`), a price/data feed, not
  arbitrary off-chain compute. **[sourced]**

**Recommendation:** use **Switchboard On-Demand** as the DON that writes the
race-finish verdict via the program's `forwarder` (set the forwarder to the
Switchboard authority; the zero-key escape hatch already covers sim/demo).
Confirm the On-Demand "Function/custom job → on-chain write" pattern against the
package docs.

---

## 8. Custody (Privy TEE)

**Replaces:** `privy.ts`, `privy-provision.ts`, robot `wallets.ts`.

- **Privy supports Solana** (`docs.privy.io/recipes/solana`) — embedded + server
  wallets, TEE signing of Solana txs. **[sourced]** The same `PrivyClient` Node
  SDK is used; provisioning switches `chain_type: "ethereum"` →
  `"solana"`, and signing uses Solana tx signing instead of EIP-712.

**Action:** add a Solana branch to `privy-provision.ts`
(`chain_type: "solana"`) and Solana signing methods in `privy.ts`
(`accountFor(role)` returns a Solana signer adapter). Confirm the exact
server-wallet Solana signing call against the Privy recipe.

---

## 9. World ID

**Replaces:** `worldid.ts` (no change needed) + on-chain nullifier.

- `worldid.ts` is an **off-chain HTTP verifier** → chain-agnostic, unchanged.
- The **nullifier** is already stored on-chain in `place_bet` (a `nullifier`
  PDA; reuse fails on `init`) — the native one-human-one-bet guard.
- If on-chain World ID *proof* verification is ever required on Solana, the path
  is **World ID via Wormhole** (`wormhole.com/blog/expanding-worldcoins-world-id-to-solana`). **[sourced]** Not needed while verification stays off-chain.

**Status:** ✅ complete; no work required.

---

## 10. Indexing / leaderboard data layer

**Replaces:** BigQuery over EVM logs (`bigquery.ts`, `leaderboard.ts`).

- For the fleet leaderboard, **query program accounts directly**
  (`getProgramAccounts` over the `agent` PDAs) — already implemented in
  `agentRanking` / `fleetReputation`. No external indexer required for the demo.
- For a real-time ecosystem view, the 2026 stack is **Helius
  (webhooks / LaserStream) or Yellowstone gRPC (Geyser)**
  (`docs.helius.dev`, Triton Yellowstone guide). **[sourced]** Optional.

**Status:** ✅ on-chain ranking; external indexer optional.

---

## Per-integration recommendation table

| # | EVM piece | Native-Solana choice | Package / source | Confidence | Repo status |
|---|---|---|---|---|---|
| 1 | ERC-20 / x402 gate | x402 `exact` on SPL-USDC | `@faremeter/{payment-solana,fetch,info}` | confirmed | gate ✅ (align to v2 headers) |
| 1b | USDC bridge | Circle CCTP V2 | `developers.circle.com/cctp` | confirmed | not wired (optional) |
| 2 | EIP-3009 gasless | **Kora** relayer (fee payer) | `solana-foundation/kora` | confirmed | client scaffolded (`solana-gasless.ts`); needs Kora node |
| 3 | ENS | **SNS** `.sol` | `@bonfida/spl-name-service` | sourced | resolution ✅; registration scaffolded (`sns.ts:registerSubdomain`) |
| 4 | ERC-8004 | own Anchor reputation (+8004-solana interop) | `clanker5000` / `QuantuLabs/8004-solana` | sourced | program ✅; **writes landed this pass** |
| 5 | EventPass ERC-721 | program-native pass (or Metaplex Core) | `@metaplex-foundation/mpl-core` | sourced | program pass ✅ |
| 6 | Treasury + Ledger | program PDA vault + **Squads v4** / Ledger Solana | `Squads-Protocol/v4` | sourced | program ✅; submit flow TODO |
| 7 | Chainlink CRE | **Switchboard On-Demand** | `@switchboard-xyz/on-demand` | sourced | program ✅; DON wiring TODO |
| 8 | Privy TEE | Privy **Solana** wallets | `docs.privy.io/recipes/solana` | sourced | converted to `chain_type:"solana"` (privy.ts/wallets.ts/privy-provision.ts) |
| 9 | World ID | off-chain verify + on-chain nullifier | (Wormhole if on-chain) | sourced | ✅ complete |
| 10 | BigQuery | `getProgramAccounts` (+ Helius/Yellowstone) | `docs.helius.dev` | sourced | on-chain ranking ✅ |

---

## Remaining cutover plan (ordered)

> **This is the native-Solana-only fork** — the EVM cutover is DONE here (the
> hybrid demo lives in the sibling repo). Status updated below.

1. ✅ **Client wrappers** — market (`openMarketOnChain` / `placeBetOnChain` /
   `settleMarketOnChain`), reputation writes (`registerAgentOnChain` /
   `giveFeedbackOnChain` / `repSummaryOnChain`), payments (`payOnChain` /
   `usdcBalanceOf`) in `solana-chain.ts`.
2. ✅ **Solana robot/wallet config** — `config.ts:ROBOTS.wallet` is now a base58
   Solana pubkey; ENS name replaced by an `sns` field.
3. ✅ **`settle.ts` is Solana-only** — all paths delegate to `solana-chain.ts`
   (the EVM viem body was removed entirely, not gated).
4. ✅ **Betting signer model** — `placeBetOnChain` signs per-bettor (phone wallet
   in prod, `SOLANA_DEV_KEYS_DIR` for dev), matching the program's bet PDA.
5. ✅ **Ledger Solana submit** — `submitSignedSolanaTx` lands the Ledger-signed
   tx; `settle.ts:broadcastSigned` delegates to it. (Clear-sign *rendering* on
   the Ledger Solana app still to confirm on device.)
6. **External integrations** — code scaffolded; need keys/standup to go live:
   - ✅ scaffolded: **Kora** gasless client (`solana-gasless.ts`), **SNS**
     registration (`sns.ts:registerSubdomain`), **Privy Solana** custody
     (`privy.ts` / `wallets.ts` / `privy-provision.ts` now `chain_type:"solana"`).
   - ⛔ still TODO: **Switchboard On-Demand** DON wiring (set the program
     `forwarder` to the Switchboard authority), **Squads v4** as treasury owner.
7. ✅ **Default flipped** — `CHAIN_BACKEND` defaults to `solana`; all EVM
   Solidity/hardhat/viem removed. `sidecar/src` is 100% EVM-free.

**Before running:** still need the deploy artifacts — `anchor build` IDL copied
to `sidecar/src/generated/clanker5000.json`, a deployed program id + USDC mint +
facilitator key in `contracts.solana.json` / env. The TS is syntactically valid
but **not type-checked here** (no `node_modules` / IDL); run `npm run typecheck`
+ `anchor build` in CI. External services (Kora node, Switchboard feed, Privy
app, SNS parent domain) need their own keys/accounts.
