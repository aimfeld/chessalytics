---
phase: 193-session-tick-streak-shield
plan: 01
subsystem: api
tags: [fastapi, sqlalchemy, alembic, react, typescript, tanstack-query]

# Dependency graph
requires:
  - phase: 191-schedule-progress-surface
    provides: the weekly FlameState/settle_weeks settlement machine this plan replaces, plus the dev-clock tooling (app/core/dev_clock.py, scripts/reset_train_state.py) used to test calendar-shaped behavior
  - phase: 189-pool-scheduler-backend
    provides: local_today / next_scheduled_day / session_window / is_session_expired — the day-boundary primitives the new tick machine reuses unchanged
provides:
  - "SHIELD_CAP / is_scheduled_day / scheduled_days_per_week / TickSnapshot / TickView / DayOutcome / _judge_one_day / tick_days in app/services/train_scheduler.py — the per-day tick state machine"
  - "train_settings.shield_level (SmallInteger, CHECK 0-7) and train_settings.pool_eligible_since (nullable Date, D-06 watermark) columns, replacing flame_state"
  - "TrainProgressResponse.session_streak_count / .shield_level / .streak_reset_notice wire fields"
  - "_material_flags / _stamp_pool_eligibility in app/repositories/train_repository.py — the D-06 watermark stamping mechanism"
  - "ShieldMeter / pipBandColor / SHIELD_PIP_COUNT in TrainProgressRow.tsx — the 7-segment pip meter component"
  - "TRAIN_SHIELD_PIP_LOW/MEDIUM/HIGH theme constants"
affects: [193-02-eager-tick-and-badge, 193-03-if-any-follow-on-train-work]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Four-value DayOutcome discriminant (fulfilled/missed/neutral/credit_only) instead of a (fulfilled, eligible) boolean pair, so one shared _judge_one_day primitive can express both the lazy day-walk AND a later eager off-day/late-completion credit without re-deriving the SHIELD_CAP clamp"
    - "Elapsed-day boundary via is_session_expired(session_window(day, weekday_mask), today) — never a bare day < today comparison — collapses correctly to the naive boundary for dense masks while generalizing correctly for sparse ones"

key-files:
  created:
    - alembic/versions/20260728_055940_f2624e60292e_phase_193_session_tick_shield.py
  modified:
    - app/services/train_scheduler.py
    - app/models/train_settings.py
    - app/repositories/train_repository.py
    - app/schemas/train.py
    - app/routers/train.py
    - tests/services/test_train_scheduler.py
    - tests/repositories/test_train_repository.py
    - tests/routers/test_train.py
    - tests/scripts/test_reset_train_state.py
    - scripts/reset_train_state.py
    - frontend/src/lib/theme.ts
    - frontend/src/types/train.ts
    - frontend/src/components/train/TrainProgressRow.tsx
    - frontend/src/components/train/__tests__/TrainProgressRow.test.tsx
    - frontend/src/components/train/__tests__/TrainStartScreen.test.tsx

key-decisions:
  - "Task 1 checkpoint (user ruling, verbatim: 'streaks haven't shipped. do a hard reset, we lose nothing.'): option-b — hard reset with NO data backfill, pool_eligible_since stays nullable and lazily stamped go-forward (not NOT NULL DEFAULT today). This is a conscious, recorded D-05 (Phase 191 retroactivity) waiver, not a silent regression — see Deviations below."
  - "Multi-week settle-before-mutate test scenario (test_settings_update_settles_with_old_mask_first) redesigned onto a Monday-only OLD mask rather than the original weekly-bucketed 3-session scenario, so per-day judgment has no intervening misses between the three sessions — preserves the test's INTENT (old-schedule settlement before a mutation) under the new per-day semantics"

patterns-established:
  - "DayOutcome discriminant pattern: any future settlement caller (eager tick, off-day credit) routes through _judge_one_day rather than re-deriving shield/count arithmetic — a divergence gate (single occurrence of `min(...SHIELD_CAP)` in app/) enforces this"

requirements-completed: [PROG-01]

