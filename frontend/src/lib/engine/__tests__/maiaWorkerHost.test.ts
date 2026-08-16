/**
 * maiaWorkerHost.ts unit tests (quick 260729-sod, FIX 3).
 *
 * Covers: one Worker shared across leases, refcount-to-zero termination +
 * re-spawn, single-in-flight serialisation, priority queue-jumping (without
 * preempting an in-flight request), worker-death settlement (queued +
 * in-flight rejected, onFatal fired for every lease), and the
 * webgpu-unavailable respawn moved here from Task 2's per-consumer suites.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Sentry from '@sentry/react';
import { acquireMaiaWorker, resetMaiaWorkerHostForTests, ENGINE_PATH } from '../maiaWorkerHost';

vi.mock('@sentry/react', () => ({ captureException: vi.fn(), addBreadcrumb: vi.fn() }));

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

  postMessage(msg: WorkerMessageLike): void {
    this.messages.push(msg);
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
  });

  afterEach(() => {
    resetMaiaWorkerHostForTests();
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
    expect(replacement.messages).toContainEqual({ type: 'init', backend: 'wasm' });

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
    expect(replacement.messages).toContainEqual({ type: 'init', backend: 'wasm' });

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
});
