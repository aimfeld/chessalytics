/**
 * TrainReveal — the auto-opening post-solve reveal panel (SOLV-05/06/07-
 * adjacent, D-07..D-12 from Phase 190, D-01..D-05 from Phase 190.1).
 *
 * Auto-opens as soon as grading and the solve POST have BOTH landed — no
 * "show solution" tap (D-07). Order (190.1 UAT round 3, regrouped in Phase 200
 * UAT round 6): the guess-feedback card (verdict + score chip in its header,
 * outcome copy (D-11) and the Also fine move list in its body), mastered hint
 * (D-12, countdown removed), up to
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

import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Chess } from 'chess.js';
import { Loader2, X } from 'lucide-react';
import { trainApi } from '@/api/client';
import { useLibraryGame } from '@/hooks/useLibrary';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { Button } from '@/components/ui/button';
import { TRAIN_BUTTON_CLASS } from '@/components/train/buttonStyles';
import { LoadError } from '@/components/ui/load-error';
import { TrainLineStepper } from '@/components/train/TrainLineStepper';
import type { TrainLineStep } from '@/components/train/TrainLineStepper';
import { TrainFlawFixedBanner } from '@/components/train/TrainFlawFixedBanner';
import { VariationTree } from '@/components/analysis/VariationTree';
import { BoardControls } from '@/components/board/BoardControls';
import { ArrowGlyphIcon } from '@/components/icons/ArrowGlyphIcon';
import { MoveQualityIcon } from '@/components/icons/MoveQualityIcon';
import { Card, CardHeader, CardBody } from '@/components/ui/card';
import {
  EngineLines,
  EngineLinesSkeleton,
  MAX_LINES,
  replayPvLine,
  formatScore,
} from '@/components/analysis/EngineLines';
import { DARK_GREEN } from '@/lib/arrowColor';
import { BEST_MOVE_ARROW, TRAIN_VERDICT_CORRECT, TRAIN_VERDICT_INCORRECT } from '@/lib/theme';
import { toDisplayQuality, trainGlyphColor } from '@/lib/trainArrows';
import type { TrainFineMove, TrainMoveQuality } from '@/lib/trainArrows';
import { GUESS_POINTS, MOVE_TIER_POINTS } from '@/lib/trainScore';
import { GUESS_LABELS, guessFeedbackProse } from '@/lib/trainGuessLabels';
import type { Guess } from '@/lib/trainGuessLabels';
import { cn, formatDateWithYear } from '@/lib/utils';
import { formatTimeControl } from '@/lib/formatTimeControl';
import type { GradeResult, TrainEngineLine, TrainGradingEngine } from '@/hooks/useTrainGradingEngine';
import type { TrainFreePlayState } from '@/hooks/useTrainFreePlay';
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
 * Phase 200 UAT: a line box steps at most this many plies (six full moves —
 * about two wrapped token rows; UAT round 3 raised it from ten). The deep tail
 * of a long PV is noise on the reveal, and before this cap the stepper's
 * internal scroll was standing in for a limit that was never set.
 */
const MAX_LINE_PLIES = 12;

/** Phase 200 (LEGEND-04): the spotlight key for the alternative fine moves.
 * They lost their own card in UAT round 6 (they live in the guess card's body
 * now), but the key is unchanged — it identifies the spotlight ENTRY, which
 * still covers exactly the same set of green arrows. */
const ALSO_FINE_KEY = 'train-reveal-also-fine';

/** Phase 200 (LEGEND-02): one legend entry's spotlight payload — the box's own
 * testid key plus the UCIs its card/glyph spotlights together. */
interface SpotlightEntry {
  key: string;
  ucis: string[];
}

/**
 * Phase 200 UAT: the whole-card (and whole-row) click/tap handler.
 *
 * On mobile a tap anywhere on the card toggles its spotlight. The arrow glyph
 * is deliberately NOT a button (UAT: "the glyph icon doesn't need any special
 * handlers"), so a tap on it reads as a tap on the card and can never toggle
 * the card's spotlight off on its own.
 *
 * A tap on a button INSIDE the card (the stepper's prev/next controls and its
 * SAN tokens) keeps doing its own job and ALSO highlights the card (UAT round
 * 8) — stepping a line is exactly the moment the user needs to see which box
 * is driving the board. That branch only ever turns the spotlight ON: toggling
 * would strobe the highlight off on every second tap of next, and un-highlight
 * the box the user is actively stepping.
 *
 * UAT round 9: when the board has DEPARTED the pristine solution (a line is
 * stepped into, or free play is running), a click/tap on any card first snaps
 * the board back to the solution position and THEN spotlights that card — on
 * both viewports. Before this, clicking the "Played in game" card while three
 * plies deep into the best line only moved the card ring: the board kept
 * showing the other line's position, so the card's own move was nowhere on
 * screen. This branch never toggles the spotlight off — the click's whole
 * point is to show that card's move, and desktop hover has already set it.
 */
