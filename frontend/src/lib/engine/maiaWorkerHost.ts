/**
 * maiaWorkerHost — a single, refcounted Maia Web Worker shared by every
 * `/analysis` consumer (quick 260729-sod, FIX 3).
 *
 * Before this module, `/analysis` ran up to THREE independent Maia workers
 * simultaneously: `useMaiaEngine` (live chart), `useGemSweep` (background
 * sweep, via its own `useMaiaEngine` call), and `maiaQueue` (FlawChess
 * Engine's policy provider) — each holding its own ~226 MB ONNX Runtime WASM
 * heap. Desktop: up to 3 workers (~678 MB). Mobile/low-power (where the gem
 * sweep is gated off by `isLowPowerDevice()`): 2 workers (~452 MB — the
 * configuration that actually OOM'd mobile Safari on FLAWCHESS-92). See
 * 260729-sod-FINDINGS.md §4.
 *
 * This host collapses that to ONE Worker + ONE ONNX session, refcounted by
 * lease. The enabling simplification: the host serialises to exactly ONE
 * inference in flight on the wire at any time, so the worker's `result`
 * message is unambiguous without any request-id — ORT can't run two
 * inferences concurrently on one session anyway, so today's "parallel"
 * workers only ever bought parallelism by paying 3x the heap.
 *
 * The two existing consumer disciplines are NOT merged into this host — they
 * stay ABOVE it, driving it as plain leases:
 *  - `useMaiaEngine` keeps its `pendingFenRef` single-in-flight "drop and
 *    reissue" discipline (only the latest position matters for a live chart).
 *  - `maiaQueue` keeps its no-drop FIFO with per-request promises (every
 *    `policy()` call issued by `mctsSearch.ts` needs an answer — dropping one
 *    would leave an expansion's promise hanging forever) and its own
 *    same-FEN batching (deduped distinct ELOs, never the full ladder) BEFORE
 *    calling this host's `analyze()` once per batch.
 * Their caches, however, ARE now shared (Phase 194 CACHE-05): the UCI-keyed
 * `fen|elo` policy cache lives in `maiaPolicyCache.ts`, write-through
 * populated by `useMaiaEngine`'s chart on every ladder rung and read by
 * `maiaQueue`'s `policy()` on a hit — so a position the chart already
 * inferred serves the engine's own root policy call without a second Maia
 * forward pass. This host still owns transport only (worker spawn/respawn/
 * death, one in-flight request, priority ordering) and guarantees every
 * `analyze()` promise settles; it holds no cache of its own.
 *
 * Ownership of the Task-1/Task-2 respawn + Sentry-capture logic moves here
 * from `useMaiaEngine.ts`/`maiaQueue.ts`, which no longer construct a Worker
 * or handle `webgpu-unavailable`/`onerror` themselves.
 */

import * as Sentry from '@sentry/react';
import { captureMaiaWorkerError, type MaiaErrorSource } from '@/lib/maiaWorkerErrors';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Path to the vendored Maia Worker served from public/maia/ — moved here from maiaQueue.ts (D-04's "SEPARATE Worker() instance" is reversed by this task; see file headers there). */
export const ENGINE_PATH = '/maia/maia-worker.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MaiaAnalyzeResult {
  fen: string;
  rawPolicyByElo: { elo: number; policy: Float32Array }[];
  wdlByElo: { elo: number; wdl: Float32Array }[];
  backend: 'webgpu' | 'wasm';
}

export interface MaiaWorkerLease {
  /** Enqueues one `analyze` request; resolves/rejects once this specific request settles. */
  analyze(fen: string, eloInputs: readonly number[]): Promise<MaiaAnalyzeResult>;
  /** Resolves with the active backend once the shared worker reports `ready` (lazily spawns if needed). */
  whenReady(): Promise<'webgpu' | 'wasm'>;
  /** Synchronous read of the current backend — null until `ready`. */
  getBackend(): 'webgpu' | 'wasm' | null;
  /** Drops this lease. At zero remaining leases, terminates the worker and frees the heap. */
  release(): void;
}

export interface AcquireMaiaWorkerOptions {
  /** Distinguishes this lease's Sentry captures — `maia-worker` (chart/gem-sweep) vs `maia-queue-worker` (FlawChess Engine). */
  source: MaiaErrorSource;
  /** `true` = jump queued background requests (but never preempt the in-flight one) — the live chart. `false` = background (gem sweep, engine search). */
  priority: boolean;
  /** Fired once, when the shared worker dies unexpectedly (onerror, or a pre-ready error) — NOT fired for a webgpu-unavailable respawn, which is transparent to leases. */
  onFatal?: () => void;
}

