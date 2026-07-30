---
phase: 191-schedule-progress-surface
plan: 02
subsystem: api
tags: [fastapi, sqlalchemy, train, streak, scheduler]

requires:
  - phase: 191-schedule-progress-surface
    provides: "Plan 01's settle_streak_snapshot single settlement entry point, TrainSettingsRow, get_progress/ProgressSnapshot, TrainProgressResponse"
provides:
  - "get_waiting_puzzle_count — a read-only, provably-write-free upper-bound estimate of puzzles waiting, reused by both GET /train/progress and (in a later plan) the nav badge"
  - "pool_state (no_material/exhausted/available) — the single server-side discriminant the two PROG-05 empty states branch on"
  - "next_due_date on GET /train/progress — the earliest date an ACTIVE item will next resurface"
  - "settle-before-mutate on PUT /train/settings (D-18 closure) — elapsed unsettled weeks are judged by the OLD schedule before the new one is persisted"
affects: [191-04-schedule-settings-ui, 191-05-nav-badge, 191-06-empty-states]

tech-stack:
  added: []
  patterns:
    - "COUNT-only mirror of a materializing query: get_waiting_puzzle_count reuses composition's exact eligibility predicates (due_stmt/pool_entry_stmt/herring_stmt) but only ever executes func.count() aggregates and NOT EXISTS subqueries — never a write, never a FEN reconstruction, safe to call on every progress/badge request."
    - "Read-before-mutate ordering for a frozen-value-machine: settle-before-mutate resolves the OLD row/OLD timezone BEFORE applying any new value, reusing the same single settlement entry point (settle_streak_snapshot) the read path already calls — one state machine, two call sites, no duplicated persistence logic."

key-files:
  created: []
  modified:
    - app/repositories/train_repository.py
    - app/schemas/train.py
    - app/routers/train.py
    - frontend/src/types/train.ts
    - tests/repositories/test_train_repository.py
    - tests/routers/test_train.py

key-decisions:
  - "Task 1's row-count-invariant test seeds the open/expired session fixtures with a bare (flaw-less) Game rather than reusing _seed_flaw_game, so the fixture itself never contributes extra pool_entry_stmt material and each test's expected count stays exact and legible."
  - "The Task 3 router end-to-end test computes its 'one fully-elapsed week' date relative to real wall-clock now() (current week's Monday minus 7 days) rather than a fixed historical date — settle_weeks replays EVERY elapsed week since the last settlement, so an arbitrarily old fixture date settles-then-immediately-loses the streak across the many empty weeks between then and now. This is correct settle_weeks behavior, not a bug; the fixture had to respect it."
  - "_pool_state resolves 'available' for a zero-drill_items user with a non-zero blob_pending_count (still catching up) rather than 'no_material' (cold start) — matches the plan's flagged assumption A2 and the PROG-05 requirement that opportunistic analysis in progress must never look like 'you have nothing'."

requirements-completed: [SCHD-02, PROG-05, PROG-01]

coverage:
  - id: D1
    description: "get_waiting_puzzle_count returns a read-only upper-bound estimate mirroring composition's own eligibility predicates (open-session/completed-session/due+pool+herring), provably never writing a drill_sessions or drill_solves row"
    requirement: "SCHD-02"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py -k waiting (8 tests, incl. test_waiting_count_never_writes_a_session_or_solve_row and test_waiting_count_expired_open_session_ignored_and_not_flipped)"
        status: pass
    human_judgment: false
  - id: D2
    description: "pool_state (no_material/exhausted/available) and next_due_date on GET /train/progress give the two PROG-05 empty-state surfaces a single server-side discriminant with no client-side arithmetic"
    requirement: "PROG-05"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py -k 'pool_state or next_due' (6 tests)"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_progress_returns_200_with_all_seven_fields"
        status: pass
    human_judgment: false
  - id: D3
    description: "PUT /train/settings settles every fully-elapsed unsettled week against the OLD weekday_mask/timezone before persisting the new values (D-18 settle-before-mutate)"
    requirement: "PROG-01"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py -k settle (5 tests, incl. test_settings_update_settles_with_old_mask_first)"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_put_settings_settles_elapsed_weeks_with_old_mask_before_get"
        status: pass
    human_judgment: false

duration: 55min
completed: 2026-07-27
status: complete
---

# Phase 191 Plan 02: Backend Read-Model — Waiting Count, Pool State, Settle-Before-Mutate Summary

**A read-only `get_waiting_puzzle_count` estimate, a server-computed `pool_state` empty-state discriminant, and D-18's settle-before-mutate close on `PUT /train/settings` — all landing in `train_repository.py`.**

## Performance

