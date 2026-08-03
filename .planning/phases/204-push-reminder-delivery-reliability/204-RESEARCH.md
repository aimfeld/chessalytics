# Phase 204: Push Reminder Delivery Reliability - Research

**Researched:** 2026-08-03
**Domain:** Web Push reliability (RFC 8030 TTL semantics), VAPID key-mismatch detection, PostgreSQL conditional-claim release, React app-wide resync hook
**Confidence:** HIGH — every code claim below was read from the file this session; the only `[ASSUMED]`/`[CITED]` items are RFC/MDN semantics and one CONTEXT.md count that this research corrects.

## Summary

This phase is pure plumbing over code that already exists and already works end to end (Phase 201/202 shipped, verified in production incident SEED-135). There are no new packages, no new endpoints, no schema migration. The four fixes are: (1) thread a keyword-only `ttl_seconds` parameter through `push_send.send_to_subscription`/`send_to_user`, computed by a new `train_scheduler` helper as "seconds until 23:59:59 local today"; (2) add a passive VAPID-key-mismatch **detector** (not repairer — CONTEXT.md D-04/D-05 already settled this) inside `ensureDeviceSubscribed`; (3) add a new module-scoped-guarded React hook mounted in `ProtectedLayout` that blindly re-POSTs an existing device subscription through a new `push.ts` export; (4) add a conditional claim-release UPDATE in `train_reminder_repository`, called from `_process_candidate` as a new step 8 when `PushFanoutResult.attempted == 0 or attempted == pruned`.

Every integration point CONTEXT.md names checks out against the actual file, with one correction: the "~15 existing tests call `send_to_subscription`" claim is off — the actual count is **10** (`tests/test_push_send.py`), all calling with only `client, endpoint=, p256dh=, auth=, payload=` (no `subscription_id` kwarg, relying entirely on its default). Adding a second keyword-only defaulted `ttl_seconds` parameter is exactly as safe as D1's `subscription_id` addition was — verified by reading the actual call sites, not by trusting the count.

**Primary recommendation:** Do the backend TTL/claim-release work and the frontend detector/resync work as two independent plans (they share no files) — `app/services/push_send.py` + `app/services/train_scheduler.py` + `app/repositories/train_reminder_repository.py` + `app/services/train_reminder_service.py` on one side, `frontend/src/lib/push.ts` + a new `frontend/src/hooks/useDevicePushResync.ts` + `frontend/src/App.tsx` on the other. Write the rotation runbook as a third, trivial task (a docstring addition, no code).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| TTL computation (D-01/D-02/D-03) | API / Backend | — | Pure server-side value threaded into an outbound HTTP header; no client involvement |
| Claim release on total non-delivery (D-13/D-14/D-15) | API / Backend (repository) | — | `train_reminder_repository` already owns the claim; the release is a sibling conditional UPDATE in the same module |
| Device re-sync after server-side prune (D-07..D-12) | Browser / Client | API / Backend (existing endpoint, unchanged) | Detection of "my subscription differs from server state" can only happen where the live `PushSubscription` object lives — the browser. The backend contributes nothing new (idempotent `upsert_subscription` already exists) |
| VAPID key-mismatch detection (D-04/D-05) | Browser / Client | — | `applicationServerKey` is a browser-only object on the live `PushSubscription`; the backend has no way to inspect a client's cached key |
| Rotation runbook (D-06) | Docs (not a runtime tier) | — | Operational procedure, no code |

## User Constraints (from CONTEXT.md)

<user_constraints>

### Locked Decisions

All of D-01 through D-18 in `204-CONTEXT.md` are locked implementation decisions made by Claude under "you decide" — restated here verbatim by reference rather than duplicated (the full text is 350+ lines; see `.planning/phases/204-push-reminder-delivery-reliability/204-CONTEXT.md` sections D5/D4/D2/D3). The load-bearing ones for planning:

- **D-01/D-02/D-03 (TTL):** TTL = seconds remaining until 23:59:59 in the user's local day (not "next midnight" — DST-midnight-nonexistent zones). No floor, no cap. Threaded as a keyword-only defaulted parameter through `send_to_user` → `send_to_subscription`, mirroring D1's `subscription_id` pattern exactly. The helper lives in `train_scheduler.py` beside `local_today`/`local_hour`. Module default must NOT be 0.
- **D-04/D-05 (VAPID mismatch):** Comparison + repair (`unsubscribe()` + re-`subscribe()`) live ONLY in `ensureDeviceSubscribed` (the gesture path). The passive D2 re-sync path detects a mismatch and does **nothing** — no re-POST, no `unsubscribe()`. This deliberately narrows ROADMAP success criterion 4 to "...on the user's next reminder-related gesture." The planner must reconcile the wording, not silently satisfy it with a passive `subscribe()`.
- **D-06:** A rotation runbook is written down this phase. Location is Claude's discretion.
- **D-07..D-12 (device re-sync):** A new hook (`useDevicePushResync` or similar) mounted in `App.tsx`'s `ProtectedLayout` beside the existing `useReminderResurfaceRedirect` call, same guest gate. Fire condition: not guest, `reminder_enabled === true`, `getDeviceSubscription()` resolved non-null, its `applicationServerKey` matches current VAPID key. Cadence: once per app load via a **module-scoped guard** (not a ref, not localStorage). Mechanism: blind idempotent re-POST to existing `POST /api/push/subscribe`, no probe, no new endpoint. Lives in `push.ts` as a new exported function (e.g. `resyncExistingSubscription`), NOT via `ensureDeviceSubscribed` — must never call `Notification.requestPermission()` or `PushManager.subscribe()`.
- **D-12:** A prune does NOT flip `reminder_enabled` to false. No backend change on the prune path beyond D1.
- **D-13/D-14/D-15 (claim release):** Release the day's claim when, and only when, `attempted == 0 or attempted == pruned`. Guarded UPDATE on `reminder_last_sent_on = :today`, in `train_reminder_repository` beside `claim_reminder_day`, mirroring its `RETURNING` shape. `failed` (construction/encryption exceptions) does NOT trigger release — only `pruned`.
- **D-16:** No new push metric, Sentry alert rule, or client-side delivery ack lands with this phase.

### Claude's Discretion

- Exact names: the re-sync hook, `push.ts`'s new export, the extracted body-builder, the `train_scheduler` TTL helper.
- Rotation runbook location (`CLAUDE.md` § Production Server, a `docs/` file, or a `push_send.py` module docstring).
- The module default value for `ttl_seconds`.
- `applicationServerKey` comparison mechanism (byte compare vs base64url round-trip) and where the helper sits.
- Test strategy for the TTL header and the re-sync path.
- Whether `attempted == 0` (as opposed to only `attempted == pruned`) is reachable in practice — keep it in the predicate regardless, it costs nothing.

### Deferred Ideas (OUT OF SCOPE)

