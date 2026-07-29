/**
 * useMaiaEngine — React hook wrapping the Maia-3 ("Chessformer") ONNX model in a
 * classic Web Worker, exposing the full per-ELO move-probability curve + WDL as
 * plain data. Structural sibling of `useStockfishEngine.ts` (Worker lifecycle,
 * mount-only effect, isReady/isAnalyzing, adaptive debounce, stale-result guard,
 * tab-hide pause) — the *protocol* differs (structured `{fen, eloInputs}` messages,
 * not UCI text), but the state-machine shape transfers directly.
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
 * Architecture: 151-RESEARCH.md Pattern 1; Confirmed contract: 151-MAIA-CONTRACT.md
 */

import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import * as Sentry from '@sentry/react';
import { maskAndSoftmax, softmaxWdl, expectedScore, MAIA_ELO_LADDER } from '../lib/maiaEncoding';
import type { WdlVector } from '../lib/maiaEncoding';
import { captureMaiaWorkerError } from '../lib/maiaWorkerErrors';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Path to the vendored Maia Worker served from public/maia/. */
const ENGINE_PATH = '/maia/maia-worker.js';

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
  /** True once the Worker's ONNX session has been created. */
  isReady: boolean;
  /** True while a (non-cached) inference is in flight for the current FEN. */
  isAnalyzing: boolean;
  /**
   * CR-03 (Phase 172, SEED-106): true once the Worker fired an `onerror` — an
   * async script-load failure (404, CSP block, importScripts failure) that never
   * throws a catchable exception on the main thread and leaves the worker dead
   * but silent (distinct from the `type: 'error'` inference failures already
   * forwarded via onmessage). Lets a consumer (the background gem sweep) abandon
   * an in-flight request stuck on a worker that will never report `ready`.
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
  | { type: 'error'; message: string };

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Converts a worker's raw per-ELO payload into the hook's normalized MaiaResult. */
function buildMaiaResult(fen: string, msg: WorkerResultMessage): MaiaResult {
  const perElo = msg.rawPolicyByElo.map(({ elo, policy }) => ({
    elo,
    moveProbabilities: maskAndSoftmax(policy, fen),
  }));
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

export function useMaiaEngine({ fen, enabled, selectedElo }: UseMaiaEngineOptions): UseMaiaEngineState {
  // ─── Refs ──────────────────────────────────────────────────────────────────

  const workerRef = useRef<Worker | null>(null);
  const isReadyRef = useRef(false);
  const currentFenRef = useRef<string | null>(null);
  /** FEN of the inference we are currently waiting on (null when nothing is in flight). */
  const pendingFenRef = useRef<string | null>(null);
  /** Active execution provider once the worker reports `ready` — tags Sentry errors. */
  const backendRef = useRef<'webgpu' | 'wasm' | null>(null);

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
   * Sends `analyze` for the given FEN, or commits a cache hit immediately without
   * a worker round-trip. Paused while the tab is hidden (D-04-adjacent tab-hide
   * pause pattern, mirrors useStockfishEngine's visibilitychange handling).
   */
  const analyze = useCallback(
    (fenToAnalyze: string) => {
      const worker = workerRef.current;
      if (!worker || !isReadyRef.current) return;
      if (document.visibilityState === 'hidden') return;

      const cached = cacheRef.current.get(fenToAnalyze);
      if (cached) {
        setLatestResult(cached);
        return;
      }

      // Keep a single inference in flight. The Maia worker can't cancel a running
      // ONNX inference, so posting a second `analyze` only queues it behind the
      // first — a slider drag that settles while an earlier position is still
      // computing used to wait out that whole backlog (far slower than a direct
      // click to the same position). Drop the request here; the result handler
      // re-issues for whatever position is current once the running inference
      // completes, skipping every intermediate slider position.
      if (pendingFenRef.current !== null) return;

      pendingFenRef.current = fenToAnalyze;
      setIsAnalyzing(true);
      worker.postMessage({ type: 'analyze', fen: fenToAnalyze, eloInputs: MAIA_ELO_LADDER });
    },
    [], // stable — only reads refs and stable state setters
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

  // ─── Worker lifecycle ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!enabled) return;

    // Classic (non-module) Worker — mirrors the Stockfish precedent; the Maia
    // Worker uses importScripts() to load onnxruntime-web's UMD-style bundles.
    const worker = new Worker(ENGINE_PATH);
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      if (msg.type === 'ready') {
        setIsReady(true);
        isReadyRef.current = true;
        backendRef.current = msg.backend;
        return;
      }
      if (msg.type === 'result') {
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
        return;
      }
      // msg.type === 'error': surfaced as isAnalyzing=false (no partial UI state).
      // The worker is a classic Worker with no Sentry init, and onnxruntime-web's
      // native failures (e.g. the Firefox/Windows `Clip` WebGPU shader error) print to
      // console but never throw a catchable JS exception — so they reach Sentry ONLY by
      // being forwarded here. Routed through captureMaiaWorkerError (quick 260729-sod,
      // FIX 2) for bounded classification + stable grouping instead of embedding the raw
      // worker text in the error message (CLAUDE.md frontend Sentry rules).
      captureMaiaWorkerError(msg.message, { source: 'maia-worker', backend: backendRef.current });
      pendingFenRef.current = null;
      setIsAnalyzing(false);
    };

    // CR-03 (Phase 172, SEED-106): mirror workerPool.createSlot — an async
    // script-load failure (404, CSP block, importScripts failure) never throws a
    // catchable JS exception on the main thread; it only surfaces here (the
    // onmessage `type: 'error'` path only covers inference failures AFTER the
    // worker booted). Without this handler a dead worker never reports `ready`,
    // so a gem-sweep candidate on the Maia stage hangs forever. Capture to
    // Sentry and surface `hasFailed` so the sweep can abandon it.
    worker.onerror = () => {
      Sentry.captureException(new Error('Maia worker: worker load failure'), {
        tags: { source: 'maia-worker', backend: backendRef.current ?? 'unknown', maia_failure: 'load' },
      });
      setHasFailed(true);
      setIsReady(false);
      isReadyRef.current = false;
      pendingFenRef.current = null;
      setIsAnalyzing(false);
    };

    worker.postMessage({ type: 'init' });

    return () => {
      worker.postMessage({ type: 'terminate' });
      worker.terminate();
      workerRef.current = null;
    };
  }, [enabled, cacheResult]);

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
