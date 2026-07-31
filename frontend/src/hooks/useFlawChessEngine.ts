/**
 * useFlawChessEngine — React hook driving the frozen `SearchRunner`
 * (`mctsSearch`) against the real Phase 154 providers (`createWorkerPool()` +
 * `createMaiaQueue()`), exposing a live-refining ranked-lines snapshot.
 *
 * This is the anytime-emit engine behind DISPLAY-01: `mctsSearch`'s
 * `onSnapshot` fires after every completed backup; the hook throttles those
 * commits into React state at a fixed ~150ms cadence WITHOUT delaying the
 * first paint (a throttle, not a debounce — see the onSnapshot throttle
 * section below, D-09, 155-RESEARCH.md Pattern 3 / Pitfall 3).
 *
 * Architecture: 155-RESEARCH.md Patterns 1-4, Pitfall 1 (abort does not free
 * the Stockfish pool — must also call `pool.stopAll()`), Pitfall 3 (a
 * debounce is the wrong tool for the live-refine cadence).
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import { mctsSearch } from '@/lib/engine/mctsSearch';
import { createWorkerPool, computePoolSize, type WorkerPool } from '@/lib/engine/workerPool';
import { createMaiaQueue, type MaiaQueue } from '@/lib/engine/maiaQueue';
import { DEFAULT_POLICY_TEMPERATURE } from '@/lib/engine/policyTemperature';
import type { EngineSnapshot, SearchBudget, EngineProviders, RankedLine } from '@/lib/engine/types';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Rapid-step FEN-navigation debounce window (ms) AND the onSnapshot throttle
 * window (ms) — the SAME value, reused for two DISTINCT mechanisms (D-09):
 * one debounces navigation input, the other throttles snapshot output. Do
 * not conflate the two; see the onSnapshot throttle below.
 */
const RAPID_STEP_DEBOUNCE_MS = 150;

/**
 * Node-expansion budget cap (D-09: one node = one expansion event). Tunable —
 * revisit after SC4 real-device mobile-memory UAT (155-RESEARCH.md D-02).
 */
const FLAWCHESS_ENGINE_MAX_NODES = 400;

/**
 * Search-tree ply depth cap. Must stay in the locked [6,10] band (SEED-082) —
 * do not change this without revisiting the milestone's ply-depth lock.
 */
const FLAWCHESS_ENGINE_MAX_PLIES = 8;

// ─── Bot-play budget (D-07/D-09) ────────────────────────────────────────────
//
// ADDITIVE profile for Phase 169's clocked bot games (168.5-RESEARCH.md
// Pattern 1) — sits ALONGSIDE the analysis-board constants above, never
// replacing them: retuning FLAWCHESS_ENGINE_MAX_NODES in place would
// silently degrade the live /analysis engine card, an unrelated regression
// (Pitfall 1). The values themselves live in the dependency-light
// `@/lib/engine/botBudget` so the calibration harness imports the SAME
// definition instead of hand-maintaining a mirror (a divergence would
// calibrate a bot that does not ship, T-168.5-04-01); re-exported here for
// app callers (Phase 169's `useBotGame`, which most plausibly calls
// `selectBotMove` directly, harness-style, not this hook).
export {
  FLAWCHESS_BOT_MAX_NODES,
  FLAWCHESS_BOT_MAX_PLIES,
  FLAWCHESS_BOT_CONCURRENCY,
  FLAWCHESS_BOT_STOP_RULE,
} from '@/lib/engine/botBudget';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UseFlawChessEngineOptions {
  /** Current board position. null keeps the engine idle (no search sent). */
  fen: string | null;
  /** When false, the WorkerPool/MaiaQueue are not created and no search runs. */
  enabled: boolean;
  /**
   * Shared per-side ELO for the practical model (D-07/Open Question 2):
   * `budget.elo = { w: elo, b: elo }`. True self/opponent asymmetry is
   * deferred to Phase 157's game-review overlay.
   */
  elo: number;
  /**
   * Phase 159 D-06/D-07 (Thread A): reshapes the root-mover's-own-side Maia
   * policy before search. Omitted defaults to `DEFAULT_POLICY_TEMPERATURE`
   * (a true no-op) at THIS call site — kept visible here, not hidden inside
   * `mctsSearch`, so the search-orchestrator layer's no-op short-circuit
   * (Pitfall 1/T-159-08) stays legible from the hook's own call site.
   */
  policyTemperature?: number;
}

