---
phase: 203-pwa-install-re-prompting-train-anchored-install-offer
plan: 01
subsystem: api
tags: [fastapi, sqlalchemy, alembic, pydantic, react, tanstack-query, train-settings]

# Dependency graph
requires:
  - phase: 201-push-infrastructure-and-train-reminders
    provides: train_settings table with reminder_enabled/reminder_hour/reminder_last_sent_on and the full-replace GET/PUT /train/settings contract this plan extends
provides:
  - "reminder_intent_at nullable timestamptz column on train_settings (client-writable, no backfill)"
  - "Widened TrainSettingsResponse/TrainSettingsUpdate (backend) and TrainSettingsResponse/TrainSettingsUpdate/TrainSettingsDraft (frontend) carrying reminder_intent_at end to end"
  - "Both existing PUT call sites (TrainReminderButton.handleClick, TrainScheduleSettings debounced save) echo the current server reminder_intent_at value"
  - "Proven full-replace loud-failure contract: an omitted reminder_intent_at key 422s rather than silently clearing a previously-set intent"
affects: [203-02-plan, 203-03-plan, 203-04-plan]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
# Same estimateTokens scale (chars/4 over the realized diff), never a harness token count.
actuals:
  tokens: 8000
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Mechanical field-threading repeat: a new full-replace-PUT field touches model, migration, both Pydantic schemas, repository dataclass + 3 upsert sites, router's 2 explicit constructors, frontend types + hook + N call sites, in that fixed order"
    - "Required-but-nullable Pydantic field (no default) as the mechanism for loud-failure-on-omission in a full-replace PUT contract"

key-files:
  created:
    - alembic/versions/20260802_174733_6e7e50844af5_phase_203_reminder_intent.py
  modified:
    - app/models/train_settings.py
    - app/schemas/train.py
    - app/repositories/train_repository.py
    - app/routers/train.py
    - tests/routers/test_train.py
    - tests/repositories/test_train_repository.py
    - frontend/src/types/train.ts
    - frontend/src/hooks/useTrainSettings.ts
    - frontend/src/components/train/TrainReminderButton.tsx
    - frontend/src/components/train/TrainScheduleSettings.tsx
    - frontend/src/components/train/__tests__/TrainReminderButton.test.tsx
    - frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx

key-decisions:
  - "reminder_intent_at is required-but-nullable on TrainSettingsUpdate (no Pydantic default) so an omitting PUT body 422s instead of silently clearing a previously-recorded install intent — the full-replace contract's loud-failure guarantee (D-02)."
  - "Both existing frontend PUT call sites echo data.reminder_intent_at read from the GET response directly at save time, rather than threading it through TrainScheduleSettings' debounced Draft/seed-effect state — neither call site writes a NEW intent in this plan, only the Plan 04 iOS tap will."
  - "Fixed 18 pre-existing calls to train_repository.upsert_settings in tests/repositories/test_train_repository.py (file not listed in the plan's files_modified) — the new required keyword-only parameter has no default, mirroring the existing reminder_enabled/reminder_hour asymmetry, so every existing caller needed the explicit reminder_intent_at=None kwarg (Rule 3 blocking-issue fix, confirmed at the tracer checkpoint)."

patterns-established:
  - "Full-replace PUT contract: every new client-writable settings field must touch every existing PUT call site in the same commit, verified by re-running the complete settings test suite (not just -k reminder_intent) plus tsc -b"

requirements-completed: []  # OFFER-03/OFFER-05 (this plan's frontmatter) are NOT closed here — this
  # plan only lands the reminder_intent_at backend substrate they depend on. The actual iOS install
  # affordance UI (OFFER-03) and standalone re-surface banner (OFFER-05) are Plan 04, per
  # ROADMAP.md's per-plan breakdown. REQUIREMENTS.md checkboxes deliberately left [ ] Pending,
  # matching the project's established partial-delivery precedent (see STATE.md Decisions,
  # Phase 151-03 MAIA-04 entry).

