/**
 * workerPoolState — the leaf module of the `workerPool.ts` split: the shared
 * mutable state (`PoolState`), the cross-stage call surface (`PoolOps`), the
 * tunable degradation knobs, the pool's own types (`QueuedGradeRequest`/
 * `PoolWorkerSlot`/`GradeCache`), and the pure priority-queue/pool-sizing/
 * predicate functions (`enqueue`/`dequeueHighestPriority`/`sideToMove`/
 * `isLowPowerDevice`/`computePoolSize`/`noLiveSlotRemains`) — Phase 215-02
 * (SC-1/SC-2), extracted from `createWorkerPool()`'s 596-655 state bindings;
 * consolidated here (215 code review WR-01) so the module graph is a real
 * DAG instead of a facade↔stage cycle (see below).
 *
 * This module imports NOTHING from `workerPool.ts` or the three stage
 * modules (`workerPoolWatchdog.ts`, `workerPoolDispatch.ts`,
 * `workerPoolLifecycle.ts`) — only `./types`. Every one of those four
 * modules imports FROM here instead: `workerPool.ts` re-exports this file's
 * constants/types/functions for its existing external importers (a plain
 * `export { ... } from './workerPoolState'`, not a redefinition), and each
 * stage module imports the constants/types it needs directly from here. That
 * makes the graph `workerPool.ts` -> `{watchdog,dispatch,lifecycle}.ts` ->
 * `workerPoolState.ts` — a DAG, not a cycle.
 *
 * WR-01 history: before this consolidation, `workerPoolState.ts` type-only
 * imported `PoolWorkerSlot`/`QueuedGradeRequest`/`GradeCache` FROM
 * `workerPool.ts`, while `workerPool.ts` (and every stage module) imported
 * runtime bindings (constants, `enqueue`/`dequeueHighestPriority`,
 * `sideToMove`, `computePoolSize`, `noLiveSlotRemains`) BACK from
 * `workerPool.ts` — a real facade<->stage import cycle that this file's own
 * header used to (incorrectly) deny, claiming the `PoolOps` dispatch table
 * was "what lets sibling modules call into each other without an import
 * cycle." That claim was true only for the STAGE<->STAGE calls the table
 * actually exists for (watchdog -> lifecycle's `replaceDeadSlot`, lifecycle's
 * `createSlot` -> dispatch's `handleLine`, dispatch -> watchdog's re-arm) —
 * it said nothing about the separate facade<->stage cycle in the constant/
 * type imports, which was runtime-safe only because every cross-module
 * binding was read inside a function body, never at module-evaluation time.
 * Moving the shared leaf definitions here (rather than adding a new
 * `workerPoolCore.ts`) keeps every stage module's existing `from
 * './workerPoolState'` import path unchanged for the `PoolState`/`PoolOps`
 * types they already imported.
 *
 * `PoolState` bundles the twelve mutable bindings `createWorkerPool()` used
 * to close over directly; each field below keeps its original Phase
 * 213/CR-01 doc comment verbatim, since that comment carries load-bearing
 * decision history (race-condition guards, respawn-generation invalidation,
 * readiness/failure settlement) rather than just a type description.
 *
 * `PoolOps` is a nine-field dispatch table, not a plain data object: every
 * field is a function one stage module may need to call into another
 * stage's implementation. It deliberately exceeds CLAUDE.md's "context
 * object with fewer than three fields and one reader" carve-out — it has
 * nine fields and a reader in every stage module — because the real call
 * graph between the stages is CYCLIC: the watchdog stage fires into the
 * lifecycle stage's `replaceDeadSlot`, the lifecycle stage's `createSlot`
 * wires the dispatch stage's `handleLine` as the worker's message handler,
 * and the dispatch stage re-arms the watchdog stage on every fresh
 * dispatch. Late binding through one shared table is what lets sibling
 * STAGE modules call into each other without an import cycle BETWEEN
 * THEMSELVES: `createWorkerPool` builds one `ops` object, wiring each field
 * to whichever module actually owns that stage's implementation. This does
 * not (and never did) apply to the separate facade<->stage constant/type
 * imports fixed above.
 */

import type { MoveGrade } from './types';

