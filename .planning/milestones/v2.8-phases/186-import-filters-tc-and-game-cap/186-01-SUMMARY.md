---
phase: 186-import-filters-tc-and-game-cap
plan: 01
subsystem: import
tags: [fastapi, sqlalchemy, alembic, postgres, pydantic, import-pipeline]

# Dependency graph
requires: []
provides:
  - "user_import_settings table (TC toggles + game_cap CHECK + reserved backfill-cursor columns)"
  - "D-13 grandfathering migration (existing users -> all TCs + cap 5000)"
  - "user_import_settings_repository (get/upsert/get-or-create, kw-only user_id V4 guard)"
  - "GET/PATCH /users/me/import-settings endpoints"
  - "count_backlog_by_platform_and_tc derived aggregate query"
  - "forward/incremental-sync TC filter wired into import_service.run_import"
affects: [186-02, 186-03]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "kw-only user_id repository functions for V4 IDOR mitigation (mirrors user_rating_anchors_repository)"
    - "derived aggregate query over games table instead of a denormalized counter (186-RESEARCH.md Pattern 1)"
    - "dict fallback in _passes_tc_filter mirroring _collect_position_rows' isinstance(g, NormalizedGame) pattern for test-double compatibility"

key-files:
  created:
    - app/models/user_import_settings.py
    - app/repositories/user_import_settings_repository.py
    - alembic/versions/20260724_043548_f09f8dee4aee_add_user_import_settings.py
    - tests/test_migration_186_user_import_settings.py
  modified:
    - alembic/env.py
    - app/routers/users.py
    - app/schemas/users.py
    - app/services/import_service.py
    - app/repositories/game_repository.py
    - tests/test_users_router.py
    - tests/test_import_service.py
    - tests/test_game_repository.py

key-decisions:
  - "D-13 confirmed via checkpoint:decision gate (coordinator approved 2026-07-24): existing users grandfathered to all four TCs enabled + game_cap=5000, baked into the one-way migration INSERT ... SELECT."
  - "alembic/env.py needed a direct model import (not in plan's files_modified) so autogenerate detects the new table -- most existing models rely on transitive imports via other registered models, which doesn't hold for a brand-new table with no cross-references."
  - "IMPORT-05 listed in plan frontmatter requirements but not delivered by this plan (only IMPORT-01/02/04 match the plan's stated Implements list) -- left unmarked, matching the established partial-delivery convention (see STATE.md Phase 151/154/155 entries)."

requirements-completed: [IMPORT-01, IMPORT-02, IMPORT-04]

