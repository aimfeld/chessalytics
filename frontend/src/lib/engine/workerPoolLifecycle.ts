/**
 * workerPoolLifecycle — the spawn/respawn/death stage of `workerPool.ts`'s
 * per-worker state machine: constructing a slot's `Worker` and wiring its
 * `progressPort`/`onmessage`/`onerror` handlers (`createSlot`), the
 * shared-URL construction loop that runs once per pool spawn
 * (`runSpawnConstructionLoop`, `ensureSpawned`), replacing a slot whose
 * worker has permanently failed so one fault costs a worker rather than a
 * slot for the rest of the page visit (`replaceDeadSlot`), and the three
 * public teardown/prewarm entry points (`stopAll`, `terminate`, `warm`)
 * (Phase 215-02 extraction from `createWorkerPool()`). Not a React hook —
 * plain module, no UI wiring, matching `maiaWorkerHost.ts`'s framing as
 * "the singleton that owns Worker spawn/respawn/death".
 *
 * Every function here takes the pool's shared `PoolState` and cross-stage
 * `PoolOps` dispatch table as its first two parameters (`workerPoolState.ts`)
 * — this stage reaches into the watchdog stage via `ops.clearSlotWatchdog`/
 * `ops.armInitWatchdog`, into the dispatch stage via `ops.handleLine`/
 * `ops.dispatchNext`, and into `createWorkerPool`'s own readiness functions
 * via `ops.markPoolFailed`. `markPoolReady`, `markPoolFailed` and
 * `whenReady` deliberately stay inside `createWorkerPool` itself (not this
 * module) — they own the `poolReadyWaiters`/`poolReadyRejecters` pair and
 * are the CR-01 readiness seam, and keeping them co-located with the
 * `WorkerPool` return literal keeps that contract readable in one place.
 * The pool's own types and constants (`MAX_SLOT_RESPAWNS`/`computePoolSize`/
 * `noLiveSlotRemains`) import from `workerPoolState.ts`, never from the
 * `workerPool.ts` facade (215 code review WR-01) — see that file's header
 * for why.
 */

import * as Sentry from '@sentry/react';
import {
  markEngineAssetPending,
  reportEngineAssetProgress,
} from './engineAssetProgress';
import { createStockfishWorker, ensureStockfishWorkerUrl } from './stockfishWorkerSource';
import type { PoolState, PoolOps, PoolWorkerSlot } from './workerPoolState';
import { MAX_SLOT_RESPAWNS, computePoolSize, noLiveSlotRemains } from './workerPoolState';

/**
 * Replace a slot whose worker has permanently failed, so one fault costs a
 * worker rather than a slot for the rest of the page visit (see
 * `MAX_SLOT_RESPAWNS`). Called by every death path — `worker.onerror`,
 * `fireWatchdog`, `fireStopWatchdog` — AFTER each has settled the slot's
 * in-flight request and marked it `dead`.
 *
 * Replaces the three call sites' former `if (noLiveSlotRemains()) drainPending()`
 * and keeps that guarantee: pending requests are still drained when no live
 * slot is left, which now means the respawn failed or the budget is spent. A
 * successful respawn deliberately does NOT drain — the fresh worker will
 * service the queue once its `readyok` lands.
 *
 * Two details that are load-bearing rather than defensive:
 *  - The dead worker is TERMINATED, not just dropped. `fireWatchdog` fires on
 *    a wedged-but-alive worker, which would otherwise keep its Stockfish heap
 *    and whatever it is chewing on for the rest of the visit.
 *  - Its handlers are detached FIRST. A wedged worker can still emit a late
 *    line or error, and that must not reach a slot no longer in the pool —
 *    `handleLine` would flip `isReady` on an orphan, and a late `onerror`
 *    would spend respawn budget on a slot already replaced.
 */
