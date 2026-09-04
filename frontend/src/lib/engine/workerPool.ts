/**
 * workerPool — a pool of 2-4 single-threaded Stockfish.wasm Web Workers that
 * grade candidate moves via `searchmoves`-restricted MultiPV searches,
 * fronted by a plain-array priority queue (POOL-01, POOL-02). The queue's
 * ordering machinery is fully built and unit-tested, but every request
 * dispatched through the current frozen 2-arg `EngineProviders.grade(fen,
 * candidateUcis)` contract carries `priority: 0, depth: 0` (no caller exists
 * yet to supply real values) — so dispatch order is NOT currently "toward the
 * currently-highest-scoring root line first" in practice. Phase 155's MCTS
 * orchestrator is the intended real priority source (see the priority-queue
 * section below and 154-03-SUMMARY.md WR-02).
 *
 * This is the real implementation of the frozen `EngineProviders.grade()`
 * method (Phase 153), generalizing the already-shipped single-worker
 * `useStockfishGradingEngine.ts` state machine (Phase 151.1) into N
 * independent instances. Not a React hook — plain module, no UI wiring
 * (that lands in Phase 155).
 *
 * Load-bearing caveat (SC5, confirmed on the real binary — 151.1-01-SUMMARY.md):
 * every MultiPV-consuming path here keys results by `parsed.pv[0]` (the move),
 * NEVER by the `multipv` field — that field is an eval RANK that reorders as
 * search depth climbs, not a stable move identity.
 *
 * Phase 195 (LADDER-02/04/06): `grade()` takes an optional 4th `gradingDepth`
 * param (mirroring the Phase 194 `signal` precedent) resolved by the caller
 * from `gradingDepthForTreeDepth(leaf.depth)`; the `go` line is composed
 * exclusively through `buildGradeGoCommand` (D-08, one shared builder for the
 * app and the `.mjs` calibration harnesses) and carries no wall-clock bound —
 * the removed `GRADING_MOVETIME_SAFETY_CAP_MS` is replaced by the host-side
 * watchdog (D-06, `GRADING_WATCHDOG_TIMEOUT_MS`) added in this file below.
 *
 * The tunable degradation knobs, the pool's own types
 * (`QueuedGradeRequest`/`PoolWorkerSlot`/`GradeCache`), and the pure
 * priority-queue/pool-sizing/predicate functions (`enqueue`/
 * `dequeueHighestPriority`/`sideToMove`/`isLowPowerDevice`/`computePoolSize`/
 * `noLiveSlotRemains`) live in `workerPoolState.ts` (215 code review WR-01) —
 * this file re-exports every one of them below for its existing external
 * importers (`useGemSweep.ts`'s `isLowPowerDevice`, `useFlawChessEngine.ts`'s
 * `computePoolSize`, and this module's own test file), rather than
 * redefining them, so the module graph stays a DAG: this facade and the
 * three stage modules all import FROM `workerPoolState.ts`, never the other
 * way around.
 */

import type { MoveGrade } from './types';
import { markEngineAssetFailed, markEngineAssetReady } from './engineAssetProgress';
import type {
  PoolState,
  PoolOps,
  PoolWorkerSlot,
  QueuedGradeRequest,
  GradeCache,
} from './workerPoolState';
import {
  GRADE_CACHE_MAX,
  DESKTOP_POOL_MIN,
  DESKTOP_POOL_MAX,
  MOBILE_POOL_SIZE,
  GRADING_WATCHDOG_TIMEOUT_MS,
  GRADING_WATCHDOG_SUSPEND_FACTOR,
  MAX_WATCHDOG_SUSPEND_REARMS,
  GRADING_WATCHDOG_LIVENESS_MS,
  MAX_WATCHDOG_LIVENESS_REARMS,
  STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS,
  MAX_SLOT_RESPAWNS,
  INIT_WATCHDOG_TIMEOUT_MS,
  enqueue,
  dequeueHighestPriority,
  isLowPowerDevice,
  computePoolSize,
} from './workerPoolState';
import {
  clearSlotWatchdog as wdClearSlotWatchdog,
  armStopWatchdog as wdArmStopWatchdog,
  armInitWatchdog as wdArmInitWatchdog,
} from './workerPoolWatchdog';
import {
  dispatchNext as dispatchDispatchNext,
  handleLine as dispatchHandleLine,
  grade as dispatchGrade,
} from './workerPoolDispatch';
import {
  replaceDeadSlot as lcReplaceDeadSlot,
  ensureSpawned as lcEnsureSpawned,
  stopAll as lcStopAll,
  terminate as lcTerminate,
  warm as lcWarm,
} from './workerPoolLifecycle';
export type { MoveGrade };

