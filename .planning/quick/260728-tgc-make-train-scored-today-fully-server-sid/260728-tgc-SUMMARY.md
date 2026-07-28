---
phase: quick-260728-tgc
plan: 01
subsystem: train
tags: [fastapi, pydantic, sqlalchemy, react, typescript, tanstack-query, train]

# Dependency graph
requires:
  - phase: 189
    provides: drill_solves table (correct_guess/move_quality per-row outcome storage)
  - phase: 193
    provides: current Train session/solve loop (useTrainSession, TrainSolveScreen, TrainStartScreen)
provides:
  - "POST /train/sessions returns solved_results: one SolvedResult (correct_guess, move_quality) per recorded solve, in position order"
  - "useTrainSession seeds sessionScore/sessionSolvedCount from solved_results instead of a localStorage tally"
  - "Train's 'Scored today' recap is now correct on any device, not just the one that solved the session"
affects: [train, drill-solve, session-score]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Server returns per-puzzle scoring ingredients (correct_guess, move_quality); client aggregates via the single owning formula (frontend/src/lib/trainScore.ts) — Option B, no server-side score duplication"

key-files:
  created: []
  modified:
    - app/schemas/train.py
    - app/repositories/train_repository.py
    - app/routers/train.py
    - tests/repositories/test_train_repository.py
    - tests/routers/test_train.py
    - frontend/src/types/train.ts
    - frontend/src/hooks/useTrainSession.ts
    - frontend/src/components/train/TrainStartScreen.tsx
    - frontend/src/hooks/__tests__/useTrainSession.test.ts
    - frontend/src/pages/__tests__/Train.solveLoop.test.tsx
    - frontend/src/components/train/__tests__/TrainStartScreen.test.tsx
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx

key-decisions:
  - "Option B (LOCKED): server returns raw per-puzzle ingredients (correct_guess, move_quality), client aggregates with the existing trainScore.ts formula. No score integer computed in Python, no CI drift-check needed — Option A (porting the formula server-side) was explicitly rejected per app/models/drill_solve.py's DrillMoveQuality docstring."
  - "_resume_session's solved-count-only func.count() query widened into a single row select (correct_guess, move_quality, correct_move ordered by position) — still one query, no second round-trip; solved_count now derives as len(solved_results)."
  - "Legacy-tier fallback (move_quality IS NULL -> degrade from correct_move) extracted into one shared _resolve_move_quality_tier() helper, called from both record_solve's lost-claim re-read and the new solved_results builder — the rule now exists in exactly one place."
  - "useTrainSession's session mutation onSuccess also clears solvedPositions unconditionally when seeding sessionScore from solved_results, since that set would otherwise double-count against the freshly seeded server total on a resume; verified safe because startSession never fires mid-puzzle."
  - "sessionSolvedCount's base switched from session.solved_count to session.solved_results.length; solved_count itself was left on the wire response unchanged because TrainSolveScreen's currentPosition1Based and TrainStartScreen's landing-state resolution still consume it directly."

requirements-completed: [BUGFIX-TRAIN-SCORE-CROSSDEVICE]

coverage:
  - id: D1
    description: "POST /train/sessions returns solved_results — one entry per recorded solve, in position order, empty for fresh/no-material sessions"
    requirement: "BUGFIX-TRAIN-SCORE-CROSSDEVICE"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::test_resume_returns_solved_results_in_position_order"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::test_fresh_composition_returns_empty_solved_results"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::test_resume_solved_results_degrades_legacy_null_move_quality"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_compose_session_serves_own_blunder"
        status: pass
    human_judgment: false
  - id: D2
    description: "Train's 'Scored today' recap renders the correct non-zero total on a device that never saw the original solve responses (the reproduced prod bug)"
    requirement: "BUGFIX-TRAIN-SCORE-CROSSDEVICE"
    verification:
      - kind: integration
        ref: "frontend/src/pages/__tests__/Train.solveLoop.test.tsx#REGRESSION (260728-tgc): a completed session with server-recorded solved_results shows the correct non-zero score on a device that never saw the original solve responses"
        status: pass
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useTrainSession.test.ts#seeds sessionScore and sessionSolvedCount from solved_results, not a device-local tally"
        status: pass
    human_judgment: false
  - id: D3
    description: "The in-loop 'N / M pts' counter still increments live on each solve with no refetch, and the storage key is gone from frontend/src"
    requirement: "BUGFIX-TRAIN-SCORE-CROSSDEVICE"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useTrainSession.test.ts#increases by one after a successful solve mutation"
        status: pass
      - kind: other
        ref: "grep -rq \"train_score\" frontend/src (exit 1 -> key absent)"
        status: pass
    human_judgment: false

