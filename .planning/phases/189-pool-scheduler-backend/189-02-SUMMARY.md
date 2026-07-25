---
phase: 189-pool-scheduler-backend
plan: 02
subsystem: database
tags: [sqlalchemy, postgres, cascade, fastapi, pytest]

# Dependency graph
requires:
  - phase: 189-01
    provides: "drill_items / drill_sessions / drill_solves / train_settings tables (D-02/D-04 anchoring), guest-gated POST /api/train/sessions"
provides:
  - "Non-vacuous cascade tests proving DELETE /imports/games and the 30-day guest purge remove drill_items/drill_solves via the games FK cascade while drill_sessions/train_settings survive (D-04)"
  - "D-04/D-05 breadcrumb comments at both real delete call sites (app/routers/imports.py, app/services/guest_cleanup_service.py) so a future 'cleanup' commit cannot silently delete drill_sessions without failing CI"
affects: [190-train-page-and-solve-loop, 191-schedule-and-progress-surface]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "POOL-09 guarantee is proven by application-level tests against the FK schema (T-189-06/T-189-07), not by application code — the deletion logic itself is unchanged"

key-files:
  created: []
  modified:
    - app/routers/imports.py
    - app/services/guest_cleanup_service.py
    - tests/test_imports_router.py
    - tests/test_guest_cleanup_service.py

key-decisions:
  - "Both new comments cite Phase 189's D-02/D-04/D-05 by phase-scoped ID (not bare 'D-05') to disambiguate from guest_cleanup_service.py's own pre-existing Phase-187 D-05 label, which is an unrelated decision (cursor-reset column scope) in the same file"
  - "test_purge_guest_without_drill_rows_is_noop and test_delete_games_no_drill_rows_is_noop create no non-guest rows, so no finally-block cleanup was added — the file's existing autouse _cleanup_leaked_guest_rows fixture already cascades away every guest-owned row (drill_sessions included, via its users.id FK) when the test's guest User row is deleted at teardown"

requirements-completed: [POOL-09]

coverage:
  - id: D1
    description: "DELETE /api/games (DELETE /imports/games) cascades drill_items and drill_solves away via the games FK while leaving drill_sessions and train_settings untouched"
    requirement: "POOL-09"
    verification:
      - kind: integration
        ref: "tests/test_imports_router.py::TestDeleteAllGamesDrillCascade::test_delete_games_cascades_drill_rows"
        status: pass
    human_judgment: false
  - id: D2
    description: "Deleting a single game removes only that game's drill_items; a sibling game's drill_items for the same user survive with streak/due_date unchanged"
    requirement: "POOL-09"
    verification:
      - kind: integration
        ref: "tests/test_imports_router.py::TestDeleteAllGamesDrillCascade::test_delete_single_game_leaves_sibling_drill_rows"
        status: pass
    human_judgment: false
  - id: D3
    description: "Delete-all is a safe no-op for a user with no train rows, and idempotent on repeated calls"
    requirement: "POOL-09"
    verification:
      - kind: integration
        ref: "tests/test_imports_router.py::TestDeleteAllGamesDrillCascade::test_delete_games_no_drill_rows_is_noop"
        status: pass
      - kind: integration
        ref: "tests/test_imports_router.py::TestDeleteAllGamesDrillCascade::test_delete_games_twice_is_idempotent"
        status: pass
    human_judgment: false
  - id: D4
    description: "POST /api/train/sessions returns 200 with an empty puzzle list (not a 500) after a user's games have all been deleted"
    requirement: "POOL-09"
    verification:
      - kind: integration
        ref: "tests/test_imports_router.py::TestDeleteAllGamesDrillCascade::test_compose_session_after_delete_all_returns_empty"
        status: pass
    human_judgment: false
  - id: D5
    description: "The 30-day guest-inactivity purge cascades drill_items/drill_solves away via the games FK while the guest's drill_sessions row survives; a guest with no train rows purges cleanly"
    requirement: "POOL-09"
    verification:
      - kind: integration
        ref: "tests/test_guest_cleanup_service.py::TestPurgeGuestDrillCascade::test_purge_guest_cascades_drill_rows"
        status: pass
      - kind: integration
        ref: "tests/test_guest_cleanup_service.py::TestPurgeGuestDrillCascade::test_purge_guest_without_drill_rows_is_noop"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-25
