---
phase: quick-260806-p9n
plan: 01
subsystem: import
tags: [chess.com, import, sentry, cursor, backfill]
status: complete
dependency-graph:
  requires: []
  provides:
    - "chesscom_client._fetch_archive_with_retries(user_id) skip-event Sentry context"
    - "chesscom_client.fetch_chesscom_games(on_archive_skipped=)"
    - "chesscom_client.fetch_chesscom_games_backward skipped_any cursor freeze"
    - "import_service.JobState.earliest_skipped_archive_ym"
    - "import_service._complete_import_job last_synced_at clamp"
  affects:
    - app/services/chesscom_client.py
    - app/services/import_service.py
tech-stack:
  added: []
  patterns:
    - "Sentry set_context BEFORE capture_message, literal message string for stable grouping"
    - "Skip-reporting callback wired through an async generator to accumulate min() state on the caller's JobState"
key-files:
  created: []
  modified:
    - app/services/chesscom_client.py
    - app/services/import_service.py
    - tests/test_chesscom_client.py
    - tests/services/test_import_service.py
    - CHANGELOG.md
decisions:
  - "D-01: 404/410 still skip-and-remember, never hard-fail — a chess.com month that never recovers must not block the import forever."
  - "D-02: Sentry context (archive_url, status, user_id, platform) attached before capture_message; message string kept a literal so FLAWCHESS-39 keeps its grouping."
  - "D-03: forward cursor clamps last_synced_at to first-of-earliest-skipped-month (min() across all skips); backward cursor freezes on_month_attempted from the first skip onward for the remainder of the walk."
  - "D-04: scope held to Fix A + Fix B only — no retry-loop refactor, no new table, no 5xx/429 changes, no lichess changes."
  - "D-05: every new assertion proven by actual revert + observed failure (see Revert-Proof Check below), not by grep."
metrics:
  duration: "~55 min"
  completed: "2026-08-06"
actuals:
  tokens: 7308
  tasks: 2
  commits: 2
---

# Phase quick-260806-p9n Plan 01: Fix chess.com 404 archive skip, add Sentry context Summary

Fixed FLAWCHESS-39: a 404/410 on a chess.com monthly archive fetch was silently
treated as "attempted but empty," advancing both import cursors past a month
that was never actually fetched — permanent silent data loss, and an
untriageable Sentry event carrying only `source`/`platform` tags.

## What Was Built

**Task 1 — `app/services/chesscom_client.py`:**
- `_fetch_archive_with_retries` now takes a required `user_id: int` parameter
  (both in-module call sites updated) and, on a 404/410 skip, calls
  `sentry_sdk.set_context("import", {platform, user_id, archive_url, status})`
  immediately before the existing `sentry_sdk.capture_message("chess.com
  archive skipped", ...)`. The message string is unchanged (no interpolation)
  so the existing FLAWCHESS-39 grouping holds.
- `fetch_chesscom_games` (forward pass) gains an optional
  `on_archive_skipped: Callable[[tuple[int, int]], None] | None = None`
  parameter, invoked once per skipped month with `(year, month)` via the
  existing `_parse_archive_year_month` helper. A 200 response with an empty
  `games` array is never reported as a skip.
- `fetch_chesscom_games_backward` introduces a local `skipped_any: bool`
  flag, set `True` inside the `resp is None` branch. `on_month_attempted` is
  now guarded by `and not skipped_any`, so once a month is skipped, the
  callback stops firing for that month and every OLDER month in the same
  walk (the walk proceeds newest → oldest, so "older" is monotonic from the
  skip point). The walk itself is unaffected — older months are still
  fetched and their games still yielded; only the persisted-cursor callback
  is suppressed.
- Docstrings updated for both functions (Pitfall-1 paragraph on the backward
  walk restated to "up to and excluding the first skipped month"; `Args:`
  entries for `on_archive_skipped` / `on_month_attempted` updated).

**Task 2 — `app/services/import_service.py`:**
- `JobState` gains `earliest_skipped_archive_ym: tuple[int, int] | None =
  None`.
- New module-level helper `_month_start_utc(ym) -> datetime` (first instant
  of a `(year, month)` tuple, UTC-aware).
- In `_make_game_iterator`'s chess.com branch, a local `_on_archive_skipped`
  closure records the **minimum** skipped month into
  `job.earliest_skipped_archive_ym` (accumulates across the whole forward
  walk regardless of callback arrival order) and is wired as
  `on_archive_skipped=` into `chesscom_client.fetch_chesscom_games`.
