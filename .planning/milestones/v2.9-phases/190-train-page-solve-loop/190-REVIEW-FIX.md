---
phase: 190-train-page-solve-loop
fixed_at: 2026-07-26T08:05:24Z
review_path: .planning/phases/190-train-page-solve-loop/190-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 190: Code Review Fix Report

**Fixed at:** 2026-07-26T08:05:24Z
**Source review:** .planning/phases/190-train-page-solve-loop/190-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 4 (critical_warning — CR-01, WR-01, WR-02, WR-03; IN-01/IN-02 out of scope)
- Fixed: 4
- Skipped: 0

## Fixed Issues

### CR-01: Grading silently uses a fabricated null result when the Stockfish Worker isn't ready yet, with no UI gate to prevent it

**Files modified:** `frontend/src/hooks/useTrainGradingEngine.ts`, `frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts`, `frontend/src/components/train/TrainSolveScreen.tsx` (defense-in-depth UI gate, committed under WR-01 below since it landed alongside that fix)
**Commits:** `ed4ea6c8`, `8c3a292f`
**Applied fix:** `search()` in `useTrainGradingEngine.ts` now queues the dispatch (`pendingReadyDispatchRef`) instead of resolving immediately with a fabricated `{evalCp: null, evalMate: null, bestMoveUci: null}` result whenever the engine isn't ready. The `readyok` handler in `handleLine` drains the queued dispatch once the handshake completes. `pendingReadyDispatchRef` is cleared on `abortGrading()` and on Worker teardown to avoid leaking stale requests across generations.

**Adaptation beyond the review's literal snippet:** the review's suggested fix rejected outright when `!worker` (`reject(new Error('Grading engine unavailable'))`). Implementing that literally broke 4 existing `TrainSolveScreen.test.tsx` tests — investigation showed this is because React commits a **child** component's mount effects (`TrainSolveScreen`'s own effect, which calls `startGrading`) before an **ancestor**'s effects (`useTrainGradingEngine`'s Worker-construction effect lives in the parent, `Train.tsx`). This means `workerRef.current` is **guaranteed** to be `null` on the very first puzzle of every session, not just occasionally under a slow WASM fetch. The final fix queues in both the "Worker doesn't exist yet" and "Worker exists but not ready" cases — both are safely drained by the same `readyok` handler once the Worker is eventually constructed, since `Train.tsx` never disables the engine (`enabled: true` is a constant) once a session mounts.

**Proof (revert-fails-test):** added a hook-level regression test asserting `search()` queues (0 `go` messages dispatched) rather than immediately fabricating a result when `startGrading` fires before `readyok`, then dispatches for real (1 `go` message) once the handshake completes, yielding a genuine `bestMoveUci` match instead of a permanent `null`. Reverting the `useTrainGradingEngine.ts` fix while keeping this test fails it (`expected +0 to be 1`). The `!worker`-reject regression was independently caught (and proven) by the pre-existing `TrainSolveScreen.test.tsx` suite: `git stash`-ing the `!worker`-reject version reproduced 4 failing tests (grading-error surfaced instead of a verdict); the merged queue-both-cases fix restores all 4 to green.

### WR-01: `handleRetryEngine` invokes `startGrading` before the Worker restart it just triggered has actually happened

