/**
 * Analysis — standalone /analysis page.
 *
 * Default export (required by React.lazy — every other page uses a named export;
 * this is the intentional divergence, see RESEARCH.md Pitfall 1).
 *
 * Composes:
 *   useAnalysisBoard  — branching move-tree board state
 *   useStockfishEngine — UCI WASM engine state
 *   EvalBar / EngineLines / VariationTree — analysis display components
 *   ChessBoard / BoardControls — board interaction
 *   EvalChart — below-board eval chart with slider (Phase 140 game mode)
 *
 * Security:
 *   ?line= guard: parseAnalysisLineParam degrades a malformed UCI line to its legal
 *     prefix (or empty) — a hand-typed bad URL can't crash the board.
 *   ?fen= guard (T-165-03): parseAnalysisFenParam chess.js-validates the decoded FEN,
 *     degrading a malformed/garbage value to null (free-play start) instead of crashing.
 *   T-140-02a: NaN-guard on ?game_id= / ?ply= params — malformed → null → isGameMode false.
 *   T-140-02b: L-8 guard on mainLine[ply] accesses — out-of-bounds → undefined → no-op.
 *
 * Engine: on by default (D-06); "Loading engine…" shown in eval area while WASM inits;
 *   board stays interactive throughout (SC#3).
 *
 * Modes: ?line=<uci,uci,…> seeds free play with an opening main line (cursor at the end,
 *   navigable back to move 1); no line → bare start. ?fen=<encoded fen> additively seeds
 *   free play with an arbitrary mid-game FEN snapshot as the root (SEED-094 / D-06;
 *   restored alongside ?line=, not a replacement — no navigable history back to move 1).
 *   ?game_id=X&ply=Y loads the full game at ply Y (game mode). Precedence when multiple
 *   params are present: game_id > fen > line. ?orientation=white|black additively orients
 *   the board in ANY free-play sub-mode (171 UAT gap 1); game mode ignores it and always
 *   orients from gameData.user_color. A manual flip still wins over either (hasAutoFlipped).
 *   The legacy tactic mode (?flaw_ply=, removed Quick 260627-l2z) is gone; clicking a
 *   move-list tactic chip grafts the PV as an in-tree sideline with a depth overlay.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { useNavigate } from 'react-router';
import { Chess } from 'chess.js';
import { useAnalysisBoard } from '@/hooks/useAnalysisBoard';
import { useAnalysisRouteParams } from '@/hooks/analysis/useAnalysisRouteParams';
import { useAnalysisEngineLines } from '@/hooks/analysis/useAnalysisEngineLines';
import { useAnalysisRouteSeeding } from '@/hooks/analysis/useAnalysisRouteSeeding';
import { useAnalysisBoardArrows } from '@/hooks/analysis/useAnalysisBoardArrows';
import { useStockfishEngine } from '@/hooks/useStockfishEngine';
import { useStockfishGradingEngine } from '@/hooks/useStockfishGradingEngine';
import { useMaiaEngine } from '@/hooks/useMaiaEngine';
import { nextLineFen } from '@/lib/nextLineFen';
import {
  useMaiaEloDefault,
  deriveRawDefault,
  clampToLadderBounds,
  FREE_PLAY_DEFAULT_ELO,
} from '@/hooks/useMaiaEloDefault';
import { useFlawChessEngine } from '@/hooks/useFlawChessEngine';
import { useEngineAssetStatus } from '@/hooks/useEngineAssets';
import { engineGateRequired } from '@/lib/engine/engineAssetProgress';
import { EngineReadyGate } from '@/components/bots/EngineReadyGate';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useGameOverlay } from '@/hooks/useGameOverlay';
import { useLiveMoveFlaw } from '@/hooks/useLiveMoveFlaw';
import { useTacticLines, useLibraryGame } from '@/hooks/useLibrary';
import { buildGameAnalysisUrl } from '@/lib/analysisUrl';
import type { PasteParseResult, PastedGameHeaders } from '@/lib/pastedGame';
import { takePastedGameHandoff } from '@/lib/pastedGameHandoff';
import { EvalBar } from '@/components/analysis/EvalBar';
import { MAX_LINES as FC_MAX_LINES } from '@/components/analysis/FlawChessEngineLines';
import type { FlawSeverity } from '@/types/library';
import { isRareMoveTier } from '@/types/library';
import { useFastForward, FAST_FORWARD_ANIMATION_MS } from '@/hooks/useFastForward';
import { tacticOrientationAtPly } from '@/lib/tacticOrientation';
import { TEMPERATURE_DEFAULT } from '@/components/analysis/TemperatureSelector';
import type { HoveredQualityMove } from '@/components/analysis/MaiaMoveQualityBar';
import { ChessBoard } from '@/components/board/ChessBoard';
import {
  BOARD_MAX_WIDTH,
  BOARD_EVAL_BARS_ALLOWANCE_PX,
  EVAL_SLIDER_SLACK_PX,
  DESKTOP_BOARD_SIZE_REDUCTION_PX,
} from '@/components/board/boardSize';
import {
  PlayerBar,
  BoardHeaderRow,
  BoardFooterRow,
} from '@/components/analysis/AnalysisPlayerBar';
import {
  BoardControls,
  VariationTreePanel,
  EvalChartPanel,
  TagsPanel,
  EloSelectorPanel,
  FlawChessCard,
  MoveListHeaderContent,
  HumanTab,
  FlawChessTab,
  MobileEngineLines,
  EvalTab,
  MovesTab,
  StatsTab,
  AnalysisTabs,
} from '@/components/analysis/AnalysisTabs';
import { BoardRow, DesktopBoardStage } from '@/components/analysis/AnalysisBoardStage';
import {
  StockfishCard,
  MovesCard,
  DesktopMaiaPanel,
  PasteModalNode,
} from '@/components/analysis/AnalysisDesktopCards';
import {
  forkPlyForOrientation,
  flawKey,
  bestSanFromPv,
  type TacticRef,
  type OpenLine,
} from '@/lib/analysisTactics';
import {
  MOVE_HIGHLIGHT_GOOD,
  STOCKFISH_ACCENT,
  MAIA_ACCENT,
  FLAWCHESS_ENGINE_ACCENT,
} from '@/lib/theme';
import { selectCandidatesByMass, nearestByElo } from '@/lib/moveQuality';
import {
  sideToMoveFromFen,
  terminalPositionEval,
  type MoverColor,
} from '@/lib/liveFlaw';
import type { NodeId, MoveNode } from '@/hooks/useAnalysisBoard';
import type { MoveCurvePoint } from '@/hooks/useMaiaEngine';
import { GEM_MAIA_MAX_PROB, LIVE_EVAL_CACHE_MAX } from '@/lib/gemMove';
import { useGemSweep } from '@/hooks/useGemSweep';
import { selectSweepCandidates, type SweepCandidate } from '@/lib/gemSweep';
import { useAnalysisGemMarkers } from '@/hooks/analysis/useAnalysisGemMarkers';
import { useBoardStageSize } from '@/hooks/analysis/useBoardStageSize';

// ─── Constants ────────────────────────────────────────────────────────────────

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// LIVE_EVAL_CACHE_MAX (per-session live engine-eval cache cap, FEN →
// completed eval, item 4) moved to lib/gemMove.ts (215 code review WR-04) —
// useAnalysisGemMarkers.ts's parent-grade retention cache shares the same
// bound, so both files now import one constant instead of two copies that
// could silently diverge.

// NO_GAME_PLY (IN-04 sentinel) moved to useAnalysisGemMarkers.ts (Phase 215
// Plan 05) — that hook is its sole reader now.

/** Synthetic eval-bar depth for a terminal (checkmate/draw) position — clears EvalBar's
 *  mate-display gate (depth >= 8) so a decisive terminal eval fills the bar (Quick 260709-j3k). */
const TERMINAL_EVAL_DEPTH = 99;

/** Eval-bar fill for "dead equal" / "no data at all" — the midpoint of EvalBar's
 *  white-fraction scale, matching what its own cp sigmoid returns for 0. Named
 *  because it is the last resort of the left bar's precedence chain and the draw
 *  case of a terminal position, and a bare 0.5 repeated across those expressions
 *  is exactly the magic number the root CLAUDE.md forbids. */
const EVAL_BAR_NEUTRAL_FRACTION = 0.5;

/** Below this width the page renders its mobile takeover layout. Set to Tailwind's `md`
 *  (768px) — MUST stay in sync with the shell's height-lock unlock band in ProtectedLayout
 *  (App.tsx uses `md:max-desk3col:` so [0,768) stays locked for the takeover's footer chain,
 *  [768,1200) scrolls for the two-column layout). Note this is now above the shell's `sm`
 *  chrome breakpoint (640px), so the 640–768 slice shows the takeover under the desktop nav
 *  header — functionally fine (locked shell, full nav available). */
const MOBILE_BREAKPOINT_PX = 768;

/** The desk3col grid breakpoint (mirrors `--breakpoint-desk3col: 1200px` in index.css):
 *  at/above this width the locked desktop 3-column grid engages; between
 *  MOBILE_BREAKPOINT_PX and this width the page uses the mid-range two-column layout
 *  (board + eval chart | tabbed panel). Same literal as
 *  useBoardStageSize.ts's BOARD_WIDTH_LOCK_MIN_PX (Phase 215 Plan 05), kept as its own
 *  named constant since it gates a different concern (which layout tree renders, not the
 *  board's height lock). */
const DESK3COL_BREAKPOINT_PX = 1200;

// BOARD_EVAL_BARS_ALLOWANCE_PX/DESKTOP_BOARD_SIZE_REDUCTION_PX moved to
// components/board/boardSize.ts (215 code review WR-04) — useBoardStageSize.ts
// and AnalysisBoardStage.tsx are not independent readers of a private copy:
// this file's DESKTOP_GRID_MAX_WIDTH_PX calc, useBoardStageSize's boardWidth
// derivation, and AnalysisBoardStage's boardWidth-plus-allowance maxWidth all
// need the SAME bound, so they now share one import instead of three copies
// that could silently disagree and clip the eval bars again.

/** Mobile board size ceiling — 80px below the shared BOARD_MAX_WIDTH. The mobile layout
 *  is a vertical stack (board on top, tabs below), so a full-size board crowded the tab
 *  panel; a smaller board leaves more of the viewport for the tabs. The board is square and
 *  width-driven on mobile, so this caps its height too. */
const MOBILE_BOARD_MAX_WIDTH = BOARD_MAX_WIDTH - 80;

/** Max width of the mobile board block (the board + its two flanking eval bars + the
 *  wrapper's `px-2` side padding). Caps the `flex-1` board container at the mobile board
 *  ceiling so the board FILLS its container instead of capping short inside a wider one —
 *  which otherwise leaves a gap between the board's right edge and the SF eval bar and
 *  pushes the player clock labels past the board's right border. `MOBILE_BOARD_MAX_WIDTH`
 *  (board) + `BOARD_EVAL_BARS_ALLOWANCE_PX` (bars + gaps) + 16 (`px-2` both sides,
 *  border-box). Combined with `92vw` at the call site so narrow phones still shrink to fit. */
const MOBILE_BOARD_BLOCK_MAX_PX = MOBILE_BOARD_MAX_WIDTH + BOARD_EVAL_BARS_ALLOWANCE_PX + 16;

// BOARD_WIDTH_LOCK_MIN_PX/BOARD_HEIGHT_LOCK_MIN_PX moved to
// useBoardStageSize.ts (Phase 215 Plan 05) — that hook is their sole reader
// now.

/** Fixed width (px) of each side-panel grid track. Mirrors the `360px` literals in the
 *  `desk3col:grid-cols-[360px_1fr_360px]` template and `desk3col:w-[360px]` columns below. */
const SIDE_COLUMN_WIDTH_PX = 360;
/** Gutter (px) between the three desktop columns — mirrors the grid's `gap-4`. */
const DESKTOP_GRID_GAP_PX = 16;
// EVAL_SLIDER_SLACK_PX moved to components/board/boardSize.ts (215 code
// review WR-04) — see the BOARD_EVAL_BARS_ALLOWANCE_PX comment above.
/** Max width of the desktop 3-column grid: two side panels + two gutters + the board group
 *  at its ceiling (board max + flanking eval bars + the two slider-slack margins). Past this
 *  the grid stops stretching and centers itself, so extra viewport width falls to the window
 *  margins instead of inflating the fluid center track and pulling the side panels away from
 *  the board (Phase 161 UAT). */
const DESKTOP_GRID_MAX_WIDTH_PX =
  SIDE_COLUMN_WIDTH_PX * 2 +
  DESKTOP_GRID_GAP_PX * 2 +
  (BOARD_MAX_WIDTH - DESKTOP_BOARD_SIZE_REDUCTION_PX) +
  BOARD_EVAL_BARS_ALLOWANCE_PX +
  EVAL_SLIDER_SLACK_PX * 2;

// QUALITY_HOVER_ARROW_WIDTH, NEXT_MOVE_ARROW_WIDTH, ARROW_COUNT,
// FLAWCHESS_ENGINE_ARROW_WIDTH and STOCKFISH_ENGINE_ARROW_WIDTH moved to
// useAnalysisBoardArrows.ts (Phase 215 Plan 05) — that hook is their sole
// reader now.

/**
 * Phase 196 (INJECT-04, RESEARCH.md Pitfall 1): the single shared empty-array
 * reference returned from every "nothing to inject" branch of the
 * `extraRootMoves` state below. Load-bearing because `useFlawChessEngine`
 * treats an `extraRootMoves` identity change as "restart the search", while
 * `engine.pvLines`' array reference changes on EVERY Stockfish `info` line
 * during the ~1.5-2s window before the free run commits. A fresh `[]`
 * literal on those branches would abort and restart the FlawChess search
 * continuously and DISPLAY-01's first search would never complete — there
 * must be exactly ONE such array in the module.
 */
const NO_EXTRA_ROOT_MOVES: string[] = [];

type AnalysisLayoutMode = 'mobile' | 'mid' | 'desktop';

/**
 * Which of the three analysis layouts to render, chosen by viewport width:
 *   • 'mobile'  (< MOBILE_BREAKPOINT_PX)   — full tab takeover, board on top.
 *   • 'mid'     (MOBILE..desk3col)         — two equal columns: board |
 *                                             tabbed panel (Moves | Eval | Maia | FlawChess | Stats).
 *   • 'desktop' (>= desk3col)              — the locked 3-column grid.
 * Driven by JS (not CSS) so the board / eval-chart / variation-tree mount EXACTLY once —
 * a CSS `hidden` split would duplicate their stable `id`/`data-testid`s and the engine board.
 * Exactly one of the three return branches renders, so those shared nodes never coexist.
 */
