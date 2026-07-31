---
phase: 196-analysis-board-stockfish-root-injection
fixed_at: 2026-07-31T04:05:23Z
review_path: .planning/phases/196-analysis-board-stockfish-root-injection/196-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 196: Code Review Fix Report

**Fixed at:** 2026-07-31T04:05:23Z
**Source review:** .planning/phases/196-analysis-board-stockfish-root-injection/196-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 3 (WR-01, WR-02, WR-03 — `fix_scope: critical_warning`; IN-01 intentionally excluded, out of scope)
- Fixed: 3
- Skipped: 0

## Fixed Issues

### WR-01: Per-position injection latch can commit and lock in a stale-position candidate (`Analysis.tsx`)

**Files modified:** `frontend/src/hooks/useStockfishEngine.ts`, `frontend/src/hooks/useFlawChessEngine.ts`, `frontend/src/pages/Analysis.tsx`, `frontend/src/pages/__tests__/Analysis.test.tsx`
**Commit:** `eebc6d6a`
**Status:** `fixed: requires human verification`

**Applied fix:** Both `useStockfishEngine` and `useFlawChessEngine` now expose a `currentFen: string | null` field, committed in the SAME effect run (and same render) that resets `pvLines`/`snapshot` on every `fen` change — so `currentFen` lags `fen` by exactly the same one render that the line data does. `Analysis.tsx`'s root-injection effect now bails out early (step "2b", before computing `missing`) whenever `flawChessEngine.currentFen !== position || engine.currentFen !== position`, i.e. whenever either hook's committed line data has not yet caught up to the current position. The effect's dependency array was extended with `engine.currentFen` and `flawChessEngine.currentFen` so it re-fires once each hook's own reset (and eventual re-search commit) lands for the new position.

**Race reproduction and load-bearing proof:** The existing regression test at `Analysis.test.tsx` (`"resets to the sentinel on FEN change..."`) does not exercise this race — it hand-mutates the mock's `pvLines`/`rankedLines` to the NEW position's fixtures BEFORE firing the position-changing click, which does not match production's asynchronous reset timing. A new test was added: `"does NOT commit a spurious latch from a stale previous-position pvLines/rankedLines pairing that is coincidentally ALSO legal in the new position (WR-01, 196-REVIEW.md)"`. It establishes a genuine disagreement at the start position (Stockfish top-2 `g1f3`/`e2e4`, organic set `{d2d4}`, correctly injecting `['e2e4','g1f3']`), then freezes both hooks' mocked `currentFen` at the start-position FEN literal while navigating through two real board moves (1.d4 d5 — chosen because White is to move again afterward and neither d4 nor d5 touches the g1 knight or e2 pawn, so the STALE `g1f3`/`e2e4` UCIs are coincidentally ALSO legal in the brand-new position). Only after the navigation does the test land genuinely-fresh, non-disagreeing data (`c2c4`/`g1f3`, both already organic) and assert `extraRootMoves` resets to `[]`.

Per the fix-workflow's mandatory proof requirement, the production-code guard (the `if (flawChessEngine.currentFen !== position || engine.currentFen !== position) { return; }` block in `Analysis.tsx`) was reverted in isolation (replaced with `if (false && (...))`) and the test suite re-run:
- **With the guard reverted:** the new test FAILED — `expected [ 'e2e4', 'g1f3' ] to deeply equal []` — reproducing the exact bug: the stale pairing from the start position incorrectly latched onto the post-1.d4-d5 position, and the pre-existing INJECT-04 "exactly once" latch then permanently blocked the effect from ever re-evaluating with the later genuinely-fresh data.
- **With the guard restored:** the new test PASSED, along with all 62 pre-existing tests in the file (63/63 total) and the full frontend suite (2956/2956).

This confirms the fix is load-bearing, not merely present.

**Note on verification tier:** Per the fixer's verification protocol, this finding fixes a genuine logic/ordering bug (not a syntax issue), so despite full green tsc/lint/test/knip gates and the revert-then-restore proof above, the commit status is recorded as `fixed: requires human verification` — flagging it for a human to additionally confirm via manual UAT on `/analysis` (rapid position navigation while the FlawChess Engine and Stockfish cards are both live) before this phase proceeds to the verifier stage.

### WR-02: `extraRootMoves` union/prior-seeding logic duplicated byte-for-byte across the two `SearchRunner` implementations

**Files modified:** `frontend/src/lib/engine/treeCommon.ts`, `frontend/src/lib/engine/mctsSearch.ts`, `frontend/src/lib/engine/fallbackExpectimax.ts`
**Commit:** `d01a40bf`
**Status:** `fixed`

**Applied fix:** Extracted the INJECT-01/INJECT-02 merge block (build `injectedUcis`, compute `keptTotal`, seed the injected candidate's prior, exempt it from the hard cap) into a new shared `mergeExtraRootMoves(candidateMap, effectivePolicy, extraRootMoves)` helper in `treeCommon.ts`, matching the review's suggested signature. Both `mctsSearch.ts`'s `dispatchExpansion` and `fallbackExpectimax.ts`'s `expandNode` now call this single implementation identically (still gated on their own `isRoot && extraRootMoves?.length > 0` condition, unchanged from before) instead of maintaining a copy-pasted block. All 72 pre-existing tests across `mctsSearch.test.ts`, `fallbackExpectimax.test.ts`, and `treeCommon.test.ts` — including the INJECT-01/INJECT-02 parity regressions the review cited — pass unchanged, confirming byte-identical behavior preservation.

### WR-03: INJECT-05 harness's "top organic candidate" is findability-ranked, not practical-score-ranked — report narrative implies the latter

**Files modified:** `reports/root-injection/report.md`, `scripts/engine-root-injection.mjs`
**Commit:** `ed29b73e`
**Status:** `fixed`

**Applied fix:** Documentation/disclosure fix only, per the task's explicit instruction not to re-run the harness or alter any committed measured numbers in the TSV. Added a clarifying comment at `scripts/engine-root-injection.mjs`'s `topOrganicLine` computation (line ~417, now ~423 after the comment) explaining that `rankedLines` is sorted by `rankScore` (a findability-discounted score), not raw `practicalScore`, so this is the top *ranked* organic alternative, not necessarily the best-practical-score one. In `reports/root-injection/report.md`: (1) reworded the headline datum (fen44 quote) to say "top *ranked* organic candidate" with an inline pointer to the methodology note; (2) reworded the visit-allocation table's intro sentence similarly; (3) added a new bullet to the "Limits" section spelling out the full methodology gap — that some other unrecorded organic candidate could carry a higher `practicalScore` than the one the report calls "the top organic candidate," and that the reported "practical-score gap" is against the top-*ranked* alternative specifically, not verified to be the largest possible gap. The one numeric value in the headline quote (`0.0217`, IN-01's target) was deliberately left untouched, matching the `fix_scope: critical_warning` exclusion of IN-01.

## Skipped Issues

None — all three in-scope findings were fixed.

---

_Fixed: 2026-07-31T04:05:23Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
