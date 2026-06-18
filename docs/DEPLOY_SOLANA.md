# Deploying clanker5000 to Solana — runbook

Hard-won notes for building and deploying the native-Solana program. The build
and IDL toolchain is version-sensitive; the deploy is RPC-throughput-sensitive.

## Toolchain (must match — see docs/SOLANA_NATIVE_MIGRATION.md §0)

| Tool | Version | Why |
|---|---|---|
| Agave (Solana CLI) | **4.0.3** | platform-tools **v1.53** = build-sbf rustc ≥ 1.85, required to parse Anchor 0.31's edition-2024 deps. 2.1.x (rustc 1.79) / 3.0.x (rustc 1.84) fail the lockfile parse. |
| Anchor CLI | **0.31.0** | 0.30.1's IDL build is broken on 2026 rustc; npm `@coral-xyz/anchor-cli@0.31.1` ships a 0.31.0 binary whose launcher self-rejects — install `0.31.0`, or call the ELF in `node_modules/@coral-xyz/anchor-cli/anchor` directly. |
| `@coral-xyz/anchor` (TS) | **^0.31.1** | must read the 0.31 IDL format. |

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/v4.0.3/install)"
npm i -g @coral-xyz/anchor-cli@0.31.0
```

## Build

```bash
cd solana
anchor build                      # -> target/deploy/clanker5000.so + target/idl + target/types
cp target/idl/clanker5000.json ../sidecar/src/generated/clanker5000.json
```

If `anchor keys sync` runs, it sets `declare_id!` + `Anchor.toml` to the program
keypair (`target/deploy/clanker5000-keypair.json`). Make sure **both**
`[programs.localnet]` and `[programs.devnet]` match `declare_id!` or `anchor test`
fails with `DeclaredProgramIdMismatch (4100)`.

## Local test (fast, authoritative)

```bash
anchor test            # spins a local validator, runs tests/clanker5000.ts -> 3/3
```

## Deploy to a cluster

```bash
solana config set --url <RPC>
solana program deploy target/deploy/clanker5000.so \
  --program-id target/deploy/clanker5000-keypair.json \
  --use-rpc --max-sign-attempts 5000 --with-compute-unit-price 10000
```

### RPC throughput is the real constraint

The program is ~640 KB ≈ ~640 write txs. Public/free RPCs rate-limit these:

- **`api.devnet.solana.com`** — ~40 req/s/method; 429s the writes into a stall.
- **Helius free tier** — 10 RPS; completes but slowly (tens of minutes); the CLI
  bursts above 10 RPS and eats 429 back-offs.
- **A paid/Developer RPC** — finishes in ~30 s. This is the one place free tier
  genuinely costs you for deploys.

Use **`--use-rpc`** so writes are *confirmed* before the finalize step. Without
it (TPU path), confirmations get dropped on throttled endpoints and the CLI
finalizes an **incomplete buffer** → `Error processing Instruction 1: invalid
account data for instruction`.

### Resume / recover (no SOL lost)

Each deploy uploads to an intermediate **buffer** account that persists if the
run dies. To make it explicitly resumable, control the buffer keypair:

```bash
solana-keygen new -o /tmp/buf.json
# loop until the buffer is fully written (resumes the same buffer each pass):
solana program write-buffer target/deploy/clanker5000.so --buffer /tmp/buf.json \
  --url <RPC> --use-rpc --max-sign-attempts 5000        # repeat until rc=0
# then finalize from the verified buffer:
solana program deploy --buffer /tmp/buf.json \
  --program-id target/deploy/clanker5000-keypair.json --url <RPC>
```

Reclaim SOL from stuck buffers anytime:

```bash
solana program close --buffers --url <RPC>      # returns ~4.5 SOL/buffer
```

Funding: a deploy needs **~4.6 SOL** rent. Devnet CLI airdrops are usually
rate-limited to nothing — use the web faucet (https://faucet.solana.com).

## After deploy

1. `solana program show <PROGRAM_ID> --url <RPC>` to confirm.
2. Fill `sidecar/src/generated/contracts.solana.json` (programId, usdcMint,
   facilitator, treasury, rpc) — see `contracts.solana.example.json`.
3. Set `[programs.devnet]` in `Anchor.toml` to the deployed id.
