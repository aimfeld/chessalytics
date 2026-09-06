// @vitest-environment jsdom
/**
 * useMaiaEngine unit tests, driven via a mocked `maiaWorkerHost` lease
 * (quick 260729-sod, FIX 3 — this hook no longer constructs a Worker
 * directly; it acquires a lease from the shared host).
 *
 * Behaviors verified (151-04-PLAN.md Task 3, + FIX 3 rewiring):
 * 1. Idle (no lease) until enabled.
 * 2. Lease acquisition with source 'maia-worker' and the requested priority.
 * 3. isReady flips false->true once the lease's whenReady() resolves.
 * 4. Adaptive debounce: settled FEN fires analyze with the exact selectedElo rung first
 *    (quick 260906-gu2 two-phase ladder), then the remaining ladder rungs.
 * 5. Rapid successive FEN changes coalesce to one analyze for the final FEN.
 * 6. Stale-result discard: a result for a superseded FEN is ignored.
 * 7. Cache hit for a previously-seen FEN skips a second lease round-trip.
 * 8. Tab-hide pause: no analyze while hidden; re-analyzes on visible.
 * 9. Unmount releases the lease.
 * 10. wdl / expectedScoreAtSelectedElo derive from the ladder rung nearest selectedElo.
 * 11. onFatal (worker death, quick 260729-sod FIX 3) sets hasFailed and resets isReady.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMaiaEngine } from '../useMaiaEngine';
import { MAIA_ELO_LADDER, POLICY_VOCAB_SIZE } from '../../lib/maiaEncoding';
import { acquireMaiaWorker } from '../../lib/engine/maiaWorkerHost';
import type { AcquireMaiaWorkerOptions, MaiaAnalyzeResult, MaiaWorkerLease } from '../../lib/engine/maiaWorkerHost';
import { getCachedPolicy, getPendingPolicy, clearMaiaPolicyCache } from '../../lib/engine/maiaPolicyCache';

vi.mock('../../lib/engine/maiaWorkerHost', () => ({
  acquireMaiaWorker: vi.fn(),
}));

// ─── Fake lease ────────────────────────────────────────────────────────────

interface FakeAnalyzeCall {
  fen: string;
  eloInputs: number[];
  resolve: (result: MaiaAnalyzeResult) => void;
  reject: (err: Error) => void;
}

class FakeLease implements MaiaWorkerLease {
  analyzeCalls: FakeAnalyzeCall[] = [];
  released = false;
  opts: AcquireMaiaWorkerOptions;
  private readyResolve: ((backend: 'webgpu' | 'wasm') => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  constructor(opts: AcquireMaiaWorkerOptions) {
    this.opts = opts;
  }

  analyze(fen: string, eloInputs: number[]): Promise<MaiaAnalyzeResult> {
    return new Promise<MaiaAnalyzeResult>((resolve, reject) => {
      this.analyzeCalls.push({ fen, eloInputs, resolve, reject });
    });
  }

  whenReady(): Promise<'webgpu' | 'wasm'> {
    return new Promise<'webgpu' | 'wasm'>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  getBackend(): 'webgpu' | 'wasm' | null {
    return null;
  }

  release(): void {
    this.released = true;
  }

  simulateReady(backend: 'webgpu' | 'wasm' = 'wasm'): void {
    this.readyResolve?.(backend);
  }

  simulateFatal(): void {
    this.opts.onFatal?.();
  }

  latestAnalyzeCall(): FakeAnalyzeCall | undefined {
    return this.analyzeCalls[this.analyzeCalls.length - 1];
  }
}

let currentLease: FakeLease;

function stubHost(): void {
  vi.mocked(acquireMaiaWorker).mockImplementation((opts: AcquireMaiaWorkerOptions) => {
    currentLease = new FakeLease(opts);
    return currentLease;
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const TEST_FEN_2 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1';

async function driveReady(lease: FakeLease): Promise<void> {
  await act(async () => {
    lease.simulateReady('wasm');
    await Promise.resolve();
  });
}

function analyzeMessages(lease: FakeLease): { fen: string; eloInputs: number[] }[] {
  return lease.analyzeCalls.map((c) => ({ fen: c.fen, eloInputs: c.eloInputs }));
}

/** Builds a synthetic host analyze() result for the given FEN (all-zero logits). */
function buildResultMessage(fen: string, elos: readonly number[] = MAIA_ELO_LADDER): MaiaAnalyzeResult {
  const rawPolicyByElo = elos.map((elo) => ({
    elo,
    policy: new Float32Array(POLICY_VOCAB_SIZE),
  }));
  const wdlByElo = elos.map((elo) => ({ elo, wdl: Float32Array.from([0, 0, 0]) }));
  return { fen, rawPolicyByElo, wdlByElo, backend: 'wasm' };
}

