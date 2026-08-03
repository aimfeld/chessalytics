# Phase 201: Push Infrastructure & Train Reminders - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-01
**Phase:** 201-push-infrastructure-train-reminders
**Areas discussed:** Send path & VAPID policy, Fan-out & idempotency ledger, Notification content & click target, Scheduler placement & dev testing

---

## Send path & VAPID policy

### How should the send path be built?

| Option | Description | Selected |
|--------|-------------|----------|
| Crypto lib + our own httpx POST (Recommended) | Transport-agnostic library does VAPID signing + aes128gcm encryption, hands back headers + body; we POST with `httpx.AsyncClient`. No `requests`, no hand-rolled crypto. | ✓ |
| pywebpush in asyncio.to_thread | Smallest code, best-trodden path, but pulls `requests` into the image. Honors PUSH-04's intent, not its letter. | |
| Fully hand-rolled on cryptography + httpx | ES256 JWT + ECDH/HKDF/AES-128-GCM written here. Zero new runtime deps beyond `cryptography`, but a real crypto implementation task. | |
| You decide after research | Let the researcher benchmark all three. | |

**User's choice:** Crypto lib + our own httpx POST
**Notes:** Research still has to pin the exact package; `py-vapid` + `http-ece`-style composition is the fallback if no single transport-agnostic package holds up.

### What is the VAPID rotation policy?

| Option | Description | Selected |
|--------|-------------|----------|
| Single key, rotation = accepted mass invalidation (Recommended) | One keypair in `/opt/flawchess/.env`. Rotation silently kills every subscription; documented as a known consequence with an operational note. | ✓ |
| Single key + documented re-subscribe recovery path | Frontend re-subscribes when the server's public key differs from the one the browser holds, so rotation self-heals on next visit. | |
| Dual-key overlap window | `vapid_key_id` per subscription; sign with the key that subscription was created under. Zero breakage, real machinery. | |

**User's choice:** Single key, rotation = accepted mass invalidation

### What happens when VAPID keys are unset (dev, test, a fresh clone)?

| Option | Description | Selected |
|--------|-------------|----------|
| Graceful disable (Recommended) | Empty key = feature off, mirroring `SENTRY_DSN`'s convention. `scripts/gen_vapid_keys.py` one-shot for generation. | ✓ |
| Startup abort | Raises at lifespan like `PYDANTIC_AI_MODEL_INSIGHTS`. Impossible to ship prod with push silently dead, but taxes every dev and CI job. | |
| Auto-generate on first boot into the DB | No operator step, but violates PUSH-03 — the private key would sit in Postgres and in every dump. | |

**User's choice:** Graceful disable

### How should transient push-service failures (5xx, 429, timeout) be handled?

| Option | Description | Selected |
|--------|-------------|----------|
| No retry — log, capture, move on (Recommended) | A reminder is worthless an hour late; the next scheduled day brings another. Single pass, no backoff state. | ✓ |
| Bounded in-tick retry | Two retries with short backoff. Catches a momentary FCM blip, stretches tick wall time. | |
| Retry on the next tick | Mark failed rather than sent so the next tick retries. Most delivery-complete, turns the ledger into a state machine. | |

**User's choice:** No retry — log, capture, move on

---

## Fan-out & idempotency ledger

### What is the fan-out rule for a user with several subscribed devices?

| Option | Description | Selected |
|--------|-------------|----------|
| All devices (Recommended) | Every live subscription gets the push. No activity tracking. Accepted cost: double-buzz for a user at their desk with their phone nearby. | ✓ |
| Most-recently-active device only | One buzz, but needs `last_seen_at` plus machinery to keep it honest, and can pick the laptop closed at 17:00. | |
| All devices, but collapse via notification tag | Only helps the same-device case, which the idempotency guard already prevents. | |

**User's choice:** All devices

### Where does the 'already sent today' guard live?