/** Raw worker payload shape for a completed `analyze` (see maia-worker.js header). */
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
  | { type: 'error'; message: string }
  | { type: 'webgpu-unavailable'; message: string };

/** One `analyze()` call awaiting dispatch or resolution. */
interface QueuedRequest {
  fen: string;
  eloInputs: readonly number[];
  priority: boolean;
  leaseId: number;
  source: MaiaErrorSource;
  resolve: (result: MaiaAnalyzeResult) => void;
  reject: (err: Error) => void;
}

interface ReadyWaiter {
  resolve: (backend: 'webgpu' | 'wasm') => void;
  reject: (err: Error) => void;
}

interface LeaseRecord {
  source: MaiaErrorSource;
  onFatal?: () => void;
}

// ─── Module-level singleton state ──────────────────────────────────────────

let worker: Worker | null = null;
let isReady = false;
let backend: 'webgpu' | 'wasm' | null = null;
/** Source of whichever lease most recently triggered a spawn — used to tag Sentry captures that fire before any request is in flight (pre-ready init failures). */
let spawnSource: MaiaErrorSource | null = null;

let nextLeaseId = 1;
const leases = new Map<number, LeaseRecord>();

/** Requests not yet dispatched to the worker, ordered priority-first, FIFO within each priority tier. */
const queue: QueuedRequest[] = [];
/** The single request currently awaiting the worker's `result`/`error`, or null when idle. */
let inFlight: QueuedRequest | null = null;
/** Callers awaiting `whenReady()` before the worker has reported `ready`. */
const readyWaiters: ReadyWaiter[] = [];

// ─── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Inserts a request into `queue`. Priority requests go after every
 * already-queued priority request but before every non-priority one — FIFO
 * within each tier, never preempting whatever is already `inFlight`. This is
 * what keeps the live chart's ladder inference from queuing behind the
 * FlawChess Engine's MCTS policy calls or the gem sweep's background sweep.
 */
function enqueue(req: QueuedRequest): void {
  if (req.priority) {
    const firstNonPriorityIdx = queue.findIndex((q) => !q.priority);
    if (firstNonPriorityIdx === -1) queue.push(req);
    else queue.splice(firstNonPriorityIdx, 0, req);
  } else {
    queue.push(req);
  }
  ensureSpawned(req.source);
  dispatchNext();
}

/** Dispatches the head of `queue` to the worker, if idle and ready. */
function dispatchNext(): void {
  if (inFlight !== null) return;
  if (!worker || !isReady) return;
  const next = queue.shift();
  if (!next) return;
  inFlight = next;
  worker.postMessage({ type: 'analyze', fen: next.fen, eloInputs: next.eloInputs });
}

// ─── Worker lifecycle ───────────────────────────────────────────────────────

/** Lazily spawns the worker on the first `analyze()`/`whenReady()` call — never eagerly at `acquireMaiaWorker`. */
function ensureSpawned(source: MaiaErrorSource): void {
  if (worker) return;
  spawn(source, 'auto');
}

/**
 * Constructs a fresh Worker and wires its handlers. `mode: 'wasm'` is used
 * exactly once, for the respawn after a `webgpu-unavailable` message (quick
 * 260729-sod, FIX 1, moved here from the two consumers in FIX 3) — it pins
 * the fresh worker to the WASM-only path so it never loads the WebGPU bundle
 * that failed in the dead one.
 */
function spawn(source: MaiaErrorSource, mode: 'auto' | 'wasm'): void {
  spawnSource = source;
  let w: Worker;
  try {
    w = new Worker(ENGINE_PATH);
  } catch (err) {
    // Graceful-degradation floor: a construction failure must not leave every
    // affected promise hanging forever.
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { source, backend: 'unknown', maia_failure: 'load' },
    });
    failAllLeasesAndDropWorker(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  worker = w;
  isReady = false;
  backend = null;

  w.onmessage = (e: MessageEvent<WorkerMessage>) => handleMessage(e.data);

  // A Worker whose script fails to load (404 / CSP / syntax error) does NOT
  // throw from `new Worker(...)` — it fires this asynchronous `error` event
  // instead, which the try/catch above can never catch. This is "worker
  // death": reject everything, fire every lease's onFatal, drop the worker so
  // the next analyze()/whenReady() re-spawns.
  w.onerror = (): void => {
    Sentry.captureException(new Error('Maia worker: worker load failure'), {
      tags: { source: spawnSource ?? source, backend: backend ?? 'unknown', maia_failure: 'load' },
    });
    failAllLeasesAndDropWorker(new Error('Maia worker: worker load failure'));
  };

  // Auto mode probes WebGPU worker-side; a post-fallback respawn is pinned to wasm.
  w.postMessage(mode === 'wasm' ? { type: 'init', backend: 'wasm' } : { type: 'init' });
}

