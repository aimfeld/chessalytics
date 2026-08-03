---
phase: 201-push-infrastructure-train-reminders
plan: 04
subsystem: infra
tags: [scheduler, asyncio, sqlalchemy, fastapi-lifespan, webpush]

# Dependency graph
requires:
  - phase: 201-01
    provides: "push_send.send_to_user fan-out, train_reminder_service.build_reminder_payload (D-10/D-11/D-14), REMIND-08 dev trigger"
  - phase: 201-03
    provides: "train_settings.reminder_enabled/reminder_hour/reminder_last_sent_on columns, GET/PUT /train/settings exposure"
provides:
  - "train_scheduler.local_hour(tz_name, now_utc) -> int, the companion UTC->local-hour conversion to local_today"
  - "app/repositories/train_reminder_repository.py: list_reminder_candidate_user_ids, claim_reminder_day, has_completed_session_on"
  - "train_reminder_service.send_due_reminders / _process_candidate: the full per-candidate eligibility loop, settle-before-copy, claim-then-send fan-out"
  - "train_reminder_service.run_periodic_train_reminders, the D-15 asyncio.create_task wrapper, wired into app/main.py's lifespan as a fifth background task"
  - "CHANGELOG.md Phase 201 user-facing bullet"
affects: [202]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 14800
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-candidate own-session isolation (mirrors guest_cleanup_service._purge_guest): each reminder candidate opens its own async_session_maker() session inside its own try/except, so one candidate's failure or rollback can never poison another's transaction or starve the rest of the tick"
    - "Settle-then-claim-then-send ordering: settle_streak_snapshot commits before the copy is built, claim_reminder_day commits before any network call (D-07) -- two separate commits inside one candidate's session, deliberately not one transaction"
    - "SQL narrows, Python decides (D-16): the candidate query applies no timezone conversion and no reminder_last_sent_on date predicate; local_today/local_hour/is_scheduled_day (Python, reused verbatim) and the per-user claim UPDATE are the real guards"

key-files:
  created:
    - app/repositories/train_reminder_repository.py
    - tests/services/test_train_reminder_service.py
  modified:
    - app/services/train_scheduler.py
    - app/services/train_reminder_service.py
    - app/main.py
    - tests/services/test_train_scheduler.py
    - tests/test_main_lifespan.py
    - CHANGELOG.md

key-decisions:
  - "is_scheduled_day(day, weekday_mask=0) actually returns True (train_scheduler's own 'train anytime, every day scheduled' identity case). The plan's <open_decisions_resolved> section incorrectly stated it returns False. Implemented the plan's explicitly REQUIRED behavior (a weekday_mask=0 user never gets a reminder) via an explicit `row.weekday_mask == 0 or not is_scheduled_day(...)` guard rather than the plan's literal 'reuse verbatim, no special-casing' instruction, which would have produced the opposite of the required, tested behavior. See Deviations below."
  - "Task 1 and Task 2 test infrastructure turned out inseparable at first pass: the autouse `_patch_reminder_session_maker` fixture (needed by every Task 2 test) referenced `train_reminder_service.async_session_maker`, an attribute that only exists once Task 2's code is written. Built both tasks' code together, then split the diff back into two atomic per-task commits (Task 1: scheduler+repository+their tests; Task 2: service+its tests) so the commit history still matches the plan's task boundaries."
  - "TestFanOut's two tests use REAL webpush encryption (a generated VAPID keypair + real EC subscription keys) with only httpx.AsyncClient.post mocked, rather than mocking push_send.send_to_user -- proves send_due_reminders' single call into the send layer genuinely fans out to all N subscriptions, not just that the service calls the function once."

patterns-established:
  - "A background scheduler's per-candidate loop step order (schedule gate -> hour gate -> cheap pre-filter -> settle -> already-done gate -> atomic claim+commit -> send) is documented as load-bearing in the module docstring, not just in code comments, so a future editor sees the ordering constraint before touching any single step."

requirements-completed: [REMIND-02, REMIND-03, REMIND-04, REMIND-05, REMIND-06, REMIND-07]

