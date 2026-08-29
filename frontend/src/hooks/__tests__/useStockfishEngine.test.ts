// @vitest-environment jsdom
/**
 * useStockfishEngine mock-Worker unit tests.
 *
 * Behaviors verified:
 * 1. Classic Worker instantiation (no { type: 'module' }).
 * 2. UCI init: uci → setoption MultiPV value 2 → isready → isReady false→true.
 * 3. Adaptive debounce: settled move fires immediately; rapid steps coalesce.
 * 4. Search command contains movetime 1500 and nodes 2000000.
 * 5. Stop-pending discard: stale bestmove is discarded; only final FEN result committed.
 * 6. lowerbound/upperbound info lines DO paint evalCp live (relaxed bound).
 * 7. Exact info line paints evalCp before bestmove; bestmove confirms + stops analysis.
 * 8. Visibility hidden → stop sent, worker NOT terminated.
 * 9. Unmount → stop + terminate.
 *
 * Phase 213-08 (G-213-35): the worker-lifecycle effect now constructs its
 * Worker asynchronously, via `ensureStockfishWorkerUrl().then(setupWorker)`
 * — this file mocks `stockfishWorkerSource` so the hook's own UCI/debounce
 * logic stays the thing under test (the shared-fetch mechanics are covered
 * by `stockfishWorkerSource.test.ts`), and every test that needs the mock
 * Worker to already exist awaits `flushWorkerSpawn()` once, right after the
 * initial render, before driving the UCI handshake.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Sentry from '@sentry/react';
import { useStockfishEngine } from '../useStockfishEngine';
import {
  getEngineAssetsSnapshot,
  resetEngineAssetsForTests,
} from '@/lib/engine/engineAssetProgress';

// @sentry/react's ESM module namespace is not configurable, so vi.spyOn cannot
// redefine captureException on the real module — mock the module instead
// (mirrors useFlawChessEngine.test.ts).
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

// Phase 213-08: the hook now routes construction through the shared source
// module. This file's job is the hook's own UCI/debounce/state-machine
// logic, not the shared-fetch mechanics (covered by
// `stockfishWorkerSource.test.ts`) — mock the module so
// `ensureStockfishWorkerUrl()` resolves to `null` (today's direct-
// construction path) on every call, and `createStockfishWorker` constructs
// against the exact same literal path the pre-refactor local `ENGINE_PATH`
// constant held.
const STOCKFISH_ENGINE_PATH = '/engine/stockfish-18-lite-single.js';
vi.mock('@/lib/engine/stockfishWorkerSource', () => ({
  ensureStockfishWorkerUrl: vi.fn(() => Promise.resolve(null)),
  createStockfishWorker: vi.fn((sharedUrl: string | null) => {
    const WorkerCtor = globalThis.Worker as unknown as new (url: string) => Worker;
    return sharedUrl === null
      ? new WorkerCtor(STOCKFISH_ENGINE_PATH)
      : new WorkerCtor(`${STOCKFISH_ENGINE_PATH}#${encodeURIComponent(sharedUrl)}`);
  }),
}));

// ─── Mock Worker ─────────────────────────────────────────────────────────────

/**
 * Phase 213: a minimal synchronous double for the `MessageChannel`/
 * `MessagePort` pair the worker-lifecycle effect uses to wire the vendored
 * Stockfish glue's `progressPort` protocol. Mirrors `workerPool.test.ts`'s
 * identical double — a real Node/jsdom `MessageChannel` delivers messages
 * asynchronously, which would force every progress-wiring test to await a
 * tick for no reason; this double fires synchronously instead, like
 * `MockWorker.simulateMessage` does for the UCI line protocol.
 */
class MockMessagePort {
  onmessage: ((e: MessageEvent<{ loaded: number; total: number }>) => void) | null = null;
  peer: MockMessagePort | null = null;

  postMessage(data: { loaded: number; total: number }): void {
    this.peer?.onmessage?.(new MessageEvent('message', { data }));
  }
}

