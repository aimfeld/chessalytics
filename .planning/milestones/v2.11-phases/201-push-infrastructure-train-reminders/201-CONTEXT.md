# Phase 201: Push Infrastructure & Train Reminders - Context

**Gathered:** 2026-08-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Backend-only push delivery for Train session reminders. In scope: the
`push_subscriptions` table, VAPID keypair generation + signing, the async send
path, `frontend/public/push-sw.js`'s `push` / `notificationclick` handlers
(wired via `workbox.importScripts`), the `reminder_enabled` / `reminder_hour`
columns on `train_settings` and their exposure through the existing
`GET`/`PUT /train/settings` API, the push subscribe / unsubscribe / VAPID
public-key endpoints, and the ≥15-minute reminder scheduler job.

Out of scope: every piece of Train UI. The score-screen pre-prompt and the
`TrainScheduleSettings` toggle + hour picker are Phase 202 (PERM-01..04).
Also out of scope per SEED-132: install promotion, iOS push, the QR handoff
(Phase B, deferred on a BrowserStack dependency), and any notification type
other than the Train reminder.

Requirements: PUSH-01..06, REMIND-01..08 (see `.planning/REQUIREMENTS.md`).

</domain>

<decisions>
## Implementation Decisions

SEED-132 already locked the shape of this phase: per-device-per-browser
subscriptions 1-to-many on `user_id`, prune on 410/404, `reminder_enabled` +
`reminder_hour` (default 18) on `train_settings`, a ≥15-minute tick,
`workbox.importScripts` and **never** `injectManifest`, no vendor / Firebase /
paid dependency, guests excluded, and reuse of `train_scheduler`'s day
predicates instead of re-derived weekday math. Those are NOT restated as
decisions here — read the seed. The decisions below are what this discussion
resolved on top of it.

### Send path & VAPID