export function replaceDeadSlot(state: PoolState, ops: PoolOps, slot: PoolWorkerSlot): void {
  const idx = state.slots.indexOf(slot);
  if (idx === -1) return; // already replaced, or the pool was terminated under us
  ops.clearSlotWatchdog(slot);
  slot.worker.onmessage = null;
  slot.worker.onerror = null;
  slot.worker.terminate();

  if (state.slotRespawns >= MAX_SLOT_RESPAWNS) {
    state.slots.splice(idx, 1);
  } else {
    state.slotRespawns++;
    try {
      // Phase 213-08: reuses the ALREADY-RESOLVED shared URL from the
      // initial spawn — a slot death must never re-trigger (or wait on)
      // the shared fetch.
      const fresh = createSlot(state, ops, state.resolvedSharedUrl);
      state.slots[idx] = fresh;
      ops.armInitWatchdog(fresh);
    } catch (err) {
      // Same graceful-degradation floor as `ensureSpawned` (Pitfall 1): a
      // Worker constructor that throws leaves a smaller live pool, never an
      // exception escaping a death handler.
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { source: 'stockfish-worker-pool' },
      });
      state.slots.splice(idx, 1);
    }
  }

  // `noLiveSlotRemains()` is false for an EMPTY pool (it requires
  // `slots.length > 0`), so the emptiness case has to be tested separately —
  // otherwise splicing out the last slot would skip the drain and hang every
  // queued request.
  if (state.slots.length === 0 || noLiveSlotRemains(state)) {
    // CR-01 (213-REVIEW.md): every constructed slot has died and none can be
    // replaced (respawn budget spent, or replacement construction also
    // failed) — the pool can never dispatch another request. Without this,
    // `stockfish-wasm` never reaches `done: true` NOR `'failed'` in the
    // shared asset store, so `EngineReadyGate`'s Start button stays
    // disabled forever with no Retry affordance.
    ops.markPoolFailed();
    drainPending(state);
    return;
  }
  // A sibling may have been idle while this slot held the queue up.
  ops.dispatchNext();
}

/** Resolve (empty) every still-pending request — nothing will ever dispatch them. */
export function drainPending(state: PoolState): void {
  while (state.pending.length > 0) {
    const req = state.pending.pop();
    req?.resolve(new Map());
  }
}

/**
 * Phase 213-08 (G-213-35): `sharedUrl` is the ALREADY-RESOLVED shared
 * `.wasm` URL (or `null` on the degraded direct-construction path) — this
 * function never awaits `ensureStockfishWorkerUrl()` itself. The initial
 * spawn resolves it once in `ensureSpawned()`'s continuation and passes it
 * through; `replaceDeadSlot()` reuses the same already-resolved
 * `resolvedSharedUrl` closure variable for every later respawn, so a slot
 * death never re-triggers (or waits on) the shared fetch.
 */
export function createSlot(
  state: PoolState,
  ops: PoolOps,
  sharedUrl: string | null,
): PoolWorkerSlot {
  const worker = createStockfishWorker(sharedUrl);

  // Phase 213 D-01/T-213-01/T-213-07: wire the vendored glue's own,
  // already-shipped `progressPort` protocol (213-RESEARCH.md Pattern 2) —
  // this is wiring, not an owned fetch. The glue
  // (`stockfish-18-lite-single.js`) already streams the `.wasm` internally
  // against a hardcoded raw byte total; an app-side fetch of the same URL
  // would download 7.3 MB twice (213-RESEARCH.md Pitfall 4). Do not edit
  // the vendored file. Feature-detect `MessageChannel` (some environments,
  // and possibly a bare jsdom test env, may lack it) and skip the wiring
  // rather than throwing out of createSlot() — a missing progress bar must
  // never break engine spawn (T-213-07); the try/catch around this whole
  // function call in `ensureSpawned()`/`replaceDeadSlot()` remains the
  // graceful-degradation floor for everything else in this function.
  if (typeof MessageChannel !== 'undefined') {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (e: MessageEvent<{ loaded: number; total: number }>) => {
      // T-213-01: discard the glue's own `percent`/`speedBytesPerSec`/
      // `etaText` entirely and re-derive percent in the store, so Maia and
      // Stockfish share one clamping/coercion path. `total` is a hardcoded
      // constant in the glue today but the app must not assume that: the
      // store's own coercion falls back to STOCKFISH_WASM_BYTES_FALLBACK
      // when `total` is missing or non-positive.
      const { loaded, total } = e.data;
      reportEngineAssetProgress('stockfish-wasm', loaded, total);
    };
    worker.postMessage({ progressPort: port2 }, [port2]);
  }

  const slot: PoolWorkerSlot = {
    worker,
    state: 'idle',
    stopPending: false,
    isReady: false,
    dead: false,
    current: null,
    accumulator: new Map(),
    watchdogTimer: null,
    armedAtMs: 0,
    watchdogSuspendRearms: 0,
    lastInfoAtMs: 0,
    watchdogLivenessRearms: 0,
  };
  worker.onmessage = (e: MessageEvent<string>) => ops.handleLine(slot, e.data);
  // WR-03/WR-04: an async script-load failure (404, CSP block, syntax
  // error) never throws a catchable JS exception on the main thread — it
  // only surfaces here. Without this handler such a failure is completely
  // silent and any in-flight/future request on this slot hangs forever.
  worker.onerror = () => {
    Sentry.captureException(new Error('Stockfish worker pool: worker load failure'), {
      tags: { source: 'stockfish-worker-pool' },
    });
    // 195-06 review WR-01: this path settles the in-flight request but used
    // to leave the D-06 watchdog armed — the only one of the exit paths that
    // did. The stale 60s timer would later fire on an already-dead slot and
    // report a second, misleading "grading watchdog timeout" to Sentry for a
    // failure that was already correctly reported here.
    ops.clearSlotWatchdog(slot);
    slot.isReady = false;
    slot.dead = true;
    slot.current?.resolve(new Map());
    slot.current = null;
    replaceDeadSlot(state, ops, slot);
  };
  worker.postMessage('uci');
  return slot;
}

