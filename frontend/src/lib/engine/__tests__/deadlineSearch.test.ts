/**
 * deadlineSearch.ts unit tests (Phase 169 Plan 08 gap closure, D-16/D-17/D-18).
 *
 * Drives a fully controllable stub `SearchRunner` (fake timers, synthetic
 * `EngineSnapshot`s with controllable `nodesEvaluated`) that mirrors
 * mctsSearch's real abort-as-graceful-stop contract — one "node" per tick,
 * `onSnapshot` fired each tick, and an immediate resolve-with-latest-snapshot
 * on abort (never a throw) — so no real providers or search core are
 * exercised. Mirrors the fixture style of mctsSearch.test.ts and
 * selectBotMove.test.ts (fabricated providers/deps, no real engine calls).
 *
 * Covers:
 * - Test 1 (D-16 deadline cut): a base search that would run far past the
 *   deadline is stopped once the deadline elapses; the wrapper resolves with
 *   the base search's best-so-far snapshot, not a throw and not empty.
 * - Test 2 (D-18 node floor): a deadline that elapses BEFORE the floor is
 *   reached does not cut immediately — the cut is armed and only fires once
 *   the floor is crossed.
 * - Test 3 (D-17 cancel propagates immediately): an OUTER abort cuts the
 *   search at once, unconditionally, never delayed by the node floor.
 * - Test 4 (fast path): a base search that finishes before the deadline is
 *   unaffected, and the deadline timer is cleared (no leak).
 * - Test 5 (snapshot pass-through): every onSnapshot the base search emits
 *   is forwarded to the caller unchanged.
 * - Bonus: an outer signal already aborted at call time is handled too.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDeadlineSearch } from '../deadlineSearch';
import type { SearchRunner } from '../guardrail';
import type { EngineProviders, EngineSnapshot, SearchBudget } from '../types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const STUB_FEN = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
const STUB_PROVIDERS = {} as EngineProviders;
const STUB_BUDGET: SearchBudget = {
  maxNodes: 1000,
  elo: { w: 1500, b: 1500 },
  maxPlies: 6,
  concurrency: 4,
};

const STUB_TICK_INTERVAL_MS = 100;

function makeSnapshot(nodesEvaluated: number, budgetExhausted: boolean): EngineSnapshot {
  return {
    rankedLines: [],
    nodesEvaluated,
    budgetExhausted,
    stopReason: budgetExhausted ? 'budget' : null,
  };
}

interface StubSearchConfig {
  totalNodes: number;
  tickIntervalMs?: number;
}

/**
 * A controllable stub `SearchRunner` mirroring mctsSearch's real
 * abort-as-graceful-stop contract (mctsSearch.ts:456->535): it "expands" one
 * node per tick (emitting onSnapshot each time) and resolves with the LATEST
 * snapshot the instant its signal aborts — never a throw. Resolves naturally
 * with `budgetExhausted: true` once `totalNodes` is reached.
 */
