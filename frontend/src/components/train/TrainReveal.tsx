/**
 * TrainReveal — the auto-opening post-solve reveal panel (SOLV-05/06/07-
 * adjacent, D-07..D-12 from Phase 190, D-01..D-05 from Phase 190.1).
 *
 * Auto-opens as soon as grading and the solve POST have BOTH landed — no
 * "show solution" tap (D-07). Order (190.1 UAT round 3): the guess verdict
 * line, outcome copy (D-11), mastered hint (D-12, countdown removed), up to
 * three steppable engine-line boxes (190.1-03 D-03; the move verdict is the
 * Your-move box's header mark, in canonical your > best > game order — UAT
 * round 5 reversed round 3's best-leads-on-a-miss rule), then
 * the compact game footer (SOLV-05). The opt-in tactic stepper (SOLV-06) was
 * REMOVED per 190.1 UAT round 4 — confusing, not needed. The Solution/
 * Analyze/Next row lives below the board in TrainSolveScreen.
 *
 * 190.1-03: every line box's eval/PV comes from the client grading engine
 * (`GradeResult.bestLine`/`.playedLine` from `gradeMove`, and the reveal-time
 * "played in game" search from 190.1-01) — never a stored server line/eval
 * (D-01). A previous plan's stored best line (`PuzzleRevealResponse.pv`) is
 * no longer read here.
 *
 * T-190-16 (Information Disclosure — speculative prefetch): both
 * answer-adjacent fetches this component owns (the reveal GET and the game
 * card) are gated on the solve response being present (`verdict !== null`) —
 * neither ever fires before the solve POST has actually succeeded.
 *
 * When the solve POST has NOT succeeded (still pending, or failed), this
 * component renders only the pre-existing block-and-retry row (190-04) —
 * same test ids, same disabled-Next contract — so 190-04's own regression
 * coverage (`TrainSolveScreen.test.tsx`) keeps passing unchanged.
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Chess } from 'chess.js';
import { Loader2 } from 'lucide-react';
import { trainApi } from '@/api/client';
import { useLibraryGame } from '@/hooks/useLibrary';
import { Button } from '@/components/ui/button';
import { TRAIN_BUTTON_CLASS } from '@/components/train/buttonStyles';
import { LoadError } from '@/components/ui/load-error';
import { TrainLineStepper } from '@/components/train/TrainLineStepper';
import type { TrainLineStep } from '@/components/train/TrainLineStepper';
import { TrainFlawFixedBanner } from '@/components/train/TrainFlawFixedBanner';
import { replayPvLine, formatScore } from '@/components/analysis/EngineLines';
import { TRAIN_VERDICT_CORRECT, TRAIN_VERDICT_INCORRECT } from '@/lib/theme';
import type { TrainMoveQuality } from '@/lib/trainArrows';
import { GUESS_LABELS } from '@/lib/trainGuessLabels';
import type { Guess } from '@/lib/trainGuessLabels';
import { formatDateWithYear } from '@/lib/utils';
import { formatTimeControl } from '@/lib/formatTimeControl';
import type { GradeResult, TrainEngineLine, TrainGradingEngine } from '@/hooks/useTrainGradingEngine';
import type { PuzzleRevealResponse, SolveResponse, TrainPuzzle } from '@/types/train';

/** 190.1-01/03: the role label for the reveal's "played in game" line. */
const GAME_MOVE_LINE_TITLE = 'Played in game';

/** 190.1-03 D-03: role keys for the three steppable engine lines, in their
 * canonical display AND testid-precedence order (your > best > game). */
type RoleKey = 'your' | 'best' | 'game';

const ROLE_LABELS: Record<RoleKey, string> = {
  your: 'Your move',
  best: 'Best move',
  game: GAME_MOVE_LINE_TITLE,
};

const ROLE_TESTIDS: Record<RoleKey, string> = {
  your: 'train-line-box-your-move',
  best: 'train-line-box-best-move',
  game: 'train-line-box-game-move',
};

