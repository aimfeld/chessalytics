/**
 * useTrainGradingEngine — session-scoped single-Worker Stockfish grading
 * engine for the Train solve loop (SOLV-03).
 *
 * Mirrors useStockfishEngine.ts's classic (non-module) Worker lifecycle and
 * idle/thinking/stopping UCI state machine (190-RESEARCH.md Pattern 4), but
 * exposes an IMPERATIVE surface instead of a fen-prop-driven one: the caller
 * explicitly starts/aborts a search per puzzle (`startGrading`/`abortGrading`)
 * rather than relying on mount/unmount, because the search must outlive a
 * per-puzzle component key change (190-RESEARCH.md Pitfall 3).
 *
 * Exactly ONE Worker exists for the whole session — created once when the
 * solve loop mounts (`enabled` toggled at the SESSION boundary, never per
 * puzzle — 190-RESEARCH.md Pattern 4 / Pitfall 2).
 *
 * Grading rule (190-RESEARCH.md Pattern 2 — TrainPuzzle carries no answer key,
 * P-01, so the client's own search grades the attempt; two regimes as of
 * Phase 211):
 *   mover = sideToMoveFromFen(fen)
 *   esBefore = evalToExpectedScore(bestSearch.evalCp, bestSearch.evalMate, mover)
 *   playedMoveUci === bestSearch.bestMoveUci -> esAfter = esBefore, no 2nd search
 *     (the exact-match fast path, unchanged)
 *   else -> run ONE full-budget width-1 search on the post-move FEN, esAfter
 *     with the SAME mover
 *   severity = classifyLiveSeverity(esBefore, esAfter)
 *   moveTier = moveTierFromSeverity(severity)  (SEED-119: good/inaccuracy/wrong)
 * The mount search itself is width 1 (Phase 211 D-05): this hook proposes NO
 * alternative moves — the "Also fine" set is certified SERVER-side from the
 * stored deep answer key, and when the played move is one of the server's
 * certified key moves, record_solve OVERRIDES the tier this hook computed
 * (Phase 211 D-07).
 * Accepted residual (Phase 211 D-04): an OFF-KEY played move is graded
 * best-effort by this live engine and can still disagree with the analysis
 * board's deeper verdict; the top-K deep-eval blob extension that would close
 * that gap is explicitly out of scope.
 * Never re-derive the sigmoid/threshold locally — both come from
 * `@/lib/liveFlaw` (CI-drift-checked against app/services/flaws_service.py).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { parseInfoLine, parseBestmove, dedupePvLinesByFirstMove, rankLineForMove } from './uciParser';
import type { PvLine } from './uciParser';
import { classifyLiveSeverity, evalToExpectedScore, sideToMoveFromFen } from '@/lib/liveFlaw';
import type { MoverColor } from '@/lib/liveFlaw';
import { moveTierFromSeverity } from '@/lib/trainScore';
import type { TrainMoveTier } from '@/lib/trainScore';
import {
  createStockfishWorker,
  ensureStockfishWorkerUrl,
} from '@/lib/engine/stockfishWorkerSource';

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Grading search budget — MEASURED 2026-07-25 via
 * `node scripts/measure-train-movetime.mjs` (ladder 500/1000/1500/2500ms,
 * node cap 2,000,000, against 10 real sharp-blunder FENs extracted from
 * this project's own dev DB — see the script's FENS comment for
 * provenance). Stability defined as: same best move AND expected-score
 * reading within `INACCURACY_DROP / 2` of the 2500ms baseline run (raw cp
 * is naturally noisy even at a fixed movetime — project_eval_nondeterminism
 * — so exact-cp equality is the wrong bar; ES is what the grading decision
 * actually consumes).
 *
 * Result: the engine's TOP MOVE was identical to the baseline at every
 * movetime for all 10 FENs (0 disagreements) — the fast-path exact-match
 * check (D-06) is unaffected by movetime in this sample. ES stability
 * (score) reached the baseline by 1000ms for every FEN, worst case; two
 * FENs needed 1000ms specifically (max ES diff at 500ms: 0.089 on one
 * sharp rook-endgame FEN), the rest were stable already at 500ms. Kept the
 * existing 1500ms value rather than lowering it: one full rung of margin
 * above the measured 1000ms floor, generous for sharp-puzzle accuracy
 * without materially changing the D-06 "Checking your move…" wait
 * (worst case: two sequential 1500ms searches on a non-exact-match
 * puzzle). See 190-01-SUMMARY.md for the full per-FEN table.
 */
export const TRAIN_GRADING_MOVETIME_MS = 1500;
export const TRAIN_GRADING_MAX_NODES = 2000000;

