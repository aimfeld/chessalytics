# Phase 204: Push Reminder Delivery Reliability - Pattern Map

**Mapped:** 2026-08-03
**Files analyzed:** 8 (4 backend modify, 1 backend test extend x3, 2 frontend modify, 1 frontend new + 1 frontend test new)
**Analogs found:** 8 / 8 — every file has a strong in-repo analog; RESEARCH.md already ground-truthed every integration point, so this document supplies only the copy-paste-ready excerpts.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `app/services/push_send.py` (MODIFY) | service | request-response | itself — `subscription_id` param precedent, same file | exact (self-precedent) |
| `app/services/train_scheduler.py` (MODIFY) | utility | transform | `local_today`/`local_hour` in same file | exact |
| `app/repositories/train_reminder_repository.py` (MODIFY) | model/repository | CRUD | `claim_reminder_day` in same file | exact |
| `app/services/train_reminder_service.py` (MODIFY) | service | event-driven (scheduled tick) | `_process_candidate`'s existing step 6/7 in same file | exact |
| `frontend/src/lib/push.ts` (MODIFY) | utility/service | request-response | `ensureDeviceSubscribed`'s tail (same file) | exact |
| `frontend/src/hooks/useDevicePushResync.ts` (CREATE) | hook | event-driven (mount-time probe) | `frontend/src/hooks/useReminderResurface.ts` | exact |
| `frontend/src/App.tsx` (MODIFY, `ProtectedLayout` ~:558) | provider/mount-site | request-response | its own existing `useReminderResurfaceRedirect` mount line ~:558 | exact |
| `tests/services/test_train_scheduler.py` (MODIFY/CREATE test fn) | test | transform | none yet in that file for TTL — model on `local_today`/`local_hour`'s docstrings | role-match |
| `tests/test_push_send.py` (MODIFY) | test | request-response | `_mock_client` + status-branch table, same file | exact |
| `tests/services/test_train_reminder_service.py` (MODIFY, new `TestClaimRelease`) | test | CRUD/event-driven | `TestClaimReminderDay` (~:155) + `TestFanOut` (~:629) | exact |
| `frontend/src/lib/__tests__/push.test.ts` (MODIFY) | test | request-response | `stubBrowserGlobals` (~:48-70) + existing `describe('ensureDeviceSubscribed', ...)` | exact |
| `frontend/src/hooks/__tests__/useDevicePushResync.test.ts` (CREATE) | test | event-driven | `push.test.ts`'s `stubBrowserGlobals` mocking style (no existing hook test file for `useReminderResurface` found — verify at plan time) | role-match |

## Pattern Assignments

### `app/services/push_send.py` (service, request-response) — MODIFY

**Anchor:** `_PUSH_TTL_SECONDS = 0` (line 56) and `send_to_subscription` signature (lines 96-119).

**Analog:** the file's own `subscription_id` precedent (SEED-135 D1) — copy the exact keyword-only-defaulted-param shape.

**Current constant to replace** (lines 53-56):
```python
# RFC 8030 TTL. 0 = deliver only if the device is reachable right now, never
# stored by the push service. A reminder is worthless once its hour has passed
# (D-04/D-08 already own lateness), so we do not ask for retention.
_PUSH_TTL_SECONDS = 0
```
Replace the constant name (D-02 requires non-zero) and add a doc line pointing at the rotation runbook if it lands here (D-06 discretion).

**Current signature to extend** (lines 96-104, `send_to_subscription`):
```python
async def send_to_subscription(
    client: httpx.AsyncClient,
    *,
    endpoint: str,
    p256dh: str,
    auth: str,
    payload: dict[str, object],
    subscription_id: int | None = None,
) -> bool:
```
Add `ttl_seconds: int = _DEFAULT_PUSH_TTL_SECONDS` as the next keyword-only defaulted param, mirroring `subscription_id`'s placement exactly (last param, defaulted, never required).

