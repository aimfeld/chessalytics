/**
 * maiaQueue — a Maia policy provider supplying per-node UCI-keyed
 * move-probability distributions for an explicit per-side ELO (POOL-03).
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
 * Worker ownership (quick 260729-sod, FIX 3 — reverses Phase 154 D-04's
 * "SEPARATE Worker() instance" decision): this module no longer constructs
 * its own Worker. `/analysis` running up to THREE concurrent Maia workers —
 * this queue's own, `useMaiaEngine`'s chart worker, and `useGemSweep`'s own
 * `useMaiaEngine` instance — cost ~226 MB of WASM heap EACH: up to 3 on
 * desktop (~678 MB) and 2 on mobile/low-power (~452 MB, the configuration
 * that actually OOM'd mobile Safari on FLAWCHESS-92 — the gem sweep's
 * `isLowPowerDevice()` gate keeps its instance from spawning there). This
 * module now acquires a `priority: false` lease from the shared
 * `maiaWorkerHost` singleton instead, which owns Worker spawn/respawn/death
 * and guarantees every request settles. The D-04 parts that still hold are
 * unchanged: deduped per-side ELOs instead of the full ladder, and a
 * separate `(fen, elo)`-keyed cache.
 *
 * Lazy lease acquisition on the first `policy()`/`warm()` call (D-02),
 * `type: 'error'`/`webgpu-unavailable`/worker-death Sentry reporting is now
 * entirely owned by `maiaWorkerHost.ts`; this module's own graceful-
 * degradation floor is the `.catch` in `processQueue` below — a lease
 * rejection (worker death) settles every affected promise instead of leaving
 * it hanging (Pitfall 1).
 */

import { maskAndSoftmax } from '@/lib/maiaEncoding';
import { sanToUci } from '@/lib/sanToSquares';
import { acquireMaiaWorker } from './maiaWorkerHost';
import type { MaiaAnalyzeResult, MaiaWorkerLease } from './maiaWorkerHost';
import type { Side } from './types';

// ─── Constants ───────────────────────────────────────────────────────────────

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
  /** Resolves every outstanding request to `{}` and releases the shared worker lease. */
  terminate(): void;
  /**
   * Acquires the shared worker lease (which lazily spawns the Worker and
   * begins the ONNX weight load) WITHOUT enqueueing an `analyze` request —
   * the Phase 169.5 prewarm counterpart to `WorkerPool.warm()`.
   *
   * This exists even though the opening book's own `deps.policy()` call
   * already warms Maia by necessity on essentially every bot turn: that makes
   * "Maia is warm" a latent consequence of "the book happened to run", an
   * invariant that would break silently under a future config where the book
   * is disabled or `BOOK_PLY_CAP` is 0. It is the same one-line
   * `ensureLease()` forwarding shape as `WorkerPool.warm()` and costs
   * nothing. Idempotent.
   */
  warm(): void;
}