coverage:
  - id: D1
    description: "A background task started in the FastAPI lifespan wakes at least every 15 minutes and, for each fractional IANA offset (+05:30, +05:45, +12:45), correctly resolves the user's local hour via the new local_hour helper"
    requirement: "REMIND-02"
    verification:
      - kind: unit
        ref: "tests/services/test_train_scheduler.py::TestLocalHour"
        status: pass
      - kind: unit
        ref: "tests/services/test_train_reminder_service.py::TestTickInterval::test_tick_interval_at_least_15_minutes"
        status: pass
    human_judgment: false
  - id: D2
    description: "A reminder fires only on a day the user's weekday_mask schedules (including the weekday_mask=0 'never fires' case), and the local-hour gate is inclusive at reminder_hour with no upper bound (catch-up through the end of the local day)"
    requirement: "REMIND-03"
    verification:
      - kind: integration
        ref: "tests/services/test_train_reminder_service.py::TestScheduledDay"
        status: pass
      - kind: integration
        ref: "tests/services/test_train_reminder_service.py::TestHourBoundary"
        status: pass
    human_judgment: false
  - id: D3
    description: "A completed drill_sessions row for the local-today suppresses the reminder AND leaves the day unclaimed; an open (non-completed) session still gets the nudge"
    requirement: "REMIND-04"
    verification:
      - kind: integration
        ref: "tests/services/test_train_reminder_service.py::TestAlreadyTrained"
        status: pass
      - kind: unit
        ref: "tests/services/test_train_reminder_service.py::TestHasCompletedSessionOn"
        status: pass
    human_judgment: false
  - id: D4
    description: "The daily send is claimed via a conditional UPDATE committed BEFORE any push POST; two overlapping claims for the same user/day yield exactly one True; two back-to-back ticks send exactly one POST total"
    requirement: "REMIND-05"
    verification:
      - kind: unit
        ref: "tests/services/test_train_reminder_service.py::TestClaimReminderDay::test_two_sequential_committed_calls_yield_exactly_one_true_idempotent"
        status: pass
      - kind: integration
        ref: "tests/services/test_train_reminder_service.py::TestIdempotency"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every live subscription of a claimed user receives exactly one POST from one claim (proven with real webpush encryption), and a mid-fan-out failure on one subscription does not prevent the remaining ones from being attempted"
    requirement: "REMIND-06"
    verification:
      - kind: integration
        ref: "tests/services/test_train_reminder_service.py::TestFanOut"
        status: pass
    human_judgment: false
  - id: D6
    description: "Guest users never appear in the candidate set, proven by forcing reminder_enabled=True directly at the DB layer (bypassing the /train/* 403 gate) and asserting exclusion"
    requirement: "REMIND-07"
    verification:
      - kind: integration
        ref: "tests/services/test_train_reminder_service.py::TestListReminderCandidateUserIds::test_guest_excluded_even_with_reminder_enabled_forced_true"
        status: pass
    human_judgment: false
  - id: D7
    description: "The job settles the streak snapshot (D-12) before building the notification copy, so a lapsed user's 'Day N' reports the settled count, never the stale stored one; streak_count=0 reads 'Day 1 is waiting.'"
    verification:
      - kind: integration
        ref: "tests/services/test_train_reminder_service.py::TestSettleBeforeCopy"
        status: pass
    human_judgment: false
  - id: D8
    description: "With VAPID keys unset the reminder task logs once at startup and never ticks; one candidate's failure never starves the rest of the tick, and Sentry is captured exactly once per tick (not per candidate)"
    verification:
      - kind: unit
        ref: "tests/services/test_train_reminder_service.py::TestRunPeriodic::test_run_periodic_returns_without_ticking_when_vapid_unset"
        status: pass
      - kind: integration
        ref: "tests/services/test_train_reminder_service.py::TestFailureIsolation"
        status: pass
    human_judgment: false
  - id: D9
    description: "The reminder ticker starts and shuts down cleanly alongside the four existing FastAPI lifespan background tasks"
    verification:
      - kind: integration
        ref: "tests/test_main_lifespan.py::TestLifespanBackgroundTasks::test_both_background_tasks_spawned"
        status: pass
    human_judgment: false
  - id: D10
    description: "Real end-to-end reminder delivery to a subscribed browser at the user's chosen local hour (HUMAN-UAT, deferred per operator instruction)"
    verification: []
    human_judgment: true
    rationale: "This plan's own <verification> section explicitly defers the full HUMAN-UAT flow (generate keys, subscribe a real browser, set reminder_hour to the current hour, confirm exactly one OS notification per local day) to after phase execution, per the operator's stated instruction. Automated coverage proves every decision boundary and the fan-out mechanics; only real notification delivery to a real device needs a human."