**Where the constant is consumed** (line 126, inside the `headers` dict build at lines 125-136):
```python
    headers = {
        "ttl": str(_PUSH_TTL_SECONDS),
        "content-encoding": "aes128gcm",
        ...
```
Change to `"ttl": str(ttl_seconds)`.

**`send_to_user` signature to extend** (lines 174-176):
```python
async def send_to_user(
    session: AsyncSession, *, user_id: int, payload: dict[str, object]
) -> PushFanoutResult:
```
Add `ttl_seconds: int = _DEFAULT_PUSH_TTL_SECONDS` keyword-only, and thread it into the `send_to_subscription(...)` call at lines 203-210:
```python
                should_prune = await send_to_subscription(
                    client,
                    endpoint=subscription.endpoint,
                    p256dh=subscription.p256dh,
                    auth=subscription.auth,
                    payload=payload,
                    subscription_id=subscription.id,
                )
```
→ add `ttl_seconds=ttl_seconds,` as the next line.

**Docstring precedent to mirror** (lines 110-119, explains why `subscription_id` is keyword-only-defaulted — copy this reasoning style verbatim for `ttl_seconds`, updating the caller count to 10 per RESEARCH.md's correction, not RESEARCH's-quoted-CONTEXT's "~15"):
```python
    Args:
        subscription_id: The row's PK, threaded in so the prune capture's
            `set_context` can identify which row was deleted (SEED-135 D1)
            without ever carrying the endpoint. Keyword-only and defaulted to
            None rather than required -- `send_to_subscription` is exported
            in `__all__` and called directly by ~15 tests with the pre-D1
            signature. ...
```

---

### `app/services/train_scheduler.py` (utility, transform) — MODIFY

**Anchor:** insert new function directly after `local_hour` (ends at line 153), inside the same module, no new imports needed beyond what's already there (`ZoneInfo`, `ZoneInfoNotFoundError`, `DEFAULT_TIMEZONE` already imported for `local_today`/`local_hour`).

**Analog — `local_today`** (lines 103-129, copy this fallback shape and docstring cadence exactly):
```python
def local_today(tz_name: str, now_utc: datetime.datetime) -> datetime.date:
    """Convert a UTC instant to a user's local calendar day (D-06).
    ...
    """
    try:
        zone = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo(DEFAULT_TIMEZONE)
    return now_utc.astimezone(zone).date()
```

**Analog — `local_hour`** (lines 132-153, identical fallback shape, different return leaf):
```python
def local_hour(tz_name: str, now_utc: datetime.datetime) -> int:
    """Convert a UTC instant to a user's local clock hour (Phase 201, REMIND-02/D-16).
    ...
    """
    try:
        zone = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo(DEFAULT_TIMEZONE)
    return now_utc.astimezone(zone).hour
```

**New function to add (RESEARCH.md's Code Example 1, already correct — paste as-is, only rename per Claude's discretion if preferred):**
```python
_END_OF_DAY_HOUR = 23
_END_OF_DAY_MINUTE = 59
_END_OF_DAY_SECOND = 59


def seconds_until_end_of_local_day(tz_name: str, now_utc: datetime.datetime) -> int:
    """Seconds remaining in the user's local calendar day (Phase 204, D-01/D-03)."""
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

---

### `app/repositories/train_reminder_repository.py` (repository, CRUD) — MODIFY

**Anchor:** insert new function directly after `claim_reminder_day` (ends at line 97), before `has_completed_session_on` (starts at line 100). Add `release_reminder_claim` to the `__all__` list (currently lines 125-129).

**Analog — `claim_reminder_day` in full** (lines 66-97, mirror its exact `update().where().values().returning()` shape, its "does not commit" contract, and its `scalar_one_or_none()` → bool pattern):
```python
async def claim_reminder_day(session: AsyncSession, *, user_id: int, today: datetime.date) -> bool:
    """Atomically claim `today` as sent for `user_id` (REMIND-05, D-06/D-07).

    A conditional `UPDATE ... RETURNING`: only claims when
    `reminder_last_sent_on` is NULL or strictly before `today`. Returns
    whether THIS call won the claim -- a loser's UPDATE matches zero rows.

    Does NOT commit. The caller MUST commit this before issuing any push
    POST (D-07): a send-then-mark ordering would double-send after a crash
    between the POST and the commit, and would quietly reintroduce the retry
    semantics D-04 rejects.

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        today: The user's own already-resolved local calendar day (from
            `train_scheduler.local_today`), never a database-side date.
    """
    stmt = (
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
    claimed = (await session.execute(stmt)).scalar_one_or_none()
    return claimed is not None
```

**New function to add (RESEARCH.md's Code Example 4 — already correct, paste as-is):**
```python
async def release_reminder_claim(
    session: AsyncSession, *, user_id: int, today: datetime.date
) -> bool:
    """Undo THIS tick's claim when the fan-out delivered to nobody (D-13/D-14)."""
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
Note: no `or_`/`is_(None)` guard here — deliberately narrower than `claim_reminder_day`'s predicate (D-14: only release a claim that equals `today` exactly, never a NULL/earlier row).

**`__all__` update** (currently lines 125-129):
```python
__all__ = [
    "claim_reminder_day",
    "has_completed_session_on",
    "list_reminder_candidate_user_ids",
]
```
→ add `"release_reminder_claim",` (alphabetical, matching existing style).

---

### `app/services/train_reminder_service.py` (service, event-driven) — MODIFY

**Anchor:** `_process_candidate`, existing lines 179-183 (the last two lines of the function today):
```python
        payload = build_reminder_payload(streak_count=view.settled.streak_count)
        result = await push_send.send_to_user(session, user_id=user_id, payload=payload)
        return _CandidateOutcome(
            eligible=True, claimed=True, sent=True, pruned=result.pruned, failed=result.failed
        )
```
This is the exact code to change. New shape (RESEARCH.md's Code Example 4, second block):
```python
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
**Import line to extend** (line 44):
```python
from app.services.train_scheduler import is_scheduled_day, local_hour, local_today
```
→ add `seconds_until_end_of_local_day` to this import.

**Load-bearing constraint (Pitfall 4 from RESEARCH.md):** the release call must be the next line after `send_to_user` returns, inside the SAME `async with async_session_maker() as session:` block (opened at line 128) — never inside the outer try/except in `send_due_reminders` (lines ~216-226), so a raised exception from `send_to_user` leaves the claim standing.

---

### `frontend/src/lib/push.ts` (utility/service, request-response) — MODIFY

**Anchor:** `ensureDeviceSubscribed`'s tail, lines 141-161:
```typescript
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      }));
    const json = subscription.toJSON();
    if (json.endpoint === undefined) {
      throw new Error('PushSubscription.toJSON() returned no endpoint');
    }
    const body: PushSubscribeRequest = {
      endpoint: json.endpoint,
      keys: {
        p256dh: json.keys?.p256dh ?? '',
        auth: json.keys?.auth ?? '',
      },
    };
    await pushApi.subscribe(body);
    return { status: 'subscribed' };
