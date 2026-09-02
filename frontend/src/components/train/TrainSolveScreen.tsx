/**
 * TrainSolveScreen — the guess -> one move -> grade -> verdict slice of the
 * Train solve loop (SOLV-01/02/03/04, D-05/D-06/D-13, Phase 190 Plans 01+04).
 *
 * D-05 (LOCKED): the board is fully visible for study but rejects every
 * piece input until the user commits a binary guess ("One critical move" /
 * "Several fine moves"); the guess buttons sit where the move prompt lives.
 * After the guess, exactly one move is accepted (SOLV-02) — every subsequent
 * drop is rejected.
 *
 * Grading (SOLV-03): `startGrading(puzzle.fen)` fires once per puzzle at
 * MOUNT (190-RESEARCH.md Open Question 1 — resolved at mount to maximise the
 * D-06 fast-path hit rate), not gated on the guess. `correct_guess` is read
 * ONLY from the server's `SolveResponse` — never recomputed client-side
 * (POOL-10).
 *
 * Persistence (190-04 Task 3, T-190-12): once grading resolves, the verdict
 * renders from `trainSession.lastSolveResponse` (the solve mutation's own
 * `data`) rather than a copy held in local state — so a retried solve
 * (`trainSession.retrySolve`) surfaces its result exactly the same way a
 * first-try success does, with no separate wiring. `advance()` itself is a
 * no-op until the CURRENT puzzle's solve has actually succeeded (the hook's
 * own gate); the Next button's `disabled` attribute mirrors that but is not
 * the only thing enforcing it (defense in depth — the hook's gate is what the
 * forced-failure test actually asserts against).
 *
 * Plan 05 replaces the inline verdict/error/Next block with `TrainReveal`
 * (the reveal panel — verdicts, honest copy, best line, opt-in tactic
 * stepper, game card, deep link). `TrainReveal` fetches the reveal GET, the
 * game card, and the tactic-lines PV itself, all gated on the solve response
 * being present (T-190-16) — none of that data is requested before the
 * solve POST resolves.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { Chess, type Move } from 'chess.js';
import { Loader2, Search, Volume2, VolumeX } from 'lucide-react';
import { Link } from 'react-router';
import { buildGameAnalysisUrl } from '@/lib/analysisUrl';
import { cn } from '@/lib/utils';
import { ChessBoard } from '@/components/board/ChessBoard';
import { Button } from '@/components/ui/button';
import { LoadError } from '@/components/ui/load-error';
import { TRAIN_BUTTON_CLASS } from '@/components/train/buttonStyles';
import { TrainReveal } from '@/components/train/TrainReveal';
import type { TrainRevealStep } from '@/components/train/TrainReveal';
import { EvalBar } from '@/components/analysis/EvalBar';
import type { SolveResponse, TrainPuzzle, VettedMove } from '@/types/train';
import type { UseTrainSessionResult } from '@/hooks/useTrainSession';
import { useFitBoardToViewport } from '@/hooks/useFitBoardToViewport';
import { useTrainFreePlay, uciFromDrop } from '@/hooks/useTrainFreePlay';
import { useStockfishEngine, type StockfishEngineState } from '@/hooks/useStockfishEngine';
import type { PvLine } from '@/hooks/uciParser';
import { useWakeLock } from '@/hooks/useWakeLock';
import type { GradeResult, TrainEngineLine, TrainGradingEngine } from '@/hooks/useTrainGradingEngine';
import { evalToExpectedScore, sideToMoveFromFen, terminalPositionEval } from '@/lib/liveFlaw';
import { useMarkPlayActive } from '@/lib/playActive';
import { usePublishMobileBoardControls } from '@/lib/mobileBoardControls';
import { playSound, useMuted, setMuted } from '@/lib/sounds';
import { saveTrainRevealCache } from '@/lib/trainRevealCache';
import type { CachedTrainReveal } from '@/lib/trainRevealCache';
import { GUESS_LABELS } from '@/lib/trainGuessLabels';
import type { Guess } from '@/lib/trainGuessLabels';
import {
  applyTrainSpotlight,
  buildTrainFreePlayArrows,
  buildTrainRevealOverlay,
  buildTrainStepArrows,
  buildTrainStepMarkers,
  classifyTrainMoveQuality,
  TRAIN_STEP_HIGHLIGHT,
} from '@/lib/trainArrows';
import type { TrainMoveQuality, TrainOverlayMove } from '@/lib/trainArrows';
import { scorePuzzle, TRAIN_POINTS_PER_PUZZLE } from '@/lib/trainScore';
import {
  SEV_INACCURACY,
  SEV_MISTAKE,
  ZONE_DANGER,
  ZONE_SUCCESS,
  TRAIN_POINTS_FG_ON_DARK,
  TRAIN_POINTS_FG_ON_LIGHT,
  STOCKFISH_ACCENT,
} from '@/lib/theme';

export interface TrainSolveScreenProps {
  puzzle: TrainPuzzle;
  trainSession: UseTrainSessionResult;
  gradingEngine: TrainGradingEngine;
  /** Called instead of `trainSession.advance()` when the Next control is
   * pressed on a landed verdict. Defaults to `trainSession.advance` — Plan
   * 05 Task 3 wires a real callback from Train.tsx that also handles the
   * session-complete -> score-screen transition. */
  onNext?: () => void;
  /**
   * 190.1 UAT round 5 (Analyze -> browser back): a previously solved
   * puzzle's cached solution state. When set, it always describes `puzzle`
   * itself (Train.tsx passes the cached puzzle alongside it), and the screen
   * mounts straight into the reveal — guess/played-move/grade seeded from
   * the cache, `moveApplied` locked, and NO mount grading search (the puzzle
   * is already solved; no move will ever be graded). The reveal's own
   * game-move search still runs — it is independent of the mount search.
   */
  restoredSolve?: CachedTrainReveal | null;
}

/**
 * Bounded readiness window (190-04 T-190-13): if the grading engine's Worker
 * never reports `isReady` within this budget — or errors at any point — the
 * solve screen stops offering the guess/move flow (which would otherwise hang
 * on "Checking your move…" forever) and surfaces `train-engine-error` with a
 * restart affordance instead. Generous above real WASM init time (seconds,
 * not tens of seconds) but finite so a genuinely dead engine is never a
 * silent, indefinite wait.
 */
const TRAIN_ENGINE_READY_TIMEOUT_MS = 15000;

/**
 * Desktop board width (190 UAT): 50% larger than the 400px ChessBoard default.
 * Shared between the `ChessBoard maxWidth` prop and the board column's
 * `max-width` so the progress bar always spans exactly the board's width
 * (same pattern as Bots.tsx's BOT_BOARD_MAX_WIDTH_PX).
 */
const TRAIN_BOARD_MAX_WIDTH_PX = 600;

/**
 * 190.1 UAT round 4: on a short browser window the board shrinks with the
 * viewport height. Floor for that shrink — below it the page scrolls instead,
 * rather than shrinking the board into unusability. Well under the old
 * `TRAIN_BOARD_MAX_WIDTH_PX / 2` (191 UAT: that floor bound before the
 * measured fit ran out of room, which is what pinned the button row to the
 * bottom edge on a short window); 240px is still ~30px squares.
 */
const TRAIN_BOARD_MIN_WIDTH_PX = 240;
/**
 * Space kept free below the board column — the page container's own `py-6`
 * bottom padding (24px) plus visual breathing room, so the
 * Solution/Analyze/Next row is never flush against the viewport edge.
 */
