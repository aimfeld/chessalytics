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
import * as Sentry from '@sentry/react';
import { parseInfoLine } from './uciParser';
import type { PvLine } from './uciParser';
import {
  markEngineAssetFailed,
  markEngineAssetPending,
  markEngineAssetReady,
  reportEngineAssetProgress,
} from '@/lib/engine/engineAssetProgress';
import {
  createStockfishWorker,
  ensureStockfishWorkerUrl,
} from '@/lib/engine/stockfishWorkerSource';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Primary wall-clock search cap (milliseconds). Locked by ROADMAP SC#2. */
const MOVETIME_MS = 1500;

/** Secondary node-count valve — hardware-independent safety bound. */
const MAX_NODES = 2000000;

/** Rapid-step debounce window (ms): coalesces held arrow-key auto-repeat to one search. */
const RAPID_STEP_DEBOUNCE_MS = 150;

/** Number of candidate lines requested from the engine. */
const MULTIPV = 2;

/**
 * Bug fix (quick 260731-s0z, FIX-6): trailing-throttle window for
 * `pvLines`/`evalCp` commits during a search. Numerically equal to
 * `RAPID_STEP_DEBOUNCE_MS` but a DISTINCT mechanism — that debounces INPUT
 * (FEN navigation), this throttles OUTPUT (pvLines commits, ~20-40 info
 * lines per search each re-rendering the whole Analysis page). Do not
 * conflate the two — same warning `useFlawChessEngine.ts` carries for its
 * own onSnapshot throttle.
 */
