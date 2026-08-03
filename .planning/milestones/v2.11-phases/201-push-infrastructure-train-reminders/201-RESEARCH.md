# Phase 201: Push Infrastructure & Train Reminders - Research

**Researched:** 2026-08-01
**Domain:** Web Push (VAPID + aes128gcm) over async Python; periodic-tick scheduling; Workbox `generateSW` service-worker extension
**Confidence:** HIGH (primary blocker resolved and verified against PyPI/GitHub source; codebase anchors read directly)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

SEED-132 already locked the shape of this phase: per-device-per-browser
subscriptions 1-to-many on `user_id`, prune on 410/404, `reminder_enabled` +
`reminder_hour` (default 18) on `train_settings`, a ≥15-minute tick,
`workbox.importScripts` and **never** `injectManifest`, no vendor / Firebase /
paid dependency, guests excluded, and reuse of `train_scheduler`'s day
predicates instead of re-derived weekday math. Those are NOT restated as
decisions here — read the seed. The decisions below are what the discussion
resolved on top of it.

**Send path & VAPID**

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
  **RESOLVED BY THIS RESEARCH: see Standard Stack — `webpush` 1.0.6.**

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

**Fan-out & idempotency**

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

**Notification content & click behavior**

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

**Scheduler placement & dev testing**

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
  **RESOLVED: `webpush` 1.0.6 — see Standard Stack.**
- The `push_subscriptions` schema details beyond PUSH-01's per-device-per-browser
  1-to-many + CASCADE FK shape: endpoint uniqueness constraint, `p256dh` / `auth`
  key storage, and whether any user-agent label is stored for a future device list.
- Exact notification title/body wording around the D-10 day number, and the
  icon/badge assets used.
- Test strategy for the send path without hitting real push services.
- The `push-sw.js` build/asset path (it lives in `frontend/public/` per SEED-132).

### Deferred Ideas (OUT OF SCOPE)

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

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PUSH-01 | `push_subscriptions` table, 1-to-many on `user_id`, CASCADE FK | Standard Stack schema sketch (Code Examples § 1); anchors on `drill_session.py`/`bot_game_settings` migration style |
| PUSH-02 | Prune on 410/404 | Code Examples § 3 (`send_to_subscription`); Common Pitfall "410 vs 404 vs everything else" |
| PUSH-03 | VAPID keypair, public at subscribe, private in `.env`, rotation documented | D-02/D-03 (locked); `webpush.vapid.VAPID.generate_keys()` (Code Examples § 2); `scripts/gen_vapid_keys.py` sketch |
| PUSH-04 | No blocking HTTP call from the event loop, no `requests` | Standard Stack dependency audit — `webpush` 1.0.6 has zero `requests`/`aiohttp` in its dependency tree (verified via PyPI JSON `requires_dist`); send path issues `httpx.AsyncClient().post()` |
| PUSH-05 | No vendor/Firebase/paid dependency | Standard Stack — `webpush` posts directly to whatever endpoint the browser supplied; no FCM/APNs SDK involved |
| PUSH-06 | `push-sw.js` via `workbox.importScripts`, existing `generateSW` config unchanged | Architecture Patterns § "Service worker `importScripts` mechanics"; Common Pitfall "Caddy cache-control gap" |
| REMIND-01 | `reminder_enabled`/`reminder_hour` on `train_settings`, defaulted through `get_or_create_settings` | Code Examples § 4 (migration + model + repository diff) |
| REMIND-02 | ≥15-minute tick | D-15 interval constant; Architecture Patterns § scheduler |
| REMIND-03 | Fires only on a scheduled day, reuse `train_scheduler` predicates | `is_scheduled_day` read at `app/services/train_scheduler.py:302-310` |
| REMIND-04 | Send-time suppression when already trained today | D-09; `drill_sessions.completed_at` read at `app/models/drill_session.py:86-88` |
| REMIND-05 | "Already sent today" idempotency guard | D-06/D-07; Code Examples § 5 (claim-then-send UPDATE) |
| REMIND-06 | One documented fan-out rule | D-05 (fan out to all live subscriptions) |
| REMIND-07 | Guests never receive reminders | `_reject_guest`/D-05 pattern in `app/routers/train.py:47-54`; candidate query filters `users.is_guest = false` |
| REMIND-08 | On-demand dev trigger, no request-context clock | D-17; Common Pitfall "the reminder job has no request, so `dev_now_utc` cannot apply" |

</phase_requirements>

## Summary

