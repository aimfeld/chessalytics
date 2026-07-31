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
 */

import * as Sentry from '@sentry/react';
import { parseInfoLine } from '@/hooks/uciParser';
import type { MoveGrade } from './types';
export type { MoveGrade };

// ─── Tunable constants (SC4 degradation knobs — tunable without touching logic) ──

/** Path to the vendored Stockfish engine served from public/engine/. Same binary as the primary/grading workers, N SEPARATE Worker() loads (one per pool slot). */
export const ENGINE_PATH = '/engine/stockfish-18-lite-single.js';

/** Grading search depth target — matches the single-worker grading hook's conservative default. */
export const GRADING_TARGET_DEPTH = 14;

/** Wall-clock safety valve (ms) so a slow position never stalls a pool worker. */
export const GRADING_MOVETIME_SAFETY_CAP_MS = 2500;

/**
 * Pool-level (per-FEN) grade-cache cap. A full 400-node analysis-board search
 * touches a measured 352-386 distinct FENs (194-RESEARCH.md Pattern 4) — 256
 * was small enough that a single search thrashed its own cache before
 * cross-search reuse was even possible. 1024 is the next power of two above
 * roughly 2.6x the measured 386-FEN ceiling: one full search's working set
 * plus about 1.6 searches worth of navigation history (Phase 194 CACHE-01).
 */
export const GRADE_CACHE_MAX = 1024;

/** Per-worker `Hash` UCI option cap (MB) — Pitfall 1 mitigation: shallow searchmoves-restricted grading doesn't benefit from a large hash table, and N workers at default Hash settings multiplies mobile memory pressure for no search-quality gain. */
export const WORKER_HASH_MB = 8;

/** Desktop pool-size floor (also the DESKTOP_POOL_MIN/undefined-cores fallback). */
export const DESKTOP_POOL_MIN = 2;

/** Desktop pool-size ceiling. */
export const DESKTOP_POOL_MAX = 4;

/** Cores reserved for the main thread + Maia worker when sizing the desktop pool. */
export const DESKTOP_HEADROOM_CORES = 2;

/** Mobile pool size — fixed, not derived from cores (D-01). */
export const MOBILE_POOL_SIZE = 2;

/** `hardwareConcurrency` at or below this counts as "mobile" (D-01). */
export const MOBILE_CORE_THRESHOLD = 4;

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single pending grade() request awaiting dispatch to a free worker slot. */
export interface QueuedGradeRequest {
  fen: string;
  candidateUcis: string[];
  /** Higher = more urgent. Derived by the caller from the root ancestor's current practicalScore (POOL-02). */
  priority: number;
  /** Tie-break 2: shallower depth-from-root wins. */
  depth: number;
  resolve: (grades: Map<string, MoveGrade>) => void;
}

/** Internal per-worker UCI state machine states — mirrors useStockfishGradingEngine's EngineState. */
type SlotState = 'idle' | 'thinking' | 'stopping';

/** One pool worker slot: a classic Worker plus its stop-before-go state machine. */
export interface PoolWorkerSlot {
  worker: Worker;
  state: SlotState;
  /** True while a `stop` we sent is awaiting its terminal `bestmove` (FLAWCHESS-7V guard). */
  stopPending: boolean;
  /** True once this slot's UCI init sequence (uciok -> Hash -> isready -> readyok) completes. */
  isReady: boolean;
  /** True once this slot's worker has fired an `error` event — permanently out of service (WR-04). */
  dead: boolean;
  /** The request currently assigned to this slot, or null when free. */
  current: QueuedGradeRequest | null;
  /** In-flight grades accumulated from `info` lines for `current`, keyed by pv[0] (UCI). */
  accumulator: Map<string, MoveGrade>;
}

/** The public surface `createWorkerPool()` returns — implements `EngineProviders.grade` (D-08). */
export interface WorkerPool {
  /**
   * UCI-keyed white-POV grades for `candidateUcis` at `fen` (EngineProviders.grade
   * shape — the optional `signal` is an ADDITIONAL param, so this stays
   * structurally assignable to the frozen 2-arg `EngineProviders.grade`).
   * On abort: an unstarted (still-pending) request is removed from the queue;
   * an in-flight request sends `stop` to its slot. Either way the returned
   * promise resolves with an empty Map rather than hanging or throwing.
   */
  grade(fen: string, candidateUcis: string[], signal?: AbortSignal): Promise<Map<string, MoveGrade>>;
  /** Send `stop` to every thinking slot and resolve (empty) every pending request. */
  stopAll(): void;
  /** Stop + `worker.terminate()` every slot; a later `grade()` call re-spawns the pool. */
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
}

