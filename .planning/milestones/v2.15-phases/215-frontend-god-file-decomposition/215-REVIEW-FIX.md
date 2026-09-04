---
phase: 215-frontend-god-file-decomposition
fixed_at: 2026-09-04T10:39:44Z
review_path: .planning/phases/215-frontend-god-file-decomposition/215-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 215: Code Review Fix Report

**Fixed at:** 2026-09-04T10:39:44Z
**Source review:** .planning/phases/215-frontend-god-file-decomposition/215-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 7 (WR-01 through WR-07; Info findings out of scope per fix_scope=critical_warning)
- Fixed: 7
- Skipped: 0

**Verification environment:** all fixes were made and verified inside an isolated git worktree (`.claude/worktrees/rf-215-*`, on temp branch `gsd-reviewfix/215-*`), then fast-forwarded into `gsd/phase-215-frontend-god-file-decomposition` in the main checkout. After the fast-forward, the full gate (`npm run lint`, `npm run build`, `npm test -- --run`, `npm run knip`) was re-verified against the worktree's copy before teardown; the worktree state and the post-fast-forward main-checkout state are identical (fast-forward, not squash/rebase), so the numbers below are reproducible from the main checkout.

## Fixed Issues

### WR-01: Stage modules import from the facade they are imported by (import cycle the docs say does not exist)

**Files modified:** `frontend/src/lib/engine/workerPool.ts`, `frontend/src/lib/engine/workerPoolState.ts`, `frontend/src/lib/engine/workerPoolDispatch.ts`, `frontend/src/lib/engine/workerPoolLifecycle.ts`, `frontend/src/lib/engine/workerPoolWatchdog.ts`
**Commit:** `9936f6bd7`
**Applied fix:** Moved the tunable constants, `QueuedGradeRequest`/`PoolWorkerSlot`/`GradeCache` types, `enqueue`/`dequeueHighestPriority`/`sideToMove`/`isLowPowerDevice`/`computePoolSize`/`noLiveSlotRemains` into `workerPoolState.ts`, which now imports nothing from `workerPool.ts` or the three stage modules — only `./types`. `workerPool.ts` re-exports everything for its existing external importers (`useGemSweep.ts`'s `isLowPowerDevice`, `useFlawChessEngine.ts`'s `computePoolSize`, and the `workerPool.test.ts` suite); the three stage modules now import directly from `workerPoolState.ts` instead of the facade. Deleted the stale `export { noLiveSlotRemains }` re-export in `workerPoolLifecycle.ts` and rewrote the `workerPoolState.ts` header to describe the real DAG instead of denying the cycle existed. Verified with `npx madge --circular src/lib/engine/workerPool.ts` (4 cycles before → 0 after) and the full `workerPool.test.ts` suite (109/109 passed).

### WR-02: Three `PoolOps` fields are never called through `ops`

**Files modified:** `frontend/src/lib/engine/workerPoolState.ts`, `frontend/src/lib/engine/workerPool.ts`
**Commit:** `0a738b9be`
**Applied fix:** Deleted `rearmGradingWatchdog`, `createSlot` and `drainPending` from the `PoolOps` interface and from the `ops` literal in `createWorkerPool()`, plus the now-unused `wdRearmGradingWatchdog`/`lcCreateSlot`/`lcDrainPending` imports. Corrected the "twelve-field dispatch table" prose to nine fields. Verified with `grep -rn "ops\.rearmGradingWatchdog\|ops\.createSlot\|ops\.drainPending"` (no matches remained even before the fix — confirmed dead) and the full `workerPool.test.ts` suite (109/109 passed after the fix).

### WR-03: `EngineToggleHeader` duplicated into two component files with diverging signatures

**Files modified:** `frontend/src/components/analysis/EngineToggleHeader.tsx` (new), `frontend/src/components/analysis/AnalysisTabs.tsx`, `frontend/src/components/analysis/AnalysisDesktopCards.tsx`
**Commit:** `831315292`
**Applied fix:** Extracted one exported `EngineToggleHeader` component (keeping the original `icon: LucideIcon` prop) into a new `EngineToggleHeader.tsx`, imported from both sibling files. `AnalysisDesktopCards.tsx`'s `StockfishCard` now passes `icon={Cpu}` explicitly at its call site instead of hard-coding the icon inside a private copy. Deleted both stale "Private duplicate of Analysis.tsx's own module-level `EngineToggleHeader`" comments (that source no longer exists).

