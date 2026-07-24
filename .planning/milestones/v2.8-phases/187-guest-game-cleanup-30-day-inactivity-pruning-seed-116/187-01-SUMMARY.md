---
phase: 187-guest-game-cleanup-30-day-inactivity-pruning-seed-116
plan: 01
subsystem: database
tags: [sqlalchemy, postgres, guest-auth, background-jobs, cascade-delete]

# Dependency graph
requires:
  - phase: 186-import-filters-tc-and-game-cap
    provides: user_import_settings backfill-cursor columns + reset_backfill_cursors repository function
provides:
  - "app/services/guest_cleanup_service.py: get_eligible_guest_ids, _purge_guest, cleanup_inactive_guests"
  - "_GUEST_CLEANUP_INTERVAL_SECONDS constant (consumed by Plan 02's periodic wrapper)"
affects: [187-02-lifespan-wiring]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-guest transaction isolation (one async_session_maker() session/commit per guest, D-06)"
    - "Per-tick loop: per-item try/except accumulating counts, single aggregated Sentry capture at tick end (not per-item)"

key-files:
  created:
    - app/services/guest_cleanup_service.py
    - tests/test_guest_cleanup_service.py
  modified: []

key-decisions:
  - "Mirror DELETE /api/games precedent: _purge_guest also deletes UserBenchmarkPercentile + UserRatingAnchor rows (Pitfall 2, resolved at plan time)"
  - "Tests cannot use the standard rollback-scoped db_session fixture for _purge_guest/cleanup_inactive_guests: db_session's AsyncSession is bound to an already-begun Connection (join_transaction_mode=conditional_savepoint), so its commit() only releases a SAVEPOINT invisible to _purge_guest's separately-opened connection. Added a real_session_maker test fixture (genuine, non-savepoint sessionmaker bound to test_engine, mirroring conftest.py's fresh_test_user pattern) for seeding + monkeypatched guest_cleanup_service.async_session_maker to it."

patterns-established:
  - "guest_cleanup_service.py: eligibility query (session param) / per-entity purge (opens own session) / orchestration loop (opens own session, calls purge) three-function decomposition, mirroring import_service.py's cleanup_orphaned_jobs/run_periodic_reaper split"

requirements-completed: []

coverage:
  - id: D1
    description: "get_eligible_guest_ids selects only is_guest=true guests with last_activity older than 30 days; excludes NULL-last_activity guests and registered users"
    verification:
      - kind: unit
        ref: "tests/test_guest_cleanup_service.py::TestEligibilityQuery::test_selects_only_31_day_inactive_guests"
        status: pass
    human_judgment: false
  - id: D2
    description: "_purge_guest deletes games + all 5 cascading children + import_jobs + derived-stats rows, resets both backfill-cursor mechanisms, keeps User/bookmarks/user_import_settings row"
    verification:
      - kind: integration
        ref: "tests/test_guest_cleanup_service.py::TestPurgeGuestEndToEnd::test_purge_deletes_all_and_resets_cursors_keeps_survivors"
        status: pass
    human_judgment: false
  - id: D3
    description: "cleanup_inactive_guests isolates per-guest failures (D-06) and emits one D-07 summary log line per tick"
    verification:
      - kind: unit
        ref: "tests/test_guest_cleanup_service.py::TestTransactionPerGuest::test_one_guest_failure_does_not_block_or_rollback_another"
        status: pass
      - kind: unit
        ref: "tests/test_guest_cleanup_service.py::TestCleanupSummaryLog::test_emits_one_summary_line_with_counts"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-07-24
status: complete
---

# Phase 187 Plan 01: Guest Purge Core Summary

**`guest_cleanup_service.py` with a 30-day eligibility query, a per-guest cascade purge reusing `delete_all_games_for_user`/`reset_backfill_cursors`, and a per-tick orchestration loop with isolated per-guest failure handling — all proven by a real-DB integration test.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 2 completed
- **Files modified:** 2 (both new)

## Accomplishments

- `get_eligible_guest_ids(session)` — selects `is_guest=true` users with `last_activity` older than 30 days, relying on PostgreSQL's NULL-comparison semantics to exclude never-active guests with no special-case guard.
- `_purge_guest(guest_id)` — one `async_session_maker()` session/commit per guest (D-06): deletes games + 5 cascading children via `game_repository.delete_all_games_for_user`, deletes `import_jobs` rows, deletes `UserBenchmarkPercentile`/`UserRatingAnchor` rows (Pitfall 2 precedent match), and resets both backfill-cursor mechanisms via `user_import_settings_repository.reset_backfill_cursors` (Pitfall 1 dual-reset fix) — mirroring the production `DELETE /api/games` handler body.
- `cleanup_inactive_guests()` — snapshots the eligible-guest id list in one session, then purges each guest in its own try/except so one bad guest cannot starve the rest of the tick's backlog (Pitfall 4), emitting one D-07 summary log line (scanned/purged/games_deleted/failed) and capturing exactly one Sentry event per tick if any guest failed.
- Confirmed the eligibility predicate is load-bearing (not decorative) by reverting it to select all guests and observing `TestEligibilityQuery` fail, then restoring it.

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end single-guest purge** - `c9db09fb` (feat)
2. **Task 2: Eligibility matrix + orchestration loop** - `f67b847d` (feat)
3. **Formatting follow-up** - `5ce629ca` (style, ruff format line-wrap on a test helper signature)

**Plan metadata:** committed as part of this summary's final commit (see `<final_commit>`).

## Files Created/Modified

