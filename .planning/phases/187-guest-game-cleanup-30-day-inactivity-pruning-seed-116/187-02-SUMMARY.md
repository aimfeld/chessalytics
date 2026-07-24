---
phase: 187-guest-game-cleanup-30-day-inactivity-pruning-seed-116
plan: 02
subsystem: infra
tags: [asyncio, fastapi-lifespan, background-jobs, sentry, guest-cleanup]

# Dependency graph
requires:
  - phase: 187-guest-game-cleanup-30-day-inactivity-pruning-seed-116 (Plan 01)
    provides: "guest_cleanup_service.py: get_eligible_guest_ids, _purge_guest, cleanup_inactive_guests, _GUEST_CLEANUP_INTERVAL_SECONDS"
provides:
  - "app/services/guest_cleanup_service.py: run_periodic_guest_cleanup (daily periodic loop)"
  - "app/main.py: guest-cleanup wired as the 4th lifespan background task"
  - "tests/test_main_lifespan.py: EXPECTED_TASKS drift fixed, full-task-spawn coverage restored"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Periodic asyncio task loop: sleep-before-first-tick, per-tick try/except, logger.exception + sentry_sdk.set_tag/capture_exception (mirrors run_periodic_reaper)"
    - "Lifespan task lifecycle: create_task on startup, cancel()+await in shutdown finally, CancelledError swallowed, other exceptions logged not propagated"

key-files:
  created: []
  modified:
    - app/services/guest_cleanup_service.py
    - app/main.py
    - tests/test_guest_cleanup_service.py
    - tests/test_main_lifespan.py

key-decisions:
  - "run_periodic_guest_cleanup is a byte-for-byte structural mirror of run_periodic_reaper (D-01/D-02): no deviation from the plan's specified shape."
  - "Fixed pre-existing test_main_lifespan.py EXPECTED_TASKS drift (missing 'full-eval-drain') as part of this plan's declared scope, not a separate deviation."

patterns-established:
  - "guest_cleanup_service.py now exposes 3 layers: eligibility query / per-guest purge / per-tick orchestration (Plan 01) + periodic loop wrapper (Plan 02) — full production lifecycle for a 4th background task type."

requirements-completed: []

coverage:
  - id: D1
    description: "run_periodic_guest_cleanup sleeps _GUEST_CLEANUP_INTERVAL_SECONDS before each tick, calls cleanup_inactive_guests once per tick, and survives (logs + Sentry-captures) a per-tick exception without breaking the loop"
    verification:
      - kind: unit
        ref: "tests/test_guest_cleanup_service.py::TestRunPeriodicGuestCleanup::test_calls_cleanup_once_per_iteration"
        status: pass
      - kind: unit
        ref: "tests/test_guest_cleanup_service.py::TestRunPeriodicGuestCleanup::test_survives_cleanup_exception"
        status: pass
    human_judgment: false
  - id: D2
    description: "The guest-cleanup task is spawned via asyncio.create_task in the app/main.py lifespan on startup and cancelled+awaited cleanly on shutdown, alongside the existing 3 background tasks"
    verification:
      - kind: integration
        ref: "tests/test_main_lifespan.py::TestLifespanBackgroundTasks::test_both_background_tasks_spawned"
        status: pass
    human_judgment: false
  - id: D3
    description: "tests/test_main_lifespan.py EXPECTED_TASKS drift corrected (added missing 'full-eval-drain' and new 'guest-cleanup'), and the lifespan smoke test now stubs+asserts all 4 named tasks"
    verification:
      - kind: unit
        ref: "tests/test_main_lifespan.py (EXPECTED_TASKS constant + test_both_background_tasks_spawned assertions)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-24
status: complete
---

# Phase 187 Plan 02: Periodic Loop + Lifespan Wiring Summary

**`run_periodic_guest_cleanup` daily asyncio loop wrapping Plan 01's purge orchestration, wired as the 4th FastAPI lifespan background task alongside the reaper/eval-drain/full-eval-drain, with the lifespan smoke test's pre-existing task-list drift corrected.**

## Performance

- **Duration:** ~20 min
- **Tasks:** 2 completed
- **Files modified:** 4

## Accomplishments