coverage:
  - id: D1
    description: "A missed scheduled day drains exactly one shield pip (floored at 0), and shield reaching 0 resets the persisted streak_count to 0"
    requirement: "PROG-01"
    verification:
      - kind: unit
        ref: "tests/services/test_train_scheduler.py::TestJudgeOneDay::test_missed_drains_one_pip_floored_at_zero_and_resets_count_at_zero"
        status: pass
      - kind: unit
        ref: "tests/services/test_train_scheduler.py::TestTickDays::test_sparse_mask_boundary_judged_once_window_closes"
        status: pass
    human_judgment: false
  - id: D2
    description: "streak_reset_notice is derived from resulting state (not from 'did this call settle the reset') so it survives a reload"
    requirement: "PROG-01"
    verification:
      - kind: unit
        ref: "tests/services/test_train_scheduler.py::TestTickDaysStreakResetNotice::test_true_only_when_shield_and_count_are_zero_and_history_exists"
        status: pass
    human_judgment: false
  - id: D3
    description: "A scheduled day before pool_eligible_since is neutral (no drain, no tick) but still advances streak_settled_through"
    requirement: "PROG-01"
    verification:
      - kind: unit
        ref: "tests/services/test_train_scheduler.py::TestTickDays::test_watermark_neutral_strictly_before_judged_on_or_after"
        status: pass
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::TestStampPoolEligibility::test_null_watermark_produces_no_shield_change_across_elapsed_scheduled_days"
        status: pass
    human_judgment: false
  - id: D4
    description: "A settled day is frozen forever — the settle walk only ever starts strictly after streak_settled_through"
    requirement: "PROG-01"
    verification:
      - kind: unit
        ref: "tests/services/test_train_scheduler.py::TestTickDays::test_never_walks_a_day_at_or_before_settled_through"
        status: pass
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_settled_day_survives_mask_change"
        status: pass
    human_judgment: false
  - id: D5
    description: "Sparse-mask elapsed-day boundary via is_session_expired(session_window(...)), never a bare day < today (RESEARCH.md Pitfall 1)"
    requirement: "PROG-01"
    verification:
      - kind: unit
        ref: "tests/services/test_train_scheduler.py::TestTickDays::test_sparse_mask_boundary_not_judged_before_window_closes"
        status: pass
      - kind: unit
        ref: "tests/services/test_train_scheduler.py::TestTickDays::test_sparse_mask_boundary_judged_once_window_closes"
        status: pass
    human_judgment: false
  - id: D6
    description: "The Train stats row renders a 7-segment shield pip meter and an always-visible '{N}-session streak' label"
    requirement: "PROG-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainProgressRow.test.tsx (shield pip meter (E1) / streak count label (E2) describe blocks)"
        status: pass
    human_judgment: false
  - id: D7
    description: "Migration applies cleanly and is schema-reversible; new columns match the locked shape"
    verification:
      - kind: other
        ref: "uv run alembic upgrade head && uv run alembic downgrade -1 && uv run alembic upgrade head; psql \\d train_settings"
        status: pass
    human_judgment: false

duration: ~18min (Task 2-4 execution span; excludes the Task 1 checkpoint wait)
completed: 2026-07-28
status: complete
---

# Phase 193 Plan 01: Session-Tick Streaks with a Depletable Shield Summary

**Per-day tick + 0-7 depletable shield replaces Phase 191's weekly settlement machine end to end — new `shield_level`/`pool_eligible_since` columns, a `tick_days`/`_judge_one_day` pure state machine, the rewritten `GET /train/progress` payload, and a 7-segment pip meter rendering it.**

## Performance

- **Duration:** ~18 min (Task 2 through Task 4; the Task 1 `checkpoint:decision` paused execution for a coordinator round-trip, not counted)
- **Started:** 2026-07-28T06:06:59Z (Task 2 commit)
- **Completed:** 2026-07-28T06:24:16Z (Task 4 commit)
- **Tasks:** 4 (1 checkpoint:decision + 3 executed)
- **Files modified:** 15 (1 new migration, 14 modified)

## Accomplishments
- Deleted Phase 191's weekly `FlameState`/`settle_weeks` machine and replaced it with a pure per-scheduled-day tick (`tick_days`) built on a single shared arithmetic primitive (`_judge_one_day`) driven by a four-value `DayOutcome` discriminant, so the shield-credit clamp is typed exactly once in the whole backend (enforced by a grep divergence gate).
- New `shield_level` (SmallInteger, CHECK 0-7) and `pool_eligible_since` (nullable Date, D-06 watermark) columns on `train_settings`, via one Alembic migration that also executes the Task 1 checkpoint decision (hard reset, no backfill).
- Rewired `settle_streak_snapshot`/`get_progress` onto the new tick machine, adding `_material_flags`/`_stamp_pool_eligibility` for the D-06 watermark-stamping mechanism (stamped once, in the same transaction that discovers material).
- Rewrote `TrainProgressResponse` (`session_streak_count`, `shield_level`, `streak_reset_notice`) and the `TrainProgressRow.tsx` component with a 7-segment pip meter (`ShieldMeter`, `pipBandColor`, `data-testid="train-shield-meter"`/`"train-shield-pip"`), replacing the single `lucide-react` `Flame` icon.
- Reworked the entire backend test suite for the new field names and per-day semantics (not a mechanical rename — several multi-week scenarios needed redesigning onto the new day-granularity model), plus a new `TestStampPoolEligibility` class.

