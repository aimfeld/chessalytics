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
 *
 * Bug fix (quick 260901-oxh): this was 150ms, which is exactly HALF
 * react-chessboard v5's 300ms default `animationDurationInMs`. The library's
 * position effect is keyed on `[position]` only, so a new position arriving
 * mid-slide snapped `currentPosition` to the still-pending
 * `waitingForAnimationPosition` and restarted the animation — every
 * intermediate piece slide was aborted at roughly half travel, which is the
 * "moves get visually skipped" symptom. The cadence is now 200ms and the board
 * animation is DERIVED from it (below) so the two can never drift apart again.
 *
 * The exact value is a watchability choice, not a correctness one — any value
 * works as long as the derived animation stays below it. 250ms was tried and
 * judged too slow; 200ms is the settled cadence. Run-length context for any
 * future retune: the measured gap between consecutive notable plies is p50=3,
 * p75=7, p90=16, p99=43 plies, so a slower cadence is paid for almost entirely
 * in the tail (at 200ms: ~600ms median run, ~3.2s at p90).
 */
export const FAST_FORWARD_STEP_MS = 200;

/**
 * Margin between the end of a piece slide and the next position commit. Its
 * only job is to keep FAST_FORWARD_ANIMATION_MS strictly BELOW the step so a
 * slide always finishes before the next position lands.
 */
const FAST_FORWARD_ANIMATION_HEADROOM_MS = 30;

/**
 * Board animation duration to use FOR THE DURATION OF A RUN, in milliseconds.
 *
 * DERIVED from FAST_FORWARD_STEP_MS on purpose — writing it as a second
 * literal is precisely the drift that caused the skipped-move bug documented
 * on FAST_FORWARD_STEP_MS above. The invariant this expression encodes is
 * "animation < step", so retuning the cadence can never silently re-break the
 * animation. Consumers pass it to ChessBoard's `animationDurationInMs` only
 * while a run is in flight; normal navigation keeps the library's 300ms
 * default.
 */
export const FAST_FORWARD_ANIMATION_MS = FAST_FORWARD_STEP_MS - FAST_FORWARD_ANIMATION_HEADROOM_MS;

/**
 * Settle delay between LANDING on the target ply and reporting the run as
 * finished, in milliseconds.
 *
 * Bug fix (quick 260901-oxh follow-up): the replay was smooth for every
 * intermediate ply but visibly hitched on the last one. `stop()` used to run in
 * the same tick as the landing `goToNode`, so React committed the arrival
 * position and `running: false` together — meaning the exact frame that starts
 * the final piece slide is also the frame that
 *   - un-suppresses FOUR live engines (Stockfish, Maia, FlawChess, grading:
 *     each `fen` prop flips from `null` to the new position at once), and
 *   - releases the gem sweep's `liveBusy` lever,
 * so worker startup, WASM search dispatch and the resulting render cascade all
 * pile onto the landing animation. It also flipped the board's
 * `animationDurationInMs` back to the library's 300ms default for that one
 * move, making the arrival slide a different speed from every ply before it.
 *
 * Holding the run open for one more step's worth of time fixes both: the
 * landing ply gets exactly the same slot as every intermediate ply, and the
 * engines resume at the moment the NEXT tick would have fired — i.e. after the
 * slide is done rather than during it. Equal to FAST_FORWARD_STEP_MS by
 * definition, not by coincidence, which is also why it is derived rather than
 * written as a third literal.
 *
 * Only a LANDING settles. Cancellation by foreign navigation releases
 * immediately: the user is driving the board again and should get engines back
 * without delay.
 */
export const FAST_FORWARD_SETTLE_MS = FAST_FORWARD_STEP_MS;

export interface UseFastForwardOptions {
  enabled: boolean;
  mainLine: readonly NodeId[];
  currentNodeId: NodeId | null;
  /** The board's current main-line ply, or null at the root (one ply before ply 0). */
  currentPly: number | null;
  stopPlies: ReadonlySet<number>;
  /**
   * The real useAnalysisBoard.goToNode accepts an optional `{ silent?:
   * boolean }` second argument; this hook never passes it — every replayed
   * ply plays the normal move sound, arrival included — so the narrower
   * single-argument shape is what's declared here (a function accepting
   * fewer parameters than the caller's is structurally assignable).
   */
  goToNode: (id: NodeId) => void;
  /**
   * Ordering escape hatch: fired with `true` when a run begins and `false`
   * exactly once when it ends (by landing, by foreign-navigation
   * cancellation, or by an explicit stop). On a landing the `false` is
   * deferred by FAST_FORWARD_SETTLE_MS so the arrival slide finishes before
   * consumers un-suppress whatever they suppressed; see that constant. It
   * exists because a consumer may
   * need the run state ABOVE the line where this hook is called — on the
   * analysis page the hook sits ~1,000 lines below the engine hooks that must
   * read it, and hooks cannot be reordered around that. Pushing the state
   * upward through this callback is the alternative to pulling `isRunning`
   * downward.
   */
  onRunningChange?: (running: boolean) => void;
}

export interface UseFastForwardReturn {
  start: () => void;
  /** The hook's own copy of the value `onRunningChange` reports. */
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
  const { enabled, mainLine, currentNodeId, currentPly, stopPlies, goToNode, onRunningChange } =
    options;

