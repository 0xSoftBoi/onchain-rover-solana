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
- [ ] Add a `tools/unit.cjs` with pure-function unit tests for `impliedProb`, the alert-queue tier/cap logic, and `drawSpark`; wire into `verify.sh`.
- [x] Extend `verify.sh` to run the harness across 11 query modes per page (cb/vertical/osd/clean/blink/demo/lite/freeze/api/bartop) — catches mode-specific breakage.

### Accessibility
- [ ] Full WCAG contrast pass on amber-on-panel and dim text; bump where < 4.5:1.
- [ ] Ensure every color-coded signal (win/loss, up/down, fav) has a redundant text/glyph cue, including in `?cb=1`.

### Performance
- [ ] Coalesce the broadcast poll fan-out further (single batched fetch helper); measure fetch/s.
- [ ] Verify Page-Visibility pause actually stops all RAF/animation; add a quick self-check.

### UX / features
- [ ] Operator hotkeys on the broadcast page (next/prev scene, force a test moment, toggle clean/lite) — documented, keyboard-only, no deps.
- [ ] "Standby / intermission" scene shown when the sidecar is offline (no live data), so the stream never looks dead.
- [ ] `STREAMING.md` guide: OBS setup, every `?` query flag, how to wire `ACTIONS_BASE` for Blinks.
- [ ] Real bet-via-Blink hand-off page: World ID IDKit → nullifier → POST the bet Action (closes the one gap from the Blinks work).
- [ ] Auto-derive `ACTIONS_BASE` from `/chain/config` when `?api` is set.
- [ ] Tasteful parity: bring `?osd`/telemetry or `?clean` ideas to the overlay where they don't fight the transparent mandate.

## Done
- (loop appends completed items here with the commit hash)
