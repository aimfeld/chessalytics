# Phase 204: Push Reminder Delivery Reliability - Context

**Gathered:** 2026-08-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Make a Train push reminder that fails to arrive recoverable and visible. Four
independent fixes from SEED-135:

- **D2 (frontend)** — a device holding a live `PushSubscription` that the server
  pruned re-registers itself without user action and without touching the
  one-shot notification permission.
- **D5 (backend)** — `TTL: 0` stops discarding messages the instant a phone is
  unreachable; retention is bounded by the same end-of-local-day rule D-08
  already applies to the scheduler.
- **D4 (frontend)** — `ensureDeviceSubscribed`'s `existing ??` starts comparing
  `applicationServerKey` against the current VAPID key, so a rotation cannot
  leave devices permanently holding a dead subscription that even a manual
  toggle can't repair. Plus a written rotation runbook.
- **D3 (backend)** — the day's reminder claim is released when the fan-out
  delivered to nobody, so D2's re-sync can actually produce a same-day reminder.

Backend + frontend, no migration expected.

**Out of scope** (from ROADMAP.md § Phase 204 Non-goals, unchanged):
retries on transient send failure (D-04 stands); releasing the claim on a
*partial* failure; distinguishing "Chrome dropped it" from "user revoked
permission" server-side; Sentry alert rules on push health; any new push metric
or client-side delivery ack.

**D1 (the silent prune) is already fixed** by quick task `260803-nio`
(commit `e63c3b7a1`) and is not part of this phase.

</domain>

<decisions>
## Implementation Decisions

**The user's answer to "which areas do you want to discuss" was "You decide".**
Every decision below is therefore Claude's call, made against the already-locked
Phase 201/202 decisions and the code as it stands, with the reasoning stated so
it can be overridden before or during planning. **D-04 below is the one most
worth a second look** — it deliberately narrows a ROADMAP success criterion.

### D5 — push-service retention (TTL)

- **D-01: TTL is the remaining seconds in the user's local day**, computed from
  the same `row.timezone` the tick already resolves, not a flat few hours.
  Rationale: this is not cosmetic consistency with D-08 — it is load-bearing.
  A flat 4–6h TTL sent at 21:00 can deliver at 02:00 the next morning, and on a
  scheduled day the user then also receives *tomorrow's* reminder; D-14's tag
  collapses a backlog but does not stop a stale message arriving alone on a day
  it was not meant for. Bounding at local-day end is exactly the invariant the
  scheduler already claims to hold.
  - No floor and no cap. A tick at 23:52 yields a ~480s TTL, and that is
    correct: a reminder that cannot be delivered before the day ends *should*
    expire. The degenerate near-midnight case reproduces TTL 0 by design.
  - Compute as "today at 23:59:59 in the user's tz, minus now" rather than
    "next local midnight". Midnight is a nonexistent local time in a few zones
    with midnight DST transitions (Cuba, historically Brazil); 23:59:59 always
    exists. `zoneinfo` will not raise either way, but the arithmetic is only
    obviously correct with the end-of-today form.

- **D-02: thread `ttl_seconds` as a keyword-only, defaulted parameter** through
  `push_send.send_to_user` → `send_to_subscription`, exactly the way
  `subscription_id` was threaded for D1. ~15 existing tests call
  `send_to_subscription` with the pre-D1 signature and must keep working.
  Only `train_reminder_service._process_candidate` passes a real value; the
  dev-trigger endpoint (`POST /api/push/dev/trigger-reminder`) takes the
  default. Pick a module default that is *not* 0 so no future caller silently
  reintroduces the bug.

- **D-03: the seconds-until-end-of-local-day helper lives in `app/services/train_scheduler.py`**,
  beside `local_today` / `local_hour`.
  That module is already the single source of truth for "what day and hour is
  it for this user" (D-16); a second place doing tz arithmetic is exactly the
  drift D-16 exists to prevent.

### D4 — VAPID key mismatch

