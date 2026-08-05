---
phase: quick-260805-lgf
plan: 01
subsystem: observability
tags: [sentry, push, fastapi, asyncio, backend]

requires:
  - phase: 204-push-reminder-delivery-reliability
    provides: "push_send.send_to_subscription prune branch (SEED-135 D1) that this plan downgrades and enriches"
provides:
  - "sentry_sdk.capture_message(level='info') on the push-prune path, replacing a synthetic RuntimeError capture_exception"
  - "push_host / user_agent / user_id in the prune Sentry context, read before the row is deleted"
  - "per-tick sentry_sdk.isolation_scope() on all five lifespan background loops"
  - "_eval_drain_tick as a standalone module-level function (mirrors _full_drain_tick)"
affects: [push, sentry, background-tasks, eval-drain]

actuals:
  tokens: 13521
  tasks: 4
  commits: 5

tech-stack:
  added: []
  patterns:
    - "sentry_sdk.capture_message(..., level='info') for expected/designed state transitions, reserving capture_exception for real errors"
    - "per-tick with sentry_sdk.isolation_scope(): wrapping a background loop's try/except so tags/context never survive past one tick"
    - "thin while/try loop over an extracted _xxx_tick() helper, mirroring the existing _full_drain_tick shape, to keep nesting under CLAUDE.md's hard limit of 4"

key-files:
  created:
    - tests/test_background_task_sentry_scope.py
  modified:
    - app/services/push_send.py
    - app/repositories/push_repository.py
    - app/services/eval_drain.py
    - app/services/import_service.py
    - app/services/guest_cleanup_service.py
    - app/services/train_reminder_service.py
    - app/main.py
    - tests/test_push_send.py
    - tests/services/test_eval_drain.py

key-decisions:
  - "D-01 (seed, carried into plan): per-tick isolation_scope(), not AsyncioIntegration — the latter forks per asyncio TASK (leaves tick N's writes on tick N+1 of the same loop) and changes scope behavior process-wide."
  - "D-02 (seed, carried into plan): push_host is derived via urlsplit(endpoint).hostname at the call site, not threaded as a new parameter — only user_agent/user_id needed threading."
  - "D-03 (seed, carried into plan): no CHANGELOG entry — internal observability only, no user-facing behavior change."
  - "D-04 (seed, carried into plan): the >=300 non-prune branch is untouched — equally undiagnosable but explicitly out of scope."

requirements-completed: [SEED-138-P1, SEED-138-P2]

coverage:
  - id: D1
    description: "404/410 push responses are captured via sentry_sdk.capture_message(level='info') with a push_host/user_agent/user_id context, never via capture_exception"
    requirement: "SEED-138-P1"
    verification:
      - kind: unit
        ref: "tests/test_push_send.py::test_send_to_subscription_status_404_prunes_and_captures"
        status: pass
      - kind: unit
        ref: "tests/test_push_send.py::test_send_to_subscription_status_410_prunes_and_captures"
        status: pass
      - kind: integration
        ref: "tests/test_push_send.py::test_send_to_user_prune_context_carries_real_user_agent_and_user_id"
        status: pass
    human_judgment: false
  - id: D2
    description: "No character of the endpoint PATH reaches any Sentry payload or log record on the prune path; only the host does"
    requirement: "SEED-138-P1"
    verification:
      - kind: unit
        ref: "tests/test_push_send.py::test_send_to_subscription_status_404_leaks_no_endpoint"
        status: pass
      - kind: unit
        ref: "tests/test_push_send.py::test_send_to_subscription_status_410_leaks_no_endpoint"
        status: pass
    human_judgment: false
  - id: D3
    description: "Every lifespan background loop (reaper, entry-drain, full-drain, guest cleanup, train reminders) wraps its per-tick body in a Sentry isolation scope so a tag/context from one tick never reaches a later event"
    requirement: "SEED-138-P2"
    verification:
      - kind: unit
        ref: "tests/test_background_task_sentry_scope.py::test_tick_n_plus_1_event_does_not_carry_tick_n_tag[run_periodic_reaper]"
        status: pass
      - kind: unit
        ref: "tests/test_background_task_sentry_scope.py::test_tick_n_plus_1_event_does_not_carry_tick_n_tag[run_eval_drain]"
        status: pass
      - kind: unit
        ref: "tests/test_background_task_sentry_scope.py::test_tick_n_plus_1_event_does_not_carry_tick_n_tag[run_full_eval_drain]"
        status: pass
      - kind: unit
        ref: "tests/test_background_task_sentry_scope.py::test_tick_n_plus_1_event_does_not_carry_tick_n_tag[run_periodic_guest_cleanup]"
        status: pass
      - kind: unit
        ref: "tests/test_background_task_sentry_scope.py::test_tick_n_plus_1_event_does_not_carry_tick_n_tag[run_periodic_train_reminders]"
        status: pass
    human_judgment: false
  - id: D4
    description: "run_eval_drain's tick body extracted into _eval_drain_tick (prerequisite for D3, keeps nesting under CLAUDE.md's hard limit of 4) with byte-identical behavior"
    verification:
      - kind: unit
        ref: "tests/services/test_eval_drain.py (33 tests, unmodified except the AST-guard retarget)"
        status: pass
    human_judgment: false

