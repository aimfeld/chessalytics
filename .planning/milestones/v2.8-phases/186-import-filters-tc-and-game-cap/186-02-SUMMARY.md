---
phase: 186-import-filters-tc-and-game-cap
plan: 02
subsystem: import
tags: [fastapi, sqlalchemy, httpx, lichess-api, chesscom-api, import-pipeline, backfill]

# Dependency graph
requires:
  - phase: 186-01
    provides: "user_import_settings table (TC toggles + game_cap + reserved backfill-cursor columns), user_import_settings_repository, count_backlog_by_platform_and_tc, forward-sync TC filter"
provides:
  - "lichess_client.fetch_lichess_games(until_ms=...) backward-fetch support (additive, newest-first)"
  - "chesscom_client.fetch_chesscom_games_backward -- newest->oldest monthly-archive walk with should_stop/on_month_attempted"
  - "import_service two-pass run_import (forward pass then capped backward pass, one job/one progress bar, D-05)"
  - "user_repository.get_created_at -- backlog anchor fetch inside the bootstrap session scope"
  - "user_import_settings_repository backfill-cursor read/update/reset functions (chess.com year/month, lichess until-ms)"
  - "delete_all_games resets backfill cursors while preserving TC/cap preferences"
affects: [186-03]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "in-memory live_counts dict seeded from one backlog query, mutated as games are TC-filtered -- avoids a DB round trip per should_stop() check while staying a plain synchronous closure"
    - "async on_month_attempted callback (chesscom_client) -- Task 1's Callable[[tuple[int,int]], None] signature widened to Awaitable[None] since the callback's only real caller persists the cursor via an awaited DB write"
    - "autouse pytest fixture defaulting get_or_create_settings to all-TC-disabled so the new backward pass is a true no-op for tests that only exercise forward-pass/job-lifecycle machinery, overridable per-test via mock.patch nesting"

key-files:
  created: []
  modified:
    - app/services/lichess_client.py
    - app/services/chesscom_client.py
    - app/services/import_service.py
    - app/repositories/user_repository.py
    - app/repositories/user_import_settings_repository.py
    - app/routers/imports.py
    - tests/test_lichess_client.py
    - tests/test_chesscom_client.py
    - tests/test_import_service.py
    - tests/test_imports_router.py

key-decisions:
  - "on_month_attempted is async (Callable[[tuple[int,int]], Awaitable[None]]), not the plan's illustrative sync Callable[..., None] -- the only real implementation persists the cursor via an awaited DB write, so a sync signature would be uncallable from the actual caller. De-risked: verified against real usage, not just Task 1's Pattern 3 sketch."
  - "should_stop stays a plain synchronous closure (Callable[[], bool]) backed by an in-memory live_counts dict seeded from ONE count_backlog_by_platform_and_tc query at pass start, incremented as games pass the TC filter -- avoids a DB round trip on every should_stop() check (which chess.com calls before every month and lichess calls before every chunk) without changing the stop semantics."
  - "chess.com's should_stop() is checked BEFORE the player-joined probe too (not just before each month), so a Sync whose budgets are already full performs zero HTTP requests -- not locked by the plan, added because it was free given the should_stop-first structure and testably cheap."
  - "user_repository.get_created_at uses AsyncSession.get() (a distinct mock/production method from .execute()) rather than a SELECT -- deliberate choice to keep the bootstrap-scope created_at fetch trivially mockable independent of the settings-load SELECT that shares the same session."
  - "Test-only: an autouse fixture in test_import_service.py defaults get_or_create_settings to all-TC-disabled so the new backward pass is a no-op for the ~16 pre-existing forward-pass/job-lifecycle tests that never intended to exercise it; tests that DO need TC filtering or the backward pass override it locally via their own with patch(...) block, which correctly nests on top of the fixture's patch."

requirements-completed: [IMPORT-03]

