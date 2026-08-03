---
id: SEED-135
status: dormant
planted: 2026-08-03
planted_during: v2.11 post-deploy UAT — operator set a 16:00 reminder on Android Chrome and received nothing
trigger_when: before the next push-related phase, or immediately if a second user reports missing reminders
scope: small-medium (independent fixes: backend observability, frontend re-sync, TTL correction; plus one scheduler ordering decision to settle)
---

# SEED-135: A pruned push subscription is silent, permanent, and burns the day's claim

## What Happened (the incident that planted this)

First real-world Train reminder after the v2.11 deploy. The scheduler worked perfectly;
the notification still never arrived, and **nothing anywhere recorded that fact**.

Timeline (Europe/Zurich, 2026-08-03, user 28):

| Time | Event |
|---|---|
| 15:35:17 | v2.11 backend started, phase 201/203 migrations ran |
| 15:37:13 | `POST /api/push/subscribe` → 201, row stored |
| 15:50 | tick #1 — hour 15 < `reminder_hour` 16, not eligible |
| **16:05** | tick #2 — eligible, day claimed, send attempted, **FCM returned 404/410**, row pruned |
| 16:20 | tick #3 — `reminder_last_sent_on` already today, no-op |

Diagnosis had to be reconstructed **entirely by inference**, because the prune path emits
nothing: `train_settings.reminder_last_sent_on = 2026-08-03` proved the tick reached the
send (only `claim_reminder_day` writes that column, and it runs immediately before the
POST), and `push_subscriptions` was empty with no `/api/push/unsubscribe` in the logs,
which leaves `push_send.py`'s 404/410 branch as the only possible deleter.

Everything server-side was verified healthy and is **not** the problem: `sw.js` ships
`importScripts("/push-sw.js")`, `push-sw.js` is served `cache-control: no-cache`, the
served VAPID key matches the PEM in `/opt/flawchess/.env`, `VAPID_SUBJECT` is a valid
mailto, and a real VAPID-signed POST from inside the prod container reached FCM and got a
clean `410 push subscription has unsubscribed or expired` (not 401/403) — so signing,
aes128gcm encryption, and outbound connectivity all work. No code path calls
`registration.unregister()`. Chrome invalidated the subscription device-side somewhere
between 15:37 and 16:05; **why** is not determinable from server data.

The root cause was a one-off device-side hiccup. The reason it cost a full day and a
30-minute investigation is the three defects below.

## The Three Defects

### D1 — The prune is completely silent (backend, observability)

`app/services/push_send.py:127`:

```python
if resp.status_code in _PRUNE_STATUS_CODES:
    return True
```

Returns `True`, and `send_to_user` deletes the row — with **no log line, no
`sentry_sdk.capture_exception`, no counter**. Note the asymmetry: every *other* non-2xx
status one line below *does* get a `logger.warning` + Sentry capture. The one branch that
permanently destroys state is the one that says nothing.