- **D-01:** The send path is a **transport-agnostic crypto library plus our own
  `httpx.AsyncClient` POST**. The library does VAPID signing and `aes128gcm`
  payload encryption and hands back headers + encrypted body; the HTTP call is
  ours. Rejected: `pywebpush` in `asyncio.to_thread` (unblocks the loop but puts
  `requests` in the image, which PUSH-04 forbids by its literal wording — "`requests`
  never enters the request or scheduler path"), and a fully hand-rolled
  ES256 JWT + ECDH/HKDF/AES-GCM implementation (turns a wiring task into a crypto
  task with its own test-vector burden).
  **Open for research:** pin the exact package and verify it is maintained and
  genuinely transport-agnostic. If no single package holds up, compose
  VAPID-JWT + `http-ece`-style payload encryption over `httpx` — still not
  hand-rolled crypto. `cryptography` is not currently a direct dependency
  (`pyproject.toml`), so whatever is chosen likely adds it explicitly.

- **D-02:** **One VAPID keypair, and rotation is accepted mass invalidation.**
  Rotating the key silently kills every existing subscription; users go quiet
  until they re-subscribe. This is documented as a known consequence with an
  operational note (rotate only on key compromise, and truncate
  `push_subscriptions` when you do, so the 410 sweep is not the only cleanup).
  Rejected: a public-key-mismatch re-subscribe self-heal, and a dual-key overlap
  window keyed by `vapid_key_id` — real machinery for an event that may never
  happen, at ~50 users/day blast radius.
  — **Reversibility:** costly — adding a key-id per subscription later needs a
  migration and a backfill of existing rows.

- **D-03:** **Unset VAPID keys = graceful disable**, mirroring `SENTRY_DSN`'s
  empty-string-means-off convention in `app/core/config.py`. Empty
  `VAPID_PRIVATE_KEY` → the scheduler logs once at startup and does not tick,
  the public-key endpoint 404s, subscribe rejects. Every dev / test / CI run
  works with zero setup. Key generation is a `scripts/gen_vapid_keys.py`
  one-shot that prints a keypair for the operator to paste into
  `/opt/flawchess/.env`. Rejected: startup abort (taxes every developer and CI
  job), and auto-generating into the DB (violates PUSH-03 — the private key
  would sit in Postgres and in every DB dump).

- **D-04:** **No retry on transient push-service failure.** On anything that is
  not 410/404 — 5xx, 429, timeout — log, `sentry_sdk.capture_exception` per
  CLAUDE.md, leave the subscription alone, move on. A reminder is worthless an
  hour late and the next scheduled day brings another one. Keeps the job a
  single pass with no backoff state. (410/404 still prune, per PUSH-02.)

### Fan-out & idempotency

- **D-05:** **Fan out to all live subscriptions.** No per-subscription activity
  tracking, no most-recently-active heuristic. We cannot know which device the
  user is near at 18:00 and the point is that the reminder lands. Accepted cost:
  a user at their desk with their phone on the table gets two buzzes. Rejected:
  most-recently-active (needs a `last_seen_at` column plus machinery to keep it
  honest, and confidently picks the laptop closed at 17:00).

- **D-06:** The "already sent today" guard is a **nullable `reminder_last_sent_on`
  DATE column on `train_settings`**, compared against
  `train_scheduler.local_today(tz, now)`. Same shape and same table as the
  existing `streak_settled_through` watermark, no new table, and the write is
  part of the row the job already loaded. Accepted cost: no send history —
  you can answer "when was the last one" but not "did we send on the 14th".
  Rejected: a `push_reminder_sends` log table (a forever-growing table with a
  retention question, for ~50 sends/day).
  — **Reversibility:** costly — dropping or re-siting the column needs a migration.

- **D-07:** **Claim first, then send.** A conditional
  `UPDATE train_settings SET reminder_last_sent_on = :today WHERE user_id = :id
  AND (reminder_last_sent_on IS NULL OR reminder_last_sent_on < :today)
  RETURNING user_id`, committed **before** the POST. Double-send becomes
  structurally impossible: a crash mid-fan-out, or a second ticker, can never
  re-claim the day. Accepted cost: a send that fails is still marked, so that
  user loses today's reminder — consistent with D-04. Rejected: send-then-mark
  (better delivery, but double-sends on a crash between POST and commit and
  quietly reintroduces retry semantics).

- **D-08:** **Catch up until the end of the user's local day.** The predicate is
  "local hour >= `reminder_hour` AND not sent today AND no completed session
  today", not a strict `[hour, hour+15min)` window. A deploy landing at 18:05 or
  a short outage does not silently cost a user their reminder. Accepted cost: a
  multi-hour outage produces a late (e.g. 21:00) reminder, which is late but not
  wrong. Rejected: strict window (any missed tick silently drops the day), and
  a bounded-lateness variant (extra constant for a case the end-of-day bound
  already covers).

- **D-09:** **"Already trained today" (REMIND-04) means a completed session** —
  a `drill_sessions` row for the user's local today with a non-null
  `completed_at`. Matches REMIND-04's wording and what the streak machine
  already counts. Someone who opened a session at 17:00 and abandoned it
  half-done still gets the nudge, deliberately. Rejected: suppressing on any
  session touched today (rewards abandoning).

### Notification content & click behavior

- **D-10:** The body **includes the day number, computed as `streak_count + 1`**
  — i.e. it names *today's* session, not the last completed one. This removes
  the zero case entirely: a brand-new or just-broken user reads "Day 1", never
  "Day 0". `streak_count` is already on the `train_settings` row the job loads,
  so this costs no extra query. Framing stays forward-looking and
  encouragement-only. (This was the user's call over the recommended
  static-copy option; the streak-0 rebuke concern that motivated the
  recommendation is fully answered by the `+ 1`.)

- **D-11:** **`shield_level` never appears in the notification.** Mentioning
  shields is the deadline / loss-aversion framing SEED-132 decision 10
  explicitly rejected — the shield already delivers its consequence in-app
  without being announced. Streak-as-encouragement stays; shield-as-countdown
  does not.

- **D-12:** The job **settles the streak snapshot before building the copy.**
  `streak_count` only advances when `settle_streak_snapshot` runs (today: via
  `GET /train/progress` or `PUT /train/settings`), so a user who missed three
  scheduled days without opening the app carries a stale, too-high count. The
  reminder job calls the same existing mutation entry point first, so "Day N"
  is honest. Consequence the planner must handle: **the reminder job becomes a
  writer of streak state, not just a reader** — its transaction boundary and
  its interaction with D-07's claim UPDATE both matter. Rejected: reading as-is
  (ships a number we know can be false), and dropping the day number when the
  snapshot is stale (silently degrades for exactly the lapsed users the
  reminder targets).

- **D-13:** `notificationclick` **focuses an existing FlawChess client if one
  exists, otherwise opens `/train`** — `clients.matchAll({type: 'window',
  includeUncontrolled: true})` → `focus()` + `navigate('/train')`, else
  `clients.openWindow('/train')`. Avoids piling up duplicate tabs / PWA windows
  on the common desktop case. Rejected: bare `clients.openWindow('/train')`.

- **D-14:** The payload carries a **fixed `tag: 'train-reminder'` with
  `renotify: false`**, so a device that was offline and receives a backlog shows
  one notification and today's replaces any stale one still in the tray, without
  re-buzzing.

### Scheduler placement & dev testing

- **D-15:** The job runs as an **`asyncio.create_task` in the FastAPI lifespan**,
  beside `run_periodic_guest_cleanup` at `app/main.py:120`, in a
  `run_periodic_train_reminders` wrapper mirroring
  `app/services/guest_cleanup_service.py`'s shape (named interval constant, no
  magic numbers, Sentry capture, its own `async_session_maker` session). Prod
  runs a single uvicorn process — `deploy/entrypoint.sh` passes no `--workers` —
  so there is exactly one ticker; D-07's claim UPDATE covers restarts and any
  future multi-process case. Rejected: host cron (a deploy-time artifact outside
  the docker-compose story) and a separate worker container (overkill for 96
  wake-ups a day on a box with OOM history).

