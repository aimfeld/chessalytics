---
phase: 201-push-infrastructure-train-reminders
plan: 01
subsystem: infra
tags: [webpush, vapid, aes128gcm, httpx, fastapi, sqlalchemy, alembic, sentry]

# Dependency graph
requires: []
provides:
  - push_subscriptions table (CASCADE-to-users, unique endpoint) + PushSubscription model
  - push_repository (upsert/list/delete-by-endpoint/delete-by-id, all V4 user_id-scoped)
  - push_send service (VAPID sign + aes128gcm encrypt via webpush, httpx.AsyncClient POST, prune-on-404/410)
  - push router (POST /push/subscribe, POST /push/unsubscribe, GET /push/vapid-public-key, POST /push/dev/trigger-reminder)
  - train_reminder_service notification-copy layer (build_reminder_payload, D-10 "Day N" framing)
  - scripts/gen_vapid_keys.py operator one-shot keypair generator
  - isolated `push` uv dependency group (webpush + cryptography), Dockerfile opts in, Dockerfile.worker untouched
affects: [201-02, 201-03, 201-04, 202]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 20600
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: [webpush==1.0.6, cryptography (explicit, already transitive)]
  patterns:
    - "Isolated uv dependency group (push) mirroring the maia-inference isolation pattern — kept out of [project.dependencies] so Dockerfile.worker never pulls it"
    - "D-03 empty-string-means-disabled VAPID config, mirroring SENTRY_DSN's convention"
    - "Prune-on-404/410-only status branching (never a blanket non-2xx prune/capture)"
    - "Per-subscription try/except isolation in a fan-out loop, one aggregate PushFanoutResult"

key-files:
  created:
    - app/models/push_subscription.py
    - app/repositories/push_repository.py
    - app/schemas/push.py
    - app/services/push_send.py
    - app/services/train_reminder_service.py
    - app/routers/push.py
    - scripts/gen_vapid_keys.py
    - alembic/versions/20260801_221737_e02dc5378c12_phase_201_push_subscriptions.py
    - tests/routers/test_push.py
    - tests/test_push_send.py
    - tests/models/test_push_subscription.py
  modified:
    - pyproject.toml
    - Dockerfile
    - .env.example
    - app/core/config.py
    - app/main.py
    - alembic/env.py
    - tests/test_dependency_isolation.py

key-decisions:
  - "Router-test mocking deviates from the plan's literal 'patch httpx.AsyncClient.post' instruction: patching the class globally would also intercept the test's own ASGI-transport driving call, since both use the same class/method. Patched app.services.push_send.push_http_client (the factory) instead, targeting only the outbound send."
  - "list_subscriptions gained an explicit ORDER BY id for deterministic fan-out ordering, needed to make the multi-subscription status-branch test (201/410/500) assertable."
  - "PushFanoutResult.failed counts only exceptions caught by the per-subscription try/except (construction/encryption errors), not non-prune HTTP failures — send_to_subscription's boolean return only distinguishes prune vs not-prune, matching Task 1's stated contract."

patterns-established:
  - "Web Push send path: webpush library for VAPID+aes128gcm, httpx.AsyncClient for the actual POST, follow_redirects=False for SSRF mitigation on a client-supplied endpoint"
  - "Dev-only fail-closed router gate (settings.ENVIRONMENT != 'development' -> 404) mirroring app/core/dev_clock.py"

requirements-completed: [PUSH-01, PUSH-02, PUSH-03, PUSH-04, PUSH-05, REMIND-08]

