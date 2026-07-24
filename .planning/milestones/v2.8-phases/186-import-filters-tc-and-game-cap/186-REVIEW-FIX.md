---
phase: 186-import-filters-tc-and-game-cap
fixed_at: 2026-07-24T06:30:04Z
review_path: .planning/phases/186-import-filters-tc-and-game-cap/186-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 186: Code Review Fix Report

**Fixed at:** 2026-07-24T06:30:04Z
**Source review:** .planning/phases/186-import-filters-tc-and-game-cap/186-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 4 (1 critical, 3 warning; Info findings IN-01/IN-02 out of scope per fix_scope=critical_warning)
- Fixed: 4
- Skipped: 0

## Fixed Issues

### CR-01: Backward-walk budget is inflated by duplicate (already-imported) games, starving real backlog import

**Files modified:** `app/repositories/game_repository.py`, `app/services/import_service.py`, `tests/test_game_repository.py`, `tests/test_import_service.py`
**Commit:** `53bf1162`
**Applied fix:** Added `game_repository.get_platform_game_ids_for_user(session, user_id, platform)` -- a single indexed query (served by the existing `uq_games_user_platform_game_id` unique index) returning every `platform_game_id` already stored for that (user, platform). `_run_backward_pass` now loads this set once, up front (right after the idle-budget short-circuit, so a fully-capped Sync still does zero extra work), and threads it through to `_run_chesscom_backward_pass` / `_run_lichess_backward_pass`. `_record_backward_game` now skips incrementing `live_counts` for any fetched game whose `platform_game_id` is already in that set -- these are exactly the games `bulk_insert_games`'s `ON CONFLICT DO NOTHING` will later no-op, so they no longer inflate the budget. The dedup check happens per-game, in real time as games are fetched (not deferred to batch-flush time), which the D-07 stop-condition semantics require (a mid-batch `should_stop()` must react to genuine budget state, not a stale one). Went with this approach (querying existing ids up front) over the review's alternative of threading newly-inserted-id information back out of `_flush_batch`, because the latter would have required changing `_flush_batch`'s call signature -- which 5+ existing `TestBackwardPass` tests directly patch with a narrower 3-positional-arg fake, so that path risked breaking real, pre-existing test coverage for the D-07 stop-condition logic.

Added a new regression test, `TestBackwardPass::test_backward_walk_duplicates_do_not_consume_budget`, that reproduces the exact overlap scenario the bug depended on: the backward walk fetches 3 "duplicate" platform_game_ids (simulating games the forward pass already imported this run, via a patched `get_platform_game_ids_for_user` return value) followed by 3 genuinely new backlog games, with `game_cap=3`. Asserts the walk fetches all 6 games without stopping early -- proving the 3 duplicates did not consume the 3-game budget. Also added `TestGetPlatformGameIdsForUser` in `tests/test_game_repository.py` (real-DB unit tests for the new repository function: scoping to (user_id, platform), empty-result case).

### WR-01: "First Sync: imports all your games" copy is now false

**Files modified:** `frontend/src/pages/Import.tsx`
**Commit:** `bb39fffd`
**Applied fix:** Updated the static help text from "First Sync: imports all your games. Later syncs only fetch new games since the last import." to "First Sync: imports your recent games, plus a bounded amount of older history (see Import filters above). Later syncs only fetch new games since the last import." -- matching the review's suggested wording and no longer contradicting the budget chips shown above it on the same page. No test asserted the old exact copy string, so no test updates were needed.

### WR-02: `chesscom_backfill_*` / `lichess_backfill_*` reserved-column docstrings are stale

**Files modified:** `app/models/user_import_settings.py`, `alembic/versions/20260724_043548_f09f8dee4aee_add_user_import_settings.py`
**Commit:** `2ae051f9`
**Applied fix:** Replaced the "RESERVED for Plan 02 ... not written or read by this plan" framing in both the model's module docstring / column comment and the migration's module docstring with language pointing at the actual reader/writer (Plan 02's backward-fetch backfill, shipped in this same phase): `import_service._run_chesscom_backward_pass` / `_run_lichess_backward_pass` and `user_import_settings_repository.get_chesscom_backfill_cursor` / `get_lichess_backfill_cursor` / `update_chesscom_backfill_cursor` / `update_lichess_backfill_cursor`.

### WR-03: Per-month / per-chunk cursor persistence opens one DB session per fetch unit

**Files modified:** `app/services/import_service.py`, `tests/test_import_service.py` (same commit as CR-01, since both touch the same backward-pass functions)
**Commit:** `53bf1162`
**Applied fix:** Applied the review's suggested lighter cadence. Added a new constant `_CURSOR_PERSIST_EVERY_N_UNITS = 6` and batched the cursor-persist DB write (session open + UPDATE + commit) to every N attempted months (chess.com) / fetched chunks (lichess) instead of after every single unit. The in-memory `until_ms` cursor for lichess still advances every chunk (it feeds the next fetch); only the DB write is batched. Both halves force a final flush of any not-yet-persisted trailing progress before the walk returns (whether by `should_stop()`, history exhaustion, or the stalled-cursor guard), so at most `N-1` units of progress can ever be "lost" on a mid-walk exit -- and per Pitfall 1, a re-attempted month/chunk on the next Sync is wasted work, not a correctness bug (CR-01's fix makes re-attempts budget-safe regardless of how many times a unit gets re-walked).

Added a new regression test, `TestBackwardPass::test_chesscom_cursor_persisted_in_batches_not_every_month`, asserting that across 8 attempted months, the cursor is persisted exactly twice (once at the 6th unit, once as the forced final flush at the 8th) rather than 8 times.

## Skipped Issues

None -- all in-scope findings were fixed.

---

_Fixed: 2026-07-24T06:30:04Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
