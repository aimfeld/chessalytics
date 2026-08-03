---
phase: 202
reviewed: 2026-08-02
depth: standard
status: issues_found
critical: 1
warning: 3
info: 2
files_reviewed_list:
  - frontend/src/lib/push.ts
  - frontend/src/hooks/usePushCapability.ts
  - frontend/src/hooks/useTrainSettings.ts
  - frontend/src/components/train/TrainReminderButton.tsx
  - frontend/src/components/train/TrainScheduleSettings.tsx
  - frontend/src/components/train/TrainScoreScreen.tsx
  - frontend/src/components/admin/TrainReminderTestCard.tsx
  - frontend/src/pages/Admin.tsx
  - frontend/src/api/client.ts
  - frontend/src/types/push.ts
  - frontend/src/types/train.ts
  - frontend/src/lib/__tests__/push.test.ts
  - frontend/src/components/train/__tests__/TrainReminderButton.test.tsx
  - frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx
  - frontend/src/components/train/__tests__/TrainScoreScreen.test.tsx
  - frontend/src/components/train/__tests__/TrainStartScreen.test.tsx
  - frontend/src/components/admin/__tests__/TrainReminderTestCard.test.tsx
---

# Phase 202: Code Review Report

**Reviewed:** 2026-08-02
**Depth:** standard
**Files Reviewed:** 17
**Status:** issues_found

## Summary

The phase's core state-machine design (D-01..D-13) is implemented faithfully in the
common-path branches: the single call site for `Notification.requestPermission()`
holds, the double-press guard works via synchronous `disabled` state, `reminder_enabled`
is never written `true` ahead of a confirmed subscribe, toggle-off never touches the
browser subscription, and the D-11 per-device-vs-account-wide asymmetry is correctly
render-only (no stray PUT). The 47+ tests in this phase are unusually rigorous about
negative assertions (`expect(x).not.toHaveBeenCalled()`), not just presence checks.

The problems found are concentrated in the *unhappy paths that the branch matrix
doesn't reach*: `ensureDeviceSubscribed()` has one code path (a permission-request
rejection) that neither of its two callers protects against, leaving the control
permanently stuck mid-flight with the permission already spent; and the same
function's populated `catch` block — reached by every tested failure case — never
surfaces to Sentry from either call site, contrary to the CLAUDE.md rule it was
explicitly designed around. There is also a newly-introduced (by this phase, not
pre-existing) stale-cache overwrite risk on the score-screen button's full-replace PUT.

## Critical Issues

### CR-01: `ensureDeviceSubscribed()` can reject or hang, and neither caller has a catch — the control gets stuck disabled forever after the permission is already spent

**File:** `frontend/src/lib/push.ts:116-122`

**Issue:** The function's `try`/`catch` starts at line 121, but the one-shot permission
request is awaited *before* it, at line 117:

```ts
if (Notification.permission === 'default') {
  const result = await Notification.requestPermission(); // ONLY call site — PERM-01
  if (result === 'denied') return { status: 'denied' };
  if (result !== 'granted') return { status: 'dismissed' };
}
try {
  const registration = await navigator.serviceWorker.ready;   // also unbounded
  ...
} catch (error) {
  return { status: 'error', error };
}
```

Two concrete ways this bites:

1. **`Notification.requestPermission()` rejects instead of resolving.** This is not
   purely theoretical — some browser/webview contexts reject this promise (e.g. a
   `TypeError`/`NotAllowedError` when the engine judges the call not to be sufficiently
   "in response to a user gesture", which can happen with `async` click handlers in
   stricter engines) rather than resolving `'denied'`. When it rejects,
   `ensureDeviceSubscribed()` itself rejects — uncaught by its own function body.
2. **`navigator.serviceWorker.ready` never settles** (line 122, inside the `try` but
   with no timeout) — e.g. Safari private browsing, or any environment where
   `'serviceWorker' in navigator` is true but registration/activation silently never
   completes. The promise just hangs.

Neither caller guards against this:

- `TrainReminderButton.tsx:79-113` — `handleClick` is `async`, calls
  `const result = await ensureDeviceSubscribed(vapidPublicKey);` with no
  `try`/`catch`, and is invoked as `onClick={() => void handleClick()}` (line 121) —
  the `void` discards the promise, so a rejection becomes an unhandled promise
  rejection. `setState('pending')` (line 81) was already called and nothing ever
  transitions it out: the button stays disabled with the plain "Remind me" label,
  forever, with the browser's permission dialog possibly already resolved (spent) and
  no way for the user to retry short of a full page reload.
