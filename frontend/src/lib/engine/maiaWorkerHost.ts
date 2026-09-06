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
import {
  captureMaiaWorkerError,
  classifyMaiaWorkerError,
  MaiaWorkerError,
  type MaiaErrorSource,
} from '@/lib/maiaWorkerErrors';
import { supportsWasmSimd } from './wasmSimd';
import { isIosWebKit } from './iosWebKit';
import {
  getEngineAssetsSnapshot,
  markEngineAssetFailed,
  markEngineAssetPending,
  markEngineAssetReady,
  markEngineAssetsUnsupported,
  reportEngineAssetProgress,
  resetEngineAssetForRefetch,
} from './engineAssetProgress';
import { ensureOrtRuntime, fetchWasmOnlyOrtRuntime, probeOrtBackendOnce, type OrtBackend } from './ortRuntimeSource';
import { ENGINE_ASSET_CACHE_NAME, ENGINE_ASSET_VERSION_QUERY, versionedEngineAssetUrl } from './engineAssetCache';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Versioned URL (path plus the shared `?v=<n>` query — quick 260905-rhc) to
 * the vendored Maia Worker served from public/maia/ — moved here from
 * maiaQueue.ts (D-04's "SEPARATE Worker() instance" is reversed by this
 * task; see file headers there).
 */
export const ENGINE_PATH = versionedEngineAssetUrl('/maia/maia-worker.js');

/**
 * WR-01 (Phase 219 review): matches onnxruntime-web's own rejection message
 * ("WebAssembly backend initializing failed due to timeout.") once
 * `ort.env.wasm.initTimeout` (maia-worker.js's `MAIA_WASM_INIT_TIMEOUT_MS`)
 * bounds a blocked-pthread-worker hang instead of letting `create()` hang
 * forever. Distinguishes this ONE recoverable pre-ready failure mode from
 * every other pre-ready init error (OOM, a genuine model-load failure, an
 * unrelated ONNX error) — those still fail the worker outright via
 * `failAllLeasesAndDropWorker`.
 */
const THREADED_INIT_TIMEOUT_PATTERN = /initializ(?:ing|ation).*timeout/i;

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
  // Phase 219 (D-08/D-10): `numThreads` is the wasm thread count
  // `chooseWasmThreadCount()` chose on the worker side — see maia-worker.js.
  | { type: 'ready'; backend: 'webgpu' | 'wasm'; numThreads: number }
  | { type: 'progress'; loaded: number; total: number }
  | WorkerResultMessage
  | { type: 'error'; message: string }
  // Phase 213-12 (D-20): LOST its modelBuffer field (G-213-8 retired) — every
  // spawn now reads the model from CacheStorage instead of a one-shot handoff.
  | { type: 'webgpu-unavailable'; message: string };

/**
 * Outgoing init message shape (Phase 213-09, G-213-35). `backend` is now
 * REQUIRED and always exactly `'webgpu' | 'wasm'` — the main thread (this
 * host, via `ortRuntimeSource.ts`'s adapter probe) makes the backend decision
 * BEFORE the Worker is constructed, so the worker's own former `'auto'` mode
 * (probe-inside-the-worker) no longer exists. `runtimeBuffer` is the
 * onnxruntime-web runtime `.wasm` bytes for `ort.env.wasm.wasmBinary` — absent
 * when the shared runtime fetch degraded to `null` (T-213-09-02), in which
 * case the worker leaves `wasmBinary` unset and onnxruntime-web resolves the
 * binary from `wasmPaths` exactly as before this change.
 *
 * Phase 213-12 (D-20, closing G-213-37): `assetCacheName` is set from
 * `ENGINE_ASSET_CACHE_NAME` (imported, never duplicated as a literal — the
 * worker cannot `import` this TS module) on EVERY spawn in `constructWorker`,
 * covering both the `'auto'` and the `'wasm'` respawn branch with the one
 * assignment. It is the SAME versioned CacheStorage name `engineAssetCache.ts`
 * opens on the main thread, so `maia-worker.js`'s own small mirror of that
 * cache logic reaches the identical cache by name rather than a duplicated
 * literal — the mechanism that makes a second Maia worker spawn (the
 * per-game respawn `BotsGame`'s `key={boot.nonce}` remount guarantees) cost
 * zero network after the first complete download.
 *
 * Phase 213-12 (D-20): LOST `modelBuffer` — the `G-213-8` handoff (a dying
 * WebGPU worker transferring its downloaded model to its wasm replacement)
 * is retired. CacheStorage supersedes it: every replacement worker now reads
 * the model from the SAME versioned cache via `assetCacheName`, which costs
 * zero network whenever the model was already downloaded, without keeping a
 * second transferable in this message (the exact shape that produced
 * `G-213-36`).
 *
 * Quick 260905-rhc: `assetVersionQuery` is the shared `?v=<n>` suffix
 * (`ENGINE_ASSET_VERSION_QUERY`, derived from `ENGINE_ASSET_CACHE_VERSION`)
 * — set on EVERY spawn in `constructWorker`, the same object literal that
 * already sets `assetCacheName`, covering both the normal spawn and the
 * wasm-pinned respawn with one assignment. The worker cannot `import` this
 * TS module, so the suffix arrives on the message instead of being
 * duplicated there as a literal. Absent means unversioned URLs inside the
 * worker (a degrade, never a crash).
 */