- **D-16:** **Candidate selection: SQL narrows, Python decides the hour.** One
  query pulls users with `reminder_enabled`, at least one live subscription, and
  a not-yet-sent-today ledger; the local-hour comparison happens in Python via
  `zoneinfo`, reusing `train_scheduler.local_today` rather than re-expressing
  timezone semantics in SQL. Keeps one source of truth for "what day/hour is it
  for this user" — the same helper the streak machine uses. Rejected: a full
  SQL-side `now() AT TIME ZONE train_settings.timezone` filter (scales better,
  but duplicates timezone semantics across Postgres tzdata and Python
  `zoneinfo` where they can drift, and raises in SQL on an invalid tz string).

- **D-17:** **REMIND-08 is satisfied by a dev-only POST endpoint**, gated on
  `ENVIRONMENT == "development"` — the exact pattern `app/core/dev_clock.py`
  already uses, inert in every other environment. It sends to the calling
  user's subscriptions immediately, bypassing the hour / weekday / suppression
  checks. Chosen over a `scripts/` one-shot specifically because it can be fired
  from the device receiving the notification, which matters for Phase 202's UAT
  and for later iOS work.

- **D-18:** **Phase 201 also exposes `reminder_enabled` / `reminder_hour`
  through the existing Train settings API** (`GET`/`PUT /train/settings`
  request/response schemas), on top of the migration and the
  `get_or_create_settings` defaults. Phase 202 is then purely frontend — no
  backend work leaks into a UI phase, and 201 is independently testable
  end-to-end with curl. This slightly widens the roadmap's "no user-facing
  surface yet" wording: the API fields exist, but nothing in the UI reads or
  writes them until 202.