export interface FlawChessEngineState {
  /** Top ranked root candidates, pre-sorted descending by practicalScore. */
  rankedLines: RankedLine[];
  /** D-09: count of expansion events consumed by the current/last search. */
  nodesEvaluated: number;
  /** True once maxNodes/maxPlies stopped the search (not an abort). */
  budgetExhausted: boolean;
  /** True while a search is in flight for the current position. */
  isSearching: boolean;
  /** True once the WorkerPool/MaiaQueue instances are created (enabled-gated). */
  isReady: boolean;
}

const INITIAL_SNAPSHOT: EngineSnapshot = {
  rankedLines: [],
  nodesEvaluated: 0,
  budgetExhausted: false,
  stopReason: null,
};

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useFlawChessEngine({
  fen,
  enabled,
  elo,
  policyTemperature,
}: UseFlawChessEngineOptions): FlawChessEngineState {
  // ─── Refs ──────────────────────────────────────────────────────────────────

  const poolRef = useRef<WorkerPool | null>(null);
  const queueRef = useRef<MaiaQueue | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  /** Timestamp (ms) of the last FEN change — drives the adaptive debounce. */
  const lastFenChangeAtRef = useRef(0);

  /** Timestamp (ms) of the last onSnapshot commit — drives the throttle. */
  const lastCommitAtRef = useRef(0);
  /** Pending trailing-commit timer for the onSnapshot throttle, or null when idle. */
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── State ─────────────────────────────────────────────────────────────────

  const [isReady, setIsReady] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [snapshot, setSnapshot] = useState<EngineSnapshot>(INITIAL_SNAPSHOT);

  // ─── Provider lifecycle (Pattern 1) — created once per enabled-lifetime ────
  //
  // Mirrors useStockfishEngine's Worker-lifecycle effect gated on `enabled`:
  // the WorkerPool + MaiaQueue are created ONCE while the switch is ON and
  // terminated on cleanup — never recreated per FEN (that would break Phase
  // 154's lazy-spawn-once + FEN cache).

  useEffect(() => {
    if (!enabled) return;
    const pool = createWorkerPool();
    const queue = createMaiaQueue();
    poolRef.current = pool;
    queueRef.current = queue;
    setIsReady(true);
    return () => {
      pool.terminate();
      queue.terminate();
      poolRef.current = null;
      queueRef.current = null;
      setIsReady(false);
      setIsSearching(false);
    };
  }, [enabled]); // re-run only if enabled toggles

  // ─── Adaptive debounce on FEN navigation (Pattern 2) ───────────────────────

  const [debouncedFen, setDebouncedFen] = useState<string | null>(null);
  useEffect(() => {
    // Drop the previous position's lines immediately so the card never shows
    // orphaned rankedLines from the prior ply while the new search spins up
    // (mirrors useStockfishEngine's identical FEN-effect clearing behavior).
    setSnapshot(INITIAL_SNAPSHOT);
    if (fen === null) {
      setDebouncedFen(null);
      return;
    }
    const now = Date.now();
    const sinceLast = now - lastFenChangeAtRef.current;
    lastFenChangeAtRef.current = now;
    if (sinceLast > RAPID_STEP_DEBOUNCE_MS) {
      // Settled move: fire immediately so the first line paints near-instantly.
      setDebouncedFen(fen);
      return;
    }
    // Rapid succession (held arrow-key auto-repeat): coalesce via debounce.
    const timer = setTimeout(() => setDebouncedFen(fen), RAPID_STEP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [fen]);

  // ─── onSnapshot throttle (Pattern 3 — NOT a debounce, Pitfall 3) ───────────
  //
  // Commit immediately if the last commit was more than RAPID_STEP_DEBOUNCE_MS
  // ago (this is what makes the FIRST snapshot of every search paint near-
  // instantly); otherwise schedule exactly one trailing commit of the LATEST
  // snapshot, clearing any previously scheduled one. A plain debounce here
  // would delay first paint and violate DISPLAY-01's "appear immediately".
  const handleSnapshot = useCallback((next: EngineSnapshot) => {
    const now = Date.now();
    const sinceLast = now - lastCommitAtRef.current;
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    if (sinceLast > RAPID_STEP_DEBOUNCE_MS) {
      lastCommitAtRef.current = now;
      setSnapshot(next);
      return;
    }
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      lastCommitAtRef.current = Date.now();
      setSnapshot(next);
    }, RAPID_STEP_DEBOUNCE_MS - sinceLast);
  }, []); // stable — only accesses refs and a stable state setter

  // ─── Debounced FEN → mctsSearch (Pattern 2, Pitfall 1 regression guard) ────

  useEffect(() => {
    const pool = poolRef.current;
    const queue = queueRef.current;
    if (!debouncedFen || !enabled || !pool || !queue) return;

    // Pitfall 1 (STALE as of Phase 194 ABORT-01): dispatchExpansion now
    // forwards this signal into providers.grade()'s 3rd param, so the abort()
    // below already reaches WorkerPool.grade's dequeue/stop handling on its
    // own. The explicit pool.stopAll() call is kept as redundant, idempotent
    // defense in depth (not removed — that's out of scope for Phase 194), not
    // because it is still load-bearing. maiaQueue has no stopAll (an
    // in-flight ONNX inference cannot be interrupted) — a stale policy()
    // resolution is unused and harmless.
    abortControllerRef.current?.abort();
    pool.stopAll();

    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Reset the onSnapshot throttle so the FIRST snapshot of this fresh
    // search always commits immediately, regardless of the previous search's
    // throttle state (D-09 first-paint guarantee).
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    lastCommitAtRef.current = 0;

    const budget: SearchBudget = {
      maxNodes: FLAWCHESS_ENGINE_MAX_NODES,
      maxPlies: FLAWCHESS_ENGINE_MAX_PLIES,
      concurrency: computePoolSize(),
      // D-07/Open Question 2: both colors share the single on-page ELO in
      // free analysis; true self/opponent asymmetry is deferred to Phase 157.
      elo: { w: elo, b: elo },
      // extraRootMoves intentionally left unset (155-RESEARCH.md A5).
      // Phase 159 D-06/D-07 (Thread A): defaulted at THIS call site (not
      // inside mctsSearch) so the no-op short-circuit stays visible at the
      // orchestrator layer (Pitfall 1/T-159-08).
      policyTemperature: policyTemperature ?? DEFAULT_POLICY_TEMPERATURE,
    };
    const providers: EngineProviders = { policy: queue.policy, grade: pool.grade };

    setIsSearching(true);
    void mctsSearch(debouncedFen, budget, providers, handleSnapshot, controller.signal)
      .then((finalSnapshot) => {
        if (controller.signal.aborted) return;
        if (pendingTimerRef.current) {
          clearTimeout(pendingTimerRef.current);
          pendingTimerRef.current = null;
        }
        lastCommitAtRef.current = Date.now();
        setSnapshot(finalSnapshot);
        setIsSearching(false);
      })
      .catch((err: unknown) => {
        // A rejection (worker crash, or grade()/policy() throwing after a
        // concurrent state change tore down the pool/queue) must not become
        // an unhandled promise rejection nor leave isSearching stuck true —
        // see WR-01, 155-REVIEW.md.
        if (controller.signal.aborted) return;
        Sentry.captureException(err, { tags: { source: 'flawchess-engine' } });
        setIsSearching(false);
      });
  }, [debouncedFen, enabled, elo, policyTemperature, handleSnapshot]);

  // ─── Abort-on-disable guard (WR-02, 155-REVIEW.md) ─────────────────────────
  //
  // The search-trigger effect above only calls abortControllerRef.current
  // ?.abort() at the TOP of its guarded body, which is skipped whenever the
  // guard (`!debouncedFen || !enabled || !pool || !queue`) fails — e.g. when
  // `enabled` flips to false without a FEN change. Without this cleanup, a
  // stale in-flight search's callbacks could still fire (controller.signal
  // .aborted would remain false) and call setSnapshot/setIsSearching after
  // the engine was disabled. This effect's cleanup always runs on the next
  // dep change AND on unmount, regardless of whether the guard above passes.
  useEffect(() => {
    return () => abortControllerRef.current?.abort();
  }, [debouncedFen, enabled]);

  // ─── Unmount cleanup ────────────────────────────────────────────────────────
  //
  // The provider-lifecycle effect's own cleanup already terminates the pool
  // and queue (which resolves every in-flight promise so mctsSearch's awaits
  // settle without hanging); this additionally aborts the outstanding
  // AbortController and clears any pending throttle timer on unmount.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    };
  }, []); // stable refs — no deps required

  // ─── Return ────────────────────────────────────────────────────────────────

  return {
    rankedLines: snapshot.rankedLines,
    nodesEvaluated: snapshot.nodesEvaluated,
    budgetExhausted: snapshot.budgetExhausted,
    isSearching,
    isReady,
  };
}