interface InitMessage {
  type: 'init';
  backend: OrtBackend;
  runtimeBuffer?: ArrayBuffer;
  assetCacheName?: string;
  assetVersionQuery?: string;
  /** WR-01 (Phase 219 review): pins the worker's `ort.env.wasm.numThreads` to
   *  1 — sent on the ONE retry `handleMessage` issues after a threaded wasm
   *  init timeout (`THREADED_INIT_TIMEOUT_PATTERN`), never on a normal spawn. */
  forceSingleThread?: boolean;
}

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
/** Phase 219 (D-10, Pitfall 9): the wasm thread count the worker reported on its last `ready` message — attached to failure-path Sentry context in `maiaWorkerErrors.ts` alongside `hardwareConcurrency`, `null` before the first `ready`. */
let lastReportedNumThreads: number | null = null;
/** Source of whichever lease most recently triggered a spawn — used to tag Sentry captures that fire before any request is in flight (pre-ready init failures). */
let spawnSource: MaiaErrorSource | null = null;
/**
 * WR-01 (Phase 219 review): true when the CURRENT worker's init message was
 * sent with `forceSingleThread: true` — set in `constructWorker` (the single
 * funnel every spawn goes through) and read by `handleMessage`'s pre-ready
 * `error` branch to decide whether a threaded-init-timeout is still eligible
 * for the one-time single-thread retry, or whether this replacement ALSO
 * timed out (already single-threaded, so retrying again could never help —
 * treat it as a genuine failure instead of looping forever).
 */
let currentInitForceSingleThread = false;

let nextLeaseId = 1;
const leases = new Map<number, LeaseRecord>();

/** D-13: cached `supportsWasmSimd()` result — `null` until the first `ensureSpawned()` probes it, so repeated calls do not re-validate. */
let simdSupported: boolean | null = null;

/**
 * Bug fix (213-UAT G-213-8): true once a WebGPU session has failed in this
 * page session. `respawnPinnedToWasm()` only pins the ONE replacement it
 * spawns; if that replacement later died fatally, `worker` went back to
 * `null` and the next `ensureSpawned()` re-probed WebGPU in `'auto'` mode —
 * re-running the same doomed GPU init AND a fresh 45.7 MB model download,
 * once per cycle. WebGPU availability cannot change within a page session,
 * so once it has failed every later spawn is pinned to wasm.
 */
let webgpuFailed = false;

/**
 * Phase 213-09 (G-213-35): true from the moment `spawn()` starts awaiting the
 * shared onnxruntime-web runtime fetch until the Worker has actually been
 * constructed. `ensureSpawned()` re-entry during this window is a no-op
 * rather than a second spawn — the same hazard plan 213-08 closed for
 * `workerPool.ts`'s `grade()` (T-213-09-03). While this is true, `worker`
 * stays `null`, so `dispatchNext()`'s existing `!worker` guard already lets a
 * request enqueue rather than dispatch — no separate "in-flight" branch is
 * needed on the queuing side, only on the re-spawn side.
 */
let spawnInFlight = false;

