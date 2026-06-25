#!/usr/bin/env bash
# CLANKER 500 — verification gate. Run before EVERY self-improvement commit.
#   ./tools/verify.sh            # fast: site/* syntax + runtime harness
#   ./tools/verify.sh --sidecar  # also run sidecar `tsc --noEmit`
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

for f in site/broadcast.html site/overlay.html; do
  node -e '
    const fs=require("fs"); const h=fs.readFileSync(process.argv[1],"utf8");
    const b=[...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join("\n;\n");
    fs.writeFileSync("/tmp/_vchk.js", b);
  ' "$f"
  if node --check /tmp/_vchk.js 2>/dev/null; then echo "  ✓ $f  syntax"; else echo "  ✗ $f  syntax"; fail=1; fi
  if node tools/broadcast-harness.cjs "$f" 2>/dev/null | grep -q "RUNTIME OK"; then echo "  ✓ $f  runtime"; else echo "  ✗ $f  runtime"; fail=1; fi
done

if [ "${1:-}" = "--sidecar" ]; then
  if (cd sidecar && timeout 300 node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -q "error TS"); then
    echo "  ✗ sidecar tsc"; fail=1
  else echo "  ✓ sidecar tsc"; fi
fi

[ $fail -eq 0 ] && echo "VERIFY OK" || echo "VERIFY FAILED"
exit $fail