| Option | Description | Selected |
|--------|-------------|----------|
| `reminder_last_sent_on` DATE on train_settings (Recommended) | Same shape and table as `streak_settled_through`. No new table. No history. | ✓ |
| Separate `push_reminder_sends` log table | UNIQUE constraint does the idempotency at DB level, plus per-send outcome. A forever-growing table with a retention question. | |
| Both — column for the guard, Sentry/log for history | Minimal schema plus a trail, but the trail is subject to ~1h prod docker log retention. | |

**User's choice:** `reminder_last_sent_on` DATE on train_settings

### If the backend misses a user's hour, does the reminder still go out late?

| Option | Description | Selected |
|--------|-------------|----------|
| Catch up until end of local day (Recommended) | "local hour >= reminder_hour AND not sent today AND no completed session today". Survives deploys and short outages; a long outage yields a late reminder. | ✓ |
| Strict window — [hour, hour+15min) only | Never a late buzz, but any missed tick silently costs that user their reminder. | |
| Catch up within a bounded lateness (e.g. 2 hours) | Middle ground at the cost of one more named constant and clause. | |

**User's choice:** Catch up until end of local day

### What counts as 'already trained today' for the send-time suppression (REMIND-04)?

| Option | Description | Selected |
|--------|-------------|----------|
| A completed session (Recommended) | `drill_sessions` for today with non-null `completed_at`. Matches REMIND-04 and the streak machine. Abandoned sessions still get the nudge. | ✓ |
| Any session touched today | Never nags someone mid-session, but rewards abandoning. | |
| A completed session, OR an open one started recently | Correct in the narrow mid-session case, costs a second time-window constant. | |

**User's choice:** A completed session

---

## Notification content & click target

### What does the reminder actually say?

| Option | Description | Selected |
|--------|-------------|----------|
| Static, practice-framed (Recommended) | Fixed title + body. No per-user query, nothing that can be stale, survives every edge case. | |
| Include the puzzle count | More concrete, but costs a pool-count query and introduces a number that can disagree with the app a minute later. | |
| Include the streak count | Strongest pull for an engaged user; flagged as edging toward the loss-aversion framing SEED-132 rejected, and as reading badly at streak 0. | ✓ |

**User's choice:** Include the streak count
**Notes:** Chosen over the recommendation. `streak_count` is already on the `train_settings` row the job loads, so it costs no extra query — the concern was purely the streak-0 case, resolved below.

### What does the copy say when `streak_count` is 0?

| Option | Description | Selected |
|--------|-------------|----------|
| Fall back to the static copy (Recommended) | streak >= 1 gets the day number, streak 0 gets neutral copy. One branch. | |
| Invitational start copy | "Start a new streak" — more motivating, but names the absence. | |
| Show it regardless | "Day 0" verbatim. Simplest, most annoying to the user we most need back. | |

**User's choice:** *(free text)* "The day number is streak_count + 1, so this is not a problem."
**Notes:** Dissolves the branch entirely — the number names *today's* session rather than the last completed one, so a fresh or just-broken user reads "Day 1". No zero case exists. Adopted as D-10.

### Should `shield_level` appear anywhere in the notification?

| Option | Description | Selected |
|--------|-------------|----------|
| No (Recommended) | Mentioning shields is the deadline/loss-aversion framing SEED-132 decision 10 rejected. | ✓ |
| Yes, when the shield is low | Strongest urgency signal, but a direct reversal of a locked seed decision. | |

**User's choice:** No

### `streak_count` is a settled snapshot. What should the job do about a stale count?

| Option | Description | Selected |
|--------|-------------|----------|
| Settle first, then send (Recommended) | Job calls `settle_streak_snapshot` before building the copy, so "Day N" is honest. Makes the job a writer of streak state. | ✓ |
| Read as-is, accept staleness | Strictly read-only apart from the ledger, but ships a number we know can be false. | |
| Drop the day number when the snapshot is stale | Never wrong, never a writer, but silently degrades for exactly the lapsed users being reminded. | |

**User's choice:** Settle first, then send

### Where does `notificationclick` land?

| Option | Description | Selected |
|--------|-------------|----------|
| Focus an existing FlawChess tab, else open /train (Recommended) | `clients.matchAll` → `focus()` + `navigate('/train')`, else `openWindow`. ~15 lines. | ✓ |
| Always open a new window at /train | Three lines, but a second tab every time for a desktop user with the app open. | |