// Re-exported for existing external importers (useGemSweep.ts's
// isLowPowerDevice, useFlawChessEngine.ts's computePoolSize, and this
// module's own test file) — see the file header for why these are imports
// from workerPoolState.ts rather than local definitions.
export {
  GRADE_CACHE_MAX,
  DESKTOP_POOL_MIN,
  DESKTOP_POOL_MAX,
  MOBILE_POOL_SIZE,
  GRADING_WATCHDOG_TIMEOUT_MS,
  GRADING_WATCHDOG_SUSPEND_FACTOR,
  MAX_WATCHDOG_SUSPEND_REARMS,
  GRADING_WATCHDOG_LIVENESS_MS,
  MAX_WATCHDOG_LIVENESS_REARMS,
  STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS,
  MAX_SLOT_RESPAWNS,
  INIT_WATCHDOG_TIMEOUT_MS,
  enqueue,
  dequeueHighestPriority,
  isLowPowerDevice,
  computePoolSize,
};
export type { QueuedGradeRequest, GradeCache };

// ─── Types ──────────────────────────────────────────────────────────────────
//
// QueuedGradeRequest/PoolWorkerSlot/GradeCache moved to workerPoolState.ts
// (215 code review WR-01). QueuedGradeRequest/GradeCache are re-exported above
// for existing importers; PoolWorkerSlot and the pure helpers with no external
// importer through this module (knip 6.34 flags dead re-exports) are not.

/** The public surface `createWorkerPool()` returns — implements `EngineProviders.grade` (D-08). */
export interface WorkerPool {
  /**
   * UCI-keyed white-POV grades for `candidateUcis` at `fen` (EngineProviders.grade
   * shape — the optional `signal` AND the optional `gradingDepth` are
   * ADDITIONAL params, so this stays structurally assignable to the frozen
   * 2-arg `EngineProviders.grade`). `gradingDepth` defaults to
   * `GRADING_ROOT_DEPTH` when omitted (D-02) — the caller-resolved Stockfish
   * search depth from `gradingDepthForTreeDepth(leaf.depth)` (LADDER-02).
   * On abort: an unstarted (still-pending) request is removed from the queue;
   * an in-flight request sends `stop` to its slot. Either way the returned
   * promise resolves with an empty Map rather than hanging or throwing. A
   * dispatched search that never returns `bestmove` is bounded by the
   * host-side watchdog (D-06) instead of a wall-clock movetime bound.
   */
  grade(
    fen: string,
    candidateUcis: string[],
    signal?: AbortSignal,
    gradingDepth?: number,
  ): Promise<Map<string, MoveGrade>>;
  /** Send `stop` to every thinking slot and resolve (empty) every pending request. */
  stopAll(): void;
  /** Stop + `worker.terminate()` every slot; a later `grade()` call re-spawns the pool (and resets the `MAX_SLOT_RESPAWNS` budget). */
  terminate(): void;
  /**
   * Spawn the Stockfish worker pool with NO search and no movetime spend, so
   * the opening-book window (Phase 169.5) pays the worker-spawn cost instead
   * of the first move the bot actually has to search — which, under the book,
   * is the first move OUT of book and exactly the one we least want cold.
   *
   * Idempotent: the body is a bare `ensureSpawned()` call, which short-circuits
   * on its own `spawned` flag, so a re-running effect cannot spawn a second pool.
   *
   * Do NOT "simplify" this to `grade(fen, [])`. That spawns NOTHING: `grade()`
   * returns early on the WR-05 empty-candidates guard BEFORE `ensureSpawned()`
   * is ever reached. It does not throw and does not error — it is a silent
   * no-op as a prewarm trigger, which is precisely why this dedicated method
   * exists (pinned by a test in `__tests__/workerPool.test.ts`).
   */
  warm(): void;
  /**
   * INJECT-05: exact hit/miss counts for this pool's shared `GradeCache`
   * since pool creation (or since the last `resetCacheStats()` call). A
   * hit/miss here counts a cache OUTCOME (see `GradeCache.read`'s doc
   * comment) — not whether a dispatched Stockfish search ultimately
   * produced a result. Read-only: calling `cacheStats()` cannot change any
   * observable `grade()` behavior.
   */
  cacheStats(): { hits: number; misses: number };
  /**
   * INJECT-05: resets this pool's `GradeCache` hit/miss counters (as
   * reported by `cacheStats()`) to zero WITHOUT evicting any cached entry —
   * a subsequent identical `grade()` request still reports a hit.
   */
  resetCacheStats(): void;
  /**
   * Phase 213 D-01: resolves the first time ANY slot completes its UCI init
   * handshake (`uciok` then `readyok`) — the Stockfish-side readiness
   * definition, matching Maia's "bytes downloaded and the engine usable"
   * (`maiaWorkerHost.ts`'s own `whenReady()`). "First slot ready" is
   * sufficient because `dispatchNext()` already skips non-`isReady` slots; it
   * does not wait for the other `computePoolSize()` slots. Lazily spawns the
   * pool (via `ensureSpawned()`) if it has not been spawned yet, so the
   * promise can actually settle. Consumers: this pool's own `stockfish-wasm`
   * asset-store transition (below) and `useFlawChessEngine` (Plan 05).
   * Resets on `terminate()` — a subsequent call is pending again until the
   * re-spawned pool reports its own first `readyok`.
   */
  whenReady(): Promise<void>;
}