The phase's own stated blocker — a `requests`-free, `httpx`-compatible way to
sign and encrypt Web Push messages — has a clean, single-package answer:
**`webpush` 1.0.6** (PyPI name `webpush`, import path `webpush`, GitHub
`delvinru/webpush-py`, MIT license). Its dependency tree is
`cryptography>=46.0.1`, `pydantic>=2.11.7`, `email-validator>=2.2.0`,
`pyjwt>=2.10.1` — verified directly against PyPI's `requires_dist` metadata,
with zero occurrence of `requests` or `aiohttp` anywhere in that tree. Its
public API (`WebPush.get(message, subscription) -> WebPushMessage` with
`.encrypted: bytes` and `.headers: dict`) does exactly what D-01 asks: VAPID
signing (ES256 JWT via `pyjwt`) + `aes128gcm` encryption (via
`cryptography`'s AESGCM/HKDF/EC primitives), handed back as headers + body for
the caller's own `httpx.AsyncClient().post(...)` to send. This resolves D-01
without composing two packages — `py-vapid` + `http-ece` remains a documented
fallback (both independently verified, well-downloaded, `requests`-free) if
`webpush`'s low GitHub activity (last commit 2025-10-29, 18 stars) becomes a
problem later.

The rest of the phase is a straight application of patterns already proven
elsewhere in this codebase: a fifth periodic `asyncio.create_task` mirroring
`run_periodic_guest_cleanup` exactly (named interval constant, own
`async_session_maker` session, per-tick Sentry capture, sleep-before-first-tick);
two new `train_settings` columns following the `streak_settled_through`
nullable-Date-watermark and `shield_level` SmallInteger+CHECK precedents
already in that table; and a new `push_subscriptions` table following the
`drill_sessions`-style CASCADE-only-to-`users` shape. The one genuinely new
mechanical risk is the service worker: `workbox.importScripts: ['/push-sw.js']`
is a synchronous `importScripts()` call baked into the generated `sw.js`, and
`push-sw.js` itself is **not** part of Workbox's precache manifest — so it is
not automatically cache-busted by a deploy. Reading `deploy/Caddyfile`
confirms `/push-sw.js` would fall through every existing cache rule (it is not
`/sw.js`, not `/assets/*`, not `/maia/maia-worker.js`, not `/maia/*`/`/engine/*`)
straight to the Caddy default (no explicit `Cache-Control` header set for that
path), which means the browser applies its own heuristic freshness lifetime —
a real risk that edits to `push-sw.js` alone might not be picked up promptly.
The Caddyfile change (add `/push-sw.js` to the existing `@nocache` matcher) is
a required, easily-missed part of PUSH-06.

**Primary recommendation:** add `webpush>=1.0.6` (which pulls in `cryptography`,
`pyjwt`, `email-validator`, and already-present `pydantic`) to a new,
backend-only `push` dependency group in `pyproject.toml` — mirroring the
`maia-inference` isolation pattern — so `Dockerfile.worker`'s
`uv sync --locked --no-dev` (no group filtering) never pulls these packages
into the lean remote-worker image.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| VAPID keypair generation & storage | API/Backend | — | One-shot `scripts/gen_vapid_keys.py`; private key lives in server `.env`, never in the DB or client |
| Push subscribe/unsubscribe | API/Backend | Browser/Client | Client calls `PushManager.subscribe()` (browser API, out of scope this phase per SEED-132/Phase 202) and POSTs the resulting subscription JSON to a new `/push/subscribe` endpoint |
| `push_subscriptions` persistence | Database/Storage | API/Backend | New table, CASCADE FK to `users.id`; repository layer owns all SQL |
| Push send (crypto + HTTP POST) | API/Backend | — | `webpush.WebPush.get()` (in-process, no network) + `httpx.AsyncClient` POST to the browser-supplied endpoint (an external push service — Chrome/FCM, Mozilla autopush, Apple web.push) |
| Reminder scheduling/tick | API/Backend | — | `asyncio.create_task` in the FastAPI lifespan, same process as the API — no separate worker/cron per D-15 |
| `train_settings.reminder_*` | Database/Storage | API/Backend | Two/three new columns on the existing table; repository owns defaults via `get_or_create_settings` |
| `push-sw.js` push/notificationclick handlers | Browser/Client | CDN/Static | Runs inside the browser's service worker; served as a static file, `importScripts`-loaded by the Workbox-generated `sw.js` |
| Caddy cache headers for `push-sw.js` | CDN/Static | — | Must join `/sw.js`/`/registerSW.js`/`/manifest.webmanifest` in the `@nocache` matcher (`deploy/Caddyfile`) |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `webpush` | 1.0.6 (PyPI, released 2025-10-29) [VERIFIED: PyPI JSON API `requires_dist`] | VAPID JWT signing (ES256) + RFC 8291 `aes128gcm` payload encryption, returned as `WebPushMessage(encrypted: bytes, headers: dict)` for the caller's own HTTP client | The ONLY candidate found that is a single package, genuinely transport-agnostic (does not import `requests`/`aiohttp`/`httpx` at all — never calls the network itself), and Python-3.13-compatible (`requires-python = ">=3.10"`) [VERIFIED: pypi.org/pypi/webpush/json and raw pyproject.toml on GitHub `main`, which matches the 1.0.6 PyPI release tag byte-for-byte] |
| `httpx` | already `>=0.27.0` in `[project.dependencies]` | The actual POST to the push service endpoint | Already the project's only sanctioned async HTTP client (CLAUDE.md) — no new dependency needed for the transport half |

### Supporting (transitive, via `webpush`)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `cryptography` | `>=46.0.1` required by `webpush`; latest on PyPI is 50.0.0, released 2026-07-31 [VERIFIED: PyPI JSON API] | EC key generation (P-256/`SECP256R1`), ECDH, HKDF, AES-GCM — the actual `aes128gcm` primitives | Pulled in transitively; do not pin a narrower range than `webpush` requires |
| `pyjwt` | `>=2.10.1`; latest 688M downloads/month [VERIFIED: pypistats.org] | ES256 JWT encoding for the VAPID `Authorization: vapid t=..., k=...` header | Pulled in transitively |
| `email-validator` | `>=2.2.0`; latest 227M downloads/month [VERIFIED: pypistats.org] | Validates the VAPID `sub` claim's `mailto:` address via Pydantic's `EmailStr` | Pulled in transitively — `webpush`'s `WebPush.__init__(subscriber: EmailStr | None)` needs a real contact email; use a project mailbox, e.g. `push@flawchess.com` (any deliverable address; some push services log it on repeated failures) |
| `pydantic` | project already requires `>=2.0.0`; `webpush` needs `>=2.11.7` | `WebPushSubscription`/`WebPushKeys`/`WebPushMessage` models | uv's resolver will satisfy the tighter floor across both requirements automatically — no manual pin needed, but expect the lockfile's `pydantic` version to move to `>=2.11.7` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `webpush` (single package) | `py-vapid` (1.9.4, released 2026-01-05, deps: `cryptography>=46` only [VERIFIED: PyPI JSON]) + `http-ece` (1.2.1, released 2024-08-08, deps: `cryptography>=2.5` only [VERIFIED: PyPI JSON]) composed manually | Both packages are individually more actively maintained/downloaded than `webpush` (`py-vapid`: 6.05M downloads/month; `http-ece`: 3.38M downloads/month — both almost certainly riding on being `pywebpush`'s own transitive deps, so their real "used directly" number is smaller, but the packages themselves are healthy and `requests`-free). This composition is MORE code to write (two APIs to glue: `py_vapid.Vapid01.sign()` for headers, `http_ece.encrypt()` for the body) but is the documented fallback if `webpush`'s low commit cadence becomes a blocker (e.g. a `cryptography` major-version break it hasn't picked up yet). Keep this path documented in case `webpush` needs replacing later — do not silently swap without updating this doc. |
| `webpush` | `pywebpush` (2.3.0, released 2026-02-09) | REJECTED per D-01 — `requires_dist` includes both `requests>=2.21.0` AND (as of the 2026-02-09 release) `aiohttp` [VERIFIED: PyPI JSON `requires_dist`]. Even running it in `asyncio.to_thread` still puts `requests` in the dependency tree/image, which PUSH-04 forbids by its literal wording. |
| `webpush` | Hand-rolled ES256 JWT + ECDH/HKDF/AES-GCM directly on `cryptography` | REJECTED per D-01 — turns a wiring task into a crypto implementation task with its own RFC 8291/8292 test-vector burden; `webpush`'s `_encrypt()` method (read verbatim from source, see Code Examples) already implements exactly this correctly and is testable as a black box. |
| `webpush-rs` (PyO3/Rust binding) | — | Considered and not recommended: adds a compiled-binary dependency (arch-specific wheels) for no benefit over the pure-Python `webpush` at this volume (~50 sends/day); the project's own two Dockerfiles already juggle amd64/arm64 Stockfish binaries — no need to add a third moving part. Not independently verified this session; noted for completeness only. |

**Installation:**
```bash
# pyproject.toml — new isolated dependency group (see "Dependency-image blast radius" below)
uv add --group push webpush
```

**Version verification:** confirmed live against PyPI JSON API this session (`curl -s https://pypi.org/pypi/webpush/json`) — see the Package Legitimacy Audit table for the full signal set. `python-chess`/`fastapi`/`sqlalchemy`/etc. versions were not re-verified (unaffected by this phase).

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `webpush` | PyPI | latest release 2025-10-29 (~9 mo old); first release predates that | 26,087/month, 10,674/week [VERIFIED: pypistats.org] | `github.com/delvinru/webpush-py` (MIT, 18 stars, 2 open issues, not archived, `pushed_at` 2025-11-01) [VERIFIED: GitHub REST API] | `[SUS]` per the automated `package-legitimacy` seam (reason: `unknown-downloads` — the seam's PyPI download-count signal returned null; the real number, fetched independently via pypistats.org, is a legitimate small-but-real 26k/month) | **Approved with a flag** — small download count and modest GitHub activity (18 stars, last commit 2025-10-29) are honest maintenance-risk signals, not fraud signals: source published under MIT, matches its own pyproject.toml exactly, does exactly what it claims, no obfuscation, no postinstall hooks. Planner should add a `checkpoint:human-verify` before the first `uv add`. |
| `py-vapid` | PyPI | latest 2026-01-05 (recent) | 6,050,702/month [VERIFIED: pypistats.org] | `github.com/mozilla-services/vapid` (Mozilla) | `[SUS]` per seam (same `unknown-downloads` false-positive) | Fallback-only in this phase (not installed unless `webpush` is later replaced) — real signals (Mozilla-owned repo, 6M/month) are strong |
| `http-ece` | PyPI | latest 2024-08-08 | 3,378,066/month [VERIFIED: pypistats.org] | `github.com/martinthomson/encrypted-content-encoding` | `[SUS]` per seam (same false-positive) | Fallback-only in this phase |
| `cryptography` | PyPI | latest 2026-07-31 (v50.0.0, 158 releases total) [VERIFIED: PyPI JSON] | not fetched (pypistats.org rate-limited this session) | `github.com/pyca/cryptography` | `[SUS]` per seam (reasons: `too-new`, `unknown-downloads`, `no-repository`) — **false positive**: `cryptography` is one of the most widely used PyPI packages in existence (PyCA-maintained, used by `requests`, `pyjwt`, `paramiko`, and virtually every TLS-adjacent Python project); the "too-new" signal fired because a fresh point release shipped the day before this research ran, not because the package is new | Approved — no flag needed, `[VERIFIED]` via training knowledge + PyPI JSON confirming 158 historical releases |
| `pyjwt` | PyPI | latest 2026-05-21 | 688,819,075/month [VERIFIED: pypistats.org] | `github.com/jpadilla/pyjwt` | `[SUS]` per seam (`unknown-downloads` false-positive) | Approved — one of the most downloaded PyPI packages, no flag needed |
| `email-validator` | PyPI | latest 2025-08-26 | 227,300,835/month [VERIFIED: pypistats.org] | `github.com/JoshData/python-email-validator` | `[SUS]` per seam (`unknown-downloads` false-positive) | Approved — no flag needed |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** `webpush` carries a genuine (not false-positive) maintenance-risk flag — its GitHub activity is low (last commit 2025-10-29, 18 stars) even though its content is verified-correct and its PyPI metadata is clean. **The planner must add a `checkpoint:human-verify` task before the `uv add webpush` step**, presenting this audit table so the operator can accept the small-project risk explicitly (the alternative, composing `py-vapid` + `http-ece`, is documented above and costs roughly one extra hour of glue code if the operator prefers the more-downloaded pair instead).

*Note on the automated seam:* every PyPI package checked this session returned `[SUS]` with reason `unknown-downloads` from `gsd_run query package-legitimacy check --ecosystem pypi`, including universally-trusted packages like `cryptography` and `pyjwt`. The seam's download-count signal appears to be npm-specific and always returns null for the `pypi` ecosystem — treat every PyPI `[SUS]` verdict from this seam as **inconclusive**, not as a real risk signal, and cross-check manually via `pypistats.org` and the PyPI JSON API (`https://pypi.org/pypi/<name>/json`) as done above, per the package's actual `requires_dist`, publish history, and GitHub activity.

## Architecture Patterns

### System Architecture Diagram

```
                    ┌─────────────────────────────────────────┐
                    │  Browser (Chrome/Edge/Firefox/Safari)    │
                    │                                           │
                    │  PushManager.subscribe(applicationServer  │
                    │    Key: <VAPID public key>)                │
                    │       │                                   │
                    │       ▼                                   │
                    │  POST /api/push/subscribe {endpoint,       │
                    │    keys:{p256dh,auth}}  ────────────┐      │
                    └──────────────────────────────────────┼─────┘
                                                             │
   ┌─────────────────────────────────────────────────────────▼───────────────┐
   │  FastAPI backend (single uvicorn process)                                │
   │                                                                          │
   │  push router  ──►  push_repository.create_subscription()                 │
   │                        │                                                │
   │                        ▼                                                │
   │                  push_subscriptions table (CASCADE FK users.id)          │
   │                                                                          │
   │  ┌────────────────────────────────────────────────────────────────┐    │
   │  │ run_periodic_train_reminders()  (asyncio.create_task, lifespan) │    │
   │  │   loop:                                                        │    │
   │  │     sleep(REMINDER_TICK_INTERVAL_SECONDS)  # >= 15 min          │    │
   │  │     candidates = SELECT users WHERE reminder_enabled            │    │
   │  │                  AND EXISTS(live push_subscriptions)            │    │
   │  │                  AND (reminder_last_sent_on IS NULL             │    │
   │  │                       OR reminder_last_sent_on < today_utc())   │    │
   │  │     for each candidate (Python, per-user zoneinfo):              │    │
   │  │       today = local_today(tz, now_utc)          ── D-16          │    │
   │  │       if not is_scheduled_day(today, weekday_mask): skip ── REMIND-03 │
   │  │       if local_hour < reminder_hour: skip        ── D-08          │    │
   │  │       if already sent today: skip                ── D-06/REMIND-05│    │
   │  │       await settle_streak_snapshot(...)           ── D-12          │    │
   │  │       if has completed drill_session today: skip  ── D-09/REMIND-04│    │
   │  │       claimed = UPDATE train_settings SET           ── D-07         │    │
   │  │                 reminder_last_sent_on=today          (commit BEFORE│    │
   │  │                 WHERE ... RETURNING user_id           any POST)     │    │
   │  │       if not claimed: skip  (raced by a concurrent tick)           │    │
   │  │       for each live subscription (fan-out, D-05):                  │    │
   │  │         msg = WebPush(vapid_keys).get(body, subscription)          │    │
   │  │         resp = await httpx.AsyncClient().post(endpoint,            │    │
   │  │                       content=msg.encrypted, headers=msg.headers)  │    │
   │  │         if resp.status_code in (404, 410): prune subscription      │    │
   │  │         elif not resp.is_success: log + sentry_capture, move on    │    │
   │  └────────────────────────────────────────────────────────────────┘    │
   └───────────────────────────────────────────┬────────────────────────────┘
                                                 │ HTTPS POST (aes128gcm body,
                                                 │  VAPID Authorization header)
                    ┌────────────────────────────▼────────────────────────────┐
                    │ Push service (browser-chosen, NOT ours):                  │
                    │  fcm.googleapis.com (Chrome) /                             │
                    │  updates.push.services.mozilla.com (Firefox) /             │
                    │  web.push.apple.com (Safari 16.4+)                         │
                    └────────────────────────────┬────────────────────────────┘
                                                 │ delivers to the device
                    ┌────────────────────────────▼────────────────────────────┐
                    │  Browser service worker (push-sw.js, imported via         │
                    │  workbox.importScripts into the Workbox-generated sw.js)  │
                    │                                                            │
                    │  self.addEventListener('push', event => {                 │
                    │    event.waitUntil(                                        │
                    │      self.registration.showNotification(title, {          │
                    │        body, tag:'train-reminder', renotify:false, ... })) │
                    │  })                                                        │
                    │  self.addEventListener('notificationclick', event => {    │
                    │    event.waitUntil(clients.matchAll(...) -> focus/navigate │
                    │      or clients.openWindow('/train'))                      │
                    │  })                                                        │
                    └────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
app/
├── models/
│   └── push_subscription.py       # NEW — push_subscriptions ORM model
├── schemas/
│   └── push.py                    # NEW — PushSubscribeRequest, VapidPublicKeyResponse
├── repositories/
│   └── push_repository.py         # NEW — create/list/prune push_subscriptions
├── routers/
│   └── push.py                    # NEW — POST /push/subscribe, DELETE /push/subscribe,
│                                   #        GET /push/vapid-public-key,
│                                   #        POST /push/dev/trigger-reminder (dev-only, D-17)
├── services/
│   ├── push_send.py               # NEW — webpush.WebPush wrapper + httpx POST + prune-on-410/404
│   └── train_reminder_service.py  # NEW — candidate selection + per-user eligibility + fan-out
│                                   #        orchestration (mirrors guest_cleanup_service.py shape)
├── core/
│   └── config.py                  # EDIT — add VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
├── main.py                        # EDIT — add run_periodic_train_reminders task (D-15)
scripts/
└── gen_vapid_keys.py              # NEW — one-shot keypair generator (D-03)
frontend/public/
└── push-sw.js                     # NEW — push + notificationclick handlers (D-13/D-14)
alembic/versions/
└── <ts>_<hash>_phase_201_push_subscriptions_and_reminder_columns.py  # NEW
```

### Pattern 1: Periodic background task (mirror `guest_cleanup_service.py`)
**What:** A named-interval `while True: sleep(); try: tick(); except: log+sentry` loop, wired into the FastAPI lifespan's `asyncio.create_task`, cancelled+awaited in the `finally` block.
**When to use:** REMIND-02's ≥15-minute reminder tick — this is the established, only-in-this-codebase pattern for periodic in-process work (no cron, no separate worker container, per D-15).
**Example (read verbatim from `app/services/guest_cleanup_service.py:189-217`, adapt the interval/tick call):**
```python
_REMINDER_TICK_INTERVAL_SECONDS = 15 * 60  # REMIND-02: >= 15 minutes

async def run_periodic_train_reminders() -> None:
    while True:
        await asyncio.sleep(_REMINDER_TICK_INTERVAL_SECONDS)
        try:
            await send_due_reminders()
        except Exception:
            logger.exception("Periodic train reminder tick failed")
            sentry_sdk.set_tag("source", "train_reminders")
            sentry_sdk.capture_exception()
```
Wire into `app/main.py`'s lifespan exactly like `guest_cleanup_task` (`app/main.py:120,132,152-157`): `asyncio.create_task(run_periodic_train_reminders(), name="train-reminders")`, cancelled in the `finally` block alongside the other four tasks, with its own `try/except asyncio.CancelledError` / `except Exception: logger.exception(...)` pair.

### Pattern 2: Nullable-Date watermark column (mirror `streak_settled_through`)
**What:** A single nullable `Date` column on an existing settings table used as an idempotency/progress marker, compared against a freshly-computed local date.
**When to use:** D-06's `reminder_last_sent_on` — exact same shape as `train_settings.streak_settled_through` (`app/models/train_settings.py:82`, `Mapped[datetime.date | None] = mapped_column(Date, nullable=True)`).

### Pattern 3: SmallInteger + range CheckConstraint (mirror `shield_level`)
**What:** A bounded integer domain column expressed as `SmallInteger` + a `CheckConstraint`, not a native enum (CLAUDE.md DB rule).
**When to use:** `reminder_hour` (0–23). Read verbatim from `app/models/train_settings.py:52-54`:
```python
CheckConstraint(
    f"shield_level BETWEEN 0 AND {SHIELD_CAP}", name="ck_train_settings_shield_level"
),
```
`reminder_hour` should follow identically: `CheckConstraint("reminder_hour BETWEEN 0 AND 23", name="ck_train_settings_reminder_hour")`, `SmallInteger`, `nullable=False`, `server_default="18"` (REMIND-01's stated default).

### Pattern 4: `httpx.AsyncClient` mocking in tests (mirror `test_chesscom_client.py`)
**What:** `unittest.mock.patch` on the client method, returning a `MagicMock`/`AsyncMock` response with `.status_code`/`.json()`/`.raise_for_status`.
**When to use:** Testing `push_send.py`'s send-and-prune logic without hitting real push services. Read verbatim from `tests/test_chesscom_client.py:1-62` — same idiom applies: `@patch("httpx.AsyncClient.post")` (or patch the module-level import site, matching this codebase's existing convention of patching where the name is *used*, per `test_chesscom_client.py`'s own docstring "Uses unittest.mock to patch httpx.AsyncClient.get") returning a `MagicMock(status_code=410)` etc. to drive the prune-on-410/404 branch and the log-and-continue branch (400/401/403/413/429/5xx) independently.

### Anti-Patterns to Avoid
- **Filtering `reminder_last_sent_on` by a single SQL date in the candidate query:** a user's local calendar day differs from UTC's by up to ±14 hours depending on timezone, so a `WHERE reminder_last_sent_on < CURRENT_DATE` (Postgres session/UTC date) can both over-select (a user whose local day hasn't started yet gets pulled in) and under-select (a user whose local day has already turned but whose watermark is still "UTC today" gets skipped) at the boundary. Per D-16, the SQL query narrows on `reminder_enabled` + subscription existence only; the per-user date/hour math happens in Python via `local_today`/`zoneinfo`, and the FINAL guard against a double-send is D-07's atomic per-user `UPDATE ... WHERE reminder_last_sent_on IS NULL OR reminder_last_sent_on < :today RETURNING`, where `:today` is that specific user's already-resolved local date.
- **Sending before claiming (D-07):** always commit the claim UPDATE before issuing the push HTTP POST. Sending first and marking after is more delivery-honest but reopens the double-send window this decision exists to close.
- **Switching `vite.config.ts`'s VitePWA strategy to `injectManifest`** to get push handlers — SEED-132 decision 15 / the hard constraint in REQUIREMENTS.md names this explicitly as a trap: it would require reimplementing `navigateFallback: null`, the all-HTML `globIgnores`, the wasm/onnx exclusions, and the `/api/*`-first `runtimeCaching` order, all by hand. `workbox.importScripts` achieves the same result with zero risk to those four production-bug fixes.
- **Reading `now_utc` via `dev_now_utc`/`X-Dev-Clock-Offset-Minutes` inside the reminder job:** the background task has no `Request` object — `dev_now_utc(request: Request)` cannot be called outside a FastAPI dependency-injected handler. D-17's dev-only trigger endpoint is a request-scoped alternative specifically because of this — do not attempt to thread the offset header into the scheduler loop.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| VAPID JWT signing (ES256) | A manual `jwt.encode(..., algorithm="ES256")` call plus manual EC key loading/PEM parsing | `webpush.vapid.VAPID.get_authorization_header()` (used internally by `WebPush.get()`) | RFC 8292's `aud`/`exp`/`sub` claim shape and the `t=...,k=...` header format are easy to get subtly wrong (e.g. `aud` must be `scheme://host` with NO path, `exp` must be an epoch-seconds int ≤24h out) — the library already gets this right and is testable as a black box rather than re-deriving RFC edge cases |
| `aes128gcm` payload encryption (RFC 8291) | Manual ECDH key exchange + HKDF key/nonce derivation + AES-GCM framing with the `\x02` padding byte and the 21-byte header (salt + record-size + key-length + key) | `webpush.WebPush._encrypt()` (private, called by `.get()`) | This is exactly the kind of "turns a wiring task into a crypto task with its own test-vector burden" D-01 explicitly rejected doing by hand; a single off-by-one in the HKDF `info` byte strings silently produces payloads every push service rejects or garbles |
| Timezone-aware "is this the user's scheduled/reminder hour" logic | A fresh `pytz`/`zoneinfo` comparison inside the reminder job | `app.services.train_scheduler.local_today` + `is_scheduled_day` (already pure, already unit-tested in `tests/services/test_train_scheduler.py`) | REMIND-03 explicitly requires reuse; a second timezone-math implementation is exactly the "duplicates timezone semantics ... where they can drift" risk D-16 names |
| Periodic background job scaffolding | A new bespoke `while True` / cron / separate container | The existing `run_periodic_*` lifespan-task pattern (4 already exist: reaper, eval-drain, full-eval-drain, guest-cleanup) | One more task in the same shape costs nothing architecturally and keeps shutdown/cancellation semantics uniform across all 5 |

**Key insight:** every piece of genuinely hard cryptography and timezone math this phase needs already has a correct, tested implementation either in a small transport-agnostic third-party library (`webpush`) or already living in this codebase (`train_scheduler`). The phase's actual net-new code is almost entirely orchestration: a new table, two new settings columns, a new periodic task, and a service-worker file — not new algorithms.

## Common Pitfalls

### Pitfall 1: `push-sw.js` is invisible to Workbox's cache-busting
**What goes wrong:** editing `frontend/public/push-sw.js` alone, without also touching `vite.config.ts`'s `workbox.importScripts` array, produces a deploy where the generated `sw.js` (which embeds the literal string `importScripts(["/push-sw.js"]);`) is byte-identical to the previous build. The browser's SW update algorithm force-bypasses HTTP cache **only for the top-level `sw.js` fetch**; the `importScripts()`-loaded `/push-sw.js` sub-resource is fetched according to normal HTTP caching rules. `deploy/Caddyfile` [VERIFIED: `deploy/Caddyfile:14-53`, read this session] sets explicit `Cache-Control` for `/sw.js`/`/registerSW.js`/`/manifest.webmanifest` (`no-cache`), `/assets/*` (`immutable`), `/maia/maia-worker.js` (`no-cache`), and `/maia/*`/`/engine/*` (`max-age=2592000`) — `/push-sw.js` matches **none** of these matchers and falls through to the bare `file_server` with no explicit header, meaning the browser applies its own heuristic freshness lifetime to it.
**Why it happens:** Workbox's `importScripts` option is unrelated to its precache manifest / `globIgnores` machinery — it is a plain code-generation string substitution, documented in the Workbox source template (`sw-template.ts`: `importScripts(<%= importScripts.map(JSON.stringify).join(...) %>);`) [VERIFIED: Context7 `/googlechrome/workbox`, `sw-template.ts`].
**How to avoid:** add `/push-sw.js` to the existing `@nocache` matcher in `deploy/Caddyfile` (`@nocache path /sw.js /registerSW.js /manifest.webmanifest /push-sw.js`), so every deploy forces revalidation regardless of whether the outer `sw.js` changed.
**Warning signs:** a fix to `push-sw.js`'s handler logic that "doesn't take effect" on a device that already had the app installed/registered, even after a hard reload of the page (a page reload does not force-refetch `importScripts()` sub-resources — only the SW update cycle does, and even that respects the sub-resource's own cache headers).

### Pitfall 2: 410 vs 404 vs everything else
**What goes wrong:** treating any non-2xx response as "prune the subscription" silently deletes subscriptions on a transient 5xx/429/timeout, defeating D-04's explicit "no retry, but also don't destroy state on a transient failure" contract.
**Why it happens:** RFC 8030 draws a real semantic distinction — 404 means the push service itself says the subscription URL is gone (`Subscription Expired`), 410 means the push service tried delivering, gave up, and will never accept for that endpoint again; both mean "dead, prune it." Everything else (400 malformed request, 401/403 invalid VAPID auth, 413 payload too large, 429 rate limited, 5xx server error) is either a bug in our own send path (400/401/403/413 — worth a Sentry capture to catch a construction error early) or transient (429/5xx — log and move on per D-04) [CITED: RFC 8030 §7, `pushpad.xyz/blog/web-push-errors-explained-with-http-status-codes`, and `github.com/zaru/webpush/issues/71` discussing the exact 404-vs-410 confusion].
**How to avoid:** branch explicitly: `status_code in (404, 410)` → prune; else → `logger.warning` + `sentry_sdk.capture_exception` (using a synthesized exception or the response text, never embedding the raw endpoint URL in the Sentry MESSAGE per CLAUDE.md's "never embed variables" rule — use `set_context`) + leave the row alone.
**Warning signs:** `push_subscriptions` row count dropping sharply during a push-service outage window.

### Pitfall 3: `mailto:` subscriber claim is mandatory, not optional
**What goes wrong:** `webpush.WebPush(...)` raises `WebPushException("Subscriber email required")` [VERIFIED: `webpush/__init__.py:95-98`, read verbatim this session] if neither the constructor nor the per-call `.get(subscriber=...)` argument supplies an email. Forgetting this crashes the very first send attempt.
**Why it happens:** RFC 8292's VAPID `sub` claim is a contact address push services may use to reach the operator about abuse; the library enforces it can't be silently blank.
**How to avoid:** supply a real, monitored address (e.g. `VAPID_SUBJECT` env var, mirroring the `VAPID_PRIVATE_KEY`/`VAPID_PUBLIC_KEY` empty-string-means-disabled convention — D-03 should extend to this third setting too) at `WebPush(...)` construction time, once, at module scope or per-send.
**Warning signs:** every single send failing with `WebPushException`, never reaching the network.

### Pitfall 4: `payload_size` — this library encrypts arbitrary messages, but push services still cap ciphertext at ~4KB
**What goes wrong:** the notification body/title JSON payload, once through `_encrypt()`, must stay under the RFC 8030 mandatory-support floor of 4096 bytes net (push services MAY reject larger with 413; some allow more, none are required to) [CITED: RFC 8030 §7.2 via WebSearch this session].
**Why it happens:** the D-10 "Day N" copy plus any icon/badge URLs is tiny (well under 200 bytes as JSON), so this is unlikely to bite in practice — flagged so nobody later stuffs a stack trace or a long PV line into the notification payload.
**How to avoid:** keep the payload to `{title, body, tag, url}`-shaped JSON only; if a 413 ever appears in the D-04 "log and move on" branch, that is the signal.
**Warning signs:** 413 responses appearing in Sentry.

### Pitfall 5: the candidate SQL query must exclude guests explicitly (REMIND-07)
**What goes wrong:** `push_subscriptions` has no natural guest exclusion of its own (unlike `app/routers/train.py`'s `_reject_guest` gate, which fires per-request) — the candidate SELECT for the periodic job is not behind any request-scoped guard.
**Why it happens:** guest games are never bulk-analysed so guests structurally have no puzzle pool (per SEED-132/REQUIREMENTS.md's own framing), meaning `reminder_enabled` should in practice never be True for a guest (no UI surface offers it — Phase 202 is not built yet, and even once it is, Train's `_reject_guest` 403s every `/train/*` call, including `PUT /train/settings`, so a guest literally cannot set `reminder_enabled=True` through the API). This makes an explicit `users.is_guest = false` filter defense-in-depth rather than the only guard — but it should still be added explicitly to the candidate query so REMIND-07 is enforced structurally, not merely by omission (the codebase's own convention, per `app/routers/train.py:47-54`'s explicit-403-not-inferred-from-empty-result pattern, favors explicit gates over relying on upstream invariants).
**How to avoid:** `JOIN users ON users.id = train_settings.user_id WHERE users.is_guest = false AND train_settings.reminder_enabled ...`.
**Warning signs:** none expected in practice given the UI-surface gap, but a missing explicit filter is a silent landmine for whenever guest promotion/demotion logic changes.

### Pitfall 6: the reminder job has no request context — `dev_now_utc` literally cannot be called
**What goes wrong:** attempting to import and call `app.core.dev_clock.dev_now_utc(request)` from inside `run_periodic_train_reminders`/`send_due_reminders` fails at the type level — the function's sole parameter is a FastAPI `Request`, which does not exist in a background `asyncio.create_task`.
**Why it happens:** the dev clock is deliberately request-scoped (per-browser-session override via a header), and a background job has no browser session.
**How to avoid:** the scheduler always uses `datetime.datetime.now(datetime.timezone.utc)` directly. REMIND-08 is satisfied entirely by D-17's separate dev-only POST endpoint (which DOES have a `Request` and can accept `dev_now_utc` normally, or can simply bypass all the hour/weekday/suppression checks and send immediately, which is what D-17 specifies — no clock manipulation needed there at all).
**Warning signs:** a `ty check` type error on any attempt to call `dev_now_utc()` outside a `Depends(...)`-injected handler.

## Code Examples

### 1. `push_subscriptions` model (PUSH-01)
```python
# app/models/push_subscription.py — new file
from __future__ import annotations

import datetime

from sqlalchemy import DateTime, ForeignKey, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class PushSubscription(Base):
    """One row per device-per-browser Web Push subscription (PUSH-01/PUSH-02).

    CASCADE-only to users.id (mirrors app/models/drill_session.py's FK
    shape) -- a subscription is pure client-supplied state, not
    game-derived data, so it has no other foreign key.
    """

    __tablename__ = "push_subscriptions"
    __table_args__ = (
        # A re-subscribe from the same browser/device returns the SAME
        # endpoint URL until it expires -- unique on endpoint alone
        # (not (user_id, endpoint)) prevents a duplicate row on repeat
        # subscribe calls and also prevents one endpoint being claimed
        # by two different user_ids simultaneously.
        UniqueConstraint("endpoint", name="uq_push_subscriptions_endpoint"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    p256dh: Mapped[str] = mapped_column(Text, nullable=False)
    auth: Mapped[str] = mapped_column(Text, nullable=False)
    # Claude's Discretion (CONTEXT.md): cheap static metadata for a future
    # device list. NOT a last_seen_at heuristic (D-05 rejected that).
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


__all__ = ["PushSubscription"]
```

### 2. VAPID key generation script (PUSH-03/D-03)
```python
# scripts/gen_vapid_keys.py — new file, mirrors the operator-facing
# one-shot shape of other scripts/ tools; NOT run automatically anywhere.
"""One-shot VAPID keypair generator (D-03).

Prints a PEM private key, PEM public key, and the base64url application
server key. Paste VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY into
/opt/flawchess/.env manually -- never committed, never auto-generated
into the DB (PUSH-03).
"""
from webpush.vapid import VAPID

private_key, public_key, application_server_key = VAPID.generate_keys()
print("VAPID_PRIVATE_KEY (paste PEM, escape newlines or use a multi-line .env value):")
print(private_key.decode())
print("VAPID_PUBLIC_KEY (PEM):")
print(public_key.decode())
print("Application server key (base64url, what PushManager.subscribe() needs client-side):")
print(application_server_key)
```
Note: `VAPID(private_key=..., public_key=...)` (the class `webpush.WebPush` wraps) accepts `bytes | Path | BytesIO | StringIO` for both keys [VERIFIED: `webpush/vapid.py:32-58`, read verbatim this session] — the simplest prod wiring is to store the raw PEM bytes as `.env` string values and pass them as `bytes` (`.encode()`) at `WebPush(...)` construction time, not as file paths (avoids needing key files on disk in the container).

### 3. Send path with prune-on-410/404 (PUSH-02/PUSH-04/D-04)
```python
# app/services/push_send.py — new file
from __future__ import annotations

import logging

import httpx
import sentry_sdk
from webpush import WebPush, WebPushSubscription
from webpush.types import WebPushKeys

from app.core.config import settings

logger = logging.getLogger(__name__)

# RFC 8292: exp MUST NOT exceed 24h. Also the D-03 empty-key disable check.
_VAPID_EXPIRATION_SECONDS = 12 * 60 * 60  # matches webpush's own default

# Status codes meaning "push service will never accept this endpoint again" (PUSH-02).
_PRUNE_STATUS_CODES = frozenset({404, 410})


def _build_webpush() -> WebPush | None:
    """Returns None when VAPID keys are unset (D-03 graceful disable)."""
    if not settings.VAPID_PRIVATE_KEY or not settings.VAPID_PUBLIC_KEY:
        return None
    return WebPush(
        private_key=settings.VAPID_PRIVATE_KEY.encode(),
        public_key=settings.VAPID_PUBLIC_KEY.encode(),
        subscriber=settings.VAPID_SUBJECT,
        expiration=_VAPID_EXPIRATION_SECONDS,
    )


async def send_to_subscription(
    client: httpx.AsyncClient,
    *,
    endpoint: str,
    p256dh: str,
    auth: str,
    payload: dict,
) -> bool:
    """Send one push message. Returns True if the subscription should be pruned.

    D-04: only 404/410 return True (prune). Every other non-2xx is logged +
    reported to Sentry and left alone -- no retry, no deletion.
    """
    wp = _build_webpush()
    if wp is None:
        return False  # D-03: VAPID unconfigured, no-op
    subscription = WebPushSubscription(
        endpoint=endpoint, keys=WebPushKeys(p256dh=p256dh, auth=auth)
    )
    message = wp.get(message=payload, subscription=subscription)
    try:
        resp = await client.post(
            str(subscription.endpoint),
            content=message.encrypted,
            headers=dict(message.headers),
        )
    except httpx.HTTPError:
        logger.exception("Push send transport error")
        sentry_sdk.set_tag("source", "push_send")
        sentry_sdk.capture_exception()
        return False

    if resp.status_code in _PRUNE_STATUS_CODES:
        return True
    if resp.status_code >= 400:  # 400/401/403/413/429/5xx per D-04
        logger.warning("Push send failed with status %d", resp.status_code)
        sentry_sdk.set_tag("source", "push_send")
        sentry_sdk.set_context("push_send", {"status_code": resp.status_code})
        sentry_sdk.capture_exception(
            RuntimeError(f"Push send returned {resp.status_code}")
        )
    return False
```
Note: `WebPushMessage.headers` [VERIFIED: `webpush/types.py`, read verbatim] contains exactly `{"ttl", "content-encoding", "authorization"}` (lowercase keys) — it does **not** include `Content-Type` or `Urgency`. Most push services (Chrome/FCM, Mozilla autopush) do not require an explicit `Content-Type` for a binary `aes128gcm` body, but adding `"Urgency": "normal"` explicitly is a defensible extra header if the planner wants delivery-priority control later; it is optional per RFC 8030 (defaults to "normal" server-side when absent).

### 4. `train_settings` migration + model diff (REMIND-01)
```python
# alembic/versions/<ts>_<hash>_phase_201_push_subscriptions_and_reminder_columns.py
# down_revision MUST be '2c248989d979' (the current head, verified this
# session — `alembic/versions/20260728_184611_2c248989d979_...py`).

def upgrade() -> None:
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("p256dh", sa.Text(), nullable=False),
        sa.Column("auth", sa.Text(), nullable=False),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("endpoint", name="uq_push_subscriptions_endpoint"),
    )
    op.add_column(
        "train_settings",
        sa.Column("reminder_enabled", sa.Boolean(), server_default="false", nullable=False),
    )
    op.add_column(
        "train_settings",
        sa.Column("reminder_hour", sa.SmallInteger(), server_default="18", nullable=False),
    )
    op.create_check_constraint(
        "ck_train_settings_reminder_hour", "train_settings", "reminder_hour BETWEEN 0 AND 23"
    )
    op.add_column(
        "train_settings", sa.Column("reminder_last_sent_on", sa.Date(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("train_settings", "reminder_last_sent_on")
    op.drop_constraint("ck_train_settings_reminder_hour", "train_settings", type_="check")
    op.drop_column("train_settings", "reminder_hour")
    op.drop_column("train_settings", "reminder_enabled")
    op.drop_table("push_subscriptions")
```
Repository diff (mirrors `get_or_create_settings`, `app/repositories/train_repository.py:235-277`): add `reminder_enabled`, `reminder_hour`, `reminder_last_sent_on` to `TrainSettingsRow`, the `get_settings`/`get_or_create_settings` SELECT and INSERT-defaults, and (for `reminder_enabled`/`reminder_hour` only — `reminder_last_sent_on` is job-owned, never client-writable) `upsert_settings`'s `ON CONFLICT DO UPDATE` `set_={...}` dict and `TrainSettingsUpdate`/`TrainSettingsResponse` in `app/schemas/train.py`.

### 5. Claim-then-send idempotency guard (REMIND-05/D-06/D-07)
```python
# Inside train_reminder_service.py's per-candidate loop, AFTER the
# is_scheduled_day / hour / already-trained-today checks pass, and AFTER
# settle_streak_snapshot (D-12) has run so streak_count is current:

claim_stmt = (
    update(TrainSettings)
    .where(
        TrainSettings.user_id == user_id,
        or_(
            TrainSettings.reminder_last_sent_on.is_(None),
            TrainSettings.reminder_last_sent_on < today,
        ),
    )
    .values(reminder_last_sent_on=today)
    .returning(TrainSettings.user_id)
)
claimed = (await session.execute(claim_stmt)).scalar_one_or_none()
await session.commit()  # D-07: commit the claim BEFORE any push POST
if claimed is None:
    continue  # raced by a concurrent tick / already sent
# ... now safe to fan out to every live subscription (D-05) and send.
```

### 6. `push-sw.js` handlers (PUSH-06/D-13/D-14)
```javascript
// frontend/public/push-sw.js — new file, imported via
// workbox.importScripts: ['/push-sw.js'] in vite.config.ts.
// Runs inside the Workbox-generated service worker's global scope.

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Time to train';
  const options = {
    body: data.body || '',
    tag: 'train-reminder',      // D-14: fixed tag
    renotify: false,             // D-14: no re-buzz on backlog replace
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/train' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/train';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(targetUrl);
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
```
[CITED: MDN `ServiceWorkerGlobalScope: notificationclick event`, `WindowClient` — standard `event.waitUntil`/`clients.matchAll`/`.focus()`/`.navigate()`/`clients.openWindow()` shape, verified via WebSearch this session against the exact contract D-13 already specifies] Failure modes to guard against: an unhandled promise rejection inside `event.waitUntil(...)` (wrap in try/catch if `data.json()` might throw on a malformed payload) can terminate the SW's ability to keep the event alive, silently dropping the notification; `event.data` can be `null` if a push arrives with no payload (defensive `? :` above handles this); a revoked notification permission mid-flight simply means `showNotification` rejects — no crash, but worth a `.catch()` if visibility into silent failures matters later.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Safari Web Push required a paid Apple Developer Program cert + proprietary `web.push.apple.com`-adjacent flow | Standard VAPID + Web Push Protocol, same as Chrome/Firefox | Safari 16.4 (macOS Ventura 13.0 era) [CITED: WebSearch this session] | Confirms REQUIREMENTS.md's "Apple Web Push does NOT require the $99 Developer Program" premise — no code impact this phase (iOS is deferred), but validates the premise the whole SEED-132 cost analysis rests on |
| `pywebpush` (bundles `requests` + `aiohttp` as of 2.3.0, 2026-02-09) as the default Python web-push library | Purpose-built transport-agnostic libraries (`webpush`, or `py-vapid`+`http-ece`) | Ongoing — `pywebpush`'s own `requires_dist` now lists BOTH `requests` and `aiohttp`, suggesting even its own maintainers are aware of the async gap but haven't removed the sync dependency | This phase's entire D-01 research question exists because of this gap; resolved by NOT using `pywebpush` |

**Deprecated/outdated:**
- `aesgcm` Content-Encoding (the pre-RFC-8291 payload encryption scheme, still supported by `pywebpush` for legacy compatibility): not relevant here — `webpush` only implements `aes128gcm`, which is what every current browser (Chrome ≥50, Firefox ≥55, Safari 16.4+) expects.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `webpush` 1.0.6's low GitHub star count (18) and single active maintainer represent a genuine but acceptable maintenance-risk tradeoff, not a reason to reject it | Package Legitimacy Audit | If the maintainer abandons the project and a future `cryptography`/`pyjwt` major bump breaks it, the send path needs a swap to the documented `py-vapid`+`http-ece` fallback — bounded, one-time cost, not a silent failure (the package would simply stop installing/importing, not silently misbehave) |
| A2 | A project mailbox address (e.g. `push@flawchess.com`) is an acceptable `VAPID_SUBJECT`/`subscriber` value and does not need to be a personal email | Code Examples § 3, Pitfall 3 | Low risk — RFC 8292 only requires it be a contact method push services MAY use; any deliverable address works |
| A3 | Adding `"Urgency": "normal"` header is optional, not required, for delivery | Code Examples § 3 | Low risk — RFC 8030 defaults to "normal" server-side when the header is absent; only relevant if delivery timing issues appear later |
| A4 | `webpush-rs` (the Rust/PyO3 binding) was correctly assessed as unnecessary at this volume without deep independent verification of its own maintenance/download signals | Standard Stack § Alternatives Considered | Low risk — it was not chosen, so a stale assessment here does not affect the shipped code; flagged only for completeness |

**If this table is empty:** N/A — see entries above; none are HIGH-risk to the phase's success criteria.

## Open Questions (RESOLVED)

Both questions were resolved at plan time. Neither became a checkpoint task:
this run carries an explicit operator instruction — "Don't ask questions in
between, I'll test everything after the phase is executed" — so both were
resolved in the plans and surfaced for review in the diff instead.

1. **Exact `VAPID_SUBJECT` value to use in prod**
   - What we know: RFC 8292 requires SOME `mailto:` contact address; the codebase has no existing "operator contact email" convention to reuse.
   - What's unclear: whether `push@flawchess.com` exists as a real mailbox yet, or whether a different address (e.g. the operator's own) should be used.
   - Recommendation: planner should treat this as a `checkpoint:human-verify` (or add it to CONTEXT.md at plan time) rather than guessing — it's a one-line `.env` value, not a design decision, but it needs the operator to confirm a real deliverable address.
   - **RESOLVED:** `VAPID_SUBJECT` defaults to `push@flawchess.com`, set in `201-01-PLAN.md` Task 1 Step 1 (the `Settings` default plus the `.env.example` documentation) and printed by `scripts/gen_vapid_keys.py` as a ready-to-paste line. The operational caveat — point it at a monitored mailbox before enabling push in prod — is recorded in that plan's `<flagged_assumptions>` block. It is a one-line `.env` value, changeable without touching any code.

2. **Whether to `checkpoint:human-verify` the `webpush` package choice itself**
   - What we know: the package is verified functionally correct (source read verbatim, matches its own PyPI metadata) and dependency-clean (`requests`-free), but has low GitHub activity.
   - What's unclear: whether the operator prefers to accept that risk or spend the extra glue-code effort on the more-downloaded `py-vapid`+`http-ece` composition instead.
   - Recommendation: the Package Legitimacy Audit above already flags this — the planner should insert a `checkpoint:human-verify` task before the `uv add webpush` step presenting both options.
   - **RESOLVED:** no checkpoint task was created, per the no-checkpoint instruction above. `webpush` 1.0.6 stands (D-01), with the choice made auditable in three places instead of a gate: § Package Legitimacy Audit in this file (the full signal set and the one honest maintenance flag), threat `T-201-SC` in `201-01-PLAN.md`'s STRIDE register, and that plan's `<flagged_assumptions>` block, which records the `py-vapid` + `http-ece` fallback as a documented drop-in for `build_webpush` / `send_to_subscription` only — roughly an hour of glue code, no change to any other file in the phase.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|--------------|-----------|---------|----------|
| PostgreSQL (dev) | `push_subscriptions` table, migration | ✓ (per CLAUDE.md dev workflow — assumed running, not re-verified this session) | 18 (per CLAUDE.md) | — |
| `webpush` PyPI package | Send path (D-01) | not yet installed — verified installable via PyPI (`pip index versions webpush` equivalent confirmed via PyPI JSON API) | 1.0.6 | `py-vapid`+`http-ece` composition (both independently verified installable) |
| External push services (fcm.googleapis.com, updates.push.services.mozilla.com, web.push.apple.com) | Actually delivering a push in dev/staging | Cannot be verified from this research session (requires a real browser subscription) | — | None needed — these are the fixed, free, vendor-less endpoints REQUIREMENTS.md already establishes; no dev-environment substitute exists other than mocking `httpx.AsyncClient.post` in tests (see Architecture Patterns § 4) |
| Real browser (Chrome/Firefox/Edge/Safari) with notification permission granted | End-to-end UAT of the whole push flow | Not available in this research session (backend-only phase; browser UAT is this phase's own Validation Architecture gap, see below) | — | D-17's dev-only trigger endpoint + `curl` is the phase's own within-scope substitute; full browser UAT is deferred to Phase 202 per SEED-132's phase split, though the planner may still want a minimal manual `curl`-driven smoke test in this phase's own verification |

**Missing dependencies with no fallback:** none — every dependency this phase needs is either already present, installable, or has a documented fallback.

**Missing dependencies with fallback:** `webpush` package (fallback: `py-vapid`+`http-ece`), real-browser delivery testing (fallback: mocked `httpx` in unit tests + a dev-only `curl`-driven trigger endpoint for a manual smoke check against a real subscribed browser, if the operator has one handy — not required for this phase's automated verification).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | pytest 8.x + pytest-asyncio (async_mode=auto) + pytest-xdist, per-run cloned test DB (see `tests/conftest.py`) |
| Config file | `pyproject.toml` `[tool.pytest.ini_options]` |
| Quick run command | `uv run pytest tests/test_push_send.py tests/services/test_train_reminder_service.py tests/routers/test_push.py -x` (new test files, exact names at planner's discretion) |
| Full suite command | `uv run pytest -n auto` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|---------------------|--------------|
| PUSH-01 | `push_subscriptions` CASCADE-deletes when the owning user is deleted | integration (DB) | `pytest tests/models/test_push_subscription.py -x` | ❌ Wave 0 |
| PUSH-02 | 410/404 response prunes the row; other statuses do not | unit (mocked `httpx.AsyncClient.post`) | `pytest tests/test_push_send.py -x` | ❌ Wave 0 |
| PUSH-03 | Public key reachable at subscribe time; private key never leaves `.env`/process env | unit (`GET /push/vapid-public-key` returns the configured public key; grep-based CI check that no test/fixture commits a private key literal is out of scope for pytest — a manual code-review item) | `pytest tests/routers/test_push.py::test_vapid_public_key -x` | ❌ Wave 0 |
| PUSH-04 | Send path never imports/calls `requests`; issues no blocking call | static (dependency audit, not a runtime test) — `python -c "import webpush; import sys; assert 'requests' not in sys.modules"` after importing the send module, OR simply verify `uv.lock`/`pip list` has no `requests` transitively from the `push` group | manual verification step at merge time (see Assumptions Log — no automated CI gate exists for "no blocking call from the event loop" beyond code review + the dependency audit) | N/A — HUMAN-UAT / code-review gate |
| PUSH-05 | No Firebase/vendor SDK imported | static (dependency audit) | same as PUSH-04 | N/A — HUMAN-UAT / code-review gate |
| PUSH-06 | `workbox.importScripts` config present, existing `workbox` block unchanged | unit (frontend, snapshot/diff test on `vite.config.ts`'s workbox object) OR manual diff review | `npm test -- --run` if a config-snapshot test is added; otherwise a plain `git diff` review at merge time | ❌ Wave 0 (optional — may be a review-only gate, not a test) |
| REMIND-01 | `reminder_enabled`/`reminder_hour` default correctly through `get_or_create_settings` | unit/integration | `pytest tests/test_train_repository.py -k reminder -x` (extend existing file) | Existing file, new cases |
| REMIND-02 | Tick interval constant is ≥15 minutes | unit (constant assertion — trivial but catches an accidental typo) | `pytest tests/services/test_train_reminder_service.py::test_tick_interval_at_least_15_minutes -x` | ❌ Wave 0 |
| REMIND-03 | No reminder sent on an unscheduled day | unit (pure function, mirrors `test_train_scheduler.py`'s style if the day-eligibility logic is factored into a pure function; otherwise integration) | `pytest tests/services/test_train_reminder_service.py -k scheduled_day -x` | ❌ Wave 0 |
| REMIND-04 | Suppressed when a completed session exists for local-today | integration (DB) | `pytest tests/services/test_train_reminder_service.py -k already_trained -x` | ❌ Wave 0 |
| REMIND-05 | Idempotent under a simulated concurrent double-tick | integration (DB, two overlapping claim UPDATEs) | `pytest tests/services/test_train_reminder_service.py -k idempotent -x` | ❌ Wave 0 |
| REMIND-06 | All live subscriptions receive the send (fan-out) | integration (mocked `httpx`, assert N calls for N subscriptions) | `pytest tests/services/test_train_reminder_service.py -k fan_out -x` | ❌ Wave 0 |
| REMIND-07 | Guest users never appear in the candidate query | integration (DB) | `pytest tests/services/test_train_reminder_service.py -k guest_excluded -x` | ❌ Wave 0 |
| REMIND-08 | Dev-only trigger endpoint sends immediately, bypasses checks, 404s outside dev | integration (router, `ENVIRONMENT` monkeypatched) | `pytest tests/routers/test_push.py -k dev_trigger -x` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** the relevant new test file(s) only (`pytest tests/<new_file>.py -x`)
- **Per wave merge:** `uv run pytest -n auto` (full backend suite)
- **Phase gate:** full suite green before `/gsd-verify-work`; frontend `npm run lint && npm test -- --run` if `push-sw.js` gets its own test file (Workbox `importScripts` config itself is not natively testable via Vitest — it's a build-time string substitution — so PUSH-06's automated coverage is necessarily thin; the strongest automated check is a `vite build` + grep of the generated `dist/sw.js` for the literal `importScripts(["/push-sw.js"])` substring)

### Wave 0 Gaps
- [ ] `tests/models/test_push_subscription.py` — CASCADE-delete behavior, unique-endpoint constraint
- [ ] `tests/test_push_send.py` — mocked-`httpx` send/prune/log branches (mirrors `tests/test_chesscom_client.py`'s mocking idiom)
- [ ] `tests/services/test_train_reminder_service.py` — candidate selection, scheduled-day/hour/already-trained/idempotency/fan-out/guest-exclusion cases
- [ ] `tests/routers/test_push.py` — subscribe/unsubscribe/vapid-public-key/dev-trigger endpoints
- [ ] No new framework install needed — pytest + pytest-asyncio + the existing per-run-DB isolation cover everything; `unittest.mock` (stdlib) covers the `httpx` mocking, matching the established `test_chesscom_client.py` pattern

**Cannot be automatically validated (HUMAN-UAT required):**
- Real end-to-end push delivery to an actual subscribed browser (Chrome/Firefox/Safari) — this phase has no user-facing subscribe UI yet (that's Phase 202), so the only in-phase way to exercise this is `curl`-driving the subscribe endpoint with a manually-obtained browser subscription JSON (e.g. via the browser devtools console calling `PushManager.subscribe()` against the dev VAPID public key) and then hitting D-17's dev-only trigger endpoint, watching for a real OS notification to appear. Recommend this as an explicit `checkpoint:human-verify` / manual verification step in the plan, not skipped entirely — it is the only way to prove PUSH-01 through PUSH-06 work together end-to-end before Phase 202 builds the UI on top.
- Apple Web Push / Safari-specific header quirks — genuinely out of reach without a Safari 16.4+ device (macOS or iOS), and iOS itself is explicitly deferred to SEED-132 Phase B. Desktop Safari (macOS) is technically in this phase's scope (SEED-132 decision 1: desktop push is first-class across "Chrome/Edge/Firefox" — Safari desktop is not explicitly named in that list, worth flagging to the operator if Safari-desktop coverage is expected this phase).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|-------------------|
| V2 Authentication | no | Push subscribe/unsubscribe endpoints sit behind the existing `current_active_user` FastAPI-Users dependency — no new auth mechanism |
| V3 Session Management | no | Unaffected — no new session concept |
| V4 Access Control | yes | Every push endpoint must scope to `current_active_user.id`, never a client-supplied `user_id` (V4/IDOR — the exact pattern already enforced throughout `app/routers/train.py`, e.g. "V4: never client-supplied" comments at `app/repositories/train_repository.py:9-14`); the dev-only trigger endpoint (D-17) must ALSO stay scoped to the calling user's own subscriptions, never accept a target `user_id` |
| V5 Input Validation | yes | Pydantic schemas for `POST /push/subscribe` body (`endpoint`, `keys.p256dh`, `keys.auth` — validate `endpoint` is a well-formed HTTPS URL via Pydantic's `AnyHttpUrl`, matching `webpush.types.WebPushSubscription`'s own field type); `reminder_hour` bounded 0–23 at both the Pydantic layer (mirroring `TrainSettingsUpdate.weekday_mask`'s `Field(ge=0, le=127)` pattern) and the DB CHECK constraint |
| V6 Cryptography | yes | Never hand-roll — `webpush`'s `cryptography`-backed ECDH/HKDF/AES-GCM implementation is the standard control (see Don't Hand-Roll); the VAPID private key must never be logged, never embedded in a Sentry message, and never committed (D-02/D-03, `/opt/flawchess/.env` only) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| A malicious client POSTs a `push_subscriptions` row with a forged `endpoint` pointing at an internal/private network address (SSRF via push send) | Spoofing / Tampering | Pydantic's `AnyHttpUrl` type restricts to well-formed HTTPS URLs but does NOT block private/internal IP ranges by itself; the actual push services (`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`) are the only realistic legitimate targets, and `httpx.AsyncClient`'s outbound POST from the backend to an attacker-controlled `endpoint` is a real SSRF surface worth flagging to the planner — a defense-in-depth option is validating the endpoint's host against an allowlist of known push-service domains before ever sending, though this may be more restrictive than needed if the goal is broad browser compatibility (new push-service domains can appear). Flagged as an Open Question for the planner to size proportionally — at minimum, `httpx.AsyncClient` should NOT follow redirects to arbitrary hosts (`follow_redirects=False`, the httpx default) when POSTing to a subscription endpoint. |
| A user's push subscription is exfiltrated and replayed by an attacker to fingerprint when a user is "at their desk" (D-05 fan-out reveals device presence indirectly) | Information Disclosure | Out of scope for this phase's threat model — the fan-out itself is server-to-push-service, not attacker-observable; no new disclosure surface beyond what `PushManager.subscribe()` already exposes client-side by design (this is inherent to Web Push, not a FlawChess-specific gap) |
| VAPID private key committed to git or logged in an error message | Information Disclosure | D-02/D-03's `.env`-only convention; CLAUDE.md's "never embed variables in error messages" rule applied specifically — a `WebPushException`/crypto error must never interpolate key material into its message string |
| Reminder body content injection (a malicious `streak_count` or similar server-computed value somehow reaching the notification body unescaped) | Tampering | Not a real risk here — every value in the notification body (`streak_count + 1`, per D-10) is server-computed from the authenticated user's own `train_settings` row, never client-supplied free text; no HTML/script injection surface exists in a native OS notification's plain-text body/title fields |

## Sources

### Primary (HIGH confidence)
- `pypi.org/pypi/webpush/json`, `pypi.org/pypi/py-vapid/json`, `pypi.org/pypi/http-ece/json`, `pypi.org/pypi/pywebpush/json`, `pypi.org/pypi/cryptography/json` — PyPI JSON API, fetched directly via `curl` this session; authoritative for version/dependency/release-date claims
- `raw.githubusercontent.com/delvinru/webpush-py/main/{pyproject.toml,webpush/__init__.py,webpush/types.py,webpush/vapid.py,webpush/cli.py}` — full source read verbatim this session, confirmed byte-consistent with the pinned PyPI 1.0.6 release via matching `pyproject.toml` version string and git tag `1.0.6`
- `api.github.com/repos/delvinru/webpush-py` (+ `/tags`, `/commits`) — repo metadata (stars, issues, license, last-push date) fetched directly this session
- `pypistats.org/api/packages/*/recent` — real download-count data, fetched directly this session (overrides the automated `package-legitimacy` seam's `unknown-downloads` false-positive for the PyPI ecosystem)
- Context7 `/googlechrome/workbox` — `sw-template.ts` and `GenerateSWOptions` JSON schema, confirming `importScripts` is a plain code-generation option separate from the precache manifest
- This session's `Read` of: `app/services/guest_cleanup_service.py`, `app/main.py`, `app/services/train_scheduler.py`, `app/models/train_settings.py`, `app/repositories/train_repository.py` (relevant functions), `app/models/drill_session.py`, `app/core/config.py`, `app/core/dev_clock.py`, `app/routers/train.py`, `app/schemas/train.py`, `frontend/vite.config.ts` (lines 50-140), `deploy/Caddyfile`, `pyproject.toml`, `Dockerfile`, `Dockerfile.worker`, `app/models/base.py`, `app/core/database.py` (relevant lines), `tests/test_chesscom_client.py`, `tests/test_guest_cleanup_service.py` (docstring), `tests/test_main_lifespan.py`, alembic migration history (revision chain, head = `2c248989d979`) — all quoted verbatim with line ranges where cited above

### Secondary (MEDIUM confidence)
- WebSearch results on RFC 8030/8292 status-code and payload-size semantics, cross-referenced against `pushpad.xyz` and a real `web-push-libs/webpush-java` GitHub issue discussing the 404-vs-410 distinction — not read directly from the RFC text itself this session, but corroborated across 2+ independent sources
- WebSearch on Safari 16.4 Web Push / VAPID history (no Apple Developer Program requirement) — corroborates REQUIREMENTS.md's own pre-existing claim, not newly discovered
- WebSearch on MDN `notificationclick`/`clients.matchAll`/`WindowClient` API shape — standard, well-established browser API, not independently fetched from developer.mozilla.org this session (search-result synthesis only)

### Tertiary (LOW confidence)
- `webpush-rs` (PyO3 Rust binding) — surfaced in one WebSearch result only, not independently verified; explicitly not recommended, kept only as a "considered and rejected" note

## Metadata

**Confidence breakdown:**
- Standard stack (the D-01 blocker): HIGH — resolved via direct PyPI JSON API + verbatim GitHub source read, cross-checked against the pinned release tag
- Architecture (periodic-task/schema/repository patterns): HIGH — every pattern cited is read verbatim from this exact codebase, not inferred
- Service worker mechanics (PUSH-06): HIGH for the `importScripts` code-generation behavior (Context7-verified against Workbox's actual template source) and the Caddy cache-header gap (verified by reading `deploy/Caddyfile` directly); MEDIUM for browser-level HTTP caching nuances of `importScripts()` sub-resources (corroborated via WebSearch, not independently tested against a live browser this session)
- Web Push protocol details (status codes, payload limits, VAPID claims): MEDIUM — corroborated across 2+ independent WebSearch sources but not read directly from RFC 8030/8292 text this session
- Pitfalls: HIGH for pitfalls 1, 3, 5, 6 (all verified against this codebase's actual files or the library's actual source); MEDIUM for pitfalls 2 and 4 (protocol-level claims, WebSearch-corroborated)

**Research date:** 2026-08-01
**Valid until:** ~30 days for the codebase-anchor claims (stable, this repo's Train/main.py/config.py shape does not change fast); ~14 days for the `webpush` package pin specifically (small project, re-verify `pypi.org/pypi/webpush/json` immediately before `uv add` if planning is delayed) — re-check its GitHub `pushed_at` date at plan time in case a newer release changed the dependency tree.