coverage:
  - id: D1
    description: "A logged-in user can POST a browser push subscription to POST /api/push/subscribe and it is stored against their own user id"
    requirement: "PUSH-01"
    verification:
      - kind: integration
        ref: "tests/routers/test_push.py#test_dev_trigger_sends_real_encrypted_push_end_to_end"
        status: pass
      - kind: integration
        ref: "tests/models/test_push_subscription.py#test_cascade_deletes_subscriptions_on_user_delete"
        status: pass
      - kind: integration
        ref: "tests/models/test_push_subscription.py#test_upsert_subscription_on_duplicate_endpoint_updates_in_place"
        status: pass
    human_judgment: false
  - id: D2
    description: "POST /api/push/dev/trigger-reminder in ENVIRONMENT=development fans a real VAPID-signed, aes128gcm-encrypted POST to every live subscription and returns the attempted count"
    requirement: "REMIND-08"
    verification:
      - kind: integration
        ref: "tests/routers/test_push.py#test_dev_trigger_sends_real_encrypted_push_end_to_end"
        status: pass
      - kind: integration
        ref: "tests/routers/test_push.py#test_dev_trigger_404_outside_development"
        status: pass
    human_judgment: false
  - id: D3
    description: "404/410 prunes the subscription row; every other non-2xx status leaves it alone and is reported once to Sentry; pruning is idempotent under two passes"
    requirement: "PUSH-02"
    verification:
      - kind: unit
        ref: "tests/test_push_send.py#test_send_to_user_fan_out_prunes_only_the_410_not_the_500"
        status: pass
      - kind: unit
        ref: "tests/test_push_send.py#test_send_to_user_prune_is_idempotent_across_two_calls"
        status: pass
      - kind: unit
        ref: "tests/test_push_send.py (7 per-status-code tests: 400/401/403/413/429/500/503)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Empty VAPID keys mean graceful disable: vapid-public-key 404s, subscribe 503s, no send attempted, whole suite green with zero VAPID setup"
    requirement: "PUSH-03"
    verification:
      - kind: integration
        ref: "tests/routers/test_push.py#test_vapid_public_key_404_when_unconfigured"
        status: pass
      - kind: integration
        ref: "tests/routers/test_push.py#test_subscribe_503_when_unconfigured"
        status: pass
      - kind: unit
        ref: "tests/test_push_send.py#test_send_to_user_unconfigured_returns_zero_result"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every push HTTP call is an awaited httpx.AsyncClient POST; the send path never imports/calls requests, no asyncio.to_thread"
    requirement: "PUSH-04"
    verification:
      - kind: unit
        ref: "tests/test_push_send.py#test_push_send_module_never_imports_requests_at_runtime"
        status: pass
      - kind: unit
        ref: "tests/test_push_send.py#test_push_send_source_declares_no_top_level_requests_import"
        status: pass
    human_judgment: false
  - id: D6
    description: "No vendor SDK/Firebase/paid dependency added; only webpush + cryptography, in an isolated push group excluded from the worker image"
    requirement: "PUSH-05"
    verification:
      - kind: unit
        ref: "tests/test_dependency_isolation.py#test_worker_dep_set_excludes_push_stack"
        status: pass
      - kind: unit
        ref: "tests/test_dependency_isolation.py#test_push_packages_present_only_in_push_group"
        status: pass
      - kind: unit
        ref: "tests/test_dependency_isolation.py#test_backend_dockerfile_opts_into_push_group"
        status: pass
    human_judgment: false
  - id: D7
    description: "The VAPID private key never leaks into logs, Sentry messages, or exception text (T-201-02)"
    verification:
      - kind: unit
        ref: "tests/test_push_send.py#test_no_key_leak_on_error_status_branch"
        status: pass
      - kind: unit
        ref: "tests/test_push_send.py#test_no_key_leak_on_transport_error_branch"
        status: pass
    human_judgment: false
  - id: D8
    description: "Real end-to-end push delivery to an actual subscribed browser (HUMAN-UAT, deferred per operator instruction)"
    verification: []
    human_judgment: true
    rationale: "This plan has no user-facing subscribe UI (Phase 202 owns it). The dev-trigger endpoint + curl is the automated substitute proven by the tracer test; genuine OS-notification delivery to a real browser needs a human with a subscribed device, per 201-RESEARCH.md's Validation Architecture HUMAN-UAT note."

duration: 45min
completed: 2026-08-02
status: complete
---

# Phase 201 Plan 01: Push Infrastructure Tracer Summary

**VAPID-signed, aes128gcm-encrypted Web Push send path (webpush + httpx.AsyncClient) proven end to end through a dev-only trigger endpoint, with the full push_subscriptions CRUD, status-branch prune logic, and worker-image dependency isolation.**