/**
 * Phase 213-09: bumped by `resetModuleState()` (the last-lease-release
 * teardown) — a spawn continuation captures the generation BEFORE its
 * runtime-fetch await and compares against the current value once the fetch
 * resolves, so a `spawn()` that was already in flight when the last lease
 * released constructs nothing into an already-torn-down module state.
 * Mirrors `workerPool.ts`'s `spawnGeneration` for its own `terminate()`.
 */
let spawnGeneration = 0;

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

/**
 * Lazily spawns the worker on the first `analyze()`/`whenReady()` call — never
 * eagerly at `acquireMaiaWorker`. D-13: probes WASM-SIMD support BEFORE ever
 * constructing a `Worker` — this is the single choke point every Maia
 * consumer funnels through (bot play, the analysis chart, the gem sweep, and
 * the FlawChess Engine's policy queue all reach the worker via this
 * function), so a device that can never run the model never spends 45.7 MB of
 * mobile data finding out. The probe result is cached in `simdSupported` so
 * repeated `ensureSpawned()` calls do not re-validate.
 *
 * Phase 213-09 (T-213-09-03): also guards on `spawnInFlight` — `spawn()` now
 * awaits the shared onnxruntime-web runtime fetch before constructing a
 * Worker, so `worker` stays `null` for the whole fetch window. Without this
 * guard, every `analyze()`/`whenReady()` call arriving during that window
 * would re-enter this function and start a SECOND spawn (and a second
 * runtime fetch) rather than joining the one already in flight.
 */
function ensureSpawned(source: MaiaErrorSource): void {
  if (worker) return;
  if (spawnInFlight) return;
  if (simdSupported === null) {
    simdSupported = supportsWasmSimd();
  }
  if (!simdSupported) {
    markEngineAssetsUnsupported('no-wasm-simd');
    // Reported by EngineReadyGate's `unsupported` capture (D-17), not here —
    // the MaiaWorkerError marker keeps useFlawChessEngine from reporting the
    // same rejection a second time as "a provider failed to become ready".
    failAllLeasesAndDropWorker(new MaiaWorkerError('Maia worker: device lacks WASM SIMD', 'unsupported'));
    return;
  }
  // SEED-158 (2026-09-06): on iOS/iPadOS WebKit the wasm inference path
  // kills the whole page (Safari's silent per-page memory-limit termination,
  // measured on an iPhone 14 Pro), so a wasm-pinned spawn is never allowed
  // there. WebGPU IS fine on the same device (iOS 26 Safari: the real worker
  // reached `ready backend=webgpu` and survived 30 full ladders at ~510 ms
  // each), so the 'auto' spawn below goes ahead and `spawn()` gates iOS off
  // only if the adapter probe answers 'wasm'. Same terminal shape as the SIMD
  // case above (no Retry: a reload runs into the same answer). Stockfish is
  // unaffected: it lives in `workerPool.ts` and never reaches this host.
  if (webgpuFailed && isIosWebKit()) {
    gateOffIosWebKit('iOS WebKit: WebGPU already failed this page session — Maia stays off (wasm inference kills the page, SEED-158)');
    return;
  }
  spawn(source, webgpuFailed ? 'wasm' : 'auto');
}

/**
 * The iOS/iPadOS terminal (SEED-158): no Worker is (or stays) constructed,
 * the store reports `unsupported` with the `'ios-webkit'` reason so
 * `EngineReadyGate` shows the iOS-specific copy, and every lease is settled
 * with the `'unsupported'` marker (same contract as the SIMD case: the gate's
 * D-17 capture reports it, this host does not). Reached from three places —
 * the pre-spawn probe answering 'wasm', a `webgpu-unavailable` message, and a
 * mid-inference WebGPU death — all of which would otherwise fall through to
 * the fatal wasm spawn. `iosWebKit.ts` carries the device evidence.
 */
function gateOffIosWebKit(consoleLine: string): void {
  console.info(`[maia-worker] ${consoleLine}`);
  spawnInFlight = false;
  markEngineAssetsUnsupported('ios-webkit');
  failAllLeasesAndDropWorker(
    new MaiaWorkerError('Maia worker: gated off on iOS WebKit (no usable WebGPU; wasm inference kills the page)', 'unsupported'),
  );
}

