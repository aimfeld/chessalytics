/**
 * useAnalysisBoardArrows — the board-overlay derivation cluster of `Analysis()`
 * (Phase 215 Plan 05, first of three hooks that clear the remaining
 * arrow-level complexity breaches — see 215-04-SUMMARY.md for the state this
 * plan builds on).
 *
 * Owns every `BoardArrow[]`/`SquareMarker[]` value the `<ChessBoard>` render
 * consumes: the PV-sideline tactic overlay, the move-quality hover preview,
 * the translucent next-move arrow, the two live-engine arrow layers, and the
 * square-marker/last-move-tint derivation (severity > gem/great > best/good >
 * book precedence). WHY a separate hook: this is a pure transform of
 * already-computed board/engine/gem state (no state/effects of its own beyond
 * `useMemo`), matching the `useLiveMoveFlaw.ts` shape cited in
 * 215-PATTERNS.md ("Extracted transform hooks (gem-sweep / board-arrows)").
 *
 * Ownership boundary: this hook calls no engine hook of its own — `engine`,
 * `flawChessEngine` and `reconciledBestUci` are already-resolved results
 * threaded in as options, exactly like `useAnalysisEngineLines.ts`'s
 * `engine`/`flawChessEngine`/`grading` fields. `resolveMarkerFor` and
 * `storedBestGoodByPly` are still LOCAL to `Analysis.tsx` at this point in the
 * phase (215-06's `useAnalysisGemMarkers` extraction owns them next) — this
 * hook consumes them as options regardless of which file defines them.
 *
 * `forkPlyForOrientation` is NOT a private copy (215 code review WR-05): it
 * previously was, and had already textually diverged from the other three
 * copies (logically equivalent, but a silent drift risk) — now imported
 * from `lib/analysisTactics.ts` (a lib module, not a page module, so
 * "hooks must not depend on page-level modules" does not apply).
 */

import { useMemo } from 'react';
import { Chess } from 'chess.js';
import type { BoardArrow, SquareMarker } from '@/components/board/ChessBoard';
import type { NodeId, MoveNode } from '@/hooks/useAnalysisBoard';
import type { RankedLine } from '@/lib/engine/types';
import type { PvLine } from '@/hooks/uciParser';
import type { HoveredQualityMove } from '@/components/analysis/MaiaMoveQualityBar';
import type { TacticLinesResponse } from '@/types/library';
import { toDisplayDepthForOrientation } from '@/lib/tacticDepth';
import { buildPvArrow } from '@/lib/tacticArrows';
import { uciToSquares } from '@/lib/sanToSquares';
import { forkPlyForOrientation, type TacticRef } from '@/lib/analysisTactics';
import {
  TAC_MISSED,
  TAC_ALLOWED,
  FLAWCHESS_ENGINE_ARROW,
  BEST_MOVE_ARROW,
  NEXT_MOVE_ARROW,
  MOVE_HIGHLIGHT_GEM,
  MOVE_HIGHLIGHT_GREAT,
} from '@/lib/theme';

// Arrow-width tuning constants (0-1 normalized, 0 = thinnest, 1 = thickest).
// This hook is their sole reader after this extraction, so they move with the
// cluster rather than staying behind as an orphaned import.
const QUALITY_HOVER_ARROW_WIDTH = 0.6;
const NEXT_MOVE_ARROW_WIDTH = 0.18;
// Both live-engine overlays show only the top-1 line per engine (156 UAT
// parity — no second-best arrow anywhere on the board).
const ARROW_COUNT = 1;
const FLAWCHESS_ENGINE_ARROW_WIDTH = 1.0;
const STOCKFISH_ENGINE_ARROW_WIDTH = 0.5;

/**
 * Named seam (CLAUDE.md: extract one named predicate/helper, not five
 * one-line helpers) that keeps `boardSquareMarkers` under the enforced
 * complexity-15 limit. Sticky gem/great marker append — see that memo's own
 * comment for the Phase 175/163-REVIEW WR-05 precedence rule this implements:
 * yields to any existing severity marker already on the square.
 */