## Performance

- **Duration:** ~45 min
- **Completed:** 2026-08-02
- **Tasks:** 3
- **Files modified:** 19

## Accomplishments
- `push_subscriptions` table + `PushSubscription` model + `push_repository` (upsert-on-conflict-by-endpoint, list, delete-by-endpoint scoped to owner, delete-by-id for pruning)
- `push_send` service: `webpush` 1.0.6 for VAPID JWT signing + RFC 8291 aes128gcm encryption, `httpx.AsyncClient` (never `requests`) for the actual POST, `follow_redirects=False` SSRF mitigation, prune-only-on-404/410 branching with a fixed-message Sentry capture on every other error
- `push` router: subscribe (201/503), unsubscribe (204, IDOR-scoped), vapid-public-key (200/404), and a dev-only trigger endpoint fail-closed on `ENVIRONMENT != "development"`
- `train_reminder_service.build_reminder_payload` — the D-10 "Day N = streak_count + 1" copy builder, no `shield_level` framing
- Isolated `push` uv dependency group (mirrors `maia-inference`); `Dockerfile` opts in, `Dockerfile.worker` untouched — proven by an extended `tests/test_dependency_isolation.py`
- `scripts/gen_vapid_keys.py` operator one-shot keypair generator
- Full status-branch test table (201/200/404/410/400/401/403/413/429/500/503 + transport error), fan-out + idempotent-prune tests, CASCADE + unique-endpoint DB tests, and two `no_key_leak` tests proving the VAPID private key never reaches Sentry

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end push delivery — one subscription, one real send** - `b5f76a59e` (feat)
2. **Task 2: Prune, unsubscribe, and the full send-status branch table** - `6e9da65ad` (test)
3. **Task 3: Operator keygen script, dependency-isolation guard, and PUSH-04 evidence** - `16d6c0bc5` (feat)

_Note: Task 2 carried `tdd="true"` but the Task-1 implementation was already correct against every written test — no RED->GREEN cycle was needed; all 28 new tests passed on first run._

## Files Created/Modified
- `app/models/push_subscription.py` - `PushSubscription` ORM model, CASCADE-to-users, unique endpoint
- `app/repositories/push_repository.py` - upsert/list/delete CRUD, all V4 keyword-only `user_id`-scoped
- `app/schemas/push.py` - subscribe/unsubscribe/vapid-key/dev-trigger Pydantic schemas, HTTPS-only endpoint validator
- `app/services/push_send.py` - VAPID+aes128gcm send path, `PushFanoutResult`, `send_to_user` fan-out
- `app/services/train_reminder_service.py` - notification-copy layer (D-10/D-11/D-14)
- `app/routers/push.py` - the four push endpoints
- `scripts/gen_vapid_keys.py` - operator keypair generator
- `alembic/versions/20260801_221737_e02dc5378c12_phase_201_push_subscriptions.py` - migration, `down_revision='2c248989d979'`
- `tests/routers/test_push.py` - 8 router integration tests
- `tests/test_push_send.py` - 19 send-path unit tests
- `tests/models/test_push_subscription.py` - 3 DB constraint tests
- `pyproject.toml` - new `[dependency-groups].push` (webpush, cryptography)
- `Dockerfile` - `uv sync` gains `--group push`
- `.env.example` - documents `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`
- `app/core/config.py` - the three VAPID settings, empty-string-disabled
- `app/main.py` - registers the push router under `/api`
- `alembic/env.py` - imports `PushSubscription` so future autogenerate sees the table
- `tests/test_dependency_isolation.py` - extended with the `push` group isolation guard

