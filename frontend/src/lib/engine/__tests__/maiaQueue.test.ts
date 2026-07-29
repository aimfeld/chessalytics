// @vitest-environment jsdom
/**
 * maiaQueue.ts mock-Worker unit tests.
 *
 * Task 1 covers the requestPolicy pipeline (POOL-03/D-04): dedup, batching,
 * the (fen,elo)-keyed cache, SAN->UCI entry-count parity (Pitfall 4), and the
 * no-drop async FIFO queue (Open Question 2).
 *
 * Task 2 covers worker lifecycle (lazy spawn, terminate), Sentry error
 * forwarding under a distinct tag, and graceful degradation (POOL-04/D-02).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Sentry from '@sentry/react';
import { createMaiaQueue, ENGINE_PATH, MAIA_CACHE_MAX, type MaiaQueue } from '../maiaQueue';
import type { EngineProviders } from '../types';
import { maskAndSoftmax, POLICY_VOCAB_SIZE } from '@/lib/maiaEncoding';

// @sentry/react's ESM module namespace is not configurable, so vi.spyOn cannot
// redefine captureException on the real module — mock the module instead.
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

  /** Fire the onmessage handler with a synthetic structured message. */
  simulateMessage(data: WorkerMessageLike): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** Fire the onerror handler — simulates an asynchronous Worker script-load failure (404/CSP/syntax error), which `new Worker(...)` never throws for synchronously. */
  simulateError(): void {
    this.onerror?.(new Event('error'));
  }
}

let createdWorkers: MockWorker[];

