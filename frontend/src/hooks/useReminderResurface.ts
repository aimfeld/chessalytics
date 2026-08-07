/**
 * useReminderResurface — OFFER-05/D-16: closes the iOS install→reminder
 * two-session cliff. A user who tapped the iOS install affordance
 * (`TrainReminderButton`'s `ios-tabbed` branch, Plan 04 Task 1) recorded
 * `reminder_intent_at` server-side and left the tab — the next time they
 * open the installed PWA (a standalone launch), this is the only mechanism
 * left to route them back to actually granting reminders.
 *
 * Fail-safe by construction (CONTEXT.md D-01): this iOS branch ships without
 * real-device verification, so every signal here — `isStandalone`, the
 * settings fetch, the subscription probe — must positively resolve to the
 * qualifying value before `shouldResurface` can be true. Any unresolved,
 * unavailable, or thrown signal degrades to `false` — render nothing,
 * redirect nowhere — never to a redirect or a prompt the user did not ask
 * for.
 *
 * Two hooks, one file, deliberately split:
 * - `useReminderResurface` is the pure decision (no router dependency), so
 *   it can be unit tested — and consumed by `TrainReminderResurfaceBanner`
 *   — without a Router wrapper.
 * - `useReminderResurfaceRedirect` adds the router-only "push to /train"
 *   wiring `App.tsx`'s `ProtectedLayout` calls with zero arguments, kept
 *   separate so the decision hook above stays router-free.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';
import { useTrainSettings } from '@/hooks/useTrainSettings';
import { getDeviceSubscription } from '@/lib/push';

/** Per-device dismiss flag — its OWN key, distinct from both the D-04
 * install-cooldown keys (`lib/installCooldown.ts`) and the server-side
 * `reminder_intent_at` field. Three different lifetimes, three different
 * keys: install cooldown is per-device/per-surface cadence, the intent flag
 * bridges the tab->standalone boundary server-side, and this flag is a
 * one-way "I don't want this prompt again on this device" note. */
export const TRAIN_RESURFACE_DISMISSED_KEY = 'train-resurface-dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(TRAIN_RESURFACE_DISMISSED_KEY) === 'true';
  } catch {
    // Fail-safe: a broken/unavailable localStorage must not let the
    // redirect+banner surface appear unexpectedly — treat as dismissed.
    return true;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(TRAIN_RESURFACE_DISMISSED_KEY, 'true');
  } catch {
    // Best-effort only — a failed write just means the banner may resurface
    // on a later launch, not a functional bug.
  }
}

export interface UseReminderResurfaceResult {
  shouldResurface: boolean;
  dismiss: () => void;
  isResolved: boolean;
  /** Called by the banner immediately after a confirmed subscribe so it can
   * unmount without a reload or waiting for a remount to re-probe
   * `getDeviceSubscription()`. */
  markSubscribed: () => void;
}

/**
 * The OFFER-05/D-16 decision: `shouldResurface` is true only when ALL of —
 * standalone, `reminder_intent_at` non-null, the subscription probe resolved
 * to null (no subscription on this device), dismiss flag absent. Every other
 * combination, including any unresolved or thrown probe, returns `false`.
 *
 * `options.enabled` (CR-01 fix, 203-REVIEW.md) threads down to
 * `useTrainSettings` so a caller mounted app-wide (see
 * `useReminderResurfaceRedirect` below) can gate the underlying
 * `GET /train/settings` off for guests, who get a guaranteed 403 from
 * `_reject_guest`. Defaults to enabled, so the pre-existing
 * `TrainReminderResurfaceBanner` call site (already Train-page-scoped,
 * guests cannot reach it without games) is unaffected.
 */
export function useReminderResurface(options?: { enabled?: boolean }): UseReminderResurfaceResult {
  const { isStandalone } = useInstallPrompt();
  const { data } = useTrainSettings({ enabled: options?.enabled ?? true });
  // null = probe not yet resolved (or its rejection never resolved it) —
  // deliberately indistinguishable from "still loading" so an unresolved
  // probe can never accidentally read as "no subscription".
  const [deviceSubscribed, setDeviceSubscribed] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(() => readDismissed());

  useEffect(() => {
    let cancelled = false;
    getDeviceSubscription()
      .then((subscription) => {
        if (!cancelled) setDeviceSubscribed(subscription !== null);
      })
      .catch(() => {
        // `getDeviceSubscription()` already swallows its own errors and
        // resolves `null` (lib/push.ts) — this catch is an extra fail-safe
        // layer so a future change there can never let a rejection escape
        // this hook. Leaving `deviceSubscribed` at `null` keeps
        // `shouldResurface` false forever for this mount, which is the
        // correct fail-safe outcome for a probe that never resolved.
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

  const dismiss = (): void => {
    writeDismissed();
    setDismissed(true);
  };

  const markSubscribed = (): void => {
    setDeviceSubscribed(true);
  };

  return { shouldResurface, dismiss, isResolved, markSubscribed };
}

/**
 * D-16's active route push. The manifest `start_url` is `/`
 * (`vite.config.ts`), so a standalone launch never lands on Train by
 * itself — this hook makes the push explicit, at most once per mount (a ref
 * guard, not a re-firing effect), and only when the user is not already
 * somewhere in Train (the same `/train` prefix predicate
 * `InstallPromptBanner`'s route suppression uses).
 *
 * Kept OUT of `useReminderResurface` above so that hook stays router-free
 * and independently testable without a Router wrapper. `ProtectedLayout`
 * calls this once per render.
 *
 * CR-01 FIX (203-REVIEW.md): `ProtectedLayout` mounts this hook
 * unconditionally on EVERY protected route for EVERY account, including
 * guests — `options.enabled` lets the caller thread its own guest check
 * down through `useReminderResurface` to `useTrainSettings`, so the
 * underlying `GET /train/settings` never fires for a guest at all (rather
 * than firing and having its guaranteed 403 land in Sentry). Kept as an
 * explicit caller-supplied flag (not a `useUserProfile()` call inside this
 * hook) so this file's existing test suite — which mocks
 * `useTrainSettings`/`useInstallPrompt` but not `useUserProfile` or a
 * `QueryClientProvider` — is unaffected.
 */
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
