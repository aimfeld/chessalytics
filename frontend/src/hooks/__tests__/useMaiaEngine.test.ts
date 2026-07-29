// @vitest-environment jsdom
/**
 * useMaiaEngine mock-Worker unit tests.
 *
 * Behaviors verified (151-04-PLAN.md Task 3):
 * 1. Idle (no Worker) until enabled.
 * 2. Classic Worker instantiation + init message.
 * 3. isReady flips false->true on the 'ready' message.
 * 4. Adaptive debounce: settled FEN fires analyze with the full MAIA_ELO_LADDER.
 * 5. Rapid successive FEN changes coalesce to one analyze for the final FEN.
 * 6. Stale-result discard: a result for a superseded FEN is ignored.
 * 7. Cache hit for a previously-seen FEN skips a second worker round-trip.
 * 8. Tab-hide pause: no analyze while hidden; re-analyzes on visible.
 * 9. Unmount sends terminate and terminates the Worker.
 * 10. wdl / expectedScoreAtSelectedElo derive from the ladder rung nearest selectedElo.
 *
 * Respawn behaviors (quick 260729-sod, FIX 1): a `webgpu-unavailable` message
 * terminates the dead worker and constructs exactly one wasm-pinned
 * replacement; a no-adapter device that reports `ready` directly never
 * respawns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMaiaEngine } from '../useMaiaEngine';
import { MAIA_ELO_LADDER, POLICY_VOCAB_SIZE } from '../../lib/maiaEncoding';

// ─── Mock Worker ─────────────────────────────────────────────────────────────

interface WorkerMessageLike {
  type: string;
  [key: string]: unknown;
}

class MockWorker {
  onmessage: ((e: MessageEvent<WorkerMessageLike>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  messages: WorkerMessageLike[] = [];
  terminated = false;

  postMessage(msg: WorkerMessageLike): void {
    this.messages.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Fire the onmessage handler with a synthetic structured message. */
  simulateMessage(data: WorkerMessageLike): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** Fire the onerror handler — simulates an asynchronous Worker script-load failure. */
  simulateError(): void {
    this.onerror?.(new Event('error'));
  }
}

let createdWorkers: MockWorker[];

/** Narrow accessor for `noUncheckedIndexedAccess` — throws if no worker exists yet. */
function latestWorker(): MockWorker {
  const w = createdWorkers[createdWorkers.length - 1];
  if (!w) throw new Error('No MockWorker constructed yet');
  return w;
}

