/**
 * workerPoolDispatch — the request-dispatch and UCI-response stage of
 * `workerPool.ts`'s per-worker state machine: assigning pending `grade()`
 * requests to free slots (`dispatchNext`), sending the actual `go` command
 * (`sendGo`), parsing everything a slot's worker emits back
 * (`handleLine` — the UCI message parser, the highest-risk function in the
 * phase, moved verbatim, same branch order, same string comparisons, same
 * early returns), and the public `grade()` entry point itself
 * (Phase 215-02 extraction from `createWorkerPool()`). Not a React hook —
 * plain module, no UI wiring, matching `maiaQueue.ts`'s convention.
 *
 * Every function here takes the pool's shared `PoolState` and cross-stage
 * `PoolOps` dispatch table as its first two parameters (`workerPoolState.ts`)
 * — `handleLine` reaches into the watchdog stage via `ops.clearSlotWatchdog`
 * and into `createWorkerPool`'s own readiness functions via
 * `ops.markPoolReady`/`ops.ensureSpawned`, and `sendGo` arms a fresh grading
 * watchdog by importing `fireWatchdog` directly from `workerPoolWatchdog.ts`
 * — that one call is not part of `PoolOps` because nothing outside the
 * watchdog module's own re-arm path calls it. The pool's own types and
 * constants (`enqueue`/`dequeueHighestPriority`/`noLiveSlotRemains`/
 * `sideToMove`/`WORKER_HASH_MB`/`GRADING_WATCHDOG_TIMEOUT_MS`) import from
 * `workerPoolState.ts`, never from the `workerPool.ts` facade (215 code
 * review WR-01) — that facade imports FROM the stage modules, so a stage
 * module importing back from it would recreate the cycle this split fixed.
 */

import { parseInfoLine } from '@/hooks/uciParser';
import type { MoveGrade } from './types';
import { buildGradeGoCommand, GRADING_ROOT_DEPTH } from './gradingLadder';
import { fireWatchdog } from './workerPoolWatchdog';
import type { PoolState, PoolOps, PoolWorkerSlot, QueuedGradeRequest } from './workerPoolState';
import {
  enqueue,
  dequeueHighestPriority,
  noLiveSlotRemains,
  sideToMove,
  WORKER_HASH_MB,
  GRADING_WATCHDOG_TIMEOUT_MS,
} from './workerPoolState';

/** Send `go` (plus its `setoption`/`position` setup) to a free slot for `req`, arming the grading watchdog. */
export function sendGo(
  state: PoolState,
  ops: PoolOps,
  slot: PoolWorkerSlot,
  req: QueuedGradeRequest,
): void {
  slot.current = req;
  slot.accumulator = new Map();
  slot.worker.postMessage(`setoption name MultiPV value ${req.candidateUcis.length}`);
  slot.worker.postMessage(`position fen ${req.fen}`);
  slot.worker.postMessage(buildGradeGoCommand(req.gradingDepth, req.candidateUcis));
  slot.state = 'thinking';
  ops.clearSlotWatchdog(slot); // defensive: a stale timer must never coexist with a fresh dispatch
  // FLAWCHESS-9G: a fresh dispatch is the only place the re-arm counters
  // reset — each grading request gets its own budget for both causes — and
  // the only place `lastInfoAtMs` clears, so liveness is always measured
  // against THIS dispatch's output, never the previous request's. That last
  // reset is DEFENSIVE only while `GRADING_WATCHDOG_LIVENESS_MS <
  // GRADING_WATCHDOG_TIMEOUT_MS` holds (a carried-over stamp is then always
  // at least a full watchdog window stale, so it could never vouch for this
  // dispatch anyway); raising the liveness window past the timeout makes it
  // load-bearing, and a unit test pins that ordering as the tripwire.
  slot.armedAtMs = Date.now();
  slot.watchdogSuspendRearms = 0;
  slot.watchdogLivenessRearms = 0;
  slot.lastInfoAtMs = 0;
  slot.watchdogTimer = setTimeout(() => fireWatchdog(state, ops, slot), GRADING_WATCHDOG_TIMEOUT_MS);
}

