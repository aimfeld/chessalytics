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
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import {
  ArrowLeftRight,
  ChartNoAxesColumn,
  ChessKnight,
  Cpu,
  type LucideIcon,
  User,
} from 'lucide-react';
import { useAnalysisBoard } from '@/hooks/useAnalysisBoard';
import { useStockfishEngine } from '@/hooks/useStockfishEngine';
import { useStockfishGradingEngine } from '@/hooks/useStockfishGradingEngine';
import { useMaiaEngine } from '@/hooks/useMaiaEngine';
import {
  useMaiaEloDefault,
  deriveRawDefault,
  clampToLadderBounds,
  FREE_PLAY_DEFAULT_ELO,
} from '@/hooks/useMaiaEloDefault';
import { useFlawChessEngine } from '@/hooks/useFlawChessEngine';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useGameOverlay } from '@/hooks/useGameOverlay';
import { useLiveMoveFlaw } from '@/hooks/useLiveMoveFlaw';
import { useTacticLines, useLibraryGame } from '@/hooks/useLibrary';
import {
  parseAnalysisLineParam,
  parseAnalysisFenParam,
  parseAnalysisOrientationParam,
} from '@/lib/analysisUrl';
import { toDisplayDepthForOrientation } from '@/lib/tacticDepth';
import { buildPvArrow } from '@/lib/tacticArrows';
import { EvalBar } from '@/components/analysis/EvalBar';
import { EngineLines, EngineLinesSkeleton, LINES_MIN_HEIGHT, MAX_LINES as SF_MAX_LINES } from '@/components/analysis/EngineLines';
import { FlawChessEngineLines, MAX_LINES as FC_MAX_LINES } from '@/components/analysis/FlawChessEngineLines';
import { FlawChessAgreementVerdict } from '@/components/analysis/FlawChessAgreementVerdict';
import { Card, CardHeader, CardBody } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { InfoPopover } from '@/components/ui/info-popover';
import { VariationTree } from '@/components/analysis/VariationTree';
import type { FlawMarkerEntry } from '@/components/analysis/VariationTree';
import type { FlawSeverity } from '@/types/library';
import { tacticOrientationAtPly } from '@/lib/tacticOrientation';
import { EvalChart } from '@/components/library/EvalChart';
import { AnalysisPendingPill } from '@/components/library/AnalysisPendingPill';
import { AnalysisTagsPanel } from '@/components/analysis/AnalysisTagsPanel';
import { MaiaHumanPanel } from '@/components/analysis/MaiaHumanPanel';
import { EloSelector } from '@/components/analysis/EloSelector';
import { TemperatureSelector, TEMPERATURE_DEFAULT } from '@/components/analysis/TemperatureSelector';
import type { HoveredQualityMove } from '@/components/analysis/MaiaMoveQualityBar';
import { ChessBoard } from '@/components/board/ChessBoard';
import type { BoardArrow } from '@/components/board/ChessBoard';
import { BOARD_MAX_WIDTH, BOARD_MIN_WIDTH, computeBoardSize } from '@/components/board/boardSize';
import { BoardControls } from '@/components/board/BoardControls';
import { PlayerBar } from '@/components/board/PlayerBar';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { uciToSquares, sanToUci } from '@/lib/sanToSquares';
import {
  TAC_MISSED,
  TAC_ALLOWED,
  MOVE_HIGHLIGHT_GOOD,
  MOVE_HIGHLIGHT_GEM,
  MOVE_HIGHLIGHT_GREAT,
  STOCKFISH_ACCENT,
  MAIA_ACCENT,
  FLAWCHESS_ENGINE_ACCENT,
  FLAWCHESS_ENGINE_ARROW,
  BEST_MOVE_ARROW,
  NEXT_MOVE_ARROW,
} from '@/lib/theme';
import { selectCandidatesByMass, nearestByElo, classifyMoveQuality, type MoveGrade } from '@/lib/moveQuality';
import type { MoveQualityEval, EngineLine } from '@/components/analysis/MovesByRatingChart';
import {
  sideToMoveFromFen,
  terminalPositionEval,
  evalToExpectedScore,
  type MoverColor,
} from '@/lib/liveFlaw';
import type { NodeId, MoveNode } from '@/hooks/useAnalysisBoard';
import type { MoveCurvePoint } from '@/hooks/useMaiaEngine';
import { buildEvalLookup, getByUci, getBySan, resolveReconciledBest, rankReconciledCandidates } from '@/lib/engineEvalLookup';
import type { RankedLine } from '@/lib/engine/types';
import { cloneRankedLineWith } from '@/lib/engine/treeCommon';
import type { PvLine } from '@/hooks/uciParser';
import { classifyGem, summarizeForGem, GEM_MAIA_MAX_PROB } from '@/lib/gemMove';
import { useGemSweep } from '@/hooks/useGemSweep';
import { resolveGemVerdict, selectSweepCandidates, type SweepCandidate } from '@/lib/gemSweep';

// ─── Constants ────────────────────────────────────────────────────────────────

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Engine label shown in the engine info line — the bundled Stockfish 18 WASM. */
const ENGINE_NAME = 'Stockfish 18';

/** Cap on the per-session live engine-eval cache (FEN → completed eval), item 4. */
const LIVE_EVAL_CACHE_MAX = 256;

/** IN-04 (172-deferred-review-findings.md): named sentinel for a move-list
 *  marker entry with no associated GAME ply (a genuinely free/off-mainline
 *  move) — never a bare `-1` literal, so a call site that DOES have a real
 *  mainline ply available is never tempted to reach for the same magic
 *  number instead of the ply it actually has. */
const NO_GAME_PLY = -1;

/** Synthetic eval-bar depth for a terminal (checkmate/draw) position — clears EvalBar's
 *  mate-display gate (depth >= 8) so a decisive terminal eval fills the bar (Quick 260709-j3k). */