function stubWorkerCtor(): void {
  createdWorkers = [];
  vi.stubGlobal(
    'Worker',
    vi.fn(function () {
      const w = new MockWorker();
      createdWorkers.push(w);
      return w;
    }),
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const TEST_FEN_2 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1';

function driveReady(worker: MockWorker): void {
  act(() => {
    worker.simulateMessage({ type: 'ready', backend: 'wasm' });
  });
}

function analyzeMessages(worker: MockWorker): WorkerMessageLike[] {
  return worker.messages.filter((m) => m.type === 'analyze');
}

/** Builds a synthetic worker 'result' message for the given FEN (all-zero logits). */
function buildResultMessage(fen: string): WorkerMessageLike {
  const rawPolicyByElo = MAIA_ELO_LADDER.map((elo) => ({
    elo,
    policy: new Float32Array(POLICY_VOCAB_SIZE),
  }));
  const wdlByElo = MAIA_ELO_LADDER.map((elo) => ({ elo, wdl: Float32Array.from([0, 0, 0]) }));
  return { type: 'result', fen, rawPolicyByElo, wdlByElo, backend: 'wasm' };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('useMaiaEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    stubWorkerCtor();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not create a Worker until enabled', () => {
    renderHook(() => useMaiaEngine({ fen: null, enabled: false, selectedElo: 1500 }));
    expect(createdWorkers).toHaveLength(0);
  });

  it('creates a classic Worker and sends init when enabled', () => {
    renderHook(() => useMaiaEngine({ fen: null, enabled: true, selectedElo: 1500 }));
    const WorkerCtor = vi.mocked(globalThis.Worker as new (url: string) => Worker);
    expect(WorkerCtor).toHaveBeenCalledWith('/maia/maia-worker.js');
    expect(latestWorker().messages).toContainEqual({ type: 'init' });
  });

  it('isReady flips false->true on the ready message', () => {
    const { result } = renderHook(() => useMaiaEngine({ fen: null, enabled: true, selectedElo: 1500 }));
    expect(result.current.isReady).toBe(false);
    driveReady(latestWorker());
    expect(result.current.isReady).toBe(true);
  });

  it('settled FEN fires analyze with the full ELO ladder once ready', async () => {
    vi.advanceTimersByTime(200); // Date.now() >> 0 so the first FEN is a "settled move".
    renderHook(() => useMaiaEngine({ fen: TEST_FEN, enabled: true, selectedElo: 1500 }));
    driveReady(latestWorker());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    const msgs = analyzeMessages(latestWorker());
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.fen).toBe(TEST_FEN);
    expect(msgs[0]?.eloInputs).toEqual(MAIA_ELO_LADDER);
  });

  it('rapid successive FEN changes coalesce — only the final FEN is analyzed', async () => {
    const { rerender } = renderHook(
      ({ fen }: { fen: string }) => useMaiaEngine({ fen, enabled: true, selectedElo: 1500 }),
      { initialProps: { fen: TEST_FEN } },
    );
    driveReady(latestWorker());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(140); // before the 150ms debounce fires
    });
    rerender({ fen: TEST_FEN_2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    const msgs = analyzeMessages(latestWorker());
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.fen).toBe(TEST_FEN_2);
  });

  it('discards a stale result whose fen no longer matches the current position', async () => {
    const { rerender, result } = renderHook(
      ({ fen }: { fen: string }) => useMaiaEngine({ fen, enabled: true, selectedElo: 1500 }),
      { initialProps: { fen: TEST_FEN } },
    );
    driveReady(latestWorker());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current.isAnalyzing).toBe(true);

    // FEN changes (immediate-fire path — sinceLast > 150ms) before TEST_FEN's result arrives.
    rerender({ fen: TEST_FEN_2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // Stale result for the OLD fen arrives — must be discarded.
    act(() => {
      latestWorker().simulateMessage(buildResultMessage(TEST_FEN));
    });
    expect(result.current.perElo).toHaveLength(0);
  });

  it('a cache hit for a previously-seen FEN skips a second worker round-trip', async () => {
    const { rerender, result } = renderHook(
      ({ fen }: { fen: string }) => useMaiaEngine({ fen, enabled: true, selectedElo: 1500 }),
      { initialProps: { fen: TEST_FEN } },
    );
    driveReady(latestWorker());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    act(() => {
      latestWorker().simulateMessage(buildResultMessage(TEST_FEN));
    });
    expect(result.current.perElo.length).toBe(MAIA_ELO_LADDER.length);

    const countBefore = analyzeMessages(latestWorker()).length;

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
    expect(analyzeMessages(latestWorker())).toHaveLength(countBefore + 1);
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
    driveReady(latestWorker());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // TEST_FEN analyzed and cached.
    act(() => {
      latestWorker().simulateMessage(buildResultMessage(TEST_FEN));
    });
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
    driveReady(latestWorker());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // TEST_FEN is analyzing (worker "busy"), no result yet.
    expect(analyzeMessages(latestWorker())).toHaveLength(1);

    // Move to a new settled position while TEST_FEN is still in flight.
    rerender({ fen: TEST_FEN_2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // No second request queued behind the running one.
    expect(analyzeMessages(latestWorker())).toHaveLength(1);

    // TEST_FEN result lands -> worker free -> analyze the current FEN (TEST_FEN_2).
    act(() => {
      latestWorker().simulateMessage(buildResultMessage(TEST_FEN));
    });
    const msgs = analyzeMessages(latestWorker());
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
    driveReady(latestWorker());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // Hidden: the debounce committed but analyze() bailed — no worker round-trip.
    expect(analyzeMessages(latestWorker())).toHaveLength(0);

    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
        writable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // On return the current FEN is analyzed.
    expect(analyzeMessages(latestWorker())).toHaveLength(1);
    expect(analyzeMessages(latestWorker())[0]?.fen).toBe(TEST_FEN);
  });

  it('resultFen reports the FEN the held curve belongs to, and clears with it (163-REVIEW WR-03)', async () => {
    vi.advanceTimersByTime(200); // first FEN settles immediately
    const { rerender, result } = renderHook(
      ({ fen }: { fen: string }) => useMaiaEngine({ fen, enabled: true, selectedElo: 1500 }),
      { initialProps: { fen: TEST_FEN } },
    );
    driveReady(latestWorker());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // No result held yet — no FEN to attribute.
    expect(result.current.resultFen).toBeNull();

    act(() => {
      latestWorker().simulateMessage(buildResultMessage(TEST_FEN));
    });
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

  it('unmount sends terminate and terminates the Worker (no leak)', () => {
    const { unmount } = renderHook(() => useMaiaEngine({ fen: null, enabled: true, selectedElo: 1500 }));
    unmount();
    expect(latestWorker().messages).toContainEqual({ type: 'terminate' });
    expect(latestWorker().terminated).toBe(true);
  });

  it('wdl / expectedScoreAtSelectedElo derive from the ladder rung nearest selectedElo', async () => {
    const { result } = renderHook(() => useMaiaEngine({ fen: TEST_FEN, enabled: true, selectedElo: 1550 }));
    driveReady(latestWorker());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    const msg = buildResultMessage(TEST_FEN);
    const wdlByElo = msg.wdlByElo as { elo: number; wdl: Float32Array }[];
    // Give the 1500 rung (nearest to selectedElo=1550, ties broken toward the
    // lower/earlier rung) a clearly winning WDL logit set.
    msg.wdlByElo = wdlByElo.map((entry) =>
      entry.elo === 1500 ? { ...entry, wdl: Float32Array.from([0, 0, 10]) } : entry,
    );
    act(() => {
      latestWorker().simulateMessage(msg);
    });

    expect(result.current.wdl?.win).toBeGreaterThan(0.9);
    expect(result.current.expectedScoreAtSelectedElo).toBeGreaterThan(0.9);
  });

  // ─── Respawn (quick 260729-sod, FIX 1) ────────────────────────────────────

  it('webgpu-unavailable terminates worker #1 and constructs exactly one replacement', () => {
    renderHook(() => useMaiaEngine({ fen: null, enabled: true, selectedElo: 1500 }));
    expect(createdWorkers).toHaveLength(1);
    const worker1 = latestWorker();

    act(() => {
      worker1.simulateMessage({ type: 'webgpu-unavailable', message: 'RangeError: Out of memory' });
    });

    expect(worker1.terminated).toBe(true);
    expect(createdWorkers).toHaveLength(2);
  });

  it('the replacement receives {type:init, backend:wasm}', () => {
    renderHook(() => useMaiaEngine({ fen: null, enabled: true, selectedElo: 1500 }));
    const worker1 = latestWorker();
    act(() => {
      worker1.simulateMessage({ type: 'webgpu-unavailable', message: 'boom' });
    });

    expect(latestWorker()).not.toBe(worker1);
    expect(latestWorker().messages).toContainEqual({ type: 'init', backend: 'wasm' });
  });

  it("after the replacement's ready, a normal analyze/result round-trip works", async () => {
    vi.advanceTimersByTime(200);
    renderHook(() => useMaiaEngine({ fen: TEST_FEN, enabled: true, selectedElo: 1500 }));
    const worker1 = latestWorker();
    act(() => {
      worker1.simulateMessage({ type: 'webgpu-unavailable', message: 'boom' });
    });
    const replacement = latestWorker();
    driveReady(replacement);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    const msgs = analyzeMessages(replacement);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.fen).toBe(TEST_FEN);
  });

  it('a worker that reports ready directly (no adapter) constructs exactly one Worker', () => {
    renderHook(() => useMaiaEngine({ fen: null, enabled: true, selectedElo: 1500 }));
    driveReady(latestWorker());
    expect(createdWorkers).toHaveLength(1);
  });
});