function createMockMessageChannel(): { port1: MockMessagePort; port2: MockMessagePort } {
  const port1 = new MockMessagePort();
  const port2 = new MockMessagePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

/** Stubs the global `MessageChannel` constructor with the synchronous double above. */
function stubMessageChannel(): void {
  vi.stubGlobal(
    'MessageChannel',
    vi.fn(function (this: unknown) {
      return createMockMessageChannel();
    }),
  );
}

class MockWorker {
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  messages: string[] = [];
  /**
   * Phase 213: every `postMessage` call in arrival order, including
   * non-string payloads (the `{ progressPort }` handoff) — `messages` above
   * stays string-only so every pre-existing assertion keeps working
   * untouched. Use this array for ordering assertions the string-only log
   * cannot express.
   */
  allMessages: unknown[] = [];
  terminated = false;

  postMessage(msg: string | { progressPort: MockMessagePort }): void {
    this.allMessages.push(msg);
    if (typeof msg === 'string') {
      this.messages.push(msg);
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Fire the onmessage handler with a synthetic UCI line. */
  simulateMessage(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** Fire the onerror handler (async script-load failure — never a sync throw). */
  simulateError(): void {
    this.onerror?.(new ErrorEvent('error', { message: 'simulated worker load failure' }));
  }

  /** The `MockMessagePort` (port2) this worker was handed at spawn, or undefined if `MessageChannel` was unstubbed/unavailable. */
  capturedProgressPort(): MockMessagePort | undefined {
    const found = this.allMessages.find(
      (m): m is { progressPort: MockMessagePort } =>
        typeof m === 'object' && m !== null && 'progressPort' in m,
    );
    return found?.progressPort;
  }
}

let mockWorker: MockWorker;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Drive the mock engine through the full UCI init sequence (uciok → readyok). */
function driveInit(worker: MockWorker): void {
  act(() => {
    worker.simulateMessage('uciok');
  });
  act(() => {
    worker.simulateMessage('readyok');
  });
}

/**
 * Phase 213-08: flushes the microtask the worker-lifecycle effect's deferred
 * `ensureStockfishWorkerUrl().then(setupWorker)` continuation needs to run
 * and construct the mock Worker. Every test that reads `mockWorker` (or
 * asserts on the Worker constructor) after the INITIAL render must await
 * this once — a FEN-only `rerender` does not re-run the worker effect
 * (deps are `[enabled, clearPendingPvCommit]`), so no further flush is
 * needed after that.
 */
async function flushWorkerSpawn(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const TEST_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const TEST_FEN_2 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1';
const TEST_FEN_3 = 'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq c3 0 1';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('useStockfishEngine', () => {
  beforeEach(() => {
    // Initialize the fake clock at epoch 0 so Date.now() is deterministic.
    // This ensures sinceLast = Date.now() - lastFenChangeAtRef.current is predictable:
    // first FEN at t=0 gives sinceLast=0 (debounce path), and the "settled move"
    // test explicitly advances past 150ms before rendering to trigger the immediate path.
    vi.useFakeTimers({ now: 0 });
    mockWorker = new MockWorker();
    // Use a regular function (not arrow) so `new Worker(url)` works.
    // A constructor that returns a plain object has that object override `this`.
    vi.stubGlobal('Worker', vi.fn(function () { return mockWorker; }));
    // Phase 213: deterministic synchronous double for the progressPort wiring.
    stubMessageChannel();
    resetEngineAssetsForTests();
    // Test hygiene fix (quick 260731-s0z): the 'visibility hidden...' test
    // below redefines document.visibilityState via Object.defineProperty,
    // which leaks across tests in this file (jsdom's document is not
    // recreated per-test) — reset it here so later tests are not silently
    // affected by whichever test ran before them.
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetEngineAssetsForTests();
    vi.clearAllMocks();
  });

  it('creates a classic Worker — no module option', async () => {
    renderHook(() => useStockfishEngine({ fen: null, enabled: true }));
    await flushWorkerSpawn();
    // The Worker constructor must be called with only the engine path.
    // A second argument ({ type: 'module' }) would break the Emscripten glue.
    const WorkerCtor = vi.mocked(globalThis.Worker as new (url: string) => Worker);
    expect(WorkerCtor).toHaveBeenCalledWith('/engine/stockfish-18-lite-single.js');
    expect(WorkerCtor).toHaveBeenCalledTimes(1);
  });

  it('sends uci as the first command on mount', async () => {
    renderHook(() => useStockfishEngine({ fen: null, enabled: true }));
    await flushWorkerSpawn();
    expect(mockWorker.messages[0]).toBe('uci');
  });

  it('setoption MultiPV uses value 2', async () => {
    renderHook(() => useStockfishEngine({ fen: null, enabled: true }));
    await flushWorkerSpawn();
    act(() => {
      mockWorker.simulateMessage('uciok');
    });
    expect(mockWorker.messages).toContain('setoption name MultiPV value 2');
  });

  it('sends isready after setoption and transitions isReady false→true on readyok', async () => {
    const { result } = renderHook(() =>
      useStockfishEngine({ fen: null, enabled: true }),
    );
    expect(result.current.isReady).toBe(false);
    await flushWorkerSpawn();

    act(() => {
      mockWorker.simulateMessage('uciok');
    });
    expect(mockWorker.messages).toContain('isready');

    act(() => {
      mockWorker.simulateMessage('readyok');
    });
    expect(result.current.isReady).toBe(true);
  });

  it('settled first move fires the search near-instantly (no fixed delay)', async () => {
    // Advance fake time past RAPID_STEP_DEBOUNCE_MS (150ms) so Date.now() >> 0.
    // lastFenChangeAtRef is initialized to 0, so sinceLast = 200 - 0 = 200 > 150,
    // which triggers the immediate (non-debounced) path.
    vi.advanceTimersByTime(200);

    renderHook(() => useStockfishEngine({ fen: TEST_FEN, enabled: true }));
    await flushWorkerSpawn();
    driveInit(mockWorker);

    // debouncedFen was set synchronously during mount, and the debouncedFen+isReady
    // effect fired when readyok set isReady=true — so go was sent during driveInit.
    expect(mockWorker.messages.some((m) => m.startsWith('go '))).toBe(true);
  });

  it('rapid successive FEN changes coalesce — only the final FEN is searched', async () => {
    // Start at fake time 0: first FEN change gives sinceLast = 0 < 150 → debounce path.
    const { rerender } = renderHook(
      ({ fen }: { fen: string }) => useStockfishEngine({ fen, enabled: true }),
      { initialProps: { fen: TEST_FEN } },
    );
    await flushWorkerSpawn();
    driveInit(mockWorker);

    // Advance to 140ms — just before the TEST_FEN debounce fires at 150ms.
    // This ensures React effects are flushed in their own act before we rerender.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(140);
    });

    // Rerender within the debounce window (140ms < 150ms since TEST_FEN).
    // The FEN-effect cleanup cancels the TEST_FEN timer synchronously.
    rerender({ fen: TEST_FEN_2 });

    // Advance 200ms more — TEST_FEN_2 debounce fires at 140+150=290ms.
    // The original TEST_FEN timer (at 150ms) was cancelled; only TEST_FEN_2 fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // Only one go command should have been sent, for the final FEN.
    const goCommands = mockWorker.messages.filter((m) => m.startsWith('go '));
    expect(goCommands).toHaveLength(1);
    expect(mockWorker.messages).toContain(`position fen ${TEST_FEN_2}`);
    expect(mockWorker.messages).not.toContain(`position fen ${TEST_FEN}`);
  });

  it('sends position + go after the debounce delay (rapid-succession path)', async () => {
    const { result } = renderHook(() =>
      useStockfishEngine({ fen: TEST_FEN, enabled: true }),
    );
    await flushWorkerSpawn();
    driveInit(mockWorker);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200); // past 150 ms debounce
    });

    expect(mockWorker.messages).toContain(`position fen ${TEST_FEN}`);
    expect(mockWorker.messages.some((m) => m.startsWith('go '))).toBe(true);
    expect(result.current.isAnalyzing).toBe(true);
  });

  it('search command contains movetime 1500 and nodes 2000000', async () => {
    renderHook(() => useStockfishEngine({ fen: TEST_FEN, enabled: true }));
    await flushWorkerSpawn();
    driveInit(mockWorker);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    const goCmd = mockWorker.messages.find((m) => m.startsWith('go '));
    expect(goCmd).toBeDefined();
    expect(goCmd).toContain('movetime 1500');
    expect(goCmd).toContain('nodes 2000000');
  });

  it('lowerbound info line paints evalCp live (relaxed bound, lichess-style)', async () => {
    const { result } = renderHook(() =>
      useStockfishEngine({ fen: TEST_FEN, enabled: true }),
    );
    await flushWorkerSpawn();
    driveInit(mockWorker);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    act(() => {
      mockWorker.simulateMessage(
        'info depth 12 multipv 1 score cp 45 lowerbound nodes 12000 pv e2e4 e7e5',
      );
    });

    // Lowerbound info lines now paint immediately (relaxed bound for live first-paint).
    // TEST_FEN is black-to-move: UCI +45 (mover POV) → white-POV = -45.
    expect(result.current.evalCp).toBe(-45);
  });

  it('upperbound info line paints evalCp live (relaxed bound, lichess-style)', async () => {
    const { result } = renderHook(() =>
      useStockfishEngine({ fen: TEST_FEN, enabled: true }),
    );
    await flushWorkerSpawn();
    driveInit(mockWorker);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    act(() => {
      mockWorker.simulateMessage(
        'info depth 12 multipv 1 score cp 60 upperbound nodes 14000 pv d2d4 d7d5',
      );
    });

    // Upperbound info lines now paint immediately (relaxed bound for live first-paint).
    // TEST_FEN is black-to-move: UCI +60 (mover POV) → white-POV = -60.
    expect(result.current.evalCp).toBe(-60);
  });

  it('exact info line already paints evalCp; bestmove confirms and stops analysis', async () => {
    const { result } = renderHook(() =>
      useStockfishEngine({ fen: TEST_FEN, enabled: true }),
    );
    await flushWorkerSpawn();
    driveInit(mockWorker);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // Info line arrives during search — should paint evalCp immediately.
    act(() => {
      mockWorker.simulateMessage(
        'info depth 14 multipv 1 score cp 52 nodes 30000 pv e2e4 e7e5 g1f3',
      );
    });

    // TEST_FEN is black-to-move, so UCI's +52 (mover POV) is normalized to
    // white-POV = -52. This is set BEFORE the bestmove (live painting).
    expect(result.current.evalCp).toBe(-52);
    expect(result.current.isAnalyzing).toBe(true); // still analyzing

    // Bestmove confirms the final result and stops analysis.
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4 ponder e7e5');
    });

    expect(result.current.evalCp).toBe(-52);
    expect(result.current.isAnalyzing).toBe(false);
  });

  it('stop-pending bestmove is discarded — rapid FEN changes show only final result', async () => {
    const { rerender, result } = renderHook(
      ({ fen }: { fen: string }) =>
        useStockfishEngine({ fen, enabled: true }),
      { initialProps: { fen: TEST_FEN } },
    );

    await flushWorkerSpawn();
    driveInit(mockWorker);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // Engine is analyzing TEST_FEN
    expect(result.current.isAnalyzing).toBe(true);

    // Receive an info line for TEST_FEN — committed immediately via live painting.
    act(() => {
      mockWorker.simulateMessage(
        'info depth 14 multipv 1 score cp 52 nodes 30000 pv e2e4 e7e5',
      );
    });

    // Change FEN while thinking — adaptive debounce fires immediately (fake time 200
    // vs. lastFenChangeAtRef 0 → sinceLast=200 > 150), so stop is sent synchronously
    // during the rerender. The FEN effect also clears pvLines/evalCp.
    rerender({ fen: TEST_FEN_2 });

    await act(async () => {
      // No pending debounce timer (immediate fire path); advance is a no-op here.
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(mockWorker.messages).toContain('stop');

    // Stale bestmove arrives (from TEST_FEN search) — must be DISCARDED
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4 ponder e7e5');
    });

    // pvLines must remain empty — TEST_FEN result was cleared by the FEN effect
    // and the stale bestmove was discarded without committing.
    expect(result.current.pvLines).toHaveLength(0);
    // evalCp must still be null (cleared by FEN effect; stale result not committed)
    expect(result.current.evalCp).toBeNull();
  });

  it('FEN change during the stopping state does not send a second go (FLAWCHESS-7V)', async () => {
    // Regression: while a stop is in flight (state === 'stopping') and we are awaiting
    // the terminating bestmove, a further FEN change must NOT send position+go — doing
    // so races the in-flight stop and traps the Stockfish WASM engine ("unreachable").
    // The pending bestmove handler re-analyzes the LATEST FEN once it arrives.
    const { rerender } = renderHook(
      ({ fen }: { fen: string }) => useStockfishEngine({ fen, enabled: true }),
      { initialProps: { fen: TEST_FEN } },
    );

    await flushWorkerSpawn();
    driveInit(mockWorker);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // Engine is analyzing TEST_FEN (state === 'thinking'); exactly one go was sent.
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(1);

    // Change FEN while thinking → stop is sent (state → 'stopping'); no new position/go.
    rerender({ fen: TEST_FEN_2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mockWorker.messages).toContain('stop');

    // Change FEN AGAIN while still stopping (no bestmove yet). With the bug this fell
    // through to position+go; the fix returns early.
    rerender({ fen: TEST_FEN_3 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mockWorker.messages).not.toContain(`position fen ${TEST_FEN_3}`);
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(1);

    // The terminating bestmove (from the TEST_FEN search) arrives → re-analyze the
    // latest FEN (TEST_FEN_3), skipping the intermediate TEST_FEN_2.
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4 ponder e7e5');
    });
    expect(mockWorker.messages).toContain(`position fen ${TEST_FEN_3}`);
    expect(mockWorker.messages).not.toContain(`position fen ${TEST_FEN_2}`);
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(2);
  });

  it('visibility hidden sends stop without terminating the Worker', async () => {
    renderHook(() => useStockfishEngine({ fen: TEST_FEN, enabled: true }));
    await flushWorkerSpawn();
    driveInit(mockWorker);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // Engine is now analyzing (stateRef === 'thinking')
    const stopsBefore = mockWorker.messages.filter((m) => m === 'stop').length;

    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
        writable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const stopsAfter = mockWorker.messages.filter((m) => m === 'stop').length;
    expect(stopsAfter).toBeGreaterThan(stopsBefore);
    expect(mockWorker.terminated).toBe(false);
  });

  it('unmount sends stop and terminates the Worker (no leak)', async () => {
    const { unmount } = renderHook(() =>
      useStockfishEngine({ fen: null, enabled: true }),
    );
    await flushWorkerSpawn();

    unmount();

    expect(mockWorker.messages).toContain('stop');
    expect(mockWorker.terminated).toBe(true);
  });

  // ─── Phase 213-08 (G-213-35): unmount racing the deferred worker spawn ────

  it('Phase 213-08: unmounting before the shared fetch resolves constructs no worker and leaves nothing behind', async () => {
    const { unmount } = renderHook(() =>
      useStockfishEngine({ fen: null, enabled: true }),
    );

    // Unmount SYNCHRONOUSLY, before the deferred `ensureStockfishWorkerUrl()
    // .then(setupWorker)` continuation has had a chance to run — this sets
    // `cancelled = true` in the same tick, before any microtask fires.
    unmount();

    // Now let the deferred continuation actually run.
    await flushWorkerSpawn();

    // `setupWorker`'s `if (cancelled) return;` guard must have prevented
    // construction entirely — no live worker was created, let alone leaked.
    const WorkerCtor = vi.mocked(globalThis.Worker as new (url: string) => Worker);
    expect(WorkerCtor).not.toHaveBeenCalled();
    expect(mockWorker.terminated).toBe(false); // never constructed, nothing to terminate
  });

  // ─── FIX-5 (quick 260731-s0z): stop the superseded search on a RAPID FEN change ──

  it('FIX-5: stops the superseded search immediately on a RAPID FEN change, discarding its info lines and bestmove', async () => {
    vi.advanceTimersByTime(200); // settled path: first FEN fires the search immediately
    const { rerender, result } = renderHook(
      ({ fen }: { fen: string }) => useStockfishEngine({ fen, enabled: true }),
      { initialProps: { fen: TEST_FEN } },
    );
    await flushWorkerSpawn();
    driveInit(mockWorker);
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(1);

    act(() => {
      mockWorker.simulateMessage(
        'info depth 14 multipv 1 score cp 52 nodes 30000 pv e2e4 e7e5',
      );
    });
    expect(result.current.evalCp).toBe(-52);

    // RAPID FEN change — no time advance since the initial settle, so
    // sinceLast is 0 (< RAPID_STEP_DEBOUNCE_MS). Before FIX-5, nothing
    // stopped the old search on this path.
    rerender({ fen: TEST_FEN_2 });
    expect(mockWorker.messages).toContain('stop');

    // The OLD search's info line must not commit — currentFen already
    // points at TEST_FEN_2.
    act(() => {
      mockWorker.simulateMessage(
        'info depth 15 multipv 1 score cp 60 nodes 40000 pv e2e4 e7e5',
      );
    });
    expect(result.current.pvLines).toHaveLength(0);
    expect(result.current.evalCp).toBeNull();
    expect(result.current.currentFen).toBe(TEST_FEN_2);

    // The OLD search's terminating bestmove is discarded (not committed),
    // and the discard handler re-analyzes the current (new) position
    // exactly once — one position/go pair for TEST_FEN_2, two go commands
    // total (the original TEST_FEN search + this re-analysis).
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4 ponder e7e5');
    });
    expect(result.current.pvLines).toHaveLength(0);
    expect(
      mockWorker.messages.filter((m) => m === `position fen ${TEST_FEN_2}`).length,
    ).toBe(1);
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(2);
  });

  // ─── FIX-6 (quick 260731-s0z): throttle pvLines commits during a search ────

  it('FIX-6: commits at most one pvLines snapshot per throttle window, first paint immediate, final bestmove unconditional', async () => {
    const { result } = renderHook(() =>
      useStockfishEngine({ fen: TEST_FEN, enabled: true }),
    );
    await flushWorkerSpawn();
    driveInit(mockWorker);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // First info line — commits immediately (the throttle's "last commit"
    // timestamp starts at 0, so the very first commit is always immediate).
    act(() => {
      mockWorker.simulateMessage(
        'info depth 10 multipv 1 score cp 10 nodes 1000 pv e2e4 e7e5',
      );
    });
    expect(result.current.evalCp).toBe(-10);

    // Second info line inside the throttle window — must NOT commit yet.
    act(() => {
      mockWorker.simulateMessage(
        'info depth 11 multipv 1 score cp 20 nodes 2000 pv e2e4 e7e5',
      );
    });
    expect(result.current.evalCp).toBe(-10);

    // Advance past the throttle window (150ms, same value as
    // RAPID_STEP_DEBOUNCE_MS but a distinct mechanism) — the trailing commit
    // fires with the LATEST (second) value, not the first.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(result.current.evalCp).toBe(-20);

    // Third info line schedules a new trailing commit (pending)...
    act(() => {
      mockWorker.simulateMessage(
        'info depth 12 multipv 1 score cp 30 nodes 3000 pv e2e4 e7e5',
      );
    });
    expect(result.current.evalCp).toBe(-20); // still pending, no timer advanced

    // ...followed immediately by bestmove: an unconditional flush, visible
    // with NO timer advance.
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4 ponder e7e5');
    });
    expect(result.current.evalCp).toBe(-30);
    expect(result.current.isAnalyzing).toBe(false);
  });

  // ─── Phase 213 D-01: standalone worker reports progress + marks ready ─────

  describe('D-01: reports download progress and marks stockfish-wasm ready', () => {
    it('wires a progressPort before the uci handshake, and reporting progress through it updates the shared asset store', async () => {
      renderHook(() => useStockfishEngine({ fen: null, enabled: true }));
      await flushWorkerSpawn();

      // Handshake ordering: progressPort wiring happens before 'uci' is sent.
      expect(mockWorker.allMessages[mockWorker.allMessages.length - 1]).toBe('uci');
      const port = mockWorker.capturedProgressPort();
      expect(port).toBeDefined();

      act(() => {
        port?.postMessage({ loaded: 50, total: 100 });
      });

      const snapshot = getEngineAssetsSnapshot();
      expect(snapshot.assets['stockfish-wasm']?.loaded).toBe(50);
      expect(snapshot.assets['stockfish-wasm']?.total).toBe(100);
    });

    it('marks stockfish-wasm ready on the readyok line', async () => {
      renderHook(() => useStockfishEngine({ fen: null, enabled: true }));
      await flushWorkerSpawn();
      driveInit(mockWorker);

      const snapshot = getEngineAssetsSnapshot();
      expect(snapshot.assets['stockfish-wasm']?.done).toBe(true);
    });

    it('a MessageChannel-less environment skips the wiring without breaking engine spawn', async () => {
      vi.stubGlobal('MessageChannel', undefined);

      const { result } = renderHook(() => useStockfishEngine({ fen: null, enabled: true }));
      await flushWorkerSpawn();
      // No progressPort message was sent — 'uci' is the only message.
      expect(mockWorker.allMessages).toEqual(['uci']);

      driveInit(mockWorker);
      expect(result.current.isReady).toBe(true);
    });
  });

  // ─── CR-01 (213-REVIEW.md): worker.onerror must not be invisible ──────────
  //
  // Before this fix, this hook installed NO worker.onerror handler at all
  // (contrast with workerPool.ts's createSlot(), which does) — a 404/CSP-
  // blocked engine script failed completely silently: no Sentry capture,
  // isReady never became true, and the shared 'stockfish-wasm' asset store
  // never learned about the failure either.
  describe('CR-01: worker.onerror is Sentry-captured and marks stockfish-wasm failed', () => {
    it('captures to Sentry with the stockfish-engine source tag on an async script-load failure', async () => {
      renderHook(() => useStockfishEngine({ fen: null, enabled: true }));
      await flushWorkerSpawn();

      mockWorker.simulateError();

      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: expect.objectContaining({ source: 'stockfish-engine' }) }),
      );
    });

    it('marks the shared stockfish-wasm asset store failed', async () => {
      renderHook(() => useStockfishEngine({ fen: null, enabled: true }));
      await flushWorkerSpawn();

      mockWorker.simulateError();

      expect(getEngineAssetsSnapshot().status).toBe('failed');
    });

    it('never fires for a clean uciok/readyok init sequence', async () => {
      renderHook(() => useStockfishEngine({ fen: null, enabled: true }));
      await flushWorkerSpawn();
      driveInit(mockWorker);

      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(getEngineAssetsSnapshot().status).not.toBe('failed');
    });
  });
});