coverage:
  - id: D1
    description: "PATCH /users/me/import-settings persists TC toggles + game_cap; subsequent GET returns saved values scoped to the authenticated user (D-09 persistence contract)"
    requirement: "IMPORT-01"
    verification:
      - kind: integration
        ref: "tests/test_users_router.py::TestPatchImportSettings::test_import_settings_patch_then_get_roundtrip"
        status: pass
      - kind: integration
        ref: "tests/test_users_router.py::TestImportSettingsUserIsolation::test_import_settings_cannot_read_or_write_another_users"
        status: pass
    human_judgment: false
  - id: D2
    description: "New user's settings default to bullet=off, blitz/rapid/classical=on, game_cap=1000 on first GET (create-on-first-touch, D-16 guest/registered parity)"
    requirement: "IMPORT-01"
    verification:
      - kind: integration
        ref: "tests/test_users_router.py::TestGetImportSettings::test_import_settings_defaults_for_new_user"
        status: pass
    human_judgment: false
  - id: D3
    description: "game_cap=2500 (outside {1000,3000,5000}) is rejected 422 by Pydantic Literal before reaching the DB"
    requirement: "IMPORT-01"
    verification:
      - kind: integration
        ref: "tests/test_users_router.py::TestPatchImportSettings::test_import_settings_patch_invalid_game_cap_returns_422"
        status: pass
    human_judgment: false
  - id: D4
    description: "Existing users are grandfathered to all four TCs enabled + game_cap=5000 by the Alembic migration's one-time INSERT ... SELECT (D-13)"
    requirement: "IMPORT-01"
    verification:
      - kind: integration
        ref: "tests/test_migration_186_user_import_settings.py::test_grandfathers_existing_user_to_all_tcs_and_cap_5000"
        status: pass
    human_judgment: false
  - id: D5
    description: "The DB CHECK constraint (ck_user_import_settings_cap) rejects an invalid game_cap as defense-in-depth (T-186-02)"
    verification:
      - kind: integration
        ref: "tests/test_migration_186_user_import_settings.py::test_check_constraint_rejects_invalid_game_cap"
        status: pass
    human_judgment: false
  - id: D6
    description: "Forward/incremental sync drops a game whose time_control_bucket is a deselected TC before insert; None-bucket and correspondence(classical) games always pass (D-02/D-14/D-15)"
    requirement: "IMPORT-02"
    verification:
      - kind: unit
        ref: "tests/test_import_service.py::TestPassesTcFilter"
        status: pass
      - kind: integration
        ref: "tests/test_import_service.py::TestRunImportTcFilter::test_forward_sync_drops_deselected_tc_keeps_none_and_classical"
        status: pass
    human_judgment: false
  - id: D7
    description: "count_backlog_by_platform_and_tc returns per-(platform, TC) counts for games played before the anchor, excludes post-anchor games, and omits NULL-bucket games (D-01/D-02/D-15)"
    requirement: "IMPORT-04"
    verification:
      - kind: integration
        ref: "tests/test_game_repository.py::TestCountBacklogByPlatformAndTc"
        status: pass
    human_judgment: false
  - id: D8
    description: "GET /users/me/import-settings surfaces backlog_counts populated with the authenticated user's own pre-anchor counts only"
    requirement: "IMPORT-04"
    verification:
      - kind: integration
        ref: "tests/test_users_router.py::TestImportSettingsBacklogCounts::test_backlog_counts_match_pre_anchor_games_for_own_user_only"
        status: pass
    human_judgment: false

# Metrics
duration: 25min
completed: 2026-07-24
status: complete
---

# Phase 186 Plan 01: Settings Tracer — TC Filter Foundation Summary

**Per-user `user_import_settings` table + grandfathering migration + GET/PATCH API + derived backlog-count query + forward-sync TC filter, proven end-to-end as the phase's tracer slice.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-07-24T06:30Z (checkpoint reached, blocked on D-13 confirmation)
- **Completed:** 2026-07-24T06:52Z
- **Tasks:** 2 (plus 1 checkpoint:decision gate)
- **Files modified:** 12 (4 created, 8 modified)

## Accomplishments
- New `user_import_settings` table (TC toggles + `game_cap` CHECK(1000,3000,5000) + three nullable backfill-cursor columns reserved for Plan 02), created and grandfathered via a one-way Alembic migration confirmed at the D-13 checkpoint.
- `user_import_settings_repository.py`: get/upsert/get-or-create with kw-only `user_id` (V4 IDOR mitigation) and a `DEFAULT_IMPORT_SETTINGS` constant for new-user defaults (D-16).
- `GET`/`PATCH /users/me/import-settings` endpoints, scoped exclusively to `current_active_user`.
- Forward/incremental-sync TC filter wired into `import_service.run_import`: loads settings once per job, drops deselected-TC games before insert, always keeps `None`-bucket and correspondence(classical) games (D-02/D-14/D-15).
- `count_backlog_by_platform_and_tc` derived aggregate query (no denormalized counter) surfaced in the settings response as `backlog_counts`.
- Tracer feedback gate run after Task 1's commit (autonomous mode, `_auto_chain_active: true`) — the tracer's `<verify>` (`alembic upgrade head` + targeted pytest) passed before Task 2 (expansion) began.