const CANONICAL_ROLE_ORDER: readonly RoleKey[] = ['your', 'best', 'game'];

/**
 * One steppable line box's resolved render data (190.1-03 D-03: when two of
 * the three role's first moves coincide, they render as ONE box carrying
 * both role labels, never two boxes repeating the same move).
 *
 * `line === null` means "defer to the game-move search's own idle/loading/
 * ready/error state machine" — the only role that can ever be in that state
 * is a STANDALONE 'game' box (`roles` is exactly `['game']`), since 'your'/
 * 'best' are only ever added to `roles` when `gradeResult` already supplies
 * their line synchronously.
 */
interface LineBox {
  roles: RoleKey[];
  testid: string;
  title: string;
  line: TrainEngineLine | null;
  /** Quality of the box's (shared) first move, for the header icon and the
   * step highlight (190.1 UAT): 'best' whenever the best move is in the box,
   * else the played move's own quality, else the game move's searched
   * quality. Null while not yet known (standalone game box pre-search). */
  quality: TrainMoveQuality | null;
  /** The move verdict's mark (190.1 UAT round 3), carried by any box that
   * includes the 'your' role: green check when correct_move, red cross
   * otherwise. Null for boxes without the user's own move. */
  mark: 'correct' | 'incorrect' | null;
}

/**
 * One reveal-line step report to the board owner (190.1 UAT): the move that
 * led to the currently shown position with its quality (colors the last-move
 * square highlight), and the line's next move (drawn as a blue engine-line
 * arrow). A null report means "back at the puzzle position — show the full
 * solution overlay again".
 */
export interface TrainRevealStep {
  lastMoveUci: string;
  quality: TrainMoveQuality | null;
  nextMoveUci: string | null;
  /** True when the shown position is one move into the line (190.1 UAT
   * round 4) — the board owner adds the quality icon badge on the moved-to
   * square for the FIRST move only (deeper steps are engine continuations). */
  isFirstMove: boolean;
}

/**
 * Groups the up-to-three role lines by coincident first-move UCI (190.1-03
 * D-03). Merge-precedence rule for which line's data is DISPLAYED (distinct
 * from testid precedence, which is always your > best > game): 'best'
 * present -> best line (played==best fast path, or best alone, or best==
 * game); else 'your' present -> played line (your alone, or your==game);
 * else the box is a standalone 'game' box with no synchronous line (the
 * caller renders its own loading/ready/error states).
 */
function buildLineBoxes(
  puzzleFen: string,
  playedMoveUci: string | null,
  gradeResult: GradeResult | null,
  gameMoveUci: string | null,
  playedMoveQuality: TrainMoveQuality | null,
  gameMoveQuality: TrainMoveQuality | null,
  correctMove: boolean,
): LineBox[] {
  const uciByRole: Partial<Record<RoleKey, string>> = {};
  if (gradeResult !== null && playedMoveUci !== null) uciByRole.your = playedMoveUci;
  const bestUci = gradeResult?.bestLine.moves[0];
  if (bestUci !== undefined) uciByRole.best = bestUci;
  if (gameMoveUci !== null) uciByRole.game = gameMoveUci;

  // 190.1 UAT round 5 (reverses round 3's best-leads-on-a-miss order): the
  // display order is ALWAYS canonical — Your move on top of Best move — so
  // the user's own move is the first thing read regardless of the verdict.
  const boxes: LineBox[] = [];
  const consumed = new Set<RoleKey>();

  for (const role of CANONICAL_ROLE_ORDER) {
    if (consumed.has(role)) continue;
    const uci = uciByRole[role];
    if (uci === undefined) continue;
    const roles = CANONICAL_ROLE_ORDER.filter((r) => uciByRole[r] === uci);
    roles.forEach((r) => consumed.add(r));
    const line = roles.includes('best')
      ? (gradeResult?.bestLine ?? null)
      : roles.includes('your')
        ? (gradeResult?.playedLine ?? null)
        : null; // standalone 'game' box — caller supplies the search-derived line
    // testid precedence your > best > game — roles is already filtered from
    // CANONICAL_ROLE_ORDER, so roles[0] is the highest-precedence role here.
    const primaryRole = roles[0] ?? role;
    const quality: TrainMoveQuality | null = roles.includes('best')
      ? 'best'
      : roles.includes('your')
        ? playedMoveQuality
        : gameMoveQuality;
    const san = sanFromPlayedUci(puzzleFen, uci);
    boxes.push({
      roles,
      testid: ROLE_TESTIDS[primaryRole],
      title: roles.map((r) => ROLE_LABELS[r]).join(' / ') + (san !== null ? `: ${san}` : ''),
      line,
      quality,
      mark: roles.includes('your') ? (correctMove ? 'correct' : 'incorrect') : null,
    });
  }
  return boxes;
}

