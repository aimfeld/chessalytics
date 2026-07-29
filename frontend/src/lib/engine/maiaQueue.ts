/**
 * maiaQueue — a dedicated single-instance Maia policy Web Worker, fully
 * separate from the existing `useMaiaEngine` hook, that supplies per-node
 * UCI-keyed move-probability distributions for an explicit per-side ELO
 * (POOL-03).
 *
 * This is the real implementation of the frozen `EngineProviders.policy()`
 * method (Phase 153), forking the already-shipped `useMaiaEngine.ts`
 * `{type:'analyze', fen, eloInputs}` protocol into a non-React async queue.
 * Not a React hook — plain module, no UI wiring (that lands in Phase 155).
 *
 * D-04: requests only the distinct ELOs the search needs (often just `{w,b}`
 * from `SearchBudget.elo`, deduped) — NEVER the full 600-2600 ELO ladder
 * `useMaiaEngine` sweeps for its chart. Cache is keyed by `(fen, elo)` and is
 * fully separate from `useMaiaEngine`'s cache.
 *
 * Open Question 2 (154-RESEARCH.md): unlike `useMaiaEngine`'s single-in-flight
 * "drop and reissue" discipline (fine for a UI that only cares about the
 * LATEST position), every `policy()` call issued by `mctsSearch.ts` needs an
 * answer — dropping one would leave an expansion's promise hanging forever.
 * This module therefore uses a proper async FIFO queue: one ONNX inference in
 * flight at a time, every caller's promise resolves.
 *
 * Worker lifecycle: lazy spawn on the first `policy()` call (D-02), `{type:
 * 'error'}` messages forwarded to Sentry under a distinct source tag
 * (classic Workers never throw a catchable JS exception on the main thread),
 * and a graceful-degradation floor — a construction failure or a worker
 * error settles every affected promise instead of leaving it hanging
 * (Pitfall 1).
 */

import * as Sentry from '@sentry/react';
import { maskAndSoftmax } from '@/lib/maiaEncoding';
import { sanToUci } from '@/lib/sanToSquares';
import { captureMaiaWorkerError } from '@/lib/maiaWorkerErrors';
import type { Side } from './types';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Path to the vendored Maia Worker served from public/maia/ — same binary as useMaiaEngine, a SEPARATE Worker() instance (D-04). */
export const ENGINE_PATH = '/maia/maia-worker.js';

/** (fen, elo)-keyed cache cap — mirrors useMaiaEngine's MAIA_CACHE_MAX FIFO pattern, but this cache is fully separate (D-04). */
export const MAIA_CACHE_MAX = 256;

// ─── Types ──────────────────────────────────────────────────────────────────

/** The public surface `createMaiaQueue()` returns — implements `EngineProviders.policy` (D-08). */
export interface MaiaQueue {
  /**
   * UCI-keyed Maia move-probability distribution at `elo` for `side` to move
   * (EngineProviders.policy shape). `side` is accepted for contract-shape
   * parity only — it does not change the result independently of `fen`,
   * since side-to-move is already implicit in the FEN's own 'w'/'b' field
   * (D-08).
   */
  policy(fen: string, elo: number, side: Side): Promise<Record<string, number>>;
  /** Post `{type:'terminate'}`, `worker.terminate()`, and reset internal state so a later `policy()` re-spawns. */
  terminate(): void;
  /**
   * Spawn the Maia worker (which posts `{type:'init'}` and begins the ONNX
   * weight load) WITHOUT enqueueing an `analyze` request — the Phase 169.5
   * prewarm counterpart to `WorkerPool.warm()`.
   *
   * This exists even though the opening book's own `deps.policy()` call
   * already warms Maia by necessity on essentially every bot turn: that makes
   * "Maia is warm" a latent consequence of "the book happened to run", an
   * invariant that would break silently under a future config where the book
   * is disabled or `BOOK_PLY_CAP` is 0. It is the same one-line
   * `ensureSpawned()` forwarding shape as `WorkerPool.warm()` and costs
   * nothing. Idempotent — `ensureSpawned()` returns early if a worker exists.
   */
  warm(): void;
}

/** One policy() call awaiting dispatch or resolution. */
interface PendingPolicyRequest {
  fen: string;
  elo: number;
  resolve: (result: Record<string, number>) => void;
}

