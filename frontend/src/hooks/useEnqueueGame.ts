import { useMutation, useQueryClient, type UseMutationResult, type QueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { EnqueueTier1Response } from '@/types/api';

/** Shared request — both hooks below POST the same endpoint, just with the
 * game id bound at a different time (hook-construction vs mutate-time). */
async function postTier1Enqueue(gameId: number): Promise<EnqueueTier1Response> {
  const response = await apiClient.post<EnqueueTier1Response>(`/imports/eval/tier1/${gameId}`);
  return response.data;
}

/**
 * Shared onSuccess invalidation for a tier-1 enqueue — the coverage badge
 * updates within one render cycle without waiting for the 3s poll
 * (RESEARCH.md Pitfall 5), and any cached library card (list or single-game)
 * refetches so it picks up the new active_eval_status (prefix match covers
 * every param variant, including a specific ['library-game', gameId] entry).
 *
 * Exported (Phase 208) so usePasteGame.useSavePastedGame reuses the exact
 * same query-key list instead of duplicating it — the paste-save endpoint
 * performs save + tier-1 enqueue in one call, so it needs this same
 * invalidation without a second round-trip mutation.
 */
export function invalidateAfterTier1Enqueue(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['imports', 'eval-coverage'] });
  void queryClient.invalidateQueries({ queryKey: ['library-games'] });
  void queryClient.invalidateQueries({ queryKey: ['library-game'] });
}

/**
 * Mutation to enqueue a single game for Stockfish full eval (tier-1, user-triggered).
 *
 * The game id is bound at HOOK-CONSTRUCTION time — use this when the id is
 * already known when the component mounts (e.g. a library card). For a
 * surface that only learns the id later (the bot-result Analyze CTA, which
 * needs the server-assigned id from a finish-time store POST), use
 * `useTier1EnqueueForGame` instead.
 *
 * @param gameId - the game to enqueue
 */
export function useTier1Enqueue(
  gameId: number,
): UseMutationResult<EnqueueTier1Response, Error, void> {
  const queryClient = useQueryClient();
  return useMutation<EnqueueTier1Response, Error, void>({
    mutationFn: () => postTier1Enqueue(gameId),
    onSuccess: () => invalidateAfterTier1Enqueue(queryClient),
  });
}

/**
 * Quick 260714-rj5: mutate-time variant of `useTier1Enqueue` — the game id is
 * the `.mutate(gameId)` argument rather than bound at hook-construction time.
 * `useTier1Enqueue(gameId)` cannot serve a caller whose game id only exists
 * after an earlier async step resolves (Bots.tsx's Analyze CTA: the id comes
 * from the finish-time `useStoreBotGame()` response).
 */
export function useTier1EnqueueForGame(): UseMutationResult<EnqueueTier1Response, Error, number> {
  const queryClient = useQueryClient();
  return useMutation<EnqueueTier1Response, Error, number>({
    mutationFn: (gameId: number) => postTier1Enqueue(gameId),
    onSuccess: () => invalidateAfterTier1Enqueue(queryClient),
  });
}