- `run_periodic_guest_cleanup()` added to `guest_cleanup_service.py` — a structural 1:1 mirror of `run_periodic_reaper`: infinite loop, sleeps `_GUEST_CLEANUP_INTERVAL_SECONDS` (24h) before each tick, calls `cleanup_inactive_guests()`, and on exception logs via `logger.exception`, tags `source="guest_cleanup"`, and calls `sentry_sdk.capture_exception()` without breaking the loop (D-01/D-02/D-07).
- `app/main.py` lifespan wiring: imported `run_periodic_guest_cleanup`, spawned `guest_cleanup_task = asyncio.create_task(run_periodic_guest_cleanup(), name="guest-cleanup")` after `full_drain_task`, and added the matching `.cancel()` + `try/except CancelledError/except Exception: logger.exception(...)` block in the shutdown `finally`, placed after the `full_drain_task` block and before `stop_engine()`/`stop_maia()` — no ordering dependency since guest cleanup never touches the engine.
- `tests/test_guest_cleanup_service.py::TestRunPeriodicGuestCleanup` — two fast unit tests (monkeypatched `asyncio.sleep` + `cleanup_inactive_guests`, no DB) mirroring `TestRunPeriodicReaper`: one iteration calls the orchestration, and a raised exception is swallowed while `sentry_sdk.capture_exception` fires.
- `tests/test_main_lifespan.py`: corrected the pre-existing `EXPECTED_TASKS` drift (was missing `"full-eval-drain"`, widened the type annotation to `tuple[str, ...]`) and added `"guest-cleanup"`; extended `test_both_background_tasks_spawned` with `_stub_full_drain`/`_stub_guest_cleanup` recording stubs so all 4 named tasks are now verified spawned at lifespan startup (previously only 2 of 4 were actually asserted).

## Task Commits

Each task was committed atomically:

1. **Task 1: run_periodic_guest_cleanup loop + loop-mechanics tests** - `c61274cd` (feat)
2. **Task 2: Wire the 4th background task into app/main.py lifespan + fix test_main_lifespan drift** - `59d59c5b` (feat)

**Plan metadata:** committed as part of this summary's final commit (see `<final_commit>`).

## Files Created/Modified

- `app/services/guest_cleanup_service.py` - added `run_periodic_guest_cleanup()` (periodic loop wrapper, `asyncio` import added)
- `app/main.py` - imported `run_periodic_guest_cleanup`; spawned/cancelled `guest_cleanup_task` as the 4th lifespan background task
- `tests/test_guest_cleanup_service.py` - added `TestRunPeriodicGuestCleanup` (2 unit tests, `asyncio`/`unittest.mock.patch` imports added)
- `tests/test_main_lifespan.py` - corrected `EXPECTED_TASKS`, extended `test_both_background_tasks_spawned` to cover all 4 tasks

## Decisions Made

- Followed the plan's structural-mirror mandate exactly: no divergence from `run_periodic_reaper`'s shape (sleep-first, per-tick try/except, per-tick Sentry capture) and no divergence from the existing 3-task lifespan wiring pattern (cancel-then-await-all, CancelledError swallowed, other exceptions logged not propagated).
- Fixed the pre-existing `EXPECTED_TASKS` staleness (T-187-08 in the plan's threat register) as in-scope work per the plan's explicit instruction, not treated as an out-of-scope deviation.

## Deviations from Plan

None - plan executed exactly as written. The `EXPECTED_TASKS` correction and `test_both_background_tasks_spawned` extension were both explicitly specified in Task 2's `<action>`, not discovered mid-execution.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. The task starts automatically in every environment where the FastAPI lifespan runs (dev and prod); no env vars or manual steps needed.

## Next Phase Readiness

- Phase 187 (SEED-116) is now feature-complete: the 30-day guest inactivity cleanup runs automatically in-process, daily, with clean startup/shutdown lifecycle and per-tick failure isolation at both the loop level (this plan) and the per-guest level (Plan 01).
- No blockers for this phase. The daily interval means the first real production tick won't fire until ~24h after the next deploy; Sentry (source=guest_cleanup) is the effective early-warning channel per D-07 — no dry-run/manual-trigger tooling exists by design (D-07 deferred item).
- Full backend gate green: `ruff format`, `ruff check --fix`, `ty check app/ tests/` (zero errors), full `pytest -n auto` (3635 passed, 18 pre-existing skips, 0 failures).

---
*Phase: 187-guest-game-cleanup-30-day-inactivity-pruning-seed-116*
*Completed: 2026-07-24*

## Self-Check: PASSED