- **Duration:** ~55 min
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- `get_waiting_puzzle_count` (repository): mirrors `compose_and_materialize_session`'s own branch order — an open unexpired session (puzzle_count minus solved count), a completed-in-window session (0, D-07), or a COUNT-only estimate of due `drill_items` + untracked `pool_entry_stmt` candidates (excluded via SQL `NOT EXISTS`, never a Python pair set) + `herring_stmt(exclude_served=False)` candidates, capped at `puzzles_per_session`. Never calls `compose_and_materialize_session` or `expire_stale_sessions`; an expired-but-still-`open` row is skipped in Python, never flipped. 8 named tests including a row-count invariant proving the read never writes a `drill_sessions`/`drill_solves` row, and a two-user scoping proof.
- `_pool_state` + `_next_due_date` (repository) + `GET /train/progress` response fields `waiting_count`/`pool_state`/`next_due_date`: `pool_state` is a single `Literal["no_material", "exhausted", "available"]` the two PROG-05 empty states branch on — cold-start (never had material) vs. exhausted (had material, nothing waiting, nothing analyzing) vs. available (including "still catching up" for a zero-`drill_items` user with a non-zero blob-pending count). `next_due_date` is the earliest future due date among ACTIVE items, or null.
- Settle-before-mutate on `upsert_settings` (D-18 closure): reads the OLD `train_settings` row and resolves `today` from the OLD timezone, calls Plan 01's `settle_streak_snapshot` (the one settlement entry point, reused verbatim), THEN applies the new `timezone`/`weekday_mask`/`puzzles_per_session`. A user who skips several weeks and then reschedules has those weeks judged by the schedule that was actually in force, not the one they just picked. `update_train_settings` passes `now_utc` through; the handler docstring records the D-18 ordering.

## Task Commits

1. **Task 1: Read-only waiting-puzzle count that never materializes a session** - `266c5bb0` (feat)
2. **Task 2: Pool-state discriminant and next-due date on the progress response** - `29e2860e` (feat)
3. **Task 3: Settle-before-mutate on PUT /train/settings** - `055aca39` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified

- `app/repositories/train_repository.py` - `get_waiting_puzzle_count`, `_pool_state`, `_next_due_date`; `ProgressSnapshot` gains `waiting_count`/`pool_state`/`next_due_date`; `upsert_settings` gains `now_utc` and settle-before-mutate
- `app/schemas/train.py` - `TrainProgressResponse` gains `waiting_count`/`pool_state`/`next_due_date`
- `app/routers/train.py` - `get_train_progress` passes the three new fields through; `update_train_settings` passes `now_utc`
- `frontend/src/types/train.ts` - `TrainPoolState`; `TrainProgressResponse` mirror gains the three new fields
- `tests/repositories/test_train_repository.py` - 8 waiting-count tests, 6 pool_state/next_due_date tests, 5 settle-before-mutate tests (incl. `test_settings_update_settles_with_old_mask_first`)
- `tests/routers/test_train.py` - extended progress 200 test (10-field key set), one settle-before-mutate end-to-end PUT-then-GET case

## Decisions Made

- Row-count-invariant fixtures back their `drill_sessions`/`drill_solves` rows with a bare (flaw-less) `Game` rather than the shared `_seed_flaw_game` helper, so the fixture itself never contributes extra `pool_entry_stmt` material — keeps each expected count exact rather than an off-by-N surprise.
- The Task 3 router end-to-end test computes its "one fully-elapsed week" fixture date relative to real wall-clock `now()` (current week's Monday minus 7 days), not a fixed historical date — `settle_weeks` replays every elapsed week since the last settlement, so an arbitrarily old fixture date settles the one real week and then immediately loses the streak across the many empty weeks since. This is correct `settle_weeks` behavior (D-05 full-history replay), not a bug; the fixture had to respect it.
- `_pool_state` resolves `"available"` (not `"no_material"`) for a zero-`drill_items` user whose blunders are still being analyzed (`blob_pending_count > 0`) — matches the plan's flagged assumption A2 and PROG-05's requirement that in-progress analysis must never present as "you have nothing".

## Deviations from Plan

None — plan executed exactly as written, all `<behavior>` cases and acceptance criteria satisfied by named tests.

## Issues Encountered

None. One self-caught test-design bug during Task 1 development (a row-count-invariant fixture accidentally added extra pool material via a shared flaw-seeding helper) was found and fixed before any commit — see Decisions Made.

## User Setup Required

None — no external service configuration, no migration (all three tasks operate on existing tables and existing columns).

## Next Phase Readiness

- `get_waiting_puzzle_count` and `pool_state` are ready for Plan 05's nav badge and Plan 06's empty states to consume via the shared `GET /train/progress` response (no new endpoint needed).
- D-18 is now fully closed: lazy-on-read settlement (Plan 01) + settle-before-mutate (this plan) together guarantee a settled week can never be re-judged, whether the user reads or reschedules first.
- No blockers for Plans 03/04/05/06.

## Self-Check: PASSED

All modified files verified present on disk; commit hashes `266c5bb0`, `29e2860e`, `055aca39` verified in `git log`.

---
*Phase: 191-schedule-progress-surface*
*Completed: 2026-07-27*
</content>
