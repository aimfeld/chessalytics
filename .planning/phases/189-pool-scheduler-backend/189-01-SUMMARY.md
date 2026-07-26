---
phase: 189-pool-scheduler-backend
plan: 01
subsystem: api
tags: [fastapi, sqlalchemy, alembic, postgres, spaced-repetition, pydantic]

# Dependency graph
requires: []
provides:
  - "drill_items / drill_sessions / drill_solves / train_settings tables (D-02/D-04/D-06/D-07/D-08 schema shape)"
  - "app.services.train_scheduler — pure interval-ladder scheduler (local_today, next_scheduled_day, apply_result, session_window, is_session_expired)"
  - "app.services.train_pool — winnability-floor pool-entry SQL (pool_entry_stmt, expected_score_sql, full_fen_at_ply)"
  - "app.repositories.train_repository — settings create-on-first-touch + SR-path session composition"
  - "POST /api/train/sessions — guest-gated session composition endpoint"
affects: [190-train-page-and-solve-loop, 191-schedule-and-progress-surface, 189-02, 189-03, 189-04, 189-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Live-join answer key at serve time (D-01) — no drill table caches best_move/pv/sharp-soft classification"
    - "drill_items FKs to games(id) only, plain (game_id, ply) reference columns, lazy eviction via LEFT JOIN game_flaws (D-02)"
    - "SQL/Python twin functions with a _sql suffix (expected_score_sql mirrors eval_cp_to_expected_score's Option-B mate mapping)"
    - "Centralized _reject_guest(user) called as the first statement of every /train/* handler (D-05)"

key-files:
  created:
    - app/models/drill_item.py
    - app/models/drill_session.py
    - app/models/drill_solve.py
    - app/models/train_settings.py
    - app/services/train_scheduler.py
    - app/services/train_pool.py
    - app/repositories/train_repository.py
    - app/schemas/train.py
    - app/routers/train.py
    - alembic/versions/20260725_115348_10335efafdb4_phase_189_train_tables.py
    - tests/services/test_train_scheduler.py
    - tests/routers/test_train.py
  modified:
    - alembic/env.py
    - app/main.py

key-decisions:
  - "TrainSessionResponse.session_id is int | None (deviation from the plan's literal `int` type) so the repository's explicit 'write NO session row when nothing qualifies' contract is expressible — session_date/expires_on stay always-populated since they're pure functions of (today, weekday_mask)"
  - "WINNABILITY_FLOOR_ES = 0.20, LADDER_DAYS = {0: 0, 1: 3, 2: 10}, MASTERY_STREAK_THRESHOLD = 3, PARK_FAIL_THRESHOLD = 3 — planner discretion per CONTEXT.md, matching the seed's stated ranges"
  - "compose_and_materialize_session scoped to the SR path only per Task 1 — herrings (Plan 03) and D-12 resume-open-session (Plan 04) are explicitly out of scope"

patterns-established:
  - "Internal repository dataclasses (TrainSettingsRow, ComposedPuzzle, ComposedSession) mirror user_import_settings_repository's frozen-dataclass convention; the router converts them to Pydantic schemas at the boundary"

requirements-completed: [POOL-01, POOL-04, POOL-05, POOL-06, POOL-10]

coverage:
  - id: D1
    description: "A user's own qualifying blunder (ply-parity, winnability floor, non-empty missed_pv_lines) is served as one puzzle by POST /api/train/sessions with a full 6-field FEN and no answer-key field"
    requirement: "POOL-01"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py::test_compose_session_serves_own_blunder"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_pre_attempt_payload_shape"
        status: pass
    human_judgment: false
  - id: D2
    description: "Opponent-side flaws, blob-less blunders, and hopeless pre-move positions never enter the pool"
    requirement: "POOL-01"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py::test_opponent_flaw_excluded"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_null_blob_excluded"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_below_winnability_floor_excluded"
        status: pass
    human_judgment: false
  - id: D3
    description: "Train explicitly rejects guest accounts with 403 before any pool query runs (D-05); unauthenticated requests return 401"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py::test_403_guest"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_401_unauthenticated"
        status: pass
    human_judgment: false
  - id: D4
    description: "drill_items anchors to games(id) only — no FK to game_flaws (D-02), proven against live information_schema"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py::test_drill_items_fk_targets"
        status: pass
    human_judgment: false
  - id: D5
    description: "The interval ladder is pure (zero I/O), masters at exactly streak 3, parks at exactly fail_count 3 with zero ever-correct, has no guess parameter, and the D-06 day-boundary conversion has exactly one implementation"
    requirement: "POOL-04, POOL-05, POOL-06"
    verification:
      - kind: unit
        ref: "tests/services/test_train_scheduler.py (21 tests, table-driven boundary cases)"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-07-25
status: complete
---

# Phase 189 Plan 01: Pool + Scheduler Backend Skeleton Summary

**Four-table Train schema (drill_items/drill_sessions/drill_solves/train_settings) with a pure interval-ladder scheduler and a guest-gated POST /api/train/sessions that serves a user's own qualifying blunder as a puzzle with a full FEN and no answer key**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-07-25
- **Tasks:** 2 (Task 1 tracer, Task 2 auto/TDD)
- **Files modified:** 14 (12 created, 2 modified)

## Accomplishments

- One Alembic migration creating `drill_items`, `drill_sessions`, `drill_solves`, `train_settings` with every FK carrying an explicit `ondelete`, every CHECK named `ck_<table>_<concept>`, and both partial indexes (`ix_drill_items_user_status_due`, the D-12 single-open-session `uq_drill_sessions_user_open`)
- `app/services/train_scheduler.py` — pure, zero-I/O interval ladder: `local_today` (D-06 UTC→local conversion), `next_scheduled_day` (D-07 empty-mask identity), `apply_result` (mastery at exactly streak 3, parking at exactly fail_count 3, no guess parameter), `session_window` (D-10), `is_session_expired`
- `app/services/train_pool.py` — `pool_entry_stmt` reusing `player_only_gate` for ply-parity and a `PriorPosition` self-join reading the pre-flaw-move eval (Pitfall 2), `expected_score_sql` (SQL twin of the Option-B mate-mapped sigmoid, matching `best_move_candidates._es_sql`'s branch order), `full_fen_at_ply` (PGN replay for a full legal FEN)
- `app/repositories/train_repository.py` — `get_or_create_settings` (create-on-first-touch) and `compose_and_materialize_session` (due-item scan → pool-entry padding → FEN reconstruction with broken-FEN drop → session + pre-materialized `drill_solves` rows)
- `POST /api/train/sessions` — `_reject_guest` centralized gate, IDOR-safe (`user_id` always from `current_active_user.id`), Sentry-wrapped
- 8 router tests + 21 pure scheduler unit tests, all green; full backend suite (3668 tests) green

## Task Commits

1. **Task 1: End-to-end "compose a session from my own blunders"** - `e32ed2a6` (feat, tracer)
2. **Task 2: Complete the pure interval ladder** - `9c27d1dc` (test, RED) → `a2e31fd7` (feat, GREEN)

**Plan metadata:** (this commit)

## Files Created/Modified

- `app/models/drill_item.py` - `DrillItem` ORM + `DrillStatus` IntEnum, composite PK `(user_id, game_id, ply)`, D-02 anchoring
- `app/models/drill_session.py` - `DrillSession` ORM, D-04 users-only FK, D-12 partial unique index
- `app/models/drill_solve.py` - `DrillSolve` ORM + `DrillSource`/`DrillGuess` IntEnums, pre-materialized per-puzzle rows
- `app/models/train_settings.py` - `TrainSettings` ORM, D-06/D-07/D-08 defaults
- `app/services/train_scheduler.py` - pure interval ladder (constants, day-boundary functions, `apply_result`, `session_window`, `is_session_expired`)
- `app/services/train_pool.py` - winnability-floor pool-entry SQL + FEN reconstruction
- `app/repositories/train_repository.py` - settings CRUD + SR-path session composition
- `app/schemas/train.py` - `TrainPuzzle` (exactly 5 fields, POOL-10) + `TrainSessionResponse`
- `app/routers/train.py` - guest-gated `POST /train/sessions`
- `alembic/versions/20260725_115348_10335efafdb4_phase_189_train_tables.py` - four-table migration
- `alembic/env.py` - registered the four new models in the explicit autogenerate import list
- `app/main.py` - registered `train_router` at `/api`
- `tests/services/test_train_scheduler.py` - 21 pure-function unit tests
- `tests/routers/test_train.py` - 8 end-to-end router tests

## Decisions Made

- `TrainSessionResponse.session_id` is `int | None`, not the plan's literal `int` — necessary to express the repository's explicit "write NO `drill_sessions` row when nothing qualifies" contract; `session_date`/`expires_on` stay always-populated (pure functions of `today`/`weekday_mask`, no persistence dependency)
- `WINNABILITY_FLOOR_ES = 0.20`, `LADDER_DAYS = {0: 0, 1: 3, 2: 10}`, `MASTERY_STREAK_THRESHOLD = 3`, `PARK_FAIL_THRESHOLD = 3` — planner discretion per CONTEXT.md, at the values RESEARCH.md's Code Examples section already sketched
- `compose_and_materialize_session` deliberately scoped to the SR path only (no herrings, no D-12 resume-open-session check) — those land in Plans 03/04 per the phase's source_audit table
- Reverted `requirements.mark-complete`'s POOL-01/04/05/06/10 checkbox flips: per this plan's own source_audit table these requirements are shared across Plans 01/04/05 (composition padding, herrings, solve-time ladder wiring, reveal endpoint) — left `[ ]` Pending; the last contributing plan actually closes them

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Made `TrainSessionResponse.session_id` nullable**
- **Found during:** Task 1 (router/schema wiring)
- **Issue:** The plan's literal schema (`session_id: int`) cannot represent the same task's explicit requirement to "return zero puzzles and write NO session row when nothing qualifies" — a non-nullable int has no value to carry in that case.
- **Fix:** Changed `session_id` to `int | None` in `app/schemas/train.py`, with a docstring explaining the contract; `session_date`/`expires_on` remain non-nullable since they're computed regardless of persistence.
- **Files modified:** `app/schemas/train.py`, `app/repositories/train_repository.py` (`ComposedSession.session_id: int | None`)
- **Verification:** `uv run ty check app/ tests/` passes; no test currently exercises the true empty-pool path (all four seeded-flaw tests produce exactly one qualifying or zero-qualifying puzzle from a single flaw, never a mixed empty-session case), so this path is implemented per the plan's spec but not independently asserted by a dedicated "zero session row" test in this plan.
- **Committed in:** `e32ed2a6` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 Rule 1 bug fix — schema/behavior consistency)
**Impact on plan:** Necessary correction to make the plan's own stated behavior expressible. No scope creep.

## Issues Encountered

- **JSONB `None` vs SQL `NULL` gotcha (test-only, not a production bug):** the `test_null_blob_excluded` test initially failed because passing `missed_pv_lines=None` explicitly to the `GameFlaw` constructor writes `null::jsonb` (a JSON null value), which `IS NOT NULL` treats as present — not a true SQL `NULL`. Fixed by omitting the column entirely from the test's INSERT when simulating "no blob" (matches how `eval_apply.py`'s production write path already behaves — it never explicitly nulls the column, only omits it for flaws with no computed blob). No application code was affected; `app/services/train_pool.py`'s `GameFlaw.missed_pv_lines.isnot(None)` filter is correct as written.
- A second test-helper bug (using `None` as a "use the default" sentinel that collided with the deliberate `missed_pv_lines=None` test case) was caught and fixed in the same investigation.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The four-table schema, pure scheduler, pool-entry SQL, and guest gate are all in place for Plan 02 (delete-all/guest-prune cascade verification), Plan 03 (sharp/soft classifier + red herrings), Plan 04 (D-12 resume + full session composition + settings endpoints), and Plan 05 (solve/reveal endpoints).
- `full_fen_at_ply`, `expected_score_sql`, `player_only_gate` reuse, and the `_sql`-suffix twin-function convention are established and ready for Plan 03's herring query to follow.
- No blockers.

---
*Phase: 189-pool-scheduler-backend*
*Completed: 2026-07-25*

## Self-Check: PASSED

All 13 created/modified files verified present; all 3 task commits (`e32ed2a6`, `9c27d1dc`, `a2e31fd7`) verified in git log.
