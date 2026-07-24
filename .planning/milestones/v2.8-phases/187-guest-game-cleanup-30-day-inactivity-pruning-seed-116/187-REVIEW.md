---
phase: 187-guest-game-cleanup-30-day-inactivity-pruning-seed-116
reviewed: 2026-07-24T13:54:34Z
depth: standard
files_reviewed: 4
files_reviewed_list:
  - app/services/guest_cleanup_service.py
  - app/main.py
  - tests/test_guest_cleanup_service.py
  - tests/test_main_lifespan.py
findings:
  critical: 0
  warning: 3
  info: 1
  total: 4
status: resolved
resolution:
  WR-01: fixed — _purge_guest re-verifies the full eligibility predicate at delete time (+ load-bearing test test_reactivated_guest_is_skipped_not_purged)
  WR-02: accepted — mirrors the pre-existing DELETE /api/games layering precedent; follow-up (repository extraction) deferred, not a new regression
  WR-03: fixed — autouse _cleanup_leaked_guest_rows teardown deletes guest User rows created by real_session_maker tests (cascade cleans children)
  IN-01: accepted — untested shutdown-exception branch mirrors a pre-existing full_drain_task gap; not a new regression
---

# Phase 187: Code Review Report

**Reviewed:** 2026-07-24T13:54:34Z
**Depth:** standard
**Files Reviewed:** 4
**Status:** issues_found

## Summary

Reviewed the guest 30-day-inactivity cleanup feature: the eligibility query, per-guest purge, per-tick orchestration loop, the periodic `asyncio` wrapper, and the 4th lifespan background task wiring in `app/main.py`, plus both test files.

Core correctness is solid. I traced the eligibility predicate, confirmed via `\d`-equivalent model inspection that all 5 game-scoped child tables (`game_positions`, `game_flaws`, `game_best_moves`, `eval_jobs`, `bot_game_settings`) carry `ON DELETE CASCADE` from `games.id` — no orphan risk. `_purge_guest` is a faithful line-for-line mirror of the production-proven `DELETE /api/games` router handler (`app/routers/imports.py:455-479`), including the dual cursor reset (`import_jobs` row deletion **and** `reset_backfill_cursors()` on `user_import_settings`) that Pitfall 1 in `187-RESEARCH.md` specifically calls out — both calls are present (`guest_cleanup_service.py:78`, `:98`). `NULL last_activity` guests are correctly excluded by Postgres three-valued `<` semantics (and belt-and-suspenders `isnot(None)`), and the cutoff is computed timezone-aware in Python per project idiom. Transaction scope is genuinely per-guest (own `async_session_maker()` session per iteration), and a per-guest failure is isolated with `except Exception` inside the loop so it can't starve the rest of the tick — verified by a real test that forces guest 2 to fail and asserts guest 1's already-committed purge survives. `ruff`/`ty`/the new test files all pass cleanly (`uv run ty check`, `uv run ruff check`, `pytest tests/test_guest_cleanup_service.py tests/test_main_lifespan.py` — 8/8 pass).

Three Warnings and one Info below, none of them blocking: a documented-but-real TOCTOU window where a guest who is promoted/reactivated mid-tick can still be purged unconditionally; the raw `select()`/`delete()` statements living in the service layer rather than a repository (an existing project-wide pattern the phase mirrors rather than introduces); a latent test-pollution trap from the `real_session_maker` integration tests; and an untested shutdown-exception branch for the new task.

## Warnings

### WR-01: `_purge_guest` never re-checks `is_guest`/eligibility at delete time — TOCTOU window during a large first-tick backlog

**File:** `app/services/guest_cleanup_service.py:64-100` (also `:119-131`)
**Issue:** `cleanup_inactive_guests` snapshots the eligible-guest id list in one `SELECT`, then purges each guest sequentially in its own transaction. `_purge_guest(guest_id)` deletes unconditionally by `user_id` — it never re-verifies `is_guest = true` or re-checks `last_activity` immediately before deleting. `187-RESEARCH.md`'s own Security Domain section identified this exact race (a guest promoting to a full registered account, or simply logging back in, between the eligibility `SELECT` and their own turn in the loop) and reasoned the window was "only a few seconds/minutes" given the daily cadence. But that reasoning assumes a small, steady per-day backlog — the SAME research doc's Open Question 2 explicitly flags that the *first* tick after this feature deploys may process an **unbounded backlog** of guests that have been eligible since before the feature existed ("the FIRST tick may process an unknown-sized backlog of already-30-days-inactive guests... this could be a large one-time replay, not the steady daily trickle D-02 assumed"). If that backlog is large, a guest near the tail of `eligible_guest_ids` could sit unpurged for minutes-to-hours after being snapshotted, during which they could log back in (bumping `last_activity`) or even fully register — and still have their data unconditionally deleted on their eventual turn in the loop. This is a genuine, if narrow, path to deleting an active/registered user's data — squarely the failure mode `review_focus` #1 asks to rule out.
**Fix:** Re-verify eligibility in the same statement that deletes, e.g. scope the games/import-jobs delete to guests still matching the predicate, or cheaply re-check `is_guest` immediately before each guest's purge:
```python
async def _purge_guest(guest_id: int) -> int:
    async with async_session_maker() as session:
        # Defense-in-depth: guest may have logged in / promoted since the
        # eligibility snapshot, especially during a large first-tick backlog.
        still_guest = await session.scalar(
            select(User.is_guest).where(User.id == guest_id)
        )
        if not still_guest:
            return 0
        deleted_count = await game_repository.delete_all_games_for_user(session, guest_id)
        ...
```