// ─── Priority queue (POOL-02): plain array, linear max-scan ────────────────
//
// No maintained priority-queue library fits this workload's scale (hundreds
// of pending grades per search, not millions) — a hand-rolled O(n) linear
// scan is both correct and fast enough. Tie-break order matches every other
// canonical tie-break in the Phase 153 core: NEVER insertion/arrival order.
//
// WR-02: `priority`/`depth` are populated by a caller that computes
// per-root-line practical scores. Every request built by `grade()` today
// still carries `priority: 0, depth: 0` (see below) because Phase 155's MCTS
// orchestrator dispatches at most `computePoolSize()` concurrent expansions
// per round — dispatch capacity always keeps pace with demand, so this
// ordering logic is correct and tested in isolation but has no discriminating
// input to act on yet. Phase 198 (mctsSearch continuous dispatch) is the
// consumer that will populate real priority values once in-flight expansions
// can exceed free worker slots, making dispatch order matter for the first
// time. Deliberately retained, not dead code (Phase 194 CACHE-06).

/** Push a new request onto the pending array. */
export function enqueue(pending: QueuedGradeRequest[], req: QueuedGradeRequest): void {
  pending.push(req);
}

/**
 * Remove and return the highest-priority pending request. Ties broken by
 * smaller `depth`, then by ascending `candidateUcis[0]` UCI string —
 * NEVER by insertion/arrival order. Returns undefined on an empty array.
 */
export function dequeueHighestPriority(
  pending: QueuedGradeRequest[],
): QueuedGradeRequest | undefined {
  let best: QueuedGradeRequest | undefined;
  let bestIdx = -1;
  pending.forEach((req, i) => {
    const better =
      best === undefined ||
      req.priority > best.priority ||
      (req.priority === best.priority && req.depth < best.depth) ||
      (req.priority === best.priority &&
        req.depth === best.depth &&
        (req.candidateUcis[0] ?? '') < (best.candidateUcis[0] ?? ''));
    if (better) {
      best = req;
      bestIdx = i;
    }
  });
  if (bestIdx >= 0) pending.splice(bestIdx, 1);
  return best;
}

// ─── Adaptive pool sizing (POOL-04/D-01): plain function, not a React hook ──
//
// Because this module is explicitly NOT a React hook, sizing is a plain,
// non-reactive function computed ONCE at lazy-spawn time (D-02), not a
// useIsMobile()-style hook with re-render-on-resize semantics.
// Deliberately not user-agent-string sniffing and not reading the
// unavailable/coarse-on-Safari device-memory navigator field (both rejected
// by D-01 as brittle/unreliable signals).

/**
 * True on a "mobile" device: `hardwareConcurrency <= MOBILE_CORE_THRESHOLD` OR
 * a coarse pointer. Deliberately not user-agent-string sniffing and not
 * reading the unavailable/coarse-on-Safari device-memory navigator field
 * (both rejected by D-01 as brittle/unreliable signals).
 *
 * Extracted from `computePoolSize()` in Phase 172 (SEED-106 D-05) so the
 * background gem sweep (`useGemSweep.ts`) can gate itself off on the same
 * devices the Stockfish pool already downsizes for, via ONE heuristic instead
 * of two copies that could drift.
 */
export function isLowPowerDevice(): boolean {
  const cores = navigator.hardwareConcurrency || DESKTOP_POOL_MIN;
  const isCoarsePointer =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return cores <= MOBILE_CORE_THRESHOLD || isCoarsePointer;
}

/**
 * Compute the number of Stockfish worker slots for this device. Mobile
 * (`isLowPowerDevice()`) always gets `MOBILE_POOL_SIZE`; desktop gets
 * `clamp(cores - DESKTOP_HEADROOM_CORES, DESKTOP_POOL_MIN, DESKTOP_POOL_MAX)`.
 */
export function computePoolSize(): number {
  if (isLowPowerDevice()) return MOBILE_POOL_SIZE;
  const cores = navigator.hardwareConcurrency || DESKTOP_POOL_MIN;
  return Math.min(DESKTOP_POOL_MAX, Math.max(DESKTOP_POOL_MIN, cores - DESKTOP_HEADROOM_CORES));
}

// ─── Pool factory: N worker slots + priority-queued dispatch ───────────────
//
// N independent copies of useStockfishGradingEngine's proven per-worker state
// machine (same ENGINE_PATH, same classic non-module Worker load, same
// stop-before-go/stopPending serialization, same pv[0]-keyed white-POV
// parsing), coordinated by the priority queue above instead of one FEN's
// request/response cycle. Worker slots are spawned lazily, on the first
// grade() call (D-02) — never eagerly at factory-construction time.

