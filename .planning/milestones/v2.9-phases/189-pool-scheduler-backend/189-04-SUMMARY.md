---
phase: 189-pool-scheduler-backend
plan: 04
subsystem: api
tags: [fastapi, sqlalchemy, postgres, spaced-repetition, pydantic]

# Dependency graph
requires:
  - phase: 189-01
    provides: "drill_items/drill_sessions/drill_solves/train_settings schema, train_scheduler (local_today, session_window, is_session_expired), train_pool.pool_entry_stmt, the SR-only compose_and_materialize_session skeleton, TrainSessionResponse's session_id-nullable contract"
  - phase: 189-03
    provides: "train_pool.herring_stmt (user-scoped, winnability-floored, non-repeating red-herring source) and HERRING_SHARE"
provides:
  - "train_pool.compose_slots — the 75/25 slot arithmetic (herring_slots = floor(n*HERRING_SHARE), sr_slots absorbs the remainder)"
  - "train_pool.blob_pending_stmt — count of own blunders still waiting on a tier-4 answer-key blob"
  - "train_repository.compose_and_materialize_session widened to the full POOL-07 mix with honest cross-backfill AND the D-09/D-10/D-11/D-12 session lifecycle (resume/expire/evict)"
  - "train_repository.expire_stale_sessions / open_session_for_user / load_session_puzzles — the lifecycle primitives"
  - "TrainSessionResponse.requested_count/blob_pending_count wire contract (the Pitfall-4 thin-pool signal)"