# Metrics
duration: ~35min
completed: 2026-07-28
status: complete
---

# Quick Task 260728-tgc: Make Train "Scored today" fully server-side Summary

**Replaced Train's localStorage-backed session score tally with a server-seeded `solved_results` wire field aggregated client-side by the existing `trainScore.ts` formula, fixing the cross-device "0 of 18" bug.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-07-28T19:44:00Z (approx, from git commit timestamps)
- **Tasks:** 3 (backend wire field, frontend seed + tally deletion, full pre-merge gate)
- **Files modified:** 13 (5 backend, 7 frontend, 1 formatter-only touch)

## Accomplishments

- `POST /train/sessions` now returns `solved_results: list[SolvedResult]` — one `{correct_guess, move_quality}` entry per recorded `drill_solves` row, in `position` order, over a single widened query (no second round-trip).
- `useTrainSession.ts`'s four localStorage helpers (`SCORE_STORAGE_PREFIX`, `scoreStorageKey`, `readStoredScore`, `persistScore`) are deleted outright; `sessionScore` now seeds from the server response via the same `scorePuzzle`/`aggregateSessionScore` pair used for live in-loop scoring.
- `sessionSolvedCount`'s base now comes from `solved_results.length` instead of the separate `solved_count` field, so the score numerator and its denominator share one server-side source.
- Reproduced the prod bug as an automated regression test (`Train.solveLoop.test.tsx`) with browser storage completely empty, and proved via mutation testing that the test actually catches the regression (reverting the seed to a constant 0 makes it fail with the expected mismatch).

## Task Commits

1. **Task 1: Return per-puzzle solved results from POST /train/sessions** - `fa4a16a6` (feat)
2. **Task 2: Seed the session score from the server and delete the device-local tally** - `3f374c15` (feat)
3. **Task 3: Full pre-merge gate** - `81256d31` (style — one formatter-added blank line)

_Note: an unrelated commit (`42372807 fix(nav): center the Train waiting-count digit in its badge`) landed on `main` between Task 1 and Task 2 from other activity on this shared working tree — it touches no file this plan modified and is not part of this quick task's work._

## Files Created/Modified

