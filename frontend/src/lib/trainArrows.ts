/**
 * trainArrows — pure reveal-board overlay builder (arrows + square-corner
 * quality badges) for the Train solve screen (Phase 190.1, D-02; reworked per
 * 190.1 UAT).
 *
 * Color language (190.1 UAT): BLUE always marks the engine's best move (the
 * app-wide "engine pointer" hue), the user's PLAYED move is colored by its
 * own move quality (good/inaccuracy/mistake/blunder), alternative fine moves
 * are dark green when clean and yellow when inaccuracy-level (quick
 * 260726-fma), and the thin white on-top arrow still marks the move played
 * in the original game. Every arrow additionally gets the matching
 * move-quality badge (the shared SquareMarker corner glyphs) on its target
 * square.
 *
 * Extracted into its own module (rather than inlined in TrainSolveScreen) so
 * the puzzle-type-aware arrow selection is unit-testable without rendering a
 * board, and so TrainSolveScreen's own logic stays small.
 */

import type { BoardArrow, SquareMarker } from '@/components/board/ChessBoard';
import { DARK_GREEN } from '@/lib/arrowColor';
import { classifyLiveSeverity } from '@/lib/liveFlaw';
import {
  MOVE_HIGHLIGHT_BEST,
  MOVE_HIGHLIGHT_BLUNDER,
  MOVE_HIGHLIGHT_GOOD,
  MOVE_HIGHLIGHT_MISTAKE,
  MOVE_HIGHLIGHT_SQUARE,
  MOVE_QUALITY_GOOD,
  MOVE_QUALITY_INACCURACY,
  MOVE_QUALITY_MISTAKE,
  MOVE_QUALITY_BLUNDER,
  NEXT_MOVE_ARROW,
  TRAIN_BEST_MOVE_ARROW,
} from '@/lib/theme';
import type { FlawSeverity } from '@/types/library';

export type TrainPuzzleType = 'sharp' | 'soft' | 'herring';

/**
 * Move-quality taxonomy for the reveal board (190.1 UAT). Deliberately the
 * subset of lib/moveQuality.ts's MoveQuality that the grading engine can
 * actually distinguish here — no 'gem'/'great' (those need the Maia overlay,
 * which the Train loop doesn't run).
 */
export type TrainMoveQuality = 'best' | 'good' | FlawSeverity;

/**
 * One "fine move" from the grading engine's MultiPV mount search — a move the
 * verdict itself would grade correct (quick 260726-fma). `quality` mirrors the
 * verdict's own two correct tiers: 'good' (drop not even an inaccuracy) or
 * 'inaccuracy' (drop within [INACCURACY_DROP, MISTAKE_DROP), still a correct
 * move by SOLV-03's rule AND still within the backend's soft-puzzle gap).
 */
export interface TrainFineMove {
  uci: string;
  quality: 'good' | 'inaccuracy';
}

/** D-02: a sharp puzzle has exactly one right move by definition — exactly
 * one quality arrow (the best move) regardless of how many entries
 * the fine-moves set has. */
export const TRAIN_SHARP_GOOD_MOVE_ARROWS = 1;
/** D-02: a soft or herring puzzle may have several fine moves — up to 3
 * quality arrows (the blue best move plus up to 2 green/yellow
 * alternatives). */
export const TRAIN_SOFT_GOOD_MOVE_ARROWS = 3;

/** Normal engine-arrow width (matches Analysis.tsx's
 * STOCKFISH_ENGINE_ARROW_WIDTH) — used for the green good-move arrows. */
export const TRAIN_GOOD_MOVE_ARROW_WIDTH = 0.5;
/** Normal engine-arrow width, same value as TRAIN_GOOD_MOVE_ARROW_WIDTH — a
 * distinct named constant per D-02 (distinct arrow widths), so the
 * played-move arrow's width can be retuned independently later. */
export const TRAIN_PLAYED_MOVE_ARROW_WIDTH = 0.5;
/** Width of the blue best-move arrow — same rationale as the played-move
 * width constant above. */
export const TRAIN_BEST_MOVE_ARROW_WIDTH = 0.5;
/** Thinner width for the game-move arrow (matches Analysis.tsx's
 * NEXT_MOVE_ARROW_WIDTH) — reads as a subtle hint layered over the wider
 * quality arrows, same treatment as the analysis board's translucent white
 * next-move arrow. */
export const TRAIN_GAME_MOVE_ARROW_WIDTH = 0.18;

