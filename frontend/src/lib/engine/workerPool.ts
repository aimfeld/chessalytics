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
 */

import * as Sentry from '@sentry/react';
import { parseInfoLine } from '@/hooks/uciParser';
import type { MoveGrade } from './types';
import { buildGradeGoCommand, GRADING_ROOT_DEPTH } from './gradingLadder';
export type { MoveGrade };

// ─── Tunable constants (SC4 degradation knobs — tunable without touching logic) ──

/** Path to the vendored Stockfish engine served from public/engine/. Same binary as the primary/grading workers, N SEPARATE Worker() loads (one per pool slot). */
export const ENGINE_PATH = '/engine/stockfish-18-lite-single.js';

/**
 * Pool-level grade-cache cap, counted in `(fen, gradingDepth)` entries. A full
 * 400-node analysis-board search touches a measured 352-386 distinct FENs
 * (194-RESEARCH.md Pattern 4) — 256 was small enough that a single search
 * thrashed its own cache before cross-search reuse was even possible. 1024 is
 * the next power of two above roughly 2.6x the measured 386-FEN ceiling: one
 * full search's working set plus about 1.6 searches worth of navigation
 * history (Phase 194 CACHE-01).
 *
 * Phase 195 caveat (195-06 review WR-02): entries are keyed by `(fen, depth)`,
 * not by FEN alone, so a position reached at two different ladder rungs now
 * occupies two slots. The shipped ladder spans two distinct depths (14 and the
 * floor), so the true worst case is up to 2x the FEN count above — still well
 * inside 1024 for one search, but the headroom for navigation history is
 * correspondingly smaller than the FEN-based arithmetic implies. Re-derive this
 * cap from a measured distinct-key count if the ladder ever spans more rungs.
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

/**
 * Host-side grading watchdog (ms, D-06) — mirrors the calibration harness's
 * own `GRADING_WATCHDOG_TIMEOUT_MS` (`scripts/lib/calibration-providers.mjs`).
 * A worker-FAULT detector, not a quality knob: it exists to bound a slot that
 * never emits `bestmove` after `sendGo` (a genuinely hung/wedged worker), not
 * to cap a merely slow position. Sized at 60s so it fires only on the former
 * — replaces the removed `GRADING_MOVETIME_SAFETY_CAP_MS` wall-clock bound
 * (D-05), which capped EVERY search regardless of whether the worker was
 * healthy.
 */
export const GRADING_WATCHDOG_TIMEOUT_MS = 60_000;

/**
 * Bug fix (FLAWCHESS-9G): multiple of `GRADING_WATCHDOG_TIMEOUT_MS` past which
 * a watchdog fire is attributed to page/tab suspension rather than a wedged
 * worker. A backgrounded mobile tab suspends the page AND its workers; on
 * resume, the elapsed `setTimeout` fires immediately even though the worker
 * never received CPU time, and treating that as a fault permanently killed a
 * healthy slot (4 production events over 20 days, 3 of 4 on mobile browsers,
 * all on /analysis).
 */
export const GRADING_WATCHDOG_SUSPEND_FACTOR = 1.5;

/**
 * Bug fix (FLAWCHESS-9G): per-dispatch cap on suspend re-arms (see
 * `GRADING_WATCHDOG_SUSPEND_FACTOR`) — keeps a genuinely wedged worker on a
 * repeatedly suspended page from re-arming forever; after this many
 * suspension-attributed fires for the SAME dispatch, `fireWatchdog` falls
 * through to the normal kill path instead of re-arming again.
 */
export const MAX_WATCHDOG_SUSPEND_REARMS = 3;