const TRAIN_BOARD_BOTTOM_GUTTER_PX = 40;

/**
 * 190.1 UAT round 7 / SEED-119: pill background+foreground for the
 * "Points: +N" reveal flash — dark green for a perfect 3, yellow for 2
 * (an inaccuracy still earned the guess point plus one move point), orange
 * for 1, red for 0. Yellow needs its own near-black foreground
 * (`TRAIN_POINTS_FG_ON_LIGHT`) — `SEV_INACCURACY` is a light amber that
 * near-white text cannot clear — while the three dark tiers share
 * `TRAIN_POINTS_FG_ON_DARK`.
 */
const TRAIN_POINTS_FLASH_COLORS: Record<number, { bg: string; fg: string }> = {
  0: { bg: ZONE_DANGER, fg: TRAIN_POINTS_FG_ON_DARK },
  1: { bg: SEV_MISTAKE, fg: TRAIN_POINTS_FG_ON_DARK },
  2: { bg: SEV_INACCURACY, fg: TRAIN_POINTS_FG_ON_LIGHT },
  3: { bg: ZONE_SUCCESS, fg: TRAIN_POINTS_FG_ON_DARK },
};

/**
 * Quick 260803-iv6 (Task 1): the horizontal space the eval-bar column plus
 * its gutter takes out of the board row — 20px `w-5` bar + 8px `gap-2`. This
 * is the single-bar counterpart of Analysis.tsx's `BOARD_EVAL_BARS_ALLOWANCE_PX`
 * (which reserves the SAME chrome twice, once per side, for its two bars).
 */
const TRAIN_EVAL_BAR_CHROME_PX = 28;

/**
 * Quick 260803-iv6: synthetic search depth handed to `EvalBar` for a terminal
 * (checkmate/stalemate) position, so a decisive mate clears `EvalBar`'s own
 * `depth >= 8` mate-fill gate instead of collapsing to the neutral midpoint.
 * Same device Analysis.tsx uses for its own terminal eval.
 */
const TRAIN_TERMINAL_EVAL_DEPTH = 99;

/**
 * Quick 260803-iv6: resolves the Train eval bar's reading from whichever
 * source currently owns the shown position — a terminal (mate/draw) verdict
 * first (the rules already know the answer), then the free-play engine's own
 * top line while exploring, else the standalone eval-bar engine. Kept as a
 * flat, non-exported module-level helper (guard-clause returns, no nesting
 * past depth 2) so the component body stays shallow per CLAUDE.md.
 */
function resolveTrainEvalBarReading(
  fen: string,
  isExploring: boolean,
  freePlayTop: PvLine | null,
  engine: StockfishEngineState,
): { evalCp: number | null; evalMate: number | null; depth: number } {
  const terminal = terminalPositionEval(fen);
  if (terminal !== null) {
    return { evalCp: terminal.cp, evalMate: terminal.mate, depth: TRAIN_TERMINAL_EVAL_DEPTH };
  }
  if (isExploring) {
    return {
      evalCp: freePlayTop?.evalCp ?? null,
      evalMate: freePlayTop?.evalMate ?? null,
      depth: freePlayTop?.depth ?? 0,
    };
  }
  return { evalCp: engine.evalCp, evalMate: engine.evalMate, depth: engine.depth };
}