- `TrainScheduleSettings.tsx:344-357` — `void ensureDeviceSubscribed(vapidPublicKey).then((result) => {...})`
  has no `.catch()`. `setSubscribing(true)` (line 343) is never reset to `false`, so
  the master `Switch` stays permanently disabled.

This is exactly the failure class the phase's own review focus calls out as
Critical: a one-shot, non-renewable browser resource can be consumed while the UI
that was supposed to react to the outcome never does, leaving the user stuck.

**Test-coverage note:** no test in `push.test.ts` or either component's test file
exercises `requestPermission()` rejecting (all cases mock it as `mockResolvedValue(...)`)
or `navigator.serviceWorker.ready` never resolving — the otherwise-thorough branch
matrix has a structural blind spot here, which is presumably why this shipped.

**Fix:** move the `try` up to wrap the whole function body (including the
`requestPermission()` await), and add a bounded timeout around
`navigator.serviceWorker.ready` (e.g. `Promise.race` against a several-second timer)
so `ensureDeviceSubscribed()` is guaranteed to settle with a `DeviceSubscribeResult`
in every case:

```ts
export async function ensureDeviceSubscribed(
  vapidPublicKey: string,
): Promise<DeviceSubscribeResult> {
  if (!isPushSupported()) return { status: 'unsupported' };
  if (Notification.permission === 'denied') return { status: 'denied' };
  try {
    if (Notification.permission === 'default') {
      const result = await Notification.requestPermission();
      if (result === 'denied') return { status: 'denied' };
      if (result !== 'granted') return { status: 'dismissed' };
    }
    const registration = await withTimeout(navigator.serviceWorker.ready, SW_READY_TIMEOUT_MS);
    ...
  } catch (error) {
    return { status: 'error', error };
  }
}
```

## Warnings

### WR-01: The one `catch` block that IS reached never reports to Sentry from either call site — production push-subscribe failures are invisible

**File:** `frontend/src/lib/push.ts:143-145`, consumed by
`frontend/src/components/train/TrainReminderButton.tsx:82` and
`frontend/src/components/train/TrainScheduleSettings.tsx:344`

**Issue:** `ensureDeviceSubscribed()`'s `catch` block swallows every failure inside
the `try` (`PushManager.subscribe()` throwing, `pushApi.subscribe()`'s axios call
rejecting, a malformed subscription) into a resolved `{ status: 'error', error }`
value — it never re-throws. The module docstring and 202-CONTEXT.md's D-13 both
justify skipping a direct `Sentry.captureException()` call here with: *"a caller
that routes the result through a TanStack mutation already gets one free capture via
the global `MutationCache.onError`."*

That premise doesn't hold for the actual call sites. `TrainReminderButton.handleClick`
calls `await ensureDeviceSubscribed(vapidPublicKey)` directly (not via `useMutation`);
`TrainScheduleSettings.handleReminderToggle` calls
`ensureDeviceSubscribed(vapidPublicKey).then(...)`, also not via `useMutation`. Because
the function never rejects (it catches internally and *resolves* with an error
status), this failure never reaches `queryClient.ts`'s `MutationCache.onError` either
— it isn't part of any mutation's promise chain. The result: a `PushManager.subscribe()`
throw or a failed `POST /push/subscribe` is reported to Sentry **nowhere at all**.

This directly contradicts CLAUDE.md's Frontend Error Handling rule: *"Manual
fetch/axios calls in catch blocks (auth forms, direct API calls outside TanStack
Query) MUST call `Sentry.captureException(error, { tags: { source: '...' } })`."*
`ensureDeviceSubscribed()`'s catch is exactly this pattern (a manual axios call —
`pushApi.subscribe` — inside a catch block outside TanStack Query). It also
undermines the phase's own stated recovery plan: 202-CONTEXT.md D-13 explicitly
rejects special-casing Brave's `AbortError` and says *"Revisit only if Sentry shows
real users hitting it"* — but Sentry will never show this, because the exception
never reaches it.