## Task Commits

Each task was committed atomically:

1. **Task 1: Decide the carry-over treatment of Phase 191's streak columns** — `checkpoint:decision`, resolved by coordinator ruling (option-b), no code commit of its own.
2. **Task 2: Tracer — one scheduled day ticks from column to wire** - `6bd31082` (feat)
3. **Task 3: Shield pip meter, streak label, and reset notice (D-01/D-02/D-04)** - `2f170b8e` (feat)
4. **Task 4: Rework every test that pins the deleted weekly/flame behavior** - `16234ba6` (test)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified
- `alembic/versions/20260728_055940_f2624e60292e_phase_193_session_tick_shield.py` - the Phase 193 migration (drop `flame_state`+CHECK, add `shield_level`+CHECK, add `pool_eligible_since`, hard-reset carry-over columns, D-05 waiver documented in module docstring)
- `app/services/train_scheduler.py` - `SHIELD_CAP`, `is_scheduled_day`, `scheduled_days_per_week`, `TickSnapshot`, `TickView`, `DayOutcome`, `_judge_one_day`, `tick_days`; deleted `FlameState`/`FLAME_LADDER`/`_flame_up`/`_flame_down`/`required_sessions_per_week`/`SettledStreak`/`StreakView`/`_settle_one_week`/`settle_weeks`
- `app/models/train_settings.py` - `shield_level` + `ck_train_settings_shield_level`; `pool_eligible_since`
- `app/repositories/train_repository.py` - `TrainSettingsRow`/`ProgressSnapshot` field renames; `_material_flags`, `_stamp_pool_eligibility`; `settle_streak_snapshot` rewired onto `tick_days`; `get_progress` reordered per D-06; `_pool_state` now takes the two material flags as parameters
- `app/schemas/train.py`, `app/routers/train.py` - `TrainProgressResponse` field renames, no structural change
- `frontend/src/lib/theme.ts` - `TRAIN_SHIELD_PIP_LOW/MEDIUM/HIGH` replacing `TRAIN_STREAK_FLAME_MINIMUM/MEDIUM/MAXIMUM`
- `frontend/src/types/train.ts` - `TrainFlameState` deleted; `TrainProgressResponse` field renames
- `frontend/src/components/train/TrainProgressRow.tsx` - `ShieldMeter`/`pipBandColor`/`SHIELD_PIP_COUNT`; unconditional streak label (D-04); reworded reset notice
- `tests/services/test_train_scheduler.py`, `tests/repositories/test_train_repository.py`, `tests/routers/test_train.py`, `tests/scripts/test_reset_train_state.py`, `scripts/reset_train_state.py`, `frontend/src/components/train/__tests__/TrainProgressRow.test.tsx`, `frontend/src/components/train/__tests__/TrainStartScreen.test.tsx` - test/tooling rework for the new model

## Decisions Made

