---
phase: quick-260803-nio
plan: 01
subsystem: observability
tags: [sentry, logging, push, fastapi, python]

requires: []
provides:
  - "404/410 push-subscription prune branch now logs at WARNING and captures to Sentry (status code + subscription id, never the endpoint) before deleting the row"
  - "Per-tick Train reminder summary escalates from INFO to WARNING when pruned>0 or failed>0, using one call site / one format string so the message shape is byte-identical at both levels"
affects: [push_send, train_reminder_service, SEED-135]

actuals:
  tokens: 3900
  tasks: 3
  commits: 1

tech-stack:
  added: []
  patterns:
    - "Threaded a keyword-only optional id (subscription_id) into an already-exported function rather than setting Sentry context at the call site, so set_context lands before capture_exception fires on the same event"
    - "logger.log(level, ...) with a single computed level + one shared format string, so a summary line's structural shape never diverges between severities"

key-files:
  created: []
  modified:
    - app/services/push_send.py
    - app/services/train_reminder_service.py
    - tests/test_push_send.py
    - tests/services/test_train_reminder_service.py

key-decisions:
  - "User-confirmed override of the phase-201 D-04 decision: the prune branch (404/410) now gets BOTH a WARNING log AND a sentry_sdk.capture_exception, matching the >=300 branch's observability instead of staying silent"
  - "subscription_id threaded into send_to_subscription as an optional keyword-only param (default None) rather than a required one, since the function is exported in __all__ and called directly by ~15 existing tests with the old signature"
  - "The captured RuntimeError for the prune case uses a distinct fixed-literal message from the >=300 branch's, so Sentry groups prunes separately from transient failures, per CLAUDE.md's no-variable-data rule"

patterns-established:
  - "Mutation-proof via pathspec-limited git stash push/pop on only the production files, keeping the new tests in the working tree, to prove a gap-closure fix is load-bearing (feedback_mutation_test_gap_closures)"

requirements-completed: [SEED-135-D1]

coverage:
  - id: D1
    description: "404/410 prune branch logs at WARNING and captures exactly one Sentry exception (status code + subscription id in set_context, no endpoint, no status digits in the message) before pruning the row"
    requirement: SEED-135-D1
    verification:
      - kind: unit
        ref: "tests/test_push_send.py::test_send_to_subscription_status_404_prunes_and_captures"
        status: pass
      - kind: unit
        ref: "tests/test_push_send.py::test_send_to_subscription_status_410_prunes_and_captures"
        status: pass
      - kind: unit
        ref: "tests/test_push_send.py::test_send_to_subscription_status_404_capture_message_has_no_status_digits"
        status: pass
      - kind: unit
        ref: "tests/test_push_send.py::test_send_to_subscription_status_410_capture_message_has_no_status_digits"
        status: pass
      - kind: unit
        ref: "tests/test_push_send.py::test_send_to_subscription_status_404_leaks_no_endpoint"
        status: pass
      - kind: unit
        ref: "tests/test_push_send.py::test_send_to_subscription_status_410_leaks_no_endpoint"
        status: pass
      - kind: unit
        ref: "tests/test_push_send.py::test_send_to_user_fan_out_prunes_only_the_410_not_the_500"
        status: pass
    human_judgment: false
  - id: D2
    description: "Per-tick reminder summary logs at WARNING when pruned>0 or failed>0 and at INFO otherwise, with an identical raw format string (record.msg) at both levels; ReminderTickSummary and the aggregate per-tick Sentry capture are unchanged"
    requirement: SEED-135-D1
    verification:
      - kind: unit
        ref: "tests/services/test_train_reminder_service.py::TestTickSummaryLog::test_pruned_nonzero_logs_summary_at_warning"
        status: pass
      - kind: unit
        ref: "tests/services/test_train_reminder_service.py::TestTickSummaryLog::test_failed_nonzero_logs_summary_at_warning"
        status: pass
      - kind: unit
        ref: "tests/services/test_train_reminder_service.py::TestTickSummaryLog::test_all_clear_logs_summary_at_info"
        status: pass
      - kind: unit
        ref: "tests/services/test_train_reminder_service.py::TestTickSummaryLog::test_warning_and_info_summaries_share_the_same_message_shape"
        status: pass
    human_judgment: false