/**
 * Phase 213-08 (G-213-35): the construction loop, run once the shared
 * `.wasm` URL has settled (either resolved or, via the defensive `.catch`
 * below, treated as `null`). Verbatim continuation of the pre-Phase-213-08
 * synchronous loop: same per-slot try/catch so a throwing constructor
 * keeps the smaller live pool (Pitfall 1), same `markPoolFailed()` when
 * the loop produced zero slots (CR-01) — plus `drainPending()` on that
 * zero-slot path and `dispatchNext()` on the success path, because
 * requests may have queued up while the fetch was in flight.
 */
export function runSpawnConstructionLoop(
  state: PoolState,
  ops: PoolOps,
  sharedUrl: string | null,
): void {
  state.resolvedSharedUrl = sharedUrl;
  const size = computePoolSize();
  for (let i = 0; i < size; i++) {
    // Graceful-degradation floor (Pitfall 1): if a worker fails to
    // construct, keep whatever slots already succeeded and carry on with
    // a smaller live pool rather than throwing out of grade().
    try {
      state.slots.push(createSlot(state, ops, sharedUrl));
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { source: 'stockfish-worker-pool' },
      });
      continue;
    }
  }
  state.spawnInFlight = false;
  if (state.slots.length === 0) {
    // CR-01 (213-REVIEW.md): every construction attempt threw — no slot
    // will ever report `readyok`, so nothing will dispatch a request and
    // `whenReady()` would hang forever without this (mirrors
    // `replaceDeadSlot()`'s equivalent guard below). Phase 213-08: also
    // drains every request that queued up during the (now-finished) spawn
    // window — `grade()`'s in-flight guard let them enqueue instead of
    // resolving empty immediately, so this is where they finally settle.
    ops.markPoolFailed();
    drainPending(state);
  } else {
    // Phase 213-08: a sibling may have queued requests while spawning.
    ops.dispatchNext();
  }
}

