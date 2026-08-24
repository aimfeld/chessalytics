import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

import { apiClient } from '@/api/client';
import { Button } from '@/components/ui/button';
import { LoadError } from '@/components/ui/load-error';
import type { ActivityStatsPayload } from '@/types/activity';

async function fetchActivityStats(refresh: boolean): Promise<ActivityStatsPayload> {
  const { data } = await apiClient.get<ActivityStatsPayload>('/admin/activity/stats', {
    params: refresh ? { refresh: 1 } : undefined,
  });
  return data;
}

/**
 * Superuser-only Activity Pulse page (Quick 260824-qaz).
 *
 * Task 1 tracer: proves the auth gate, the read-only engine, the 300s
 * server-side cache, the route, and the nav wiring end-to-end with the
 * smallest possible render — the tracked day range and a live generated-at
 * timestamp. Tasks 2-3 port the full dashboard (charts, stylesheet) onto this
 * same query without touching the auth/fetch plumbing built here.
 *
 * Not wrapped in a padded/max-width container — ProtectedLayout's
 * `<main className="pb-16 sm:pb-0">` is unpadded, which Task 2-3's ported
 * layout (and its `check_layout.mjs` width model) depends on staying true.
 */
export default function ActivityPage() {
  // D-6: the hosted page never polls. queryFn reads this ref instead of a
  // second variable in the query key, so "Refresh now" can force a
  // server-side cache bypass (?refresh=1) via the SAME refetch() call
  // TanStack Query already exposes, rather than a parallel fetch path.
  const forceRefreshRef = useRef(false);

  const { data, isPending, isError, refetch, isFetching } = useQuery({
    queryKey: ['activity-stats'],
    queryFn: () => {
      const refresh = forceRefreshRef.current;
      forceRefreshRef.current = false;
      return fetchActivityStats(refresh);
    },
    // Pinned explicitly (not left to queryClient's 30s default) so a future
    // change to those defaults can never reintroduce a poll on this page —
    // data is fetched once on mount and again only on an explicit click.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });

  const handleRefresh = () => {
    forceRefreshRef.current = true;
    void refetch();
  };

  const firstDay = data?.days[0];
  const lastDay = data && data.days.length > 0 ? data.days[data.days.length - 1] : undefined;

  return (
    <main data-testid="activity-page" className="activity-dash">
      <div className="mx-auto w-full max-w-7xl space-y-3 px-4 py-6 md:px-6">
        {isPending && (
          <p className="text-sm text-muted-foreground">Loading activity stats…</p>
        )}
        {isError && <LoadError resource="activity stats" />}
        {data && (
          <>
            <p className="text-sm text-foreground">
              Day range: {firstDay ?? '—'} to {lastDay ?? '—'}
            </p>
            <p className="text-sm text-muted-foreground">
              Generated at: {new Date(data.generated_at).toLocaleString()}
            </p>
          </>
        )}
        <Button
          type="button"
          variant="brand-outline"
          data-testid="btn-activity-refresh"
          onClick={handleRefresh}
          disabled={isFetching}
        >
          Refresh now
        </Button>
      </div>
    </main>
  );
}
