---
phase: 203-pwa-install-re-prompting-train-anchored-install-offer
reviewed: 2026-08-02T20:35:35Z
depth: standard
files_reviewed: 25
files_reviewed_list:
  - alembic/versions/20260802_174733_6e7e50844af5_phase_203_reminder_intent.py
  - app/models/train_settings.py
  - app/repositories/train_repository.py
  - app/routers/train.py
  - app/schemas/train.py
  - frontend/src/App.tsx
  - frontend/src/components/install/InstallPromptBanner.tsx
  - frontend/src/components/install/__tests__/InstallPromptBanner.test.tsx
  - frontend/src/components/train/TrainInstallQr.tsx
  - frontend/src/components/train/TrainReminderButton.tsx
  - frontend/src/components/train/TrainReminderResurfaceBanner.tsx
  - frontend/src/components/train/TrainScheduleSettings.tsx
  - frontend/src/components/train/TrainScoreScreen.tsx
  - frontend/src/components/train/TrainStartScreen.tsx
  - frontend/src/components/train/__tests__/TrainInstallQr.test.tsx
  - frontend/src/components/train/__tests__/TrainReminderButton.test.tsx
  - frontend/src/components/train/__tests__/TrainReminderResurfaceBanner.test.tsx
  - frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx
  - frontend/src/components/train/__tests__/TrainScoreScreen.test.tsx
  - frontend/src/components/train/__tests__/TrainStartScreen.test.tsx
  - frontend/src/hooks/useInstallPrompt.ts
  - frontend/src/hooks/useReminderResurface.ts
  - frontend/src/hooks/useTrainSettings.ts
  - frontend/src/hooks/__tests__/useInstallPrompt.test.ts
  - frontend/src/hooks/__tests__/useReminderResurface.test.ts
  - frontend/src/lib/handoffMarker.ts
  - frontend/src/lib/installCooldown.ts
  - frontend/src/lib/reminderSlotState.ts
  - frontend/src/lib/__tests__/handoffMarker.test.ts
  - frontend/src/lib/__tests__/installCooldown.test.ts
  - frontend/src/lib/__tests__/reminderSlotState.test.ts
  - frontend/src/types/train.ts
  - tests/repositories/test_train_repository.py
  - tests/routers/test_train.py
findings:
  critical: 2
  warning: 2
  info: 1
  total: 5
status: resolved
resolved: 2026-08-03
resolution_note: all 5 findings closed; see the Resolution section at the end of this file
---

# Phase 203: Code Review Report

**Reviewed:** 2026-08-02T20:35:35Z
**Depth:** standard
**Files Reviewed:** 25 (+7 test files read for corroboration)
**Status:** issues_found

## Summary

The backend half of this phase (`reminder_intent_at` column, migration, repository
threading, router, schemas) is solid: the migration is trivially reversible, the
full-replace `TrainSettingsUpdate` contract is genuinely required-but-nullable and
enforced with a 422, and all three frontend call sites that `save()` through
`useTrainSettings` correctly echo/write `reminder_intent_at` — no missed PUT call
site, no silent 422 risk. Test coverage on the pure resolvers
(`reminderSlotState`, `installCooldown`, `handoffMarker`) is thorough and
well-targeted at documented edge cases.

Two real defects were found by tracing call chains across hook instances rather
than reading each file in isolation, both classified Critical because they make a
shipped requirement silently not work / silently pollute production error
tracking rather than crashing loudly:

1. `useReminderResurfaceRedirect()` is now mounted unconditionally in
   `ProtectedLayout` for every route and every authenticated account, including
   guests — but the `useTrainSettings()` query it depends on has no `enabled`
   gate, unlike the codebase's own established fix (`useTrainProgress`,
   T-191-21) for exactly this failure mode. Every guest page view/window-focus
   now produces a captured 403 in Sentry.
2. The Android "Install FlawChess" upsell added to the score screen's confirmed
   reminder state depends on a `BeforeInstallPromptEvent` captured by a
   *separate, late-mounting* instance of `useInstallPrompt()` — the hook has no
   shared/singleton event store, and `beforeinstallprompt` fires (at most) once
   per page load. In practice this second instance will almost never have the
   event, so `canInstall` stays `false` and the upsell essentially never renders.

