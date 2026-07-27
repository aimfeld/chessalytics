import { useQuery } from '@tanstack/react-query';
import { trainApi } from '@/api/client';
import type { TrainProgressResponse } from '@/types/train';

/**
 * The shared query key for GET /train/progress (Phase 191 Plan 01,
 * PROG-01/PROG-04). Load-bearing: the Plan 05 nav badge reads the SAME key
 * so TanStack Query dedupes both consumers to one in-flight request.
 */
export const TRAIN_PROGRESS_QUERY_KEY = ['train', 'progress'] as const;

/**
 * GET /train/progress — the D-18 settled streak, this-week tally, and
 * honest mastered/parked counts.
 *
 * Uses the global queryClient defaults (staleTime 30s, retry 1) — no
 * custom `refetchInterval`, no polling (RESEARCH Open Question 2: a
 * schedule becoming due at midnight surfaces on the next focus/navigation
 * refetch, not live).
 *
 * `options.enabled` (Plan 05) lets the nav badge call sites gate the
 * request off entirely for guests and locked-nav accounts, so an expected
 * 403/401-adjacent failure never fires and never reaches the global
 * `QueryCache.onError` Sentry reporter (T-191-21).
 */
export function useTrainProgress(options?: { enabled?: boolean }) {
  return useQuery<TrainProgressResponse>({
    queryKey: TRAIN_PROGRESS_QUERY_KEY,
    queryFn: trainApi.getProgress,
    enabled: options?.enabled ?? true,
  });
}
