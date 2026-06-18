# Advanced Solana techniques + Phantom UX for Clanker 5000

Research + an actionable plan for two upgrades: **ZK Compression** (cut on-chain
state cost ~1000×) and **Phantom/dApp UX** (the browser experience). Sources at
the bottom.

---

## 1. ZK Compression

**What it is.** A Solana framework (Light Protocol, now acquired by Helius) that
stores account/token state in *cheaper ledger space* instead of expensive
account space: only a hash of the data lives on-chain in **sparse state trees**,
and **zero-knowledge validity proofs** guarantee integrity. Reads/writes go
through a **Photon** indexer RPC (Helius exposes it). Claimed **~1000–5000×**
cost reduction for token accounts and PDAs (≈99%+).

- SDKs: **`@lightprotocol/stateless.js`** + **`@lightprotocol/compressed-token`**.
- RPC: Helius ZK-Compression (Photon) endpoints — fits our existing Helius setup.
- Cost example: ~100 compressed token accounts ≈ 0.00004 SOL vs ≈ 0.2 SOL
  regular — the difference between "every fan gets an on-chain pass" being free
  vs prohibitive.

**Where it fits Clanker 5000 (and where it does NOT):**

| Program data | Compress? | Why |
|---|---|---|
| **EventPass** (`mint_pass`, PDA per id) | ✅ strong fit | Passes are cheap, high-volume, append-only access records — exactly the cNFT/compressed-account use case. A whole audience of passes for ~nothing. |
| **Reputation feedback** (per-`give_feedback` PDA) | ✅ fit | Every completed job mints a feedback PDA (rent each). Compressing the per-feedback records cuts that ~99%; keep the running count/sum on the regular `agent` account. |
| **Parimutuel `bet` records** | ✅ fit (at scale) | One PDA per bettor per market. Compress for large crowds; rent back to bettors today is small but compression removes it. |
| **Race/market escrow vaults** | ❌ keep regular | These **custody USDC** via SPL token CPI + PDA authority. Don't compress funds-bearing vaults — keep normal SPL accounts for the security model the audit covers. |
| **Treasury / config / attestation** | ❌ keep regular | Low-volume, security-critical singletons; no benefit. |

**Tradeoffs / gotchas.**
- Requires a **Photon RPC** (Helius) — adds an indexer dependency for reads.
- Validity proofs + the compressed-account model add code complexity; it's a
  **post-MVP optimization**, not a launch blocker.
- Compressed accounts aren't drop-in `Account<>`s — the program instructions
  that create passes/feedback would move to the Light CPI. Scope it as its own
  milestone after the audit, and only for the high-volume append-only data above.

**Recommendation:** ship MVP with regular accounts; once volume justifies it,
compress **EventPass + feedback records** first (biggest rent wins, lowest risk —
they're append-only and not funds-custody). Keep all USDC vaults regular.

---

## 2. Other advanced techniques worth adopting

- **Solana Actions + Blinks** — turn "hire guard for $0.50" or "bet on lane 2"
  into a shareable URL/QR that unfurls into a signable transaction in Phantom
  (X, Discord, the venue wall). High-leverage for a live show; an Action is just
  a GET (metadata) + POST (returns a tx) the sidecar can serve.
- **Versioned transactions + Address Lookup Tables (ALTs)** — settlement txs
  touch many accounts (vault, authority, mints, ATAs). An ALT keeps them under
  the size limit and is required as the program grows.
- **`getPriorityFeeEstimate`** — already wired server-side (`helius.ts`); the
  frontend should set a priority fee on the x402 transfer too (added below).
- **Token-2022 confidential transfers** — only if bet/stake amounts should be
  private; not needed for the demo, and mainnet USDC is classic SPL.
- **Durable nonces** — for the Ledger treasury withdraw (sign offline, submit
  later) so the clear-sign isn't racing blockhash expiry.

---

## 3. Phantom / dApp UX best practices

The browser experience is where trust is won or lost. Principles (Phantom's own
guidance + ecosystem):

1. **Show what you're signing.** Phantom simulates transactions and previews
   balance changes; help it by sending *minimal, legible* instructions. Before
   the wallet pops, the app should state plainly: "Send 0.50 USDC to the fleet
   treasury." (Added to the frontend — see §4.)
2. **Explain token-account creation + spending.** If a flow creates an ATA or
   approves spend, say why. People reject what they don't understand.
3. **Minimal permissions, no bundling.** Don't sneak extra instructions into a
   payment tx. One purpose per signature.
4. **Sign In With Solana (SIWS)** — `@phantom/sign-in-with-solana`. The wallet
   constructs the login message (not the dapp), so Phantom can vet it and show a
   clean, consistent prompt. Use SIWS for sidecar session auth instead of an
   ad-hoc `signMessage`.
5. **Wallet-adapter** for multi-wallet (Phantom/Solflare/Backpack) — already used.
6. **Mobile**: support **Mobile Wallet Adapter** + Phantom deeplinks so a phone
   user at the venue can pay/bet by scanning a QR (pairs with Blinks above).
7. **Pre-flight the obvious failures** client-side: check USDC balance before
   prompting, surface "insufficient USDC" instead of a wallet rejection.
8. **Confirmations + explorer links** for every settled tx (the frontend already
   links to Solana Explorer).

---

## 4. Applied in this repo (frontend)

- ✅ Wallet-adapter (Phantom/Solflare), keyless public RPC, explorer links.
- ✅ **Payment preview + balance pre-check + simulation** before the x402
  signature (this pass): the Hire flow now shows the exact USDC amount, checks
  the wallet's USDC balance, and `simulateTransaction`s the transfer before
  prompting — so Phantom's prompt is never a surprise and obvious failures are
  caught early. See `web/src/lib/x402.ts`.
- ✅ Priority fee on the payment transfer (compute-budget instruction).
- ⏭️ Next: SIWS session auth, Solana Actions/Blinks for hire/bet links, Mobile
  Wallet Adapter for the venue QR flow.

---

### Sources
- ZK Compression: https://www.helius.dev/docs/zk-compression/introduction ·
  https://www.zkcompression.com/home ·
  https://github.com/Lightprotocol/light-protocol ·
  https://www.helius.dev/blog/light-protocol-acquisition ·
  https://www.theblock.co/post/301368/light-protocol-and-helius-labs-introduce-zk-compression-to-further-scale-solana-apps
- SIWS: https://github.com/phantom/sign-in-with-solana
- Phantom/dApp UX: ecosystem guides (show-what-you-sign, minimal permissions,
  wallet-adapter, SIWS, transaction simulation).
