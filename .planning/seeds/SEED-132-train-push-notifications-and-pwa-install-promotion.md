---
id: SEED-132
status: dormant
planted: 2026-08-01
planted_during: /gsd-explore session on Train reminders and PWA install promotion
trigger_when: next Train-focused milestone (planned), or whenever Train retention / re-engagement comes up
scope: large (two phases — A ships independently of B)
---

# SEED-132: Train push notifications + PWA install promotion

## Why This Matters

Train is calendar-shaped: `weekday_mask` says which days a user is meant to
train, the Phase 193 shield depletes on missed scheduled days, and the whole
value of spaced repetition depends on the user actually showing up on the day
the scheduler picked. Today nothing reaches out. The only re-engagement signal
is the nav badge, which a user has to already be on the site to see.

Web push closes that loop. Email was considered and rejected: there is **zero
email infrastructure** in the project (no SMTP, no Resend/SendGrid/Mailgun/
`aiosmtplib` anywhere in `pyproject.toml` or `app/`), so email is not the
cheap incumbent channel it looks like — it would be built from scratch, and it
carries deliverability, domain reputation, and unsubscribe-compliance surface
that push does not.

**Guests are out of scope.** Guest games are never bulk-analysed, so guests
have no puzzle pool and no Train feature to be reminded about. Reminders are
authenticated-users-only. (Consistent with the eval pipeline, which already
skips guest flaws.)

## Locked decisions (from the /gsd-explore session, 2026-08-01)

### A. Channel and platform strategy

1. **Desktop push is first-class, not a fallback.** A desktop user can train
   in the browser; the notification does not need to route them to a phone.