/**
 * Async-at-the-seam spawn (Phase 213-09, G-213-35, mirrors 213-08's
 * `workerPool.ts::ensureSpawned()` pattern): resolves the onnxruntime-web
 * runtime binary (and the backend it implies) BEFORE constructing the
 * Worker, so the worker never probes the adapter itself and never issues its
 * own runtime fetch.
 *
 * `mode: 'auto'` (the normal spawn) joins `ensureOrtRuntime()`'s memoised
 * probe-then-fetch — the adapter decision is made here, once, and every
 * later `analyze()`/`whenReady()` call for the life of the page reuses it.
 * `mode: 'wasm'` (used exactly once, for the respawn after a
 * `webgpu-unavailable` message — quick 260729-sod, FIX 1, moved here from
 * the two consumers in FIX 3) calls `fetchWasmOnlyOrtRuntime()` directly:
 * the host already knows the replacement is pinned to wasm, so there is no
 * adapter left to probe and no reason to reuse `ensureOrtRuntime()`'s
 * (differently-backended) memoised promise.
 */
function spawn(source: MaiaErrorSource, mode: 'auto' | 'wasm', forceSingleThread = false): void {
  spawnSource = source;
  spawnInFlight = true;
  const myGeneration = spawnGeneration;

  // CR-02 (213-REVIEW.md): register BOTH ids as in-flight in the SAME
  // synchronous call, before either await — 'ort-runtime' can never be
  // absent from the readiness check while 'maia-model' is still pending, or
  // vice versa. No-op (via `markEngineAssetPending`'s own guard) on a
  // respawn where the id is already registered from the initial spawn.
  markEngineAssetPending('maia-model');
  markEngineAssetPending('ort-runtime');

  // Deliberately TWO separate `.then()` call sites rather than composing an
  // extra `.then()` on top of `fetchWasmOnlyOrtRuntime()`'s return value to
  // unify the two shapes into one `runtimePromise` variable: the test
  // double's synchronous "thenable" pattern (mirrors 213-08's
  // `stockfishWorkerSource` mock) only stays synchronous across EXACTLY one
  // `.then()` call layered directly on the mocked function's own return
  // value — composing a second `.then()` before this point would silently
  // reintroduce a real microtask hop for the `mode: 'wasm'` respawn path
  // only, breaking every pre-existing test that asserts on `createdWorkers`
  // immediately after triggering a respawn.
  if (mode === 'wasm') {
    fetchWasmOnlyOrtRuntime().then((runtimeBuffer) => {
      // Phase 213-09: the last lease released mid-fetch (`resetModuleState()`
      // bumped `spawnGeneration`) — construct nothing into an already-torn-down
      // module state. Mirrors `workerPool.ts::ensureSpawned()`'s
      // `myGeneration !== spawnGeneration` guard for `terminate()`.
      if (myGeneration !== spawnGeneration) return;
      spawnInFlight = false;
      constructWorker(source, 'wasm', runtimeBuffer, forceSingleThread);
    });
    return;
  }

  if (isIosWebKit()) {
    // SEED-158: decide from the probe alone, BEFORE `ensureOrtRuntime()`
    // would fetch a runtime — a 'wasm' answer on iOS means "no Maia", and
    // the 14.0 MB wasm-only binary must not be downloaded on the way there.
    probeOrtBackendOnce().then((probed) => {
      if (myGeneration !== spawnGeneration) return;
      if (probed === 'wasm') {
        gateOffIosWebKit('iOS WebKit without a usable WebGPU adapter — Maia gated off (wasm inference kills the page, SEED-158)');
        return;
      }
      spawnFromRuntime(source, myGeneration, forceSingleThread);
    });
    return;
  }

  spawnFromRuntime(source, myGeneration, forceSingleThread);
}

/** The tail of an `'auto'` spawn: resolve the probed backend's runtime bytes, then construct the Worker (unless the module was torn down mid-fetch). */
function spawnFromRuntime(source: MaiaErrorSource, myGeneration: number, forceSingleThread: boolean): void {
  ensureOrtRuntime().then(({ backend: chosenBackend, buffer: runtimeBuffer }) => {
    if (myGeneration !== spawnGeneration) return;
    spawnInFlight = false;
    constructWorker(source, chosenBackend, runtimeBuffer, forceSingleThread);
  });
}

