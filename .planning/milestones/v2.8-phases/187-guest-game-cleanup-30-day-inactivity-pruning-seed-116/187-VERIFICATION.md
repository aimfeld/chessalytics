---
phase: 187-guest-game-cleanup-30-day-inactivity-pruning-seed-116
verified: 2026-07-24T17:05:00Z
status: human_needed
score: 11/11 truths verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 10/11
  gaps_closed:
    - "Guest-cleanup task shutdown-exception logging (Truth #10 / IN-01): tests/test_main_lifespan.py::TestLifespanBackgroundTasks::test_guest_cleanup_task_exception_on_shutdown_is_logged now exercises the non-CancelledError shutdown branch directly, patching app.main.run_periodic_guest_cleanup to raise RuntimeError and asserting logger.exception('Guest cleanup task raised on shutdown') fires without propagating. Ran this test directly: PASS."
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "D-06 backstop: run a single-guest purge against a guest holding a very large game_positions cascade (GM-Hikaru-scale, ~5M rows) on a prod-like DB and observe WAL growth / lock duration against concurrent API traffic."
    expected: "The single-transaction-per-guest cascade delete (D-06, accepted risk) does not spike WAL or hold locks long enough to visibly degrade concurrent API latency; if it does, chunked/batched deletion is the documented fallback."
    why_human: "Cannot be reproduced or measured from the codebase/test DB — this is a backstop must_have explicitly declared non-inferable in 187-01-PLAN.md frontmatter (verification: backstop) requiring a real prod-scale dataset and live traffic to observe. A backstop item abstains by design and can never be closed from the codebase — this is its correct terminal state."
---

# Phase 187: Guest Game Cleanup — 30-Day Inactivity Pruning Verification Report

**Phase Goal:** Implement the already-advertised-but-never-built 30-day-inactivity guest cleanup (SEED-116): a periodic in-process asyncio task that, for guest users (`is_guest=true`) inactive >=30 days (`last_activity`), deletes their games + all cascading game-scoped children and resets BOTH import-cursor mechanisms (import_jobs row + Phase-186 user_import_settings backfill cursors), while KEEPING the guest User row + auth + bookmarks + import settings intact so a returning guest can re-import.

