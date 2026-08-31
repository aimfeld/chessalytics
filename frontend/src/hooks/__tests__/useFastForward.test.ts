// @vitest-environment jsdom
/**
 * useFastForward unit tests (Quick 260831-s4y).
 *
 * Fake-timer discipline: `vi.useFakeTimers()` in beforeEach / `vi.useRealTimers()`
 * in afterEach, ticks driven with `act(() => vi.advanceTimersByTime(...))`. No bare
 * testing-library `waitFor` on a timer-driven transition — its independent 1000ms
 * ceiling is a known flake source in this repo (see useGemSweep.test.ts precedent).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useFastForward,
  nextStopPly,
  FAST_FORWARD_STEP_MS,
  type UseFastForwardOptions,
} from '../useFastForward';
import type { NodeId } from '@/hooks/useAnalysisBoard';

function baseOptions(overrides: Partial<UseFastForwardOptions>): UseFastForwardOptions {
  return {
    enabled: true,
    mainLine: [],
    currentNodeId: null,
    currentPly: null,
    stopPlies: new Set<number>(),
    goToNode: vi.fn(),
    ...overrides,
  };
}

describe('nextStopPly', () => {
  it('returns the smallest stop strictly ahead of currentPly', () => {
    expect(nextStopPly(2, new Set([5, 9]), 20)).toBe(5);
  });

  it('never targets the ply the board already sits on', () => {
    expect(nextStopPly(5, new Set([5, 9]), 20)).toBe(9);
  });

  it('a stop at ply 0 is reachable from the root (currentPly -1)', () => {
    expect(nextStopPly(-1, new Set([0]), 20)).toBe(0);
  });

  it('falls back to lastPly when no stop remains ahead but ground remains', () => {
    expect(nextStopPly(0, new Set(), 4)).toBe(4);
  });

  it('returns null when already on the last ply with no stop ahead', () => {
    expect(nextStopPly(4, new Set(), 4)).toBeNull();
  });
});

describe('useFastForward', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() replays ascending main-line nodes, one per FAST_FORWARD_STEP_MS tick, and never past the target', () => {
    const goToNode = vi.fn();
    const mainLine: NodeId[] = [10, 11, 12, 13, 14];
    const { result } = renderHook((props: UseFastForwardOptions) => useFastForward(props), {
      initialProps: baseOptions({
        mainLine,
        currentPly: 0,
        currentNodeId: 10,
        stopPlies: new Set([3]),
        goToNode,
      }),
    });

    act(() => {
      result.current.start();
    });
    expect(result.current.isRunning).toBe(true);

    act(() => {
      vi.advanceTimersByTime(FAST_FORWARD_STEP_MS);
    });
    expect(goToNode).toHaveBeenNthCalledWith(1, 11, { silent: true });

    act(() => {
      vi.advanceTimersByTime(FAST_FORWARD_STEP_MS);
    });
    expect(goToNode).toHaveBeenNthCalledWith(2, 12, { silent: true });

    act(() => {
      vi.advanceTimersByTime(FAST_FORWARD_STEP_MS);
    });
    expect(goToNode).toHaveBeenNthCalledWith(3, 13, undefined);
    expect(goToNode).toHaveBeenCalledTimes(3);
    expect(result.current.isRunning).toBe(false);
  });
});