duration: ~1h
completed: 2026-08-05
status: complete
---

# Quick Task 260805-lgf: SEED-138 Push-Prune Downgrade + Sentry Scope Isolation Summary

**Push-prune Sentry captures downgraded from synthetic-error to `level="info"` with a diagnosable `push_host`/`user_agent`/`user_id` context, and all five lifespan background loops now carry their own per-tick Sentry isolation scope so tags and context never bleed across ticks or tasks.**

## Performance

- **Duration:** ~1h
- **Started:** 2026-08-05T~12:50Z
- **Completed:** 2026-08-05T13:53:02Z
- **Tasks:** 4/4
- **Files modified:** 9 (7 app, 3 tests — 1 test file new)

## Accomplishments

- `push_send.send_to_subscription`'s 404/410 prune branch now calls `sentry_sdk.capture_message(..., level="info")` instead of synthesizing and capturing a `RuntimeError` — routine device churn (PWA removed, browser reinstall, token rotation) no longer creates a permanent `level: error` Sentry issue.
- The prune context grew from two keys (`status_code`, `subscription_id`) to five, adding `push_host` (derived via `urlsplit(endpoint).hostname` — host only, never the bearer-capability path), `user_agent`, and `user_id`, all read from the subscription row *before* `send_to_user` deletes it moments later.
- `push_repository.list_subscriptions` now projects `user_agent` (previously only `id`/`endpoint`/`p256dh`/`auth`), the missing link that made the diagnosability fix possible.
- `run_eval_drain`'s per-tick body (5 levels of nesting — one past CLAUDE.md's hard limit) was extracted into a standalone `_eval_drain_tick()`, mirroring the existing `_full_drain_tick` shape (WR-07), as a prerequisite for wrapping it in a Sentry scope without breaching the nesting limit.
- All five lifespan background loops (`run_periodic_reaper`, `run_eval_drain`, `run_full_eval_drain`, `run_periodic_guest_cleanup`, `run_periodic_train_reminders`) now wrap their per-tick try/except in `with sentry_sdk.isolation_scope():`, closing the SEED-138 Problem 2 gap where every loop shared one Sentry scope and a `set_tag`/`set_context` in one task's tick could leak onto a completely unrelated later event (exactly what happened in the FLAWCHESS-9J incident that surfaced this seed).
- SEED-138 moved to `.planning/seeds/closed/`.

## Task Commits

1. **Task 1: Downgrade the prune capture to info and make it diagnosable end-to-end** - `ea217c3e3` (feat)
2. **Task 2: Extract run_eval_drain's tick body into `_eval_drain_tick`** - `6b49c52ff` (refactor)
3. **Task 3: Give every background loop its own per-tick Sentry isolation scope** - `580633ee9` (fix)
   - Formatter fixup after the pre-merge gate - `4aeb583d0` (style)
4. **Task 4: Full backend gate and seed closure** - `3566c8e3e` (docs: seed closure; the gate itself produced no code changes beyond the style commit above)

_No `docs: complete plan` metadata commit — per this quick task's constraints, docs artifacts (SUMMARY.md, STATE.md) are committed by the orchestrator, not this executor. The seed closure commit (`3566c8e3e`) is the one docs-shaped commit this executor made, per the explicit exception in the task constraints._

## Files Created/Modified

