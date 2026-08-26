---
phase: quick-260826-pn3
plan: 01
subsystem: train
tags: [train, spaced-repetition, drill-items, scheduler]
dependency-graph:
  requires: []
  provides:
    - "app.services.train_scheduler.LEECH_FAIL_THRESHOLD"
    - "app.services.train_scheduler.apply_result (two-door parking)"
  affects:
    - app/services/train_scheduler.py
    - app/repositories/train_repository.py (consumes ItemState pass-through, unedited)
    - app/routers/train.py (consumes apply_result's status, unedited)
    - frontend/src/components/train/TrainStatsCard.tsx
tech-stack:
  added: []
  patterns:
    - "Named boolean locals for independently greppable park-door conditions (door_a_never_solved, door_b_leech)"
key-files:
  created: []
  modified:
    - app/services/train_scheduler.py
    - tests/services/test_train_scheduler.py
    - app/models/drill_item.py
    - frontend/src/components/train/TrainStatsCard.tsx
    - tests/routers/test_train.py
    - CHANGELOG.md
decisions:
  - "Park-only, no un-park affordance (locked by Adrian 2026-08-26, matches Phase 191 D-17) — not re-opened."
  - "LEECH_FAIL_THRESHOLD = 6 lifetime lapses, tighter than Anki's default of 8, because a Train session holds far fewer slots than an Anki deck so each wasted slot costs more."
metrics:
  duration: "~35 minutes"
  completed: 2026-08-26
actuals:
  tokens: 4874
  tasks: 3
  commits: 3
status: complete
---

# Quick Task 260826-pn3: Train SR — Park Leech Items After 6 Lifetime Lapses Summary

Made `drill_items.fail_count` a non-resetting lifetime lapse counter and added a second
park door (Door B, 6 lifetime lapses) to `apply_result` in `train_scheduler.py`, so an item
the user alternately solves and fails can finally leave the Train SR pool — previously it
never could, because the only park door required `ever_correct is False`, which the first
correct solve permanently disqualified.

## What Changed

**Task 1 — `app/services/train_scheduler.py` / `tests/services/test_train_scheduler.py`:**
- Added `LEECH_FAIL_THRESHOLD: int = 6`, exported in `__all__`.
- Correct-move branch of `apply_result`: both returns (MASTERED and ACTIVE) now carry
  `state.fail_count` through unchanged instead of hardcoding `0`.
- Wrong-move branch: the increment is now unconditional (dropped the `ever_correct` guard).
  Two independent named booleans evaluate the doors — `door_a_never_solved` (unchanged,
  POOL-06) and `door_b_leech` (new, SEED-154). Either parks the item.
- **Silent-corruption trap fixed:** the PARKED return used to hardcode `ever_correct=False`.
  Since Door B can now fire on an item that HAS been solved, the return propagates
  `state.ever_correct` instead — guarded by `test_leech_park_preserves_ever_correct_true`.
- Rewrote 3 tests that encoded the old semantics under new names, added 4 new tests plus
  the guard test, per the plan's `<behavior>` block. 59 tests pass.

**Task 2 — docs/copy only, no logic changes:**
- `app/models/drill_item.py` module docstring now states the two-door rule (POOL-06 +
  SEED-154).
- `frontend/src/components/train/TrainStatsCard.tsx`: `PARKED_EXPLAINER` now reads "Missed
  6 times in total, or 3 times without ever solving it. Parked puzzles are set aside so
  they stop resurfacing." Doc comment above the constants lists `LEECH_FAIL_THRESHOLD` (6).
- `tests/routers/test_train.py`: fixed a stale docstring line on
  `test_solve_wrong_resets_streak_and_counts_fail` (no assertion/fixture change).
- `CHANGELOG.md`: added a `### Changed` bullet under `## [Unreleased]`.

**Task 3 — verification only, no files modified.**

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Verification

- `uv run pytest tests/services/test_train_scheduler.py -q` — 59 passed.
- `uv run pytest tests/services/test_train_scheduler.py tests/routers/test_train.py tests/repositories/test_train_repository.py -n auto -q` — 258 passed, all DB-backed Train assertions unchanged.
- `uv run ty check app/ tests/ scripts/` — zero errors.
- `uv run --project analysis --with ty ty check analysis/` — zero errors.
- `uv run ruff format app/ tests/ scripts/ analysis/` — 1 file reformatted (`tests/services/test_train_scheduler.py`, line-wrap only); committed separately as `style(train): ...`.
- `uv run ruff check . --fix` — all checks passed, no further changes.
- `uv run pytest -n auto -x` (full backend suite) — **4454 passed, 19 skipped** (pre-existing skips, unrelated to this change).
- `cd frontend && npm run lint` — clean.
- `cd frontend && npm test -- --run` (full frontend suite) — **3578 passed, 2 failed** in `src/pages/__tests__/Train.guestGate.test.tsx` (a `waitFor` timeout on `btn-signup-for-train`), reproduced twice under the full-suite run. Re-ran the same file in isolation twice: **6/6 passed both times.** Confirmed unrelated to this plan's changes via grep (the file references neither `TrainStatsCard` nor `PARKED_EXPLAINER`) and via `git log` on the file (last touching commits: opponent-matching rework, dead-field cleanup, Train warm-up sessions — none from this task). This matches the documented "Heavy frontend test timeout flake" pattern (two independent ceilings: Vitest's 5s `testTimeout` and testing-library's default 1000ms `waitFor`; a bare `waitFor` stack means the 1000ms ceiling is the one hit, which the per-test timeout does not cover). Logged to `deferred-items.md` per the plan's scope boundary — out of scope for this task's auto-fix rules (pre-existing, unrelated file).
- `npm run build` was not required per the plan (one string constant + one comment changed, no shared type, no new property access).

**Full pre-merge gate: green modulo one pre-existing, reproducibly-isolated-passing frontend flake unrelated to this change.** Ready to squash-merge.

## Self-Check: PASSED

- `app/services/train_scheduler.py` — FOUND, contains `LEECH_FAIL_THRESHOLD` (5 non-comment occurrences).
- `tests/services/test_train_scheduler.py` — FOUND, 59 tests pass.
- `app/models/drill_item.py` — FOUND, docstring updated.
- `frontend/src/components/train/TrainStatsCard.tsx` — FOUND, `PARKED_EXPLAINER` updated.
- `tests/routers/test_train.py` — FOUND, docstring updated, assertions untouched.
- `CHANGELOG.md` — FOUND, `### Changed` bullet present under `## [Unreleased]`.
- Commit `92c62d4e5` — FOUND in `git log`.
- Commit `4180adf2e` — FOUND in `git log`.
- Commit `c278c9cef` — FOUND in `git log`.