### WR-02: Raw `select()`/`delete()` statements live in the service layer, not a repository

**File:** `app/services/guest_cleanup_service.py:54-61, 78, 84-87`
**Issue:** CLAUDE.md's layering rule is explicit: `routers/` → HTTP only, `services/` → business logic, `repositories/` → DB access, "no SQL in services." `get_eligible_guest_ids` issues a raw `select(User.id).where(...)` directly in the service, and `_purge_guest` issues three raw `delete()` statements (`ImportJob`, `UserBenchmarkPercentile`, `UserRatingAnchor`) directly in the service rather than through a repository function. A repository-layer home for user-scoped queries already exists (`app/repositories/user_repository.py`), so `get_eligible_guest_ids` could have lived there. Mitigating context: this exactly mirrors the pre-existing `DELETE /api/games` handler (`app/routers/imports.py:465-470`), which has the identical layering issue (raw `delete()` calls inline in a router, not a repository) — so this phase is consistent with, not a new regression from, established (if non-compliant) practice, and the code comments explicitly call out that it is "mirroring the DELETE /api/games precedent."
**Fix:** Not blocking given the precedent, but worth a follow-up: extract `get_eligible_guest_ids`'s query into `user_repository.py`, and add a small `delete_import_related_stats(session, user_id)` (or similar) helper to a repository that both `imports.py`'s router and `guest_cleanup_service.py` can call, closing the layering gap in both places at once rather than perpetuating it.

### WR-03: Test-pollution trap — leaked guest `User` rows persist for the rest of the worker's test session

**File:** `tests/test_guest_cleanup_service.py:68-116, 123-307`
**Issue:** `real_session_maker`-based tests (`TestPurgeGuestEndToEnd`, `TestTransactionPerGuest`, `TestCleanupSummaryLog`) commit for real (no rollback) against the per-run test DB, and the documented deviation in `187-01-SUMMARY.md` explicitly notes this. `_purge_guest` deletes a guest's games/children but — correctly, per D-05 — never deletes the guest `User` row itself. After each of these tests runs, a guest `User` row with `last_activity` set 30+ days in the past and `is_guest=True` remains in the physical per-run test DB (`flawchess_test_gwN`) for the rest of that xdist worker's entire test session, not just this file. Every subsequent call to `get_eligible_guest_ids`/`cleanup_inactive_guests` anywhere else in the same worker (including later tests in this same file) will re-select these leftover rows and re-run a (harmless, no-op) purge attempt against them. No test today asserts an exact count of `is_guest=true` users (confirmed via a repo-wide scan), so nothing currently breaks, but this is a real landmine for any future test that does — the failure would be order-dependent and only reproduce under xdist's specific worker assignment, making it hard to diagnose.
**Fix:** Have the `real_session_maker`-based tests also delete the guest `User` row in a fixture teardown (or `try/finally`), or track created guest ids in a module-level set purged by an autouse teardown fixture, so this file leaves the per-run DB exactly as it found it.

## Info

### IN-01: New shutdown-exception log branch for `guest_cleanup_task` has zero test coverage

**File:** `app/main.py:151-156`
**Issue:** `app/main.py`'s shutdown `finally` block now has four `try/except CancelledError / except Exception: logger.exception(...)` blocks — one per background task. `tests/test_main_lifespan.py::test_drain_task_exception_on_shutdown_is_logged` only exercises the `drain_task` branch ("Eval drain task raised on shutdown"); no test forces `guest_cleanup_task` (or `full_drain_task`, a pre-existing gap) to raise a non-`CancelledError` on shutdown and asserts "Guest cleanup task raised on shutdown" is logged. This mirrors a gap that already existed for `full_drain_task` before this phase, so it isn't a new regression, but the phase had a clean opportunity to add equivalent coverage for the new branch it introduced and didn't.
**Fix:** Add a `_failing_guest_cleanup` stub analogous to `_failing_drain` in `test_drain_task_exception_on_shutdown_is_logged` (or a new parametrized variant covering all four tasks) to close this gap.

---

_Reviewed: 2026-07-24T13:54:34Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
