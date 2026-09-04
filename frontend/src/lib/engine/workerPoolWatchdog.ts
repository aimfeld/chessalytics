/**
 * workerPoolWatchdog — the host-side fault-detection layer for
 * `workerPool.ts`'s per-slot UCI state machine (D-06, FLAWCHESS-9G, quick
 * 260731-s0z FIX-4): the grading watchdog (a `go` that never answers
 * `bestmove`), the stop-bestmove watchdog (a `stop` that never answers), and
 * the replacement-slot init watchdog (a respawned worker that never
 * completes its UCI handshake). Not a React hook — plain module, no UI
 * wiring, matching `maiaQueue.ts`'s "closure/module-level state, not a
 * hook" convention (Phase 215-02 extraction from `createWorkerPool()`).
 *
 * Every function here takes the pool's shared `PoolState` and cross-stage
 * `PoolOps` dispatch table as its first two parameters (`workerPoolState.ts`)
 * — most of these seven functions only need `slot` itself, but the uniform
 * signature is what lets `createWorkerPool()` wire every watchdog entry
 * point through one `ops` table without a per-function special case, and
 * `fireWatchdog` genuinely does need `state.slots`/`state.slotRespawns` for
 * its Sentry diagnostic context. Fault handling always ends the same way —
 * marking the slot `dead` and calling `ops.replaceDeadSlot(slot)` — which is
 * why `replaceDeadSlot` (owned by the lifecycle stage, not this module) is
 * only ever reached through `ops`, never imported directly. The pool's own
 * types and constants (the watchdog timeout/re-arm knobs) import from
 * `workerPoolState.ts`, never from the `workerPool.ts` facade (215 code
 * review WR-01) — see that file's header for why.
 */

import * as Sentry from '@sentry/react';
import type { PoolState, PoolOps, PoolWorkerSlot } from './workerPoolState';
import {
  GRADING_WATCHDOG_TIMEOUT_MS,
  GRADING_WATCHDOG_SUSPEND_FACTOR,
  MAX_WATCHDOG_SUSPEND_REARMS,
  GRADING_WATCHDOG_LIVENESS_MS,
  MAX_WATCHDOG_LIVENESS_REARMS,
  STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS,
  INIT_WATCHDOG_TIMEOUT_MS,
} from './workerPoolState';

/** Clear a slot's in-flight watchdog timer, if any. Idempotent. Extracted so the call sites that take a slot out of `thinking` cannot drift apart — bestmove, abort, `stopAll`, `terminate`, `onerror`, and the defensive clear in `sendGo`. */
export function clearSlotWatchdog(_state: PoolState, _ops: PoolOps, slot: PoolWorkerSlot): void {
  if (slot.watchdogTimer !== null) {
    clearTimeout(slot.watchdogTimer);
    slot.watchdogTimer = null;
  }
}

/**
 * Re-arm a slot's grading watchdog for another full
 * `GRADING_WATCHDOG_TIMEOUT_MS` window, leaving its request untouched.
 * Extracted for the same reason as `clearSlotWatchdog`: both of
 * `fireWatchdog`'s false-positive branches must re-stamp `armedAtMs` and
 * the timer together, or the next fire mis-measures its own elapsed time.
 */
export function rearmGradingWatchdog(
  state: PoolState,
  ops: PoolOps,
  slot: PoolWorkerSlot,
  nowMs: number,
): void {
  slot.armedAtMs = nowMs;
  slot.watchdogTimer = setTimeout(
    () => fireWatchdog(state, ops, slot),
    GRADING_WATCHDOG_TIMEOUT_MS,
  );
}

/**
 * D-06: fires when a slot's `sendGo` never produced a `bestmove` within
 * `GRADING_WATCHDOG_TIMEOUT_MS` — a genuinely hung/wedged worker, not a
 * merely slow position. Two false-positive gates run first and re-arm
 * instead of killing (FLAWCHESS-9G): a fire far past its deadline is page
 * suspension, and a fire from a slot still emitting `info` is a slow or
 * CPU-starved search. Only a slot that is both on-time and silent falls
 * through. Past the gates it is treated as a worker fault, mirroring `onerror`
 * exactly (reusing `dead` rather than inventing a new lifecycle state is
 * deliberate: a 60s grading `go` with no `bestmove` is not recoverable on
 * THAT worker, `dispatchNext` already skips non-`isReady` slots, and
 * `onerror` already proves this exact degradation path). The slot is not
 * lost with it — `replaceDeadSlot` spawns a fresh worker into its place.
 */
