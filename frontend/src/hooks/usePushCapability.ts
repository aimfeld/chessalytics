/**
 * usePushCapability — D-12's gate. Resolves once whether push is usable at
 * all: D-10 feature detection plus a `staleTime: Infinity` query for the
 * VAPID application server key. A 404 on that key means "push unconfigured"
 * (201 D-03 — the default state on a fresh dev machine and in CI), not a
 * user-facing error (UI-SPEC E6), so the `queryFn` swallows it rather than
 * letting it throw into the global `QueryCache.onError` Sentry capture.
 *
 * Scoped to the Train reminder surfaces only — never an app-level provider,
 * because the key endpoint is unauthenticated and guests are out of scope.
 * Consumers today: `TrainReminderButton`, `TrainScheduleSettings`, and
 * `TrainReminderResurfaceBanner` (Phase 203). Deliberately not enumerated as a
 * fixed count — the earlier "the two consuming components" wording went stale
 * the moment Phase 203 added the third (203-REVIEW.md WR-02).
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

export function usePushCapability(): PushCapability {
  const supported = isPushSupported();

  const query = useQuery<string | null>({
    queryKey: PUSH_VAPID_QUERY_KEY,
    queryFn: async () => {
      try {
        const response = await pushApi.getVapidPublicKey();
        return response.application_server_key;
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === HTTP_NOT_FOUND) {
          return null; // D-12: unconfigured, not a user-facing error
        }
        throw error;
      }
    },
    enabled: supported,
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
