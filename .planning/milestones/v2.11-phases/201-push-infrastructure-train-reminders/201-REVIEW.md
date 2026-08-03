---
phase: 201-push-infrastructure-train-reminders
reviewed: 2026-08-02T00:00:00Z
depth: standard
files_reviewed: 26
files_reviewed_list:
  - CHANGELOG.md
  - Dockerfile
  - alembic/env.py
  - alembic/versions/20260801_221737_e02dc5378c12_phase_201_push_subscriptions.py
  - alembic/versions/20260801_225358_ca8c8fbc2080_phase_201_train_reminder_columns.py
  - app/core/config.py
  - app/main.py
  - app/models/push_subscription.py
  - app/models/train_settings.py
  - app/repositories/push_repository.py
  - app/repositories/train_reminder_repository.py
  - app/repositories/train_repository.py
  - app/routers/push.py
  - app/routers/train.py
  - app/schemas/push.py
  - app/schemas/train.py
  - app/services/push_send.py
  - app/services/train_reminder_service.py
  - app/services/train_scheduler.py
  - deploy/Caddyfile
  - frontend/public/push-sw.js
  - frontend/src/__tests__/pushServiceWorker.test.ts
  - frontend/vite.config.ts
  - pyproject.toml
  - scripts/gen_vapid_keys.py
  - tests/models/test_push_subscription.py
  - tests/repositories/test_train_repository.py
  - tests/routers/test_push.py
  - tests/routers/test_train.py
  - tests/services/test_train_reminder_service.py
  - tests/services/test_train_scheduler.py
  - tests/test_dependency_isolation.py
  - tests/test_main_lifespan.py
  - tests/test_push_send.py
findings:
  critical: 0
  warning: 3
  info: 1
  total: 4
status: issues_found
---

# Phase 201: Code Review Report

**Reviewed:** 2026-08-02T00:00:00Z
**Depth:** standard
**Files Reviewed:** 26 (of 27 listed; `.env.example` could not be read — sandbox denies access to `.env*` paths regardless of tool. Not a code defect; flagging so the gap is visible rather than silently skipped.)
**Status:** issues_found

## Summary

This phase adds Web Push send infrastructure (`push_subscriptions`, VAPID signing via
`webpush` + `httpx.AsyncClient`) and a periodic Train reminder job on top of it. The
implementation is unusually disciplined for its risk surface: every push endpoint scopes
to `current_active_user.id` (no IDOR), the VAPID private key never reaches a log line,
exception message, or Sentry payload (verified by dedicated `test_no_key_leak_*` tests
that scan captured exception str/repr and every `set_context`/`set_tag` call for PEM body
lines), `requests` is proven absent from the send path at both the AST level and via a
subprocess import check, and the D-07 claim-then-send ordering (`claim_reminder_day`
committed strictly before any network POST) is implemented exactly as specified and
covered by a real concurrent-claim test (`test_two_sequential_committed_calls_yield_exactly_one_true_idempotent`)
that relies on PostgreSQL's actual row-lock re-check semantics, not a mocked assertion.
The two migrations are a clean linear chain, reversible, and add NOT-NULL columns with
constant `server_default`s (a no-rewrite fast path on PG 11+, safe against the live
`train_settings` table). D-12's settle-before-copy step is committed as its own step
strictly before the claim, matching the plan, and is exercised by
`test_stale_streak_is_settled_before_copy_is_built`, which seeds a genuinely stale/
unsettled streak and asserts the notification body reflects the *settled* count.