```
Three changes here:
1. `existing ??` (line 143-144) is the D-04 defect — replace with a `subscriptionKeyMatches(existing, vapidPublicKey)` check that falls through to `unsubscribe()` + `subscribe()` on a `null`/mismatch, reuses `existing` only on a confirmed match.
2. Extract the `const json = subscription.toJSON(); ... await pushApi.subscribe(body);` block (lines 149-160) into a shared `postSubscription(subscription: PushSubscription): Promise<void>` helper (D-11) — both this call site and the new `resyncExistingSubscription` must call it so the `json.endpoint === undefined` / `keys?.p256dh ?? ''` handling cannot drift.
3. Add `subscriptionKeyMatches` (new export, byte-compare against `urlBase64ToUint8Array`, already imported at line 64) and `resyncExistingSubscription` (new export) — both from RESEARCH.md's Code Examples §2/§3, reproduced below verbatim since they are already correct against the current file:

```typescript
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
    return false;
  }
}

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
Note: `push.ts` does not currently import `Sentry` — check whether another symbol in the file already does before adding a new import (search `push.ts` for `@sentry/react` — if absent, add `import * as Sentry from '@sentry/react';`).

**`urlBase64ToUint8Array` (unchanged, existing helper `subscriptionKeyMatches` reuses)** — lines 64-75:
```typescript
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat(
    (BASE64_PAD_MODULUS - (base64String.length % BASE64_PAD_MODULUS)) % BASE64_PAD_MODULUS,
  );
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}
```