export function fireWatchdog(state: PoolState, ops: PoolOps, slot: PoolWorkerSlot): void {
  slot.watchdogTimer = null;

  // Bug fix (FLAWCHESS-9G): 4 production events over 20 days, 3 of 4 on
  // mobile browsers, all on /analysis — a backgrounded/suspended tab
  // freezes its workers along with the page, so the elapsed `setTimeout`
  // fires immediately on resume even though the worker never ran and is
  // not actually wedged. Treating that as a fault is a false positive that
  // costs a needless worker respawn (before `replaceDeadSlot` existed it
  // permanently shrank the pool for the rest of the session, and it still
  // spends `MAX_SLOT_RESPAWNS` budget). A fire this
  // far past deadline is attributed to suspension instead and silently
  // re-armed (bounded by `MAX_WATCHDOG_SUSPEND_REARMS` so a genuinely
  // wedged worker on a repeatedly suspended page still reaches the kill
  // path below). Non-goal: `fireStopWatchdog`/`armStopWatchdog` are
  // deliberately left unchanged — a slot in `'stopping'` has already been
  // sent `stop` and its request is being abandoned, and no production
  // Sentry event points at that path. `clearSlotWatchdog` is untouched.
  const nowMs = Date.now();
  const elapsedMs = nowMs - slot.armedAtMs;
  const sinceLastInfoMs = slot.lastInfoAtMs === 0 ? null : nowMs - slot.lastInfoAtMs;
  if (
    elapsedMs > GRADING_WATCHDOG_TIMEOUT_MS * GRADING_WATCHDOG_SUSPEND_FACTOR &&
    slot.watchdogSuspendRearms < MAX_WATCHDOG_SUSPEND_REARMS
  ) {
    slot.watchdogSuspendRearms++;
    rearmGradingWatchdog(state, ops, slot, nowMs);
    return;
  }

  // Bug fix (FLAWCHESS-9G, second pass): the suspension check above reads
  // HOST wall clock, which says nothing about whether the WORKER got CPU —
  // it only catches a deep freeze (a fire >90s past deadline). It missed
  // the desktop-Chrome event that reopened this issue, and by construction
  // it cannot catch either remaining false-positive shape: a moderately
  // throttled background tab (timer fires ~62s, worker never stopped
  // running) or a genuinely slow `go depth N` under CPU contention (D-05
  // removed the wall-clock bound, so a sharp position on a loaded machine
  // may legitimately outlast 60s with 2-4 WASM workers and Maia competing).
  // Both leave the fingerprint a real fault does not: a live `info` stream.
  // Re-arm on that instead — bounded by `MAX_WATCHDOG_LIVENESS_REARMS`, so
  // a worker that natters on forever without ever reaching `bestmove` still
  // reaches the kill path below.
  if (
    sinceLastInfoMs !== null &&
    sinceLastInfoMs < GRADING_WATCHDOG_LIVENESS_MS &&
    slot.watchdogLivenessRearms < MAX_WATCHDOG_LIVENESS_REARMS
  ) {
    slot.watchdogLivenessRearms++;
    rearmGradingWatchdog(state, ops, slot, nowMs);
    return;
  }

  // Best-effort: ask the worker to stop. It may never respond — that's
  // exactly why this fired — so this is not awaited or relied upon.
  slot.worker.postMessage('stop');
  // FLAWCHESS-9G (second pass): the original capture carried only the
  // `source` tag, so a fire could not be attributed to any of its three
  // causes (wedged worker / throttled tab / slow search) after the fact —
  // which is exactly why the one post-fix production event could not be
  // classified. Everything needed to tell them apart rides in a context,
  // never in the message: an interpolated value would fragment Sentry
  // grouping (CLAUDE.md). `otherLiveSlots` excludes this slot, which is
  // marked dead immediately below.
  Sentry.captureException(new Error('Stockfish worker pool: grading watchdog timeout'), {
    tags: { source: 'stockfish-worker-pool' },
    contexts: {
      stockfishWatchdog: {
        elapsedMs,
        sinceLastInfoMs,
        suspendRearms: slot.watchdogSuspendRearms,
        livenessRearms: slot.watchdogLivenessRearms,
        gradingDepth: slot.current?.gradingDepth ?? null,
        candidateCount: slot.current?.candidateUcis.length ?? null,
        gradesAccumulated: slot.accumulator.size,
        visibilityState: document.visibilityState,
        poolSize: state.slots.length,
        otherLiveSlots: state.slots.filter((other) => other !== slot && !other.dead).length,
        slotRespawns: state.slotRespawns,
      },
    },
  });
  slot.isReady = false;
  slot.dead = true;
  // Settle with a NEW empty Map — never `slot.accumulator`. A watchdog fire
  // means no terminal `bestmove` arrived within the bound; resolving with
  // whatever `info` lines happened to accumulate first would be the same
  // wall-clock-dependent truncation removing `GRADING_MOVETIME_SAFETY_CAP_MS`
  // exists to eliminate, only rarer and harder to reproduce (D-06).
  slot.current?.resolve(new Map());
  slot.current = null;
  ops.replaceDeadSlot(slot);
}