/**
 * Detaches handlers on the dead worker, terminates it, resets the module-level
 * worker state, and spawns a fresh replacement pinned to the wasm backend
 * (`mode: 'wasm'`, never re-probing WebGPU). Shared by the pre-ready
 * `webgpu-unavailable` path and the post-ready mid-inference WebGPU-death
 * fallback (Task 2) — both are "this worker's GPU session is unusable,
 * reclaim its heap and keep going on wasm" situations. `queue` is
 * deliberately left untouched: `spawn()` never touches it, and
 * `dispatchNext()` runs on the replacement's `ready`, servicing whatever was
 * already queued.
 */
function respawnPinnedToWasm(rawMessage: string, breadcrumbMessage: string): void {
  const source = spawnSource ?? 'maia-worker';
  if (worker) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }
  worker = null;
  isReady = false;
  backend = null;
  Sentry.addBreadcrumb({
    category: 'maia',
    level: 'info',
    message: breadcrumbMessage,
    data: { rawMessage },
  });
  spawn(source, 'wasm');
}

function handleMessage(msg: WorkerMessage): void {
  if (msg.type === 'ready') {
    isReady = true;
    backend = msg.backend;
    const waiters = readyWaiters.splice(0, readyWaiters.length);
    for (const w of waiters) w.resolve(msg.backend);
    dispatchNext();
    return;
  }

  if (msg.type === 'result') {
    const req = inFlight;
    inFlight = null;
    if (req) {
      // wdlByElo is computed by the worker and transferred on EVERY
      // analyze() call, yet nothing in the engine core reads it today —
      // deliberately retained, not dead payload a future cleanup should
      // strip: Phase 197 (Maia WDL leaf values) consumes it as the leaf
      // value for deep tree nodes (Phase 194 CACHE-06).
      req.resolve({ fen: msg.fen, rawPolicyByElo: msg.rawPolicyByElo, wdlByElo: msg.wdlByElo, backend: msg.backend });
    }
    dispatchNext();
    return;
  }

  if (msg.type === 'webgpu-unavailable') {
    // Terminal for THIS worker instance (quick 260729-sod, FIX 1): the
    // WebGPU session/warmup failed and the worker deliberately did NOT
    // double-load a second ORT runtime into its own heap. Detach handlers,
    // terminate, and respawn pinned to wasm — a fresh Worker is the only
    // reliable way to reclaim the ~226 MB heap #1 left alive. `queue` is left
    // intact (this arrives strictly pre-ready, so `inFlight` is always null
    // here — dispatchNext() never sends analyze before `ready`): the fresh
    // worker services every already-queued request, unlike `worker death`
    // below where nothing will ever run again.
    respawnPinnedToWasm(msg.message, 'Maia worker WebGPU session failed — respawning worker pinned to wasm');
    return;
  }

  // msg.type === 'error'. Routed through captureMaiaWorkerError (Task 1) for
  // bounded classification + stable Sentry grouping. `inFlight`'s own source
  // is used when available (a post-ready error always has one dispatched);
  // otherwise this is a pre-ready init failure and the spawning lease's
  // source is the best available tag.
  const errSource = inFlight?.source ?? spawnSource ?? 'maia-worker';
  captureMaiaWorkerError(msg.message, { source: errSource, backend });

  if (!isReady) {
    // Pre-ready init failure (e.g. onnx session/model-load): nothing will
    // ever service this worker — settle everything as worker death.
    failAllLeasesAndDropWorker(new Error(msg.message));
    return;
  }

  // FLAWCHESS-9D: a mid-inference WebGPU session death (observed on the
  // Android 10 / Chrome Mobile population). The vendored ORT WebGPU bundle
  // throws when it looks up a GPU buffer handle it had already released —
  // that's third-party code we don't patch, so the fix lives at the host
  // level instead of in maia-worker.js. Gated on the active backend only,
  // with no message-pattern match: the branch is self-limiting because the
  // replacement worker is pinned to wasm and reports `backend: 'wasm'`, so
  // it can fire at most once per worker lifetime — a respawn loop is
  // structurally impossible. A false positive here only costs a slower wasm
  // session for the rest of the tab, while a too-narrow pattern list would
  // both leave the bug in place and duplicate classification logic that
  // already lives in maiaWorkerErrors.ts.
  if (backend === 'webgpu') {
    const req = inFlight;
    inFlight = null;
    if (req) req.reject(new Error(msg.message));
    // No ready worker exists at this moment — dispatchNext() runs once the
    // wasm-pinned replacement reports `ready` (same contract as the
    // pre-ready webgpu-unavailable path above).
    respawnPinnedToWasm(msg.message, 'Maia worker WebGPU session died mid-inference — respawning worker pinned to wasm');
    return;
  }

  // Post-ready error: the worker is still alive, so keep serving the rest of
  // the queue — reject only the in-flight request (matches today's
  // per-consumer behavior).
  const req = inFlight;
  inFlight = null;
  if (req) req.reject(new Error(msg.message));
  dispatchNext();
}

