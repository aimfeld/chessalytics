/**
 * useDevicePushResync — Phase 204 D-07/D-08/D-09/D-10/D-11. Closes SEED-135's
 * D2: a device that holds a live `PushSubscription` while the server's
 * `push_subscriptions` row for it was pruned goes permanently dark, because
 * nothing ever re-registers it without a user gesture. This hook re-POSTs
 * that already-live subscription on the next app load, with zero user
 * interaction and zero use of the one-shot browser permission.
 *
 * Fail-safe by construction, mirroring `useReminderResurface.ts`: every
 * signal — enabled, settings, the VAPID key, the subscription probe, the key
 * comparison — must positively resolve to the qualifying value before a
 * resync attempt fires. Any unresolved, unavailable, or thrown signal means
 * do nothing.
 *
 * PERM-01 stays structural here, not just a convention this file follows:
 * this hook only ever calls `getDeviceSubscription()` (permission-free) and
 * `resyncExistingSubscription()` (never calls `Notification.requestPermission()`
 * or `PushManager.subscribe()` — see `lib/push.ts`). `ensureDeviceSubscribed`,
 * the one function allowed to spend the one-shot permission, is never
 * imported here (D-11).
 *
 * D-05 (narrowed criterion 4, detection only): a mismatched
 * `applicationServerKey` suppresses the resync entirely — no re-POST, no
 * `unsubscribe()`. The repair half lives in Plan 03's `ensureDeviceSubscribed`,
 * behind an explicit user gesture.
 *
 * D-09 cadence: at most one resync ATTEMPT per page load, enforced by a
 * MODULE-scoped guard rather than a `useRef` or a `localStorage` throttle.
 * `ProtectedLayout` is a layout route and does not remount on a nested route
 * change, but it IS fully unmounted when `token` goes away (`App.tsx:604-606`)
 * — a logout -> login within one page load would reset a `useRef` guard back
 * to its initial value, firing a second attempt in the same page load. A
 * module binding survives that unmount/remount and only resets on a real
 * page reload, which is the cadence D-09 asks for. A `localStorage` throttle
 * was deliberately rejected (D-09): it would add a fourth push-related
 * storage key with its own lifetime question, to save at most one cheap
 * idempotent POST per page load at ~50 users/day.
 *
 * Deliberate deviation from the plan's research code example: the guard is
 * set to `true` SYNCHRONOUSLY, before `getDeviceSubscription()` is called —
 * not later, inside the `.then()`. Setting it late leaves a window where two
 * mounts within the same page load could both pass the synchronous gates
 * before either probe resolves, firing two attempts. Setting it synchronously
 * removes that window and leaves exactly one guard to reason about (and to
 * reset in tests via `vi.resetModules()`). The cadence contract this
 * establishes is "at most one ATTEMPT per page load", not "one success per
 * page load" — a failed POST does not retry until the next page load.
 */
import { useEffect } from 'react';
import { useTrainSettings } from '@/hooks/useTrainSettings';
import { usePushCapability } from '@/hooks/usePushCapability';
import { getDeviceSubscription, resyncExistingSubscription, subscriptionKeyMatches } from '@/lib/push';

// Module scope, not component scope — see the cadence discussion above.
let hasResyncedThisPageLoad = false;

export function useDevicePushResync(options?: { enabled?: boolean }): void {
  const enabled = options?.enabled ?? true;
  const { data: settings } = useTrainSettings({ enabled });
  const { vapidPublicKey } = usePushCapability({ enabled });

  useEffect(() => {
    if (!enabled) return;
    if (hasResyncedThisPageLoad) return;
    if (settings?.reminder_enabled !== true) return;
    if (!vapidPublicKey) return;

    // Burn the guard synchronously, before the async probe starts (see the
    // deliberate-deviation note above) — this is what makes "at most one
    // attempt per page load" hold even across two near-simultaneous mounts.
    hasResyncedThisPageLoad = true;

    let cancelled = false;
    getDeviceSubscription()
      .then((subscription) => {
        if (cancelled || subscription === null) return;
        if (!subscriptionKeyMatches(subscription, vapidPublicKey)) return; // D-05: detect only
        return resyncExistingSubscription(subscription);
      })
      .catch(() => {
        // getDeviceSubscription() and resyncExistingSubscription() already
        // swallow their own errors — this catch is an extra fail-safe layer
        // so a future change can never let a rejection escape this hook.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, settings?.reminder_enabled, vapidPublicKey]);
}