status: complete
---

# Phase 189 Plan 02: Delete-All + Guest-Purge Cascade Verification Summary

**Non-vacuous cascade tests pinning POOL-09 at both real deletion call sites — proving drill_items/drill_solves are removed by the games FK cascade while drill_sessions/train_settings deliberately survive (D-04), with a breadcrumb comment at each site so a future cleanup commit fails CI instead of silently erasing streak history**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-07-25
- **Tasks:** 2 (both `type="auto"`)
- **Files modified:** 4 (0 created)

## Accomplishments

- `app/routers/imports.py`'s `delete_all_games` handler gained a D-02/D-04 comment immediately after the `delete_all_games_for_user` call — no new delete statement — plus 5 new tests in `tests/test_imports_router.py::TestDeleteAllGamesDrillCascade`: non-vacuous cascade (non-zero before, zero after, `drill_sessions`/`train_settings` unchanged), single-game-delete sibling survival, no-drill-rows no-op, twice-idempotent, and post-wipe session composition returning 200 with an empty puzzle list.
- `app/services/guest_cleanup_service.py`'s `_purge_guest` gained a D-04/D-05 comment next to its existing explicit deletes — no new delete statement — plus 2 new tests in `tests/test_guest_cleanup_service.py::TestPurgeGuestDrillCascade`: non-vacuous cascade coverage and a no-drill-rows no-op, both using the file's established `real_session_maker`/`_seed_eligible_guest_with_game` fixtures.
- Both comments cite the phase-scoped decision IDs (Phase 189's D-02/D-04/D-05) explicitly, distinguishing them from `guest_cleanup_service.py`'s own pre-existing Phase-187 "D-05" label (an unrelated cursor-reset decision) already present in the same function.
- Full backend suite (3675 tests, `-n auto`) green; `ruff check` and `ty check` clean.

## Task Commits

1. **Task 1: Pin the delete-all cascade and the drill_sessions survival rule** - `b98fae8b` (test)
2. **Task 2: Pin the guest-purge cascade** - `56b4a64c` (test)

**Plan metadata:** (this commit)

## Files Created/Modified

- `app/routers/imports.py` - D-02/D-04 breadcrumb comment in `delete_all_games`, no delete-statement change
- `app/services/guest_cleanup_service.py` - D-04/D-05 breadcrumb comment in `_purge_guest`, no delete-statement change
- `tests/test_imports_router.py` - `TestDeleteAllGamesDrillCascade` (5 tests) + `_game_row` seed helper
- `tests/test_guest_cleanup_service.py` - `TestPurgeGuestDrillCascade` (2 tests)

## Decisions Made

- Comments cite phase-scoped IDs ("Phase 189 D-04/D-05") rather than bare "D-05" to avoid colliding with `guest_cleanup_service.py`'s own pre-existing Phase-187 D-05 label in the same function body.
- No `finally`-block cleanup was added around the two no-drill-rows tests — they create no non-guest rows, and the file's existing autouse `_cleanup_leaked_guest_rows` fixture already deletes the test's guest `User` row at teardown, cascading away every FK'd child (including `drill_sessions`) for free.

## Deviations from Plan

None - plan executed exactly as written. Both tasks matched their `<action>` blocks and acceptance criteria without requiring an auto-fix.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- POOL-09 is now proven at both real call sites with regression tests; a future PR that adds a `delete(DrillSession)`/`delete(TrainSettings)` statement at either site will fail these new tests, not just silently ship.
- No blockers for Plan 03 (sharp/soft classifier + red herrings), Plan 04 (D-12 resume + settings endpoints), or Plan 05 (solve/reveal endpoints).

---
*Phase: 189-pool-scheduler-backend*
*Completed: 2026-07-25*

## Self-Check: PASSED

All 4 created/modified source/test files verified present; both task commits (`b98fae8b`, `56b4a64c`) verified in git log.