// ─── Tunable constants (SC4 degradation knobs — tunable without touching logic) ──
//
// Phase 213-08 (G-213-35): the removed `ENGINE_PATH` constant (formerly in
// `workerPool.ts`) routed worker construction through
// `createStockfishWorker()` (`stockfishWorkerSource.ts`), which owns the
// served glue path. Confirmed via repo-wide grep (including `scripts/*.mjs`)
// that nothing outside that file imported the removed export.

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
 * healthy. That "fault, not slowness" intent is only actually ENFORCED by the
 * two re-arm gates in `fireWatchdog` (see `GRADING_WATCHDOG_SUSPEND_FACTOR`
 * and `GRADING_WATCHDOG_LIVENESS_MS`); this constant alone cannot tell the
 * two apart, which is what FLAWCHESS-9G was.
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
 * Bug fix (FLAWCHESS-9G, second pass): silence window (ms) separating a
 * genuinely wedged worker from a merely slow or CPU-starved one. Stockfish
 * emits `info` lines continuously while it searches (depth completions, plus
 * per-root-move `currmove` reports once an iteration passes ~3s), so a slot
 * that produced a line recently is demonstrably ALIVE — its 60s deadline then
 * says nothing about worker health, only that this position is slow on this
 * machine, which `go depth N` explicitly permits (D-05 removed the wall-clock
 * bound). Killing such a slot is a false positive.
 *
 * 20s is a judgement call, not a measurement: comfortably wider than the
 * largest plausible gap between two `info` lines at the depths this pool
 * searches (ladder 10-14, searchmoves-restricted, so only a handful of
 * `currmove` reports per iteration), while still a third of the watchdog
 * window — a worker that has gone completely silent is killed at its FIRST
 * fire, with no added latency. This is the knob to widen if the enriched
 * Sentry context (see `fireWatchdog`) starts showing fires whose
 * `sinceLastInfoMs` sits just past it.
 */
export const GRADING_WATCHDOG_LIVENESS_MS = 20_000;

/**
 * Bug fix (FLAWCHESS-9G, second pass): per-dispatch cap on liveness re-arms
 * (see `GRADING_WATCHDOG_LIVENESS_MS`) — the same containment
 * `MAX_WATCHDOG_SUSPEND_REARMS` gives the suspension path. A worker that
 * keeps emitting `info` forever without ever reaching `bestmove` must not
 * re-arm forever: `mctsSearch` awaits this grade, so an unbounded re-arm
 * turns a slow node into a stalled search. Counted separately from the
 * suspend re-arms so the two causes stay distinguishable in Sentry.
 *
 * Trade-off, stated plainly: worst case a dispatch is now abandoned after
 * `GRADING_WATCHDOG_TIMEOUT_MS * (1 + MAX_WATCHDOG_SUSPEND_REARMS +
 * MAX_WATCHDOG_LIVENESS_REARMS)` rather than 60s. That is only reachable by a
 * slot that is provably alive the whole time; the alternative is what this
 * fix exists to stop — killing a healthy worker and settling its node with an
 * empty grade, which dents search quality invisibly instead of visibly.
 */
export const MAX_WATCHDOG_LIVENESS_REARMS = 3;

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
 * a false positive costs one worker respawn (Sentry-visible via
 * `fireStopWatchdog`), and this constant is the tuning knob if that is ever
 * observed in production.
 */
export const STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS = 10_000;

/**
 * Bug fix (2026-08-23): total slot respawns allowed over ONE pool's lifetime.
 *
 * A slot marked `dead` used to stay dead until `terminate()` — and `terminate()`
 * only runs on the React effect cleanup, i.e. when the user leaves the analysis
 * or bot page. So a single worker fault silently shrank the pool for the whole
 * visit: not wrong answers, but fewer parallel grades, and for the BOT a
 * deadline-bounded search on a smaller pool reaches fewer nodes and can pick a
 * different move. `replaceDeadSlot` now spawns a replacement instead.
 *
 * The cap exists because the respawn paths are not all slow: `worker.onerror`
 * fires immediately for a 404/CSP-blocked engine script, so an uncapped respawn
 * would spin constructing workers. Once the budget is spent the pool degrades
 * exactly as it did before this fix — smaller, then drained — rather than
 * looping. Sized for a couple of full-pool wipes at the desktop maximum of 4
 * slots; a healthy session should never spend more than one or two.
 */
export const MAX_SLOT_RESPAWNS = 8;

/**
 * Bug fix (2026-08-23): bound (ms) on a REPLACEMENT slot's UCI init handshake.
 *
 * Respawning re-opened a hang that the FIX-3 dead-pool guard used to close by
 * accident. Once every slot was dead, `grade()` resolved new requests empty
 * immediately; now a fresh slot sits in the pool, so `noLiveSlotRemains()` is
 * false and the request enqueues. That is correct as long as the replacement
 * actually boots — but a worker that CONSTRUCTS and then goes silent (never
 * `uciok`, never an `error` event — the shape a memory-starved mobile device
 * produces) would strand the queue forever. This watchdog turns that silence
 * into an ordinary slot death, which the respawn budget then bounds.
 *
 * Armed only on replacements, not on `ensureSpawned`'s initial slots: this
 * closes exactly the hazard the respawn introduces, and leaves the pre-existing
 * (and separate) question of a never-booting FIRST worker alone. Generous
 * relative to a cold WASM compile on slow mobile hardware, since it only ever
 * matters when something is already broken.
 */