- `app/services/guest_cleanup_service.py` - eligibility query, per-guest purge, per-tick orchestration loop; two named constants (`_GUEST_CLEANUP_INTERVAL_SECONDS`, `_GUEST_INACTIVITY_THRESHOLD`)
- `tests/test_guest_cleanup_service.py` - `TestPurgeGuestEndToEnd`, `TestEligibilityQuery`, `TestTransactionPerGuest`, `TestCleanupSummaryLog` (4 tests, all real-DB integration except the eligibility unit test)

## Decisions Made

- **Pitfall 2 (resolved at plan time, implemented here):** `_purge_guest` also deletes `UserBenchmarkPercentile`/`UserRatingAnchor` rows, matching the `DELETE /api/games` precedent exactly (both deletes are idempotent no-ops when the guest never had rows there).
- **Test infrastructure deviation (Rule 3 — blocking issue, discovered and fixed during execution):** `_purge_guest`/`cleanup_inactive_guests` open their own DB session via a module-level `from app.core.database import async_session_maker` binding, captured at `guest_cleanup_service`'s own import time (collection) — before conftest.py's `override_get_async_session` fixture ever patches `app.core.database.async_session_maker` (that patch only rebinds the attribute *on* `app.core.database`; Python's `from ... import ...` binds a snapshot, not a live attribute lookup, so it never propagates to a module that imported the name directly — confirmed empirically via a scratch repro: `import_service.async_session_maker`'s `current_database()` resolves to the real dev DB `"flawchess"`, not the isolated per-run test DB, exactly the same shape a naive `guest_cleanup_service` implementation would have hit). Separately, the standard rollback-scoped `db_session` fixture binds its `AsyncSession` to an *already-begun* `Connection`, which puts SQLAlchemy into `join_transaction_mode="conditional_savepoint"` — its `commit()` only releases a SAVEPOINT, invisible to any other physical connection (standard Postgres MVCC), so it cannot be used to seed data for a separately-opened `_purge_guest` session either.
  - **Fix:** Added a `real_session_maker` pytest fixture (a genuine, non-savepoint `async_sessionmaker` bound to `test_engine`, mirroring conftest.py's own `fresh_test_user` pattern) used both to seed test data with real, cross-connection-visible commits, and — via an autouse `monkeypatch.setattr(guest_cleanup_service, "async_session_maker", real_session_maker)` fixture — to route `guest_cleanup_service`'s own internal session opens to the isolated per-run test DB. This mirrors the established `patch("app.services.import_service.async_session_maker", mock_maker)` idiom already used throughout `tests/test_import_service.py`, just with a real (not mocked) sessionmaker.
  - **Why this matters beyond testability:** without this fix, the new integration tests would have given false confidence (asserting against a DB connection that saw no test data) or, worse, executed real `DELETE` statements against the actual development database via whatever integer `user_id` happened to be generated in the test run — a correctness and safety issue, not just a test-infra nicety.
  - **Scope:** contained entirely within `tests/test_guest_cleanup_service.py` (no `tests/conftest.py` change) to keep the deviation's footprint inside the plan's own declared `files_modified`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Test session-binding fix for `_purge_guest`/`cleanup_inactive_guests` integration tests**
- **Found during:** Task 1 (writing `TestPurgeGuestEndToEnd`)
- **Issue:** Both the plan's suggested `create_guest_user(db_session)` seeding pattern and a naive `_purge_guest` implementation using `from app.core.database import async_session_maker` would have resolved to the wrong database at test time (see Decisions Made above for the full mechanism) — the integration test initially failed with `deleted_count == 0` even though the seeded game genuinely existed, tracing to this root cause via a scratch repro.
- **Fix:** Added `real_session_maker` fixture + autouse `monkeypatch.setattr` patch, described above.
- **Files modified:** `tests/test_guest_cleanup_service.py`
- **Verification:** `TestPurgeGuestEndToEnd` passes with correct deletion counts and survivor assertions; verified via a direct scratch query that `current_database()` resolves to the per-run test DB, not the dev DB, before finalizing the fix.
- **Committed in:** `c9db09fb` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking — test infrastructure correctness/safety)
**Impact on plan:** Necessary for the integration test to actually verify what it claims to verify (and to avoid any risk of touching the real dev DB during test runs). No scope creep — contained to the plan's own test file.

## Issues Encountered

- Mid-session, an errant `git checkout -- app/services/guest_cleanup_service.py` (run while manually verifying the eligibility-predicate revert-and-fail acceptance criterion) reverted the file to the Task 1 commit, discarding the uncommitted Task 2 additions (`cleanup_inactive_guests` + `sentry_sdk` import). Re-applied the identical Task 2 edits from the prior in-context version, re-verified via `git diff` that the restored file exactly matched what had been written, and re-ran the full test suite before committing Task 2. No data or work was permanently lost.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `app/services/guest_cleanup_service.py` exposes `cleanup_inactive_guests` and the `_GUEST_CLEANUP_INTERVAL_SECONDS` constant, ready for Plan 02 to wrap in `run_periodic_guest_cleanup()` and wire into the FastAPI lifespan (mirroring `run_periodic_reaper`).
- No blockers. The eligibility query, cascade-no-orphans guarantee, dual cursor reset, and per-guest transaction isolation are all test-proven; Plan 02 only needs to add the periodic wrapper and lifespan task lifecycle.

---
*Phase: 187-guest-game-cleanup-30-day-inactivity-pruning-seed-116*
*Completed: 2026-07-24*

## Self-Check: PASSED