export function TrainSolveScreen({
  puzzle,
  trainSession,
  gradingEngine,
  onNext,
  restoredSolve = null,
}: TrainSolveScreenProps): ReactElement {
  // Suppress the mobile app header while a puzzle is on screen — the board
  // needs the vertical space (ProtectedLayout reads this flag; same pattern
  // as BotsGame).
  useMarkPlayActive();

  // Keep the phone awake while a puzzle or its reveal is on screen — both are
  // long reading states with no touch input, so the OS auto-lock timer would
  // otherwise fire mid-solve. Scoped to this component on purpose: the start
  // and score screens must NOT hold the lock (a user who walks away there
  // should get their normal auto-lock).
  useWakeLock();

  // 190.1 UAT round 4: reveal-line stepping plays move sounds — same shared
  // mute preference (and toggle iconography) as bot games.
  const muted = useMuted();

  // Initial state seeds from `restoredSolve` (190.1 UAT round 5) so a
  // restored reveal never flashes the guess prompt before the mount effect
  // runs; the per-puzzle effect below re-seeds identically on transitions.
  const [guess, setGuess] = useState<Guess | null>(restoredSolve?.guess ?? null);
  const [boardFen, setBoardFen] = useState(puzzle.fen);
  const [moveApplied, setMoveApplied] = useState(restoredSolve !== null);
  const [isGrading, setIsGrading] = useState(false);
  const [gradingError, setGradingError] = useState(false);
  const [lastPlayedUci, setLastPlayedUci] = useState<string | null>(
    restoredSolve?.playedMoveUci ?? null,
  );
  // 190.1-03: the resolved GradeResult from the LAST gradeMove call for this
  // puzzle — threaded to TrainReveal so its steppable line boxes (YOUR MOVE /
  // BEST MOVE) render from the exact same engine output the verdict itself
  // was computed from, never a second derivation.
  const [gradeResult, setGradeResult] = useState<GradeResult | null>(
    restoredSolve?.gradeResult ?? null,
  );
  // 190.1-04 (D-02): the reveal query's resolved game-move UCI, reported up
  // from TrainReveal via onGameMoveUciChange — needed here (not lifted into
  // TrainReveal itself) so the board's arrows prop can include the thin white
  // game-move arrow alongside the best/played-move arrows.
  const [gameMoveUci, setGameMoveUci] = useState<string | null>(null);
  // 190.1 UAT: the reveal-time search's resolved game-move line (null while
  // pending/errored/coincident) — its eval derives the game move's quality
  // badge on the board overlay.
  const [gameMoveLine, setGameMoveLine] = useState<TrainEngineLine | null>(null);
  // 190.1 UAT: the reveal panel's current line-stepping state — non-null while
  // a line is stepped away from its start. While stepping, the solution
  // overlay (arrows + quality badges) is cleared, the reported last move gets
  // a quality-colored square highlight, and the line's next move renders as a
  // blue engine arrow.
  const [lineStep, setLineStep] = useState<TrainRevealStep | null>(null);
  // Phase 200 (EXPLORE-01/02), reworked per Phase 200 UAT: the free-play
  // branching move tree — reachable only once the verdict has landed
  // (handlePieceDrop's post-verdict branch below). Seeded from the
  // stepped-line prefix when there is one (EXPLORE-02), or an empty prefix
  // from the pristine reveal. Torn down by handleShowSolution (EXPLORE-04) and
  // the per-puzzle reset effect (EXPLORE-05).
  //
  // The hook owns its OWN Stockfish Worker (EXPLORE-05: a second, independent
  // engine instance — never a repurposed grading engine) and grades every
  // freely played move from it. See useTrainFreePlay's docstring.
  //
  // 190.1 UAT round 5: a restored reveal's verdict comes from the cache (the
  // solve mutation belongs to the unmounted prior page visit) — but a LIVE
  // solve response always wins, and the restored fallback disappears the
  // moment the puzzle transitions (restoredSolve nulls together with it).
  //
  // Bug fix (FLAWCHESS-64): the live verdict counts only when it belongs to
  // the puzzle currently on screen. `resetSolve()` runs in the puzzle-keyed
  // effect below, which React fires AFTER the child TrainReveal's own effects,
  // so a bare `lastSolveResponse` left one commit where the next puzzle was
  // already rendered while the previous puzzle's verdict was still set —
  // TrainReveal's query key flipped to the new position and fetched the reveal
  // for a puzzle that had never been attempted (a guaranteed 409). Pairing the
  // verdict with `lastSolvedPosition` closes that window at the source, and
  // also stops the reveal panel from rendering the old solution for one frame.
  //
  // Phase 211 (Plan 03): derived HERE, above the free-play seed memo, so the
  // hoisted `vettedMoves` memo below can feed BOTH the reveal overlay and the
  // free-play seed from one place.
  const liveVerdict =
    trainSession.lastSolvedPosition === puzzle.position ? trainSession.lastSolveResponse : null;
  const verdict = liveVerdict ?? restoredSolve?.verdict ?? null;

  // Phase 211 (D-01/D-06): the server's certified "also fine" set — the
  // single source BOTH consumers read: the reveal overlay's green alternative
  // arrows AND the free-play seed's root-ply key (do not inline the default
  // at either call site). The `?? []` here is the ONE nullish default for
  // the served list on this whole screen: a `trainRevealCache` entry written
  // by a pre-211 bundle restores a verdict with no `vetted_moves` key at
  // runtime even though the compiler sees the optional field — keeping
  // exactly one default is what makes the D-10 mutation test meaningful.
  const vettedMoves = useMemo<VettedMove[]>(() => verdict?.vetted_moves ?? [], [verdict]);

  // `seedEval` hands it the grading engine's verdict for the puzzle position,
  // so the FIRST free move is graded without waiting for the free-play engine
  // to re-search a position the solve loop already searched. Phase 211
  // (D-06): the seed also carries the SAME served vetted list the reveal
  // overlay draws (the hoisted `vettedMoves` memo above — the single
  // stale-cache default site), so the free-play ROOT ply and the "Also fine"
  // row can never read different keys.
  const freePlaySeedEval = useMemo(
    () =>
      gradeResult === null
        ? null
        : {
            cp: gradeResult.bestLine.evalCp,
            mate: gradeResult.bestLine.evalMate,
            bestUci: gradeResult.bestMoveUci,
            vettedMoves,
          },
    [gradeResult, vettedMoves],
  );
  const freePlay = useTrainFreePlay({ startFen: puzzle.fen, seedEval: freePlaySeedEval });
  // Phase 200 (LEGEND-02/D-09): the single active legend spotlight entry —
  // exactly one line box's move is spotlit at a time, or none. Set by
  // TrainReveal's hover/focus/tap handlers via onSpotlightChange, filtered
  // into the board overlay below via applyTrainSpotlight.
  const [spotlight, setSpotlight] = useState<{ key: string; ucis: string[] } | null>(null);
  // 190.1 UAT round 3: the Solution/Analyze/Next row lives HERE, below the
  // board (each button a third of the board's width). Solution bumps this
  // nonce; the reveal's steppers key their reset on it, snapping the board
  // back to the puzzle position with the full solution overlay.
  const [solutionNonce, setSolutionNonce] = useState(0);
  // 190.1 UAT round 7: the points earned by a LIVE solve, shown as a short
  // "Points: +N" pop animation over the board as the reveal opens. Set by the
  // result-sound effect below (so it can never fire for a restored reveal),
  // cleared on puzzle transition. The element's CSS animation ends at
  // opacity 0 with fill-mode forwards, so no unmount timer is needed.
  const [pointsFlash, setPointsFlash] = useState<number | null>(null);
  // Phase 200 UAT round 5: board orientation. Defaults to the solver's own
  // color (a black-to-move puzzle starts flipped, as it always has) and is
  // toggled by the free-play board-controls strip. Reset on every puzzle
  // transition by the same effect that resets the rest of the solve state —
  // orientation is a per-position affordance, not a session preference.
  const [flipped, setFlipped] = useState(puzzle.side_to_move === 'black');
  const handleFlipBoard = useCallback(() => setFlipped((prev) => !prev), []);
  // Quick 260809-g0n: on phones, while free-move mode is active this replaces
  // the main nav buttons in the fixed bottom bar (the /analysis board's
  // mobile-footer treatment) — see MobileBottomBar in App.tsx. The wiring
  // mirrors TrainExplorationPanel's own in-card control strip exactly (same
  // canReset-mirrors-canGoBack semantic) so the two surfaces can never
  // disagree; the in-card strip itself covers `sm` and up.
  const mobileBoardControls = useMemo(
    () =>
      freePlay.isExploring
        ? {
            onBack: freePlay.goBack,
            onForward: freePlay.goForward,
            onReset: freePlay.goToRoot,
            onFlip: handleFlipBoard,
            canGoBack: freePlay.canGoBack,
            canGoForward: freePlay.canGoForward,
            canReset: freePlay.canGoBack,
          }
        : null,
    [
      freePlay.isExploring,
      freePlay.goBack,
      freePlay.goForward,
      freePlay.goToRoot,
      freePlay.canGoBack,
      freePlay.canGoForward,
      handleFlipBoard,
    ],
  );
  usePublishMobileBoardControls(mobileBoardControls);
  // 191 UAT: the board column shrinks to whatever vertical room the viewport
  // actually leaves (see useFitBoardToViewport) — measured, not a hard-coded
  // chrome estimate, so the button row below the board always keeps its
  // gutter no matter what else the page renders above the column.
  const columnRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const boardMaxWidthPx = useFitBoardToViewport({
    columnRef,
    boardRef,
    maxPx: TRAIN_BOARD_MAX_WIDTH_PX,
    minPx: TRAIN_BOARD_MIN_WIDTH_PX,
    gutterPx: TRAIN_BOARD_BOTTOM_GUTTER_PX,
  });
  const [engineTimedOut, setEngineTimedOut] = useState(false);
  // Bumped by a manual engine retry so the readiness-timeout effect below
  // re-arms its window even when `isReady` itself hasn't changed value yet.
  const [engineRetryNonce, setEngineRetryNonce] = useState(0);

  // Destructured so their (stable, useCallback([])) identities can be listed
  // in the effect's deps array without the effect re-firing on gradingEngine's
  // own per-render object identity.
  const { startGrading, abortGrading, gradeMove, restartEngine, isReady, hasError } = gradingEngine;

  const engineFailed = hasError || engineTimedOut;

  // T-190-13: a bounded readiness window — the Worker either reports ready
  // in time or this fires. Resets (clears) once isReady flips true, and
  // re-arms on a manual retry via `engineRetryNonce`.
  useEffect(() => {
    if (isReady) {
      setEngineTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setEngineTimedOut(true), TRAIN_ENGINE_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isReady, engineRetryNonce]);

  // Fires the "find the best move" search once per puzzle at mount and resets
  // the per-puzzle UI state. abortGrading on cleanup covers a puzzle
  // transition mid-search (190-RESEARCH.md Pitfall 3).
  //
  // Bug fix (Phase 190-01 checkpoint): this effect used to be guarded by a
  // `startedForFenRef.current === puzzle.fen` ref-check meant to suppress a
  // duplicate `startGrading` dispatch on React StrictMode's dev-only
  // mount->cleanup->mount double-invoke. That guard was itself the bug: the
  // interim cleanup's `abortGrading()` bumps the engine's generation and
  // stops the in-flight search, but the ref then suppressed the SECOND
  // mount's `startGrading` call (same puzzle.fen) entirely — leaving no
  // search running for the puzzle's now-current generation, so
  // `gradeMove`'s internal `await bestSearchReadyRef.current` hung forever
  // (observed in manual browser UAT as "Checking your move…" never
  // resolving). `startGrading`/`abortGrading` are already idempotent and
  // cancellation-safe via the hook's generation counter — calling
  // `startGrading` on every effect invocation (as below) is correct in both
  // StrictMode dev (harmless extra stop+go pair) and production (fires
  // exactly once per real puzzle.fen change).
  useEffect(() => {
    // 190.1 UAT round 5: a restored puzzle (Analyze -> back) seeds its cached
    // solved state instead of the fresh-puzzle reset, and skips the mount
    // grading search entirely — no move will ever be graded for it. The
    // Next-press transition to a fresh puzzle re-fires this effect with
    // restoredSolve already null (both change on the same render).
    setGuess(restoredSolve?.guess ?? null);
    setBoardFen(puzzle.fen);
    setMoveApplied(restoredSolve !== null);
    setIsGrading(false);
    setGradingError(false);
    setLastPlayedUci(restoredSolve?.playedMoveUci ?? null);
    setGradeResult(restoredSolve?.gradeResult ?? null);
    setGameMoveUci(null);
    setGameMoveLine(null);
    setLineStep(null);
    setSpotlight(null);
    setPointsFlash(null);
    setFlipped(puzzle.side_to_move === 'black');
    // Phase 200 (EXPLORE-05): a puzzle transition tears down any active
    // exploration session (and, via the hook's `enabled: isExploring` engine
    // in task 3, its Worker) — the next puzzle always starts in the pristine
    // reveal state, never mid-sideline.
    freePlay.reset();
    trainSession.resetSolve();
    if (restoredSolve === null) startGrading(puzzle.fen);
    return () => {
      abortGrading();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trainSession.resetSolve is a stable useCallback from the hook (it closes over the mutation's own `.reset`, bound once per observer — see useTrainSession's stability comment; it was NOT stable before that fix, so this line's original claim was aspirational). Including the whole trainSession object would re-fire this effect every render. restoredSolve only ever changes together with puzzle.fen (Train.tsx pairs them), so puzzle.fen already covers it — as does puzzle.side_to_move, which is a function of the FEN. freePlay.reset's identity is keyed on puzzle.fen alone, so it changes with (and only with) that dep.
  }, [puzzle.fen, startGrading, abortGrading, freePlay.reset]);

  async function gradeAndSolve(playedGuess: Guess, playedUci: string): Promise<void> {
    setIsGrading(true);
    setGradingError(false);
    let grade: GradeResult;
    try {
      grade = await gradeMove(puzzle.fen, playedUci);
    } catch {
      // A grading timeout (TRAIN_GRADING_TIMEOUT_MS) or any other grading
      // failure — never a silent, indefinite "Checking your move…" spinner
      // (CLAUDE.md: every mutation path needs an isError branch). Retry
      // re-runs the SAME played move through the grading engine from
      // scratch, since no verdict was ever computed.
      setGradingError(true);
      setIsGrading(false);
      return;
    }
    setGradeResult(grade);
    try {
      await trainSession.solvePuzzle({
        position: puzzle.position,
        guess: playedGuess,
        played_move: playedUci,
        move_quality: grade.moveTier,
      });
      // correct_guess is read ONLY from the server response (POOL-10) — never
      // recomputed client-side. The verdict itself renders from
      // trainSession.lastSolveResponse below, not a local copy.
    } catch {
      // T-190-12: the solve-POST failure surfaces via trainSession.isSolveError
      // below (locked copy + Retry, which calls trainSession.retrySolve() —
      // re-submitting this SAME payload, never re-grading). Do not swallow;
      // do not add a second Sentry error-report call here — the global
      // mutation-cache handler in queryClient.ts already reports it.
    } finally {
      setIsGrading(false);
    }
  }

  function retryGrading(): void {
    if (guess === null || lastPlayedUci === null) return;
    void gradeAndSolve(guess, lastPlayedUci);
  }

  // Bug fix (WR-01): `handleRetryEngine` used to call `startGrading`
  // synchronously right here, but `restartEngine()` only bumps state — the
  // actual Worker teardown/recreate (and `hasErrorRef` reset) happens in the
  // Worker-lifecycle effect on the NEXT commit, which React defers. Calling
  // `startGrading` inline raced the STALE Worker/refs: on an onerror-
  // triggered retry it permanently rejected this puzzle's grading (nothing
  // ever re-issued the search once the new Worker became ready), and on a
  // readiness-timeout-triggered retry it re-triggered the CR-01 not-ready
  // fabrication. Deferred below to the effect keyed on `isReady` actually
  // flipping true after a retry, instead of firing inline.
  const handleRetryEngine = useCallback(() => {
    restartEngine();
    setEngineTimedOut(false);
    setEngineRetryNonce((n) => n + 1);
  }, [restartEngine]);

  // Tracks the last `engineRetryNonce` for which `startGrading` has already
  // been re-dispatched, so this effect fires exactly once per manual retry
  // (not on every render once `isReady` is already true).
  const lastStartedRetryNonceRef = useRef(0);
  useEffect(() => {
    if (!isReady) return;
    if (engineRetryNonce === 0) return; // no manual retry has happened yet
    if (lastStartedRetryNonceRef.current === engineRetryNonce) return;
    lastStartedRetryNonceRef.current = engineRetryNonce;
    startGrading(puzzle.fen);
  }, [isReady, engineRetryNonce, startGrading, puzzle.fen]);

  function handlePieceDrop(source: string, target: string): boolean {
    // D-05: board locked until the binary guess is committed.
    if (guess === null) return false;
    // SOLV-02: exactly one attempt per puzzle.
    if (moveApplied) {
      // Phase 200 (EXPLORE-01/02/D-12): once the verdict has landed, a
      // further drop starts (or extends) a free-play sideline on this SAME
      // board — no mode toggle, no second board, no second grading attempt.
      // Guardrail (Pitfall 3, extended): this branch sits STRICTLY after the
      // guess and moveApplied guards above, which are what hold SOLV-02 at
      // exactly one graded attempt — do not reorder them, and do not widen
      // the graded path (below) to read displayFen.
      if (verdict === null) return false; // solve/grading still pending
      // Already in free play: the move tree validates (and forks) the drop
      // itself, exactly as the analysis board does.
      if (freePlay.isExploring) {
        const played = freePlay.playMove(source, target);
        if (played) {
          setLineStep(null);
          setSpotlight(null);
        }
        return played;
      }
      // Opening move of a free-play session: validate against displayFen —
      // D-12: the LIVE position on the board (a stepped-into line position, or
      // the puzzle position), never the frozen boardFen — to derive the UCI
      // the tree is seeded with.
      const exploreUci = uciFromDrop(displayFen, source, target);
      if (exploreUci === null) return false;
      freePlay.start(lineStep?.prefixUci ?? [], exploreUci);
      setLineStep(null);
      setSpotlight(null);
      return true;
    }

    const chess = new Chess(boardFen);
    let move: Move;
    try {
      move = chess.move({ from: source, to: target, promotion: 'q' }); // auto-queen
    } catch {
      return false;
    }
    if (!move) return false;

    setMoveApplied(true);
    setBoardFen(chess.fen());
    const playedUci = `${move.from}${move.to}${move.promotion ?? ''}`;
    setLastPlayedUci(playedUci);
    void gradeAndSolve(guess, playedUci);
    return true;
  }

  // SOLV-04/D-13: "i of N" uses the session's FROZEN puzzle_count, never
  // puzzles.length (which can legitimately shrink after a lazy eviction —
  // Phase 189's own documented behavior).
  //
  // Bug fix (190-06 UAT): `currentIndex` is 0-relative to `trainSession.puzzles`
  // (see useTrainSession.ts's module docstring — that array is the FULL
  // session on a fresh load, but only the REMAINING puzzles on a resume), so
  // it alone undercounts a resumed session's true position. The session's
  // own `solved_count`, frozen at load time, is the number of puzzles solved
  // BEFORE this frontend session started; adding it back in recovers the
  // real 1-based position across both the fresh (solved_count === 0) and
  // resume (solved_count > 0) cases.
  const totalPuzzles = trainSession.session?.puzzle_count ?? trainSession.puzzles.length;
  const solvedBeforeThisLoad = trainSession.session?.solved_count ?? 0;
  // 190.1 UAT round 5: a restored reveal shows an ALREADY-solved puzzle — the
  // most recently solved one, so its 1-based position is exactly the resumed
  // session's solved_count (the general formula below would overshoot by one,
  // since it targets the next UNSOLVED puzzle).
  const currentPosition1Based =
    restoredSolve !== null
      ? Math.max(1, solvedBeforeThisLoad)
      : solvedBeforeThisLoad + (trainSession.currentIndex ?? 0) + 1;
  const progressFraction =
    totalPuzzles > 0 ? Math.min(1, Math.max(0, (currentPosition1Based - 1) / totalPuzzles)) : 0;

  // SOLV-02: the opponent's (or the user's own) last move into this position —
  // arrival data only, never the answer. A null arriving move (ply 0) renders
  // no highlight, never a fabricated square.
  const lastMove = puzzle.last_move_uci
    ? { from: puzzle.last_move_uci.slice(0, 2), to: puzzle.last_move_uci.slice(2, 4) }
    : null;

  // Phase 200 (D-12): the live board position — while exploring, the
  // exploration hook's replayed FEN is the single source of truth for both
  // the RENDERED board and handlePieceDrop's exploration-branch move
  // validation above. Deliberately never `boardFen`: every existing
  // `setBoardFen` call site is untouched by this plan, so `boardFen` stays
  // frozen at the pristine/stepped position for the whole exploration
  // session — validating a sideline drop against it would silently re-impose
  // a one-color restriction the moment the sideline's side to move flips
  // (see handlePieceDrop's own comment for the full mechanism).
  const displayFen = freePlay.isExploring ? (freePlay.fen ?? boardFen) : boardFen;

  // T-190-12: the verdict/Next/solve-error row only appears once the local
  // grade+solve pipeline has settled (moveApplied && !isGrading && no
  // grading-level error) — it then distinguishes success (lastSolveResponse
  // set) from a solve-POST failure (isSolveError) via the SAME row. The
  // `verdict` itself is derived above the free-play seed memo (Phase 211
  // moved it up so the seed can carry the served vetted list).
  const showResultRow =
    moveApplied && !isGrading && !gradingError && (verdict !== null || trainSession.isSolveError);

  // Quick 260803-iv6 (Task 1, T-iv6-01): the SAME gate the reveal panel
  // itself uses — a live engine evaluation shown before the reveal opens
  // would hand the user the answer to the "one critical move vs several fine
  // moves" question the puzzle is asking, so the bar cannot appear any
  // earlier than `showResultRow` does.
  const showEvalBar = showResultRow;
  const evalBarFen = showEvalBar && !freePlay.isExploring ? displayFen : null;
  // Deliberately disabled while exploring: `useTrainFreePlay` already owns a
  // FEN-driven Stockfish worker for the explored position (see its own
  // docstring), so this gate keeps exactly one such worker alive at a time
  // for the shown position (the session-scoped grading worker is a third,
  // but is idle once the verdict has landed).
  const evalBarEngine = useStockfishEngine({ fen: evalBarFen, enabled: evalBarFen !== null });
  const freePlayTopLine = freePlay.pvLines[0] ?? null;
  const evalBarReading = resolveTrainEvalBarReading(
    displayFen,
    freePlay.isExploring,
    freePlayTopLine,
    evalBarEngine,
  );

  // 190.1 UAT: the played move's classified quality — derived once here and
  // shared by the board overlay below AND the reveal's line-box header icons
  // (threaded down as a prop), so the two surfaces can never drift.
  //
  // Phase 211 (D-03/D-07): when the verdict carries the server's graded-ES
  // pair (a key-move override), the badge derives from THOSE numbers through
  // the same classifier — before this phase the board badge and the score
  // chip were always equal only because the server echoed the client's own
  // assertion; now the server can legitimately disagree with the client
  // engine's search, and the display must follow the server. Off-key moves
  // (graded_es_* null/absent) keep the client-engine derivation.
  const playedMoveQuality = useMemo<TrainMoveQuality | null>(() => {
    if (gradeResult === null || lastPlayedUci === null) return null;
    const isBest = lastPlayedUci === gradeResult.bestMoveUci;
    if (verdict?.graded_es_before != null && verdict?.graded_es_after != null) {
      return classifyTrainMoveQuality(verdict.graded_es_before, verdict.graded_es_after, isBest);
    }
    return classifyTrainMoveQuality(gradeResult.esBefore, gradeResult.esAfter, isBest);
  }, [gradeResult, lastPlayedUci, verdict]);

  // The game move's quality: derived from the coinciding best/played move
  // when no reveal-time search ran, else from the searched line's eval via
  // the SAME expected-score pipeline the verdict uses.
  const gameMoveQuality = useMemo<TrainMoveQuality | null>(() => {
    if (gameMoveUci === null || gradeResult === null) return null;
    if (gameMoveUci === gradeResult.bestMoveUci) return 'best';
    if (gameMoveUci === lastPlayedUci) return playedMoveQuality;
    if (gameMoveLine === null) return null;
    const mover = sideToMoveFromFen(puzzle.fen);
    const esGame = evalToExpectedScore(gameMoveLine.evalCp, gameMoveLine.evalMate, mover);
    return classifyTrainMoveQuality(gradeResult.esBefore, esGame, false);
  }, [gameMoveUci, gradeResult, lastPlayedUci, playedMoveQuality, gameMoveLine, puzzle.fen]);

  // 190.1-04 (D-02, reworked per 190.1 UAT): reveal-board overlay — the blue
  // best-move arrow, green alternative-good-move arrows capped by puzzle
  // type, the played-move arrow colored by its own quality, the thin white
  // game-move arrow, plus a move-quality corner badge on every arrow's
  // target square. Empty until the verdict has actually landed.
  const revealOverlay = useMemo(() => {
    const playedMove: TrainOverlayMove | null =
      gradeResult !== null && lastPlayedUci !== null && playedMoveQuality !== null
        ? { uci: lastPlayedUci, quality: playedMoveQuality }
        : null;
    return buildTrainRevealOverlay(
      verdict?.puzzle_type ?? 'sharp',
      // Phase 211 (D-01): the server's certified vetted list — the client
      // engine no longer contributes alternatives to this overlay. The
      // hoisted `vettedMoves` memo above owns the stale-cache default.
      vettedMoves,
      gradeResult?.bestMoveUci ?? null,
      playedMove,
      gameMoveUci !== null ? { uci: gameMoveUci, quality: gameMoveQuality } : null,
      verdict !== null,
    );
  }, [verdict, vettedMoves, gradeResult, lastPlayedUci, playedMoveQuality, gameMoveUci, gameMoveQuality]);

  /**
   * 260902-qf7 (reverses Phase 200 UAT): the moves the PRISTINE (un-spotlit)
   * reveal board draws — "Your move", "Best move", AND the played-in-game
   * move. A puzzle mined from the user's own game exists to contrast their
   * guess against what they actually played there, so that contrast must not
   * be hidden behind a hover/tap; only the server-vetted "Also fine"
   * alternatives remain hover/tap-only, surfacing (alone) while their own
   * legend card is spotlit and otherwise staying off the board.
   *
   * Expressed as a DEFAULT active set for `applyTrainSpotlight` rather than a
   * second drawing rule, so the un-spotlit board and a spotlit one go through
   * exactly the same filter. A verdict cannot land without a `gradeResult` and
   * a played move (both live and restored paths set them together), so this is
   * non-empty whenever the overlay itself is non-empty — the empty case would
   * hit `applyTrainSpotlight`'s no-op and simply show everything. `gameMoveUci`
   * is `null` for filler puzzles (and any puzzle not mined from a user's own
   * game), so `.filter` drops it there and the pristine set is unchanged.
   */
  const pristineOverlayUcis = useMemo(
    () =>
      [lastPlayedUci, gradeResult?.bestMoveUci ?? null, gameMoveUci].filter(
        (uci): uci is string => uci !== null,
      ),
    [lastPlayedUci, gradeResult, gameMoveUci],
  );

  // Phase 200 (LEGEND-02): the reveal overlay filtered down to the spotlit
  // legend entry's own arrow(s)/badge, or — with nothing spotlit — down to the
  // pristine your/best pair above.
  const spotlitOverlay = useMemo(
    () => applyTrainSpotlight(revealOverlay, spotlight?.ucis ?? pristineOverlayUcis),
    [revealOverlay, spotlight, pristineOverlayUcis],
  );

  // 190.1 UAT stepping mode: while a reveal line is stepped away from its
  // start, the solution overlay is cleared; the only marks are the stepped
  // move's quality-colored square highlight and a blue arrow for the line's
  // next move. Back at the start (lineStep === null), the full overlay
  // (spotlight-filtered, Pitfall 1: a stray hover while stepping must never
  // touch the step overlay's own blue next-move arrow) and the puzzle's own
  // arrival-move highlight return.
  // Phase 200 UAT round 5: while exploring, the single arrow is the free-play
  // engine's own top move for the shown position — the analysis board's blue
  // Stockfish pointer, in free play too. Memoized so a re-render that doesn't
  // change the best move hands `ChessBoard` the same array identity (the old
  // "no arrows while exploring" rule used a module constant for exactly that).
  const freePlayArrows = useMemo(
    () => buildTrainFreePlayArrows(freePlay.bestMoveUci),
    [freePlay.bestMoveUci],
  );
  const boardArrows = freePlay.isExploring
    ? freePlayArrows
    : lineStep !== null
      ? buildTrainStepArrows(lineStep.nextMoveUci)
      : spotlitOverlay.arrows;
  // 190.1 UAT round 4: while stepping, the line's FIRST move keeps its
  // quality icon badge on the moved-to square (deeper steps show none).
  // Phase 200 UAT: while exploring, the badge is the FREELY PLAYED move's own
  // live grade (useTrainFreePlay) — the original EXPLORE-03 rule of "no badges
  // at all" was reversed, since grading the sideline is the point.
  const boardMarkers = freePlay.isExploring
    ? freePlay.boardMarkers
    : lineStep !== null
      ? buildTrainStepMarkers(lineStep.lastMoveUci, lineStep.quality, lineStep.isFirstMove)
      : spotlitOverlay.markers;
  const boardLastMove = freePlay.isExploring
    ? freePlay.lastMove
    : lineStep !== null
      ? { from: lineStep.lastMoveUci.slice(0, 2), to: lineStep.lastMoveUci.slice(2, 4) }
      : lastMove;
  // Phase 200 UAT: the free-play last-move highlight is quality-colored too
  // (undefined while the move is still ungraded — the board then falls back to
  // its ordinary highlight rather than flashing a wrong color).
  const boardLastMoveColor = freePlay.isExploring
    ? freePlay.lastMoveColor
    : lineStep !== null && lineStep.quality !== null
      ? TRAIN_STEP_HIGHLIGHT[lineStep.quality]
      : undefined;

  // 190.1 UAT rounds 6+7 / SEED-119: the reveal plays a per-score result
  // sound AND pops the "Points: +N" flash over the board the moment a LIVE
  // solve response lands — never for a restored reveal (its solve happened
  // on a prior page visit). The full per-puzzle max (3, guess + a good move)
  // plays FullScore; any lesser positive score (e.g. guess-only,
  // or guess plus an inaccuracy) plays PartialScore; 0 points plays Defeat. The
  // ref keeps StrictMode's dev-only double effect invocation (and any later
  // re-render with the same response object) from playing it twice;
  // playSound itself honors the shared mute preference.
  //
  // Quick 260814-b: the full-score branch now plays `score-full` (its own
  // clip), NOT `game-win`. One solved puzzle and a whole green session used to
  // sound identical, which flattened the session-end payoff; WinChime is now
  // reserved for the session verdict (TrainScoreScreen) and bot-game wins.
  //
  // Bug fix (Phase 200 UAT round 7): the ref is seeded with whatever verdict
  // the solve mutation ALREADY holds at mount, not with null. The solve
  // mutation lives on `useTrainSession` in the page above, which outlives this
  // screen — so a remount (dev-clock time travel drops back to the landing and
  // starts a NEW session, and Train.tsx's `returnToLanding` unmounts/remounts
  // this component) used to see the PREVIOUS session's last verdict as
  // "unsounded" and replayed its result sound (and the points flash) over the
  // first puzzle of the fresh session. A mount-time response is by definition
  // not a live landing: only a response that arrives while this screen is
  // mounted may sound.
  const liveSolveResponse = trainSession.lastSolveResponse;
  const soundedSolveRef = useRef<SolveResponse | null>(liveSolveResponse);
  useEffect(() => {
    if (liveSolveResponse === null || soundedSolveRef.current === liveSolveResponse) return;
    soundedSolveRef.current = liveSolveResponse;
    const points = scorePuzzle(liveSolveResponse.correct_guess, liveSolveResponse.move_quality);
    playSound(
      points === TRAIN_POINTS_PER_PUZZLE ? 'score-full' : points > 0 ? 'score-partial' : 'game-loss',
    );
    setPointsFlash(points);
  }, [liveSolveResponse]);

  // Phase 200 UAT round 3: stepping a line back to its START position restores
  // the pristine solution board, and that board must show the FULL solution —
  // both the Your-move and the Best-move arrow. Without this, the card the user
  // stepped inside is still spotlit (desktop: the pointer never left it while
  // clicking prev; mobile: the tap that opened the line is still active), so
  // the restored "solution" showed that one card's move alone. Only a real
  // non-null -> null transition reaches this (React bails out on an unchanged
  // null), so a stepper's own mount report can never clear a live spotlight.
  //
  // UAT round 9 carve-out: a CARD CLICK also ends the stepped line (it snaps
  // the board back to the solution position), but there the whole point is to
  // spotlight the clicked card — so `returnToSolution` arms this ref and the
  // clear is skipped exactly once. A ref rather than extra state: the flag must
  // be read in the very effect run this transition triggers, and re-rendering
  // for it would be pointless.
  const keepSpotlightRef = useRef(false);
  useEffect(() => {
    if (lineStep !== null) return;
    if (keepSpotlightRef.current) {
      keepSpotlightRef.current = false;
      return;
    }
    setSpotlight(null);
  }, [lineStep]);

  // D-08: as the reveal opens (the solve POST has actually succeeded), the
  // board snaps back to the puzzle position and becomes the stage for
  // stepping the best/tactic line — the played move is reported in the
  // verdict text above, not left on the board.
  useEffect(() => {
    if (verdict !== null) {
      setBoardFen(puzzle.fen);
    }
  }, [verdict, puzzle.fen]);

  const handleNext = onNext ?? trainSession.advance;

  // Phase 200 (D-11) + UAT round 9: the board has left the pristine reveal —
  // a line is stepped, or exploration is running. Gates the Solution button's
  // visibility, and tells the reveal panel that a card click must first bring
  // the board back before spotlighting itself.
  const isBoardDeparted = lineStep !== null || freePlay.isExploring;

  // SEED-119: the badge's color pair for the current pointsFlash tier,
  // falling back to the 0-point entry (never an unreadable bg/fg pair) when
  // pointsFlash holds a value outside the known 0-3 range. The `!` is safe:
  // key 0 is always present in TRAIN_POINTS_FLASH_COLORS by construction.
  const pointsFlashColors =
    pointsFlash !== null
      ? (TRAIN_POINTS_FLASH_COLORS[pointsFlash] ?? TRAIN_POINTS_FLASH_COLORS[0]!)
      : undefined;

  /**
   * Phase 200 UAT round 9: brings the board back to the pristine solution
   * position — every stepper reset (solutionNonce), the board FEN, no stepped
   * line, no exploration — WITHOUT touching the spotlight. Wired to a reveal
   * card click, which re-applies its OWN spotlight right after (and so arms
   * `keepSpotlightRef` above, since ending the stepped line would otherwise
   * clear it again on the next commit).
   */
  function returnToSolution(): void {
    if (lineStep !== null) keepSpotlightRef.current = true;
    setSolutionNonce((n) => n + 1);
    setBoardFen(puzzle.fen);
    setLineStep(null);
    // Phase 200 (EXPLORE-04): one press does both jobs — exit exploration AND
    // the existing stepper reset, so the board always snaps to the pristine
    // reveal in a single tap regardless of which departed state it was in.
    freePlay.reset();
    // Flipping is only offered while exploring, so leaving exploration also
    // restores the puzzle's initial orientation — otherwise the pristine
    // reveal comes back upside down after a flip.
    setFlipped(puzzle.side_to_move === 'black');
  }

  function handleShowSolution(): void {
    returnToSolution();
    // The Solution button restores the FULL overlay, so it drops the spotlight
    // too. Safe alongside the ref `returnToSolution` may have just armed: that
    // ref only suppresses the effect's own clear, never this explicit one.
    setSpotlight(null);
  }

  // 190.1 UAT round 5: leaving the reveal via Analyze caches the full
  // solution state, so the browser back button restores THIS solved reveal
  // instead of the start screen (a resumed session no longer contains the
  // solved puzzle, and the grade result lives only in this page's memory).
  function handleAnalyzeClick(): void {
    const sessionId = trainSession.session?.session_id;
    if (
      sessionId == null ||
      verdict === null ||
      guess === null ||
      lastPlayedUci === null ||
      gradeResult === null
    ) {
      return;
    }
    saveTrainRevealCache({
      sessionId,
      puzzle,
      verdict,
      guess,
      playedMoveUci: lastPlayedUci,
      gradeResult,
    });
  }

  return (
    <div
      // The board column's fitted width, published as a custom property so the
      // MOBILE stack can cap itself with a class (`max-w-[var(...)]`) that
      // `lg:max-w-none` can still override — an inline `max-width` could not be
      // beaten by a breakpoint utility. Below `lg` this makes the reveal panel
      // exactly as wide as the board column, which the sticky pinning below
      // depends on: a wider reveal would scroll past the pinned column's
      // background and show two strips of moving cards flanking the board.
      style={{ '--train-col-max': `${boardMaxWidthPx}px` } as CSSProperties}
      className="mx-auto flex w-full max-w-[var(--train-col-max)] flex-col items-center gap-4 lg:mx-0 lg:max-w-none lg:flex-row lg:items-start lg:justify-center lg:gap-8"
      data-testid="train-solve-screen"
    >
      <div
        ref={columnRef}
        // Mobile: the board column (progress + board + Solution/Analyze/Next)
        // pins to the top of the viewport so the board never scrolls out of
        // sight while the reveal panel is read beneath it — the reveal's
        // arrows/spotlight are meaningless when the board they annotate is off
        // screen. Desktop already sits the reveal in its own column, so the
        // whole treatment is `max-lg:`. The opaque background is what the
        // scrolled-under content passes behind; `pb-3` keeps the first reveal
        // card off the button row (and, being inside the measured column, is
        // honestly accounted for by `useFitBoardToViewport`).
        className="flex w-full flex-col items-center gap-4 max-lg:sticky max-lg:top-0 max-lg:z-10 max-lg:bg-background max-lg:pb-3"
        style={{ maxWidth: boardMaxWidthPx }}
      >
      <div className="flex w-full flex-col gap-1">
        <div className="flex w-full items-center justify-between">
          <p className="text-sm font-semibold" data-testid="train-progress">
            {currentPosition1Based} of {totalPuzzles}
          </p>
          {/* SOLV-04/D-04: the running session score, top-right of the progress
              row — only once at least one puzzle has actually been scored, so
              the first puzzle of a fresh session never shows "0 / 0 pts". */}
          {trainSession.sessionSolvedCount > 0 && (
            <p className="text-sm font-semibold" data-testid="train-session-score">
              {trainSession.sessionScore} / {trainSession.sessionSolvedCount * TRAIN_POINTS_PER_PUZZLE} pts
            </p>
          )}
        </div>
        <div className="h-1.5 w-full rounded-full bg-muted" data-testid="train-progress-bar">
          <div
            className="h-1.5 rounded-full bg-brand-brown"
            style={{ width: `${progressFraction * 100}%` }}
          />
        </div>
      </div>
      <div ref={boardRef} className="flex w-full flex-row items-stretch gap-2">
        <div className="relative min-w-0 flex-1">
          <ChessBoard
            position={displayFen}
            flipped={flipped}
            lastMove={boardLastMove}
            lastMoveColor={boardLastMoveColor}
            onPieceDrop={handlePieceDrop}
            arrows={boardArrows}
            squareMarkers={boardMarkers}
            maxWidth={boardMaxWidthPx - TRAIN_EVAL_BAR_CHROME_PX}
            id="chessboard"
          />
          {/* 190.1 UAT round 7: short "Points: +N" pop over the board as the
              reveal opens. Centering lives in the keyframes' translate(-50%,-50%)
              (NOT Tailwind translate utilities — the animation would overwrite
              them mid-flight); the animation ends at opacity 0 and holds there
              (fill-mode forwards), so the element lingers invisibly (and
              pointer-events-none) until the next puzzle clears the state. */}
          {pointsFlash !== null && (
            <div
              className="animate-train-points-pop pointer-events-none absolute left-1/2 top-1/2 z-10 select-none whitespace-nowrap rounded-full px-6 py-2 text-2xl font-bold shadow-lg"
              style={{ backgroundColor: pointsFlashColors?.bg, color: pointsFlashColors?.fg }}
              data-testid="train-points-flash"
            >
              Points: +{pointsFlash}
            </div>
          )}
        </div>
        {/* Quick 260803-iv6 (Task 1): the slot is ALWAYS present — that is
            what keeps the board from resizing mid-puzzle when the reveal
            opens (the board's own maxWidth already reserves this column's
            width). Only the EvalBar inside it is conditional on showEvalBar. */}
        <div className="w-5 shrink-0">
          {showEvalBar && (
            <EvalBar
              evalCp={evalBarReading.evalCp}
              evalMate={evalBarReading.evalMate}
              depth={evalBarReading.depth}
              flipped={flipped}
              accentColor={STOCKFISH_ACCENT}
              testId="train-eval-bar"
              className="h-full w-full"
            />
          )}
        </div>
      </div>
      {/* 190.1 UAT round 3: Solution + Analyze + Next directly below the
          board, sharing its width evenly (plus the round-4 mute icon at the
          right edge). Solution resets every
          reveal stepper (and the board) back to the puzzle position. Analyze
          deep-links one ply BEFORE the mistake: the analysis board's mainline
          index k holds the position AFTER k+1 half-moves, so passing
          puzzle.ply itself would land one half-move too late. */}
      {verdict !== null && (
        <div className="flex w-full items-center gap-2">
          {/* Phase 200 (D-11): visibility-gated, not always present — shown
              only once the board has departed the pristine reveal (a line is
              stepped, or exploration is active). Both of Solution's jobs
              still fire together on a press (handleShowSolution): exit
              exploration AND the existing stepper reset. Label stays
              "Solution" — no relabel, no hint line. */}
          {isBoardDeparted && (
            <Button
              variant="brand-outline"
              className={cn('flex-1', TRAIN_BUTTON_CLASS)}
              data-testid="btn-train-solution"
              onClick={handleShowSolution}
            >
              Solution
            </Button>
          )}
          {/* D-09 (Phase 192): hidden — not disabled — when the herring's
              source game link is null. Nothing else on the reveal
              references the game at that point, so a disabled control
              would be an unexplained stub. `buildGameAnalysisUrl` keeps its
              `(gameId: number, ...)` signature unwidened; this gate is what
              guarantees it is never called with null. */}
          {puzzle.game_id !== null && (
            <Button asChild variant="brand-outline" className={cn('flex-1', TRAIN_BUTTON_CLASS)}>
              <Link
                to={buildGameAnalysisUrl(puzzle.game_id, puzzle.ply > 0 ? puzzle.ply - 1 : null)}
                data-testid="btn-train-analyze"
                aria-label="Analyze this position"
                onClick={handleAnalyzeClick}
              >
                <Search className="h-4 w-4 mr-1" />
                Analyze
              </Link>
            </Button>
          )}
          <Button
            variant="default"
            className={cn('flex-1', TRAIN_BUTTON_CLASS)}
            data-testid="btn-train-next"
            onClick={handleNext}
          >
            Next
          </Button>
          {/* 190.1 UAT round 4: stepping plays move sounds — same mute
              toggle as bot games (GameControls), same persisted preference. */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMuted(!muted)}
            aria-label={muted ? 'Unmute sounds' : 'Mute sounds'}
            data-testid="board-btn-mute"
          >
            {muted ? <VolumeX /> : <Volume2 />}
          </Button>
        </div>
      )}
      {engineFailed ? (
        <div className="flex flex-col items-center gap-2" data-testid="train-engine-error">
          <LoadError resource="the grading engine" />
          <Button
            variant="brand-outline"
            className={TRAIN_BUTTON_CLASS}
            data-testid="btn-train-engine-retry"
            onClick={handleRetryEngine}
          >
            Retry
          </Button>
        </div>
      ) : !isReady ? (
        // CR-01 defense in depth: never offer the guess/move UI before the
        // grading engine's Worker has actually completed its UCI handshake —
        // without this, a fast user (or one on a slow connection where the
        // ~1-2MB WASM asset takes longer to fetch) could commit a graded move
        // while `gradingEngine.search()` would still have fabricated a bogus
        // result. The primary fix (queuing until ready) lives in
        // useTrainGradingEngine.ts; this is the belt-and-suspenders UI gate.
        <div className="flex items-center gap-2" data-testid="train-engine-loading">
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-semibold text-muted-foreground">Loading engine…</p>
        </div>
      ) : (
        <>
          {guess === null && !moveApplied && (
            <div className="flex flex-col items-center gap-2">
              {/* 190 UAT: some positions don't make the player's color obvious —
                  state it explicitly right where the guess is committed. */}
              <p className="text-sm font-semibold" data-testid="train-guess-prompt">
                Before you move with {puzzle.side_to_move}, decide:
              </p>
              <div className="flex gap-2">
                <Button
                  variant="brand-outline"
                  className={TRAIN_BUTTON_CLASS}
                  data-testid="btn-train-guess-critical"
                  onClick={() => setGuess('critical')}
                >
                  {GUESS_LABELS.critical}
                </Button>
                <Button
                  variant="brand-outline"
                  className={TRAIN_BUTTON_CLASS}
                  data-testid="btn-train-guess-several"
                  onClick={() => setGuess('several')}
                >
                  {GUESS_LABELS.several}
                </Button>
              </div>
            </div>
          )}
          {/* 190.1 UAT: once the guess is committed the board unlocks — say so
              explicitly, in the same slot the guess buttons occupied. */}
          {guess !== null && !moveApplied && (
            <p className="text-sm font-semibold" data-testid="train-move-prompt">
              Now play a move for {puzzle.side_to_move}
            </p>
          )}
          {moveApplied && isGrading && (
            <div className="flex items-center gap-2" data-testid="train-grading-indicator">
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
              <p className="text-sm font-semibold text-muted-foreground">Checking your move…</p>
            </div>
          )}
          {gradingError && (
            <div className="flex flex-col items-center gap-2" data-testid="train-grading-error">
              <LoadError resource="your move grading" />
              <Button
                variant="brand-outline"
                className={TRAIN_BUTTON_CLASS}
                data-testid="btn-train-retry-grading"
                onClick={retryGrading}
              >
                Retry
              </Button>
            </div>
          )}
        </>
      )}
      </div>
      {showResultRow && (
        <TrainReveal
          puzzle={puzzle}
          sessionId={trainSession.session?.session_id ?? null}
          verdict={verdict}
          isSolveError={trainSession.isSolveError}
          onRetrySolve={trainSession.retrySolve}
          onNext={handleNext}
          onFenChange={setBoardFen}
          gradingEngine={gradingEngine}
          guess={guess}
          playedMoveUci={lastPlayedUci}
          gradeResult={gradeResult}
          playedMoveQuality={playedMoveQuality}
          gameMoveQuality={gameMoveQuality}
          onGameMoveUciChange={setGameMoveUci}
          onGameMoveLineChange={setGameMoveLine}
          onLineStep={setLineStep}
          solutionNonce={solutionNonce}
          spotlightKey={spotlight?.key ?? null}
          onSpotlightChange={setSpotlight}
          isBoardDeparted={isBoardDeparted}
          onReturnToSolution={returnToSolution}
          alsoFineMoves={revealOverlay.alsoFineMoves}
          isExploring={freePlay.isExploring}
          freePlay={freePlay}
          onExitExploration={handleShowSolution}
          flipped={flipped}
          onFlipBoard={handleFlipBoard}
        />
      )}
    </div>
  );
}