/**
 * Mount-search width and movetime. Width 1 as of Phase 211 (D-05):
 * alternatives ("Also fine" moves) are now certified SERVER-side from the
 * stored deep answer key (soft `su`, herring good-band ladder), so the mount
 * search no longer proposes any — the only consumers of this search are the
 * best move, `esBefore`, and the displayed solution PV. The full
 * `TRAIN_GRADING_MOUNT_MOVETIME_MS` budget therefore goes to ONE line instead
 * of being split four ways, which is the accuracy argument for the change: a
 * deeper best line and steadier esBefore from the same wall-clock budget.
 *
 * The width-4 sweep that previously justified this constant (measured
 * 2026-07-26 via `node scripts/measure-train-movetime.mjs`) is retained in
 * 190.1-02-SUMMARY.md and is no longer the reason for this value. The
 * movetime constants are unchanged — no new number is invented by Phase 211.
 */
export const TRAIN_GRADING_MULTIPV_WIDTH = 1;
export const TRAIN_GRADING_MOUNT_MOVETIME_MS = TRAIN_GRADING_MOVETIME_MS;

/**
 * Hard ceiling on `gradeMove`'s returned promise (Phase 190-01 checkpoint
 * bug fix — manual browser UAT hit an indefinite "Checking your move…"
 * hang). Generous above the worst case (two sequential
 * `TRAIN_GRADING_MOVETIME_MS` searches plus WASM/message-passing overhead)
 * so it never fires under normal operation, but finite so a genuinely wedged
 * engine (a dead Worker, a StrictMode double-invoke race, a search that
 * never emits `bestmove`) always resolves to a visible error state instead
 * of a silent infinite spinner.
 */
export const TRAIN_GRADING_TIMEOUT_MS = 8000;

// ─── Types ──────────────────────────────────────────────────────────────────

type EngineState = 'idle' | 'thinking' | 'stopping';

interface RawSearchResult {
  /** White-POV centipawns (already sign-normalized for the searched FEN). */
  evalCp: number | null;
  evalMate: number | null;
  bestMoveUci: string | null;
  /** UCI moves following the top (multipv 1) line's `pv` keyword — mover-POV
   * move list, not sign-dependent (190.1-01: captured for the reveal-time
   * lines, previously parsed but discarded). */
  pv: string[];
  /**
   * Every rank the engine returned for this search, sorted by `multipv`
   * ascending and white-POV sign-normalized (190.1-02 D-01 point 1). As of
   * Phase 211 (D-05) EVERY search this hook dispatches — mount, after-move,
   * reveal-time — is width 1, so this normally holds exactly one entry
   * (rank 1, whose convenience values are `evalCp`/`evalMate`/`pv` above).
   * The array shape is kept because the commit path is width-agnostic and
   * `startGameMoveSearch`'s reveal-time exact-UCI lookup (211-02 consumer
   * ledger row 4) still reads it; it no longer leaves this hook — Plan
   * 211-03 deleted `GradeResult`'s rank-lines field once the free-play seed
   * seam switched to the served vetted list (D-06). Never assume
   * `lines.length` equals the requested width: the engine returns only as
   * many ranks as there are legal moves and never pads — nor that every
   * rank holds a DISTINCT move before `dedupePvLinesByFirstMove` runs at
   * commit time (see that helper for the cross-iteration staleness this
   * drops); after it, every entry's first move is unique.
   */
  lines: PvLine[];
}

interface BestSearchResult extends RawSearchResult {
  fen: string;
  generation: number;
}

interface QueuedDispatch {
  fen: string;
  generation: number;
  /** MultiPV width to request for this dispatch — travels WITH the deferred
   * dispatch (190.1-02) rather than being fixed at call time, since the
   * mount search (width TRAIN_GRADING_MULTIPV_WIDTH) and every other search
   * (width 1) share the same stop/queue serialization. */
  width: number;
  movetimeMs: number;
  resolve: (result: RawSearchResult) => void;
  reject: (error: Error) => void;
}

export interface GradeResult {
  /** SEED-119: the three-way move-quality tier, derived from
   * `classifyLiveSeverity` via `moveTierFromSeverity` — never a re-derived
   * boolean. `moveTier !== 'wrong'` is what feeds the SR ladder verdict. */
  moveTier: TrainMoveTier;
  bestMoveUci: string | null;
  esBefore: number;
  esAfter: number;
  /** The MultiPV mount search's rank-1 line (190.1-02 D-01 point 1), derived
   * without any additional search. */
  bestLine: TrainEngineLine;
  /**
   * The played move's own line. On the exact-match fast path this is exactly
   * `bestLine` — rank 1 IS the played move's line. Otherwise it comes from
   * the after-move grading search (`[playedMoveUci, ...afterSearch.pv]`,
   * 190.1-02 D-01 point 2), with the displayed eval clamped to never read
   * better than `bestLine`'s.
   */
  playedLine: TrainEngineLine;
}