/** Side-to-move literal read directly off a FEN string (D-08). */
function sideToMove(fen: string): 'w' | 'b' {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

export function createWorkerPool(): WorkerPool {
  const slots: PoolWorkerSlot[] = [];
  const pending: QueuedGradeRequest[] = [];
  const cache = new Map<string, Map<string, MoveGrade>>();
  let spawned = false;

  function cacheGrades(fen: string, grades: Map<string, MoveGrade>): void {
    // CACHE-03: merge into any existing per-FEN entry rather than replacing
    // it. A same-FEN request with a shifted candidate set (the root's
    // candidate list can widen or narrow across PUCT selection rounds) must
    // not destroy grades already accumulated for UCIs outside this call's
    // request. Incoming values win on key collision — a re-grade of the same
    // UCI at the same depth is the same computation, so overwriting is safe.
    const existing = cache.get(fen);
    const merged = existing ? new Map(existing) : new Map<string, MoveGrade>();
    for (const [uci, grade] of grades) merged.set(uci, grade);
    // Phase 194 code-review WR-01: a write is a use. `Map.set` on an ALREADY
    // PRESENT key does not reorder it, so without this delete a re-graded FEN
    // keeps its original insertion position and the eviction below picks it as
    // if the cache were still FIFO. That hits the worst possible target: the
    // root is the FEN most often re-graded (its candidate set widens across
    // PUCT rounds — the very case the merge above exists for), so the entry
    // CACHE-02 is meant to protect would be the first one dropped.
    cache.delete(fen);
    cache.set(fen, merged);
    // LRU eviction: both the read-hit branch in grade() below and the write
    // above do a delete-then-reinsert touch, so Map's insertion-order
    // iteration here yields the least-recently-USED entry, not the
    // least-recently-inserted one (CACHE-02).
    if (cache.size > GRADE_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  function sendGo(slot: PoolWorkerSlot, req: QueuedGradeRequest): void {
    slot.current = req;
    slot.accumulator = new Map();
    slot.worker.postMessage(`setoption name MultiPV value ${req.candidateUcis.length}`);
    slot.worker.postMessage(`position fen ${req.fen}`);
    slot.worker.postMessage(
      `go depth ${GRADING_TARGET_DEPTH} searchmoves ${req.candidateUcis.join(' ')} movetime ${GRADING_MOVETIME_SAFETY_CAP_MS}`,
    );
    slot.state = 'thinking';
  }

  /** Assign as many pending requests as there are free (idle, ready) slots. */
  function dispatchNext(): void {
    for (const slot of slots) {
      if (pending.length === 0) return;
      if (slot.state !== 'idle' || !slot.isReady || slot.current !== null) continue;
      const req = dequeueHighestPriority(pending);
      if (!req) return;
      sendGo(slot, req);
    }
  }

  /** Handle one UCI line emitted by a pool worker (per-slot line handler). */
  function handleLine(slot: PoolWorkerSlot, line: string): void {
    if (line === 'uciok') {
      // Cap Hash low (Pitfall 1) — shallow searchmoves-restricted grading
      // gains nothing from a large hash table, and N workers at default
      // settings multiplies mobile memory pressure for no search-quality gain.
      slot.worker.postMessage(`setoption name Hash value ${WORKER_HASH_MB}`);
      slot.worker.postMessage('isready');
      return;
    }

    if (line === 'readyok') {
      slot.isReady = true;
      dispatchNext();
      return;
    }

    if (line.startsWith('info ')) {
      if (slot.state !== 'thinking' || slot.stopPending || slot.current === null) return;
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
        // (abort path, Task 3) or will be re-dispatched.
        slot.stopPending = false;
        slot.state = 'idle';
        slot.current = null;
        dispatchNext();
        return;
      }

      slot.state = 'idle';
      slot.current = null;
      if (req) {
        cacheGrades(req.fen, slot.accumulator);
        req.resolve(slot.accumulator);
      }
      dispatchNext();
    }
  }

  /** True once every spawned slot has permanently failed via onerror — no worker will ever service a request. */
  function noLiveSlotRemains(): boolean {
    return slots.length > 0 && slots.every((slot) => slot.dead);
  }

  /** Resolve (empty) every still-pending request — nothing will ever dispatch them. */
  function drainPending(): void {
    while (pending.length > 0) {
      const req = pending.pop();
      req?.resolve(new Map());
    }
  }

  function createSlot(): PoolWorkerSlot {
    const worker = new Worker(ENGINE_PATH);
    const slot: PoolWorkerSlot = {
      worker,
      state: 'idle',
      stopPending: false,
      isReady: false,
      dead: false,
      current: null,
      accumulator: new Map(),
    };
    worker.onmessage = (e: MessageEvent<string>) => handleLine(slot, e.data);
    // WR-03/WR-04: an async script-load failure (404, CSP block, syntax
    // error) never throws a catchable JS exception on the main thread — it
    // only surfaces here. Without this handler such a failure is completely
    // silent and any in-flight/future request on this slot hangs forever.
    worker.onerror = () => {
      Sentry.captureException(new Error('Stockfish worker pool: worker load failure'), {
        tags: { source: 'stockfish-worker-pool' },
      });
      slot.isReady = false;
      slot.dead = true;
      slot.current?.resolve(new Map());
      slot.current = null;
      if (noLiveSlotRemains()) drainPending();
    };
    worker.postMessage('uci');
    return slot;
  }

  function ensureSpawned(): void {
    if (spawned) return;
    spawned = true;
    const size = computePoolSize();
    for (let i = 0; i < size; i++) {
      // Graceful-degradation floor (Pitfall 1): if a worker fails to
      // construct, keep whatever slots already succeeded and carry on with
      // a smaller live pool rather than throwing out of grade().
      try {
        slots.push(createSlot());
      } catch (err) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
          tags: { source: 'stockfish-worker-pool' },
        });
        continue;
      }
    }
  }

  function grade(
    fen: string,
    candidateUcis: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, MoveGrade>> {
    // WR-05: an empty searchmoves list would make Stockfish search ALL moves
    // and burn its full movetime budget on the public EngineProviders.grade
    // surface — fail fast before spawning anything.
    if (candidateUcis.length === 0) return Promise.resolve(new Map());
    // WR-01: a listener added via signal.addEventListener('abort', ...) below
    // never fires for a signal that is ALREADY aborted at call time — without
    // this guard the search would run to completion unnecessarily.
    if (signal?.aborted) return Promise.resolve(new Map());

    const cached = cache.get(fen);
    // CACHE-04: partial-hit (subset) grading was tested against the vendored
    // Stockfish binary using the shipped `go depth 14 searchmoves ...
    // movetime 2500` shape, and produced a DIFFERENT cp for the same move at
    // the same reported depth (bound exact) than a full-set grade of the same
    // (fen, move) — the italian position's f3e5 at -301 (5-move set) vs -253
    // (2-move subset), and the middlegame position's f3e5 at 9 (5-move set)
    // vs 5 (2-move subset), both at matching depth 14. `searchmoves`
    // restriction changes Stockfish's internal move ordering and time
    // allocation, so a subset grade is not interchangeable with a full-set
    // grade even at matching depth. Keep this all-or-nothing read; do not add
    // a partial-hit path. [CITED: 194-RESEARCH.md Pattern 5, measured 2026-07-30]
    if (cached && candidateUcis.every((uci) => cached.has(uci))) {
      // Pool-level cache hit (position-only, ELO-independent) — no new go.
      const subset = new Map<string, MoveGrade>();
      for (const uci of candidateUcis) {
        const g = cached.get(uci);
        if (g) subset.set(uci, g);
      }
      // LRU touch-on-hit: delete then reinsert so Map's insertion-order
      // iteration (consumed by cacheGrades' `keys().next().value` eviction)
      // yields the least-recently-USED entry, not the least-recently-inserted
      // one (CACHE-02).
      cache.delete(fen);
      cache.set(fen, cached);
      return Promise.resolve(subset);
    }

    ensureSpawned();
    // WR-03: if every slot construction attempt threw (0 live slots after the
    // spawn loop), nothing will ever dispatch a queued request — resolve
    // empty now rather than enqueuing into a queue nothing will service.
    if (slots.length === 0) return Promise.resolve(new Map());

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
        resolve: settle,
      };
      enqueue(pending, req);

      if (signal) {
        onAbort = () => {
          const idx = pending.indexOf(req);
          if (idx >= 0) {
            // Unstarted — just drop it from the queue.
            pending.splice(idx, 1);
            settle(new Map());
            return;
          }
          // In-flight — send stop; the eventual bestmove is discarded by
          // the same stopPending/FLAWCHESS-7V guard handleLine already
          // uses for a superseded search.
          for (const slot of slots) {
            if (slot.current === req && slot.state === 'thinking') {
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

      dispatchNext();
    });
  }

  function stopAll(): void {
    for (const slot of slots) {
      if (slot.state === 'thinking') {
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
    while (pending.length > 0) {
      const req = pending.pop();
      req?.resolve(new Map());
    }
  }

  function terminate(): void {
    for (const slot of slots) {
      slot.worker.postMessage('stop');
      slot.worker.terminate();
      // CR-02: worker.terminate() kills the worker outright — no bestmove
      // will ever arrive to resolve an in-flight request, so settle it here
      // (mirrors maiaQueue.terminate()'s folding of currentBatch into the
      // settled set).
      slot.current?.resolve(new Map());
      slot.current = null;
    }
    while (pending.length > 0) {
      const req = pending.pop();
      req?.resolve(new Map());
    }
    slots.length = 0;
    spawned = false;
  }

  /** Prewarm: spawn the pool without searching. See `WorkerPool.warm()`. */
  function warm(): void {
    ensureSpawned();
  }

  return { grade, stopAll, terminate, warm };
}
