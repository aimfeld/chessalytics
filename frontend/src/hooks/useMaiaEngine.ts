/**
 * useMaiaEngine — React hook wrapping the Maia-3 ("Chessformer") ONNX model,
 * exposing the full per-ELO move-probability curve + WDL as plain data.
 * Structural sibling of `useStockfishEngine.ts` (lease lifecycle, mount-only
 * effect, isReady/isAnalyzing, adaptive debounce, stale-result guard,
 * tab-hide pause) — the *protocol* differs (structured `{fen, eloInputs}`
 * messages, not UCI text), but the state-machine shape transfers directly.
 *
 * MAIA-04: full per-ELO curve + WDL computed for a known FEN, ELO ladder =
 *          maiachess.com's 600-2600 step 100 (UAT quick 260705-bm3; validated
 *          sub-band 1100-2000 per 151-MAIA-CONTRACT.md §c).
 * MAIA-05: ephemeral, board-session-scoped FIFO cache (no persistence).
 * SURF-05: live recompute on every FEN change, no server round-trip.
 *
 * maskAndSoftmax/expectedScore/softmaxWdl are single-sourced from maiaEncoding.ts
 * (the worker returns RAW policy/WDL logits only — see maia-worker.js header).
 *
 * Worker ownership (quick 260729-sod, FIX 3): this hook no longer constructs
 * or terminates a Worker directly — it acquires a lease from the shared
 * `maiaWorkerHost` singleton, which owns spawn/respawn/death and guarantees
 * every `analyze()` promise settles. This hook keeps its OWN
 * `pendingFenRef` single-in-flight "drop and reissue" discipline (only the
 * latest position matters for a live chart) ABOVE the host — that discipline
 * is NOT something the host enforces, since other leases (e.g. `maiaQueue`)
 * need every request answered.
 *
 * Architecture: 151-RESEARCH.md Pattern 1; Confirmed contract: 151-MAIA-CONTRACT.md
 */

import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import {
  buildPolicyMoveContext,
  softmaxPolicyByContext,
  softmaxWdl,
  expectedScore,
  MAIA_ELO_LADDER,
} from '../lib/maiaEncoding';
import type { WdlVector } from '../lib/maiaEncoding';
import { acquireMaiaWorker } from '../lib/engine/maiaWorkerHost';
import type { MaiaAnalyzeResult, MaiaWorkerLease } from '../lib/engine/maiaWorkerHost';
import { setCachedPolicy } from '../lib/engine/maiaPolicyCache';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Rapid-step debounce window (ms) — mirrors useStockfishEngine's RAPID_STEP_DEBOUNCE_MS. */
const RAPID_STEP_DEBOUNCE_MS = 150;

/** Ephemeral inference cache cap — mirrors Analysis.tsx's LIVE_EVAL_CACHE_MAX pattern (MAIA-05). */
const MAIA_CACHE_MAX = 256;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UseMaiaEngineOptions {
  /** Current board position. null keeps the engine idle (no analyze sent). */
  fen: string | null;
  /** When false the Worker is not created and analysis does not run. */
  enabled: boolean;
  /** ELO used to pick the "you are here" rung for wdl/expectedScoreAtSelectedElo. */
  selectedElo: number;
  /**
   * Lease priority on the shared Maia worker host (quick 260729-sod, FIX 3):
   * `true` (default) jumps queued background requests (the live chart must
   * never be starved behind the FlawChess Engine's MCTS policy calls or the
   * gem sweep) but never preempts whatever inference is already in flight.
   * `false` is for background-only consumers (see `useGemSweep.ts`).
   */
  priority?: boolean;
}

/** One ELO rung's normalized per-legal-move probability distribution, keyed by SAN. */
export interface MoveCurvePoint {
  elo: number;
  moveProbabilities: Record<string, number>;
}

export interface UseMaiaEngineState {
  /** Full per-ELO curve (every MAIA_ELO_LADDER rung) — chart input (SURF-01). */
  perElo: MoveCurvePoint[];
  /** expectedScore(wdl) at the ladder rung nearest `selectedElo`; null until ready. */
  expectedScoreAtSelectedElo: number | null;
  /** Full WDL vector at the ladder rung nearest `selectedElo`; null until ready. */
  wdl: WdlVector | null;
  /** True once the shared worker's ONNX session has been created (this lease has seen `ready`). */
  isReady: boolean;
  /** True while a (non-cached) inference is in flight for the current FEN. */
  isAnalyzing: boolean;
  /**
   * CR-03 (Phase 172, SEED-106): true once the shared worker host reports this
   * lease `onFatal` — worker death (async script-load failure, or a pre-ready
   * init error) that leaves the worker dead. Lets a consumer (the background
   * gem sweep) abandon an in-flight request stuck on a worker that will never
   * report `ready` again. NOT fired for a transparent webgpu-unavailable
   * respawn (quick 260729-sod, FIX 1) — the host handles that on its own.
   */
  hasFailed: boolean;
  /**
   * The FEN `perElo`/`wdl` actually belong to; null while no result is held.
   * Bug fix (163-REVIEW WR-03): this hook clears `latestResult` in an effect
   * keyed on `fen`, i.e. one commit AFTER the caller's `fen` prop changes — so
   * on the navigation commit `perElo` still holds the PREVIOUS position's
   * curve. Callers writing per-FEN caches must key/guard on `resultFen`, never
   * on their own current position.
   */
  resultFen: string | null;
}

