// @vitest-environment jsdom
/**
 * maiaQueue.ts unit tests, driven via a mocked `maiaWorkerHost` lease
 * (quick 260729-sod, FIX 3 — this module no longer constructs a Worker
 * directly; it acquires a `priority: false` lease from the shared host).
 *
 * Task 1 covers the requestPolicy pipeline (POOL-03/D-04): dedup, batching,
 * the (fen,elo)-keyed cache, SAN->UCI entry-count parity (Pitfall 4), and the
 * no-drop async FIFO queue (Open Question 2).
 *
 * Task 2 covered worker lifecycle (lazy spawn, terminate) and graceful
 * degradation (POOL-04/D-02) — Sentry error forwarding + webgpu-unavailable
 * respawn are now entirely owned by `maiaWorkerHost.ts` (see
 * maiaWorkerHost.test.ts); this module's own remaining self-heal contract is
 * the `onFatal` callback settling every stranded pending request to `{}`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMaiaQueue, MAIA_CACHE_MAX, type MaiaQueue } from '../maiaQueue';
import { acquireMaiaWorker, ENGINE_PATH } from '../maiaWorkerHost';
import type { AcquireMaiaWorkerOptions, MaiaAnalyzeResult, MaiaWorkerLease } from '../maiaWorkerHost';
import type { EngineProviders } from '../types';
import { maskAndSoftmax, POLICY_VOCAB_SIZE } from '@/lib/maiaEncoding';

vi.mock('../maiaWorkerHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../maiaWorkerHost')>();
  return { ...actual, acquireMaiaWorker: vi.fn() };
});

// ─── Fake lease ────────────────────────────────────────────────────────────

interface FakeAnalyzeCall {
  fen: string;
  eloInputs: number[];
  resolve: (result: MaiaAnalyzeResult) => void;
  reject: (err: Error) => void;
}

class FakeLease implements MaiaWorkerLease {
  analyzeCalls: FakeAnalyzeCall[] = [];
  released = false;
  opts: AcquireMaiaWorkerOptions;
  private readyResolve: ((backend: 'webgpu' | 'wasm') => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  constructor(opts: AcquireMaiaWorkerOptions) {
    this.opts = opts;
  }

  analyze(fen: string, eloInputs: number[]): Promise<MaiaAnalyzeResult> {
    return new Promise<MaiaAnalyzeResult>((resolve, reject) => {
      this.analyzeCalls.push({ fen, eloInputs, resolve, reject });
    });
  }

  whenReady(): Promise<'webgpu' | 'wasm'> {
    return new Promise<'webgpu' | 'wasm'>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  getBackend(): 'webgpu' | 'wasm' | null {
    return null;
  }

  release(): void {
    this.released = true;
  }

  /** Resolves whenReady() and lets the queue's own microtask hop dispatch. */
  simulateReady(backend: 'webgpu' | 'wasm' = 'wasm'): void {
    this.readyResolve?.(backend);
  }

  simulateReadyRejected(err: Error): void {
    this.readyReject?.(err);
  }

  simulateFatal(): void {
    this.opts.onFatal?.();
  }
}

let createdLeases: FakeLease[];

function stubHost(): void {
  createdLeases = [];
  vi.mocked(acquireMaiaWorker).mockImplementation((opts: AcquireMaiaWorkerOptions) => {
    const lease = new FakeLease(opts);
    createdLeases.push(lease);
    return lease;
  });
}

/** Drives the head lease to ready and flushes the microtask that lets `processQueue` dispatch. */
async function driveReady(lease: FakeLease, backend: 'webgpu' | 'wasm' = 'wasm'): Promise<void> {
  lease.simulateReady(backend);
  await Promise.resolve();
}

function analyzeMessages(lease: FakeLease): { fen: string; eloInputs: number[] }[] {
  return lease.analyzeCalls.map((c) => ({ fen: c.fen, eloInputs: c.eloInputs }));
}