export const INIT_WATCHDOG_TIMEOUT_MS = 30_000;

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
  /** True once this slot's worker has failed (an `error` event, WR-04, or a watchdog fire) — out of service. The slot itself is replaced by `replaceDeadSlot`; this flag gates dispatch until then and stays set on the discarded slot object forever. */
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
  /** FLAWCHESS-9G (second pass): wall-clock stamp of the last `info` line this slot emitted for `current`, or 0 when it has emitted none since `sendGo` — the worker-liveness signal `fireWatchdog` uses to tell a wedged worker from a slow one. */
  lastInfoAtMs: number;
  /** FLAWCHESS-9G (second pass): liveness re-arms consumed by the current dispatch (see `MAX_WATCHDOG_LIVENESS_REARMS`). Reset to 0 on every fresh `sendGo` dispatch. */
  watchdogLivenessRearms: number;
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

/** The twelve mutable bindings `createWorkerPool()`'s closure shares across every extracted stage. */
export interface PoolState {
  readonly slots: PoolWorkerSlot[];
  readonly pending: QueuedGradeRequest[];
  readonly gradeCache: GradeCache;
  spawned: boolean;
  /**
   * Phase 213-08 (G-213-35): true from the moment `ensureSpawned()` starts
   * until the construction loop (the `ensureStockfishWorkerUrl()`
   * continuation) has run. While true, `grade()`'s first zero-slot guard
   * must NOT short-circuit — a request arriving during this window is
   * queued and dispatched once slots appear, never resolved empty.
   */
  spawnInFlight: boolean;
  /**
   * Phase 213-08: bumped by `terminate()` and captured by `ensureSpawned()`
   * before its `ensureStockfishWorkerUrl()` await — a spawn continuation
   * that resolves after a `terminate()` ran mid-fetch compares its captured
   * generation against the current one and constructs nothing if they no
   * longer match. Prevents a late continuation from pushing slots into a
   * pool the caller already tore down.
   */
  spawnGeneration: number;
  /**
   * Phase 213-08: the shared `.wasm` URL once `ensureStockfishWorkerUrl()`
   * resolves (or `null` on the degraded/failed path) — set once by the
   * initial spawn's continuation and reused by every later
   * `replaceDeadSlot()` respawn, which must never re-await the shared fetch.
   */
  resolvedSharedUrl: string | null;
  /** Respawns consumed so far — see `MAX_SLOT_RESPAWNS`. */
  slotRespawns: number;
  /** Phase 213 D-01: true once ANY slot has completed its UCI init handshake. Reset by `terminate()`. */
  poolReady: boolean;
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
  poolFailed: boolean;
  /** Callers awaiting `whenReady()` before the first slot has reported `readyok`. */
  readonly poolReadyWaiters: (() => void)[];
  /**
   * CR-01 (213-REVIEW.md): callers awaiting `whenReady()` to be REJECTED once
   * the pool can never dispatch another request — settled by `markPoolFailed()`
   * below, the same moment `markEngineAssetFailed('stockfish-wasm')` fires.
   * Parallel array to `poolReadyWaiters`, same index per pending `whenReady()`
   * call (both pushed together in `whenReady()`).
   */
  readonly poolReadyRejecters: ((err: Error) => void)[];
}

/**
 * Cross-stage dispatch table `createWorkerPool()` builds once and threads
 * through every stage module — see the file-level JSDoc above for why this
 * exists as one shared table rather than direct imports between siblings.
 */
export interface PoolOps {
  markPoolReady: () => void;
  markPoolFailed: () => void;
  clearSlotWatchdog: (slot: PoolWorkerSlot) => void;
  armStopWatchdog: (slot: PoolWorkerSlot) => void;
  armInitWatchdog: (slot: PoolWorkerSlot) => void;
  dispatchNext: () => void;
  handleLine: (slot: PoolWorkerSlot, line: string) => void;
  replaceDeadSlot: (slot: PoolWorkerSlot) => void;
  ensureSpawned: () => void;
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

// ─── Pool factory helpers: N worker slots + priority-queued dispatch ───────

/** Side-to-move literal read directly off a FEN string (D-08). */
export function sideToMove(fen: string): 'w' | 'b' {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

/**
 * True once every slot currently in the pool is dead — no worker will
 * service a request until one is replaced. A plain module-level predicate
 * over `PoolState` (Phase 215-02) rather than a `PoolOps` field: it is pure
 * and read-only, needed identically by the dispatch stage's `grade()` and
 * the lifecycle stage's own `replaceDeadSlot()`, and taking `state` directly
 * (like `enqueue`/`dequeueHighestPriority` above) avoids growing the
 * cross-stage dispatch table for a function with no side effects to
 * coordinate.
 */
export function noLiveSlotRemains(state: PoolState): boolean {
  return state.slots.length > 0 && state.slots.every((slot) => slot.dead);
}