coverage:
  - id: D1
    description: "lichess client fetches a backward (older) chunk when given until_ms, streaming newest-first (API default sort=dateDesc) so the oldest game in a bounded chunk arrives last"
    requirement: "IMPORT-03"
    verification:
      - kind: unit
        ref: "tests/test_lichess_client.py::TestFetchLichessGames::test_backward_until_ms_passed_in_params"
        status: pass
      - kind: unit
        ref: "tests/test_lichess_client.py::TestFetchLichessGames::test_backward_games_streamed_newest_first_oldest_last"
        status: pass
    human_judgment: false
  - id: D2
    description: "chess.com client walks monthly archives newest->oldest, checking should_stop() before every month (including the very first -- zero HTTP calls when budgets are already full), and fires on_month_attempted for every attempted month regardless of match count (Pitfall 1)"
    requirement: "IMPORT-03"
    verification:
      - kind: unit
        ref: "tests/test_chesscom_client.py::TestFetchChesscomGamesBackward::test_backward_visits_archives_newest_to_oldest"
        status: pass
      - kind: unit
        ref: "tests/test_chesscom_client.py::TestFetchChesscomGamesBackward::test_backward_on_month_attempted_fires_for_zero_match_month"
        status: pass
      - kind: unit
        ref: "tests/test_chesscom_client.py::TestFetchChesscomGamesBackward::test_backward_should_stop_true_immediately_performs_zero_requests"
        status: pass
      - kind: unit
        ref: "tests/test_chesscom_client.py::TestFetchChesscomGamesBackward::test_backward_resumes_just_before_oldest_attempted_ym"
        status: pass
    human_judgment: false
  - id: D3
    description: "One Sync job runs a forward pass (post-anchor, uncapped, TC-filtered) then a backward pass (pre-anchor, capped) within one job -- forward strictly before backward"
    requirement: "IMPORT-03"
    verification:
      - kind: integration
        ref: "tests/test_import_service.py::TestBackwardPass::test_two_pass_forward_runs_before_backward_with_resumable_cursor"
        status: pass
    human_judgment: false
  - id: D4
    description: "A brand-new user's first Sync never fetches unbounded history -- forward pass is bounded below by users.created_at and the backward pass is budget-capped, ending at exactly game_cap for the single selected TC rather than the full mocked history"
    requirement: "IMPORT-03"
    verification:
      - kind: integration
        ref: "tests/test_import_service.py::TestBackwardPass::test_first_sync_backlog_bounded_not_full_history"
        status: pass
    human_judgment: false
  - id: D5
    description: "The backward walk persists a per-platform oldest-attempted cursor after every fetch attempt; a mid-walk should_stop() halt leaves the cursor at only the attempted month/chunk, resumable by the next Sync"
    requirement: "IMPORT-03"
    verification:
      - kind: integration
        ref: "tests/test_import_service.py::TestBackwardPass::test_two_pass_forward_runs_before_backward_with_resumable_cursor"
        status: pass
    human_judgment: false
  - id: D6
    description: "The backward walk stops only when ALL selected TC budgets are full, not after the first one fills"
    requirement: "IMPORT-03"
    verification:
      - kind: integration
        ref: "tests/test_import_service.py::TestBackwardPass::test_budget_stops_only_when_all_selected_tc_full"
        status: pass
    human_judgment: false
  - id: D7
    description: "A deselected TC bucket never accrues backlog even when interleaved with selected-TC games in the platform source"
    requirement: "IMPORT-03"
    verification:
      - kind: integration
        ref: "tests/test_import_service.py::TestBackwardPass::test_budget_deselected_tc_never_accrues_backlog"
        status: pass
    human_judgment: false
  - id: D8
    description: "Settings (TC filter + game_cap) are read once at job start (D-04) -- a settings PATCH issued while a job is active does not alter that job's filter/cap"
    requirement: "IMPORT-03"
    verification:
      - kind: integration
        ref: "tests/test_import_service.py::TestBackwardPass::test_mid_run_settings_patch_does_not_affect_active_job"
        status: pass
    human_judgment: false
  - id: D9
    description: "Deleting all games resets the per-platform backfill cursors to NULL while preserving the user's TC toggles and game_cap"
    requirement: "IMPORT-03"
    verification:
      - kind: integration
        ref: "tests/test_imports_router.py::TestDeleteAllGamesCursorReset::test_delete_and_cursor_reset_preserves_tc_and_cap"
        status: pass
      - kind: integration
        ref: "tests/test_imports_router.py::TestDeleteAllGamesCursorReset::test_delete_and_cursor_reset_returns_deleted_game_count"
        status: pass
    human_judgment: false