duration: 35min
completed: 2026-08-03
status: complete
---

# Quick Task 260803-nio: Make the Push Subscription Prune Observable Summary

**Reversed phase 201's intentional silence on 404/410 push-subscription prunes (WARNING log + Sentry capture, status/subscription-id only) and escalated the per-tick reminder summary to WARNING on any pruned/failed count, so the next silent-reminder-death incident leaves a trace instead of needing forensic inference.**

## Performance

- **Duration:** 35 min
- **Tasks:** 3/3 complete

## Accomplishments

1. **`push_send.send_to_subscription`'s 404/410 branch now observable.** Mirrors the existing `>=300` branch's style: `logger.warning("Push subscription pruned after status %d", ...)`, `sentry_sdk.set_tag("source", "push_send")`, `sentry_sdk.set_context("push_send", {"status_code": ..., "subscription_id": ...})`, then `sentry_sdk.capture_exception(RuntimeError("Push send returned a prune status"))` — a distinct fixed-literal message from the non-prune branch's, so Sentry groups the two separately. `return True` is unchanged; the delete in `send_to_user` still happens exactly as before. Threaded a new keyword-only `subscription_id: int | None = None` param into `send_to_subscription` (defaulted, not required, since ~15 existing tests call it with the old signature) and passed `subscription.id` from `send_to_user`'s fan-out loop, so `set_context` can identify the about-to-be-deleted row without ever holding the endpoint (a bearer capability). Updated the module docstring and `tests/test_push_send.py`'s stale coverage-list line.

2. **`train_reminder_service.send_due_reminders`'s per-tick summary escalates on failure.** Replaced the single `logger.info(...)` call with `logger.log(level, ...)` using the same six-`%d` format string, where `level = logging.WARNING if (pruned > 0 or failed > 0) else logging.INFO`. One call site, one format string, so the message shape is identical regardless of which level actually fires — load-bearing for prod `grep` and for the prefix-filtering tests. Added a comment explaining why: app-level INFO is filtered out of prod docker logs (verified 2026-08-03), so a tick that pruned or failed left no trace without this change. `ReminderTickSummary` and the single aggregate per-tick `sentry_sdk.capture_exception(last_failure)` block are untouched — no second Sentry capture was added for the prune case (Task 1 already captures once per pruned subscription).

3. **Mutation-proved both changes** by reverting only the two production files (pathspec-limited `git stash push -- app/services/push_send.py app/services/train_reminder_service.py`, keeping the four new/modified test additions in the working tree), re-running both test files, and observing the exact expected-red set fail, then restoring and confirming the exact same set green — see "Mutation Proof" below.

## Mutation Proof (observed, not asserted)

**Step 1 — revert.** `git stash push -m "mutation-proof: revert prod changes" -- app/services/push_send.py app/services/train_reminder_service.py`. `git status --short` confirmed only the two test files remained modified.

**Step 2 — run against reverted code.** `uv run pytest tests/test_push_send.py tests/services/test_train_reminder_service.py -q` → **6 failed, 53 passed**:

```
FAILED tests/test_push_send.py::test_send_to_subscription_status_404_prunes_and_captures
  AssertionError: assert 0 == 1  (mock_capture.call_count)
FAILED tests/test_push_send.py::test_send_to_subscription_status_410_prunes_and_captures
  AssertionError: assert 0 == 1  (mock_capture.call_count)
FAILED tests/test_push_send.py::test_send_to_subscription_status_404_capture_message_has_no_status_digits
  AssertionError: assert 0 == 1  (mock_capture.call_count)
FAILED tests/test_push_send.py::test_send_to_subscription_status_410_capture_message_has_no_status_digits
  AssertionError: assert 0 == 1  (mock_capture.call_count)
FAILED tests/services/test_train_reminder_service.py::TestTickSummaryLog::test_pruned_nonzero_logs_summary_at_warning
  AssertionError: assert 20 == 30  (record.levelno; 20=INFO, 30=WARNING)
FAILED tests/services/test_train_reminder_service.py::TestTickSummaryLog::test_failed_nonzero_logs_summary_at_warning
  AssertionError: assert 20 == 30  (record.levelno; 20=INFO, 30=WARNING)
```