/**
 * Local discriminated state for the reveal-time "played in game" search
 * (190.1-01/03). Only ever populated for a STANDALONE 'game' box — the
 * dispatching effect below skips the search entirely when the game move
 * coincides with `playedMoveUci` or `gradeResult.bestLine.moves[0]`.
 */
type GameMoveLineState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; line: TrainEngineLine }
  | { status: 'error' };

export interface TrainRevealProps {
  puzzle: TrainPuzzle;
  /** Active session id — needed for the reveal GET's URL. Null only in a
   * defensive/impossible state (a solve response cannot exist without an
   * active session), guarded by the query's own `enabled` gate. */
  sessionId: number | null;
  /** The solved puzzle's server verdict, or null while the solve mutation is
   * still pending/erroring (see module docstring). */
  verdict: SolveResponse | null;
  isSolveError: boolean;
  onRetrySolve: () => void;
  onNext: () => void;
  /** Wired straight to the shared board's position state — the reveal never
   * mounts its own board (D-08/D-09). */
  onFenChange: (fen: string) => void;
  /** The session-scoped grading engine (190.1-01) — threaded from
   * `TrainSolveScreen`, which already holds it. Supplies the reveal-time
   * "played in game" search via `startGameMoveSearch`. */
  gradingEngine: TrainGradingEngine;
  /** The guess the user committed before playing a move — spelled out on the
   * verdict row with the SAME wording as the guess buttons (190.1-03 D-03).
   * Null only in a defensive/impossible state (a verdict cannot exist
   * without a prior guess commit). */
  guess: Guess | null;
  /** The UCI of the move the user actually played — derives the verdict
   * row's SAN token and doubles as the 'your' role's line-box key. */
  playedMoveUci: string | null;
  /** The `gradeMove` result for `playedMoveUci` — supplies the 'your' and
   * 'best' role lines/evals with no further engine search (190.1-03 D-01). */
  gradeResult: GradeResult | null;
  /** The played move's classified quality (190.1 UAT) — derived once by the
   * board owner (TrainSolveScreen) from `gradeResult`, threaded here for the
   * line-box header icons so the icon and the board badge can never drift. */
  playedMoveQuality?: TrainMoveQuality | null;
  /** The game move's classified quality (190.1 UAT) — derived by the board
   * owner from the reported game-move line (see `onGameMoveLineChange`), or
   * from the coinciding played/best move. Null while unknown. */
  gameMoveQuality?: TrainMoveQuality | null;
  /**
   * 190.1-04 (D-02): reports the reveal query's resolved game-move UCI to the
   * board owner (TrainSolveScreen), which needs it to draw the thin white
   * game-move arrow, without lifting the reveal query itself out of this
   * component. Called with `null` on cleanup (puzzle transition/unmount) so a
   * stale prior-puzzle game move never leaks into the next puzzle's arrows.
   */
  onGameMoveUciChange?: (uci: string | null) => void;
  /**
   * 190.1 UAT: reports the reveal-time search's resolved game-move line to
   * the board owner, which derives the game move's QUALITY from it (for the
   * quality badge on the game-move arrow's target square). Called with `null`
   * on cleanup/re-dispatch so a stale line never outlives its search. Not
   * called at all when the game move coincides with the played/best move (no
   * search runs — the board owner derives the quality from the coinciding
   * move instead).
   */
  onGameMoveLineChange?: (line: TrainEngineLine | null) => void;
  /**
   * 190.1 UAT: reports the current line-stepping state to the board owner.
   * Non-null while a line is stepped away from its start (the board owner
   * clears the solution overlay, highlights the reported last move in its
   * quality color, and draws the blue next-move arrow); null when back at the
   * start position (full solution overlay restored).
   */
  onLineStep?: (step: TrainRevealStep | null) => void;
  /**
   * 190.1 UAT round 3: the Solution/Analyze/Next row moved out of this
   * component to below the board (TrainSolveScreen). The board owner bumps
   * this nonce when its Solution button is pressed; every stepper here keys
   * its reset on it, snapping the reveal back to the puzzle position.
   */
  solutionNonce?: number;
}

