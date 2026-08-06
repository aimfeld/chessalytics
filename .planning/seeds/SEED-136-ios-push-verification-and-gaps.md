---
id: SEED-136
status: active
planted: 2026-08-03
planted_during: post-Phase-204 question — "is there a chance push already works on iPhone?"
triggered: 2026-08-05 (both clauses fired the same evening — see Step 0)
trigger_when: FIRED — the first `apple` endpoints appeared in `push_subscriptions` on 2026-08-05
scope: small (the Apple *send* path is now verified end-to-end on macOS Safari; what remains
  is iOS-only *client* UI, which is React code with existing unit coverage)
---

# SEED-136: iOS push is built but never exercised — verify it, then close three known iOS-only gaps

## Why This Matters

Phases 201-204 shipped a Web Push stack that *should* work on iPhone, and the iOS path was
deliberately designed rather than accidentally supported. As planted (2026-08-03), **no
Apple push endpoint had ever existed in production**, so every Apple-specific assumption
below was untested inference:

```sql
-- Prod, 2026-08-03
SELECT ... FROM push_subscriptions GROUP BY service;
-- fcm | 1 sub | 1 user | newest 2026-08-03 14:47
-- (no rows for apple)
```

Phase 204's real-device UAT (`204-03-SUMMARY.md`) was Android/Chrome only.

**That changed on 2026-08-05.** A macOS Safari test (Step 0) proved the Apple *send* path
end-to-end, converting the inference rows in the table below into evidence. The residual
risk is now confined to the iOS-only client UI.

## What Is Already In Place

`Status` distinguishes **RUN** (exercised against Apple's live service on 2026-08-05, see
Step 0) from **READ** (still inference from the source alone):

| Requirement | Where | Status |
|---|---|---|
| Manifest `display: 'standalone'` (precondition for an iOS installed web app) | `frontend/vite.config.ts:65` | READ |
| SW always calls `showNotification` on `push` (iOS enforces `userVisibleOnly` and revokes on silent pushes) | `frontend/public/push-sw.js` | **RUN** |
| VAPID JWT `aud = scheme://hostname` → `https://web.push.apple.com` | `app/services/push_crypto.py:149` | **RUN** |
| `sub` is a `mailto:` (Apple rejects a missing/invalid `sub` with 400 BadJwtToken) | `push_crypto.py:151`, `VAPID_SUBJECT` default `push@flawchess.com` | **RUN** |
| ES256, `exp` 12h (Apple rejects `exp` > 24h) | `push_crypto.py:154`, `_VAPID_EXPIRATION_SECONDS` | **RUN** |
| `Ttl` > 0 (Apple discards a TTL-0 message and still returns 201) | `push_send.py:77`, fixed by Phase 204 D5 | **RUN** |
| aes128gcm payload accepted by Apple and decrypted by WebKit | `push_crypto.py:62` | **RUN** (see Step 0 caveat) |
| `notificationclick` focuses an existing client and navigates (D-13) | `push-sw.js:50-70` | **RUN** |
| An iOS-tab UI path that survives the absent `PushManager` | `reminderSlotState.ts` resolves `ios-tabbed` BEFORE the `available` gate | READ |
| Install instructions, then a real subscribe control after install | `TrainReminderButton.tsx:207` (`ios-tabbed`) → `standalone-unsubscribed` | READ |

Note that the backend contains **no Apple-specific branching at all** (`grep -rn "apple" app/`
returns one unrelated comment in `endgame_repository.py`). `aud` is derived generically from
the endpoint host, so the bytes POSTed for an iPhone subscription are identical to those a
macOS Safari subscription produces. That is what makes Step 0 a valid proxy for the send leg.

So the expected iPhone flow is: Safari tab → "Get reminders" → "tap Share then Add to Home
Screen" → open the installed app → "Remind me" → permission prompt → subscribe. **Push in a
plain Safari tab can never work** (no `PushManager` before install); that is by design, not
a defect.

## Step 0 — macOS Safari verification (DONE, 2026-08-05): the send leg passes

macOS Safari 16.1+ supports Web Push in a **plain tab** (the install requirement is
iOS-only), and subscribes against the same Apple Push Service, yielding a
`https://web.push.apple.com/...` endpoint. Combined with the no-Apple-branching note above,
that makes it a faithful proxy for everything server-side.

Run against prod with a scratch account (user 551, `Europe/Zurich`, `reminder_hour = 21`,
`weekday_mask = 127`). **Result: the notification arrived**, and clicking it opened `/train`.

Evidence chain, which is worth reusing because none of it depends on seeing the banner:

| Signal | Observed | Means |
|---|---|---|
| `train_settings.reminder_last_sent_on` | `2026-08-05` (= `CURRENT_DATE`) | tick ran, every gate passed, day claimed |
| claim not released | `reminder_last_sent_on` still set | `attempted > 0` and `attempted != pruned` |
| no `Train reminder tick` line in `docker compose logs` | absent over 45 min | `pruned == 0` **and** `failed == 0` |

The third row is the load-bearing one and it is *inverted* logic, so it needs stating: the
app configures no logging at all (`app/main.py` only calls `getLogger`; no `basicConfig`,
no `dictConfig`, no `--log-level` in `deploy/`), so the root logger sits at uvicorn's
default WARNING. App-level INFO never reaches docker logs. The tick summary logs at WARNING
**iff** `pruned > 0 or failed > 0` (`train_reminder_service.py:276`). Its *absence* is
therefore positive evidence of a clean fan-out, not evidence the job didn't run.

Beware the tempting wrong signal: `reminder_last_sent_on` being set does **not** prove Apple
accepted the POST. `release_reminder_claim` excludes `failed` deliberately
(`train_reminder_service.py:209`), so a 400 `BadJwtToken` still leaves the watermark
standing. Only the WARNING-summary check distinguishes them.

Two gotchas that cost time and will cost it again:

- **Look in Notification Center before concluding anything.** The notification was delivered
  correctly but appeared only in Notification Center, not as a banner, which is a local macOS
  alert-style/Focus setting. It read as a total failure for twenty minutes.
- **Open caveat on the payload.** The SW's malformed-payload fallback is
  `title = 'Time to train'` with `body: ''` (`push-sw.js:26-28`), and the backend's
  `REMINDER_TITLE` is *also* `"Time to train"`. A decryption or JSON-parse failure renders an
  identical title with an empty body, so **the body text is the only discriminator** between
  working aes128gcm and a silent fallback. Whoever re-runs this should confirm the body
  carried the real streak copy. Consider making the fallback title visibly distinct
  (e.g. append a marker) so this test can never be ambiguous again.

### Test-row provenance (do not misread these later)

| id | user | service | note |
|---|---|---|---|
| 16 | 551 | apple | **operator's macOS Safari test row**, not an iPhone |
| 18 | 5 | apple | **first real iPhone**, connected 2026-08-05 18:42Z |

Row 16 is what fired this seed's `apple endpoint first appears` trigger. It is a Mac.

## Step 1 — The iPhone verification (what Step 0 could not reach)

Step 0 leaves exactly the iOS *client* path unproven: `resolveReminderSlotState` keys off
`isIOS` (UA `/iPad|iPhone|iPod/`), `isStandalone` and `isMobile`, all false on a Mac, so the
run resolved to `desktop-unsubscribed` and never entered the `ios-tabbed` branch
(`reminderSlotState.ts:90`).

**Live opportunity:** user 5 already holds an iPhone subscription (row 18). Their first
reminder was correctly suppressed on 2026-08-05 because they completed a drill session at
18:41:59Z, seven seconds before subscribing, so `has_completed_session_on` (REMIND-04/D-09)
held the day unclaimed and `reminder_last_sent_on` stayed NULL. **This is by design, not a
fault.** Their `reminder_hour` is 18, so the observation window is: they must *not* complete
a session before 18:00 local on a subsequent day. Anyone diagnosing a "no iPhone reminder"
report must check `drill_sessions.completed_at` for that local day first.

On an iPhone running iOS 16.4+, from **Safari**:

1. Open flawchess.com/train, tap **Get reminders**, follow the Share → Add to Home Screen
   instructions.
2. Launch from the Home Screen icon, tap **Remind me**, accept the permission prompt.
3. Confirm a NEW row appears: `SELECT id, user_id FROM push_subscriptions WHERE endpoint LIKE '%apple%'`
   — ids 16 and 18 already exist, so count the delta, never the total.
4. Wait for the scheduled reminder (or set `reminder_hour` to the next hour), having *not*
   completed a drill session that local day.

Outcomes:

- **Row appears + notification arrives** → iOS works. Close this seed, keep only the three
  gaps below as a judgement call.
- **Row appears, no notification** → after Step 0 this is now much more likely to be an
  iOS *delivery/display* problem than a send-path bug, since the send leg is proven. Check
  Notification Center and Focus mode first, then the SW console, then Sentry.
  `push_send.py` captures every non-2xx with `source: push_send` and the status code in
  `set_context` (SEED-135 D1 also made the 404/410 prune branch non-silent). A 400 there
  points at the JWT claims; a 403 at the key.
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