**`getDeviceSubscription` (unchanged, the fail-safe probe both `useDevicePushResync` and `useReminderResurface` call)** — lines 82-90:
```typescript
export async function getDeviceSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}
```

---

### `frontend/src/hooks/useDevicePushResync.ts` (hook, event-driven) — CREATE

**Analog:** `frontend/src/hooks/useReminderResurface.ts` in full (168 lines) — copy its fail-safe shape: `getDeviceSubscription()` + `useTrainSettings()`, `null` = unresolved (never collapses to a qualifying value), `cancelled` flag in effect cleanup, `.catch()` backstop even though the underlying probe already swallows.

**Analog's `useReminderResurface` decision body** (lines 82-129 — copy the `useEffect`/`cancelled` shape exactly):
```typescript
export function useReminderResurface(options?: { enabled?: boolean }): UseReminderResurfaceResult {
  const { isStandalone } = useInstallPrompt();
  const { data } = useTrainSettings({ enabled: options?.enabled ?? true });
  const [deviceSubscribed, setDeviceSubscribed] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(() => readDismissed());

  useEffect(() => {
    let cancelled = false;
    getDeviceSubscription()
      .then((subscription) => {
        if (!cancelled) setDeviceSubscribed(subscription !== null);
      })
      .catch(() => {
        if (!cancelled) setDeviceSubscribed(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isResolved = data !== undefined && deviceSubscribed !== null;
  const shouldResurface =
    isResolved &&
    isStandalone &&
    data?.reminder_intent_at != null &&
    deviceSubscribed === false &&
    !dismissed;
  ...
}
```

**Analog's redirect wrapper (`useReminderResurfaceRedirect`, lines 154-167) — the once-per-mount `useRef` guard pattern**, relevant because `useDevicePushResync` needs a STRONGER guard (module-scoped, per D-09/Pitfall 3, not just `useRef`, since `ProtectedLayout` can fully unmount/remount on a logout→login within one page load):
```typescript
export function useReminderResurfaceRedirect(options?: { enabled?: boolean }): void {
  const { shouldResurface } = useReminderResurface({ enabled: options?.enabled ?? true });
  const location = useLocation();
  const navigate = useNavigate();
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (navigatedRef.current) return;
    if (!shouldResurface) return;
    if (location.pathname.startsWith('/train')) return;
    navigatedRef.current = true;
    navigate('/train');
  }, [shouldResurface, location.pathname, navigate]);
}
```