affects: [190-train-page-and-solve-loop, 191-schedule-and-progress-surface, 189-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SAVEPOINT-wrapped write + IntegrityError catch (session.begin_nested()) as the concurrency-race resolution pattern for a partial unique index — mirrors app/repositories/worker_heartbeat_repository.py's begin_nested usage and app/routers/imports.py's IntegrityError-as-expected-race handling, but resolved inside the repository rather than the router"
    - "Slot-fill-then-cross-backfill: two independently-capped candidate lists (SR up to sr_slots, herring up to herring_slots), continuation pointers into each ordered pool for the cross-backfill extension, defensive [:n] cap at the end"
    - "Deterministic (user_id, session_date)-seeded shuffle via random.Random(f\"{user_id}:{today.isoformat()}\") for D-09's non-inferable red-herring positioning"

key-files:
  created:
    - tests/repositories/test_train_repository.py
  modified:
    - app/services/train_pool.py
    - app/repositories/train_repository.py
    - app/schemas/train.py
    - tests/routers/test_train.py

key-decisions:
  - "blob_pending_stmt lives in train_pool.py (not train_repository.py) as a proper exported query-builder, mirroring pool_entry_stmt/herring_stmt's convention, rather than reaching into train_pool's private _SEVERITY_BLUNDER constant from a second module — not literally named in the plan's function inventory but a natural, in-scope implementation of the plan's explicit Task 1 requirement"
  - "Cross-backfill uses if/elif (SR-short takes priority over herring-short) rather than two independent ifs — the plan's wording allows either reading; if/elif is the simpler, sufficient implementation for the specified test cases and avoids double-counting when both sides are simultaneously short"
  - "The entire materialize step (new drill_items padding rows + DrillSession + DrillSolve inserts) is wrapped in ONE session.begin_nested() SAVEPOINT, not just the DrillSession insert alone — a concurrent padding-scan collision on a drill_items primary key is caught by the same except IntegrityError branch as the drill_sessions unique-index race, since both indicate the same underlying concurrent-composition race"
  - "On the IntegrityError fallback, a None re-fetch does a bare `raise` (re-raising the original IntegrityError) rather than a second sentry_sdk.capture_exception + wrapped RuntimeError (the import_service.py precedent) — the router's outer try/except already captures once; a second capture in the repository would double-report the same incident to Sentry"

patterns-established:
  - "compose_slots as the reusable slot-arithmetic seam for any future N-way pool mix (Phase 191's schedule surface can read the same 75/25 split for display without re-deriving it)"

requirements-completed: [POOL-07, POOL-01, POOL-03]

coverage:
  - id: D1
    description: "POST /api/train/sessions returns exactly N puzzles at the 75/25 split (9 SR / 3 herrings for the default N=12) whenever enough material exists on both sides"
    requirement: "POOL-07"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::TestComposeSlots::test_compose_slots_sums_to_n"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::TestComposeSlots::test_compose_slots_default_n_is_nine_three"
        status: pass
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_full_session_is_nine_sr_and_three_herrings"
        status: pass
    human_judgment: false
  - id: D2
    description: "Honest cross-backfill: when one source (SR or herrings) comes up short, the other fills the gap so the session still reaches N whenever total material exists"
    requirement: "POOL-07"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_sr_shortfall_backfills_with_herrings"
        status: pass
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_herring_shortfall_backfills_with_sr"
        status: pass
    human_judgment: false
  - id: D3
    description: "SR padding pulls fresh qualifying flaws not yet tracked as drill_items, most-recently-played games first, creating a new streak-0 due-today drill_items row per pick"
    requirement: "POOL-07"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_padding_introduces_new_drill_items_recency_first"
        status: pass
    human_judgment: false
  - id: D4
    description: "A user with zero drillable material gets an empty puzzle list and no drill_sessions row is written"
    requirement: "POOL-07"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_empty_pool_writes_no_session_row"
        status: pass
    human_judgment: false
  - id: D5
    description: "blob_pending_count reports own blunders still waiting on tier-4 analysis, distinguishing a backfill-thin session from a genuinely exhausted pool (Pitfall 4)"
    requirement: "POOL-07"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_blob_pending_count_reports_waiting_flaws"
        status: pass
    human_judgment: false
  - id: D6
    description: "D-12: a second compose call inside an open session's window resumes it — same session_id, same frozen puzzle order, only not-yet-attempted puzzles returned"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_second_compose_resumes_open_session"
        status: pass
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_frozen_order_is_stable_across_resumes"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_compose_twice_returns_same_session_id"
        status: pass
    human_judgment: false
  - id: D7
    description: "D-11: an expired session is marked expired on the next composition call; recorded solves are kept, unsolved items' due_date is untouched, no leftover puzzle list carries over"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_expired_session_is_marked_and_recomposed"
        status: pass
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_expired_session_keeps_recorded_solves"
        status: pass
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_unsolved_items_stay_due_after_expiry"
        status: pass
    human_judgment: false
  - id: D8
    description: "D-02 lazy eviction on resume: a puzzle whose backing game_flaws row vanished under reclassification is skipped (not served, not deleted); the session's frozen puzzle_count is unchanged"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_evicted_item_is_skipped_on_resume"
        status: pass
    human_judgment: false
  - id: D9
    description: "T-189-14: two concurrent POST /api/train/sessions calls for the same user leave at most one open drill_sessions row; the race loser resumes the winner's session via the uq_drill_sessions_user_open partial unique index rather than erroring"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py::test_concurrent_compose_yields_one_open_session"
        status: pass
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_integrity_error_race_resumes_winner_session"
        status: pass
    human_judgment: false

# Metrics
duration: 45min
completed: 2026-07-25
status: complete
---

# Phase 189 Plan 04: Full POOL-07 Session Composition + Lifecycle Summary

**Widens the tracer's SR-only composition to the full 75/25 SR/herring mix with honest cross-backfill and a thin-pool signal, then layers D-09/D-10/D-11/D-12 session resume/expiry/eviction on top, with a deterministically-forced-race test proving the concurrency guard is load-bearing**

## Performance

- **Duration:** ~45 min
- **Completed:** 2026-07-25
- **Tasks:** 2 (Task 1 auto, Task 2 auto)
- **Files modified:** 5 (1 created, 4 modified)

## Accomplishments

- `compose_slots(n)` in `train_pool.py` — pure `(sr_slots, herring_slots)` split at `HERRING_SHARE`, SR side absorbing the rounding remainder; `blob_pending_stmt` — the own-blunder-count query mirroring `pool_entry_stmt`'s eligibility gate but inverted on the answer-key condition
- `compose_and_materialize_session` widened to the full POOL-07 algorithm: due `drill_items` first (most-overdue-first), padded from `pool_entry_stmt` up to `sr_slots` (recency-first, new `DrillItem` rows at streak 0 due today), `herring_stmt` up to `herring_slots` with an `exclude_served=False` exhaustion fallback, and an honest cross-backfill step so a lopsided pool still reaches N whenever enough total material exists
- Deterministic `(user_id, session_date)`-seeded shuffle (D-09) before materializing the `DrillSession` + one pre-inserted `DrillSolve` per puzzle
- Session lifecycle layer: `expire_stale_sessions` (D-11, touches nothing but `status`), `open_session_for_user` + `load_session_puzzles` (D-12 resume path, `user_id`-scoped against IDOR, lazy-evicts SR puzzles whose backing flaw vanished)
- Race safety: the entire materialize step (padding `DrillItem`s + `DrillSession` + `DrillSolve`s) runs inside one `session.begin_nested()` SAVEPOINT; a concurrent second composition winning `uq_drill_sessions_user_open` raises `IntegrityError`, caught and resolved by resuming the winner's session instead of a 500 (T-189-14)
- 34 new tests (9 repository composition-mix tests including a parametrized `compose_slots` sweep, 8 repository lifecycle tests including a deterministic monkeypatch-forced race test, 2 router tests); full backend suite (3739 tests) green; `ty`/`ruff` clean

## Task Commits

1. **Task 1: 75/25 composition with honest backfill and a thin-pool signal** - `a179eedd` (feat)
2. **Task 2: Session lifecycle — resume, expire, freeze, evict** - `8113a19c` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified

- `app/services/train_pool.py` — added `compose_slots` (Task 1), `blob_pending_stmt` (Task 1)
- `app/repositories/train_repository.py` — widened `compose_and_materialize_session` to the full mix + cross-backfill (Task 1), then to the full lifecycle (Task 2); added `expire_stale_sessions`, `open_session_for_user`, `load_session_puzzles`, `_resume_open_session` (Task 2)
- `app/schemas/train.py` — extended `TrainSessionResponse`'s class docstring with the explicit `puzzle_count < requested_count` → read `blob_pending_count` contract (no field changes; both fields already existed from Plan 01)
- `tests/repositories/test_train_repository.py` — new file: `TestComposeSlots` (21 parametrized + 1), 6 composition-mix tests, 8 lifecycle tests
- `tests/routers/test_train.py` — added `test_compose_twice_returns_same_session_id`, `test_concurrent_compose_yields_one_open_session`

## Decisions Made

- `blob_pending_stmt` added to `train_pool.py` as a proper exported query-builder (mirroring `pool_entry_stmt`/`herring_stmt`'s convention) rather than reaching into `train_pool`'s private `_SEVERITY_BLUNDER` constant from `train_repository.py` — a natural, in-scope implementation detail of Task 1's explicit `blob_pending_count` requirement, not literally named in the plan's function inventory
- Cross-backfill uses `if/elif` (SR-short checked before herring-short) rather than two independent `if`s — simpler and sufficient for the plan's specified shortfall scenarios; when both sides are simultaneously exhausted, extending either branch would find no material anyway
- The whole materialize step (new `drill_items` + `DrillSession` + `DrillSolve`s) shares ONE `session.begin_nested()` SAVEPOINT rather than wrapping only the `DrillSession` insert — a concurrent padding-scan collision on a `drill_items` primary key is the same underlying race as the `drill_sessions` unique-index collision, so both are resolved by the same `except IntegrityError` → resume branch
- The IntegrityError-fallback's defensive `resumed is None` branch does a bare `raise` rather than a second `sentry_sdk.capture_exception` (unlike `imports.py`'s precedent) — the router's outer `except Exception` already captures once; double-capturing the same incident would be redundant
- Marked only **POOL-07** complete via `requirements.mark-complete` (this plan's headline deliverable — "a session-composition endpoint returns exactly N puzzles..."). Left **POOL-01** `[ ]` Pending per Plan 01's own decision note: POOL-01 is shared across Plans 01/04/05 and its "carries a stored answer key" clause isn't fully served until Plan 05's solve/reveal endpoints actually expose `best_move`/`pv` at solve time — Plan 05 is the last contributing plan that closes it. **POOL-03** was already `[x]` Complete from Plan 03.

## Deviations from Plan

None — plan executed as written. `TrainSessionResponse`'s `requested_count`/`blob_pending_count` fields turned out to already exist from Plan 01 (that plan's `ComposedSession` dataclass and schema were pre-widened in anticipation); this plan only needed to extend the docstring and wire real values into them, which the acceptance criteria already anticipated ("app/schemas/train.py TrainSessionResponse declares both...").

## Issues Encountered

- **Mutation-test gap caught during self-verification (not a plan gap):** the initial `test_concurrent_compose_yields_one_open_session` router test (two `httpx.AsyncClient`s + `asyncio.gather`) passed even when the `except IntegrityError` fallback was deliberately removed — the two requests weren't reliably interleaving at the exact race window in this test environment, so the test wasn't proving the concurrency guard was load-bearing. Added `test_integrity_error_race_resumes_winner_session`, which deterministically forces the race by monkeypatching `open_session_for_user`'s first call to miss an already-seeded winner session, so the real `DrillSession` insert genuinely collides on `uq_drill_sessions_user_open`. Reverting the fix now correctly fails this test (confirmed via manual revert-and-rerun before restoring); the async-client test is kept as an additional (non-deterministic but still useful) integration check.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Full POOL-07 composition (mix, backfill, thin-pool signal) and the D-09/D-10/D-11/D-12 lifecycle are in place for Plan 05 (solve/reveal endpoints) and Phase 190 (the frontend solve loop, which drives this same `POST /api/train/sessions` endpoint on every session start and resume).
- `compose_slots` is ready for Phase 191's schedule/progress surface to display the 9/3 split without re-deriving it.
- No blockers.

---
*Phase: 189-pool-scheduler-backend*
*Completed: 2026-07-25*

## Self-Check: PASSED

All 5 created/modified files verified present; both task commits (`a179eedd`, `8113a19c`) verified in git log.
