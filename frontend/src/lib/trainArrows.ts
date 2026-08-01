/**
 * trainArrows — pure reveal-board overlay builder (arrows + square-corner
 * quality badges) for the Train solve screen (Phase 190.1, D-02; reworked per
 * 190.1 UAT).
 *
 * Color language (190.1 UAT, recolored per Phase 200 D-04/D-05): BLUE always
 * marks the engine's best move (the app-wide "engine pointer" hue), the
 * user's PLAYED move is colored by its own move quality (good/mistake/
 * blunder — inaccuracy is PRESENTATION-collapsed into good, see
 * `toDisplayQuality`), alternative fine moves are dark green regardless of
 * whether the grading engine classified them good or inaccuracy, and the
 * thin white on-top arrow still marks the move played in the original game.
 * Every arrow additionally gets the matching move-quality badge (the shared
 * SquareMarker corner glyphs) on its target square. Accepted cost: the
 * reveal board can no longer visually distinguish good from inaccuracy — by
 * design (D-04: a played inaccuracy must not contradict SOLV-03's verdict
 * that it was a correct answer). The line eval badge is still the
 * disclosure channel for the small drop; `classifyTrainMoveQuality`/
 * `classifyLiveSeverity` are untouched, so the underlying classification and
 * the verdict/eval numbers still know the difference.
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
  MOVE_QUALITY_GOOD,
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

/**
 * Arrow caps, counted in ALTERNATIVES (Phase 200 UAT round 4) — not in total
 * arrows as the original D-02 constants were.
 *
 * The old total-based cap silently spent slots on moves that never render as
 * a green alternative anyway: `fineMoves` always includes rank 1 (the best
 * move, drawn blue), and the played move is drawn in its own quality color
 * when it happens to be a fine alternative. Under a total cap of 3 a soft
 * puzzle therefore showed 2 alternatives normally, and only 1 whenever the
 * user had played one of them — which is exactly the "several fine moves but
 * only one is shown" the UAT reported. Capping the alternatives directly (and
 * filtering out the best/played moves BEFORE slicing) makes the cap mean what
 * it reads like.
 */
/** A sharp puzzle has exactly one right move by definition (D-02), so it
 * draws NO alternative arrows at all, regardless of how many entries the
 * fine-moves set has. Deliberately kept at zero after the round-4 recount:
 * the sharp/soft label comes from the server's deep MultiPV-2 answer key,
 * which outranks the solve loop's 1.5s client search — if the deep key says
 * the runner-up is itself a mistake, green alternatives here would both
 * teach the wrong lesson and contradict the critical-vs-several guess the
 * user just scored on. */
export const TRAIN_SHARP_ALT_MOVE_ARROWS = 0;
/** A soft or herring puzzle may have several fine moves, so every alternative
 * the MultiPV mount search can possibly return is drawable. Equals
 * `TRAIN_GRADING_MULTIPV_WIDTH - 1` (rank 1 is the best move) — not imported
 * from `useTrainGradingEngine` because the dependency runs the other way
 * (that hook imports `TrainFineMove` from here), and a cycle is a worse
 * trade than this comment. */
export const TRAIN_SOFT_ALT_MOVE_ARROWS = 3;

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
  // Phase 200 D-05: inaccuracy is presentation-collapsed into good — same
  // fill as the 'good' entry, never its own yellow.
  inaccuracy: MOVE_QUALITY_GOOD,
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
  // Phase 200 D-05: inaccuracy is presentation-collapsed into good — same
  // highlight as the 'good' entry, never the shared yellow.
  inaccuracy: MOVE_HIGHLIGHT_GOOD,
  mistake: MOVE_HIGHLIGHT_MISTAKE,
  blunder: MOVE_HIGHLIGHT_BLUNDER,
};

/**
 * The single blue engine-pointer arrow for one UCI move, or no arrow at all
 * for a null/malformed input. Shared by the reveal stepper and free play so
 * the engine hue and width can never drift between the two surfaces; the
 * distinct `layerKey` keeps them from colliding under `dedupeArrowsByMove`.
 */