// ─── Priority queue / pool sizing / noLiveSlotRemains (POOL-01/02/04, D-01) ─
//
// enqueue/dequeueHighestPriority/isLowPowerDevice/computePoolSize/sideToMove/
// noLiveSlotRemains moved to workerPoolState.ts (215 code review WR-01) —
// re-exported above for existing importers (this module's own
// createGradeCache/createWorkerPool below use the imported bindings
// directly).

// ─── Pool factory: N worker slots + priority-queued dispatch ───────────────
//
// N independent copies of useStockfishGradingEngine's proven per-worker state
// machine (same ENGINE_PATH, same classic non-module Worker load, same
// stop-before-go/stopPending serialization, same pv[0]-keyed white-POV
// parsing), coordinated by the priority queue above instead of one FEN's
// request/response cycle. Worker slots are spawned lazily, on the first
// grade() call (D-02) — never eagerly at factory-construction time.

// GradeCache interface moved to workerPoolState.ts (215 code review WR-01) —
// re-exported above for existing importers.

/**
 * Extracted from `createWorkerPool`'s in-closure cache (Phase 194
 * CACHE-01..04) so a Node measurement harness (INJECT-05,
 * `scripts/engine-root-injection.mjs`) can read/write through the shipped
 * read gate, keying, LRU touch, and merge semantics directly, and so
 * `createWorkerPool`'s own `grade()` and that harness share exactly one
 * `GradeCache` instance each rather than two implementations that could
 * silently drift apart. This is a behaviour-preserving move: the read gate,
 * keying, LRU touch, merge semantics, and eviction policy below are
 * byte-identical to the pre-extraction closure — only the hit/miss counters
 * are new (INJECT-05).
 */
