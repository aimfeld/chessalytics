---
phase: quick-260727-qai
plan: 01
subsystem: train
tags: [fastapi, sqlalchemy, alembic, react, typescript, pydantic]

requires:
  - phase: 190
    provides: Train solve loop (TrainSolveScreen, useTrainGradingEngine, useTrainSession, drill_solves)
provides:
  - Tiered Train puzzle scoring (guess 1pt + move 0/1/2pt, max 3/puzzle)
  - DrillMoveQuality-backed move_quality column on drill_solves
  - Recolored Points-flash badge (4 tiers, legible fg on every bg)
affects: [train]

tech-stack:
  added: []
  patterns:
    - "Wire tier + derived ladder boolean pattern: SolveRequest/SolveResponse carry a client-asserted move_quality tier; the server derives the SR ladder's pass/fail boolean from it (!= 'wrong') so downstream scheduler logic stays untouched."

key-files:
  created:
    - alembic/versions/20260727_170416_ed0735f3d998_seed_119_drill_solve_move_quality.py
  modified:
    - app/models/drill_solve.py
    - app/schemas/train.py
    - app/routers/train.py
    - app/repositories/train_repository.py
    - tests/routers/test_train.py
    - tests/repositories/test_train_repository.py
    - frontend/src/lib/trainScore.ts
    - frontend/src/lib/theme.ts
    - frontend/src/lib/liveFlaw.ts
    - frontend/src/types/train.ts
    - frontend/src/lib/trainRevealCache.ts
    - frontend/src/hooks/useTrainGradingEngine.ts
    - frontend/src/hooks/useTrainSession.ts
    - frontend/src/components/train/TrainSolveScreen.tsx
    - frontend/src/lib/__tests__/trainScore.test.ts
    - frontend/src/lib/__tests__/trainRevealCache.test.ts
    - frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts
    - frontend/src/hooks/__tests__/useTrainSession.test.ts
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
    - frontend/src/components/train/__tests__/TrainReveal.test.tsx
    - frontend/src/pages/__tests__/Train.solveLoop.test.tsx
    - CHANGELOG.md

key-decisions:
  - "correct_move stays server-derived (move_quality != 'wrong') so app/services/train_scheduler.py's apply_result stays byte-identical and the SR ladder's pass/fail semantics are unchanged — an inaccuracy still passes"
  - "TrainMoveTier (not TrainMoveQuality) is the frontend type name to avoid a live collision with trainArrows.ts's existing 5-value TrainMoveQuality taxonomy"
  - "All three defensive/optimistic fallback branches in gradeMoveInner (no usable mount search, exact-match fast path, illegal/unparseable played move) resolve the GOOD tier, never silently costing the user points"
  - "liveFlaw.ts now re-exports FlawSeverity so trainScore.ts's moveTierFromSeverity can import it from the severity-classifier module rather than reaching into types/library.ts directly"

requirements-completed: [SEED-119]

duration: 19min
completed: 2026-07-27
status: complete
---

# Quick Task 260727-qai: Tiered Train Puzzle Scoring Summary

**Train puzzles now score guess(1) + move(0/1/2) = max 3, with a 4-tier recolored Points-flash badge; an inaccuracy still passes the spaced-repetition ladder unchanged.**

## Performance

- **Duration:** ~19 min
- **Completed:** 2026-07-27
- **Tasks:** 3 completed
- **Files modified:** 21 (1 new migration, 20 modified)

## Accomplishments