/**
 * Bug fix (quick 260731-s0z, FIX-4): host-side "stop-bestmove" watchdog (ms),
 * armed instead of a bare `clearSlotWatchdog` whenever this pool sends `stop`
 * to a slot (the abort in-flight branch and `stopAll()`'s thinking branch).
 * Without it, a slot parked in `'stopping'` whose worker never answers with a
 * `bestmove` (a genuinely hung worker) was lost permanently: not marked
 * `dead`, so it also blinded `noLiveSlotRemains()` / the FIX-3 dead-pool
 * guard, and nothing reached Sentry. A `stop` must produce `bestmove`
 * near-immediately (the search polls the stop flag between nodes), so this
 * bound is an order of magnitude tighter than `GRADING_WATCHDOG_TIMEOUT_MS` —
 * a false positive costs one permanently dead slot (Sentry-visible via
 * `fireStopWatchdog`), and this constant is the tuning knob if that is ever
 * observed in production.
 */
export const STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS = 10_000;

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single pending grade() request awaiting dispatch to a free worker slot. */
export interface QueuedGradeRequest {
  fen: string;
  candidateUcis: string[];
  /** Higher = more urgent. Derived by the caller from the root ancestor's current practicalScore (POOL-02). */
  priority: number;
  /** Tie-break 2: shallower depth-from-root wins. Dispatch-priority tie-break (dead until Phase 198) — NOT the resolved Stockfish search depth; see `gradingDepth` below for that. */
  depth: number;
  /** The resolved Stockfish SEARCH depth for this request (LADDER-02/D-01), distinct from the `depth` tie-break field above. Composed into the `go` line via `buildGradeGoCommand`. */
  gradingDepth: number;
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
  /** D-06: handle for the in-flight `GRADING_WATCHDOG_TIMEOUT_MS` timer, or null when idle/no timer running. Started in `sendGo`, cleared by every path that takes the slot out of the `thinking` state. */
  watchdogTimer: ReturnType<typeof setTimeout> | null;
  /** FLAWCHESS-9G: wall-clock stamp of the moment the grading watchdog was (re-)armed. Only meaningful while a grading watchdog is in flight. */
  armedAtMs: number;
  /** FLAWCHESS-9G: suspend re-arms consumed by the current dispatch (see `MAX_WATCHDOG_SUSPEND_REARMS`). Reset to 0 on every fresh `sendGo` dispatch. */
  watchdogSuspendRearms: number;
}

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

/**
 * The public surface `createGradeCache()` returns — the shipped grade-outcome
 * cache, extracted from `createWorkerPool`'s closure (INJECT-05) so a Node
 * measurement harness (`scripts/engine-root-injection.mjs`) can read/write
 * through the EXACT same read gate, keying, LRU touch, and merge semantics
 * the browser pool uses, rather than a harness-local reimplementation that
 * would measure a mirror of production behavior instead of production
 * behavior itself.
 */