export function createGradeCache(): GradeCache {
  const cache = new Map<string, Map<string, MoveGrade>>();
  let cacheHits = 0;
  let cacheMisses = 0;

  /**
   * The ONLY place a grade-cache key is built (LADDER-03/ENGINE-07). Composes
   * `(fen, gradingDepth)` into a flat template string, in the same pipe-joined
   * idiom `maiaPolicyCache.ts`'s `cacheKey(fen, elo)` uses — a FEN never
   * contains the separator, so the mapping is injective. Every read, delete,
   * and write below MUST route through this helper: if any one of them built
   * its own key expression, the cache would silently split into two key
   * spaces and a depth-14 grade could satisfy a depth-10 request (or vice
   * versa) whenever the two expressions happened to collide or diverge.
   */
  function cacheKey(fen: string, gradingDepth: number): string {
    return `${fen}|${gradingDepth}`;
  }

  function write(fen: string, gradingDepth: number, grades: Map<string, MoveGrade>): void {
    // CACHE-03: merge into any existing (fen, gradingDepth) entry rather than
    // replacing it, scoped within a single depth. A same-(fen, depth) request
    // with a shifted candidate set (the root's candidate list can widen or
    // narrow across PUCT selection rounds) must not destroy grades already
    // accumulated for UCIs outside this call's request. Incoming values win
    // on key collision — a re-grade of the same UCI at the same depth is the
    // same computation, so overwriting is safe.
    const key = cacheKey(fen, gradingDepth);
    const existing = cache.get(key);
    const merged = existing ? new Map(existing) : new Map<string, MoveGrade>();
    for (const [uci, grade] of grades) merged.set(uci, grade);
    // Phase 194 code-review WR-01: a write is a use. `Map.set` on an ALREADY
    // PRESENT key does not reorder it, so without this delete a re-graded
    // entry keeps its original insertion position and the eviction below
    // picks it as if the cache were still FIFO. That hits the worst possible
    // target: the root is the entry most often re-graded (its candidate set
    // widens across PUCT rounds — the very case the merge above exists for),
    // so the entry CACHE-02 is meant to protect would be the first one
    // dropped.
    cache.delete(key);
    cache.set(key, merged);
    // LRU eviction: both the read-hit branch in read() below and the write
    // above do a delete-then-reinsert touch, so Map's insertion-order
    // iteration here yields the least-recently-USED entry, not the
    // least-recently-inserted one (CACHE-02).
    if (cache.size > GRADE_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  function read(
    fen: string,
    candidateUcis: string[],
    gradingDepth: number,
  ): Map<string, MoveGrade> | null {
    // LADDER-03/ENGINE-07: the key is the composite (fen, gradingDepth), built
    // ONCE here via the single key helper and reused for the read gate below
    // AND for both halves of the read-hit LRU touch. A depth-14 cached entry
    // must never satisfy a depth-10 request (or vice versa) regardless of
    // which visit order reached this FEN first — an exact composite-key match
    // is the ONLY read path; there is no "nearest depth" or "deeper is better"
    // fallback.
    const key = cacheKey(fen, gradingDepth);
    const cached = cache.get(key);
    // CACHE-04: partial-hit (subset) grading was tested against the vendored
    // Stockfish binary using the shipped `go depth 14 searchmoves ...
    // movetime 2500` shape, and produced a DIFFERENT cp for the same move at
    // the same reported depth (bound exact) than a full-set grade of the same
    // (fen, move) — the italian position's f3e5 at -301 (5-move set) vs -253
    // (2-move subset), and the middlegame position's f3e5 at 9 (5-move set)
    // vs 5 (2-move subset), both at matching depth 14. `searchmoves`
    // restriction changes Stockfish's internal move ordering and time
    // allocation, so a subset grade is not interchangeable with a full-set
    // grade even at matching depth. Keep this all-or-nothing read (scoped to
    // one (fen, depth) entry); do not add a partial-hit path. [CITED:
    // 194-RESEARCH.md Pattern 5, measured 2026-07-30]
    if (cached && candidateUcis.every((uci) => cached.has(uci))) {
      // Pool-level cache hit (position-only, ELO-independent) — no new go.
      const subset = new Map<string, MoveGrade>();
      for (const uci of candidateUcis) {
        const g = cached.get(uci);
        if (g) subset.set(uci, g);
      }
      // LRU touch-on-hit: delete then reinsert so Map's insertion-order
      // iteration (consumed by write()'s `keys().next().value` eviction)
      // yields the least-recently-USED entry, not the least-recently-inserted
      // one (CACHE-02).
      cache.delete(key);
      cache.set(key, cached);
      cacheHits += 1;
      return subset;
    }
    // INJECT-05: a miss is counted here, at the ONLY point this cache decides
    // "fresh Stockfish work is needed" — before ensureSpawned()/dispatch, so
    // these counters measure cache OUTCOMES, not Stockfish-dispatch outcomes.
    // The caller may still resolve empty AFTER a counted miss via its own
    // separate zero-live-slots guard; that is a distinct, later failure mode
    // and does not change what this counter measures.
    cacheMisses += 1;
    return null;
  }

  function stats(): { hits: number; misses: number } {
    return { hits: cacheHits, misses: cacheMisses };
  }

  function resetCacheStats(): void {
    cacheHits = 0;
    cacheMisses = 0;
  }

  return { read, write, stats, resetCacheStats };
}

export function createWorkerPool(): WorkerPool {
  const state: PoolState = {
    slots: [],
    pending: [],
    gradeCache: createGradeCache(),
    spawned: false,
    /**
     * Phase 213-08 (G-213-35): true from the moment `ensureSpawned()` starts
     * until the construction loop (the `ensureStockfishWorkerUrl()`
     * continuation) has run. While true, `grade()`'s first zero-slot guard
     * must NOT short-circuit — a request arriving during this window is
     * queued and dispatched once slots appear, never resolved empty.
     */
    spawnInFlight: false,
    /**
     * Phase 213-08: bumped by `terminate()` and captured by `ensureSpawned()`
     * before its `ensureStockfishWorkerUrl()` await — a spawn continuation
     * that resolves after a `terminate()` ran mid-fetch compares its captured
     * generation against the current one and constructs nothing if they no
     * longer match. Prevents a late continuation from pushing slots into a
     * pool the caller already tore down.
     */
    spawnGeneration: 0,
    /**
     * Phase 213-08: the shared `.wasm` URL once `ensureStockfishWorkerUrl()`
     * resolves (or `null` on the degraded/failed path) — set once by the
     * initial spawn's continuation and reused by every later
     * `replaceDeadSlot()` respawn, which must never re-await the shared fetch.
     */
    resolvedSharedUrl: null,
    /** Respawns consumed so far — see `MAX_SLOT_RESPAWNS`. */
    slotRespawns: 0,
    /** Phase 213 D-01: true once ANY slot has completed its UCI init handshake. Reset by `terminate()`. */
    poolReady: false,
    /**
     * CR-01 (213-REVIEW.md): true once the pool has been marked irrecoverably
     * dead by `markPoolFailed()` (with no `readyok` ever having landed). Lets a
     * `whenReady()` call arriving AFTER that point (e.g. `warm()` triggered the
     * failure earlier, before any consumer awaited readiness) reject
     * immediately instead of registering a waiter nothing will ever settle —
     * `ensureSpawned()` is a no-op once `spawned` is already true, so without
     * this flag `markPoolFailed()`'s own reject-on-fire is the ONLY chance a
     * late `whenReady()` caller would ever get. Reset by `terminate()`.
     */
    poolFailed: false,
    /** Callers awaiting `whenReady()` before the first slot has reported `readyok`. */
    poolReadyWaiters: [],
    /**
     * CR-01 (213-REVIEW.md): callers awaiting `whenReady()` to be REJECTED once
     * the pool can never dispatch another request — settled by `markPoolFailed()`
     * below, the same moment `markEngineAssetFailed('stockfish-wasm')` fires.
     * Parallel array to `poolReadyWaiters`, same index per pending `whenReady()`
     * call (both pushed together in `whenReady()`).
     */
    poolReadyRejecters: [],
  };

  /**
   * Phase 213 D-01: the single place both `whenReady()`'s promise and the
   * `stockfish-wasm` asset-store transition fire, so they can never diverge.
   * No-ops if the pool is already marked ready (idempotent — `handleLine`'s
   * `readyok` branch calls this on every slot's readyok, not just the first).
   */
  function markPoolReady(): void {
    if (state.poolReady) return;
    state.poolReady = true;
    const waiters = state.poolReadyWaiters.splice(0, state.poolReadyWaiters.length);
    state.poolReadyRejecters.length = 0; // the promise is settling via resolve(); these are now moot
    for (const resolve of waiters) resolve();
    markEngineAssetReady('stockfish-wasm');
  }

  /**
   * CR-01 (213-REVIEW.md): fires wherever the pool can never dispatch another
   * request — either every construction attempt in `ensureSpawned()` threw,
   * or `replaceDeadSlot()` has exhausted every slot with no live replacement.
   * Marks the shared `stockfish-wasm` asset entry `'failed'` (so
   * `EngineReadyGate` can show Retry instead of leaving the Start button
   * disabled forever — the store-level fix for the deadlock) AND rejects
   * every outstanding `whenReady()` waiter (so `useFlawChessEngine`'s
   * `Promise.all([...]).catch()` can actually fire instead of hanging).
   * No-op on the reject side once the pool has already reported ready once —
   * `poolReadyWaiters`/`poolReadyRejecters` are already empty by then
   * (spliced out by `markPoolReady()`), so a later fatal failure still flips
   * the shared store to `'failed'` without retroactively un-resolving an
   * already-settled `whenReady()` promise.
   */
  function markPoolFailed(): void {
    state.poolFailed = true;
    markEngineAssetFailed('stockfish-wasm');
    const rejecters = state.poolReadyRejecters.splice(0, state.poolReadyRejecters.length);
    state.poolReadyWaiters.length = 0; // paired resolvers for the same promises — now moot
    for (const reject of rejecters) {
      reject(new Error('Stockfish worker pool: failed to become ready'));
    }
  }

  // ─── Watchdog stage delegation (Phase 215-02) ────────────────────────────
  //
  // The seven watchdog functions themselves (fault detection for a hung
  // grading `go`, a hung `stop`, and a hung replacement-slot init handshake)
  // now live in `workerPoolWatchdog.ts` — see that file for the full
  // implementation and doc comments. These four thin wrappers exist so every
  // pre-existing call site below (`clearSlotWatchdog(slot)`,
  // `armStopWatchdog(slot)`, `armInitWatchdog(slot)`, and the `fireWatchdog`
  // reference `sendGo` arms directly) keeps reading exactly as it did before
  // the split — each just forwards this pool's own `state`/`ops` through to
  // the extracted implementation. `rearmGradingWatchdog` and
  // `fireStopWatchdog`/`fireInitWatchdog` have no remaining call site in this
  // file (they are only ever invoked from within `workerPoolWatchdog.ts`
  // itself), so they are wired directly into `ops` below without a local
  // wrapper.
  function clearSlotWatchdog(slot: PoolWorkerSlot): void {
    wdClearSlotWatchdog(state, ops, slot);
  }

  function armStopWatchdog(slot: PoolWorkerSlot): void {
    wdArmStopWatchdog(state, ops, slot);
  }

  function armInitWatchdog(slot: PoolWorkerSlot): void {
    wdArmInitWatchdog(state, ops, slot);
  }

  // ─── Dispatch stage delegation (Phase 215-02) ────────────────────────────
  //
  // `sendGo`/`dispatchNext`/`handleLine`/`grade` themselves — the request
  // dispatcher, the UCI message parser (`handleLine`, the wire-protocol
  // interpreter and highest-risk function in the phase), and the public
  // `grade()` entry point — now live in `workerPoolDispatch.ts`. These two
  // thin wrappers keep every pre-existing call site in this file
  // (`dispatchNext()` from `replaceDeadSlot`/`runSpawnConstructionLoop`,
  // `handleLine(slot, line)` from `createSlot`'s `worker.onmessage`) reading
  // exactly as before. `sendGo` has no remaining call site in this file (its
  // only caller, `dispatchNext`, moved with it), so it is not re-wrapped
  // here.
  function dispatchNext(): void {
    dispatchDispatchNext(state, ops);
  }

  function handleLine(slot: PoolWorkerSlot, line: string): void {
    dispatchHandleLine(state, ops, slot, line);
  }

  // ─── Lifecycle stage delegation (Phase 215-02) ───────────────────────────
  //
  // `replaceDeadSlot`/`drainPending`/`createSlot`/`runSpawnConstructionLoop`/
  // `ensureSpawned`/`stopAll`/`terminate`/`warm` themselves — spawn/respawn/
  // death and the three public teardown/prewarm entry points — now live in
  // `workerPoolLifecycle.ts`. None of them has a remaining direct call site
  // in this file: every reference below goes through `ops` (for the
  // dispatch-table fields) or a same-signature local wrapper (for `stopAll`/
  // `terminate`/`warm`, which the returned `WorkerPool` object still
  // references by shorthand). `whenReady()`'s own `ensureSpawned()` call
  // becomes `ops.ensureSpawned()` below for the same reason.

  // Delegates to the dispatch stage (Phase 215-02) — see
  // `workerPoolDispatch.ts` for the full implementation. A local wrapper
  // (rather than an inline arrow in the `ops`/return object) keeps this
  // matching the original top-level `function grade(...)` declaration so the
  // returned object's `grade,` shorthand below is unchanged.
  function grade(
    fen: string,
    candidateUcis: string[],
    signal?: AbortSignal,
    gradingDepth?: number,
  ): Promise<Map<string, MoveGrade>> {
    return dispatchGrade(state, ops, fen, candidateUcis, signal, gradingDepth);
  }

  function stopAll(): void {
    lcStopAll(state, ops);
  }

  function terminate(): void {
    lcTerminate(state, ops);
  }

  /** Prewarm: spawn the pool without searching. See `WorkerPool.warm()`. */
  function warm(): void {
    lcWarm(state, ops);
  }

  /**
   * See `WorkerPool.whenReady()`.
   *
   * CR-01 (213-REVIEW.md): now has a real reject path. Previously this
   * promise's executor only destructured `resolve`, so a totally dead pool
   * (every slot construction failed, or every slot died with the respawn
   * budget spent) left this promise pending forever — `useFlawChessEngine`'s
   * `Promise.all([...]).catch()` could then never fire. `reject` is pushed to
   * `poolReadyRejecters` and settled by `markPoolFailed()` wherever the pool
   * becomes irrecoverably dead. Also rejects IMMEDIATELY if the pool was
   * already marked failed before this call (e.g. `warm()` triggered the
   * failure earlier) — `ensureSpawned()` no-ops once `spawned` is already
   * true, so a late caller would otherwise register a waiter nothing will
   * ever settle.
   */
  function whenReady(): Promise<void> {
    if (state.poolReady) return Promise.resolve();
    if (state.poolFailed) {
      return Promise.reject(new Error('Stockfish worker pool: failed to become ready'));
    }
    return new Promise<void>((resolve, reject) => {
      state.poolReadyWaiters.push(resolve);
      state.poolReadyRejecters.push(reject);
      ops.ensureSpawned();
    });
  }

  // ─── Cross-stage dispatch table (Phase 215-02) ───────────────────────────
  //
  // See `workerPoolState.ts` for why this exists as one shared table rather
  // than direct imports between sibling stage modules. Every field now
  // delegates to its extracted stage module (`workerPoolWatchdog.ts`,
  // `workerPoolDispatch.ts`, `workerPoolLifecycle.ts`) — `markPoolReady`/
  // `markPoolFailed` are the only fields still backed by functions defined
  // inline above, since those two (plus `whenReady`) deliberately stay
  // inside `createWorkerPool` itself (see `workerPoolLifecycle.ts`'s header
  // JSDoc for why).
  const ops: PoolOps = {
    markPoolReady,
    markPoolFailed,
    clearSlotWatchdog,
    armStopWatchdog,
    armInitWatchdog,
    dispatchNext,
    handleLine,
    replaceDeadSlot: (slot) => lcReplaceDeadSlot(state, ops, slot),
    ensureSpawned: () => lcEnsureSpawned(state, ops),
  };

  return {
    grade,
    stopAll,
    terminate,
    warm,
    cacheStats: () => state.gradeCache.stats(),
    resetCacheStats: () => state.gradeCache.resetCacheStats(),
    whenReady,
  };
}