  const [isRunning, setIsRunning] = useState(false);
  const runningRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const planRef = useRef<RunPlan | null>(null);
  // Names the node id the hook itself is about to (or has just) commanded —
  // the sole cancellation signal (D-05). Seeded at start() and updated on
  // every tick, BEFORE goToNode is called.
  const expectedNodeIdRef = useRef<NodeId | null>(null);

  // onRunningChange is held in a ref (refreshed by the bare useEffect below,
  // mirroring the tickRef precedent further down) so an unstable caller-supplied
  // callback identity cannot change `stop`'s identity — `stop` feeds `tick`'s
  // deps AND the cancellation effect's deps, so churn there would re-arm the
  // cancellation effect on every render.
  const onRunningChangeRef = useRef<((running: boolean) => void) | undefined>(undefined);
  useEffect(() => {
    onRunningChangeRef.current = onRunningChange;
  });

  // currentPly is null at the root, which is one ply BEFORE ply 0 — the ?? -1
  // is load-bearing so the root can still fast-forward (D-04: disabled only
  // at the very end).
  const canFastForward =
    enabled && mainLine.length > 0 && (currentPly ?? -1) < mainLine.length - 1;

  // Pending deferred onRunningChange(false) after a landing. Held separately
  // from timerRef because it outlives the run itself: `runningRef` is already
  // false while this is armed, which is deliberate — a user who presses
  // fast-forward again during the settle window must be able to start a new run
  // immediately rather than wait out the tail of the previous one.
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSettleTimer = useCallback((): void => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  /**
   * Ends a run. `settle` defers only the onRunningChange(false) report by
   * FAST_FORWARD_SETTLE_MS (see that constant) — every other piece of run state
   * is torn down synchronously either way, so `start` is immediately available
   * again. Defaults to false so the cancellation paths, which pass no argument,
   * keep releasing instantly.
   */
  const stop = useCallback(
    (settle: boolean = false): void => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Reading runningRef BEFORE clearing it is what makes onRunningChange(false)
      // fire exactly once per run regardless of which exit path got here
      // (landing, cancellation, or a snapshot that shrank under the cursor).
      const wasRunning = runningRef.current;
      runningRef.current = false;
      planRef.current = null;
      setIsRunning(false);
      if (!wasRunning) return;
      // A previous settle can still be armed if this run started inside another
      // run's settle window; the exactly-once contract is per run, so drop it.
      clearSettleTimer();
      if (!settle) {
        onRunningChangeRef.current?.(false);
        return;
      }
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        onRunningChangeRef.current?.(false);
      }, FAST_FORWARD_SETTLE_MS);
    },
    [clearSettleTimer],
  );

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
    // Every step — intermediate and landing — plays the normal move sound
    // (per checkpoint feedback: the replay should sound like actually
    // playing through the moves, not just the arrival).
    goToNode(nodeId);
    if (landed) {
      // `true`: the arrival slide starts on the commit this goToNode triggers,
      // so the run must stay REPORTED as running until it finishes — otherwise
      // the engines and the gem sweep resume on top of it. See
      // FAST_FORWARD_SETTLE_MS.
      stop(true);
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

    // Bug fix (quick 260901-oxh): the run used to OPEN with a full
    // FAST_FORWARD_STEP_MS of dead time because the first step was scheduled
    // rather than taken. The first ply is now stepped synchronously and
    // `tick`'s own self-rescheduling tail drives every later step, so pressing
    // fast-forward moves a piece immediately.
    //
    // Every pre-existing invariant survives the reordering, and each one
    // depends on an assignment made BELOW-but-before the tick() call:
    //  - `runningRef.current = true` is set before tick() runs, so a second
    //    start() in the same commit still hits the guard at the top of this
    //    function (no second timer chain).
    //  - `expectedNodeIdRef` is seeded here and rewritten by tick immediately
    //    BEFORE each goToNode — it remains the sole cancellation signal (D-05).
    //  - `planRef` is assigned before tick() reads it, so the snapshot
    //    semantics documented on RunPlan are unchanged.
    //  - tick's `landed` check still stops on arrival, which for a one-ply
    //    target now happens inside start() itself (start's `true` and stop's
    //    `false` then batch to a net no-op, which is correct — such a run is
    //    behaviourally identical to pressing Forward once).
    // Pressing fast-forward again inside the previous run's settle window is
    // legal (see settleTimerRef); disarming its pending `false` here is what
    // stops it from landing in the middle of THIS run. The consumer is still
    // holding `true` from that run, so the report below is a no-op re-set
    // rather than a flicker.
    clearSettleTimer();
    runningRef.current = true;
    setIsRunning(true);
    onRunningChangeRef.current?.(true);
    expectedNodeIdRef.current = currentNodeId;
    planRef.current = { mainLine, target, cursor };
    tick();
  }, [enabled, mainLine, currentPly, stopPlies, currentNodeId, tick, clearSettleTimer]);

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
  // fires after the component using this hook is gone. The settle timer is
  // dropped rather than flushed — its only job is to report to a consumer that
  // no longer exists.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    };
  }, []);

  return { start, isRunning, canFastForward };
}