/** Raw worker payload shape for a completed `analyze` (see maia-worker.js header; identical wire contract to useMaiaEngine). */
interface WorkerResultMessage {
  type: 'result';
  fen: string;
  rawPolicyByElo: { elo: number; policy: Float32Array }[];
  wdlByElo: { elo: number; wdl: Float32Array }[];
  backend: 'webgpu' | 'wasm';
}

type WorkerMessage =
  | { type: 'ready'; backend: 'webgpu' | 'wasm' }
  | WorkerResultMessage
  | { type: 'error'; message: string };

// ─── Factory ────────────────────────────────────────────────────────────────

export function createMaiaQueue(): MaiaQueue {
  let worker: Worker | null = null;
  let isReady = false;
  /** Active execution provider once the worker reports `ready` — tags Sentry errors. */
  let backend: 'webgpu' | 'wasm' | null = null;

  /** Ephemeral (fen, elo)-keyed cache — separate from useMaiaEngine's, per D-04. */
  const cache = new Map<string, Record<string, number>>();
  /** Requests not yet dispatched to the worker. */
  const pending: PendingPolicyRequest[] = [];
  /** The batch of requests currently awaiting the worker's `result` message, or null when idle. */
  let currentBatch: PendingPolicyRequest[] | null = null;

  function cacheResult(key: string, result: Record<string, number>): void {
    cache.set(key, result);
    if (cache.size > MAIA_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  /**
   * Assigns the next batch of same-FEN pending requests to the worker, if the
   * worker is ready and no inference is currently in flight (one ONNX
   * inference at a time — the ONNX runtime can't run two analyses
   * concurrently). Batches every pending request sharing the head-of-queue's
   * FEN into one `analyze` call with the deduped distinct ELOs they need
   * (D-04) — never the full ladder.
   */
  function processQueue(): void {
    if (currentBatch !== null) return;
    if (!worker || !isReady) return;
    const first = pending[0];
    if (!first) return;

    const batch = pending.filter((req) => req.fen === first.fen);
    for (const req of batch) {
      const idx = pending.indexOf(req);
      if (idx >= 0) pending.splice(idx, 1);
    }

    const dedupedElos = Array.from(new Set(batch.map((req) => req.elo)));
    currentBatch = batch;
    worker.postMessage({ type: 'analyze', fen: first.fen, eloInputs: dedupedElos });
  }

  /**
   * Converts the worker's raw per-ELO logits into UCI-keyed probabilities for
   * every request in the just-completed batch, resolving each caller's own
   * promise. `maskAndSoftmax` (single-sourced from maiaEncoding.ts) yields
   * SAN-keyed probabilities; each key is converted to UCI via `sanToUci`,
   * dropping only genuinely unconvertible entries (WR-07 null convention,
   * Pitfall 4 — verified by the entry-count-parity test).
   */
  function handleResult(msg: WorkerResultMessage): void {
    const batch = currentBatch;
    currentBatch = null;
    if (batch) {
      const sanByElo = new Map<number, Record<string, number>>();
      for (const { elo, policy: rawPolicy } of msg.rawPolicyByElo) {
        sanByElo.set(elo, maskAndSoftmax(rawPolicy, msg.fen));
      }

      for (const req of batch) {
        const sanKeyed = sanByElo.get(req.elo) ?? {};
        const uciKeyed: Record<string, number> = {};
        for (const [san, prob] of Object.entries(sanKeyed)) {
          const uci = sanToUci(msg.fen, san);
          if (uci !== null) uciKeyed[uci] = prob;
        }
        cacheResult(`${req.fen}|${req.elo}`, uciKeyed);
        req.resolve(uciKeyed);
      }
    }
    processQueue();
  }

  /**
   * Resolves every queued (`pending`) AND in-flight (`currentBatch`) request
   * to `{}`, terminates and drops the dead worker, and resets `isReady` so
   * the next `policy()` call's `ensureSpawned()` re-attempts a fresh spawn
   * instead of queuing forever behind a permanently-dead worker. Shared by
   * the pre-ready message-error path (CR-03) and the async
   * `worker.onerror` script-load-failure path (WR-03) — both are the same
   * "worker is dead, nothing will ever service this queue" situation.
   */
  function settleAllAndDropWorker(): void {
    const failedBatch = currentBatch;
    currentBatch = null;
    if (failedBatch) {
      for (const req of failedBatch) req.resolve({});
    }
    const stranded = pending.splice(0, pending.length);
    for (const req of stranded) req.resolve({});
    worker?.terminate();
    worker = null;
    isReady = false;
  }

  function handleMessage(msg: WorkerMessage): void {
    if (msg.type === 'ready') {
      isReady = true;
      backend = msg.backend;
      processQueue();
      return;
    }
    if (msg.type === 'result') {
      handleResult(msg);
      return;
    }
    // msg.type === 'error': the Maia worker is a classic Worker with no
    // Sentry init, and onnxruntime-web's native failures never throw a
    // catchable JS exception on the main thread — so they reach Sentry ONLY
    // by being forwarded here. Routed through captureMaiaWorkerError (quick
    // 260729-sod, FIX 2) for bounded classification + stable grouping
    // instead of embedding the raw worker text in the error message
    // (CLAUDE.md: never embed variables in error messages). Distinct
    // 'maia-queue-worker' source tag keeps this filterable separately from
    // the chart's 'maia-worker' tag.
    captureMaiaWorkerError(msg.message, { source: 'maia-queue-worker', backend });
    if (!isReady) {
      // Pre-ready init failure (e.g. onnx session/model-load — CR-03): the
      // worker never got to dispatch, so `currentBatch` is still null and
      // every request is stranded in `pending`. Nothing will ever service
      // it — settle the whole queue and drop the dead worker so a later
      // policy() re-attempts a fresh spawn instead of hanging forever.
      settleAllAndDropWorker();
      return;
    }
    // Post-ready error: the worker is still alive, so keep serving the rest
    // of the queue (unchanged pre-existing behavior).
    const failedBatch = currentBatch;
    currentBatch = null;
    if (failedBatch) {
      for (const req of failedBatch) req.resolve({});
    }
    processQueue();
  }

  /** Lazily spawns the worker on the first policy() call (D-02) — never eagerly. */
  function ensureSpawned(): void {
    if (worker) return;
    try {
      const w = new Worker(ENGINE_PATH);
      worker = w;
      w.onmessage = (e: MessageEvent<WorkerMessage>) => handleMessage(e.data);
      // A Worker whose script fails to load (404 / CSP / syntax error) does
      // NOT throw from `new Worker(...)` — it fires this asynchronous
      // `error` event instead, which the try/catch below can never catch
      // (WR-03). Same self-heal contract as the pre-ready message-error
      // path above: capture to Sentry, settle every affected promise, drop
      // the dead worker so the next policy() re-spawns.
      w.onerror = (): void => {
        Sentry.captureException(new Error('Maia queue worker failed to load'), {
          tags: { source: 'maia-queue-worker', backend: backend ?? 'unknown', maia_failure: 'load' },
        });
        settleAllAndDropWorker();
      };
      w.postMessage({ type: 'init' });
    } catch (err) {
      // Graceful-degradation floor (Pitfall 1): a construction failure must
      // not leave every pending policy() promise hanging forever.
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { source: 'maia-queue-worker', backend: 'unknown', maia_failure: 'load' },
      });
      const failed = pending.splice(0, pending.length);
      for (const req of failed) req.resolve({});
    }
  }

  function policy(fen: string, elo: number, side: Side): Promise<Record<string, number>> {
    void side; // side is implicit in fen's own 'w'/'b' field (D-08); accepted for contract shape only.
    const cacheKey = `${fen}|${elo}`;
    const cached = cache.get(cacheKey);
    if (cached) return Promise.resolve(cached);

    return new Promise<Record<string, number>>((resolve) => {
      pending.push({ fen, elo, resolve });
      ensureSpawned();
      processQueue();
    });
  }

  function terminate(): void {
    if (worker) {
      worker.postMessage({ type: 'terminate' });
      worker.terminate();
    }
    worker = null;
    isReady = false;
    backend = null;
    const unresolved = [...(currentBatch ?? []), ...pending];
    currentBatch = null;
    pending.length = 0;
    for (const req of unresolved) req.resolve({});
  }

  /** Prewarm: spawn the worker without an analyze request. See `MaiaQueue.warm()`. */
  function warm(): void {
    ensureSpawned();
  }

  return { policy, terminate, warm };
}