/** Cached inference result for one FEN — every ladder rung, board-session scoped. */
interface MaiaResult {
  /** The FEN this inference was computed for (WR-03 — see `resultFen`). */
  fen: string;
  perElo: MoveCurvePoint[];
  wdlByElo: { elo: number; wdl: WdlVector }[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Converts the host's raw per-ELO payload into the hook's normalized
 * MaiaResult. Also write-throughs the shared `fen|elo` policy cache
 * (`maiaPolicyCache.ts`, Phase 194 CACHE-05) with a UCI-keyed distribution
 * per ladder rung, so a position this chart already inferred serves the
 * engine's own root `policy()` call (`maiaQueue.ts`) without a second
 * ~130 ms Maia forward pass. Keyed on `fen` — this function is always called
 * with the RESULT's own `msg.fen`, never the hook's current `fen` prop
 * (163-REVIEW WR-03: `latestResult` clears one commit after the prop
 * changes, so a write keyed on the prop could target the wrong position).
 * UCI-keyed rather than reusing this function's own SAN-keyed
 * `moveProbabilities`: the engine's consumer needs UCI keys, and converting
 * SAN to UCI at read time would reintroduce the per-move chess.js replay
 * Phase 194 JANK-01 removed from the hot path.
 *
 * Bug fix (quick 260731-s0z, FIX-7): this used to call both `maskAndSoftmax`
 * and `maskAndSoftmaxUci` per ELO rung — 21 rungs means 42 `new Chess(fen)`
 * constructions and 42 full legal-move generations for ONE FEN whose
 * legal-move set, vocab indices, and UCI/SAN keys are rung-INVARIANT; only
 * the logits differ per rung. `buildPolicyMoveContext` now builds that
 * rung-invariant context ONCE, and `softmaxPolicyByContext` runs one softmax
 * pass per rung over precomputed indices, returning both keyspaces from a
 * single pass. `maskAndSoftmax`/`maskAndSoftmaxUci` are kept as the
 * independent reference implementations the parity tests
 * (`maiaEncoding.test.ts`) compare this path against — not reimplemented on
 * top of it, which would make those tests self-referential.
 */
function buildMaiaResult(fen: string, msg: MaiaAnalyzeResult): MaiaResult {
  const ctx = buildPolicyMoveContext(fen);
  const perElo = msg.rawPolicyByElo.map(({ elo, policy }) => {
    const { san, uci } = softmaxPolicyByContext(policy, ctx);
    setCachedPolicy(fen, elo, uci);
    return {
      elo,
      moveProbabilities: san,
    };
  });
  const wdlByElo = msg.wdlByElo.map(({ elo, wdl }) => ({ elo, wdl: softmaxWdl(wdl) }));
  return { fen, perElo, wdlByElo };
}

/** Finds the ladder entry whose ELO is numerically closest to `target`. */
function nearestByElo<T extends { elo: number }>(entries: T[], target: number): T | undefined {
  return entries.reduce<T | undefined>((closest, entry) => {
    if (closest === undefined) return entry;
    return Math.abs(entry.elo - target) < Math.abs(closest.elo - target) ? entry : closest;
  }, undefined);
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useMaiaEngine({
  fen,
  enabled,
  selectedElo,
  priority = true,
}: UseMaiaEngineOptions): UseMaiaEngineState {
  // ─── Refs ──────────────────────────────────────────────────────────────────

  const leaseRef = useRef<MaiaWorkerLease | null>(null);
  const isReadyRef = useRef(false);
  const currentFenRef = useRef<string | null>(null);
  /** FEN of the inference we are currently waiting on (null when nothing is in flight). */
  const pendingFenRef = useRef<string | null>(null);

  /** Ephemeral, board-session-scoped FIFO cache (MAIA-05) — no persistence. */
  const cacheRef = useRef<Map<string, MaiaResult>>(new Map());

  /** Timestamp of the last FEN change, for the adaptive debounce (mirrors useStockfishEngine). */
  const lastFenChangeAtRef = useRef(0);

  // ─── State ─────────────────────────────────────────────────────────────────

  const [isReady, setIsReady] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  const [latestResult, setLatestResult] = useState<MaiaResult | null>(null);

  // ─── Ref sync ──────────────────────────────────────────────────────────────

  useEffect(() => {
    currentFenRef.current = fen;
    isReadyRef.current = isReady;
  });

  // ─── FIFO cache insert ─────────────────────────────────────────────────────

  const cacheResult = useCallback((key: string, result: MaiaResult) => {
    const cache = cacheRef.current;
    cache.set(key, result);
    if (cache.size > MAIA_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }, []);

  // ─── Analyze ───────────────────────────────────────────────────────────────

  /**
   * Sends `analyze` for the given FEN via the shared worker lease, or commits
   * a cache hit immediately without a round-trip. Paused while the tab is
   * hidden (D-04-adjacent tab-hide pause pattern, mirrors
   * useStockfishEngine's visibilitychange handling).
   */
  const analyze = useCallback(
    (fenToAnalyze: string) => {
      const lease = leaseRef.current;
      if (!lease || !isReadyRef.current) return;
      if (document.visibilityState === 'hidden') return;

      const cached = cacheRef.current.get(fenToAnalyze);
      if (cached) {
        setLatestResult(cached);
        return;
      }

      // Keep a single inference in flight. A running ONNX inference can't be
      // cancelled, so posting a second `analyze` only queues it behind the
      // first — a slider drag that settles while an earlier position is still
      // computing used to wait out that whole backlog (far slower than a direct
      // click to the same position). Drop the request here; the result handler
      // re-issues for whatever position is current once the running inference
      // completes, skipping every intermediate slider position. This
      // discipline lives ABOVE the shared maiaWorkerHost — the host itself
      // does not drop anything (other leases need every request answered).
      if (pendingFenRef.current !== null) return;

      pendingFenRef.current = fenToAnalyze;
      setIsAnalyzing(true);
      lease.analyze(fenToAnalyze, MAIA_ELO_LADDER).then(
        (msg) => {
          if (leaseRef.current !== lease) return; // this lease has since been released/replaced
          // Cache every completed inference, even one whose position was already
          // superseded — the result is valid for msg.fen, so caching it makes a
          // later revisit (a slider scrub back) an instant cache hit instead of a
          // recompute, and keeps the debounce-effect cache restore below effective.
          const result = buildMaiaResult(msg.fen, msg);
          cacheResult(msg.fen, result);
          // Only paint it if it still matches the on-screen position (stale guard).
          if (msg.fen === currentFenRef.current) setLatestResult(result);
          // Clear the in-flight flag only when the result we were waiting on lands —
          // a superseded result must not stop the spinner for a request still running.
          if (msg.fen === pendingFenRef.current) {
            pendingFenRef.current = null;
            setIsAnalyzing(false);
            // The worker is free again — converge on the live position. If the user
            // moved on (slider drag/scrub) while this ran, analyze where they are
            // now, skipping the intermediate positions we deliberately never queued.
            const current = currentFenRef.current;
            if (current && current !== msg.fen && !cacheRef.current.has(current)) {
              analyzeRef.current(current);
            }
          }
        },
        () => {
          // Rejected — either this lease was released (unmount/enabled toggle,
          // no UI update needed) or the host's worker died mid-request (the
          // `onFatal` callback below already handles that UI-state update).
          if (leaseRef.current !== lease) return;
          if (pendingFenRef.current === fenToAnalyze) pendingFenRef.current = null;
          setIsAnalyzing(false);
        },
      );
    },
    [cacheResult],
  );

  const analyzeRef = useRef(analyze);

  // ─── Debounce (mirrors useStockfishEngine's adaptive debounce) ────────────

  // The analyze trigger carries a monotonic `seq` so that navigating back to a
  // FEN identical to the last one still re-fires the analyze effect. Keying the
  // effect on the raw FEN string alone let React bail out of an identical-value
  // state update, which (after a rapid slider scrub landing back on the current
  // position) left the chart blank and the eval bar stuck at 50% — no analyze
  // was ever issued for the resting position.
  const [analyzeTarget, setAnalyzeTarget] = useState<{ fen: string; seq: number } | null>(null);
  const seqRef = useRef(0);
  useEffect(() => {
    if (fen === null) {
      setLatestResult(null);
      setAnalyzeTarget(null);
      return;
    }
    // Revisiting an already-analyzed position (common when scrubbing the slider
    // back and forth) is an instant cache restore — no null-flash, and critically
    // never leaves the curve/eval-bar stuck blank while waiting on the trigger.
    const cached = cacheRef.current.get(fen);
    if (cached) {
      setLatestResult(cached);
      return;
    }
    // Cache miss: drop the previous position's curve/WDL immediately so a slow
    // inference never leaves a stale curve mislabeled as the current position's.
    setLatestResult(null);
    const commit = (): void => setAnalyzeTarget({ fen, seq: seqRef.current++ });
    const now = Date.now();
    const sinceLast = now - lastFenChangeAtRef.current;
    lastFenChangeAtRef.current = now;
    if (sinceLast > RAPID_STEP_DEBOUNCE_MS) {
      commit();
      return;
    }
    const timer = setTimeout(commit, RAPID_STEP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [fen]);

  // ─── Worker lease lifecycle (quick 260729-sod, FIX 3) ──────────────────────

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    const lease = acquireMaiaWorker({
      source: 'maia-worker',
      priority,
      // CR-03 (Phase 172, SEED-106): worker death (async script-load failure,
      // or a pre-ready init error) — NOT fired for a transparent
      // webgpu-unavailable respawn, which the host handles on its own and
      // this hook never observes as a state transition.
      onFatal: () => {
        if (disposed) return;
        setHasFailed(true);
        setIsReady(false);
        isReadyRef.current = false;
        pendingFenRef.current = null;
        setIsAnalyzing(false);
      },
    });
    leaseRef.current = lease;

    lease.whenReady().then(
      (backendResult) => {
        if (disposed) return;
        void backendResult; // backend is exposed via the host, not surfaced on this hook's own state
        setIsReady(true);
        isReadyRef.current = true;
      },
      () => {
        // Rejected — the onFatal callback above already covers the UI-state
        // update for worker death; nothing further to do here.
      },
    );

    return () => {
      disposed = true;
      lease.release();
      leaseRef.current = null;
      // Bug fix (quick 260731-s0z, FIX-1): this cleanup used to only null the
      // lease, leaving pendingFenRef/isAnalyzing/isReady set. The in-flight
      // request's own rejection handler above bails at the
      // `leaseRef.current !== lease` check BEFORE it clears pendingFenRef, so
      // that ref stayed non-null forever and every later analyze() returned
      // at the single-in-flight gate — a disable-mid-inference permanently
      // wedged the hook even after a subsequent re-enable. Mirrors the
      // four-field reset `onFatal` above already performs, and the analogous
      // teardown reset in useStockfishEngine.ts's worker cleanup.
      pendingFenRef.current = null;
      setIsAnalyzing(false);
      setIsReady(false);
      isReadyRef.current = false;
      // useGemSweep.ts flips `enabled` dynamically (engineEnabled =
      // effectiveEnabled && hasWork) so it inherits this fix too; it only
      // reads perElo/resultFen/hasFailed, never isReady/isAnalyzing, so these
      // added resets cannot regress the sweep.
    };
  }, [enabled, priority]);

  // ─── Debounced FEN -> analyze ───────────────────────────────────────────────

  useEffect(() => {
    if (!analyzeTarget || !isReady) return;
    analyze(analyzeTarget.fen);
  }, [analyzeTarget, isReady, analyze]);

  // ─── Tab-hide pause ─────────────────────────────────────────────────────────

  useEffect(() => {
    function handleVisibility(): void {
      if (document.visibilityState === 'visible') {
        // Re-analyze the current position on return — mirrors useStockfishEngine's
        // auto re-go so a position changed-while-hidden. is picked up immediately.
        const current = currentFenRef.current;
        if (current) analyzeRef.current(current);
      }
      // No explicit worker-side action is needed on hide: Maia inference is a
      // single request/response per position (not an iterative search like
      // Stockfish), so there is nothing in-flight to stop — analyze() itself
      // checks visibilityState and will not fire a NEW analyze while hidden.
    }

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // ─── Derived state (selectedElo -> nearest ladder rung) ────────────────────

  const nearestWdlEntry = useMemo(
    () => (latestResult ? nearestByElo(latestResult.wdlByElo, selectedElo) : undefined),
    [latestResult, selectedElo],
  );

  const wdl = nearestWdlEntry?.wdl ?? null;
  const expectedScoreAtSelectedElo = wdl ? expectedScore(wdl) : null;

  // ─── Return ────────────────────────────────────────────────────────────────

  return {
    perElo: latestResult?.perElo ?? [],
    expectedScoreAtSelectedElo,
    wdl,
    isReady,
    isAnalyzing,
    hasFailed,
    resultFen: latestResult?.fen ?? null,
  };
}