/**
 * Constructs a fresh Worker and wires its handlers, once the backend
 * decision and the runtime buffer are both already resolved. `runtimeBuffer`
 * is TRANSFERRED, not copied — a zero-copy pointer handoff rather than a
 * structured clone of 14.0-25.7 MB (213-RESEARCH.md Pitfall 2).
 *
 * Buffer-safety audit (G-213-36, Phase 213-11; mechanism moved in Phase
 * 213-12, D-20): transferring — and thereby detaching — `runtimeBuffer` here
 * is safe because every caller of `getEngineAsset()` (which both
 * `ensureOrtRuntime()` and `fetchWasmOnlyOrtRuntime()` now route through,
 * `ortRuntimeSource.ts`) receives an instance it exclusively owns: a fresh
 * cache read, or an independent copy for a single-flight joiner. No
 * ArrayBuffer is ever retained across calls in `ortRuntimeSource.ts`'s own
 * module scope, so there is no shared value any transfer could detach — a
 * structural guarantee from the cache layer rather than a copy discipline
 * this function has to reason about.
 *
 * Phase 213-12 (D-20, closing G-213-37): `modelBuffer` (G-213-8) is RETIRED
 * — it used to be the second transferable in this message, the exact shape
 * that produced `G-213-36`. Every spawn now reads the model from
 * CacheStorage inside `maia-worker.js` itself instead.
 */