function makeCardClickHandler({
  isDesktop,
  isSpotlit,
  isBoardDeparted,
  entry,
  onSpotlightChange,
  onReturnToSolution,
}: {
  isDesktop: boolean;
  isSpotlit: boolean;
  isBoardDeparted: boolean;
  entry: SpotlightEntry;
  onSpotlightChange?: (entry: SpotlightEntry | null) => void;
  onReturnToSolution?: () => void;
}): (event: MouseEvent<HTMLElement>) => void {
  return (event) => {
    if (event.target instanceof Element && event.target.closest('button') !== null) {
      if (!isDesktop && !isSpotlit) onSpotlightChange?.(entry);
      return;
    }
    if (isBoardDeparted) {
      // Order matters: the reset clears the board owner's spotlight, so the
      // entry is re-applied after it. Both land in the same React event, so
      // they batch and the entry wins.
      onReturnToSolution?.();
      onSpotlightChange?.(entry);
      return;
    }
    // Desktop, board already pristine: inert. Hover is the only spotlight
    // driver there, and a click-toggle would fight the pointer-enter that just
    // fired, leaving the card un-spotlit while the pointer still sits on it.
    if (isDesktop) return;
    onSpotlightChange?.(isSpotlit ? null : entry);
  };
}

/**
 * The SAN tokens for one line box's stepper: the engine PV replayed from the
 * puzzle position (dropping any token chess.js could not replay), capped at
 * `MAX_LINE_PLIES`. Shared by both stepper call sites so the cap can never
 * apply to one box and not the other.
 */
function lineSanTokens(startFen: string, moves: string[]): string[] {
  return replayPvLine(startFen, moves)
    .map((step) => step.san)
    .filter((san): san is string => san !== null)
    .slice(0, MAX_LINE_PLIES);
}

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
  /** The box's (shared) first-move UCI — Phase 200 (LEGEND-01/LEGEND-02):
   * drives both the legend glyph's color derivation and the spotlight's
   * `activeUcis` filter. Always defined: a box only exists when at least one
   * role resolved a UCI (see `buildLineBoxes`). */
  uci: string;
  title: string;
  line: TrainEngineLine | null;
  /** Quality of the box's (shared) first move, for the header icon and the
   * step highlight (190.1 UAT): 'best' whenever the best move is in the box,
   * else the played move's own quality, else the game move's searched
   * quality. Null while not yet known (standalone game box pre-search). */
  quality: TrainMoveQuality | null;
  /** Phase 200 UAT round 3: the MOVE points the user actually earned (0-2,
   * from the server's own `move_quality` tier), shown as the header's score
   * chip — it replaced the green check / red cross mark. Null for boxes
   * without the user's own move. */
  movePoints: number | null;
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
  /**
   * Phase 200 (EXPLORE-02): unlike `TrainLineStep.prefixUci` (which excludes
   * the move that led to the reported position), this reports the COMPLETE
   * chain of moves already played from `puzzle.fen` to reach the position
   * currently ON THE BOARD — i.e. the stepper's own `prefixUci` PLUS
   * `lastMoveUci`. Seeds exploration's move list when it starts from a
   * stepped-into line position.
   */
  prefixUci: string[];
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
  movePoints: number,
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
      uci,
      title: roles.map((r) => ROLE_LABELS[r]).join(' / ') + (san !== null ? `: ${san}` : ''),
      line,
      quality,
      movePoints: roles.includes('your') ? movePoints : null,
    });
  }
  return boxes;
}

/**
 * Phase 200 UAT round 3: the reveal's score chip — it replaced the green check
 * / red cross marks on both the guess row and the Your-move box header. It
 * always states what the line actually SCORED (guess: 0 or 1; move: 0, 1 for an
 * inaccuracy, or 2), so the reveal and the "Points: +N" flash over the board
 * add up to the same total. Green whenever anything was earned, red at zero.
 */
function TrainScoreChip({ points, testid }: { points: number; testid: string }): ReactElement {
  return (
    <span
      // rounded-full + slightly wider padding: the same pill shape as the
      // "Points: +N" flash over the board (Phase 200 UAT round 3), so the two
      // surfaces read as the same scoring language.
      className="shrink-0 rounded-full px-2 py-0.5 text-sm font-semibold text-white"
      style={{ backgroundColor: points > 0 ? TRAIN_VERDICT_CORRECT : TRAIN_VERDICT_INCORRECT }}
      data-testid={testid}
    >
      +{points}
    </span>
  );
}

