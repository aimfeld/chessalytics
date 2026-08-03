---
phase: 204-push-reminder-delivery-reliability
plan: 02
subsystem: api
tags: [push, web-push, rfc8030, sqlalchemy, sentry, timezone, zoneinfo]

# Dependency graph
requires:
  - phase: 201-push-infrastructure-train-reminders
    provides: push_send.send_to_subscription/send_to_user, train_reminder_repository.claim_reminder_day, train_reminder_service._process_candidate's step order
provides:
  - "train_scheduler.seconds_until_end_of_local_day: end-of-local-day (23:59:59, never next-midnight) remaining-seconds helper"
  - "push_send: keyword-only, defaulted ttl_seconds threaded through send_to_subscription/send_to_user (module default 3600s, never 0)"
  - "train_reminder_repository.release_reminder_claim: conditional UPDATE guarded on reminder_last_sent_on = :today"
  - "train_reminder_service._process_candidate step 8: releases today's claim on total non-delivery only"
  - "204-DECISIONS.md: the D3 decision log (rationale, rejected alternatives, reversibility, test node id)"
affects: [204-03-final-verification, push-health-metrics-future-work]

# Actuals (#2632)
actuals:
  tokens: 9755
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "TTL threading mirrors the subscription_id keyword-only-defaulted precedent (Phase 201 D1)"
    - "release_reminder_claim mirrors claim_reminder_day's conditional-UPDATE-with-RETURNING shape"

key-files:
  created:
    - .planning/phases/204-push-reminder-delivery-reliability/204-DECISIONS.md
  modified:
    - app/services/train_scheduler.py
    - app/services/push_send.py
    - app/services/train_reminder_service.py
    - app/repositories/train_reminder_repository.py
    - tests/services/test_train_scheduler.py
    - tests/test_push_send.py
    - tests/services/test_train_reminder_service.py

key-decisions:
  - "D-01: TTL computed as 'today at 23:59:59 local minus now', never 'next local midnight' (a nonexistent local time in a few DST-transition zones); no floor, no cap"
  - "D-13/D-14/D-15: release the day's claim only when attempted == 0 or attempted == pruned, guarded on reminder_last_sent_on = :today; failed never triggers the release"
  - "The release runs as step 8, the next statement after send_to_user returns normally, reachable from no exception handler, so a crash mid-fan-out leaves the claim standing (D-07 stays structural)"

patterns-established:
  - "Pattern: a push-service TTL that mirrors the scheduler's own stated day-boundary invariant rather than an independent constant"
  - "Pattern: a claim-release UPDATE guarded on equality with the exact value the claim wrote, not a looser NULL/inequality check, so it can only ever undo its own tick's claim"

requirements-completed: [PUSHREL-03, PUSHREL-05, PUSHREL-06]

coverage:
  - id: D1
    description: "Push POST carries a ttl header equal to the seconds remaining in the user's local day, computed once in train_reminder_service and threaded through push_send with no floor/cap and a non-zero module default"
    requirement: PUSHREL-03
    verification:
      - kind: unit
        ref: "tests/services/test_train_scheduler.py::TestSecondsUntilEndOfLocalDay"
        status: pass
      - kind: unit
        ref: "tests/test_push_send.py::test_send_to_subscription_explicit_ttl_seconds_sets_header"
        status: pass
      - kind: unit
        ref: "tests/test_push_send.py::test_send_to_subscription_default_ttl_seconds_is_not_zero"
        status: pass
    human_judgment: false
  - id: D2
    description: "The day's reminder claim is released when, and only when, the fan-out delivered to nobody; a partial failure and a crash mid-fan-out both leave the claim standing, and the decision is recorded durably"
    requirement: PUSHREL-05
    verification:
      - kind: unit
        ref: "tests/services/test_train_reminder_service.py::TestReleaseReminderClaim"
        status: pass
      - kind: unit
        ref: "tests/services/test_train_reminder_service.py::TestClaimReleaseOnTotalNonDelivery::test_raising_send_to_user_does_not_release_the_claim"
        status: pass
    human_judgment: false
  - id: D3
    description: "Five production changes are each mutation-tested by reverting and confirming a named test goes red, then restoring to green"
    requirement: PUSHREL-06
    verification:
      - kind: other
        ref: "manual mutation runs recorded below under 'Mutation Testing Log'"
        status: pass
    human_judgment: false

duration: ~35min
completed: 2026-08-03
status: complete
---

# Phase 204 Plan 02: TTL end-to-end + claim release on total non-delivery Summary

