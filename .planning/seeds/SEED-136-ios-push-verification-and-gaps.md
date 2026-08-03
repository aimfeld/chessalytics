---
id: SEED-136
status: dormant
planted: 2026-08-03
planted_during: post-Phase-204 question — "is there a chance push already works on iPhone?"
trigger_when: the first iPhone user reports missing reminders, OR an `apple` endpoint first appears in `push_subscriptions`, OR before any further push/PWA phase
scope: small (one operator device test; then 2-3 small frontend fixes, only if the test fails)
---

# SEED-136: iOS push is built but never exercised — verify it, then close three known iOS-only gaps

## Why This Matters

Phases 201-204 shipped a Web Push stack that *should* work on iPhone, and the iOS path was
deliberately designed rather than accidentally supported. But **no Apple push endpoint has
ever existed in production**, so every Apple-specific assumption below is untested
inference, not evidence.

Prod, 2026-08-03:

```sql
SELECT ... FROM push_subscriptions GROUP BY service;
-- fcm | 1 sub | 1 user | newest 2026-08-03 14:47
-- (no rows for apple)
```

Phase 204's real-device UAT (`204-03-SUMMARY.md`) was Android/Chrome only. The one and only
send path that has ever been proven end-to-end is FCM.

## What Is Already In Place (verified by reading, not by running)

Every Apple-specific requirement appears to be satisfied:

| Requirement | Where | Status |
|---|---|---|
| Manifest `display: 'standalone'` (precondition for an iOS installed web app) | `frontend/vite.config.ts:65` | present |
| SW always calls `showNotification` on `push` (iOS enforces `userVisibleOnly` and revokes on silent pushes) | `frontend/public/push-sw.js` | present |
| VAPID JWT `aud = scheme://hostname` → `https://web.push.apple.com` | `app/services/push_crypto.py:149` | present |
| `sub` is a `mailto:` (Apple rejects a missing/invalid `sub` with 400 BadJwtToken) | `push_crypto.py:151`, `VAPID_SUBJECT` default `push@flawchess.com` | present |
| ES256, `exp` 12h (Apple rejects `exp` > 24h) | `push_crypto.py:154`, `_VAPID_EXPIRATION_SECONDS` | present |
| `Ttl` > 0 (Apple discards a TTL-0 message and still returns 201) | `push_send.py:77`, fixed by Phase 204 D5 | present |
| An iOS-tab UI path that survives the absent `PushManager` | `reminderSlotState.ts` resolves `ios-tabbed` BEFORE the `available` gate | present |
| Install instructions, then a real subscribe control after install | `TrainReminderButton.tsx:207` (`ios-tabbed`) → `standalone-unsubscribed` | present |

So the expected iPhone flow is: Safari tab → "Get reminders" → "tap Share then Add to Home
Screen" → open the installed app → "Remind me" → permission prompt → subscribe. **Push in a
plain Safari tab can never work** (no `PushManager` before install); that is by design, not
a defect.

## Step 1 — The Verification (do this first; it may close the seed)

On an iPhone running iOS 16.4+, from **Safari**:

1. Open flawchess.com/train, tap **Get reminders**, follow the Share → Add to Home Screen
   instructions.
2. Launch from the Home Screen icon, tap **Remind me**, accept the permission prompt.
3. Confirm a row appears: `SELECT count(*) FROM push_subscriptions WHERE endpoint LIKE '%apple%'`.
4. Wait for the scheduled reminder (or set `reminder_hour` to the next hour).

Outcomes:

- **Row appears + notification arrives** → iOS works. Close this seed, keep only the three
  gaps below as a judgement call.
- **Row appears, no notification** → Sentry has the answer. `push_send.py` captures every
  non-2xx with `source: push_send` and the status code in `set_context` (SEED-135 D1 also
  made the 404/410 prune branch non-silent). A 400 there points at the JWT claims; a 403 at
  the key.
- **No row** → the failure is client-side, in `ensureDeviceSubscribed`, captured with
  `source: push`.

## Step 2 — The Three iOS-Only Gaps (fix only what the test justifies)

### G1 — iOS < 16.4 dead end (cosmetic, but it is a broken promise)

`ios-tabbed` resolves on `isIOS && !isStandalone && !subscribed` alone — deliberately, since
gating it on `available` would leave the slot empty forever (`PushManager` is absent in an
iOS tab). The side effect: an iOS 15 user is told to install the app, installs it, and finds
nothing — in standalone, `isPushSupported()` is still false, so the slot resolves to
`hidden`.

Options: detect the standalone-but-unsupported combination and show a short "your iOS
version doesn't support this" line instead of nothing; or accept it (the affected population
is shrinking and overlaps the iOS <16.4 no-WASM-SIMD Maia population already documented in
`project_maia_ios_two_failure_populations`).

### G2 — The install copy assumes Safari

"tap **Share** then **Add to Home Screen**" is Safari-share-sheet shaped. On older iOS, only
a Safari-installed web app gets push at all; a user following these steps inside Chrome iOS
may end up with an install that can never receive a notification. Worth a check on what
third-party iOS browsers actually do today before writing any copy.

### G3 — Silent subscription loss hits iOS hardest

iOS drops push subscriptions more readily than Chrome (app removal, long non-use, storage
eviction). Phase 204's passive re-sync (`resyncExistingSubscription`, D-04/D-05) only
re-POSTs an **already-live** subscription; it never mints a new one, by design, to keep
PERM-01 structural. Consequence: an iPhone user whose subscription is dropped device-side
silently stops receiving reminders until they re-toggle, with no in-app signal that anything
broke.

Note that `PushManager.subscribe()` does **not** prompt when `Notification.permission ===
'granted'`, so a re-mint on the standalone path would not spend the one-shot permission —
which means D-04/D-05 could in principle be revisited for the already-granted case. That is
a decision, not an obvious fix: it widens the set of code paths allowed to call `subscribe()`
beyond the single gesture-driven one `push.ts` exists to guarantee.

## Related

- SEED-135 (closed) — the Android incident that produced the prune observability this
  verification depends on.
- Phase 202 `202-CONTEXT.md:158-164` — the original "accepted, known gap: an iPhone user sees
  no hint the feature exists" decision, which Phase 203's `ios-tabbed` state later closed.
- `docs/push-vapid-rotation-runbook.md` — unrelated to iOS, but the same send path.