export interface GradeCache {
  /**
   * Reads a cached grade subset for `(fen, gradingDepth)` restricted to
   * `candidateUcis`. Returns `null` on any miss (CACHE-04/LADDER-03
   * all-or-nothing: a cached entry that lacks even one requested UCI is
   * still a miss). INJECT-05: increments `stats().misses` on every `null`
   * return and `stats().hits` on every non-null return — these are cache
   * OUTCOME counters, not Stockfish-dispatch counters. The caller
   * (`createWorkerPool.grade()`) may still resolve empty AFTER a counted
   * miss via its own separate zero-live-slots guard; that later failure mode
   * does not change what THIS counter measures ("was fresh Stockfish work
   * needed"), so the harness's reported denominator stays unambiguous.
   */
  read(fen: string, candidateUcis: string[], gradingDepth: number): Map<string, MoveGrade> | null;
  /** Merges `grades` into the existing `(fen, gradingDepth)` entry (CACHE-03), never replacing it wholesale. */
  write(fen: string, gradingDepth: number, grades: Map<string, MoveGrade>): void;
  /** INJECT-05: exact hit/miss counts since cache creation (or since the last `resetCacheStats()` call). */
  stats(): { hits: number; misses: number };
  /** INJECT-05: resets the hit/miss counters to zero WITHOUT evicting any cached entry — a subsequent identical request still reports a hit via `cacheStats()`. */
  resetCacheStats(): void;
}

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
  const slots: PoolWorkerSlot[] = [];
  const pending: QueuedGradeRequest[] = [];
  const gradeCache = createGradeCache();
  let spawned = false;

  /** Clear a slot's in-flight watchdog timer, if any. Idempotent. Extracted so the call sites that take a slot out of `thinking` cannot drift apart — bestmove, abort, `stopAll`, `terminate`, `onerror`, and the defensive clear in `sendGo`. */
  function clearSlotWatchdog(slot: PoolWorkerSlot): void {
    if (slot.watchdogTimer !== null) {
      clearTimeout(slot.watchdogTimer);
      slot.watchdogTimer = null;
    }
  }

  /**
   * D-06: fires when a slot's `sendGo` never produced a `bestmove` within
   * `GRADING_WATCHDOG_TIMEOUT_MS` — a genuinely hung/wedged worker, not a
   * merely slow position. Treated as a worker fault, mirroring `onerror`
   * exactly (reusing `dead` rather than inventing a new lifecycle state is
   * deliberate: a 60s grading `go` with no `bestmove` is not recoverable
   * within this pool instance, `dispatchNext` already skips non-`isReady`
   * slots, and `onerror` already proves this exact degradation path).
   */
  function fireWatchdog(slot: PoolWorkerSlot): void {
    slot.watchdogTimer = null;

    // Bug fix (FLAWCHESS-9G): 4 production events over 20 days, 3 of 4 on
    // mobile browsers, all on /analysis — a backgrounded/suspended tab
    // freezes its workers along with the page, so the elapsed `setTimeout`
    // fires immediately on resume even though the worker never ran and is
    // not actually wedged. Treating that as a fault is a false positive:
    // `dead` is never cleared until `terminate()`, so one spurious fire
    // permanently shrinks the pool for the rest of the session. A fire this
    // far past deadline is attributed to suspension instead and silently
    // re-armed (bounded by `MAX_WATCHDOG_SUSPEND_REARMS` so a genuinely
    // wedged worker on a repeatedly suspended page still reaches the kill
    // path below). Non-goal: `fireStopWatchdog`/`armStopWatchdog` are
    // deliberately left unchanged — a slot in `'stopping'` has already been
    // sent `stop` and its request is being abandoned, and no production
    // Sentry event points at that path. `clearSlotWatchdog` is untouched.
    const elapsedMs = Date.now() - slot.armedAtMs;
    if (
      elapsedMs > GRADING_WATCHDOG_TIMEOUT_MS * GRADING_WATCHDOG_SUSPEND_FACTOR &&
      slot.watchdogSuspendRearms < MAX_WATCHDOG_SUSPEND_REARMS
    ) {
      slot.watchdogSuspendRearms++;
      slot.armedAtMs = Date.now();
      slot.watchdogTimer = setTimeout(() => fireWatchdog(slot), GRADING_WATCHDOG_TIMEOUT_MS);
      return;
    }

    // Best-effort: ask the worker to stop. It may never respond — that's
    // exactly why this fired — so this is not awaited or relied upon.
    slot.worker.postMessage('stop');
    Sentry.captureException(new Error('Stockfish worker pool: grading watchdog timeout'), {
      tags: { source: 'stockfish-worker-pool' },
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
    if (noLiveSlotRemains()) drainPending();
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
  function armStopWatchdog(slot: PoolWorkerSlot): void {
    clearSlotWatchdog(slot);
    slot.watchdogTimer = setTimeout(() => fireStopWatchdog(slot), STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS);
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
  function fireStopWatchdog(slot: PoolWorkerSlot): void {
    slot.watchdogTimer = null;
    // STATIC message — no interpolated FEN/UCI (CLAUDE.md Sentry grouping rule).
    Sentry.captureException(new Error('Stockfish worker pool: stop-bestmove watchdog timeout'), {
      tags: { source: 'stockfish-worker-pool' },
    });
    slot.isReady = false;
    slot.dead = true;
    slot.current?.resolve(new Map());
    slot.current = null;
    if (noLiveSlotRemains()) drainPending();
  }

  function sendGo(slot: PoolWorkerSlot, req: QueuedGradeRequest): void {
    slot.current = req;
    slot.accumulator = new Map();
    slot.worker.postMessage(`setoption name MultiPV value ${req.candidateUcis.length}`);
    slot.worker.postMessage(`position fen ${req.fen}`);
    slot.worker.postMessage(buildGradeGoCommand(req.gradingDepth, req.candidateUcis));
    slot.state = 'thinking';
    clearSlotWatchdog(slot); // defensive: a stale timer must never coexist with a fresh dispatch
    // FLAWCHESS-9G: a fresh dispatch is the only place the suspend-rearm
    // counter resets — each grading request gets its own re-arm budget.
    slot.armedAtMs = Date.now();
    slot.watchdogSuspendRearms = 0;
    slot.watchdogTimer = setTimeout(() => fireWatchdog(slot), GRADING_WATCHDOG_TIMEOUT_MS);
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
        // (abort path, D-06 watchdog fire) or will be re-dispatched.
        // This clear is also (quick 260731-s0z, FIX-4) the disarm point for
        // the re-armed stop-bestmove watchdog on the healthy path — a
        // `bestmove` landing before STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS clears
        // it here before it can fire.
        clearSlotWatchdog(slot);
        slot.stopPending = false;
        slot.state = 'idle';
        slot.current = null;
        dispatchNext();
        return;
      }

      clearSlotWatchdog(slot);
      slot.state = 'idle';
      slot.current = null;
      if (req) {
        // This `bestmove` branch is the ONLY caller of gradeCache.write — the
        // abort path, stopAll, terminate, and onerror all settle without
        // writing, which is precisely what keeps a partial grade out of the
        // cache. Do not "helpfully" add a write to one of those settle paths.
        gradeCache.write(req.fen, req.gradingDepth, slot.accumulator);
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
      watchdogTimer: null,
      armedAtMs: 0,
      watchdogSuspendRearms: 0,
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
      // 195-06 review WR-01: this path settles the in-flight request but used
      // to leave the D-06 watchdog armed — the only one of the exit paths that
      // did. The stale 60s timer would later fire on an already-dead slot and
      // report a second, misleading "grading watchdog timeout" to Sentry for a
      // failure that was already correctly reported here.
      clearSlotWatchdog(slot);
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
    const hit = gradeCache.read(fen, candidateUcis, resolvedGradingDepth);
    if (hit) return Promise.resolve(hit);

    ensureSpawned();
    // WR-03: if every slot construction attempt threw (0 live slots after the
    // spawn loop), nothing will ever dispatch a queued request — resolve
    // empty now rather than enqueuing into a queue nothing will service.
    if (slots.length === 0) return Promise.resolve(new Map());
    // Bug fix (quick 260731-s0z, FIX-3): the guard above only covers "no slot
    // was ever constructed". Once every constructed slot has since died (via
    // `worker.onerror`, `fireWatchdog`, or FIX-4's `fireStopWatchdog`), a NEW
    // request enqueued here was reachable and unrecoverable — `dispatchNext`
    // skips every non-`isReady` slot and `drainPending` only runs at a death
    // TRANSITION, not for a request queued afterward, so `useBotGame.ts`'s
    // signal-less `.grade(fen, [uci])` call hung unconditionally. Requires
    // `slots.length > 0`, which the guard above has just established.
    if (noLiveSlotRemains()) return Promise.resolve(new Map());

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
              // Bug fix (quick 260731-s0z, FIX-4): a bare `clearSlotWatchdog`
              // here left the slot parked in 'stopping' with no exit if the
              // worker never answers `stop` with a terminating `bestmove` —
              // arm the stop-bestmove watchdog instead so a genuinely hung
              // worker is bounded and marked dead rather than lost silently.
              armStopWatchdog(slot);
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
        // Bug fix (quick 260731-s0z, FIX-4): same re-arm as the abort path
        // above — a bare clearSlotWatchdog left a never-answering `stop`
        // unbounded.
        armStopWatchdog(slot);
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
      clearSlotWatchdog(slot);
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

  return {
    grade,
    stopAll,
    terminate,
    warm,
    cacheStats: () => gradeCache.stats(),
    resetCacheStats: () => gradeCache.resetCacheStats(),
  };
}
