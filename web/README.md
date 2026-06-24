<div align="center">

# 🏁 Clanker 5000 — Web Frontend

### Native-Solana race client: hire rovers, place bets, watch the leaderboard

[![Solana](https://img.shields.io/badge/Solana-native-14F195?logo=solana&logoColor=white)](https://solana.com)
[![Vite](https://img.shields.io/badge/Vite-React-FFD400?logo=vite&logoColor=black)](https://vitejs.dev)
[![Wallet Adapter](https://img.shields.io/badge/wallet--adapter-Phantom%20%2F%20Solflare-E10600?logo=solana&logoColor=white)](https://github.com/solana-labs/wallet-adapter)
[![x402](https://img.shields.io/badge/x402-SPL--USDC-FFD400?logoColor=black)](https://x402.org)
[![EVM Free](https://img.shields.io/badge/EVM-free-00D061?logoColor=white)](#)

</div>

---

A fresh **native-Solana** frontend: Vite + React + `@solana/wallet-adapter` (Phantom / Solflare). Replaces the old EVM dashboards (viem / EIP-712 / `window.ethereum`). No EVM, no server-held keys — the connected wallet signs.

---

## 🏎️ What it does

- **Connect** a Solana wallet (Phantom/Solflare) via wallet-adapter.
- **Hire** a rover — `POST /task/:robot` behind the **x402** gate; on a 402 the
  app sends a real **SPL-USDC** transfer to the fleet treasury and retries with
  the `X-PAYMENT` header (`src/lib/x402.ts`, mirrors `sidecar/src/solana-x402.ts`).
- **Race** — live race state + parimutuel odds from the sidecar.
- **Leaderboard** — fleet reputation read **straight from the clanker5000
  program accounts** via `getProgramAccounts` (no indexer) — `src/lib/program.ts`.

---

## 🚀 Pit-Lane Quick Start

### Step 1 — Install & configure

```bash
cd web
npm install
```

> [!IMPORTANT]
> All env vars here are public/keyless. **NEVER** put a Helius API key in the frontend — that's server-side only.

```bash
cat > .env.local <<'ENV'
VITE_CLUSTER=devnet
VITE_SOLANA_RPC=https://api.devnet.solana.com
VITE_SIDECAR_URL=http://127.0.0.1:4021
VITE_PROGRAM_ID=4FLTsBUD6iCQo5VBzdCSv8imoCnhttnQ1GQFEHL5iEDD
VITE_USDC_MINT=<spl-usdc-mint-for-this-cluster>
ENV
```

### Step 2 — Run

```bash
npm run dev        # http://localhost:5173
npm run typecheck
npm run build
```

---

## 📦 Layout

| File | Purpose |
|---|---|
| `src/main.tsx` | wallet-adapter providers + RPC connection |
| `src/config.ts` | cluster / RPC / sidecar / program id / USDC mint (`VITE_*`) |
| `src/lib/x402.ts` | the 402 → pay-USDC → retry handshake |
| `src/lib/program.ts` | Anchor read client (IDL) + sidecar-instruction → wallet-sign helper |
| `src/idl/clanker5000.json` | the program IDL (from `anchor build`) |
| `src/components/` | `Hire`, `Race`, `Leaderboard` |

---

## 🔧 Next (wallet-signed writes)

`program.ts` ships `ixFromSidecar` + `sendInstructions` so the round-join /
`place_bet` flow (sidecar `/race/round/:id/chain/authorization-request` → sign →
`/chain/join`) can be wired as a wallet-signed action — the per-driver /
per-bettor signer model the program enforces (World ID gates betting).

> [!NOTE]
> The legacy EVM operator dashboards under `sidecar/public/` still exist for the
> robot-control surfaces (WebRTC pilot, telemetry); this app is the native-Solana
> hire/race/reputation client.

---

<div align="center">

🏁 &nbsp;🏎️&nbsp; 🏁

*No EVM. No server keys. Just Solana, USDC, and robots on the track.*

</div>