- Passive-path VAPID repair (the `permission === 'granted'`-guarded `unsubscribe()` + re-`subscribe()`) — declined in D-04, revisit only if a real key rotation is planned.
- Releasing the claim on `failed` as well as `pruned` (the wider D-15 predicate) — defensible, deliberately not taken.
- Client-side delivery ack (service-worker `push` handler POST proving a notification was shown) — out of scope per D-16.
- Push-health metrics / Sentry alert rule on `source=push_send` — gated behind D5 landing, not built now.
- Distinguishing "Chrome dropped the subscription" from "user revoked permission" (both 410 server-side) — open question, not a deliverable.
- Per-subscription `last_seen_at` / device labelling — carried over from 201, unmet.

</user_constraints>

<phase_requirements>
## Phase Requirements

No new REQUIREMENTS.md IDs exist for this phase yet — the phase description states "Phase requirement IDs (MUST address): TBD (derive at planning; source is SEED-135 defects D2, D3, D4, D5)". The planner must mint phase-scoped IDs (e.g. `PUSHREL-01..0N`) at plan time and register them in REQUIREMENTS.md. Suggested mapping from the six ROADMAP success criteria to this research's findings:

| Suggested ID (planner to confirm) | Description (from ROADMAP success criteria) | Research Support |
|----|-------------|------------------|
| PUSHREL-01 | A pruned device re-registers on app load without user action, and a reminder scheduled after that point arrives | `useDevicePushResync` design (Code Examples §3), `App.tsx:558` mount site, `upsert_subscription`'s `ON CONFLICT DO UPDATE` (already exists, no backend change) |
| PUSHREL-02 | The re-sync path can never call `requestPermission()`/`subscribe()`; stays inside `push.ts` as the single call site | `resyncExistingSubscription` design (Code Examples §3) — reads `getDeviceSubscription()` only, never touches the two gated APIs |
| PUSHREL-03 | A reminder sent while briefly unreachable is still delivered on wake, bounded by the chosen TTL; D-14's tag still collapses backlog to one notification | TTL helper design (Code Examples §1), RFC 8030 §5.2 semantics (Sources), existing `REMINDER_NOTIFICATION_TAG`/`renotify: False` in `train_reminder_service.py:82-83` (unchanged) |
| PUSHREL-04 | A VAPID key change causes devices to detect the mismatch (narrowed: repair only on next gesture); rotation procedure documented | `applicationServerKey` comparison design (Code Examples §2), rotation runbook (Common Pitfalls §5) |
| PUSHREL-05 | D3 decision recorded with reasoning; D-07 double-send invariant demonstrably still holds | Claim-release design (Code Examples §4), D-07 argument already fully reasoned in CONTEXT.md D-13 |
| PUSHREL-06 | Desync-and-recover path covered end to end; each production change mutation-tested | Validation Architecture section below |

</phase_requirements>

## Standard Stack

No new libraries. Every piece of this phase is additive logic over already-vendored code:

| Component | Location | Status |
|---|---|---|
| `httpx.AsyncClient` (push POST) | `app/services/push_send.py:32,86-93` | Existing, unchanged |
| `zoneinfo` (stdlib) | `app/services/train_scheduler.py:35` | Existing import, reused for the new TTL helper |
| `push_crypto` (vendored `webpush-py` MIT, ~110 LOC) | `app/services/push_crypto.py` | Existing, unchanged — no new crypto for D-04 (the comparison is a plain byte compare, not a new signing/encryption primitive) |
| Browser `PushManager`/`Notification` APIs | `frontend/src/lib/push.ts` | Existing, unchanged surface, extended with 2 new/refactored functions |

**Installation:** none — no `uv add` / `npm install` needed for this phase.

## Package Legitimacy Audit

**Not applicable.** This phase introduces no new backend or frontend package dependencies — it is entirely new logic over `httpx`, `zoneinfo` (stdlib), the already-vendored `push_crypto` module, and existing browser Web APIs. The Package Legitimacy Gate is skipped per its own trigger condition ("Every phase that installs external packages").

## Architecture Patterns

### System Architecture Diagram

```
                    ┌─────────────────────────────────────────────┐
                    │  Backend: reminder tick (every 15 min)       │
                    │  app/services/train_reminder_service.py      │
                    └───────────────┬───────────────────────────────┘
                                    │ _process_candidate() step order:
                                    │ 1 scheduled-day gate
                                    │ 2 local-hour gate (D-08, no upper bound)
                                    │ 3 cheap reminder_last_sent_on pre-filter
                                    │ 4 settle_streak_snapshot + commit
                                    │ 5 has_completed_session_on gate
                                    │ 6 claim_reminder_day + commit  ◄── D-07: commit BEFORE send
                                    │ 7 push_send.send_to_user(payload, ttl_seconds=…) ◄── D-01/D-02 NEW ARG
                                    │ 8 [NEW] if attempted==0 or attempted==pruned:
                                    │      release_reminder_claim(user_id, today)   ◄── D-13/D-14/D-15
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │  push_send.send_to_user()                    │
                    │  fan-out over list_subscriptions(user_id)     │
                    │  per-subscription: encrypt (aes128gcm) →      │
                    │  POST endpoint, headers incl. ttl=<computed>  │◄── D-01 NEW: was hardcoded 0
                    │  404/410 → delete row (pruned++)              │
                    │  other non-2xx → log+capture, leave (failed++)│
                    └───────────────┬───────────────────────────────┘
                                    │ 404/410 (real prune, e.g. Chrome invalidated it)
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │  Browser: NEXT app load (any protected route) │
                    │  App.tsx ProtectedLayout                      │
                    │  useDevicePushResync({ enabled: !guest })     │◄── NEW HOOK (D-07..D-12)
                    │    fire when: reminder_enabled && live         │
                    │    device subscription && key matches VAPID   │
                    │    (module-scoped once-per-load guard)        │
                    └───────────────┬───────────────────────────────┘
                                    │ resyncExistingSubscription(existingSubscription)
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │  push.ts (single call site, PERM-01)          │
                    │  resyncExistingSubscription() — NEVER calls   │
                    │  requestPermission()/subscribe() — blind      │
                    │  idempotent re-POST via pushApi.subscribe()   │
                    └───────────────┬───────────────────────────────┘
                                    │ POST /push/subscribe (existing endpoint, unchanged)
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │  upsert_subscription() ON CONFLICT DO UPDATE  │
                    │  push_repository.py:62-83 — row restored      │
                    └─────────────────────────────────────────────┘
                                    │
                                    ▼
                    Next 15-min tick's candidate scan finds the row again
                    → same-day reminder possible IF the claim was released (step 8)
```

### Recommended Project Structure

No new files at the directory level — everything is additions to existing modules, plus exactly one new frontend hook file:

