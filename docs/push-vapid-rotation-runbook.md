---
title: VAPID key rotation runbook
date: 2026-08-03
context: operator procedure for rotating the Web Push VAPID keypair. Written as part of
  Phase 204 (Push Reminder Delivery Reliability, D-06), which closed the gap left by
  Phase 201 D-02 — that decision locked rotation as accepted mass invalidation but the
  procedure itself lived only in an archived `.planning/` file until now.
source: app/services/push_send.py, app/repositories/push_repository.py, frontend/src/lib/push.ts
---

# VAPID key rotation runbook

This is the procedure for rotating the Web Push VAPID keypair that signs every push
notification FlawChess sends (Train reminders today; nothing else uses push yet).

## When to rotate

**Only on key compromise.** Rotation is not routine hygiene. Phase 201 D-02 is LOCKED:
rotating the VAPID keypair is accepted mass invalidation of every existing device
subscription, on purpose — there is no dual-key or staged rollover path, and building one
is explicitly out of scope. Do not rotate speculatively or on a schedule.

## What breaks

Every existing `push_subscriptions` row was minted against the old
`applicationServerKey`. Once the new keypair is live, the push service will reject every
send against those old rows with a permanent 403 (not the 404/410 this app already
treats as "prune me") — they will never self-prune. `train_settings.reminder_enabled`
stays `true` for those users, so the UI keeps promising reminders until each device is
individually touched. This is deliberate (CONTEXT.md D-12): a self-heal on the user's
next reminder gesture is the better answer than flipping the flag to make the app honest
about a state it can fix on its own.

## Procedure

1. Generate a new VAPID keypair (any standard tool that produces a P-256/ES256 keypair
   in the format `push_crypto.py` expects works — see that module for the exact PEM
   parsing it does).
2. Set `VAPID_PRIVATE_KEY` and `VAPID_PUBLIC_KEY` in `/opt/flawchess/.env` on the
   production server. **Never commit these values** — `.env` is server-local only.
3. Confirm `VAPID_SUBJECT` is still a valid `mailto:` address (it does not need to
   change during a rotation, but confirm it wasn't left blank).
4. Restart the backend so the new keys are read into the running process:
   `ssh flawchess "cd /opt/flawchess && docker compose restart backend"`.
5. Truncate the subscriptions table — every existing row is now dead weight that will
   only produce 403 noise in Sentry:
   ```sql
   TRUNCATE push_subscriptions;
   ```
6. Confirm the new key is live: `GET /api/push/vapid-public-key` should return the NEW
   public key. `application_server_key()` derives this from the PEM at call time on
   every request, so a stale hand-pasted value cannot drift out of sync with what was
   actually set in step 2.

## What users experience, and what recovers them

Nothing arrives until each device is individually touched — there is no passive,
automatic recovery for a rotated key. Recovery happens on the user's next
reminder-related **gesture**: the Train score screen's reminder button, the Settings
reminder toggle, or the iOS resurface banner. These are the only three callers of
`ensureDeviceSubscribed`, and as of Phase 204 that function detects a key mismatch (or a
missing/unreadable key) and repairs it by destroying the stale subscription and minting a
fresh one under the current key — including a subscription that predates this fix
entirely.

**The passive app-load re-sync added in Phase 204 does NOT repair a key mismatch.** It
detects one and deliberately does nothing (CONTEXT.md D-04/D-05) — Phase 201 D-02 already
accepted rotation as mass invalidation and explicitly rejected building a passive
self-heal for an event expected to be rare. If a future incident makes that decision
worth revisiting, the escape hatch is already recorded so it costs no re-research: a
passive repair guarded on `Notification.permission === 'granted'` provably cannot spend
the one-shot notification permission (`PushManager.subscribe()` does not prompt when
permission is already granted), so reversing this narrowing would be declined on the D-02
"do we want this machinery" grounds, not on a PERM-01 safety objection.

## How to verify the rotation landed

On one real device: toggle reminders off and back on in Settings (or use any of the
three gesture entry points above). Then confirm a fresh row exists —

```sql
SELECT id, user_id, left(endpoint, 40) FROM push_subscriptions WHERE user_id = <you>;
```

— and, in development only, that `POST /api/push/dev/trigger-reminder` for that user
reports `attempted == 1` and `pruned == 0`.