- `app/schemas/train.py` — `SolvedResult` model + `TrainSessionResponse.solved_results` field
- `app/repositories/train_repository.py` — `ComposedSolvedResult` dataclass, `_resolve_move_quality_tier()` helper (extracted from `record_solve`'s legacy-tier fallback and shared with the new builder), widened single-query `_resume_session` builder, `solved_results=[]` at the two other `ComposedSession` construction sites
- `app/routers/train.py` — maps `composed.solved_results` onto the wire response
- `tests/repositories/test_train_repository.py` — 3 new tests: resume returns entries in position order, fresh composition returns `[]`, legacy `move_quality IS NULL` row degrades correctly
- `tests/routers/test_train.py` — extended `test_compose_session_serves_own_blunder` to assert `solved_results == []` on the wire
- `frontend/src/types/train.ts` — `SolvedResult` interface + `TrainSessionResponse.solved_results`
- `frontend/src/hooks/useTrainSession.ts` — deleted localStorage helpers, session-mutation seeding, live in-loop accumulation kept, `sessionSolvedCount` base switched
- `frontend/src/components/train/TrainStartScreen.tsx` — `sessionScore` prop docstring corrected (no longer describes a localStorage-persisted tally)
- `frontend/src/hooks/__tests__/useTrainSession.test.ts` — new coverage: seeding from `solved_results`, subsequent solve still increments both
- `frontend/src/pages/__tests__/Train.solveLoop.test.tsx` — rewrote the resumed-score test to seed via `solved_results`; added the cross-device regression test; added a `getProgress` mock (see Deviations)
- `frontend/src/components/train/__tests__/TrainStartScreen.test.tsx` — `BASE_SESSION` fixture gained `solved_results: []`
- `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` — `makeSession` fixture gained `solved_results: []`; one structural test seeded a `solved_results` entry so the score row actually renders

## Decisions Made

See `key-decisions` in frontmatter. Summary: Option B (server ingredients, client aggregation) executed exactly as locked; no points arithmetic was added to Python anywhere. The one non-trivial internal decision was extracting `_resolve_move_quality_tier()` as a shared helper rather than duplicating the legacy-tier degradation logic in the new resume-path builder.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added a `getProgress` mock to `Train.solveLoop.test.tsx`'s `@/api/client` mock**
- **Found during:** Task 2, writing the cross-device regression test
- **Issue:** `TrainStatsCard`/`TrainStreakCard` (rendered by every Train landing state) call `useTrainProgress()` → `trainApi.getProgress` internally. This test file's `vi.mock('@/api/client', ...)` replaces `trainApi` with an object that never included `getProgress`, so the query never resolves (react-query logs "No queryFn was passed" and the card spins in its loading skeleton forever). Every earlier test in the file happened to pass without ever asserting on that card's populated content, so the gap was latent. The new regression test asserts on `train-stats-today-score`, which only renders once the progress query resolves — it hung past the 5s default timeout.
- **Fix:** Added a `getProgress` mock resolving a `DEFAULT_TRAIN_PROGRESS` fixture (`TrainProgressResponse`) to the shared `@/api/client` mock, plus the `15000`ms per-test timeout already used by the file's other whole-page-mount tests (`project_frontend_heavy_test_timeout_flake` precedent).
- **Files modified:** `frontend/src/pages/__tests__/Train.solveLoop.test.tsx`
- **Verification:** All 6 tests in the file pass, including the new regression test; the other 5 pre-existing tests are unaffected (none assert on progress-dependent card content).
- **Committed in:** `3f374c15` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking — test infrastructure gap, not a plan-scope change)
**Impact on plan:** No scope creep; this was a pre-existing test-mock gap that only became visible once a test actually needed the progress-dependent card to resolve. No production code was touched by this fix.

## Issues Encountered

- The plan's Task 2 verification step said to let `npx tsc -b` enumerate `TrainSessionResponse` fixtures needing `solved_results` — in practice `tsconfig.app.json` excludes all `*.test.ts(x)` files (`"exclude": ["src/**/*.test.ts", "src/**/*.test.tsx"]`), so `tsc -b` never touches test fixtures at all (confirmed: a `--force` clean rebuild produced zero errors both before and after adding `solved_results`). The actual signal came from running `vitest` and letting missing-field runtime crashes (`.map` on `undefined`) surface each fixture that needed the field — functionally equivalent enumeration, just via test runtime instead of the type checker. `npx tsc -b` was still run clean as required by the plan's literal gate command; it just wasn't the mechanism that found the fixtures.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Train's "Scored today" recap is correct on every device; no known cross-device scoring gaps remain in this area.
- `frontend/src/lib/trainScore.ts` remains the sole scoring authority — nothing in this change created a second scoring path.
- Full pre-merge gate is green (see verification report below); ready for a standard squash-merge to `main` whenever the user requests it (not done as part of this quick task per the "do not commit docs artifacts" / no-unrequested-merge instructions).

## Self-Check: PASSED

All 12 claimed created/modified files verified present on disk. All 3 task commit hashes (`fa4a16a6`, `3f374c15`, `81256d31`) verified present in `git log`.

---
*Quick task: 260728-tgc*
*Completed: 2026-07-28*