/**
 * Bug fix (quick 260731-s0z, FIX-4): arm the stop-bestmove watchdog on a
 * slot we just sent `stop` to, in place of a bare `clearSlotWatchdog`.
 * Reuses `watchdogTimer` rather than adding a second field — the two
 * bounds (`GRADING_WATCHDOG_TIMEOUT_MS` for a "go" that never answers,
 * `STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS` for a "stop" that never answers) are
 * mutually exclusive by slot state, and every existing exit path already
 * clears that one field.
 */
export function armStopWatchdog(state: PoolState, ops: PoolOps, slot: PoolWorkerSlot): void {
  clearSlotWatchdog(state, ops, slot);
  slot.watchdogTimer = setTimeout(
    () => fireStopWatchdog(state, ops, slot),
    STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS,
  );
}

/**
 * Bug fix (quick 260731-s0z, FIX-4): fires when a slot we sent `stop` to
 * never produces the terminating `bestmove` within
 * `STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS` — the slot was left parked in
 * `'stopping'` forever, permanently lost but never marked `dead`, so it
 * also blinded `noLiveSlotRemains()`. Deliberately mirrors `fireWatchdog`
 * rather than sharing a body: the two differ in whether a `stop` still
 * needs sending (it doesn't here — we already sent one) and in the Sentry
 * message; reusing `dead` (instead of a new lifecycle state) is the same
 * choice D-06 already made for `fireWatchdog`. `slot.stopPending` is left
 * alone here — `dead` is the dispatch gate, and a late `bestmove` on a
 * dead slot is already harmless (handleLine's stopPending branch would
 * just no-op it).
 */
export function fireStopWatchdog(_state: PoolState, ops: PoolOps, slot: PoolWorkerSlot): void {
  slot.watchdogTimer = null;
  // STATIC message — no interpolated FEN/UCI (CLAUDE.md Sentry grouping rule).
  Sentry.captureException(new Error('Stockfish worker pool: stop-bestmove watchdog timeout'), {
    tags: { source: 'stockfish-worker-pool' },
  });
  slot.isReady = false;
  slot.dead = true;
  slot.current?.resolve(new Map());
  slot.current = null;
  ops.replaceDeadSlot(slot);
}

/**
 * Bound a REPLACEMENT slot's init handshake (see `INIT_WATCHDOG_TIMEOUT_MS`).
 * Reuses `watchdogTimer`: a slot in init is neither `thinking` nor
 * `stopping`, so the field is free, and the `readyok` branch of `handleLine`
 * disarms it — the same field-sharing argument FIX-4 made for the
 * stop-bestmove bound.
 */
export function armInitWatchdog(state: PoolState, ops: PoolOps, slot: PoolWorkerSlot): void {
  slot.armedAtMs = Date.now();
  slot.watchdogTimer = setTimeout(
    () => fireInitWatchdog(state, ops, slot),
    INIT_WATCHDOG_TIMEOUT_MS,
  );
}

/** A replacement worker never finished its UCI handshake — treat it as any other slot death. */
export function fireInitWatchdog(_state: PoolState, ops: PoolOps, slot: PoolWorkerSlot): void {
  slot.watchdogTimer = null;
  // STATIC message — no interpolated data (CLAUDE.md Sentry grouping rule).
  Sentry.captureException(new Error('Stockfish worker pool: replacement worker init timeout'), {
    tags: { source: 'stockfish-worker-pool' },
  });
  slot.isReady = false;
  slot.dead = true;
  ops.replaceDeadSlot(slot);
}