function appendGemGreatMarker(
  base: SquareMarker[],
  markerHere: { tier: 'gem' | 'great' } | null,
  lastMove: { from: string; to: string } | null,
): SquareMarker[] {
  if (markerHere === null || lastMove == null) return base; // non-null resolution = confirmed gem/great
  if (base.some((m) => m.square === lastMove.to && m.severity != null)) return base;
  return [
    ...base,
    markerHere.tier === 'great' ? { square: lastMove.to, great: true } : { square: lastMove.to, gem: true },
  ];
}

/**
 * Quick 260717-rbn best/good marker append — the same defensive precedence
 * `appendGemGreatMarker` uses (yields to any existing severity/gem/great
 * marker on the square), appended only for the current MAINLINE ply.
 */
function appendBestGoodMarker(
  withMarker: SquareMarker[],
  bestGoodTier: 'best' | 'good' | undefined,
  lastMove: { from: string; to: string } | null,
): SquareMarker[] {
  if (bestGoodTier == null || lastMove == null) return withMarker;
  if (
    withMarker.some(
      (m) => m.square === lastMove.to && (m.severity != null || m.gem === true || m.great === true),
    )
  ) {
    return withMarker;
  }
  return [
    ...withMarker,
    bestGoodTier === 'best' ? { square: lastMove.to, best: true } : { square: lastMove.to, good: true },
  ];
}

/**
 * Phase 172 (SEED-106 D-08) book marker append — LOWEST precedence in
 * severity > gem/great > best/good > book. Appended only when the current
 * node is a MAINLINE ply inside the book AND the square carries none of
 * severity/gem/great/best/good.
 */
function appendBookMarker(
  withBestGood: SquareMarker[],
  isBookPly: boolean,
  lastMove: { from: string; to: string } | null,
): SquareMarker[] {
  if (!isBookPly || lastMove == null) return withBestGood;
  if (
    withBestGood.some(
      (m) =>
        m.square === lastMove.to &&
        (m.severity != null ||
          m.gem === true ||
          m.great === true ||
          m.best === true ||
          m.good === true),
    )
  ) {
    return withBestGood;
  }
  return [...withBestGood, { square: lastMove.to, book: true }];
}

export interface UseAnalysisBoardArrowsOptions {
  // ── Board state (useAnalysisBoard) ────────────────────────────────────
  position: string;
  currentNodeId: NodeId | null;
  nodes: Map<NodeId, MoveNode>;
  mainLine: NodeId[];
  isOnMainLine: (nodeId: NodeId) => boolean;
  lastMove: { from: string; to: string } | null;

  // ── Game mode ──────────────────────────────────────────────────────────
  isGameMode: boolean;
  gameOpeningPlyCount: number | null | undefined;
  currentMainlinePly: number;

  // ── Focused in-tree tactic sideline (the open/pending PV chip) ────────
  focusedFlaw: TacticRef | null;
  contextualTacticData: TacticLinesResponse | null | undefined;
  contextualOnStoredLine: boolean;
  contextualCurrentPly: number;
  focusedPvLine: readonly NodeId[];

  // ── Move-quality bar hover preview ────────────────────────────────────
  hoveredQualityMoves: HoveredQualityMove[] | null;

  // ── Live engine overlays — already-resolved results, no engine hook of
  // its own (see file header). ──────────────────────────────────────────
  flawChessEnabled: boolean;
  flawChessRankedLines: RankedLine[];
  engineEnabled: boolean;
  enginePvLines: PvLine[];
  reconciledBestUci: string | null;

  // ── Precomputed/live overlay markers (useGameOverlay / useLiveMoveFlaw
  // results, unrelated hooks that stay in Analysis.tsx) ──────────────────
  gameOverlaySquareMarkers: SquareMarker[];
  liveFlawSquareMarkers: SquareMarker[];