/** Builds a synthetic host analyze() result for the given FEN/ELOs (all-zero logits). */
function buildResultMessage(fen: string, elos: number[]): MaiaAnalyzeResult {
  const rawPolicyByElo = elos.map((elo) => ({ elo, policy: new Float32Array(POLICY_VOCAB_SIZE) }));
  const wdlByElo = elos.map((elo) => ({ elo, wdl: Float32Array.from([0, 0, 0]) }));
  return { fen, rawPolicyByElo, wdlByElo, backend: 'wasm' };
}

/** Resolves the latest still-unsettled analyze() call on `lease` with a synthetic result. */
async function resolveLatest(lease: FakeLease, fen: string, elos: number[]): Promise<void> {
  const call = lease.analyzeCalls[lease.analyzeCalls.length - 1];
  call?.resolve(buildResultMessage(fen, elos));
  await Promise.resolve();
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
    stubHost();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // ─── D-02: lazy spawn ──────────────────────────────────────────────────

  it('does not acquire a lease until the first policy() call', () => {
    createMaiaQueue();
    expect(createdLeases).toHaveLength(0);
  });

  it('acquires a priority:false lease with source maia-queue-worker on the first policy() call', () => {
    const queue = createMaiaQueue();
    void queue.policy(TEST_FEN, 1500, 'w');
    expect(createdLeases).toHaveLength(1);
    expect(acquireMaiaWorker).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'maia-queue-worker', priority: false }),
    );
  });

  it('ENGINE_PATH now lives on maiaWorkerHost (D-04 reversal)', () => {
    expect(ENGINE_PATH).toBe('/maia/maia-worker.js');
  });

  // ─── Prewarm (Phase 169.5, SC5) ────────────────────────────────────────

  it('warm() acquires the lease without enqueueing an analyze', () => {
    const queue = createMaiaQueue();
    queue.warm();

    expect(createdLeases).toHaveLength(1);
    expect(analyzeMessages(createdLeases[0]!)).toHaveLength(0);
  });

  it('warm() is idempotent', () => {
    const queue = createMaiaQueue();
    queue.warm();
    queue.warm();
    expect(createdLeases).toHaveLength(1);
  });

  // ─── D-04: dedup + narrow ELOs ─────────────────────────────────────────

  it('requests only the distinct ELOs needed, collapsing two same-ELO requests into one analyze call', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1500, 'w');
    const p2 = queue.policy(TEST_FEN, 1500, 'b');
    const lease = createdLeases[0]!;
    await driveReady(lease);
    await resolveLatest(lease, TEST_FEN, [1500]);
    await Promise.all([p1, p2]);

    const calls = analyzeMessages(lease);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.eloInputs).toEqual([1500]);
  });

  it('batches two DIFFERENT ELOs for the same FEN into one analyze call, deduped', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1200, 'w');
    const p2 = queue.policy(TEST_FEN, 1800, 'b');
    const lease = createdLeases[0]!;
    await driveReady(lease);
    await resolveLatest(lease, TEST_FEN, [1200, 1800]);
    await Promise.all([p1, p2]);

    const calls = analyzeMessages(lease);
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
    const lease = createdLeases[0]!;
    await driveReady(lease);
    await resolveLatest(lease, fen, [1500]);
    const uciPolicy = await promise;

    const sanPolicy = maskAndSoftmax(new Float32Array(POLICY_VOCAB_SIZE), fen);
    expect(Object.keys(uciPolicy)).toHaveLength(Object.keys(sanPolicy).length);
  });

  // ─── cache-hit ──────────────────────────────────────────────────────────

  it('resolves a repeated (fen, elo) request from cache with no second analyze call', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1500, 'w');
    const lease = createdLeases[0]!;
    await driveReady(lease);
    await resolveLatest(lease, TEST_FEN, [1500]);
    const result1 = await p1;

    const result2 = await queue.policy(TEST_FEN, 1500, 'w');
    expect(result2).toEqual(result1);
    expect(analyzeMessages(lease)).toHaveLength(1);
  });

  it('does not cache-hit across different ELOs for the same FEN (separate fen|elo keys)', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1500, 'w');
    const lease = createdLeases[0]!;
    await driveReady(lease);
    await resolveLatest(lease, TEST_FEN, [1500]);
    await p1;

    const p2 = queue.policy(TEST_FEN, 1600, 'w');
    await resolveLatest(lease, TEST_FEN, [1600]);
    await p2;

    expect(analyzeMessages(lease)).toHaveLength(2);
  });

  it('caps the cache at MAIA_CACHE_MAX entries (FIFO eviction)', async () => {
    const queue = createMaiaQueue();
    const lease = (): FakeLease => createdLeases[0]!;
    // Seed one more than the cap, each a distinct (fen, elo) key.
    for (let i = 0; i < MAIA_CACHE_MAX + 1; i++) {
      const fen = fenVariant(i);
      const p = queue.policy(fen, 1500, 'w');
      if (i === 0) await driveReady(lease());
      await resolveLatest(lease(), fen, [1500]);
      await p;
    }
    // The very first (fen=fenVariant(0), elo=1500) entry should have been
    // evicted — re-requesting it must issue a NEW analyze call, not resolve
    // from cache.
    const analyzeCountBefore = analyzeMessages(lease()).length;
    const pAgain = queue.policy(fenVariant(0), 1500, 'w');
    await resolveLatest(lease(), fenVariant(0), [1500]);
    await pAgain;
    expect(analyzeMessages(lease()).length).toBe(analyzeCountBefore + 1);
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
    const lease = createdLeases[0]!;
    await driveReady(lease);

    // One ONNX inference in flight at a time: each result triggers dispatch
    // of the next batch, so these are simulated in sequence.
    await resolveLatest(lease, fenA, [1000]);
    await resolveLatest(lease, fenB, [1200]);
    await resolveLatest(lease, fenC, [1400]);

    await expect(Promise.all([p1, p2, p3])).resolves.toBeDefined();
    expect(analyzeMessages(lease)).toHaveLength(3);
  });

  // ─── D-02: terminate + re-spawn ─────────────────────────────────────────

  it('terminate() releases the lease; a later policy() acquires a fresh one', async () => {
    const queue = createMaiaQueue();
    void queue.policy(TEST_FEN, 1500, 'w');
    const lease = createdLeases[0]!;
    await driveReady(lease);

    queue.terminate();
    expect(lease.released).toBe(true);

    void queue.policy(TEST_FEN, 1500, 'w');
    expect(createdLeases).toHaveLength(2);
  });

  it('terminate() resolves any still-pending request rather than hanging it', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1500, 'w'); // never gets a lease response
    queue.terminate();
    await expect(p1).resolves.toEqual({});
  });

  // ─── Worker death self-heal (onFatal) — Sentry capture itself now lives in maiaWorkerHost.test.ts ──

  it('onFatal (worker death) resolves every stranded pending() request to {}, and the SAME lease self-heals on the next policy()', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1500, 'w');
    const lease = createdLeases[0]!;
    // Deliberately do NOT driveReady() — a pre-ready init failure strands the
    // request in this queue's own `pending` backlog (never dispatched to the
    // lease at all).
    lease.simulateFatal();

    await expect(p1).resolves.toEqual({});

    // The host's own self-heal contract is "the SAME lease's next analyze()
    // re-spawns" (the lease persists — only the underlying Worker died) —
    // this queue does NOT acquire a second lease.
    const p2 = queue.policy(TEST_FEN, 1500, 'w');
    expect(createdLeases).toHaveLength(1);
    await driveReady(lease);
    await resolveLatest(lease, TEST_FEN, [1500]);
    await expect(p2).resolves.toBeDefined();
  });

  it('a lease rejection mid-batch (e.g. release() racing a fatal worker) resolves the whole batch to {}', async () => {
    const queue = createMaiaQueue();
    const p1 = queue.policy(TEST_FEN, 1500, 'w');
    const lease = createdLeases[0]!;
    await driveReady(lease);

    const call = lease.analyzeCalls[0]!;
    call.reject(new Error('lease released'));
    await Promise.resolve();

    await expect(p1).resolves.toEqual({});
  });

  // ─── Contract shape ─────────────────────────────────────────────────────

  it('policy is structurally assignable to EngineProviders.policy', () => {
    const queue: MaiaQueue = createMaiaQueue();
    const providerPolicy: EngineProviders['policy'] = queue.policy;
    expect(typeof providerPolicy).toBe('function');
  });
});