### Claude's Discretion

- The exact web-push package behind D-01 (research pins it, planner locks it),
  including whether `cryptography` is added explicitly to `pyproject.toml`.
- The `push_subscriptions` schema details beyond PUSH-01's per-device-per-browser
  1-to-many + CASCADE FK shape: endpoint uniqueness constraint, `p256dh` / `auth`
  key storage, and whether any user-agent label is stored for a future device list.
- Exact notification title/body wording around the D-10 day number, and the
  icon/badge assets used.
- Test strategy for the send path without hitting real push services.
- The `push-sw.js` build/asset path (it lives in `frontend/public/` per SEED-132).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase source of truth
- `.planning/seeds/SEED-132-train-push-notifications-and-pwa-install-promotion.md` —
  the locked decisions this phase implements (channel strategy, data model,
  timing, service-worker trap, the A/B phase split), the rejected alternatives,
  the "no vendor / no Firebase / no Apple Developer Program" cost analysis, and
  the per-file implementation anchors. Read this first; the decisions above are
  layered on top of it, not a replacement for it.
- `.planning/ROADMAP.md` § "Phase 201: Push Infrastructure & Train Reminders" —
  goal, the five success criteria, and the four named plan-time decisions.
- `.planning/REQUIREMENTS.md` — PUSH-01..06, REMIND-01..08 verbatim, plus the
  "Notification permission is a one-shot, non-renewable resource" framing note.

### Project constraints
- `CLAUDE.md` § Critical Constraints — the async-only rule (`httpx.AsyncClient`,
  never `requests`) that D-01 exists to satisfy.
- `CLAUDE.md` § Database Design Rules — mandatory FK with explicit `ondelete`,
  unique constraints for natural keys, `SMALLINT`/`TEXT`+CHECK over native ENUM.
- `CLAUDE.md` § Error Handling & Sentry — `capture_exception` in non-trivial
  service/router `except` blocks; never embed variables in error messages.
- `CLAUDE.md` § "Dev clock (testing Train's schedule without waiting days)" —
  the `ENVIRONMENT == "development"` gating pattern D-17 mirrors, and the
  reason the reminder job cannot read `X-Dev-Clock-Offset-Minutes`.

### Prior phase context
- `.planning/phases/200-train-solve-screen-board-legend-inline-sideline-exploration/200-CONTEXT.md` —
  the immediately preceding phase (frontend-only, shares no files with 201).
  Relevant only as a decision-format reference.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `app/services/guest_cleanup_service.py` — the canonical periodic-job shape:
  module-level named interval constant, `run_periodic_*` wrapper, own
  `async_session_maker` session, Sentry capture. D-15's job mirrors it.
- `app/services/train_scheduler.py` — `local_today(tz_name, now_utc)`,
  `is_scheduled_day(day, weekday_mask)`, `next_scheduled_day`, `tick_days`,
  `SHIELD_CAP`, `DEFAULT_*`. REMIND-03 and D-16 both consume these rather than
  re-deriving weekday or timezone math.
- `app/repositories/train_repository.py:235` `get_or_create_settings` — the
  create-on-first-touch seam using `pg_insert(...).on_conflict_do_nothing`.
  The two new columns default through here at the application layer, with
  `server_default` present only for direct-INSERT parity (the existing
  `weekday_mask` / `puzzles_per_session` pattern).
- `app/repositories/train_repository.py` `settle_streak_snapshot` — the single
  mutation entry point D-12 reuses.
- `app/core/config.py` `Settings` — `SENTRY_DSN`'s empty-string-means-disabled
  convention that D-03 copies for `VAPID_PRIVATE_KEY`.
- `app/core/dev_clock.py` — the `ENVIRONMENT == "development"` gating D-17 mirrors.
- `scripts/reset_train_state.py` — the `--db dev|benchmark` + `--user-id` script
  shape, if a companion script is wanted alongside D-17's endpoint.