# Metrics
duration: 45min
completed: 2026-08-02
status: complete
---

# Phase 201 Plan 04: Train Reminder Scheduler Summary

**A fifth FastAPI lifespan task ticks every 15 minutes, narrows candidates in SQL (D-16), decides schedule/hour/already-trained eligibility in Python via `train_scheduler`'s reused predicates, settles the streak snapshot before building "Day N" copy (D-12), claims the day atomically before any network call (D-07), and fans the notification out to every live subscription via 201-01's `push_send.send_to_user`.**

## Performance

- **Duration:** ~45 min
- **Completed:** 2026-08-02
- **Tasks:** 3
- **Files modified:** 8 (2 created, 6 modified)

## Accomplishments
- `train_scheduler.local_hour(tz_name, now_utc) -> int` — the companion to `local_today`, with the identical unrecognised-timezone fallback, covered by the three fractional IANA offsets (+05:30, +05:45, +12:45) plus the fallback case
- `app/repositories/train_reminder_repository.py` — `list_reminder_candidate_user_ids` (narrows on `reminder_enabled` + a live subscription + `is_guest=false`, no timezone/date predicate), `claim_reminder_day` (the atomic REMIND-05 guard, caller commits), `has_completed_session_on` (the REMIND-04/D-09 suppression check)
- `train_reminder_service.send_due_reminders` / `_process_candidate` — the full per-candidate loop in the plan's load-bearing order: scheduled-day gate → hour gate (inclusive, no upper bound) → cheap pre-filter → settle-and-commit → already-trained gate → claim-and-commit → send
- `train_reminder_service.run_periodic_train_reminders` — the D-15 periodic wrapper, D-03 graceful VAPID-unset disable, one aggregate Sentry capture per tick
- `app/main.py` — the fifth lifespan task (`train-reminders`), cancelled and awaited alongside the other four
- 35 new tests: `test_train_scheduler.py` (+4 `local_hour` tests), `test_train_reminder_service.py` (new file, 30 tests: 13 Task-1 repository tests + 17 Task-2 service tests), and `test_main_lifespan.py` (extended with the fifth task's startup/EXPECTED_TASKS assertions)
- `CHANGELOG.md` Phase 201 bullet under `[Unreleased]`

## Task Commits

Each task was committed atomically:

1. **Task 1: Candidate selection, the atomic day claim, and the local-hour helper** - `bf932d51c` (feat)
2. **Task 2: The per-candidate eligibility loop, settle-before-copy, claim-then-send fan-out** - `aa38eeb37` (feat)
3. **Task 3: Lifespan wiring, full-suite gate, and the CHANGELOG entry** - `02ceb59e7` (feat)

## Files Created/Modified
- `app/repositories/train_reminder_repository.py` - the three reminder-job SQL functions, no `session.commit()` calls (caller commits), zero SQL-side timezone/date predicates
- `app/services/train_scheduler.py` - `local_hour`
- `app/services/train_reminder_service.py` - `ReminderTickSummary`, `_CandidateOutcome`, `_process_candidate`, `send_due_reminders`, `run_periodic_train_reminders`, `_REMINDER_TICK_INTERVAL_SECONDS`
- `app/main.py` - the fifth `asyncio.create_task`, its cancel + await in the `finally` block
- `tests/services/test_train_scheduler.py` - `TestLocalHour` (4 tests)
- `tests/services/test_train_reminder_service.py` - 30 tests: `TestListReminderCandidateUserIds`/`TestClaimReminderDay`/`TestHasCompletedSessionOn` (13, Task 1) + `TestTickInterval`/`TestZeroCandidates`/`TestOneCandidateHappyPath`/`TestScheduledDay`/`TestHourBoundary`/`TestAlreadyTrained`/`TestIdempotency`/`TestFanOut`/`TestSettleBeforeCopy`/`TestFailureIsolation`/`TestRunPeriodic` (17, Task 2)
- `tests/test_main_lifespan.py` - extended `EXPECTED_TASKS` and the startup-spawn assertion to cover `train-reminders`
- `CHANGELOG.md` - Phase 201 `### Added` bullet

## Decisions Made
- Built Task 1 and Task 2's code together because the Task 2 test fixtures (an autouse `monkeypatch.setattr(train_reminder_service, "async_session_maker", ...)`) reference an attribute that only exists once `send_due_reminders`'s module is written — then split the resulting diff back into two atomic commits along the plan's task boundaries so the commit history still reads as Task 1 → Task 2.
- `TestFanOut`'s two tests use real `webpush` encryption (a generated VAPID keypair + real EC subscription keys, only `httpx.AsyncClient.post` mocked) rather than mocking `push_send.send_to_user`, to prove `send_due_reminders`' single call into the send layer genuinely produces N POSTs for N subscriptions, not merely that the function was called once.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `weekday_mask == 0` handling contradicted `is_scheduled_day`'s actual return value**
- **Found during:** Task 2 (writing `_process_candidate`)
- **Issue:** `201-04-PLAN.md`'s `<open_decisions_resolved>` section states "`is_scheduled_day` returns False for every day under a zero mask" and instructs reusing it verbatim with "Do not special-case it." Reading `app/services/train_scheduler.py` directly shows `is_scheduled_day(day, 0)` actually returns **True** — `weekday_mask == 0` is that module's own "train anytime, every day is scheduled" identity case, used elsewhere for SR pool eligibility (`next_scheduled_day`, `session_window`). Following the plan's literal instruction (`if not is_scheduled_day(...): continue`) would fire a reminder every day for a `weekday_mask=0` user — the opposite of the plan's own required behavior ("A candidate whose `weekday_mask` is 0 is skipped on every day") and its own named acceptance test (`-k "scheduled_day"` must cover "a zero `weekday_mask`").
- **Fix:** Implemented the plan's explicitly required, tested behavior directly: `if row.weekday_mask == 0 or not is_scheduled_day(today, row.weekday_mask): continue`. This is a minimal, documented deviation from "don't special-case it" — the general weekday-gating logic still fully reuses `is_scheduled_day`, only the `weekday_mask == 0` reminder-specific override is added explicitly, with a code comment recording the discrepancy so a future reader isn't confused by the contradiction between this code and the plan doc.
- **Files modified:** `app/services/train_reminder_service.py`
- **Verification:** `tests/services/test_train_reminder_service.py::TestScheduledDay::test_zero_weekday_mask_is_skipped_on_every_day_scheduled_day` passes; without the explicit `weekday_mask == 0` check this test fails (confirmed via the literal-reuse behavior of `is_scheduled_day` alone).
- **Committed in:** `aa38eeb37` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — the plan's own prose was internally inconsistent with the codebase it was directing me to reuse; the required, tested behavior was implemented over the incorrect prose description of that behavior).
**Impact on plan:** No scope creep — the fix is a one-line guard clause plus a documentation comment. Every other Task 2 behavior matches the plan's literal action steps exactly.

## Issues Encountered
None beyond the deviation above.

## User Setup Required
None for this plan. VAPID keys stay unconfigured (D-03 graceful disable) until an operator runs `scripts/gen_vapid_keys.py` (from plan 201-01) and pastes the output into `/opt/flawchess/.env` — that step is prod enablement, not part of this plan's completion. The plan's own `<verification>` section defers full HUMAN-UAT (real browser subscribe + real reminder delivery) to after phase execution, per the operator's explicit instruction.

## Next Phase Readiness
- Phase 201 (Push Infrastructure & Train Reminders) is now feature-complete on the backend: the send chain (201-01), the service-worker handlers (201-02), the settings columns and API (201-03), and the scheduler (this plan) are all wired together and tested end to end via the dev-only trigger endpoint plus this plan's automated coverage of the real scheduled path.
- Phase 202 is purely frontend: the `TrainScheduleSettings` toggle + hour picker UI, consuming the already-shipped `GET`/`PUT /train/settings` `reminder_enabled`/`reminder_hour` fields (D-18, from 201-03) — no backend work should be needed.
- No blockers.

---
*Phase: 201-push-infrastructure-train-reminders*
*Completed: 2026-08-02*

## Self-Check: PASSED

All 9 files verified present on disk; all 3 task commits (`bf932d51c`, `aa38eeb37`, `02ceb59e7`) verified present in git history.
