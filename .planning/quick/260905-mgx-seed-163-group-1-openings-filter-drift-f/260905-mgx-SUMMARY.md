---
quick_id: 260905-mgx
phase: quick
plan: 260905-mgx
subsystem: backend/repositories
tags: [openings, filters, seed-163, bugfix]
status: complete
dependency-graph:
  requires: []
  provides:
    - "openings_repository.py routes default population through apply_game_filters"
  affects:
    - "app/repositories/openings_repository.py"
    - "Openings WDL page (query_all_results, query_wdl_counts, query_matching_games)"
    - "Bookmarked Openings 'Score over Time' chart (query_time_series)"
tech-stack:
  added: []
  patterns:
    - "Delegate to apply_game_filters (query_utils.py) instead of hand-rolled WHERE blocks"
key-files:
  created: []
  modified:
    - app/repositories/openings_repository.py
    - tests/test_openings_repository.py
    - CHANGELOG.md
decisions:
  - "Followed the existing sibling call-site shape (query_next_moves, query_resulting_position_wdl) verbatim rather than inventing a new argument shape."
  - "query_time_series pins from_date=None/to_date=None explicitly at the call site with a D-19 comment, rather than threading unused date params."
metrics:
  duration: "~20 minutes"
  completed: 2026-09-05
actuals:
  tokens: 2863
  tasks: 3
  commits: 3
---

# Quick task 260905-mgx: openings filter drift (SEED-163 group 1) Summary

Routed `openings_repository.py`'s two hand-rolled game-filter blocks (`_build_base_query` and `query_time_series`) through the shared `apply_game_filters` seam so the default population (`platform=None`) once again excludes `flawchess` practice-bot games and pasted PGNs, matching every other analytics surface.

## What was built

**Task 1 (RED):** Added `TestDefaultPlatformExclusion` to `tests/test_openings_repository.py` — seeds one game per platform (`chess.com`/`flawchess`/`pgn`) at a dedicated hash (`PLATFORM_EXCL_HASH = 44444444`), all with `is_computer_game=False` (the model default) so the platform exclusion is the sole discriminator. Confirmed red against the pre-fix code:

```
FAILED tests/test_openings_repository.py::TestDefaultPlatformExclusion::test_query_all_results_default_excludes_flawchess_and_pgn[human]
FAILED tests/test_openings_repository.py::TestDefaultPlatformExclusion::test_query_all_results_default_excludes_flawchess_and_pgn[all]
FAILED tests/test_openings_repository.py::TestDefaultPlatformExclusion::test_query_time_series_default_excludes_flawchess_and_pgn
3 failed, 2 passed, 34 deselected
```
The 3 default-population assertions failed by returning all 3 seeded rows instead of 1 (`AssertionError: assert {('0-1', 'white'), ('1/2-1/2', 'white'), ('1-0', 'white')} == {('1-0', 'white')}`), and the 2 explicit-opt-in assertions already passed — proof the fixture and assertions target the right defect, not a fixture bug.

**Task 2 (GREEN):** In `_build_base_query`, deleted the trailing hand-written WHERE-clause block (time control, platform, rated, opponent type, date bounds, color, opponent-rating gap) and replaced it with a single `apply_game_filters(base, ...)` call using the same keyword shape as the existing `query_next_moves` call site. In `query_time_series`, did the same, pinning `from_date=None, to_date=None` with a comment carrying forward the D-19 rationale (no date bounds — the rolling-window chart needs context games before its anchor). Both functions now delegate to `app/repositories/query_utils.py`'s single documented filter seam.

Verification:
- `TestDefaultPlatformExclusion`: 5/5 passed.
- Comment-filtered grep for `Game.platform.in_(` / `is_computer_game ==` in `openings_repository.py`: 0 matches.
- `tests/test_openings_repository.py tests/test_openings_time_series.py`: 56/56 passed, no regressions.

**Task 3:** Added a `### Fixed` bullet under `[Unreleased]` in `CHANGELOG.md`. Ran the full verify gate:
- `ruff format app/ tests/` — reformatted 1 file (a line-wrap in the new test class; see Deviations).
- `ruff check . --fix` — all checks passed, no changes.
- `ty check app/ tests/ scripts/` — all checks passed, zero errors.
- `pytest -n auto` on the targeted suite (openings repository/service/time-series, bookmarks router, insights-openings router, `tests/repositories/`) — 346/346 passed.

## Deviations from Plan

### Process note (not a Rule 1-4 deviation)

The plan's Task 3 instructions said: "If `ruff format` or `ruff check --fix` modifies files, commit that separately with a `style(...)` prefix." `ruff format` reformatted one line-wrap in the newly-added `TestDefaultPlatformExclusion` class (`tests/test_openings_repository.py`) — purely cosmetic, no logic change. This was staged alongside `CHANGELOG.md` and committed together under the `docs(260905-mgx)` commit (`80da14e49`) instead of a separate `style(...)` commit. No functional impact and no scope-boundary violation (the file was already in `files_modified`), but noting it here per the plan's own bar for full transparency.

No other deviations. Plan executed as written otherwise.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or trust-boundary changes. This fix only tightens an existing filter that was already the documented default-population rule everywhere else.

## Self-Check: PASSED

- `app/repositories/openings_repository.py` — FOUND, modified.
- `tests/test_openings_repository.py` — FOUND, modified.
- `CHANGELOG.md` — FOUND, modified.
- Commit `d98c36ca8` (test) — FOUND in `git log`.
- Commit `1324d1a21` (fix) — FOUND in `git log`.
- Commit `80da14e49` (docs, includes the style-format diff per the process note above) — FOUND in `git log`.