/** Arrow fill per move quality. 'best' uses the app-wide engine-pointer blue,
 * never a green — the whole point of the 190.1 UAT recolor. */
const QUALITY_ARROW_COLOR: Record<TrainMoveQuality, string> = {
  best: TRAIN_BEST_MOVE_ARROW,
  good: MOVE_QUALITY_GOOD,
  inaccuracy: MOVE_QUALITY_INACCURACY,
  mistake: MOVE_QUALITY_MISTAKE,
  blunder: MOVE_QUALITY_BLUNDER,
};

/**
 * Last-move square-highlight color per move quality (190.1 UAT stepping):
 * mirrors useGameOverlay's severity mapping (inaccuracy = the shared yellow),
 * plus blue for an engine-best/engine-line move.
 */
export const TRAIN_STEP_HIGHLIGHT: Record<TrainMoveQuality, string> = {
  best: MOVE_HIGHLIGHT_BEST,
  good: MOVE_HIGHLIGHT_GOOD,
  inaccuracy: MOVE_HIGHLIGHT_SQUARE,
  mistake: MOVE_HIGHLIGHT_MISTAKE,
  blunder: MOVE_HIGHLIGHT_BLUNDER,
};

/**
 * While stepping a reveal line (190.1 UAT), the ONLY arrow on the board is a
 * blue pointer for the line's next move from the shown position (it comes
 * from a Stockfish line, so it reads in the engine hue). Null/absent next
 * move (end of the line) draws nothing.
 */
export function buildTrainStepArrows(nextMoveUci: string | null): BoardArrow[] {
  const squares = squaresFromUci(nextMoveUci);
  if (squares === null) return [];
  return [
    {
      ...squares,
      color: TRAIN_BEST_MOVE_ARROW,
      width: TRAIN_BEST_MOVE_ARROW_WIDTH,
      layerKey: 'step-next',
    },
  ];
}

/**
 * While stepping (190.1 UAT round 4): the line's FIRST move keeps its quality
 * badge on the target square (the squares are already highlighted in the
 * quality color — the badge is the icon on top). Deeper steps are engine
 * continuations and carry no badge. Null quality (tactic-less/unresolved
 * lines) draws nothing.
 */
export function buildTrainStepMarkers(
  lastMoveUci: string,
  quality: TrainMoveQuality | null,
  isFirstMove: boolean,
): SquareMarker[] {
  if (!isFirstMove || quality === null) return [];
  const squares = squaresFromUci(lastMoveUci);
  if (squares === null) return [];
  return [markerForQuality(squares.endSquare, quality)];
}

/** One quality-annotated move for the overlay builder. `quality: null` (game
 * move only) means "not yet known" — arrow drawn, no badge. */
export interface TrainOverlayMove {
  uci: string;
  quality: TrainMoveQuality | null;
}

export interface TrainRevealOverlay {
  arrows: BoardArrow[];
  markers: SquareMarker[];
}

/**
 * Classify a reveal move's quality from the SAME expected-score pipeline the
 * verdict itself uses (liveFlaw's classifyLiveSeverity — never a new cutoff):
 * the engine's own top move is 'best'; anything whose drop against the
 * pre-move eval isn't even an inaccuracy is 'good'; otherwise the severity.
 */
export function classifyTrainMoveQuality(
  esBefore: number,
  esMove: number,
  isBestMove: boolean,
): TrainMoveQuality {
  if (isBestMove) return 'best';
  return classifyLiveSeverity(esBefore, esMove) ?? 'good';
}

function goodMoveArrowCap(puzzleType: TrainPuzzleType): number {
  return puzzleType === 'sharp' ? TRAIN_SHARP_GOOD_MOVE_ARROWS : TRAIN_SOFT_GOOD_MOVE_ARROWS;
}

/** UCI ("e2e4"/"e7e8q") -> {startSquare, endSquare}, or null for a null,
 * malformed, or too-short (< 4 chars) input — never throws. */
function squaresFromUci(uci: string | null): { startSquare: string; endSquare: string } | null {
  if (uci === null || uci.length < 4) return null;
  return { startSquare: uci.slice(0, 2), endSquare: uci.slice(2, 4) };
}

/** The SquareMarker corner badge for a quality — the same glyph set the
 * analysis board uses (green star / thumbs-up / severity NAG glyphs). */
function markerForQuality(square: string, quality: TrainMoveQuality): SquareMarker {
  if (quality === 'best') return { square, best: true };
  if (quality === 'good') return { square, good: true };
  return { square, severity: quality };
}