# Metrics
duration: 40min
completed: 2026-07-24
status: complete
---

# Phase 186 Plan 02: Backward-Fetch Backfill Summary

**Two-pass Sync (forward + budget-capped backward backfill) across both platform clients, with an in-memory live-budget stop condition and an incrementally-persisted resumable cursor.**

## Performance

- **Duration:** 40 min
- **Started:** 2026-07-24T06:56Z
- **Completed:** 2026-07-24T07:36Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments
- `lichess_client.fetch_lichess_games` gained an additive `until_ms` parameter -- no change to the existing streaming/retry loop, since lichess's `sort=dateDesc` default already yields newest-first.
- `chesscom_client.fetch_chesscom_games_backward` (new): walks monthly archives newest→oldest, resuming just before a persisted `(year, month)` cursor (or the current month on first run), checking `should_stop()` before every month -- including the very first, so a fully-budgeted Sync makes zero HTTP requests.
- `import_service.run_import` restructured into two passes within one job (D-05): a FORWARD pass (unchanged mechanism, now bounded below by `users.created_at` so `since=None` never reaches a platform client -- closing the first-sync unbounded-fetch regression) followed by a BACKWARD pass that stops only once every selected TC's live count reaches `game_cap` (D-07).
- Backward-walk cursor persistence: `user_import_settings_repository` gained chess.com `(year, month)` and lichess `until_ms` cursor read/update functions, written incrementally after every attempted month/chunk (Pitfall 1) -- a period that yields zero matching games still advances the cursor.
- `delete_all_games` now resets the three backfill-cursor columns to NULL (Pitfall 4) while leaving TC toggles and `game_cap` untouched, so a post-delete resync backfills the fresh account's full budget instead of resuming from a stale boundary.
- Settings (TC filter + cap) are loaded exactly once per job at bootstrap (D-04) -- a concurrent PATCH never leaks into an active job's forward or backward pass.

## Task Commits

Each task was committed atomically:

1. **Task 1: Backward-fetch client functions** - `e2b56959` (feat)
2. **Task 2: Two-pass Sync orchestration + cursor persistence** - `868526fa` (feat)
3. **Task 3: delete_all_games resets backfill cursors** - `cb08f52a` (feat)

**Plan metadata:** commit pending (this SUMMARY + STATE/ROADMAP update)

## Files Created/Modified
- `app/services/lichess_client.py` -- `until_ms` param on `fetch_lichess_games` (additive).
- `app/services/chesscom_client.py` -- `fetch_chesscom_games_backward`, `_month_before`, `_parse_archive_year_month`; `on_month_attempted` widened to an async callback.
- `app/services/import_service.py` -- two-pass `run_import`; `_bootstrap_import_job` now also fetches `users.created_at`; new `_run_forward_pass`/`_run_backward_pass`/`_run_chesscom_backward_pass`/`_run_lichess_backward_pass`/`_lichess_backward_perf_type`/`_record_backward_game` helpers; `_load_enabled_tc_buckets` renamed `_load_import_settings` (now returns the full settings row, not just the derived bucket set).
- `app/repositories/user_repository.py` -- `get_created_at` (PK lookup via `session.get`).
- `app/repositories/user_import_settings_repository.py` -- `get_chesscom_backfill_cursor`/`update_chesscom_backfill_cursor`/`get_lichess_backfill_cursor`/`update_lichess_backfill_cursor`/`reset_backfill_cursors`.
- `app/routers/imports.py` -- `delete_all_games` calls `reset_backfill_cursors`.
- `tests/test_lichess_client.py` -- 3 backward-fetch tests.
- `tests/test_chesscom_client.py` -- 5 backward-walk tests + `_make_async_recorder` helper.
- `tests/test_import_service.py` -- autouse no-op-backward-pass fixture, `session.get` stubs across all session-mock helpers, `TestRunImportTcFilter` updated for the new backward pass, new `TestBackwardPass` class (5 tests: first_sync, budget×2, two_pass, mid_run_settings).
- `tests/test_imports_router.py` -- `TestDeleteAllGamesCursorReset` (2 tests).

