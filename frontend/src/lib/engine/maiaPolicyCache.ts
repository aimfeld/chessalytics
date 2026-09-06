/**
 * maiaPolicyCache — a module-scoped, LRU, `fen|elo`-keyed cache of UCI-keyed
 * Maia move-probability distributions, shared by two consumers (Phase 194
 * CACHE-05):
 *
 *  - `maiaQueue.ts`'s `policy()` provider (the engine's root-position Maia
 *    call, one rung per FEN via `budget.elo[leaf.side]`).
 *  - `useMaiaEngine.ts`'s write-through: the exact selected-ELO rung first
 *    (quick 260906-gu2 — the rung the engine's root call needs), then all 21
 *    `MAIA_ELO_LADDER` rungs per navigated position.
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

/**
 * Quick 260906-gu2: in-flight registry. `useMaiaEngine` marks `(fen, elo)`
 * pending the moment it issues a worker request for it; `maiaQueue.policy()`
 * awaits that entry instead of issuing a SECOND inference for the same key.
 * Before this, every navigation cost the engine a duplicate ~200 ms root
 * inference on wasm — the chart's request was already queued ahead of it on
 * the shared worker, but the engine's `policy()` checked the cache before
 * that result landed. `setCachedPolicy` settles the entry; a failed request
 * must call `failPolicyPending` so waiters fall back to their own request.
 */
interface PendingPolicy {
  promise: Promise<Record<string, number>>;
  resolve: (policy: Record<string, number>) => void;
  reject: (err: Error) => void;
}

const pending = new Map<string, PendingPolicy>();

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
  const waiter = pending.get(key);
  if (waiter) {
    pending.delete(key);
    waiter.resolve(policy);
  }
}

/**
 * Registers `(fen, elo)` as in flight so a concurrent `getPendingPolicy`
 * reader can await it. No-op when the key is already cached or pending.
 */
export function markPolicyPending(fen: string, elo: number): void {
  const key = cacheKey(fen, elo);
  if (cache.has(key) || pending.has(key)) return;
  let resolve: PendingPolicy['resolve'] = () => undefined;
  let reject: PendingPolicy['reject'] = () => undefined;
  const promise = new Promise<Record<string, number>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A pending entry nobody awaits must not surface as an unhandled rejection
  // when its request fails — readers attach their own handlers via
  // `getPendingPolicy`.
  promise.catch(() => undefined);
  pending.set(key, { promise, resolve, reject });
}

/** The in-flight promise for `(fen, elo)`, if a producer has marked it pending and not yet settled it. */
export function getPendingPolicy(fen: string, elo: number): Promise<Record<string, number>> | undefined {
  return pending.get(cacheKey(fen, elo))?.promise;
}

/** Settles a pending `(fen, elo)` with a rejection (the producing request failed); no-op if not pending. */
export function failPolicyPending(fen: string, elo: number, err: Error): void {
  const key = cacheKey(fen, elo);
  const waiter = pending.get(key);
  if (!waiter) return;
  pending.delete(key);
  waiter.reject(err);
}

/** Empties the shared cache and the pending registry — for test isolation across a module-scoped singleton. */
export function clearMaiaPolicyCache(): void {
  cache.clear();
  const abandoned = Array.from(pending.values());
  pending.clear();
  for (const entry of abandoned) entry.reject(new Error('maiaPolicyCache cleared'));
}