/**
 * One reveal-time engine line (190.1-01, D-01/D-03). `moves` are UCI strings
 * rooted at the PUZZLE's fen — not the position after any move — the
 * invariant shared by all three reveal lines (YOUR MOVE / BEST MOVE /
 * PLAYED IN GAME) so a single replay-from-puzzle-fen call always applies.
 * `evalCp`/`evalMate` are white-POV, matching every other eval in this file.
 */
export interface TrainEngineLine {
  moves: string[];
  evalCp: number | null;
  evalMate: number | null;
}

export interface UseTrainGradingEngineOptions {
  /** Session-scoped enable — created once per session, never per puzzle. */
  enabled: boolean;
}

export interface TrainGradingEngine {
  isReady: boolean;
  /** True once the Worker has reported a genuine error (failed to load/
   * crashed) — surfaced so callers can show an error state rather than
   * silently retry against a dead engine. */
  hasError: boolean;
  /** Start the "find the best move" search for a puzzle's FEN. */
  startGrading: (fen: string) => void;
  /** Cancel any in-flight/pending search for the current puzzle (Pitfall 3). */
  abortGrading: () => void;
  /**
   * Tear down the current Worker and spin up a fresh one (190-04 T-190-13:
   * the engine-failure fallback's retry affordance). Clears `hasError` so a
   * genuinely recovered engine is usable again; the caller must re-issue
   * `startGrading` for the current puzzle afterwards.
   */
  restartEngine: () => void;
  /**
   * Resolve the grading verdict for a played move against the fen most
   * recently passed to `startGrading`. Awaits the best-move search if it
   * has not yet settled. Rejects if grading does not complete within
   * `TRAIN_GRADING_TIMEOUT_MS` or the engine reports an error — callers
   * MUST catch this (never treated as "still loading" indefinitely).
   */
  gradeMove: (fen: string, playedMoveUci: string) => Promise<GradeResult>;
  /**
   * Reveal-time search for the PLAYED IN GAME box (190.1-01, D-01 point 3):
   * derives the position after `gameMoveUci` (rejecting on an illegal/
   * malformed move) and runs a fresh single-line search on it. Resolves a
   * `TrainEngineLine` rooted at `puzzleFen` — see that interface's doc
   * comment for the shared invariant. Reuses the SAME `generationRef` as
   * `startGrading`/`gradeMove` (no second cancellation authority).
   */
  startGameMoveSearch: (puzzleFen: string, gameMoveUci: string) => Promise<TrainEngineLine>;
}

/** Build the `bestLine` field from a settled mount search: rank 1's PV,
 * falling back to a single-element array containing the bestmove token when
 * the PV is empty (190.1-02 D-01 point 1). */
function bestLineFrom(best: BestSearchResult): TrainEngineLine {
  const moves = best.pv.length > 0 ? best.pv : best.bestMoveUci !== null ? [best.bestMoveUci] : [];
  return { moves, evalCp: best.evalCp, evalMate: best.evalMate };
}

/**
 * Bug fix (190.1 UAT round 9; rationale narrowed by Phase 211): a played/game
 * move evaluated by its own after-move search occasionally READS better than
 * the best move (e.g. your Ke4 −4.5 vs best Ke5 −4.0). With the mount search
 * at width 1 (Phase 211 D-05) the node budget is no longer split across
 * ranks, so the surviving causes are the after-move search spending its
 * budget one ply DEEPER than the mount search, and ordinary cross-search cp
 * variance in decided positions (project_eval_nondeterminism). The verdict
 * already treats "better than best" as correct; this clamp only stops the
 * DISPLAYED eval from contradicting the "best move" label. From the mover's
 * POV the shown eval is capped at the best line's eval; the line's moves are
 * untouched.
 */
function clampLineEvalToBest(
  line: TrainEngineLine,
  best: TrainEngineLine,
  mover: MoverColor,
): TrainEngineLine {
  const esLine = evalToExpectedScore(line.evalCp, line.evalMate, mover);
  const esBest = evalToExpectedScore(best.evalCp, best.evalMate, mover);
  if (esLine <= esBest) return line;
  return { ...line, evalCp: best.evalCp, evalMate: best.evalMate };
}

/** Convert a UCI move string ("e2e4", "e7e8q") applied to `fen` into the
 * resulting FEN, or null on illegal/malformed input. */
