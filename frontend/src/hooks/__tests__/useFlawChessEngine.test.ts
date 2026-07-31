// @vitest-environment jsdom
/**
 * useFlawChessEngine unit tests (Phase 155 Plan 02).
 *
 * `createWorkerPool`/`createMaiaQueue`/`mctsSearch` are mocked so the tests
 * control exactly when `onSnapshot` fires and can assert on the mocked
 * WorkerPool's `stopAll` (jsdom has no real Worker; follows Analysis.test.tsx's
 * existing grading-engine mock precedent). Fake timers drive the adaptive
 * FEN debounce and the onSnapshot throttle deterministically, mirroring
 * useStockfishEngine.test.ts's `vi.useFakeTimers({ now: 0 })` convention.
 *
 * Behaviors verified:
 * 1. Throttle (DISPLAY-01/D-09): the first onSnapshot commits near-instantly;
 *    a burst of subsequent snapshots within 150ms results in at most one
 *    additional trailing commit, of the LATEST snapshot only.
 * 2. Abort (Pitfall 1 regression guard): navigating to a new FEN aborts the
 *    previous run's AbortSignal AND calls the mocked pool's `stopAll` before
 *    a fresh mctsSearch call is issued.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { EngineSnapshot } from '@/lib/engine/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockGrade = vi.fn();
const mockStopAll = vi.fn();
const mockPoolTerminate = vi.fn();
const mockCreateWorkerPool = vi.fn(() => ({
  grade: mockGrade,
  stopAll: mockStopAll,
  terminate: mockPoolTerminate,
}));
const mockComputePoolSize = vi.fn(() => 2);

vi.mock('@/lib/engine/workerPool', () => ({
  createWorkerPool: () => mockCreateWorkerPool(),
  computePoolSize: () => mockComputePoolSize(),
}));

const mockPolicy = vi.fn();
const mockQueueTerminate = vi.fn();
const mockCreateMaiaQueue = vi.fn(() => ({
  policy: mockPolicy,
  terminate: mockQueueTerminate,
}));

vi.mock('@/lib/engine/maiaQueue', () => ({
  createMaiaQueue: () => mockCreateMaiaQueue(),
}));

const mockMctsSearch = vi.fn();

vi.mock('@/lib/engine/mctsSearch', () => ({
  mctsSearch: (
    fen: string,
    budget: unknown,
    providers: unknown,
    onSnapshot: (s: EngineSnapshot) => void,
    signal: AbortSignal,
  ) => mockMctsSearch(fen, budget, providers, onSnapshot, signal),
}));

import { useFlawChessEngine } from '../useFlawChessEngine';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TEST_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const TEST_FEN_2 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1';

function makeSnapshot(rootMove: string): EngineSnapshot {
  return {
    rankedLines: [
      {
        rootMove,
        practicalScore: 0.6,
        objectiveEvalCp: 30,
        objectiveEvalMate: null,
        modalPath: [rootMove],
        modalStats: [{ objectiveEvalCp: 30, objectiveEvalMate: null, maiaProb: 0.5 }],
        visits: 1,
      },
    ],
    nodesEvaluated: 1,
    budgetExhausted: false,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('useFlawChessEngine', () => {
  beforeEach(() => {
    // Initialize the fake clock at epoch 0 so Date.now() is deterministic
    // (mirrors useStockfishEngine.test.ts's convention).
    vi.useFakeTimers({ now: 0 });
    mockGrade.mockReset();
    mockStopAll.mockReset();
    mockPoolTerminate.mockReset();
    mockCreateWorkerPool.mockClear();
    mockComputePoolSize.mockReset().mockReturnValue(2);
    mockPolicy.mockReset();
    mockQueueTerminate.mockReset();
    mockCreateMaiaQueue.mockClear();
    mockMctsSearch.mockReset();
    // Default: never resolves (tests drive onSnapshot directly and don't rely
    // on the returned promise settling unless explicitly testing that path).
    mockMctsSearch.mockImplementation(() => new Promise<EngineSnapshot>(() => {}));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throttle: first onSnapshot commits near-instantly; later snapshots throttle at ~150ms (never a debounce that delays first paint, DISPLAY-01)', async () => {
    // Advance past RAPID_STEP_DEBOUNCE_MS so the settled-first-mount FEN fires
    // the search immediately (sinceLast = 200 - 0 = 200 > 150).
    vi.advanceTimersByTime(200);

    const { result } = renderHook(() =>
      useFlawChessEngine({ fen: TEST_FEN, enabled: true, elo: 1500 }),
    );

    expect(mockMctsSearch).toHaveBeenCalledTimes(1);
    const onSnapshot = mockMctsSearch.mock.calls[0]?.[3] as (s: EngineSnapshot) => void;
    expect(onSnapshot).toBeDefined();

    // First onSnapshot: the throttle's lastCommitAtRef was reset to 0 before
    // the search started, so this commits immediately — no 150ms delay.
    const snapshot1 = makeSnapshot('e2e4');
    act(() => {
      onSnapshot(snapshot1);
    });
    expect(result.current.rankedLines).toBe(snapshot1.rankedLines);

    // A burst of two more snapshots arriving within the same throttle window
    // (no timer advance between them): only ONE trailing commit should ever
    // be scheduled, and it must reflect the LATEST snapshot (snapshot3), not
    // the intermediate one (snapshot2).
    const snapshot2 = makeSnapshot('g1f3');
    const snapshot3 = makeSnapshot('d2d4');
    act(() => {
      onSnapshot(snapshot2);
      onSnapshot(snapshot3);
    });
    // Not yet committed — still showing snapshot1 until the trailing timer fires.
    expect(result.current.rankedLines).toBe(snapshot1.rankedLines);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    // Only the latest snapshot (snapshot3) was committed — snapshot2 was
    // superseded, proving at most one trailing commit per 150ms window.
    expect(result.current.rankedLines).toBe(snapshot3.rankedLines);
    expect(result.current.rankedLines).not.toBe(snapshot2.rankedLines);
  });

  it('abort: navigating to a new FEN aborts the previous run AND calls pool.stopAll() (DISPLAY-01 / Pitfall 1 regression guard)', async () => {
    const { rerender } = renderHook(
      ({ fen }: { fen: string }) => useFlawChessEngine({ fen, enabled: true, elo: 1500 }),
      { initialProps: { fen: TEST_FEN } },
    );

    // Settle the first FEN (fires immediately: sinceLast = 0 - 0 = 0, NOT
    // > 150, so it takes the debounce path — advance past it).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(mockMctsSearch).toHaveBeenCalledTimes(1);
    const firstSignal = mockMctsSearch.mock.calls[0]?.[4] as AbortSignal;
    expect(firstSignal.aborted).toBe(false);
    // stopAll() is (harmlessly) called before every search including the
    // first, since the pool has nothing in flight yet — track the baseline
    // call count so the navigation assertion below proves a NEW call happened.
    const stopAllCallsBeforeNav = mockStopAll.mock.calls.length;

    // Navigate to a new FEN. Settled navigation (sinceLast > 150 since the
    // last FEN change) fires the debounce immediately, so stopAll + a fresh
    // mctsSearch call happen synchronously within this act().
    rerender({ fen: TEST_FEN_2 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // Pitfall 1 regression guard: the previous run's signal is aborted AND
    // pool.stopAll() was called again — the signal alone does not free the pool.
    expect(firstSignal.aborted).toBe(true);
    expect(mockStopAll.mock.calls.length).toBeGreaterThan(stopAllCallsBeforeNav);

    // A fresh search was issued for the new FEN.
    expect(mockMctsSearch).toHaveBeenCalledTimes(2);
    expect(mockMctsSearch.mock.calls[1]?.[0]).toBe(TEST_FEN_2);
    const secondSignal = mockMctsSearch.mock.calls[1]?.[4] as AbortSignal;
    expect(secondSignal.aborted).toBe(false);
  });

  // ─── Phase 196 (INJECT-03): extraRootMoves threading ───────────────────────

  it('threads extraRootMoves into the SearchBudget by reference (INJECT-03)', async () => {
    vi.advanceTimersByTime(200);
    const extra = ['h2h4'];

    renderHook(() => useFlawChessEngine({ fen: TEST_FEN, enabled: true, elo: 1500, extraRootMoves: extra }));

    expect(mockMctsSearch).toHaveBeenCalledTimes(1);
    const budget = mockMctsSearch.mock.calls[0]?.[1] as { extraRootMoves?: string[] };
    expect(budget.extraRootMoves).toBe(extra);
  });

  it('produces a SearchBudget with extraRootMoves undefined when the option is omitted (byte-identical to pre-phase behaviour)', async () => {
    vi.advanceTimersByTime(200);

    renderHook(() => useFlawChessEngine({ fen: TEST_FEN, enabled: true, elo: 1500 }));

    expect(mockMctsSearch).toHaveBeenCalledTimes(1);
    const budget = mockMctsSearch.mock.calls[0]?.[1] as { extraRootMoves?: string[] };
    expect(budget.extraRootMoves).toBeUndefined();
  });

  it('does NOT restart the search when extraRootMoves keeps the SAME array reference across a re-render', async () => {
    vi.advanceTimersByTime(200);
    const extra = ['h2h4'];

    const { rerender } = renderHook(
      ({ elo }: { elo: number }) =>
        useFlawChessEngine({ fen: TEST_FEN, enabled: true, elo, extraRootMoves: extra }),
      { initialProps: { elo: 1500 } },
    );

    expect(mockMctsSearch).toHaveBeenCalledTimes(1);
    const stopAllCallsBefore = mockStopAll.mock.calls.length;

    // Re-render with an unrelated prop unchanged and the SAME extraRootMoves
    // reference: no new search should be dispatched.
    rerender({ elo: 1500 });

    expect(mockMctsSearch).toHaveBeenCalledTimes(1);
    expect(mockStopAll.mock.calls.length).toBe(stopAllCallsBefore);
  });

  it('restarts the search when extraRootMoves changes identity, even with equal contents (identity is the contract)', async () => {
    vi.advanceTimersByTime(200);

    const { rerender } = renderHook(
      ({ extraRootMoves }: { extraRootMoves: string[] }) =>
        useFlawChessEngine({ fen: TEST_FEN, enabled: true, elo: 1500, extraRootMoves }),
      { initialProps: { extraRootMoves: ['h2h4'] } },
    );

    expect(mockMctsSearch).toHaveBeenCalledTimes(1);
    const stopAllCallsBefore = mockStopAll.mock.calls.length;

    // A NEW array reference with equal contents must still restart — identity
    // is the contract, which is precisely why Analysis.tsx (Task 2) owns the
    // stability guarantee.
    rerender({ extraRootMoves: ['h2h4'] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(mockMctsSearch).toHaveBeenCalledTimes(2);
    expect(mockStopAll.mock.calls.length).toBeGreaterThan(stopAllCallsBefore);
    const budget = mockMctsSearch.mock.calls[1]?.[1] as { extraRootMoves?: string[] };
    expect(budget.extraRootMoves).toEqual(['h2h4']);
  });
});