/**
 * D-11/190.1-03 assumption-delta: neutral-factual outcome copy. A herring
 * always reads as "handled well" regardless of the guess/move verdict (a
 * herring has no critical move by definition). The prior miss sentence
 * ("In the game you played X. Best was Y.") is REMOVED — its two facts are
 * now stated with live evals by the played-in-game and best-move line boxes,
 * and its data source (`best_move_san`) is one of the fields Task 3 removes.
 * A correct, non-herring puzzle (or a genuine miss) renders no outcome
 * sentence at all; the verdict rows and line boxes already say everything.
 */
function outcomeCopy(verdict: SolveResponse): string | null {
  if (verdict.puzzle_type === 'herring') {
    return 'You handled this well in the game — several moves are fine.';
  }
  return null;
}

/** UCI ("e2e4"/"e7e8q") -> SAN via chess.js from `fen`, or null on a null/
 * malformed/illegal input — the move row falls back to the bare mark rather
 * than rendering a broken token (190.1-03 Task 1). */
function sanFromPlayedUci(fen: string, uci: string | null): string | null {
  if (uci === null || uci.length < 4) return null;
  try {
    const chess = new Chess(fen);
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
    });
    return move ? move.san : null;
  } catch {
    return null;
  }
}

export function TrainReveal({
  puzzle,
  sessionId,
  verdict,
  isSolveError,
  onRetrySolve,
  onNext,
  onFenChange,
  gradingEngine,
  guess,
  playedMoveUci,
  gradeResult,
  playedMoveQuality = null,
  gameMoveQuality = null,
  onGameMoveUciChange,
  onGameMoveLineChange,
  onLineStep,
  solutionNonce = 0,
}: TrainRevealProps): ReactElement | null {
  const { startGameMoveSearch } = gradingEngine;

  /**
   * Per-stepper step handler (190.1 UAT): forwards the stepped FEN to the
   * shared board and reports the stepping state up. The first move of a line
   * carries that line's own quality (plus its icon badge on the board, UAT
   * round 4 via `isFirstMove`); every deeper move is an engine continuation
   * and reads as 'good' (green highlight — UAT round 3; the blue 'best'
   * highlight read as the gem violet on the wood board). The next-move arrow
   * stays engine-blue regardless. `firstMoveQuality: null` (unresolved game
   * box) reports a quality-less step (default highlight, still a blue
   * next-move arrow).
   */
  function handleLineStep(firstMoveQuality: TrainMoveQuality | null) {
    return (step: TrainLineStep): void => {
      onFenChange(step.fen);
      if (step.index === 0 || step.lastMoveUci === null) {
        onLineStep?.(null);
        return;
      }
      onLineStep?.({
        lastMoveUci: step.lastMoveUci,
        quality: step.index === 1 ? firstMoveQuality : 'good',
        nextMoveUci: step.nextMoveUci,
        isFirstMove: step.index === 1,
      });
    };
  }

  // T-190-16: disabled until the solve POST has landed — no speculative
  // pre-attempt fetch, no answer-key data reachable before this gate flips.
  const revealQuery = useQuery<PuzzleRevealResponse>({
    queryKey: ['train-reveal', sessionId, puzzle.position],
    queryFn: () => trainApi.revealPuzzle(sessionId as number, puzzle.position),
    enabled: verdict !== null && sessionId !== null,
    staleTime: Infinity, // the answer key never changes once solved
  });

  // SOLV-05/T-190-16: same gate — the game card fetch is disabled until the
  // solve response is present, never fetched speculatively on mount.
  const gameQuery = useLibraryGame(verdict !== null ? puzzle.game_id : null);

  // 190.1-01, D-01 point 3 / T-190.1-02: dispatched exclusively off
  // `revealQuery.data` — reachable only once the reveal GET has itself
  // succeeded, which is already gated on the solve POST having landed. No
  // engine search on the game move can fire before that.
  const gameMoveUci = revealQuery.data?.played_in_game_move_uci ?? null;

  // 190.1-04 (D-02): report the resolved game-move UCI to the board owner so
  // it can draw the thin white game-move arrow — fires whenever the reveal
  // query's played_in_game_move_uci resolves, and with null on cleanup
  // (puzzle transition/unmount) so a stale value never leaks forward.
  useEffect(() => {
    onGameMoveUciChange?.(gameMoveUci);
    return () => {
      onGameMoveUciChange?.(null);
    };
  }, [gameMoveUci, onGameMoveUciChange]);

  const [gameMoveLine, setGameMoveLine] = useState<GameMoveLineState>({ status: 'idle' });
  useEffect(() => {
    if (gameMoveUci === null) {
      setGameMoveLine({ status: 'idle' });
      return;
    }
    // 190.1-03 D-03: when the game move coincides with the played move or the
    // engine's best move, the merged box uses that SURVIVING entry's line —
    // no reveal-time search is dispatched at all.
    const coincidesWithYourOrBest =
      gameMoveUci === playedMoveUci ||
      (gradeResult !== null && gameMoveUci === gradeResult.bestLine.moves[0]);
    if (coincidesWithYourOrBest) {
      setGameMoveLine({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setGameMoveLine({ status: 'loading' });
    startGameMoveSearch(puzzle.fen, gameMoveUci)
      .then((line) => {
        if (cancelled) return;
        setGameMoveLine({ status: 'ready', line });
        // 190.1 UAT: hand the resolved line to the board owner so the
        // game-move arrow can carry its quality badge.
        onGameMoveLineChange?.(line);
      })
      .catch(() => {
        if (cancelled) return;
        setGameMoveLine({ status: 'error' });
      });
    return () => {
      cancelled = true;
      onGameMoveLineChange?.(null);
    };
  }, [gameMoveUci, puzzle.fen, startGameMoveSearch, playedMoveUci, gradeResult, onGameMoveLineChange]);

  if (verdict === null) {
    // Grading/solve has not landed successfully yet. Only the pre-existing
    // block-and-retry row applies (190-04) — same shape, same test ids.
    if (!isSolveError) return null;
    return (
      <div className="flex flex-col items-center gap-2" data-testid="train-solve-error">
        <p className="text-sm font-semibold">Couldn&apos;t save your result.</p>
        <Button
          variant="brand-outline"
          className={TRAIN_BUTTON_CLASS}
          data-testid="btn-train-solve-retry"
          onClick={onRetrySolve}
        >
          Retry
        </Button>
        <Button
          variant="default"
          className={TRAIN_BUTTON_CLASS}
          data-testid="btn-train-next"
          disabled
          onClick={onNext}
        >
          Next
        </Button>
      </div>
    );
  }

  const outcome = outcomeCopy(verdict);
  // PROG-03/D-14: the mastery banner supersedes the old plain "Mastered —
  // retired." comeback hint. Same trigger condition the removed
  // `comebackHint` used — a herring carries no SR bookkeeping (POOL-08) so
  // it never shows the banner.
  const showFlawFixedBanner =
    verdict.puzzle_type !== 'herring' && verdict.item_status === 'mastered';
  const gameMoveSan = revealQuery.data?.played_in_game_san ?? null;
  // Shared header for the non-ready standalone game-move-box states
  // (loading/error/idle) — the SAN is the only reveal-payload value ever
  // shown here (never a stored eval/line as a failure-mode fallback).
  const gameMoveTitle = (
    <p className="text-xl font-semibold truncate">
      {GAME_MOVE_LINE_TITLE}
      {gameMoveSan != null && `: ${gameMoveSan}`}
    </p>
  );

  const lineBoxes = buildLineBoxes(
    puzzle.fen,
    playedMoveUci,
    gradeResult,
    gameMoveUci,
    playedMoveQuality,
    gameMoveQuality,
    verdict.correct_move,
  );

  // Opponent-and-rating for the game footer: the side the user did NOT play.
  const game = gameQuery.data ?? null;
  const opponentName =
    game !== null
      ? game.user_color === 'white'
        ? (game.black_username ?? '?')
        : (game.white_username ?? '?')
      : null;
  const opponentRating =
    game !== null ? (game.user_color === 'white' ? game.black_rating : game.white_rating) : null;

  return (
    // lg:mt-[46px] (190.1 UAT round 4): on desktop the board column starts
    // with its progress block (20px text row + 4px gap + 6px bar + the
    // column's 16px gap = 46px before the board itself), so this offset
    // top-aligns the Guess verdict with the TOP OF THE BOARD, not the
    // progress text. Keep in sync with TrainSolveScreen's progress block.
    <div className="flex w-full flex-col gap-4 lg:mt-[46px] lg:max-w-sm" data-testid="train-reveal">
      {/* 1. Guess verdict (190.1 UAT round 3) — one line in the same style as
          the line-box headers, with the server-computed mark (never a
          client-side re-derivation of correct_guess). The MOVE verdict now
          lives on the Your-move box's own header mark, not a separate row. */}
      <p className="text-xl font-semibold" data-testid="train-verdict-guess">
        Guess: {guess !== null ? GUESS_LABELS[guess] : ''}
        <span
          className="ml-1"
          style={{ color: verdict.correct_guess ? TRAIN_VERDICT_CORRECT : TRAIN_VERDICT_INCORRECT }}
        >
          {verdict.correct_guess ? '✓' : '✗'}
        </span>
      </p>

      {/* 2. Outcome copy (D-11) — the herring "handled well" sentence, or
          nothing (the miss sentence is retired — see outcomeCopy's doc). */}
      {outcome && (
        <p className="text-base font-normal" data-testid="train-outcome-copy">
          {outcome}
        </p>
      )}

      {/* 3. Flaw fixed banner (PROG-03/D-14) — supersedes the D-12 plain
          "Mastered — retired." comeback hint; nothing for a herring or a
          non-mastered item. */}
      {showFlawFixedBanner && <TrainFlawFixedBanner fen={puzzle.fen} />}

      {revealQuery.isError && (
        <p className="text-sm font-semibold text-muted-foreground" data-testid="train-reveal-error">
          Couldn&apos;t load the full reveal details.
        </p>
      )}

      {/* 4. Up to three steppable engine-line boxes (190.1-03 D-03) — one per
          DISTINCT first move (your move / best move / played in game),
          merged when two or three coincide. Every eval/line comes from the
          client grading engine (`gradeResult` or the reveal-time search
          below), never a stored server line. */}
      {lineBoxes.map((box) =>
        box.line !== null ? (
          <div key={box.testid} className="flex flex-col gap-2" data-testid={box.testid}>
            <TrainLineStepper
              moves={replayPvLine(puzzle.fen, box.line.moves)
                .map((step) => step.san)
                .filter((san): san is string => san !== null)}
              startFen={puzzle.fen}
              title={box.title}
              evalLabel={formatScore(box.line.evalCp, box.line.evalMate)}
              quality={box.quality}
              mark={box.mark}
              resetNonce={solutionNonce}
              onStepChange={handleLineStep(box.quality)}
            />
          </div>
        ) : (
          // Standalone 'game' box — defers to the reveal-time search's own
          // idle/loading/ready/error state machine (190.1-01 Task 2).
          <div key={box.testid} className="flex flex-col gap-2" data-testid={box.testid}>
            {gameMoveLine.status === 'ready' && (
              <TrainLineStepper
                moves={replayPvLine(puzzle.fen, gameMoveLine.line.moves)
                  .map((step) => step.san)
                  .filter((san): san is string => san !== null)}
                startFen={puzzle.fen}
                title={box.title}
                evalLabel={formatScore(gameMoveLine.line.evalCp, gameMoveLine.line.evalMate)}
                quality={gameMoveQuality}
                resetNonce={solutionNonce}
                onStepChange={handleLineStep(gameMoveQuality)}
              />
            )}
            {gameMoveLine.status === 'loading' && (
              <div className="flex items-center gap-2" data-testid="train-game-line-loading">
                {gameMoveTitle}
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
              </div>
            )}
            {gameMoveLine.status === 'error' && (
              <div className="flex flex-col gap-2" data-testid="train-game-line-error">
                {gameMoveTitle}
                <LoadError resource="the played-in-game engine line" />
              </div>
            )}
            {gameMoveLine.status === 'idle' && gameMoveTitle}
          </div>
        ),
      )}

      {/* 4a. Idle SAN-only game-move box (190.1-01): the game move has no
          derivable UCI (an unparseable SAN) but the SAN itself is known —
          renders the header alone, never a stepper. Not part of `lineBoxes`
          (it has no UCI to merge/compare by). */}
      {gameMoveUci === null && gameMoveSan !== null && (
        <div className="flex flex-col gap-2" data-testid="train-line-box-game-move">
          {gameMoveTitle}
        </div>
      )}

      {/* 5. Game footer (190.1-03 D-03, format per 190.1 UAT round 3):
          "Game: <TC> · vs <opponent> (<elo>) · <date>" — same `useLibraryGame`
          fetch and solve-response gate as before. The Solution/Analyze/Next
          row that used to close this panel now lives below the board
          (TrainSolveScreen, UAT round 3).

          D-07 (Phase 192): a herring reveal omits this footer entirely — "vs
          <opponent>" has no referent when the solver was never a participant
          in a stranger's game, and the reveal already labels the puzzle a
          herring outright, so dropping the line leaks nothing new. Both the
          error branch and the success branch sit behind the SAME
          `puzzle_type !== 'herring'` gate — gating only the success branch
          would leave a herring free to render "Failed to load the game" for
          a `useLibraryGame` query that (for a null `game_id`, D-09) never
          fired in the first place. */}
      {verdict.puzzle_type !== 'herring' && (
        <>
          {gameQuery.isError && (
            <LoadError resource="the game" data-testid="train-gamecard-error" />
          )}
          {game !== null && (
            <p className="text-sm text-muted-foreground" data-testid="train-reveal-footer">
              Game:{' '}
              {game.time_control_bucket !== null && (
                <>
                  <span className="capitalize">{game.time_control_bucket}</span>
                  {game.time_control_str !== null && ` ${formatTimeControl(game.time_control_str)}`}
                  {' · '}
                </>
              )}
              vs {opponentName}
              {opponentRating !== null && ` (${opponentRating})`}
              {game.played_at !== null && ` · ${formatDateWithYear(game.played_at)}`}
            </p>
          )}
        </>
      )}
    </div>
  );
}