function stubWorkerCtor(): void {
  createdWorkers = [];
  vi.stubGlobal(
    'Worker',
    vi.fn(function (this: unknown) {
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

/** Builds a synthetic worker 'result' message for the given FEN/ELOs (all-zero logits). */
function buildResultMessage(fen: string, elos: number[]): WorkerMessageLike {
  const rawPolicyByElo = elos.map((elo) => ({ elo, policy: new Float32Array(POLICY_VOCAB_SIZE) }));
  const wdlByElo = elos.map((elo) => ({ elo, wdl: Float32Array.from([0, 0, 0]) }));
  return { type: 'result', fen, rawPolicyByElo, wdlByElo, backend: 'wasm' };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TEST_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

// Verified (chess.js) to expose exactly the move-type each label claims:
// PROMOTION_FEN has a promotion move, CASTLE_FEN has a castling move, EP_FEN
// has a legal en-passant capture (Pitfall 4 coverage — no silent sanToUci drop).
const PROMOTION_FEN = '6k1/4P3/8/8/8/8/8/4K3 w - - 0 1';
const CASTLE_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/5N2/PPPPBPPP/RNBQK2R w KQkq - 0 1';
const EN_PASSANT_FEN = 'rnbqkbnr/pp2pppp/8/2ppP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3';

/** A valid, distinct starting-position FEN (only the fullmove counter varies) — used wherever a test needs many distinct-but-parseable cache keys. */
function fenVariant(n: number): string {
  return `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 ${n + 1}`;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createMaiaQueue', () => {
  beforeEach(() => {
    stubWorkerCtor();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // ─── D-02: lazy spawn ──────────────────────────────────────────────────

  it('does not construct a Worker until the first policy() call', () => {
    createMaiaQueue();
    expect(createdWorkers).toHaveLength(0);
  });

  it('constructs the worker at ENGINE_PATH on the first policy() call', () => {
    const queue = createMaiaQueue();
    void queue.policy(TEST_FEN, 1500, 'w');
    expect(createdWorkers).toHaveLength(1);
    expect(vi.mocked(Worker)).toHaveBeenCalledWith(ENGINE_PATH);
  });

  // ─── Prewarm (Phase 169.5, SC5) ────────────────────────────────────────

  it("warm() constructs the worker and posts {type:'init'} without enqueueing an analyze", () => {
    const queue = createMaiaQueue();
    queue.warm();

    expect(createdWorkers).toHaveLength(1);
    expect(vi.mocked(Worker)).toHaveBeenCalledWith(ENGINE_PATH);
    const worker = createdWorkers[0]!;
    // The ONNX weight load begins...
    expect(worker.messages).toContainEqual({ type: 'init' });
    // ...but no policy request was made, so nothing is queued to analyze.
    expect(analyzeMessages(worker)).toHaveLength(0);
  });

  it('warm() is idempotent', () => {
    const queue = createMaiaQueue();
    queue.warm();
    queue.warm();
    expect(createdWorkers).toHaveLength(1);
  });

  // ─── D-04: dedup + narrow ELOs ─────────────────────────────────────────

  it('requests only the distinct ELOs needed, collapsing two same-ELO requests into one analyze call', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1500, 'w');
    const p2 = queue.policy(TEST_FEN, 1500, 'b');
    const worker = createdWorkers[0]!;
    driveReady(worker);
    worker.simulateMessage(buildResultMessage(TEST_FEN, [1500]));
    await Promise.all([p1, p2]);

    const calls = analyzeMessages(worker);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.eloInputs).toEqual([1500]);
  });

  it('batches two DIFFERENT ELOs for the same FEN into one analyze call, deduped', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1200, 'w');
    const p2 = queue.policy(TEST_FEN, 1800, 'b');
    const worker = createdWorkers[0]!;
    driveReady(worker);
    worker.simulateMessage(buildResultMessage(TEST_FEN, [1200, 1800]));
    await Promise.all([p1, p2]);

    const calls = analyzeMessages(worker);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.eloInputs).toEqual([1200, 1800]);
  });

  // ─── Pitfall 4: SAN->UCI entry-count parity, no silent drops ───────────

  it.each([
    ['promotion', PROMOTION_FEN],
    ['castling', CASTLE_FEN],
    ['en passant', EN_PASSANT_FEN],
  ])('has the same entry count as maskAndSoftmax for a %s position', async (_label, fen) => {
    const queue = createMaiaQueue();
    const promise = queue.policy(fen, 1500, 'w');
    const worker = createdWorkers[0]!;
    driveReady(worker);
    worker.simulateMessage(buildResultMessage(fen, [1500]));
    const uciPolicy = await promise;

    const sanPolicy = maskAndSoftmax(new Float32Array(POLICY_VOCAB_SIZE), fen);
    expect(Object.keys(uciPolicy)).toHaveLength(Object.keys(sanPolicy).length);
  });

  // ─── cache-hit ──────────────────────────────────────────────────────────

  it('resolves a repeated (fen, elo) request from cache with no second analyze call', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1500, 'w');
    const worker = createdWorkers[0]!;
    driveReady(worker);
    worker.simulateMessage(buildResultMessage(TEST_FEN, [1500]));
    const result1 = await p1;

    const result2 = await queue.policy(TEST_FEN, 1500, 'w');
    expect(result2).toEqual(result1);
    expect(analyzeMessages(worker)).toHaveLength(1);
  });

  it('does not cache-hit across different ELOs for the same FEN (separate fen|elo keys)', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1500, 'w');
    const worker = createdWorkers[0]!;
    driveReady(worker);
    worker.simulateMessage(buildResultMessage(TEST_FEN, [1500]));
    await p1;

    const p2 = queue.policy(TEST_FEN, 1600, 'w');
    worker.simulateMessage(buildResultMessage(TEST_FEN, [1600]));
    await p2;

    expect(analyzeMessages(worker)).toHaveLength(2);
  });

  it('caps the cache at MAIA_CACHE_MAX entries (FIFO eviction)', async () => {
    const queue = createMaiaQueue();
    const worker0 = (): MockWorker => createdWorkers[0]!;
    // Seed one more than the cap, each a distinct (fen, elo) key.
    for (let i = 0; i < MAIA_CACHE_MAX + 1; i++) {
      const fen = fenVariant(i);
      const p = queue.policy(fen, 1500, 'w');
      if (i === 0) driveReady(worker0());
      worker0().simulateMessage(buildResultMessage(fen, [1500]));
      await p;
    }
    // The very first (fen=fenVariant(0), elo=1500) entry should have been
    // evicted — re-requesting it must issue a NEW analyze call, not resolve
    // from cache.
    const analyzeCountBefore = analyzeMessages(worker0()).length;
    const pAgain = queue.policy(fenVariant(0), 1500, 'w');
    worker0().simulateMessage(buildResultMessage(fenVariant(0), [1500]));
    await pAgain;
    expect(analyzeMessages(worker0()).length).toBe(analyzeCountBefore + 1);
  });

  // ─── No-drop async FIFO (Open Question 2) ──────────────────────────────

  it('resolves every issued policy() promise, never dropping one under concurrent load', async () => {
    const queue = createMaiaQueue();
    const fenA = fenVariant(0);
    const fenB = fenVariant(1);
    const fenC = fenVariant(2);
    const p1 = queue.policy(fenA, 1000, 'w');
    const p2 = queue.policy(fenB, 1200, 'w');
    const p3 = queue.policy(fenC, 1400, 'w');
    const worker = createdWorkers[0]!;
    driveReady(worker);

    // One ONNX inference in flight at a time: each result triggers dispatch
    // of the next batch synchronously, so these can be simulated in sequence.
    worker.simulateMessage(buildResultMessage(fenA, [1000]));
    worker.simulateMessage(buildResultMessage(fenB, [1200]));
    worker.simulateMessage(buildResultMessage(fenC, [1400]));

    await expect(Promise.all([p1, p2, p3])).resolves.toBeDefined();
    expect(analyzeMessages(worker)).toHaveLength(3);
  });

  // ─── D-02: terminate + re-spawn ─────────────────────────────────────────

  it('terminate() posts {type:terminate} and calls worker.terminate(); a later policy() re-spawns', () => {
    const queue = createMaiaQueue();
    void queue.policy(TEST_FEN, 1500, 'w');
    const worker = createdWorkers[0]!;
    driveReady(worker);

    queue.terminate();
    expect(worker.messages.some((m) => m.type === 'terminate')).toBe(true);
    expect(worker.terminated).toBe(true);

    void queue.policy(TEST_FEN, 1500, 'w');
    expect(createdWorkers).toHaveLength(2);
  });

  it('terminate() resolves any still-pending or in-flight promise rather than hanging it', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1500, 'w'); // never gets a worker response
    queue.terminate();
    await expect(p1).resolves.toEqual({});
  });

  // ─── Sentry error forwarding ────────────────────────────────────────────

  it('drains pending and drops the dead worker on a PRE-READY error, so a later policy() re-spawns a fresh Worker (CR-03)', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1500, 'w');
    const worker = createdWorkers[0]!;
    // Deliberately do NOT driveReady() — this is a worker-init failure
    // (e.g. onnx session/model-load) arriving before the worker ever became
    // ready, so `currentBatch` is still null and the request is sitting in
    // `pending`.
    worker.simulateMessage({ type: 'error', message: 'onnx init failure' });

    await expect(p1).resolves.toEqual({});

    // The dead worker must be dropped so the next policy() call re-spawns a
    // fresh Worker rather than queuing forever behind the dead one.
    void queue.policy(TEST_FEN, 1500, 'w');
    expect(createdWorkers).toHaveLength(2);
  });

  it('forwards a worker error message to Sentry with the distinct maia-queue-worker tag and settles the in-flight promise', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1500, 'w');
    const worker = createdWorkers[0]!;
    driveReady(worker);
    worker.simulateMessage({ type: 'error', message: 'onnx runtime failure' });

    await expect(p1).resolves.toEqual({});
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ source: 'maia-queue-worker' }) }),
    );
  });

  it('forwards a Worker construction failure to Sentry and resolves pending requests instead of hanging', async () => {
    vi.stubGlobal(
      'Worker',
      vi.fn(function () {
        throw new Error('simulated construction failure');
      }),
    );
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1500, 'w');

    await expect(p1).resolves.toEqual({});
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ source: 'maia-queue-worker' }) }),
    );
  });

  it('captures an asynchronous worker.onerror (script-load failure) to Sentry, settles the pending promise, and re-spawns on the next policy() call (WR-03)', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1500, 'w');
    const worker = createdWorkers[0]!;
    // `new Worker(...)` never throws synchronously for a script-load
    // failure (404/CSP/syntax error) — it fires `onerror` asynchronously.
    // Deliberately no driveReady().
    worker.simulateError();

    await expect(p1).resolves.toEqual({});
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ source: 'maia-queue-worker' }) }),
    );

    void queue.policy(TEST_FEN, 1500, 'w');
    expect(createdWorkers).toHaveLength(2);
  });

  // ─── Respawn (quick 260729-sod, FIX 1) ──────────────────────────────────

  it('webgpu-unavailable terminates worker #1 and constructs exactly one wasm-pinned replacement', () => {
    const queue = createMaiaQueue();
    void queue.policy(TEST_FEN, 1500, 'w');
    const worker1 = createdWorkers[0]!;

    worker1.simulateMessage({ type: 'webgpu-unavailable', message: 'RangeError: Out of memory' });

    expect(worker1.terminated).toBe(true);
    expect(createdWorkers).toHaveLength(2);
    const replacement = createdWorkers[1]!;
    expect(replacement.messages).toContainEqual({ type: 'init', backend: 'wasm' });
  });

  it('a policy() queued before the fallback still resolves from the replacement worker (nothing stranded)', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1500, 'w');
    const worker1 = createdWorkers[0]!;

    worker1.simulateMessage({ type: 'webgpu-unavailable', message: 'boom' });

    const replacement = createdWorkers[1]!;
    driveReady(replacement);
    replacement.simulateMessage(buildResultMessage(TEST_FEN, [1500]));

    await expect(p1).resolves.toBeDefined();
  });

  it('a worker that reports ready directly (no adapter) constructs exactly one Worker', () => {
    const queue = createMaiaQueue();
    void queue.policy(TEST_FEN, 1500, 'w');
    driveReady(createdWorkers[0]!);
    expect(createdWorkers).toHaveLength(1);
  });

  // ─── Contract shape ─────────────────────────────────────────────────────

  it('policy is structurally assignable to EngineProviders.policy', () => {
    const queue: MaiaQueue = createMaiaQueue();
    const providerPolicy: EngineProviders['policy'] = queue.policy;
    expect(typeof providerPolicy).toBe('function');
  });
});
