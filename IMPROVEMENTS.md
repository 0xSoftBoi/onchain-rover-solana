# CLANKER 500 — self-improvement backlog (Ralph loop)

The autonomous loop reads this file, picks the highest-value **unchecked** item (or adds new
ones it discovers), implements it, **verifies** (`./tools/verify.sh [--sidecar]` must print
`VERIFY OK`), commits to `solana-native-only`, then checks the item off here. Keep changes small,
focused, shippable. Never commit if verify fails. Do not modify `site/clanker-mock.js`.

## Priority order
1. Correctness / bugs  2. Boot blockers  3. Tests/verification  4. Accessibility  5. Performance  6. UX polish & features

## Backlog
### Correctness & boot
- [x] Fix the `@bonfida/spl-name-service` boot crash so `cd sidecar && npm run dev` boots. ROOT CAUSE (corrected): NOT a package packaging bug — plain `node` 22.22 imports the full package fine (201 exports). It's the **`tsx` dev/start loader** (esbuild) mishandling bonfida's bundled-borsh minified nested re-export (`export{i as serialize}` via its `_virtual/__exports` shim) → "does not provide an export named 'serialize'". FIX: `sns.ts` now lazy-loads bonfida via a cached `import()` inside its functions (typed `typeof import(...)`, no `any`), so module-load (= server boot) never touches the bonfida code path. Verified: boots under tsx (no crash) AND full SNS works under native node; degrades to `resolved:false` (existing try/catch) under the tsx loader instead of crashing. sns.ts is the only static importer; index.ts touches SNS only in async routes. Optional follow-up (not done, avoids a half-baked runner swap): switch dev/start to native `node --watch --experimental-strip-types` to also restore live SNS under the dev runner.
- [x] Connection badge: "reconnecting" state after consecutive failed polls in live mode (both pages).
- [x] Audit every `$()` lookup added recently for null-safety on the overlay (fewer elements than broadcast). Guarded all element derefs in the forever-running paths (`poll`, `pollTicker`, `clk`, moment queue, pilot lower-third, sponsor rotation, confetti canvas) + load-time flag toggles; a missing element now no-ops instead of throwing every tick. Zero unguarded `$().` chains remain.

### Tests / verification
- [x] `tools/unit.cjs`: unit tests for `impliedProb` (extracted from source, asserts pool/odds/precedence/null), wired into `verify.sh`.
- [x] Extend `tools/unit.cjs` to cover `drawSpark` (polyline scaling: endpoints, flat-series guard, value→y inversion).
- [x] Extract alert thresholds to a pure `betTier(usdc)` helper (both pages) + unit tests (boundaries 0/10/50).
- [x] Extend `verify.sh` to run the harness across 11 query modes per page (cb/vertical/osd/clean/blink/demo/lite/freeze/api/bartop) — catches mode-specific breakage.

### Accessibility
- [ ] Full WCAG contrast pass on amber-on-panel and dim text; bump where < 4.5:1.
- [x] Scorebug favourite now shows a redundant "★ FAV" marker (not just amber glow) — non-color cue, both pages.
- [ ] Continue: ensure remaining color-only signals (e.g. phase chip colors, `.flash`) have redundant cues.

### Performance
- [x] Parallelize the poll fetches (race/state + race/odds + onchain/feed) with Promise.all — ~3× lower poll latency, both pages.
- [ ] Verify Page-Visibility pause actually stops all RAF/animation; add a quick self-check.

### UX / features
- [x] Operator hotkeys on the broadcast page: n/→ next scene, p/← prev, m test alert, c clean, l lite (no deps).
- [x] "Race Control Offline" banner (both pages) when live-mode polls keep failing — stream signals a dropped backend instead of frozen data.
- [x] `STREAMING.md` guide: OBS setup, all query flags (both pages), operator hotkeys, sound, Blinks/ACTIONS_BASE wiring.
- [ ] Real bet-via-Blink hand-off page: World ID IDKit → nullifier → POST the bet Action (closes the one gap from the Blinks work).
- [ ] Auto-derive `ACTIONS_BASE` from `/chain/config` when `?api` is set.
- [ ] Tasteful parity: bring `?osd`/telemetry or `?clean` ideas to the overlay where they don't fight the transparent mandate.

## Done
- (loop appends completed items here with the commit hash)