Consequence: a user's reminders can die forever and the only trace is the absence of a
row. There is also no aggregate visibility — `ReminderTickSummary` counts `pruned`, but
that only reaches a `logger.info`, and **app-level INFO is filtered out in prod** (verified:
`WARNING`-level lines from `atomic-submit` appear in `docker compose logs`, the reminder
tick's `logger.info` summary does not appear at all).

Fix direction: log at WARNING and capture to Sentry on prune, tagged `source=push_send`,
with `set_context` carrying the status code and subscription id (never the endpoint — it
is a bearer capability). Consider promoting the per-tick summary to WARNING, or emitting
it only when `pruned > 0 or failed > 0`.

### D2 — Nothing ever re-subscribes (frontend) ← the one that actually matters

`pushApi.subscribe` has exactly one caller, `ensureDeviceSubscribed` in
`frontend/src/lib/push.ts`, which only runs on explicit user gestures:
`TrainReminderButton`, `TrainScheduleSettings`, `TrainReminderResurfaceBanner`. **There is
no re-sync on app load or on Train page mount.**

So after a server-side prune the two sides desync permanently: `train_settings.reminder_enabled`
stays `true`, the UI happily renders "reminders on", the browser still holds its own
`PushSubscription` object — and the server has no row to send to. The user is dark forever
and the UI actively lies about it. Only manually toggling reminders off and on recovers.

This is what converts a transient device-side hiccup into a permanent silent failure, and
it is the highest-value fix of the three.

Fix direction: on Train mount (or app load when `reminder_enabled`), compare
`getDeviceSubscription()` against server state and re-POST when the device has a live
subscription the server doesn't know about. Needs a cheap server-side "do you have a live
subscription for this endpoint?" signal, or just an idempotent re-POST — `upsert_subscription`
is already `ON CONFLICT DO UPDATE` on `endpoint`, so a blind re-POST is safe and needs no
new endpoint. Guard it so it cannot spend the one-shot `Notification.requestPermission()`
(PERM-01) — this path must never call `subscribe()`, only re-register an *existing* device
subscription.

### D3 — A failed send burns the day's claim (scheduler ordering)

`claim_reminder_day` commits **before** the send (D-07, deliberate: it makes a double-send
structurally impossible across a crash mid-fan-out), and D-04 explicitly rejects retries.
Combined, a 410 consumes the day: `reminder_last_sent_on = today` blocks every later tick,
so even re-subscribing one minute later yields nothing until tomorrow. Operator had to
`UPDATE train_settings SET reminder_last_sent_on = NULL` by hand on prod to test again.

This is a *known and accepted* consequence of D-07, not an oversight — so treat it as a
decision to revisit, not a bug to blindly fix. The tension is real: releasing the claim on
failure reintroduces exactly the double-send window D-07 exists to close.

Fix direction (weakest of the three, do not over-build): the narrow case worth handling is
"the fan-out attempted zero subscriptions, or every subscription was pruned" — nothing was
delivered and nothing *could* have been, so no double-send risk exists in releasing the
claim. `PushFanoutResult` already carries `attempted`/`pruned`/`failed`, so the condition
is expressible without new plumbing. Leave the partial-failure case alone.

### D4 (latent, not this incident) — `existing ??` never validates the key

`ensureDeviceSubscribed` does:

```js
const existing = await registration.pushManager.getSubscription();
const subscription = existing ?? (await registration.pushManager.subscribe({ ... }));
```

It reuses whatever `getSubscription()` returns **without comparing
`existing.options.applicationServerKey` to the current VAPID key**. A VAPID key rotation
would therefore leave every device silently holding a dead subscription, with FCM 403-ing
(not 410-ing) every send forever. Standard practice is to compare and `unsubscribe()` +
re-subscribe on mismatch. Cheap to add alongside D2; note the rotation runbook does not
exist either.

### D5 — `TTL: 0` contradicts D-08 and makes non-delivery invisible

`app/services/push_send.py:49` sends every push with `TTL: 0`, justified as "a reminder is
worthless once its hour has passed (D-04/D-08 already own lateness), so we do not ask for
retention."

**That rationale inverts what D-08 actually says.** The hour gate in
`train_reminder_service.py:146` is deliberately inclusive with *no upper bound* — "the end
of the user's local day is the only bound, so a deploy at 18:05 or a short outage never
silently costs a user their reminder." The scheduler is explicitly built to tolerate
lateness within the local day; `TTL: 0` then tells the push service to discard the message
outright unless the device is reachable at that exact instant. The two decisions pull in
opposite directions, and the TTL wins.

`TTL: 0` is zero-tolerance for entirely normal phone states: Android Doze (screen off and
stationary — the likely state of a phone at a 17:00 reminder), off Wi-Fi mid-handover, or
any momentary network blip. Note this is *independent* of the app being closed: a closed
app is the normal, designed case for Web Push (the OS wakes the SW), and is not itself a
problem.

**The nasty part is that it is indistinguishable from success.** A discarded message
returns **201**, not an error — so `send_to_subscription` returns `False`, the row
survives, no log, no Sentry, `ReminderTickSummary.sent` increments. Server state after a
silent discard is byte-identical to server state after a real delivery. Do not read
`sent=1` + a surviving subscription row as proof a notification was shown; it isn't.

Fix direction: set TTL to the remaining seconds in the user's local day (consistent with
D-08's own bound), or simply a few hours. `renotify: false` + the fixed `train-reminder`
tag already collapse a backlog to one notification (D-14), so retention cannot produce a
pile-up — the stated reason for TTL 0 is already handled by the tag.

## Open Questions

- **D3 is a decision, not a fix.** Does releasing the claim on a total-non-delivery fan-out
  actually violate D-07's invariant, or is `attempted == pruned` a genuinely safe carve-out?
  Settle this before writing code.
- Should a prune also flip `reminder_enabled` to `false`, so the UI stops lying? That is
  arguably more honest than D2's silent re-sync, but it discards user intent over what may
  be a transient device hiccup — and re-enabling costs the user a trip through Settings.
  Probably no; D2 is the better answer. Worth an explicit call.
- **D5 undermines the evidence base for D1/D3.** Because a `TTL: 0` discard is
  indistinguishable from a delivery server-side, we currently cannot tell "reminder sent
  and shown" from "reminder sent and dropped" for *any* past tick. Fixing D5 (or adding a
  client-side delivery ack) may be a prerequisite for trusting any push metric we add.
- Is there a cheap way to distinguish "Chrome dropped it" from "user revoked notification
  permission"? Both surface as 410 server-side, but they want opposite UX (silently
  re-register vs. stop nagging).
- No alerting exists on push health at all. Even after D1, someone has to be looking. Is a
  Sentry alert rule on `source=push_send` worth it at this volume?

## Related

- Phase 201 (push subscriptions + reminder tick), Phase 203 (reminder intent/resurface).
- `app/services/push_send.py`, `app/services/train_reminder_service.py`,
  `app/repositories/train_reminder_repository.py`, `frontend/src/lib/push.ts`.
- Decisions in tension: D-04 (no retry), D-07 (claim before send), PERM-01 (one-shot
  permission, single call site).
