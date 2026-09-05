import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * Total count of the user's imported games, across ALL platforms — including
 * `flawchess` (bot-practice) and `pgn` (pasted) rows. This is deliberate
 * (SEED-163 2d): a user whose only games are bot games must read "You have N
 * games", not "You have 0 games", in the empty state that appears once the
 * analytics defaults flip to Human + Rated.
 *
 * Shared `['gameCount']` query key so Openings, Endgames and GlobalStats all
 * hit the same cached request instead of issuing three independent fetches.
 * Extracted from the query previously inlined in Openings.tsx.
 */
export function useGameCount() {
  return useQuery<{ count: number }>({
    queryKey: ['gameCount'],
    queryFn: async () => {
      const response = await apiClient.get<{ count: number }>('/users/games/count');
      return response.data;
    },
    staleTime: 30_000,
  });
}

/**
 * Convenience wrapper returning just the count (or null while loading/absent).
 * Hides the `data?.count ?? null` derivation in its own function so callers
 * near an eslint `complexity` per-file baseline (Endgames.tsx, GlobalStats.tsx
 * — SEED-163 2d) don't pick up the optional-chain/nullish-coalescing branches
 * inline in an already-at-cap page component.
 */
export function useGameCountValue(): number | null {
  const { data } = useGameCount();
  return data ? data.count : null;
}