function constructWorker(
  source: MaiaErrorSource,
  chosenBackend: OrtBackend,
  runtimeBuffer: ArrayBuffer | null,
  forceSingleThread = false,
): void {
  let w: Worker;
  try {
    w = new Worker(ENGINE_PATH);
  } catch (err) {
    // Graceful-degradation floor: a construction failure must not leave every
    // affected promise hanging forever.
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { source, backend: 'unknown', maia_failure: 'load' },
    });
    failAllLeasesAndDropWorker(new MaiaWorkerError(String(err), 'load'));
    return;
  }

  worker = w;
  isReady = false;
  backend = null;
  // WR-03 fix (Phase 219 review): this was never reset on respawn, so a
  // pre-ready init failure in a REPLACEMENT worker (e.g. after a
  // webgpu-unavailable respawn) attached the DEAD worker's numThreads to the
  // Sentry `engine_device` context, contradicting the documented contract
  // above ("null before the first ready") — constructWorker is the single
  // funnel every spawn (auto AND wasm-pinned respawn) goes through, so
  // resetting here covers every respawn path.
  lastReportedNumThreads = null;
  // WR-01 (Phase 219 review): tracked per-worker so a THIS worker's own
  // pre-ready timeout can tell "first timeout, eligible for the single-
  // thread retry" apart from "already single-threaded, retrying again is
  // pointless" — see `currentInitForceSingleThread`'s own comment.
  currentInitForceSingleThread = forceSingleThread;

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
    failAllLeasesAndDropWorker(new MaiaWorkerError('Maia worker: worker load failure', 'load'));
  };

  // Phase 213-12 (D-20, G-213-37): sent on EVERY spawn — this single
  // assignment covers both the 'auto' spawn and the 'wasm' respawn branch,
  // since both funnel through this one function.
  const initMsg: InitMessage = {
    type: 'init',
    backend: chosenBackend,
    assetCacheName: ENGINE_ASSET_CACHE_NAME,
    assetVersionQuery: ENGINE_ASSET_VERSION_QUERY,
    forceSingleThread,
  };
  const transfer: Transferable[] = [];
  if (runtimeBuffer) {
    initMsg.runtimeBuffer = runtimeBuffer;
    transfer.push(runtimeBuffer);
  }
  w.postMessage(initMsg, transfer);
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
  // SEED-158 (2026-09-06): on iOS/iPadOS WebKit the wasm replacement would
  // kill the page (see `iosWebKit.ts`), so a WebGPU failure there is the
  // TERMINAL `unsupported` state, not a respawn. Captured once per page
  // session (`webgpuFailed` below guarantees no second pass) because it is
  // exactly the population the seed wants visible: an iOS device that has
  // WebGPU yet lost Maia to it. Variable data goes in context, not the
  // message, so the events group (CLAUDE.md Sentry rules).
  if (isIosWebKit()) {
    webgpuFailed = true;
    Sentry.setContext('maia', { rawMessage, breadcrumbMessage });
    Sentry.captureException(new Error('Maia worker: WebGPU failed on iOS WebKit — gated off (no wasm fallback there)'), {
      tags: { source, backend: 'webgpu', maia_failure: 'webgpu-ios-terminal' },
    });
    gateOffIosWebKit(`${breadcrumbMessage} — iOS WebKit: no wasm respawn (it kills the page) — ${rawMessage}`);
    return;
  }
  // Announce the fallback in the console. maia-worker.js's header has always
  // promised "the fallback itself is announced with a single console.info
  // line", but until Phase 219 UAT only a Sentry breadcrumb was recorded — a
  // browser UAT on a device whose WebGPU EP fails (Linux/RADV: "Program Cast
  // requires f16 but the device does not support it") saw the worker land on
  // wasm with no console trace of WHY. Same shape as the `ready` line below.
  console.info(`[maia-worker] ${breadcrumbMessage} — ${rawMessage}`);
  // G-213-8: WebGPU has now failed for this page session — never re-probe it.
  webgpuFailed = true;
  if (worker) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }
  worker = null;
  isReady = false;
  backend = null;
  // Bug fix (WR-02, 213-REVIEW.md): the replacement worker reads the model
  // again via `fetchModelBuffer` (both the pre-ready `webgpu-unavailable`
  // path and this post-ready mid-inference death re-run the full init
  // sequence) — if this respawn follows a completed
  // `markEngineAssetReady('maia-model')`, the store's entry is still
  // `{ done: true, loaded: total }` from the dead worker's earlier success.
  // Without resetting it, `useEngineAssets(['maia-model']).ready`/`.percent`
  // would keep reporting the asset 100% ready throughout the replacement's
  // own init — a real state/reality mismatch a caller gating new work on
  // `.ready` (rather than a provider's own `whenReady()`) could act on.
  //
  // Phase 213-12 (D-20): now UNCONDITIONAL. Before this plan it was
  // conditional on whether the dying worker had handed its model bytes over
  // (G-213-8) — a handoff meant no fetch would occur, so resetting would
  // have dropped the bar to 0% for a "download" that was never going to
  // happen. That handoff is retired: every respawn now reads the model
  // through `fetchModelBuffer`'s own cache-first path, which reports full
  // progress IMMEDIATELY on a cache hit — so resetting first and letting the
  // cache-hit report drive the bar back to 100% is correct on every path,
  // cached or not.
  resetEngineAssetForRefetch('maia-model');
  // Bug fix (213-09, G-213-35): also unconditional, for the same reason —
  // this respawn path only ever fires after a WebGPU attempt, i.e. the
  // runtime binary already fetched was the asyncify build — the wasm-only
  // replacement about to be requested (see `spawn(source, 'wasm')` below) is
  // ALWAYS different bytes, so the gate's bar must not keep reporting the
  // asyncify build's already-`done` state while the wasm-only one is
  // resolved fresh (cache hit or genuine fetch).
  resetEngineAssetForRefetch('ort-runtime');
  Sentry.addBreadcrumb({
    category: 'maia',
    level: 'info',
    message: breadcrumbMessage,
    data: { rawMessage },
  });
  spawn(source, 'wasm');
}

/**
 * WR-01 (Phase 219 review): named seam (mirrors `respawnPinnedToWasm` above)
 * that keeps `handleMessage` under the enforced complexity-15 limit.
 * Detaches the dying worker, resets module state, and spawns a REPLACEMENT
 * with `forceSingleThread: true` — reusing whichever mode `ensureSpawned`
 * would have chosen (still 'auto' unless WebGPU has separately failed), so
 * the SAME backend is retried and only `numThreads` changes. `queue` is left
 * untouched: this only ever fires pre-ready (nothing has been serviced yet),
 * so the replacement drains it on its own `ready` — same contract as
 * `respawnPinnedToWasm`. A breadcrumb (not a full Sentry capture) mirrors
 * that function's own webgpu-unavailable reporting shape: this path is
 * non-terminal, so a full capture only happens if the single-thread retry
 * ALSO fails (`handleMessage`'s terminal `captureMaiaWorkerError` call).
 */