2. **Installing the PWA is NOT a prerequisite for push** on desktop Chrome/
   Edge/Firefox or on Android Chrome — the Push API is available to an
   ordinary tabbed site. The original framing ("prompt desktop users to
   install so we can push to them") holds on **iOS only**, where Safari
   exposes push exclusively to a home-screen-installed PWA (16.4+). Do not
   re-derive the install-gates-push premise for other platforms.
3. **The install nudge is therefore a separate value proposition** — "train on
   the go", not "so we can notify you". Copy must reflect that, otherwise it
   reads as a bait for a permission the user has already granted on desktop.

### B. Data model

4. **`push_subscriptions` is per-device-per-browser, 1-to-many on `user_id`.**
   One person = desktop Chrome subscription + phone PWA subscription + …
   Each endpoint goes stale independently.
5. **Prune on `410 Gone`** (and `404`) from the push service. Expired
   subscriptions must not accumulate or the fan-out degrades silently.
6. **`train_settings` gains two columns**: `reminder_enabled` (bool) and
   `reminder_hour` (SmallInteger, default 18). The table already carries the
   IANA `timezone` this needs.

### C. Timing

7. **User-picked hour, default 18:00 local.** The "just fix it at 18:00 for
   everyone" alternative was considered and rejected: it saves **nothing** on
   the scheduler (see 8), so the entire cost of the picker is one SmallInteger
   column on a table already being migrated plus one dropdown in a settings
   panel that already has auto-saving pickers. Set against that, a fixed hour
   that lands wrong is the exact thing that makes someone revoke — and
   notification permission is a **one-shot, non-renewable resource** (Chrome
   and Safari both hard-block re-prompting after a browser-level deny; there
   is no in-app recovery).
8. **The scheduler must tick at least every 15 minutes regardless of design.**
   "18:00 local" across IANA timezones includes half- and quarter-hour offsets
   (India +5:30, Nepal +5:45, Chatham +12:45), so a per-hour tick is wrong.
   This is why a fixed hour buys no simplification.
9. **The in-app master toggle outranks the hour picker.** A user who can
   silence Train reminders inside FlawChess keeps the browser permission grant
   intact and stays reachable later; a user who has to go to browser settings
   is gone permanently. If anything gets cut, cut the hour picker, never the
   toggle.
10. **Deadline/loss-aversion timing rejected** ("your shield drops at
    midnight"). It makes the notification about punishment rather than
    practice, and the shield already delivers the consequence without needing
    to be announced. Adaptive/learned timing also rejected — more failure
    modes, and too little per-user history at current scale.

### D. Permission UX

11. **Ask after the first completed session**, on the score screen
    (`TrainScoreScreen.tsx`), via a **custom in-app pre-prompt** with
    Yes / Not now. Only the Yes path calls the real browser API. "Not now" is
    recoverable; a browser "Deny" is not — this is the entire reason for the
    pre-prompt indirection.
12. **`TrainScheduleSettings.tsx` is the permanent fallback surface** for
    anyone who said "Not now", and the home of the toggle + hour picker.
13. **Rejected: asking on Train landing or at import completion.** Both ask
    before the user has any evidence Train is worth a daily interruption.

### E. Service worker (the biggest hidden scope risk)

14. **Keep `generateSW`; add push handlers via
    `workbox.importScripts: ['/push-sw.js']`.** `frontend/vite.config.ts:56`
    runs VitePWA in default `generateSW` mode, which builds the SW from config
    alone and **cannot** carry a `push` / `notificationclick` listener.
15. **Do NOT switch to `strategies: 'injectManifest'`** to get those handlers.
    It looks like the clean fix and it is a trap: the existing `workbox` block
    is hand-tuned against real production bugs that would all have to be
    re-implemented imperatively —
    - `navigateFallback: null` so the SW never serves `index.html` for backend
      navigations such as the OAuth callback (commit `b953abad`),
    - `globIgnores` excluding **all** HTML, because precaching `index.html`
      made installed Android PWAs launch a many-deploys-old shell,
    - `*.wasm` and the ~44 MB Maia `*.onnx` excluded for the iOS Cache API
      ~50 MB limit,
    - a two-rule `runtimeCaching` order where `/api/*` NetworkOnly is
      registered **first** so it wins over the navigation route.

    Regressing any of these breaks the core app in service of a Train feature.
    `importScripts` keeps all of it untouched.

### F. Scope cut — two phases, A ships without B

16. **Phase A — push infrastructure + Train reminders (desktop + Android).**
    `push_subscriptions` table, VAPID keys, the 15-minute scheduler job, the
    `push-sw.js` handlers, the score-screen pre-prompt, and the settings
    toggle + hour picker. Independently shippable and delivers the actual
    user value to everyone who can already receive push without installing
    anything.
17. **Phase B — install promotion + iOS push.** Desktop→phone QR handoff
    (a desktop page cannot install anything on a phone, and there is no SMS
    channel, so QR is the only option), Android `beforeinstallprompt`, and the
    iOS path.
18. **Do not invert the order.** Promotion-first would ship an install nag
    promising a notification feature that does not exist yet.
19. **iOS ordering is inverted and belongs in B**: Safari has no
    `beforeinstallprompt`, so installation cannot be triggered
    programmatically — only explained ("tap Share → Add to Home Screen"), and
    the permission prompt is unavailable until the user is in standalone mode.
    That is install → later visit → permission: **two sessions minimum, with a
    drop-off cliff between them.** Phase B also needs a **dismissal-persistence
    rule** so the nudge cannot become a nag.
20. **Phase B carries a BrowserStack dependency.** The operator has no iPhone
    (confirmed 2026-08-01). Same testing route as the Maia iOS work. Phase A
    has no such dependency — another reason the split is load-bearing rather
    than cosmetic.

## Cost: zero, and no third-party service

Web Push has **no per-message cost and no vendor**. The backend POSTs directly
to the endpoint the browser supplied at subscribe time — `fcm.googleapis.com`
(Chrome), `updates.push.services.mozilla.com` (Firefox), `web.push.apple.com`
(Safari). Free, platform-operated, no account to create. VAPID is a
self-signed JWT from a keypair generated locally, not issued credentials.

Two traps that lead to a needless paid dependency:

- **Chrome's `fcm.googleapis.com` endpoint does NOT mean Firebase is
  required.** Standard Web Push with VAPID needs no Firebase project, no FCM
  server key, no GCP billing account. Do not add the Firebase SDK.
- **Apple Web Push (Safari 16.4+ / iOS PWA) does NOT require an Apple
  Developer Program membership.** That applied to the *legacy* macOS Safari
  flow (proprietary APNs path, paid Website Push ID certificate). The modern
  standard flow uses the same VAPID keypair as every other browser. Phase B
  has no $99/year line item; its only external dependency is BrowserStack.

Expected volume ~50 notifications/day: ~50 HTTPS POSTs plus 96 scheduler
wake-ups (the 15-minute tick), each one indexed query. Negligible against the
Stockfish pool and import pipeline already on that box, and it stays
negligible at 1000x that volume — there is no volume-scaling cost curve here.

Reinforces the email rejection independently: at ~1,500 messages/month, email
would sit at the edge of Resend's 3,000/month free tier (then $20/mo), so the
rejected channel is the one that costs money.

## Open questions (resolve during phase research)

1. **Web-push library vs. the async-only Critical Constraint — treat as a
   blocker, not a detail.** `pywebpush`, the default choice, is built on
   `requests`, which CLAUDE.md explicitly prohibits ("always use
   `httpx.AsyncClient` — `requests` blocks the event loop"). Options to
   evaluate: a maintained async web-push library, running `pywebpush` in a
   threadpool executor, or hand-rolling VAPID JWT + `aes128gcm` payload
   encryption on `cryptography` and POSTing via `httpx`. Resolve before
   planning — it decides whether the send path is a thin wrapper or a real
   crypto implementation task.
2. **VAPID key generation, storage, and rotation.** Public key ships to the
   client at subscribe time; private key belongs in `/opt/flawchess/.env`
   (never committed). Rotation invalidates every existing subscription —
   decide whether that is acceptable or needs a migration path.
3. **Fan-out and dedup policy.** If a user has three subscribed devices, do
   all three buzz, or only the most recently active? And a **send-time**
   "session already completed today" check is required, not just a
   schedule-time one — someone who trains at 17:00 must not get the 18:00
   reminder.
4. **Scheduler placement and idempotency.** Slots in beside
   `run_periodic_guest_cleanup` as another `asyncio.create_task` in
   `app/main.py`, but needs a "already sent today" guard so a backend restart
   inside the 15-minute window cannot double-send.
5. **Dev-clock interaction.** `app/core/dev_clock.py` shifts "now" via a
   request header for Train's calendar behavior, but the reminder job is a
   background task with no request context. Decide how a reminder is tested
   without waiting for 18:00 — likely an explicit dev-only trigger endpoint
   rather than trying to thread the offset into the scheduler.

## Implementation anchors (current code)

- `frontend/vite.config.ts:56` — the VitePWA `generateSW` block and its tuned
  `workbox` config (decisions 14/15). Manifest already has
  `display: 'standalone'`, `scope: '/'`, and 192/512/maskable icons, so the
  install side needs no manifest work.
- `app/models/train_settings.py` — gains `reminder_enabled` + `reminder_hour`;
  already holds the IANA `timezone` and `weekday_mask` the scheduler needs.
- `app/services/train_scheduler.py` — `local_today` / `next_scheduled_day` /
  `tick_days`; the reminder job's "is today a scheduled day for this user"
  predicate should reuse this, not re-derive weekday math.
- `app/repositories/train_repository.py` — `get_or_create_settings` is the
  create-on-first-touch seam the new columns must default through at the
  application layer (matching the existing `weekday_mask`/`puzzles_per_session`
  pattern, where `server_default` exists only for direct-INSERT parity).
- `app/main.py:120` — `run_periodic_guest_cleanup` is the existing pattern for
  a periodic `asyncio.create_task` background job.
- `frontend/src/components/train/TrainScoreScreen.tsx` — where the pre-prompt
  fires (decision 11).
- `frontend/src/components/train/TrainScheduleSettings.tsx` — the auto-saving
  weekday/session-size pickers; the toggle + hour picker join them, and this
  is the permanent fallback surface (decision 12).
- `frontend/public/` — new `push-sw.js` lives here (decision 14).

## Out of scope

- Email as a channel (rejected — no infrastructure exists; push is strictly
  cheaper to build and operate).
- Reminders for guests (no puzzle pool exists for them).
- Any notification other than the Train session reminder. No import-complete,
  no analysis-finished, no marketing pushes — each additional notification
  type raises the revocation risk on a permission that cannot be re-requested.
- Switching the service worker to `injectManifest` (decision 15).