## Task Commits

Each task was committed atomically:

1. **Checkpoint: D-13 grandfathering confirmation** — coordinator approved "all four TCs enabled + game_cap=5000" as locked, no adjustment.
2. **Task 1: End-to-end settings slice (tracer)** — `221f6f71` (feat)
3. **Task 2: Derived backlog-count query + settings response** — `b74ba01e` (feat)

**Plan metadata:** commit pending (this SUMMARY + STATE/ROADMAP update)

## Files Created/Modified
- `app/models/user_import_settings.py` — `UserImportSettings` ORM model (TC booleans, `game_cap` SmallInteger + CHECK, 3 nullable backfill-cursor columns).
- `app/repositories/user_import_settings_repository.py` — `get_settings`/`upsert_settings`/`get_or_create_settings`, `ImportSettingsRow` dataclass, `GameCap` Literal, `DEFAULT_IMPORT_SETTINGS`.
- `alembic/versions/20260724_043548_f09f8dee4aee_add_user_import_settings.py` — creates the table + D-13 grandfathering `INSERT ... SELECT`.
- `alembic/env.py` — direct model import so autogenerate detects the new table (Rule 3 deviation).
- `app/schemas/users.py` — `ImportSettingsResponse` (incl. `backlog_counts`) and `ImportSettingsUpdate` Pydantic v2 models, `game_cap: Literal[1000, 3000, 5000]`.
- `app/routers/users.py` — `GET`/`PATCH /users/me/import-settings`.
- `app/services/import_service.py` — `_enabled_tc_buckets`, `_passes_tc_filter`, `_load_enabled_tc_buckets` helpers; filter wired into `run_import`'s batch loop.
- `app/repositories/game_repository.py` — `count_backlog_by_platform_and_tc`.
- `tests/test_migration_186_user_import_settings.py` (new) — table/CHECK creation, D-13 grandfathering, CHECK-constraint rejection.
- `tests/test_users_router.py` — import-settings GET/PATCH/isolation/backlog-counts tests.
- `tests/test_import_service.py` — TC-filter unit tests + one end-to-end `run_import` integration test; updated `test_one_session_per_batch`'s expected session count (+1 for the new settings-load session).
- `tests/test_game_repository.py` — `count_backlog_by_platform_and_tc` tests.

