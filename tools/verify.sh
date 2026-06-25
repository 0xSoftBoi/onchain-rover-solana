#!/usr/bin/env bash
# CLANKER 500 — verification gate. Run before EVERY self-improvement commit.
#   ./tools/verify.sh            # site/* syntax + runtime harness across all query modes
#   ./tools/verify.sh --sidecar  # also run sidecar `tsc --noEmit`
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

# query modes exercised by the runtime harness (broadcast supports all; overlay ignores extras)
MODES=("" "?cb=1" "?vertical=1" "?osd=1" "?clean=1" "?blink=1" "?demo=1" "?lite=1" "?freeze=0" "?api=https://x.test" "?bar=top&bug=0&clock=0")

for f in site/broadcast.html site/overlay.html; do
  # syntax (mode-independent)
  node -e '
    const fs=require("fs"); const h=fs.readFileSync(process.argv[1],"utf8");
    const b=[...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join("\n;\n");
    fs.writeFileSync("/tmp/_vchk.js", b);
  ' "$f"
  if node --check /tmp/_vchk.js 2>/dev/null; then echo "  ✓ $f  syntax"; else echo "  ✗ $f  syntax"; fail=1; fi
  # runtime across every query mode
  bad=""
  for qs in "${MODES[@]}"; do
    if ! QS="$qs" node tools/broadcast-harness.cjs "$f" 2>/dev/null | grep -q "RUNTIME OK"; then bad="$bad ${qs:-default}"; fi
  done
  if [ -z "$bad" ]; then echo "  ✓ $f  runtime (${#MODES[@]} modes)"; else echo "  ✗ $f  runtime FAILED:$bad"; fail=1; fi
done

if [ "${1:-}" = "--sidecar" ]; then
  if (cd sidecar && timeout 300 node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -q "error TS"); then
    echo "  ✗ sidecar tsc"; fail=1
  else echo "  ✓ sidecar tsc"; fi
fi

[ $fail -eq 0 ] && echo "VERIFY OK" || echo "VERIFY FAILED"
exit $fail