**New file body (RESEARCH.md's Code Example 3, already correct — paste as-is, minus the App.tsx mount line which belongs in App.tsx):**
```typescript
import { useEffect, useRef } from 'react';
import { useTrainSettings } from '@/hooks/useTrainSettings';
import { usePushCapability } from '@/hooks/usePushCapability';
import { getDeviceSubscription, resyncExistingSubscription, subscriptionKeyMatches } from '@/lib/push';

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
        // fail-safe: leave hasResyncedThisPageLoad untouched so a transient
        // failure can retry on the NEXT app load
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, settings?.reminder_enabled, vapidPublicKey]);
}
```
**Verify at plan time:** `usePushCapability()`'s actual return shape (field name `vapidPublicKey` assumed from RESEARCH.md — grep `frontend/src/hooks/usePushCapability.ts` before using it verbatim).

---

### `frontend/src/App.tsx` (provider/mount-site) — MODIFY

**Anchor:** `ProtectedLayout`, line 558 (the existing mount call, immediately after the CR-01 comment block at lines 545-557):
```typescript
  useReminderResurfaceRedirect({ enabled: profile != null && !profile.is_guest });
```
Add directly below it (same guest gate, per D-07):
```typescript
  useReminderResurfaceRedirect({ enabled: profile != null && !profile.is_guest });
  useDevicePushResync({ enabled: profile != null && !profile.is_guest }); // NEW — Phase 204 D-07
```
**Import to add** (near line 38, beside `useReminderResurfaceRedirect`'s import):
```typescript
import { useReminderResurfaceRedirect } from '@/hooks/useReminderResurface';
```
→ add `import { useDevicePushResync } from '@/hooks/useDevicePushResync';`

---

## Shared Patterns

### Keyword-only defaulted parameter threading (backend)
**Source:** `app/services/push_send.py:96-104,110-119` (the `subscription_id` precedent, SEED-135 D1)
**Apply to:** `send_to_subscription` and `send_to_user`'s new `ttl_seconds` parameter — same position (last), same "keyword-only + defaulted, never required" contract, same docstring cadence explaining why (existing test callers must keep compiling unmodified).

### tz-aware "local day" helper co-location (backend)
**Source:** `app/services/train_scheduler.py:103-153` (`local_today`/`local_hour`)
**Apply to:** the new `seconds_until_end_of_local_day` — identical `try: ZoneInfo(tz_name) except (ZoneInfoNotFoundError, ValueError): ZoneInfo(DEFAULT_TIMEZONE)` fallback block, verbatim, no new import needed.

### Conditional-UPDATE-with-RETURNING (backend)
**Source:** `app/repositories/train_reminder_repository.py:66-97` (`claim_reminder_day`)
**Apply to:** `release_reminder_claim` — same `update().where(...).values(...).returning(...)`, `scalar_one_or_none() is not None` → bool shape, "does not commit, caller commits" contract stated in the docstring.

### Fail-safe browser probe (frontend)
**Source:** `frontend/src/hooks/useReminderResurface.ts:82-129` (`useReminderResurface`)
**Apply to:** `useDevicePushResync` — `null`/unresolved never collapses to a qualifying value, `cancelled` flag in effect cleanup, `.catch()` backstop even though the probe (`getDeviceSubscription`) already swallows its own errors.

### Single call-site for one-shot browser permission (PERM-01, frontend)
**Source:** `frontend/src/lib/push.ts` module-level contract (see `ensureDeviceSubscribed`'s docstring, lines 106-129) — `Notification.requestPermission()` and `PushManager.subscribe()` may only be called from `ensureDeviceSubscribed`.
**Apply to:** `resyncExistingSubscription` and `useDevicePushResync` — both must be structurally incapable of calling either gated API; enforce by only ever passing an already-live `PushSubscription` obtained from `getDeviceSubscription()` into the new function.

### Sentry capture without variable-embedded messages (backend + frontend)
**Source:** `app/services/push_send.py:153-159` (`set_tag`/`set_context` before a fixed-literal `capture_exception`) and the frontend catch at `push.ts` (existing `ensureDeviceSubscribed` error arm).
**Apply to:** `resyncExistingSubscription`'s catch block — `Sentry.captureException(error, { tags: { source: 'push_resync' } })`, never embedding the endpoint or subscription id in a message string.

## No Analog Found

None — every file in scope has at least a role-match analog in the same module or an adjacent test file. The one soft spot: no confirmed existing test file for `useReminderResurface` itself (RESEARCH.md flags this as unverified — "a targeted `find` at plan time should confirm whether `useReminderResurface` has its own test file to copy the harness shape from"). If absent, `frontend/src/lib/__tests__/push.test.ts`'s `stubBrowserGlobals` (lines 48-70, reproduced below) plus a plain `@testing-library/react` `renderHook` call is the fallback harness for `useDevicePushResync.test.ts`.

## Test Fixture/Mock Excerpts

### Frontend: `stubBrowserGlobals` (`frontend/src/lib/__tests__/push.test.ts:40-70`)
```typescript
interface GlobalStubOptions {
  permission?: NotificationPermission;
  requestPermission?: ReturnType<typeof vi.fn>;
  getSubscription?: ReturnType<typeof vi.fn>;
  subscribe?: ReturnType<typeof vi.fn>;
  omitPushManager?: boolean;
}

function stubBrowserGlobals(options: GlobalStubOptions = {}): {
  requestPermission: ReturnType<typeof vi.fn>;
  getSubscription: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
} {
  const requestPermission = options.requestPermission ?? vi.fn().mockResolvedValue('granted');
  const getSubscription = options.getSubscription ?? vi.fn().mockResolvedValue(null);
  const subscribe = options.subscribe ?? vi.fn().mockResolvedValue(fakeSubscription);

  vi.stubGlobal('Notification', {
    permission: options.permission ?? 'default',
    requestPermission,
  });
  if (!options.omitPushManager) {
    vi.stubGlobal('PushManager', class {});
  }
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }) },
    configurable: true,
  });

  return { requestPermission, getSubscription, subscribe };
}
```
`fakeSubscription` (line 36-38, needed for any test exercising `subscriptionKeyMatches`/`resyncExistingSubscription` too — extend it with an `options.applicationServerKey` field for the key-mismatch tests):
```typescript
const fakeSubscription = {
  toJSON: () => ({ endpoint: 'https://example.test/ep', keys: { p256dh: 'p', auth: 'a' } }),
};
```
`vi.mock('@/api/client', ...)` block (lines 12-21) and `vi.mock('@sentry/react', ...)` (line 23) are already set up in this file — the new `subscriptionKeyMatches`/`resyncExistingSubscription` tests belong in the same file and reuse both mocks plus the existing `afterEach` reset (lines 72-76):
```typescript
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(pushApi.subscribe).mockReset();
  vi.mocked(Sentry.captureException).mockReset();
});
```
Representative assertion style from the existing suite (`describe('ensureDeviceSubscribed', ...)`, e.g. "already subscribed: reuses the existing subscription without calling pushManager.subscribe again" ~line 246) — mirror this shape for the new key-match-reuse and key-mismatch-repair cases: assert both the returned status/value AND that `subscribe`/`requestPermission` were or were not called.

### Backend: `_mock_client` (`tests/test_push_send.py:80-86`)
```python
def _mock_client(status_code: int | None = None, *, side_effect: object = None) -> AsyncMock:
    client = AsyncMock()
    if side_effect is not None:
        client.post = AsyncMock(side_effect=side_effect)
    else:
        client.post = AsyncMock(return_value=MagicMock(status_code=status_code))
    return client
```
Representative existing assertion (`test_send_to_subscription_status_201_no_prune_no_capture`, lines 94-104) — the new TTL-header test should follow this exact call shape, additionally passing `ttl_seconds=` and asserting on `client.post.call_args.kwargs["headers"]["ttl"]`:
```python
@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_subscription_status_201_no_prune_no_capture() -> None:
    p256dh, auth = _fresh_subscription_keys()
    client = _mock_client(201)
    with patch("app.services.push_send.sentry_sdk.capture_exception") as mock_capture:
        should_prune = await push_send.send_to_subscription(
            client, endpoint=_ENDPOINT, p256dh=p256dh, auth=auth, payload=_PAYLOAD
        )
    assert should_prune is False
    assert mock_capture.call_count == 0
```

### Backend: `TestClaimReminderDay` (`tests/services/test_train_reminder_service.py:155-204`) — mirror shape for the new claim-release test
```python
class TestClaimReminderDay:
    async def test_does_not_claim_when_equal(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _USER_ID)
        db_session.add(
            TrainSettings(
                user_id=_USER_ID,
                reminder_enabled=True,
                reminder_hour=18,
                reminder_last_sent_on=_TODAY,
            )
        )
        await db_session.flush()

        claimed = await train_reminder_repository.claim_reminder_day(
            db_session, user_id=_USER_ID, today=_TODAY
        )
        assert claimed is False
        row = (
            await db_session.execute(
                select(TrainSettings.reminder_last_sent_on).where(TrainSettings.user_id == _USER_ID)
            )
        ).scalar_one()
        assert row == _TODAY
```
A new `TestReleaseReminderClaim` class should mirror this shape 1:1 for `release_reminder_claim` (seed a row with `reminder_last_sent_on=_TODAY`, assert `released is True` + row is now `None`; seed a row with an earlier/different date, assert `released is False` + row unchanged).

### Backend: `TestFanOut` (`tests/services/test_train_reminder_service.py:629-661`) — mirror shape for `TestClaimRelease`'s end-to-end case
```python
class TestFanOut:
    async def test_three_subscriptions_receive_three_posts_from_one_claim(
        self,
        real_session_maker: async_sessionmaker[AsyncSession],
        vapid_keypair: None,
    ) -> None:
        await _seed_ready_candidate(real_session_maker, n_subscriptions=3)
        mock_post = AsyncMock(side_effect=[MagicMock(status_code=201) for _ in range(3)])
        with patch("httpx.AsyncClient.post", new=mock_post):
            summary = await train_reminder_service.send_due_reminders(_NOW)
        assert mock_post.await_count == 3
        assert summary.claimed == 1
        assert summary.sent == 1

    async def test_mid_fan_out_failure_does_not_skip_remaining_subscriptions(
        self,
        real_session_maker: async_sessionmaker[AsyncSession],
        vapid_keypair: None,
    ) -> None:
        await _seed_ready_candidate(real_session_maker, n_subscriptions=3)
        mock_post = AsyncMock(
            side_effect=[
                MagicMock(status_code=201),
                httpx.ConnectError("boom"),
                MagicMock(status_code=201),
            ]
        )
        with patch("httpx.AsyncClient.post", new=mock_post):
            summary = await train_reminder_service.send_due_reminders(_NOW)
        assert mock_post.await_count == 3
        assert summary.claimed == 1
        assert summary.sent == 1
```
For the new `TestClaimRelease` class (total-prune case), seed with `n_subscriptions=1` and a `mock_post` returning `MagicMock(status_code=410)` for all calls, then assert `reminder_last_sent_on IS NULL` after the tick via a follow-up `real_session_maker()` query (mirroring `TestClaimReminderDay`'s row-read style above). For the crash-mid-fanout case, use `side_effect=httpx.ConnectError(...)` for ALL posts (→ `PushFanoutResult(failed=N)`, not an unhandled exception — `send_to_user` already isolates per-subscription, so to test the "release never runs on a raised exception" invariant, patch `push_send.send_to_user` itself (not `httpx.AsyncClient.post`) to raise, and assert the claim row is untouched.

## Metadata

**Analog search scope:** `app/services/`, `app/repositories/`, `frontend/src/lib/`, `frontend/src/hooks/`, `frontend/src/App.tsx`, `tests/`, `frontend/src/lib/__tests__/` — all files named in RESEARCH.md's Integration Points and Code Examples sections, re-read this session at their current line numbers (which mostly matched RESEARCH.md, confirming no drift since it was written today).
**Files scanned:** 8 source files (full or targeted reads), 4 test files (targeted reads for fixture/mock/assertion shapes).
**Pattern extraction date:** 2026-08-03
