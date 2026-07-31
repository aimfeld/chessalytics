/**
 * useStockfishEngine — React hook wrapping Stockfish 18 lite-single WASM
 * in a Web Worker, exposing a UCI state machine as plain data.
 *
 * Rendering is deferred to Phases 137/138; this hook is data-only.
 * ENGINE-01: evalCp / evalMate
 * ENGINE-02: pvLines (MultiPV=2)
 * ENGINE-03: pvLines[0].moves[0] (best move UCI string)
 * ENGINE-04: isReady / isAnalyzing + enabled control input
 * ENGINE-05: adaptive debounce + go movetime 1500 nodes 2000000 + stopPendingRef
 *
 * Architecture: RESEARCH.md Patterns 1–4
 * Pitfall refs: Pitfall 3 (stale eval race), Pitfall 4 (worker leak),
 *               Pitfall 5 (bound filtering), D-04 (tab-hide pause)
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { parseInfoLine } from './uciParser';
import type { PvLine } from './uciParser';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Path to the vendored Stockfish engine served from public/engine/. */
const ENGINE_PATH = '/engine/stockfish-18-lite-single.js';

/** Primary wall-clock search cap (milliseconds). Locked by ROADMAP SC#2. */
const MOVETIME_MS = 1500;

/** Secondary node-count valve — hardware-independent safety bound. */
const MAX_NODES = 2000000;

/** Rapid-step debounce window (ms): coalesces held arrow-key auto-repeat to one search. */
const RAPID_STEP_DEBOUNCE_MS = 150;

/** Number of candidate lines requested from the engine. */
const MULTIPV = 2;

// ─── Types ───────────────────────────────────────────────────────────────────

/** Internal UCI state machine states. */
type EngineState = 'idle' | 'thinking' | 'stopping';

export interface UseStockfishEngineOptions {
  /** Current board position. null keeps the engine idle (no go sent). */
  fen: string | null;
  /** When false the Worker is not created and analysis does not run. */
  enabled: boolean;
}

