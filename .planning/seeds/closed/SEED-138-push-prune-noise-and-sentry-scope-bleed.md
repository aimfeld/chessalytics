---
id: SEED-138
status: dormant
planted: 2026-08-04
planted_during: investigation of Sentry FLAWCHESS-9J ("Push send returned a prune status", first prune capture since SEED-135 D1 shipped)
trigger_when: the next push/PWA phase, OR the next time a Sentry event's context looks like it belongs to a different background task, OR when prune captures start arriving regularly enough to be noise
scope: small (two independent fixes, both local; ~1 file each plus tests)
---

# SEED-138: the prune capture is mis-graded and un-diagnosable, and background-task Sentry scopes bleed into each other

## Why This Matters

SEED-135 D1 (2026-08-03) added a Sentry capture to `push_send.py`'s prune branch so it
would stop being the one branch that deletes state silently. That was right. Its first
real firing in prod (Sentry `FLAWCHESS-9J`, 2026-08-04 15:03:39Z) showed two problems —
one in the capture itself, one it merely exposed.

Neither is a crash. Both make Sentry actively misleading, which is worse than a gap.

## Problem 1 — normal device churn is graded as `level: error`, and can't be diagnosed

`app/services/push_send.py:176-191` captures a synthetic
`RuntimeError("Push send returned a prune status")` on 404/410.

**Mis-graded.** A 410 Gone is the *designed, expected* end of a subscription's life: the
push service permanently retired the endpoint (PWA removed from the home screen, browser
reinstall, site data cleared, FCM/APNs token rotation). Every one of those lands in
Sentry as an unresolved `level: error` issue forever. The `logger.warning` on line 184
already satisfies D1's actual requirement (don't delete state silently); the
exception-shaped capture is the part that turns routine lifecycle into an error.

Fix: `sentry_sdk.capture_message(..., level="info")`, or drop the capture and keep the
warning log. Keep the distinct fixed literal either way — D1's separate-grouping
rationale still holds.

**Un-diagnosable.** The `set_context` carries only `status_code` and `subscription_id`.
`send_to_user` deletes the row moments later (`push_send.py:263`), taking `user_agent`
and `endpoint` with it — so after the fact there is no way to tell *which device* died.
That is not hypothetical: it is exactly what blocked this investigation, which had to
prove the device's owner by elimination (only one prod user has `reminder_enabled`)
rather than by reading the event.

Fix: add to the context, at the call site where the row is still in hand —

- `push_host` — the endpoint's **host only** (`fcm.googleapis.com` /
  `web.push.apple.com` / `updates.push.services.mozilla.com`). The bearer capability is
  the endpoint *path*, not the host, so this is safe under D1's no-endpoint rule and
  makes iOS-vs-Android prunes distinguishable at a glance. Directly serves
  `[[SEED-136]]`, which is waiting on Apple-endpoint evidence.
- `user_agent` and `user_id`.

`send_to_subscription` already takes `subscription_id` keyword-only + defaulted for
backward compatibility with the 10 direct test callers (see its docstring); any new
field must follow that same shape.

## Problem 2 — all five background tasks share one Sentry isolation scope

The prune event carries context and spans belonging to a **completely different**
background task:

- context `best_move_candidates_fallback: {fallback_ply_count: 2, game_id: 2261015}`
- trace span `op: db`, description = the best-move **lottery** query
  (`SELECT u.id FROM users u WHERE EXISTS (... best_moves_completed_at IS NULL ...)`)

The reminder tick never touches either. Cause: `AsyncioIntegration` is not enabled in
`sentry_sdk.init` (`app/main.py:182-191`), and nothing anywhere in `app/` wraps a task
in `sentry_sdk.isolation_scope()` (grep for `isolation_scope|new_scope|AsyncioIntegration`
returns nothing). So every lifespan background loop inherits and shares the lifespan's
isolation scope.

Consequence: every `sentry_sdk.set_tag("source", ...)` and `set_context(...)` in a
background task **persists on the shared scope and leaks onto later, unrelated events**.
`source` is one of the two tags CLAUDE.md names as a filterable dimension, so this
corrupts exactly the dimension triage relies on — a future event can be tagged
`source: push_send` while having nothing to do with push.

Fix, either:
- wrap each background loop's per-tick body in `with sentry_sdk.isolation_scope():`
  (explicit, local, matches the existing per-tick try/except structure), or
- enable `AsyncioIntegration` in `sentry_sdk.init` (global, forks the scope per task).

Prefer the first if only some loops matter; the second is one line but changes scope
behavior for every task at once. Whichever is chosen, a test should assert that a tag set
inside one tick is absent from an event captured in the next.

## What this seed is NOT

The 410 itself was correct behavior and needs no fix. It was an orphaned row on user 28
(`FlawChessDev`): `upsert_subscription` keys on `endpoint`
(`push_repository.py:71-79`), so a device whose endpoint rotates inserts a **new** row and
leaves the old one to be pruned at the next send. Confirmed by the tick log
(`scanned=1 eligible=1 claimed=1 sent=1 pruned=1 failed=0`) and by the claim surviving —
`train_reminder_service.py:209` only releases when `attempted == pruned`, so ≥2 rows
existed. The prune *is* the cleanup.

## Evidence for `[[SEED-136]]` while we're here

As of 2026-08-04, prod `push_subscriptions` holds **exactly one row** — id 6, user 28,
`fcm.googleapis.com`, Android Chrome, created 2026-08-03 19:21. Still **no Apple endpoint
has ever existed**, including after an iPhone tester was actively exercising reminders on
a non-FlawChessDev account on 2026-08-04. That is a stronger signal than SEED-136's
2026-08-03 snapshot: an iPhone user tried and no row appeared, so SEED-136's
"first iPhone user reports missing reminders" trigger is arguably already met.

## Related

- `[[SEED-136]]` — iOS push built but never exercised; `push_host` in the prune context
  and the missing-Apple-endpoint evidence above both feed it directly.
- SEED-135 D1 — the change that added this capture (correct intent, wrong severity).
- Phase 201 (`push_send`, `push_repository`, push router), Phase 204 (`ttl_seconds`,
  `useDevicePushResync`).
- `[[project_prod_log_retention_use_sentry]]` — prod docker logs retain ~1h and drop app
  INFO, which is why the Sentry event's own context has to be good enough to diagnose
  from alone.