## Decisions Made
- `on_month_attempted`'s type signature is async (`Callable[[tuple[int,int]], Awaitable[None]]`), diverging from the plan's illustrative sync `Callable[..., None]` sketch in Pattern 3 -- the only real caller persists the cursor via an awaited DB write, so a sync callback would be uncallable. Verified this is necessary (not speculative) by writing the real implementation first, then fixing the signature to match.
- `should_stop` stays a plain synchronous closure over an in-memory `live_counts` dict, seeded from one `count_backlog_by_platform_and_tc` query at the start of each backward pass and incremented as games pass the TC filter. This avoids a DB round trip on every `should_stop()` check (called before every chess.com month and every lichess chunk) while keeping the stop semantics exactly D-07 ("ALL selected budgets full").
- chess.com's `should_stop()` is checked before the player-joined probe too, not just before each archive month -- a Sync whose budgets are already full performs zero HTTP requests. Not explicitly required by the plan; added because the should_stop-first structure made it free and it's directly testable (`test_backward_should_stop_true_immediately_performs_zero_requests`).
- `user_repository.get_created_at` uses `AsyncSession.get()` rather than a `select(User)...` SELECT -- a distinct session method from `.execute()`, chosen so the bootstrap-scope created_at fetch is independently mockable from the settings-load SELECT sharing the same session (both real production benefit -- one fewer query construction -- and a pragmatic test-isolation win).
- Test-only: added an autouse pytest fixture in `test_import_service.py` that defaults `get_or_create_settings` to all-TC-disabled, making the new backward pass a genuine no-op (zero session opens, zero client calls) for the ~16 pre-existing tests that only exercise forward-pass/job-lifecycle machinery and never intended to exercise the backward pass. Tests that need TC filtering or the backward pass explicitly override this locally via their own `with patch(...)` block, which correctly composes with `mock.patch`'s nesting semantics (the inner patch's teardown restores to the fixture's patch, not the true unpatched function).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Widened `on_month_attempted` to an async callback**
- **Found during:** Task 2 (wiring the chess.com cursor-persistence callback)
- **Issue:** Task 1's plan text sketched `on_month_attempted: Callable[[tuple[int, int]], None] | None` (sync). The only real caller (`import_service._run_chesscom_backward_pass`) needs to persist the cursor via `async_session_maker()` + an awaited UPDATE + commit -- a sync callback signature cannot express this, and `ty check` caught the mismatch immediately (`CoroutineType[Any, Any, None]` not assignable to `None`).
- **Fix:** Changed the parameter type to `Callable[[tuple[int, int]], Awaitable[None]] | None` and `await`ed the call inside `fetch_chesscom_games_backward`. Updated the 3 Task-1 tests that pass `on_month_attempted=visited_months.append` (a sync `list.append`) to use a small `_make_async_recorder` wrapper instead.
- **Files modified:** `app/services/chesscom_client.py`, `tests/test_chesscom_client.py`
- **Verification:** `uv run ty check app/services/chesscom_client.py` clean; all 5 `TestFetchChesscomGamesBackward` tests pass.
- **Committed in:** `868526fa` (Task 2 commit)

**2. [Rule 1 - Bug] `count_backlog_by_platform_and_tc`'s return dict-key typing required a cast**
- **Found during:** Task 2 (`ty check`)
- **Issue:** `game_repository.count_backlog_by_platform_and_tc` returns `dict[str, dict[str, int]]` (Plan 01's existing signature, not `TimeControlBucket`-Literal-typed), but the new `live_counts: dict[TimeControlBucket, int]` in `_run_backward_pass` assigned from it directly, which `ty` correctly flagged as an incompatible value type.
- **Fix:** Added an explicit `cast("dict[TimeControlBucket, int]", ...)` at the assignment site with a comment explaining the DB column isn't Literal-typed but the values are always valid TC buckets (D-15's None-bucket rows are already excluded by that query).
- **Files modified:** `app/services/import_service.py`
- **Verification:** `uv run ty check app/services/import_service.py` clean.
- **Committed in:** `868526fa` (Task 2 commit)

