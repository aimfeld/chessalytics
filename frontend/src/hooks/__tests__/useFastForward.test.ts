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
    expect(goToNode).toHaveBeenNthCalledWith(1, 11);

    act(() => {
      vi.advanceTimersByTime(FAST_FORWARD_STEP_MS);
    });
    expect(goToNode).toHaveBeenNthCalledWith(2, 12);

    act(() => {
      vi.advanceTimersByTime(FAST_FORWARD_STEP_MS);
    });
    expect(goToNode).toHaveBeenNthCalledWith(3, 13);
    expect(goToNode).toHaveBeenCalledTimes(3);
    expect(result.current.isRunning).toBe(false);
  });

  it('foreign navigation cancels an in-flight run: further timer advances fire no additional goToNode and isRunning goes false', () => {
    const goToNode = vi.fn();
    const mainLine: NodeId[] = [10, 11, 12, 13, 14];
    const { result, rerender } = renderHook((props: UseFastForwardOptions) => useFastForward(props), {
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
    act(() => {
      vi.advanceTimersByTime(FAST_FORWARD_STEP_MS);
    });
    expect(goToNode).toHaveBeenCalledTimes(1); // stepped onto 11

    // A committed node the hook never commanded (e.g. the user clicked Back).
    rerender(baseOptions({ mainLine, currentPly: 0, currentNodeId: 999, stopPlies: new Set([3]), goToNode }));
    expect(result.current.isRunning).toBe(false);

    act(() => {
      vi.advanceTimersByTime(FAST_FORWARD_STEP_MS * 5);
    });
    expect(goToNode).toHaveBeenCalledTimes(1); // no further calls
  });

  it('hook-commanded navigation does NOT cancel: rerendering with the id the hook just commanded lets the run continue', () => {
    const goToNode = vi.fn();
    const mainLine: NodeId[] = [10, 11, 12, 13, 14];
    const { result, rerender } = renderHook((props: UseFastForwardOptions) => useFastForward(props), {
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
    act(() => {
      vi.advanceTimersByTime(FAST_FORWARD_STEP_MS);
    });
    expect(goToNode).toHaveBeenNthCalledWith(1, 11);

    // Simulate the consumer committing the node the hook itself just commanded.
    rerender(baseOptions({ mainLine, currentPly: 1, currentNodeId: 11, stopPlies: new Set([3]), goToNode }));
    expect(result.current.isRunning).toBe(true);

    act(() => {
      vi.advanceTimersByTime(FAST_FORWARD_STEP_MS);
    });
    expect(goToNode).toHaveBeenNthCalledWith(2, 12);

    act(() => {
      vi.advanceTimersByTime(FAST_FORWARD_STEP_MS);
    });
    expect(goToNode).toHaveBeenNthCalledWith(3, 13);
    expect(result.current.isRunning).toBe(false);
  });

  it('no stop ahead (D-04): with empty stopPlies on a five-ply main line, the run animates through every remaining ply and lands on the last one', () => {
    const goToNode = vi.fn();
    const mainLine: NodeId[] = [100, 101, 102, 103, 104];
    const { result } = renderHook((props: UseFastForwardOptions) => useFastForward(props), {
      initialProps: baseOptions({
        mainLine,
        currentPly: 0,
        currentNodeId: 100,
        stopPlies: new Set(),
        goToNode,
      }),
    });

    act(() => {
      result.current.start();
    });

    for (let i = 0; i < 3; i++) {
      act(() => {
        vi.advanceTimersByTime(FAST_FORWARD_STEP_MS);
      });
    }
    expect(goToNode).toHaveBeenNthCalledWith(1, 101);
    expect(goToNode).toHaveBeenNthCalledWith(2, 102);
    expect(goToNode).toHaveBeenNthCalledWith(3, 103);
    expect(result.current.isRunning).toBe(true); // not yet landed

    act(() => {
      vi.advanceTimersByTime(FAST_FORWARD_STEP_MS);
    });
    expect(goToNode).toHaveBeenNthCalledWith(4, 104);
    expect(goToNode).toHaveBeenCalledTimes(4);
    expect(result.current.isRunning).toBe(false);
  });

  it('canFastForward is false at the last ply and true at the root with a non-empty main line', () => {
    const mainLine: NodeId[] = [10, 11, 12];
    const { result: atEnd } = renderHook((props: UseFastForwardOptions) => useFastForward(props), {
      initialProps: baseOptions({ mainLine, currentPly: 2, currentNodeId: 12 }),
    });
    expect(atEnd.current.canFastForward).toBe(false);

    const { result: atRoot } = renderHook((props: UseFastForwardOptions) => useFastForward(props), {
      initialProps: baseOptions({ mainLine, currentPly: null, currentNodeId: null }),
    });
    expect(atRoot.current.canFastForward).toBe(true);
  });

  it('canFastForward is false when enabled is false, and start() is inert in that state', () => {
    const goToNode = vi.fn();
    const mainLine: NodeId[] = [10, 11, 12];
    const { result } = renderHook((props: UseFastForwardOptions) => useFastForward(props), {
      initialProps: baseOptions({ enabled: false, mainLine, currentPly: 0, currentNodeId: 10, goToNode }),
    });
    expect(result.current.canFastForward).toBe(false);

    act(() => {
      result.current.start();
    });
    act(() => {
      vi.advanceTimersByTime(FAST_FORWARD_STEP_MS * 3);
    });
    expect(goToNode).not.toHaveBeenCalled();
    expect(result.current.isRunning).toBe(false);
  });

  it('unmounting mid-run fires no further goToNode after subsequent timer advances', () => {
    const goToNode = vi.fn();
    const mainLine: NodeId[] = [10, 11, 12, 13, 14];
    const { result, unmount } = renderHook((props: UseFastForwardOptions) => useFastForward(props), {
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
    act(() => {
      vi.advanceTimersByTime(FAST_FORWARD_STEP_MS);
    });
    expect(goToNode).toHaveBeenCalledTimes(1);

    unmount();

    act(() => {
      vi.advanceTimersByTime(FAST_FORWARD_STEP_MS * 5);
    });
    expect(goToNode).toHaveBeenCalledTimes(1); // no further calls after unmount
  });

  it('a second start() while a run is in flight does not spawn a second timer chain', () => {
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
      result.current.start(); // re-entrant call within the same commit — must be a no-op
    });

    act(() => {
      vi.advanceTimersByTime(FAST_FORWARD_STEP_MS);
    });
    // A second timer chain would double the calls per tick.
    expect(goToNode).toHaveBeenCalledTimes(1);
  });
});