## Decisions Made
- Router-test mocking deviates from the plan's literal "patch httpx.AsyncClient.post" instruction — see Deviations below.
- `list_subscriptions` gained `ORDER BY id` for deterministic fan-out ordering (not specified in the plan, needed for the 3-subscription status-branch test to be assertable).
- `PushFanoutResult.failed` counts only exceptions from the per-subscription try/except, not non-prune HTTP failures — matches Task 1's `send_to_subscription -> bool` contract (prune vs not-prune only).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Router-test `httpx.AsyncClient.post` patching would break its own test driver**
- **Found during:** Task 1 (tracer test, Step 9)
- **Issue:** The plan's literal instruction was "patch httpx.AsyncClient.post to return MagicMock(status_code=201)". `tests/routers/test_push.py` drives the outer HTTP request through `httpx.AsyncClient` + `ASGITransport` (the established router-test pattern shared with `test_train.py`). Patching `httpx.AsyncClient.post` at the class level intercepts ALL instances of that method — including the test's own call into the FastAPI app — since there is no way to distinguish "the test's own request" from "the app's outbound push send" once both go through the same patched class method.
- **Fix:** Patched `app.services.push_send.push_http_client` (the factory `send_to_user` calls to build its own outbound client) to return a small fake async-context-manager whose `.post` is the assertable `AsyncMock`. This targets only the outbound push send and leaves the ASGI-transport driving call untouched. `tests/test_push_send.py` (which never drives an outer ASGI request) still uses the plan's literal `patch("httpx.AsyncClient.post", ...)` approach for `send_to_user`, since there's no conflict there.
- **Files modified:** `tests/routers/test_push.py`
- **Verification:** All 8 router tests pass; the tracer test's assertions on target URL, `authorization`/`content-encoding` headers, and encrypted body content are unaffected.
- **Committed in:** `b5f76a59e` (Task 1 commit)

**2. [Rule 1 - Bug] `list_subscriptions` needed deterministic ordering for a multi-subscription test to be assertable**
- **Found during:** Task 2 (fan-out test with 3 subscriptions returning 201/410/500)
- **Issue:** PostgreSQL does not guarantee row order without `ORDER BY`; a test asserting "the second subscription got 410, the third got 500" needs the repository to return rows in a stable, predictable order.
- **Fix:** Added `.order_by(PushSubscription.id)` to `push_repository.list_subscriptions`.
- **Files modified:** `app/repositories/push_repository.py`
- **Verification:** `tests/test_push_send.py::test_send_to_user_fan_out_prunes_only_the_410_not_the_500` passes deterministically.
- **Committed in:** `6e9da65ad` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 — bug fixes needed for the tests themselves to be correct/deterministic, no production behavior change beyond the ordering addition).
**Impact on plan:** Both fixes were necessary for the plan's own verification to be achievable as written. No scope creep — no new endpoints, no new columns, no architectural change.

## Issues Encountered
- The installed `webpush` 1.0.6 package's API matched `201-RESEARCH.md`'s drafted signatures exactly (`WebPush.__init__`, `WebPush.get`, `VAPID.generate_keys`) — no divergence to reconcile.
- `ty check` initially flagged `Result.rowcount` (existing codebase suppression pattern applied), `WebPushSubscription.endpoint: AnyHttpUrl` vs a bare `str` (fixed with `pydantic.AnyHttpUrl(endpoint)`), and `dict(WebPushHeaders)` widening to `dict[str, object]` (fixed with an explicit `cast(dict[str, str], ...)`) — all resolved inline, zero remaining `ty` errors.

## User Setup Required
None for this plan — VAPID keys stay empty (D-03 graceful disable) until an operator runs `scripts/gen_vapid_keys.py` and pastes the output into `/opt/flawchess/.env`. That step belongs to actual prod enablement, not this plan's completion.

## Next Phase Readiness
- The push send chain (subscribe -> encrypt -> POST -> prune) is fully proven and ready for plan 201-02 (`push-sw.js`) to render what this chain sends.
- Plan 201-03 can now add `reminder_enabled`/`reminder_hour`/`reminder_last_sent_on` to `train_settings` without touching anything in this plan's migration.
- Plan 201-04's scheduler can call `push_send.send_to_user` and `train_reminder_service.build_reminder_payload` directly — both are already fan-out-safe and D-05/D-10/D-11-compliant.
- No blockers.

---
*Phase: 201-push-infrastructure-train-reminders*
*Completed: 2026-08-02*

## Self-Check: PASSED

All 11 created files verified present on disk; all 3 task commits (`b5f76a59e`, `6e9da65ad`, `16d6c0bc5`) verified present in git history.
