#!/usr/bin/env node
/**
 * stockfish-pool.mjs — N-process Stockfish pool (Phase 168, Plan 03, Task 1),
 * mirroring `frontend/src/lib/engine/workerPool.ts`'s free-slot queue over
 * `node:child_process` instances instead of Web Workers.
 *
 * The CAL-03 spike (168-02-SUMMARY.md) found the bottleneck is `grade()`
 * serialization inside `mctsSearch` under a SINGLE shared Stockfish process
 * (`SEARCH_CONCURRENCY=1`), NOT Maia/ONNX inference (168-RESEARCH.md
 * Pitfall 3). The fix is N independently-spawned Stockfish processes so
 * `mctsSearch` can dispatch up to `size` concurrent `grade()` calls — each
 * individual process STILL serves only one `go` at a time (never overlapping
 * `go`s on the SAME process); throughput comes from parallelizing ACROSS
 * processes, not from multiplexing one.
 *
 * Every request (bot grading, Stockfish-skill anchor moves, adjudication
 * evals) reuses the existing per-engine UCI logic
 * (`calibration-providers.mjs`'s `nodeGrade`/`evalPositionCp`,
 * `calibration-anchors.mjs`'s `stockfishSkillMove`) — each of which already
 * resets every option it depends on (Skill Level/UCI_LimitStrength/MultiPV)
 * immediately before its own `go` (Pitfall 2). Routing those same functions
 * through this pool's acquire/release preserves that per-call reset
 * discipline PER PROCESS: a weakened Skill Level set on one engine for an
 * anchor move can never leak into a different engine's bot-grading `go`.
 *
 * D-11 (168.5-02, Task 2): `withEngine` also retries a timed-out `go` in
 * place up to `ENGINE_RETRY_ATTEMPTS` times via `runWithRetry`, reusing
 * `stopAndSync()` between attempts, so a single slow reply degrades to a
 * retry rather than aborting the whole multi-hour sweep.
 */
import { spawnStockfish, STOCKFISH_INIT_TIMEOUT_MS } from './node-engine-providers.mjs';
import { nodeGrade, evalPositionCp, evalPositionCpWithBest } from './calibration-providers.mjs';
import { stockfishSkillMove } from './calibration-anchors.mjs';

/** Default pool size — mirrors `workerPool.ts`'s `DESKTOP_POOL_MAX` order of magnitude. */
export const STOCKFISH_POOL_DEFAULT_SIZE = 4;

/**
 * Retry attempts (D-11) after a `waitFor` watchdog timeout on a grading or
 * adjudication `go` — a single late reply must not abort a multi-hour sweep.
 * 2 retries = 3 total attempts (initial + 2). Engine restart is NOT
 * attempted here as a further fallback — the harness's existing per-cell
 * failure path is the last resort once retries are exhausted.
 */
export const ENGINE_RETRY_ATTEMPTS = 2;

/** Matches `StockfishUciEngine.waitFor`'s rejection message — the only error class D-11 retries. */
const TIMEOUT_ERROR_PATTERN = /Stockfish response timeout after/;

/**
 * Acquires the next free engine, or queues the caller until one is released
 * (mirrors `workerPool.ts`'s pending-array + `dispatchNext` free-slot scan,
 * generalized to one FIFO waiter list since every request here is a single
 * atomic `go` round-trip, not a priority-ordered MCTS grade queue).
 */
function acquireEngine(pool) {
  const free = pool.engines.find((engine) => !pool.busy.get(engine));
  if (free !== undefined) {
    pool.busy.set(free, true);
    return Promise.resolve(free);
  }
  return new Promise((resolve) => pool.waiters.push(resolve));
}

/** Releases an engine back to the pool — hands it directly to the next FIFO waiter if one is queued. */
function releaseEngine(pool, engine) {
  const nextWaiter = pool.waiters.shift();
  if (nextWaiter !== undefined) {
    nextWaiter(engine); // stays "busy": handed straight to the waiting request.
    return;
  }
  pool.busy.set(engine, false);
}

/**
 * D-11: runs `fn(engine)`, retrying the SAME operation in place up to
 * `ENGINE_RETRY_ATTEMPTS` times when it rejects with a `waitFor` watchdog
 * timeout — a single late reply must not fail the whole cell. Between
 * attempts, `stopAndSync()` resyncs the engine to quiescent (reused verbatim
 * from `node-engine-providers.mjs`, not reimplemented). Only the timeout
 * error class is retried: illegal-move/parse errors are deterministic and
 * would loop forever without ever succeeding.
 */
async function runWithRetry(engine, fn) {
  let lastErr;
  for (let attempt = 0; attempt <= ENGINE_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn(engine);
    } catch (err) {
      lastErr = err;
      const isTimeout = err instanceof Error && TIMEOUT_ERROR_PATTERN.test(err.message);
      if (!isTimeout || attempt === ENGINE_RETRY_ATTEMPTS) throw err;
      await engine.stopAndSync();
    }
  }
  throw lastErr; // unreachable — the loop above always returns or throws
}