```
app/
├── services/
│   ├── push_send.py              # + ttl_seconds param (D-01/D-02)
│   ├── train_scheduler.py        # + seconds_until_end_of_local_day() (D-03)
│   └── train_reminder_service.py # + step 8 call to the new repo function
├── repositories/
│   └── train_reminder_repository.py  # + release_reminder_claim() (D-13/D-14/D-15)
frontend/src/
├── lib/
│   └── push.ts                   # + comparison helper (D-04) + resyncExistingSubscription (D-11) + extracted body-builder
├── hooks/
│   └── useDevicePushResync.ts    # NEW FILE — mirrors useReminderResurface.ts's shape
└── App.tsx                       # + one hook-mount line in ProtectedLayout, beside :558
```

### Pattern 1: Module-level default constants co-located with the CHECK constraint they mirror

**What:** `DEFAULT_REMINDER_HOUR` in `train_scheduler.py:98` is the single source of truth consumed by the model's `CheckConstraint`, `get_or_create_settings`, and the Pydantic `Field` bound — "so none of the three ever drifts."
**When to use:** The new TTL module default (`_PUSH_TTL_SECONDS`'s replacement) should follow the same one-constant-many-consumers shape, even though there is only one consumer here (`send_to_subscription`'s default arg) — name it clearly, e.g. `_DEFAULT_PUSH_TTL_SECONDS`, and comment why it must not be 0.
**Example:**
```python
# app/services/push_send.py — CURRENT (the D5 defect)
# Source: app/services/push_send.py:53-56 [VERIFIED: app/services/push_send.py:53-56]
# RFC 8030 TTL. 0 = deliver only if the device is reachable right now, never
# stored by the push service. A reminder is worthless once its hour has passed
# (D-04/D-08 already own lateness), so we do not ask for retention.
_PUSH_TTL_SECONDS = 0
```

### Pattern 2: Keyword-only defaulted parameter threading (the exact D1 precedent this phase repeats)

**What:** `subscription_id: int | None = None` was added to `send_to_subscription` in SEED-135 D1 specifically so ~10 (not ~15, see Landmines) pre-existing direct callers in `tests/test_push_send.py` keep compiling with no signature change on their end.
**When to use:** D-02's `ttl_seconds` parameter must follow this identically — keyword-only, defaulted, never required.
**Example:**
```python
# Source: app/services/push_send.py:96-119 [VERIFIED: app/services/push_send.py:96-104]
async def send_to_subscription(
    client: httpx.AsyncClient,
    *,
    endpoint: str,
    p256dh: str,
    auth: str,
    payload: dict[str, object],
    subscription_id: int | None = None,
    ttl_seconds: int = _DEFAULT_PUSH_TTL_SECONDS,  # NEW, D-02
) -> bool:
    ...
    headers = {
        "ttl": str(ttl_seconds),  # was: str(_PUSH_TTL_SECONDS)
        ...
    }
```

### Anti-Patterns to Avoid

- **Computing "next local midnight" instead of "23:59:59 today minus now":** CONTEXT.md D-01 explicitly rejects this — midnight is a nonexistent local time in a handful of zones with midnight DST transitions historically (Cuba, historically Brazil). `zoneinfo` will not raise on either form, but only the end-of-today form is obviously correct without a special case.
- **Adding a floor/cap to the TTL:** D-01 explicitly says no floor, no cap — a near-midnight tick producing a ~480s TTL (or less) is correct, not a bug to special-case.
- **Building a `push_reminder_sends` audit table or any new metric alongside D5:** explicitly rejected at the 201-D-06 level and reaffirmed by D-16 in this phase — `sent` only becomes a trustworthy count once TTL is fixed, and building a metric on top of that in the same phase is out of scope.
- **Calling `unsubscribe()` on a VAPID key mismatch in the passive path:** D-05 explicitly rejects this — a false-positive `ArrayBuffer` comparison would destroy a working subscription with no way back except the user manually re-toggling.
- **Reusing `ensureDeviceSubscribed` for the passive resync:** would risk spending the one-shot permission on app load with no user gesture — exactly what PERM-01 forbids. The new resync function must be structurally incapable of calling `Notification.requestPermission()` or `PushManager.subscribe()`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| VAPID JWT signing / aes128gcm encryption | New crypto code | `app/services/push_crypto.py` (already vendored, byte-tested against upstream) | Untouched by this phase — D-04's comparison is a plain byte/base64 equality check on a public key, not new cryptography |
| "Is this device's timezone the boundary of today" | Manual UTC arithmetic in `push_send.py` or `train_reminder_service.py` | `train_scheduler.local_today`/the new TTL helper | D-03 explicitly places the new helper beside `local_today`/`local_hour` — a second tz-arithmetic site is exactly the drift D-16 (201-CONTEXT) exists to prevent |
| ArrayBuffer equality | A hand-rolled loop with subtle off-by-one on `DataView` | `Uint8Array` + a straightforward index/length compare, or base64url round-trip through the SAME `urlBase64ToUint8Array` already in `push.ts:64-75` | The existing helper already turns the base64url VAPID key into the exact byte layout `applicationServerKey` holds (both are X9.62 uncompressed points — confirmed by reading `push_crypto.application_server_key_from_pem`, `app/services/push_crypto.py:159-162`) |

**Key insight:** every piece of machinery this phase needs (crypto, tz-day-boundary math, idempotent upsert, base64url decode) already exists in the codebase. The entire phase is wiring, not invention — which is also why it needs zero new dependencies and no research spike.

## Common Pitfalls

### Pitfall 1: Threading TTL through the WRONG layer

