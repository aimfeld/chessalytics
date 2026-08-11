import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ReadinessResponse } from '@/types/api';

const READINESS_POLL_INTERVAL_MS = 3_000;
const READINESS_STALE_TIME_MS = 3_000;

// Laddered decay once tier1 is true and only tier2 is outstanding. tier2 waits
// out a days-long eval drain (SEED-146), so a fixed 3s cadence for the whole
// wait is the unbounded-standing-load problem this backoff exists to fix.
// Three integer-literal steps, clamping at 5 minutes — no multiplication or
// Math.pow, so the emitted sequence is exactly assertable (D-05).
const READINESS_BACKOFF_LADDER_MS = [15_000, 60_000, 300_000] as const;

// A tab left open for hours must eventually go quiet even while tier2 is
// still outstanding ("a tab open for 8 hours should not still be asking",
// seed). 30 minutes of tier2-waiting yields ~8 requests instead of ~600.
// refetchOnWindowFocus (project default, unmodified — see queryClient.ts)
// refreshes a resumed tab even after this budget is exhausted.
const READINESS_BACKOFF_BUDGET_MS = 30 * 60_000;

/** Poll GET /imports/readiness, decaying once only Tier 2 is outstanding.
 *
 * Tier 1 (tier1=true): no active import job in-flight for this user.
 * Tier 2 (tier2=true): tier1=true AND evals drained AND percentile rows exist
 *   (or user has no games).
 *
 * Defaults tier1=false and tier2=false before the first fetch resolves, so
 * gated surfaces (endgames page, eval-dependent stats) do not flash open on
 * initial page load.
 *
 * Three cadence phases:
 * - tier1 false (import phase, seconds-to-minutes): flat 3s cadence.
 * - tier1 true, tier2 false (waiting on the eval drain): laddered decay —
 *   15s, then 60s, then 300s and holds there — advanced once per real fetch.
 * - Once the next scheduled tick would land more than 30 minutes into the
 *   decay phase: polling stops entirely (the duration-cap "go quiet" case).
 * - tier2 true: polling stops, as before — Stage-A/Stage-B work is done.
 *
 * The hook never hard-stops at tier1: while tier1 is true and tier2 is false
 * it keeps polling (albeit decayed), so Endgames.tsx, OpeningFindingCard.tsx,
 * OpeningStatsCard.tsx and PositionResultsPanel.tsx still unlock reactively
 * on the tier2 transition without requiring a navigation.
 *
 * All consumers on the same page share one in-flight request via the shared
 * queryKey ['imports', 'readiness'] — TanStack Query deduplicates them.
 *
 * NOTE: This hook does NOT include a window.location.reload() effect.
 * Consumers that need to react to the tier2 transition should use a
 * toast/notification (e.g. App.tsx Tier-2 watcher) rather than a hard reload.
 */
export function useReadiness() {
  // Poll-state ref carried across renders/fetches. Advanced exclusively in
  // queryFn (once per real fetch) — never in refetchInterval, which React may
  // evaluate multiple times per fetch and would make the ladder nondeterministic.
  const backoffRef = useRef<{ backoffStartedAtMs: number | null; backoffFetchCount: number }>({
    backoffStartedAtMs: null,
    backoffFetchCount: 0,
  });

  const query = useQuery<ReadinessResponse>({
    queryKey: ['imports', 'readiness'],
    queryFn: async () => {
      const response = await apiClient.get<ReadinessResponse>('/imports/readiness');
      const data = response.data;

      const state = backoffRef.current;
      if (data.tier1 && !data.tier2) {
        if (state.backoffStartedAtMs === null) {
          state.backoffStartedAtMs = Date.now();
          state.backoffFetchCount = 0;
        } else {
          state.backoffFetchCount += 1;
        }
      } else {
        state.backoffStartedAtMs = null;
        state.backoffFetchCount = 0;
      }

      return data;
    },
    staleTime: READINESS_STALE_TIME_MS,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.tier2) return false;
      if (!data || !data.tier1) return READINESS_POLL_INTERVAL_MS;

      const state = backoffRef.current;
      const lastIndex = READINESS_BACKOFF_LADDER_MS.length - 1;
      const index = Math.min(state.backoffFetchCount, lastIndex);
      const candidate = READINESS_BACKOFF_LADDER_MS[index] ?? READINESS_BACKOFF_LADDER_MS[lastIndex];
      if (candidate === undefined) return false;

      const elapsed =
        state.backoffStartedAtMs === null ? 0 : Date.now() - state.backoffStartedAtMs;
      if (elapsed + candidate > READINESS_BACKOFF_BUDGET_MS) return false;

      return candidate;
    },
  });

  return {
    tier1: query.data?.tier1 ?? false,
    tier2: query.data?.tier2 ?? false,
    pendingCount: query.data?.pending_count ?? 0,
    totalCount: query.data?.total_count ?? 0,
    isLoading: query.isLoading,
  };
}
