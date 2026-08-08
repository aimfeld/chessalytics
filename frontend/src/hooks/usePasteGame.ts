import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { SavePastedGameRequest, SavePastedGameResponse } from '@/types/api';
import { invalidateAfterTier1Enqueue } from '@/hooks/useEnqueueGame';

async function postSavePastedGame(
  request: SavePastedGameRequest,
): Promise<SavePastedGameResponse> {
  const response = await apiClient.post<SavePastedGameResponse>('/imports/paste', request);
  return response.data;
}

/**
 * Mutation for "Analyze full game" (Phase 208, PASTE-04). The endpoint
 * performs save + tier-1 enqueue in one call (no id-then-enqueue chain like
 * useTier1EnqueueForGame needs), so onSuccess reuses the same invalidation
 * list a tier-1 enqueue triggers.
 *
 * No manual Sentry capture here — TanStack Query mutation errors are already
 * reported globally by MutationCache.onError in queryClient.ts; a second
 * capture here would double-report.
 */
export function useSavePastedGame(): UseMutationResult<
  SavePastedGameResponse,
  Error,
  SavePastedGameRequest
> {
  const queryClient = useQueryClient();
  return useMutation<SavePastedGameResponse, Error, SavePastedGameRequest>({
    mutationFn: postSavePastedGame,
    onSuccess: () => invalidateAfterTier1Enqueue(queryClient),
  });
}