/** One policy() call awaiting dispatch or resolution. */
interface PendingPolicyRequest {
  fen: string;
  elo: number;
  resolve: (result: Record<string, number>) => void;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createMaiaQueue(): MaiaQueue {
  /** Ephemeral (fen, elo)-keyed cache — separate from useMaiaEngine's, per D-04. */
  const cache = new Map<string, Record<string, number>>();
  /** Requests not yet dispatched to the shared worker lease. */
  const pending: PendingPolicyRequest[] = [];
  /** True while a batch's `lease.analyze()` call is in flight — the local mirror of the old `currentBatch !== null` gate, so this queue never fires two concurrent analyze() calls from its own lease. */
  let dispatching = false;
  let lease: MaiaWorkerLease | null = null;
  /**
   * True once this lease's `whenReady()` has resolved at least once. Gates
   * `processQueue` exactly like the old `isReady` check did: every
   * `policy()` call issued synchronously before the shared worker becomes
   * ready accumulates in `pending`, so the FIRST dispatch after `ready`
   * naturally batches every same-FEN request that arrived in that window —
   * without this gate, this queue's own `dispatching` flag would let the
   * very first `policy()` call dispatch alone (a batch of one) before a
   * second synchronous call ever gets a chance to join it, defeating D-04's
   * same-FEN batching.
   */
  let leaseReady = false;
  /** True while a `whenReady()` subscription is outstanding — prevents `ensureLease` from stacking duplicate subscriptions across repeated calls before the first one settles. */
  let readyPromiseInFlight = false;

  function cacheResult(key: string, result: Record<string, number>): void {
    cache.set(key, result);
    if (cache.size > MAIA_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  /**
   * Converts the host's raw per-ELO logits into UCI-keyed probabilities for
   * every request in the just-completed batch, resolving each caller's own
   * promise. `maskAndSoftmax` (single-sourced from maiaEncoding.ts) yields
   * SAN-keyed probabilities; each key is converted to UCI via `sanToUci`,
   * dropping only genuinely unconvertible entries (WR-07 null convention,
   * Pitfall 4 — verified by the entry-count-parity test).
   */
  function handleResult(batch: PendingPolicyRequest[], msg: MaiaAnalyzeResult): void {
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

  /**
   * Assigns the next batch of same-FEN pending requests to the lease, if the
   * shared worker is ready and no inference is currently in flight from this
   * queue (one ONNX inference at a time — the ONNX runtime can't run two
   * analyses concurrently). Batches every pending request sharing the
   * head-of-queue's FEN into one `analyze` call with the deduped distinct
   * ELOs they need (D-04) — never the full ladder.
   */
  function processQueue(): void {
    if (dispatching) return;
    if (!leaseReady || !lease) return;
    const first = pending[0];
    if (!first) return;

    const batch = pending.filter((req) => req.fen === first.fen);
    for (const req of batch) {
      const idx = pending.indexOf(req);
      if (idx >= 0) pending.splice(idx, 1);
    }

    const dedupedElos = Array.from(new Set(batch.map((req) => req.elo)));
    dispatching = true;
    lease.analyze(first.fen, dedupedElos).then(
      (result) => {
        dispatching = false;
        handleResult(batch, result);
        processQueue();
      },
      () => {
        // Unconditional: this IS the no-hanging-promise invariant (Pitfall 1)
        // — a lease rejection (worker death, or this lease being released)
        // must not leave any request in this batch hanging forever.
        dispatching = false;
        for (const req of batch) req.resolve({});
        processQueue();
      },
    );
  }

  /**
   * Worker death (async script-load failure, or a pre-ready init error):
   * nothing will ever service a request still sitting in `pending` — resolve
   * every stranded one to `{}` (self-heal contract, preserved at the host
   * level for whatever this lease has in flight/queued there; `pending` is
   * this queue's own not-yet-dispatched backlog).
   */
  function onFatal(): void {
    leaseReady = false;
    const stranded = pending.splice(0, pending.length);
    for (const req of stranded) req.resolve({});
  }

  /**
   * Lazily acquires the shared worker lease on the first policy()/warm() call
   * (D-02) — never eagerly — and, on every call while not yet ready, (re-)
   * subscribes to `whenReady()`. This is what makes "the next analyze()
   * re-spawns" (the host's worker-death self-heal contract) actually happen
   * from this queue's side: the SAME lease persists across a worker death
   * (`onFatal` only resets `leaseReady`, it does not drop `lease`) — the
   * lease's own `whenReady()` re-triggers the host's `ensureSpawned()` since
   * the dead worker was already dropped there.
   */
  function ensureLease(): MaiaWorkerLease {
    if (!lease) {
      lease = acquireMaiaWorker({ source: 'maia-queue-worker', priority: false, onFatal });
    }
    if (!leaseReady && !readyPromiseInFlight) {
      readyPromiseInFlight = true;
      lease.whenReady().then(
        () => {
          readyPromiseInFlight = false;
          leaseReady = true;
          processQueue();
        },
        () => {
          readyPromiseInFlight = false;
          // onFatal above already handles settlement for a rejected whenReady().
        },
      );
    }
    return lease;
  }

  function policy(fen: string, elo: number, side: Side): Promise<Record<string, number>> {
    void side; // side is implicit in fen's own 'w'/'b' field (D-08); accepted for contract shape only.
    const cacheKey = `${fen}|${elo}`;
    const cached = cache.get(cacheKey);
    if (cached) return Promise.resolve(cached);

    return new Promise<Record<string, number>>((resolve) => {
      pending.push({ fen, elo, resolve });
      ensureLease();
      processQueue();
    });
  }

  function terminate(): void {
    const unresolved = pending.splice(0, pending.length);
    for (const req of unresolved) req.resolve({});
    lease?.release();
    lease = null;
    leaseReady = false;
  }

  /** Prewarm: acquire the shared lease without an analyze request. See `MaiaQueue.warm()`. */
  function warm(): void {
    ensureLease();
  }

  return { policy, terminate, warm };
}