const TERMINAL_EVAL_DEPTH = 99;

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
 *  BOARD_WIDTH_LOCK_MIN_PX, kept as its own named constant since it gates a different
 *  concern (which layout tree renders, not the board's height lock). */
const DESK3COL_BREAKPOINT_PX = 1200;

/** Horizontal space the two flanking eval bars + their `gap-2` gutters consume in the
 *  desktop board row: 2×(w-5 bar = 20px) + 2×(gap-2 = 8px). Subtracted from the stage's
 *  measured width so the board is sized to the space that actually remains beside the
 *  bars (Phase 161 UAT: bars hug the board, board never clips). */
const BOARD_EVAL_BARS_ALLOWANCE_PX = 56;

/** Desktop-only board-size reduction (UAT 179): on the ≥1200px desktop analysis layout
 *  the board is drawn 20px smaller than its natural width/height fit, leaving more room
 *  for the eval chart + tags stacked below it. Applied to the FINAL computed board size
 *  (not the max-width ceiling) so it produces a visible 20px reduction regardless of
 *  whether the width, height, or ceiling constraint binds — the ceiling rarely binds on
 *  desktop (the board is usually height-limited), which is why a ceiling-only cut is
 *  invisible. Does NOT affect the mid or mobile layouts. */
const DESKTOP_BOARD_SIZE_REDUCTION_PX = 20;

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

/** The board's height budget only binds in the locked desktop layout, i.e. at/above the
 *  desk3col width breakpoint AND at/above the `short` height-unlock threshold. Both mirror
 *  the CSS tokens in index.css (`--breakpoint-desk3col: 1200px`, `short` = max-height
 *  559.98px). Outside that band the page scrolls, so the board is width-driven. */
const BOARD_WIDTH_LOCK_MIN_PX = 1200;
const BOARD_HEIGHT_LOCK_MIN_PX = 560;

/** Fixed width (px) of each side-panel grid track. Mirrors the `360px` literals in the
 *  `desk3col:grid-cols-[360px_1fr_360px]` template and `desk3col:w-[360px]` columns below. */
const SIDE_COLUMN_WIDTH_PX = 360;
/** Gutter (px) between the three desktop columns — mirrors the grid's `gap-4`. */
const DESKTOP_GRID_GAP_PX = 16;
/** Per-side horizontal slack (px) left between the board group and its center track. The
 *  board group is sized this much narrower than the track so it centers with breathing room
 *  on each side, into which the EvalChart slider's ±8px thumb overhang (EvalChart.tsx: the
 *  `calc(100% + 16px)` / `-8px` marginLeft slider) lands — otherwise the stage's
 *  overflow-x-hidden clips the thumb at the min/max position (Phase 161 UAT). Also widens the
 *  visible column gap a touch, which was the paired request. */
const EVAL_SLIDER_SLACK_PX = 12;
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

/** Normalized width of the move-quality-bar hover arrows (quick 260705-kfg). */
const QUALITY_HOVER_ARROW_WIDTH = 0.6;

/** Normalized width of the on-main-line next-move arrow — thin so it reads as a
 *  subtle hint layered over the wider 0.5 engine arrows. */
const NEXT_MOVE_ARROW_WIDTH = 0.18;

/**
 * Phase 156 (ARROW-01/02/03, D-02): top-1-per-engine arrow count for the
 * free-analysis board's FC + SF arrow layer. A future engine-settings panel
 * may make this configurable (e.g. top-2) — bumping this constant is the only
 * change needed then, no prop threading now (D-03).
 */
const ARROW_COUNT = 1;

/** Normalized width of the FlawChess Engine board arrow — widest of the three
 *  concentric arrows so it draws at the bottom (D-05). Maxed at 1.0 (156 UAT: the
 *  FC practical move is the headline signal, so its arrow is the boldest on the board). */
const FLAWCHESS_ENGINE_ARROW_WIDTH = 1.0;

/** Normalized width of the Stockfish board arrow — nests inside the FC arrow
 *  and outside the thin white next-move arrow (D-05). */
const STOCKFISH_ENGINE_ARROW_WIDTH = 0.5;

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

// ─── Shared engine-card header toggle (D-03) ──────────────────────────────────

/**
 * Switch + accent-tinted caption, shared by all three engine card headers
 * (Stockfish/Maia/FlawChess) so none of the three headers triples this
 * near-identical markup inline (155-RESEARCH.md Pitfall 5). Visual weight:
 * switch first (left), caption text after (UI-SPEC Component Inventory §3).
 * The checked-state track color is set via an inline `style` override (wins
 * over the Switch primitive's default `data-[state=checked]:bg-primary`
 * class) rather than a CSS custom property, keeping this a plain, typed
 * `style={{...}}` object like every other accent usage in this file.
 */
function EngineToggleHeader({
  checked,
  onCheckedChange,
  accent,
  testId,
  ariaLabel,
  icon: Icon,
  children,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  accent: string;
  testId: string;
  ariaLabel: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={ariaLabel}
        data-testid={testId}
        style={checked ? { backgroundColor: accent } : undefined}
      />
      <span
        className="flex items-center gap-1.5 text-sm font-medium"
        style={{ color: accent }}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {children}
      </span>
    </>
  );
}

/**
 * Header info tooltip for the FlawChess Engine card — a plain-language, three-paragraph
 * explanation of what the engine does and why it differs from a normal engine. Sourced
 * from docs/flawchess-engine-explained-2026-07-06.md (§1, §9), kept non-technical
 * (no "expectimax"/"MCTS" jargon in user-facing copy).
 */
function FlawChessInfoTooltip() {
  return (
    <InfoPopover ariaLabel="About the FlawChess Engine" testId="flawchess-info-popover">
      <div className="max-w-xs space-y-2">
        <p>
          Stockfish shows the objectively best move, assuming perfect play. The FlawChess
          Engine instead favors moves you can realistically pull off: ones that are easier
          for a player at your level to find (along with their follow-ups), and that pay off
          against an opponent who defends imperfectly, the way real players do.
        </p>
        <p>
          It blends Stockfish's objective quality with Maia's model of how humans at a given
          rating really play, treating both sides as fallible. So it can rank a trap above
          the textbook best move, showing both numbers: "objectively +3.0, but practically
          +0.9 for you."
        </p>
      </div>
    </InfoPopover>
  );
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

/**
 * Main-line ply the tactic PV sideline forks from, by orientation (Quick 260628-pu2 UAT).
 *
 * Missed lines fork at the pre-flaw DECISION board (flawPly-1) and replay the
 * should-have-played PV. Allowed lines fork at the FLAW position itself (flawPly): the
 * sideline begins with the opponent's punishing response, not a replay of the flaw move.
 * The backend's allowed_moves prepends the flaw move at index 0, so allowed PVs grafted
 * here drop that lead-in move (allowed_moves.slice(1)).
 */
function forkPlyForOrientation(flawPly: number, orientation: 'missed' | 'allowed'): number {
  return orientation === 'allowed' ? flawPly : flawPly - 1;
}

/**
 * Stable key for a tactic line (Quick 260703-kyb multi-line state): identifies which
 * flaw a chip / open line belongs to. Used as the openLines Map key and as an
 * activePvKeys entry so VariationTree can read chip "on" state by membership.
 */
function flawKey(flaw: { ply: number; orientation: 'missed' | 'allowed' }): string {
  return `${flaw.ply}:${flaw.orientation}`;
}

/**
 * The engine's top-line first move (UCI) converted to SAN at `baseFen` — feeds
 * MovesByRatingChart's `bestSan` emphasis (Plan 06, SURF-01). Returns null for no
 * PV yet or an illegal/malformed replay (never throws).
 */
function bestSanFromPv(baseFen: string, uci: string | null): string | null {
  const squares = uciToSquares(uci);
  if (!squares || !uci) return null;
  try {
    const chess = new Chess(baseFen);
    const move = chess.move({
      from: squares.from,
      to: squares.to,
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return move.san;
  } catch {
    return null;
  }
}

type OpenLine = { rootNodeId: NodeId; ply: number; orientation: 'missed' | 'allowed' };
type FlawRef = { ply: number; orientation: 'missed' | 'allowed' };

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
  pendingFlaw: FlawRef | null,
  openLines: Map<string, OpenLine>,
  mainLine: NodeId[],
  nodes: Map<NodeId, MoveNode>,
): FlawRef | null {
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
  const [searchParams] = useSearchParams();

  // Free-play entry point: the opening line to seed as the board's main line,
  // carried as a `?line=` param of comma-separated UCI moves from the standard
  // start (replaces the old `?fen=` snapshot — a move list lets the user step
  // all the way back to move 1). parseAnalysisLineParam degrades a malformed or
  // hand-typed value to its legal prefix, so bad input can't crash the board —
  // the same defensive posture the old FEN guard (T-138-01) had.
  const lineParam = searchParams.get('line');
  const lineSans = useMemo(() => parseAnalysisLineParam(lineParam), [lineParam]);

  // Additive `?fen=` snapshot entry point (SEED-094 / D-06): seeds an arbitrary
  // mid-game FEN (e.g. a gem-ELO calibration harness row) as a free-play root
  // with no navigable history. parseAnalysisFenParam degrades a malformed or
  // hand-typed value to null (T-165-03), so a bad URL can't crash the board.
  // Precedence when both ?fen= and ?line= are present: fen wins (see the
  // ?line= seeding effect's `rootFenSeed === null` guard below).
  const fenParam = searchParams.get('fen');
  const rootFenSeed = useMemo(() => parseAnalysisFenParam(fenParam), [fenParam]);

  // Free-play orientation entry point (171 UAT gap 1): `?orientation=white|black`
  // orients the board when opened from e.g. a finished bot game. Before this,
  // free play had no orientation input at all — a bot game played as Black
  // opened white-side-up. parseAnalysisOrientationParam degrades a malformed or
  // hand-typed value to null (T-171-08-01/02), matching the fen/line guards above.
  const orientationParam = searchParams.get('orientation');
  const urlOrientation = useMemo(
    () => parseAnalysisOrientationParam(orientationParam),
    [orientationParam]
  );

  // ── URL params — game mode (T-140-02a) ──────────────────────────────────────
  // Security: NaN-guard on numeric params — malformed → null → mode disabled.
  const gameIdRaw = searchParams.get('game_id');
  const plyRaw = searchParams.get('ply');

  const gameId: number | null =
    gameIdRaw != null && !Number.isNaN(Number(gameIdRaw)) ? Number(gameIdRaw) : null;
  // Game mode initial ply (T-140-02a: NaN-guard). null when the ply param is absent
  // or malformed; game mode still loads (gameId drives it) and opens at ply 0
  // (Quick 260628-qta UAT: game_id without ply loads the game at ply 0).
  const initialPly: number | null =
    plyRaw != null && !Number.isNaN(Number(plyRaw)) ? Number(plyRaw) : null;

  // Game mode is keyed on game_id alone — the ply param is optional (defaults to 0
  // via the `?? 0` guards on every mainLine[initialPly] access below).
  const isGameMode = gameId != null;

  const layoutMode = useAnalysisLayoutMode();
  const isMobile = layoutMode === 'mobile';
  const isMid = layoutMode === 'mid';

  // D-06: engine on by default; toggle available via infoSlot button.
  const [engineEnabled, setEngineEnabled] = useState(true);
  // Phase 155 D-02/D-03: the Maia and FlawChess Engine header switches — all
  // three engine cards default ON (all-by-default UI, gated on the SC4
  // real-device mobile-memory UAT per 155-RESEARCH.md D-02).
  const [maiaEnabled, setMaiaEnabled] = useState(true);
  const [flawChessEnabled, setFlawChessEnabled] = useState(true);
  const [boardFlipped, setBoardFlipped] = useState(false);
  // Once we have auto-oriented the board to the player's color, manual flips win.
  const hasAutoFlipped = useRef(false);

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
  const engine = useStockfishEngine({
    fen: engineEnabled ? position : null,
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
  // rating-at-game-time or free-play current_rating, with user-override precedence.
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
  const maia = useMaiaEngine({ fen: position, enabled: maiaEnabled, selectedElo });

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
  const flawChessEngine = useFlawChessEngine({
    fen: flawChessEnabled ? position : null,
    enabled: flawChessEnabled,
    elo: selectedElo,
    policyTemperature: temperature,
    extraRootMoves,
  });

  // Seeding guard refs: prevent re-running effects after the first game load.
  const hasLoadedMainLine = useRef(false);
  const hasNavigatedToInitialPly = useRef(false);

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

  // ── Effects (game seeding, board flip, contextual PV insert) ──────────────────

  // Orient the board to the player's color once (item 5; 171 UAT gap 1). ONE
  // orientation source for BOTH modes: game mode learns the player's colour
  // from the backend (gameData.user_color), free play learns it from the URL
  // (?orientation=). Before 171-08 free play had NO orientation input at all,
  // so a bot game played as Black opened white-side-up. Black games/lines open
  // flipped; manual flips afterward win permanently (hasAutoFlipped guard).
  const autoOrientation = isGameMode ? (gameData?.user_color ?? null) : urlOrientation;

  useEffect(() => {
    if (autoOrientation === null || hasAutoFlipped.current) return;
    hasAutoFlipped.current = true;
    setBoardFlipped(autoOrientation === 'black');
  }, [autoOrientation]);

  // Game mode: seed the board once when game data arrives (L-1: never call from chip click).
  useEffect(() => {
    if (!isGameMode || gameData?.moves == null || hasLoadedMainLine.current) return;
    hasLoadedMainLine.current = true;
    loadMainLine(gameData.moves, STARTING_FEN);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameData?.moves, isGameMode]);

  // Free play: seed the opening main line from the ?line= param once. The cursor
  // lands at the end of the line (loadMainLine's default), and the user can step
  // back to move 1 through the variation tree. hasLoadedMainLine is shared with
  // game mode and the ?fen= effect below — a page is exactly one of the three,
  // never more. `rootFenSeed === null` makes precedence explicit (game_id > fen >
  // line): when both ?fen= and ?line= are present, fen wins (RESEARCH Landmine 8 —
  // without this guard, effect ordering alone would decide the winner).
  useEffect(() => {
    if (isGameMode || rootFenSeed !== null || lineSans.length === 0 || hasLoadedMainLine.current)
      return;
    hasLoadedMainLine.current = true;
    loadMainLine(lineSans, STARTING_FEN);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineSans, isGameMode, rootFenSeed]);

  // Free play: seed an arbitrary mid-game FEN snapshot from the ?fen= param once
  // (SEED-094 / D-06, additive alongside ?line=). Empty sans + the parsed FEN as
  // root seeds a free-play root at that exact position — no new hook method
  // needed. hasLoadedMainLine is shared with the other seeding effects above.
  useEffect(() => {
    if (isGameMode || rootFenSeed === null || hasLoadedMainLine.current) return;
    hasLoadedMainLine.current = true;
    loadMainLine([], rootFenSeed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootFenSeed, isGameMode]);

  // Navigate to initialPly AFTER loadMainLine state lands (separate effect — RESEARCH.md Hardest Part 3).
  // Watches mainLine.length so it fires after the batch-reset from loadMainLine.
  useEffect(() => {
    if (!isGameMode || mainLine.length === 0 || hasNavigatedToInitialPly.current) return;
    hasNavigatedToInitialPly.current = true;
    const ply = initialPly ?? 0;
    // Quick 260702-fog: if the opening ply carries a user tactic chip, open its line
    // automatically — same effect as clicking the chip (setPendingFlaw + navigate to the
    // fork node; the useTacticLines → insertPvLine graft effect below records the sideline
    // once the PV arrives). Missed forks at the decision board (ply-1), allowed at the flaw
    // position. initialAlignPly mirrors this fork so the move list top-aligns the same node.
    if (initialTactic !== null) {
      const forkNodeId = mainLine[forkPlyForOrientation(initialTactic.ply, initialTactic.orientation)];
      if (forkNodeId !== undefined) {
        setPendingFlaw(initialTactic);
        goToNode(forkNodeId);
        return;
      }
    }
    // No tactic chip here (or fork out of bounds): navigate to initialPly as before.
    // T-140-02b: L-8 guard — out-of-bounds ply is a no-op, not a crash.
    const nodeId = mainLine[ply];
    if (nodeId !== undefined) goToNode(nodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainLine.length, isGameMode]);

  // Insert contextual PV sideline when the fetch arrives (L-1: insertPvLine, not loadMainLine).
  // Quick 260703-kyb: records the new line into openLines WITHOUT touching any previously
  // open line — insertPvLine unions ids into pvNodeIds, never clobbers.
  useEffect(() => {
    if (!isGameMode || pendingFlaw == null || contextualTacticData == null) return;
    const key = flawKey(pendingFlaw);
    if (openLines.has(key)) return; // already recorded — guard against a stale re-run
    // Allowed lines start AT the flaw position and drop the prepended flaw move (index 0),
    // so the sideline begins with the opponent's response (Quick 260628-pu2 UAT). Missed
    // lines start at the decision board and use the full PV.
    const pvMoves =
      pendingFlaw.orientation === 'missed'
        ? (contextualTacticData.missed_moves ?? [])
        : (contextualTacticData.allowed_moves ?? []).slice(1);
    // T-140-02b: L-8 guard on the fork node lookup.
    const forkNodeId = mainLine[forkPlyForOrientation(pendingFlaw.ply, pendingFlaw.orientation)];
    if (forkNodeId === undefined || pvMoves.length === 0) return;
    // Snapshot the line's root id BEFORE grafting — the hook assigns nextId to the first
    // grafted node (insertPvLine's batch-build loop starts at prev.nextId).
    const rootNodeId = nextId;
    insertPvLine(pvMoves, forkNodeId);
    setOpenLines((prev) => new Map(prev).set(key, { rootNodeId, ply: pendingFlaw.ply, orientation: pendingFlaw.orientation }));
    setPendingFlaw(null);
    // mainLine/openLines/nextId intentionally omitted — mainLine is stable after game load;
    // openLines/nextId are read fresh from the latest render at the moment this effect
    // fires (triggered by pendingFlaw/contextualTacticData, already guarded above), so
    // reacting to them too would cause spurious re-runs when the user navigates the tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextualTacticData, pendingFlaw?.ply, pendingFlaw?.orientation, isGameMode]);

  // ── Derived values ────────────────────────────────────────────────────────────

  // Stockfish card loading skeleton — spins only while the standalone Stockfish
  // WASM is still initializing (155 UAT un-merge: the search runs independently
  // of the FlawChess Engine, so this no longer depends on flawChessEnabled).
  const engineLoading = engineEnabled && !engine.isReady;
  // Mirrors engineLoading: true only while the FlawChess Engine's WorkerPool/
  // MaiaQueue are still spinning up (pre-`isReady`); once ready,
  // FlawChessEngineLines handles its own pre-first-snapshot skeleton.
  const flawChessLoading = flawChessEnabled && !flawChessEngine.isReady;

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
  const grading = useStockfishGradingEngine({
    fen: gradingEnabled ? position : null,
    candidateSans: unionSans,
    enabled: gradingEnabled,
  });

  // Phase 158 (SEED-087 SC1) / Phase 162 (SEED-090 D-01): the single
  // UCI-keyed eval source every displayed Stockfish eval on this page
  // resolves through — the grading run wins by construction (module
  // precedence in buildEvalLookup), so a move graded by both sources shows
  // the deeper, depth-parity grading value; a move graded ONLY by the free
  // run still resolves to the free-run value until grading catches up.
  const evalLookup = useMemo(
    () => buildEvalLookup(engine.pvLines, grading.gradeMap, position),
    [engine.pvLines, grading.gradeMap, position],
  );

  // The grading run's own SAN keyspace converted to UCI (Pitfall 3 — the SAME
  // keyspace `qualityBySan` iterates below, NOT the broader `unionSans`, which
  // only seeds the grading run's search). Hoisted (162 UAT) because BOTH the
  // argmax below and the card's reconciled ranking (`reconciledPvLines`) rank
  // over this exact set — sharing it guarantees card line 1 === argmax.
  const gradedCandidateUcis = useMemo(() => {
    const candidateUcis: string[] = [];
    for (const san of grading.gradeMap.keys()) {
      const uci = sanToUci(position, san);
      if (uci !== null) candidateUcis.push(uci);
    }
    return candidateUcis;
  }, [grading.gradeMap, position]);

  // Tie-break toward the free run's own bestSan (converted to UCI) so a
  // genuine expected-score tie prefers the standalone Stockfish pick — shared
  // by the argmax and the card ranking (162 UAT).
  const reconciledTieBreakUci = useMemo(
    () => (bestSan !== null ? sanToUci(position, bestSan) : null),
    [bestSan, position],
  );

  // Phase 162 (SEED-090 D-03/D-11/D-10): the SINGLE canonical reconciled-best
  // UCI every downstream display consumer threads through instead of
  // re-deriving its own argmax (the Phase 158 anti-pattern this phase exists
  // to kill) — qualityBySan, the arrow, verdict, eval bar, and card all read
  // it. Re-derives fresh every render from `evalLookup` — no pinned-label
  // state (D-10: live argmax per snapshot, never a pin).
  const reconciledBestUci = useMemo(() => {
    // 162-REVIEW WR-01: with Maia off + FlawChess on, the grading union is
    // FC's top-3 only until the free run commits AND the widened union
    // re-grades — in that window the argmax ran over a candidate set that
    // cannot contain Stockfish's actual best, so the verdict/arrow/eval bar
    // could present a non-SF-best FC candidate as "Stockfish's pick" (and the
    // verdict could falsely claim alignment). Treat the argmax as unresolved
    // until the committed free-run best is itself a graded candidate — every
    // consumer already falls back to raw engine.pvLines[0] on null (the
    // existing first-paint path), which gets the move identity right.
    const freeRunBestUci = freeRunCommitted ? (engine.pvLines[0]?.moves[0] ?? null) : null;
    if (freeRunBestUci !== null && !gradedCandidateUcis.includes(freeRunBestUci)) {
      return null;
    }
    return resolveReconciledBest(evalLookup, gradedCandidateUcis, sideToMoveFromFen(position), reconciledTieBreakUci);
  }, [evalLookup, gradedCandidateUcis, position, reconciledTieBreakUci, freeRunCommitted, engine.pvLines]);

  // 162-REVIEW WR-02: the SAN form of the reconciled argmax, hoisted out of
  // qualityBySan so BOTH the chart's Best quality/label designation AND its
  // emphasized (thick) stroke key off the SAME move. Pre-fix the emphasis
  // prop stayed on the raw free-run bestSan, so the chart could thick-stroke
  // one move while coloring/naming a DIFFERENT move Best (the exact
  // mirror-image scenario this phase fixed for the label). Null (no grades
  // yet) — the chart call sites fall back to the raw bestSan.
  const reconciledBestSan = useMemo(
    () => (reconciledBestUci !== null ? bestSanFromPv(position, reconciledBestUci) : null),
    [reconciledBestUci, position],
  );

  // Phase 162 (SEED-090 D-13): a PvLine-shaped object for the reconciled-argmax
  // move, fed to FlawChessAgreementVerdict's `stockfishLine` prop so the
  // verdict's Stockfish side always names the TRUE global reconciled argmax
  // with ITS reconciled eval, never raw `engine.pvLines[0]` (RESEARCH Pitfall
  // 1: this call site bypassed evalLookup entirely pre-162). `moves` carries
  // the resolved grade's own PV when retained (162 UAT), falling back to the
  // bare root move; `depth` is the resolved grade's depth, free-run depth as
  // fallback (cosmetic only — the verdict never renders a PV's depth). null
  // when reconciledBestUci is null (grading not yet landed) — the call site
  // below falls back to `engine.pvLines[0]` so first paint still shows a value.
  const reconciledStockfishLine = useMemo<PvLine | null>(() => {
    if (reconciledBestUci === null) return null;
    const resolved = getByUci(evalLookup, reconciledBestUci);
    return {
      multipv: 1,
      depth: resolved?.depth ?? engine.depth,
      moves: resolved?.pv ?? [reconciledBestUci],
      evalCp: resolved?.evalCp ?? null,
      evalMate: resolved?.evalMate ?? null,
    };
  }, [reconciledBestUci, evalLookup, engine.depth]);

  // Phase 162 (SEED-090 D-08): the off-main-line eval bar's engine-passthrough
  // source (useGameOverlay's enginePassthrough branch) — the reconciled best's
  // eval once grading has landed for this position, else the raw free-run eval
  // (a natural lookup fallback: reconciledBestUci is null pre-grading or when
  // gradingEnabled is false, so no special-casing is needed here). Closes
  // RESEARCH Pitfall 1's second bypass — useGameOverlay's engineEvalCp/Mate/
  // Depth params previously read `engine.evalCp`/`evalMate`/`depth` raw.
  const reconciledBestEval = useMemo(() => {
    const resolved = reconciledBestUci !== null ? getByUci(evalLookup, reconciledBestUci) : null;
    return resolved ?? { evalCp: engine.evalCp, evalMate: engine.evalMate, depth: engine.depth };
  }, [reconciledBestUci, evalLookup, engine.evalCp, engine.evalMate, engine.depth]);

  // Phase 158 (SEED-087 SC1/SC3/SC4, SC5 scope fence): parallel RankedLine-
  // shaped display objects — NEVER the live MCTS-core snapshots themselves —
  // with `objectiveEvalCp`/`objectiveEvalMate` swapped for the reconciled
  // lookup value. Both are pulled from the SAME resolved grade so a forced-mate
  // root candidate surfaces `#-4` on the card + agreement verdict instead of the
  // `…` a null cp alone would print (quick 260709 — the earlier cp-only swap
  // dropped mate).
  //
  // Phase 194 JANK-03 audit fix: this used to be `{ ...line, objectiveEvalCp:
  // ..., objectiveEvalMate: ... }` — a second, previously-unaudited
  // `RankedLine` spread site that the phase's own `{\s*\.\.\.line` grep
  // missed because the `{` and `...line` fall on separate source lines.
  // Spreading forces `modalPath`/`modalStats`' lazy accessors to evaluate
  // immediately for every one of `FC_MAX_LINES` lines on every render this
  // memo recomputes. `Object.getOwnPropertyDescriptors` copies the getter
  // descriptor (laziness preserved), never the current value.
  const reconciledRankedLines = useMemo<RankedLine[]>(
    () =>
      flawChessEngine.rankedLines.slice(0, FC_MAX_LINES).map((line) => {
        const resolved = getByUci(evalLookup, line.rootMove);
        return cloneRankedLineWith(line, {
          objectiveEvalCp: resolved?.evalCp ?? null,
          objectiveEvalMate: resolved?.evalMate ?? null,
        });
      }),
    [flawChessEngine.rankedLines, evalLookup],
  );

  // Phase 196 (INJECT-06, RESEARCH.md "CORRECTED" / Pitfall 2): a second,
  // UNSLICED view of the same rankedLines, for the verdict row's lookup
  // ONLY. Eval reconciliation is deliberately NOT applied here — the
  // verdict's lookup reads only `.rootMove`/`.practicalScore`.
  // FlawChessEngineLines' visible list stays capped at FC_MAX_LINES
  // (reconciledRankedLines, unchanged above); INJECT-06 needs the lookup to
  // see every root candidate the search tracked, because per D-01 a
  // genuinely strong-but-unfindable injected move is legitimately outranked
  // out of the top 2 and must still surface its practical score.
  const flawChessRankedLinesForVerdict = useMemo<RankedLine[]>(
    () => flawChessEngine.rankedLines,
    [flawChessEngine.rankedLines],
  );

  // Phase 162 UAT (supersedes D-04/D-12's card scope): the Stockfish card's
  // lines are the top-2 of the reconciled ranking over the FULL grading union
  // — not the free run's own 2 PVs with swapped evals. This closes the D-12
  // residual edge case UAT flagged: the arrow/verdict/FC card named a
  // reconciled best (a Maia/FC-sourced candidate) that the Stockfish card
  // didn't list. PV move text comes from each grade's retained `pv` (bare
  // root move as fallback for a pre-`pv` cache entry); per-line depth is the
  // grade's own depth. Gated on `reconciledBestUci` (the WR-01 guard) so the
  // card, arrow, and verdict re-source at the same instant; until then the
  // free run's own lines render with reconciled evals, re-sorted by expected
  // score (the pre-UAT D-04 behavior, now purely the placeholder path).
  const reconciledPvLines = useMemo<PvLine[]>(() => {
    const mover = sideToMoveFromFen(position);
    if (reconciledBestUci !== null) {
      const ranked = rankReconciledCandidates(evalLookup, gradedCandidateUcis, mover, reconciledTieBreakUci);
      return ranked.slice(0, SF_MAX_LINES).map(({ uci, grade }, index) => ({
        multipv: index + 1,
        depth: grade.depth,
        moves: grade.pv ?? [uci],
        evalCp: grade.evalCp,
        evalMate: grade.evalMate,
      }));
    }
    const withReconciledEval = engine.pvLines.map((line) => {
      const uci = line.moves[0];
      const resolved = uci !== undefined ? getByUci(evalLookup, uci) : null;
      return resolved !== null ? { ...line, evalCp: resolved.evalCp, evalMate: resolved.evalMate } : line;
    });
    return [...withReconciledEval].sort(
      (a, b) =>
        evalToExpectedScore(b.evalCp, b.evalMate, mover) - evalToExpectedScore(a.evalCp, a.evalMate, mover),
    );
  }, [engine.pvLines, evalLookup, position, reconciledBestUci, gradedCandidateUcis, reconciledTieBreakUci]);

  // Phase 151.1 D-08 / Phase 158 (SEED-087 SC3): 5-bucket quality
  // classification of the RECONCILED grades (not the raw grading pass's
  // gradeMap directly) — so a move's displayed number and its severity color
  // can never disagree at a bucket boundary (covers the Maia chart line/
  // SAN-label colors, the quality-bar segments, and positionVerdict). The
  // reconciled map is built over the SAME SAN keyspace the grading pass
  // produced; an unresolved SAN (a sanToUci conversion failure) maps to a
  // null/null grade, never the raw pool grade.
  const qualityBySan = useMemo<Map<string, MoveQualityEval>>(() => {
    const reconciledGradeMap = new Map<string, MoveGrade>();
    for (const san of grading.gradeMap.keys()) {
      reconciledGradeMap.set(
        san,
        getBySan(evalLookup, position, san) ?? { evalCp: null, evalMate: null, depth: 0 },
      );
    }
    // Phase 162 (SEED-090 D-03): pass the SAN form of the single reconciled
    // argmax — NOT the free run's raw bestSan — so the chart's "Best" label
    // always agrees with the reconciled eval, closing the mirror-image bug
    // where a free-run pin could label a lower-eval move Best. Null (no
    // grades yet) falls back to classifyMoveQuality's own top-scorer.
    // (162-REVIEW WR-02: the SAN is hoisted into reconciledBestSan above so
    // the chart's emphasis stroke shares it.)
    const infoBySan = classifyMoveQuality(reconciledGradeMap, sideToMoveFromFen(position), reconciledBestSan);
    const merged = new Map<string, MoveQualityEval>();
    for (const [san, info] of infoBySan) {
      const grade = reconciledGradeMap.get(san);
      merged.set(san, {
        quality: info.quality,
        evalCp: grade?.evalCp ?? null,
        evalMate: grade?.evalMate ?? null,
      });
    }
    return merged;
  }, [evalLookup, grading.gradeMap, position, reconciledBestSan]);

  // Phase 163 (SEED-092): recolors the CURRENT position's reconciled-best candidate
  // as 'gem'/'great' — feeds ONLY the chart/bar display sites (MaiaHumanPanel
  // below), never positionVerdict/the FlawChess card (those stay on the base
  // qualityBySan; the gem/great override is a display concern only). Distinct
  // from the gem block below (~liveFlawByNode section): this memo is
  // forward-looking over the CURRENT position's own candidates, while that block
  // classifies the ARRIVAL move that reached the current node against the PARENT
  // position (graded on demand). Stable ref (returns qualityBySan unchanged) when
  // no gem/great qualifies, so consumers memoized on it don't re-render needlessly.
  //
  // Phase 175 (SEED-108 D-01/D-03, Pitfall 3): for a mainline position of an
  // analyzed game, the STORED tier of the NEXT mainline move — the move about
  // to be played from here, at ply `mainlinePlyHere + 1` — is authoritative
  // and consulted FIRST. `classify_best_move` only ever stores a row for an
  // out-of-book BEST-move ply, so a stored gem/great can only ever match the
  // engine's reconciled-best candidate; the `nextNode?.san === reconciledBestSan`
  // check confirms that agreement rather than assuming it. A null/absent
  // stored row for an analyzed game's next ply is itself the authoritative
  // "not a gem/great" answer — the live classifyGem fallback below is never
  // consulted in that case.
  const qualityBySanWithGem = useMemo<Map<string, MoveQualityEval>>(() => {
    if (reconciledBestSan === null) return qualityBySan;

    const onMainlineHere = currentNodeId === null || isOnMainLine(currentNodeId);
    if (onMainlineHere) {
      const mainlinePlyHere = currentNodeId !== null ? mainLine.indexOf(currentNodeId) : -1;
      const nextPly = mainlinePlyHere + 1;
      const nextNodeId = mainLine[nextPly];
      const nextNode = nextNodeId !== undefined ? nodes.get(nextNodeId) : undefined;
      // Quick 260719-m5g: the stored-data short-circuit below is authoritative ONLY
      // when the user actually PLAYED the engine best move at this ply.
      // classify_best_move only ever writes a game_best_moves row for a played==best
      // ply, so a missing stored row means "the move the user PLAYED here was not a
      // gem/great" — it says NOTHING about whether the engine best move (which the
      // user did NOT play) would be a gem. When the played move was non-best (e.g.
      // Rc7?? while Kd3 was best), fall through to the live classifyGem fallback so
      // the card marks reconciledBestSan as a gem BEFORE it is played, matching the
      // on-board gemByNode badge that appears once it IS played.
      const playedBestHere = nextNode?.san === reconciledBestSan;
      const stored = storedTierByPly.get(nextPly);
      if (stored !== undefined && playedBestHere) {
        const bestInfo = qualityBySan.get(reconciledBestSan);
        if (!bestInfo) return qualityBySan;
        const next = new Map(qualityBySan);
        next.set(reconciledBestSan, { ...bestInfo, quality: stored.tier });
        return next;
      }
      if (gameHasStoredBestMoveData && playedBestHere) return qualityBySan; // Pitfall 3: authoritative only for the played-best move
    }

    // Quick 260719-m5g: pin the gem's Maia rung to the MOVER's rating-at-game-time
    // (Phase 172 / SEED-106 D-01 — the gem rung is a property of the GAME, never the
    // reactive ELO slider), matching the on-board gemByNode badge (pinnedEloForMover)
    // so the card's pre-play gem and the post-play badge cannot disagree. The live
    // exploration overlays (Maia chart / WDL bar / FlawChess Engine) keep using
    // selectedElo — only gem CLASSIFICATION is pinned here.
    const rung = nearestByElo(maia.perElo, pinnedEloForMover(sideToMoveFromFen(position)));
    const maiaProb = rung?.moveProbabilities[reconciledBestSan] ?? null;
    // Bug fix (163-REVIEW WR-01): verify the summarized argmax IS the move we are
    // about to recolor instead of hard-coding playedIsBest: true. When the
    // summarize argmax diverges from reconciledBestSan (tie-break drift, or a
    // partially graded map), classifyGem would otherwise evaluate the argmax
    // pair's gap while a DIFFERENT move gets painted violet — a false gem.
    // Mirrors the arrival-move path's own `bestSan === playedSan` check (gem
    // block below).
    const { bestSan, bestEs, secondBestEs } = summarizeForGem(
      qualityBySan,
      sideToMoveFromFen(position),
    );
    const isGem = classifyGem({
      maiaProbability: maiaProb,
      playedIsBest: bestSan === reconciledBestSan,
      bestEs,
      secondBestEs,
    });
    if (!isGem) return qualityBySan;
    const bestInfo = qualityBySan.get(reconciledBestSan);
    if (!bestInfo) return qualityBySan;
    const next = new Map(qualityBySan);
    next.set(reconciledBestSan, { ...bestInfo, quality: 'gem' });
    return next;
  }, [
    qualityBySan,
    reconciledBestSan,
    maia.perElo,
    pinnedEloForMover,
    position,
    currentNodeId,
    isOnMainLine,
    mainLine,
    nodes,
    storedTierByPly,
    gameHasStoredBestMoveData,
  ]);

  // The FlawChess Engine's top practical pick — its root move's SAN + reconciled
  // white-POV objective eval — shown as the pinned "FlawChess" reference row atop
  // the Maia chart tooltip (quick 260710-e2p). Sourced ONLY from the FlawChess
  // Engine (reconciledRankedLines[0]), NEVER standalone Stockfish: the row is
  // labeled "FlawChess", so pinning Stockfish's objective best there mislabeled it
  // as FlawChess (the two diverge exactly when FlawChess trades objective eval for
  // human findability, e.g. exd6 over Rad1). Empty — which drops the pinned row —
  // when the FlawChess Engine is off or has no ranked line yet, rather than falling
  // back to a mislabeled Stockfish pick. Reconciled objective eval matches the FC
  // card's blue objective aside; the FlawChess source carries mate via the same
  // reconciled lookup (objectiveEvalMate), so a forced-mate root prints "#-N".
  const engineTopLines = useMemo<EngineLine[]>(() => {
    if (!flawChessEnabled) return [];
    const top = reconciledRankedLines[0];
    if (!top) return [];
    const san = bestSanFromPv(position, top.rootMove);
    if (san === null) return [];
    return [{ san, evalCp: top.objectiveEvalCp, evalMate: top.objectiveEvalMate }];
  }, [position, flawChessEnabled, reconciledRankedLines]);

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

  // Flaw marker map for VariationTree: keyed by mainLine nodeId.
  // Only entries with a tactic chip or blunder/mistake severity are included (D-02, D-03).
  const flawMarkerByNodeId = useMemo<Map<NodeId, FlawMarkerEntry>>(() => {
    const map = new Map<NodeId, FlawMarkerEntry>();
    if (!isGameMode || gameData?.flaw_markers == null) return map;
    // Quick 260628-1t5 (reverting e116912c item 5): the missed chip goes back onto the
    // flaw node mainLine[ply], together with the allowed chip + severity glyph — a single
    // entry per flaw node, no decision-node (ply-1) split.
    for (const fm of gameData.flaw_markers) {
      // noUncheckedIndexedAccess guard (T-140-02b): skip out-of-range plies.
      const nodeId = mainLine[fm.ply];
      if (nodeId === undefined) continue;
      // Quick 260628-u7d follow-up: opponent tactic tags are surfaced in the eval-chart
      // tooltip (built separately in EvalChart) but NOT in the move list — suppress the
      // opponent's motifs here. Severity glyphs stay both-color (pre-existing behavior).
      const missedMotif = fm.is_user ? fm.missed_tactic_motif : null;
      const allowedMotif = fm.is_user ? fm.allowed_tactic_motif : null;
      const sev = fm.severity;
      if (missedMotif !== null || allowedMotif !== null || sev === 'blunder' || sev === 'mistake') {
        map.set(nodeId, {
          missedMotif,
          allowedMotif,
          missedDepth: fm.is_user ? fm.missed_tactic_depth : null,
          allowedDepth: fm.is_user ? fm.allowed_tactic_depth : null,
          severity: sev,
          ply: fm.ply,
        });
      }
    }
    return map;
  }, [isGameMode, gameData, mainLine]);

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

  // Phase 175 (SEED-108 D-01/D-03): a resolved gem OR great marker for a
  // (nodeId, ply) pair — from either the stored backend tier or the live
  // fallback (see resolveMarkerFor below). `elo` is null only when a stored
  // marker's mover color couldn't be resolved (should not happen in
  // practice — fenAtPly always has an entry for a real mainline ply).
  type ResolvedMarker = {
    tier: 'gem' | 'great';
    maiaProbability: number;
    elo: number | null;
    byOpponent: boolean;
  };

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
  const sweep = useGemSweep({
    enabled: sweepArmedForGame && evalChartReady && gradingEnabled && !gameHasStoredBestMoveData,
    sweepKey: gameId,
    candidates: sweepCandidates,
    pinnedEloForPly,
    liveBusy: liveEnginesBusy,
    userColor: sweepUserColor,
  });

  // Syncs sweepResolvedPlies (above) from the sweep's own state — runs AFTER
  // `sweep` so this can never be the thing `needParentGemGrade` depends on in
  // the SAME render (breaking the circularity noted above).
  useEffect(() => {
    setSweepResolvedPlies(new Set(sweep.gemByPly.keys()));
  }, [sweep.gemByPly]);

  // Phase 175 (SEED-108 D-01/D-03, Pitfall 2/3): resolve the gem/GREAT marker
  // for a node with the FULL documented precedence — the STORED backend tier
  // (present or authoritatively null, per storedTierByPly/gameHasStoredBest-
  // MoveData above) wins for any mainline ply of an analyzed game, consulted
  // BEFORE the live fallback. Only when there is no stored answer for this
  // (nodeId, ply) — off-mainline, free-play, or an unanalyzed game — does this
  // fall through to the Phase 172 CR-01 live precedence: the live per-node
  // resolution (gemByNode) is AUTHORITATIVE the moment it has graded this
  // node, INCLUDING an explicit `null` "graded, not a gem" verdict; the
  // background sweep (sweep.gemByPly) is a FALLBACK only, consulted solely
  // when the live path has no answer. A `gemByNode.get(id) ?? sweep.gemByPly.
  // get(ply)` collapse cannot express that (`null ?? x === x`), which let the
  // sweep's shallower grade overrule a deeper live rejection — resolveGemVerdict
  // (gemSweep.ts) is the shared helper that gets this right. Both the board
  // badge and the move-list fold route through here so ALL of this precedence
  // lives in exactly one place.
  const resolveMarkerFor = useCallback(
    (nodeId: NodeId, ply: number): ResolvedMarker | null => {
      if (ply >= 0) {
        const stored = storedTierByPly.get(ply);
        if (stored !== undefined) {
          const fen = fenAtPly(ply);
          const mover = fen !== null ? sideToMoveFromFen(fen) : null;
          const userColor = gameData?.user_color;
          return {
            tier: stored.tier,
            maiaProbability: stored.maiaProb,
            elo: mover !== null ? pinnedEloForMover(mover) : null,
            byOpponent: isGameMode && userColor != null && mover !== null && mover !== userColor,
          };
        }
        // Pitfall 3: an analyzed game's mainline ply with no stored row is an
        // authoritative "not a gem/great" — the live fallback is never
        // consulted for it.
        if (gameHasStoredBestMoveData) return null;
      }
      const gemDetail = resolveGemVerdict(gemByNode, sweep.gemByPly, nodeId, ply);
      return gemDetail !== null ? { tier: 'gem', ...gemDetail } : null;
    },
    [
      storedTierByPly,
      fenAtPly,
      pinnedEloForMover,
      isGameMode,
      gameData?.user_color,
      gameHasStoredBestMoveData,
      gemByNode,
      sweep.gemByPly,
    ],
  );

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

  // When the parent grade completes, run C2 and RESOLVE the node: stamp the gem
  // detail on a pass, or an explicit null on a miss (so it is never re-graded).
  useEffect(() => {
    if (!needParentGemGrade || currentNodeId === null || parentFen === null) return;
    // Wait for a COMPLETE parent pass keyed to the parent FEN (gradeMapFen guards
    // against the one-commit-late clear, mirroring the Maia cache's WR-03 guard).
    if (gemGrading.gradeMapFen !== parentFen || gemGrading.isGrading) return;
    if (gemGrading.gradeMap.size === 0) return;

    const gradeBySan = new Map<string, { evalCp: number | null; evalMate: number | null }>();
    for (const [san, g] of gemGrading.gradeMap) {
      gradeBySan.set(san, { evalCp: g.evalCp, evalMate: g.evalMate });
    }
    const mover = sideToMoveFromFen(parentFen);
    const { bestSan, bestEs, secondBestEs } = summarizeForGem(gradeBySan, mover);
    const playedSan = nodes.get(currentNodeId)?.san ?? null;
    const parentCurve = maiaCurveByFen.get(parentFen);
    // Phase 172 (SEED-106 D-01): pinned to the MOVER's own rating-at-game-time —
    // `mover` above is already "whoever actually made this move", the same
    // variable byOpponent (below) uses. The stamped GemDetail.elo reports this
    // pinned rung (the popover's "At N ELO" line), never the live ELO slider.
    const pinnedElo = pinnedEloForMover(mover);
    const maiaProbability =
      playedSan !== null
        ? nearestByElo(parentCurve ?? [], pinnedElo)?.moveProbabilities[playedSan] ?? null
        : null;
    const isGem = classifyGem({
      maiaProbability,
      playedIsBest: bestSan === playedSan,
      bestEs,
      secondBestEs,
    });
    // The mover made the move; in game mode it's the opponent when it isn't the
    // user's color. Free play has no opponent, so this stays false there.
    const byOpponent =
      isGameMode && gameData?.user_color != null && mover !== gameData.user_color;
    // classifyGem === true guarantees maiaProbability is non-null (it rejects a
    // null probability), so the detail's number is safe.
    const detail: GemDetail | null =
      isGem && maiaProbability !== null ? { maiaProbability, elo: pinnedElo, byOpponent } : null;
    setGemByNode((prev) => {
      if (prev.has(currentNodeId)) return prev; // already resolved — first wins
      const next = new Map(prev);
      next.set(currentNodeId, detail);
      if (next.size > LIVE_EVAL_CACHE_MAX) {
        const oldest = next.keys().next().value;
        if (oldest !== undefined) next.delete(oldest);
      }
      return next;
    });
  }, [
    needParentGemGrade,
    currentNodeId,
    parentFen,
    gemGrading.gradeMap,
    gemGrading.gradeMapFen,
    gemGrading.isGrading,
    nodes,
    maiaCurveByFen,
    pinnedEloForMover,
    isGameMode,
    gameData?.user_color,
  ]);

  // Move-list marker map (item 1, Quick 260628-1t5): merge the game-mode flaw markers with
  // the live free-move severity for the CURRENT node, so a freely-played blunder/mistake
  // paints the same glyph in the move list as on the board (single source — liveFlaw's own
  // squareMarker severity — so list and board can never disagree). Only blunder/mistake get
  // a glyph (inaccuracy/clean show none, matching the main-line behavior). The live entry is
  // NOT gated by game mode — it must also surface in free-play mode (where flawMarkerByNodeId
  // is empty). When there is no live flaw the original map is returned unchanged (stable ref).
  const moveListMarkers = useMemo<Map<NodeId, FlawMarkerEntry>>(() => {
    const liveSeverity = liveFlaw.squareMarkers[0]?.severity;
    const showCurrentLive =
      currentNodeId !== null && (liveSeverity === 'blunder' || liveSeverity === 'mistake');
    const hasGemWork = gemByNode.size > 0;
    // Phase 172 (SEED-106 D-04/D-05): the background sweep's own gem source.
    const hasSweepWork = sweep.gemByPly.size > 0;
    // Phase 175 (SEED-108 D-01/D-03): the stored backend tier's own source.
    const hasStoredWork = storedTierByPly.size > 0;
    // Phase 172 (SEED-106 D-08): a game with a nonzero opening_ply_count has
    // book markers to paint even when nothing else in this memo has work.
    const hasBookWork = (gameData?.opening_ply_count ?? 0) > 0;
    if (
      liveFlawByNode.size === 0 &&
      !showCurrentLive &&
      !hasGemWork &&
      !hasSweepWork &&
      !hasStoredWork &&
      !hasBookWork
    ) {
      return flawMarkerByNodeId;
    }

    const mainLineSet = new Set(mainLine);
    const merged = new Map(flawMarkerByNodeId);
    const addLive = (nodeId: NodeId, severity: FlawSeverity): void => {
      if (merged.has(nodeId)) return; // game/PV flaw entry wins (keeps its tactic chips)
      if (mainLineSet.has(nodeId)) return; // stale id reused as a main-line node after reload
      if (!nodes.has(nodeId)) return; // node deleted (e.g. a collapsed PV fork)
      merged.set(nodeId, {
        missedMotif: null,
        allowedMotif: null,
        missedDepth: null,
        allowedDepth: null,
        severity,
        ply: NO_GAME_PLY, // free-move entries carry no game ply (IN-04)
      });
    };
    // Persisted sideline classifications first, then the current node's in-flight one.
    for (const [nodeId, severity] of liveFlawByNode) addLive(nodeId, severity);
    if (currentNodeId !== null && (liveSeverity === 'blunder' || liveSeverity === 'mistake')) {
      addLive(currentNodeId, liveSeverity);
    }

    // Phase 163 (SEED-092 D-05/D-06), extended Phase 175 (SEED-108) with
    // great: fold resolved gem/great entries into the SAME map — unlike
    // addLive above, this has NO mainLineSet exclusion. gemActive covers
    // mainline AND free-variation nodes (D-05), and moveListMarkers is the ONLY
    // map VariationTree reads, so excluding mainline ids here would silently
    // drop mainline gem/great badges from the move list. Merging onto a
    // severity-free entry (e.g. a tactic-chips-only game entry) keeps its
    // chips and adds the gem/great.
    const addMarker = (nodeId: NodeId, ply: number, detail: ResolvedMarker): void => {
      if (!nodes.has(nodeId)) return; // node deleted (e.g. a collapsed PV fork)
      const existing = merged.get(nodeId);
      if (existing?.gem || existing?.great) return; // already flagged
      // Bug fix (163-REVIEW WR-05, move-list side): a backend/live severity entry on
      // the same node wins — one move never renders two badges. "Mutually exclusive
      // by construction" only holds within the live pipeline; a BACKEND severity
      // (server Stockfish) and the live WASM gem/great can legitimately disagree.
      if (existing?.severity != null) return;
      const base =
        existing ??
        // IN-04 fix: `ply` is the REAL mainline/sweep ply whenever one is
        // known (markerNodePlies below only falls back to NO_GAME_PLY for a
        // genuine free-variation node) — never a synthesized -1 that discards
        // information the caller actually had.
        {
          missedMotif: null,
          allowedMotif: null,
          missedDepth: null,
          allowedDepth: null,
          ply,
        };
      if (detail.tier === 'great') {
        merged.set(nodeId, {
          ...base,
          great: true,
          // The detection-time rung + probability + who played it, for the
          // move-list great popover.
          greatMaiaProbability: detail.maiaProbability,
          greatElo: detail.elo ?? undefined,
          greatByOpponent: detail.byOpponent,
        });
      } else {
        merged.set(nodeId, {
          ...base,
          gem: true,
          // The detection-time rung + probability + who played it, for the
          // move-list gem popover.
          gemMaiaProbability: detail.maiaProbability,
          gemElo: detail.elo ?? undefined,
          gemByOpponent: detail.byOpponent,
        });
      }
    };
    // Phase 175 (SEED-108 D-01/D-03), extending Phase 172 (SEED-106 CR-01/
    // D-04/D-05): fold every mainline ply carrying a STORED tier, every live
    // per-node resolution, AND the background sweep's resolved gems through
    // the SHARED `resolveMarkerFor` precedence (stored wins over live, live
    // wins over the sweep for any node it has graded — INCLUDING an explicit
    // `null` rejection, in which case the sweep is never consulted for that
    // node). Build the candidate node set: every stored-tier mainline ply
    // FIRST (its REAL ply — IN-04), then every gemByNode key not already
    // covered (its own resolved mainline ply when it has one, else the
    // NO_GAME_PLY sentinel for a genuine free-variation node), then any
    // sweep-only mainline ply the live path has NOT graded. sweep.gemByPly is
    // keyed by ply index into mainLine and is NOT gemByNode (Pitfall 4 — the
    // sweep has its OWN cache, bounded by candidates.length, never the shared
    // FIFO-256-capped map); display reads the union, nothing is copied between them.
    const markerNodePlies = new Map<NodeId, number>();
    mainLine.forEach((nodeId, plyIndex) => {
      if (storedTierByPly.has(plyIndex)) markerNodePlies.set(nodeId, plyIndex);
    });
    for (const nodeId of gemByNode.keys()) {
      if (markerNodePlies.has(nodeId)) continue;
      const idx = mainLine.indexOf(nodeId);
      markerNodePlies.set(nodeId, idx >= 0 ? idx : NO_GAME_PLY);
    }
    for (const plyIndex of sweep.gemByPly.keys()) {
      const nodeId = mainLine[plyIndex];
      if (nodeId === undefined || markerNodePlies.has(nodeId)) continue;
      markerNodePlies.set(nodeId, plyIndex);
    }
    for (const [nodeId, ply] of markerNodePlies) {
      const detail = resolveMarkerFor(nodeId, ply);
      if (detail !== null) addMarker(nodeId, ply, detail); // null = absent or graded-and-rejected
    }

    // Phase 172 (SEED-106 D-08): book markers — LOWEST precedence in
    // severity > gem/great > book. Only MAINLINE plies before opening_ply_count
    // qualify (free-variation nodes are never in book — D-04 skips book plies
    // before they can even become sweep/gem candidates). Must not overwrite an
    // existing entry that will actually RENDER a glyph — but the move-list's
    // resolveMarkerIcon only draws blunder/mistake severities, NOT inaccuracy
    // (there is no inaccuracy glyph there, unlike the board's `!?`). WR-04 fix:
    // an inaccuracy-severity book ply was suppressed here yet rendered nothing,
    // leaving the ply blank. Defer only to entries that draw an icon (blunder,
    // mistake, gem, great) so an inaccuracy-only book ply falls through to the
    // book badge.
    const openingPlyCount = gameData?.opening_ply_count ?? 0;
    if (openingPlyCount > 0) {
      mainLine.forEach((nodeId, plyIndex) => {
        if (plyIndex >= openingPlyCount) return;
        if (!nodes.has(nodeId)) return; // node deleted (e.g. a collapsed PV fork)
        const existing = merged.get(nodeId);
        if (
          existing?.severity === 'blunder' ||
          existing?.severity === 'mistake' ||
          existing?.gem === true ||
          existing?.great === true
        )
          return;
        merged.set(nodeId, {
          ...(existing ?? {
            missedMotif: null,
            allowedMotif: null,
            missedDepth: null,
            allowedDepth: null,
            ply: plyIndex, // IN-04 fix: the real ply index, never a synthesized -1
          }),
          book: true,
        });
      });
    }

    return merged;
  }, [
    flawMarkerByNodeId,
    liveFlaw,
    currentNodeId,
    liveFlawByNode,
    mainLine,
    nodes,
    gemByNode,
    sweep.gemByPly,
    storedTierByPly,
    resolveMarkerFor,
    gameData?.opening_ply_count,
  ]);

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
        const fcSquares = uciToSquares(flawChessEngine.rankedLines[i]?.rootMove ?? null);
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
        const sfUci = reconciledBestUci ?? engine.pvLines[i]?.moves[0] ?? null;
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
  }, [flawChessEnabled, flawChessEngine.rankedLines, engineEnabled, engine.pvLines, reconciledBestUci]);

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
          loadMainLine([], rootFen);
        }
      };

  const canReset = currentNodeId !== null;

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
    if (nodeId !== undefined) goToNode(nodeId);
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
  // with the Stockfish (white-POV) bar and the board orientation. 0.5 while unresolved.
  const maiaWhiteFraction =
    maia.expectedScoreAtSelectedElo === null
      ? 0.5
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
  const fcWhiteFraction = topLine
    ? sideToMoveFromFen(position) === 'white'
      ? topLine.practicalScore
      : 1 - topLine.practicalScore
    : 0.5;
  // A terminal position pins the left bar to the deterministic result too: neither the
  // FlawChess nor the Maia engine emits a ranked line for a checkmate (no legal move),
  // so their fraction fell back to 0.5 while the Stockfish bar already read decisive
  // (Quick 260709-j3k follow-up). mate > 0 = White wins (full white), < 0 = Black wins
  // (full black), draw = midpoint.
  const terminalWhiteFraction =
    terminalEval == null
      ? null
      : terminalEval.mate != null
        ? terminalEval.mate > 0
          ? 1
          : 0
        : 0.5;
  const leftEvalBarWhiteFraction =
    terminalWhiteFraction ?? (flawChessEnabled ? fcWhiteFraction : maiaWhiteFraction);
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
  const boardStageRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(0);
  // Full rendered height of the board group (caps + board + player rows + controls,
  // plus the eval chart on desktop). Only consumed by the mid layout, where the left
  // column IS this group, so the right-column tab panel can be sized to match it exactly
  // (taller than the bare board — otherwise the tabs stop at the board's bottom edge and
  // the Maia chart / verdict get clipped short of the controls).
  const [boardStageHeight, setBoardStageHeight] = useState(0);
  useEffect(() => {
    const stage = boardStageRef.current;
    if (!stage) return; // mobile tree: the desktop stage is not mounted; boardWidth is unused there.
    const measure = (): void => {
      const el = boardStageRef.current;
      if (!el) return;
      // Desktop layout = the ≥1200px band (the desk3col 3-column grid). The height
      // budget only additionally binds once tall enough (`locked`).
      const isDesktopWidth = window.matchMedia(`(min-width:${BOARD_WIDTH_LOCK_MIN_PX}px)`).matches;
      const locked =
        isDesktopWidth && window.matchMedia(`(min-height:${BOARD_HEIGHT_LOCK_MIN_PX}px)`).matches;
      // Non-board "chrome" (source caps + player rows + eval chart + gaps) shares the board's
      // vertical budget, so subtract it. Derived from the DOM as (group height − board box
      // height) rather than the boardWidth STATE, so it carries no stale closure and settles
      // in one pass: group height = chrome + board box height, so the difference is exactly
      // the chrome regardless of the current board size.
      const group = el.firstElementChild;
      const boardBoxHeight = containerRef.current?.clientHeight ?? 0;
      const chrome = group ? Math.max(0, group.clientHeight - boardBoxHeight) : 0;
      // Full group height (board + caps + player rows + controls) — the mid layout sizes
      // its right-column tab panel to this so the tabs run the full height of the board
      // block, bottoming out at the board-controls card rather than the board's edge.
      setBoardStageHeight(group ? group.clientHeight : 0);
      // Reserve the bars allowance AND both slider-slack margins so the board group ends up
      // narrower than its track and centers with EVAL_SLIDER_SLACK_PX of breathing room on
      // each side — room the eval-chart slider's thumb overhang needs to avoid being clipped.
      const widthBudget = el.clientWidth - BOARD_EVAL_BARS_ALLOWANCE_PX - EVAL_SLIDER_SLACK_PX * 2;
      const heightBudget = locked ? el.clientHeight - chrome : Infinity;
      const raw = computeBoardSize(widthBudget, heightBudget, BOARD_MAX_WIDTH);
      // UAT 179: draw the desktop board 20px smaller than its natural fit (floored at
      // BOARD_MIN_WIDTH). Applied to the final size so it's visible whichever constraint
      // binds; mid/mobile (isDesktopWidth false) are untouched.
      const desktopBoard = Math.max(BOARD_MIN_WIDTH, raw - DESKTOP_BOARD_SIZE_REDUCTION_PX);
      // Bug fix: in a ~35px viewport band just above the desk3col breakpoint the fluid 1fr
      // track is narrow enough that widthBudget drops below BOARD_MIN_WIDTH. The floor above
      // then pins the board at 420 while the group (board + BOARD_EVAL_BARS_ALLOWANCE_PX)
      // exceeds the track, so desk3col:overflow-hidden clipped the two flanking eval bars to
      // slivers. widthBudget already reserves the bars + slider slack, so cap the floored
      // board to it: the board shrinks below the readability floor in that narrow band
      // (accepted trade-off) rather than the bars getting cut off. raw=0 (zero-budget guard)
      // keeps board 0 so ChessBoard's `boardWidth > 0` render gate still fires.
      setBoardWidth(isDesktopWidth ? Math.min(desktopBoard, widthBudget) : raw);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    // A viewport resize that crosses the width/height lock thresholds also flips the
    // `locked` branch above; observe window resize too so those crossings recompute even
    // if the stage's own box happens not to change on the same frame.
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
    // containerRef is a stable ref object; listed to satisfy exhaustive-deps without churn.
    // isGameMode/gameData: the board-group chrome (player bars + eval chart) mounts
    // ASYNChronously once the game loads, but the ResizeObserver watches the fixed-size
    // stage box and never fires on that inner growth — so without a re-measure here the
    // board stays sized for the pre-load (chrome-less) group and the now-taller group
    // overflows the stage, producing a spurious vertical scrollbar (Phase 161 UAT). Re-run
    // on those transitions so the height budget re-subtracts the real chrome and refits.
    // layoutMode (not just isMobile): the desktop stage mounts in BOTH the mid and desktop
    // trees, so crossing the desk3col breakpoint remounts it — re-run to re-observe the new
    // stage node (else the observer stays bound to the unmounted one and boardWidth goes stale).
  }, [layoutMode, containerRef, isGameMode, gameData]);

  // Left eval bar — FlawChess Engine (brown) when enabled (D-04 precedence), else Maia
  // (violet, D-01/D-05, SURF-04). Single expected-score fill: both sources bypass the cp
  // sigmoid entirely via whiteFraction. 0.5 fallback while neither source has a result yet.
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

  // Phase 163 (SEED-092 D-06): the board's own gem badge — appended to whichever
  // base squareMarkers source (precomputed game overlay or live free-move
  // classification) is currently active. Reads the sticky per-node resolution
  // (gemByNode) for the CURRENT node, the SAME source the move list uses — so the
  // two can never disagree, and the badge shows the moment the on-demand parent
  // grade resolves rather than depending on grade-timing at navigation. A `null`
  // value is a graded-and-rejected node (no badge). Note (behavior change from the
  // old live D-03 read): the badge is now sticky at its detection ELO rather than
  // re-evaluating C1 on every ELO-slider tick — it matches the move list, and the
  // popover already discloses the detection ELO. Phase 172 (SEED-106 D-01): the
  // gem rung is now pinned to the mover's own rating-at-game-time, not the live
  // selectedElo — an ELO-slider change no longer newly qualifies or un-qualifies
  // any node; pinning is what makes a background sweep cacheable at all.
  const boardSquareMarkers = useMemo(() => {
    const base =
      gameOverlay.squareMarkers.length > 0 ? gameOverlay.squareMarkers : liveFlaw.squareMarkers;
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
    // Bug fix (163-REVIEW WR-05): in game mode the base can carry a BACKEND-
    // precomputed severity marker on lastMove.to (server-side Stockfish), while
    // the gem/great's C2 comes from the frontend WASM pass (or the backend's
    // own classifier for the stored path) — the two evals can diverge by
    // design (documented eval non-determinism), so "mutually exclusive by
    // construction" doesn't hold across pipelines. One square never renders two
    // badges: an existing severity marker wins, the gem/great yields.
    const withMarker =
      markerHere !== null && // non-null resolution = confirmed gem/great
      lastMove != null &&
      !base.some((m) => m.square === lastMove.to && m.severity != null)
        ? [
            ...base,
            markerHere.tier === 'great'
              ? { square: lastMove.to, great: true }
              : { square: lastMove.to, gem: true },
          ]
        : base;

    // Quick 260717-rbn: best/good — the same defensive precedence the gem/
    // great block above uses (yields to any existing severity/gem/great
    // marker on the square), appended only for the current MAINLINE ply.
    const bestGoodTier =
      currentMainlinePly >= 0 ? storedBestGoodByPly.get(currentMainlinePly) : undefined;
    const withBestGood =
      bestGoodTier != null &&
      lastMove != null &&
      !withMarker.some(
        (m) => m.square === lastMove.to && (m.severity != null || m.gem === true || m.great === true),
      )
        ? [
            ...withMarker,
            bestGoodTier === 'best'
              ? { square: lastMove.to, best: true }
              : { square: lastMove.to, good: true },
          ]
        : withMarker;

    // Phase 172 (SEED-106 D-08): book marker — LOWEST precedence in
    // severity > gem/great > best/good > book. Appended only when the current
    // node is a MAINLINE ply inside the book AND the square carries none of
    // severity/gem/great/best/good.
    const isBookPly =
      currentMainlinePly >= 0 &&
      gameData?.opening_ply_count != null &&
      currentMainlinePly < gameData.opening_ply_count;
    if (
      isBookPly &&
      lastMove != null &&
      !withBestGood.some(
        (m) =>
          m.square === lastMove.to &&
          (m.severity != null ||
            m.gem === true ||
            m.great === true ||
            m.best === true ||
            m.good === true),
      )
    ) {
      return [...withBestGood, { square: lastMove.to, book: true }];
    }
    return withBestGood;
  }, [
    gameOverlay.squareMarkers,
    liveFlaw.squareMarkers,
    resolveMarkerFor,
    currentNodeId,
    currentMainlinePly,
    lastMove,
    gameData?.opening_ply_count,
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
    />
  );

  // Mobile board row — purely width-driven square that fills the takeover width. No
  // heightRef: the mobile page scrolls (no viewport height lock), so the board sizes to its
  // flex-1 container width alone. The bars (items-stretch) match the board's height and the
  // board fills its container, so the bars hug it. Desktop uses the JS-sized stage below.
  const boardRow = (
    <div className="flex flex-row items-stretch gap-2">
      {leftEvalBarNode()}
      <div ref={containerRef} data-testid="analysis-board" tabIndex={0} className="min-w-0 flex-1">
        {chessBoardNode()}
      </div>
      {rightEvalBarNode()}
    </div>
  );

  // Player info row (desktop, game mode): name + ELO left, remaining clock right.
  // Rendered above and below the board, ordered by orientation (Quick 260628-pcb).
  const playerBar = (color: 'white' | 'black') => (
    <PlayerBar
      isWhite={color === 'white'}
      name={(color === 'white' ? gameData?.white_username : gameData?.black_username) ?? null}
      rating={(color === 'white' ? gameData?.white_rating : gameData?.black_rating) ?? null}
      clockSeconds={color === 'white' ? playerClocks.white : playerClocks.black}
      testId={`analysis-player-${color}`}
    />
  );

  // Small source cap centered over an eval bar (151.1 UAT): "FC"/"Maia" (brown/
  // violet) over the left bar per D-04 precedence, "SF" (blue) over the right.
  // "Maia" is wider than the w-5 slot and overflows symmetrically — the ~7px
  // right overflow stays inside the gap-2 to the player name, and the left
  // overflow lands in the inter-column gutter. Common Pitfall 4: keep the new
  // "FC" cap at the existing text-xs size — do not introduce text-sm here.
  const evalBarCap = (text: 'Maia' | 'SF' | 'FC', color: string) => (
    // text-xs (below the usual text-sm floor) — a tiny bar cap acting as a visual
    // aside, per UAT "make the labels smaller". leading-none keeps the row compact.
    <span className="whitespace-nowrap text-xs font-medium leading-none" style={{ color }}>
      {text}
    </span>
  );

  // Eval-bar-width flanking slot — matches boardRow's `w-5` bars + `gap-2` so the
  // center content lines up exactly with the board's left/right edges.
  const evalBarSlot = (content: ReactNode) => (
    <div className="flex w-5 shrink-0 justify-center">{content}</div>
  );

  // Row flanking the board with the source caps, its center aligned to the board
  // edges. `player` renders the name/clock line (game mode); free play passes null
  // to show the caps alone over the bars.
  const boardHeaderRow = (player: ReactNode) => (
    <div className="flex flex-row items-center gap-2">
      {evalBarSlot(
        flawChessEnabled
          ? evalBarCap('FC', FLAWCHESS_ENGINE_ACCENT)
          : evalBarCap('Maia', MAIA_ACCENT),
      )}
      <div className="min-w-0 flex-1">{player}</div>
      {evalBarSlot(evalBarCap('SF', STOCKFISH_ACCENT))}
    </div>
  );

  // Bottom player row: same board-edge alignment as the header, no caps.
  const boardFooterRow = (player: ReactNode) => (
    <div className="flex flex-row items-center gap-2">
      {evalBarSlot(null)}
      <div className="min-w-0 flex-1">{player}</div>
      {evalBarSlot(null)}
    </div>
  );

  // VariationTree props — shared between the desktop side panel and the mobile Moves tab.
  // The mobile tab passes variant="vertical" to fill the space; props are otherwise identical.
  const variationTree = (variant: 'responsive' | 'vertical') => (
    <VariationTree
      variant={variant}
      nodes={nodes}
      mainLine={mainLine}
      currentNodeId={currentNodeId}
      rootPly={rootPly}
      initialPly={isGameMode ? initialAlignPly : undefined}
      topAlignSeq={moveListTopAlignSeq}
      onNodeClick={goToNode}
      decorations={sidelineNodeColors}
      pvNodeIds={isGameMode ? pvNodeIds : undefined}
      flawMarkerByNodeId={moveListMarkers}
      onPvChipClick={isGameMode ? handlePvChipClick : undefined}
      activePvKeys={isGameMode ? activePvKeys : undefined}
      pvFetchPending={isGameMode ? contextualPending : undefined}
      pvFetchError={isGameMode ? contextualError : undefined}
      // deleteSubtree wired unconditionally: the free-move sideline × delete must
      // work in free-play mode too. Previously gated on isGameMode, so in free play
      // the × rendered (free-move blocks always show it) but its handler was
      // undefined and clicking did nothing. deleteSubtree is always safe — it
      // recovers currentNodeId to the fork parent when the current node is deleted.
      onDeleteLine={deleteSubtree}
    />
  );

  // Board controls — shared. The desktop panel now sits in the move-list card's darker
  // footer band (flat, compact sm icons evenly spread); the mobile footer passes flat with
  // no size so the buttons fill the width like the main nav (Quick 260628-dgv).
  const boardControls = (flat = false, size?: 'sm' | 'md' | 'lg') => (
    <BoardControls
      onBack={goBack}
      onForward={goForward}
      onReset={handleReset}
      onFlip={() => setBoardFlipped((f) => !f)}
      canGoBack={currentNodeId !== null}
      canReset={canReset}
      canGoForward={canGoForward}
      flat={flat}
      size={size}
    />
  );

  // The eval-chart element (game mode only) — placed below the board on desktop, inside the
  // Eval tab on mobile. Single instance; rendered in whichever tree is active.
  // evalChartReady itself is declared earlier (Phase 172, SEED-106 D-03 hoist —
  // the sweep-start effect needs it as its readiness gate).
  // While analysis hasn't landed yet, show the Pending…/Analyzing… pill where
  // the eval chart would go instead of nothing (live poll updates active_eval_status).
  const evalPending =
    isGameMode &&
    gameData != null &&
    !evalChartReady &&
    (gameData.active_eval_status === 'pending' || gameData.active_eval_status === 'leased');
  // `highlightedPlies` is desktop-only (the tags panel's hover-highlight, Task 3);
  // the mobile evalChart() call site omits it, leaving chart markers un-dimmed there.
  // Renders the eval chart when ready, the pending/leased pill while analysis is
  // in flight, or null otherwise (free play, or a card with no active job).
  const evalChart = (heightClass: string, highlightedPlies?: Set<number> | null) => {
    if (
      evalChartReady &&
      gameId != null &&
      gameData?.eval_series != null &&
      gameData.flaw_markers != null &&
      gameData.phase_transitions != null &&
      gameData.moves != null
    ) {
      return (
        <EvalChart
          gameId={gameId}
          evalSeries={gameData.eval_series}
          flawMarkers={gameData.flaw_markers}
          phaseTransitions={gameData.phase_transitions}
          moves={gameData.moves}
          heightClass={heightClass}
          initialPly={initialPly}
          flipped={gameData.user_color === 'black'}
          // User-scope the gem/great dot layer (Plan 06 fix): best_move_tier is
          // position-scoped, so pass user_color to exclude the opponent's gems/greats.
          userColor={
            gameData.user_color === 'white' || gameData.user_color === 'black'
              ? gameData.user_color
              : undefined
          }
          sliderTestId="analysis-eval-chart-slider"
          disableHoverScrub
          onHoverPlyChange={handleEvalChartPlyChange}
          syncPly={evalChartPly}
          commandedPly={tagCommandedPly}
          commandSeq={tagCommandSeq}
          highlightedPlies={highlightedPlies}
        />
      );
    }
    if (evalPending && gameId != null) {
      return <AnalysisPendingPill gameId={gameId} leased={gameData?.active_eval_status === 'leased'} />;
    }
    return null;
  };

  // The flaw-tags panel (game mode only, quick-260702-nm8) — MoveStats card + Missed |
  // Allowed | Context tags. Same readiness gate as the eval chart (implies flaw_markers
  // present). Cycling a cell/chip reuses the exact goToNode pattern from
  // handleEvalChartPlyChange — a single call auto-syncs board + move list + eval-chart
  // crosshair (evalChartPly derives from currentNodeId). `withHighlight` (Task 3, desktop
  // only) wires the hover-highlight back onto the eval chart. `section` (UAT 179) splits
  // the panel: desktop renders 'stats' (right column) + 'tags' (below the eval chart);
  // mobile/mid render 'stats' in the Stats tab and 'tags' at the bottom of the Eval tab
  // (quick 260719-ey9 — the default 'panel' slice is now unused there). Declared before
  // desktopBoardStage, which embeds the 'tags' section under the eval chart.
  const tagsPanel = (withHighlight = false, section: 'panel' | 'stats' | 'tags' = 'panel') =>
    evalChartReady && gameData ? (
      <AnalysisTagsPanel
        game={gameData}
        section={section}
        onCyclePly={(ply, orientation) => {
          // T-140-02b: L-8 guard for noUncheckedIndexedAccess.
          const nodeId = mainLine[ply];
          // The ply the board should rest on: a missed line forks at ply-1 (the decision
          // board), an allowed line at ply; context tags / Move Stats cells navigate to the
          // flaw ply itself.
          const restPly = orientation !== undefined ? forkPlyForOrientation(ply, orientation) : ply;
          if (orientation !== undefined && nodeId !== undefined) {
            // Missed/allowed tactic badge: unfold its sideline AND navigate to the decision
            // fork (ply-1 for missed, flaw ply for allowed). Unlike the move-list chip, the
            // tags-card badge NEVER folds an already-open line (UAT): if the sideline is
            // already unfolded, just navigate to the fork instead of toggling it shut.
            const key = flawKey({ ply, orientation });
            if (openLines.has(key)) {
              const forkNodeId = mainLine[restPly];
              if (forkNodeId !== undefined) goToNode(forkNodeId);
            } else {
              handlePvChipClick(nodeId, { ply, orientation });
            }
          } else if (nodeId !== undefined) {
            goToNode(nodeId);
          }
          // Top-align the navigated move so a downward jump lands at the TOP of the move
          // list (with an unfolded sideline visible below), not clipped at the bottom.
          setMoveListTopAlignSeq((s) => s + 1);
          // Surface the eval-chart tooltip on the board's RESTING ply (the fork for a missed
          // line), NOT the raw flaw ply: the command's onHoverPlyChange re-navigates the
          // board, so commanding the flaw ply would yank the cursor one move past a missed
          // line's decision fork on a repeat click.
          setTagCommandedPly(restPly);
          setTagCommandSeq((s) => s + 1);
        }}
        onHighlightChange={withHighlight ? setTagsHighlightedPlies : undefined}
      />
    ) : null;

  // Desktop board column (Phase 161 UAT). The outer div is the measured "stage" (see the
  // boardStageRef effect): a full-width, viewport-height-locked box. Inside sits ONE tight,
  // centered group — source caps + top player, the board flanked by its two eval bars, the
  // bottom player, and the eval chart. The board is JS-sized (computeBoardSize) so:
  //   • the eval bars are exactly as tall as the board and sit flush to its edges (gap-2),
  //   • the player rows and chart stay directly adjacent to the board (no flex-1 gap), and
  //   • the board shrinks to fit as width/height tighten until it hits the board's floor
  //     (D-08), past which the overflowing bottom (eval chart, then board) is CLIPPED, not
  //     scrolled — a middle-column scrollbar is never acceptable (Phase 161 UAT).
  // The group's width follows the board+bars row (maxWidth = boardWidth + bars allowance),
  // so the caps, player rows and chart all align to the board edges. `w-5` fixes each bar's
  // width; `h-full` makes it fill the boardWidth-tall wrapper.
  const desktopBoardStage = (
    <div
      ref={boardStageRef}
      // overflow-hidden on BOTH axes: x clips the EvalChart slider's intentional ±8px
      // alignment slack (its -ml-8px track overhang); y clips a too-tall group on a short
      // window instead of showing a vertical scrollbar (Phase 161 UAT — the user prefers
      // the eval chart cut off at the bottom over a middle-column scrollbar).
      className="flex w-full min-w-0 shrink-0 flex-col items-center desk3col:min-h-0 desk3col:h-full desk3col:justify-start desk3col:overflow-hidden"
    >
      <div
        className="flex w-full flex-col items-center gap-2"
        style={{ maxWidth: boardWidth ? boardWidth + BOARD_EVAL_BARS_ALLOWANCE_PX : undefined }}
      >
        {/* Source caps (Maia/SF) over the bars + top player (game mode). */}
        <div className="w-full">
          {boardHeaderRow(
            isGameMode && gameData ? playerBar(boardFlipped ? 'white' : 'black') : null,
          )}
        </div>

        {/* Board flanked by its two eval bars — all three exactly boardWidth tall. */}
        <div className="flex flex-row items-center gap-2">
          <div className="w-5 shrink-0" style={{ height: boardWidth }}>
            {leftEvalBarNode('h-full w-full')}
          </div>
          <div
            ref={containerRef}
            data-testid="analysis-board"
            tabIndex={0}
            style={{ width: boardWidth, height: boardWidth }}
          >
            {chessBoardNode()}
          </div>
          <div className="w-5 shrink-0" style={{ height: boardWidth }}>
            {rightEvalBarNode('h-full w-full')}
          </div>
        </div>

        {/* Bottom player (game mode only). */}
        {isGameMode && gameData && (
          <div className="w-full">{boardFooterRow(playerBar(boardFlipped ? 'black' : 'white'))}</div>
        )}

        {/* Board controls directly under the board — moved here from the move-list
            card footer so they hug the board in BOTH the mid and desktop layouts.
            Placed ABOVE the eval chart so a too-short locked desktop viewport clips
            the chart (bottom of the group), never the controls. Capped to the board
            group width by the parent's maxWidth, so it aligns to the board edges.
            Charcoal container (Card) to match the surrounding engine cards. */}
        <Card className="w-full px-1">{boardControls(true, 'sm')}</Card>

        {/* EvalChart with slider — game mode only, aligned to the board width.
            highlightedPlies (Task 3): dims non-matching markers on tags-panel hover.
            Quick 260714-rj5: also renders while analysis is pending/leased, showing
            the pill in the chart's slot instead of nothing.
            Suppressed in the mid layout (!isMid): there the chart lives in the Eval
            tab (mobile parity), and a second EvalChart under the board would clash on
            its `eval-chart-${gameId}` testids. Desktop keeps it here under the board. */}
        {!isMid && (evalChartReady || evalPending) && (
          <div data-testid="analysis-eval-chart" className="w-full">
            {evalChart('h-[120px]', tagsHighlightedPlies)}
          </div>
        )}

        {/* Missed/Allowed/Context tags in a charcoal container, below the eval
            chart (UAT 179). Desktop only (!isMid) — the mid/mobile layouts keep the
            tags below the MoveStats card in the tabbed panel. Aligned to the board
            width by the group's maxWidth, filling the slack under the chart. */}
        {!isMid && (
          <div className="w-full" data-testid="analysis-board-tags">
            {tagsPanel(true, 'tags')}
          </div>
        )}
      </div>
    </div>
  );

  // Shared ELO slider: drives BOTH the FlawChess and Maia engines, so on desktop it
  // sits BETWEEN the two cards (164 UAT); each mobile tab (FlawChess / Maia) renders
  // its own copy since they're separate screens. The FlawChess card header still
  // reflects the value ("FlawChess Engine (N ELO)"). The reset control snaps back to
  // the players' rating once the user has dragged off it (164 UAT).
  const eloSelector = (
    <div className="px-2 flex flex-col gap-2" data-testid="analysis-elo-selector-row">
      <EloSelector
        value={selectedElo}
        onChange={setSelectedElo}
        defaultElo={defaultElo}
        onReset={resetToDefault}
      />
    </div>
  );

  // FlawChess Engine card (D-01, DISPLAY-04) — a fixed-height charcoal Card
  // stacked directly above MaiaHumanPanel, reused verbatim in BOTH the desktop
  // human column and the mobile "FlawChess" tab (mobile-parity: D-01's "apply to
  // both" + CLAUDE.md's mobile-parity rule). Mirrors the Stockfish card's own
  // loading → off → lines CardBody pattern (line ~1585 below): flawChessLoading
  // gates the pre-`isReady` skeleton (worker pool spin-up); once ready,
  // FlawChessEngineLines renders its OWN pre-first-snapshot skeleton internally.
  // `footer` (164 UAT): mobile passes the ELO slider so it sits inside the card;
  // desktop omits it (the slider is a standalone row between the two cards there).
  const renderFlawChessCard = (footer?: React.ReactNode): React.ReactElement => (
    <Card data-testid="analysis-flawchess-panel">
      <CardHeader
        size="compact"
        data-testid="analysis-flawchess-info"
        className="font-normal text-muted-foreground"
      >
        <EngineToggleHeader
          checked={flawChessEnabled}
          onCheckedChange={setFlawChessEnabled}
          accent={FLAWCHESS_ENGINE_ACCENT}
          testId="btn-analysis-flawchess-toggle"
          ariaLabel="Toggle FlawChess Engine"
          icon={ChessKnight}
        >
          {/* ELO in parens = the mover's rating (or the slider override), the
              strength the engine is playing at (155 UAT). */}
          FlawChess Engine ({selectedElo} ELO)
        </EngineToggleHeader>
        <FlawChessInfoTooltip />
      </CardHeader>
      <CardBody className={`${LINES_MIN_HEIGHT} p-2`}>
        {flawChessLoading ? (
          <EngineLinesSkeleton testId="analysis-flawchess-loading" rows={2} />
        ) : !flawChessEnabled ? (
          <div className="flex h-full items-center px-2 text-sm text-muted-foreground">
            FlawChess Engine off
          </div>
        ) : (
          <>
            <FlawChessEngineLines
              rankedLines={reconciledRankedLines}
              isSearching={flawChessEngine.isSearching}
              baseFen={position}
              startPly={currentPly}
              flipped={boardFlipped}
              terminalOutcome={flawChessTerminalOutcome}
              onMoveClick={playUciLine}
            />
            {/* Agreement verdict (Phase 157-02, REVIEW-02; Phase 158 SEED-087
                SC4; Phase 162 SEED-090 D-13): the Stockfish side is now
                `reconciledStockfishLine` — the TRUE global reconciled argmax
                (`reconciledBestUci`) named at ITS reconciled eval, which may
                be a different move than raw `engine.pvLines[0]` (D-12 accepted
                edge case) — never engineTopLines, which silently degrades to a
                FlawChess row when standalone Stockfish is off. Falls back to
                `engine.pvLines[0]` pre-grading so first paint still resolves.
                The FlawChess side is reconciledRankedLines (evalLookup-
                sourced), so both picks resolve through the SAME lookup —
                making "FC pick grades higher than the objective best"
                impossible by construction.
                Hidden in a terminal position (quick 260709): the game is over, so
                the "Turn on Stockfish to compare picks." prompt is misleading —
                the terminal `#0`/`½–½` badge above says it all. */}
            {flawChessTerminalOutcome == null && (
              <FlawChessAgreementVerdict
                flawChessLine={reconciledRankedLines[0] ?? null}
                stockfishLine={reconciledStockfishLine ?? (engine.pvLines[0] ?? null)}
                flawChessRankedLines={flawChessRankedLinesForVerdict}
                engineEnabled={engineEnabled}
                elo={selectedElo}
                baseFen={position}
                rawProbBySan={rawProbBySan}
                shownSans={shownSans}
                onHoverMovesChange={setHoveredQualityMoves}
                onPlayMove={playProseMove}
              />
            )}
            {/* Phase 159 D-08: the Human <-> Stockfish play-style slider lives at
                the bottom of the FlawChess Engine card (it only reshapes this
                engine's policy). */}
            <div className="mt-2 px-2">
              <TemperatureSelector value={temperature} onChange={setTemperature} />
            </div>
          </>
        )}
        {/* Mobile-only ELO slider inside the card (164 UAT); always shown, even when
            the engine is off, since it also drives the Maia surfaces. */}
        {footer !== undefined && <div className="mt-2">{footer}</div>}
      </CardBody>
    </Card>
  );

  // The mobile "Maia" tab content (D-03, LIC-02) — shared across every mobile tab
  // layout below, so this JSX isn't duplicated. The FlawChess card lives in its own
  // adjacent tab (flawChessTab) rather than here; the ELO slider sits inside the Maia
  // card (as its footer) on mobile since it drives both engines (164 UAT).
  const humanTab = (
    <TabsContent value="human" className="min-h-0 overflow-y-auto thin-scrollbar">
      <div className="flex flex-col gap-3 px-3">
        <MaiaHumanPanel
          selectedElo={selectedElo}
          perElo={maia.perElo}
          playedSan={playedSan}
          // 162-REVIEW WR-02: the chart's emphasized stroke follows the SAME
          // reconciled Best the quality color/label/verdict designate, not the
          // raw free-run pick (raw bestSan still feeds selectCandidatesByMass
          // above so the free-run pick stays plotted).
          bestSan={reconciledBestSan ?? bestSan}
          shownSans={shownSans}
          qualityBySan={qualityBySanWithGem}
          mover={sideToMoveFromFen(position)}
          engineTopLines={engineTopLines}
          onHoverMovesChange={setHoveredQualityMoves}
          isOpponentToMove={isOpponentToMove}
          onPlayMove={playProseMove}
          enabled={maiaEnabled}
          onToggleEnabled={setMaiaEnabled}
          compact
          footer={eloSelector}
        />
      </div>
    </TabsContent>
  );

  // The mobile "FlawChess" tab content — the FlawChess Engine card, moved out of the
  // Maia tab into its own tab to the right of it. Shared across the mobile tab layouts.
  // The ELO slider sits inside the card (as its footer) on mobile (164 UAT), since this
  // is a separate screen from the Maia tab (which carries its own copy).
  const flawChessTab = (
    <TabsContent value="flawchess" className="min-h-0 overflow-y-auto thin-scrollbar">
      <div className="flex flex-col gap-3 px-3">{renderFlawChessCard(eloSelector)}</div>
    </TabsContent>
  );

  // Mobile Stockfish PV lines, without the info-card header. Mirrors the desktop
  // `analysis-engine-card` body's loading → off → lines branches. Relocated from
  // above the board to the top of the Eval tab; shown there in every mobile layout.
  const mobileEngineLines = (
    <div className="shrink-0 px-2" data-testid="analysis-engine-lines-mobile">
      {engineLoading ? (
        <EngineLinesSkeleton testId="analysis-engine-loading" compact />
      ) : !engineEnabled ? (
        <div className="flex h-full items-center px-2 text-sm text-muted-foreground">
          Engine off
        </div>
      ) : (
        // 162 UAT: reconciled top-2 over the full grading union, mobile parity
        // with the desktop card below (CLAUDE.md mobile-parity rule).
        <EngineLines
          pvLines={reconciledPvLines}
          isAnalyzing={engine.isAnalyzing}
          startPly={currentPly}
          baseFen={position}
          flipped={boardFlipped}
          onMoveClick={playUciLine}
          compact
        />
      )}
    </div>
  );

  // The mobile "Eval" tab content — Stockfish PV lines on top, the eval chart below,
  // then the tactics card (Missed/Allowed/Context tags — quick 260719-ey9 relocated it
  // here from the old Tags tab) at the bottom. All game-mode only; evalChart() returns
  // null in free play / before the game loads, and the tags section only renders once
  // analysis lands (evalChartReady), leaving just the engine lines otherwise.
  const evalTab = (
    <TabsContent
      value="eval"
      className="min-h-0 overflow-x-hidden overflow-y-auto thin-scrollbar"
    >
      <div className="flex flex-col gap-2 pt-1">
        {mobileEngineLines}
        {(evalChartReady || evalPending) && <div className="px-3">{evalChart('h-[120px]')}</div>}
        {evalChartReady && <div className="px-3">{tagsPanel(false, 'tags')}</div>}
      </div>
    </TabsContent>
  );

  // The mobile "Moves" tab content — the vertical variation tree in a charcoal
  // container (no card header), matching the surrounding tab surfaces. Shared across
  // the mobile tab layouts and the mid-range right column. The charcoal wrapper keeps
  // the flex/scroll chain (`min-h-0 flex-1`) so the tree's internal scroller resolves.
  //
  // Bug fix (bot-game live analysis): when the live poll lands analysis on a game the
  // user is viewing on the Moves tab, the move-quality icons (blunder/mistake, gem/
  // great, book) did NOT appear in place on mobile — only switching to another tab and
  // back (a Radix unmount/remount) surfaced them. The move list derives its markers
  // from gameData via memos that DO recompute on the poll, yet the active tab's already-
  // mounted subtree kept a stale render; a remount is what reliably picks the icons up.
  // Keying the subtree on the analysis-ready transition reproduces that remount exactly
  // when analysis lands (evalChartReady flips false→true once), so the icons show
  // without a manual tab switch. The move tree, cursor, and any user-built sideline live
  // in useAnalysisBoard (above VariationTree), so this view remount never loses them.
  // Free play and already-analyzed games keep a stable key (mounts once, no churn).
  const moveListKey = isGameMode ? (evalChartReady ? 'moves-analyzed' : 'moves-pending') : 'moves';
  const movesTab = (
    <TabsContent value="moves" className="flex min-h-0 flex-1 flex-col pb-2">
      <div
        key={moveListKey}
        className="charcoal-texture flex min-h-0 flex-1 flex-col rounded-md"
      >
        {variationTree('vertical')}
      </div>
    </TabsContent>
  );

  // The mobile "Stats" tab content — the MoveStats / accuracy card (game mode only;
  // quick 260719-ey9 renamed the tab from "Tags" and moved the tactic/context tags card
  // out to the bottom of the Eval tab, so this tab now shows the accuracy + move stats
  // only via section='stats'). While analysis is still in flight the tab shows the SAME
  // Analyzing pill the Eval tab uses, then swaps to the panel once evals land — so the
  // tab is present (and clearly "working") the whole time instead of only popping into
  // existence once evals arrive. The prior pattern (trigger + content mounted ONLY on
  // evalChartReady) added a Radix tab to an already-mounted <Tabs> at the ready
  // transition, which failed to render in place on mobile until a full page reload
  // (quick 260719-dzh) — the accuracy card + move stats stayed "completely absent" even
  // though the eval chart had appeared.
  const statsTab = (
    <TabsContent value="stats" className="min-h-0 overflow-y-auto thin-scrollbar">
      <div className="px-2 pt-1">
        {evalChartReady ? (
          tagsPanel(false, 'stats')
        ) : evalPending && gameId != null ? (
          <AnalysisPendingPill
            gameId={gameId}
            leased={gameData?.active_eval_status === 'leased'}
          />
        ) : null}
      </div>
    </TabsContent>
  );

  // The full tabbed panel (Moves | Eval | Maia | FlawChess [| Stats]) — the mobile
  // takeover's whole body AND the mid-range layout's right column (both reuse it
  // verbatim; only one layout tree renders at a time, so the Tabs mount exactly
  // once). Needs a height-bounded flex parent (`flex min-h-0 flex-1`) so each tab's
  // internal scroller resolves: mobile gets it from the takeover column, mid from a
  // boardWidth-tall wrapper. The Stats trigger/content render whenever the game is
  // analyzed OR still being analyzed (evalChartReady || evalPending) — present with an
  // Analyzing pill during analysis, then the panel once evals land (quick 260719-dzh);
  // free play / idle unanalyzed games omit them, and the Tabs subtree never remounts
  // across the transition (no cursor/variation-tree loss).
  const analysisTabs = (
    <Tabs defaultValue="moves" className="flex min-h-0 flex-1 flex-col gap-2 px-2 pt-2">
      <TabsList variant="underline" className="w-full shrink-0">
        <TabsTrigger value="moves" data-testid="analysis-tab-moves" className="gap-1 px-1">
          <ArrowLeftRight aria-hidden="true" />
          Moves
        </TabsTrigger>
        {/* Engine-colored tab nav: Eval = Stockfish blue, Maia = violet,
            FlawChess = gold — matching each surface's accent (theme.ts). */}
        <TabsTrigger
          value="eval"
          data-testid="analysis-tab-eval"
          className="gap-1 px-1"
          style={{ color: STOCKFISH_ACCENT }}
        >
          <Cpu aria-hidden="true" />
          Eval
        </TabsTrigger>
        <TabsTrigger
          value="human"
          data-testid="analysis-tab-human"
          className="gap-1 px-1"
          style={{ color: MAIA_ACCENT }}
        >
          <User aria-hidden="true" />
          Maia
        </TabsTrigger>
        <TabsTrigger
          value="flawchess"
          data-testid="analysis-tab-flawchess"
          className="gap-1 px-1"
          style={{ color: FLAWCHESS_ENGINE_ACCENT }}
        >
          <ChessKnight aria-hidden="true" />
          FlawChess
        </TabsTrigger>
        {(evalChartReady || evalPending) && (
          <TabsTrigger value="stats" data-testid="analysis-tab-stats" className="gap-1 px-1">
            <ChartNoAxesColumn aria-hidden="true" />
            Stats
          </TabsTrigger>
        )}
      </TabsList>
      {movesTab}
      {evalTab}
      {humanTab}
      {flawChessTab}
      {(evalChartReady || evalPending) && statsTab}
    </Tabs>
  );

  // ── Shared desktop/mid cards ──────────────────────────────────────────────────
  // Extracted from the desktop 3-column return so the mid-range two-column layout can
  // reuse them verbatim (single mount — only one return branch renders). Each references
  // component-scope state directly, exactly as when it was inline.

  // Stockfish engine info + lines card (155/162 UAT: reconciled top-2 over the grading union).
  const stockfishCard = (
    <Card data-testid="analysis-engine-card">
      <CardHeader
        size="compact"
        data-testid="analysis-engine-info"
        className="font-normal text-muted-foreground"
      >
        <EngineToggleHeader
          checked={engineEnabled}
          onCheckedChange={setEngineEnabled}
          accent={STOCKFISH_ACCENT}
          testId="btn-analysis-engine-toggle"
          ariaLabel="Toggle Stockfish engine"
          icon={Cpu}
        >
          {ENGINE_NAME}
          {engineEnabled && reconciledBestEval.depth > 0 ? `, Depth ${reconciledBestEval.depth}` : ''}
        </EngineToggleHeader>
      </CardHeader>
      <CardBody className="min-h-[78px] p-2">
        {engineLoading ? (
          <EngineLinesSkeleton testId="analysis-engine-loading" />
        ) : !engineEnabled ? (
          <div className="flex h-full items-center px-2 text-sm text-muted-foreground">
            Engine off
          </div>
        ) : (
          <EngineLines
            pvLines={reconciledPvLines}
            isAnalyzing={engine.isAnalyzing}
            startPly={currentPly}
            baseFen={position}
            flipped={boardFlipped}
            onMoveClick={playUciLine}
          />
        )}
      </CardBody>
    </Card>
  );

  // Move-list card (desktop side panel): variation tree fills and scrolls internally.
  // `flex-1 min-h-0` needs a height-bounded flex parent (the board-height region) so the
  // tree's absolute-fill scroller has a definite height (a 0-height parent would render an
  // empty list). The board controls no longer sit in a footer band here — they moved under
  // the board inside desktopBoardStage (hugging the board like the mid layout).
  const movesCard = (
    <Card
      data-testid="analysis-movelist-card"
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <CardHeader size="compact" data-testid="analysis-movelist-header">
        <ArrowLeftRight className="h-4 w-4" aria-hidden />
        Moves
      </CardHeader>
      {variationTree('responsive')}
    </Card>
  );

  // Maia move-quality panel (desktop/mid, non-compact — no in-card ELO footer; the slider is
  // a standalone row/cell next to it). The mobile Maia tab renders its own compact copy.
  const desktopMaiaPanel = (
    <MaiaHumanPanel
      selectedElo={selectedElo}
      perElo={maia.perElo}
      playedSan={playedSan}
      // 162-REVIEW WR-02: same reconciled-emphasis threading as the mobile Maia tab.
      bestSan={reconciledBestSan ?? bestSan}
      shownSans={shownSans}
      qualityBySan={qualityBySanWithGem}
      mover={sideToMoveFromFen(position)}
      engineTopLines={engineTopLines}
      onHoverMovesChange={setHoveredQualityMoves}
      isOpponentToMove={isOpponentToMove}
      onPlayMove={playProseMove}
      enabled={maiaEnabled}
      onToggleEnabled={setMaiaEnabled}
    />
  );

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
            <div className="flex min-w-0 flex-col gap-2">{desktopBoardStage}</div>
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
          {boardHeaderRow(
            isGameMode && gameData ? playerBar(boardFlipped ? 'white' : 'black') : null,
          )}
          {boardRow}
          {isGameMode && gameData && boardFooterRow(playerBar(boardFlipped ? 'black' : 'white'))}
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
          {boardControls(true)}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="analysis-page" className="flex min-h-0 flex-1 flex-col bg-background">
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
            {isGameMode && gameData && (
              <div aria-hidden="true" className="hidden desk3col:block desk3col:invisible desk3col:-mb-2">
                {playerBar(boardFlipped ? 'white' : 'black')}
              </div>
            )}
            {renderFlawChessCard()}
            {/* Shared ELO slider between the two cards (164 UAT): it drives both the
                FlawChess and Maia engines, so it sits in the gap rather than inside
                either card. */}
            {eloSelector}
            {desktopMaiaPanel}
          </div>

          {/* Board column ──────────────────────────────────────────────────── */}
          {/* Fluid `1fr` grid track holding the JS-sized board stage (caps + players +
              board/eval-bars + eval chart). All sizing/scroll behavior lives inside
              desktopBoardStage (defined above) so this middle track is just its slot. */}
          {desktopBoardStage}

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
            {isGameMode && gameData && (
              <div aria-hidden="true" className="hidden desk3col:block desk3col:invisible desk3col:-mb-2">
                {playerBar(boardFlipped ? 'white' : 'black')}
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
            {stockfishCard}
            {movesCard}
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
                {playerBar(boardFlipped ? 'black' : 'white')}
              </div>
            )}
            {/* MoveStats card (Accuracies + two-sided category table) lives in the
                right column. The Missed/Allowed/Context tags moved back under the eval
                chart in the board column (UAT 179 — see analysis-board-tags), so this
                column shows the stats card only. withHighlight=true preserved — its
                hover/cycle state still wires back onto the eval chart. */}
            {tagsPanel(true, 'stats')}
          </div>

        </div>
      </main>
    </div>
  );
}
