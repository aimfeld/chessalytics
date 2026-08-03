---
phase: 201-push-infrastructure-train-reminders
plan: 03
subsystem: api
tags: [train, alembic, sqlalchemy, pydantic, fastapi]

# Dependency graph
requires:
  - phase: 201-01
    provides: "push_subscriptions table + push send chain (this plan's migration chains off 201-01's e02dc5378c12 head)"
provides:
  - "train_settings.reminder_enabled / reminder_hour / reminder_last_sent_on columns + ck_train_settings_reminder_hour CHECK constraint"
  - "DEFAULT_REMINDER_ENABLED / DEFAULT_REMINDER_HOUR / REMINDER_HOUR_MIN / REMINDER_HOUR_MAX constants in train_scheduler.py"
  - "TrainSettingsRow / get_settings / get_or_create_settings / upsert_settings carrying the three reminder fields"
  - "GET/PUT /api/train/settings exposing reminder_enabled/reminder_hour (D-18)"
affects: [201-04]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 8400
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Nullable-Date watermark column (reminder_last_sent_on mirrors streak_settled_through) written only by a future background job, never by the settings PUT path"
    - "SmallInteger + range CheckConstraint for a bounded local-hour integer (reminder_hour mirrors shield_level), Pydantic Field bound derived from the same named constants as the DB CHECK"

key-files:
  created:
    - alembic/versions/20260801_225358_ca8c8fbc2080_phase_201_train_reminder_columns.py
  modified:
    - app/models/train_settings.py
    - app/services/train_scheduler.py
    - app/repositories/train_repository.py
    - app/schemas/train.py
    - app/routers/train.py
    - tests/repositories/test_train_repository.py
    - tests/routers/test_train.py

key-decisions:
  - "reminder_last_sent_on is included in upsert_settings' RETURNING clause but deliberately absent from its values(...) and ON CONFLICT DO UPDATE set_ dict, matching the existing streak_count/shield_level pattern for job-owned columns the settings UPSERT must never write."
  - "Updated all 16 pre-existing upsert_settings call sites in tests/repositories/test_train_repository.py with the two new required keyword args (reminder_enabled=False, reminder_hour=18) rather than making them optional with defaults on the repository function itself — the router/API layer is the only caller that should ever omit an explicit reminder_enabled from user intent, and it doesn't (body.reminder_enabled is always required)."

patterns-established:
  - "Job-owned watermark column: absent from both the Pydantic update schema and the response schema, included only in a repository function's RETURNING clause, with a named test asserting an unrelated write leaves it byte-identical."

requirements-completed: [REMIND-01]

coverage:
  - id: D1
    description: "train_settings carries reminder_enabled (default false), reminder_hour (default 18, constrained 0-23) and reminder_last_sent_on (nullable date), applied at the application layer through get_or_create_settings exactly the way weekday_mask and puzzles_per_session already are"
    requirement: "REMIND-01"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py#test_get_or_create_settings_reminder_defaults"
        status: pass
      - kind: integration
        ref: "tests/repositories/test_train_repository.py#test_get_settings_reminder_defaults_from_raw_insert"
        status: pass
      - kind: integration
        ref: "tests/repositories/test_train_repository.py#test_upsert_settings_persists_reminder_fields"
        status: pass
    human_judgment: false
  - id: D2
    description: "A user who has never touched Train settings gets reminder_enabled false and reminder_hour 18 on their first GET /api/train/settings, without any migration-time backfill"
    requirement: "REMIND-01"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py#test_get_settings_creates_defaults_on_first_touch"
        status: pass
    human_judgment: false
  - id: D3
    description: "GET and PUT /api/train/settings both read and write reminder_enabled and reminder_hour, so the whole reminder configuration is exercisable with curl before any UI exists (D-18)"
    requirement: "REMIND-01"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py#test_put_settings_persists_and_round_trips"
        status: pass
    human_judgment: false
  - id: D4
    description: "PUT /api/train/settings with reminder_hour outside 0-23 is rejected with 422 by Pydantic before any SQL runs, and the same bound is enforced independently by the ck_train_settings_reminder_hour CHECK constraint"
    requirement: "REMIND-01"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py#test_put_settings_rejects_out_of_range_reminder_hour_422"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#test_reminder_hour_check_constraint_rejects_out_of_range"
        status: pass
    human_judgment: false
  - id: D5
    description: "reminder_last_sent_on is job-owned: absent from PUT/GET wire schemas, and upsert_settings never changes its stored value"
    requirement: "REMIND-01"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#test_upsert_settings_leaves_reminder_last_sent_on_unchanged"
        status: pass
    human_judgment: false
  - id: D6
    description: "Adding the three columns leaves every existing train_settings row valid via server defaults, no migration backfill; the guest gate still blocks a guest from setting reminder_enabled=True through the API"
    requirement: "REMIND-01"
    verification:
      - kind: unit
        ref: "migration round-trip: uv run alembic upgrade head && uv run alembic downgrade -1 && uv run alembic upgrade head"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py#test_settings_403_guest"
        status: pass
    human_judgment: false

# Metrics
duration: 15min
completed: 2026-08-02
status: complete
---

# Phase 201 Plan 03: Train Reminder Configuration Summary

**`reminder_enabled`/`reminder_hour`/`reminder_last_sent_on` land on `train_settings` via a hand-written Alembic revision chained off plan 201-01, defaulted through `get_or_create_settings` and round-tripped through `GET`/`PUT /api/train/settings` — the whole reminder surface is curl-testable before Phase 202 writes any UI.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-08-02
- **Tasks:** 3
- **Files modified:** 8 (1 created, 7 modified)

