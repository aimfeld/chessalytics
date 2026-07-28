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
import type { ReactElement } from 'react';
import { Chess, type Move } from 'chess.js';
import { Loader2, Search, Volume2, VolumeX } from 'lucide-react';
import { Link } from 'react-router-dom';
import { buildGameAnalysisUrl } from '@/lib/analysisUrl';
import { cn } from '@/lib/utils';
import { ChessBoard } from '@/components/board/ChessBoard';
import { Button } from '@/components/ui/button';
import { LoadError } from '@/components/ui/load-error';
import { TRAIN_BUTTON_CLASS } from '@/components/train/buttonStyles';
import { TrainReveal } from '@/components/train/TrainReveal';
import type { TrainRevealStep } from '@/components/train/TrainReveal';
import type { SolveResponse, TrainPuzzle } from '@/types/train';
import type { UseTrainSessionResult } from '@/hooks/useTrainSession';
import { useFitBoardToViewport } from '@/hooks/useFitBoardToViewport';
import type { GradeResult, TrainEngineLine, TrainGradingEngine } from '@/hooks/useTrainGradingEngine';
import { evalToExpectedScore, sideToMoveFromFen } from '@/lib/liveFlaw';
import { useMarkPlayActive } from '@/lib/playActive';
import { playSound, useMuted, setMuted } from '@/lib/sounds';
import { saveTrainRevealCache } from '@/lib/trainRevealCache';
import type { CachedTrainReveal } from '@/lib/trainRevealCache';
import { GUESS_LABELS } from '@/lib/trainGuessLabels';
import type { Guess } from '@/lib/trainGuessLabels';
import {
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
    setPointsFlash(null);
    trainSession.resetSolve();
    if (restoredSolve === null) startGrading(puzzle.fen);
    return () => {
      abortGrading();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trainSession.resetSolve is a stable useCallback([]) from the hook; including the whole trainSession object would re-fire this effect every render. restoredSolve only ever changes together with puzzle.fen (Train.tsx pairs them), so puzzle.fen already covers it.
  }, [puzzle.fen, startGrading, abortGrading]);

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
    if (moveApplied) return false;

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

  // T-190-12: the verdict/Next/solve-error row only appears once the local
  // grade+solve pipeline has settled (moveApplied && !isGrading && no
  // grading-level error) — it then distinguishes success (lastSolveResponse
  // set) from a solve-POST failure (isSolveError) via the SAME row.
  // 190.1 UAT round 5: a restored reveal's verdict comes from the cache (the
  // solve mutation belongs to the unmounted prior page visit) — but a LIVE
  // solve response always wins, and the restored fallback disappears the
  // moment the puzzle transitions (restoredSolve nulls together with it).
  const verdict = trainSession.lastSolveResponse ?? restoredSolve?.verdict ?? null;
  const showResultRow =
    moveApplied && !isGrading && !gradingError && (verdict !== null || trainSession.isSolveError);

  // 190.1 UAT: the played move's classified quality — derived once here and
  // shared by the board overlay below AND the reveal's line-box header icons
  // (threaded down as a prop), so the two surfaces can never drift.
  const playedMoveQuality = useMemo<TrainMoveQuality | null>(() => {
    if (gradeResult === null || lastPlayedUci === null) return null;
    return classifyTrainMoveQuality(
      gradeResult.esBefore,
      gradeResult.esAfter,
      lastPlayedUci === gradeResult.bestMoveUci,
    );
  }, [gradeResult, lastPlayedUci]);

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
      // `?? []` also covers a stale sessionStorage reveal-cache entry written
      // before fineMoves replaced goodMoveUcis (quick 260726-fma) — the cache's
      // shallow shape check does not validate this field.
      gradeResult?.fineMoves ?? [],
      gradeResult?.bestMoveUci ?? null,
      playedMove,
      gameMoveUci !== null ? { uci: gameMoveUci, quality: gameMoveQuality } : null,
      verdict !== null,
    );
  }, [verdict, gradeResult, lastPlayedUci, playedMoveQuality, gameMoveUci, gameMoveQuality]);

  // 190.1 UAT stepping mode: while a reveal line is stepped away from its
  // start, the solution overlay is cleared; the only marks are the stepped
  // move's quality-colored square highlight and a blue arrow for the line's
  // next move. Back at the start (lineStep === null), the full overlay and
  // the puzzle's own arrival-move highlight return.
  const boardArrows = lineStep !== null ? buildTrainStepArrows(lineStep.nextMoveUci) : revealOverlay.arrows;
  // 190.1 UAT round 4: while stepping, the line's FIRST move keeps its
  // quality icon badge on the moved-to square (deeper steps show none).
  const boardMarkers =
    lineStep !== null
      ? buildTrainStepMarkers(lineStep.lastMoveUci, lineStep.quality, lineStep.isFirstMove)
      : revealOverlay.markers;
  const boardLastMove =
    lineStep !== null
      ? { from: lineStep.lastMoveUci.slice(0, 2), to: lineStep.lastMoveUci.slice(2, 4) }
      : lastMove;
  const boardLastMoveColor =
    lineStep !== null && lineStep.quality !== null ? TRAIN_STEP_HIGHLIGHT[lineStep.quality] : undefined;

  // 190.1 UAT rounds 6+7 / SEED-119: the reveal plays a per-score result
  // sound AND pops the "Points: +N" flash over the board the moment a LIVE
  // solve response lands — never for a restored reveal (its solve happened
  // on a prior page visit). The full per-puzzle max (3, guess + a good move)
  // plays WinChime (round 7: the Victory fanfare read too aggressive here,
  // same verdict as bot games); any lesser positive score (e.g. guess-only,
  // or guess plus an inaccuracy) plays LowTime; 0 points plays Defeat. The
  // ref keeps StrictMode's dev-only double effect invocation (and any later
  // re-render with the same response object) from playing it twice;
  // playSound itself honors the shared mute preference.
  const liveSolveResponse = trainSession.lastSolveResponse;
  const soundedSolveRef = useRef<SolveResponse | null>(null);
  useEffect(() => {
    if (liveSolveResponse === null || soundedSolveRef.current === liveSolveResponse) return;
    soundedSolveRef.current = liveSolveResponse;
    const points = scorePuzzle(liveSolveResponse.correct_guess, liveSolveResponse.move_quality);
    playSound(points === TRAIN_POINTS_PER_PUZZLE ? 'game-win' : points > 0 ? 'low-time' : 'game-loss');
    setPointsFlash(points);
  }, [liveSolveResponse]);

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

  // SEED-119: the badge's color pair for the current pointsFlash tier,
  // falling back to the 0-point entry (never an unreadable bg/fg pair) when
  // pointsFlash holds a value outside the known 0-3 range. The `!` is safe:
  // key 0 is always present in TRAIN_POINTS_FLASH_COLORS by construction.
  const pointsFlashColors =
    pointsFlash !== null
      ? (TRAIN_POINTS_FLASH_COLORS[pointsFlash] ?? TRAIN_POINTS_FLASH_COLORS[0]!)
      : undefined;

  function handleShowSolution(): void {
    setSolutionNonce((n) => n + 1);
    setBoardFen(puzzle.fen);
    setLineStep(null);
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
      className="flex w-full flex-col items-center gap-4 lg:flex-row lg:items-start lg:justify-center lg:gap-8"
      data-testid="train-solve-screen"
    >
      <div
        ref={columnRef}
        className="flex w-full flex-col items-center gap-4"
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
      <div ref={boardRef} className="relative w-full">
        <ChessBoard
          position={boardFen}
          flipped={puzzle.side_to_move === 'black'}
          lastMove={boardLastMove}
          lastMoveColor={boardLastMoveColor}
          onPieceDrop={handlePieceDrop}
          arrows={boardArrows}
          squareMarkers={boardMarkers}
          maxWidth={boardMaxWidthPx}
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
      {/* 190.1 UAT round 3: Solution + Analyze + Next directly below the
          board, sharing its width evenly (plus the round-4 mute icon at the
          right edge). Solution resets every
          reveal stepper (and the board) back to the puzzle position. Analyze
          deep-links one ply BEFORE the mistake: the analysis board's mainline
          index k holds the position AFTER k+1 half-moves, so passing
          puzzle.ply itself would land one half-move too late. */}
      {verdict !== null && (
        <div className="flex w-full items-center gap-2">
          <Button
            variant="brand-outline"
            className={cn('flex-1', TRAIN_BUTTON_CLASS)}
            data-testid="btn-train-solution"
            onClick={handleShowSolution}
          >
            Solution
          </Button>
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
        />
      )}
    </div>
  );
}