/** Resolves the latest analyze() call with a synthetic result, flushing the resulting microtask. */
async function resolveLatest(lease: FakeLease, fen: string): Promise<void> {
  await act(async () => {
    lease.latestAnalyzeCall()?.resolve(buildResultMessage(fen));
    await Promise.resolve();
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('useMaiaEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    stubHost();
    // The shared policy cache is a module-scoped singleton (Phase 194
    // CACHE-05) — clear it so no test in this file leaks state.
    clearMaiaPolicyCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('does not acquire a lease until enabled', () => {
    renderHook(() => useMaiaEngine({ fen: null, enabled: false, selectedElo: 1500 }));
    expect(acquireMaiaWorker).not.toHaveBeenCalled();
  });

  it('acquires a lease with source maia-worker and priority=true by default when enabled', () => {
    renderHook(() => useMaiaEngine({ fen: null, enabled: true, selectedElo: 1500 }));
    expect(acquireMaiaWorker).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'maia-worker', priority: true }),
    );
  });

  it('honors priority: false (e.g. useGemSweep, quick 260729-sod FIX 3)', () => {
    renderHook(() => useMaiaEngine({ fen: null, enabled: true, selectedElo: 1500, priority: false }));
    expect(acquireMaiaWorker).toHaveBeenCalledWith(expect.objectContaining({ priority: false }));
  });

  it('isReady flips false->true once whenReady() resolves', async () => {
    const { result } = renderHook(() => useMaiaEngine({ fen: null, enabled: true, selectedElo: 1500 }));
    expect(result.current.isReady).toBe(false);
    await driveReady(currentLease);
    expect(result.current.isReady).toBe(true);
  });

  it('settled FEN fires analyze with the exact selectedElo rung first (quick 260906-gu2), then the remaining ladder', async () => {
    vi.advanceTimersByTime(200); // Date.now() >> 0 so the first FEN is a "settled move".
    const { result } = renderHook(() => useMaiaEngine({ fen: TEST_FEN, enabled: true, selectedElo: 1550 }));
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    let msgs = analyzeMessages(currentLease);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.fen).toBe(TEST_FEN);
    expect(msgs[0]?.eloInputs).toEqual([1550]);
    // The exact rung is registered as pending so maiaQueue.policy() can await it.
    expect(getPendingPolicy(TEST_FEN, 1550)).toBeInstanceOf(Promise);
    expect(result.current.isAnalyzing).toBe(true);

    // Phase 1 lands: wdl is available, the chart (perElo) is still empty.
    await act(async () => {
      currentLease.latestAnalyzeCall()?.resolve(buildResultMessage(TEST_FEN, [1550]));
      await Promise.resolve();
    });
    expect(result.current.wdl).not.toBeNull();
    expect(result.current.resultFen).toBe(TEST_FEN);
    expect(result.current.perElo).toHaveLength(0);
    expect(getPendingPolicy(TEST_FEN, 1550)).toBeUndefined();
    expect(getCachedPolicy(TEST_FEN, 1550)).toBeDefined();

    // Phase 3 (no prefetchFen given): every ladder rung, nothing already held.
    msgs = analyzeMessages(currentLease);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]?.fen).toBe(TEST_FEN);
    expect(msgs[1]?.eloInputs).toEqual(MAIA_ELO_LADDER);
    expect(result.current.isAnalyzing).toBe(true);

    await resolveLatest(currentLease, TEST_FEN);
    expect(result.current.perElo.length).toBe(MAIA_ELO_LADDER.length);
    expect(result.current.isAnalyzing).toBe(false);
    expect(analyzeMessages(currentLease)).toHaveLength(2);
  });

  it('a selectedElo that IS a ladder rung is excluded from the ladder request (already held)', async () => {
    vi.advanceTimersByTime(200);
    renderHook(() => useMaiaEngine({ fen: TEST_FEN, enabled: true, selectedElo: 1500 }));
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(analyzeMessages(currentLease)[0]?.eloInputs).toEqual([1500]);
    await act(async () => {
      currentLease.latestAnalyzeCall()?.resolve(buildResultMessage(TEST_FEN, [1500]));
      await Promise.resolve();
    });
    const ladderMsg = analyzeMessages(currentLease)[1];
    expect(ladderMsg?.eloInputs).toEqual(MAIA_ELO_LADDER.filter((elo) => elo !== 1500));
  });

  it('prefetchFen: the next ply\'s exact rung is inferred between phase 1 and the ladder, and stepping onto it is a cache hit', async () => {
    vi.advanceTimersByTime(200);
    const { rerender, result } = renderHook(
      ({ fen, prefetchFen }: { fen: string; prefetchFen: string }) =>
        useMaiaEngine({ fen, enabled: true, selectedElo: 1550, prefetchFen }),
      { initialProps: { fen: TEST_FEN, prefetchFen: TEST_FEN_2 } },
    );
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(analyzeMessages(currentLease)).toEqual([{ fen: TEST_FEN, eloInputs: [1550] }]);

    await act(async () => {
      currentLease.latestAnalyzeCall()?.resolve(buildResultMessage(TEST_FEN, [1550]));
      await Promise.resolve();
    });
    // Prefetch is NOT a live request — isAnalyzing stays false while it runs.
    expect(analyzeMessages(currentLease)[1]).toEqual({ fen: TEST_FEN_2, eloInputs: [1550] });
    expect(result.current.isAnalyzing).toBe(false);
    expect(getPendingPolicy(TEST_FEN_2, 1550)).toBeInstanceOf(Promise);

    await act(async () => {
      currentLease.latestAnalyzeCall()?.resolve(buildResultMessage(TEST_FEN_2, [1550]));
      await Promise.resolve();
    });
    // The prefetch result is cached (policy cache too) but never painted for the live position.
    expect(result.current.resultFen).toBe(TEST_FEN);
    expect(getCachedPolicy(TEST_FEN_2, 1550)).toBeDefined();
    // Then the live position's ladder.
    expect(analyzeMessages(currentLease)[2]).toEqual({ fen: TEST_FEN, eloInputs: MAIA_ELO_LADDER });
    expect(result.current.isAnalyzing).toBe(true);
    await resolveLatest(currentLease, TEST_FEN);

    // Step forward: wdl for TEST_FEN_2 is available on the very next commit, no exact-rung request.
    rerender({ fen: TEST_FEN_2, prefetchFen: TEST_FEN });
    expect(result.current.resultFen).toBe(TEST_FEN_2);
    expect(result.current.wdl).not.toBeNull();
    expect(result.current.perElo).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // TEST_FEN's ladder is complete, so no prefetch for it — straight to TEST_FEN_2's ladder.
    const msgs = analyzeMessages(currentLease);
    expect(msgs).toHaveLength(4);
    expect(msgs[3]).toEqual({ fen: TEST_FEN_2, eloInputs: MAIA_ELO_LADDER });
  });

  it('ladderOnly: true requests the plain full ladder in one batch and never prefetches (gem sweep contract)', async () => {
    vi.advanceTimersByTime(200);
    const { result } = renderHook(() =>
      useMaiaEngine({ fen: TEST_FEN, enabled: true, selectedElo: 1550, prefetchFen: TEST_FEN_2, ladderOnly: true }),
    );
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(analyzeMessages(currentLease)).toEqual([{ fen: TEST_FEN, eloInputs: MAIA_ELO_LADDER }]);
    await resolveLatest(currentLease, TEST_FEN);
    expect(result.current.perElo.length).toBe(MAIA_ELO_LADDER.length);
    expect(analyzeMessages(currentLease)).toHaveLength(1);
  });

  it('a FEN change while the exact rung is in flight re-plans for the new position instead of finishing the old ladder', async () => {
    vi.advanceTimersByTime(200);
    const { rerender } = renderHook(
      ({ fen }: { fen: string }) => useMaiaEngine({ fen, enabled: true, selectedElo: 1550 }),
      { initialProps: { fen: TEST_FEN } },
    );
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(analyzeMessages(currentLease)).toEqual([{ fen: TEST_FEN, eloInputs: [1550] }]);

    rerender({ fen: TEST_FEN_2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(analyzeMessages(currentLease)).toHaveLength(1); // single in flight — nothing queued

    await act(async () => {
      currentLease.latestAnalyzeCall()?.resolve(buildResultMessage(TEST_FEN, [1550]));
      await Promise.resolve();
    });
    const msgs = analyzeMessages(currentLease);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toEqual({ fen: TEST_FEN_2, eloInputs: [1550] });
  });

  it('a rejected request fails its pending policy entries so an awaiting maiaQueue.policy() can fall back', async () => {
    vi.advanceTimersByTime(200);
    renderHook(() => useMaiaEngine({ fen: TEST_FEN, enabled: true, selectedElo: 1550 }));
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    const waiter = getPendingPolicy(TEST_FEN, 1550);
    expect(waiter).toBeInstanceOf(Promise);
    await act(async () => {
      currentLease.latestAnalyzeCall()?.reject(new Error('worker died'));
      await Promise.resolve();
    });
    await expect(waiter).rejects.toThrow('worker died');
    expect(getPendingPolicy(TEST_FEN, 1550)).toBeUndefined();
  });

  it('rapid successive FEN changes coalesce — only the final FEN is analyzed', async () => {
    const { rerender } = renderHook(
      ({ fen }: { fen: string }) => useMaiaEngine({ fen, enabled: true, selectedElo: 1500 }),
      { initialProps: { fen: TEST_FEN } },
    );
    await driveReady(currentLease);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(140); // before the 150ms debounce fires
    });
    rerender({ fen: TEST_FEN_2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    const msgs = analyzeMessages(currentLease);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.fen).toBe(TEST_FEN_2);
  });

  it('discards a stale result whose fen no longer matches the current position', async () => {
    const { rerender, result } = renderHook(
      ({ fen }: { fen: string }) => useMaiaEngine({ fen, enabled: true, selectedElo: 1500 }),
      { initialProps: { fen: TEST_FEN } },
    );
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current.isAnalyzing).toBe(true);
    const staleCall = currentLease.latestAnalyzeCall();

    // FEN changes (immediate-fire path — sinceLast > 150ms) before TEST_FEN's result arrives.
    rerender({ fen: TEST_FEN_2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // Stale result for the OLD fen arrives — must be discarded.
    await act(async () => {
      staleCall?.resolve(buildResultMessage(TEST_FEN));
      await Promise.resolve();
    });
    expect(result.current.perElo).toHaveLength(0);
  });

  it('a cache hit for a previously-seen FEN skips a second lease round-trip', async () => {
    const { rerender, result } = renderHook(
      ({ fen }: { fen: string }) => useMaiaEngine({ fen, enabled: true, selectedElo: 1500 }),
      { initialProps: { fen: TEST_FEN } },
    );
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await resolveLatest(currentLease, TEST_FEN);
    expect(result.current.perElo.length).toBe(MAIA_ELO_LADDER.length);

    const countBefore = analyzeMessages(currentLease).length;

    // Navigate away, then back to TEST_FEN (now cached).
    rerender({ fen: TEST_FEN_2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    rerender({ fen: TEST_FEN });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // Only ONE new analyze was sent (for TEST_FEN_2) — the TEST_FEN revisit is a cache hit.
    expect(analyzeMessages(currentLease)).toHaveLength(countBefore + 1);
    expect(result.current.perElo.length).toBe(MAIA_ELO_LADDER.length);
  });

  it('restores the cached curve when a rapid scrub lands back on the current position', async () => {
    // Regression: a rapid slider scrub away and straight back to the current
    // position used to no-op the analyze trigger (identical debounced FEN) while
    // still clearing the curve, leaving the chart blank and the eval bar at 50%.
    vi.advanceTimersByTime(200); // make the first FEN settle immediately
    const { rerender, result } = renderHook(
      ({ fen }: { fen: string }) => useMaiaEngine({ fen, enabled: true, selectedElo: 1500 }),
      { initialProps: { fen: TEST_FEN } },
    );
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // TEST_FEN analyzed and cached.
    await resolveLatest(currentLease, TEST_FEN);
    expect(result.current.perElo.length).toBe(MAIA_ELO_LADDER.length);

    // Scrub away and straight back inside the debounce window so the intermediate
    // FEN never commits — the final FEN equals the last-committed one.
    rerender({ fen: TEST_FEN_2 });
    rerender({ fen: TEST_FEN });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // The cached TEST_FEN curve is restored, not stuck empty (empty => 50% bar).
    expect(result.current.perElo.length).toBe(MAIA_ELO_LADDER.length);
  });

  it('keeps one inference in flight and converges to the current position on completion', async () => {
    // A slider drag settling while an earlier position is still computing must not
    // queue a backlog behind the running inference — instead the worker jumps
    // straight to the current position once it frees up (skipping intermediates).
    vi.advanceTimersByTime(200); // first FEN settles immediately
    const { rerender } = renderHook(
      ({ fen }: { fen: string }) => useMaiaEngine({ fen, enabled: true, selectedElo: 1500 }),
      { initialProps: { fen: TEST_FEN } },
    );
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // TEST_FEN is analyzing (worker "busy"), no result yet.
    expect(analyzeMessages(currentLease)).toHaveLength(1);

    // Move to a new settled position while TEST_FEN is still in flight.
    rerender({ fen: TEST_FEN_2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // No second request queued behind the running one.
    expect(analyzeMessages(currentLease)).toHaveLength(1);

    // TEST_FEN result lands -> worker free -> analyze the current FEN (TEST_FEN_2).
    await resolveLatest(currentLease, TEST_FEN);
    const msgs = analyzeMessages(currentLease);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]?.fen).toBe(TEST_FEN_2);
  });

  it('does not analyze while hidden; analyzes the current FEN on visible', async () => {
    // Start hidden so analyze() bails and nothing is left in flight — this lets us
    // assert the single-inference guard does not swallow the on-visible analyze.
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
      writable: true,
    });
    vi.advanceTimersByTime(200); // Date.now() >> 0 so the first FEN settles immediately.
    renderHook(() => useMaiaEngine({ fen: TEST_FEN, enabled: true, selectedElo: 1500 }));
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // Hidden: the debounce committed but analyze() bailed — no round-trip.
    expect(analyzeMessages(currentLease)).toHaveLength(0);

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
        writable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // On return the current FEN is analyzed.
    expect(analyzeMessages(currentLease)).toHaveLength(1);
    expect(analyzeMessages(currentLease)[0]?.fen).toBe(TEST_FEN);
  });

  it('resultFen reports the FEN the held curve belongs to, and clears with it (163-REVIEW WR-03)', async () => {
    vi.advanceTimersByTime(200); // first FEN settles immediately
    const { rerender, result } = renderHook(
      ({ fen }: { fen: string }) => useMaiaEngine({ fen, enabled: true, selectedElo: 1500 }),
      { initialProps: { fen: TEST_FEN } },
    );
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // No result held yet — no FEN to attribute.
    expect(result.current.resultFen).toBeNull();

    await resolveLatest(currentLease, TEST_FEN);
    expect(result.current.resultFen).toBe(TEST_FEN);

    // Navigating to an uncached FEN clears the curve AND its attribution —
    // per-FEN cache writers key on resultFen, never on their own position.
    rerender({ fen: TEST_FEN_2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current.perElo).toHaveLength(0);
    expect(result.current.resultFen).toBeNull();
  });

  it('unmount releases the lease (no leak)', () => {
    const { unmount } = renderHook(() => useMaiaEngine({ fen: null, enabled: true, selectedElo: 1500 }));
    const lease = currentLease;
    unmount();
    expect(lease.released).toBe(true);
  });

  it('wdl / expectedScoreAtSelectedElo derive from the ladder rung nearest selectedElo', async () => {
    const { result } = renderHook(() => useMaiaEngine({ fen: TEST_FEN, enabled: true, selectedElo: 1550 }));
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    const msg = buildResultMessage(TEST_FEN);
    // Give the 1500 rung (nearest to selectedElo=1550, ties broken toward the
    // lower/earlier rung) a clearly winning WDL logit set.
    msg.wdlByElo = msg.wdlByElo.map((entry) =>
      entry.elo === 1500 ? { ...entry, wdl: Float32Array.from([0, 0, 10]) } : entry,
    );
    await act(async () => {
      currentLease.latestAnalyzeCall()?.resolve(msg);
      await Promise.resolve();
    });

    expect(result.current.wdl?.win).toBeGreaterThan(0.9);
    expect(result.current.expectedScoreAtSelectedElo).toBeGreaterThan(0.9);
  });

  // ─── Shared fen|elo policy cache write-through (Phase 194 CACHE-05) ────────

  it('write-through populates the shared fen|elo policy cache with a UCI-keyed entry per ladder rung after a result commits', async () => {
    vi.advanceTimersByTime(200); // first FEN settles immediately
    renderHook(() => useMaiaEngine({ fen: TEST_FEN, enabled: true, selectedElo: 1500 }));
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await resolveLatest(currentLease, TEST_FEN);

    for (const elo of MAIA_ELO_LADDER) {
      const cached = getCachedPolicy(TEST_FEN, elo);
      expect(cached).toBeDefined();
      // Every key is a UCI-shaped move string (from-square + to-square,
      // optional promotion piece) — not a SAN string like 'Nf3', proving the
      // write-through used maskAndSoftmaxUci, not the chart's SAN-keyed
      // maskAndSoftmax output.
      for (const uci of Object.keys(cached!)) {
        expect(uci).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
      }
    }
  });

  it("a maiaQueue.policy() call issued after the chart populated a FEN resolves from the shared cache without a lease.analyze() call — proven via useMaiaEngine's write-through side", async () => {
    vi.advanceTimersByTime(200);
    renderHook(() => useMaiaEngine({ fen: TEST_FEN, enabled: true, selectedElo: 1500 }));
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await resolveLatest(currentLease, TEST_FEN);

    // The 1500 rung the chart just wrote is directly readable via the shared
    // module — this is the exact seam maiaQueue.policy() reads through (see
    // maiaQueue.test.ts's cross-consumer CACHE-05 assertion for the
    // zero-analyze-call proof on that side).
    expect(getCachedPolicy(TEST_FEN, 1500)).toBeDefined();
  });

  // ─── Disable-mid-inference cleanup (quick 260731-s0z, FIX-1) ───────────────

  it('a disable while an analyze is in flight, followed by re-enable, leaves a later uncached FEN analyzable again', async () => {
    vi.advanceTimersByTime(200); // first FEN settles immediately
    const { rerender, result } = renderHook(
      ({ fen, enabled }: { fen: string | null; enabled: boolean }) =>
        useMaiaEngine({ fen, enabled, selectedElo: 1500 }),
      { initialProps: { fen: TEST_FEN as string | null, enabled: true } },
    );
    await driveReady(currentLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // TEST_FEN is in flight on the first lease.
    const inFlightCall = currentLease.latestAnalyzeCall();
    expect(inFlightCall).toBeDefined();
    expect(result.current.isAnalyzing).toBe(true);

    // Disable mid-inference — the cleanup effect must reset the bookkeeping
    // even though the in-flight promise has not settled yet.
    rerender({ fen: TEST_FEN, enabled: false });
    // The rejection handler bails on `leaseRef.current !== lease` before it
    // can clear pendingFenRef itself — proving the fix lives in the cleanup,
    // not in the rejection handler.
    await act(async () => {
      inFlightCall?.reject(new Error('lease released'));
      await Promise.resolve();
    });
    expect(result.current.isAnalyzing).toBe(false);
    expect(result.current.isReady).toBe(false);

    // Re-enable AND navigate to an uncached FEN in the same commit (rather
    // than re-enabling on the SAME fen first) — deliberately avoids a
    // separate, legitimate same-FEN reissue-on-reconnect race that would
    // otherwise leave a genuine in-flight request for TEST_FEN sitting on
    // the new lease and confound this assertion. A brand-new lease is
    // acquired; without the fix, pendingFenRef is still stuck non-null from
    // before the disable and this analyze() is silently dropped at the
    // single-in-flight gate.
    rerender({ fen: TEST_FEN_2, enabled: true });
    const newLease = currentLease;
    expect(newLease).not.toBe(undefined);
    await driveReady(newLease);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    const msgs = analyzeMessages(newLease);
    expect(msgs.some((m) => m.fen === TEST_FEN_2)).toBe(true);
  });

  // ─── Worker death (quick 260729-sod, FIX 3 — onFatal replaces the old onerror handler) ──

  it('onFatal sets hasFailed and resets isReady', async () => {
    const { result } = renderHook(() => useMaiaEngine({ fen: null, enabled: true, selectedElo: 1500 }));
    await driveReady(currentLease);
    expect(result.current.isReady).toBe(true);

    act(() => {
      currentLease.simulateFatal();
    });

    expect(result.current.hasFailed).toBe(true);
    expect(result.current.isReady).toBe(false);
  });
});