coverage:
  - id: D1
    description: "reminder_intent_at round-trips through GET/PUT /train/settings: null default, PUT-then-GET echoes an ISO instant exactly, explicit null clears it, and a row created before the migration reads back null"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py#test_put_settings_writes_and_round_trips_reminder_intent_at"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py#test_put_settings_clears_reminder_intent_at"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py#test_get_settings_creates_defaults_on_first_touch"
        status: pass
    human_judgment: false
  - id: D2
    description: "A PUT body omitting the reminder_intent_at key returns 422 — the full-replace contract fails loudly instead of silently clearing a previously-set intent"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py#test_put_settings_rejects_missing_reminder_intent_at_422"
        status: pass
    human_judgment: false
  - id: D3
    description: "Both existing frontend PUT call sites (TrainReminderButton grant path, TrainScheduleSettings debounced save) send the current server reminder_intent_at value, never undefined, and every pre-existing settings save still succeeds"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReminderButton.test.tsx#happy path: press -> grant -> subscribe -> persist -> confirmation names the hour"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx#clicking the Fr chip issues exactly one updateSettings call after the debounce window, with weekday_mask = previous mask + bit 4"
        status: pass
      - kind: other
        ref: "cd frontend && npm run build (tsc -b)"
        status: pass
    human_judgment: false

# Metrics
duration: ~50min (across a tracer checkpoint pause)
completed: 2026-08-02
status: complete
---

# Phase 203 Plan 01: reminder_intent_at Round-Trip Summary

**Client-writable `reminder_intent_at` timestamptz column threaded through the full-replace `GET`/`PUT /train/settings` contract on both backend and frontend, with a required-but-nullable schema field proving the omission-422 loud-failure guarantee.**

## Performance

- **Duration:** ~50 min (Task 1 committed, human-verify tracer checkpoint approved, then Task 2)
- **Started:** 2026-08-02T17:44:00Z
- **Completed:** 2026-08-02T18:06:00Z
- **Tasks:** 2
- **Files modified:** 13 (1 new migration, 12 modified)

