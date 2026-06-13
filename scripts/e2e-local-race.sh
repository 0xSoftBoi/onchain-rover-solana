#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAIN="$ROOT/chain"
RPC_URL="${LOCAL_CHAIN_RPC_URL:-http://127.0.0.1:8545}"
NODE_PID=""

cleanup() {
  if [[ -n "$NODE_PID" ]]; then
    kill "$NODE_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ ! -d "$CHAIN/node_modules" ]]; then
  npm --prefix "$CHAIN" install
fi

npm --prefix "$CHAIN" run compile

if ! curl -fsS "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  >/dev/null 2>&1; then
  npm --prefix "$CHAIN" run node >"$CHAIN/.local-node.log" 2>&1 &
  NODE_PID="$!"
  for _ in {1..40}; do
    if curl -fsS "$RPC_URL" \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
      >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
fi

npm --prefix "$CHAIN" run deploy
npm --prefix "$CHAIN" run e2e:local