/**
 * Builds the reveal board's full overlay (D-02, recolored per 190.1 UAT):
 * - a BLUE best-move arrow (the engine's top move) with a 'best' badge
 * - up to cap-1 additional fine-move arrows (soft/herring only), green with a
 *   'good' badge when clean, yellow with the inaccuracy badge when the drop
 *   is inaccuracy-level (quick 260726-fma)
 * - the user's played-move arrow colored by its own quality, with the
 *   matching quality badge — merged into the blue arrow when the played move
 *   IS the best move
 * - a thin white game-move arrow (drawn on top) for the move played in the
 *   game, with its quality badge once known (`quality: null` = no badge yet)
 *
 * Returns an empty overlay whenever `verdictLanded` is false — nothing may be
 * visible before the attempt is graded. Every arrow gets its own `layerKey`
 * so a coincident from-to pair across roles renders as concentric arrows
 * instead of collapsing under `dedupeArrowsByMove`. Badges are deduped by
 * TARGET SQUARE with precedence played > best > fine > game (the played
 * move's verdict is the one the user is here to learn).
 */
export function buildTrainRevealOverlay(
  puzzleType: TrainPuzzleType,
  fineMoves: TrainFineMove[],
  bestMoveUci: string | null,
  playedMove: TrainOverlayMove | null,
  gameMove: TrainOverlayMove | null,
  verdictLanded: boolean,
): TrainRevealOverlay {
  if (!verdictLanded) return { arrows: [], markers: [] };

  const arrows: BoardArrow[] = [];
  const markers: SquareMarker[] = [];
  const markedSquares = new Set<string>();

  function pushMarker(uci: string, quality: TrainMoveQuality | null): void {
    if (quality === null) return;
    const squares = squaresFromUci(uci);
    if (squares === null || markedSquares.has(squares.endSquare)) return;
    markedSquares.add(squares.endSquare);
    markers.push(markerForQuality(squares.endSquare, quality));
  }

  // Badge precedence pass first (played > best > fine > game), independent of
  // arrow draw order.
  if (playedMove !== null) pushMarker(playedMove.uci, playedMove.quality);
  if (bestMoveUci !== null) pushMarker(bestMoveUci, 'best');
  const cap = goodMoveArrowCap(puzzleType);
  const cappedFineMoves = fineMoves.slice(0, cap);
  for (const fine of cappedFineMoves) pushMarker(fine.uci, fine.quality);
  if (gameMove !== null) pushMarker(gameMove.uci, gameMove.quality);

  // Played-move arrow, colored by its quality — unless it IS the best move,
  // in which case the blue best arrow below is the single arrow for both.
  const playedIsBest = playedMove !== null && playedMove.uci === bestMoveUci;
  if (playedMove !== null && !playedIsBest) {
    const squares = squaresFromUci(playedMove.uci);
    if (squares !== null) {
      arrows.push({
        ...squares,
        color: QUALITY_ARROW_COLOR[playedMove.quality ?? 'good'],
        width: TRAIN_PLAYED_MOVE_ARROW_WIDTH,
        layerKey: 'played',
      });
    }
  }

  const bestSquares = squaresFromUci(bestMoveUci);
  if (bestSquares !== null) {
    arrows.push({
      ...bestSquares,
      color: TRAIN_BEST_MOVE_ARROW,
      width: TRAIN_BEST_MOVE_ARROW_WIDTH,
      layerKey: 'best',
    });
  }

  // Alternative fine moves (soft/herring rank 2+): green when clean, yellow
  // when inaccuracy-level (quick 260726-fma), skipping moves already drawn as
  // the best or played arrow.
  cappedFineMoves.forEach((fine, index) => {
    if (fine.uci === bestMoveUci || fine.uci === playedMove?.uci) return;
    const squares = squaresFromUci(fine.uci);
    if (squares === null) return;
    arrows.push({
      ...squares,
      color: fine.quality === 'inaccuracy' ? MOVE_QUALITY_INACCURACY : DARK_GREEN,
      width: TRAIN_GOOD_MOVE_ARROW_WIDTH,
      layerKey: `good-${index}`,
    });
  });

  const gameSquares = squaresFromUci(gameMove?.uci ?? null);
  if (gameSquares !== null) {
    arrows.push({
      ...gameSquares,
      color: NEXT_MOVE_ARROW,
      width: TRAIN_GAME_MOVE_ARROW_WIDTH,
      onTop: true,
      layerKey: 'game',
    });
  }

  return { arrows, markers };
}
