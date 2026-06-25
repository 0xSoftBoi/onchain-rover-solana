# CLANKER 500 — self-improvement backlog (Ralph loop)

The autonomous loop reads this file, picks the highest-value **unchecked** item (or adds new
ones it discovers), implements it, **verifies** (`./tools/verify.sh [--sidecar]` must print
`VERIFY OK`), commits to `solana-native-only`, then checks the item off here. Keep changes small,
focused, shippable. Never commit if verify fails. Do not modify `site/clanker-mock.js`.

## Priority order
1. Correctness / bugs  2. Boot blockers  3. Tests/verification  4. Accessibility  5. Performance  6. UX polish & features

## Backlog
### Correctness & boot
- [ ] Fix the pre-existing `@bonfida/spl-name-service` ↔ `borsh` ESM packaging issue so `cd sidecar && npm run dev` boots. NOTE (loop): the bad `borsh` is bundled INSIDE `@bonfida/.../dist/esm/node_modules/borsh` (its ESM `index.js` lacks a named `serialize`), so a root `overrides` won't reach it — needs a `@bonfida` version bump (network `npm install`) or lazy-importing SNS so the server boots without it. Do this DELIBERATELY (it needs a full-server boot to verify), not in a quick autonomous tick.
- [x] Connection badge: "reconnecting" state after consecutive failed polls in live mode (both pages).
- [ ] Audit every `$()` lookup added recently for null-safety on the overlay (fewer elements than broadcast).

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