- `app/services/push_send.py` - prune branch downgraded to `capture_message(level="info")`; `_push_host()` helper; `send_to_subscription` gained keyword-only `user_agent`/`user_id`; module docstring amended
- `app/repositories/push_repository.py` - `PushSubscriptionRow.user_agent` field; `list_subscriptions` projects it
- `app/services/eval_drain.py` - `_eval_drain_tick()` extracted; `run_eval_drain`/`run_full_eval_drain` wrapped in per-tick `isolation_scope()`
- `app/services/import_service.py` - `run_periodic_reaper` wrapped in per-tick `isolation_scope()`
- `app/services/guest_cleanup_service.py` - `run_periodic_guest_cleanup` wrapped in per-tick `isolation_scope()`
- `app/services/train_reminder_service.py` - `run_periodic_train_reminders` wrapped in per-tick `isolation_scope()`
- `app/main.py` - convention comment above the five `asyncio.create_task` calls, recording D-01 for whoever adds a sixth loop
- `tests/test_push_send.py` - 4 prune tests + 2 helpers repointed at `capture_message` with a `capture_exception` call-count==0 revert-proof assertion; 3 new tests (host-in-context, DB-backed real-user-agent diagnosability, repository `user_agent` projection incl. the None case); module docstring updated
- `tests/services/test_eval_drain.py` - `TestGatherOutsideSession` retargeted at `_eval_drain_tick`, plus a `gather_calls_seen >= 1` assertion so a future rename can't make the guard pass vacuously
- `tests/test_background_task_sentry_scope.py` (new) - real behavioral proof (capturing `sentry_sdk.Client` + real `Transport`, not AST/symbol checks) that a tag set in tick 1 of each of the five loops is absent from an event captured in tick 2

## Decisions Made

None beyond the seed's own locked D-01..D-04, carried into the plan unchanged (see frontmatter `key-decisions`). No plan-time decisions were re-opened.

## Deviations from Plan

None — plan executed exactly as written. Task 3's gate produced one trivial ruff-format reflow (a `logger.warning(...)` call line-length change after the indent shift from the `isolation_scope()` wrap), committed separately as `style(eval-drain): apply ruff formatter line-length reflow` per the plan's own instruction to commit formatter output separately.

## Issues Encountered

- Building the `tests/test_background_task_sentry_scope.py` capturing-client fixture required one iteration: passing a bare callable as `sentry_sdk.Client(transport=...)` hits the SDK's deprecated "function transport" path and never routes through `capture_envelope` with a real `Envelope`; switching to a `Transport` *instance* (not a callable/class) fixed it. Verified this against a real `sentry_sdk` 2.61 client + isolation-scope round-trip in a scratch script before writing the test, per the plan's own escape hatch ("iterate on it until a captured event's tags dict is actually observable").

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- SEED-138 fully closed; both Problem 1 (mis-graded, un-diagnosable prune) and Problem 2 (scope bleed) are fixed and regression-tested.
- Carried forward per the plan's Task 4 note (not acted on): as of 2026-08-04, prod `push_subscriptions` has never held an Apple endpoint, including after an iPhone tester exercised reminders — evidence that `[[SEED-136]]`'s trigger (verify the iOS push path on real hardware) is arguably already met. The `push_host` context field this plan adds is what will make the next Apple prune (if one ever occurs) visible in Sentry.
- No blockers for future push/Sentry work.

## Self-Check: PASSED

- `app/services/push_send.py` — FOUND
- `app/repositories/push_repository.py` — FOUND
- `app/services/eval_drain.py` — FOUND
- `app/services/import_service.py` — FOUND
- `app/services/guest_cleanup_service.py` — FOUND
- `app/services/train_reminder_service.py` — FOUND
- `app/main.py` — FOUND
- `tests/test_push_send.py` — FOUND
- `tests/services/test_eval_drain.py` — FOUND
- `tests/test_background_task_sentry_scope.py` — FOUND
- `.planning/seeds/closed/SEED-138-push-prune-noise-and-sentry-scope-bleed.md` — FOUND
- `.planning/seeds/SEED-138-push-prune-noise-and-sentry-scope-bleed.md` (old path) — CONFIRMED ABSENT
- Commit `ea217c3e3` — FOUND
- Commit `6b49c52ff` — FOUND
- Commit `580633ee9` — FOUND
- Commit `4aeb583d0` — FOUND
- Commit `3566c8e3e` — FOUND

---
*Quick task: 260805-lgf*
*Completed: 2026-08-05*
