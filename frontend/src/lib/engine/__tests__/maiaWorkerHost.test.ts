/**
 * maiaWorkerHost.ts unit tests (quick 260729-sod, FIX 3).
 *
 * Covers: one Worker shared across leases, refcount-to-zero termination +
 * re-spawn, single-in-flight serialisation, priority queue-jumping (without
 * preempting an in-flight request), worker-death settlement (queued +
 * in-flight rejected, onFatal fired for every lease), the
 * webgpu-unavailable respawn moved here from Task 2's per-consumer suites,
 * and (Phase 213-09, G-213-35) the async-at-the-seam runtime-fetch spawn:
 * single spawn under concurrent `ensureSpawned()`, queued requests during
 * the in-flight fetch, the null-buffer degrade, the SIMD-fail zero-fetch
 * path, the respawn requesting wasm-only directly, and the both-surfaces
 * single-fetch proof.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Sentry from '@sentry/react';
import { acquireMaiaWorker, resetMaiaWorkerHostForTests, ENGINE_PATH } from '../maiaWorkerHost';
import { getEngineAssetsSnapshot, resetEngineAssetsForTests } from '../engineAssetProgress';
import { ensureOrtRuntime, fetchWasmOnlyOrtRuntime } from '../ortRuntimeSource';
import { ENGINE_ASSET_CACHE_NAME } from '../engineAssetCache';

vi.mock('@sentry/react', () => ({ captureException: vi.fn(), addBreadcrumb: vi.fn() }));

// ─── ortRuntimeSource mock (Phase 213-09, G-213-35) ────────────────────────
//
// `spawn()` now awaits the shared onnxruntime-web runtime fetch before
// constructing a Worker. This file's job is the HOST's own dispatch/queue/
// respawn/refcount logic, not the runtime-fetch mechanics (covered by
// `ortRuntimeSource.test.ts`) — the DEFAULT mock resolves both
// `ensureOrtRuntime()` and `fetchWasmOnlyOrtRuntime()` via a synchronous
// "thenable" (a `.then` that invokes its callback immediately, in the SAME
// synchronous call, rather than deferring to a real microtask) so every
// pre-existing test in this file that asserts on `createdWorkers` right
// after calling `analyze()`/`whenReady()` — with NO await in between — keeps
// working completely unchanged: `spawn()`'s `runtimePromise.then(...)` call
// resolves and runs its continuation synchronously, so the worker exists by
// the time control returns to the test. Only the NEW tests that specifically
// prove the queue-instead-of-drop / concurrent-spawn race behavior override
// this default with a real, test-controlled Promise via
// `vi.mocked(ensureOrtRuntime).mockReturnValueOnce(...)`.
function syncThenable<T>(value: T): PromiseLike<T> {
  return {
    then<TResult1 = T, TResult2 = never>(
      onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      const result = onfulfilled ? onfulfilled(value) : (value as unknown as TResult1);
      return Promise.resolve(result);
    },
  };
}

vi.mock('../ortRuntimeSource', () => ({
  ensureOrtRuntime: vi.fn(() => syncThenable({ backend: 'wasm' as const, buffer: null })),
  fetchWasmOnlyOrtRuntime: vi.fn(() => syncThenable<ArrayBuffer | null>(null)),
}));

// ─── Mock Worker ─────────────────────────────────────────────────────────────

interface WorkerMessageLike {
  type: string;
  [key: string]: unknown;
}

class MockWorker {
  onmessage: ((e: MessageEvent<WorkerMessageLike>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  messages: WorkerMessageLike[] = [];
  terminated = false;

  transfers: (Transferable[] | undefined)[] = [];

  postMessage(msg: WorkerMessageLike, transfer?: Transferable[]): void {
    this.messages.push(msg);
    this.transfers.push(transfer);
  }

  terminate(): void {
    this.terminated = true;
  }

  simulateMessage(data: WorkerMessageLike): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }
}

let createdWorkers: MockWorker[];

function stubWorkerCtor(): void {
  createdWorkers = [];
  vi.stubGlobal(
    'Worker',
    vi.fn(function () {
      const w = new MockWorker();
      createdWorkers.push(w);
      return w;
    }),
  );
}

function driveReady(worker: MockWorker, backend: 'webgpu' | 'wasm' = 'wasm'): void {
  worker.simulateMessage({ type: 'ready', backend });
}

function analyzeMessages(worker: MockWorker): WorkerMessageLike[] {
  return worker.messages.filter((m) => m.type === 'analyze');
}

/** Stand-in for the real 45.7 MB model — only its identity and length matter here. */
const MODEL_BYTES = 1024;

const TEST_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const TEST_FEN_2 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1';

