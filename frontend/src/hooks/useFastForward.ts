/**
 * useFastForward — animated replay to the next notable main-line ply
 * (Quick 260831-s4y).
 *
 * Single directional command (D-03: no rewind counterpart). Replays the main
 * line forward one ply every FAST_FORWARD_STEP_MS until it lands on the next
 * "stop" ply the caller supplies (blunder/mistake/gem/great — computed by the
 * caller, this hook is agnostic to what a stop means), or, when no stop
 * remains ahead, animates all the way to the final main-line ply (D-04 —
 * there is no true no-op state short of already being on the last ply).
 *
 * Cancellation (D-05): any COMMITTED navigation this hook did not itself just
 * command — back/forward/reset, a move-list click, the eval-chart scrub, an
 * arrow key, the wheel — stops the in-flight run. This is implemented with a
 * single `expectedNodeIdRef` comparison against the `currentNodeId` prop, so
 * no existing navigation handler needs to know this hook exists.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NodeId } from '@/hooks/useAnalysisBoard';

/**
 * Per-ply replay cadence in milliseconds — the ONE knob controlling how fast
 * the fast-forward replay steps through intervening moves (D-01).
 */
export const FAST_FORWARD_STEP_MS = 200;

export interface UseFastForwardOptions {
  enabled: boolean;
  mainLine: readonly NodeId[];
  currentNodeId: NodeId | null;
  /** The board's current main-line ply, or null at the root (one ply before ply 0). */
  currentPly: number | null;
  stopPlies: ReadonlySet<number>;
  goToNode: (id: NodeId, opts?: { silent?: boolean }) => void;
}

export interface UseFastForwardReturn {
  start: () => void;
  isRunning: boolean;
  canFastForward: boolean;
}

/**
 * nextStopPly — pure target-selection helper, exported for direct unit
 * testing without React.
 *
 * Scans (currentPly, lastPly] ascending for the first ply present in
 * `stopPlies`. When none is found and there is still ground to cover
 * (lastPly > currentPly), the terminal ply itself is the implicit stop
 * (D-04 — the final position is always reachable). Returns null only when
 * there is nowhere left to go (already on the last ply).
 */
export function nextStopPly(
  currentPly: number,
  stopPlies: ReadonlySet<number>,
  lastPly: number,
): number | null {
  for (let ply = currentPly + 1; ply <= lastPly; ply++) {
    if (stopPlies.has(ply)) return ply;
  }
  return lastPly > currentPly ? lastPly : null;
}

/** Snapshot taken at start() time — the loop drives off this, not live props,
 *  so a mid-run prop change (e.g. loadMainLine swapping mainLine) needs no
 *  ref-sync effect; it's simply caught by the cancellation guard instead. */
interface RunPlan {
  mainLine: readonly NodeId[];
  target: number;
  cursor: number;
}

export function useFastForward(options: UseFastForwardOptions): UseFastForwardReturn {
  const { enabled, mainLine, currentNodeId, currentPly, stopPlies, goToNode } = options;

  const [isRunning, setIsRunning] = useState(false);
  const runningRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const planRef = useRef<RunPlan | null>(null);
  // Names the node id the hook itself is about to (or has just) commanded —
  // the sole cancellation signal (D-05). Seeded at start() and updated on
  // every tick, BEFORE goToNode is called.
  const expectedNodeIdRef = useRef<NodeId | null>(null);

  // currentPly is null at the root, which is one ply BEFORE ply 0 — the ?? -1
  // is load-bearing so the root can still fast-forward (D-04: disabled only
  // at the very end).
  const canFastForward =
    enabled && mainLine.length > 0 && (currentPly ?? -1) < mainLine.length - 1;

  const stop = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    runningRef.current = false;
    planRef.current = null;
    setIsRunning(false);
  }, []);

  // tickRef holds the latest tick closure so the self-rescheduling
  // setTimeout below can call it by ref rather than by name — referencing a
  // useCallback result inside its own body trips
  // react-hooks/immutability (the const isn't assigned yet at the point the
  // closure captures it, even though it resolves fine by call time).
  const tickRef = useRef<() => void>(() => {});

  const tick = useCallback((): void => {
    const plan = planRef.current;
    if (plan === null) return;
    plan.cursor += 1;
    const nodeId = plan.mainLine[plan.cursor];
    if (nodeId === undefined) {
      // noUncheckedIndexedAccess guard: the snapshot mainLine shrank out from
      // under the cursor (shouldn't happen given the cancellation guard, but
      // stop rather than skip ahead if it ever does).
      stop();
      return;
    }
    expectedNodeIdRef.current = nodeId;
    const landed = plan.cursor >= plan.target;
    // Intermediate steps stay silent — the same machine-gun-sound guard
    // handleEvalChartPlyChange documents for a per-ply scrub. The landing
    // step is a single deliberate arrival and sounds.
    goToNode(nodeId, landed ? undefined : { silent: true });
    if (landed) {
      stop();
      return;
    }
    timerRef.current = setTimeout(() => tickRef.current(), FAST_FORWARD_STEP_MS);
  }, [goToNode, stop]);

  useEffect(() => {
    tickRef.current = tick;
  });

  const start = useCallback((): void => {
    // Guard on runningRef (not the isRunning state) so a double click inside
    // one commit cannot start two timer chains.
    if (runningRef.current) return;
    if (!enabled || mainLine.length === 0) return;
    const lastPly = mainLine.length - 1;
    const cursor = currentPly ?? -1;
    if (cursor >= lastPly) return;
    const target = nextStopPly(cursor, stopPlies, lastPly);
    if (target === null) return;

    runningRef.current = true;
    setIsRunning(true);
    expectedNodeIdRef.current = currentNodeId;
    planRef.current = { mainLine, target, cursor };
    timerRef.current = setTimeout(tick, FAST_FORWARD_STEP_MS);
  }, [enabled, mainLine, currentPly, stopPlies, currentNodeId, tick]);

  // Cancellation (D-05): fires on every committed navigation. A run in
  // flight stops the instant the committed node differs from the node the
  // hook itself last commanded — covering every foreign navigation path
  // (back/forward/reset/move-list/eval-chart scrub/arrow keys/wheel) without
  // editing a single existing handler.
  useEffect(() => {
    if (!runningRef.current) return;
    if (currentNodeId !== expectedNodeIdRef.current) {
      stop();
    }
  }, [currentNodeId, stop]);

  // Mount-scoped cleanup: kill any pending timer on unmount so no navigation
  // fires after the component using this hook is gone.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  return { start, isRunning, canFastForward };
}
