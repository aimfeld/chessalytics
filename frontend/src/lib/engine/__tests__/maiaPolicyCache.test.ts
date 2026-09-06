/**
 * maiaPolicyCache.ts unit tests — the shared, module-scoped, LRU `fen|elo`
 * policy cache (Phase 194 CACHE-01/02/05).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedPolicy,
  setCachedPolicy,
  clearMaiaPolicyCache,
  markPolicyPending,
  getPendingPolicy,
  failPolicyPending,
  MAIA_POLICY_CACHE_MAX,
} from '../maiaPolicyCache';

const FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const FEN_2 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1';

/** A valid, distinct FEN (only the fullmove counter varies) for capacity/LRU tests. */
function fenVariant(n: number): string {
  return `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 ${n + 1}`;
}

describe('maiaPolicyCache', () => {
  beforeEach(() => {
    clearMaiaPolicyCache();
  });

  it('getCachedPolicy returns undefined for a key never set', () => {
    expect(getCachedPolicy(FEN, 1500)).toBeUndefined();
  });

  it('getCachedPolicy returns the stored record for a key that was set', () => {
    const record = { e2e4: 0.6, d2d4: 0.4 };
    setCachedPolicy(FEN, 1500, record);
    expect(getCachedPolicy(FEN, 1500)).toEqual(record);
  });

  it('two different ELOs at the same FEN are two independent entries', () => {
    setCachedPolicy(FEN, 1200, { e2e4: 0.9 });
    setCachedPolicy(FEN, 2000, { d2d4: 0.9 });
    expect(getCachedPolicy(FEN, 1200)).toEqual({ e2e4: 0.9 });
    expect(getCachedPolicy(FEN, 2000)).toEqual({ d2d4: 0.9 });
    // A lookup at one ELO never returns the other's value.
    expect(getCachedPolicy(FEN, 1200)).not.toEqual({ d2d4: 0.9 });
  });

  it('the same ELO at two different FENs are two independent entries', () => {
    setCachedPolicy(FEN, 1500, { e2e4: 1 });
    setCachedPolicy(FEN_2, 1500, { d2d4: 1 });
    expect(getCachedPolicy(FEN, 1500)).toEqual({ e2e4: 1 });
    expect(getCachedPolicy(FEN_2, 1500)).toEqual({ d2d4: 1 });
  });

  it('clearMaiaPolicyCache() empties the cache', () => {
    setCachedPolicy(FEN, 1500, { e2e4: 1 });
    clearMaiaPolicyCache();
    expect(getCachedPolicy(FEN, 1500)).toBeUndefined();
  });

  // ─── Pending registry (quick 260906-gu2) ────────────────────────────────

  it('getPendingPolicy is undefined until a producer marks the key pending', () => {
    expect(getPendingPolicy(FEN, 1500)).toBeUndefined();
    markPolicyPending(FEN, 1500);
    expect(getPendingPolicy(FEN, 1500)).toBeInstanceOf(Promise);
    expect(getPendingPolicy(FEN, 1600)).toBeUndefined();
    expect(getPendingPolicy(FEN_2, 1500)).toBeUndefined();
  });

  it('setCachedPolicy resolves the pending promise with the stored policy and clears the pending entry', async () => {
    markPolicyPending(FEN, 1500);
    const waiter = getPendingPolicy(FEN, 1500);
    setCachedPolicy(FEN, 1500, { e2e4: 0.7, d2d4: 0.3 });
    await expect(waiter).resolves.toEqual({ e2e4: 0.7, d2d4: 0.3 });
    expect(getPendingPolicy(FEN, 1500)).toBeUndefined();
    expect(getCachedPolicy(FEN, 1500)).toEqual({ e2e4: 0.7, d2d4: 0.3 });
  });

  it('failPolicyPending rejects the pending promise and clears the entry; a later mark starts fresh', async () => {
    markPolicyPending(FEN, 1500);
    const waiter = getPendingPolicy(FEN, 1500);
    failPolicyPending(FEN, 1500, new Error('worker died'));
    await expect(waiter).rejects.toThrow('worker died');
    expect(getPendingPolicy(FEN, 1500)).toBeUndefined();
    markPolicyPending(FEN, 1500);
    expect(getPendingPolicy(FEN, 1500)).toBeInstanceOf(Promise);
  });

  it('markPolicyPending is a no-op for an already-cached or already-pending key', () => {
    setCachedPolicy(FEN, 1500, { e2e4: 1 });
    markPolicyPending(FEN, 1500);
    expect(getPendingPolicy(FEN, 1500)).toBeUndefined();

    markPolicyPending(FEN_2, 1500);
    const first = getPendingPolicy(FEN_2, 1500);
    markPolicyPending(FEN_2, 1500);
    expect(getPendingPolicy(FEN_2, 1500)).toBe(first);
  });

  it('failPolicyPending on a key that is not pending is a no-op', () => {
    expect(() => failPolicyPending(FEN, 1500, new Error('x'))).not.toThrow();
  });

  it('clearMaiaPolicyCache() rejects and drops pending entries too', async () => {
    markPolicyPending(FEN, 1500);
    const waiter = getPendingPolicy(FEN, 1500);
    clearMaiaPolicyCache();
    await expect(waiter).rejects.toThrow();
    expect(getPendingPolicy(FEN, 1500)).toBeUndefined();
  });

  it(
    'LRU (CACHE-01/02): filling to exactly MAIA_POLICY_CACHE_MAX evicts nothing; reading an entry then forcing one eviction spares it and evicts a never-read entry — fails under FIFO',
    () => {
      for (let i = 0; i < MAIA_POLICY_CACHE_MAX; i++) {
        setCachedPolicy(fenVariant(i), 1500, { e2e4: i });
      }
      // No eviction yet: the very first entry is still present.
      expect(getCachedPolicy(fenVariant(0), 1500)).toEqual({ e2e4: 0 });
      // Reading it above already touched it (MRU). Read it once more so the
      // assertion below is unambiguous even if a future refactor changes
      // getCachedPolicy's touch semantics.
      expect(getCachedPolicy(fenVariant(0), 1500)).toEqual({ e2e4: 0 });

      // One more distinct entry forces exactly one eviction.
      setCachedPolicy(fenVariant(MAIA_POLICY_CACHE_MAX), 1500, { e2e4: -1 });

      // fenVariant(0) was just touched -> must survive.
      expect(getCachedPolicy(fenVariant(0), 1500)).toEqual({ e2e4: 0 });
      // fenVariant(1) was never touched after its initial insert -> it is
      // the true least-recently-used entry and must have been evicted.
      // Under the previous FIFO implementation this assertion would fail,
      // because fenVariant(0) (inserted first) would have been evicted, not
      // fenVariant(1).
      expect(getCachedPolicy(fenVariant(1), 1500)).toBeUndefined();
    },
    15000,
  );

  it(
    'LRU (CACHE-02): a WRITE to an already-present key counts as a use — re-setting an entry spares it from the next eviction (fails when setCachedPolicy omits the delete-then-reinsert touch)',
    () => {
      for (let i = 0; i < MAIA_POLICY_CACHE_MAX; i++) {
        setCachedPolicy(fenVariant(i), 1500, { e2e4: i });
      }
      // Re-set (not read) the oldest entry. `Map.set` on an existing key does
      // NOT reorder it, so without an explicit delete-then-reinsert this write
      // leaves fenVariant(0) at the head of the eviction order.
      setCachedPolicy(fenVariant(0), 1500, { e2e4: 100 });

      // One more distinct entry forces exactly one eviction.
      setCachedPolicy(fenVariant(MAIA_POLICY_CACHE_MAX), 1500, { e2e4: -1 });

      // fenVariant(0) was just written -> most-recently-used -> must survive.
      expect(getCachedPolicy(fenVariant(0), 1500)).toEqual({ e2e4: 100 });
      // fenVariant(1) is now the true least-recently-used entry.
      expect(getCachedPolicy(fenVariant(1), 1500)).toBeUndefined();
    },
    15000,
  );
});