This is a slightly wider red set than the plan's five named items — the plan grouped 404+410 no-status-digits assertion into "one test" (Test 3) but this implementation wrote it as two separate parametrized-by-hand tests (404 and 410), so the same coverage surfaces as 4 push_send failures + 2 tick-summary failures = 6, not 5. No gap: every item the plan named as expected-red did go red.

Explicitly re-ran the tests the plan calls out as expected to **stay green** on the reverted code, to confirm they are not false negatives:
```
tests/test_push_send.py::test_send_to_subscription_status_404_leaks_no_endpoint PASSED
tests/test_push_send.py::test_send_to_subscription_status_410_leaks_no_endpoint PASSED
tests/services/test_train_reminder_service.py::TestTickSummaryLog::test_all_clear_logs_summary_at_info PASSED
tests/test_push_send.py::test_send_to_user_fan_out_prunes_only_the_410_not_the_500 PASSED
```
(4 passed, 55 deselected) — correct: the old code leaked nothing and did log the all-clear case at INFO, so these assertions hold regardless of the fix.

**Step 3 — restore.** `git stash pop` → `Dropped refs/stash@{0}`. `git status --short` confirmed all four files (2 prod + 2 test) back to modified.

**Step 4 — re-run restored code.** `uv run pytest tests/test_push_send.py tests/services/test_train_reminder_service.py -q` → **59 passed**.

**Step 5 — backend gate.**
- `uv run ruff format app/ tests/` → 1 file reformatted (`tests/services/test_train_reminder_service.py`, a long `assert type(...) is type(...) is ...` line wrapped to 4 lines by the formatter — no logic change, folded into the same commit).
- `uv run ruff check app/ tests/ --fix` → All checks passed.
- `uv run ty check app/ tests/` → All checks passed (zero errors).
- `uv run pytest tests/test_push_send.py tests/services/test_train_reminder_service.py -q` (re-run after formatting) → 59 passed.

## Deviations from Plan

### Auto-fixed Issues

None beyond the ruff-format reformat folded into the commit (mechanical, no behavior change).

### Test count vs. plan's Task 1 spec

The plan's Task 1 behavior spec described "Test 3" and "Test 4" as single tests each covering both prune statuses (404 and 410). This implementation instead wrote `_assert_prune_status_captures_no_digits(status_code)` and `_assert_prune_status_leaks_no_endpoint(status_code, caplog)` as shared helpers, each called once for 404 and once for 410 — 4 tests instead of 2, mirroring the existing `_assert_error_status_captures_once` pattern already used for the non-prune status codes in the same file. Same coverage, finer granularity, consistent with the file's existing idiom. Not a scope change.

## Explicitly Left Untouched (out of scope per task instructions)

- `frontend/src/lib/push.ts` (D2 re-sync, D4 applicationServerKey validation) — SEED-135 D2/D4, deferred.
- The claim-before-send ordering in `train_reminder_service._process_candidate` (D3) — reopens locked decision D-07 from phase 201, deferred.
- `_PUSH_TTL_SECONDS = 0` in `push_send.py` (D5) — deferred.
- `SEED-135-push-subscription-prune-is-silent-and-unrecoverable.md`'s status — left active (not moved to `.planning/seeds/closed/`), since D2/D3/D4/D5 remain open.

## Self-Check: PASSED

- `app/services/push_send.py` — FOUND, modified as described.
- `app/services/train_reminder_service.py` — FOUND, modified as described.
- `tests/test_push_send.py` — FOUND, modified as described.
- `tests/services/test_train_reminder_service.py` — FOUND, modified as described.
- Commit `e63c3b7a1` — FOUND in `git log --oneline`.