### Established Patterns
- `app/models/train_settings.py` — `streak_settled_through` is a nullable `Date`
  watermark on this exact table, which is precisely D-06's `reminder_last_sent_on`
  shape. `shield_level` shows the SmallInteger + range `CheckConstraint` pattern
  a bounded `reminder_hour` (0..23) should follow.
- Router convention: `APIRouter(prefix="/push", tags=["push"])` with relative
  paths in decorators — never embed the prefix in individual routes.
- Repositories hold the SQL, services hold the logic, routers stay thin.
- `frontend/vite.config.ts` VitePWA `generateSW` block — hand-tuned against real
  production bugs (`navigateFallback: null` for the OAuth callback,
  `globIgnores` excluding all HTML / `*.wasm` / `*.onnx`, `/api/*` NetworkOnly
  registered first). PUSH-06 and SEED-132 decision 15: add
  `workbox.importScripts: ['/push-sw.js']` and change nothing else.

### Integration Points
- `app/main.py:120` — the lifespan's `asyncio.create_task` block (four existing
  periodic tasks: orphan reaper, eval drain, full eval drain, guest cleanup).
  D-15's task joins here.
- `deploy/entrypoint.sh` — single uvicorn process, no `--workers`; also the
  place Alembic migrations run automatically on container start.
- `/opt/flawchess/.env` — where the VAPID private key lives in prod. Never
  committed (D-02/D-03, PUSH-03).
- `app/models/drill_session.py` — `session_date` (Date), `status` (Text +
  CHECK, default `open`), `completed_at` (nullable). D-09's suppression query
  reads these.
- `pyproject.toml` `[project.dependencies]` — note this set is shared with the
  lean remote-worker image (`Dockerfile.worker`). Anything added for push lands
  in the worker image too unless it goes in an isolated dependency group, the
  way `maia-inference` does.

</code_context>

<specifics>
## Specific Ideas

- The day number in the notification body is `streak_count + 1` — it names the
  session the user is being invited to, not the last one they finished. The
  user raised this specifically to dissolve the streak-0 problem rather than
  branch around it (D-10).
- "Rotate only on key compromise, and truncate `push_subscriptions` when you
  do" is the operational note that must accompany the D-02 rotation policy in
  whatever doc records it.

</specifics>

<deferred>
## Deferred Ideas

- **Per-subscription `last_seen_at` / device labelling** — would enable the
  most-recently-active fan-out rejected in D-05, and a "your devices" management
  list. Not needed for this phase; revisit only if double-buzz turns out to
  bother real users.
- **Send history / audit table** — the `push_reminder_sends` table rejected in
  D-06. Revisit if debugging delivery ever needs more than "when was the last
  send", keeping in mind prod docker logs retain only ~1h.
- **Delivery retry semantics** — the "retry on the next tick until the local day
  ends" option rejected in D-04/D-07. Would turn the ledger into a state machine.
- **SEED-132 Phase B** — install promotion, desktop→phone QR handoff, Android
  `beforeinstallprompt`, and the iOS install-then-permission path. Explicitly out
  of this milestone on a BrowserStack dependency; the seed stays open in
  `.planning/seeds/`.
- **Any notification type beyond the Train reminder** — import-complete,
  analysis-finished, marketing. Out of scope per SEED-132: each additional type
  raises revocation risk on a permission that cannot be re-requested.

### Reviewed Todos (not folded)
`gsd-tools query todo.match-phase 201` returned three matches
(`172-deferred-review-findings`, the WR-01 Tailwind axis label, and the
bitboard-storage note), all scoring on generic keywords ("source", "review",
"app", "users") with no substantive relation to push, notifications, or the
Train scheduler. None folded.

</deferred>

---

*Phase: 201-push-infrastructure-train-reminders*
*Context gathered: 2026-08-01*