**Verified:** 2026-07-24T17:05:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (IN-01 / Truth #10)

**Note on contract source:** This phase has no `### Phase 187` ROADMAP goal block and no mapped REQ-IDs (confirmed: `grep -E "Phase 187" .planning/REQUIREMENTS.md` returns nothing, and ROADMAP.md has no phase-187 section). Per the task instructions, this is expected — the must-haves contract is 187-CONTEXT.md's D-01..D-07 plus the `must_haves` frontmatter blocks in 187-01-PLAN.md and 187-02-PLAN.md, which is what this report verifies against. Neither omission is reported as a gap.

## What Changed Since Previous Verification

1. **IN-01 / Truth #10 closed.** `tests/test_main_lifespan.py::TestLifespanBackgroundTasks::test_guest_cleanup_task_exception_on_shutdown_is_logged` was added (lines 205-271). It patches `app.main.run_periodic_guest_cleanup` with a stub that raises `RuntimeError` on receiving `CancelledError` (simulating a non-CancelledError shutdown failure), drives `app.router.lifespan_context(app)` through a full enter/exit cycle, and asserts `logger.exception("Guest cleanup task raised on shutdown")` fires (captured directly via a `monkeypatch.setattr(main_module.logger, "exception", ...)` wrapper) and that the exception does not propagate out of the lifespan context manager. **Ran this test directly (not trusting narration):** `uv run pytest "tests/test_main_lifespan.py::TestLifespanBackgroundTasks::test_guest_cleanup_task_exception_on_shutdown_is_logged" -q` → PASS. Full file: `uv run pytest tests/test_main_lifespan.py -q` → `3 passed in 4.79s`. Truth #10 re-scored VERIFIED.
2. **WR-01 regression re-confirmed.** `tests/test_guest_cleanup_service.py::TestPurgeGuestEndToEnd::test_reactivated_guest_is_skipped_not_purged` still passes. **Ran directly:** `uv run pytest "tests/test_guest_cleanup_service.py::TestPurgeGuestEndToEnd::test_reactivated_guest_is_skipped_not_purged" -q` → `1 passed in 4.27s`.
3. Combined run: `uv run pytest tests/test_guest_cleanup_service.py tests/test_main_lifespan.py -q` → `10 passed in 6.42s` (was 9 passed at previous verification — the new test accounts for the +1).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `get_eligible_guest_ids` selects only `is_guest=true AND last_activity < now()-30d` (D-03) | VERIFIED | `app/services/guest_cleanup_service.py:44-61`; `tests/test_guest_cleanup_service.py::TestEligibilityQuery::test_selects_only_31_day_inactive_guests` — asserts 31d guest selected. |
| 2 | NULL `last_activity` guest never selected (Pitfall 3) | VERIFIED | Same query relies on SQL 3-valued-logic (`isnot(None)` documented, not load-bearing) + same test asserts `null_activity_guest.id not in eligible_ids`. |
| 3 | Registered user (`is_guest=false`) with old `last_activity` never selected (V4 boundary) | VERIFIED | `User.is_guest.is_(True)` predicate; same test asserts `registered.id not in eligible_ids`. |
| 4 | Purge deletes games + all 5 cascading children with ZERO orphans (D-03) | VERIFIED | All 5 child models confirmed `ON DELETE CASCADE` from `games.id` (`game_position.py:63`, `game_flaw.py:36`, `game_best_move.py:36`, `eval_jobs.py:82`, `bot_game_settings.py:29`). `game_repository.delete_all_games_for_user` deletes `GamePosition` then `Game` (lines 249-263). `TestPurgeGuestEndToEnd::test_purge_deletes_all_and_resets_cursors_keeps_survivors` seeds one row in each of the 5 child tables + asserts `count()==0` post-purge for all. |
| 5 | BOTH cursor mechanisms reset: `import_jobs` row deleted AND `reset_backfill_cursors` NULLs the 3 backfill columns (Pitfall 1/D-04) | VERIFIED | `_purge_guest` (`guest_cleanup_service.py:96-117`) calls `delete(ImportJob)...` then `user_import_settings_repository.reset_backfill_cursors(session, user_id=guest_id)`. Same integration test asserts `ImportJob` count==0 and the 3 backfill columns are `None` while `tc_*`/`game_cap` are unchanged. |
| 6 | Guest User row + auth + `position_bookmark` + `user_import_settings` preference row SURVIVE (D-05) | VERIFIED | No `delete(User)`/`session.delete(user...)` anywhere in `guest_cleanup_service.py` (grep confirms zero matches). Same test asserts `user_row.is_guest is True`, `PositionBookmark` count==1, and the `UserImportSettings` row still exists with `tc_bullet/tc_blitz/tc_rapid/tc_classical` and `game_cap` unchanged. |
| 7 | Each guest purged in its own `async_session_maker()` session/commit — one transaction per guest, no batching (D-06) | VERIFIED | `_purge_guest` opens `async with async_session_maker() as session:` per call (line 76); `cleanup_inactive_guests` iterates ids calling `_purge_guest` per-guest in a loop. `TestTransactionPerGuest::test_one_guest_failure_does_not_block_or_rollback_another` forces guest 2 to fail and asserts guest 1's purge is independently committed. |
| — (backstop) | A single ~5M-row `game_positions` cascade in one transaction does not spike prod WAL/locks (D-06 accepted risk) | ABSTAINED (backstop) | Declared `verification: backstop` in 187-01-PLAN.md frontmatter — non-inferable from codebase/test DB. Routed to human verification below; not counted in the truths score. |
| 8 | `run_periodic_guest_cleanup` sleeps `_GUEST_CLEANUP_INTERVAL_SECONDS` before its first tick, then calls `cleanup_inactive_guests` each tick (D-01/D-02) | VERIFIED | `guest_cleanup_service.py:198-205`: `while True: await asyncio.sleep(...); try: await cleanup_inactive_guests() ...`. `TestRunPeriodicGuestCleanup::test_calls_cleanup_once_per_iteration` drives 2 iterations via a mocked sleep and asserts the spy was called >=2 times. |
| 9 | A `cleanup_inactive_guests` exception is caught per-tick, logged, Sentry-captured with `set_tag('source','guest_cleanup')`, loop continues (D-07) | VERIFIED | `except Exception: logger.exception(...); sentry_sdk.set_tag("source", "guest_cleanup"); sentry_sdk.capture_exception()` (lines 202-205). `test_survives_cleanup_exception` forces a raise on iteration 1, asserts the loop continues to iteration 2+ and `capture_exception` was called. |
| 10 | Guest-cleanup task spawned via `asyncio.create_task` on startup, cancelled+awaited on shutdown, CancelledError swallowed, other shutdown exceptions logged "exactly like the existing 3 tasks" (D-01) | ✓ VERIFIED (re-scored) | Spawn (`app/main.py:119`) and cancel+await (`:131`, `:151-156`) confirmed present. `test_both_background_tasks_spawned` covers the CancelledError-swallowed path (spawn + clean shutdown). **New:** `test_guest_cleanup_task_exception_on_shutdown_is_logged` (`test_main_lifespan.py:205-271`) directly exercises the non-CancelledError shutdown branch for `guest_cleanup_task` specifically — patches `app.main.run_periodic_guest_cleanup` to raise `RuntimeError` on cancellation, drives the lifespan through enter/exit, and asserts `logger.exception("Guest cleanup task raised on shutdown")` fires without propagating. **Ran directly, not from narration:** PASS. This closes the previously-flagged IN-01 gap — the invariant now has its own behavioral proof, not just structural analogy to the sibling `drain_task` branch. |
| 11 | `tests/test_main_lifespan.py` `EXPECTED_TASKS` corrected to include `"full-eval-drain"` AND `"guest-cleanup"`, with a stub/assert for the new task | VERIFIED | `EXPECTED_TASKS = ("periodic-orphan-reaper", "eval-drain", "full-eval-drain", "guest-cleanup")` (`test_main_lifespan.py:23-28`); `_stub_guest_cleanup` + `guest_cleanup_called` assertion added to `test_both_background_tasks_spawned`. |

**Score:** 11/11 truths verified (0 present, behavior-unverified; 1 backstop item abstained separately)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `app/services/guest_cleanup_service.py` | eligibility query, `_purge_guest`, `cleanup_inactive_guests`, `run_periodic_guest_cleanup`, 2 named constants | ✓ VERIFIED | 206 lines, all 4 functions present with explicit return types, no stubs/TODOs. |
| `app/main.py` | 4th background task wired into lifespan (import, create_task, cancel, await-with-log) | ✓ VERIFIED | Import at line 32, `create_task(..., name="guest-cleanup")` at line 119, `.cancel()` at line 131, cancel+await-with-log block at lines 151-156 — placed identically to the 3 existing tasks. |
| `tests/test_guest_cleanup_service.py` | Integration + unit tests covering eligibility, purge, transaction isolation, summary log, periodic loop | ✓ VERIFIED | 9 tests across 5 test classes, all pass. |
| `tests/test_main_lifespan.py` | Corrected `EXPECTED_TASKS`, extended spawn assertion, dedicated shutdown-exception test for guest-cleanup task | ✓ VERIFIED | 272 lines, `EXPECTED_TASKS` widened to `tuple[str, ...]` with all 4 tasks; 3 lifespan tests, all pass (was 2 at previous verification — `test_guest_cleanup_task_exception_on_shutdown_is_logged` added). |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `app/main.py` lifespan | `run_periodic_guest_cleanup` | `asyncio.create_task(run_periodic_guest_cleanup(), name="guest-cleanup")` | WIRED | Confirmed present at `app/main.py:119`, verified live via `test_both_background_tasks_spawned`. |
| `run_periodic_guest_cleanup` | `cleanup_inactive_guests` | direct `await` call inside the tick's `try` block | WIRED | `guest_cleanup_service.py:201`; unit-tested via mocked sleep + spy. |
| `_purge_guest` | `game_repository.delete_all_games_for_user` | direct call, same session | WIRED | `guest_cleanup_service.py:96`; reuses the exact function `DELETE /api/games` already calls in prod. |
| `_purge_guest` | `user_import_settings_repository.reset_backfill_cursors` | direct call, `user_id=` keyword, same session, same commit | WIRED | `guest_cleanup_service.py:117`; confirmed implementation only NULLs the 3 progress-cursor columns, leaving `tc_*`/`game_cap` untouched. |
| `LastActivityMiddleware` | `users.last_activity` | `sa_update(User).where(User.id == user_id).values(last_activity=now)` on any authenticated (bearer-token) request, no `is_guest` exclusion | WIRED | Confirms SEED gotcha #1 end-to-end: guest browsing bumps `last_activity`, feeding the eligibility query's inactivity signal (`app/middleware/last_activity.py:98-101`). |
| `app/main.py` lifespan shutdown | `guest_cleanup_task` non-CancelledError handling | `try/except Exception: logger.exception("Guest cleanup task raised on shutdown")` block awaiting the cancelled task | WIRED | `app/main.py:151-156`; **now behaviorally proven** by `test_guest_cleanup_task_exception_on_shutdown_is_logged`, not just structural analogy to the drain-task branch. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Guest-cleanup + lifespan test suite passes for real (not just SUMMARY narration) | `uv run pytest tests/test_guest_cleanup_service.py tests/test_main_lifespan.py -q` | `10 passed in 6.42s` | ✓ PASS |
| The specific new IN-01-closing test passes in isolation | `uv run pytest "tests/test_main_lifespan.py::TestLifespanBackgroundTasks::test_guest_cleanup_task_exception_on_shutdown_is_logged" -q` | `1 passed` | ✓ PASS |
| The WR-01 regression test (reactivated guest skipped) still passes | `uv run pytest "tests/test_guest_cleanup_service.py::TestPurgeGuestEndToEnd::test_reactivated_guest_is_skipped_not_purged" -q` | `1 passed in 4.27s` | ✓ PASS |
| All 5 game-scoped child FKs are `ON DELETE CASCADE` from `games.id` | `grep -n "ondelete" app/models/{game_position,game_flaw,game_best_move,eval_jobs,bot_game_settings}.py` | All 5 confirmed `ondelete="CASCADE"` | ✓ PASS |
| Guest User row is never deleted anywhere in the cleanup service | `grep -n "delete(User)\|session.delete(user" app/services/guest_cleanup_service.py` | No matches | ✓ PASS |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | `grep -n -E "TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER"` across all 4 phase files | — | None found — clean. |

No blockers. No unresolved debt markers in any file touched by this phase.

### Code Review Cross-Check

`187-REVIEW.md` (standard depth, 4 files, 0 critical / 3 warning / 1 info) was independently spot-checked against the current code, not trusted as-is:

- **WR-01** (TOCTOU: `_purge_guest` never re-checked eligibility at delete time) — claimed fixed. **Re-confirmed this pass**: `test_reactivated_guest_is_skipped_not_purged` re-run directly — PASS.
- **WR-02** (raw SQL in service layer, not repository) — accepted, mirrors a pre-existing `DELETE /api/games` router pattern. Not a phase-goal blocker.
- **WR-03** (leaked guest `User` rows pollute later tests) — claimed fixed. `_cleanup_leaked_guest_rows` autouse fixture confirmed present.
- **IN-01** (untested shutdown-exception branch for the new task) — **CLOSED this pass.** `test_guest_cleanup_task_exception_on_shutdown_is_logged` now provides direct behavioral proof of the branch, superseding the reviewer's "accepted, non-blocking" disposition with an actual passing test. Truth #10 re-scored VERIFIED.

### Human Verification Required

1. **D-06 backstop: large-cascade prod safety**
   - **Test:** Purge a guest holding a ~5M-row `game_positions` cascade (GM-Hikaru-scale) against a prod-representative DB under concurrent API load; observe WAL growth and lock duration.
   - **Expected:** No visible API latency degradation; if there is, the documented chunked/batched-delete fallback should be implemented.
   - **Why human:** Explicitly declared a non-inferable `backstop` must-have in 187-01-PLAN.md frontmatter — cannot be measured from source code or the test DB, only from real prod-scale data and live traffic. This is the correct terminal state for a backstop item: it can never be closed from the codebase, and remains the sole outstanding item for this phase.

### Gaps Summary

No FAILED truths and no missing/stub/orphaned artifacts. All 11 must-have truths (Plan-01's eligibility/cascade/dual-cursor-reset/survivor-preservation/transaction-isolation, and Plan-02's periodic-loop-mechanics/exception-isolation/corrected-lifespan-test/shutdown-exception-logging) are now directly proven by tests this verifier ran itself (not taken from SUMMARY narration). The single remaining item is the explicitly-declared D-06 backstop (large-cascade prod WAL/lock safety), which by definition cannot be verified from the codebase and correctly routes to human verification rather than being marked failed or silently passed. The phase goal — guest purge + dual cursor reset + survivor preservation, spawned/cancelled correctly with logged (not propagated) shutdown failures — is fully achieved in the codebase.

---

_Verified: 2026-07-24T17:05:00Z_
_Verifier: Claude (gsd-verifier)_