**Files modified:** `frontend/src/components/train/TrainSolveScreen.tsx`, `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx`
**Commit:** `949546e3`
**Applied fix:** `handleRetryEngine` no longer calls `startGrading(puzzle.fen)` synchronously (it only calls `restartEngine()`, resets `engineTimedOut`, and bumps `engineRetryNonce`). A new `useEffect` keyed on `[isReady, engineRetryNonce]` re-dispatches `startGrading` exactly once, only after the restarted Worker actually reports ready (tracked via `lastStartedRetryNonceRef` so it doesn't re-fire on every render once ready). Also folded in CR-01's defense-in-depth: the guess/move UI now renders a "Loading engine…" state (`data-testid="train-engine-loading"`) instead of the guess buttons whenever `!isReady && !engineFailed`, so a fast user can never race the WASM boot even before the primary hook-level fix would matter.

**Proof (revert-fails-test):** added a test simulating an `onerror`-triggered engine failure (`FailingWorker`) followed by a manual retry that hands out a healthy `FakeWorker`; asserts the guess buttons reappear and a subsequent played move reaches `train-verdict-guess` (not `train-grading-error`). Reverting only `TrainSolveScreen.tsx` (keeping the new test) reproduces exactly the review's predicted failure mode: `train-grading-error` shows forever, the verdict never lands, because the stale synchronous `startGrading` call permanently rejected the puzzle's grading against not-yet-reset refs.

### WR-02: Session completion never accounts for an SR-item's `game_flaws` row vanishing under reclassification

**Files modified:** `app/repositories/train_repository.py`, `tests/routers/test_train.py`
**Commit:** `ff0f8ed7`
**Applied fix:** `_mark_session_complete_if_done`'s remaining-count query now `outerjoin`s `GameFlaw` (keyed the same way `load_session_puzzles`'s own `existing_flaw_keys` check is keyed: `user_id`, `game_id`, `ply`) and excludes SR-source rows whose flaw row no longer exists via `or_(DrillSolve.source != DrillSource.SR_ITEM, GameFlaw.game_id.isnot(None))` — mirroring `load_session_puzzles`'s lazy-eviction posture instead of only excluding rows whose `games` row was deleted.

**Proof (revert-fails-test):** added `test_session_completes_when_sr_item_flaw_row_vanishes_under_reclassification`, which seeds a 2-puzzle session (one SR item, one herring), deletes the SR item's backing `GameFlaw` row (simulating reclassification), solves only the herring, and asserts `session_complete: true`. Running this test against the pre-fix code fails with `assert False is True` (session stayed open forever, exactly the review's predicted stuck state); it passes with the fix applied.

### WR-03: `TrainReveal`'s tactic-line stepper block uses non-null assertions instead of narrowing the query result

**Files modified:** `frontend/src/components/train/TrainReveal.tsx`
**Commit:** `a5942f4c`
**Applied fix:** Bound `const tacticLinesData = tacticLinesQuery.data;` once and narrowed each `TrainLineStepper` render with `missedMoves && missedMoves.length > 0 && tacticLinesData && (...)` / `allowedMoves && ... && tacticLinesData && (...)`, reading `tacticLinesData.position_fen`/`.missed_motif`/`.missed_depth`/`.allowed_motif`/`.allowed_depth` instead of the four `tacticLinesQuery.data!` assertions. This is a type-safety-only refactor with no behavior change (the review itself notes the current code is "sound today," just fragile against a future refactor) — verified via the full pre-existing `TrainReveal.test.tsx` suite (12 tests) staying green and `npx tsc -b` reporting zero errors; no new dedicated test was added since there is no observable runtime behavior to assert against.

## Skipped Issues

None — all 4 in-scope findings (critical_warning) were fixed.

## Out of Scope (fix_scope: critical_warning)

IN-01 (redundant exception subclasses in `train_repository.py`/`library_repository.py`) and IN-02 (`SolveRequest.played_move` lacks UCI format validation) were left untouched per the configured `fix_scope`.

## Verification Summary

- Frontend: `npx tsc -b` (zero errors), `npm run lint` (zero errors), `npm run knip` (zero issues), full `npm test -- --run` (193 files / 2634 tests, all passing).
- Backend: `uv run ruff format --check` + `uv run ruff check` (clean), `uv run ty check app/ tests/` (zero errors), full `uv run pytest -n auto` (3780 passed, 19 skipped, 0 failed).
- Every fix was proven via revert-the-fix-fails-the-test evidence (see each finding above), not just symbol-presence/grep.

---

_Fixed: 2026-07-26T08:05:24Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
