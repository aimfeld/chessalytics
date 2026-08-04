/**
 * useTrainFreePlay — Phase 200 (EXPLORE-01/02/04/05, reworked per Phase 200
 * UAT): the post-verdict free-play surface for the Train reveal board.
 *
 * UAT change from the original single-chain `useTrainExploration`: free play
 * now runs on the SAME branching move tree the Analysis page uses
 * (`useAnalysisBoard`), so sidelines behave exactly as they do there — playing
 * a move from a jumped-back position FORKS a new variation instead of
 * truncating the tail, every open line stays visible in the move list
 * (`VariationTree`), and a line closes via its own × affordance. The linear
 * "stepper" model is gone.
 *
 * It also grades every freely played move. The grade uses the SAME
 * expected-score pipeline as the solve verdict (`classifyTrainMoveQuality`
 * over `liveFlaw`'s sigmoid): the parent position's completed engine eval vs
 * the child position's, with "was it the engine's own top move" answered from
 * the parent's rank-1 PV. Deliberately NO Maia (Phase 200 UAT): the Train loop
 * never loads the ONNX runtime, so what the Analysis page would call a gem or
 * a great move is labelled plainly `best` here.
 *
 * Two engines are in play on the solve screen and they are separate Worker
 * objects with no shared dispatch queue: the session-scoped grading engine
 * (`useTrainGradingEngine`, untouched by this hook) and the free-play engine
 * created below, which exists only while `isExploring` and is torn down by
 * `useStockfishEngine`'s own lifecycle the moment that flips false.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Chess } from 'chess.js';

import type { SquareMarker } from '@/components/board/ChessBoard';
import type { FlawMarkerEntry } from '@/components/analysis/VariationTree';
import { useAnalysisBoard } from '@/hooks/useAnalysisBoard';
import type { MoveNode, NodeId } from '@/hooks/useAnalysisBoard';
import { useStockfishEngine } from '@/hooks/useStockfishEngine';
import { rankLineForSquares } from '@/hooks/uciParser';
import type { PvLine } from '@/hooks/uciParser';
import { evalToExpectedScore, sideToMoveFromFen, terminalPositionEval } from '@/lib/liveFlaw';
import {
  classifyTrainMoveQuality,
  toDisplayQuality,
  trainQualityMarker,
  TRAIN_STEP_HIGHLIGHT,
} from '@/lib/trainArrows';
import type { TrainMoveQuality } from '@/lib/trainArrows';

/**
 * FIFO bound on the per-FEN eval cache — mirrors the Analysis page's own
 * `LIVE_EVAL_CACHE_MAX`, so a long free-play session can't grow it without
 * bound. Well above any realistic sideline depth.
 */
const FREE_PLAY_EVAL_CACHE_MAX = 200;

/** One position's completed engine verdict, cached while the board sits on it
 * so the move OUT of it can be graded once the board has moved on. */
interface FreePlayEval {
  cp: number | null;
  mate: number | null;
  /** The engine's rank-1 move from this position (UCI), or null when unknown —
   * the "is this the best move" input to `classifyTrainMoveQuality`. */
  bestUci: string | null;
}

/**
 * Phase 205 (D-04): the grading engine's seed for `useTrainFreePlay`,
 * threaded through `TrainSolveScreen`'s `freePlaySeedEval`. Extends
 * `FreePlayEval`'s three fields with the settled mount search's own rank
 * lines, so the FIRST freely played move — when it lands on the puzzle's
 * ROOT ply and matches one of those ranks — can be graded from that SAME
 * search instead of a fresh, independently-searched post-move eval that can
 * disagree with it (SEED-137 case 2). See `currentQuality`'s root-only
 * branch below for where this is consumed. `lines` is REQUIRED here (unlike
 * `GradeResult.lines`, which is optional for D-10 cache-restore reasons) —
 * the one nullish default that absorbs a missing/older-bundle value lives
 * at `TrainSolveScreen.tsx`'s `freePlaySeedEval` seam, not here.
 */
export interface FreePlaySeedEval extends FreePlayEval {
  lines: PvLine[];
}