**What goes wrong:** Computing the TTL inside `push_send.send_to_user` (which has no `AsyncSession`-scoped access to the user's `timezone` without an extra query) instead of computing it once in `_process_candidate` (which already has `row.timezone` and `now_utc` in scope) and passing the already-computed value down.
**Why it happens:** `send_to_user`'s signature takes `session, user_id, payload` — it would be tempting to add a `tz_name` parameter and compute the TTL inside it, duplicating the local_today/local_hour input pattern.
**How to avoid:** Compute the TTL once in `_process_candidate` (which already resolves `today`/`hour` via `local_today`/`local_hour` at `train_reminder_service.py:130-131`) and pass the numeric `ttl_seconds` straight through `send_to_user` → `send_to_subscription`, exactly like `payload` is already passed. `send_to_user`'s signature gains one new keyword-only parameter, mirrored from `send_to_subscription`'s.
**Warning signs:** If `push_send.py` needs to import `train_scheduler` for anything beyond the constant it already needs, the TTL computation landed in the wrong layer.

### Pitfall 2: `applicationServerKey` is `null` when the existing subscription predates VAPID-key comparison being written

**What goes wrong:** Every "live" subscription this app has ever created went through `PushManager.subscribe({ applicationServerKey: ... })` (see `push.ts:143-148`), so `existing.options.applicationServerKey` should never legitimately be `null` in practice for this codebase. But `[CITED: MDN PushSubscriptionOptions.applicationServerKey]` documents it as `null` when a subscription was created *without* passing the option — a real state on some other site's subscription, not reachable from FlawChess's own code path, but defensive code should not crash if it ever sees `null` (e.g. a corrupted browser profile, or a future code path that forgets to pass the option).
**Why it happens:** `PushSubscriptionOptions.applicationServerKey` is typed `ArrayBuffer | null` in the DOM lib; a comparison helper that assumes non-null and calls `.byteLength` will throw.
**How to avoid:** Treat `null` (or a thrown property read) the same as "mismatch, or unknown" — do not treat it as "matches." Given D-05 already says "the passive path never repairs, only detects," a `null` key on the passive path should resolve to "cannot confirm match" → skip the re-POST for that signal in a fail-safe manner, consistent with `useReminderResurface`'s existing "any unresolved signal → do nothing" convention (`useReminderResurface.ts:11-15`).
**Warning signs:** A crash/exception surfacing from inside the new hook's effect on a device whose subscription was somehow created outside `ensureDeviceSubscribed`.

### Pitfall 3: `ProtectedLayout` does NOT remount on every route change — the module-scoped guard exists for a DIFFERENT remount case

**What goes wrong:** Assuming a `useRef(false)` guard inside the new hook is insufficient because "the user navigates around a lot" is not, by itself, the risk. `<Route element={<ProtectedLayout />}>` (`App.tsx:842`) is a **layout route** wrapping children via `<Outlet/>` — React Router does NOT remount the layout element when only the nested route changes (confirmed structurally: `useReminderResurfaceRedirect`'s existing `navigatedRef` — a plain per-mount `useRef` — already relies on this same layout-route non-remount behavior for its own once-per-mount guard, `useReminderResurface.ts:158-166`).
**Why it matters for D-09's design:** The real remount case is a full unmount/remount of `ProtectedLayout` itself — e.g. token clearing (line 604-606: `if (!token) return <Navigate to="/login" replace />` unmounts the whole subtree), then logging back in. A plain `useRef` guard resets on that remount; a **module-scoped** `let hasResyncedThisPageLoad = false` declared at the top of `useDevicePushResync.ts` (outside the hook function) survives it, because the JS module itself is not re-evaluated by a component remount — only a full page reload resets it.
**How to avoid:** Declare the guard variable at module scope in the new hook file, not inside the hook function body, and gate the resync effect on it exactly the way the file's docstring should explain (mirror the reasoning documented at `useReminderResurface.ts:37-56` for `TRAIN_RESURFACE_DISMISSED_KEY`, but note D-09 explicitly rejects a `localStorage` key here — "a fourth push-related storage key with its own lifetime question... to save at most one 201 POST per app load at ~50 users/day").
**Warning signs:** A test that mounts/unmounts `ProtectedLayout` twice within the same test file (simulating login→logout→login) and observes the resync firing twice would catch a `useRef`-only implementation; it would NOT catch a route-change-only regression, because that never remounts the layout in the first place.

### Pitfall 4: `attempted == pruned` predicate ordering — this must run AFTER `send_to_user` returns, never on an exception path

**What goes wrong:** Wrapping the new step 8 call in the SAME try/except that already surrounds `_process_candidate` inside `send_due_reminders` (`train_reminder_service.py:216-226`) would be structurally wrong if a developer later "helpfully" moves the release call into that outer handler — it must only run when `send_to_user` returns normally with `PushFanoutResult(attempted=N, pruned=N, failed=0)` (or `attempted=0`), never when an unexpected exception aborted the fan-out (a crash mid-fan-out leaves the claim standing, per D-13's own written-out D-07 argument).
**Why it happens:** The natural place to "clean up on failure" in this codebase's established isolation pattern (`_process_candidate` isolated by the caller's try/except) invites putting the release logic in the wrong catch block.
**How to avoid:** Add the release call as literally the next line after `result = await push_send.send_to_user(...)` inside `_process_candidate` (`train_reminder_service.py:180`), inside the SAME `async with async_session_maker() as session:` block, guarded by the `attempted == 0 or attempted == result.pruned` predicate — not in any exception handler.
**Warning signs:** A test that forces `send_to_user` to raise (rather than return a `PushFanoutResult`) and then asserts the claim was released would catch this if it ever passes — it must NOT pass; the claim should stay committed on a true crash.

### Pitfall 5: The rotation runbook must be written even though "Claude's discretion" makes it feel optional

**What goes wrong:** Because the runbook's *location* is discretionary, it is easy to treat the runbook itself as optional. It is not — ROADMAP success criterion 4's second half explicitly requires "the rotation procedure is written down," and 201-CONTEXT.md's D-02 operational note ("rotate only on key compromise, and truncate `push_subscriptions` when you do") currently lives ONLY in an archived `201-CONTEXT.md` file (`.planning/milestones/v2.11-phases/201-.../201-CONTEXT.md`), which is not discoverable by an operator mid-incident.
**How to avoid:** Recommend `app/services/push_send.py`'s module docstring (it already documents D-01..D-04's rationale at the top of the file, `push_send.py:1-23`) as the landing spot — it is the file an operator investigating a push outage will already be reading, and it is version-controlled (unlike `CLAUDE.md § Production Server`, which is a good secondary cross-reference but is a much longer file already crowded with unrelated operational notes).
**Warning signs:** A plan that marks D-06 "done" via a `.planning/` doc update alone, with no change to any file under `app/` or `docs/`, has satisfied the letter of "written down" only for planning-tool consumers, not for a future on-call engineer.

## Code Examples

### 1. TTL helper in `train_scheduler.py` (D-01/D-03)

```python
# NEW — app/services/train_scheduler.py, beside local_today/local_hour
# Design basis: [CITED: RFC 8030 §5.2] "the TTL header field contains a value
# in seconds that suggests how long a push message is retained... if the user
# agent is unavailable, a push message with a zero TTL expires and is never
# delivered." D-01: compute as "23:59:59 today minus now", not "next
# midnight" — a nonexistent local time in a handful of historical
# midnight-DST-transition zones; zoneinfo will not raise either way, but only
# the end-of-day form is obviously correct.
_END_OF_DAY_HOUR = 23
_END_OF_DAY_MINUTE = 59
_END_OF_DAY_SECOND = 59


def seconds_until_end_of_local_day(tz_name: str, now_utc: datetime.datetime) -> int:
    """Seconds remaining in the user's local calendar day (Phase 204, D-01/D-03).

    No floor, no cap, by design — a tick at 23:59:58 local yields ~1s, and
    that is correct: a reminder that cannot be delivered before the day ends
    should expire, reproducing TTL 0's old behavior only in that degenerate
    case. Shares local_today/local_hour's fallback shape: an unrecognised
    tz_name falls back to DEFAULT_TIMEZONE rather than raising.
    """
    try:
        zone = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo(DEFAULT_TIMEZONE)
    local_now = now_utc.astimezone(zone)
    end_of_day = local_now.replace(
        hour=_END_OF_DAY_HOUR, minute=_END_OF_DAY_MINUTE, second=_END_OF_DAY_SECOND, microsecond=0
    )
    return max(int((end_of_day - local_now).total_seconds()), 0)
```

`max(..., 0)` guards the (currently unreachable, since `local_now` is always `<= 23:59:59`) case where a future refactor moves `now_utc` past end-of-day before this is called — cheap insurance, not a floor on the intended range.

### 2. `applicationServerKey` comparison (D-04, frontend)

```typescript
// NEW — frontend/src/lib/push.ts
// [ASSUMED, byte-format confirmed via reading app/services/push_crypto.py:159-162]
// application_server_key_from_pem() returns the base64url X9.62 UNCOMPRESSED
// POINT — the exact byte layout PushSubscriptionOptions.applicationServerKey
// holds as an ArrayBuffer. urlBase64ToUint8Array (push.ts:64-75) already
// produces those same bytes from that same base64url string, so no new
// decoding logic is needed — only a byte-for-byte compare.

/** True only when `existing`'s applicationServerKey is a non-null ArrayBuffer
 * whose bytes match `currentVapidKey` exactly. `null` (a subscription created
 * without the option — [CITED: MDN PushSubscriptionOptions.applicationServerKey])
 * or a thrown property read both resolve to `false` ("cannot confirm match"),
 * per D-05's fail-safe convention — never treated as a match. */
export function subscriptionKeyMatches(
  existing: PushSubscription,
  currentVapidKey: string,
): boolean {
  try {
    const existingKey = existing.options.applicationServerKey;
    if (existingKey === null) return false;
    const existingBytes = new Uint8Array(existingKey);
    const expectedBytes = urlBase64ToUint8Array(currentVapidKey);
    if (existingBytes.length !== expectedBytes.length) return false;
    return existingBytes.every((byte, i) => byte === expectedBytes[i]);
  } catch {
    return false; // fail-safe: an unreadable key is never treated as a match
  }
}
```

`ensureDeviceSubscribed` (the gesture path, D-04's repair site) calls this to decide whether to reuse `existing` or fall through to `unsubscribe()` + `subscribe()`. `useDevicePushResync` (the passive path, D-05) calls the SAME function to decide whether the mismatch signal should suppress the re-POST — never to repair.

### 3. The new resync hook + `push.ts` export (D-07..D-12)

```typescript
// NEW — frontend/src/lib/push.ts
// D-11: extracted from ensureDeviceSubscribed's tail (push.ts:149-161) so the
// gesture path and the passive re-sync path cannot drift on
// `json.endpoint === undefined` / `keys?.p256dh ?? ''` handling.
async function postSubscription(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();
  if (json.endpoint === undefined) {
    throw new Error('PushSubscription.toJSON() returned no endpoint');
  }
  await pushApi.subscribe({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
  });
}

/**
 * D-07..D-12: re-POST an EXISTING device subscription after a suspected
 * server-side prune. Never calls Notification.requestPermission() or
 * PushManager.subscribe() (PERM-01) — the caller supplies an already-live
 * PushSubscription (from getDeviceSubscription()); this function only talks
 * to the backend. Blind and idempotent: upsert_subscription is
 * ON CONFLICT DO UPDATE on endpoint (app/repositories/push_repository.py:62-83),
 * so re-POSTing an endpoint the server already has is a harmless no-op.
 */
export async function resyncExistingSubscription(subscription: PushSubscription): Promise<boolean> {
  try {
    await postSubscription(subscription);
    return true;
  } catch (error) {
    Sentry.captureException(error, { tags: { source: 'push_resync' } });
    return false;
  }
}
```

```typescript
// NEW FILE — frontend/src/hooks/useDevicePushResync.ts
// Mirrors useReminderResurface.ts's fail-safe shape and useReminderResurfaceRedirect's
// once-per-mount ref pattern, PLUS a module-scoped guard (D-09) so a
// ProtectedLayout remount (e.g. logout -> login) cannot re-fire this within
// the same page load — a plain useRef resets on that remount, a module-level
// binding does not (verified: App.tsx:604-606 unmounts the whole
// ProtectedLayout subtree when `!token`).
import { useEffect, useRef } from 'react';
import { useTrainSettings } from '@/hooks/useTrainSettings';
import { usePushCapability } from '@/hooks/usePushCapability';
import { getDeviceSubscription, resyncExistingSubscription, subscriptionKeyMatches } from '@/lib/push';

// Module scope, NOT component scope — survives a ProtectedLayout remount
// within the same page load; resets only on a real page reload. D-09
// explicitly rejects a localStorage key here (a fourth push-related storage
// key, unbounded lifetime question, to save at most one 201 POST per app
// load at ~50 users/day).
let hasResyncedThisPageLoad = false;

export function useDevicePushResync(options?: { enabled?: boolean }): void {
  const enabled = options?.enabled ?? true;
  const { data: settings } = useTrainSettings({ enabled });
  const { vapidPublicKey } = usePushCapability();
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (hasResyncedThisPageLoad || attemptedRef.current) return;
    if (settings?.reminder_enabled !== true) return;
    if (!vapidPublicKey) return;

    let cancelled = false;
    attemptedRef.current = true;
    getDeviceSubscription()
      .then((subscription) => {
        if (cancelled || subscription === null) return;
        if (!subscriptionKeyMatches(subscription, vapidPublicKey)) return; // D-05: detect only
        hasResyncedThisPageLoad = true;
        return resyncExistingSubscription(subscription);
      })
      .catch(() => {
        // getDeviceSubscription() already swallows its own errors (push.ts).
        // Fail-safe: leave hasResyncedThisPageLoad untouched so a genuinely
        // transient failure can retry on the NEXT app load, not silently
        // suppress it forever.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, settings?.reminder_enabled, vapidPublicKey]);
}
```

```typescript
// App.tsx ProtectedLayout — one new line beside :558
useReminderResurfaceRedirect({ enabled: profile != null && !profile.is_guest });
useDevicePushResync({ enabled: profile != null && !profile.is_guest }); // NEW
```

### 4. Claim release in `train_reminder_repository.py` (D-13/D-14/D-15)

```python
# NEW — app/repositories/train_reminder_repository.py, beside claim_reminder_day
async def release_reminder_claim(
    session: AsyncSession, *, user_id: int, today: datetime.date
) -> bool:
    """Undo THIS tick's claim when the fan-out delivered to nobody (D-13/D-14).

    Guarded on `reminder_last_sent_on = :today` (not merely "is not null") so
    this can only ever release the claim THIS tick itself won -- never a
    later claim by a second ticker, keeping the D-07 double-send invariant
    structural rather than resting on "there is only one process". Mirrors
    claim_reminder_day's conditional-UPDATE-with-RETURNING shape exactly, so
    tests can assert on the row count the same way.

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        today: The SAME local calendar day claim_reminder_day was called with
            in this tick -- never re-resolved.
    """
    stmt = (
        update(TrainSettings)
        .where(
            TrainSettings.user_id == user_id,
            TrainSettings.reminder_last_sent_on == today,
        )
        .values(reminder_last_sent_on=None)
        .returning(TrainSettings.user_id)
    )
    released = (await session.execute(stmt)).scalar_one_or_none()
    return released is not None
```

```python
# app/services/train_reminder_service.py — _process_candidate, new step 8
# after the existing line 180 (train_reminder_service.py:180)
payload = build_reminder_payload(streak_count=view.settled.streak_count)
ttl_seconds = seconds_until_end_of_local_day(row.timezone, now_utc)  # D-01
result = await push_send.send_to_user(
    session, user_id=user_id, payload=payload, ttl_seconds=ttl_seconds
)
# D-13/D-14/D-15: nothing was (or could have been) delivered -- release
# today's claim so a same-day re-sync (D2) can still produce a reminder.
if result.attempted == 0 or result.attempted == result.pruned:
    await train_reminder_repository.release_reminder_claim(
        session, user_id=user_id, today=today
    )
    await session.commit()
return _CandidateOutcome(
    eligible=True, claimed=True, sent=True, pruned=result.pruned, failed=result.failed
)
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `TTL: 0` (deliver-now-or-never) | TTL = seconds until end of local day | This phase (D-01) | A discarded message is no longer indistinguishable from a delivered one for phones that were briefly unreachable |
| Silent VAPID-key reuse (`existing ??`) | Key comparison in the gesture path; passive detection only | This phase (D-04/D-05) | Manual toggle-off/toggle-on recovery restored after a rotation; passive path stays read-only |
| No app-load re-sync | `useDevicePushResync` mounted app-wide | This phase (D-07..D-12) | A server-side prune self-heals on next visit instead of requiring a manual Settings toggle |
| Claim always sticks for the day, even on total non-delivery | Claim released when `attempted == 0 or attempted == pruned` | This phase (D-13/D-14/D-15) | A same-day re-sync (D2) can produce a reminder the same day, not only tomorrow |

**Deprecated/outdated:** none — this phase does not remove any public API surface. The old `_PUSH_TTL_SECONDS = 0` module constant is replaced by a differently-named default (Claude's discretion on the exact name/value), not simply mutated in place, so a grep for the old name surfaces every remaining reference cleanly during the rename.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `PushSubscriptionOptions.applicationServerKey` returns `null` (not `undefined` or a thrown error) when a subscription was created without the option, per MDN — not independently reproduced in this codebase's test suite | Common Pitfalls §2, Code Examples §2 | If the actual runtime behavior differs (e.g. throws instead of returning null in some engine), the `try/catch` wrapper in `subscriptionKeyMatches` already covers it — low risk, the fail-safe path is identical either way |
| A2 | No browser currently in FlawChess's supported matrix returns `applicationServerKey` in a byte order or point-compression format different from what `application_server_key_from_pem` emits (X9.62 uncompressed point) — based on the fact `urlBase64ToUint8Array` + `PushManager.subscribe({ applicationServerKey })` already round-trip successfully in production per the SEED-135 incident (a subscribe from that exact key succeeded before the later prune) | Code Examples §2, Don't Hand-Roll | If wrong, the comparison would false-negative (never match, causing every app load to skip the resync's key-match gate) — this fails CLOSED (no repair attempted, no crash), consistent with D-05's fail-safe design, so the blast radius is "resync path never fires," not a corruption |

**If this table is empty:** N/A — see rows above. Both assumptions fail closed under D-05's own fail-safe design, so neither blocks planning; the planner should still flag A1/A2 for a UAT check on at least one real device (Chrome desktop is sufficient, per Phase 201's own verified UAT precedent).

## Open Questions

1. **What exact numeric default should replace `_PUSH_TTL_SECONDS = 0`?**
   - What we know: D-02 requires it be non-zero so no future caller silently reintroduces the bug; the real value used at the one production call site (`train_reminder_service._process_candidate`) is always the computed `seconds_until_end_of_local_day` result, never the default.
   - What's unclear: the dev-trigger endpoint (`app/routers/push.py` `dev_trigger_reminder`) is the ONLY caller that would ever actually use the default (it calls `push_send.send_to_user` with no `ttl_seconds` override) — so the default only matters for dev/manual testing, never production.
   - Recommendation: a moderate fixed value (e.g. one hour, `3600`) is defensible and cheap — it is never exercised in production, only by the dev-only trigger endpoint gated on `ENVIRONMENT == "development"` (`app/routers/push.py:107-134`). Confirm the dev-trigger call site is updated too if the plan wants it to also pass a computed value instead of relying on the default (not required by any CONTEXT.md decision, but worth a planner call).

2. **Should `release_reminder_claim` also be called from the dev-trigger endpoint's path?**
   - What we know: `dev_trigger_reminder` (`app/routers/push.py:107-134`) never writes `reminder_last_sent_on` at all (by design, D-17 from Phase 201 — "firing it twice sends twice, on purpose").
   - What's unclear: nothing — this confirms D-13's release logic has zero interaction with the dev-trigger path, since that path never claims in the first place.
   - Recommendation: no change needed to `push.py`; flagging only so the planner doesn't accidentally wire the new repository function into a router that has no claim to release.

## Environment Availability

Skipped — this phase has no new external dependencies (no new package, no new service, no new CLI tool). Everything needed (`httpx`, `zoneinfo`, `cryptography`/`pyjwt` behind `push_crypto`, browser Web Push APIs) is already present and already exercised by Phase 201/202's shipped code.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Backend framework | pytest 9.0.3 + pytest-asyncio, per-run cloned Postgres DB (see `tests/conftest.py`) |
| Backend config file | `pyproject.toml` `[tool.pytest.ini_options]` (implicit; run via `uv run pytest`) |
| Frontend framework | Vitest + Testing Library, `frontend/vitest.config.ts` (implicit; run via `npm test`) |
| Quick run command (backend) | `uv run pytest tests/services/test_train_reminder_service.py tests/test_push_send.py -n auto` |
| Quick run command (frontend) | `cd frontend && npm test -- --run src/lib/__tests__/push.test.ts src/hooks/__tests__/useDevicePushResync.test.ts` |
| Full suite command (backend) | `uv run pytest -n auto` |
| Full suite command (frontend) | `cd frontend && npm test -- --run` |

### Phase Requirement → Test Map

| Req ID (suggested) | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PUSHREL-03 (TTL) | `seconds_until_end_of_local_day` returns correct remaining seconds for mid-day, near-end-of-day, and exact-boundary instants | unit | `uv run pytest tests/services/test_train_scheduler.py -k end_of_local_day -x` | ❌ Wave 0 — new test function needed in existing file |
| PUSHREL-03 (TTL) | `send_to_subscription`'s outbound POST carries the computed `ttl_seconds` in the `ttl` header, not the old hardcoded value | unit | `uv run pytest tests/test_push_send.py -k ttl -x` | ❌ Wave 0 — extend existing status-branch test file, reuse its `_mock_client` fixture (`tests/test_push_send.py:80-86`) to assert on `client.post.call_args.kwargs["headers"]["ttl"]` |
| PUSHREL-03 (TTL, 10 existing tests) | All 10 pre-existing `send_to_subscription` calls (`tests/test_push_send.py`) keep passing with no signature change on their end | regression | `uv run pytest tests/test_push_send.py -n auto` | ✅ exists |
| PUSHREL-05 (claim release) | `attempted == pruned` releases the claim (single-subscription-all-pruned case) | unit | `uv run pytest tests/services/test_train_reminder_service.py -k claim_release -x` | ❌ Wave 0 — new `TestClaimRelease` class, mirroring `TestFanOut`'s `real_session_maker` pattern (`test_train_reminder_service.py:629-661`) |
| PUSHREL-05 (claim release) | A partial failure (some pruned, some delivered) does NOT release the claim | unit | same test file | ❌ Wave 0 |
| PUSHREL-05 (claim release) | `release_reminder_claim` only releases a claim matching `today` — a claim from a different day (simulating a second ticker's later claim) is untouched | unit | `uv run pytest tests/services/test_train_reminder_service.py -k TestClaimReminderDay -x` (extend `TestClaimReminderDay`, mirror `test_does_not_claim_when_equal`, `test_train_reminder_service.py:183-204`) | ❌ Wave 0 |
| PUSHREL-05 (D-07 invariant) | A crash mid-fan-out (exception from `send_to_user`, not a normal `PushFanoutResult` return) leaves the claim standing — release logic never runs | unit | same file | ❌ Wave 0 — mutation-test this by reverting the "only after normal return" guard and confirming the test goes red |
| PUSHREL-04 (VAPID mismatch, gesture path) | `ensureDeviceSubscribed` calls `unsubscribe()` + re-`subscribe()` on a key mismatch, reuses `existing` on a match | unit | `cd frontend && npm test -- --run src/lib/__tests__/push.test.ts` (extend existing `describe('ensureDeviceSubscribed', ...)`, `frontend/src/lib/__tests__/push.test.ts:184-280`) | ❌ Wave 0 |
| PUSHREL-04 (VAPID mismatch, passive path) | `subscriptionKeyMatches` returns `false` on `null`, on a byte mismatch, and on a thrown property read; `true` only on exact byte match | unit | same test file, new `describe` block | ❌ Wave 0 |
| PUSHREL-01/02 (device resync) | `useDevicePushResync` fires exactly once per page load, re-POSTs an existing subscription, and NEVER calls `Notification.requestPermission()`/`PushManager.subscribe()` | unit | `cd frontend && npm test -- --run src/hooks/__tests__/useDevicePushResync.test.ts` | ❌ Wave 0 — new file, mirror `frontend/src/lib/__tests__/push.test.ts`'s `stubBrowserGlobals` helper (lines 40-70) for the browser mocks, and `useReminderResurface.ts`'s test file (if present) for the hook-testing harness shape |
| PUSHREL-01 (fail-safe) | `reminder_enabled === false`, guest, or an unresolved `getDeviceSubscription()` probe all suppress the resync | unit | same file | ❌ Wave 0 |
| PUSHREL-06 (end-to-end) | Desync-and-recover: seed a `push_subscriptions` row, delete it (simulating a prune), invoke the resync path, assert the row is restored via `upsert_subscription`'s existing `ON CONFLICT DO UPDATE` | integration | Backend: extend `tests/routers/test_push.py`'s existing subscribe-endpoint test with a re-subscribe-after-delete case (no new endpoint, so this is just a second `POST /push/subscribe` call in an existing test) | ❌ Wave 0 (backend half only — the frontend half of "end to end" is covered by PUSHREL-01/02's unit tests plus manual UAT, since no E2E browser harness exists in this repo for Web Push) |

### Sampling Rate

- **Per task commit:** the quick run commands above (backend TTL/claim-release tests; frontend push.ts/hook tests).
- **Per wave merge:** full backend suite (`uv run pytest -n auto`) + full frontend suite (`npm test -- --run`).
- **Phase gate:** both full suites green before `/gsd-verify-work`, plus the mutation-testing check explicitly required by ROADMAP success criterion 6 — for each of the four production changes (TTL threading, VAPID comparison, resync hook, claim release), revert it and confirm the corresponding test goes red. Do not accept symbol-presence or grep-based verification (per `feedback_mutation_test_gap_closures` memory and CLAUDE.md's own mutation-testing guideline).

### Wave 0 Gaps

- [ ] `tests/services/test_train_scheduler.py` — new test function(s) for `seconds_until_end_of_local_day` (mid-day, near-end-of-day, exact-boundary cases; no DST-specific fixture needed per Open Questions reasoning — the "23:59:59 always exists" property is what D-01 exploits, not something a test needs to independently prove via a historical DST-midnight zone)
- [ ] `tests/test_push_send.py` — extend the status-branch table to assert on the `ttl` header value alongside the existing prune/capture assertions (reuse `_mock_client`, `tests/test_push_send.py:80-86`)
- [ ] `tests/services/test_train_reminder_service.py` — new `TestClaimRelease` class (mirrors `TestFanOut`'s `real_session_maker` + `vapid_keypair` fixtures, `test_train_reminder_service.py:629-661`) covering: total-prune releases, partial-failure does not release, and a crash-mid-fanout leaves the claim
- [ ] `frontend/src/lib/__tests__/push.test.ts` — extend with `subscriptionKeyMatches` unit tests and `ensureDeviceSubscribed` key-mismatch-repair tests (reuse `stubBrowserGlobals`, lines 40-70)
- [ ] `frontend/src/hooks/__tests__/useDevicePushResync.test.ts` — new file; needs a hook-testing harness (`@testing-library/react`'s `renderHook`, or the pattern the (currently absent, verify at plan time) `useReminderResurface.test.ts` uses if one exists — a targeted `find` at plan time should confirm whether `useReminderResurface` has its own test file to copy the harness shape from)
- [ ] `tests/routers/test_push.py` — extend with a re-subscribe-after-delete integration case for PUSHREL-06's end-to-end backend half

## Security Domain

`security_enforcement` is not set in `.planning/config.json` (absent = enabled per the workflow default), so this section is required.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | No auth surface changes — the phase touches no login/session code |
| V3 Session Management | No | Unaffected |
| V4 Access Control | Yes, unchanged | `POST /push/subscribe` already scopes to `current_active_user.id` (`app/routers/push.py:40-44`), never a client-supplied `user_id` — the new resync path calls this SAME endpoint through the SAME `pushApi.subscribe()` client method, so no new IDOR surface is introduced. Verified by reading the router: no new endpoint is added by this phase. |
| V5 Input Validation | Yes, unchanged | `PushSubscribeRequest`'s existing `https`-only `field_validator` (`app/schemas/push.py:25-31`) already covers the resync path's re-POST, since it reuses the same request schema |
| V6 Cryptography | No new crypto | The `applicationServerKey` comparison (D-04) is a plain byte-equality check on a PUBLIC key already transmitted over HTTPS to the client — not a secret, not a new signing/encryption primitive. `app/services/push_crypto.py` (VAPID JWT signing, aes128gcm encryption) is untouched by this phase. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| A malicious page re-POSTing an arbitrary (non-owned) `PushSubscription` via the new resync export | Spoofing | Already mitigated structurally: `resyncExistingSubscription` only ever receives a `PushSubscription` object obtained from THIS origin's own `navigator.serviceWorker.ready` + `getSubscription()` (`push.ts:82-90`) — there is no code path where a caller can construct or inject an arbitrary subscription object; the backend endpoint it posts to is also already scoped to the authenticated user (V4, above) |
| Denial via forced repeated re-subscribe spam from a compromised client | Denial of Service | `upsert_subscription`'s `ON CONFLICT DO UPDATE` (`app/repositories/push_repository.py:62-83`) makes repeat POSTs idempotent and cheap (one UPSERT, no unbounded row growth); the module-scoped once-per-page-load guard (D-09) additionally bounds the resync path to at most once per app load per device, not per render |
| Leaking the private VAPID key or bearer-capability endpoint via a comparison error/log | Information Disclosure | `subscriptionKeyMatches` never logs the key bytes; on error it returns `false` and lets the CALLER decide whether to capture to Sentry — no comparison failure path embeds key material in a Sentry payload, mirroring the existing CLAUDE.md rule already followed by `push_send.py`'s prune-capture code (`app/services/push_send.py:145-159`, "never the endpoint — it is a bearer capability") |

## Sources

### Primary (HIGH confidence — read this session)

- `app/services/push_send.py` (full file) — TTL constant, `send_to_subscription`/`send_to_user` signatures, prune branch, D-04 no-retry logic
- `app/services/train_reminder_service.py` (full file) — `_process_candidate` step order, `ReminderTickSummary`/`PushFanoutResult` consumption, claim-then-send ordering
- `app/repositories/train_reminder_repository.py` (full file) — `claim_reminder_day`'s exact SQL/RETURNING shape, `list_reminder_candidate_user_ids`
- `app/services/train_scheduler.py` (full file) — `local_today`/`local_hour`, `zoneinfo` fallback pattern, `DEFAULT_REMINDER_HOUR`/co-located-constants pattern
- `app/routers/push.py`, `app/repositories/push_repository.py`, `app/models/push_subscription.py`, `app/schemas/push.py` — endpoint behavior, `upsert_subscription`'s `ON CONFLICT DO UPDATE`, unique constraint on `endpoint` alone
- `app/services/push_crypto.py` (full file) — confirmed `application_server_key_from_pem` produces the base64url X9.62 uncompressed point, the exact byte format the frontend's `applicationServerKey` ArrayBuffer holds
- `frontend/src/lib/push.ts` (full file) — `ensureDeviceSubscribed`'s exact `existing ??` defect, `urlBase64ToUint8Array`, `getDeviceSubscription`, the single-call-site PERM-01 contract
- `frontend/src/hooks/useReminderResurface.ts` (full file) — the fail-safe probe pattern and the `navigatedRef`/layout-route-non-remount precedent used to justify D-09's module-scoped guard
- `frontend/src/App.tsx` lines 527-608, 834-905 — `ProtectedLayout`'s exact mount site (line 558), the layout-route structure (`<Route element={<ProtectedLayout />}>`, line 842), and the `!token` early-return unmount case (lines 604-606)
- `frontend/src/hooks/usePushCapability.ts`, `frontend/src/api/client.ts` (pushApi block, lines 299-306), `frontend/src/types/push.ts`, `frontend/src/types/train.ts` (reminder_enabled field) — the exact existing client-side surface this phase extends
- `tests/test_push_send.py` (full file) — the actual `send_to_subscription` call count (10, not ~15) and their exact call shape
- `tests/services/test_train_reminder_service.py` (full file structure via class/def grep + targeted reads) — existing test class shapes to mirror for new D-13/D-14 tests, `TestFanOut`'s `real_session_maker`/`httpx.AsyncClient.post` patch pattern
- `frontend/src/lib/__tests__/push.test.ts` (full file) — the exact `stubBrowserGlobals` mocking pattern for `navigator.serviceWorker`/`PushManager`/`Notification` under jsdom
- `frontend/knip.json` — confirmed generic project-wide entry (`src/prerender.tsx`), no special allowlisting needed for a new `push.ts` export as long as it is actually imported (by the new hook)
- `.planning/phases/204-push-reminder-delivery-reliability/204-CONTEXT.md`, `.planning/seeds/SEED-135-*.md`, `.planning/milestones/v2.11-phases/201-*/201-CONTEXT.md`, `.planning/milestones/v2.11-phases/202-*/202-CONTEXT.md`, `.planning/milestones/v2.11-REQUIREMENTS.md` — all locked decisions and requirement text

### Secondary (MEDIUM confidence)

- [RFC 8030: Generic Event Delivery Using HTTP Push, §5.2/§7](https://www.rfc-editor.org/rfc/rfc8030) — TTL header semantics ("if the user agent is unavailable, a push message with a zero TTL expires and is never delivered"), 404/410 as terminal statuses — confirms the SEED-135/CONTEXT.md D-01 premise exactly
- [MDN: PushSubscriptionOptions.applicationServerKey](https://developer.mozilla.org/en-US/docs/Web/API/PushSubscriptionOptions/applicationServerKey) — `null` when the option was omitted at subscribe time; "widely available since March 2023" baseline

### Tertiary (LOW confidence)

- None used as load-bearing claims — every design recommendation in this document is grounded in either a file read this session or a cited RFC/MDN reference.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries; every piece verified by reading the actual vendored/existing module this session
- Architecture: HIGH — every integration point (file:line) was read this session, not inferred from CONTEXT.md's prose alone; one CONTEXT.md claim (test count) was checked and corrected
- Pitfalls: HIGH — the layout-route-non-remount claim (Pitfall 3) was verified structurally against `App.tsx`'s actual `<Route>` nesting and the existing `navigatedRef` precedent, not assumed from React Router's general behavior
- VAPID key byte-format claim (Code Examples §2): MEDIUM-HIGH — confirmed the backend's byte format via `push_crypto.py`, but the frontend-side `ArrayBuffer` shape assumption (A2) is not independently reproduced against a real browser in this research session

**Research date:** 2026-08-03
**Valid until:** 30 days (stable internal APIs; RFC 8030/MDN citations do not expire on this timescale) — but re-verify the `send_to_subscription` call count and any test file line numbers if this research is consumed more than a few commits after 2026-08-03, since this is an actively-developed area of the codebase.