- **Task 1 checkpoint — option-b (hard reset, no backfill).** Coordinator ruling, verbatim: *"streaks haven't shipped. do a hard reset, we lose nothing."* Implemented per the coordinator's two clarifications: (1) no `MIN(drill_items.created_at ...)` backfill statement in the migration; (2) `pool_eligible_since` stays `DATE NULL` (not `NOT NULL DEFAULT today`) — the lazy-stamp path is D-06's intended go-forward mechanism for every user, existing or new, not just a migration artifact.
- **D-05 (Phase 191 retroactivity) waiver — recorded, not silent.** Phase 190 *did* ship (release #280), so the ~14 existing `drill_sessions` rows this reset discards from replay are real usage, not phantom rows. What did not ship is Phase 191's streak surface (the thing being rewritten). The waiver rests on the data being trivial in volume (13 `train_settings` rows) and being the developer's own pre-production data, not on the sessions being fictional. This is recorded in three places: the migration's module docstring, this Decisions section, and (per the coordinator's instruction) here explicitly as a citation of the user ruling above.
- **Multi-week settle-before-mutate test scenario redesigned.** `test_settings_update_settles_with_old_mask_first` originally seeded 3 sessions across 3 weeks under a dense/every-day-scheduled mask, relying on the old weekly-bucket model's "1 session/week required" special case. Under the new per-day model with a dense mask, the days *between* those sessions would register as misses and drain the shield before the third session — a real behavior difference, not a test bug. Redesigned onto a Monday-only OLD mask so the three sessions are the *only* scheduled days between them, preserving the test's actual intent (settle-before-mutate uses the OLD schedule) under correct new semantics.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed `frontend/src/components/train/__tests__/TrainStartScreen.test.tsx`'s stale mock object**
- **Found during:** Task 3 (frontend pip meter) — `npx tsc -b` verification step
- **Issue:** This file is not in the plan's `files_modified` list, but its `DEFAULT_TRAIN_PROGRESS` mock object used the old field names (`settled_streak_weeks`, `flame_state`, `streak_lost_last_week`). Once `TrainProgressResponse`'s shape changed, `tsc -b` failed on this file — a direct, unavoidable fallout of the type rename, not a pre-existing issue.
- **Fix:** Renamed the three fields in the mock object to match the new `TrainProgressResponse` shape.
- **Files modified:** `frontend/src/components/train/__tests__/TrainStartScreen.test.tsx`
- **Verification:** `npx tsc -b` clean; `npx vitest run src/components/train src/App.test.tsx` — 171/171 passed.
- **Committed in:** `2f170b8e` (Task 3 commit)

**2. [Rule 1 - Bug] Docstring literal tripped the FlameState grep acceptance gate**
- **Found during:** Task 4 — acceptance-criteria verification (`No test file references a three-state flame value`)
- **Issue:** `tests/services/test_train_scheduler.py`'s module docstring referenced the deleted `FlameState` symbol by name (as prose explaining what was replaced), which the acceptance criterion's literal `"FlameState" in file` grep correctly flagged.
- **Fix:** Reworded the docstring to describe the deleted symbol without using its literal name ("the deleted 3-state flame enum").
- **Files modified:** `tests/services/test_train_scheduler.py`
- **Verification:** `uv run python -c "...bad=[p for p in pathlib.Path('tests').rglob('*.py') if 'FlameState' in p.read_text()]; assert not bad"` exits 0.
- **Committed in:** `16234ba6` (Task 4 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking build fix, 1 docstring/acceptance-gate fix)
**Impact on plan:** Both fixes are necessary side effects of the type/symbol renames this plan performs by design. No scope creep — no functionality beyond the plan's stated scope was added.

## Issues Encountered

- **Test redesign complexity (not a bug, a modeling consequence):** several `tests/repositories/test_train_repository.py` scenarios originally used sessions dated ~10 days before "now" under a dense (every-day) mask — sensible under the old weekly-bucket model (one settled week, one requirement) but semantically wrong under the new per-day model (9+ intervening missed days would drain the shield to 0 before the test's assertions ran). Resolved by moving single-day scenarios to "yesterday" (`_PROGRESS_YESTERDAY`) so only one day is walked, and redesigning the multi-session scenario onto a sparse Monday-only mask (see Decisions above). This is flagged here because it is exactly the kind of "scenario replaced, not dropped" rework Task 4's `<action>` anticipated — not a shortcut.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The tracer contract is proven end to end: one scheduled day ticks correctly from the `shield_level`/`pool_eligible_since` columns through `tick_days`/`_judge_one_day`, through `settle_streak_snapshot`/`get_progress`, through `TrainProgressResponse`, to the rendered `ShieldMeter`.
- `_judge_one_day`'s `DayOutcome` discriminant already includes `"credit_only"` (unused by this plan's lazy-only `tick_days` caller) — Plan 02's eager off-day/late-completion credit path can call it directly with no re-derivation.
- `_material_flags`/`_stamp_pool_eligibility` are in place and tested — Plan 02's eager-tick caller inside `record_solve` can reuse `get_or_create_settings`'s already-resolved `pool_eligible_since` without a second stamp site.
- Full backend suite (3880 passed, 18 skipped) and frontend suite (171/171 in the touched dirs) green; `ruff format`/`ruff check`/`ty check app/ tests/` clean; migration round-trips (`upgrade head` / `downgrade -1` / `upgrade head`).
- Not yet done (explicitly out of scope for Plan 01, per the plan's `<objective>`): D-03's eager tick on session completion, D-07's off-day credit, D-09/D-10's nav-badge visibility — these land in Plan 02/03.

---
*Phase: 193-session-tick-streak-shield*
*Completed: 2026-07-28*