/**
 * Phase 205 (D-04): frozen empty rank-lines array — referential stability so
 * `currentQuality`'s memo does not re-run every render when no seed is
 * present (a fresh `[]` literal would fail the dependency-array `Object.is`
 * check on every render). Never mutated.
 */
const NO_SEED_LINES = Object.freeze<PvLine[]>([]);

export interface UseTrainFreePlayOptions {
  /** The puzzle position — the root of every free-play line. */
  startFen: string;
  /**
   * The grading engine's verdict for `startFen`, so the FIRST freely played
   * move is graded immediately instead of waiting for the free-play engine to
   * re-evaluate a position the solve loop already searched. White-POV, same as
   * every other eval in the Train stack. Null before a verdict has landed.
   */
  seedEval: FreePlaySeedEval | null;
}

export interface TrainFreePlayState {
  /** True from the first post-verdict drop until `reset()`. */
  isExploring: boolean;
  /** The live board position while exploring, else null. */
  fen: string | null;
  /** The move that reached `fen` (for the board's ordinary last-move highlight). */
  lastMove: { from: string; to: string } | null;
  /** Quality-colored last-move highlight, or undefined while the move is
   * still ungraded (the board then falls back to its default highlight). */
  lastMoveColor: string | undefined;
  /** The quality badge for the move that reached `fen` — the board half of
   * "highlight played moves by move quality". Empty while ungraded. */
  boardMarkers: SquareMarker[];
  // ── VariationTree inputs ────────────────────────────────────────────────
  nodes: Map<NodeId, MoveNode>;
  mainLine: NodeId[];
  currentNodeId: NodeId | null;
  /** Ply offset of `startFen`, so the move list numbers plies like the game did. */
  rootPly: number;
  /** The move list half of the quality highlighting — one entry per graded node. */
  moveListMarkers: Map<NodeId, FlawMarkerEntry>;
  // ── Engine card inputs ──────────────────────────────────────────────────
  /** Staleness-guarded: empty unless the lines belong to the shown position. */
  pvLines: PvLine[];
  isAnalyzing: boolean;
  /**
   * The engine's top move from the SHOWN position (UCI), or null while the
   * engine hasn't produced a line for it yet. Staleness-guarded by the same
   * `engineIsCurrent` check as `pvLines`, so the board's blue best-move arrow
   * (Phase 200 UAT round 5) can never point at the previous position's answer.
   */
  bestMoveUci: string | null;
  // ── Commands ────────────────────────────────────────────────────────────
  /**
   * Begins free play: roots the tree at `startFen`, grafts `prefixUci` (the
   * stepped-line prefix already on the board, or `[]` from the pristine
   * reveal) followed by `moveUci`, and lands on the tip.
   */
  start: (prefixUci: string[], moveUci: string) => void;
  /** Plays a board move from the current node — forks when it diverges. */
  playMove: (from: string, to: string) => boolean;
  /** Grafts a whole engine line from the current node and lands on its end. */
  playLine: (uciMoves: string[]) => void;
  /** Navigates to an existing node (move-list click). */
  goToNode: (id: NodeId) => void;
  /** Retreats one move along the current line (board-controls ◀). */
  goBack: () => void;
  /** Advances to the current node's first child (board-controls ▶). */
  goForward: () => void;
  /** Jumps back to the puzzle position WITHOUT leaving free play or dropping
   * the tree — the board-controls Reset. Exiting free play entirely is a
   * different command owned by the caller (Solution / the panel's ×). */
  goToRoot: () => void;
  /** False at the puzzle position — disables Reset and ◀ together. */
  canGoBack: boolean;
  /** True when the current node has at least one child to advance into. */
  canGoForward: boolean;
  /** Deletes a sideline and everything under it (the move list's × affordance). */
  deleteLine: (rootId: NodeId) => void;
  /** Returns to the pristine (non-exploring) state, re-rooted at `startFen`.
   * Stable per `startFen` so callers can list it in an effect's deps. */
  reset: () => void;
}