Two Warnings and one Info round out lower-severity quality issues.

## Critical Issues

### CR-01: Guest accounts hit a guaranteed 403 on `/train/settings` on every protected page, captured to Sentry

**File:** `frontend/src/App.tsx:550` (call site), `frontend/src/hooks/useReminderResurface.ts:74-76` (root cause)

**Issue:** `ProtectedLayout` now calls `useReminderResurfaceRedirect()` unconditionally on mount — it wraps *every* protected route (`/library`, `/openings`, `/endgames`, `/bots`, `/admin`, `/train`, …), for every authenticated account, guest or not:

```tsx
// App.tsx ProtectedLayout — runs for ALL routes, ALL users
useReminderResurfaceRedirect();
```

`useReminderResurfaceRedirect` calls `useReminderResurface()`, which calls `useTrainSettings()` unconditionally (`frontend/src/hooks/useReminderResurface.ts:76`):

```ts
const { data } = useTrainSettings();
```

`useTrainSettings()` (`frontend/src/hooks/useTrainSettings.ts:41-44`) has no `enabled` option at all — it always fires `GET /train/settings`. The backend's `_reject_guest` (`app/routers/train.py:47-54`) returns 403 for every guest account on this exact endpoint. `frontend/src/lib/queryClient.ts`'s global `QueryCache.onError` captures **every** query error to Sentry unconditionally, with no status-code filter:

```ts
onError: (error, query) => {
  Sentry.captureException(error, { tags: { source: 'tanstack-query' }, extra: { queryKey: query.queryKey } });
},
```

This is the *exact* failure mode the codebase already fixed once: `useTrainProgress` (`frontend/src/hooks/useTrainProgress.ts:21-24`) documents it plainly —

> `options.enabled` (Plan 05) lets the nav badge call sites gate the request off entirely for guests and locked-nav accounts, so an expected 403/401-adjacent failure never fires and never reaches the global `QueryCache.onError` Sentry reporter (T-191-21).

— and `NavHeader`/`MobileBottomBar` both gate their `useTrainProgress` call with `enabled: navUnlocked && profile != null && !profile.is_guest`. `useReminderResurface`/`useTrainSettings` has no equivalent guard, and is now mounted app-wide rather than Train-page-scoped, so the blast radius is every page a guest visits, repeated on every `staleTime`-expiry/window-focus refetch (default TanStack behavior — nothing here disables it).

Net effect: every guest session produces a stream of captured 403 "errors" in Sentry, drowning real signal, in direct contradiction of CLAUDE.md's "Skip expected failures" rule and this codebase's own precedent.

**Fix:** Thread a guest/import-gate check into `useReminderResurface`/`useTrainSettings`, mirroring `useTrainProgress`'s pattern:

```ts
// useTrainSettings.ts
export function useTrainSettings(options?: { enabled?: boolean }) {
  const query = useQuery<TrainSettingsResponse>({
    queryKey: TRAIN_SETTINGS_QUERY_KEY,
    queryFn: trainApi.getSettings,
    enabled: options?.enabled ?? true,
  });
  ...
}

// useReminderResurface.ts
const { data: profile } = useUserProfile();
const { data } = useTrainSettings({ enabled: profile != null && !profile.is_guest });
```