**Fix:** add the capture back into the one place it's structurally safe to do so
(the catch itself, since it's the sole swallow point for this whole class of error):

```ts
} catch (error) {
  Sentry.captureException(error, { tags: { source: 'push-subscribe' } });
  return { status: 'error', error }; // D-13 — UI still stays non-blocking
}
```

(This requires importing `@sentry/react` into `lib/push.ts`, which it currently does
not — update the module docstring's "never call Sentry here" guidance accordingly,
since the reasoning that justified it doesn't hold as implemented.)

### WR-02: `TrainReminderButton`'s save() can silently revert weekday/puzzle settings changed on another device — a lost-update risk this phase newly triggers

**File:** `frontend/src/components/train/TrainReminderButton.tsx:86-99`

**Issue:** `PUT /train/settings` is a full-replace body (by design, pre-existing
since Phase 191), so every save must resend `weekday_mask`/`puzzles_per_session`
along with whatever field actually changed. `handleClick`'s save call does this by
reading the current React Query cache value (`data.weekday_mask`,
`data.puzzles_per_session`) rather than fetching fresh:

```ts
save({
  weekdayMask: data.weekday_mask,
  puzzlesPerSession: data.puzzles_per_session,
  reminderEnabled: true,
  reminderHour: data.reminder_hour,
}, { ... });
```

202-CONTEXT.md's D-05 explicitly documents multi-device usage as a first-class,
intended scenario for this phase ("a user with reminders enabled on their phone still
sees the button on their desktop"). Concretely: a user changes their weekday schedule
on their phone, then — without reloading — completes a Train session on a desktop tab
that hasn't refetched `/train/settings` in the last 30s (the global `staleTime`
default in `queryClient.ts`), and presses "Remind me" there. The desktop's stale
`data.weekday_mask` gets written back to the server, silently discarding the phone
edit. This risk pre-dates Phase 202 in the abstract (any full-replace PUT has it),
but this phase is what newly exposes it to an action ("turn on reminders") that has
nothing to do with intentionally editing the schedule — a user pressing this button
has no reason to expect it can revert unrelated settings.

**Fix:** either refetch settings immediately before constructing the save payload
(`await queryClient.fetchQuery({ queryKey: TRAIN_SETTINGS_QUERY_KEY, ... })`) so the
values sent are current, or (cleaner) change the backend/PUT contract so this specific
flow can send a true partial update. At minimum, this is worth a one-line comment
acknowledging the tradeoff was accepted, since it isn't currently discussed anywhere
in the phase's decision log.

### WR-03: The documented "rapid off-then-on inside the debounce window" race has no automated regression test

**File:** `frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx`

**Issue:** 202-02-SUMMARY.md's Checkpoint Resolution records that the human UAT
protocol included "a rapid off/on inside the debounce window settling on ON after
reload" — this is exactly the scenario the review focus called out to inspect
closely. Tracing the code confirms it resolves correctly today (the debounce timer
restarts on every `draft` change, and the toggle-ON success handler uses a
functional `setDraft` update so it always merges onto the latest draft rather than a
stale snapshot) — this is not currently a bug. But there is no automated test
covering it (only individual "toggle on" and separate "toggle off" tests exist), so a
future refactor of `handleReminderToggle`/`useDebounce` interaction could silently
reintroduce the exact regression the human tester was checking for, with nothing in
CI to catch it.

**Fix:** add a test that fires OFF then ON (or ON then OFF, guarded by the
`subscribing`-disables-the-Switch invariant) within the 600ms debounce window and
asserts exactly one `updateSettings` call lands with the final state.

## Info

### IN-01: `TrainReminderTestCard` is missing an explicit return type annotation

**File:** `frontend/src/components/admin/TrainReminderTestCard.tsx:26`

**Issue:** `export function TrainReminderTestCard() {` has no return type, unlike
every other component this phase touches or adds
(`TrainReminderButton`: `ReactElement | null`, `TrainScoreScreen`: `ReactElement`,
`TrainScheduleSettings`: `ReactElement`). CLAUDE.md's Coding Guidelines: "Add
explicit return type annotations on all functions."

**Fix:**
```ts
import type { ReactElement } from 'react';
export function TrainReminderTestCard(): ReactElement {
```

### IN-02: `usePushCapability`'s VAPID query treats every non-404 failure identically to "unconfigured," hiding the feature until the component remounts

**File:** `frontend/src/hooks/usePushCapability.ts:33-50`

**Issue:** Any error other than a 404 (e.g. a transient 500 or a network blip) is
rethrown, which sets the query to `status: 'error'` with `data: undefined` — and
`available`/`showReminderBlock` treat that identically to a genuinely-unconfigured
VAPID key (both surfaces hide). Because TanStack Query's default `retryOnMount`
behavior refetches errored queries with `data === undefined` on the next mount
(remount, e.g. re-navigating to the Train page), this self-heals reasonably quickly
in normal usage and does not persist for the rest of the browser session — so this is
not the correctness bug it might first appear to be. Noted only because a component
that stays mounted through a transient backend hiccup (rather than remounting) will
show no reminder UI and no error message until it does remount or the page reloads,
which is a minor UX gap given the "genuinely unconfigured" and "transient failure"
cases are visually indistinguishable to the user (both look like the feature doesn't
exist). Not action-required unless it turns out to matter in practice.

---

_Reviewed: 2026-08-02_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