- **D-04: the key comparison and the `unsubscribe()` + re-`subscribe()` repair live ONLY in `ensureDeviceSubscribed` (the gesture path).**
  **The passive D2 re-sync path never repairs a mismatch — it detects one and
  does nothing.**

  This **narrows ROADMAP success criterion 4** ("a VAPID public-key change
  causes devices to detect the mismatch and re-subscribe") to "…on the user's
  next reminder-related gesture". The planner must reconcile the criterion's
  wording; do not silently satisfy it with a passive-path `subscribe()`.

  Reasoning, and why it is not a cop-out: the actual bug in `existing ??` is
  that it makes the *gesture* path unable to recover either — after a rotation,
  toggling reminders off and on reuses the same dead subscription forever.
  Fixing the comparison restores manual recovery, which is the only recovery
  D-02 (Phase 201, LOCKED: "rotation is accepted mass invalidation, rotate only
  on key compromise, and truncate `push_subscriptions` when you do") ever
  promised. Phase 201 explicitly *rejected* a public-key-mismatch self-heal as
  real machinery for an event that may never happen; adding it back on a
  passive path re-opens a settled decision on a hypothetical.

  Worth recording for whoever revisits this: `PushManager.subscribe()` does
  **not** prompt when `Notification.permission === 'granted'` — it only prompts
  (or throws) when permission is `default`/`denied`. So a passive-path repair
  guarded on `permission === 'granted'` would *not* actually endanger the
  one-shot resource. That carve-out is available if the rotation story ever
  needs it; it is declined here on the D-02 grounds above, not on PERM-01
  grounds.

- **D-05: on mismatch the passive re-sync skips the re-POST entirely** — it
  does not POST the dead subscription, and it does not call `unsubscribe()`
  either. Posting a known-dead endpoint just parks a row the server will 403
  against forever. Calling `unsubscribe()` would be free of permission cost but
  destroys a working subscription on any false positive in an `ArrayBuffer`
  comparison; the passive path stays read-only plus one idempotent POST.

- **D-06: the rotation runbook is written down** as part of this phase
  (criterion 4's second half). Content: rotate only on key compromise; after
  rotating, `TRUNCATE push_subscriptions`; devices re-subscribe on their next
  reminder gesture (score-screen button, Settings toggle, or resurface banner);
  `reminder_enabled` is left alone, so the UI will over-promise until each
  device is touched. Location is Claude's discretion (see below).

### D2 — device re-sync after a server-side prune

- **D-07: a new dedicated hook (`useDevicePushResync` or similar), mounted app-wide in `App.tsx`'s `ProtectedLayout`**
  beside the existing
  `useReminderResurfaceRedirect({ enabled: profile != null && !profile.is_guest })`
  call at `App.tsx:558`, using the same guest gate.
  Not Train-page-only: the user who has gone dark is precisely the user who has
  stopped visiting Train, so gating the repair on a Train visit gates it on the
  behavior the reminder exists to produce.
  Not folded into `useReminderResurface`: that hook is the iOS
  install→reminder resurface decision (OFFER-05/D-16) and conflating two
  unrelated triggers in one predicate makes both harder to test. It does show
  the exact shape to copy — `getDeviceSubscription()` + `useTrainSettings()`,
  fail-safe on every unresolved signal.

- **D-08: fire condition** — all of: not a guest, `settings.reminder_enabled`
  is `true`, `getDeviceSubscription()` resolved to a **non-null** subscription,
  and (per D-04) its `applicationServerKey` matches the current VAPID key.
  Any unresolved or thrown signal means do nothing, mirroring
  `useReminderResurface`'s fail-safe construction.

- **D-09: cadence is once per app load**, enforced by a module-scoped guard so
  a remount or a route change cannot re-fire it. Not a `localStorage`
  timestamp throttle: that adds a fourth push-related storage key with its own
  lifetime question (there are already three — see
  `TRAIN_RESURFACE_DISMISSED_KEY`'s comment) to save at most one 201 POST per
  app load at ~50 users/day.

- **D-10: the re-sync is a blind idempotent re-POST to the existing `POST /api/push/subscribe`.**
  No new endpoint and no "does the server have
  this endpoint?" probe — `upsert_subscription` is already
  `ON CONFLICT DO UPDATE` on `endpoint`, and a probe would be a second
  round-trip that answers a question the POST already settles.

- **D-11: it lives in `push.ts` as a new exported function** (e.g.
  `resyncExistingSubscription`), NOT by calling `ensureDeviceSubscribed`.
  PERM-01 keeps `push.ts` as the single call site for the one-shot resource;
  this function's contract is that it touches neither
  `Notification.requestPermission()` nor `PushManager.subscribe()`. Extract the
  shared `PushSubscribeRequest` body-building + `pushApi.subscribe()` tail so
  the two paths cannot drift on the `json.endpoint === undefined` /
  `keys?.p256dh ?? ''` handling.

- **D-12: a prune does NOT flip `reminder_enabled` to `false`.** (ROADMAP
  plan-time decision 3, settled explicitly as it asked.) Flipping it is more
  honest for exactly as long as it takes the user to notice, and it discards
  real user intent over what was, in the incident that planted SEED-135, a
  one-off device-side hiccup — then charges the user a trip through Settings to
  undo. D-07's re-sync makes the desync self-heal, which is strictly better
  than making the lie honest. No backend change on the prune path beyond what
  D1 already shipped.
  — **Reversibility:** reversible — a one-line change on the prune path if the
  self-heal proves unreliable in production.

### D3 — the day's claim on a total non-delivery

- **D-13: release the claim when, and only when, the fan-out delivered to nobody** — `attempted == 0 or attempted == pruned`.
  The partial-failure case stays untouched, per the seed and the ROADMAP
  non-goals.

  Why this does not violate D-07's invariant: D-07 exists so that a double-send
  is *structurally* impossible. 404/410 are terminal "this endpoint does not
  exist" statuses (RFC 8030 §7) — the message was demonstrably not delivered to
  a pruned endpoint, so releasing the claim cannot produce a second delivery of
  a first one that never happened. A crash mid-fan-out still leaves the claim
  standing, because the release only runs after the fan-out returns.

  Composition matters: this is what makes D2 pay off *today* rather than
  tomorrow. Prune at 16:05 → user opens the app at 18:00 → re-sync re-registers
  → the 18:15 tick sends. Without the release, D2's repair produces nothing
  until the next scheduled day.

- **D-14 — the release is a conditional UPDATE guarded on `reminder_last_sent_on = :today`**,
  in `train_reminder_repository` beside
  `claim_reminder_day`. Guarding it means the release can only ever un-claim
  the day *this tick* claimed, never a later claim by another ticker — the
  invariant stays structural rather than resting on "there is only one
  process". Mirror `claim_reminder_day`'s `RETURNING` shape so tests can assert
  on the row count.

- **D-15: `failed` does NOT trigger the release**, only `pruned`. A
  `PushFanoutResult.failed` is a construction/encryption exception, which also
  means nothing reached the network — so including it would be defensible — but
  the seed's condition is deliberately narrow and a wider predicate is harder
  to reason about at 3am. Recorded as a deferred variant, not a gap.

### Evidence ordering

- **D-16: D5 lands in this phase, and no new push metric, Sentry alert rule, or client-side delivery ack lands with it.**
  (ROADMAP plan-time decision 4.)
  While `TTL: 0` stands, a discarded message and a real delivery are
  byte-identical server-side (both 201, both increment `sent`), so any metric
  built now would be measuring something it cannot name. After D-01, `sent`
  means "the push service accepted it and will hold it until end of local day",
  which is a claim worth counting. Alerting is explicitly a later decision.

### Claude's Discretion

- Exact names: the re-sync hook, `push.ts`'s new export, the extracted
  body-builder, and the `train_scheduler` TTL helper.
- Where the D-06 rotation runbook lives — `CLAUDE.md` § Production Server, a
  `docs/` file, or a module docstring in `push_send.py`. Pick whichever the
  repo already uses for operational procedures; the D-02 note it extends
  currently lives only in `201-CONTEXT.md`, which is archived.
- The module default value for D-02's `ttl_seconds`.
- How the `applicationServerKey` comparison is performed (`ArrayBuffer` →
  `Uint8Array` byte compare vs base64url round-trip) and where the helper sits.
- Test strategy for the TTL header and the re-sync path (no real push service).
- Whether the `attempted == 0` half of D-13 is reachable in practice —
  `list_reminder_candidate_user_ids` already requires a live subscription, so
  it only fires on a delete racing the scan. Keep it in the predicate
  regardless; it costs nothing.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase source of truth
- `.planning/seeds/SEED-135-push-subscription-prune-is-silent-and-unrecoverable.md` —
  the incident timeline, the D1–D5 defect analysis, the open questions, and the
  explicit "D3 is a decision, not a fix" warning. Read this first; the
  decisions above are layered on it.
- `.planning/ROADMAP.md` § "Phase 204: Push Reminder Delivery Reliability" —
  goal, scope, the six success criteria, the four named plan-time decisions,
  and the non-goals. **Note D-04 above narrows criterion 4's wording.**

### Locked decisions this phase must not violate
- `.planning/milestones/v2.11-phases/201-push-infrastructure-train-reminders/201-CONTEXT.md` —
  D-02 (rotation = accepted mass invalidation; the self-heal was rejected),
  D-04 (no retry), D-05 (fan out to all), D-07 (claim before send), D-08
  (catch up until end of local day), D-14 (fixed tag + `renotify: false`),
  D-16 (SQL narrows, Python decides the hour).
- `.planning/milestones/v2.11-phases/202-reminder-permission-ux/202-CONTEXT.md` —
  D-06/D-11/D-13 and the PERM-01 framing: `push.ts` is the single call site for
  the one-shot permission, and the three gesture entry points
  (`TrainReminderButton`, `TrainScheduleSettings`, `TrainReminderResurfaceBanner`)
  are the only callers of `ensureDeviceSubscribed`.
- `.planning/REQUIREMENTS.md` (v2.11 set archived at
  `.planning/milestones/v2.11-REQUIREMENTS.md`) — PUSH-01..06, REMIND-01..08,
  PERM-01..04 verbatim.

### Project constraints
- `CLAUDE.md` § Critical Constraints — `httpx.AsyncClient` only; never
  `asyncio.gather` on one `AsyncSession` (the fan-out loop is sequential for
  this reason).
- `CLAUDE.md` § Error Handling & Sentry — capture in non-trivial service/router
  `except` blocks; never embed variables in Sentry *message* strings; the push
  endpoint is a bearer capability and must never reach a log record or a Sentry
  payload.
- `CLAUDE.md` § Frontend → Browser Automation Rules — `data-testid` on any new
  interactive element (this phase expects none).
- `CLAUDE.md` § Coding Guidelines — mutation-testing expectation restated by
  ROADMAP criterion 6: prove each production change by reverting it and
  confirming the test goes red, never by symbol presence.

### External specs
- RFC 8030 §5.2 (TTL header semantics) and §7 (404/410 as terminal statuses) —
  the basis for D-01 and D-13's safety argument.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `app/services/train_scheduler.py:103` `local_today` / `:132` `local_hour` —
  the single source of truth for per-user date/hour. D-03's TTL helper joins
  them here.
- `app/repositories/train_reminder_repository.py` `claim_reminder_day` — the
  conditional-UPDATE-with-`RETURNING` shape D-14's release mirrors.
- `frontend/src/hooks/useReminderResurface.ts` — the fail-safe probe pattern to
  copy for D-07/D-08: `getDeviceSubscription()` + `useTrainSettings()`, an
  `enabled` guest gate threaded from the caller, `null` meaning "unresolved"
  and never collapsing to a qualifying value, a `cancelled` flag in the effect
  cleanup, and a `.catch()` backstop even though the probe already swallows.
- `frontend/src/lib/push.ts:82` `getDeviceSubscription` — already the only
  "is this device reachable?" mechanism, already permission-free. D-11's new
  function sits beside it.
- `frontend/src/lib/push.ts:64` `urlBase64ToUint8Array` — produces the same
  bytes `applicationServerKey` was created from, so D-04's comparison has its
  reference value already.

### Established Patterns
- `push_send.send_to_subscription`'s `subscription_id` parameter (SEED-135 D1)
  — keyword-only + defaulted specifically because ~15 tests call the function
  directly with the older signature. D-02's `ttl_seconds` follows it exactly.
- `train_reminder_service._process_candidate`'s step order is load-bearing and
  documented in the module docstring; D-13's release is a **new step 8**, after
  the fan-out returns. Do not reorder steps 1–7.
- Repositories hold SQL, services hold logic, routers stay thin.
- `App.tsx:558` — the app-wide-hook-with-guest-gate pattern D-07 copies.

### Integration Points
- `app/services/push_send.py:56` `_PUSH_TTL_SECONDS = 0` — the D5 defect site;
  becomes the module default of D-02's parameter.
- `app/services/train_reminder_service.py:180` — the `send_to_user` call that
  gains the TTL argument, and the point after which D-13's release runs.
- `app/routers/push.py` `dev_trigger_reminder` — the second `send_to_user`
  caller; takes the TTL default and needs no signature change.
- `frontend/src/App.tsx` `ProtectedLayout` — where D-07's hook mounts.
- `frontend/src/api/client.ts:299` `pushApi` — `subscribe` already exists and
  is all D-10 needs; no new client method.

</code_context>

<specifics>
## Specific Ideas

- The user's whole answer was "You decide" — there are no user-supplied
  specifics for this phase. Every judgement call above is Claude's and is open
  to override at planning time.
- The single decision most worth revisiting is **D-04**: it deliberately
  narrows ROADMAP success criterion 4 from "devices detect a VAPID mismatch and
  re-subscribe" to "…on the user's next reminder gesture", on the grounds that
  Phase 201's D-02 already locked rotation as accepted mass invalidation. The
  technical escape hatch (a passive repair guarded on
  `Notification.permission === 'granted'`, which provably cannot spend the
  one-shot permission) is documented in D-04 so reversing this costs no
  re-research.

</specifics>

<deferred>
## Deferred Ideas

- **Passive-path VAPID repair** — the `permission === 'granted'`-guarded
  `unsubscribe()` + re-`subscribe()` on a mismatch, declined in D-04. Revisit
  only if a real key rotation is ever planned.
- **Releasing the claim on `failed`** (construction/encryption errors) as well
  as `pruned` — the wider D-15 predicate. Defensible, deliberately not taken.
- **Client-side delivery ack** — a service-worker `push` handler POST that
  proves a notification was actually shown. The only thing that would make
  "sent" verifiable end-to-end. Out of scope per D-16 and the ROADMAP
  non-goals; D-01 is its prerequisite either way.
- **Push-health metrics and a Sentry alert rule on `source=push_send`** —
  explicitly gated behind D5 landing (SEED-135's fourth open question). Nobody
  is watching push health today even after D1.
- **Distinguishing "Chrome dropped the subscription" from "user revoked
  permission"** — both surface as 410 server-side but want opposite UX
  (silently re-register vs. stop nagging). Noted in the seed as an open
  question, not a deliverable.
- **Per-subscription `last_seen_at` / device labelling** — carried over unmet
  from 201-CONTEXT's deferred list; would also make a prune attributable to a
  specific device.

### Reviewed Todos (not folded)
`gsd-tools query todo.match-phase 204` returned three matches — the WR-01
Tailwind score-axis label (0.9), `172-deferred-review-findings` (0.6), and the
bitboard-storage note (0.6). All scored on generic keywords ("source",
"frontend", "app", "users") with no relation to push, notifications, or the
reminder scheduler. The same three matched Phase 201 and were declined then for
the same reason. None folded.

</deferred>

---

*Phase: 204-push-reminder-delivery-reliability*
*Context gathered: 2026-08-03*