- `_complete_import_job` now computes `last_synced_at = min(now,
  _month_start_utc(job.earliest_skipped_archive_ym))` when a skip was
  recorded, else `last_synced_at = now` (byte-identical to prior behavior).
  `completed_at` and `status="completed"` are untouched — a skip never fails
  the job (D-01). A `logger.warning` names the held-back timestamp and the
  skipped month.
- `CHANGELOG.md`: one `### Fixed` bullet under `## [Unreleased]`.

## Deviations from Plan

None — plan executed exactly as written. All five behaviors in Task 1's
`<behavior>` block and all three in Task 2's were implemented as specified;
no Rule 1-4 deviations were needed.

## Revert-Proof Check (D-05, mandatory)

Performed as three actual reverts with observed failures, then restored.
Working tree confirmed clean (`git diff` empty) after each restore.

**1. Removed the `not skipped_any` guard** in `fetch_chesscom_games_backward`
(`if on_month_attempted is not None:` instead of `... and not skipped_any`).
Ran `test_backward_skip_freezes_cursor_but_keeps_walking_older_months`:

```
E       assert [(2024, 3), (...2), (2024, 1)] == [(2024, 3)]
E         Left contains 2 more items, first extra item: (2024, 2)
FAILED tests/test_chesscom_client.py::TestFetchChesscomGamesBackward::test_backward_skip_freezes_cursor_but_keeps_walking_older_months
```
Restored. Full `tests/test_chesscom_client.py` suite green (45 passed) and
`git diff` clean afterward.

**2. Reverted `_complete_import_job` to unconditional `last_synced_at = now`**
(deleted the `if job.earliest_skipped_archive_ym is not None:` clamp block).
Ran `test_complete_import_job_clamps_last_synced_at_to_earliest_skip`:

```
E       AssertionError: assert datetime.datetime(2026, 8, 6, 16, 28, 35, ...) == datetime.datetime(2025, 11, 1, 0, 0, tzinfo=datetime.timezone.utc)
FAILED tests/services/test_import_service.py::test_complete_import_job_clamps_last_synced_at_to_earliest_skip
```
Restored. `tests/services/test_import_service.py` green (10 passed) and
`git diff` clean afterward.

**3. Deleted the `sentry_sdk.set_context` call** at the skip branch in
`_fetch_archive_with_retries`. Ran
`test_404_on_archive_skip_reports_sentry_context_before_message`:

```
E       assert ['capture_message'] == ['set_context', 'capture_message']
E         At index 0 diff: 'capture_message' != 'set_context'
FAILED tests/test_chesscom_client.py::TestFetchChesscomGames::test_404_on_archive_skip_reports_sentry_context_before_message
```
Restored. Full `tests/test_chesscom_client.py` suite green (45 passed) and
`git diff` clean afterward.

All three reverts produced the expected failure and were fully restored — no
gap fix in this plan survives its own revert.

## Behavior Sanity Checks (from plan `<verification>`)

- `_fetch_archive_with_retries` still `return None` for 404/410 — no new
  `raise` introduced (D-01). Verified by inspecting the skip branch.
- `capture_message("chess.com archive skipped", ...)` argument is a plain
  string literal — no f-string / `%` interpolation (D-02).
- The 429 branch and `_RETRYABLE_STATUS_CODES` branch are byte-identical to
  before this plan (diffed against `HEAD~2`, no hits inside those blocks).
- No changes under `app/services/lichess_client.py` or
  `_run_lichess_backward_pass` (D-04) — confirmed via diff.
- No new table, column, or Alembic migration — `git diff HEAD~2 -- alembic/`
  is empty.

## Pre-merge Gate

```
uv run ruff format app/ tests/          # 349 files left unchanged
uv run ruff check app/ tests/ --fix     # All checks passed!
uv run ty check app/ tests/             # All checks passed! (zero errors)
uv run pytest -n auto -x -q             # 4098 passed, 19 skipped
```
Frontend half of the gate skipped per task constraints — no frontend files
touched.

## Self-Check: PASSED

- FOUND: app/services/chesscom_client.py
- FOUND: app/services/import_service.py
- FOUND: tests/test_chesscom_client.py
- FOUND: tests/services/test_import_service.py
- FOUND: CHANGELOG.md
- FOUND: commit b9d5f9c93 (Task 1)
- FOUND: commit 42d675b87 (Task 2)

## Commits

- `b9d5f9c93` — fix(quick-260806-p9n): attach Sentry context to chess.com archive skip, report skipped months
- `42d675b87` — fix(quick-260806-p9n): hold last_synced_at back to earliest skipped chess.com month