/** Assign as many pending requests as there are free (idle, ready) slots. */
export function dispatchNext(state: PoolState, ops: PoolOps): void {
  for (const slot of state.slots) {
    if (state.pending.length === 0) return;
    if (slot.state !== 'idle' || !slot.isReady || slot.current !== null) continue;
    const req = dequeueHighestPriority(state.pending);
    if (!req) return;
    sendGo(state, ops, slot, req);
  }
}

/** Handle one UCI line emitted by a pool worker (per-slot line handler). */
export function handleLine(state: PoolState, ops: PoolOps, slot: PoolWorkerSlot, line: string): void {
  if (line === 'uciok') {
    // Cap Hash low (Pitfall 1) — shallow searchmoves-restricted grading
    // gains nothing from a large hash table, and N workers at default
    // settings multiplies mobile memory pressure for no search-quality gain.
    slot.worker.postMessage(`setoption name Hash value ${WORKER_HASH_MB}`);
    slot.worker.postMessage('isready');
    return;
  }

  if (line === 'readyok') {
    ops.clearSlotWatchdog(slot); // disarms a replacement slot's init watchdog, if one is armed
    slot.isReady = true;
    ops.markPoolReady();
    dispatchNext(state, ops);
    return;
  }

  if (line.startsWith('info ')) {
    if (slot.state !== 'thinking' || slot.stopPending || slot.current === null) return;
    // FLAWCHESS-9G (second pass): stamp liveness BEFORE the parse filters
    // below. A worker grinding through a hard position emits plenty of
    // lines this branch goes on to discard (`currmove` reports carry no
    // score; lower/upperbound scores are not `exact`) — every one of them
    // is proof the worker is running, which is all `fireWatchdog` needs.
    slot.lastInfoAtMs = Date.now();
    const parsed = parseInfoLine(line);
    if (parsed === null || parsed.bound !== 'exact') return;
    const uci = parsed.pv[0];
    if (uci === undefined) return;

    const whitePovSign = sideToMove(slot.current.fen) === 'b' ? -1 : 1;
    const toWhitePov = (v: number | null): number | null => (v === null ? null : v * whitePovSign);

    // Never key by the info line's raw multipv rank field (it reorders
    // across depths) — key by pv[0], the move itself (SC5).
    slot.accumulator.set(uci, {
      evalCp: toWhitePov(parsed.scoreCp),
      evalMate: toWhitePov(parsed.scoreMate),
      depth: parsed.depth,
    });
    return;
  }

  if (line.startsWith('bestmove')) {
    const req = slot.current;
    if (slot.stopPending) {
      // Stale bestmove — the terminal response to our own `stop`. Discard
      // (FLAWCHESS-7V guard); the request was already settled elsewhere
      // (abort path, D-06 watchdog fire) or will be re-dispatched.
      // This clear is also (quick 260731-s0z, FIX-4) the disarm point for
      // the re-armed stop-bestmove watchdog on the healthy path — a
      // `bestmove` landing before STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS clears
      // it here before it can fire.
      ops.clearSlotWatchdog(slot);
      slot.stopPending = false;
      slot.state = 'idle';
      slot.current = null;
      dispatchNext(state, ops);
      return;
    }

    ops.clearSlotWatchdog(slot);
    slot.state = 'idle';
    slot.current = null;
    if (req) {
      // This `bestmove` branch is the ONLY caller of gradeCache.write — the
      // abort path, stopAll, terminate, and onerror all settle without
      // writing, which is precisely what keeps a partial grade out of the
      // cache. Do not "helpfully" add a write to one of those settle paths.
      state.gradeCache.write(req.fen, req.gradingDepth, slot.accumulator);
      req.resolve(slot.accumulator);
    }
    dispatchNext(state, ops);
  }
}