function buildResultMessage(fen: string, elos: number[] = [1500]): WorkerMessageLike {
  return {
    type: 'result',
    fen,
    rawPolicyByElo: elos.map((elo) => ({ elo, policy: new Float32Array(4352) })),
    wdlByElo: elos.map((elo) => ({ elo, wdl: Float32Array.from([0, 0, 0]) })),
    backend: 'wasm',
  };
}

describe('maiaWorkerHost', () => {
  beforeEach(() => {
    stubWorkerCtor();
    resetMaiaWorkerHostForTests();
    resetEngineAssetsForTests();
  });

  afterEach(() => {
    resetMaiaWorkerHostForTests();
    resetEngineAssetsForTests();
    // BUG FIX (Phase 213-12, test isolation): `vi.clearAllMocks()` below
    // clears call history but does NOT reset an implementation installed via
    // `mockReturnValue`/`mockImplementation` (only `mockReset()` does) — a
    // test that sets a PERSISTENT (not `-Once`) override on these two mocks
    // (e.g. the "MUTATION CHECK" test below) would otherwise leak a REAL,
    // asynchronously-resolving Promise into every later test in this file,
    // silently breaking their synchronous "no await needed" assumption about
    // the default `syncThenable`. Restoring the default here, every test,
    // makes each test's OWN `mockReturnValueOnce`/`mockReturnValue` override
    // local to itself.
    vi.mocked(ensureOrtRuntime).mockImplementation(() => syncThenable({ backend: 'wasm' as const, buffer: null }));
    vi.mocked(fetchWasmOnlyOrtRuntime).mockImplementation(() => syncThenable<ArrayBuffer | null>(null));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('constructs the worker at ENGINE_PATH lazily, not at acquireMaiaWorker', () => {
    acquireMaiaWorker({ source: 'maia-worker', priority: true });
    expect(createdWorkers).toHaveLength(0);
  });

  it('one Worker is constructed across two leases', () => {
    const lease1 = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    const lease2 = acquireMaiaWorker({ source: 'maia-queue-worker', priority: false });

    void lease1.whenReady();
    expect(createdWorkers).toHaveLength(1);
    void lease2.whenReady();
    // Still one worker — the second lease shares the already-spawned instance.
    expect(createdWorkers).toHaveLength(1);
    expect(vi.mocked(Worker)).toHaveBeenCalledWith(ENGINE_PATH);
  });

  it('refcount reaching zero terminates the worker, and a later acquire re-spawns', () => {
    const lease1 = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    const lease2 = acquireMaiaWorker({ source: 'maia-queue-worker', priority: false });
    // release() below rejects this still-pending whenReady() (the worker never
    // reached `ready`) — attach a no-op catch so it doesn't surface as an
    // unhandled rejection.
    lease1.whenReady().catch(() => {});
    const worker1 = createdWorkers[0]!;

    lease1.release();
    expect(worker1.terminated).toBe(false); // lease2 still holds a reference

    lease2.release();
    expect(worker1.terminated).toBe(true);

    const lease3 = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease3.whenReady();
    expect(createdWorkers).toHaveLength(2);
  });

  it('serialises to exactly one in-flight request across two leases', () => {
    const chart = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    const engine = acquireMaiaWorker({ source: 'maia-queue-worker', priority: false });
    void chart.analyze(TEST_FEN, [1500]);
    driveReady(createdWorkers[0]!);
    void engine.analyze(TEST_FEN_2, [1200]);

    // Only the first request has been dispatched — the second sits queued.
    expect(analyzeMessages(createdWorkers[0]!)).toHaveLength(1);
    expect(analyzeMessages(createdWorkers[0]!)[0]?.fen).toBe(TEST_FEN);

    createdWorkers[0]!.simulateMessage(buildResultMessage(TEST_FEN, [1500]));

    expect(analyzeMessages(createdWorkers[0]!)).toHaveLength(2);
    expect(analyzeMessages(createdWorkers[0]!)[1]?.fen).toBe(TEST_FEN_2);
  });

  it('a priority request jumps queued background requests but never preempts the in-flight one', async () => {
    const chart = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    const engine = acquireMaiaWorker({ source: 'maia-queue-worker', priority: false });
    const sweep = acquireMaiaWorker({ source: 'maia-worker', priority: false });

    // A background request is already in flight when the priority request arrives.
    const backgroundInFlight = engine.analyze(TEST_FEN, [1200]);
    driveReady(createdWorkers[0]!);
    const backgroundQueued = sweep.analyze(TEST_FEN_2, [1300]);
    const priorityRequest = chart.analyze('8/8/8/8/8/8/8/4K2k w - - 0 1', [1500]);

    // In-flight request is untouched — priority does not preempt it.
    expect(analyzeMessages(createdWorkers[0]!)).toHaveLength(1);
    expect(analyzeMessages(createdWorkers[0]!)[0]?.fen).toBe(TEST_FEN);

    createdWorkers[0]!.simulateMessage(buildResultMessage(TEST_FEN, [1200]));
    await backgroundInFlight;

    // The priority request jumped ahead of the queued background one.
    expect(analyzeMessages(createdWorkers[0]!)).toHaveLength(2);
    expect(analyzeMessages(createdWorkers[0]!)[1]?.fen).toBe('8/8/8/8/8/8/8/4K2k w - - 0 1');

    createdWorkers[0]!.simulateMessage(buildResultMessage('8/8/8/8/8/8/8/4K2k w - - 0 1', [1500]));
    await priorityRequest;

    expect(analyzeMessages(createdWorkers[0]!)).toHaveLength(3);
    expect(analyzeMessages(createdWorkers[0]!)[2]?.fen).toBe(TEST_FEN_2);
    createdWorkers[0]!.simulateMessage(buildResultMessage(TEST_FEN_2, [1300]));
    await backgroundQueued;
  });

  it('worker death (pre-ready error) rejects queued + in-flight requests and fires every lease onFatal', async () => {
    const onFatal1 = vi.fn();
    const onFatal2 = vi.fn();
    const lease1 = acquireMaiaWorker({ source: 'maia-worker', priority: true, onFatal: onFatal1 });
    const lease2 = acquireMaiaWorker({ source: 'maia-queue-worker', priority: false, onFatal: onFatal2 });

    const p1 = lease1.analyze(TEST_FEN, [1500]);
    const p2 = lease2.analyze(TEST_FEN_2, [1200]);

    // Never driveReady() — this is a pre-ready init failure.
    createdWorkers[0]!.simulateMessage({ type: 'error', message: 'onnx init failure' });

    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
    expect(onFatal1).toHaveBeenCalledTimes(1);
    expect(onFatal2).toHaveBeenCalledTimes(1);

    // A later analyze() re-spawns a fresh worker.
    void lease1.analyze(TEST_FEN, [1500]);
    expect(createdWorkers).toHaveLength(2);
  });

  it('an async worker.onerror (script-load failure) also settles as worker death', async () => {
    const onFatal = vi.fn();
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true, onFatal });
    const p1 = lease.analyze(TEST_FEN, [1500]);

    createdWorkers[0]!.simulateError();

    await expect(p1).rejects.toThrow();
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ maia_failure: 'load' }) }),
    );
  });

  it('webgpu-unavailable terminates worker #1 and constructs exactly one wasm-pinned replacement, servicing queued requests', async () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    const p1 = lease.analyze(TEST_FEN, [1500]);
    const worker1 = createdWorkers[0]!;

    worker1.simulateMessage({ type: 'webgpu-unavailable', message: 'RangeError: Out of memory' });

    expect(worker1.terminated).toBe(true);
    expect(createdWorkers).toHaveLength(2);
    const replacement = createdWorkers[1]!;
    expect(replacement.messages).toContainEqual(expect.objectContaining({ type: 'init', backend: 'wasm' }));

    // The queued request survives the respawn and is serviced by the new worker.
    driveReady(replacement);
    expect(analyzeMessages(replacement)).toHaveLength(1);
    replacement.simulateMessage(buildResultMessage(TEST_FEN, [1500]));
    await expect(p1).resolves.toBeDefined();
  });

  it('a mid-inference webgpu error rejects in-flight, respawns pinned to wasm, and services the queue (FLAWCHESS-9D)', async () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    const p1 = lease.analyze(TEST_FEN, [1500]);
    const worker1 = createdWorkers[0]!;
    driveReady(worker1, 'webgpu');
    const p2 = lease.analyze(TEST_FEN_2, [1200]);

    // Only the in-flight request has been dispatched to worker #1.
    expect(analyzeMessages(worker1)).toHaveLength(1);

    worker1.simulateMessage({ type: 'error', message: 'WebGPU buffer already released' });

    await expect(p1).rejects.toThrow();
    expect(worker1.terminated).toBe(true);
    expect(createdWorkers).toHaveLength(2);
    const replacement = createdWorkers[1]!;
    expect(replacement.messages).toContainEqual(expect.objectContaining({ type: 'init', backend: 'wasm' }));

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ backend: 'webgpu', maia_failure: 'inference' }),
      }),
    );

    // The still-queued request survives the respawn.
    driveReady(replacement, 'wasm');
    expect(analyzeMessages(replacement)).toHaveLength(1);
    expect(analyzeMessages(replacement)[0]?.fen).toBe(TEST_FEN_2);
    replacement.simulateMessage(buildResultMessage(TEST_FEN_2, [1200]));
    await expect(p2).resolves.toBeDefined();
  });

  it('WR-02: a mid-inference webgpu respawn resets maia-model to not-done in the store, even though it was already marked ready', async () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.analyze(TEST_FEN, [1500]).catch(() => {});
    const worker1 = createdWorkers[0]!;
    driveReady(worker1, 'webgpu'); // marks maia-model done:true in the store

    expect(getEngineAssetsSnapshot().assets['maia-model']?.done).toBe(true);

    worker1.simulateMessage({ type: 'error', message: 'WebGPU buffer already released' });

    // The dead worker's earlier success must not linger: the replacement
    // worker is silently re-fetching the ENTIRE model from scratch, so the
    // store must say so — not still report the stale 100%-ready signal.
    const entry = getEngineAssetsSnapshot().assets['maia-model'];
    expect(entry?.done).toBe(false);
    expect(entry?.loaded).toBe(0);
  });

  it('a mid-inference error on a wasm-backed worker rejects only the in-flight request — no respawn', async () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    const p1 = lease.analyze(TEST_FEN, [1500]);
    const worker1 = createdWorkers[0]!;
    driveReady(worker1, 'wasm');
    const p2 = lease.analyze(TEST_FEN_2, [1200]);

    worker1.simulateMessage({ type: 'error', message: 'inference failed' });

    await expect(p1).rejects.toThrow();
    expect(worker1.terminated).toBe(false);
    expect(createdWorkers).toHaveLength(1);

    // Worker #1 stays alive and serves the next queued request.
    expect(analyzeMessages(worker1)).toHaveLength(2);
    expect(analyzeMessages(worker1)[1]?.fen).toBe(TEST_FEN_2);
    worker1.simulateMessage(buildResultMessage(TEST_FEN_2, [1200]));
    await expect(p2).resolves.toBeDefined();
  });

  it('getBackend() reflects the active backend once ready, null before', () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    expect(lease.getBackend()).toBeNull();
    void lease.whenReady();
    driveReady(createdWorkers[0]!, 'webgpu');
    expect(lease.getBackend()).toBe('webgpu');
  });

  // ─── Phase 213-01: progress/ready forwarding into engineAssetProgress.ts ──

  it('forwards a worker progress message into the engineAssetProgress store', () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.whenReady();
    createdWorkers[0]!.simulateMessage({ type: 'progress', loaded: 1000, total: 45_683_686 });

    const snapshot = getEngineAssetsSnapshot();
    expect(snapshot.assets['maia-model']).toEqual({ loaded: 1000, total: 45_683_686, done: false });
  });

  it("the worker's ready message marks maia-model done in the store", () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.whenReady();
    driveReady(createdWorkers[0]!);

    const snapshot = getEngineAssetsSnapshot();
    expect(snapshot.assets['maia-model']?.done).toBe(true);
    expect(snapshot.status).toBe('ready');
  });

  // ─── D-13 choke point: no WASM SIMD -> zero Workers, ever ────────────────

  it('a device without WASM SIMD never constructs a Worker, and the store reports unsupported', () => {
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);

    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.whenReady().catch(() => {});

    expect(createdWorkers).toHaveLength(0);
    expect(getEngineAssetsSnapshot().status).toBe('unsupported');
  });

  it('a capable device (the default in this file) DOES construct a Worker — proves the probe is not always-fail', () => {
    // Companion to the case above: without this, a bug that hardcoded
    // `simdSupported = false` would pass the "unsupported" case above
    // vacuously — every other test in this file already proves a Worker
    // spawns, but this one names the guard explicitly.
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.whenReady();

    expect(createdWorkers).toHaveLength(1);
    expect(getEngineAssetsSnapshot().status).not.toBe('unsupported');
  });

  // ─── Phase 213-04 D-14/D-15: failure routing into engineAssetProgress ────

  it('a pre-ready error (second consecutive fetch failure) marks the store failed', () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.whenReady().catch(() => {});

    createdWorkers[0]!.simulateMessage({ type: 'error', message: 'model fetch failed' });

    expect(getEngineAssetsSnapshot().status).toBe('failed');
  });

  it('an async worker.onerror (script-load failure) also marks the store failed', () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.whenReady().catch(() => {});

    createdWorkers[0]!.simulateError();

    expect(getEngineAssetsSnapshot().status).toBe('failed');
  });

  it('failAllLeasesAndDropWorker does NOT downgrade an existing unsupported status to failed', () => {
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);

    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.whenReady().catch(() => {});

    // ensureSpawned() already called markEngineAssetsUnsupported() and
    // failAllLeasesAndDropWorker() BEFORE any worker was ever constructed —
    // the status must still read 'unsupported', never overwritten to the
    // less specific 'failed'.
    expect(createdWorkers).toHaveLength(0);
    expect(getEngineAssetsSnapshot().status).toBe('unsupported');
  });

  it('a webgpu-unavailable respawn does NOT mark the store failed — it stays transparent to consumers', () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.analyze(TEST_FEN, [1500]).catch(() => {});
    const worker1 = createdWorkers[0]!;

    worker1.simulateMessage({ type: 'webgpu-unavailable', message: 'RangeError: Out of memory' });

    expect(getEngineAssetsSnapshot().status).not.toBe('failed');
  });

  it('a post-ready error does NOT mark the store failed — the worker is still alive and serving', () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    const p1 = lease.analyze(TEST_FEN, [1500]);
    driveReady(createdWorkers[0]!, 'wasm');
    void p1.catch(() => {});

    createdWorkers[0]!.simulateMessage({ type: 'error', message: 'inference failed' });

    expect(getEngineAssetsSnapshot().status).not.toBe('failed');
  });
  // ─── G-213-8 RETIRED (Phase 213-12, D-20): no more model-buffer handoff ────
  //
  // Every spawn now reads the model from CacheStorage instead (proven
  // end-to-end in maiaWorkerScript.test.ts and engineAssetCache.test.ts) —
  // the handoff this block used to test no longer exists. `resetModelBuffer`
  // is retired from the init message entirely and the progress-bar reset on
  // a respawn is now UNCONDITIONAL, since no bytes are ever handed over.

  it('the replacement worker\'s init message carries NO model buffer field', () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.analyze(TEST_FEN, [1500]).catch(() => {});
    const worker1 = createdWorkers[0]!;

    worker1.simulateMessage({ type: 'progress', loaded: MODEL_BYTES, total: MODEL_BYTES });
    worker1.simulateMessage({ type: 'webgpu-unavailable', message: 'RangeError: Out of memory' });

    const worker2 = createdWorkers[1]!;
    const init = worker2.messages.find((m) => m.type === 'init')!;
    expect(init).toMatchObject({ type: 'init', backend: 'wasm' });
    expect(init).not.toHaveProperty('modelBuffer');
    // No model-buffer transferable either — only ort-runtime's buffer (if
    // any) can appear in this respawn's transfer list now.
    const initIndex = worker2.messages.indexOf(init);
    expect(worker2.transfers[initIndex] ?? []).not.toContain(undefined);
  });

  it('the progress bar ALWAYS resets on a webgpu-unavailable respawn — unconditional now that no bytes are ever handed over', () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.analyze(TEST_FEN, [1500]).catch(() => {});
    const worker1 = createdWorkers[0]!;

    worker1.simulateMessage({ type: 'progress', loaded: MODEL_BYTES, total: MODEL_BYTES });
    worker1.simulateMessage({ type: 'webgpu-unavailable', message: 'RangeError: Out of memory' });

    const entry = getEngineAssetsSnapshot().assets['maia-model'];
    expect(entry?.loaded).toBe(0);
    expect(entry?.done).toBe(false);
  });

  it('the replacement still reaches ready and services the queue, with zero model bytes in its init message', async () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    const p1 = lease.analyze(TEST_FEN, [1500]);
    const worker1 = createdWorkers[0]!;

    worker1.simulateMessage({ type: 'webgpu-unavailable', message: 'RangeError: Out of memory' });

    const replacement = createdWorkers[1]!;
    expect(replacement.messages.find((m) => m.type === 'init')).not.toHaveProperty('modelBuffer');
    driveReady(replacement);
    expect(analyzeMessages(replacement)).toHaveLength(1);
    replacement.simulateMessage(buildResultMessage(TEST_FEN, [1500]));
    await expect(p1).resolves.toBeDefined();
  });

  it('never re-probes WebGPU after it has failed once — a later respawn is still pinned to wasm', () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.analyze(TEST_FEN, [1500]).catch(() => {});

    // Cycle 1: WebGPU fails, replacement is pinned to wasm.
    createdWorkers[0]!.simulateMessage({
      type: 'webgpu-unavailable',
      message: 'RangeError: Out of memory',
    });
    // The wasm replacement then dies fatally, dropping the worker entirely.
    createdWorkers[1]!.simulateError();

    // A fresh request re-spawns from scratch. Before this fix that spawn went
    // back to 'auto', re-probing the GPU AND re-downloading the whole model
    // once per cycle.
    void lease.analyze(TEST_FEN_2, [1500]).catch(() => {});

    const worker3 = createdWorkers[2]!;
    expect(worker3.messages.find((m) => m.type === 'init')).toMatchObject({
      type: 'init',
      backend: 'wasm',
    });
  });

  // ─── Phase 213-09 (G-213-35): async-at-the-seam runtime-fetch spawn ────────
  //
  // These tests override the module-mock's default synchronous-thenable
  // `ensureOrtRuntime()`/`fetchWasmOnlyOrtRuntime()` with a REAL,
  // test-controlled Promise to exercise the async spawn seam itself: the
  // in-flight queueing window and the concurrent-`ensureSpawned()` race.

  /** A controllable Promise the test resolves/rejects on demand. */
  function createDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
  } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('T-213-09-03: concurrent ensureSpawned() calls during the in-flight runtime fetch issue exactly ONE fetch and construct exactly ONE Worker', async () => {
    const deferred = createDeferred<{ backend: 'webgpu' | 'wasm'; buffer: ArrayBuffer | null }>();
    vi.mocked(ensureOrtRuntime).mockImplementationOnce(() => deferred.promise);

    const lease1 = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    const lease2 = acquireMaiaWorker({ source: 'maia-queue-worker', priority: false });
    void lease1.whenReady().catch(() => {});
    void lease2.whenReady().catch(() => {});
    void lease1.analyze(TEST_FEN, [1500]).catch(() => {});

    // No Worker exists yet — construction is gated on the runtime fetch.
    expect(createdWorkers).toHaveLength(0);
    expect(vi.mocked(ensureOrtRuntime)).toHaveBeenCalledTimes(1);

    deferred.resolve({ backend: 'wasm', buffer: null });
    await Promise.resolve(); // flush the .then() continuation

    expect(createdWorkers).toHaveLength(1);
    expect(vi.mocked(ensureOrtRuntime)).toHaveBeenCalledTimes(1); // still just once
  });

  it('T-213-09-03: an analyze() issued while the runtime fetch is still in flight is QUEUED and resolves once the worker becomes ready — never dropped', async () => {
    const deferred = createDeferred<{ backend: 'webgpu' | 'wasm'; buffer: ArrayBuffer | null }>();
    vi.mocked(ensureOrtRuntime).mockImplementationOnce(() => deferred.promise);

    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    const p1 = lease.analyze(TEST_FEN, [1500]);
    const p2 = lease.analyze(TEST_FEN_2, [1200]);

    expect(createdWorkers).toHaveLength(0);

    deferred.resolve({ backend: 'wasm', buffer: null });
    await Promise.resolve();

    expect(createdWorkers).toHaveLength(1);
    driveReady(createdWorkers[0]!);

    expect(analyzeMessages(createdWorkers[0]!)).toHaveLength(1);
    createdWorkers[0]!.simulateMessage(buildResultMessage(TEST_FEN, [1500]));
    await expect(p1).resolves.toBeDefined();

    expect(analyzeMessages(createdWorkers[0]!)).toHaveLength(2);
    createdWorkers[0]!.simulateMessage(buildResultMessage(TEST_FEN_2, [1200]));
    await expect(p2).resolves.toBeDefined();
  });

  it('T-213-09-02: a null runtime buffer (degraded fetch) still spawns the worker — init carries no runtimeBuffer field', async () => {
    vi.mocked(ensureOrtRuntime).mockReturnValueOnce(
      Promise.resolve({ backend: 'webgpu', buffer: null }),
    );

    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.whenReady().catch(() => {});
    await Promise.resolve();
    await Promise.resolve(); // native Promise needs an extra microtask tick to settle

    expect(createdWorkers).toHaveLength(1);
    const init = createdWorkers[0]!.messages.find((m) => m.type === 'init')!;
    expect(init).toMatchObject({ type: 'init', backend: 'webgpu' });
    expect(init.runtimeBuffer).toBeUndefined();
  });

  it('D-13: a device without WASM SIMD issues ZERO runtime-fetch calls — the SIMD gate precedes the fetch, not the other way around', () => {
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);

    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.whenReady().catch(() => {});

    expect(vi.mocked(ensureOrtRuntime)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchWasmOnlyOrtRuntime)).not.toHaveBeenCalled();
    expect(createdWorkers).toHaveLength(0);
  });

  it('the webgpu-unavailable respawn requests the wasm-only runtime directly via fetchWasmOnlyOrtRuntime(), not ensureOrtRuntime() again', async () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.analyze(TEST_FEN, [1500]).catch(() => {});
    const worker1 = createdWorkers[0]!;

    vi.mocked(ensureOrtRuntime).mockClear();
    worker1.simulateMessage({ type: 'webgpu-unavailable', message: 'RangeError: Out of memory' });
    await Promise.resolve();

    expect(vi.mocked(fetchWasmOnlyOrtRuntime)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ensureOrtRuntime)).not.toHaveBeenCalled(); // respawn does NOT reuse the initial (differently-backended) memoised promise

    const replacement = createdWorkers[1]!;
    const init = replacement.messages.find((m) => m.type === 'init')!;
    expect(init).toMatchObject({ type: 'init', backend: 'wasm' });
    expect(init).not.toHaveProperty('modelBuffer'); // G-213-8 retired (Phase 213-12, D-20) — every spawn reads the model from CacheStorage instead
  });

  it('the webgpu-unavailable respawn resets ort-runtime for refetch — the replacement is a DIFFERENT binary', () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.analyze(TEST_FEN, [1500]).catch(() => {});
    const worker1 = createdWorkers[0]!;

    // The initial (asyncify) runtime fetch completed.
    worker1.simulateMessage({ type: 'progress', loaded: 100, total: 100 });
    driveReady(worker1, 'webgpu');
    expect(getEngineAssetsSnapshot().assets['ort-runtime']?.done).toBe(true);

    worker1.simulateMessage({ type: 'webgpu-unavailable', message: 'RangeError: Out of memory' });

    // The gate's bar must not keep reporting the OLD (asyncify) build's
    // already-done state while the wasm-only replacement fetches fresh.
    const entry = getEngineAssetsSnapshot().assets['ort-runtime'];
    expect(entry?.done).toBe(false);
    expect(entry?.loaded).toBe(0);
  });

  it('BOTH SURFACES: two leases with different sources share exactly ONE runtime fetch', () => {
    const botLease = acquireMaiaWorker({ source: 'maia-worker', priority: true }); // stands for bot play
    const analysisLease = acquireMaiaWorker({ source: 'maia-queue-worker', priority: false }); // stands for the analysis board

    void botLease.whenReady().catch(() => {});
    void analysisLease.whenReady().catch(() => {});

    expect(vi.mocked(ensureOrtRuntime)).toHaveBeenCalledTimes(1);
    expect(createdWorkers).toHaveLength(1); // one shared worker serves both leases
  });

  it("CR-02: registers 'ort-runtime' pending in the SAME synchronous call as 'maia-model' — neither is reachable without the other", () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.whenReady().catch(() => {});

    // Synchronously right after the spawn — no await, no microtask flush
    // (the default mock's synchronous thenable already resolved by now, but
    // CR-02's own guarantee is that BOTH ids are registered before either
    // async continuation could have arrived).
    const snapshot = getEngineAssetsSnapshot();
    expect(snapshot.assets['maia-model']).toBeDefined();
    expect(snapshot.assets['ort-runtime']).toBeDefined();
  });

  it("the worker's ready message marks ort-runtime done in the store — on every path, including the degraded null-buffer one", async () => {
    vi.mocked(ensureOrtRuntime).mockReturnValueOnce(Promise.resolve({ backend: 'wasm', buffer: null }));

    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.whenReady().catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(getEngineAssetsSnapshot().assets['ort-runtime']?.done).toBe(false); // not yet — worker hasn't reported ready
    driveReady(createdWorkers[0]!);
    expect(getEngineAssetsSnapshot().assets['ort-runtime']?.done).toBe(true);
  });

  // ─── G-213-36: the actual /analysis -> /bots regression ─────────────────
  //
  // `ortRuntimeSource` is mocked wholesale in this file (its own real
  // behavior is `ortRuntimeSource.test.ts`'s job), so these tests prove the
  // OTHER half of the contract: `maiaWorkerHost`'s spawn/teardown/respawn
  // plumbing must forward whatever buffer it receives without holding onto
  // or reusing it — and, using a real structured-clone transfer (Node's
  // `structuredClone(buf, { transfer: [buf] })`, which detaches exactly like
  // a real browser `Worker.postMessage(msg, transfer)`), that a SECOND
  // worker's init message actually LANDS with a genuinely usable buffer, not
  // merely "no error was thrown".
  it('G-213-36 THE ACTUAL REGRESSION: teardown + respawn (the /analysis -> /bots navigation) delivers a valid, non-detached init message to the SECOND worker', async () => {
    const bufferA = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const bufferB = new Uint8Array([6, 7, 8, 9, 10]).buffer;
    // Simulates the FIXED ortRuntimeSource: retain-and-copy hands out a
    // fresh, independent buffer instance on every call — never the same one
    // twice, even though both calls join the same page-session-scoped fetch.
    vi.mocked(ensureOrtRuntime)
      .mockReturnValueOnce(Promise.resolve({ backend: 'wasm', buffer: bufferA }))
      .mockReturnValueOnce(Promise.resolve({ backend: 'wasm', buffer: bufferB }));

    // First spawn — stands for /analysis.
    const lease1 = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease1.whenReady().catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(createdWorkers).toHaveLength(1);
    const worker1 = createdWorkers[0]!;
    driveReady(worker1);

    const init1 = worker1.messages.find((m) => m.type === 'init')!;
    expect(init1.runtimeBuffer).toBe(bufferA);

    // Simulate the REAL browser behavior of the transfer list
    // `constructWorker` passed to `postMessage` — this is the step that
    // detached the memoised buffer before the G-213-36 fix.
    structuredClone(bufferA, { transfer: [bufferA] });
    expect(bufferA.byteLength).toBe(0); // sanity: worker1's own transfer really did detach it

    // Last lease released — the /analysis -> /bots navigation tears down
    // module state exactly as `resetModuleState()` does.
    lease1.release();

    // Second spawn — stands for /bots, in the SAME page session.
    const lease2 = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease2.whenReady().catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(createdWorkers).toHaveLength(2);
    const worker2 = createdWorkers[1]!;
    const init2 = worker2.messages.find((m) => m.type === 'init')!;

    // THE assertion the plan requires: the second worker's init message
    // actually LANDED with a valid, USABLE runtime buffer — not detached,
    // correct length, and itself still transferable (proving it was never
    // touched by worker1's transfer above).
    expect(init2).toBeDefined();
    expect(init2.runtimeBuffer).toBe(bufferB);
    expect((init2.runtimeBuffer as ArrayBuffer).byteLength).toBe(5);
    expect(() => structuredClone(init2.runtimeBuffer, { transfer: [init2.runtimeBuffer as ArrayBuffer] })).not.toThrow();

    // No error was thrown or captured anywhere in this sequence.
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
  });

  it('MUTATION CHECK: if ensureOrtRuntime() ever regresses to returning the SAME buffer instance on both calls, the second worker receives an ALREADY-DETACHED buffer (the exact pre-fix bug)', async () => {
    const sharedBuffer = new Uint8Array([1, 2, 3]).buffer;
    // Deliberately the BUGGY shape: every call resolves the SAME instance,
    // reproducing what the memoised promise used to hand out before
    // ortRuntimeSource.ts's retain-and-copy fix.
    vi.mocked(ensureOrtRuntime).mockReturnValue(Promise.resolve({ backend: 'wasm', buffer: sharedBuffer }));

    const lease1 = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease1.whenReady().catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    const worker1 = createdWorkers[0]!;
    driveReady(worker1);

    // Worker1's real postMessage transfer detaches the shared buffer.
    structuredClone(sharedBuffer, { transfer: [sharedBuffer] });
    expect(sharedBuffer.byteLength).toBe(0);

    lease1.release();

    const lease2 = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease2.whenReady().catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    const worker2 = createdWorkers[1]!;
    const init2 = worker2.messages.find((m) => m.type === 'init')!;

    // This IS the bug this plan fixes: the second worker's init message
    // carries the SAME already-detached buffer. A real browser's
    // `postMessage` would throw `DataCloneError` at exactly this point.
    expect((init2.runtimeBuffer as ArrayBuffer).byteLength).toBe(0);
    expect(() => structuredClone(init2.runtimeBuffer, { transfer: [init2.runtimeBuffer as ArrayBuffer] })).toThrow();
  });

  // ─── G-213-37 (D-20): assetCacheName threaded through the init message ────
  //
  // `maiaWorkerHost` no longer duplicates the cache-name literal — it must
  // send `ENGINE_ASSET_CACHE_NAME` (imported for direct comparison, not
  // re-derived) on EVERY spawn, on both the 'auto' and the 'wasm' respawn
  // branch, so `maia-worker.js` reaches the SAME versioned cache by name.

  it("G-213-37: the init message carries assetCacheName on the normal ('auto') spawn branch", () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.whenReady().catch(() => {});

    const init = createdWorkers[0]!.messages.find((m) => m.type === 'init')!;
    expect(init.assetCacheName).toBe(ENGINE_ASSET_CACHE_NAME);
  });

  it("G-213-37: the init message carries assetCacheName on the wasm-pinned respawn branch too", () => {
    const lease = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease.analyze(TEST_FEN, [1500]).catch(() => {});
    const worker1 = createdWorkers[0]!;

    worker1.simulateMessage({ type: 'webgpu-unavailable', message: 'RangeError: Out of memory' });

    const replacement = createdWorkers[1]!;
    const init = replacement.messages.find((m) => m.type === 'init')!;
    expect(init.assetCacheName).toBe(ENGINE_ASSET_CACHE_NAME);
  });

  it('G-213-37: a second spawn after resetModuleState() teardown still delivers an init message the worker RECEIVES — asserted on the received message, not the absence of a throw', () => {
    // Mirrors G-213-36's own standard: G-213-36 was silent because
    // `new Worker()` succeeded and the failure happened inside a `.then()` —
    // asserting only "no error thrown" would not have caught it. The same
    // discipline applies to this plan's own new wiring: prove the SECOND
    // worker (post-teardown) actually received a well-formed init message.
    const lease1 = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease1.whenReady().catch(() => {});
    const worker1 = createdWorkers[0]!;
    driveReady(worker1);
    lease1.release(); // last lease released -> resetModuleState() teardown

    const lease2 = acquireMaiaWorker({ source: 'maia-worker', priority: true });
    void lease2.whenReady().catch(() => {});

    expect(createdWorkers).toHaveLength(2);
    const worker2 = createdWorkers[1]!;
    const init2 = worker2.messages.find((m) => m.type === 'init');
    expect(init2).toBeDefined();
    expect(init2).toMatchObject({ type: 'init', assetCacheName: ENGINE_ASSET_CACHE_NAME });
  });
});