function useAnalysisLayoutMode(): AnalysisLayoutMode {
  const compute = (): AnalysisLayoutMode => {
    if (typeof window === 'undefined') return 'desktop';
    if (window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`).matches) return 'mobile';
    if (window.matchMedia(`(max-width: ${DESK3COL_BREAKPOINT_PX - 1}px)`).matches) return 'mid';
    return 'desktop';
  };
  const [mode, setMode] = useState<AnalysisLayoutMode>(compute);
  useEffect(() => {
    const mqMobile = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
    const mqMid = window.matchMedia(`(max-width: ${DESK3COL_BREAKPOINT_PX - 1}px)`);
    const update = () => setMode(compute());
    mqMobile.addEventListener('change', update);
    mqMid.addEventListener('change', update);
    return () => {
      mqMobile.removeEventListener('change', update);
      mqMid.removeEventListener('change', update);
    };
  }, []);
  return mode;
}

// ─── Root-ply helper ──────────────────────────────────────────────────────────

/**
 * Derive the ply offset of a position from its FEN.
 * rootPly = (fullmoveNumber - 1) * 2 + (sideToMove === 'b' ? 1 : 0)
 * Used by EngineLines (startPly) and VariationTree (rootPly) to produce
 * correct move-number labels for opening-position entries.
 */
function fenToRootPly(fen: string | undefined): number {
  if (!fen) return 0;
  const parts = fen.split(' ');
  const side = parts[1];
  const fullmove = parts[5];
  if (side === undefined || fullmove === undefined) return 0;
  const ply = (Number(fullmove) - 1) * 2 + (side === 'b' ? 1 : 0);
  return Number.isNaN(ply) ? 0 : ply;
}

// forkPlyForOrientation/flawKey/bestSanFromPv and the OpenLine/TacticRef
// types moved to lib/analysisTactics.ts (215 code review WR-05) — this file
// was one of up to four independent copies (already textually diverged in
// useAnalysisBoardArrows.ts); every reader now imports the single shared
// implementation.

/**
 * Find the open (or pending) tactic line the board is currently "in" — extracted to a
 * pure module-scope function (not inlined in a component useMemo) because the React
 * Compiler's memoization-preservation lint cannot analyze this control flow (nested
 * for/while loop with early returns) inline; a plain function called FROM useMemo
 * satisfies it (Quick 260703-kyb).
 *
 * Checks pendingFlaw first (its fork node always matches BEFORE any previously-focused
 * line would, since handlePvChipClick / the auto-open effect navigate there immediately),
 * then every open line: match by fork-node equality OR subtree containment (walk parentId
 * up from currentNodeId until it reaches the line's rootNodeId).
 */
function findFocusedFlaw(
  isGameMode: boolean,
  currentNodeId: NodeId | null,
  pendingFlaw: TacticRef | null,
  openLines: Map<string, OpenLine>,
  mainLine: NodeId[],
  nodes: Map<NodeId, MoveNode>,
): TacticRef | null {
  if (!isGameMode || currentNodeId === null) return null;
  if (pendingFlaw != null) {
    const forkNodeId = mainLine[forkPlyForOrientation(pendingFlaw.ply, pendingFlaw.orientation)];
    if (forkNodeId !== undefined && currentNodeId === forkNodeId) return pendingFlaw;
  }
  for (const line of openLines.values()) {
    const forkNodeId = mainLine[forkPlyForOrientation(line.ply, line.orientation)];
    if (forkNodeId !== undefined && currentNodeId === forkNodeId) {
      return { ply: line.ply, orientation: line.orientation };
    }
    if (isNodeInsideSubtree(nodes, currentNodeId, line.rootNodeId)) {
      return { ply: line.ply, orientation: line.orientation };
    }
  }
  return null;
}

/** True iff walking parentId up from `nodeId` reaches `rootId`. */
function isNodeInsideSubtree(
  nodes: Map<NodeId, MoveNode>,
  nodeId: NodeId,
  rootId: NodeId,
): boolean {
  let id: NodeId | null = nodeId;
  while (id !== null) {
    if (id === rootId) return true;
    id = nodes.get(id)?.parentId ?? null;
  }
  return false;
}

/**
 * Walk children from `rootNodeId` following the lowest-id child chain until it leaves
 * `pvNodeIds` — the ordered node array of an open tactic line. Module-scope pure
 * function for the same React Compiler reason as findFocusedFlaw above.
 */
function buildFocusedPvLine(
  nodes: Map<NodeId, MoveNode>,
  pvNodeIds: Set<NodeId>,
  rootNodeId: NodeId,
): NodeId[] {
  const chain: NodeId[] = [];
  let id: NodeId | undefined = rootNodeId;
  while (id !== undefined && pvNodeIds.has(id)) {
    chain.push(id);
    let lowest: NodeId | undefined;
    for (const node of nodes.values()) {
      if (node.parentId === id && (lowest === undefined || node.id < lowest)) lowest = node.id;
    }
    id = lowest;
  }
  return chain;
}

// ─── Page ────────────────────────────────────────────────────────────────────

/**
 * Default-exported Analysis page (required by React.lazy in App.tsx).
 * ROUTE-01: reachable by authenticated users inside ProtectedLayout.
 * ROUTE-02: ?line= seeds a free-play opening main line; empty/malformed → standard start.
 * ROUTE-04 (Phase 140): ?game_id=&ply= enters game mode (full game at initial ply).
 * ?fen= (SEED-094 / D-06): additively seeds a free-play mid-game FEN snapshot root;
 *   precedence game_id > fen > line when multiple params are present.
 */
export default function Analysis() {
  const navigate = useNavigate();

  // Everything the page learns from the URL alone (Phase 215 Plan 04 —
  // useAnalysisRouteParams.ts). initialTactic/initialAlignPly/autoOrientation
  // stay local below — they need gameData, which needs gameId from THIS
  // hook, see useAnalysisRouteParams.ts's header for the ordering reason.
  const { lineSans, rootFenSeed, urlOrientation, gameId, initialPly, isGameMode } =
    useAnalysisRouteParams();

  const layoutMode = useAnalysisLayoutMode();
  const isMobile = layoutMode === 'mobile';
  const isMid = layoutMode === 'mid';

  // G-213-34 (supersedes D-12): the same non-dismissible gate Bots.tsx mounts,
  // now on the analysis board too. The lazy initializer form is load-bearing
  // and mirrors useBotGame's `live` state: it evaluates the cache-miss
  // predicate exactly once, at mount, so the gate cannot reappear later when
  // the store's asset entries change (a mid-session WebGPU-to-wasm refetch
  // resets an asset's progress and would otherwise re-open a gate the user
  // has already passed).
  const [engineGateOpen, setEngineGateOpen] = useState(() => engineGateRequired());

  // D-06: engine on by default; toggle available via infoSlot button.
  const [engineEnabled, setEngineEnabled] = useState(true);
  // Phase 155 D-02/D-03: the Maia and FlawChess Engine header switches — all
  // three engine cards default ON (all-by-default UI, gated on the SC4
  // real-device mobile-memory UAT per 155-RESEARCH.md D-02).
  const [maiaEnabled, setMaiaEnabled] = useState(true);
  const [flawChessEnabled, setFlawChessEnabled] = useState(true);
  // Quick 260901-oxh: the fast-forward run state, LIFTED up here rather than read
  // off `fastForward.isRunning`. The useFastForward call sits ~1,000 lines below
  // (it needs `evalChartPly`), but the consumers that must react to a run are the
  // engine hooks declared just below this line — and hooks cannot be reordered
  // around that. So the hook pushes its run state upward through
  // `onRunningChange` instead of the page pulling it downward.
  //
  // This is NOT a circular dependency: the setter flows down into useFastForward,
  // the value flows up, and useFastForward reads none of the engines. It is also
  // NOT a render loop: each transition is a one-shot true/false write from an
  // event handler or a timer callback, never from render.
  const [fastForwardRunning, setFastForwardRunning] = useState(false);
  const [boardFlipped, setBoardFlipped] = useState(false);

  // Quick 260703-kyb: multi-line tactic state (move-list tactic-chip expansion →
  // flat in-tree sideline; replaces the Phase 140 activePvFlaw singleton).
  // Ephemeral in-memory — D-01: not URL-encoded.
  //
  // openLines — every currently GRAFTED tactic line, keyed by flawKey(ply, orientation).
  // pendingFlaw — the line currently being opened, awaiting its PV fetch. Only one
  // open action is in flight at a time (clicks/auto-opens are sequential); once its
  // fetch arrives, the graft effect below records it into openLines and clears this.
  const [openLines, setOpenLines] = useState<
    Map<string, { rootNodeId: NodeId; ply: number; orientation: 'missed' | 'allowed' }>
  >(() => new Map());
  const [pendingFlaw, setPendingFlaw] = useState<{
    ply: number;
    orientation: 'missed' | 'allowed';
  } | null>(null);

  // Quick 260702-nm8 (Task 3): desktop-only hover-highlight from the tags panel onto
  // the eval chart's markers — mirrors LibraryGameCard's highlightedPlies. Not passed
  // on mobile (the chart lives on a different tab there).
  const [tagsHighlightedPlies, setTagsHighlightedPlies] = useState<Set<number> | null>(null);

  // Quick 260705-kfg: the moves of the move-quality bar's currently-hovered segment
  // (SAN + severity color), drawn as board arrows. Null when nothing is hovered.
  const [hoveredQualityMoves, setHoveredQualityMoves] = useState<HoveredQualityMove[] | null>(null);

  // Phase 208 (D-19/D-20): the paste-a-FEN-or-PGN modal. Held open in every
  // mode, including ?game_id= game mode — no gating on isGameMode.
  const [pasteModalOpen, setPasteModalOpen] = useState(false);

  // Phase 208 (PASTE-02): the ephemeral (unsaved) pasted-PGN headers + the
  // side the user selected, driving the ephemeral player-info render and the
  // board's orientation. Cleared whenever the board is reset or a real
  // ?game_id= game loads (D-15 navigates there after an explicit "Analyze
  // full game" save — Plan 03 — which is a fresh page load, but this also
  // covers any future same-session transition). Never persisted (D-03).
  const [pastedHeaders, setPastedHeaders] = useState<{
    headers: PastedGameHeaders;
    userColor: 'white' | 'black';
  } | null>(null);

  // ── All hooks (unconditional, React rules) ────────────────────────────────────

  const {
    position,
    currentNodeId,
    nodes,
    mainLine,
    pvNodeIds,
    nextId,
    rootFen,
    lastMove,
    makeMove,
    goBack,
    goForward,
    goToNode,
    loadMainLine,
    isOnMainLine,
    insertPvLine,
    playUciLine,
    deleteSubtree,
    clearAllSidelines,
    isOnPvLine,
    containerRef,
  } = useAnalysisBoard(STARTING_FEN);

  // Engine hook must run unconditionally (React rules).
  // 155 UAT un-merge: the standalone Stockfish search runs whenever its own
  // switch (`engineEnabled`) is on, independently of the FlawChess Engine. The
  // two engines pick very different moves (objective vs practical-for-you), so
  // the user must see both — the Stockfish card shows Stockfish's own top-2 with
  // depth deepening live, alongside the separate FlawChess Engine card. This
  // reverses the earlier D-04 handoff (which fed the SF surfaces the FlawChess
  // engine's objective root eval and blanked the Stockfish card). Cost: two
  // concurrent Stockfish searches (this standalone WASM + the engine's 2-4
  // worker pool); mobile memory stays the deferred SC4 follow-up, not a blocker.
  //
  // FAST-FORWARD SUPPRESSION (quick 260901-oxh) — the shared explanation for all
  // four live engine hooks on this page (this one, `maia`, `flawChessEngine` and
  // `grading`); the other three cross-reference this block.
  //
  // Each of those hooks carries a 150ms RAPID_STEP_DEBOUNCE_MS with a
  // `sinceLast > RAPID_STEP_DEBOUNCE_MS` fire-immediately branch
  // (useStockfishEngine.ts:41/:277-286, useMaiaEngine.ts:45,
  // useFlawChessEngine.ts:33, useStockfishGradingEngine.ts:60/:334). setTimeout is
  // never early, so at any FAST_FORWARD_STEP_MS above that 150ms window (the
  // cadence is 200ms) `sinceLast` ALWAYS exceeds the
  // window and the immediate branch wins on every replayed ply, deterministically
  // — four fresh searches per ply. That per-ply engine load is what delays the
  // replay's own timer callbacks and makes the move sounds arrive unevenly, so
  // suppressing it is load-bearing for the fix, not an optimisation.
  //
  // The lever is the `fen` INPUT, never the `enabled` flag (DEV-1). `enabled` owns
  // Worker/provider lifecycle — its cleanup terminates the Stockfish workers, tears
  // down the whole FlawChess MCTS provider + pool, and releases Maia's shared-worker
  // lease — so flipping it per run would re-initialise three engines on every press,
  // strictly MORE main-thread work than the searches being suppressed. `enabled` is
  // also the user-facing switch state the card headers and their "engine off"
  // placeholders read, so reassigning it would visibly flip the switches mid-replay.
  // Every one of these hooks documents `fen: null` as "keeps the engine idle (no
  // analyze/go sent)" while leaving the Worker warm — that is exactly what is wanted.
  //
  // RAPID_STEP_DEBOUNCE_MS itself is deliberately NOT retuned: the fix is
  // suppression for the duration of a run, not a different debounce.
  const engine = useStockfishEngine({
    fen: engineEnabled && !fastForwardRunning ? position : null,
    enabled: engineEnabled,
  });

  // focusedFlaw: the open (or pending) line the board is currently "in" — its subtree
  // contains currentNodeId, OR its fork node equals currentNodeId (so the depth arrow
  // shows while parked at a just-opened line's fork). pendingFlaw is checked first: as
  // soon as it's set, handlePvChipClick/the auto-open effect also navigate to its fork
  // node, so this always matches BEFORE any previously-focused line would.
  const focusedFlaw = useMemo(
    () => findFocusedFlaw(isGameMode, currentNodeId, pendingFlaw, openLines, mainLine, nodes),
    [isGameMode, currentNodeId, pendingFlaw, openLines, mainLine, nodes],
  );

  // focusedPvLine: the ordered node array of the focused line — replaces the old
  // singleton pvLine as the input to the overlay memos below. Empty while the line is
  // still pending (not yet grafted) or when nothing is focused.
  const focusedPvLine = useMemo<NodeId[]>(() => {
    if (focusedFlaw == null) return [];
    const line = openLines.get(flawKey(focusedFlaw));
    if (line == null) return [];
    return buildFocusedPvLine(nodes, pvNodeIds, line.rootNodeId);
  }, [focusedFlaw, openLines, nodes, pvNodeIds]);

  // Contextual PV fetch: lazy-fetch for inline chip expansion (L-3: unconditional).
  // Keyed on pendingFlaw when a line is being opened, else the focused (already-open)
  // line — react-query caches per (gameId, ply), so re-focusing an already-opened line
  // is a cache hit, not a re-fetch.
  const fetchFlaw = pendingFlaw ?? focusedFlaw;
  const {
    data: contextualTacticData,
    isFetching: contextualPending,
    isError: contextualError,
  } = useTacticLines(gameId, fetchFlaw?.ply ?? null, fetchFlaw != null && isGameMode);

  // Game-by-id fetch for full-game mode (D-4: existing endpoint, no new backend).
  // Unconditional hook call; enabled only when isGameMode (gameId is null otherwise).
  // Quick 260714-rj5: `live: true` polls while analysis is pending/leased so a
  // freshly-enqueued bot game's eval chart appears in place once the job lands.
  const { data: gameData, isError: gameError } = useLibraryGame(
    isGameMode ? gameId : null,
    { live: true },
  );

  // Quick 260714-rj5: this is "the EVAL DATA is ready", not "the game is ready" —
  // an unanalyzed game-mode card arrives with moves + phase_transitions but
  // eval_series/flaw_markers stay null, so the move list and board render from
  // gameData.moves while evalChartReady stays false. HOISTED here (Phase 172,
  // SEED-106 D-03) — the background sweep's start effect needs this as its
  // readiness gate, and it must fire on the FALSE -> TRUE transition (a bot game
  // opened mid-tier-1-analysis), which this same `useLibraryGame({ live: true })`
  // poll already delivers. Single declaration; every other consumer below
  // (evalPending, the eval-chart render, the sweep) reads this ONE const.
  const evalChartReady =
    isGameMode &&
    gameId != null &&
    gameData?.eval_series != null &&
    gameData.flaw_markers != null &&
    gameData.phase_transitions != null &&
    gameData.moves != null;

  // Phase 172 (SEED-106 D-03): "armed" the moment evalChartReady flips true for
  // THIS gameId — same render, no one-tick delay (reading evalChartReady
  // directly avoids waiting on an effect to catch up; that delay is fine for
  // bookkeeping but not for the READINESS signal itself, which must fire the
  // instant the evals land, not one render later). `armedGameId` is sticky
  // protection against evalChartReady flickering false again for a game
  // already confirmed ready (e.g. a stale poll tick) — it never GATES the
  // initial transition. Reactive React state, not a ref: this project's lint
  // config (react-hooks/refs) forbids reading ref.current during render, and
  // `sweepArmedForGame` below is read during render.
  const [armedGameId, setArmedGameId] = useState<number | null>(null);
  useEffect(() => {
    if (!evalChartReady || gameId == null || armedGameId === gameId) return;
    setArmedGameId(gameId);
  }, [evalChartReady, gameId, armedGameId]);
  const sweepArmedForGame = gameId != null && (evalChartReady || armedGameId === gameId);

  // Phase 175 (SEED-108 D-01/D-03): per-ply STORED gem/great tier, straight from
  // EvalPoint.best_move_tier/maia_prob — the backend's authoritative
  // classify_best_move output (Plan 02). ply -> {tier, maiaProb}; only entries
  // with a non-null best_move_tier are kept (Pitfall 3 — a null tier on a
  // stored row is a real "not gem/great" verdict, never "unknown"). Empty for
  // an unanalyzed game or free play (eval_series null).
  const storedTierByPly = useMemo<Map<number, { tier: 'gem' | 'great'; maiaProb: number }>>(() => {
    const map = new Map<number, { tier: 'gem' | 'great'; maiaProb: number }>();
    const series = gameData?.eval_series;
    if (series == null) return map;
    // The analyzed board INTENTIONALLY shows BOTH players' stored gems/greats (Plan 05
    // feature, confirmed by the user 2026-07-17): opponent gems are valuable study
    // context on the board, and resolveMarkerFor's byOpponent path renders the
    // "Your opponent found a gem move!" popover for them. This is DISTINCT from the
    // user-only badges/eval-chart dots/cycling (Plan 06 fix, plyOwnership.isUserPly) —
    // those are "your gems/greats" stats, the board is a study surface. So NO user
    // filter here: every point with a non-null best_move_tier is kept (Pitfall 3 — a
    // null tier is a real "not gem/great" verdict, never "unknown").
    for (const point of series) {
      // Quick 260717-rbn: narrow explicitly to 'gem'/'great' (not just
      // maia_prob != null) — best_move_tier's type now also includes
      // 'best'/'good', which maia_prob is never populated for (Pitfall 5),
      // but TS can't infer that runtime invariant from the maia_prob check alone.
      if (
        (point.best_move_tier === 'gem' || point.best_move_tier === 'great') &&
        point.maia_prob != null
      ) {
        map.set(point.ply, { tier: point.best_move_tier, maiaProb: point.maia_prob });
      }
    }
    return map;
  }, [gameData?.eval_series]);

  // Quick 260717-rbn: per-ply STORED best/good tier, straight from
  // EvalPoint.best_move_tier — mirrors storedTierByPly's shape/no-user-filter
  // convention above (the board intentionally shows BOTH players' badges, a
  // study surface, not a "your stats" surface) but keeps only 'best'/'good'
  // (never 'gem'/'great', which storedTierByPly already owns). maia_prob is
  // always null for best/good (Pitfall 5) so there is no maia_prob filter
  // here, unlike storedTierByPly.
  const storedBestGoodByPly = useMemo<Map<number, 'best' | 'good'>>(() => {
    const map = new Map<number, 'best' | 'good'>();
    const series = gameData?.eval_series;
    if (series == null) return map;
    for (const point of series) {
      if (point.best_move_tier === 'best' || point.best_move_tier === 'good') {
        map.set(point.ply, point.best_move_tier);
      }
    }
    return map;
  }, [gameData?.eval_series]);

  // Phase 175 (SEED-108 D-01/BOARD-02, Pitfall 3): true once this game's
  // eval_series is loaded — every EvalPoint on an analyzed game's eval_series
  // carries best_move_tier (Plan 02, defaulting null), so eval_series
  // readiness IS "this game has been checked for stored gem/great data"; a
  // null tier on a given mainline ply is the real, authoritative answer,
  // never "not yet checked" (row-absence is authoritative — corpus backfill
  // of PRE-175 analyzed games is Phase 176's job, out of scope here). Reuses
  // the STICKY `sweepArmedForGame` signal (not the possibly-flickering
  // `evalChartReady`) so this can never transiently flip false mid-poll. Both
  // live gem mechanisms below (`needParentGemGrade`, `useGemSweep`'s
  // `enabled`) gate on this so neither one re-derives a verdict the stored
  // path already owns.
  const gameHasStoredBestMoveData = sweepArmedForGame;

  // Free-play ELO default source (D-07) — read from useUserProfile(), never useAuth().user
  // (no rating field there, cf. beta-gating memory).
  const { data: userProfile } = useUserProfile();

  // D-06/D-07: "you are here" ELO for the Maia surfaces, derived from game-mode
  // rating-at-game-time or the free-play blitz anchor, with user-override precedence.
  const { selectedElo, setSelectedElo, defaultElo, resetToDefault } = useMaiaEloDefault({
    isGameMode,
    gameData,
    profile: userProfile,
    // Default the ELO to whoever is to move — the opponent's rating on their
    // moves — so the Maia surfaces reflect the actual decision-maker (quick 260705-m3z).
    sideToMove: sideToMoveFromFen(position),
  });

  // Phase 172 (SEED-106 D-01): the gem rung is a property of the GAME, not of
  // the view — pinned to whichever color actually made the move
  // (rating-at-game-time), never the reactive ELO slider. `selectedElo`
  // above keeps driving the live exploration overlay (Maia chart, WDL bar,
  // FlawChess Engine) exactly as before; this helper is read ONLY by the gem
  // detection block and (plan 05 Task 2) the background sweep, so a single
  // source of truth exists for "what rung was this ply detected at" and a
  // slider nudge can never invalidate it. Reuses `deriveRawDefault` /
  // `clampToLadderBounds` (exported by useMaiaEloDefault.ts, plan 02) rather
  // than re-deriving the `*_lichess_blitz ?? raw` fallback chain a second time.
  const pinnedEloForMover = useCallback(
    (mover: MoverColor): number =>
      clampToLadderBounds(deriveRawDefault(isGameMode, gameData, userProfile, mover) ?? FREE_PLAY_DEFAULT_ELO),
    [isGameMode, gameData, userProfile],
  );

  // Whose move the analysed position is — drives the Maia verdict's you/opponent
  // framing. False in free play (no opponent).
  const isOpponentToMove =
    isGameMode && gameData?.user_color != null && sideToMoveFromFen(position) !== gameData.user_color;

  // Play a named move from the Maia verdict prose as a free move (quick 260705-mth).
  // The prose SANs are legal at the current position; resolve to from/to and hand
  // to makeMove, which advances into the existing line or forks a sideline.
  const playProseMove = (san: string): void => {
    try {
      const move = new Chess(position).move(san);
      if (move) makeMove(move.from, move.to);
    } catch {
      // SAN no longer legal (position changed under the prose) — ignore.
    }
  };

  // Maia-3 human-move model (MAIA-04/05, SURF-05): full per-ELO curve + WDL for the
  // current position, no server round-trip. Phase 155 D-03: gated on the Maia
  // card's own header switch (`maiaEnabled`) — MAIA-02's laziness is otherwise
  // already satisfied by the route-level React.lazy covering this whole page.
  // Note: this hook holds its OWN priority lease on the shared Maia worker
  // (quick 260729-sod, FIX 3 — the underlying Worker is now shared with the
  // FlawChess Engine's own internal maiaQueue, Phase 154, but each keeps a
  // separate lease/cache/single-in-flight discipline) — turning this switch
  // off releases only this lease and must not starve the FlawChess Engine's
  // own `priority: false` policy source (UI-SPEC Component Inventory §3).
  // `fen: fastForwardRunning ? null : position` — this hook gates only via
  // `enabled` and otherwise passes the position unconditionally, so the run
  // suppression is the sole condition here. See the FAST-FORWARD SUPPRESSION
  // block at the `useStockfishEngine` call above for why the lever is `fen`.
  // `prefetchFen` (quick 260906-gu2): the next ply on the current line gets
  // its exact selected-ELO rung inferred right after the live position's (one
  // ~200 ms wasm inference), so stepping forward lands on a cache hit for the
  // eval bar and the FlawChess Engine's root policy instead of a fresh
  // inference. Computed inline (a string, cheap O(mainline) lookup) — this
  // component sits at its max-statements/complexity baseline. Needs no
  // fast-forward gate of its own: the hook never prefetches while `fen` is null.
  const maia = useMaiaEngine({
    fen: fastForwardRunning ? null : position,
    enabled: maiaEnabled,
    selectedElo,
    prefetchFen: nextLineFen(nodes, currentNodeId, mainLine),
  });

  // Phase 159 D-08 (Thread A): session-only policy-temperature state, plain
  // useState mirroring the ELO slider's no-persistence behavior (no
  // localStorage/URL param) — resets to TEMPERATURE_DEFAULT on every page load.
  const [temperature, setTemperature] = useState(TEMPERATURE_DEFAULT);

  // Phase 196 (INJECT-03/04): the free run's settled disagreement moves fed
  // into the FlawChess root, exactly once per position. The VALUE is derived
  // by the effect further down (placed after `freeRunCommitted` and after
  // `flawChessEngine` itself exist, since it reads this hook's own output —
  // a feedback edge a `useMemo` cannot express, hence `useState` here rather
  // than a memo). `injectedForPositionRef` is the per-position exactly-once
  // latch that effect reads/writes.
  const [extraRootMoves, setExtraRootMoves] = useState<string[]>(NO_EXTRA_ROOT_MOVES);
  const injectedForPositionRef = useRef<string | null>(null);

  // FlawChess Engine (Phase 153-155 client-side MCTS search core, DISPLAY-01):
  // gated on its own header switch (`flawChessEnabled`), independent of the
  // Stockfish and Maia switches. `selectedElo` is shared for both colors
  // (D-07/Open Question 2, 155-02). `temperature` (Phase 159 D-06/D-07) reshapes
  // the root-mover's-own-side Maia policy before search and composes with the
  // findability ranking automatically (buildRankedLines reads child.prior).
  // `&& !fastForwardRunning`: see the FAST-FORWARD SUPPRESSION block at the
  // `useStockfishEngine` call above. `enabled` is untouched on purpose — it owns
  // the MCTS provider + worker pool lifecycle ("created once per enabled-lifetime").
  const flawChessEngine = useFlawChessEngine({
    fen: flawChessEnabled && !fastForwardRunning ? position : null,
    enabled: flawChessEnabled,
    elo: selectedElo,
    policyTemperature: temperature,
    extraRootMoves,
  });

  // Quick 260702-fog: the tactic (if any) the board auto-opens to when the entry ply carries
  // a user tactic chip. Drives BOTH the initial navigation effect and the move-list top-align
  // target, so the two stay in sync. Missed wins over allowed (see tacticOrientationAtPly).
  const initialTactic = useMemo<{ ply: number; orientation: 'missed' | 'allowed' } | null>(() => {
    if (!isGameMode) return null;
    const ply = initialPly ?? 0;
    const orientation = tacticOrientationAtPly(gameData?.flaw_markers, ply);
    return orientation === null ? null : { ply, orientation };
  }, [isGameMode, gameData?.flaw_markers, initialPly]);

  // Ply the move list top-aligns on first open: the tactic fork ply when a tactic auto-opens
  // (missed → decision board ply-1, allowed → flaw ply), else the plain entry ply. Keeps the
  // scroller's initial top-align on the node the board actually navigates to (Quick 260702-fog).
  const initialAlignPly =
    initialTactic !== null
      ? forkPlyForOrientation(initialTactic.ply, initialTactic.orientation)
      : (initialPly ?? 0);

  // Orient the board to the player's color once (item 5; 171 UAT gap 1). ONE
  // orientation source for BOTH modes: game mode learns the player's colour
  // from the backend (gameData.user_color), free play learns it from the URL
  // (?orientation=). Before 171-08 free play had NO orientation input at all,
  // so a bot game played as Black opened white-side-up. Black games/lines open
  // flipped; manual flips afterward win permanently (hasAutoFlipped guard, now
  // inside useAnalysisRouteSeeding).
  const autoOrientation = isGameMode ? (gameData?.user_color ?? null) : urlOrientation;

  // Board-seeding effects (Phase 215 Plan 04 — useAnalysisRouteSeeding.ts):
  // the six effects that imperatively seed board state via loadMainLine/
  // goToNode/insertPvLine in response to the URL/game-mode inputs above.
  // seededKey/pasteHandoffConsumed are returned because ONE more effect below
  // (the Import-tab paste-handoff consume effect) still reads/writes them.
  const { seededKeyRef, pasteHandoffConsumedRef } = useAnalysisRouteSeeding({
    isGameMode,
    gameId,
    initialPly,
    lineSans,
    rootFenSeed,
    autoOrientation,
    initialTactic,
    gameData,
    pendingFlaw,
    contextualTacticData,
    openLines,
    mainLine,
    nextId,
    loadMainLine,
    goToNode,
    insertPvLine,
    setBoardFlipped,
    setPendingFlaw,
    setOpenLines,
  });

  // ── Derived values ────────────────────────────────────────────────────────────

  // Stockfish card loading skeleton — spins only while the standalone Stockfish
  // WASM is still initializing (155 UAT un-merge: the search runs independently
  // of the FlawChess Engine, so this no longer depends on flawChessEnabled).
  const engineLoading = engineEnabled && !engine.isReady;
  // Mirrors engineLoading: true only while the FlawChess Engine's WorkerPool/
  // MaiaQueue are still spinning up. Phase 213 D-01/Plan 05 Task 1: `isReady`
  // is now backed by real asset readiness (both providers' `whenReady()`
  // settling), not merely by provider construction — so this flag is honest
  // for the same reason `engineLoading` above always was.
  const flawChessLoading = flawChessEnabled && !flawChessEngine.isReady;

  // G-213-34: the gate's own read of the unconditional asset bundle — the
  // page's ONLY store read now (supersedes D-12's three per-card reads;
  // download progress lives exclusively in the gate modal).
  //
  // Bug fix (G-213-35 third part, 213-10-PLAN.md): this used to call the full
  // `useEngineAssets(requiredEngineAssets())` for a SINGLE boolean use below
  // (`status !== 'unsupported'`) — that subscribed the whole 3,600-line page
  // to every per-chunk download notification, re-rendering the board, charts
  // and every panel on the order of a thousand-plus times during a 45.7 MB
  // cold-start download. `useEngineAssetStatus()` returns just the status
  // PRIMITIVE, so `useSyncExternalStore`'s `Object.is` check skips the
  // re-render on a byte-only progress tick — only a real status transition
  // (idle -> downloading -> ready/failed/unsupported) re-renders this page.
  // `EngineReadyGate` (mounted below) still gets full byte-level progress via
  // its own internal `useEngineAssets` call — this narrowing does not touch
  // that.
  const engineAssetStatus = useEngineAssetStatus();

  const rootPly = fenToRootPly(rootFen);
  const currentPly = fenToRootPly(position);

  const canGoForward = useMemo(() => {
    for (const node of nodes.values()) {
      if (node.parentId === currentNodeId) return true;
    }
    return false;
  }, [nodes, currentNodeId]);

  // MovesByRatingChart emphasis (Plan 06, SURF-01): the SAN of the move that reached
  // the current node — true for both game mode (the played main-line/PV move) and
  // free play (the last move the user played), since both read the same node field.
  const playedSan = currentNodeId !== null ? (nodes.get(currentNodeId)?.san ?? null) : null;

  // MovesByRatingChart emphasis: the engine's current top-line first move, converted
  // to SAN at the current position. Prefer the standalone Stockfish top move (its
  // objective best); when Stockfish is off but the FlawChess Engine is on, fall back
  // to the top practical candidate so the 151.1 best-move highlight still shows
  // (WR-04, 155-REVIEW.md).
  const bestSan = useMemo(() => {
    const uci = engineEnabled
      ? (engine.pvLines[0]?.moves[0] ?? null)
      : flawChessEnabled
        ? (flawChessEngine.rankedLines[0]?.rootMove ?? null)
        : null;
    return bestSanFromPv(position, uci);
  }, [position, engineEnabled, engine.pvLines, flawChessEnabled, flawChessEngine.rankedLines]);

  // Phase 151.1 SC2/D-02/D-06/D-07: the 0.95-cumulative-mass candidate set at the
  // selected ELO, unioned with {bestSan, playedSan} — computed ONCE here and
  // consumed as one contributor to the grading union below (unionSans), plus
  // passed to the chart (as shownSans), replacing MovesByRatingChart's own
  // top-6-by-peak cap.
  const shownSans = useMemo(
    () => selectCandidatesByMass(maia.perElo, selectedElo, playedSan, bestSan),
    [maia.perElo, selectedElo, playedSan, bestSan],
  );

  // Phase 159 D-10/D-12 (SEED-085 ride-along, 159-Pitfall 5): raw Maia move-probability-by-SAN
  // map at the selected ELO, computed ONCE here (the SAME rung the chart displays via
  // nearestByElo) and passed down to FlawChessAgreementVerdict as `rawProbBySan` — the verdict
  // gate must never call nearestByElo independently, so the prose can never contradict the chart.
  const rawProbBySan = useMemo(
    () => nearestByElo(maia.perElo, selectedElo)?.moveProbabilities ?? {},
    [maia.perElo, selectedElo],
  );

  // Phase 158 (SEED-087 SC2): the FC card's own top-MAX_LINES displayed SANs,
  // converted from their root UCI moves — the FlawChess Engine's contribution
  // to the shared grading union below. Empty (a no-op contributor) whenever
  // the FC card is off, so the union reflects only active consumers.
  const flawChessDisplayedSans = useMemo(() => {
    if (!flawChessEnabled) return [];
    const sans: string[] = [];
    for (const line of flawChessEngine.rankedLines.slice(0, FC_MAX_LINES)) {
      const san = bestSanFromPv(position, line.rootMove);
      if (san !== null) sans.push(san);
    }
    return sans;
  }, [flawChessEnabled, flawChessEngine.rankedLines, position]);

  // Phase 162 (SEED-090 D-02/D-09): the free run has "committed" a bestmove for
  // the current position once it has at least one PV line and is no longer
  // mid-search. `pvLines` is cleared to `[]` on every FEN change and
  // `isAnalyzing` flips false only on a non-stale bestmove (useStockfishEngine.ts),
  // so this pairing never reads a stale prior-position PV as committed.
  const freeRunCommitted = engine.pvLines.length > 0 && !engine.isAnalyzing;

  // Phase 158 (SEED-087 SC2, RESEARCH Pitfall 4) / Phase 162 (SEED-090 D-02/D-09):
  // the deduplicated, sorted union of the Maia chart's shownSans, the FC card's
  // displayed SANs, and — once the free run has committed a bestmove for this
  // position — the free run's own top-2 root SANs. This closes the "no
  // uncovered displayed move" gap: the grading union now contains everything
  // the Stockfish card shows, not just what Maia/FlawChess independently
  // surface. Sorted + deduped via the SAME single `Array.from(new
  // Set(...)).sort()` (mirroring the grading hook's own candidatesKey pattern)
  // so a re-throttle of the SAME top moves produces the same array and does
  // not re-trigger the search.
  const unionSans = useMemo(() => {
    const maiaSans = maiaEnabled ? shownSans : [];
    const fcSans = flawChessEnabled ? flawChessDisplayedSans : [];
    const freeRunSans: string[] = [];
    if (freeRunCommitted) {
      const san0 = bestSanFromPv(position, engine.pvLines[0]?.moves[0] ?? null);
      const san1 = bestSanFromPv(position, engine.pvLines[1]?.moves[0] ?? null);
      if (san0 !== null) freeRunSans.push(san0);
      if (san1 !== null) freeRunSans.push(san1);
    }
    return Array.from(new Set([...maiaSans, ...fcSans, ...freeRunSans])).sort();
  }, [maiaEnabled, shownSans, flawChessEnabled, flawChessDisplayedSans, freeRunCommitted, engine.pvLines, position]);

  // Phase 196 (INJECT-03/INJECT-04): supply the free run's settled root
  // first-moves (UCIs) to the FlawChess search exactly once per position, on
  // genuine disagreement only. Distinct from `unionSans` above in TWO
  // load-bearing ways: (1) stays in raw UCI form (SearchBudget.extraRootMoves
  // is `string[]` of UCIs, not SANs), and (2) MUST return the SAME shared
  // `NO_EXTRA_ROOT_MOVES` reference on every no-op branch — this value feeds
  // `useFlawChessEngine`'s search-restart effect deps (unionSans does not),
  // so an unstable identity here would abort+restart the FlawChess search on
  // every Stockfish info-line update during the ~1.5-2s pre-commit window
  // (RESEARCH.md Pitfall 1).
  useEffect(() => {
    // (1) Latch reset: navigating away (or back) to a DIFFERENT position
    // clears the per-position latch so a revisited position can inject again.
    if (injectedForPositionRef.current !== null && injectedForPositionRef.current !== position) {
      injectedForPositionRef.current = null;
    }
    // (2a) Bug fix (quick 260731-s0z, FIX-2): with a side disabled, that
    // hook's `fen` prop is `null` (see the `engineEnabled ? position : null` /
    // `flawChessEnabled ? position : null` call sites below), so its
    // `currentFen` pins to `null` forever, the (2b) staleness guard below
    // returns on every run, and step (4)'s sentinel reset is unreachable —
    // a previously latched extraRootMoves array kept feeding every subsequent
    // position's search budget even while that side stayed off. Placed
    // BEFORE the (2) latch check (a latched position must still reset) but
    // clears the latch too, so re-enabling can inject afresh; nothing can
    // latch while disabled since this branch returns before step (3). Reuses
    // the SAME identity-preserving updater step (4) uses, so the shared
    // NO_EXTRA_ROOT_MOVES reference contract holds.
    if (!engineEnabled || !flawChessEnabled) {
      injectedForPositionRef.current = null;
      setExtraRootMoves((prev) => (prev === NO_EXTRA_ROOT_MOVES ? prev : NO_EXTRA_ROOT_MOVES));
      return;
    }

    // (2) Latch check: the INJECT-04 exactly-once guarantee. Without this, a
    // later rankedLines update that now contains the injected move would look
    // like "nothing missing", reset extraRootMoves to the sentinel, and
    // restart the search a second time — oscillating.
    if (injectedForPositionRef.current === position) return;

    // (2b) Staleness guard (WR-01, 196-REVIEW.md): this effect fires in the
    // SAME passive-effect flush as useFlawChessEngine's and useStockfishEngine's
    // OWN FEN-reset effects (both declared earlier in this component's body).
    // A `setState` call inside those sibling effects does not retroactively
    // update the closure values THIS effect already captured from the
    // just-completed render — so the moment `position` changes, this
    // effect's closure can still hold `flawChessEngine.rankedLines` /
    // `engine.pvLines` from the PREVIOUS position while `position` itself is
    // already the new value. `bestSanFromPv`'s incidental legality check
    // below is not a reliable staleness guard on its own — a stale UCI is
    // often ALSO legal in the new position (e.g. a sibling-branch navigation
    // that preserves side-to-move parity), which would otherwise let step
    // (3) compute `missing` from stale data and permanently latch a spurious
    // candidate for the new position. Bail out here whenever either hook's
    // `currentFen` has not yet caught up to `position`; this same effect
    // re-fires (via the `engine.pvLines/flawChessEngine.rankedLines` deps
    // below) once each hook's own reset — and eventually its real re-search
    // commit — lands for the new position.
    if (flawChessEngine.currentFen !== position || engine.currentFen !== position) {
      return;
    }

    // (3) Compute `next`.
    let next: string[] = NO_EXTRA_ROOT_MOVES;
    if (flawChessEnabled && freeRunCommitted && flawChessEngine.rankedLines.length > 0) {
      const organicUcis = new Set(flawChessEngine.rankedLines.map((line) => line.rootMove));
      const candidateUcis = [engine.pvLines[0]?.moves[0], engine.pvLines[1]?.moves[0]].filter(
        (uci): uci is string => uci !== undefined,
      );
      const missing = candidateUcis.filter(
        (uci) => bestSanFromPv(position, uci) !== null && !organicUcis.has(uci),
      );
      if (missing.length > 0) next = Array.from(new Set(missing)).sort();
    }

    // (4) Commit.
    if (next === NO_EXTRA_ROOT_MOVES) {
      setExtraRootMoves((prev) => (prev === NO_EXTRA_ROOT_MOVES ? prev : NO_EXTRA_ROOT_MOVES));
    } else {
      injectedForPositionRef.current = position;
      setExtraRootMoves(next);
    }
    // Accepted cost (documented, not a bug to fix): on navigating AWAY from a
    // position that had an injection, extraRootMoves resets to the sentinel,
    // and because useFlawChessEngine debounces its FEN the reset can reach
    // the hook up to one debounce window (RAPID_STEP_DEBOUNCE_MS) before the
    // new FEN does — producing one extra abort+restart of a search that is
    // about to be superseded anyway. Deliberately not engineered away.
  }, [
    engineEnabled,
    flawChessEnabled,
    freeRunCommitted,
    engine.pvLines,
    engine.currentFen,
    flawChessEngine.rankedLines,
    flawChessEngine.currentFen,
    position,
  ]);

  // Phase 158 (SEED-087 SC2, RESEARCH Pitfall 5): the shared grading run is
  // gated on EITHER display consumer being active — fen/enabled are always
  // paired on this same condition below so the worker is never alive-but-
  // positionless.
  const gradingEnabled = maiaEnabled || flawChessEnabled;

  // Phase 151.1 SC3 / Phase 158 (SEED-087 SC2): a SECOND, independent
  // Stockfish worker that grades the FC∪Maia candidate union via one
  // searchmoves-restricted MultiPV search. This shared run now powers BOTH
  // the Moves-by-Rating chart (via qualityBySan) and the FC card's reconciled
  // evals (via evalLookup below), so it is gated on `maiaEnabled ||
  // flawChessEnabled` (gradingEnabled) — replacing the prior Maia-switch-only
  // gating. It never touches the `engine` (useStockfishEngine) instance or
  // its consumers.
  // `&& !fastForwardRunning` (DEV-2): the grading run is a FOURTH live engine and
  // carries the identical 150ms fire-immediately branch, so it resonates with the
  // replay cadence exactly like the three named in the FAST-FORWARD SUPPRESSION
  // block at the `useStockfishEngine` call above. Leaving it out would leave the
  // uneven-move-sound cause partly unfixed. `enabled` stays paired with
  // `gradingEnabled` alone, so the worker is never alive-but-positionless in any
  // state that outlives a run.
  const grading = useStockfishGradingEngine({
    fen: gradingEnabled && !fastForwardRunning ? position : null,
    candidateSans: unionSans,
    enabled: gradingEnabled,
  });

  // Engine-line reconciliation cluster (Phase 215 Plan 04 —
  // useAnalysisEngineLines.ts): from the shared grading run's result to the
  // single reconciled argmax + move-quality map every display consumer on
  // the page reads instead of re-deriving its own.
  const {
    reconciledBestUci,
    reconciledBestSan,
    reconciledStockfishLine,
    reconciledBestEval,
    reconciledRankedLines,
    flawChessRankedLinesForVerdict,
    reconciledPvLines,
    qualityBySanWithGem,
    engineTopLines,
  } = useAnalysisEngineLines({
    position,
    currentNodeId,
    nodes,
    mainLine,
    isOnMainLine,
    bestSan,
    freeRunCommitted,
    flawChessEnabled,
    engine,
    flawChessEngine,
    maia,
    grading,
    pinnedEloForMover,
    storedTierByPly,
    gameHasStoredBestMoveData,
  });

  // ── Derived values (game mode — new) ─────────────────────────────────────────

  // Eval-chart sync ply (Quick 260627-mt8): the board's current main-line ply, or the
  // fork point (nearest main-line ancestor) when off the main line. Drives the eval-
  // chart slider so navigating the move list / board keeps the chart in sync; on a
  // sideline it parks the slider at the position the sideline branches from, which is
  // also the natural starting point for scrubbing back onto the main line (D-05 reversal).
  const evalChartPly = useMemo<number | null>(() => {
    if (!isGameMode || currentNodeId === null) return null;
    if (isOnMainLine(currentNodeId)) {
      const idx = mainLine.indexOf(currentNodeId);
      return idx >= 0 ? idx : null;
    }
    let id: NodeId | null = nodes.get(currentNodeId)?.parentId ?? null;
    while (id !== null) {
      if (isOnMainLine(id)) {
        const idx = mainLine.indexOf(id);
        return idx >= 0 ? idx : null;
      }
      id = nodes.get(id)?.parentId ?? null;
    }
    return null;
  }, [isGameMode, currentNodeId, mainLine, nodes, isOnMainLine]);

  // Per-side remaining clock at the current position (Quick 260628-pcb). eval_series
  // carries the mover's remaining clock per ply (even ply = White, odd = Black,
  // 0-based on moves — same convention as game_positions.ply and mainLine indexing).
  // Walk up to the current ply, keeping the latest clock seen for each side.
  // clock_seconds is null for imports without %clk (e.g. some chess.com games), so
  // that side simply shows no clock.
  const playerClocks = useMemo<{ white: number | null; black: number | null }>(() => {
    const series = gameData?.eval_series;
    if (!isGameMode || series == null) return { white: null, black: null };
    const ply = evalChartPly ?? -1;
    let white: number | null = null;
    let black: number | null = null;
    for (const point of series) {
      if (point.ply > ply) break; // eval_series is ply-ascending
      if (point.clock_seconds == null) continue;
      if (point.ply % 2 === 0) white = point.clock_seconds;
      else black = point.clock_seconds;
    }
    return { white, black };
  }, [isGameMode, gameData?.eval_series, evalChartPly]);

  // flawMarkerByNodeId now comes from useAnalysisGemMarkers below (Phase 215
  // Plan 05) — this comment marks where it used to live, for grep-ability.

  // Fast-forward stop set (Quick 260831-s4y, D-02): main-line plies whose
  // FlawMarker.severity is blunder/mistake, plus plies whose
  // EvalPoint.best_move_tier is gem/great. Deliberately BOTH-SIDES — no
  // is_user / user_color filter — matching the analysis board's existing
  // both-sides gem display (D-02). Derived from eval_series directly rather
  // than reusing the nearby storedTierByPly map: that map additionally
  // requires maia_prob != null, a TypeScript-narrowing artifact of its own
  // purpose that could silently drop a legitimate fast-forward stop here.
  const fastForwardStopPlies = useMemo<Set<number>>(() => {
    const stops = new Set<number>();
    if (!isGameMode) return stops;
    for (const fm of gameData?.flaw_markers ?? []) {
      if (fm.severity === 'blunder' || fm.severity === 'mistake') stops.add(fm.ply);
    }
    for (const point of gameData?.eval_series ?? []) {
      if (isRareMoveTier(point.best_move_tier)) stops.add(point.ply);
    }
    return stops;
  }, [isGameMode, gameData?.flaw_markers, gameData?.eval_series]);

  // evalChartPly (not a raw currentPly) is deliberate: from a sideline it
  // resolves to the fork point, so a fast-forward started from a sideline
  // resumes along the main line and leaves the sideline in the tree one
  // click away — the same behavior the eval-chart scrub already has.
  const fastForward = useFastForward({
    enabled: isGameMode,
    mainLine,
    currentNodeId,
    currentPly: evalChartPly,
    stopPlies: fastForwardStopPlies,
    goToNode,
    onRunningChange: setFastForwardRunning,
  });

  // Multi-active chip highlight (Quick 260703-kyb): every currently OPEN or
  // pending-open chip's key, so multiple tactic chips can read "on" simultaneously
  // (flat siblings) instead of a single activePvNodeId/activePvOrientation match.
  const activePvKeys = useMemo<Set<string>>(() => {
    const keys = new Set<string>();
    for (const key of openLines.keys()) keys.add(key);
    if (pendingFlaw != null) keys.add(flawKey(pendingFlaw));
    return keys;
  }, [openLines, pendingFlaw]);

  // Contextual overlay PV ply (0 = fork position, 1+ = steps into the focused PV).
  const contextualCurrentPly =
    currentNodeId !== null ? focusedPvLine.indexOf(currentNodeId) + 1 : 0;

  // onStoredLine for contextual overlay: true only when on the PV sideline itself.
  const contextualOnStoredLine = currentNodeId !== null && isOnPvLine(currentNodeId);

  // Game-mode overlay (Quick 260627): precomputed blue best-move arrow + tactic depth
  // overlay + eval bar, with the live engine supplying only the grey 2nd-best line.
  // Phase 162 (SEED-090 D-08): the eval-bar passthrough params (engineEvalCp/
  // Mate/Depth) are now `reconciledBestEval`'s fields, not the raw free-run
  // eval — closes RESEARCH Pitfall 1's second evalLookup bypass. Off the main
  // line, useGameOverlay's own enginePassthrough branch surfaces these
  // unchanged (the hook's internals are untouched — only the caller's source
  // changed); on the main line the precomputed game eval still wins as before.
  const gameOverlay = useGameOverlay({
    enabled: isGameMode,
    engineEnabled,
    evalSeries: gameData?.eval_series,
    flawMarkers: gameData?.flaw_markers,
    mainLine,
    currentNodeId,
    isOnMainLine,
    lastMove,
    enginePvLines: engine.pvLines,
    engineEvalCp: reconciledBestEval.evalCp,
    engineEvalMate: reconciledBestEval.evalMate,
    engineDepth: reconciledBestEval.depth,
  });

  // ── Live free-move classification (item 4) ────────────────────────────────────
  // Cache each position's COMPLETED engine eval (white POV) keyed by FEN. The engine
  // only sets evalCp/evalMate once a search finishes (null while analyzing), so a
  // non-null value here is a depth-complete eval for the current position. Held in
  // state (not a ref) so reading it during render is legitimate; updates are
  // low-frequency (one per completed ~1.5s search) and no-op when unchanged.
  const [engineEvalByFen, setEngineEvalByFen] = useState<
    Map<string, { cp: number | null; mate: number | null }>
  >(() => new Map());
  useEffect(() => {
    if (!engineEnabled) return;
    if (engine.evalCp == null && engine.evalMate == null) return;
    setEngineEvalByFen((prev) => {
      const existing = prev.get(position);
      if (existing && existing.cp === engine.evalCp && existing.mate === engine.evalMate) {
        return prev; // unchanged — skip the re-render
      }
      const next = new Map(prev);
      next.set(position, { cp: engine.evalCp, mate: engine.evalMate });
      // Rough FIFO cap (Map preserves insertion order) so a long session can't grow it
      // without bound.
      if (next.size > LIVE_EVAL_CACHE_MAX) {
        const oldest = next.keys().next().value;
        if (oldest !== undefined) next.delete(oldest);
      }
      return next;
    });
  }, [position, engine.evalCp, engine.evalMate, engineEnabled]);

  // Phase 163 (SEED-092, RESEARCH Pitfall 1): a per-FEN retention cache for the
  // Maia curve, mirroring engineEvalByFen exactly — useMaiaEngine only exposes
  // CURRENT-position data, but gem detection (C1: hard-to-find) needs the PARENT
  // position's Maia curve once the user has navigated to the child. Retained
  // while each position is current; read back below (parentFen-keyed) once it's
  // the parent. Maia is fast and reliably wins the navigation race, so caching it
  // is safe; the Stockfish grade (C2) is instead fetched on demand per node (see
  // the gem block below) rather than cached per FEN, which is what used to race.
  const [maiaCurveByFen, setMaiaCurveByFen] = useState<Map<string, MoveCurvePoint[]>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!maiaEnabled || maia.perElo.length === 0) return;
    // Bug fix (163-REVIEW WR-03): useMaiaEngine clears its result one commit
    // AFTER `position` changes, so on the navigation commit `maia.perElo`
    // still holds the PARENT's curve — writing it under the child's FEN would
    // poison the cache (a rapid two-step navigation then classifies the
    // grandchild's arrival move against the wrong position's policy map).
    // Only cache when the hook says the curve belongs to the shown position.
    if (maia.resultFen !== position) return;
    setMaiaCurveByFen((prev) => {
      const existing = prev.get(position);
      if (existing === maia.perElo) return prev; // unchanged (stable ref) — skip re-render
      const next = new Map(prev);
      next.set(position, maia.perElo);
      if (next.size > LIVE_EVAL_CACHE_MAX) {
        const oldest = next.keys().next().value;
        if (oldest !== undefined) next.delete(oldest);
      }
      return next;
    });
  }, [position, maia.perElo, maia.resultFen, maiaEnabled]);

  // FEN of the position BEFORE the current move — the live classifier's "best before".
  const parentFen = useMemo<string | null>(() => {
    if (currentNodeId === null) return null;
    const node = nodes.get(currentNodeId);
    if (!node) return null;
    if (node.parentId === null) return rootFen;
    return nodes.get(node.parentId)?.fen ?? rootFen;
  }, [currentNodeId, nodes, rootFen]);

  // Phase 172 (SEED-106 D-04/D-08): mainline ply index of the CURRENT node, or
  // -1 for free-variation nodes / no selection. Shared by the sweep's "already
  // resolved this ply?" check, needParentGemGrade's double-work guard below, and
  // both marker memos' book/sweep-gem gates — one computation, several readers.
  const currentMainlinePly = useMemo(
    () => (currentNodeId !== null && isOnMainLine(currentNodeId) ? mainLine.indexOf(currentNodeId) : -1),
    [currentNodeId, isOnMainLine, mainLine],
  );

  // Live classification applies only to freely-played moves off the precomputed line:
  // any node that is NOT a game main-line node (game mode) and NOT a grafted PV node
  // (those are best-play lines). In free-play mode every played node qualifies.
  const liveFlawActive =
    currentNodeId !== null &&
    !(isGameMode && isOnMainLine(currentNodeId)) &&
    !isOnPvLine(currentNodeId);

  const parentEval = parentFen != null ? engineEvalByFen.get(parentFen) ?? null : null;

  // Deterministic eval for a terminal (checkmate/draw) displayed position — the live
  // engine reports an ambiguous `mate 0` there, which read as the 0.5 midpoint and
  // graded a mating move as a blunder (Quick 260709-j3k). Drives both the live
  // classification below and the right eval bar.
  const terminalEval = useMemo(() => terminalPositionEval(position), [position]);

  // Game-over state of the shown position, for the FlawChess card's terminal row
  // (quick 260709). terminalPositionEval reports checkmate as a mate score and a
  // draw as cp 0; a terminal root has no legal moves so the engine ranks nothing.
  const flawChessTerminalOutcome: 'checkmate' | 'draw' | null =
    terminalEval == null ? null : terminalEval.mate != null ? 'checkmate' : 'draw';

  const liveFlaw = useLiveMoveFlaw({
    active: liveFlawActive,
    parentFen,
    parentEval,
    // On a checkmate the child position is decisive for the mover, so the mating move
    // reads clean (green) instead of a blunder; a genuine stalemate-when-winning still
    // flags because its cp-0 child correctly drops the mover's expected score.
    childEvalCp: terminalEval ? terminalEval.cp : engine.evalCp,
    childEvalMate: terminalEval ? terminalEval.mate : engine.evalMate,
    lastMove,
  });

  // Persist each freely-played node's live blunder/mistake classification, keyed by node id
  // (Quick 260628-r5v UAT). Two purposes: (1) the move-list glyph stays on EVERY sideline move
  // the user has stepped through, not just the current one; (2) it caches the per-node
  // classification so returning to an earlier sideline move re-shows its icon without waiting
  // on the live engine to re-grade it. (The eval VALUE is already cached by FEN in
  // engineEvalByFen above; this caches the derived classification per node.)
  const [liveFlawByNode, setLiveFlawByNode] = useState<Map<NodeId, FlawSeverity>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!liveFlawActive || currentNodeId === null) return;
    const severity = liveFlaw.squareMarkers[0]?.severity;
    // Only blunder/mistake paint a glyph; skip while still pending (squareMarkers is empty
    // until both parent and child evals complete) or when the move grades clean/inaccuracy.
    if (severity !== 'blunder' && severity !== 'mistake') return;
    setLiveFlawByNode((prev) => {
      if (prev.get(currentNodeId) === severity) return prev; // unchanged — skip re-render
      const next = new Map(prev);
      next.set(currentNodeId, severity);
      // FIFO cap (Map preserves insertion order) mirrors the eval-cache bound.
      if (next.size > LIVE_EVAL_CACHE_MAX) {
        const oldest = next.keys().next().value;
        if (oldest !== undefined) next.delete(oldest);
      }
      return next;
    });
  }, [liveFlawActive, currentNodeId, liveFlaw]);

  // Phase 163 (SEED-092 D-03/D-04/D-05/D-06): gem-move detection. Broader gate than
  // liveFlawActive — D-05 requires coverage on EVERY visited node, mainline AND free
  // variations, both colors — so this deliberately has NO isGameMode/isOnMainLine/
  // isOnPvLine exclusion.
  const gemActive = currentNodeId !== null && parentFen !== null;

  // The numbers behind a detected gem, surfaced in the move-list gem popover — the
  // ELO rung it was found at, the Maia probability of the move at that rung, and
  // whether the OPPONENT (not the user) played it (game mode only; switches the
  // popover heading).
  type GemDetail = { maiaProbability: number; elo: number; byOpponent: boolean };

  // ResolvedMarker (the resolveMarkerFor return shape) moved to
  // useAnalysisGemMarkers.ts (Phase 215 Plan 05), which privately duplicates
  // this same type — see that file's header.

  // Sticky per-node gem RESOLUTION. `has(nodeId)` means the node's arrival move has
  // been graded and resolved — the gate that stops us re-grading it. A non-null
  // value is a confirmed gem (shows the badge, carries its popover detail); an
  // explicit `null` is a graded-and-rejected node. Populated ONLY by the on-demand
  // parent-grade effect below — NOT a per-FEN grade cache.
  //
  // This replaces the old gradeSummaryByFen race: the C2 grade was cached per FEN
  // only when the parent's grading pass COMPLETED while the parent was the current
  // position. Play the move before that finished and the parent — no longer current
  // — was never graded again, so the gem never showed (the reported bug). Now the
  // grade is fetched on demand for the node, so it appears regardless of timing.
  const [gemByNode, setGemByNode] = useState<Map<NodeId, GemDetail | null>>(() => new Map());

  // C1 (hard to find): the arrival move into the current node and its Maia
  // probability at the PARENT rung, read from the reliably-cached parent Maia curve
  // (Maia is fast and wins the navigation race). Cheap, so it gates whether we
  // bother spinning up a Stockfish pass on the parent at all — gems are rare by
  // construction, so this passes infrequently. Phase 172 (SEED-106 D-01): the rung
  // is PINNED to the mover's own rating-at-game-time, not the reactive ELO
  // slider — a gem is a property of the game, not of the view, and pinning is
  // what makes a background sweep cacheable at all (otherwise every slider
  // nudge would invalidate the whole sweep).
  const gemC1 = useMemo<{ playedSan: string; maiaProbability: number } | null>(() => {
    if (!gemActive || currentNodeId === null || parentFen === null) return null;
    const playedSan = nodes.get(currentNodeId)?.san ?? null;
    if (playedSan === null) return null;
    const parentCurve = maiaCurveByFen.get(parentFen);
    if (parentCurve === undefined) return null; // parent Maia not cached yet — wait
    const pinnedElo = pinnedEloForMover(sideToMoveFromFen(parentFen));
    const maiaProbability = nearestByElo(parentCurve, pinnedElo)?.moveProbabilities[playedSan] ?? null;
    if (maiaProbability === null || maiaProbability > GEM_MAIA_MAX_PROB) return null;
    return { playedSan, maiaProbability };
  }, [gemActive, currentNodeId, parentFen, nodes, maiaCurveByFen, pinnedEloForMover]);

  // Phase 172 (SEED-106 D-04/D-05): the sweep's resolved ply indices (synced
  // from `sweep.gemByPly` by an effect declared AFTER `sweep`, below), read by
  // needParentGemGrade to avoid re-grading a ply the sweep already answered.
  // React state — not sweep.gemByPly directly — breaks what would otherwise be
  // a circular dependency: needParentGemGrade also feeds the sweep's OWN
  // liveBusy input, so it cannot depend on the CURRENT render's sweep output;
  // reading a value the sync effect populated on a PRIOR commit is fine. State
  // (not a ref) because this project's lint config (react-hooks/refs) forbids
  // reading ref.current during render, and needParentGemGrade is read during
  // render — the sync effect's setState also means "the sweep just resolved
  // this ply" now genuinely re-renders, rather than silently going stale.
  const [sweepResolvedPlies, setSweepResolvedPlies] = useState<ReadonlySet<number>>(
    () => new Set(),
  );

  // Phase 175 (SEED-108 D-01/BOARD-02, Pitfall 2/3): once the current node is
  // a MAINLINE ply of an ANALYZED game, the stored backend tier already owns
  // the verdict for it (present or authoritatively null) — the live-at-cursor
  // C2 confirmation (below) must never re-derive it. Off-mainline nodes
  // (currentMainlinePly === -1) have no stored row by construction and are
  // untouched by this gate.
  const currentNodeCoveredByStoredData = gameHasStoredBestMoveData && currentMainlinePly >= 0;

  // Grade the PARENT to confirm C2 (only good move) only when the arrival move is a
  // rare gem candidate (C1 passed) AND this node is not already resolved — by
  // the live path's own sticky cache, by (Phase 172 D-04/D-05) the sweep, or
  // (Phase 175 D-01) the stored backend tier.
  const needParentGemGrade =
    gemC1 !== null &&
    currentNodeId !== null &&
    !gemByNode.has(currentNodeId) &&
    !currentNodeCoveredByStoredData &&
    !(currentMainlinePly >= 0 && sweepResolvedPlies.has(currentMainlinePly));

  // Phase 172 (SEED-106 D-04): parent FEN of mainLine[i] — the position BEFORE
  // moves[i] was played. i===0 is the game's root position; MoveNode.fen is the
  // FEN AFTER the move (useAnalysisBoard.ts), so the parent is the PRECEDING
  // mainline node's fen. noUncheckedIndexedAccess-safe — an out-of-range i
  // degrades to null, never throws.
  const fenAtPly = useCallback(
    (i: number): string | null => {
      if (i === 0) return rootFen;
      const prevNodeId = mainLine[i - 1];
      if (prevNodeId === undefined) return null;
      return nodes.get(prevNodeId)?.fen ?? null;
    },
    [mainLine, nodes, rootFen],
  );

  // D-04 free prefilter: the whole mainline's sweep-eligible candidates — pure
  // data, zero engine work, computed once per (game, eval data) change. Empty
  // whenever the eval data isn't ready (unanalyzed game — D-03 lazy path).
  const sweepCandidates = useMemo<SweepCandidate[]>(() => {
    if (!evalChartReady || gameData?.moves == null || gameData.eval_series == null) return [];
    return selectSweepCandidates(gameData.moves, gameData.eval_series, gameData.opening_ply_count, fenAtPly);
  }, [evalChartReady, gameData, fenAtPly]);

  // D-01: each sweep candidate is classified at ITS OWN mover's pinned rung —
  // the SAME helper (pinnedEloForMover) the live gem path uses, so the sweep
  // and the live path can never classify the same ply at different rungs.
  const pinnedEloForPly = useCallback(
    (plyIndex: number): number => {
      const fen = fenAtPly(plyIndex);
      return fen === null ? FREE_PLAY_DEFAULT_ELO : pinnedEloForMover(sideToMoveFromFen(fen));
    },
    [fenAtPly, pinnedEloForMover],
  );

  // The user's color, narrowed from the wire's plain `string` to MoverColor —
  // null in free play (no game) or for a malformed value (never trusted as-is).
  const sweepUserColor: MoverColor | null =
    isGameMode && (gameData?.user_color === 'white' || gameData?.user_color === 'black')
      ? gameData.user_color
      : null;

  // Phase 172 (SEED-106 CR-02): the REAL "live engines are busy" signal the
  // sweep must yield to (D-05). The prior wiring passed only `needParentGemGrade`
  // — true only while the rare live gem-C2 confirmation is pending — so the D-05
  // yield-to-cursor guard was inert: the sweep fired a fresh Maia inference + a
  // Stockfish `go` on essentially every navigation, straight into whatever the
  // free-run / grading / Maia / FlawChess-pool engines were already doing. Every
  // term below is declared ABOVE this call and none depend on the sweep (no
  // circularity — see the sweepResolvedPlies note above). The live per-node
  // gem-grade (`gemGrading`) is declared AFTER this call, but `needParentGemGrade`
  // gates its very existence (`enabled: … && needParentGemGrade`), so including
  // needParentGemGrade here already covers the whole live-gem-grade window.
  const liveEnginesBusy =
    engine.isAnalyzing ||
    maia.isAnalyzing ||
    grading.isGrading ||
    flawChessEngine.isSearching ||
    needParentGemGrade;

  // Phase 172 (SEED-106 D-04/D-05): the background gem sweep — its OWN
  // dedicated Maia + Stockfish worker instances (useGemSweep.ts, plan 04),
  // never the live `maia`/`grading`/`gemGrading` instances above. `enabled`
  // requires the readiness transition to have armed for THIS game (D-03) AND
  // the same grading-card gate the live path uses (no point sweeping when
  // neither Maia nor FlawChess panel wants gem data). `liveBusy` yields to ANY
  // busy live engine (CR-02), honoring the documented contract on both
  // UseGemSweepOptions and SweepDispatchInput — the live path is the one thing
  // the sweep must never race for CPU.
  //
  // Phase 175 (SEED-108 D-01/BOARD-02, D-01a): demoted to a fallback-only
  // gate — `!gameHasStoredBestMoveData` — so the sweep never re-sweeps a
  // mainline the stored backend data already owns. Because the sweep's own
  // candidates (`sweepCandidates` above) require `evalChartReady` to be
  // non-empty, and `gameHasStoredBestMoveData` mirrors that same readiness
  // signal, this makes the sweep structurally inert for any analyzed game's
  // mainline going forward — its dedicated-worker machinery is retained
  // (D-01: demoted, not deleted) as the documented free-play/no-stored-data
  // fallback (see useGemSweep.ts's file header).
  //
  // Quick 260901-oxh: `&& !fastForwardRunning` closes a trap the engine
  // suppression above would otherwise spring. Nulling the four live engines'
  // `fen` drives `liveEnginesBusy` to FALSE, and that is precisely the signal
  // this sweep treats as permission to run — so the suppression alone would
  // unleash the background sweep during the replay, exactly when the main
  // thread must stay quiet. The sweep is structurally inert for an ANALYZED
  // game (Phase 175 demoted it to a fallback-only path via
  // `!gameHasStoredBestMoveData`), but an UNANALYZED game has an empty
  // fast-forward stop set, so a run there travels all the way to the terminal
  // ply with the sweep live — that is the case this guard exists for.
  //
  // The lever is `liveBusy`, NOT `enabled` — and that distinction is the same
  // DEV-1 reasoning applied to this hook. `enabled` here is a WORKER-LIFECYCLE
  // gate, not merely a dispatch gate: it flows `enabled -> effectiveEnabled ->
  // engineEnabled`, which is the `enabled` argument of this hook's own
  // dedicated `useMaiaEngine` (useGemSweep.ts:269) and
  // `useStockfishGradingEngine` (:290). Gating it on `!fastForwardRunning`
  // would therefore tear down a Maia ONNX worker and a Stockfish WASM worker at
  // run start and respawn them on landing — a model reload arriving exactly
  // when the user has just landed on the position they wanted to look at, on
  // every single press. That is the very cost DEV-1 avoids for the four live
  // engines above, and there is no reason to pay it here.
  //
  // `liveBusy` blocks dispatch at useGemSweep.ts:428 (`!liveBusyRef.current &&
  // effectiveEnabledRef.current`) while leaving both workers warm, and "the
  // live path is busy" is semantically exactly what a fast-forward run IS —
  // this is the hook's designed yield, the same one it already performs on
  // every ordinary navigation while the live engines analyze. The one thing
  // `enabled` would additionally do is halt a candidate ALREADY in flight;
  // that is bounded to a single Maia inference (plus at most one grading
  // search) and is precisely the overlap `liveBusy` is built to tolerate.
  const sweep = useGemSweep({
    enabled: sweepArmedForGame && evalChartReady && gradingEnabled && !gameHasStoredBestMoveData,
    sweepKey: gameId,
    candidates: sweepCandidates,
    pinnedEloForPly,
    liveBusy: liveEnginesBusy || fastForwardRunning,
    userColor: sweepUserColor,
  });

  // Syncs sweepResolvedPlies (above) from the sweep's own state — runs AFTER
  // `sweep` so this can never be the thing `needParentGemGrade` depends on in
  // the SAME render (breaking the circularity noted above).
  useEffect(() => {
    setSweepResolvedPlies(new Set(sweep.gemByPly.keys()));
  }, [sweep.gemByPly]);

  // resolveMarkerFor now comes from useAnalysisGemMarkers below (Phase 215
  // Plan 05) — this comment marks where it used to live, for grep-ability.

  // The parent's candidate SANs to grade — the same Maia-mass selection the chart
  // uses, plus the played move (always included). No free-run contribution (the
  // free engine is on the child), so C2 is judged over Maia's candidate set.
  const parentGemCandidateSans = useMemo<string[]>(() => {
    if (!needParentGemGrade || parentFen === null || gemC1 === null) return [];
    const parentCurve = maiaCurveByFen.get(parentFen);
    if (parentCurve === undefined) return [];
    const pinnedElo = pinnedEloForMover(sideToMoveFromFen(parentFen));
    return selectCandidatesByMass(parentCurve, pinnedElo, gemC1.playedSan, null);
  }, [needParentGemGrade, parentFen, maiaCurveByFen, pinnedEloForMover, gemC1]);

  // On-demand SECOND grading worker, pinned to the parent FEN only while a gem
  // candidate needs confirming (absent/idle otherwise — `enabled` gates worker
  // creation). Fully isolated from the shared `grading` worker so the current
  // position's chart / FC card / Stockfish reconciliation are never disturbed
  // while we grade the parent.
  const gemGrading = useStockfishGradingEngine({
    fen: needParentGemGrade ? parentFen : null,
    candidateSans: parentGemCandidateSans,
    enabled: gradingEnabled && needParentGemGrade,
  });

  // Phase 215 Plan 05: the gem/marker resolution cluster (flawMarkerByNodeId,
  // resolveMarkerFor, moveListMarkers, and the on-demand parent-grade
  // resolution effect above) extracted to useAnalysisGemMarkers — see its
  // file header for scope, ownership, and the documented deviation from the
  // plan's literal field list (several inputs must stay local because they
  // feed the sweep/gemGrading calls above, which cannot move).
  const { resolveMarkerFor, moveListMarkers } = useAnalysisGemMarkers({
    currentNodeId,
    mainLine,
    nodes,
    isGameMode,
    gameData,
    liveFlaw,
    liveFlawByNode,
    gemByNode,
    setGemByNode,
    sweepGemByPly: sweep.gemByPly,
    storedTierByPly,
    gameHasStoredBestMoveData,
    fenAtPly,
    pinnedEloForMover,
    needParentGemGrade,
    parentFen,
    gemGrading,
    maiaCurveByFen,
  });

  // Phase 215 Plan 05: board-overlay derivation (arrows + square markers,
  // sideline move-list coloring, last-move tier tint) extracted to
  // useAnalysisBoardArrows — see its file header for scope and ownership
  // notes. resolveMarkerFor now comes from useAnalysisGemMarkers above;
  // storedBestGoodByPly is still local to Analysis.tsx (215-06 owns its
  // extraction next).
  const { sidelineNodeColors, boardArrows, boardSquareMarkers, lastMoveTierColor } =
    useAnalysisBoardArrows({
      position,
      currentNodeId,
      nodes,
      mainLine,
      isOnMainLine,
      lastMove,
      isGameMode,
      gameOpeningPlyCount: gameData?.opening_ply_count,
      currentMainlinePly,
      focusedFlaw,
      contextualTacticData,
      contextualOnStoredLine,
      contextualCurrentPly,
      focusedPvLine,
      hoveredQualityMoves,
      flawChessEnabled,
      flawChessRankedLines: flawChessEngine.rankedLines,
      engineEnabled,
      enginePvLines: engine.pvLines,
      reconciledBestUci,
      gameOverlaySquareMarkers: gameOverlay.squareMarkers,
      liveFlawSquareMarkers: liveFlaw.squareMarkers,
      resolveMarkerFor,
      storedBestGoodByPly,
    });

  // ── Handlers ──────────────────────────────────────────────────────────────────

  // L-5: game mode Reset → clear every sideline, reset multi-line state, navigate to entry ply.
  const handleReset = isGameMode
    ? () => {
        clearAllSidelines();
        setOpenLines(new Map());
        setPendingFlaw(null);
        setLiveFlawByNode(new Map()); // drop persisted sideline glyphs on reset
        setGemByNode(new Map()); // Phase 163: re-derives instantly from the FEN caches on revisit
        // T-140-02b: L-8 guard on initialPly — out-of-bounds is a no-op.
        const nodeId = mainLine[initialPly ?? 0];
        if (nodeId !== undefined) goToNode(nodeId);
      }
    : () => {
        setLiveFlawByNode(new Map());
        setGemByNode(new Map());
        if (mainLine.length > 0) {
          // Opening-line free play (?line=): keep the seeded opening as the main
          // line, drop any exploration sidelines, and return to the end of the
          // line (the entry point) — mirrors game mode's clear-and-return reset.
          clearAllSidelines();
          const endId = mainLine[mainLine.length - 1];
          if (endId !== undefined) goToNode(endId);
        } else {
          // Bare free play (no line): wipe back to the empty start position.
          // Phase 208: also drops the ephemeral pasted headers, if any — this
          // is the one Reset path that actually clears the loaded game (the
          // mainLine.length > 0 branch above just returns to its end).
          loadMainLine([], rootFen);
          setPastedHeaders(null);
        }
      };

  const canReset = currentNodeId !== null;

  // Phase 208 (PASTE-01/PASTE-02/PASTE-03): apply a sniffed paste result to
  // the board. A bare FEN seeds a free-play root through the SAME board API
  // the ?fen= URL-seeding effect uses (loadMainLine([], fen)) — no
  // ?fen=/?line= write-back (D-03), no navigation, no network request. A PGN
  // loads its full mainline at the parsed root, records the ephemeral
  // headers + chosen side for the player-info render, and orients the board
  // to that side directly (independent of the one-shot autoOrientation
  // effect above, since a paste can happen more than once per session).
  const handlePasteLoad = (result: PasteParseResult, userColor: 'white' | 'black') => {
    if (result.kind === 'fen') {
      loadMainLine([], result.fen);
      setPastedHeaders(null);
    } else if (result.kind === 'pgn') {
      loadMainLine(result.sans, result.rootFen);
      setPastedHeaders({ headers: result.headers, userColor });
      setBoardFlipped(userColor === 'black');
    }
  };

  // Phase 208 (D-15): after "Analyze full game" persists the row, navigate to
  // the saved game's normal /analysis?game_id=N URL — a same-route
  // search-param change, so the page re-enters game mode on `game_id` and
  // renders the real gameData-backed PlayerBar/eval chart/flaw markers. This
  // does NOT violate D-03 (which bars ?fen=/?line= write-back specifically):
  // ?game_id= is a separate param on a separate code path. The ephemeral
  // pastedHeaders state is cleared since the board is about to be replaced by
  // the real saved-game render.
  //
  // No seeding-guard reset is needed here (CR-01): the guards are keyed on
  // `game:<gameId>`, so changing the param is itself the signal to reseed. A
  // manual reset would be wrong — it could let the seeding effects fire against
  // the OUTGOING game's still-resident state before the new game's data lands.
  const handlePasteSaved = (savedGameId: number) => {
    setPastedHeaders(null);
    navigate(buildGameAnalysisUrl(savedGameId));
  };

  // Quick 260826-qdl: consume a handoff written by the Import tab's paste
  // entry point (a second PasteModal mount, distinct from this page's own
  // `pasteModalNode`). Mount-once, empty deps: the `pasteHandoffConsumed` ref
  // guard exists because React StrictMode double-invokes effects and the take
  // is destructive — without it the second invocation would find the key
  // already cleared. `seededKey.current = 'paste'` claims the shared arbiter
  // the `?line=`/`?fen=` seeding effects above read, so a stray `?line=`/
  // `?fen=` on the /analysis destination URL cannot seed over the pasted
  // game. Reusing `handlePasteLoad` verbatim (rather than re-deriving its
  // logic here) is what makes the Import-tab path behave identically to the
  // on-board paste path.
  useEffect(() => {
    if (pasteHandoffConsumedRef.current) return;
    pasteHandoffConsumedRef.current = true;
    const handoff = takePastedGameHandoff();
    // A `?game_id=` URL always wins over a pending handoff (game mode), and
    // the destructive take above has already discarded the stale payload
    // either way — no cleanup branch is needed here.
    if (handoff === null || isGameMode) return;
    seededKeyRef.current = 'paste';
    handlePasteLoad(handoff.result, handoff.userColor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Inline chip click: toggle off (SAME chip only — deleteSubtree removes just that
  // line, others stay open) or open a new line WITHOUT touching any other open line
  // (Quick 260703-kyb — flat siblings, removes the old singleton "clear previous PV
  // on chip switch" behavior).
  const handlePvChipClick = (
    nodeId: NodeId,
    flaw: { ply: number; orientation: 'missed' | 'allowed' },
  ): void => {
    const key = flawKey(flaw);
    const existing = openLines.get(key);
    if (existing != null) {
      // Same chip clicked again: collapse ONLY this line — no fetch needed.
      deleteSubtree(existing.rootNodeId);
      setOpenLines((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    // Different/new chip: open it. insertPvLine is called by the graft effect once
    // contextualTacticData arrives; other open lines are left untouched.
    setPendingFlaw(flaw);
    // Navigate to the fork node — decision board (ply-1) for missed, flaw position (ply) for
    // allowed (Quick 260628-pu2 UAT). T-140-02b guard.
    const forkNodeId = mainLine[forkPlyForOrientation(flaw.ply, flaw.orientation)];
    if (forkNodeId !== undefined) goToNode(forkNodeId);
    void nodeId; // nodeId passed for API symmetry with VariationTree; ply identifies the flaw
  };

  // EvalChart scrub callback: navigate the board to the scrubbed main-line ply.
  // Scrubbing works from a sideline too (D-05 reversal): goToNode only moves the
  // current-node pointer, so the sideline stays in the tree and is one move-list click
  // away. The old off-line guard also silently swallowed mobile chart taps, since the
  // touch-scrub overlay was never gated by the slider's disabled state.
  const handleEvalChartPlyChange = (ply: number | null): void => {
    if (ply === null) return;
    // T-140-02b: L-8 guard — ply from eval chart may not align exactly with mainLine.
    const nodeId = mainLine[ply];
    // Quick 260805-p37: this fires once per ply while the user drags the eval
    // chart / touch overlay — an unsilenced call would machine-gun one sound
    // per ply during a scrub.
    if (nodeId !== undefined) goToNode(nodeId, { silent: true });
  };

  // Cycling a flaw tag/severity/motif chip surfaces the eval-chart tooltip on the
  // targeted ply, mirroring the Library game card's click-to-cycle. commandedPly is
  // the target ply; commandSeq is a nonce so re-clicking the same ply re-fires the
  // reveal (and re-shows the tooltip after the chart's outside-click dismissal).
  const [tagCommandedPly, setTagCommandedPly] = useState<number | null>(null);
  const [tagCommandSeq, setTagCommandSeq] = useState(0);
  // Bumped on every tags-panel click so the move list top-aligns the navigated move
  // (instead of the default minimal-scroll that lands a downward jump at the bottom).
  const [moveListTopAlignSeq, setMoveListTopAlignSeq] = useState(0);

  // ── Render ────────────────────────────────────────────────────────────────────

  // Maia expected score is the side-to-MOVE's expected score (WDL is emitted from the
  // mover's POV). Convert to a WHITE-relative fraction for the eval bar so it agrees
  // with the Stockfish (white-POV) bar and the board orientation.
  //
  // Quick 260901-oxh: this now returns NULL rather than the neutral fraction when
  // Maia has no result. "No live data" and "dead equal" are different facts, and
  // the left-bar chain below has to tell them apart to hold a value through a run.
  const maiaWhiteFraction: number | null =
    maia.expectedScoreAtSelectedElo === null
      ? null
      : sideToMoveFromFen(position) === 'white'
        ? maia.expectedScoreAtSelectedElo
        : 1 - maia.expectedScoreAtSelectedElo;

  // Eval-bar wiring. Left slot shows FC (brown) over Maia (violet) whenever the
  // FlawChess Engine is enabled — its practical-for-you expected score. Right slot
  // is always the standalone Stockfish objective eval (155 UAT un-merge: no handoff
  // — Stockfish runs independently again, so the SF bar shows Stockfish's own eval
  // with depth deepening live). Kept as a small derived block (not inlined in the
  // JSX below) per Pitfall 5.
  // noUncheckedIndexedAccess: topLine is RankedLine | undefined, narrowed via
  // the `topLine ? ... : ...` ternaries below rather than a non-null assertion.
  const topLine = flawChessEngine.rankedLines[0];
  const fcWhiteFraction: number | null = topLine
    ? sideToMoveFromFen(position) === 'white'
      ? topLine.practicalScore
      : 1 - topLine.practicalScore
    : null;
  // A terminal position pins the left bar to the deterministic result too: neither the
  // FlawChess nor the Maia engine emits a ranked line for a checkmate (no legal move),
  // so their fraction fell back to the midpoint while the Stockfish bar already read
  // decisive (Quick 260709-j3k follow-up). mate > 0 = White wins (full white), < 0 =
  // Black wins (full black), draw = midpoint.
  const terminalWhiteFraction =
    terminalEval == null
      ? null
      : terminalEval.mate != null
        ? terminalEval.mate > 0
          ? 1
          : 0
        : EVAL_BAR_NEUTRAL_FRACTION;

  // The left bar's live source, or null when neither engine has produced one.
  const liveLeftWhiteFraction: number | null = flawChessEnabled
    ? fcWhiteFraction
    : maiaWhiteFraction;

  // ── Left eval bar freeze during a fast-forward run (quick 260901-oxh) ──────
  //
  // Task 3 suppresses the FlawChess and Maia searches for the duration of a run,
  // so both source fractions go null — and the old `?? 0.5` fallback would drop
  // the bar to the midpoint on every press. The midpoint does not read as "no
  // data", it reads as "equal position", i.e. actively wrong information inside
  // the very feature being fixed for looking glitchy. So the bar HOLDS instead.
  //
  // The held value is the last LIVE fraction, updated continuously, NOT a
  // snapshot taken on the rising edge of a run. Three reasons:
  //   1. A rising-edge snapshot would depend on render/effect ordering between
  //      the capture and the engine hooks clearing their own state — those hooks
  //      are declared ~2,000 lines above this block and would clear first in a
  //      later commit. A continuous hold has no such ordering coupling.
  //   2. If a run starts while the engine had not yet resolved the current
  //      position, a snapshot would freeze the placeholder — the exact value
  //      being avoided. A continuous hold keeps the last genuinely-known value.
  //   3. Nothing has to "release" the hold on landing: it is only ever READ
  //      while `fastForwardRunning` is true, so landing releases it by
  //      construction.
  //
  // The whole mechanism is kept here rather than up beside `fastForwardRunning`
  // because all three of its inputs are local to this block; splitting it across
  // 2,000 lines would cost more than it buys.
  //
  // State, not a ref, even though the held value never needs to drive a render on
  // its own: it IS read during render (it feeds the bar), and the
  // `react-hooks/refs` lint rule rejects reading `ref.current` during render
  // outright. The extra render this costs is bounded — the setter runs only when
  // the live fraction actually changes (React bails out on an Object.is-equal
  // write), i.e. a handful of times per position, and never at all during a run,
  // when the engines feeding it are suppressed.
  const [heldLeftWhiteFraction, setHeldLeftWhiteFraction] = useState<number | null>(null);
  useEffect(() => {
    // Written in an effect, not during render, so a StrictMode/concurrent
    // double-render cannot make the hold path order-dependent.
    if (!fastForwardRunning && liveLeftWhiteFraction !== null) {
      setHeldLeftWhiteFraction(liveLeftWhiteFraction);
    }
  }, [fastForwardRunning, liveLeftWhiteFraction]);

  // Precedence chain — DO NOT REORDER. `terminalWhiteFraction` must keep winning
  // over the held value so landing a run on a checkmate or draw fills the bar to
  // the real result instead of showing a stale hold. It is safe at the head of
  // the chain because `terminalEval` is `terminalPositionEval(position)`, a pure
  // function of the FEN and therefore engine-independent — it stays live
  // throughout a run even while every engine is suppressed.
  const leftEvalBarWhiteFraction =
    terminalWhiteFraction ??
    (fastForwardRunning ? heldLeftWhiteFraction : null) ??
    liveLeftWhiteFraction ??
    EVAL_BAR_NEUTRAL_FRACTION;
  const leftEvalBarAccent = flawChessEnabled ? FLAWCHESS_ENGINE_ACCENT : MAIA_ACCENT;
  const leftEvalBarTestId = flawChessEnabled ? 'analysis-flawchess-eval-bar' : 'analysis-maia-eval-bar';
  // The right bar is labeled "SF" (Stockfish): the real standalone Stockfish eval
  // whenever its switch is on, going neutral when the user turns Stockfish off
  // (`!engineEnabled`). `null`/`0` reads as the sigmoid midpoint in EvalBar's
  // computeWhiteFraction (no data → 0.5).
  // A terminal position (checkmate/draw) overrides the engine passthrough with the
  // deterministic eval so the bar fills to the winner (or sits at the midpoint on a
  // draw) instead of snapping to `mate 0` at ~50% (Quick 260709-j3k). Synthetic depth
  // clears EvalBar's mate-display gate.
  const rightEvalBarEvalCp = engineEnabled
    ? terminalEval
      ? terminalEval.cp
      : gameOverlay.evalCp
    : null;
  const rightEvalBarEvalMate = engineEnabled
    ? terminalEval
      ? terminalEval.mate
      : gameOverlay.evalMate
    : null;
  const rightEvalBarDepth = engineEnabled
    ? terminalEval
      ? TERMINAL_EVAL_DEPTH
      : gameOverlay.evalDepth
    : 0;

  // Desktop board sizing (Phase 161 UAT): the board + eval bars are measured and sized
  // in JS rather than via flexbox, so the bars are exactly as tall as the board and hug
  // its edges, and the board shrinks (never clips) when width/height is tight. We measure
  // the STAGE (a full-width, flex-height box that is NOT sized by the board itself, so no
  // circular/zero-height bootstrap), subtract the eval-bar allowance, and clamp with the
  // same computeBoardSize helper ChessBoard uses. The height budget only binds inside the
  // locked band; outside it the page scrolls and the board is width-driven.
  // Phase 215 Plan 05: the board-stage sizing cluster (boardStageRef,
  // boardWidth, boardStageHeight, and the ResizeObserver-driven measurement
  // effect) extracted to useBoardStageSize — see its file header for scope
  // notes and why it's genuinely new (not a duplicate of
  // useFitBoardToViewport/useMiniBoardSize).
  const { boardStageRef, boardWidth, boardStageHeight } = useBoardStageSize({
    layoutMode,
    containerRef,
    isGameMode,
    gameData,
  });

  // Left eval bar — FlawChess Engine (brown) when enabled (D-04 precedence), else Maia
  // (violet, D-01/D-05, SURF-04). Single expected-score fill: both sources bypass the cp
  // sigmoid entirely via whiteFraction — see the precedence chain building
  // leftEvalBarWhiteFraction above (terminal, then the fast-forward hold, then live,
  // then EVAL_BAR_NEUTRAL_FRACTION). evalCp/evalMate/depth are hard-nulled here, so the
  // fraction is this bar's ONLY live input: freezing it during a run freezes the bar
  // completely, with no companion depth or eval readout left to go stale underneath it.
  // Bug fix (151.1 UAT): Maia's WDL is from the side-to-MOVE's perspective (the board is
  // mirrored to the mover's POV when Black is to move — see maiaEncoding.encodeBoard), so
  // expectedScore is the mover's expected score. The bar's whiteFraction must be
  // WHITE-relative to match the Stockfish bar and the board orientation, so invert it
  // whenever Black is to move (see fcWhiteFraction above).
  const leftEvalBarNode = (className?: string) => (
    <EvalBar
      evalCp={null}
      evalMate={null}
      depth={0}
      whiteFraction={leftEvalBarWhiteFraction}
      flipped={boardFlipped}
      accentColor={leftEvalBarAccent}
      testId={leftEvalBarTestId}
      className={className}
    />
  );

  // Right eval bar: precomputed eval in game mode (immediate), live engine otherwise —
  // useGameOverlay passes the engine through when disabled. D-04 handoff: while the
  // FlawChess Engine runs, this bar is fed its top line's own objective root eval (never a
  // mate — ±MATE_CP_EQUIVALENT reads as near-mate on the sigmoid) rather than a second live
  // Stockfish search on the same position (POOL-04).
  const rightEvalBarNode = (className?: string) => (
    <EvalBar
      evalCp={rightEvalBarEvalCp}
      evalMate={rightEvalBarEvalMate}
      depth={rightEvalBarDepth}
      flipped={boardFlipped}
      accentColor={STOCKFISH_ACCENT}
      className={className}
    />
  );

  // boardSquareMarkers/lastMoveTierColor now come from useAnalysisBoardArrows
  // above (Phase 215 Plan 05).

  // The single react-chessboard instance / `analysis-board` focus target. Shared by the
  // desktop stage and the mobile row (only one renders at a time via isMobile), so the
  // board mounts exactly once either way. `heightRef` is supplied on mobile (the row's own
  // wrapper drives height-aware sizing); the desktop stage sizes the wrapping box directly.
  const chessBoardNode = (heightRef?: RefObject<HTMLElement | null>) => (
    <ChessBoard
      id="analysis-board"
      position={position}
      onPieceDrop={makeMove}
      lastMove={lastMove}
      // Precomputed overlay (main line) wins; else the live free-move classification (item
      // 4), which also covers free-play mode. Default green (MOVE_HIGHLIGHT_GOOD): a played
      // move is assumed OK until the engine proves otherwise, so engine-line (PV) moves and
      // not-yet-graded moves read green instead of the shared yellow fallback. The engine
      // still overrides to red/orange on a blunder/mistake (and yellow on an inaccuracy).
      lastMoveColor={
        lastMoveTierColor ??
        gameOverlay.lastMoveHighlightColor ??
        liveFlaw.lastMoveHighlightColor ??
        MOVE_HIGHLIGHT_GOOD
      }
      flipped={boardFlipped}
      arrows={boardArrows}
      squareMarkers={boardSquareMarkers}
      maxWidth={BOARD_MAX_WIDTH}
      heightRef={heightRef}
      // Quick 260901-oxh: shorten the piece slide ONLY while a fast-forward run
      // is in flight. The `undefined` branch is load-bearing — normal
      // single-step navigation (back/forward, move-list click, eval-chart
      // scrub) must keep react-chessboard's 300ms default; only the replay
      // cadence needs a slide that finishes before the next commit.
      //
      // The LANDING move animates at FAST_FORWARD_ANIMATION_MS too, like every
      // ply before it. That is not automatic: useFastForward defers its
      // `running: false` report by FAST_FORWARD_SETTLE_MS precisely so this
      // prop (and the engine suppression below it) survives the arrival slide.
      // Before that deferral the arrival commit flipped this back to the
      // library's 300ms default AND released four engines in the same frame,
      // which is what made the last move of an otherwise smooth run hitch.
      animationDurationInMs={fastForwardRunning ? FAST_FORWARD_ANIMATION_MS : undefined}
    />
  );

  // Mobile board row — purely width-driven square that fills the takeover width. No
  // heightRef: the mobile page scrolls (no viewport height lock), so the board sizes to its
  // flex-1 container width alone. The bars (items-stretch) match the board's height and the
  // board fills its container, so the bars hug it. Desktop uses the JS-sized stage below.
  // `boardRow` is extracted to `<BoardRow>` (src/components/analysis/AnalysisBoardStage.tsx,
  // 215-06), constructed at its one call site below (the mobile layout).

  // Phase 208 (PASTE-02): true whenever player info should render at all —
  // either a real fetched game (game mode) OR an ephemeral pasted PGN. A
  // paste can happen WHILE already in game mode (D-20: the trigger stays
  // visible there), so pastedHeaders — the more recently loaded source — is
  // preferred over gameData whenever both are present.
  const showPlayerBars = (isGameMode && gameData != null) || pastedHeaders != null;

  // `playerBar`/`evalBarCap`/`evalBarSlot`/`boardHeaderRow`/`boardFooterRow` are
  // extracted to `<PlayerBar>`/`<EvalBarCap>`/`<EvalBarSlot>`/`<BoardHeaderRow>`/
  // `<BoardFooterRow>` (src/components/analysis/AnalysisPlayerBar.tsx, 215-06):
  // real components with typed props, inlined directly at each call site below
  // rather than kept as a passthrough wrapper (215-06 plan: "boardHeaderRow(
  // playerBar('white', 'top')) becomes <BoardHeaderRow player={<PlayerBar
  // color="white" rowPosition="top" … />} …/>").
  //
  // The two player rows are always ordered by board orientation (Quick
  // 260628-pcb): the top row is White unless flipped, the bottom row the
  // opposite. Resolved once here (not re-derived as a `boardFlipped ? … : …`
  // ternary at each of the 7 render call sites below) so the ternary
  // contributes to Analysis()'s own complexity exactly once each, not seven
  // times — a plain dedup of an identical expression, not a metric-gaming
  // rewrite.
  const topPlayerColor: 'white' | 'black' = boardFlipped ? 'white' : 'black';
  const bottomPlayerColor: 'white' | 'black' = boardFlipped ? 'black' : 'white';

  // `variationTree`/`boardControls`/`evalChart`/`tagsPanel` are extracted to
  // `<VariationTreePanel>`/`<BoardControls>`/`<EvalChartPanel>`/`<TagsPanel>`
  // (src/components/analysis/AnalysisTabs.tsx, 215-06) — real components with
  // typed props, called directly at each render call site below (desktopBoardStage,
  // the tab cluster, movesCard, the mobile footer) instead of kept as local helpers.
  //
  // evalChartReady itself is declared earlier (Phase 172, SEED-106 D-03 hoist — the
  // sweep-start effect needs it as its readiness gate). While analysis hasn't landed
  // yet, evalPending drives the Pending…/Analyzing… pill in the eval chart's slot
  // instead of nothing (live poll updates active_eval_status).
  const evalPending =
    isGameMode &&
    gameData != null &&
    !evalChartReady &&
    (gameData.active_eval_status === 'pending' || gameData.active_eval_status === 'leased');

  // `desktopBoardStage` is extracted to `<DesktopBoardStage>`
  // (src/components/analysis/AnalysisBoardStage.tsx, 215-06); its props are built
  // once as a prop bag here (mirroring `flawChessCardProps` above) and spread at
  // its two readers below (mid layout, desktop layout).
  const desktopBoardStageProps = {
    boardStageRef,
    boardWidth,
    leftEvalBar: leftEvalBarNode('h-full w-full'),
    rightEvalBar: rightEvalBarNode('h-full w-full'),
    board: chessBoardNode(),
    containerRef,
    flawChessEnabled,
    showPlayerBars,
    topPlayerColor,
    bottomPlayerColor,
    sharedPlayerBarProps: { pastedHeaders, gameData, playerClocks, position },
    boardControlsProps: {
      onBack: goBack,
      onForward: goForward,
      onReset: handleReset,
      onFlip: () => setBoardFlipped((f) => !f),
      canGoBack: currentNodeId !== null,
      canReset,
      canGoForward,
      isGameMode,
      onFastForwardStart: fastForward.start,
      canFastForward: fastForward.canFastForward,
    },
    isMid,
    evalChartReady,
    evalPending,
    evalChartPanelProps: {
      highlightedPlies: tagsHighlightedPlies,
      evalChartReady,
      evalPending,
      gameId,
      gameData,
      initialPly,
      onHoverPlyChange: handleEvalChartPlyChange,
      evalChartPly,
      tagCommandedPly,
      tagCommandSeq,
    },
    tagsPanelProps: {
      evalChartReady,
      gameData,
      mainLine,
      openLines,
      goToNode,
      onPvChipClick: handlePvChipClick,
      setMoveListTopAlignSeq,
      setTagCommandedPly,
      setTagCommandSeq,
      setTagsHighlightedPlies,
    },
  };

  // Shared ELO slider: drives BOTH the FlawChess and Maia engines, so on desktop it
  // sits BETWEEN the two cards (164 UAT); each mobile tab (FlawChess / Maia) renders
  // its own copy since they're separate screens. The FlawChess card header still
  // reflects the value ("FlawChess Engine (N ELO)"). The reset control snaps back to
  // the players' rating once the user has dragged off it (164 UAT).
  const eloSelector = (
    <EloSelectorPanel
      value={selectedElo}
      onChange={setSelectedElo}
      defaultElo={defaultElo}
      onReset={resetToDefault}
    />
  );

  // FlawChess Engine card props shared by both readers (desktop human column, mobile
  // "FlawChess" tab) — only `footer` differs between them (164 UAT: mobile passes the
  // ELO slider so it sits inside the card; desktop omits it, the slider is a standalone
  // row between the two cards there). `<FlawChessCard>` is extracted to
  // src/components/analysis/AnalysisTabs.tsx (215-06).
  const flawChessCardProps = {
    flawChessEnabled,
    setFlawChessEnabled,
    selectedElo,
    flawChessLoading,
    reconciledRankedLines,
    flawChessIsSearching: flawChessEngine.isSearching,
    position,
    currentPly,
    boardFlipped,
    flawChessTerminalOutcome,
    onMoveClick: playUciLine,
    reconciledStockfishLine,
    enginePvLines: engine.pvLines,
    flawChessRankedLinesForVerdict,
    engineEnabled,
    rawProbBySan,
    shownSans,
    onHoverMovesChange: setHoveredQualityMoves,
    onPlayMove: playProseMove,
    temperature,
    setTemperature,
  };

  // Move-list header row content (Phase 208, D-19/D-20): shared between the
  // mobile/mid movesTab header just below and the desktop movesCard CardHeader
  // further down (added here so the Paste trigger reaches every layout, not just
  // desktop; SC-9 requires the whole flow to work at 375px). Rendered
  // unconditionally, including ?game_id= game mode (D-20). `<MoveListHeaderContent>`
  // is extracted to src/components/analysis/AnalysisTabs.tsx (215-06).
  const moveListHeaderContent = <MoveListHeaderContent onOpenPasteModal={() => setPasteModalOpen(true)} />;

  // The mobile "Moves" tab content's remount key — see MovesTab's own doc comment
  // (AnalysisTabs.tsx) for the bot-game live-analysis remount bug this fixes.
  const moveListKey = isGameMode ? (evalChartReady ? 'moves-analyzed' : 'moves-pending') : 'moves';

  // The full tabbed panel (Moves | Eval | Maia | FlawChess [| Stats]) — the mobile
  // takeover's whole body AND the mid-range layout's right column (both reuse it
  // verbatim; only one layout tree renders at a time, so the Tabs mount exactly
  // once). `<AnalysisTabs>` and its tab-content pieces are extracted to
  // src/components/analysis/AnalysisTabs.tsx (215-06).
  const analysisTabs = (
    <AnalysisTabs
      evalChartReady={evalChartReady}
      evalPending={evalPending}
      movesTab={
        <MovesTab
          moveListKey={moveListKey}
          moveListHeaderContent={moveListHeaderContent}
          variationTree={
            <VariationTreePanel
              variant="vertical"
              nodes={nodes}
              mainLine={mainLine}
              currentNodeId={currentNodeId}
              rootPly={rootPly}
              isGameMode={isGameMode}
              initialAlignPly={initialAlignPly}
              topAlignSeq={moveListTopAlignSeq}
              onNodeClick={goToNode}
              decorations={sidelineNodeColors}
              pvNodeIds={pvNodeIds}
              flawMarkerByNodeId={moveListMarkers}
              onPvChipClick={handlePvChipClick}
              activePvKeys={activePvKeys}
              pvFetchPending={contextualPending}
              pvFetchError={contextualError}
              // deleteSubtree wired unconditionally: the free-move sideline × delete must
              // work in free-play mode too. deleteSubtree is always safe — it recovers
              // currentNodeId to the fork parent when the current node is deleted.
              onDeleteLine={deleteSubtree}
            />
          }
        />
      }
      evalTab={
        <EvalTab
          mobileEngineLines={
            <MobileEngineLines
              engineLoading={engineLoading}
              engineEnabled={engineEnabled}
              reconciledPvLines={reconciledPvLines}
              isAnalyzing={engine.isAnalyzing}
              currentPly={currentPly}
              position={position}
              boardFlipped={boardFlipped}
              onMoveClick={playUciLine}
            />
          }
          evalChartReady={evalChartReady}
          evalPending={evalPending}
          evalChartPanel={
            (evalChartReady || evalPending) && (
              <EvalChartPanel
                heightClass="h-[120px]"
                evalChartReady={evalChartReady}
                evalPending={evalPending}
                gameId={gameId}
                gameData={gameData}
                initialPly={initialPly}
                onHoverPlyChange={handleEvalChartPlyChange}
                evalChartPly={evalChartPly}
                tagCommandedPly={tagCommandedPly}
                tagCommandSeq={tagCommandSeq}
              />
            )
          }
          tagsPanel={
            evalChartReady && (
              <TagsPanel
                section="tags"
                evalChartReady={evalChartReady}
                gameData={gameData}
                mainLine={mainLine}
                openLines={openLines}
                goToNode={goToNode}
                onPvChipClick={handlePvChipClick}
                setMoveListTopAlignSeq={setMoveListTopAlignSeq}
                setTagCommandedPly={setTagCommandedPly}
                setTagCommandSeq={setTagCommandSeq}
              />
            )
          }
        />
      }
      humanTab={
        <HumanTab
          selectedElo={selectedElo}
          maiaPerElo={maia.perElo}
          playedSan={playedSan}
          // 162-REVIEW WR-02: the chart's emphasized stroke follows the SAME
          // reconciled Best the quality color/label/verdict designate, not the
          // raw free-run pick (raw bestSan still feeds selectCandidatesByMass
          // above so the free-run pick stays plotted).
          reconciledBestSan={reconciledBestSan}
          bestSan={bestSan}
          shownSans={shownSans}
          qualityBySanWithGem={qualityBySanWithGem}
          position={position}
          engineTopLines={engineTopLines}
          onHoverMovesChange={setHoveredQualityMoves}
          isOpponentToMove={isOpponentToMove}
          onPlayMove={playProseMove}
          maiaEnabled={maiaEnabled}
          setMaiaEnabled={setMaiaEnabled}
          eloSelector={eloSelector}
        />
      }
      flawChessTab={
        <FlawChessTab flawChessCard={<FlawChessCard {...flawChessCardProps} footer={eloSelector} />} />
      }
      statsTab={
        <StatsTab
          evalChartReady={evalChartReady}
          tagsPanel={
            <TagsPanel
              section="stats"
              evalChartReady={evalChartReady}
              gameData={gameData}
              mainLine={mainLine}
              openLines={openLines}
              goToNode={goToNode}
              onPvChipClick={handlePvChipClick}
              setMoveListTopAlignSeq={setMoveListTopAlignSeq}
              setTagCommandedPly={setTagCommandedPly}
              setTagCommandSeq={setTagCommandSeq}
            />
          }
          evalPending={evalPending}
          gameId={gameId}
          leased={gameData?.active_eval_status === 'leased'}
        />
      }
    />
  );

  // ── Shared desktop/mid cards ──────────────────────────────────────────────────
  // `stockfishCard`/`movesCard`/`desktopMaiaPanel`/`pasteModalNode` are extracted to
  // `<StockfishCard>`/`<MovesCard>`/`<DesktopMaiaPanel>`/`<PasteModalNode>`
  // (src/components/analysis/AnalysisDesktopCards.tsx, 215-06), constructed once here
  // as prop bags (mirroring `flawChessCardProps`, 215-06 Task 2) and spread at each
  // reader — the mid-range two-column layout and the desktop 3-column layout (single
  // mount — only one return branch renders).
  const stockfishCardProps = {
    engineEnabled,
    setEngineEnabled,
    reconciledBestEval,
    engineLoading,
    reconciledPvLines,
    isAnalyzing: engine.isAnalyzing,
    currentPly,
    position,
    boardFlipped,
    onMoveClick: playUciLine,
  };

  const movesCardVariationTreeProps = {
    nodes,
    mainLine,
    currentNodeId,
    rootPly,
    isGameMode,
    initialAlignPly,
    topAlignSeq: moveListTopAlignSeq,
    onNodeClick: goToNode,
    decorations: sidelineNodeColors,
    pvNodeIds,
    flawMarkerByNodeId: moveListMarkers,
    onPvChipClick: handlePvChipClick,
    activePvKeys,
    pvFetchPending: contextualPending,
    pvFetchError: contextualError,
    onDeleteLine: deleteSubtree,
  };

  const desktopMaiaPanelProps = {
    selectedElo,
    perElo: maia.perElo,
    playedSan,
    // 162-REVIEW WR-02: same reconciled-emphasis threading as the mobile Maia tab.
    bestSan: reconciledBestSan ?? bestSan,
    shownSans,
    qualityBySan: qualityBySanWithGem,
    mover: sideToMoveFromFen(position),
    engineTopLines,
    onHoverMovesChange: setHoveredQualityMoves,
    isOpponentToMove,
    onPlayMove: playProseMove,
    enabled: maiaEnabled,
    onToggleEnabled: setMaiaEnabled,
  };

  const pasteModalNodeProps = {
    pasteModalOpen,
    setPasteModalOpen,
    onLoad: handlePasteLoad,
    onSaved: handlePasteSaved,
  };
  const pasteModalNode = <PasteModalNode {...pasteModalNodeProps} />;

  const closeEngineGate = useCallback((): void => {
    setEngineGateOpen(false);
  }, []);

  // G-213-34: unlike the bots surface, which re-warms its own provider
  // handles through `useBotGame.retryEngineWarm`, this page has no handle on
  // the three independent worker lifecycles behind it (`useStockfishEngine`'s
  // standalone worker, `useFlawChessEngine`'s pool and queue, `useMaiaEngine`'s
  // lease), so a reload is the only re-entry that cannot leave a partially
  // healed worker graph. It is safe here precisely because the gate has been
  // up since mount: there is provably no user work behind it to lose.
  const handleEngineGateRetry = useCallback((): void => {
    window.location.reload();
  }, []);

  // G-213-34: the analysis-board mount of the same gate Bots.tsx uses.
  // Suppressed when the store reports `unsupported` — a device whose
  // capability probe failed can never reach a ready state, so gating it
  // would lock it out of the analysis board permanently, the exact fallback
  // the gate's own unsupported copy promises. There is no progress to show
  // on a device that will never download, so nothing is lost by suppressing
  // it here.
  const engineGateNode =
    engineGateOpen && engineAssetStatus !== 'unsupported' ? (
      <EngineReadyGate
        surface="analysis"
        onStart={closeEngineGate}
        onRetry={handleEngineGateRetry}
      />
    ) : null;

  // ── Mid-range two-column layout (MOBILE_BREAKPOINT_PX .. desk3col) ─────────────
  // Two columns split 60/40:
  //   • left (60%):  the board (JS-sized to the column width), its flanking eval bars, the
  //            player rows, and the board controls. (No eval chart here — mobile parity:
  //            it lives in the Eval tab; desktopBoardStage suppresses it when isMid.)
  //   • right (40%): the full tabbed panel (Moves | Eval | Maia | FlawChess | Stats) — the
  //            SAME analysisTabs the mobile takeover renders, reused verbatim. The eval
  //            chart sits in the Eval tab below the Stockfish lines, exactly as on mobile.
  // The page scrolls (no viewport height lock in this band, per the shell's
  // `sm:max-desk3col:` unlock). The tab panel is wrapped in a board-height box so each
  // tab's internal scroller has a definite height (an unbounded flex-1 parent renders
  // the move tree empty).
  if (isMid) {
    // Right-column tab panel is bounded to the FULL board-stage height (board + caps +
    // player rows + controls), so the tabs run the whole height of the board block and
    // bottom out at the controls card — not clipped short at the board's edge. A bounded
    // height is also what lets each tab's internal scroller resolve (an unbounded `flex-1`
    // parent renders the move-tree list empty — the same reason the desktop movesCard
    // needs a height-bounded flex parent). Falls back to the bare board height, then to
    // auto, until the stage measures (a brief first-paint transient).
    const tabPanelHeightStyle: CSSProperties | undefined = boardStageHeight
      ? { height: Math.round(boardStageHeight) }
      : boardWidth
        ? { height: Math.round(boardWidth) }
        : undefined;
    return (
      <div data-testid="analysis-page" className="flex min-h-0 flex-1 flex-col bg-background">
        {pasteModalNode}
        {engineGateNode}
        <main
          className="mx-auto w-full px-4 py-4 pb-20 md:px-6"
          style={{ maxWidth: DESKTOP_GRID_MAX_WIDTH_PX }}
        >
          {/* Game load error (CLAUDE.md isError branch). */}
          {isGameMode && gameError && (
            <p className="mb-4 text-sm text-muted-foreground">
              Failed to load game. Something went wrong. Please try again in a moment.
            </p>
          )}
          {/* Two columns split 60/40: the board stage on the left (60%), the full
              tabbed panel (Moves | Eval | Maia | FlawChess | Stats) on the right (40%) —
              the same tabs the mobile takeover uses, reused verbatim via analysisTabs. */}
          <div className="grid grid-cols-[3fr_2fr] items-start gap-4">
            {/* Left column — the board stage (board + board controls, JS-sized to the
                column width). The controls live inside desktopBoardStage under the board;
                the eval chart is NOT here — it lives in the right column's Eval tab
                (mobile parity), so desktopBoardStage omits it under the board when isMid. */}
            <div className="flex min-w-0 flex-col gap-2"><DesktopBoardStage {...desktopBoardStageProps} /></div>
            {/* Right column — the tabbed panel, bounded to the board height so its
                tabs scroll internally instead of stretching the page. */}
            <div className="flex min-h-0 min-w-0 flex-col" style={tabPanelHeightStyle}>
              {analysisTabs}
            </div>
          </div>
        </main>
      </div>
    );
  }

  // ── Mobile takeover layout (< 640px) ──────────────────────────────────────────
  // Board + eval bar, then a tab view (Moves | Eval | Maia | FlawChess [| Stats]) that
  // fills the space down to the in-flow board-controls footer. The Stockfish PV lines
  // live at the top of the Eval tab (not above the board). The shell's back-button
  // header + suppressed bottom nav (ProtectedLayout) complete the takeover.
  if (isMobile) {
    return (
      <div
        data-testid="analysis-page"
        className="flex min-h-0 flex-1 flex-col bg-background"
      >
        {pasteModalNode}
        {engineGateNode}
        {/* Board + eval bar. */}
        {/* Board block: source caps + top player, board, bottom player. max-w-[92vw]
            shrinks the board a touch so the name/clock strips top and bottom stay on
            screen (151.1 UAT). Free play has no players — the caps show alone. */}
        <div
          className="mx-auto flex w-full shrink-0 flex-col gap-1 px-2 pt-2"
          // Cap at the board's natural block width (board + bars) so the flex-1 board
          // container never exceeds BOARD_MAX_WIDTH — the board then fills it, the SF eval
          // bar hugs the board's right edge, and the clock labels right-align to that edge
          // (min() with 92vw keeps narrow phones shrinking to fit).
          style={{ maxWidth: `min(92vw, ${MOBILE_BOARD_BLOCK_MAX_PX}px)` }}
        >
          <BoardHeaderRow
            flawChessEnabled={flawChessEnabled}
            showPlayerBars={showPlayerBars}
            color={topPlayerColor}
            pastedHeaders={pastedHeaders}
            gameData={gameData}
            playerClocks={playerClocks}
            position={position}
          />
          <BoardRow
            leftEvalBar={leftEvalBarNode()}
            board={chessBoardNode()}
            rightEvalBar={rightEvalBarNode()}
            containerRef={containerRef}
          />
          {showPlayerBars && (
            <BoardFooterRow
              player={
                <PlayerBar
                  color={bottomPlayerColor}
                  pastedHeaders={pastedHeaders}
                  gameData={gameData}
                  playerClocks={playerClocks}
                  position={position}
                />
              }
            />
          )}
        </div>

        {/* Game load error (CLAUDE.md isError branch). */}
        {isGameMode && gameError && (
          <p className="shrink-0 px-3 py-2 text-sm text-muted-foreground">
            Failed to load game. Something went wrong. Please try again in a moment.
          </p>
        )}

        {/* Tab view — fills all vertical space between the board and the footer.
            Bounded chart height inside the Eval tab (not h-full): the board already
            dominates the viewport, so a greedy chart pushed the board-controls footer
            off-screen when the mobile browser's URL bar shrank the height. h-[120px]
            (the established mobile chart height) keeps the footer visible. Quick
            260714-rj5: collapsed from two near-identical Tabs branches into one —
            the Stats trigger/content render whenever the game is analyzed OR being
            analyzed (evalChartReady || evalPending), showing an Analyzing pill
            during analysis then the panel once evals land (quick 260719-dzh), so
            the Tabs subtree itself never remounts when a game-mode card transitions
            from unanalyzed to analyzed via the live poll (no cursor/variation-tree
            loss). Free play and an idle unanalyzed game just omit the Stats tab. */}
        {analysisTabs}

        {/* In-flow board-controls footer — replaces the suppressed mobile nav bar. */}
        <div
          data-testid="analysis-mobile-footer"
          className="shrink-0 border-t border-border bg-background px-2 py-2 pb-safe"
        >
          <BoardControls
            onBack={goBack}
            onForward={goForward}
            onReset={handleReset}
            onFlip={() => setBoardFlipped((f) => !f)}
            canGoBack={currentNodeId !== null}
            canReset={canReset}
            canGoForward={canGoForward}
            isGameMode={isGameMode}
            onFastForwardStart={fastForward.start}
            canFastForward={fastForward.canFastForward}
            flat
          />
        </div>
      </div>
    );
  }

  return (
    <div data-testid="analysis-page" className="flex min-h-0 flex-1 flex-col bg-background">
      {pasteModalNode}
      {engineGateNode}
      {/* Phase 161 D-03: max-w-7xl removed at desk3col+ to reclaim horizontal space
          for the fluid grid; min-h-0/flex/h-full complete the min-h-0 chain from the
          App shell (D-01) down into the grid row below. */}
      <main className="mx-auto w-full flex-1 px-4 py-2 pb-20 md:py-6 md:pb-6 md:px-6 desk3col:flex desk3col:h-full desk3col:min-h-0 desk3col:flex-col">
        {/* Phase 161 UAT: cap the grid at its natural full-board width and center it
            (desk3col:mx-auto). Below the cap the fluid `1fr` center track still shrinks the
            board; above it the grid stops growing, so surplus width lands in the window
            margins and the side panels stay hugged to the board+bars instead of drifting
            apart. maxWidth is harmless below desk3col (stacked column, always narrower).
            desk3col:w-full gives the grid a definite width so the `1fr` track keeps a real
            basis; without it a bare mx-auto collapses the flex item to content width and
            starves the board's width measurement. */}
        <div
          className="flex flex-col gap-4 desk3col:mx-auto desk3col:grid desk3col:h-full desk3col:min-h-0 desk3col:w-full desk3col:grid-cols-[360px_1fr_360px]"
          style={{ maxWidth: DESKTOP_GRID_MAX_WIDTH_PX }}
        >

          {/* Human column ──────────────────────────────────────────────────── */}
          {/* D-01 3-column layout: left = Maia ("human") surfaces, matching the
              existing right panel's ~360px width (D-02 trade-off: narrower chart,
              fewer x-axis ticks, accepted for the thematic left-grouping). */}
          <div
            data-testid="analysis-human-column"
            className="flex w-full shrink-0 flex-col gap-4 min-w-0 desk3col:w-[360px] desk3col:min-h-0 desk3col:h-full desk3col:overflow-y-auto"
          >
            {/* Invisible spacer mirroring the board column's top player bar so the
                Human card top aligns with the board top (not the player-bar top) —
                same trick as the engine column. Desktop only; -mb-2 trims this
                column's gap-4 to the board column's gap-2. (Quick 260705-bm3) */}
            {showPlayerBars && (
              <div aria-hidden="true" className="hidden desk3col:block desk3col:invisible desk3col:-mb-2">
                <PlayerBar
                  color={topPlayerColor}
                  pastedHeaders={pastedHeaders}
                  gameData={gameData}
                  playerClocks={playerClocks}
                  position={position}
                />
              </div>
            )}
            <FlawChessCard {...flawChessCardProps} />
            {/* Shared ELO slider between the two cards (164 UAT): it drives both the
                FlawChess and Maia engines, so it sits in the gap rather than inside
                either card. */}
            {eloSelector}
            <DesktopMaiaPanel {...desktopMaiaPanelProps} />
          </div>

          {/* Board column ──────────────────────────────────────────────────── */}
          {/* Fluid `1fr` grid track holding the JS-sized board stage (caps + players +
              board/eval-bars + eval chart). All sizing/scroll behavior lives inside
              desktopBoardStage (defined above) so this middle track is just its slot. */}
          <DesktopBoardStage {...desktopBoardStageProps} />

          {/* Side panel: engine + variation tree + controls. Narrower than the board
              column (UAT 260627-mt8 item 1) and stretched to the board column's
              height. overflow-hidden (not -y-auto): the column NEVER shows its own
              scrollbar — a too-tall stack is clipped at the viewport bottom, matching the
              board column's Phase 161 clip-don't-scroll rule (user UAT). The move list
              keeps its own internal scroller, so no moves are lost. */}
          <div className="flex w-full shrink-0 flex-col gap-4 min-w-0 desk3col:w-[360px] desk3col:min-h-0 desk3col:h-full desk3col:overflow-hidden">

            {/* Spacer mirroring the board column's top player bar so the engine card
                top aligns with the board top (not the player-bar top). Desktop only
                (desk3col) where the columns sit side by side; invisible keeps its
                height. -mb-2 trims this column's gap-4 down to the board column's
                gap-2 so the spacer→card gap equals the bar→board gap. (Quick 260628-pcb) */}
            {showPlayerBars && (
              <div aria-hidden="true" className="hidden desk3col:block desk3col:invisible desk3col:-mb-2">
                <PlayerBar
                  color={topPlayerColor}
                  pastedHeaders={pastedHeaders}
                  gameData={gameData}
                  playerClocks={playerClocks}
                  position={position}
                />
              </div>
            )}

            {/* Game load error (CLAUDE.md isError branch). */}
            {isGameMode && gameError && (
              <p className="text-sm text-muted-foreground p-2">
                Failed to load game. Something went wrong. Please try again in a moment.
              </p>
            )}

            {/* Board-height region: the engine + moves cards together span exactly the
                board's height at desk3col, so the moves card's bottom border lands on the
                board's bottom edge (user UAT). The board controls now sit under the board
                in the center column (not in the moves card footer). `--analysis-board-h` is
                the JS-measured board size; the desk3col:h-[var(...)] only binds it on the
                3-column desktop layout, leaving the stacked mobile layout at natural height.
                The tags panel below then sits beside the bottom player bar + eval chart. */}
            <div
              className="flex min-h-0 flex-col gap-4 desk3col:h-[var(--analysis-board-h)] desk3col:shrink-0"
              style={{ '--analysis-board-h': boardWidth ? `${boardWidth}px` : undefined } as CSSProperties}
            >
            {/* Engine info + lines + move list (desktop side panel). stockfishCard is also
                referenced in the mobile/mid Eval tab via mobileEngineLines; movesCard is
                desktop-only (mid/mobile show the move tree in the Moves tab). */}
            <StockfishCard {...stockfishCardProps} />
            <MovesCard onOpenPasteModal={() => setPasteModalOpen(true)} variationTreeProps={movesCardVariationTreeProps} />
            </div>

            {/* Invisible spacer mirroring the board column's BOTTOM player bar so the
                Accuracies (MoveStats) card top aligns with the board-controls top (UAT
                179): the board-height region above already lands its bottom on the
                board's bottom edge, but the board controls sit one player-bar lower (below
                the footer bar). This spacer drops the stats card by exactly that footer-bar
                height. desk3col:-my-2 trims the column's gap-4 on BOTH sides of the spacer
                down to the board column's gap-2, so the net offset is the bar height alone.
                Same trick as the top spacer; game mode only (free play has no player bars
                and no stats card). (Quick 260718) */}
            {isGameMode && gameData && (
              <div aria-hidden="true" className="hidden desk3col:block desk3col:invisible desk3col:-my-2">
                <PlayerBar
                  color={bottomPlayerColor}
                  pastedHeaders={pastedHeaders}
                  gameData={gameData}
                  playerClocks={playerClocks}
                  position={position}
                />
              </div>
            )}
            {/* MoveStats card (Accuracies + two-sided category table) lives in the
                right column. The Missed/Allowed/Context tags moved back under the eval
                chart in the board column (UAT 179 — see analysis-board-tags), so this
                column shows the stats card only. withHighlight=true preserved — its
                hover/cycle state still wires back onto the eval chart. */}
            <TagsPanel
              withHighlight
              section="stats"
              evalChartReady={evalChartReady}
              gameData={gameData}
              mainLine={mainLine}
              openLines={openLines}
              goToNode={goToNode}
              onPvChipClick={handlePvChipClick}
              setMoveListTopAlignSeq={setMoveListTopAlignSeq}
              setTagCommandedPly={setTagCommandedPly}
              setTagCommandSeq={setTagCommandSeq}
              setTagsHighlightedPlies={setTagsHighlightedPlies}
            />
          </div>

        </div>
      </main>
    </div>
  );
}