/** See `WorkerPool.grade()` (`EngineProviders.grade`, Phase 153/195). */
export function grade(
  state: PoolState,
  ops: PoolOps,
  fen: string,
  candidateUcis: string[],
  signal?: AbortSignal,
  gradingDepth?: number,
): Promise<Map<string, MoveGrade>> {
  const resolvedGradingDepth = gradingDepth ?? GRADING_ROOT_DEPTH;
  // WR-05: an empty searchmoves list would make Stockfish search ALL moves
  // and burn its full movetime budget on the public EngineProviders.grade
  // surface — fail fast before spawning anything.
  if (candidateUcis.length === 0) return Promise.resolve(new Map());
  // WR-01: a listener added via signal.addEventListener('abort', ...) below
  // never fires for a signal that is ALREADY aborted at call time — without
  // this guard the search would run to completion unnecessarily.
  if (signal?.aborted) return Promise.resolve(new Map());

  // INJECT-05: gradeCache.read() is the shipped read gate — this call site
  // is now IDENTICAL to what a Node harness sharing one createGradeCache()
  // instance across a baseline and an injected mctsSearch pass exercises,
  // so a measured hit rate (via cacheStats()) describes real cache
  // behavior, not a mirror.
  const hit = state.gradeCache.read(fen, candidateUcis, resolvedGradingDepth);
  if (hit) return Promise.resolve(hit);

  ops.ensureSpawned();
  // WR-03: if every slot construction attempt threw (0 live slots after the
  // spawn loop), nothing will ever dispatch a queued request — resolve
  // empty now rather than enqueuing into a queue nothing will service.
  // Phase 213-08: gated on `!spawnInFlight` — an empty `slots` array DURING
  // the shared-fetch/construction window is expected (nothing has been
  // built yet), not a failure, so this must fall through to the enqueue
  // path below rather than resolving empty. `spawnInFlight` is false again
  // once the construction loop has actually run and either built slots or
  // genuinely produced zero.
  if (state.slots.length === 0 && !state.spawnInFlight) return Promise.resolve(new Map());
  // Bug fix (quick 260731-s0z, FIX-3): the guard above only covers "no slot
  // was ever constructed". Once every constructed slot has since died (via
  // `worker.onerror`, `fireWatchdog`, or FIX-4's `fireStopWatchdog`), a NEW
  // request enqueued here was reachable and unrecoverable — `dispatchNext`
  // skips every non-`isReady` slot and `drainPending` only runs at a death
  // TRANSITION, not for a request queued afterward, so `useBotGame.ts`'s
  // signal-less `.grade(fen, [uci])` call hung unconditionally.
  // `noLiveSlotRemains()`'s OWN precondition (`slots.length > 0`) is what
  // makes this correct during the Phase 213-08 in-flight window too — it is
  // vacuously `false` for the still-empty `slots` array while a spawn is in
  // flight, so this guard does not fire before the guard above has settled
  // that case; it does not rely on the guard above having already
  // established a non-empty array.
  if (noLiveSlotRemains(state)) return Promise.resolve(new Map());

  return new Promise((resolve) => {
    // Phase 194 code-review WR-02: `{ once: true }` only self-removes the
    // listener if it FIRES. A request that settles normally would leave its
    // listener (and the `req` closure it captures) attached for the signal's
    // whole lifetime — and mctsSearch threads ONE signal through every grade
    // of a search, so a 400-node analysis search accumulated ~400 of them.
    // Settle through this wrapper so every exit path detaches.
    let onAbort: (() => void) | null = null;
    const settle = (grades: Map<string, MoveGrade>): void => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      onAbort = null;
      resolve(grades);
    };

    const req: QueuedGradeRequest = {
      fen,
      candidateUcis,
      priority: 0,
      depth: 0,
      gradingDepth: resolvedGradingDepth,
      resolve: settle,
    };
    enqueue(state.pending, req);

    if (signal) {
      onAbort = () => {
        const idx = state.pending.indexOf(req);
        if (idx >= 0) {
          // Unstarted — just drop it from the queue.
          state.pending.splice(idx, 1);
          settle(new Map());
          return;
        }
        // In-flight — send stop; the eventual bestmove is discarded by
        // the same stopPending/FLAWCHESS-7V guard handleLine already
        // uses for a superseded search.
        for (const slot of state.slots) {
          if (slot.current === req && slot.state === 'thinking') {
            // Bug fix (quick 260731-s0z, FIX-4): a bare `clearSlotWatchdog`
            // here left the slot parked in 'stopping' with no exit if the
            // worker never answers `stop` with a terminating `bestmove` —
            // arm the stop-bestmove watchdog instead so a genuinely hung
            // worker is bounded and marked dead rather than lost silently.
            ops.armStopWatchdog(slot);
            slot.worker.postMessage('stop');
            slot.stopPending = true;
            slot.state = 'stopping';
            settle(new Map());
            return;
          }
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    dispatchNext(state, ops);
  });
}