  // ── Stored gem/great/best/good data (gem-sweep cluster, still in
  // Analysis.tsx — 215-06's scope) ──────────────────────────────────────
  resolveMarkerFor: (
    nodeId: NodeId,
    mainlinePly: number,
  ) => { tier: 'gem' | 'great' } | null;
  storedBestGoodByPly: Map<number, 'best' | 'good'>;
}

export interface UseAnalysisBoardArrowsResult {
  /** Move-list/sideline text coloring inside a focused PV (Quick 260628-ojq). */
  sidelineNodeColors: Map<NodeId, string>;
  /** The board's full arrow overlay, precedence-resolved (hover > PV sideline > engines, +next-move). */
  boardArrows: BoardArrow[] | undefined;
  /** The board's square-marker overlay (severity > gem/great > best/good > book). */
  boardSquareMarkers: SquareMarker[];
  /** Last-move square tint for a gem/great tier marker, or undefined to fall through. */
  lastMoveTierColor: string | undefined;
}

/**
 * Derives the board's arrow and square-marker overlays. See the file header
 * for scope and ownership notes.
 */
export function useAnalysisBoardArrows(
  options: UseAnalysisBoardArrowsOptions,
): UseAnalysisBoardArrowsResult {
  const {
    position,
    currentNodeId,
    nodes,
    mainLine,
    isOnMainLine,
    lastMove,
    isGameMode,
    gameOpeningPlyCount,
    currentMainlinePly,
    focusedFlaw,
    contextualTacticData,
    contextualOnStoredLine,
    contextualCurrentPly,
    focusedPvLine,
    hoveredQualityMoves,
    flawChessEnabled,
    flawChessRankedLines,
    engineEnabled,
    enginePvLines,
    reconciledBestUci,
    gameOverlaySquareMarkers,
    liveFlawSquareMarkers,
    resolveMarkerFor,
    storedBestGoodByPly,
  } = options;

  // Move-list coloring inside the PV sideline (Quick 260628-ojq UAT, extends item 4):
  // teal (TAC_MISSED) for a missed tactic, crimson (TAC_ALLOWED) for an allowed one. Every
  // sideline move from the fork up to and including the depth-0 resolving move is colored,
  // so the whole tactic line reads in its orientation color (not just the punchline move).
  // The *_tactic_ply_index indexes the PV moves, which line up 1:1 with focusedPvLine.
  const sidelineNodeColors = useMemo(() => {
    const colors = new Map<NodeId, string>();
    if (!isGameMode || focusedFlaw == null || contextualTacticData == null) return colors;
    const isMissed = focusedFlaw.orientation === 'missed';
    // allowed_tactic_ply_index indexes the API allowed_moves (flaw move at index 0); the
    // grafted focusedPvLine drops that lead-in, so shift -1 to align (Quick 260628-pu2).
    const resolveIdx = isMissed
      ? (contextualTacticData.missed_tactic_ply_index ?? 0)
      : (contextualTacticData.allowed_tactic_ply_index ?? 1) - 1;
    const color = isMissed ? TAC_MISSED : TAC_ALLOWED;
    for (let i = 0; i <= resolveIdx; i++) {
      const node = focusedPvLine[i];
      if (node !== undefined) colors.set(node, color);
    }
    return colors;
  }, [isGameMode, focusedFlaw, contextualTacticData, focusedPvLine]);

  // Board "tactic overlay" while navigating a PV sideline (item 3): the depth-countdown
  // arrow on the next stored PV move, mirroring the old tactic-mode overlay. Anchored to
  // the FOCUSED line's depth/orientation (the line the board is currently in); the live
  // engine still supplies the grey 2nd.
  const pvSidelineArrows = useMemo<BoardArrow[] | null>(() => {
    if (!isGameMode || focusedFlaw == null || contextualTacticData == null) return null;
    const orientation = focusedFlaw.orientation;
    const forkNodeId = mainLine[forkPlyForOrientation(focusedFlaw.ply, orientation)];
    const onPvPath = contextualOnStoredLine || (forkNodeId !== undefined && currentNodeId === forkNodeId);
    if (!onPvPath) return null;

    const depthRaw =
      orientation === 'missed'
        ? (contextualTacticData.missed_depth ?? 0)
        : (contextualTacticData.allowed_depth ?? 0);
    // anchored=false (Quick 260628-1t5 DECISION 2): the analysis board is a navigable
    // surface, so the allowed +1 decision-anchor offset is dropped (allowed reads like missed).
    const rootDisplayDepth = toDisplayDepthForOrientation(depthRaw, orientation, false);

    // Steps into the focused PV from the current node (0 at the fork position).
    const stepIntoPv = contextualCurrentPly;
    const nextPvNodeId = focusedPvLine[stepIntoPv];
    const nextPvNode = nextPvNodeId !== undefined ? nodes.get(nextPvNodeId) : undefined;
    const nextMove = nextPvNode ? { from: nextPvNode.from, to: nextPvNode.to } : null;
    if (!nextMove) return null;

    const displayDepth = Math.max(0, rootDisplayDepth - stepIntoPv);
    // Depth 0 is the move after the tactic resolves: treat it as payoff so it shows no
    // number and drops the orientation color — the tactic is over by then (Quick 260628-pu2
    // UAT). The countdown therefore runs ...2, 1 (punchline), then payoff.
    const isPayoff = stepIntoPv >= rootDisplayDepth;
    // 156 UAT (top-1 per engine): only the single PV-continuation arrow — the
    // light-blue 2nd-best Stockfish arrow was dropped here for parity with the
    // free-analysis board (one FC arrow + one SF arrow, no second-best anywhere).
    const arrows = buildPvArrow(nextMove, displayDepth, isPayoff, orientation);
    return arrows.length > 0 ? arrows : null;
  }, [
    isGameMode,
    focusedFlaw,
    contextualTacticData,
    contextualOnStoredLine,
    contextualCurrentPly,
    currentNodeId,
    mainLine,
    focusedPvLine,
    nodes,
  ]);

  // Quick 260705-kfg: arrows for the move-quality bar's hovered segment — one per
  // move, tinted its severity color. Each SAN is replayed at the CURRENT position
  // to resolve from/to squares (skipped if illegal/malformed; never throws). Works
  // in both game mode and free play, so it's derived independently of isGameMode.
  const qualityHoverArrows = useMemo<BoardArrow[] | null>(() => {
    if (hoveredQualityMoves === null || hoveredQualityMoves.length === 0) return null;
    const arrows: BoardArrow[] = [];
    for (const { san, color } of hoveredQualityMoves) {
      try {
        const chess = new Chess(position);
        const move = chess.move(san);
        arrows.push({
          startSquare: move.from,
          endSquare: move.to,
          color,
          width: QUALITY_HOVER_ARROW_WIDTH,
        });
      } catch {
        // Illegal SAN for this position (stale hover across a board move) — skip it.
      }
    }
    return arrows.length > 0 ? arrows : null;
  }, [hoveredQualityMoves, position]);

  // Translucent white "next move played" arrow, shown whenever the board sits on
  // the main line (root or a main-line node). It points to the move that follows
  // in the game's main line — mainLine[0] at the root, else the node after the
  // current one. Rendered on top of the engine overlay (onTop) and a bit thinner.
  const nextMoveArrow = useMemo<BoardArrow | null>(() => {
    const onMain = currentNodeId === null || isOnMainLine(currentNodeId);
    if (!onMain) return null;
    const idx = currentNodeId === null ? -1 : mainLine.indexOf(currentNodeId);
    const nextNodeId = mainLine[idx + 1];
    if (nextNodeId === undefined) return null; // at the end of the main line
    const nextNode = nodes.get(nextNodeId);
    if (!nextNode) return null;
    return {
      startSquare: nextNode.from,
      endSquare: nextNode.to,
      color: NEXT_MOVE_ARROW,
      width: NEXT_MOVE_ARROW_WIDTH,
      onTop: true,
    };
  }, [currentNodeId, isOnMainLine, mainLine, nodes]);

  // Phase 156 (ARROW-01/02/03): the board's two live engine arrows — amber
  // FlawChess Engine (practical move) and blue Stockfish (objective move).
  // Independently toggled via the existing Phase 155 card switches; each simply
  // doesn't render until its engine's first snapshot yields a root move (no
  // placeholder arrow, mirrors the card skeleton timing). 156 UAT: this layer is
  // the default board overlay in BOTH game mode and free analysis — the engine
  // arrows must be identical regardless of whether a game is loaded.
  const engineArrows = useMemo<BoardArrow[]>(() => {
    const arrows: BoardArrow[] = [];
    if (flawChessEnabled) {
      for (let i = 0; i < ARROW_COUNT; i++) {
        const fcSquares = uciToSquares(flawChessRankedLines[i]?.rootMove ?? null);
        if (fcSquares) {
          arrows.push({
            startSquare: fcSquares.from,
            endSquare: fcSquares.to,
            color: FLAWCHESS_ENGINE_ARROW,
            width: FLAWCHESS_ENGINE_ARROW_WIDTH,
            layerKey: `fc-${i}`,
          });
        }
      }
    }
    if (engineEnabled) {
      for (let i = 0; i < ARROW_COUNT; i++) {
        // Phase 162 (SEED-090 D-07/D-12): the green SF arrow follows the TRUE
        // global reconciled argmax, not the free run's own pvLines[i] — this
        // may point at a move outside the Stockfish card's 2 displayed lines
        // (accepted edge case, D-12). Falls back to the free run's own top
        // line until grading has produced a reconciled best (first paint, no
        // regression) — reuses the single reconciledBestUci memo, never a
        // fresh argmax loop (RESEARCH Anti-Pattern).
        const sfUci = reconciledBestUci ?? enginePvLines[i]?.moves[0] ?? null;
        const sfSquares = uciToSquares(sfUci);
        if (sfSquares) {
          arrows.push({
            startSquare: sfSquares.from,
            endSquare: sfSquares.to,
            color: BEST_MOVE_ARROW,
            width: STOCKFISH_ENGINE_ARROW_WIDTH,
            layerKey: `sf-${i}`,
          });
        }
      }
    }
    return arrows;
  }, [flawChessEnabled, flawChessRankedLines, engineEnabled, enginePvLines, reconciledBestUci]);

  // Board arrows (156 UAT — game/free parity): the FC + SF engine-arrow layer is
  // the default overlay in BOTH modes, so the board looks identical whether or not
  // a game is loaded. The move-quality hover overlay still wins (both modes) so
  // hovering the bar previews its moves; the game-only flaw-line drill-down overlay
  // (pvSidelineArrows, self-gated to null outside game mode) still takes precedence
  // when you navigate into a specific flaw's PV. The old game-review default overlay
  // (gameOverlay.boardArrows: Stockfish best + light-blue 2nd-best) is no longer
  // drawn — top-1 per engine everywhere. Draw order is ChessBoard's width sort
  // (D-05), not array order; the white next-move arrow layers on top (onTop).
  const baseArrows: BoardArrow[] | undefined =
    qualityHoverArrows ??
    pvSidelineArrows ??
    (engineArrows.length > 0 ? engineArrows : undefined);
  // D-09 arrow isolation (157 UAT): while a move is being previewed via hover (or
  // first-tap on mobile), show ONLY that move's arrow(s). The translucent white
  // next-move arrow was previously appended unconditionally, so it survived the
  // preview and cluttered the board — suppress it too whenever a hover is active.
  const isHoverIsolated = qualityHoverArrows !== null;
  const boardArrows: BoardArrow[] | undefined =
    nextMoveArrow && !isHoverIsolated ? [...(baseArrows ?? []), nextMoveArrow] : baseArrows;

  // Precomputed game overlay (main line) wins; else the live free-move classification
  // (item 4), which also covers free-play mode. Then the sticky gem/great resolution,
  // then stored best/good, then book — one named helper per precedence tier (CLAUDE.md
  // seam: named helper for the marker-color decision, not five one-line helpers) keeps
  // this memo under the enforced complexity limit (Phase 172 SEED-106 D-01/D-08, Phase
  // 175 SEED-108 D-01/D-03/D-04/D-05, 163-REVIEW WR-05, Quick 260717-rbn).
  const boardSquareMarkers = useMemo(() => {
    const base =
      gameOverlaySquareMarkers.length > 0 ? gameOverlaySquareMarkers : liveFlawSquareMarkers;
    // Phase 175 (SEED-108 D-01/D-03), extending Phase 172 (SEED-106 CR-01/
    // D-04/D-05): the STORED backend tier wins whenever this mainline ply of
    // an analyzed game has one — present or authoritatively null (Pitfall 3).
    // Only then does live resolution apply: gemByNode wins whenever it has
    // graded this node — INCLUDING an explicit `null` rejection, in which
    // case sweep.gemByPly is NOT consulted. `resolveMarkerFor` centralizes
    // ALL of this precedence (a `??` collapse silently fell through a live
    // `null` to the sweep's shallower grade). `null` here = absent or
    // graded-and-rejected.
    const markerHere =
      currentNodeId !== null ? resolveMarkerFor(currentNodeId, currentMainlinePly) : null;
    const withMarker = appendGemGreatMarker(base, markerHere, lastMove);

    // Quick 260717-rbn: best/good — the same defensive precedence the gem/
    // great block above uses (yields to any existing severity/gem/great
    // marker on the square), appended only for the current MAINLINE ply.
    const bestGoodTier =
      currentMainlinePly >= 0 ? storedBestGoodByPly.get(currentMainlinePly) : undefined;
    const withBestGood = appendBestGoodMarker(withMarker, bestGoodTier, lastMove);

    // Phase 172 (SEED-106 D-08): book marker — LOWEST precedence in
    // severity > gem/great > best/good > book. Appended only when the current
    // node is a MAINLINE ply inside the book AND the square carries none of
    // severity/gem/great/best/good.
    const isBookPly =
      currentMainlinePly >= 0 &&
      gameOpeningPlyCount != null &&
      currentMainlinePly < gameOpeningPlyCount;
    return appendBookMarker(withBestGood, isBookPly, lastMove);
  }, [
    gameOverlaySquareMarkers,
    liveFlawSquareMarkers,
    resolveMarkerFor,
    currentNodeId,
    currentMainlinePly,
    lastMove,
    gameOpeningPlyCount,
    storedBestGoodByPly,
  ]);

  // Gem/great last-move square highlight: color the scrubbed move's from/to squares in
  // the tier's badge hue (violet gem / blue great "best move") instead of the generic
  // green. Derived from the already-resolved boardSquareMarkers, so it inherits their
  // severity > gem/great precedence — a tier marker sits on the square only when no
  // severity marker does, so this can never override a flaw's red/orange/yellow tint.
  const lastMoveTierColor = useMemo(() => {
    if (lastMove == null) return undefined;
    const marker = boardSquareMarkers.find((m) => m.square === lastMove.to && (m.gem || m.great));
    if (marker?.gem) return MOVE_HIGHLIGHT_GEM;
    if (marker?.great) return MOVE_HIGHLIGHT_GREAT;
    return undefined;
  }, [boardSquareMarkers, lastMove]);

  return { sidelineNodeColors, boardArrows, boardSquareMarkers, lastMoveTierColor };
}
