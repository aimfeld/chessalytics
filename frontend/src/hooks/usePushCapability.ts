/**
 * usePushCapability — D-12's gate. Resolves once whether push is usable at
 * all: D-10 feature detection plus a `staleTime: Infinity` query for the
 * VAPID application server key. A 404 on that key means "push unconfigured"
 * (201 D-03 — the default state on a fresh dev machine and in CI), not a
 * user-facing error (UI-SPEC E6), so the `queryFn` swallows it rather than
 * letting it throw into the global `QueryCache.onError` Sentry capture.
 *
 * Consumers today: `TrainReminderButton`, `TrainScheduleSettings`,
 * `TrainReminderResurfaceBanner` (Phase 203), and the app-wide
 * `useDevicePushResync` (Phase 204, D-07). Deliberately not enumerated as a
 * fixed count — the earlier "the two consuming components" wording went stale
 * the moment Phase 203 added the third (203-REVIEW.md WR-02).
 *
 * `options.enabled` (Phase 204): the app-wide consumer MUST pass the same
 * guest gate `ProtectedLayout` passes `useReminderResurfaceRedirect`, so a
 * guest's app load still issues no `GET /push/vapid-public-key` (mirrors the
 * CR-01 fix already documented at `App.tsx:551-557`). The three pre-existing
 * Train-page-scoped consumers call this with no arguments and keep their
 * current behavior (default `enabled: true`).
 */
import axios from 'axios';
import { useQuery } from '@tanstack/react-query';
import { pushApi } from '@/api/client';
import { isPushSupported, readPermission } from '@/lib/push';

/** The shared query key for GET /push/vapid-public-key. */
export const PUSH_VAPID_QUERY_KEY = ['push', 'vapid-key'] as const;

const HTTP_NOT_FOUND = 404;

export interface PushCapability {
  isResolved: boolean;
  available: boolean;
  vapidPublicKey: string | null;
  permission: NotificationPermission;
}

/**
 * Bug fix (FLAWCHESS-9P): 2 production events over 13 days, `/library/games`,
 * Firefox/Linux — TanStack Query throws `<queryHash> data is undefined` when
 * a queryFn resolves `undefined`. The backend cannot produce that
 * (`app/routers/push.py` returns a Pydantic model or a 404), so the trigger
 * is a 2xx whose body is not the expected JSON object (a browser extension or
 * intermediary stub) — e.g. `''.application_server_key` yields `undefined`
 * rather than throwing. This guard takes `unknown` so it is provably
 * incapable of resolving `undefined` regardless of what the response body
 * actually is. A malformed body now takes the same "push unconfigured" path
 * as the 404 (D-12 / UI-SPEC E6) instead of feeding the global
 * `QueryCache.onError` capture.
 */
function readVapidKey(response: unknown): string | null {
  if (typeof response !== 'object' || response === null) return null;
  const key = (response as { application_server_key?: unknown }).application_server_key;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

export function usePushCapability(options?: { enabled?: boolean }): PushCapability {
  const supported = isPushSupported();

  const query = useQuery<string | null>({
    queryKey: PUSH_VAPID_QUERY_KEY,
    queryFn: async (): Promise<string | null> => {
      try {
        return readVapidKey(await pushApi.getVapidPublicKey());
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === HTTP_NOT_FOUND) {
          return null; // D-12: unconfigured, not a user-facing error
        }
        throw error;
      }
    },
    enabled: supported && (options?.enabled ?? true),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

  const vapidPublicKey = query.data ?? null;

  return {
    isResolved: !supported || !query.isPending,
    available: supported && typeof vapidPublicKey === 'string' && vapidPublicKey.length > 0,
    vapidPublicKey,
    // Read live on every render, never memoized into a ref that outlives the check.
    permission: readPermission(),
  };
}