function fenAfterUciMove(fen: string, uci: string): string | null {
  if (uci.length < 4) return null;
  try {
    const chess = new Chess(fen);
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
    });
    if (!move) return null;
    return chess.fen();
  } catch {
    return null;
  }
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useTrainGradingEngine({
  enabled,
}: UseTrainGradingEngineOptions): TrainGradingEngine {
  const workerRef = useRef<Worker | null>(null);
  const isReadyRef = useRef(false);
  const [isReady, setIsReady] = useState(false);
  const hasErrorRef = useRef(false);
  const [hasError, setHasError] = useState(false);
  /** Bumped by restartEngine() to force the Worker-lifecycle effect below to
   * tear down and recreate the Worker (190-04 engine-failure fallback). */
  const [restartGeneration, setRestartGeneration] = useState(0);

  /** Internal UCI state machine — mirrors useStockfishEngine.ts. */
  const stateRef = useRef<EngineState>('idle');
  /** True while awaiting the termination bestmove of an explicit `stop`. */
  const stopPendingRef = useRef(false);
  /** Latest dispatch request deferred until a `stop`-in-flight settles. */
  const queuedDispatchRef = useRef<QueuedDispatch | null>(null);
  /** Bug fix (CR-01): latest dispatch request deferred until the Worker's UCI
   * handshake actually completes (`readyok`). Before this fix, `search()`
   * resolved immediately with a fabricated `{evalCp: null, evalMate: null,
   * bestMoveUci: null}` whenever it was invoked before `isReadyRef.current`
   * flipped true — a completely normal state for the first puzzle of a
   * session, since WASM boot + handshake takes real wall-clock time. That
   * fabricated result permanently "settled" the puzzle's best-search: graded
   * against a neutral eval unrelated to the real position, and the D-06
   * exact-match fast path could never trigger (bestMoveUci stayed null). Only
   * the LATEST request matters if `search()` is called again before ready. */
  const pendingReadyDispatchRef = useRef<QueuedDispatch | null>(null);

  /** Bumped by startGrading/abortGrading; used to discard a superseded
   * search's result (Pitfall 3 — a stale verdict must never leak into the
   * next puzzle's state). */
  const generationRef = useRef(0);

  /** Resolver/rejecter + metadata for whichever `go` is currently in flight. */
  const pendingRef = useRef<{
    generation: number;
    whitePovSign: 1 | -1;
    resolve: (result: RawSearchResult) => void;
    reject: (error: Error) => void;
  } | null>(null);
  /** In-flight MultiPV map: keyed by multipv index, updated on exact info
   * lines (190.1-02, mirrors useStockfishEngine.ts's pvMapRef). Raw
   * (mover-POV, not yet sign-normalized) — cleared in `dispatchNow`, read
   * and sign-normalized once at `bestmove` to build the settled `lines`
   * array. A width-1 search still populates exactly one entry (rank 1). */
  const pvMapRef = useRef<Map<number, PvLine>>(new Map());

  /** The settled "find best move" search for the puzzle most recently passed
   * to startGrading. */
  const bestSearchRef = useRef<BestSearchResult | null>(null);
  /** Resolves once the CURRENT generation's best-search settles; gradeMove
   * awaits this so it works even if called before the search finishes. */
  const bestSearchReadyRef = useRef<Promise<void>>(Promise.resolve());

  // ─── Low-level dispatch (refs only — stable across renders) ───────────────

  const dispatchNow = useCallback(
    (
      fen: string,
      generation: number,
      resolve: (r: RawSearchResult) => void,
      reject: (error: Error) => void,
      width: number,
      movetimeMs: number,
    ) => {
      const worker = workerRef.current;
      if (!worker) {
        reject(new Error('Grading engine unavailable'));
        return;
      }
      pvMapRef.current.clear();
      const whitePovSign: 1 | -1 = fen.split(' ')[1] === 'b' ? -1 : 1;
      pendingRef.current = { generation, whitePovSign, resolve, reject };
      // 190.1-02 D-01 point 1: setoption FIRST, before position/go, so it
      // inherits this state machine's existing idle/thinking/stopping
      // serialization for free — no separate ordering concern. Sent for
      // EVERY dispatch (width 1 included) so the width always travels with
      // the dispatch rather than assuming a prior value survived.
      worker.postMessage(`setoption name MultiPV value ${width}`);
      worker.postMessage(`position fen ${fen}`);
      worker.postMessage(`go movetime ${movetimeMs} nodes ${TRAIN_GRADING_MAX_NODES}`);
      stateRef.current = 'thinking';
    },
    [],
  );

  /** Serialized search dispatch — no restricted-move clause (a free
   * MultiPV-width search on an arbitrary FEN). If the engine is mid-search,
   * sends `stop` and defers this dispatch until the stale bestmove settles.
   * Rejects immediately if the engine has already reported a fatal error.
   * `width`/`movetimeMs` travel WITH the dispatch (190.1-02) so a deferred
   * dispatch (queued behind a stop or the initial readyok handshake) still
   * requests the width/budget its caller asked for. */
  const search = useCallback(
    (fen: string, generation: number, width: number, movetimeMs: number): Promise<RawSearchResult> =>
      new Promise((resolve, reject) => {
        const worker = workerRef.current;
        if (hasErrorRef.current) {
          reject(new Error('Grading engine failed to load'));
          return;
        }
        if (!worker || !isReadyRef.current) {
          // Bug fix (CR-01): queue and dispatch once readyok arrives (see
          // readyok's handler in handleLine below) instead of resolving with
          // a fabricated result that permanently "settles" this generation.
          //
          // This covers TWO states, both real and both eventually resolved
          // by the SAME `readyok` drain below, since `enabled` never flips
          // back to false mid-session (Train.tsx passes a constant `true`):
          // (1) the Worker exists but hasn't finished its UCI handshake yet
          // (slow WASM fetch/init — a completely normal state for the very
          // first puzzle of a session); (2) the Worker doesn't even EXIST
          // yet (`workerRef.current` is still null) — a GUARANTEED state on
          // first mount in production, because React commits a CHILD
          // component's mount effects (TrainSolveScreen's own effect, which
          // calls startGrading) before an ANCESTOR's effects (this hook's
          // own Worker-construction effect lives in Train.tsx, the parent).
          // Rejecting outright on `!worker` (as an earlier version of this
          // fix did) broke every very first puzzle of every session.
          pendingReadyDispatchRef.current = { fen, generation, width, movetimeMs, resolve, reject };
          return;
        }
        if (stateRef.current === 'thinking') {
          worker.postMessage('stop');
          stopPendingRef.current = true;
          stateRef.current = 'stopping';
          queuedDispatchRef.current = { fen, generation, width, movetimeMs, resolve, reject };
          return;
        }
        if (stateRef.current === 'stopping') {
          // Only the latest request matters once the stale bestmove settles.
          queuedDispatchRef.current = { fen, generation, width, movetimeMs, resolve, reject };
          return;
        }
        dispatchNow(fen, generation, resolve, reject, width, movetimeMs);
      }),
    [dispatchNow],
  );

  // ─── Worker lifecycle ───────────────────────────────────────────────────

  useEffect(() => {
    if (!enabled) return;

    // A restartEngine() call (or the initial mount) starts from a clean
    // error/ready state — a stale hasError from a PRIOR Worker instance must
    // never leak into the new one (190-04 engine-failure fallback).
    hasErrorRef.current = false;
    setHasError(false);

    // Phase 213-08 (G-213-35): an unmount that beats the shared fetch must
    // not construct (and immediately leak) a worker nobody will ever clean
    // up — mirrors useStockfishEngine.ts's identical guard.
    let cancelled = false;

    function setupWorker(sharedUrl: string | null): void {
      if (cancelled) return;

      // Classic (non-module) Worker — Emscripten glue uses self.onmessage /
      // self.postMessage. Do NOT pass { type: 'module' }. Phase 213-08:
      // constructed through the shared source module — a non-null
      // `sharedUrl` routes to the already-fetched-once `.wasm`; a null
      // `sharedUrl` constructs against the served path exactly as before.
      // This hook reports no asset progress today and does not start doing
      // so here — the only change is where the worker's `.wasm` comes from.
      const worker = createStockfishWorker(sharedUrl);
      workerRef.current = worker;

      runWorkerHandshake(worker);
    }

    /** Wires the UCI line handler and kicks off the handshake for `worker`. */
    function runWorkerHandshake(worker: Worker): void {
      function handleLine(line: string): void {
        if (line === 'uciok') {
          worker.postMessage('isready');
          return;
        }
        if (line === 'readyok') {
          setIsReady(true);
          isReadyRef.current = true;
          // CR-01: drain whatever search() call arrived while the Worker was
          // still completing its UCI handshake, exactly once, for real.
          const pendingReady = pendingReadyDispatchRef.current;
          pendingReadyDispatchRef.current = null;
          if (pendingReady) {
            dispatchNow(
              pendingReady.fen,
              pendingReady.generation,
              pendingReady.resolve,
              pendingReady.reject,
              pendingReady.width,
              pendingReady.movetimeMs,
            );
          }
          return;
        }
        if (line.startsWith('info ')) {
          if (stateRef.current !== 'thinking' || stopPendingRef.current) return;
          const parsed = parseInfoLine(line);
          // Bug fix (190.1 UAT round 4): drop lowerbound/upperbound lines
          // instead of letting them overwrite the map (uciParser Pitfall 5).
          // An aspiration-window fail at the end of the movetime budget emits
          // e.g. "info depth 20 ... upperbound ... pv <2 moves>" as the LAST
          // rank-1 line, clobbering the previous exact iteration's full PV —
          // verified against the vendored engine headlessly (depth-19 exact
          // 30-ply PV replaced by a depth-20 UB 2-ply PV). That made the
          // reveal's Your-move / Played-in-game lines often 2-3 moves long.
          // Every completed iteration emits exact lines for all ranks, so the
          // map is never left empty by this filter.
          if (parsed !== null && parsed.bound === 'exact') {
            pvMapRef.current.set(parsed.multipv, {
              multipv: parsed.multipv,
              depth: parsed.depth,
              moves: parsed.pv,
              evalCp: parsed.scoreCp,
              evalMate: parsed.scoreMate,
            });
          }
          return;
        }
        if (line.startsWith('bestmove')) {
          const bestMoveUci = parseBestmove(line);

          if (stopPendingRef.current) {
            // Termination response to an explicit stop — always discard its
            // content and fire whatever dispatch was queued behind it.
            stopPendingRef.current = false;
            stateRef.current = 'idle';
            pendingRef.current = null;
            const queued = queuedDispatchRef.current;
            queuedDispatchRef.current = null;
            if (queued) {
              dispatchNow(queued.fen, queued.generation, queued.resolve, queued.reject, queued.width, queued.movetimeMs);
            }
            return;
          }

          stateRef.current = 'idle';
          const pending = pendingRef.current;
          pendingRef.current = null;
          if (!pending) return;
          // 190.1-02: commit the accumulated MultiPV map — sorted by rank,
          // sign-normalized to white POV — exactly once, at bestmove. Never
          // assume the requested width was returned (Map may have fewer
          // entries than requested); a width-1 search still yields one entry.
          const lines: PvLine[] = dedupePvLinesByFirstMove(
            [...pvMapRef.current.values()].sort((a, b) => a.multipv - b.multipv),
          ).map((l) => ({
            ...l,
            evalCp: l.evalCp === null ? null : l.evalCp * pending.whitePovSign,
            evalMate: l.evalMate === null ? null : l.evalMate * pending.whitePovSign,
          }));
          const rank1 = lines[0];
          pending.resolve({
            evalCp: rank1 !== undefined ? rank1.evalCp : null,
            evalMate: rank1 !== undefined ? rank1.evalMate : null,
            bestMoveUci,
            pv: rank1 !== undefined ? rank1.moves : [],
            lines,
          });
        }
      }

      worker.onmessage = (e: MessageEvent<string>) => {
        handleLine(e.data);
      };

      // Bug fix (Phase 190-01 checkpoint): a Worker construction/load failure
      // (e.g. the vendored WASM asset 404s or the browser can't instantiate
      // it) previously left every pending/queued search unresolved forever —
      // gradeMove would hang on `await bestSearchReadyRef.current` with no
      // visible error. Surface it via `hasError` and reject anything waiting
      // immediately rather than making callers wait out the full
      // TRAIN_GRADING_TIMEOUT_MS on a definitively-dead engine.
      worker.onerror = () => {
        hasErrorRef.current = true;
        setHasError(true);
        stateRef.current = 'idle';
        stopPendingRef.current = false;
        const pending = pendingRef.current;
        pendingRef.current = null;
        pending?.reject(new Error('Grading engine failed to load'));
        const queued = queuedDispatchRef.current;
        queuedDispatchRef.current = null;
        queued?.reject(new Error('Grading engine failed to load'));
      };

      worker.postMessage('uci');
    }

    ensureStockfishWorkerUrl().then(setupWorker);

    return () => {
      cancelled = true;
      // Phase 213-08: the shared-URL promise may not have resolved yet — if
      // `setupWorker` never ran, there is no worker to stop/terminate, and
      // `cancelled` above stops the deferred continuation from constructing
      // one after this cleanup has already run. Every other reset below is
      // unconditional — it must happen whether or not a worker ever existed.
      const worker = workerRef.current;
      if (worker) {
        worker.postMessage('stop');
        worker.terminate();
        workerRef.current = null;
      }
      setIsReady(false);
      isReadyRef.current = false;
      stateRef.current = 'idle';
      stopPendingRef.current = false;
      pendingRef.current = null;
      queuedDispatchRef.current = null;
      pendingReadyDispatchRef.current = null;
    };
  }, [enabled, dispatchNow, restartGeneration]);

  // ─── Imperative surface ─────────────────────────────────────────────────

  const restartEngine = useCallback(() => {
    setRestartGeneration((g) => g + 1);
  }, []);

  const startGrading = useCallback(
    (fen: string) => {
      generationRef.current += 1;
      const generation = generationRef.current;
      bestSearchRef.current = null;
      let resolveReady: () => void = () => {};
      let rejectReady: (error: Error) => void = () => {};
      const readyPromise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      // Attach a no-op catch directly to the stored promise so a rejection
      // (engine error / superseded search) never surfaces as an unhandled
      // promise rejection — gradeMove is the one real consumer and it awaits
      // this exact promise, propagating the failure through its own reject path.
      readyPromise.catch(() => {});
      bestSearchReadyRef.current = readyPromise;
      // Phase 211 (D-05): the mount search is width 1 — the whole
      // TRAIN_GRADING_MOUNT_MOVETIME_MS budget goes to the single best line
      // (best move, esBefore, and the displayed solution PV). Alternatives
      // are server-certified; this search proposes none.
      search(fen, generation, TRAIN_GRADING_MULTIPV_WIDTH, TRAIN_GRADING_MOUNT_MOVETIME_MS)
        .then((raw) => {
          // Superseded by a later startGrading/abortGrading — discard silently
          // (Pitfall 3: never leak a stale verdict into the next puzzle).
          if (generation !== generationRef.current) return;
          bestSearchRef.current = { fen, generation, ...raw };
          resolveReady();
        })
        .catch((error: unknown) => {
          if (generation !== generationRef.current) return;
          rejectReady(error instanceof Error ? error : new Error('Grading search failed'));
        });
    },
    [search],
  );

  const abortGrading = useCallback(() => {
    generationRef.current += 1;
    bestSearchRef.current = null;
    queuedDispatchRef.current = null;
    pendingReadyDispatchRef.current = null;
    if (stateRef.current === 'thinking') {
      workerRef.current?.postMessage('stop');
      stopPendingRef.current = true;
      stateRef.current = 'stopping';
    }
  }, []);

  const gradeMoveInner = useCallback(
    async (fen: string, playedMoveUci: string): Promise<GradeResult> => {
      const generation = generationRef.current;
      await bestSearchReadyRef.current;
      const best = bestSearchRef.current;
      const mover = sideToMoveFromFen(fen);

      const emptyLine: TrainEngineLine = { moves: [], evalCp: null, evalMate: null };

      if (!best || best.generation !== generation || best.fen !== fen) {
        // Defensive fallback (should not happen when startGrading was called
        // for this exact fen) — never crash the solve loop. Resolves the GOOD
        // tier (SEED-119): a defensive path must never silently cost the
        // user move points.
        return {
          moveTier: 'good',
          bestMoveUci: null,
          esBefore: 0.5,
          esAfter: 0.5,
          bestLine: emptyLine,
          playedLine: emptyLine,
        };
      }

      const esBefore = evalToExpectedScore(best.evalCp, best.evalMate, mover);
      const bestLine = bestLineFrom(best);

      if (playedMoveUci === best.bestMoveUci) {
        // D-06 fast path: exact match to the engine's own top move — no
        // second search. playedLine IS bestLine here — rank 1 is the played
        // move's own line (190.1-02 D-01 point 2). An exact match to the
        // engine's own best move is unambiguously the GOOD tier.
        return {
          moveTier: 'good',
          bestMoveUci: best.bestMoveUci,
          esBefore,
          esAfter: esBefore,
          bestLine,
          playedLine: bestLine,
        };
      }

      // Phase 211 (D-05): the 190.1-round-9 mount-rank shortcut is GONE — a
      // played move that is neither the engine's own top move (exact-match
      // fast path above) nor a server-certified key is graded by the ONE
      // full-budget width-1 after-move search below. Its replacement is not a
      // client branch at all: a key move's tier is overridden by the SERVER
      // in record_solve (Plan 211-01, D-07). Accepted cost (SEED-150): a
      // non-best played move now ALWAYS incurs the second "Checking your
      // move…" search, where a mount-rank hit used to skip it.
      const afterFen = fenAfterUciMove(fen, playedMoveUci);
      if (afterFen === null) {
        // Defensive fallback (illegal/unparseable played move — should not
        // happen for a real board interaction) — resolves the GOOD tier
        // (SEED-119), never silently costing the user move points.
        return {
          moveTier: 'good',
          bestMoveUci: best.bestMoveUci,
          esBefore,
          esAfter: esBefore,
          bestLine,
          playedLine: bestLine,
        };
      }

      // 190.1-02 D-01 point 2: the after-move search's PV is captured into
      // playedLine instead of being discarded. Reached for EVERY played move
      // that is not the engine's own top move (Phase 211 D-05 — the
      // mount-rank shortcut that used to skip this is gone); the display
      // clamp below is a backstop for the occasional deeper-search inversion.
      const afterRaw = await search(afterFen, generation, 1, TRAIN_GRADING_MOVETIME_MS);
      const esAfter = evalToExpectedScore(afterRaw.evalCp, afterRaw.evalMate, mover);
      const severity = classifyLiveSeverity(esBefore, esAfter);
      const moveTier = moveTierFromSeverity(severity);
      const playedLine = clampLineEvalToBest(
        {
          moves: [playedMoveUci, ...afterRaw.pv],
          evalCp: afterRaw.evalCp,
          evalMate: afterRaw.evalMate,
        },
        bestLine,
        mover,
      );
      return {
        moveTier,
        bestMoveUci: best.bestMoveUci,
        esBefore,
        esAfter,
        bestLine,
        playedLine,
      };
    },
    [search],
  );

  // Bug fix (Phase 190-01 checkpoint): manual browser UAT hit an indefinite
  // "Checking your move…" hang (StrictMode double-invoke leaving no active
  // search for the current generation — see startGrading's effect-site fix
  // in TrainSolveScreen.tsx — plus, more generally, any wedged Worker).
  // gradeMoveInner alone has no ceiling on how long it can wait; this
  // wrapper races it against TRAIN_GRADING_TIMEOUT_MS so the promise ALWAYS
  // settles, surfacing a catchable error instead of hanging forever.
  const gradeMove = useCallback(
    (fen: string, playedMoveUci: string): Promise<GradeResult> =>
      new Promise<GradeResult>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('Grading timed out'));
        }, TRAIN_GRADING_TIMEOUT_MS);
        gradeMoveInner(fen, playedMoveUci).then(
          (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error('Grading failed'));
          },
        );
      }),
    [gradeMoveInner],
  );

  // 190.1-01, D-01 point 3 / Task 2 (honest states + cancellation safety):
  // the reveal-time "played in game" search — one new lazy search per
  // puzzle, dispatched only when the reveal opens (the caller supplies the
  // game move as UCI, obtained from the reveal GET). Reuses generationRef
  // (captured at call time) as the SAME cancellation authority as
  // startGrading/gradeMove — no second counter (190.1-RESEARCH Pitfall 2).
  //
  // Races the underlying search against TRAIN_GRADING_TIMEOUT_MS using the
  // exact settle-once wrapper shape gradeMove uses above (a `settled`
  // boolean, a timer rejecting, clearTimeout on the inner settle) so the
  // promise ALWAYS settles — a wedged Worker yields a stated failure, never
  // an unbounded spinner. Before resolving, the captured generation is
  // compared against generationRef.current: a result computed for a
  // previous puzzle (the caller started a new one, or aborted, while this
  // search was in flight) rejects instead of resolving — it must never
  // become observable to the caller.
  const startGameMoveSearch = useCallback(
    (puzzleFen: string, gameMoveUci: string): Promise<TrainEngineLine> => {
      const generation = generationRef.current;
      if (hasErrorRef.current) {
        return Promise.reject(new Error('Grading engine failed to load'));
      }
      const afterFen = fenAfterUciMove(puzzleFen, gameMoveUci);
      if (afterFen === null) {
        return Promise.reject(new Error('Illegal or malformed game move'));
      }
      // 190.1 UAT round 9, narrowed by Phase 211 (D-05): at width 1 the
      // settled mount search holds only rank 1, so the ONLY move this
      // exact-UCI lookup can match is the engine's own top move — the branch
      // now means "the move played in the game IS the engine's best move",
      // which still legitimately skips a redundant search (rank 1's line IS
      // that move's line, and its eval cannot invert against the best
      // move's). This is a deliberately RETAINED consumer of the rank lookup
      // (211-02 consumer ledger row 4), not an overlooked one. The mount
      // search is guaranteed settled here in practice (the reveal only opens
      // after gradeMove resolved, which awaited it); the fen/generation
      // guard is purely defensive.
      const best = bestSearchRef.current;
      const bestMatches =
        best !== null && best.generation === generation && best.fen === puzzleFen;
      if (bestMatches) {
        const rankLine = rankLineForMove(best.lines, gameMoveUci);
        if (rankLine !== null) {
          return Promise.resolve({
            moves: rankLine.moves,
            evalCp: rankLine.evalCp,
            evalMate: rankLine.evalMate,
          });
        }
      }
      return new Promise<TrainEngineLine>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('Reveal search timed out'));
        }, TRAIN_GRADING_TIMEOUT_MS);
        search(afterFen, generation, 1, TRAIN_GRADING_MOVETIME_MS).then(
          (raw) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (generation !== generationRef.current) {
              reject(new Error('Reveal search superseded by a newer puzzle'));
              return;
            }
            const line: TrainEngineLine = {
              moves: [gameMoveUci, ...raw.pv],
              evalCp: raw.evalCp,
              evalMate: raw.evalMate,
            };
            // Rare-case backstop, same rationale as gradeMove's clamp (190.1
            // UAT round 9) — a game move outside the mount ranks whose
            // after-move search reads better than the best move must not be
            // DISPLAYED contradicting the "best move" label.
            resolve(
              bestMatches
                ? clampLineEvalToBest(line, bestLineFrom(best), sideToMoveFromFen(puzzleFen))
                : line,
            );
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error('Reveal search failed'));
          },
        );
      });
    },
    [search],
  );

  return {
    isReady,
    hasError,
    startGrading,
    abortGrading,
    restartEngine,
    gradeMove,
    startGameMoveSearch,
  };
}