/** Ply offset of a FEN — mirrors Analysis.tsx's `fenToRootPly`. */
function fenToPly(fen: string): number {
  const parts = fen.split(' ');
  const side = parts[1];
  const fullmove = parts[5];
  if (side === undefined || fullmove === undefined) return 0;
  const ply = (Number(fullmove) - 1) * 2 + (side === 'b' ? 1 : 0);
  return Number.isNaN(ply) ? 0 : ply;
}

/**
 * The `VariationTree` marker entry for one graded move. Maps the Train quality
 * taxonomy onto the move list's icon slots through `toDisplayQuality`, so an
 * inaccuracy reads exactly as it does on the reveal board (collapsed into
 * good) rather than contradicting it. Never sets `gem`/`great` — no Maia runs
 * in the Train loop (Phase 200 UAT).
 */
function markerEntryForQuality(quality: TrainMoveQuality): FlawMarkerEntry {
  const display = toDisplayQuality(quality);
  const base: FlawMarkerEntry = {
    missedMotif: null,
    allowedMotif: null,
    missedDepth: null,
    allowedDepth: null,
    ply: 0,
  };
  if (display === 'best') return { ...base, best: true };
  if (display === 'good') return { ...base, good: true };
  return { ...base, severity: display };
}

/** Insert into a FEN-keyed cache under the shared FIFO bound (Map preserves
 * insertion order, so the first key is the oldest). */
function withCapped<V>(prev: Map<string, V>, key: string, value: V): Map<string, V> {
  const next = new Map(prev);
  next.set(key, value);
  if (next.size > FREE_PLAY_EVAL_CACHE_MAX) {
    const oldest = next.keys().next().value;
    if (oldest !== undefined) next.delete(oldest);
  }
  return next;
}