function enginePointerArrows(uci: string | null, layerKey: string): BoardArrow[] {
  const squares = squaresFromUci(uci);
  if (squares === null) return [];
  return [
    {
      ...squares,
      color: TRAIN_BEST_MOVE_ARROW,
      width: TRAIN_BEST_MOVE_ARROW_WIDTH,
      layerKey,
    },
  ];
}

/**
 * While stepping a reveal line (190.1 UAT), the ONLY arrow on the board is a
 * blue pointer for the line's next move from the shown position (it comes
 * from a Stockfish line, so it reads in the engine hue). Null/absent next
 * move (end of the line) draws nothing.
 */
export function buildTrainStepArrows(nextMoveUci: string | null): BoardArrow[] {
  return enginePointerArrows(nextMoveUci, 'step-next');
}

/**
 * Phase 200 UAT round 5: while exploring, the board carries the free-play
 * engine's own top move as a blue arrow — exactly what the analysis board
 * shows for its Stockfish engine (same hue, same width). This replaces the
 * original EXPLORE-03 rule of "no arrows at all while exploring": a sideline
 * you cannot see the best answer to is a worse teacher than one you can.
 *
 * The caller passes the STALENESS-GUARDED best move (`TrainFreePlayState.
 * bestMoveUci`), so a position the engine hasn't reached yet simply draws
 * nothing rather than pointing at the previous position's answer. A terminal
 * position (mate/stalemate) yields no PV and therefore no arrow.
 */