**A push message stops dying the instant a phone is unreachable (TTL bounded by the user's local day instead of hardcoded 0), and a fan-out that delivers to nobody stops burning the whole day's reminder claim.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-08-03
- **Tasks:** 3 (all `type="auto"`)
- **Files modified:** 7 (4 production, 3 test), 1 file created (`204-DECISIONS.md`)

## Accomplishments

- `train_scheduler.seconds_until_end_of_local_day(tz_name, now_utc)` — the single tz-arithmetic site for the push TTL, sitting beside `local_today`/`local_hour` with the identical unrecognised-timezone fallback. Computed as "today at 23:59:59 local minus now," never "next local midnight," with no floor and no cap.
- `push_send.send_to_subscription`/`send_to_user` gain a keyword-only, defaulted `ttl_seconds` parameter (module default `3600`, never `0`), mirroring the existing `subscription_id` precedent exactly. All 10 pre-existing direct `send_to_subscription` call sites in `tests/test_push_send.py` compile and pass unmodified.
- `train_reminder_service._process_candidate` computes `ttl_seconds` from the candidate's own timezone and threads it into the existing `send_to_user` call — this module still does zero timezone arithmetic of its own.
- `train_reminder_repository.release_reminder_claim` — a conditional `UPDATE ... RETURNING` guarded on `reminder_last_sent_on = :today`, deliberately narrower than `claim_reminder_day`'s `OR/IS NULL` predicate, so it can only ever un-claim the exact day this tick's own claim wrote.
- `_process_candidate` step 8: releases the claim only when `result.attempted == 0 or result.attempted == result.pruned` — runs as the next statement after the fan-out returns normally, unreachable from any exception handler, so a crash mid-fan-out leaves the claim standing (the D-07 double-send invariant stays structurally intact).
- `.planning/phases/204-push-reminder-delivery-reliability/204-DECISIONS.md` — the full D3 decision record: the question as posed, the resolution, the two-guard safety argument, the rejected alternatives, the reversibility rating, and the exact pytest node id that demonstrates the invariant. Cross-referenced from `release_reminder_claim`'s own docstring so a future reader meets the reasoning in the code, not only in an archived planning file.

## Task Commits

1. **Task 1: TTL end to end — bound retention by the user's local day** - `631c70e31` (feat)
2. **Task 2: Release the day's claim when the fan-out delivered to nobody** - `b9d2deef3` (feat)
3. **Task 3: Backend gate — format, lint, types, full suite** - `14edf0b64` (style)

**Plan metadata:** (this commit, made after this SUMMARY)

Task 1 and Task 2 both edit `app/services/train_reminder_service.py` in the same region of `_process_candidate` (per the plan's stated rationale for keeping them in one plan); the diff was split cleanly into two commits by staging the TTL-threading hunk separately from the step-8 release hunk — verified with `git diff` before each commit that no cross-contamination occurred.

## Files Created/Modified

- `app/services/train_scheduler.py` - adds `seconds_until_end_of_local_day` + three `_END_OF_DAY_*` constants
- `app/services/push_send.py` - `_DEFAULT_PUSH_TTL_SECONDS = 3600` replaces `_PUSH_TTL_SECONDS = 0`; `ttl_seconds` keyword-only param on both send functions
- `app/services/train_reminder_service.py` - computes and threads `ttl_seconds`; adds step 8's guarded claim release
- `app/repositories/train_reminder_repository.py` - adds `release_reminder_claim`
- `tests/services/test_train_scheduler.py` - `TestSecondsUntilEndOfLocalDay` (4 tests)
- `tests/test_push_send.py` - 2 new TTL-header tests
- `tests/services/test_train_reminder_service.py` - `TestReleaseReminderClaim` (3 tests) + `TestClaimReleaseOnTotalNonDelivery` (3 tests); two pre-existing `_capture_send` test doubles updated to accept the new `ttl_seconds` kwarg (see Deviations)
- `.planning/phases/204-push-reminder-delivery-reliability/204-DECISIONS.md` - new, the D3 decision log
- `.planning/phases/204-push-reminder-delivery-reliability/204-VALIDATION.md` - Per-Task Verification Map populated with this plan's 3 task rows

## Decisions Made

- **D-01/D-03 (TTL):** end-of-local-day, not next-midnight; no floor/cap; identical timezone fallback to `local_today`/`local_hour`. See `204-CONTEXT.md`.
- **D-02:** `ttl_seconds` keyword-only + defaulted, non-zero default (`3600`), mirroring the `subscription_id` precedent so all 10 existing test call sites keep compiling.
- **D-13/D-14/D-15 (claim release):** release only on total non-delivery (`attempted == 0 or attempted == pruned`); guard on exact `today` equality (D-14); `failed` never triggers it (D-15). Full reasoning, rejected alternatives, and reversibility rating recorded in `204-DECISIONS.md`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Two pre-existing `_capture_send` test doubles needed the new `ttl_seconds` keyword parameter**
- **Found during:** Task 2, first full run of `tests/services/test_train_reminder_service.py`
- **Issue:** `TestSettleBeforeCopy`'s two `_capture_send` async test doubles (used as `send_to_user`'s `side_effect`) had a fixed signature `(session, *, user_id, payload)`. Once `_process_candidate` started calling `send_to_user(..., ttl_seconds=...)` (Task 1's own change), both doubles raised `TypeError: got an unexpected keyword argument 'ttl_seconds'`.
- **Fix:** Added `ttl_seconds: int = 0` to both `_capture_send` signatures. No test behavior or assertion changed — purely a signature compatibility fix forced by Task 1's own parameter addition.
- **Files modified:** `tests/services/test_train_reminder_service.py`
- **Verification:** `uv run pytest tests/services/test_train_reminder_service.py -n auto -x -q` — all 40 tests pass.
- **Committed in:** `631c70e31` (Task 1's commit, since the fix was necessary for Task 1's own change to not break existing tests — verified again unchanged after Task 2's commit).

---

**Total deviations:** 1 auto-fixed (1 blocking).
**Impact on plan:** No scope creep — a mechanical signature fix forced by the plan's own `ttl_seconds` threading, not a new feature.

## Mutation Testing Log

All five mutations named in the plan's acceptance criteria were run: reverted the specific change, ran the named command, confirmed red, restored, confirmed green.

| # | Target | Mutation | Command | Result before restore | Result after restore |
|---|--------|----------|---------|------------------------|----------------------|
| 1 | TTL header threading | `send_to_subscription`'s `headers["ttl"]` hardcoded back to `"0"` | `uv run pytest tests/test_push_send.py -k ttl -x` | ❌ both new TTL tests FAILED (`assert '0' == '7200'`, `assert '0' == '3600'`) | ✅ 2 passed |
| 2 | Local-day math | `seconds_until_end_of_local_day` uses `now_utc` directly instead of `now_utc.astimezone(zone)` | `uv run pytest tests/services/test_train_scheduler.py -k end_of_local_day -x` | ❌ mid-day Kolkata test FAILED (`assert 50399 == 30599`); Kathmandu fractional-offset test also FAILED when run without `-x` | ✅ 4 passed |
| 3 | Claim release call | Deleted the `release_reminder_claim` call (step 8) from `_process_candidate` | `uv run pytest tests/services/test_train_reminder_service.py -k ClaimReleaseOnTotalNonDelivery -x` | ❌ all-pruned test FAILED (`assert datetime.date(2026, 8, 1) is None`) | ✅ 3 passed |
| 4 | D-14 guard | Changed `reminder_last_sent_on == today` to `reminder_last_sent_on.isnot(None)` | `uv run pytest tests/services/test_train_reminder_service.py -k ReleaseReminderClaim -x` | ❌ earlier-date test FAILED (`assert True is False`) | ✅ 3 passed |
| 5 | D-07 invariant | Wrapped `send_to_user` in a local `try/except` calling `release_reminder_claim` in the `except` arm | `uv run pytest tests/services/test_train_reminder_service.py -k ClaimReleaseOnTotalNonDelivery -x` | ❌ raising-`send_to_user` test FAILED (claim was released despite the crash) | ✅ 3 passed |

Note on mutation 2's exact command match: the plan's literal `-k end_of_local_day` filter required renaming the test methods to include that literal substring (the class name `TestSecondsUntilEndOfLocalDay` alone does not match `-k end_of_local_day` since pytest's `-k` does a literal substring match and the class name has no underscores). Test methods were renamed to `test_seconds_until_end_of_local_day_*` — no test logic changed, only names, so this is documented here rather than as a deviation requiring a rule.

## Issues Encountered

None beyond the one blocking test-double fix documented above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Plan 204-01 (device re-sync) and Plan 204-02 (this plan) together make Plan 01's re-sync pay off the same day: a prune at 16:05, a re-sync at 18:00, and the 18:15 tick can now actually send, because Plan 02 released the claim the prior failed attempt would otherwise have burned.
- No new push metric, Sentry alert rule, or client-side delivery ack was added (D-16 scope fence respected) — that work remains explicitly out of scope until a future phase.
- `204-VALIDATION.md`'s Per-Task Verification Map now carries this plan's 3 rows; Plan 204-03 (final verification) can build on a fully green backend gate.
- No blockers for Plan 204-03.

## Self-Check: PASSED

All 8 claimed files verified present on disk; all 3 claimed commit hashes (`631c70e31`, `b9d2deef3`, `14edf0b64`) verified present in `git log --oneline --all`.

---
*Phase: 204-push-reminder-delivery-reliability*
*Completed: 2026-08-03*