## Accomplishments
- `reminder_intent_at` (nullable `DateTime(timezone=True)`) added to `train_settings` via a reversible Alembic migration with no backfill.
- Widened `TrainSettingsResponse`/`TrainSettingsUpdate` (backend Pydantic) and their frontend TS mirrors plus `TrainSettingsDraft`, with `reminder_intent_at` declared required-but-nullable (no default) on the PUT body so an omitting payload 422s instead of silently clearing a prior intent.
- Both existing frontend PUT call sites (`TrainReminderButton.handleClick`, `TrainScheduleSettings`'s debounced save) now echo `data.reminder_intent_at` from the GET response — neither writes a new value in this plan.
- Backend contract tests prove the write-and-round-trip, omit-422, and clear-to-null behaviors; frontend tests prove both call sites' mutation bodies carry the field, not `undefined`.
- Every pre-existing settings test (backend `-k settings`, backend repository suite, both frontend component test files) still passes — the full-replace hazard this plan exists to prove out never fired.

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end reminder_intent_at round-trip — one field through every layer** - `79f3d803d` (feat)
2. **Task 2: Contract tests for the full-replace round-trip** - `3b5793151` (test)

**Plan metadata:** committed in this step (docs: complete plan)

_Note: this plan used `type="tracer" tdd="true"` for Task 1 — the tracer feedback gate paused execution with a `checkpoint:human-verify` immediately after Task 1's commit (interactive run, GSD auto-chain flags both false), which the coordinator approved before Task 2 proceeded._

## Files Created/Modified
- `alembic/versions/20260802_174733_6e7e50844af5_phase_203_reminder_intent.py` - reversible migration adding `reminder_intent_at`
- `app/models/train_settings.py` - `reminder_intent_at: Mapped[datetime.datetime | None]` column + docstring
- `app/schemas/train.py` - `reminder_intent_at` on both `TrainSettingsResponse` and `TrainSettingsUpdate` (required-but-nullable on the latter)
- `app/repositories/train_repository.py` - `TrainSettingsRow` dataclass field, `get_settings`/`get_or_create_settings`/`upsert_settings` (param + `values()` + `set_` dict), and the internal re-construction site in the progress read-model
- `app/routers/train.py` - both explicit `TrainSettingsResponse` constructors (GET, PUT) and the `upsert_settings(...)` call
- `tests/routers/test_train.py` - updated `_put_settings` helper + 2 existing literal-dict assertions, plus 3 new dedicated contract tests
- `tests/repositories/test_train_repository.py` - 18 pre-existing `upsert_settings` call sites given the new required `reminder_intent_at=None` kwarg
- `frontend/src/types/train.ts` - `reminder_intent_at: string | null` on both interfaces
- `frontend/src/hooks/useTrainSettings.ts` - `reminderIntentAt` on `TrainSettingsDraft`, mapped into the PUT body
- `frontend/src/components/train/TrainReminderButton.tsx` - `reminderIntentAt: data.reminder_intent_at` added to the grant-path `save(...)` call
- `frontend/src/components/train/TrainScheduleSettings.tsx` - `reminderIntentAt: data.reminder_intent_at` added to the debounced `save(...)` call
- `frontend/src/components/train/__tests__/TrainReminderButton.test.tsx` - fixture + echo-assertion extension
- `frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx` - fixture + echo-assertion extension

## Decisions Made
- `reminder_intent_at` required-but-nullable on `TrainSettingsUpdate` (D-02) — an omitting PUT body 422s rather than silently clearing a previously-set intent.
- Both frontend call sites echo `data.reminder_intent_at` directly at save time rather than threading it through `TrainScheduleSettings`' debounced `Draft` state — simpler, and correct since neither site writes a new value in this plan.
- 18 pre-existing `tests/repositories/test_train_repository.py::upsert_settings` calls fixed with `reminder_intent_at=None` — a Rule 3 blocking-issue fix (not in the plan's `files_modified`), confirmed acceptable at the tracer checkpoint on the symmetry argument with `reminder_enabled`/`reminder_hour` (also required kwargs with no default).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed 18 pre-existing `upsert_settings` call sites in `tests/repositories/test_train_repository.py`**
- **Found during:** Task 1, after adding `reminder_intent_at` as a required (no-default) keyword parameter on `train_repository.upsert_settings`
- **Issue:** Every existing call to `upsert_settings` in this test file would raise `TypeError: missing required keyword-only argument` at collection/run time — this file is not listed in the plan's `files_modified` but is structurally load-bearing for the change
- **Fix:** Added `reminder_intent_at=None,` immediately after each `reminder_hour=...,` line via a targeted regex substitution, verified by re-reading the diff and running the full 105-test repository suite
- **Files modified:** `tests/repositories/test_train_repository.py`
- **Verification:** `uv run pytest tests/repositories/test_train_repository.py -n auto` — 105 passed
- **Committed in:** `79f3d803d` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary for correctness — the alternative (adding it to the plan's `files_modified` retroactively) changes nothing about the fix itself. No scope creep: the change only ever adds the mandatory new kwarg, never touches unrelated test logic.

## Issues Encountered
- The first draft of `test_put_settings_writes_and_round_trips_reminder_intent_at` compared the PUT'd instant string byte-for-byte against a `+00:00`-suffixed literal; Pydantic serializes UTC instants back out with a `Z` suffix (RFC 3339), so the assertion failed on a cosmetically-different-but-equivalent instant. Fixed by sending the instant as `...Z` in the test fixture so the literal round-trips byte-identically, rather than parsing both sides for semantic equality (simpler, and this test is specifically proving byte-level round-trip fidelity).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
`reminder_intent_at` is proven end to end (backend + frontend, all pre-existing tests green, `tsc -b` compiles) — Plans 02–04 can now build the five-state `TrainReminderButton` offer surface, the re-surface banner, and the iOS install-affordance's synchronous write on top of this contract without repeating the full-replace hazard this plan exists to close out. No blockers.

---
*Phase: 203-pwa-install-re-prompting-train-anchored-install-offer*
*Completed: 2026-08-02*

## Self-Check: PASSED

- FOUND: `.planning/phases/203-pwa-install-re-prompting-train-anchored-install-offer/203-01-SUMMARY.md`
- FOUND: `alembic/versions/20260802_174733_6e7e50844af5_phase_203_reminder_intent.py`
- FOUND commit: `79f3d803d` (Task 1)
- FOUND commit: `3b5793151` (Task 2)
- FOUND commit: `ed0321518` (docs: summary)