export interface StockfishEngineState {
  /** Centipawns from white's POV; null while loading or if score is mate. */
  evalCp: number | null;
  /** Mate in N; positive=winning, negative=losing; null if centipawn score. */
  evalMate: number | null;
  /** Up to MULTIPV candidate lines sorted by multipv index. */
  pvLines: PvLine[];
  /** Search depth of the last completed (non-discarded) analysis. */
  depth: number;
  /** True while the engine is searching the current position. */
  isAnalyzing: boolean;
  /** True once the UCI init sequence completes (uciok + readyok). */
  isReady: boolean;
  /**
   * Code review WR-01 (196-REVIEW.md): the FEN `pvLines` was most recently
   * reset/committed for. Set in the SAME effect (and same `fen`-change
   * render) that clears `pvLines` to `[]`, so it lags `fen` by exactly the
   * same one render `pvLines` does — letting a consumer distinguish "pvLines
   * genuinely belongs to the current position" from "pvLines is a stale
   * closure value from the previous position, captured in the same passive-
   * effect flush as this hook's own FEN-reset effect." Consumers must NOT
   * trust `pvLines` for a given FEN unless `currentFen === thatFen`.
   */
  currentFen: string | null;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useStockfishEngine({
  fen,
  enabled,
}: UseStockfishEngineOptions): StockfishEngineState {
  // ─── Refs ──────────────────────────────────────────────────────────────────

  const workerRef = useRef<Worker | null>(null);

  /** Internal UCI state machine — mutated from the onmessage handler (no re-render). */
  const stateRef = useRef<EngineState>('idle');

  /**
   * Layer B stale-eval guard (Pitfall 3).
   * Set to true when stop is sent; cleared when the resulting bestmove arrives
   * and is discarded without committing to pvLines.
   */
  const stopPendingRef = useRef(false);

  /**
   * Ref-for-latest-value: keeps the most recent FEN visible inside event
   * callbacks without closing over stale state (pattern from useTacticLine).
   */
  const currentFenRef = useRef<string | null>(null);

  /** Ref-for-latest-value: isReady visible inside event callbacks. */
  const isReadyRef = useRef(false);

  /** In-flight MultiPV map: keyed by multipv index, updated on exact info lines. */
  const pvMapRef = useRef<Map<number, PvLine>>(new Map());

  /**
   * Side to move of the FEN currently being analyzed. UCI scores are reported
   * from the mover's POV, but evalCp/evalMate (and PvLine) are contractually
   * white-POV. We negate the committed score when black is to move so the sign
   * is correct on every ply. Bug fix: without this the eval was flipped on
   * alternating plies (black-to-move positions showed black's POV).
   */
  const analyzedSideToMoveRef = useRef<'w' | 'b'>('w');

  /**
   * Timestamp (ms) of the last FEN change, used by the adaptive debounce to
   * distinguish settled moves (no recent prior change → fire immediately) from
   * rapid-succession steps (held arrow key → coalesce via debounce window).
   * Initialized to 0; in real time Date.now() >> 0 so the first mount always
   * fires immediately.
   */
  const lastFenChangeAtRef = useRef(0);

  // ─── State ─────────────────────────────────────────────────────────────────

  const [isReady, setIsReady] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [evalCp, setEvalCp] = useState<number | null>(null);
  const [evalMate, setEvalMate] = useState<number | null>(null);
  const [pvLines, setPvLines] = useState<PvLine[]>([]);
  const [depth, setDepth] = useState(0);
  /** WR-01 (196-REVIEW.md): the FEN `pvLines` currently belongs to. */
  const [currentFen, setCurrentFen] = useState<string | null>(null);

  // ─── Ref sync (ref-for-latest-value) ───────────────────────────────────────

  // Sync refs to latest prop/state values each render so callbacks always see
  // the current values without closing over stale state.
  useEffect(() => {
    currentFenRef.current = fen;
    isReadyRef.current = isReady;
  });

  // ─── Debounce (Layer A stale-eval guard) ───────────────────────────────────

  /**
   * Adaptive debounce: fire immediately on a settled move (no recent prior
   * FEN change); only debounce when positions change in rapid succession
   * (held arrow-key auto-repeat). This lets the first engine line paint in
   * well under 100ms, while still coalescing rapid steps to a single search.
   *
   * Firing before engine init is safe: analyze() early-returns on
   * !isReadyRef.current and the debouncedFen+isReady effect re-fires once
   * isReady flips true.
   */
  const [debouncedFen, setDebouncedFen] = useState<string | null>(null);
  useEffect(() => {
    // Item 2 (Quick 260627-l2z): the analyzed position changed — immediately drop the
    // previous position's PV lines + eval so the board never shows orphaned arrows from
    // the prior ply. Consumers fall back to precomputed data (game main line) until the
    // live engine reports for the new position; the grey 2nd-best reappears then.
    setPvLines([]);
    setEvalCp(null);
    setEvalMate(null);
    setDepth(0);
    // WR-01 (196-REVIEW.md): committed in the SAME effect run as the
    // `pvLines` reset above, so `currentFen` lags `fen` by exactly the same
    // one render that `pvLines` does — a consumer reading both in the same
    // render either sees them both-stale-together (safe: currentFen !==
    // position, so the consumer knows not to trust pvLines) or both-fresh-
    // together, never a mismatched pairing.
    setCurrentFen(fen);
    if (fen === null) {
      setDebouncedFen(null);
      return;
    }
    const now = Date.now();
    const sinceLast = now - lastFenChangeAtRef.current;
    lastFenChangeAtRef.current = now;
    if (sinceLast > RAPID_STEP_DEBOUNCE_MS) {
      // Settled move (or first mount in real time where lastFenChangeAtRef is 0
      // and Date.now() >> 0): fire immediately so the first line paints near-instantly.
      setDebouncedFen(fen);
      return;
    }
    // Rapid succession: coalesce via debounce so a storm of FEN changes
    // produces only one search.
    const timer = setTimeout(() => setDebouncedFen(fen), RAPID_STEP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [fen]);

  // ─── Analyze ───────────────────────────────────────────────────────────────

  /**
   * Send position + go for the given FEN.
   *
   * If the engine is already thinking, sends stop and marks stopPendingRef so
   * the subsequent bestmove (termination response) is discarded. The go for
   * the new FEN is deferred until that stale bestmove arrives (handleLine).
   *
   * Wrapped in useCallback (no deps — reads from stable refs only) so it can
   * be stored in analyzeRef and called from the onmessage handler without
   * causing stale closure issues.
   */
  const analyze = useCallback((fenToAnalyze: string) => {
    const worker = workerRef.current;
    if (!worker || !isReadyRef.current) return;

    if (stateRef.current === 'thinking') {
      // Engine is mid-search: stop it; the go will be re-sent once the stale
      // bestmove arrives and stopPendingRef is cleared.
      worker.postMessage('stop');
      stopPendingRef.current = true;
      stateRef.current = 'stopping';
      return;
    }

    if (stateRef.current === 'stopping') {
      // Bug fix (FLAWCHESS-7V): a stop is already in flight and we're awaiting its
      // terminating bestmove. Sending position+go now would race that in-flight stop
      // and trap the Stockfish WASM engine with "RuntimeError: unreachable". Do
      // nothing: the bestmove+stopPendingRef handler re-analyzes currentFenRef.current
      // (always the latest FEN) once the stale bestmove arrives. This path became
      // reachable when the adaptive debounce started firing settled moves immediately
      // instead of serializing every change behind a 150ms timer (quick-260629-n8e).
      return;
    }

    // Clear pvMap so stale lines from the previous position do not bleed into
    // the snapshot that will be committed on the next bestmove.
    pvMapRef.current.clear();
    // Record the side to move so the committed score can be normalized to
    // white-POV (UCI reports it from the mover's POV).
    analyzedSideToMoveRef.current = fenToAnalyze.split(' ')[1] === 'b' ? 'b' : 'w';
    worker.postMessage(`position fen ${fenToAnalyze}`);
    worker.postMessage(`go movetime ${MOVETIME_MS} nodes ${MAX_NODES}`);
    stateRef.current = 'thinking';
    setIsAnalyzing(true);
  }, []); // stable — only accesses refs and stable state setters

  /**
   * Ref holding the analyze function, used inside Worker lifetime and
   * visibility effects to avoid adding analyze to their deps arrays
   * (which would re-run the worker effect on every render).
   *
   * analyze is a stable useCallback([]) — no render-phase update is needed;
   * the ref holds the same reference for the component's lifetime.
   */
  const analyzeRef = useRef(analyze);

  // ─── Worker lifecycle ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!enabled) return;

    // Classic (non-module) Worker — Emscripten glue uses self.onmessage /
    // self.postMessage. Do NOT pass { type: 'module' } (Pitfall: Anti-Patterns).
    const worker = new Worker(ENGINE_PATH);
    workerRef.current = worker;

    /**
     * Commit the current pvMapRef snapshot to state (white-POV normalized).
     * Called on every info line (live first-paint) and on the non-stale bestmove
     * (final commit). The info-line stale guard (stateRef !== 'thinking' ||
     * stopPendingRef) ensures this is never called for a superseded search.
     *
     * Pitfall 5 note: bound filtering is intentionally relaxed — lowerbound and
     * upperbound lines paint immediately so the eval sharpens in place as depth
     * climbs. The eval may visibly bounce ~200-300ms; this is accepted
     * (lichess-style live streaming behavior).
     */
    function commitPvSnapshot(): void {
      // Normalize UCI's side-to-move score to white-POV (negate for black to
      // move) so evalCp/evalMate and every PvLine honor the white-POV contract.
      const whitePovSign = analyzedSideToMoveRef.current === 'b' ? -1 : 1;
      const toWhitePov = (v: number | null): number | null =>
        v === null ? null : v * whitePovSign;

      // Sort by multipv index so pvLines[0] is always the top line.
      const snapshot = [...pvMapRef.current.values()]
        .sort((a, b) => a.multipv - b.multipv)
        .map((l) => ({ ...l, evalCp: toWhitePov(l.evalCp), evalMate: toWhitePov(l.evalMate) }));
      setPvLines(snapshot);

      // Commit the top line's eval to the flat state fields.
      const topLine = pvMapRef.current.get(1);
      if (topLine !== undefined) {
        setEvalCp(toWhitePov(topLine.evalCp));
        setEvalMate(toWhitePov(topLine.evalMate));
        setDepth(topLine.depth);
      }
    }

    /** Handle a single UCI line emitted by the engine Worker. */
    function handleLine(line: string): void {
      if (line === 'uciok') {
        worker.postMessage(`setoption name MultiPV value ${MULTIPV}`);
        worker.postMessage('isready');
        return;
      }

      if (line === 'readyok') {
        setIsReady(true);
        isReadyRef.current = true;
        // Analysis is triggered by the debouncedFen + isReady effect below.
        // We do NOT call analyze directly here to preserve the debounce invariant.
        return;
      }

      if (line.startsWith('info ')) {
        // Stale-eval guard: ignore info lines from a superseded search.
        // stopPendingRef means a stop was sent; the engine is winding down and
        // its lines belong to the old position.
        if (stateRef.current !== 'thinking' || stopPendingRef.current) return;
        const parsed = parseInfoLine(line);
        // Pitfall 5 (relaxed for live first-paint): accept lowerbound/upperbound
        // lines too — eval bounces briefly then settles (lichess-style).
        if (parsed !== null) {
          pvMapRef.current.set(parsed.multipv, {
            multipv: parsed.multipv,
            depth: parsed.depth,
            moves: parsed.pv,
            evalCp: parsed.scoreCp,
            evalMate: parsed.scoreMate,
          });
          commitPvSnapshot();
        }
        return;
      }

      if (line.startsWith('bestmove')) {
        if (stopPendingRef.current) {
          // Layer B discard (Pitfall 3): this bestmove is the termination
          // response to our stop — it reflects the previous position, not the
          // current one. Discard and re-analyze the current FEN (unless hidden).
          stopPendingRef.current = false;
          stateRef.current = 'idle';
          const current = currentFenRef.current;
          if (current && document.visibilityState !== 'hidden') {
            analyzeRef.current(current);
          }
          return;
        }

        // Non-stale bestmove: commit the final pvMap snapshot, then mark idle.
        commitPvSnapshot();
        stateRef.current = 'idle';
        setIsAnalyzing(false);
      }
    }

    worker.onmessage = (e: MessageEvent<string>) => {
      handleLine(e.data);
    };

    // Kick off UCI initialisation — the engine will respond with 'uciok'.
    worker.postMessage('uci');

    return () => {
      // Pitfall 4: always stop + terminate on unmount to prevent CPU/battery drain.
      worker.postMessage('stop');
      worker.terminate();
      workerRef.current = null;
      // Reset readiness + state machine so a re-enable waits for the NEW worker's
      // readyok (which follows the `setoption MultiPV` sent on uciok). Bug (155 UAT):
      // isReady survived the toggle, so on re-enable analyze() fired a `go` on the
      // fresh worker BEFORE it had received `setoption MultiPV value 2` — the
      // re-search ran at MultiPV=1, painting only the best-move arrow (no 2nd-best)
      // until the next position change re-triggered a search post-init.
      setIsReady(false);
      isReadyRef.current = false;
      stateRef.current = 'idle';
      stopPendingRef.current = false;
    };
  }, [enabled]); // re-run only if enabled toggles

  // ─── Debounced FEN → analyze ───────────────────────────────────────────────

  // Trigger analysis when both (a) debouncedFen is set AND (b) engine is ready.
  // Using isReady as a dep ensures the effect re-fires when the engine finishes
  // its init sequence (even if debouncedFen was already set before init completed).
  useEffect(() => {
    if (!debouncedFen || !isReady) return;
    analyze(debouncedFen);
  }, [debouncedFen, isReady, analyze]);

  // ─── Tab-hide pause (D-04) ─────────────────────────────────────────────────

  useEffect(() => {
    function handleVisibility(): void {
      const worker = workerRef.current;
      if (!worker || !isReadyRef.current) return;

      if (document.visibilityState === 'hidden') {
        if (stateRef.current === 'thinking') {
          worker.postMessage('stop');
          stopPendingRef.current = true;
          stateRef.current = 'stopping';
        }
      } else {
        // Visible again — re-analyze the current position (auto re-go, D-04).
        const current = currentFenRef.current;
        if (current) {
          analyzeRef.current(current);
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibility);
    return () =>
      document.removeEventListener('visibilitychange', handleVisibility);
  }, []); // stable refs — no deps required

  // ─── Return ────────────────────────────────────────────────────────────────

  return { evalCp, evalMate, pvLines, depth, isAnalyzing, isReady, currentFen };
}
