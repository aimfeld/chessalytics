/**
 * maiaPolicyCache — a module-scoped, LRU, `fen|elo`-keyed cache of UCI-keyed
 * Maia move-probability distributions, shared by two consumers (Phase 194
 * CACHE-05):
 *
 *  - `maiaQueue.ts`'s `policy()` provider (the engine's root-position Maia
 *    call, one rung per FEN via `budget.elo[leaf.side]`).
 *  - `useMaiaEngine.ts`'s Moves-by-Rating chart write-through (all 21
 *    `MAIA_ELO_LADDER` rungs per navigated position).
 *
 * Module-scoped by design: it outlives any single `createMaiaQueue()`
 * instance, so a position the chart already inferred stays available to the
 * engine across re-renders/re-mounts of the hook that produced it. The key
 * construction (`${fen}|${elo}`) is intentionally private to this module —
 * `elo` is a required, separate parameter on both accessors, so no caller can
 * build a FEN-only key that would silently serve one ELO rung's distribution
 * for another (T-194-07).
 */

/**
 * `fen|elo` policy-cache cap. The engine's `policy()` call contributes at
 * most one entry per distinct FEN (side-to-move is fixed per FEN, and the
 * engine calls `providers.policy(leaf.fen, budget.elo[leaf.side], leaf.side)`
 * — one ELO per FEN) — bounded above by the same measured 386-FEN working
 * set a 400-node analysis search touches (194-RESEARCH.md Pattern 4). The
 * chart's write-through additionally contributes 21 entries (one per
 * `MAIA_ELO_LADDER` rung) per navigated position. 2048 - 386 leaves roughly
 * 79 navigated positions of chart history. At an estimated ~2 KB per entry (a
 * `Record<string, number>` over ~30-40 legal moves) the cap costs ~4 MB
 * against Maia's ~226 MB WASM heap (Phase 194 CACHE-01).
 */
export const MAIA_POLICY_CACHE_MAX = 2048;

const cache = new Map<string, Record<string, number>>();

function cacheKey(fen: string, elo: number): string {
  return `${fen}|${elo}`;
}

/**
 * Looks up a UCI-keyed Maia policy distribution for `(fen, elo)`. On a hit,
 * performs the LRU touch (delete then re-insert) so Map's insertion-order
 * iteration — consumed by `setCachedPolicy`'s `keys().next().value` eviction
 * — yields the least-recently-USED entry, not the least-recently-inserted
 * one (Phase 194 CACHE-02).
 */
export function getCachedPolicy(fen: string, elo: number): Record<string, number> | undefined {
  const key = cacheKey(fen, elo);
  const cached = cache.get(key);
  if (cached === undefined) return undefined;
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

/** Stores a UCI-keyed Maia policy distribution for `(fen, elo)`, evicting the least-recently-used entry past `MAIA_POLICY_CACHE_MAX`. */
export function setCachedPolicy(fen: string, elo: number, policy: Record<string, number>): void {
  const key = cacheKey(fen, elo);
  // Phase 194 code-review WR-01: a write is a use. `Map.set` on an ALREADY
  // PRESENT key does not reorder it, so without this delete the entry keeps
  // its original insertion position and the eviction below picks it as if the
  // cache were still FIFO — silently defeating CACHE-02 for re-written keys.
  cache.delete(key);
  cache.set(key, policy);
  if (cache.size > MAIA_POLICY_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Empties the shared cache — for test isolation across a module-scoped singleton. */
export function clearMaiaPolicyCache(): void {
  cache.clear();
}