/**
 * Phase 200 (D-01): one line box's `CardHeader` content — the legend glyph
 * button, the title/mark, and the right-aligned quality icon + eval badge.
 * Shared by both the `box.line !== null` branch and the standalone game-move
 * box so the four `train-line-stepper-*` testids (moved here verbatim from
 * `TrainLineStepper`, per D-01) render identically regardless of which
 * branch built the box.
 */
function LineBoxHeader({
  box,
  glyphRole,
  glyphColor,
  quality,
  evalLabel,
}: {
  box: LineBox;
  glyphRole: RoleKey;
  glyphColor: string;
  quality: TrainMoveQuality | null;
  evalLabel: string | null;
}): ReactElement {
  // Phase 200 (LEGEND-03/D-04/D-05, the fifth recolor site): the CardHeader's
  // quality icon must never show the inaccuracy severity glyph next to a
  // green arrow — feed it the collapsed display quality, same rule the pure
  // builder itself uses for the board.
  const displayQuality = quality !== null ? toDisplayQuality(quality) : null;
  return (
    <CardHeader size="compact">
      {/* Phase 200 UAT: a plain, non-interactive glyph. It used to be a button
          that toggled the spotlight, which meant clicking it while the card
          was already spotlit (the normal desktop state — hovering the card is
          what spotlights it) immediately UN-spotlit the card under the
          pointer. The card itself owns the spotlight now; the glyph is pure
          legend. */}
      <span data-testid={`train-reveal-glyph-${glyphRole}`} aria-hidden="true">
        <ArrowGlyphIcon color={glyphColor} />
      </span>
      <p className="min-w-0 truncate" data-testid="train-line-stepper-title">
        {box.title}
      </p>
      {/* The chip sits OUTSIDE the truncating title so a long "Your move /
          Best move: <san>" header can never clip the score away. */}
      {box.movePoints != null && (
        <TrainScoreChip points={box.movePoints} testid="train-line-stepper-points" />
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {displayQuality != null && (
          <span data-testid="train-line-stepper-quality" data-quality={displayQuality}>
            <MoveQualityIcon quality={displayQuality} className="h-4 w-4" />
          </span>
        )}
        {evalLabel != null && (
          <span
            className="rounded px-1.5 py-0.5 text-sm font-semibold text-white"
            style={{ backgroundColor: BEST_MOVE_ARROW }}
            data-testid="train-line-stepper-eval"
          >
            {evalLabel}
          </span>
        )}
      </span>
    </CardHeader>
  );
}

/**
 * Height of the free-play move list. The `VariationTree` desktop renderer
 * absolute-fills its (relative) parent by design — it must never inflate the
 * Analysis page's row height — so it needs an explicit box here rather than
 * growing with the line. Roughly eight paired rows before it scrolls.
 */
const FREE_PLAY_MOVE_LIST_HEIGHT_CLASS = 'h-56';

/**
 * Phase 200 (D-10/D-13/D-14), reworked per Phase 200 UAT: the swap-in
 * free-play surface — replaces ONLY the line boxes / Also fine row (see the
 * ternary in the main render, which gates this on `isExploring && freePlay` so
 * `freePlay` is narrowed to non-undefined by the time this is called).
 *
 * Renders a Stockfish engine-lines card (`EngineLines`, reused verbatim from
 * the Analysis page — never forked, never edited, per A-11) plus the Analysis
 * page's own move list (`VariationTree`). The UAT replaced the bespoke
 * single-chain `TrainExplorationLine` with `VariationTree` so sidelines behave
 * exactly as they do on the analysis board: a move played from a jumped-back
 * position forks, every open line stays listed, and each closes via its own ×.
 * Move-quality badges ride the same list (`moveListMarkers`).
 *
 * No Maia card, no FlawChess engine card — EXPLORE-03 excludes both, and this
 * phase never touches the ONNX runtime.
 */
function TrainExplorationPanel({
  freePlay,
  onExit,
  flipped,
  onFlipBoard,
}: {
  freePlay: TrainFreePlayState;
  /** Phase 200 UAT: the × in the Stockfish card header — same job as the
   * Solution button below the board (leave free play, restore the reveal). */
  onExit?: () => void;
  /** The shared board's current orientation and its toggle — see TrainRevealProps. */
  flipped: boolean;
  onFlipBoard?: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-4" data-testid="train-reveal-exploration">
      <Card data-testid="train-exploration-engine-card">
        <CardHeader size="compact">
          Stockfish
          <button
            type="button"
            className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
            data-testid="btn-train-exploration-close"
            aria-label="Back to the solution"
            onClick={onExit}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </CardHeader>
        <CardBody className="p-2">
          {freePlay.pvLines.length === 0 ? (
            <EngineLinesSkeleton rows={MAX_LINES} />
          ) : (
            <EngineLines
              pvLines={freePlay.pvLines}
              isAnalyzing={freePlay.isAnalyzing}
              baseFen={freePlay.fen ?? undefined}
              flipped={flipped}
              onMoveClick={(uciMoves) => freePlay.playLine(uciMoves)}
            />
          )}
        </CardBody>
      </Card>
      <Card data-testid="train-exploration-moves-card">
        <CardHeader size="compact">Moves</CardHeader>
        {/* `relative` + a fixed height: DesktopTree's scroller is absolute-fill
            (see its own comment), so it anchors here and scrolls internally
            instead of stretching the reveal column. */}
        <CardBody className={cn('relative flex min-h-0 flex-col p-1', FREE_PLAY_MOVE_LIST_HEIGHT_CLASS)}>
          <VariationTree
            variant="vertical"
            nodes={freePlay.nodes}
            mainLine={freePlay.mainLine}
            currentNodeId={freePlay.currentNodeId}
            rootPly={freePlay.rootPly}
            onNodeClick={freePlay.goToNode}
            flawMarkerByNodeId={freePlay.moveListMarkers}
            onDeleteLine={freePlay.deleteLine}
          />
        </CardBody>
        {/* Phase 200 UAT round 5: the analysis board's own control strip,
            directly under the move list. Reset jumps back to the puzzle
            position WITHOUT leaving free play or dropping the tree (that is
            Solution's / the header ×'s job) — hence the explicit `canReset`,
            which would otherwise default to `canGoBack` and read as the same
            control twice. */}
        <div className="border-t border-border px-1 py-1">
          <BoardControls
            onReset={freePlay.goToRoot}
            onBack={freePlay.goBack}
            onForward={freePlay.goForward}
            onFlip={() => onFlipBoard?.()}
            canGoBack={freePlay.canGoBack}
            canReset={freePlay.canGoBack}
            canGoForward={freePlay.canGoForward}
            flat
            size="md"
            className="w-full"
          />
        </div>
      </Card>
    </div>
  );
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
  /**
   * Phase 200 (LEGEND-02/D-07): the currently spotlit line box's `testid`
   * key, or null when no box is spotlit. The board owner (`TrainSolveScreen`)
   * holds this as its single piece of spotlight state; threaded back down so
   * a future active-card highlight (Task 3) can compare against `box.testid`.
   */
  spotlightKey?: string | null;
  /**
   * Phase 200 (LEGEND-02/D-06/D-08): reports a hover/focus/tap on a line
   * box's card or glyph up to the board owner, which derives the spotlit
   * board overlay via `applyTrainSpotlight`. Called with `null` to clear
   * (pointer-leave, blur, tap-away). `key` is the box's own `testid`; `ucis`
   * is always the box's single `uci` wrapped in an array (the shape
   * `applyTrainSpotlight` expects).
   */
  onSpotlightChange?: (entry: { key: string; ucis: string[] } | null) => void;
  /**
   * Phase 200 UAT round 9: true while the board has DEPARTED the pristine
   * solution — a reveal line is stepped away from its start, or free play is
   * running. A card click then restores the solution board before spotlighting
   * itself (see `makeCardClickHandler`).
   */
  isBoardDeparted?: boolean;
  /**
   * Phase 200 UAT round 9: asks the board owner to restore the pristine
   * solution position (stepper reset + board FEN + exploration teardown)
   * WITHOUT clearing the spotlight the same click is about to set. Distinct
   * from `onExitExploration` (wired to the Solution button), which also drops
   * the spotlight so the FULL solution overlay returns.
   */
  onReturnToSolution?: () => void;
  /**
   * Phase 200 (LEGEND-04/D-02/D-03): exactly the alternative fine moves
   * actually drawn as green arrows on the board (`revealOverlay.alsoFineMoves`
   * from the board owner) — never the overflow past the puzzle-type arrow
   * cap. Always the UNFILTERED overlay's field (the list is the legend and
   * always renders in full; only the board is spotlight-filtered). Defaults
   * to empty so the list simply doesn't render before a verdict has landed.
   * Rendered in the guess card's body since UAT round 6.
   */
  alsoFineMoves?: TrainFineMove[];
  /**
   * Phase 200 (D-10/EXPLORE-03): true from the first post-verdict drop until
   * Solution — swaps the line boxes and Also fine row for the exploration
   * engine card + move list. The header block (verdict/outcome/banner) and
   * the game footer are OUTSIDE the swap (see the render below) so they stay
   * pinned on screen throughout.
   */
  isExploring?: boolean;
  /** The board owner's `useTrainFreePlay` state — required whenever
   * `isExploring` is true (the render below narrows on `isExploring &&
   * freePlay`, so a true `isExploring` with an undefined `freePlay`
   * silently falls back to the pristine reveal rather than crashing). It
   * carries the branching move tree, the free-play engine's staleness-guarded
   * PV lines, and the per-node move-quality badges. */
  freePlay?: TrainFreePlayState;
  /** Phase 200 UAT: leaves free play — wired to the same handler as the
   * Solution button, and surfaced as an × in the Stockfish card header so the
   * exit is reachable without scrolling back to the board controls. */
  onExitExploration?: () => void;
  /** Current board orientation, so the engine card's hover-preview miniboards
   * match the real board (Phase 200 UAT round 5 — it used to be derived from
   * `puzzle.side_to_move`, which the flip control can now contradict). */
  flipped?: boolean;
  /** Toggles the shared board's orientation — the free-play board-controls
   * strip's flip button. */
  onFlipBoard?: () => void;
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
  spotlightKey = null,
  onSpotlightChange,
  isBoardDeparted = false,
  onReturnToSolution,
  alsoFineMoves = [],
  isExploring = false,
  freePlay,
  onExitExploration,
  flipped = false,
  onFlipBoard,
}: TrainRevealProps): ReactElement | null {
  const { startGameMoveSearch } = gradingEngine;
  // Phase 200 (D-06/D-08, retuned by the Phase 200 UAT): desktop spotlights on
  // whole-card hover; mobile spotlights on whole-card tap, with
  // tap-away-to-clear (below). The JS
  // gate agrees with Tailwind's default `lg` (1024px), matching
  // TrainSolveScreen's own `lg:flex-row` desktop/mobile layout split.
  const isDesktop = useIsDesktop();
  // Root of the reveal panel — the tap-away listener below only clears the
  // spotlight for a pointerdown OUTSIDE this element.
  const revealRootRef = useRef<HTMLDivElement>(null);
  /**
   * Phase 200 UAT: the testid of the line box whose position is currently ON
   * the board — the only box allowed to paint a move cursor (the brown SAN
   * badge). Null when every box sits at its start. Without this, stepping box
   * A and then box B left TWO cursors lit, only one of which described the
   * position actually shown.
   */
  const [activeStepperKey, setActiveStepperKey] = useState<string | null>(null);

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
  function handleLineStep(boxKey: string, firstMoveQuality: TrainMoveQuality | null) {
    return (step: TrainLineStep): void => {
      onFenChange(step.fen);
      if (step.index === 0 || step.lastMoveUci === null) {
        // Back at the puzzle position: this box no longer owns the board, so
        // it surrenders the cursor rather than leaving a stale one behind.
        setActiveStepperKey((prev) => (prev === boxKey ? null : prev));
        onLineStep?.(null);
        return;
      }
      setActiveStepperKey(boxKey);
      onLineStep?.({
        lastMoveUci: step.lastMoveUci,
        quality: step.index === 1 ? firstMoveQuality : 'good',
        nextMoveUci: step.nextMoveUci,
        isFirstMove: step.index === 1,
        // Phase 200 (EXPLORE-02): the reveal-level report describes the
        // position currently ON the board, so its prefix is the full chain
        // already played from puzzle.fen to reach it.
        prefixUci: [...step.prefixUci, step.lastMoveUci],
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

  // D-08 tap-away-to-clear: a small listener scoped to the panel's own
  // lifetime — registered only while mobile AND something is spotlit,
  // always removed on cleanup, so no listener ever outlives the panel
  // (T-200-02). Deliberately a raw document listener, not a generic
  // click-outside utility or a Radix popover — the research's prescribed
  // shape for this one narrow case.
  useEffect(() => {
    if (isDesktop || spotlightKey === null) return;
    function handlePointerDown(event: PointerEvent): void {
      const root = revealRootRef.current;
      if (root === null) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      onSpotlightChange?.(null);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isDesktop, spotlightKey, onSpotlightChange]);

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
    // Phase 200 UAT round 3: the chip states the earned MOVE points, so it
    // reads from the three-way scoring tier (good 2 / inaccuracy 1 / wrong 0),
    // not the coarser boolean `correct_move` the SR bookkeeping uses.
    MOVE_TIER_POINTS[verdict.move_quality],
  );

  // Free play joins the line boxes in being swapped out (see the render): the
  // guess card goes with them. Exploration replaces the board's reveal arrows
  // with its own, so the card's Also fine legend would describe arrows that are
  // no longer drawn, and the guess verdict itself is about the puzzle the user
  // has already left behind. (Same narrowing as the render's own `isExploring
  // && freePlay` ternary, so the two can never disagree.)
  const isFreePlayActive = isExploring && freePlay !== undefined;
  // Phase 200 UAT round 6: the Also fine legend lives in the guess card's body,
  // so it needs no free-play gate of its own — the card it sits in is gone.
  const showAlsoFine = alsoFineMoves.length > 0;
  // Quick 260803-iv6 (Task 3): the guess card states the verdict but never
  // says WHY it landed where it did — one locked prose sentence, derived
  // next to `showAlsoFine` since both render inside the same card body.
  // `verdict.puzzle_type !== 'herring'` is the "one of the user's own
  // blunders vs a red herring" predicate — the SAME one the game footer below
  // already uses, no extra field needed. `move_quality` joins it (2026-08-03
  // bug fix) so the sentence can never claim the user PLAYED the critical
  // move on the strength of the guess alone; see `guessFeedbackProse`.
  const guessProse =
    guess !== null
      ? guessFeedbackProse(
          guess,
          verdict.correct_guess,
          verdict.puzzle_type !== 'herring',
          verdict.move_quality,
        )
      : null;
  const alsoFineEntry = { key: ALSO_FINE_KEY, ucis: alsoFineMoves.map((f) => f.uci) };
  const isAlsoFineSpotlit = spotlightKey === ALSO_FINE_KEY;
  const alsoFineSanList = alsoFineMoves
    .map((f) => sanFromPlayedUci(puzzle.fen, f.uci))
    .filter((san): san is string => san !== null)
    .join(', ');
  // Desktop spotlights on hover/focus, mobile on whole-card tap — the same
  // split (and the same WR-01 focus/blur reasoning) as the line boxes.
  const alsoFineSpotlightHandlers = showAlsoFine
    ? {
        onPointerEnter: isDesktop ? () => onSpotlightChange?.(alsoFineEntry) : undefined,
        onPointerLeave: isDesktop ? () => onSpotlightChange?.(null) : undefined,
        onFocus: isDesktop ? () => onSpotlightChange?.(alsoFineEntry) : undefined,
        onBlur: isDesktop ? () => onSpotlightChange?.(null) : undefined,
        // UAT round 9: attached on BOTH viewports — on desktop it does nothing
        // unless the board has departed the solution (see the handler).
        onClick: makeCardClickHandler({
          isDesktop,
          isSpotlit: isAlsoFineSpotlit,
          isBoardDeparted,
          entry: alsoFineEntry,
          onSpotlightChange,
          onReturnToSolution,
        }),
        tabIndex: 0,
      }
    : {};

  /**
   * One line box's card. Extracted from the old inline `lineBoxes.map` body so
   * the Your-move box can render on its own, above the guess card (UAT round
   * 8), while the rest stay in the map below it.
   */
  function renderLineBox(box: LineBox): ReactElement {
    // Phase 200 (LEGEND-02/D-06/D-08): hover/focus (desktop only)
    // spotlights this box's own move on the shared board; leave/blur
    // restores the full overlay. On mobile, pointer-enter/leave are
    // omitted entirely — a touch device's synthesized pointer events must
    // never fight the card's own tap toggle (`handleCardTap`).
    const spotlightEntry = { key: box.testid, ucis: [box.uci] };
    const isSpotlit = spotlightKey === box.testid;
    const handleCardClick = makeCardClickHandler({
      isDesktop,
      isSpotlit,
      isBoardDeparted,
      entry: spotlightEntry,
      onSpotlightChange,
      onReturnToSolution,
    });
    const spotlightHandlers = {
      onPointerEnter: isDesktop ? () => onSpotlightChange?.(spotlightEntry) : undefined,
      onPointerLeave: isDesktop ? () => onSpotlightChange?.(null) : undefined,
      // WR-01 fix: focus/blur are desktop-gated for the SAME reason
      // pointer-enter/leave are. React's onFocus is focusin underneath, so
      // it BUBBLES up to this Card from anything focusable inside it. On a
      // touch device a real tap fires focus (spotlight ON) before click,
      // and the card's own toggle then reads that fresh state and turns it
      // back OFF — swallowing the first tap.
      onFocus: isDesktop ? () => onSpotlightChange?.(spotlightEntry) : undefined,
      onBlur: isDesktop ? () => onSpotlightChange?.(null) : undefined,
      // Phase 200 UAT: on mobile the WHOLE card is the tap target — the
      // glyph included, since it carries no handler of its own any more.
      // Round 9 attached it on desktop too, purely for the departed-board
      // "come back to the solution and show me THIS move" case; on a pristine
      // board a desktop click stays inert (see the handler).
      onClick: handleCardClick,
      tabIndex: 0,
    };
    // D-07: the active card gets its own highlight, sharing the active
    // SAN token's brand family (TrainLineStepper's bg-brand-brown).
    // UAT round 9: `cursor-pointer` unconditionally, not gated on
    // `isBoardDeparted` — the whole card is an interactive surface either way
    // (hover spotlights it, a click brings the board back), and a cursor that
    // flipped between hand and arrow as the board state changed would read as
    // a glitch rather than an affordance.
    const cardClass = cn('cursor-pointer', isSpotlit && 'ring-2 ring-brand-brown');
    // Testid precedence mirrors ROLE_TESTIDS: roles[0] is always the
    // highest-precedence role present (your > best > game).
    const glyphRole = box.roles[0] ?? 'game';

    return box.line !== null ? (
      <Card
        key={box.testid}
        data-testid={box.testid}
        data-spotlight={isSpotlit ? 'true' : undefined}
        className={cardClass}
        {...spotlightHandlers}
      >
        <LineBoxHeader
          box={box}
          glyphRole={glyphRole}
          glyphColor={trainGlyphColor({
            includesBest: box.roles.includes('best'),
            includesYour: box.roles.includes('your'),
            quality: box.quality,
          })}
          quality={box.quality}
          evalLabel={formatScore(box.line.evalCp, box.line.evalMate)}
        />
        <CardBody className="p-3">
          <TrainLineStepper
            moves={lineSanTokens(puzzle.fen, box.line.moves)}
            startFen={puzzle.fen}
            resetNonce={solutionNonce}
            showCursor={activeStepperKey === box.testid}
            onStepChange={handleLineStep(box.testid, box.quality)}
          />
        </CardBody>
      </Card>
    ) : (
      // Standalone 'game' box — defers to the reveal-time search's own
      // idle/loading/ready/error state machine (190.1-01 Task 2). The
      // header (glyph + title) renders in ALL FOUR states: the thin white
      // game arrow is drawn in all four (buildTrainRevealOverlay never
      // gates on the reveal-time search's status), so a legend entry
      // must exist in all four too. Quality/eval render only once the
      // search has actually resolved.
      <Card
        key={box.testid}
        data-testid={box.testid}
        data-spotlight={isSpotlit ? 'true' : undefined}
        className={cardClass}
        {...spotlightHandlers}
      >
        <LineBoxHeader
          box={box}
          glyphRole={glyphRole}
          glyphColor={trainGlyphColor({ includesBest: false, includesYour: false, quality: null })}
          quality={gameMoveLine.status === 'ready' ? gameMoveQuality : null}
          evalLabel={
            gameMoveLine.status === 'ready'
              ? formatScore(gameMoveLine.line.evalCp, gameMoveLine.line.evalMate)
              : null
          }
        />
        <CardBody className="p-3">
          {gameMoveLine.status === 'ready' && (
            <TrainLineStepper
              moves={lineSanTokens(puzzle.fen, gameMoveLine.line.moves)}
              startFen={puzzle.fen}
              resetNonce={solutionNonce}
              showCursor={activeStepperKey === box.testid}
              onStepChange={handleLineStep(box.testid, gameMoveQuality)}
            />
          )}
          {gameMoveLine.status === 'loading' && (
            <div className="flex items-center gap-2" data-testid="train-game-line-loading">
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">Loading…</p>
            </div>
          )}
          {gameMoveLine.status === 'error' && (
            <div data-testid="train-game-line-error">
              <LoadError resource="the played-in-game engine line" />
            </div>
          )}
        </CardBody>
      </Card>
    );
  }

  // Phase 200 UAT round 8: the user's own move leads the panel on BOTH
  // viewports — its box renders above the guess card, the rest stay below it.
  // A merged box (your == best, or your == game) carries the 'your' role too,
  // so the merged card leads exactly like a standalone Your-move box would.
  const yourBox = lineBoxes.find((box) => box.roles.includes('your')) ?? null;
  const otherBoxes = lineBoxes.filter((box) => box !== yourBox);

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
    <div
      ref={revealRootRef}
      className="flex w-full flex-col gap-4 lg:mt-[46px] lg:max-w-sm"
      data-testid="train-reveal"
    >
      {/* 1. Flaw fixed banner (PROG-03/D-14) — supersedes the D-12 plain
          "Mastered — retired." comeback hint; nothing for a herring or a
          non-mastered item. Quick 260803-iv6: hoisted to the FIRST card in
          the panel (above the Your-move box and the guess card, both
          viewports) — the mastery celebration used to sit three cards down,
          behind the Your-move and guess cards. Stays OUTSIDE the
          `isFreePlayActive` gate and the `isExploring` swap below: it is
          pinned throughout exploration too (same D-10 pinning every other
          `isFreePlayActive`-exempt section already gets). */}
      {showFlawFixedBanner && <TrainFlawFixedBanner fen={puzzle.fen} />}

      {/* 2. The Your-move box (UAT round 8) — the user's own move is the first
          thing they look for, so its card sits at the top of the rest of the
          panel on both viewports, above the guess card. Swapped out during
          exploration with the other line boxes below (same `isFreePlayActive`
          gate), since the board no longer shows the puzzle by then. */}
      {!isFreePlayActive && yourBox !== null && renderLineBox(yourBox)}

      {/* 3. The guess-feedback card (Phase 200 UAT round 6) — one card that
          absorbed what used to be three loose surfaces: the guess verdict row,
          the outcome sentence, and the standalone "Also fine" card.

          Header: the green legend glyph (only when alternatives were actually
          drawn), the guess verdict, and its score chip — scored from the
          server-computed `correct_guess`, never a client-side re-derivation.
          The MOVE score lives on the Your-move box's own header chip.
          Body: the Also fine move list, and nothing else. Phase 200 UAT round
          7 retired the last outcome sentence (the herring "You handled this
          well in the game" line), as round 3 had already retired the miss
          sentence — the verdict rows and line boxes say everything, so the
          card is header-only when there are no alternatives to list.

          Because it swallowed the Also fine row, this card is now that row's
          legend entry too and carries its spotlight contract verbatim: the
          same `train-reveal-also-fine` key, all of its UCIs spotlit together
          (D-02 — no per-token granularity), desktop hover / mobile whole-card
          tap. Handlers attach ONLY when the list is actually shown, so an
          alternatives-free card never spotlights an empty move set (which
          would filter every arrow off the board).

          Hidden in free play (both viewports), alongside the line boxes below:
          the board is showing the user's own exploration by then, not the
          puzzle, so neither the Also fine legend nor the guess verdict has
          anything on screen left to describe. */}
      {!isFreePlayActive && (
      <Card
        data-testid="train-verdict-guess"
        data-spotlight={showAlsoFine && isAlsoFineSpotlit ? 'true' : undefined}
        // No `cursor-pointer` without alternatives: an Also-fine-free guess
        // card attaches no handlers at all (see `alsoFineSpotlightHandlers`),
        // so it is genuinely inert and must not advertise otherwise.
        className={cn(
          showAlsoFine && 'cursor-pointer',
          showAlsoFine && isAlsoFineSpotlit && 'ring-2 ring-brand-brown',
        )}
        {...alsoFineSpotlightHandlers}
      >
        <CardHeader size="compact">
          {showAlsoFine && (
            // Phase 200 UAT: non-interactive, same rule as the line-box glyphs
            // — the card itself owns the spotlight.
            <span data-testid="train-reveal-glyph-also-fine" aria-hidden="true">
              <ArrowGlyphIcon color={DARK_GREEN} />
            </span>
          )}
          <span className="min-w-0 truncate">
            Guess: {guess !== null ? GUESS_LABELS[guess] : ''}
          </span>
          <TrainScoreChip
            points={verdict.correct_guess ? GUESS_POINTS : 0}
            testid="train-verdict-guess-points"
          />
        </CardHeader>
        {(guessProse !== null || showAlsoFine) && (
          <CardBody className="flex flex-col gap-2 p-3">
            {guessProse !== null && (
              <p className="text-sm" data-testid="train-verdict-guess-prose">
                {guessProse}
              </p>
            )}
            {showAlsoFine && (
              <p className="text-sm" data-testid="train-reveal-also-fine">
                Also fine: {alsoFineSanList}
              </p>
            )}
          </CardBody>
        )}
      </Card>
      )}

      {revealQuery.isError && (
        <p className="text-sm font-semibold text-muted-foreground" data-testid="train-reveal-error">
          Couldn&apos;t load the full reveal details.
        </p>
      )}

      {/* Phase 200 (D-10): the swap. isExploring replaces sections 4 and 4a
          below (the line boxes and the standalone SAN-only game box) with the
          exploration engine card + move list. Section 3 above and section 5
          (game footer) below stay OUTSIDE this ternary — pinned on screen
          throughout, per D-10. Section 1 (the guess card) used to be pinned
          too, but is now hidden in free play by its own gate above: everything
          on it describes board state that exploration has replaced. */}
      {isExploring && freePlay ? (
        <TrainExplorationPanel
          freePlay={freePlay}
          onExit={onExitExploration}
          flipped={flipped}
          onFlipBoard={onFlipBoard}
        />
      ) : (
        <>
      {/* 4. The remaining steppable engine-line boxes (190.1-03 D-03) — one
          per DISTINCT first move, merged when two or three coincide. The
          Your-move box is not among them: it renders ABOVE the guess card
          (section 0). Every eval/line comes from the client grading engine
          (`gradeResult` or the reveal-time search below), never a stored
          server line. */}
      {otherBoxes.map(renderLineBox)}

      {/* 4a. Idle SAN-only game-move box (190.1-01): the game move has no
          derivable UCI (an unparseable SAN) but the SAN itself is known —
          renders the header alone, never a stepper. Not part of `lineBoxes`
          (it has no UCI to merge/compare by). */}
      {gameMoveUci === null && gameMoveSan !== null && (
        <div className="flex flex-col gap-2" data-testid="train-line-box-game-move">
          {gameMoveTitle}
        </div>
      )}
        </>
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