## Accomplishments
- New Alembic revision `ca8c8fbc2080` (down_revision `e02dc5378c12`, plan 201-01's head) adds `reminder_enabled` (Boolean, default false), `reminder_hour` (SmallInteger, default 18) and `reminder_last_sent_on` (nullable Date) plus `ck_train_settings_reminder_hour` — no backfill, reversible round-trip verified
- `TrainSettings` model gains the three fields, mirroring `streak_settled_through`'s nullable-Date-watermark shape and `shield_level`'s SmallInteger+CHECK shape exactly
- `DEFAULT_REMINDER_ENABLED` / `DEFAULT_REMINDER_HOUR` / `REMINDER_HOUR_MIN` / `REMINDER_HOUR_MAX` added to `train_scheduler.py` as the single source of truth the model's CHECK, the repository's create-on-first-touch INSERT, and the Pydantic `Field` bound all derive from
- `TrainSettingsRow`, `get_settings`, `get_or_create_settings` and `upsert_settings` carry the three fields; `upsert_settings` gained `reminder_enabled`/`reminder_hour` keyword-only parameters and structurally cannot write `reminder_last_sent_on` (absent from both `values(...)` and the `ON CONFLICT DO UPDATE` `set_` dict, present only in `RETURNING`)
- `TrainSettingsResponse`/`TrainSettingsUpdate` gain `reminder_enabled`/`reminder_hour`, with the Pydantic bound derived from the shared constants; `reminder_last_sent_on` is absent from both schemas
- `GET`/`PUT /api/train/settings` round-trip both fields; the guest gate (`_reject_guest`) is unchanged and still blocks a guest from ever setting `reminder_enabled=True`
- 5 new repository-level tests (`-k reminder`) plus 1 new router test covering: first-touch defaults from both `get_or_create_settings` and a raw-INSERT row, `upsert_settings` persisting the fields, the job-owned-watermark invariant (a settings PUT leaves an existing `reminder_last_sent_on` byte-identical), the DB CHECK constraint firing independently of Pydantic, and 422 on both `reminder_hour` boundaries (24 and -1)

## Task Commits

Each task was committed atomically:

1. **Task 1: Migration and model columns for the reminder configuration** - `7b66d2439` (feat)
2. **Task 2: Carry the reminder fields through the repository, schemas and Train settings API** - `881aebb57` (feat)
3. **Task 3: Tests for the reminder defaults, bounds, round-trip and job-owned column** - `4f78ff5bb` (test)

## Files Created/Modified
- `alembic/versions/20260801_225358_ca8c8fbc2080_phase_201_train_reminder_columns.py` - the three-column migration, `down_revision='e02dc5378c12'`
- `app/models/train_settings.py` - `reminder_enabled`/`reminder_hour`/`reminder_last_sent_on` fields + `ck_train_settings_reminder_hour`
- `app/services/train_scheduler.py` - the four new named constants
- `app/repositories/train_repository.py` - `TrainSettingsRow`, `get_settings`, `get_or_create_settings`, `upsert_settings` (two new keyword-only params), plus the `_stamp_pool_eligibility` re-fabrication site in `get_progress`
- `app/schemas/train.py` - `TrainSettingsResponse`/`TrainSettingsUpdate` gain the two client-facing fields
- `app/routers/train.py` - `get_train_settings`/`update_train_settings` read/write the two fields
- `tests/repositories/test_train_repository.py` - 5 new `reminder`-named tests + 16 pre-existing `upsert_settings` call sites updated with the two new required kwargs
- `tests/routers/test_train.py` - 1 new 422-boundary test, extended `_put_settings` helper, updated 2 exact-equality JSON assertions, extended module docstring

## Decisions Made
- `reminder_last_sent_on` is included in `upsert_settings`' `RETURNING` clause (so the returned row reflects reality) but never in its `values(...)`/`set_` — matches the existing pattern for `streak_count`/`shield_level`/`pool_eligible_since`, all of which have a single other writer.
- Kept `upsert_settings`' two new parameters required (not defaulted) — the router always supplies them from the validated request body, so there's no legitimate caller that should silently fall back to a default; test call sites were updated explicitly instead.

## Deviations from Plan

None - plan executed exactly as written. The mechanical updates to 16 pre-existing `upsert_settings` test call sites and 2 exact-equality JSON assertions in `test_train.py` were anticipated by the plan (`tests/repositories/test_train_repository.py` and `tests/routers/test_train.py` are both listed in `files_modified`) and required to keep the pre-existing suite green through the signature/schema change — not scope creep.

## Issues Encountered
None.

## User Setup Required
None for this plan.

## Next Phase Readiness
- Plan 201-04's scheduler can read `reminder_enabled`/`reminder_hour` off the row it already loads via `get_or_create_settings`, and claim the day via a conditional UPDATE on `reminder_last_sent_on` (D-07) — the column already exists, is bounded, and is proven never written by the settings path.
- `GET`/`PUT /api/train/settings` are curl-testable end to end today, ahead of Phase 202's UI.
- No blockers.

---
*Phase: 201-push-infrastructure-train-reminders*
*Completed: 2026-08-02*

## Self-Check: PASSED

All 7 created/modified files verified present on disk; all 3 task commits (`7b66d2439`, `881aebb57`, `4f78ff5bb`) verified present in git history.