function respawnPinnedToSingleThread(source: MaiaErrorSource, rawMessage: string): void {
  // Console trace for the same reason as respawnPinnedToWasm: a silent
  // respawn is indistinguishable from a slow first init during browser UAT.
  console.info(`[maia-worker] threaded wasm init timed out — respawning pinned to single-thread — ${rawMessage}`);
  Sentry.addBreadcrumb({
    category: 'maia',
    level: 'warning',
    message: 'Maia worker: threaded wasm init timed out — respawning pinned to single-thread',
    data: { rawMessage, numThreads: lastReportedNumThreads },
  });
  if (worker) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }
  worker = null;
  isReady = false;
  backend = null;
  lastReportedNumThreads = null;
  spawn(source, webgpuFailed ? 'wasm' : 'auto', true);
}

function handleMessage(msg: WorkerMessage): void {
  if (msg.type === 'progress') {
    // D-01/D-07: forward directly to the module-level store singleton — the
    // host is already a module singleton and the store is another, so a
    // direct call is the smaller surface and is what makes progress survive
    // component unmount.
    reportEngineAssetProgress('maia-model', msg.loaded, msg.total);
    return;
  }

  if (msg.type === 'ready') {
    isReady = true;
    backend = msg.backend;
    lastReportedNumThreads = msg.numThreads;
    // Phase 219 (D-10, Pitfall 9): the only observable surface for the chosen
    // wasm thread count — read during browser UAT via the console, since
    // whenReady()'s Promise<'webgpu' | 'wasm'> signature is deliberately not
    // widened to carry it (would ripple through every caller for no gain).
    console.info(`[maia-worker] ready — backend=${msg.backend} numThreads=${msg.numThreads}`);
    markEngineAssetReady('maia-model');
    // Phase 213-09 (G-213-35): 'ready' fires only after the worker's
    // `InferenceSession.create()` has already succeeded — on EVERY path,
    // including the degraded one where our own runtime fetch returned a null
    // buffer and the worker fell back to `wasmPaths` resolution. Marking
    // 'ort-runtime' done here (never anywhere else) is what keeps the
    // non-dismissible gate from locking a device out forever behind an asset
    // nothing on the degraded path would otherwise ever mark done.
    markEngineAssetReady('ort-runtime');
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
    //
    // Phase 213-12 (D-20): the `modelBuffer` handoff (G-213-8) that used to
    // ride along on this message is RETIRED — the replacement worker now
    // reads the model from CacheStorage instead (zero network on a cache
    // hit), so there is nothing left to transfer here.
    respawnPinnedToWasm(msg.message, 'Maia worker WebGPU session failed — respawning worker pinned to wasm');
    return;
  }

  // msg.type === 'error' — the only remaining variant. Extracted into its
  // own function (rather than inlined here) to keep `handleMessage` under
  // the enforced complexity-15 limit — this branch alone (timeout-retry +
  // classification + three settlement shapes) was pushing it well past that.
  handleErrorMessage(msg.message);
}

/**
 * Handles `{ type: 'error' }`. Routed through `captureMaiaWorkerError` (Task
 * 1) for bounded classification + stable Sentry grouping. `inFlight`'s own
 * source is used when available (a post-ready error always has one
 * dispatched); otherwise this is a pre-ready init failure and the spawning
 * lease's source is the best available tag.
 */