export function ensureSpawned(state: PoolState, ops: PoolOps): void {
  if (state.spawned) return;
  state.spawned = true;
  // CR-02 (213-REVIEW.md): register 'stockfish-wasm' as in-flight BEFORE
  // any slot's async progress/ready message can arrive, so a concurrently
  // spawning, still-downloading 'maia-model' can never be silently absent
  // from `markEngineAssetReady`'s readiness check (see
  // `markEngineAssetPending`'s doc comment for the full race). Still
  // synchronous — Phase 213-08 only defers the WORKER CONSTRUCTION loop
  // below, not this registration.
  markEngineAssetPending('stockfish-wasm');
  state.spawnInFlight = true;
  // Captured BEFORE the await: a `terminate()` that runs while this fetch
  // is in flight bumps `spawnGeneration`, and the continuation below
  // compares against the (possibly stale) captured value to know its own
  // spawn was invalidated.
  const myGeneration = state.spawnGeneration;
  ensureStockfishWorkerUrl()
    .then((sharedUrl) => {
      if (myGeneration !== state.spawnGeneration) return; // terminate() ran mid-fetch — construct nothing
      runSpawnConstructionLoop(state, ops, sharedUrl);
    })
    .catch(() => {
      // Belt-and-braces (T-213-07): `ensureStockfishWorkerUrl()` is
      // documented to NEVER reject — every failure mode resolves `null`
      // instead. This defensive `.catch` exists only so a queued grade()
      // can never hang if that guarantee ever stops holding; it runs the
      // exact same construction loop with a null URL, degrading to
      // today's direct construction.
      if (myGeneration !== state.spawnGeneration) return;
      runSpawnConstructionLoop(state, ops, null);
    });
}

export function stopAll(state: PoolState, ops: PoolOps): void {
  for (const slot of state.slots) {
    if (slot.state === 'thinking') {
      // Bug fix (quick 260731-s0z, FIX-4): same re-arm as the abort path
      // above — a bare clearSlotWatchdog left a never-answering `stop`
      // unbounded.
      ops.armStopWatchdog(slot);
      slot.worker.postMessage('stop');
      slot.stopPending = true;
      slot.state = 'stopping';
      // CR-01: settle the DISPATCHED in-flight request now — its eventual
      // bestmove will be discarded by the stopPending/FLAWCHESS-7V guard in
      // handleLine (which already tolerates slot.current === null), so
      // nothing will ever resolve this promise otherwise.
      slot.current?.resolve(new Map());
      slot.current = null;
    }
  }
  // Resolve (empty) every still-pending request rather than leaving it to
  // hang forever now that nothing will ever dispatch it.
  while (state.pending.length > 0) {
    const req = state.pending.pop();
    req?.resolve(new Map());
  }
}

export function terminate(state: PoolState, ops: PoolOps): void {
  for (const slot of state.slots) {
    ops.clearSlotWatchdog(slot);
    slot.worker.postMessage('stop');
    slot.worker.terminate();
    // CR-02: worker.terminate() kills the worker outright — no bestmove
    // will ever arrive to resolve an in-flight request, so settle it here
    // (mirrors maiaQueue.terminate()'s folding of currentBatch into the
    // settled set).
    slot.current?.resolve(new Map());
    slot.current = null;
  }
  while (state.pending.length > 0) {
    const req = state.pending.pop();
    req?.resolve(new Map());
  }
  state.slots.length = 0;
  state.spawned = false;
  // Phase 213-08 (G-213-35): invalidate any in-flight spawn continuation —
  // a `terminate()` that lands while `ensureStockfishWorkerUrl()` is still
  // pending must not let that continuation push slots into this (now torn
  // down) pool once it finally resolves. `spawnInFlight` is cleared
  // unconditionally too: even if no spawn was in flight, this keeps the
  // flag's invariant ("true only between ensureSpawned() starting and its
  // construction loop finishing") honest across a terminate/re-spawn cycle.
  state.spawnGeneration++;
  state.spawnInFlight = false;
  state.slotRespawns = 0; // a re-spawned pool starts with a fresh respawn budget
  // Phase 213 T-213-08: settle (never leave hanging) every waiter of a
  // terminated pool — a re-spawned pool calls markPoolReady() again on its
  // own first readyok, so a caller awaiting THIS pool's readiness must not
  // be left dangling across the terminate/re-spawn boundary.
  state.poolReady = false;
  state.poolFailed = false; // a re-spawned pool gets a fresh chance at readyok
  const waiters = state.poolReadyWaiters.splice(0, state.poolReadyWaiters.length);
  state.poolReadyRejecters.length = 0; // paired rejecters for the same (now-resolved) promises
  for (const resolve of waiters) resolve();
}

/** Prewarm: spawn the pool without searching. See `WorkerPool.warm()`. */
export function warm(state: PoolState, ops: PoolOps): void {
  ensureSpawned(state, ops);
}