The documented SSRF posture (T-201-01: `https`-only endpoint validation,
`follow_redirects=False`, a bounded per-request timeout, deliberately no push-service
host allowlist per `COVERAGE.md`'s `OPT-OUT`) is genuinely present in code, not just
described in the plan docs — I verified each of the three claimed mitigations at
`app/schemas/push.py:25-31` and `app/services/push_send.py:95-102`. I have not
re-litigated that decision. What I did find is that the "bounded timeout" claim is
weaker than it reads: `httpx`'s single-float `timeout=` sets the *read* timeout, which is
an inter-chunk idle timeout, not a wall-clock cap on the whole response — see WR-02
below for a concrete scenario. I also found a real status-handling gap (WR-01) and an
inconsistency where the dev-only reminder trigger endpoint skips the guest gate every
other `/train/*`-adjacent handler enforces (WR-03).

## Warnings

### WR-01: 3xx responses from a push endpoint are silently treated as a successful send

**File:** `app/services/push_send.py:140-147`

**Issue:** `send_to_subscription`'s status branch only handles two cases explicitly:

```python
if resp.status_code in _PRUNE_STATUS_CODES:      # 404/410
    return True
if resp.status_code >= 400:                       # 400/401/403/413/429/5xx
    logger.warning(...)
    sentry_sdk.capture_exception(...)
return False
```

Any `3xx` response (a redirect the client deliberately does not follow, per the
`follow_redirects=False` SSRF mitigation at line 102) falls through to `return False` —
the exact same code path as a genuine `200`/`201` delivery. There is no log line, no
Sentry capture, and no distinguishing signal anywhere. Concretely: a push service (or an
attacker-registered "endpoint" used to probe the mitigation) that answers with `301`/`302`
is recorded as "delivered", the subscription is neither pruned nor flagged, and the tick
summary (`ReminderTickSummary.sent`) counts it as a successful send even though nothing
was actually delivered to any real device. `tests/test_push_send.py`'s status-branch
table exercises `200/201/404/410/400/401/403/413/429/500/503` but has no `3xx` case, so
this gap is untested as well as unhandled.

**Fix:** Treat anything outside `2xx ∪ {404, 410}` as a non-prune failure that still logs
and captures, e.g. widen the second branch to `resp.status_code not in (200, 201, 204)`
or explicitly add a `300 <= resp.status_code < 400` branch that logs + captures like the
`>= 400` case, and add a `3xx` case to the status-branch test table.

### WR-02: the "bounded timeout" SSRF mitigation does not bound total response duration

**File:** `app/services/push_send.py:95-102` (client construction), `:175-201`
(`send_to_user`'s sequential fan-out loop); `app/services/train_reminder_service.py:215-234`
(`send_due_reminders`'s sequential per-candidate loop)

**Issue:** `push_http_client()` builds `httpx.AsyncClient(timeout=_PUSH_TIMEOUT_SECONDS,
follow_redirects=False)` with a single float. Per httpx's semantics, a scalar `timeout=`
sets *all four* timeout categories (connect/read/write/pool) to that value, and the read
timeout is an **inter-chunk idle timeout** — the maximum gap between two received bytes —
not a cap on the total wall-clock duration of the response. A registered `endpoint` (any
authenticated user, including a guest, can create one via `POST /push/subscribe`, which
has no guest gate) that trickles its response body slowly enough to keep every inter-byte
gap under 10s can hold the connection open far longer than 10 seconds — in principle
indefinitely.

Because `send_to_user`'s per-subscription loop (`app/services/push_send.py:176-200`) and
`send_due_reminders`'s per-candidate loop (`app/services/train_reminder_service.py:215`)
are both strictly sequential — by design, to avoid `asyncio.gather` on a shared
`AsyncSession` per CLAUDE.md — a single slow-drip subscription stalls delivery to every
*other* live subscription of the same user, and (since candidates are processed one at a
time within one tick) delays the reminder for every other user queued behind it in that
same 15-minute tick. Concrete scenario: register a subscription whose `endpoint` points at
an attacker-controlled HTTPS server that accepts the POST and then drips the response
body one byte every 8 seconds; that candidate's `send_to_subscription` call blocks for
minutes while every subsequent candidate in the same tick waits behind it.

**Fix:** Pass an explicit `httpx.Timeout(connect=..., read=..., write=..., pool=...)`
plus an outer deadline via `asyncio.wait_for(client.post(...), timeout=_PUSH_TIMEOUT_SECONDS)`
(or httpx's newer overall-timeout support) so a slow-drip response cannot exceed the
intended bound regardless of per-chunk pacing.

### WR-03: the dev-only reminder trigger endpoint skips the guest gate every other Train-adjacent handler enforces

**File:** `app/routers/push.py:107-133`

**Issue:** `POST /api/push/dev/trigger-reminder` calls
`train_repository.get_or_create_settings(session, user_id=user.id)` and then
`push_send.send_to_user(...)` for `current_active_user`, with no `user.is_guest` check.
Every `/train/*` handler in `app/routers/train.py` calls `_reject_guest(user)` as its
*first* statement specifically because D-05 (LOCKED) states "Train is not available to
guest accounts", and `_reject_guest`'s own docstring says it is "centralized so no route
can forget it." This dev endpoint is train-settings-adjacent (it reads/creates a
`train_settings` row and sends a Train-reminder-shaped payload) but is not itself in
`train.py`, so it falls outside that centralization and was missed. Concretely: in a dev
environment, a guest session can call this endpoint to create a `train_settings` row for
itself and receive a real push notification, even though the guest could never reach
`/train/settings` to enable reminders through the normal product surface. Impact is
bounded to dev/test environments (the endpoint 404s outside `ENVIRONMENT == "development"`
per T-201-04, correctly verified elsewhere), but it is a real inconsistency with the
codebase's own stated invariant and could produce misleading results for a developer
manually verifying guest exclusion via this endpoint.

**Fix:** Add `if user.is_guest: raise HTTPException(status_code=404)` (matching the
existing environment gate's style) at the top of `dev_trigger_reminder`, before it
touches `train_repository`.

## Info

### IN-01: dev trigger reminder builds its payload from the pre-settlement streak count

**File:** `app/routers/push.py:123-127`

**Issue:** The real periodic job (`train_reminder_service._process_candidate`) is a
documented *writer* of streak state — it calls `settle_streak_snapshot` and commits it
before building `build_reminder_payload(streak_count=...)` (D-12), specifically so a
lapsed user's "Day N" is honest. The dev trigger endpoint instead calls
`get_or_create_settings` and passes `settings_row.streak_count` straight into
`build_reminder_payload` without ever calling `settle_streak_snapshot`. For a freshly
created user (`streak_count == 0`, the case the existing
`test_dev_trigger_reminder_body_names_day_one_for_zero_streak` test covers) this is
indistinguishable from the real job's output, but for an existing user with a stale,
unsettled streak (elapsed missed scheduled days not yet judged), the dev endpoint's
"Day N" can disagree with what the real job would actually send — misleading during
manual D-10 verification against a real account. Low impact (dev-only tool, and the
endpoint's own docstring already documents that it deliberately bypasses the
hour/weekday/already-sent gates — settlement just isn't called out as one of the
things being skipped).

**Fix:** Either call `settle_streak_snapshot` (committed) before building the payload to
mirror the real job's D-12 ordering, or add an explicit docstring note that the streak
number shown may be stale relative to what the real job would report.

---

_Reviewed: 2026-08-02T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