**User's choice:** Focus an existing FlawChess tab, else open /train

### Should reminders collapse on the device (notification `tag`)?

| Option | Description | Selected |
|--------|-------------|----------|
| Fixed tag, no renotify (Recommended) | `tag: 'train-reminder'`, `renotify: false`. Backlog collapses to one; today's replaces a stale one without re-buzzing. | ✓ |
| No tag | Each push independent. Leaves a notification that can't be programmatically replaced later. | |

**User's choice:** Fixed tag, no renotify

---

## Scheduler placement & dev testing

### Where does the reminder job run?

| Option | Description | Selected |
|--------|-------------|----------|
| asyncio.create_task in the lifespan (Recommended) | Beside `run_periodic_guest_cleanup` at `app/main.py:120`, mirroring `guest_cleanup_service`'s shape. Single uvicorn process in prod. | ✓ |
| Host cron calling a script | Decoupled and hand-triggerable, but a deploy-time artifact outside the docker-compose story plus a DB connection per invocation. | |
| Separate worker container | Cleanest isolation, overkill for 96 wake-ups a day on a box with OOM history. | |

**User's choice:** asyncio.create_task in the lifespan

### Claim-then-send, or send-then-mark?

| Option | Description | Selected |
|--------|-------------|----------|
| Claim first, then send (Recommended) | Conditional UPDATE committed before the POST. Double-send structurally impossible; a failed send loses the day. | ✓ |
| Send first, then mark | Better delivery, but double-sends on a crash between POST and commit and reintroduces retry semantics. | |

**User's choice:** Claim first, then send

### How is REMIND-08 (trigger a reminder on demand in dev) satisfied?

| Option | Description | Selected |
|--------|-------------|----------|
| Dev-only POST endpoint (Recommended) | Gated on `ENVIRONMENT == "development"`, the `dev_clock.py` pattern. Fireable from the device receiving the notification. | ✓ |
| scripts/ one-shot | No route surface at all, but needs a shell with DB access. | |
| Both | Endpoint plus script, small duplication if both call the same service function. | |

**User's choice:** Dev-only POST endpoint

### How does the tick select candidates across timezones?

| Option | Description | Selected |
|--------|-------------|----------|
| SQL narrows, Python decides the hour (Recommended) | SQL filters enabled + subscribed + not-sent-today; `zoneinfo` via `train_scheduler.local_today` does the hour. One source of truth for timezone semantics. | ✓ |
| Full SQL-side filter | Scales better, but duplicates timezone semantics across Postgres tzdata and Python `zoneinfo`. | |

**User's choice:** SQL narrows, Python decides the hour

### Does Phase 201 also expose `reminder_enabled` / `reminder_hour` through the Train settings API?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — columns + API fields here, UI in 202 (Recommended) | 202 stays purely frontend; 201 is independently testable with curl. | ✓ |
| Columns only — API fields in 202 | Keeps 201 strictly "no user-facing surface", but makes 202 a mixed phase and leaves 201's columns unreachable. | |

**User's choice:** Yes — columns + API fields here, UI in 202

---

## Claude's Discretion

- The exact web-push package behind D-01, and whether `cryptography` becomes an explicit dependency.
- `push_subscriptions` schema details beyond the PUSH-01 shape (endpoint uniqueness, `p256dh`/`auth` storage, optional user-agent label).
- Exact notification title/body wording around the day number, and the icon/badge assets.
- Test strategy for the send path without hitting real push services.
- The `push-sw.js` build/asset path.

## Deferred Ideas

- Per-subscription `last_seen_at` / device labelling (would enable the rejected most-recently-active fan-out, and a "your devices" list).
- A `push_reminder_sends` send-history/audit table.
- Delivery retry semantics (retry on the next tick until the local day ends).
- SEED-132 Phase B — install promotion, QR handoff, Android `beforeinstallprompt`, iOS push (BrowserStack dependency).
- Any notification type beyond the Train reminder.