- Widened the boolean `correct_move` wire contract on `POST /train/sessions/{id}/solve` into a three-way `move_quality: 'good' | 'inaccuracy' | 'wrong'` tier, with the server deriving the ladder verdict (`correct_move = move_quality != 'wrong'`) so `app/services/train_scheduler.py` needed zero edits.
- Added a nullable `move_quality` SMALLINT + `DrillMoveQuality` IntEnum + CHECK constraint on `drill_solves` (migration `ed0735f3d998` on top of `b1724dc27de8`), go-forward only — pre-existing rows keep `move_quality` NULL and their stored `correct_move`.
- Rebuilt `frontend/src/lib/trainScore.ts`'s scoring formula around the new `TrainMoveTier` type and `MOVE_TIER_POINTS` (good=2/inaccuracy=1/wrong=0); `TRAIN_POINTS_PER_PUZZLE` is now 3.
- `useTrainGradingEngine`'s `GradeResult.moveTier` replaces `correctMove`, derived solely via `moveTierFromSeverity(classifyLiveSeverity(...))` at both real classification sites; all three optimistic/defensive fallback branches resolve `'good'`.
- Recolored the "Points: +N" flash badge to cover all four score tiers (0 red / 1 orange / 2 yellow / 3 dark green) with two new `theme.ts` foreground constants so text stays legible on the light yellow tier.
- `trainRevealCache.ts` now rejects a pre-SEED-119 cached entry whose `verdict` lacks `move_quality`, landing the back button on the start screen (the module's existing best-effort fallback).
- CHANGELOG.md updated; SEED-119 moved to `.planning/seeds/closed/`.

## Task Commits

1. **Task 1: Backend move_quality contract, column, migration, and tests** - `805dd935` (feat)
2. **Task 2: Frontend tiered scoring, grading tier, wire-up, and recolored points badge** - `61dd10e9` (feat)
3. **Task 3: Full gate, changelog, and seed close** - `546ab48d` (docs)

## Files Created/Modified

- `alembic/versions/20260727_170416_ed0735f3d998_seed_119_drill_solve_move_quality.py` - additive `move_quality` column + `ck_drill_solves_move_quality` CHECK
- `app/models/drill_solve.py` - `DrillMoveQuality` IntEnum, nullable `move_quality` column
- `app/schemas/train.py` - `SolveRequest.move_quality` (replaces `correct_move`), `SolveResponse` gains `move_quality` alongside unchanged `correct_move`
- `app/repositories/train_repository.py` - bidirectional literal<->enum mapping, `record_solve` persists both fields, legacy-row degrade path on re-submit
- `app/routers/train.py` - solve endpoint passes `move_quality` through
- `tests/routers/test_train.py`, `tests/repositories/test_train_repository.py` - tier round-trip, 422 on a bad tier, inaccuracy-advances-ladder regression guard, re-submit idempotence, CHECK-constraint rejection
- `frontend/src/lib/trainScore.ts` - `TrainMoveTier`, `MOVE_TIER_POINTS`, `moveTierFromSeverity`, `TRAIN_POINTS_PER_PUZZLE=3`, `scorePuzzle(correctGuess, moveTier)`
- `frontend/src/lib/theme.ts` - `TRAIN_POINTS_FG_ON_DARK`/`TRAIN_POINTS_FG_ON_LIGHT`
- `frontend/src/lib/liveFlaw.ts` - re-exports `FlawSeverity`
- `frontend/src/types/train.ts` - `SolveRequest.move_quality`, `SolveResponse.move_quality`
- `frontend/src/lib/trainRevealCache.ts` - rejects a verdict missing `move_quality`
- `frontend/src/hooks/useTrainGradingEngine.ts` - `GradeResult.moveTier`, tier derivation at every return site
- `frontend/src/hooks/useTrainSession.ts` - solve `onSuccess` scores via `scorePuzzle`
- `frontend/src/components/train/TrainSolveScreen.tsx` - sends `move_quality`, 4-tier badge map + colors
- Seven frontend test files updated for the new contract/max
- `CHANGELOG.md` - Unreleased/Changed bullet

## Decisions Made

- `correct_move` is server-derived (`move_quality != "wrong"`), never client-asserted directly — keeps `apply_result`'s signature and the SR ladder's pass/fail semantics byte-identical to pre-SEED-119.
- Frontend type named `TrainMoveTier` (not `TrainMoveQuality`) to avoid colliding with `trainArrows.ts`'s existing unrelated 5-value `TrainMoveQuality` taxonomy, both imported into `TrainSolveScreen.tsx`.
- All defensive/fast-path fallback branches in `gradeMoveInner` resolve the GOOD tier so a defensive code path can never silently cost the user points.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Out-of-Scope Observation (reported, not implemented, per plan's design notes)

`TrainReveal.tsx` still renders a green check for an inaccuracy because its check/cross mark reads `verdict.correct_move` (line ~469, `verdict.correct_guess ? TRAIN_VERDICT_CORRECT : ...` region at line ~498-500), while the same move now scores only 1 of 2 possible move points. The reveal already colours the played-move arrow yellow via `classifyTrainMoveQuality` (confirmed: `TrainReveal.tsx` imports and applies it), so the inaccuracy IS communicated through the arrow color even though the check mark stays green. Changing the check/cross mark to reflect the tier is a design decision SEED-119 does not cover — left untouched per the plan's explicit instruction.

## User Setup Required

None - no external service configuration required.

## Verification

- `uv run alembic upgrade head` applied cleanly on the dev DB; head advanced from `b1724dc27de8` to `ed0735f3d998`.
- Backend: `uv run ty check app/ tests/` clean; `uv run pytest -n auto tests/routers/test_train.py tests/repositories/test_train_repository.py tests/services/test_train_scheduler.py` — 166 passed.
- Frontend: `npx tsc -b --force` compiles clean; `npm run lint` clean (0 errors); `npm run knip` clean; `npm test -- --run` — 2778 passed across 200 files (full suite, not just Train).
- No dev DB reset at any point.

## Next Phase Readiness

Complete and self-contained. No follow-up work required by this task; the out-of-scope reveal-mark observation above is flagged for a future decision, not a blocker.

---
*Quick task: 260727-qai*
*Completed: 2026-07-27*

## Self-Check: PASSED

All 16 referenced files found on disk; all 3 task commits (`805dd935`, `61dd10e9`, `546ab48d`) found in git history.