function createStubBaseSearch(config: StubSearchConfig): SearchRunner {
  const { totalNodes, tickIntervalMs = STUB_TICK_INTERVAL_MS } = config;

  return (_rootFen, _budget, _providers, onSnapshot, signal) =>
    new Promise<EngineSnapshot>((resolve) => {
      let nodesEvaluated = 0;
      let latestSnapshot = makeSnapshot(0, false);
      let timerId: ReturnType<typeof setTimeout> | undefined;

      const finish = (snapshot: EngineSnapshot): void => {
        if (timerId !== undefined) clearTimeout(timerId);
        resolve(snapshot);
      };

      // Mirrors mctsSearch's real loop-condition check
      // (`while (... && !signal.aborted ...)`, mctsSearch.ts:456): an
      // already-aborted signal at entry resolves synchronously with no
      // ticks at all — an 'abort' listener added AFTER the event already
      // fired would never see it.
      if (signal.aborted) {
        finish(latestSnapshot);
        return;
      }

      signal.addEventListener('abort', () => finish(latestSnapshot), { once: true });

      const tick = (): void => {
        if (signal.aborted) return; // the abort listener already resolved
        if (nodesEvaluated >= totalNodes) {
          finish(makeSnapshot(nodesEvaluated, true));
          return;
        }
        nodesEvaluated += 1;
        latestSnapshot = makeSnapshot(nodesEvaluated, false);
        onSnapshot(latestSnapshot);
        timerId = setTimeout(tick, tickIntervalMs);
      };

      timerId = setTimeout(tick, tickIntervalMs);
    });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createDeadlineSearch', () => {
  it('cuts the search at the deadline and resolves with the best-so-far snapshot, not a throw (D-16)', async () => {
    const baseSearch = createStubBaseSearch({ totalNodes: 1000 });
    const wrapped = createDeadlineSearch({ deadlineMs: 350, minNodes: 0, baseSearch });

    const resultPromise = wrapped(
      STUB_FEN,
      STUB_BUDGET,
      STUB_PROVIDERS,
      () => {},
      new AbortController().signal,
    );

    await vi.advanceTimersByTimeAsync(400);
    const snapshot = await resultPromise;

    expect(snapshot.nodesEvaluated).toBeGreaterThan(0);
    expect(snapshot.nodesEvaluated).toBeLessThan(1000);
    expect(snapshot.budgetExhausted).toBe(false);
  });

  it('Phase 194 ABORT-02: a deadline cut aborts only the INNER controller — the caller\'s OUTER signal stays unaborted (D-17)', async () => {
    const baseSearch = createStubBaseSearch({ totalNodes: 1000 });
    const wrapped = createDeadlineSearch({ deadlineMs: 350, minNodes: 0, baseSearch });
    const outerController = new AbortController();

    const resultPromise = wrapped(
      STUB_FEN,
      STUB_BUDGET,
      STUB_PROVIDERS,
      () => {},
      outerController.signal,
    );

    await vi.advanceTimersByTimeAsync(400);
    const snapshot = await resultPromise;

    // The cut fired (proven by Test 1's sibling assertions) via the wrapper's
    // OWN inner controller — never the caller's. `useBotGame`'s outer
    // `signal.aborted` check keeps meaning exactly "a cancel", never "a
    // deadline cut", so it must read false here.
    expect(snapshot.nodesEvaluated).toBeGreaterThan(0);
    expect(outerController.signal.aborted).toBe(false);
  });

  it('does not cut below the D-18 node floor even though the deadline already elapsed', async () => {
    const FLOOR = 3;
    const baseSearch = createStubBaseSearch({ totalNodes: 1000 });
    const wrapped = createDeadlineSearch({ deadlineMs: 50, minNodes: FLOOR, baseSearch });

    let settled = false;
    const resultPromise = wrapped(
      STUB_FEN,
      STUB_BUDGET,
      STUB_PROVIDERS,
      () => {},
      new AbortController().signal,
    ).then((snapshot) => {
      settled = true;
      return snapshot;
    });

    // The deadline fires at t=50, well before the first tick at t=100 — zero
    // nodes evaluated, far below the floor. The cut must be armed, not fired.
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);

    // Ticks at t=100 (1 node), t=200 (2 nodes), t=300 (3 nodes) — the floor
    // is crossed exactly at the third tick, which is where the armed cut
    // must finally fire.
    await vi.advanceTimersByTimeAsync(250);
    expect(settled).toBe(true);

    const snapshot = await resultPromise;
    expect(snapshot.nodesEvaluated).toBe(FLOOR);
  });

  it('propagates an outer cancel immediately, never delayed by the node floor (D-17)', async () => {
    const UNREACHABLE_FLOOR = 500;
    const baseSearch = createStubBaseSearch({ totalNodes: 1000 });
    const outerController = new AbortController();
    const wrapped = createDeadlineSearch({
      deadlineMs: 100_000,
      minNodes: UNREACHABLE_FLOOR,
      baseSearch,
    });

    let settled = false;
    const resultPromise = wrapped(
      STUB_FEN,
      STUB_BUDGET,
      STUB_PROVIDERS,
      () => {},
      outerController.signal,
    ).then((snapshot) => {
      settled = true;
      return snapshot;
    });

    // Two ticks have run (2 nodes) — nowhere near the unreachable floor, and
    // the deadline (100s) is nowhere close to firing either.
    await vi.advanceTimersByTimeAsync(250);
    expect(settled).toBe(false);

    outerController.abort();
    await vi.advanceTimersByTimeAsync(0); // flush the synchronous abort-event microtask chain
    expect(settled).toBe(true);

    const snapshot = await resultPromise;
    expect(snapshot.nodesEvaluated).toBe(2);
  });

  it('leaves a search that finishes before the deadline unaffected and clears its timer (fast path)', async () => {
    const TOTAL_NODES = 2;
    const baseSearch = createStubBaseSearch({ totalNodes: TOTAL_NODES });
    const wrapped = createDeadlineSearch({ deadlineMs: 100_000, minNodes: 0, baseSearch });

    const resultPromise = wrapped(
      STUB_FEN,
      STUB_BUDGET,
      STUB_PROVIDERS,
      () => {},
      new AbortController().signal,
    );

    await vi.advanceTimersByTimeAsync(350);
    const snapshot = await resultPromise;

    expect(snapshot).toEqual(makeSnapshot(TOTAL_NODES, true));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards every onSnapshot from the base search to the caller unchanged (pass-through)', async () => {
    const TOTAL_NODES = 3;
    const baseSearch = createStubBaseSearch({ totalNodes: TOTAL_NODES });
    const wrapped = createDeadlineSearch({ deadlineMs: 100_000, minNodes: 0, baseSearch });

    const received: EngineSnapshot[] = [];
    const resultPromise = wrapped(
      STUB_FEN,
      STUB_BUDGET,
      STUB_PROVIDERS,
      (snapshot) => received.push(snapshot),
      new AbortController().signal,
    );

    await vi.advanceTimersByTimeAsync(500);
    await resultPromise;

    expect(received).toEqual([
      makeSnapshot(1, false),
      makeSnapshot(2, false),
      makeSnapshot(3, false),
    ]);
  });

  it('handles an outer signal that is already aborted before the call starts', async () => {
    const baseSearch = createStubBaseSearch({ totalNodes: 1000 });
    const outerController = new AbortController();
    outerController.abort();
    const wrapped = createDeadlineSearch({ deadlineMs: 100_000, minNodes: 0, baseSearch });

    const resultPromise = wrapped(
      STUB_FEN,
      STUB_BUDGET,
      STUB_PROVIDERS,
      () => {},
      outerController.signal,
    );

    await vi.advanceTimersByTimeAsync(0);
    const snapshot = await resultPromise;

    expect(snapshot.nodesEvaluated).toBe(0);
  });
});