function handleErrorMessage(rawMessage: string): void {
  const errSource = inFlight?.source ?? spawnSource ?? 'maia-worker';

  // WR-01 (Phase 219 review): a threaded-init timeout is pre-ready by
  // construction (it fires from inside `InferenceSession.create()`, before
  // `ready` can ever post) and recoverable — retry ONCE pinned to a single
  // thread rather than failing every lease outright over what is really a
  // blocked pthread worker (missing COEP on the threaded runtime's response),
  // not a genuinely broken device. `currentInitForceSingleThread` guards
  // against retrying a worker that was ALREADY single-threaded — that
  // failure is real, not a blocked-pthread artifact, so this can never loop.
  if (!isReady && !currentInitForceSingleThread && THREADED_INIT_TIMEOUT_PATTERN.test(rawMessage)) {
    respawnPinnedToSingleThread(spawnSource ?? errSource, rawMessage);
    return;
  }

  // Dedupe (FLAWCHESS-9V/A3/A5): the returned MaiaWorkerError is what every
  // downstream waiter is rejected with, so `useFlawChessEngine` and
  // `EngineReadyGate` can tell this already-reported failure apart from one
  // nobody has captured yet.
  const reported = captureMaiaWorkerError(rawMessage, {
    source: errSource,
    backend,
    // Phase 219 (D-08): the thread count in effect when this failure fired —
    // null before the first `ready` (pre-ready init failures never had one).
    numThreads: lastReportedNumThreads,
  });

  if (!isReady) {
    // Pre-ready init failure (e.g. onnx session/model-load): nothing will
    // ever service this worker — settle everything as worker death.
    failAllLeasesAndDropWorker(reported);
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
    if (req) req.reject(reported);
    // No ready worker exists at this moment — dispatchNext() runs once the
    // wasm-pinned replacement reports `ready` (same contract as the
    // pre-ready webgpu-unavailable path above).
    respawnPinnedToWasm(rawMessage, 'Maia worker WebGPU session died mid-inference — respawning worker pinned to wasm');
    return;
  }

  // Post-ready error: the worker is still alive, so keep serving the rest of
  // the queue — reject only the in-flight request (matches today's
  // per-consumer behavior).
  const req = inFlight;
  inFlight = null;
  if (req) req.reject(reported);
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
/**
 * Every caller passes a `MaiaWorkerError` — the failure is already on its way
 * to Sentry (captured here, or by the gate for `'unsupported'`), so downstream
 * waiters rejected with it can skip re-reporting.
 */
function failAllLeasesAndDropWorker(err: MaiaWorkerError): void {
  const stranded = queue.splice(0, queue.length);
  for (const req of stranded) req.reject(err);
  if (inFlight) {
    inFlight.reject(err);
    inFlight = null;
  }
  const waiters = readyWaiters.splice(0, readyWaiters.length);
  for (const w of waiters) w.reject(err);
  for (const lease of leases.values()) lease.onFatal?.();

  // Phase 213 D-14/D-15: a terminal model-fetch/init failure marks the asset
  // store 'failed' so EngineReadyGate can offer Retry — but NEVER downgrade
  // an already-`'unsupported'` status to the generic `'failed'` one. The
  // D-13 SIMD probe already ran (in `ensureSpawned`, above this call site)
  // and determined this device can never run Maia regardless of how many
  // times it retries; offering Retry there would be a lie.
  if (getEngineAssetsSnapshot().status !== 'unsupported') {
    // Bug fix (quick 260829-tku): classification used to stop at the Sentry
    // tag in captureMaiaWorkerError — a session-init memory exhaustion (real
    // prod string, FLAWCHESS-92: onnxruntime "Out of memory" while creating
    // the inference session) reached the user as generic download-failure
    // copy instead of being told to free device memory.
    // `'unsupported'` cannot reach here (guarded above); the fallback only
    // keeps the type honest.
    markEngineAssetFailed(
      'maia-model',
      err.kind === 'unsupported' ? classifyMaiaWorkerError(err.message) : err.kind,
    );
  }

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
  // Phase 213-09: invalidates any spawn continuation already awaiting the
  // runtime fetch when the last lease released — its generation check will
  // no longer match, so it constructs nothing into this torn-down state.
  spawnGeneration += 1;
  spawnInFlight = false;
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
  // D-13: the module-level SIMD-probe cache must also be cleared, or a test
  // that stubs WebAssembly.validate to false in one case would leak that
  // cached result into every subsequent case in the same file.
  simdSupported = null;
  // G-213-8: the WebGPU pin is page-session state — a test that forces a
  // WebGPU failure in one case must not leak the pin into the next.
  webgpuFailed = false;
  // Phase 213-09: the in-flight/generation pair must also reset, or a test
  // that leaves a spawn mid-fetch would leak state into the next case.
  spawnInFlight = false;
  spawnGeneration = 0;
  // WR-01 (Phase 219 review): a test that drives a threaded-init-timeout
  // retry in one case must not leak the pin into the next.
  currentInitForceSingleThread = false;
  lastReportedNumThreads = null;
}