const PV_COMMIT_THROTTLE_MS = 150;

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

  /**
   * FIX-6 (quick 260731-s0z): handle for the pending trailing pvLines commit
   * scheduled by `commitPvSnapshotThrottled`, or null when none is scheduled.
   */
  const pvCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** FIX-6: timestamp (ms) of the last committed pvLines snapshot — drives the trailing throttle. */
  const lastPvCommitAtRef = useRef(0);

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

  /**
   * FIX-6 (quick 260731-s0z): cancels a scheduled trailing pvLines commit, if
   * any. Declared ABOVE the FEN-change effect (and every other caller) so
   * every path that supersedes or ends the current search can reach it: the
   * FEN-change effect below, `analyze()`'s `'thinking'` stop branch, the
   * `bestmove` `stopPending` discard branch, the final `bestmove` (an
   * unconditional flush, not just a clear), and the worker-lifecycle
   * cleanup. Without clearing it on every one of those paths, a trailing
   * timer can fire between a stop and the next `analyze()`'s
   * `pvMapRef.current.clear()` and commit the previous position's lines —
   * the same defect FIX-5 fixes, arriving by a different route. Stable
   * (empty deps) — only touches a ref.
   */
  const clearPendingPvCommit = useCallback(() => {
    if (pvCommitTimerRef.current !== null) {
      clearTimeout(pvCommitTimerRef.current);
      pvCommitTimerRef.current = null;
    }
  }, []);

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
   *
   * Bug fix (quick 260803-iv6): `debouncedFen` is wrapped in a `{ fen, nonce }`
   * object (a fresh literal every commit) rather than the bare fen string.
   * A caller whose `fen` prop OSCILLATES back to a value already held in
   * `debouncedFen` — e.g. the Train eval bar's FEN briefly revisiting the
   * puzzle's post-move position when a reveal-line step happens to replay the
   * exact move that was just played — used to hit React's `Object.is`
   * same-value bailout on `setDebouncedFen(fen)`: the RESET branch below
   * (`setEvalCp(null)` etc.) still ran (unconditional), but the debounced
   * commit that would have re-populated it never re-fired, since the
   * `[debouncedFen, isReady, analyze]` effect's dependency never actually
   * changed value. The result was a PERMANENTLY stuck neutral eval for that
   * FEN. The nonce guarantees a new object reference on every fen-effect run,
   * so the downstream analyze effect always re-fires when intended,
   * regardless of value coincidence.
   */
  const debounceNonceRef = useRef(0);
  const [debouncedTarget, setDebouncedTarget] = useState<{ fen: string | null; nonce: number } | null>(
    null,
  );
  const debouncedFen = debouncedTarget?.fen ?? null;
  const setDebouncedFen = useCallback((nextFen: string | null) => {
    debounceNonceRef.current += 1;
    setDebouncedTarget({ fen: nextFen, nonce: debounceNonceRef.current });
  }, []);
  useEffect(() => {
    // Bug fix (quick 260731-s0z, FIX-5): stop a still-thinking search for the
    // PREVIOUS position BEFORE this effect's own state clears below. Without
    // this, nothing stopped the superseded search on the RAPID (debounced)
    // path — for up to RAPID_STEP_DEBOUNCE_MS its info lines (and possibly
    // its bestmove) could commit into state while `currentFen` already
    // pointed at the new position, violating the documented `currentFen`
    // contract above. Reuses the exact same Layer B discard machinery
    // analyze()'s busy branch below already uses: the bestmove+stopPending
    // handler re-analyzes currentFenRef.current once the stale bestmove
    // lands, and analyze()'s 'stopping' early-return (FLAWCHESS-7V) absorbs
    // the debounced call that arrives in the meantime. Guarded on 'thinking'
    // only (never 'stopping') — sending a second stop while one is already
    // in flight is the exact FLAWCHESS-7V hazard shape.
    const worker = workerRef.current;
    if (worker && isReadyRef.current && stateRef.current === 'thinking') {
      worker.postMessage('stop');
      stopPendingRef.current = true;
      stateRef.current = 'stopping';
    }
    // FIX-6: cancel any pending trailing pv commit — it belongs to the
    // position we are about to leave (same invariant every other
    // search-superseding/ending path below honors).
    clearPendingPvCommit();

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
    // setDebouncedFen is a stable useCallback([]) — listed for exhaustive-deps
    // without churn.
  }, [fen, clearPendingPvCommit, setDebouncedFen]);

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
      // FIX-6 (quick 260731-s0z): this search is being superseded — cancel
      // any pending trailing pv commit so it cannot land after the next
      // analyze() clears pvMapRef.
      clearPendingPvCommit();
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
  }, [clearPendingPvCommit]); // stable — clearPendingPvCommit is itself a stable ([]) callback

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

    // Phase 213-08 (G-213-35): an unmount that beats the shared fetch must
    // not construct (and immediately leak) a worker nobody will ever clean
    // up — this effect's own cleanup runs once, synchronously, on unmount;
    // `cancelled` lets the deferred `setupWorker` continuation below notice
    // that has already happened.
    let cancelled = false;

    // CR-02 (213-REVIEW.md): register 'stockfish-wasm' as in-flight the
    // moment this effect starts spawning, BEFORE any of its async
    // progress/ready messages can arrive — closes the same race
    // `workerPool.ts::ensureSpawned()` closes for its own slots (see
    // `markEngineAssetPending`'s doc comment). Idempotent, so calling it here
    // in addition to `ensureStockfishWorkerUrl()`'s own (also synchronous)
    // registration is harmless — the second call is a no-op.
    markEngineAssetPending('stockfish-wasm');

    function setupWorker(sharedUrl: string | null): void {
      if (cancelled) return;

      // Phase 213-08 (G-213-35): construct through the shared source module
      // rather than a bare `new Worker(ENGINE_PATH)` — a non-null `sharedUrl`
      // routes this worker to the already-fetched-once `.wasm` via the
      // glue's own location-hash override; a null `sharedUrl` (shared fetch
      // never started or failed) still passes the versioned wasm path
      // through that same override (D-05, quick 260905-rhc) rather than
      // falling back to an unversioned URL (T-213-07).
      const worker = createStockfishWorker(sharedUrl);
      workerRef.current = worker;

      // Bug fix (CR-01, 213-REVIEW.md): an async script-load failure (404, CSP
      // block, syntax error) never throws a catchable JS exception on the main
      // thread — it only surfaces here (mirrors workerPool.ts's createSlot()
      // onerror). Without this handler such a failure was completely
      // invisible: no Sentry event, `isReady` never became `true`, and the
      // shared 'stockfish-wasm' asset store never learned about it either.
      worker.onerror = () => {
        Sentry.captureException(new Error('Stockfish engine worker: worker load failure'), {
          tags: { source: 'stockfish-engine' },
        });
        markEngineAssetFailed('stockfish-wasm');
      };

      // Phase 213 D-01/T-213-01/T-213-07: wire the vendored glue's own,
      // already-shipped `progressPort` protocol — same shape as
      // `workerPool.ts::createSlot()`'s wiring, copied verbatim rather than
      // reinvented, so the standalone Stockfish worker used by the analysis
      // board reports download bytes under the same 'stockfish-wasm' asset id.
      // The glue already streams the `.wasm` internally; this is wiring, not a
      // second fetch (213-RESEARCH.md Pitfall 4). Feature-detect
      // `MessageChannel` and skip the wiring when absent — a missing progress
      // bar must never break engine spawn. Kept UNCONDITIONALLY (Phase 213-08)
      // even on the non-null shared-URL path: it is the ONLY progress source
      // on the degraded null-URL path, and a worker built from the shared URL
      // simply reports a redundant, harmless "already done" stream.
      if (typeof MessageChannel !== 'undefined') {
        const { port1, port2 } = new MessageChannel();
        port1.onmessage = (e: MessageEvent<{ loaded: number; total: number }>) => {
          const { loaded, total } = e.data;
          reportEngineAssetProgress('stockfish-wasm', loaded, total);
        };
        worker.postMessage({ progressPort: port2 }, [port2]);
      }

      runWorkerHandshake(worker);
    }

    /**
     * Wires the UCI line handler and kicks off the handshake for `worker`.
     * Split out of `setupWorker` (Phase 213-08) purely to keep that function
     * under the CLAUDE.md nesting/LOC limits — behavior is unchanged from the
     * pre-refactor inline body.
     */
    function runWorkerHandshake(worker: Worker): void {
      /**
       * Commit the current pvMapRef snapshot to state (white-POV normalized),
       * immediately, bypassing the FIX-6 throttle below. Called by
       * `commitPvSnapshotThrottled`'s immediate branch and trailing timer, and
       * unconditionally on the final (non-stale) `bestmove` (that flush must
       * never be delayed or dropped). The info-line stale guard (stateRef !==
       * 'thinking' || stopPendingRef) ensures the THROTTLED entry point is
       * never called for a superseded search; this function itself does no
       * staleness check of its own, matching its pre-FIX-6 behavior.
       *
       * Pitfall 5 note: bound filtering is intentionally relaxed — lowerbound and
       * upperbound lines paint immediately so the eval sharpens in place as depth
       * climbs. The eval may visibly bounce ~200-300ms; this is accepted
       * (lichess-style live streaming behavior).
       */
      function commitPvSnapshotNow(): void {
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
        lastPvCommitAtRef.current = Date.now();
      }

      /**
       * FIX-6 (quick 260731-s0z): trailing-throttled entry point the info-line
       * branch calls instead of committing on every line (~20-40 per search,
       * each one re-rendering the whole Analysis page). Immediate commit when
       * the last commit is older than PV_COMMIT_THROTTLE_MS (mirrors
       * useFlawChessEngine's onSnapshot throttle) — this is what keeps the
       * FIRST info line of a search painting immediately (lastPvCommitAtRef
       * starts at 0). Otherwise schedules exactly one trailing commit that
       * calls commitPvSnapshotNow at FIRE time (re-reading pvMapRef fresh, not
       * a captured snapshot), so it always reflects whatever accumulated while
       * it waited.
       */
      function commitPvSnapshotThrottled(): void {
        const now = Date.now();
        const sinceLast = now - lastPvCommitAtRef.current;
        if (sinceLast > PV_COMMIT_THROTTLE_MS) {
          commitPvSnapshotNow();
          return;
        }
        if (pvCommitTimerRef.current !== null) return; // trailing commit already scheduled
        pvCommitTimerRef.current = setTimeout(() => {
          pvCommitTimerRef.current = null;
          commitPvSnapshotNow();
        }, PV_COMMIT_THROTTLE_MS);
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
          // Phase 213 D-01: the real readiness signal for the shared asset
          // store — this standalone worker's UCI handshake completing means
          // the .wasm is loaded and the engine is usable.
          markEngineAssetReady('stockfish-wasm');
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
            // FIX-6: throttled, not committed on every line.
            commitPvSnapshotThrottled();
          }
          return;
        }

        if (line.startsWith('bestmove')) {
          if (stopPendingRef.current) {
            // Layer B discard (Pitfall 3): this bestmove is the termination
            // response to our stop — it reflects the previous position, not the
            // current one. Discard and re-analyze the current FEN (unless hidden).
            // FIX-6: also cancel any pending trailing pv commit — it belongs
            // to the position being discarded here.
            clearPendingPvCommit();
            stopPendingRef.current = false;
            stateRef.current = 'idle';
            const current = currentFenRef.current;
            if (current && document.visibilityState !== 'hidden') {
              analyzeRef.current(current);
            }
            return;
          }

          // Non-stale bestmove: cancel any pending trailing commit and flush
          // the final pvMap snapshot immediately and unconditionally (FIX-6 —
          // the final snapshot must never be delayed or dropped), then mark idle.
          clearPendingPvCommit();
          commitPvSnapshotNow();
          stateRef.current = 'idle';
          setIsAnalyzing(false);
        }
      }

      worker.onmessage = (e: MessageEvent<string>) => {
        handleLine(e.data);
      };

      // Kick off UCI initialisation — the engine will respond with 'uciok'.
      worker.postMessage('uci');
    }

    ensureStockfishWorkerUrl().then(setupWorker);

    return () => {
      cancelled = true;
      // Phase 213-08: the shared-URL promise may not have resolved yet — if
      // `setupWorker` never ran, there is no worker to stop/terminate, and
      // `cancelled` above stops the deferred continuation from constructing
      // one after this cleanup has already run.
      const worker = workerRef.current;
      if (worker) {
        // Pitfall 4: always stop + terminate on unmount to prevent CPU/battery drain.
        worker.postMessage('stop');
        worker.terminate();
        workerRef.current = null;
      }
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
      // FIX-6 (quick 260731-s0z): cancel any pending trailing pv commit — a
      // worker teardown (unmount/disable) must not leave a stale timer that
      // fires after this worker (and its pvMapRef data) are gone.
      clearPendingPvCommit();
    };
  }, [enabled, clearPendingPvCommit]); // re-run only if enabled toggles

  // ─── Debounced FEN → analyze ───────────────────────────────────────────────

  // Trigger analysis when both (a) debouncedFen is set AND (b) engine is ready.
  // Using isReady as a dep ensures the effect re-fires when the engine finishes
  // its init sequence (even if debouncedFen was already set before init completed).
  //
  // Bug fix (quick 260803-iv6): depends on `debouncedTarget` (the nonce-tagged
  // object, a fresh reference every commit) rather than the derived
  // `debouncedFen` string — depending on the bare string would reintroduce the
  // exact same-value bailout `setDebouncedFen` was just fixed to avoid.
  useEffect(() => {
    if (!debouncedFen || !isReady) return;
    analyze(debouncedFen);
  }, [debouncedTarget, debouncedFen, isReady, analyze]);

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