## Decisions Made
- D-13 confirmed as locked via the checkpoint:decision gate — all four TCs enabled + `game_cap=5000` for existing users, baked into a one-way migration.
- `alembic/env.py` required a direct `UserImportSettings` import (not listed in the plan's `files_modified`) — most existing models are picked up by autogenerate only transitively (via cross-imports triggered by other registered models like `user_rating_anchors` being pulled in through `user_benchmark_percentile`), which doesn't hold for a brand-new, reference-free table. Classified as Rule 3 (blocking issue — autogenerate silently produced an empty diff without it).
- Added `tests/test_migration_186_user_import_settings.py` (new file, not in `files_modified`) to satisfy the plan's explicit "migration/grandfather test" acceptance criterion — mirrors the established `tests/test_migration_117.py` downgrade/insert/upgrade pattern.
- `_passes_tc_filter` accepts a dict fallback mirroring `_collect_position_rows`'s `isinstance(g, NormalizedGame)` pattern, so seven pre-existing `test_import_service.py` tests that mock the platform client with plain dicts (an established test-double convention in this file) kept passing unmodified.
- `IMPORT-05` (present in the plan's frontmatter `requirements` list) is NOT marked complete here — the plan's own `<objective>` "Implements" list only names IMPORT-01/02/04; IMPORT-05 is presumably delivered by a later plan in this phase. Left unmarked rather than guessed, matching the established partial-delivery convention documented in STATE.md (e.g. Phase 151/154/155 entries).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Registered the new model in alembic/env.py**
- **Found during:** Task 1 (Alembic autogenerate)
- **Issue:** `alembic revision --autogenerate` requires the new ORM model to be importable via `Base.metadata` at env.py load time. Unlike most existing models (picked up transitively through cross-model imports), `UserImportSettings` has no incoming references from any already-imported model, so autogenerate would silently miss it.
- **Fix:** Added `from app.models.user_import_settings import UserImportSettings  # noqa: F401` to `alembic/env.py`, following the pattern of the most recently added direct imports (e.g. `bot_game_settings`).
- **Files modified:** `alembic/env.py`
- **Verification:** `alembic revision --autogenerate` correctly detected `Detected added table 'user_import_settings'` with no other spurious diffs.
- **Committed in:** `221f6f71` (Task 1 commit)

**2. [Rule 2 - Missing Critical] Added a dedicated migration/grandfathering regression test file**
- **Found during:** Task 1 (acceptance criteria explicitly require "A migration/grandfather test asserts an existing user row has all-true TCs + game_cap=5000 after upgrade")
- **Issue:** The plan's `files_modified` list did not include a new test file for this, but the acceptance criteria cannot be satisfied without one — the migration's one-way, one-time `INSERT ... SELECT` behavior needs its own downgrade/insert-user/upgrade/assert cycle, which doesn't fit into the router or repository test files.
- **Fix:** Created `tests/test_migration_186_user_import_settings.py`, mirroring the established `tests/test_migration_117.py` pattern (Alembic-driven downgrade/upgrade against the per-run test DB, always restoring to head).
- **Files modified:** `tests/test_migration_186_user_import_settings.py` (new)
- **Verification:** All 3 tests pass (table/CHECK creation round-trip, grandfathering assertion, CHECK-constraint rejection).
- **Committed in:** `221f6f71` (Task 1 commit)

**3. [Rule 1 - Bug] Updated test_one_session_per_batch's expected session-open count**
- **Found during:** Task 1 (full `test_import_service.py` regression run)
- **Issue:** `_load_enabled_tc_buckets` intentionally opens one new `async_session_maker()` scope per job (to load the TC settings once, per D-04). `TestRunImportSessionPerBatch::test_one_session_per_batch` asserts an exact session-open count that didn't yet account for this new scope, so it failed with `7 == 6`.
- **Fix:** Updated the test's docstring and `expected_session_calls` formula to include the new TC-settings-load session (6 -> 7).
- **Files modified:** `tests/test_import_service.py`
- **Verification:** `test_one_session_per_batch` passes with the corrected count; the underlying session-lifetime-bounding invariant (Phase 90/SEED-018) is unchanged.
- **Committed in:** `221f6f71` (Task 1 commit)

---

**Total deviations:** 3 auto-fixed (1 blocking, 1 missing-critical/test-coverage, 1 bug/test-expectation-drift)
**Impact on plan:** All three were necessary to satisfy the plan's own acceptance criteria and keep the full test suite green. No scope creep — no functionality beyond what Tasks 1-2 specify was added.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 02 (backward-fetch backfill) can build directly on: the `user_import_settings` table (including its 3 reserved-but-unused backfill-cursor columns), `get_or_create_settings`/`upsert_settings`, and `count_backlog_by_platform_and_tc` (already usable for the backward walk's per-(platform, TC) stop condition per D-07).
- Plan 03 (frontend chips) can consume `GET /users/me/import-settings`'s `backlog_counts` directly — no further backend work needed for the count side of the UI (D-11/D-12 chip copy is Plan 03's job).
- No blockers. Full backend suite (3589 passed, 18 skipped, pre-existing) green after this plan's changes; `ty check` and `ruff` clean.

## Self-Check: PASSED

All 12 created/modified files confirmed present on disk; both task commit hashes
(`221f6f71`, `b74ba01e`) confirmed present in git history.

---
*Phase: 186-import-filters-tc-and-game-cap*
*Completed: 2026-07-24*