export function useTrainFreePlay({
  startFen,
  seedEval,
}: UseTrainFreePlayOptions): TrainFreePlayState {
  const [isExploring, setIsExploring] = useState(false);
  const board = useAnalysisBoard(startFen);
  const { position, nodes, mainLine, currentNodeId, rootFen, lastMove } = board;
  const { makeMove, playUciLine, goToNode, deleteSubtree, loadMainLine } = board;
  const { goBack, goForward, goToRoot } = board;

  const fen = isExploring ? position : null;
  const engine = useStockfishEngine({ fen, enabled: isExploring });
  // The hook's `currentFen` lags `fen` by exactly one render (its own
  // documented contract), so an unguarded read would paint the PREVIOUS
  // position's lines — and, worse here, grade a move against them.
  const engineIsCurrent = fen !== null && engine.currentFen === fen;
  const pvLines = engineIsCurrent ? engine.pvLines : [];

  // ── Per-FEN eval cache ────────────────────────────────────────────────────
  // Every position's completed eval, captured while the board sits on it, so
  // the move OUT of it can be graded once the board has moved on. Held in
  // state (not a ref) so reading it during render is legitimate — same shape
  // and rationale as the Analysis page's `engineEvalByFen`.
  const [evalByFen, setEvalByFen] = useState<Map<string, FreePlayEval>>(() => new Map());

  const seedCp = seedEval?.cp ?? null;
  const seedMate = seedEval?.mate ?? null;
  const seedBestUci = seedEval?.bestUci ?? null;
  // Phase 205 (D-04): the settled mount search's own rank lines, or the
  // shared frozen empty array when no seed is present yet. Deliberately NOT
  // `seedEval?.lines ?? NO_SEED_LINES` here — `seedEval.lines` is a REQUIRED
  // field on `FreePlaySeedEval` (the one nullish default for a missing value
  // lives at the `freePlaySeedEval` call site in `TrainSolveScreen.tsx`, per
  // D-10 — a second default here would make that one untestable).
  const seedLines = seedEval === null ? NO_SEED_LINES : seedEval.lines;
  useEffect(() => {
    if (seedCp === null && seedMate === null) return;
    setEvalByFen((prev) => {
      const existing = prev.get(startFen);
      if (existing?.cp === seedCp && existing.mate === seedMate && existing.bestUci === seedBestUci) {
        return prev; // unchanged — skip the re-render
      }
      return withCapped(prev, startFen, { cp: seedCp, mate: seedMate, bestUci: seedBestUci });
    });
  }, [startFen, seedCp, seedMate, seedBestUci]);

  const liveBestUci = engineIsCurrent ? (engine.pvLines[0]?.moves[0] ?? null) : null;
  const liveCp = engineIsCurrent ? engine.evalCp : null;
  const liveMate = engineIsCurrent ? engine.evalMate : null;
  useEffect(() => {
    if (fen === null) return;
    if (liveCp === null && liveMate === null) return;
    setEvalByFen((prev) => {
      const existing = prev.get(fen);
      if (existing?.cp === liveCp && existing.mate === liveMate && existing.bestUci === liveBestUci) {
        return prev;
      }
      return withCapped(prev, fen, { cp: liveCp, mate: liveMate, bestUci: liveBestUci });
    });
  }, [fen, liveCp, liveMate, liveBestUci]);

  // ── Live grading of the move that reached the current node ────────────────
  const currentNode = currentNodeId !== null ? (nodes.get(currentNodeId) ?? null) : null;

  // Board-controls ▶ enablement. `useAnalysisBoard.goForward` advances to the
  // current node's first child by insertion order (a fork's other branches are
  // reached from the move list), so "can go forward" is exactly "a child
  // exists" — matching what the button will actually do.
  const hasChild = useMemo(() => {
    if (!isExploring) return false;
    for (const node of nodes.values()) {
      if (node.parentId === currentNodeId) return true;
    }
    return false;
  }, [isExploring, nodes, currentNodeId]);
  const parentFen = useMemo<string | null>(() => {
    if (currentNode === null) return null;
    if (currentNode.parentId === null) return rootFen;
    return nodes.get(currentNode.parentId)?.fen ?? rootFen;
  }, [currentNode, nodes, rootFen]);

  const currentQuality = useMemo<TrainMoveQuality | null>(() => {
    if (!isExploring || currentNode === null || parentFen === null || fen === null) return null;
    const parent = evalByFen.get(parentFen);
    if (parent === undefined || (parent.cp === null && parent.mate === null)) return null;
    // A checkmate/stalemate position makes the engine report an ambiguous
    // `mate 0`; the rules already know the answer, so prefer them (same fix
    // the Analysis page applies — otherwise a mating move grades as a blunder).
    const terminal = terminalPositionEval(fen);
    // Phase 205 (D-04): when the played move is the puzzle's ROOT ply (no
    // parent move — `currentNode.parentId === null`) and it matches one of
    // the settled mount search's own ranks, grade it from that rank line's
    // own eval instead of the free-play engine's fresh post-move search —
    // the reveal's "Also fine" alternatives row and this badge must be
    // answered by the SAME search, so a move the row calls fine can never be
    // badged worse when played (SEED-137 case 2, Phase 205 D-04). Root-only
    // on purpose: below the root, the parent and child evals already come
    // from ONE engine (this free-play engine itself), which is already
    // self-consistent — consulting the seeded ROOT-only lines there would
    // grade a move against a search of a DIFFERENT position.
    const rootRank =
      terminal === null && currentNode.parentId === null
        ? rankLineForSquares(seedLines, currentNode.from, currentNode.to)
        : null;
    const childCp = terminal !== null ? terminal.cp : rootRank !== null ? rootRank.evalCp : liveCp;
    const childMate =
      terminal !== null ? terminal.mate : rootRank !== null ? rootRank.evalMate : liveMate;
    if (childCp === null && childMate === null) return null;
    const mover = sideToMoveFromFen(parentFen);
    const esBefore = evalToExpectedScore(parent.cp, parent.mate, mover);
    const esAfter = evalToExpectedScore(childCp, childMate, mover);
    // Compare on from/to only: the engine's UCI carries a promotion suffix
    // that `MoveNode` does not store, so a full-string compare would call an
    // engine-best promotion a non-best move.
    const isBest =
      parent.bestUci !== null &&
      parent.bestUci.slice(0, 4) === `${currentNode.from}${currentNode.to}`;
    return classifyTrainMoveQuality(esBefore, esAfter, isBest);
  }, [isExploring, currentNode, parentFen, fen, evalByFen, liveCp, liveMate, seedLines]);

  // Persist each graded node's quality so the move-list badge stays on EVERY
  // explored move (not just the current one) and re-showing an earlier move
  // doesn't wait on the engine to re-grade it.
  const [qualityByNode, setQualityByNode] = useState<Map<NodeId, TrainMoveQuality>>(
    () => new Map(),
  );
  useEffect(() => {
    if (currentQuality === null || currentNodeId === null) return;
    setQualityByNode((prev) => {
      if (prev.get(currentNodeId) === currentQuality) return prev;
      const next = new Map(prev);
      next.set(currentNodeId, currentQuality);
      return next;
    });
  }, [currentQuality, currentNodeId]);

  const moveListMarkers = useMemo(() => {
    const markers = new Map<NodeId, FlawMarkerEntry>();
    for (const [nodeId, quality] of qualityByNode) {
      if (!nodes.has(nodeId)) continue; // a deleted sideline keeps no badges
      markers.set(nodeId, markerEntryForQuality(quality));
    }
    return markers;
  }, [qualityByNode, nodes]);

  const shownQuality =
    currentNodeId !== null ? (qualityByNode.get(currentNodeId) ?? currentQuality) : null;
  const boardMarkers = useMemo<SquareMarker[]>(
    () =>
      currentNode !== null && shownQuality !== null
        ? [trainQualityMarker(currentNode.to, shownQuality)]
        : [],
    [currentNode, shownQuality],
  );
  const lastMoveColor =
    shownQuality !== null ? TRAIN_STEP_HIGHLIGHT[toDisplayQuality(shownQuality)] : undefined;

  // ── Commands ──────────────────────────────────────────────────────────────
  const start = useCallback(
    (prefixUci: string[], moveUci: string) => {
      // Both calls land in the same React batch, and `playUciLine` is a
      // FUNCTIONAL updater — so it reads the state `loadMainLine` just wrote
      // (root = startFen, no nodes) rather than the pre-reset tree.
      loadMainLine([], startFen);
      playUciLine([...prefixUci, moveUci]);
      // `loadMainLine` restarts node ids at 0, so any quality left over from an
      // earlier session would attach itself to an unrelated new node.
      setQualityByNode((prev) => (prev.size === 0 ? prev : new Map()));
      setIsExploring(true);
    },
    [loadMainLine, playUciLine, startFen],
  );

  const reset = useCallback(() => {
    setIsExploring(false);
    setQualityByNode((prev) => (prev.size === 0 ? prev : new Map()));
    loadMainLine([], startFen);
    // `evalByFen` is deliberately NOT cleared: its entries are keyed by FEN, so
    // a stale one can only ever be re-read for the very position it describes,
    // and keeping the seed means re-entering free play on the same puzzle
    // grades its first move immediately again.
  }, [loadMainLine, startFen]);

  return {
    isExploring,
    fen,
    lastMove: isExploring ? lastMove : null,
    lastMoveColor,
    boardMarkers,
    nodes,
    mainLine,
    currentNodeId,
    rootPly: fenToPly(startFen),
    moveListMarkers,
    pvLines,
    isAnalyzing: engine.isAnalyzing,
    bestMoveUci: liveBestUci,
    start,
    playMove: makeMove,
    playLine: playUciLine,
    goToNode,
    goBack,
    goForward,
    goToRoot,
    canGoBack: isExploring && currentNodeId !== null,
    canGoForward: hasChild,
    deleteLine: deleteSubtree,
    reset,
  };
}

/** Re-exported so callers can build a `start`/`playMove` guard without
 * importing chess.js twice — used by `TrainSolveScreen.handlePieceDrop` to
 * derive the UCI of a legal drop before free play has begun. */
export function uciFromDrop(fen: string, from: string, to: string): string | null {
  try {
    const chess = new Chess(fen);
    const move = chess.move({ from, to, promotion: 'q' }); // auto-queen
    if (!move) return null;
    return `${move.from}${move.to}${move.promotion ?? ''}`;
  } catch {
    return null;
  }
}
