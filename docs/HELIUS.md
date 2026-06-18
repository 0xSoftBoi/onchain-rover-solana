# Helius integration (free tier)

The fleet uses [Helius](https://helius.dev) as its Solana RPC + data layer. We run
on the **Free** plan and stay inside it deliberately.

## Free-tier budget (what we get)

| Resource | Free tier |
|---|---|
| Monthly credits | 1,000,000 |
| RPC rate limit | 10 req/s |
| DAS API rate limit | 2 req/s |
| Standard WebSockets (account/logs subscribe) | ✅ included |
| Wallet API, archive data | ✅ included |
| LaserStream gRPC / Helius WS extensions / Webhooks | ❌ paid plans |

Different methods cost different credit amounts; 1M/mo is ample for a demo fleet
as long as we don't poll.

## How it's wired

- **`HELIUS_API_KEY`** (env, never committed) → `solana-config.ts:heliusRpcUrl()`
  builds `https://{devnet|mainnet}.helius-rpc.com/?api-key=…` and uses it as the
  **backend** RPC (`solanaChainConfig().rpcUrl`). Precedence:
  `SOLANA_RPC_URL` override > Helius (if key set) > the deployment default.
- **Key never leaves the server.** `publicRpcUrl` (handed to the phone/frontend)
  always falls back to a *keyless* public endpoint — the keyed Helius URL is
  server-only. Don't put the key in `PUBLIC_*` vars.

## What we use (and why it's smart on free tier)

- **`getPriorityFeeEstimate`** (`helius.ts:priorityFeeMicroLamports` /
  `priorityPreInstructions`) — set a *dynamic* compute-unit price on settlement /
  x402 writes so they land under congestion without overpaying. We **cache the
  estimate for 10 s** so a burst of settlement txs costs one RPC call, not N —
  keeping us well under 10 RPS. Falls back to a fixed floor if Helius is off.
- **DAS `getAssetsByOwner`** (`helius.ts:getAssetsByOwner`) — one-call NFT/asset
  holder lookups (e.g. if EventPass graduates to a Metaplex asset). DAS is capped
  at **2 RPS**, so call it on demand, never in a loop.
- **Reads over polling.** For live race/leaderboard state prefer a single read or
  a standard WebSocket `accountSubscribe`/`logsSubscribe` (included free) instead
  of polling `getProgramAccounts` on a timer. (Webhooks/LaserStream would be the
  paid upgrade for a production indexer.)

## Note: program deploys on free tier

`solana program deploy` of the ~640 KB program is ~640 write txs; at 10 RPS it
takes several minutes but completes reliably (unlike the public faucet RPC, which
429s the writes into a stall). Use `--use-rpc` so writes are confirmed before the
finalize step. The buffer persists if interrupted — resume or `solana program
close --buffers` to reclaim SOL.