**3. [Rule 1 - Bug] Existing `TestRunImportTcFilter` test needed an explicit backward-pass no-op mock**
- **Found during:** Task 2 (full `test_import_service.py` regression run)
- **Issue:** This pre-existing forward-pass-filter integration test explicitly mocks `get_or_create_settings` with `tc_blitz=True, tc_rapid=True, tc_classical=True` (non-empty enabled set) and `game_cap=1000`. With the new two-pass `run_import`, this now legitimately triggers the backward pass, which called the REAL (unmocked) `chesscom_client.fetch_chesscom_games_backward` and crashed comparing a mock-derived cursor tuple against an int (`TypeError: '>' not supported between instances of 'int' and 'MagicMock'`).
- **Fix:** Added `patch("app.services.import_service.chesscom_client.fetch_chesscom_games_backward", side_effect=_empty_async_gen)` to this test's `with` block -- it's a forward-pass-filter test, so the backward pass is legitimately out of scope for it.
- **Files modified:** `tests/test_import_service.py`
- **Verification:** `TestRunImportTcFilter::test_forward_sync_drops_deselected_tc_keeps_none_and_classical` passes; assertion unchanged.
- **Committed in:** `868526fa` (Task 2 commit)

**4. [Rule 1 - Bug] Session-mock helpers needed a `session.get()` stub for the new bootstrap-scope `created_at` fetch**
- **Found during:** Task 2 (full `test_import_service.py` regression run)
- **Issue:** `_bootstrap_import_job` now calls `user_repository.get_created_at`, which uses `AsyncSession.get(User, user_id)` -- a distinct mock attribute from `session.execute`. An unconfigured `AsyncMock().get(...)` auto-chains to more `AsyncMock`/coroutine objects rather than a real datetime, which would crash any downstream `.timestamp()` arithmetic (confirmed via a standalone Python repro before writing the fix).
- **Fix:** Added `session.get = AsyncMock(return_value=SimpleNamespace(created_at=_TEST_USER_CREATED_AT))` to `_make_mock_session()`, `_make_simple_session_maker`'s factory, and `_make_counting_session_maker`'s `_TrackedSession` class -- the three session-mock builders reachable from any `run_import`-calling test.
- **Files modified:** `tests/test_import_service.py`
- **Verification:** All 78 tests in `test_import_service.py` pass, including the three `TestRunImportSessionPerBatch` session-count/ordering tests (unchanged formula -- the new `created_at` fetch reuses the existing bootstrap scope, adding no new `async_session_maker()` call).
- **Committed in:** `868526fa` (Task 2 commit)

---

**Total deviations:** 4 auto-fixed (1 blocking type-signature fix, 1 blocking type-cast fix, 2 bug/test-expectation-drift fixes)
**Impact on plan:** All four were necessary consequences of the two-pass restructure interacting with `ty check` and the existing test suite's mocking conventions. No scope creep -- no functionality beyond Tasks 1-3's stated scope was added.

## Issues Encountered
None beyond the deviations documented above. The trickiest part of this plan was NOT the production code (which follows the plan's architecture closely) but making the ~16 pre-existing `run_import`-calling tests in `test_import_service.py` continue to pass unmodified against a genuinely new code path (the backward pass) that they never anticipated -- solved with an autouse fixture rather than touching each test individually.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 03 (frontend chips) can consume `GET /users/me/import-settings`'s existing `backlog_counts` (from Plan 01) directly -- Plan 02 added no new API surface, only internal Sync-job machinery. No further backend work needed for the count side of the UI.
- The backward-fetch backfill is fully wired end-to-end: raising a user's cap or enabling a new TC via the Plan 01 settings endpoints will, on the next Sync click, actually backfill older history up to the new budget.
- No blockers. Full backend suite (3604 passed, 18 skipped) green after this plan's changes; `ty check app/ tests/` and `ruff format/check` clean.

## Self-Check: PASSED

All 10 modified files confirmed present on disk; all three task commit hashes
(`e2b56959`, `868526fa`, `cb08f52a`) confirmed present in git history.

---
*Phase: 186-import-filters-tc-and-game-cap*
*Completed: 2026-07-24*