### WR-04: Board layout constants duplicated between `Analysis.tsx` and the sizing hook that feeds it

**Files modified:** `frontend/src/components/board/boardSize.ts`, `frontend/src/lib/gemMove.ts`, `frontend/src/hooks/analysis/useBoardStageSize.ts`, `frontend/src/hooks/analysis/useAnalysisGemMarkers.ts`, `frontend/src/components/analysis/AnalysisBoardStage.tsx`, `frontend/src/pages/Analysis.tsx`
**Commit:** `dc4e4d092`
**Applied fix:** Moved `BOARD_EVAL_BARS_ALLOWANCE_PX`, `EVAL_SLIDER_SLACK_PX` and `DESKTOP_BOARD_SIZE_REDUCTION_PX` into `boardSize.ts` (already imported by both `Analysis.tsx` and `useBoardStageSize.ts`), and removed `AnalysisBoardStage.tsx`'s `boardEvalBarsAllowancePx` prop entirely — it now imports the constant directly instead of receiving it duplicated through props. Did the same for `LIVE_EVAL_CACHE_MAX` (hoisted to `lib/gemMove.ts`, already imported by both `Analysis.tsx` and `useAnalysisGemMarkers.ts`).

### WR-05: Load-bearing tactic helpers copied four times, already textually diverged

**Files modified:** `frontend/src/lib/analysisTactics.ts` (new), `frontend/src/pages/Analysis.tsx`, `frontend/src/hooks/analysis/useAnalysisBoardArrows.ts`, `frontend/src/hooks/analysis/useAnalysisRouteSeeding.ts`, `frontend/src/hooks/analysis/useAnalysisEngineLines.ts`, `frontend/src/components/analysis/AnalysisTabs.tsx`
**Commit:** `6a4ed462d`
**Applied fix:** Created `src/lib/analysisTactics.ts` exporting `forkPlyForOrientation`, `flawKey`, `bestSanFromPv` and the `TacticRef`/`OpenLine` types under one canonical naming, and updated all five files to import from there instead of holding their own copy. `useAnalysisBoardArrows.ts`'s local `forkPlyForOrientation` (the one that had already diverged textually, though logically equivalent) and `Analysis.tsx`'s local `FlawRef` type alias were both replaced by the shared `TacticRef` type/function.

### WR-06: Tap-target styling derived from the test-id suffix

**Files modified:** `frontend/src/pages/openings/OpeningsFilterFields.tsx`, `frontend/src/pages/openings/OpeningsMobileDrawers.tsx`
**Commit:** `782421bb3`
**Applied fix:** Added an explicit `tallTapTargets?: boolean` prop (default `false`) to `OpeningsFilterFieldsProps`; `toggleItemClassName` now derives from `tallTapTargets` instead of `testIdSuffix === '-sidebar'`. The mobile drawer call site (`OpeningsMobileDrawers.tsx`) now passes `tallTapTargets` explicitly; the desktop sidebar call site needs no change (relies on the `false` default). `testIdSuffix` is now purely a testid concern.

### WR-07: Complexity baseline uses `'off'`, so baselined files can regress without limit

**Files modified:** `frontend/eslint.config.js`
**Commit:** `f3d42e168`
**Applied fix:** Re-measured every one of the 52 baselined files with `npx eslint --no-inline-config --rule 'complexity: ["error", 1]' <path>` (and the analogous rule/threshold for `max-statements` on `Analysis.tsx` and `max-depth` on `reminderSlotState.test.ts`), and replaced the blanket `complexity: 'off'` with a per-file ceiling equal to the measured value, grouping files that share an identical ceiling into one config block. `Analysis.tsx` got `complexity: ['error', 132]` and `max-statements: ['error', 152]`; `Openings.tsx` got `complexity: ['error', 48]`; `reminderSlotState.test.ts` got `max-depth: ['error', 10]`. Verified the ratchet is load-bearing by lowering `LibraryGameCard.tsx`'s ceiling from 78 to 77 (lint failed: "complexity of 78. Maximum allowed is 77"), then restoring it to 78 (lint passed again). `npm run lint` is green with the real ceilings in place.

## Skipped Issues

None — all 7 in-scope findings (WR-01 through WR-07) were fixed.

---

_Fixed: 2026-09-04T10:39:44Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