export function buildTrainFreePlayArrows(bestMoveUci: string | null): BoardArrow[] {
  return enginePointerArrows(bestMoveUci, 'free-best');
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
  /** Phase 200 (LEGEND-04/D-02/D-03) — exactly the alternative fine moves
   * actually drawn as green arrows (never the overflow past the puzzle-type
   * arrow cap), for the reveal sidebar's compact "Also fine" row. Derived in
   * the SAME loop that pushes the arrows themselves, so this can never list a
   * move that isn't on the board or omit one that is. */
  alsoFineMoves: TrainFineMove[];
  /** End square -> the UCI of the move whose badge actually won that square.
   *
   * `pushMarker` dedups by end square under precedence played > best > fine >
   * game, so when two candidate moves share a target square only ONE badge
   * survives — and it belongs to the higher-precedence move. Without this map
   * `applyTrainSpotlight` could only match markers by square, which let a
   * spotlit alternative inherit the best move's blue badge (WR-02). Recorded
   * in the same `pushMarker` call that creates the badge, so the two can
   * never drift. */
  markerOwners: Record<string, string>;
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

/**
 * Phase 200 (LEGEND-03/D-04/D-05) — PRESENTATION-ONLY collapse of the
 * inaccuracy tier into good, for every drawing decision on the Train reveal
 * surface (arrow fill, badge glyph, step highlight, and the CardHeader
 * quality icon in `TrainReveal.tsx`). `classifyTrainMoveQuality` above and
 * `classifyLiveSeverity` it delegates to are UNTOUCHED by this function — the
 * verdict, the `move_quality` POSTed to `solvePuzzle`, and the line eval all
 * still know an inaccuracy from a clean good move. This is the single rule
 * every recolor site in this module (and TrainReveal's header) reads through,
 * so the collapse can never drift out of sync between the board and the
 * glyph next to it.
 */
export function toDisplayQuality(quality: TrainMoveQuality): TrainMoveQuality {
  return quality === 'inaccuracy' ? 'good' : quality;
}

function alternativeArrowCap(puzzleType: TrainPuzzleType): number {
  return puzzleType === 'sharp' ? TRAIN_SHARP_ALT_MOVE_ARROWS : TRAIN_SOFT_ALT_MOVE_ARROWS;
}

/** UCI ("e2e4"/"e7e8q") -> {startSquare, endSquare}, or null for a null,
 * malformed, or too-short (< 4 chars) input — never throws. */
function squaresFromUci(uci: string | null): { startSquare: string; endSquare: string } | null {
  if (uci === null || uci.length < 4) return null;
  return { startSquare: uci.slice(0, 2), endSquare: uci.slice(2, 4) };
}

/**
 * Phase 200 UAT: the SquareMarker corner badge for one move quality, exported
 * so the free-play board (`useTrainFreePlay`) badges a freely played move with
 * exactly the glyph the reveal board would use for the same quality — the
 * inaccuracy-collapse rule included.
 */
export function trainQualityMarker(square: string, quality: TrainMoveQuality): SquareMarker {
  return markerForQuality(square, quality);
}

/** The SquareMarker corner badge for a quality — the same glyph set the
 * analysis board uses (green star / thumbs-up / severity NAG glyphs). */
function markerForQuality(square: string, quality: TrainMoveQuality): SquareMarker {
  const displayQuality = toDisplayQuality(quality);
  if (displayQuality === 'best') return { square, best: true };
  if (displayQuality === 'good') return { square, good: true };
  return { square, severity: displayQuality };
}

/**
 * Builds the reveal board's full overlay (D-02, recolored per 190.1 UAT and
 * Phase 200 D-04/D-05):
 * - a BLUE best-move arrow (the engine's top move) with a 'best' badge
 * - up to `alternativeArrowCap` additional fine-move arrows (soft/herring
 *   only — sharp draws none), always dark green with the 'good' badge — good
 *   and inaccuracy are indistinguishable here by design (D-05)
 * - the user's played-move arrow colored by its own quality (inaccuracy
 *   collapsed to the good color/badge, per D-04), with the matching quality
 *   badge — merged into the blue arrow when the played move IS the best move
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
  if (!verdictLanded) return { arrows: [], markers: [], alsoFineMoves: [], markerOwners: {} };

  const arrows: BoardArrow[] = [];
  const markers: SquareMarker[] = [];
  const alsoFineMoves: TrainFineMove[] = [];
  const markedSquares = new Set<string>();
  const markerOwners: Record<string, string> = {};

  function pushMarker(uci: string, quality: TrainMoveQuality | null): void {
    if (quality === null) return;
    const squares = squaresFromUci(uci);
    if (squares === null || markedSquares.has(squares.endSquare)) return;
    markedSquares.add(squares.endSquare);
    markerOwners[squares.endSquare] = uci;
    markers.push(markerForQuality(squares.endSquare, quality));
  }

  // The alternatives actually drawable as green arrows: every fine move that
  // is NOT already drawn as the blue best arrow or the quality-colored played
  // arrow, capped at the puzzle type's alternative budget. Phase 200 UAT
  // round 4: the filter runs BEFORE the slice, so the best move (always rank 1
  // of `fineMoves`) and a played alternative no longer consume alternative
  // slots — see the cap constants' comment for the bug this fixes.
  const alternatives = fineMoves
    .filter((fine) => fine.uci !== bestMoveUci && fine.uci !== playedMove?.uci)
    .slice(0, alternativeArrowCap(puzzleType));

  // Badge precedence pass first (played > best > fine > game), independent of
  // arrow draw order.
  if (playedMove !== null) pushMarker(playedMove.uci, playedMove.quality);
  if (bestMoveUci !== null) pushMarker(bestMoveUci, 'best');
  for (const fine of alternatives) pushMarker(fine.uci, fine.quality);
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

  // Alternative fine moves (soft/herring rank 2+): always dark green (Phase
  // 200 D-05 — good and inaccuracy render identically now). Moves already
  // drawn as the best or played arrow were filtered out when `alternatives`
  // was built. Every pushed arrow gets a matching `alsoFineMoves` entry in
  // the SAME iteration (Phase 200 LEGEND-04/D-03), so the sidebar row and the
  // board arrows can never drift.
  alternatives.forEach((fine, index) => {
    const squares = squaresFromUci(fine.uci);
    if (squares === null) return;
    arrows.push({
      ...squares,
      color: DARK_GREEN,
      width: TRAIN_GOOD_MOVE_ARROW_WIDTH,
      layerKey: `good-${index}`,
    });
    alsoFineMoves.push(fine);
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

  return { arrows, markers, alsoFineMoves, markerOwners };
}

/**
 * Phase 200 (LEGEND-02/LEGEND-05) — the board-side half of the reveal
 * legend's hover/tap spotlight. Filters a reveal overlay down to only the
 * arrows/markers belonging to `activeUcis`, so hovering (desktop) or tapping
 * (mobile) a legend line box hides every other arrow and quality badge.
 *
 * Matches on UCI move identity (`startSquare`+`endSquare`), never on
 * `layerKey` — a coincidence-merged box (e.g. played move == game move)
 * carries a colored arrow and a thin white on-top arrow with DIFFERENT
 * `layerKey`s for the SAME move, and both must survive the same spotlight.
 * Markers match by badge OWNERSHIP (`markerOwners`), not by end-square
 * membership — see the `markerOwners` field docs and WR-02.
 *
 * Returns `overlay` itself (no-op, same reference) when `activeUcis` is null
 * or empty. Note (Phase 200 UAT) that this is NOT how the un-spotlit board is
 * drawn: `TrainSolveScreen` passes a DEFAULT active set (the your-move and
 * best-move UCIs) when nothing is spotlit, so the game move and the "Also
 * fine" alternatives stay off the board until their own legend card is
 * hovered/tapped. The no-op branch is only the degenerate fallback for an
 * overlay with no such moves at all. A malformed UCI (< 4 chars)
 * contributes no match and never throws (`squaresFromUci`'s existing
 * contract). Uses `Array.prototype.filter` throughout, so the source
 * overlay's draw order is preserved verbatim — a surviving on-top arrow
 * still paints over a surviving colored arrow underneath it.
 *
 * `alsoFineMoves` (Phase 200 LEGEND-04) is spread through UNFILTERED — the
 * "Also fine" sidebar row is the legend and always lists every drawn
 * alternative regardless of which entry is currently spotlit; only the BOARD
 * is filtered down. The board owner passes the unfiltered overlay's
 * `alsoFineMoves` to the row separately (never this function's output) for
 * exactly that reason.
 */
export function applyTrainSpotlight(
  overlay: TrainRevealOverlay,
  activeUcis: readonly string[] | null,
): TrainRevealOverlay {
  if (activeUcis === null || activeUcis.length === 0) return overlay;

  const activePairs = activeUcis
    .map((uci) => squaresFromUci(uci))
    .filter((squares): squares is { startSquare: string; endSquare: string } => squares !== null);

  const activeUciSet = new Set(activeUcis);

  function matchesActivePair(arrow: BoardArrow): boolean {
    return activePairs.some(
      (pair) => arrow.startSquare === pair.startSquare && arrow.endSquare === pair.endSquare,
    );
  }

  // WR-02 fix: match markers by the move that actually OWNS the badge, not by
  // end-square membership. Two candidate moves can share a target square (e.g.
  // the best move and a fine alternative both landing on d5); `pushMarker`
  // keeps only the higher-precedence badge, so a square-membership test let a
  // spotlit alternative display the best move's blue badge on its own green
  // arrow. An unowned square (marker with no `markerOwners` entry) is dropped
  // rather than kept — a badge we cannot attribute is exactly the leak.
  function ownsMarkerSquare(square: string): boolean {
    const ownerUci = overlay.markerOwners[square];
    return ownerUci !== undefined && activeUciSet.has(ownerUci);
  }

  return {
    ...overlay,
    arrows: overlay.arrows.filter(matchesActivePair),
    markers: overlay.markers.filter((marker) => ownsMarkerSquare(marker.square)),
  };
}

/**
 * Phase 200 (LEGEND-01) — the exact fill a legend line box's arrow glyph
 * must use, so the glyph can never drift from the board arrow it explains.
 * These are precisely the three colors `buildTrainRevealOverlay` draws for
 * the three box roles: the best-move box is always blue regardless of the
 * played move's own quality (a coincidence-merged box renders ONE blue
 * glyph, matching the single blue arrow actually drawn); a your-move-only
 * box takes its own quality color; a standalone game-move box is always the
 * thin white game-hint color.
 */
export function trainGlyphColor(opts: {
  includesBest: boolean;
  includesYour: boolean;
  quality: TrainMoveQuality | null;
}): string {
  if (opts.includesBest) return TRAIN_BEST_MOVE_ARROW;
  if (opts.includesYour) return QUALITY_ARROW_COLOR[opts.quality ?? 'good'];
  return NEXT_MOVE_ARROW;
}