/**
 * "Worker death": rejects every queued AND in-flight promise, rejects every
 * pending `whenReady()` waiter, fires every currently-registered lease's
 * `onFatal`, and drops the worker (WITHOUT clearing `leases` — leases persist
 * until explicitly `release()`d) so the next `analyze()`/`whenReady()` call
 * re-spawns a fresh worker instead of queuing forever behind a dead one.
 * Shared by the pre-ready message-error path and the async `worker.onerror`
 * script-load-failure path — both are the same "nothing will ever service
 * this queue" situation (maiaQueue's pre-existing self-heal contract,
 * preserved here at the host level).
 */
function failAllLeasesAndDropWorker(err: Error): void {
  const stranded = queue.splice(0, queue.length);
  for (const req of stranded) req.reject(err);
  if (inFlight) {
    inFlight.reject(err);
    inFlight = null;
  }
  const waiters = readyWaiters.splice(0, readyWaiters.length);
  for (const w of waiters) w.reject(err);
  for (const lease of leases.values()) lease.onFatal?.();

  if (worker) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }
  worker = null;
  isReady = false;
  backend = null;
}

// ─── Refcounting ────────────────────────────────────────────────────────────

function releaseLease(leaseId: number): void {
  if (!leases.has(leaseId)) return;
  leases.delete(leaseId);

  const err = new Error('Maia worker lease released');
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]?.leaseId === leaseId) {
      const [removed] = queue.splice(i, 1);
      removed?.reject(err);
    }
  }
  // Reject this lease's in-flight request EARLY if it owns the one running —
  // the worker itself is still computing it (ORT can't be interrupted
  // mid-inference), so `inFlight` is deliberately left in place: the eventual
  // `result`/`error` message resolves/rejects an already-settled promise
  // (a harmless no-op) and `dispatchNext()` proceeds exactly as normal.
  if (inFlight?.leaseId === leaseId) {
    inFlight.reject(err);
  }

  if (leases.size === 0) {
    // Last lease gone — terminate outright and reset every module var so
    // navigating away from /analysis really does free the ~226 MB heap.
    if (worker) {
      worker.postMessage({ type: 'terminate' });
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
    resetModuleState();
  }
}

function resetModuleState(): void {
  worker = null;
  isReady = false;
  backend = null;
  spawnSource = null;
  const remainingQueue = queue.splice(0, queue.length);
  for (const req of remainingQueue) req.reject(new Error('Maia worker terminated'));
  if (inFlight) {
    inFlight.reject(new Error('Maia worker terminated'));
    inFlight = null;
  }
  const waiters = readyWaiters.splice(0, readyWaiters.length);
  for (const w of waiters) w.reject(new Error('Maia worker terminated'));
}

// ─── Public surface ─────────────────────────────────────────────────────────

export function acquireMaiaWorker(opts: AcquireMaiaWorkerOptions): MaiaWorkerLease {
  const leaseId = nextLeaseId++;
  leases.set(leaseId, { source: opts.source, onFatal: opts.onFatal });

  return {
    analyze(fen: string, eloInputs: readonly number[]): Promise<MaiaAnalyzeResult> {
      return new Promise<MaiaAnalyzeResult>((resolve, reject) => {
        enqueue({ fen, eloInputs, priority: opts.priority, leaseId, source: opts.source, resolve, reject });
      });
    },
    whenReady(): Promise<'webgpu' | 'wasm'> {
      if (isReady && backend) return Promise.resolve(backend);
      return new Promise<'webgpu' | 'wasm'>((resolve, reject) => {
        readyWaiters.push({ resolve, reject });
        ensureSpawned(opts.source);
      });
    },
    getBackend(): 'webgpu' | 'wasm' | null {
      return backend;
    },
    release(): void {
      releaseLease(leaseId);
    },
  };
}

/** Test-only: drops the singleton so each vitest case starts clean. */
export function resetMaiaWorkerHostForTests(): void {
  if (worker) {
    worker.onmessage = null;
    worker.onerror = null;
    try {
      worker.terminate();
    } catch {
      // best-effort — a mock Worker in tests may not implement terminate()
    }
  }
  worker = null;
  isReady = false;
  backend = null;
  spawnSource = null;
  queue.length = 0;
  inFlight = null;
  readyWaiters.length = 0;
  leases.clear();
  nextLeaseId = 1;
}