/** Runs `fn` against a free engine, always releasing it back to the pool afterward (success or throw). */
async function withEngine(pool, fn) {
  const engine = await acquireEngine(pool);
  try {
    return await runWithRetry(engine, fn);
  } catch (err) {
    // WR-01: `fn` (nodeGrade/evalPositionCp/stockfishSkillMove) rejecting most
    // often means its `waitFor` timed out while the engine was still mid-search
    // — releasing it as-is would hand a still-searching engine straight to the
    // next waiter/free-scan. Resync it quiescent first (mirrors
    // gem-elo-calibration.mjs's per-position catch block); swallow a failed
    // resync here since the engine's own error/exit handlers already surface
    // an unrecoverable process death, and this path must not mask `err`.
    await engine.stopAndSync().catch(() => {});
    throw err;
  } finally {
    releaseEngine(pool, engine);
  }
}

/**
 * Spawns `size` independent Stockfish processes and returns the pool's public
 * surface: `grade`/`evalPosition`/`skillMove` (each acquire-run-release over
 * a free engine), `newGameAll` (D-09 determinism: clears every engine's
 * transposition table at a game boundary), and `quitAll`.
 */
export async function createStockfishPool({ size = STOCKFISH_POOL_DEFAULT_SIZE } = {}) {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`createStockfishPool: size must be a positive integer, got ${JSON.stringify(size)}`);
  }
  // CR-02: Promise.all rejects on the FIRST failing spawnStockfish(), which
  // would silently discard every OTHER already-spawned sibling engine (live
  // child process, UCI handshake done) with no reference left to terminate
  // it. Promise.allSettled lets us inspect every outcome and terminate every
  // fulfilled engine before rethrowing the first rejection.
  const results = await Promise.allSettled(Array.from({ length: size }, () => spawnStockfish()));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) {
    for (const r of results) {
      if (r.status === 'fulfilled') r.value.terminate();
    }
    throw failed.reason;
  }
  const engines = results.map((r) => r.value);
  const pool = { engines, busy: new Map(engines.map((engine) => [engine, false])), waiters: [] };

  return {
    size,

    /**
     * `EngineProviders.grade` shape (UCI-keyed, searchmoves-restricted,
     * depth-carrying — D-08). Declares all four parameters `mctsSearch`'s
     * `dispatchExpansion` now passes (`fen, candidateUcis, signal,
     * gradingDepth`) and forwards `gradingDepth` into `nodeGrade`.
     *
     * BUG FIX (Phase 195, T-195-09): this closure previously declared only
     * `(fen, candidateUcis)` — two parameters. JavaScript silently discards
     * extra arguments passed to a function with fewer declared parameters, so
     * once Plan 01's `dispatchExpansion` started passing a 4th depth
     * argument, this pool (the one Phase 199's recalibration sweep actually
     * runs against) would have graded every node at one flat depth while the
     * shipped browser ran the real ladder — with nothing in the sweep's own
     * output showing it. Widening the closure and forwarding the depth closes
     * that gap.
     *
     * `signal` is accepted but deliberately NOT acted on: the Node pool has no
     * abort path today, and inventing one is out of scope for this fix. The
     * parameter exists purely so a future 4th-argument caller can never be
     * silently truncated by parameter position again.
     */
    grade: (fen, candidateUcis, signal, gradingDepth) =>
      withEngine(pool, (engine) => nodeGrade(engine, fen, candidateUcis, gradingDepth)),

    /** Single-line white-POV cp eval for D-10 cutoff 2 (adjudication). */
    evalPosition: (fen) => withEngine(pool, (engine) => evalPositionCp(engine, fen)),

    /**
     * White-POV cp eval + the engine's own `bestmove` byproduct (Phase 180
     * near-free SF-agreement). Same single `go` as `evalPosition` — the
     * `bestmove` line is already awaited, so this adds ZERO extra engine work.
     */
    evalPositionWithBest: (fen) => withEngine(pool, (engine) => evalPositionCpWithBest(engine, fen)),

    /** Stockfish-skill anchor move at `skillLevel` (D-07 anchor). */
    skillMove: (fen, skillLevel) => withEngine(pool, (engine) => stockfishSkillMove(engine, fen, skillLevel)),

    /** Clears every engine's transposition table at a game boundary (D-09 determinism — Plan 02's fix, pool-wide). */
    async newGameAll() {
      await Promise.all(
        engines.map(async (engine) => {
          engine.send('ucinewgame');
          engine.send('isready');
          await engine.waitFor((line) => line === 'readyok', STOCKFISH_INIT_TIMEOUT_MS);
        }),
      );
    },

    /** Terminates every process in the pool. */
    quitAll() {
      for (const engine of engines) engine.terminate();
    },
  };
}