(`TrainReminderButton`/`TrainScheduleSettings`, the two pre-existing `useTrainSettings()` call sites, are already scoped to the Train page which guests cannot reach without games, so they don't need the same change — only the newly app-wide `useReminderResurface` consumer does.)

### CR-02: The score-screen Android install upsell depends on an event a second hook instance almost never receives

**File:** `frontend/src/hooks/useInstallPrompt.ts:42-49` (root cause), `frontend/src/components/train/TrainReminderButton.tsx:112-181` (consumer)

**Issue:** `useInstallPrompt` captures the browser's one-shot `beforeinstallprompt` event into **per-hook-instance** React state:

```ts
useEffect(() => {
  const handler = (e: Event) => { e.preventDefault(); setPromptEvent(e as BeforeInstallPromptEvent); };
  window.addEventListener('beforeinstallprompt', handler);
  return () => window.removeEventListener('beforeinstallprompt', handler);
}, []);
```

There is no module-level singleton or Context provider — a grep for `beforeinstallprompt` confirms the *only* listener registration is inside this hook body, so every call site owns an independent copy of `promptEvent`. `beforeinstallprompt` fires at most once per page load and is not re-dispatched on demand.

Phase 203 adds a *second* consumer of `canInstall`/`triggerInstall` beyond the long-lived `InstallPromptBanner` instance (mounted once, early, in `ProtectedLayout`, so it reliably captures the event whenever the browser fires it during the session): `TrainScoreScreen`'s `useTrainReminderSlot()` → `useInstallPrompt()` (`TrainReminderButton.tsx:115`), used to gate the confirmed-state Android offer:

```tsx
const showAndroidOffer = isMobile && !isIOS && !isStandalone && canInstall;
...
<Button onClick={() => void triggerInstall()}>Install FlawChess</Button>
```

`TrainScoreScreen` only mounts after a full puzzle session completes — well after the page's initial load, i.e. well after `beforeinstallprompt` has almost certainly already fired (and been captured only by the earlier `InstallPromptBanner` instance). This new, independent `useInstallPrompt()` instance's own `addEventListener` registers too late to see that already-fired, non-repeating event, so `promptEvent` stays `null` for the instance's whole lifetime, `canInstall` stays `false`, and `showAndroidOffer` essentially never evaluates `true` in production — silently defeating the OFFER-04 "install offer on Android tabbed" requirement this phase exists to add. The unit tests for this branch (`TrainReminderButton.test.tsx`) mock `useInstallPrompt` entirely at the module boundary, so they cannot and do not catch this cross-instance timing gap.

**Fix:** Make the captured event shared across all consumers instead of per-instance — e.g. lift the `beforeinstallprompt` listener to a module-level singleton (a plain variable + subscriber set, or a React Context provided once at the app root) that every `useInstallPrompt()` call reads from, so a late-mounting consumer sees an event captured earlier in the session:

```ts
// module scope, outside the hook
let capturedEvent: BeforeInstallPromptEvent | null = null;
const listeners = new Set<(e: BeforeInstallPromptEvent | null) => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    capturedEvent = e as BeforeInstallPromptEvent;
    listeners.forEach((l) => l(capturedEvent));
  });
}
```

Each `useInstallPrompt()` instance then seeds its local state from `capturedEvent` on mount and subscribes for later updates, rather than only listening for a fresh dispatch.

## Warnings

### WR-01: `TrainReminderResurfaceBanner` shows a false "couldn't turn on reminders" error if tapped before the push-capability probe resolves

**File:** `frontend/src/components/train/TrainReminderResurfaceBanner.tsx:44-51`

**Issue:** Unlike `TrainReminderButton`'s `reminderSlotState` resolver, which explicitly hides the whole slot until `isResolved`/`available`/`vapidPublicKey !== null` all clear, `TrainReminderResurfaceBanner` renders its CTA as soon as `useReminderResurface()` resolves, with no check on `usePushCapability().isResolved`:

```tsx
const handleTurnOn = async (): Promise<void> => {
  const { vapidPublicKey } = capability;
  if (vapidPublicKey === null) {
    setStatus('error'); // fires even when push IS available but the probe hasn't resolved yet
    return;
  }
  ...
};
```

`usePushCapability`'s VAPID-key query is a real network round-trip; if the user taps "Turn on reminders" in the brief window before it resolves, they see the permanent-looking `ERROR_COPY` even though push may actually be available a moment later. This is exercised by an existing test (`TrainReminderResurfaceBanner.test.tsx`, "when the VAPID key has not resolved…") but nothing in the module docstring documents this as an intentional trade-off — it reads as an overlooked race rather than a deliberate simplification.

**Fix:** Either disable the CTA (or render nothing) until `capability.isResolved` is true, mirroring `reminderSlotState`'s gate, or retry the capability query on tap before deciding it's unavailable.

### WR-02: `usePushCapability`'s docstring is now stale/incorrect

**File:** `frontend/src/hooks/usePushCapability.ts:9-11`

**Issue:** The docstring states:

> Scoped to the two consuming components only (`TrainReminderButton` here, `TrainScheduleSettings` in Plan 02) — never an app-level provider, because the key endpoint is unauthenticated and guests are out of scope.

Phase 203 added a third consumer, `TrainReminderResurfaceBanner` (`frontend/src/components/train/TrainReminderResurfaceBanner.tsx:39`), without updating this comment. Not a functional bug (the endpoint is unauthenticated, so a third consumer is harmless), but a stale invariant statement is exactly the kind of comment a future reader will trust and be misled by.

**Fix:** Update the docstring to reflect the three current consumers (or drop the enumerated list in favor of "consumed by the Train reminder surfaces").

## Info

### IN-01: `TrainReminderResurfaceBanner` mounts on every non-loading/non-error Train landing state

**File:** `frontend/src/components/train/TrainStartScreen.tsx:259,268,293`

**Issue:** `<TrainReminderResurfaceBanner />` is rendered from three separate branches of `TrainStartScreen` (`empty`, `completed`, and the shared `resume`/`short`/`fresh` return). Each mount is a fresh `useReminderResurface()` instance with its own `getDeviceSubscription()` effect run, though TanStack Query dedupes the underlying `useTrainSettings()` fetch by key so this is not a duplicate network call. Purely a note for the next reader: the banner's self-contained "compute your own mount decision" design (per its own docstring) means it re-derives `isStandalone`/subscription state independently every time `TrainStartScreen` switches landing states, which is harmless today but worth remembering if a future change makes the underlying probe stateful/side-effecting.

**Fix:** No action required; documenting for awareness only.

---

_Reviewed: 2026-08-02T20:35:35Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

---

## Resolution (2026-08-03)

All five findings are closed. Every behavioral fix was proven load-bearing by reverting it and
confirming the new regression test fails — symbol presence was not accepted as evidence.

| ID | Severity | Fix | Commit |
|----|----------|-----|--------|
| CR-01 | Critical | `useTrainSettings` gained an `enabled` gate, threaded through `useReminderResurface` → `useReminderResurfaceRedirect` → `ProtectedLayout` (`enabled: profile != null && !profile.is_guest`), ending the guest 403 storm | `9b8cdb32e` |
| CR-02 | Critical | `beforeinstallprompt` capture hoisted from per-hook-instance state to a module-level singleton with a subscriber set, so a late-mounting consumer still observes `canInstall` | `66498aaed` |
| WR-01 | Warning | `TrainReminderResurfaceBanner` now gates on `capability.isResolved && capability.available`, mirroring `reminderSlotState`'s `hidden` gate — no CTA during the probe round-trip, and none at all when push is unconfigured | `5c62fa54e` |
| WR-02 | Warning | `usePushCapability` docstring reworded to drop the fixed consumer count that went stale when Phase 203 added the third consumer | `5c62fa54e` |
| IN-01 | Info | Reviewed and accepted as harmless — `TrainReminderResurfaceBanner` re-mounting across `TrainStartScreen` landing-state branches has no behavioral consequence; no change made | — |

### Why CR-02 mattered most

It was dead code in production with a fully green test suite. `beforeinstallprompt` is one-shot and
fires early on document load; each `useInstallPrompt()` call captured it into private state, so
`TrainReminderButton`'s score-screen instance — mounted much later — never saw it and `canInstall`
was permanently `false`. The tests passed because they dispatched the event into an already-mounted
instance, which is not the production sequence. The regression test now fires the event **before**
mounting the consumer.

### Collateral fixed while closing WR-01

`TrainStartScreen.test.tsx` mocked `usePushCapability` as `available: false` file-wide while three
banner-ordering tests asserted the CTA renders. The new gate exposed the contradiction. The mock is
now mutable (matching the sibling `resurfaceMock` pattern) with unchanged defaults, so the six
landing-state assertions are untouched and only the banner block opts in.

Full gate after all fixes: frontend 219 files / 3243 tests, `npm run build`, `npm run lint`
(0 errors), `npm run knip` — all green. Backend untouched by the review fixes.
