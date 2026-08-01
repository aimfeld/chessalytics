/**
 * VariationTree — responsive move list for the analysis board (Phase 137 Plan 03).
 *
 * Renders the main game line plus every open sideline as a FLAT sibling block —
 * one indent level, no recursive nesting, no promote-to-mainline (Quick
 * 260703-kyb: replaces the old Level-1/Level-2 singleton-PV nesting model).
 * A sideline is either a tactic line (its root is in pvNodeIds — closes via its
 * chip) or a free-move line (closes via a per-line × delete affordance). Multiple
 * lines off different forks — or multiple sub-forks off the same line — all
 * render simultaneously as separate flat blocks.
 *
 * Responsive split (D-02): mobile extends HorizontalMoveList (horizontal chips
 * with each sideline inline in single parentheses); desktop uses a vertical
 * paired N. white black list with indented sibling blocks.
 * Split is Tailwind dual-DOM (sm:hidden / hidden sm:block) — no media-query hook.
 *
 * Security: node.san comes from chess.js-validated moves, not user input.
 * React auto-escapes all JSX children — no unsafe HTML injection.
 */

import { useRef, useEffect, useState, Fragment } from 'react';
import type { ReactNode } from 'react';
import { Loader2, X } from 'lucide-react';
import type { NodeId, MoveNode } from '@/hooks/useAnalysisBoard';
import { HorizontalMoveList } from '@/components/board/HorizontalMoveList';
import type { HorizontalMoveItem } from '@/components/board/HorizontalMoveList';
import { BlunderIcon, MistakeIcon } from '@/components/icons/SeverityGlyphIcon';
import { GemIcon } from '@/components/icons/GemIcon';
import { GreatMoveIcon } from '@/components/icons/GreatMoveIcon';
import { BestMoveIcon } from '@/components/icons/BestMoveIcon';
import { GoodMoveIcon } from '@/components/icons/GoodMoveIcon';
import { BookIcon } from '@/components/icons/BookIcon';
import { GemMoveBadge } from '@/components/analysis/GemMoveBadge';
import { moveLabel } from '@/lib/moveNumberLabel';
import { tacticMotifLabel, tacticDepthBadge } from '@/lib/tacticComparisonMeta';
import { cn } from '@/lib/utils';
import {
  TAC_MISSED,
  TAC_MISSED_BG,
  TAC_MISSED_BORDER,
  TAC_ALLOWED,
  TAC_ALLOWED_BG,
  TAC_ALLOWED_BORDER,
  ACTIVE_FILTER_RING_CLASS,
} from '@/lib/theme';
import type { FlawSeverity } from '@/types/library';

// Subtle zebra stripe for the desktop move list (Quick 260627-r9g item 2). A faint
// light wash on odd rows; not a semantic color, so a Tailwind opacity utility is fine.
const ZEBRA_ROW_BG = 'bg-foreground/[0.03]';
/** Zebra background for a 0-based row index (odd rows striped). */
function zebraBg(rowIdx: number): string {
  return rowIdx % 2 === 1 ? ZEBRA_ROW_BG : '';
}

/**
 * Icon + visibility for a flaw entry's move-list marker. Precedence chain
 * `severity > gem/great > best/good > book` (163-REVIEW WR-05; extended Phase
 * 172,
 * SEED-106 D-08; extended Phase 175, SEED-108 with great sitting alongside
 * gem in the same tier). Severity wins over gem/great: within the live
 * pipeline they are mutually exclusive by construction, but a BACKEND
 * severity (server Stockfish) and the live WASM gem/great can legitimately
 * disagree on the same move — one move never renders two badges, and the
 * severity badge is the more actionable signal. Book slots in at the BOTTOM
 * of the chain: a book move can still be an inaccuracy (ECO includes plenty
 * of dubious gambits), and in that case the user needs to see the flaw, not
 * the reassurance that it was theory. Gem/great-vs-book never actually
 * arises in production — D-04 skips book plies before they can be
 * classified — but the chain is stated in full so the ordering is
 * unambiguous.
 */
function resolveMarkerIcon(flaw: FlawMarkerEntry | undefined): {
  show: boolean;
  Icon: typeof BlunderIcon;
  isGem: boolean;
  isGreat: boolean;
} {
  if (flaw != null && (flaw.severity === 'blunder' || flaw.severity === 'mistake')) {
    return {
      show: true,
      Icon: flaw.severity === 'blunder' ? BlunderIcon : MistakeIcon,
      isGem: false,
      isGreat: false,
    };
  }
  if (flaw?.gem) return { show: true, Icon: GemIcon, isGem: true, isGreat: false };
  if (flaw?.great) {
    return { show: true, Icon: GreatMoveIcon, isGem: false, isGreat: true };
  }
  // Phase 200 UAT: the positive non-Maia tiers, set only by Train's free-play
  // move list (`useTrainFreePlay`). The Analysis page never populates them, so
  // its own markers are unchanged. They sit BELOW gem/great deliberately: a
  // surface that has Maia available should still say "gem", and a surface that
  // does not (Train) simply labels the same move `best`.
  if (flaw?.best) return { show: true, Icon: BestMoveIcon, isGem: false, isGreat: false };
  if (flaw?.good) return { show: true, Icon: GoodMoveIcon, isGem: false, isGreat: false };
  // IN-01 (172-deferred-review-findings.md): the `isBook` field this function
  // used to also return was never read by any caller (MoveListMarker below
  // only destructures show/Icon/isGem/isGreat) — dropped as dead output
  // rather than carried forward again.
  if (flaw?.book) return { show: true, Icon: BookIcon, isGem: false, isGreat: false };
  return { show: false, Icon: MistakeIcon, isGem: false, isGreat: false };
}

/**
 * A move-list flaw/gem/great marker: the popover-wrapped badge (GemMoveBadge,
 * tier-selected) when the entry is a gem or great, otherwise the plain
 * severity glyph. Returns null when the entry warrants no marker, so it drops
 * straight into a trailing slot. Centralizes the gem/great-vs-severity branch
 * shared by the desktop and mobile lists.
 */
function MoveListMarker({
  flaw,
  className,
}: {
  flaw: FlawMarkerEntry | undefined;
  className: string;
}): ReactNode {
  const { show, Icon, isGem, isGreat } = resolveMarkerIcon(flaw);
  if (!show) return null;
  if (isGem) {
    return (
      <GemMoveBadge
        className={className}
        maiaProbability={flaw?.gemMaiaProbability ?? null}
        elo={flaw?.gemElo ?? null}
        byOpponent={flaw?.gemByOpponent ?? false}
        tier="gem"
      />
    );
  }
  if (isGreat) {
    return (
      <GemMoveBadge
        className={className}
        maiaProbability={flaw?.greatMaiaProbability ?? null}
        elo={flaw?.greatElo ?? null}
        byOpponent={flaw?.greatByOpponent ?? false}
        tier="great"
      />
    );
  }
  return <Icon className={className} aria-hidden />;
}

/** Nearest scrollable ancestor of `el`, or null if none before the document. */
function scrollableParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Scrolls ONLY the move-list scroll container to reveal `el` — never the window.
 *
 * BUG FIX: `el.scrollIntoView()` scrolls every scrollable ancestor, including the
 * document. The Analysis page scrolls on the window (the move list is a nested
 * overflow-y-auto scroller inside it), so when opening a game at a specific ply the
 * initial `scrollIntoView({block:'start'})` top-align dragged the WHOLE page down on
 * Firefox to bring the selected move to the top of the viewport, instead of only
 * scrolling the move list. Scoping the scroll to the container keeps the page at top.
 */
function scrollActiveIntoView(el: HTMLElement, align: 'start' | 'nearest'): void {
  const container = scrollableParent(el);
  if (!container) return;
  const elRect = el.getBoundingClientRect();
  const cRect = container.getBoundingClientRect();
  if (align === 'start') {
    container.scrollTo({ top: container.scrollTop + (elRect.top - cRect.top), behavior: 'auto' });
    return;
  }
  // 'nearest' — only scroll when the row is outside the container's viewport.
  if (elRect.top < cRect.top) {
    container.scrollTo({ top: container.scrollTop + (elRect.top - cRect.top), behavior: 'smooth' });
  } else if (elRect.bottom > cRect.bottom) {
    container.scrollTo({ top: container.scrollTop + (elRect.bottom - cRect.bottom), behavior: 'smooth' });
  }
}

// ─── Props ───────────────────────────────────────────────────────────────────

/** Flaw marker entry for a mainLine node — tactic motifs + non-tactic severity. */
export interface FlawMarkerEntry {
  missedMotif: string | null;
  allowedMotif: string | null;
  /** 0-based depth of the missed tactic (display offset applied by tacticDepthBadge). */
  missedDepth: number | null;
  /** 0-based depth of the allowed tactic (display offset applied by tacticDepthBadge). */
  allowedDepth: number | null;
  severity?: FlawSeverity;
  /**
   * True when this node's arrival move is a "gem" (Phase 163, SEED-092) — renders
   * GemIcon instead of the severity glyph. Mutually exclusive with `severity` by
   * construction (classifyGem requires the clear best move, never a blunder/mistake).
   */
  gem?: boolean;
  /**
   * Maia policy probability (0..1) of the gem move at the rung it was detected
   * on — surfaced in the move-list gem popover. Set only when `gem` is true.
   */
  gemMaiaProbability?: number;
  /**
   * ELO rung the gem was detected at (the ELO-slider value at detection time) —
   * surfaced in the move-list gem popover. Set only when `gem` is true.
   */
  gemElo?: number;
  /**
   * True when the OPPONENT (not the user) played the gem — switches the popover
   * heading to "Your opponent found a gem move!". Set only when `gem` is true;
   * always false in free play (no opponent).
   */
  gemByOpponent?: boolean;
  /**
   * True when this node's arrival move is a "great" move (Phase 175,
   * SEED-108) — renders GreatMoveIcon instead of the severity glyph. Mutually
   * exclusive with `severity`/`gem` by construction (classifyGreat requires
   * the clear best move, never a blunder/mistake, and the (GEM_MAIA_MAX_PROB,
   * GREAT_MAIA_MAX_PROB] band excludes any maia_prob that would also qualify
   * as a gem).
   */
  great?: boolean;
  /**
   * Maia policy probability (0..1) of the great move at the rung it was
   * detected on — surfaced in the move-list great popover. Set only when
   * `great` is true.
   */
  greatMaiaProbability?: number;
  /**
   * ELO rung the great move was detected at (the ELO-slider value at
   * detection time) — surfaced in the move-list great popover. Set only when
   * `great` is true.
   */
  greatElo?: number;
  /**
   * True when the OPPONENT (not the user) played the great move — switches
   * the popover heading to "Your opponent found a great move!". Set only
   * when `great` is true; always false in free play (no opponent).
   */
  greatByOpponent?: boolean;
  /**
   * True when this node's ply is within `opening_ply_count` (Phase 172,
   * SEED-106 D-08) — set at the `Analysis.tsx` call site that builds
   * `moveListMarkers`. Lowest precedence in `severity > gem/great > book`:
   * severity, gem, and great all override it.
   */
  book?: boolean;
  /**
   * Phase 200 UAT: this node's arrival move is the engine's own best move —
   * renders `BestMoveIcon`. Set only by Train's free-play move list, which
   * runs no Maia and therefore labels what the Analysis page would call a gem
   * or a great move simply "best". The Analysis page never sets this.
   */
  best?: boolean;
  /**
   * Phase 200 UAT: this node's arrival move is clean but not the best move —
   * renders `GoodMoveIcon`. Same Train-only provenance as `best`; an
   * inaccuracy is presentation-collapsed into this tier by the caller
   * (`toDisplayQuality`), matching the Train reveal board.
   */
  good?: boolean;
  /** FlawMarker.ply — passed to onPvChipClick for the useTacticLines fetch key
   *  (this node's own flaw — allowed chip + severity glyph). */
  ply: number;
  /**
   * Flaw ply for the MISSED chip when it is shown one ply before its flaw
   * (Quick w8k item 5): the decision node hosts the missed tactic that belongs to
   * the flaw at this ply. Defaults to `ply` when the missed tactic is the node's own.
   */
  missedPly?: number;
}

export interface VariationTreeProps {
  nodes: Map<NodeId, MoveNode>;
  mainLine: NodeId[];
  currentNodeId: NodeId | null;
  /** Game ply of rootFen, for move-number labels. Default 0. */
  rootPly?: number;
  /** Called with the node id when a move chip is clicked. Wired to goToNode in Phase 138. */
  onNodeClick: (nodeId: NodeId) => void;
  /** Height override passed to the mobile HorizontalMoveList. */
  heightClass?: string;
  /**
   * Optional per-node text color (CSS color string), keyed by node id. Used in
   * tactic mode to mark the depth-0 target (blue) and the blunder (red) in the
   * desktop move list. Applied only on desktop; the current node keeps its
   * primary highlight. Ignored on mobile (the tactic SAN ladder carries the
   * mobile decorations).
   */
  decorations?: Map<NodeId, string>;

  // ── Flat sibling lines + flaw chips (Quick 260703-kyb) ───────────────────────

  /**
   * Membership set of every node belonging to a currently OPEN tactic line
   * (grafted by insertPvLine). A sibling block whose root is in this set is a
   * tactic line (closes via its chip, no × affordance); any other non-mainLine
   * block is a free-move line (closes via its × affordance).
   */
  pvNodeIds?: Set<NodeId>;
  /**
   * Flaw marker data keyed by mainLine node id. Only nodes that have at least one
   * tactic motif (missed/allowed) or a non-inaccuracy severity receive an entry.
   * Built by Analysis.tsx from gameData.flaw_markers.
   */
  flawMarkerByNodeId?: Map<NodeId, FlawMarkerEntry>;
  /**
   * Called when the user clicks a missed/allowed chip. Analysis.tsx fetches the
   * PV via useTacticLines and calls insertPvLine on arrival (toggle off on
   * re-click of the SAME chip; other open lines are left untouched).
   */
  onPvChipClick?: (nodeId: NodeId, flaw: { ply: number; orientation: 'missed' | 'allowed' }) => void;
  /**
   * Set of `${ply}:${orientation}` keys for every currently OPEN tactic chip.
   * Multiple chips can be simultaneously "on" (flat siblings).
   */
  activePvKeys?: Set<string>;
  /** True while the tactic-lines fetch for the active chip is in flight. */
  pvFetchPending?: boolean;
  /** True when the tactic-lines fetch for the active chip returned an error. */
  pvFetchError?: boolean;
  /**
   * Called with a free-move sideline's root node id when its × delete
   * affordance is clicked. Tactic lines (root ∈ pvNodeIds) render no ×; they
   * close via their chip (onPvChipClick) instead.
   */
  onDeleteLine?: (rootId: NodeId) => void;
  /**
   * Layout variant. `'responsive'` (default) keeps the breakpoint split — horizontal
   * strip on mobile, vertical paired list on desktop. `'vertical'` forces the vertical
   * paired list at every width (used in the mobile analysis Moves tab so the move list
   * fills the available vertical space instead of collapsing to a single horizontal row).
   */
  variant?: 'responsive' | 'vertical';
  /**
   * Game-mode ply the board first lands on (the URL `ply` param, defaulting to 0 — or the
   * tactic fork ply when the entry ply auto-opens a tactic line: decision board `ply-1` for
   * missed, flaw ply for allowed, Quick 260702-fog). When set, the desktop move list aligns
   * the move at this ply to the TOP of the scroller on first open instead of minimal-
   * scrolling it to the bottom (Quick 260628-qta UAT). Omitted / null in free play, where
   * the initial-align is skipped.
   */
  initialPly?: number | null;
  /**
   * Nonce that, when incremented, top-aligns the freshly-navigated active move to
   * the top of the scroller on the next settle (instead of the default minimal-scroll
   * that would reveal a downward jump at the BOTTOM). Bumped by tag/flaw-line clicks in
   * the Analysis tags panel so a missed/allowed flaw's move sits at the top with its
   * unfolded sideline visible below it. Omitted for plain move-by-move navigation, which
   * keeps the minimal keep-in-view scroll.
   */
  topAlignSeq?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A single flat sibling sideline block (Quick 260703-kyb — one indent level only). */
interface SiblingBlock {
  /** The block's first node id (a graft target for insertPvLine / a free fork's own id). */
  rootId: NodeId;
  /** The node this block branches off — null only when it branches off the true root
   *  position (before mainLine[0]; possible via goBack()+makeMove at the decision board). */
  forkParentId: NodeId | null;
  /** Index in mainLine of the nearest mainLine ancestor; -1 when forkParentId is null
   *  (branches off the position BEFORE mainLine[0]). */
  nearestMainIdx: number;
  /** Ordered node ids: rootId, then the lowest-id child chain. */
  chain: NodeId[];
  /** True when rootId belongs to a currently open tactic line (pvNodeIds membership). */
  isTactic: boolean;
  /** Non-null only for a sub-fork (forkParentId itself is off mainLine): the fork
   *  parent's SAN, so the block shows where it diverges (no second indent level). */
  branchLabel: string | null;
}

/** Derive the ply offset of a position from its FEN (mirrors Analysis.tsx's fenToRootPly). */
function plyFromFen(fen: string | undefined): number {
  if (!fen) return 0;
  const parts = fen.split(' ');
  const side = parts[1];
  const fullmove = parts[5];
  if (side === undefined || fullmove === undefined) return 0;
  const ply = (Number(fullmove) - 1) * 2 + (side === 'b' ? 1 : 0);
  return Number.isNaN(ply) ? 0 : ply;
}

/** The lowest-id (insertion-order-first) child of `parentId`, or undefined if none. */
function findLowestIdChild(
  nodes: Map<NodeId, MoveNode>,
  parentId: NodeId | null,
): MoveNode | undefined {
  let lowest: MoveNode | undefined;
  for (const node of nodes.values()) {
    if (node.parentId === parentId && (!lowest || node.id < lowest.id)) lowest = node;
  }
  return lowest;
}

/** Walk parentId up from `startId` until a mainLine node (or root) is reached. */
function nearestMainLineIdx(
  nodes: Map<NodeId, MoveNode>,
  mainLine: NodeId[],
  startId: NodeId | null,
): number {
  const mainLineSet = new Set(mainLine);
  let id = startId;
  while (id !== null) {
    if (mainLineSet.has(id)) return mainLine.indexOf(id);
    id = nodes.get(id)?.parentId ?? null;
  }
  return -1;
}

/** The starting ply of a block's first move, derived from its fork parent's FEN. */
function blockStartPly(
  nodes: Map<NodeId, MoveNode>,
  forkParentId: NodeId | null,
  rootPly: number,
): number {
  if (forkParentId === null) return rootPly;
  return plyFromFen(nodes.get(forkParentId)?.fen);
}

/**
 * Enumerate every sideline as a flat SiblingBlock — one indent level, no
 * recursive nesting (Quick 260703-kyb).
 *
 * A non-mainLine node is a BRANCH ROOT iff its parent is on mainLine (or is the
 * true root), OR its parent is off mainLine AND it is NOT that parent's
 * lowest-id child (a secondary sub-fork). The lowest-id child of an off-mainLine
 * node instead EXTENDS its parent's block — so a block's chain is its root, then
 * the lowest-id child of the tail, repeated. Every higher-id child along the way
 * becomes its own branch root, surfacing sub-forks as additional flat blocks
 * rather than deeper nesting.
 */
function buildSiblingBlocks(
  nodes: Map<NodeId, MoveNode>,
  mainLine: NodeId[],
  pvNodeIds: Set<NodeId>,
): SiblingBlock[] {
  const mainLineSet = new Set(mainLine);
  const blocks: SiblingBlock[] = [];

  for (const node of nodes.values()) {
    if (mainLineSet.has(node.id)) continue;
    const parentId = node.parentId;
    const parentOnMainOrRoot = parentId === null || mainLineSet.has(parentId);
    const isRoot = parentOnMainOrRoot || findLowestIdChild(nodes, parentId)?.id !== node.id;
    if (!isRoot) continue;

    const chain: NodeId[] = [node.id];
    let tailId = node.id;
    for (let child = findLowestIdChild(nodes, tailId); child; child = findLowestIdChild(nodes, tailId)) {
      chain.push(child.id);
      tailId = child.id;
    }

    blocks.push({
      rootId: node.id,
      forkParentId: parentId,
      nearestMainIdx: nearestMainLineIdx(nodes, mainLine, parentId),
      chain,
      isTactic: pvNodeIds.has(node.id),
      branchLabel: parentOnMainOrRoot ? null : (nodes.get(parentId!)?.san ?? null),
    });
  }

  blocks.sort((a, b) => a.rootId - b.rootId);
  return blocks;
}

// ─── Desktop row types and builders ──────────────────────────────────────────

interface DesktopRow {
  moveNumber: number;
  whiteNodeId: NodeId | undefined;
  blackNodeId: NodeId | undefined;
}

function buildDesktopRows(mainLine: NodeId[], rootPly: number): DesktopRow[] {
  const rows: DesktopRow[] = [];
  let idx = 0;

  // When rootPly is odd (black to move at root), first row has only a black cell.
  if (rootPly % 2 !== 0 && mainLine.length > 0) {
    rows.push({
      moveNumber: Math.ceil((rootPly + 1) / 2),
      whiteNodeId: undefined,
      blackNodeId: mainLine[0]!, // safe: length > 0 checked above
    });
    idx = 1;
  }

  while (idx < mainLine.length) {
    const ply = rootPly + idx;
    rows.push({
      moveNumber: Math.ceil((ply + 1) / 2),
      whiteNodeId: mainLine[idx]!, // safe: idx < length (loop invariant)
      blackNodeId: idx + 1 < mainLine.length ? mainLine[idx + 1]! : undefined,
    });
    idx += 2;
  }

  return rows;
}

/** Build desktop rows for a sibling block's chain, starting at the given ply. */
function buildRowsFromPly(chain: NodeId[], startPly: number): DesktopRow[] {
  const rows: DesktopRow[] = [];
  let idx = 0;

  // When the first variation move is black's turn, open with a black-only row.
  if (startPly % 2 !== 0 && chain.length > 0) {
    rows.push({
      moveNumber: Math.ceil((startPly + 1) / 2),
      whiteNodeId: undefined,
      blackNodeId: chain[0]!, // safe: length > 0 checked above
    });
    idx = 1;
  }

  while (idx < chain.length) {
    const ply = startPly + idx;
    rows.push({
      moveNumber: Math.ceil((ply + 1) / 2),
      whiteNodeId: chain[idx]!, // safe: idx < length (loop invariant)
      blackNodeId: idx + 1 < chain.length ? chain[idx + 1]! : undefined,
    });
    idx += 2;
  }

  return rows;
}

// ─── Inline flaw chip renderer ────────────────────────────────────────────────

// Same highlight-bg helper as TacticMotifChip/TagChip: bump the translucent alpha
// from 0.15 to 0.3 on hover so the chip clearly reads as highlighted.
const HIGHLIGHT_BG = (bg: string): string => bg.replace('/ 0.15)', '/ 0.3)');

interface FlawChipProps {
  nodeId: NodeId;
  motif: string;
  orientation: 'missed' | 'allowed';
  ply: number;
  depth: number | null;
  /** Set of `${ply}:${orientation}` keys for every currently open tactic chip. */
  activePvKeys: Set<string> | undefined;
  pvFetchPending: boolean | undefined;
  pvFetchError: boolean | undefined;
  onPvChipClick:
    | ((nodeId: NodeId, flaw: { ply: number; orientation: 'missed' | 'allowed' }) => void)
    | undefined;
}

/**
 * Render a missed or allowed flaw pill chip for a mainLine move-list row.
 * Sibling to the SAN <button>, NOT nested inside it (D-02).
 * Loading: spinner on chip while pvFetchPending for this node.
 * Error: error text next to the chip when pvFetchError for this node.
 *
 * Hover affordance (Quick 260628): mirrors the Games-card TacticMotifChip — pointer
 * cursor, lift, and brightened background on hover so the chip reads as clickable.
 */
function FlawChip({
  nodeId,
  motif,
  orientation,
  ply,
  depth,
  activePvKeys,
  pvFetchPending,
  pvFetchError,
  onPvChipClick,
}: FlawChipProps): ReactNode {
  // Quick 260703-kyb: multiple chips read active via key membership (flat siblings),
  // not a node/orientation singleton match.
  const isActive = activePvKeys?.has(`${ply}:${orientation}`) ?? false;
  const isMissed = orientation === 'missed';
  const color = isMissed ? TAC_MISSED : TAC_ALLOWED;
  const bg = isMissed ? TAC_MISSED_BG : TAC_ALLOWED_BG;
  const border = isMissed ? TAC_MISSED_BORDER : TAC_ALLOWED_BORDER;
  // UAT 260627: show the motif name + depth (e.g. "checkmate 4", "hanging-piece 2")
  // instead of the orientation word. Mate-family motifs collapse to "checkmate";
  // depth uses the same orientation-anchored display offset as the board badges.
  const motifLabel = tacticMotifLabel(motif);
  // anchored=false (Quick 260628-1t5 DECISION 2): the move list is a navigable surface,
  // so the allowed +1 decision-anchor offset is dropped here (allowed reads like missed).
  const depthLabel = tacticDepthBadge(motif, depth, orientation, false);
  const label = depthLabel != null ? `${motifLabel} ${depthLabel}` : motifLabel;
  const testId = `flaw-inline-tag-${orientation}-${nodeId}`;
  const ariaCollapse = `${label} tactic. Click to collapse tactic line.`;
  const ariaExpand = `${label} tactic. Click to expand tactic line.`;

  // Brighten the chip while hovered/focused (tap-focus on mobile), like the Games card.
  const [highlighted, setHighlighted] = useState(false);

  const chipLabel =
    isActive && pvFetchPending ? (
      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
    ) : (
      <span className="text-sm font-medium">{label}</span>
    );

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        data-testid={testId}
        aria-label={isActive ? ariaCollapse : ariaExpand}
        className={cn(
          'inline-flex items-center h-5 px-1.5 rounded-full border ml-1',
          'cursor-pointer transition-all hover:-translate-y-px',
          isActive && ACTIVE_FILTER_RING_CLASS,
          isActive && pvFetchError && 'opacity-60',
        )}
        style={{
          color,
          backgroundColor: highlighted ? HIGHLIGHT_BG(bg) : bg,
          borderColor: border,
          filter: highlighted ? 'brightness(1.2)' : undefined,
        }}
        onMouseEnter={() => setHighlighted(true)}
        onMouseLeave={() => setHighlighted(false)}
        onFocus={() => setHighlighted(true)}
        onBlur={() => setHighlighted(false)}
        onClick={(e) => {
          e.stopPropagation();
          onPvChipClick?.(nodeId, { ply, orientation });
        }}
      >
        {chipLabel}
      </button>
      {isActive && pvFetchError && (
        <span className="text-sm text-muted-foreground ml-1" role="alert">
          Tactic line not available for this flaw.
        </span>
      )}
    </span>
  );
}

// ─── Mobile sub-component ────────────────────────────────────────────────────

/**
 * Convert a single flat sibling block into chip items, wrapped in single
 * parentheses: the FIRST chip's numberLabel gets a leading "(", the LAST chip's
 * trailing gets the severity glyph, a closing ")", and — for a free-move block
 * only — the × delete affordance (Quick 260703-kyb — flat siblings, one paren
 * level, no Level-2 double-paren case).
 */
function siblingBlockToChips(
  block: SiblingBlock,
  nodes: Map<NodeId, MoveNode>,
  rootPlyVal: number,
  currentNodeId: NodeId | null,
  flawMarkerByNodeId: Map<NodeId, FlawMarkerEntry> | undefined,
  onDeleteLine: ((rootId: NodeId) => void) | undefined,
): HorizontalMoveItem[] {
  const startPly = blockStartPly(nodes, block.forkParentId, rootPlyVal);
  const items: HorizontalMoveItem[] = [];

  block.chain.forEach((nodeId, i) => {
    const node = nodes.get(nodeId);
    if (!node) return;
    const isWhite = (startPly + i) % 2 === 0;
    const label = isWhite ? moveLabel(startPly, i) : null;
    const isFirst = i === 0;
    const isLast = i === block.chain.length - 1;

    const flaw = flawMarkerByNodeId?.get(nodeId);

    const trailing = isLast ? (
      <span className="text-muted-foreground select-none inline-flex items-center">
        <MoveListMarker flaw={flaw} className="inline h-4 w-4 ml-0.5 align-middle" />
        {')'}
        {!block.isTactic && (
          <button
            type="button"
            data-testid={`btn-delete-line-${block.rootId}`}
            aria-label="Delete variation"
            className="text-muted-foreground hover:text-foreground inline-flex items-center ml-0.5"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteLine?.(block.rootId);
            }}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </span>
    ) : (
      <MoveListMarker flaw={flaw} className="inline h-4 w-4 ml-0.5 align-middle" />
    );

    items.push({
      key: nodeId,
      ply: nodeId,
      numberLabel: isFirst ? `(${label ?? ''}` : label,
      san: node.san,
      isCurrent: nodeId === currentNodeId,
      testId: `variation-node-${nodeId}`,
      ariaLabel: `Move ${label ?? ''} ${node.san}`.trim(),
      trailing,
    });
  });

  return items;
}

function MobileTree({
  nodes,
  mainLine,
  currentNodeId,
  pvNodeIds,
  rootPly,
  onNodeClick,
  heightClass,
  flawMarkerByNodeId,
  onDeleteLine,
}: VariationTreeProps) {
  const rootPlyVal = rootPly ?? 0;
  const resolvedPvNodeIds = pvNodeIds ?? new Set<NodeId>();
  const blocks = buildSiblingBlocks(nodes, mainLine, resolvedPvNodeIds);

  // Group blocks by the mainLine index they attach to (-1 = before mainLine[0]).
  // buildSiblingBlocks already sorts by rootId (fork-creation order), preserved here.
  const blocksByIdx = new Map<number, SiblingBlock[]>();
  for (const block of blocks) {
    const list = blocksByIdx.get(block.nearestMainIdx) ?? [];
    list.push(block);
    blocksByIdx.set(block.nearestMainIdx, list);
  }

  const chipsFor = (block: SiblingBlock): HorizontalMoveItem[] =>
    siblingBlockToChips(block, nodes, rootPlyVal, currentNodeId, flawMarkerByNodeId, onDeleteLine);

  const items: HorizontalMoveItem[] = [];
  for (const block of blocksByIdx.get(-1) ?? []) items.push(...chipsFor(block));

  mainLine.forEach((nodeId, idx) => {
    const node = nodes.get(nodeId);
    if (!node) return;
    const plyOffset = rootPlyVal + idx;
    const isWhite = plyOffset % 2 === 0;
    const label = isWhite ? moveLabel(rootPlyVal, idx) : null;

    // Severity marker for blunders/mistakes (mobile parity — D-02). Shown regardless
    // of a tactic chip on the move (UAT thl item 3); mobile renders no inline chip, so
    // the glyph is the only flaw cue here.
    const flaw = flawMarkerByNodeId?.get(nodeId);

    items.push({
      key: nodeId,
      ply: nodeId,
      numberLabel: label,
      san: node.san,
      isCurrent: nodeId === currentNodeId,
      testId: `variation-node-${nodeId}`,
      ariaLabel: `Move ${label ?? ''} ${node.san}`.trim(),
      trailing: <MoveListMarker flaw={flaw} className="inline h-4 w-4 ml-0.5 align-middle" />,
    });

    for (const block of blocksByIdx.get(idx) ?? []) items.push(...chipsFor(block));
  });

  return (
    <HorizontalMoveList
      items={items}
      onMoveClick={(ply) => onNodeClick(ply)}
      heightClass={heightClass ?? 'h-20 sm:h-20'}
      emptyText="No moves yet"
      testId="variation-tree-mobile"
    />
  );
}

// ─── Desktop sub-component ───────────────────────────────────────────────────

function DesktopTree({
  nodes,
  mainLine,
  currentNodeId,
  pvNodeIds,
  rootPly,
  onNodeClick,
  decorations,
  flawMarkerByNodeId,
  onPvChipClick,
  activePvKeys,
  pvFetchPending,
  pvFetchError,
  initialPly,
  topAlignSeq,
  onDeleteLine,
}: VariationTreeProps) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const rootPlyVal = rootPly ?? 0;
  const resolvedPvNodeIds = pvNodeIds ?? new Set<NodeId>();
  // Previous top-align nonce — a change means a tag/flaw-line click asked to top-align
  // the freshly-navigated move (rather than the default minimal-scroll). Seeded with the
  // incoming value so mount doesn't count as a command.
  const prevTopAlignSeq = useRef(topAlignSeq);

  // The node the board opens at in game mode (initialPly, defaulting to ply 0).
  // undefined in free play (empty mainLine) — the initial top-align branch is skipped.
  const initialNodeId = mainLine.length > 0 ? mainLine[initialPly ?? 0] : undefined;
  // Last mainLine node — used to detect (and skip) the initial-load last-node transient
  // in the scroll effect. A primitive NodeId (not the mainLine array) so it can sit in the
  // effect deps without re-running on every render.
  const lastNodeId = mainLine.length > 0 ? mainLine[mainLine.length - 1] : undefined;
  const didInitialAlign = useRef(false);

  // Scroll the active node into view whenever currentNodeId changes. On the FIRST settle
  // at the game's initial ply, align it to the TOP of the scroller (Quick 260628-qta UAT:
  // the selected move should sit at the top, not the bottom). loadMainLine first parks
  // currentNodeId at the game's LAST node before the board navigates to initialPly, so the
  // top-align is held until currentNodeId actually reaches initialNodeId — otherwise the
  // transient last node scrolls first and the initial ply lands via minimal-scroll at the
  // bottom. All later navigation uses minimal keep-in-view scrolling.
  useEffect(() => {
    if (currentNodeId === null) return;
    const el = activeRef.current;
    if (!el) return;
    // A tag/flaw-line click bumps topAlignSeq to force the freshly-navigated move to the
    // TOP (so a downward jump lands at the top with any unfolded sideline visible below,
    // not clipped at the bottom by the default minimal-scroll). Checked before the initial
    // branch so a mid-session command always wins.
    if (topAlignSeq !== prevTopAlignSeq.current) {
      prevTopAlignSeq.current = topAlignSeq;
      didInitialAlign.current = true;
      scrollActiveIntoView(el, 'start');
      return;
    }
    if (!didInitialAlign.current && initialNodeId !== undefined) {
      // Skip ONLY the initial-load last-node transient: loadMainLine parks currentNodeId at
      // the last mainLine node before the board navigates to the initial ply, and we don't
      // want that transient to scroll before the initial ply top-aligns. A mid-session
      // remount (mobile tab switch back to Moves after cycling tags) has no such transient —
      // currentNodeId is already the user's actual position — so fall through and top-align
      // to it instead of waiting forever for an initialNodeId settle that never comes.
      // (Quick 260702-nm8 follow-up. Edge case: a remount while genuinely parked on the last
      // node is indistinguishable from the transient and won't auto-scroll — acceptable.)
      if (currentNodeId !== initialNodeId && currentNodeId === lastNodeId && initialNodeId !== lastNodeId) {
        return;
      }
      didInitialAlign.current = true;
      scrollActiveIntoView(el, 'start');
      return;
    }
    scrollActiveIntoView(el, 'nearest');
  }, [currentNodeId, topAlignSeq, initialNodeId, lastNodeId]);

  if (mainLine.length === 0 && nodes.size === 0) {
    return (
      <div
        data-testid="variation-tree-desktop"
        aria-label="Move list"
        role="navigation"
        className="min-h-0 flex-1 overflow-y-auto thin-scrollbar"
      >
        <p className="text-sm text-muted-foreground p-2">No moves yet</p>
      </div>
    );
  }

  const mainRows = buildDesktopRows(mainLine, rootPlyVal);

  // Flat sibling blocks — one per open sideline (tactic or free-move), grouped by
  // the mainLine row they attach to (Quick 260703-kyb).
  const blocks = buildSiblingBlocks(nodes, mainLine, resolvedPvNodeIds);
  const blocksByRow = new Map<number, SiblingBlock[]>();
  for (const block of blocks) {
    const mainNodeId = block.nearestMainIdx >= 0 ? mainLine[block.nearestMainIdx] : undefined;
    const rowIdx =
      mainNodeId !== undefined
        ? mainRows.findIndex((r) => r.whiteNodeId === mainNodeId || r.blackNodeId === mainNodeId)
        : -1;
    const list = blocksByRow.get(rowIdx) ?? [];
    list.push(block);
    blocksByRow.set(rowIdx, list);
  }

  const renderMoveButton = (
    nodeId: NodeId,
    label: string,
    isVariation: boolean,
  ): ReactNode => {
    const node = nodes.get(nodeId);
    if (!node) return null;
    const isCurrent = nodeId === currentNodeId;
    const decoColor = !isCurrent ? decorations?.get(nodeId) : undefined;

    // Flaw marker for mainLine nodes only (not sideline nodes) — drives the
    // tactic chips, which stay main-line-only.
    const flaw = !isVariation ? flawMarkerByNodeId?.get(nodeId) : undefined;
    const hasTacticChip = flaw != null && (flaw.missedMotif != null || flaw.allowedMotif != null);
    // Severity glyph source: main-line nodes use their flaw entry; sideline/free nodes read
    // the same map (moveListMarkers) for ANY node, not only the current one — so the live
    // blunder/mistake glyph persists on every explored sideline move instead of vanishing when
    // the user steps forward (Quick 260628-r5v UAT). The variation entries come from the
    // per-node live-flaw cache merged in by Analysis.tsx.
    const severityFlaw = flaw ?? flawMarkerByNodeId?.get(nodeId);
    // Show the blunder/mistake/gem glyph whenever it warrants one, even when a tactic
    // chip is also present (UAT thl item 3 — icon + chip read as complementary).

    // Tactic chips render on their OWN line below the move (Quick w8k item 3), so the
    // move text stays scannable and the pills don't crowd the SAN.
    return (
      <span className="inline-flex flex-col items-start gap-1">
        <span className="inline-flex items-center gap-0.5">
          <button
            ref={isCurrent ? activeRef : undefined}
            data-testid={`variation-node-${nodeId}`}
            aria-label={`Move ${label} ${node.san}`}
            aria-current={isCurrent ? 'step' : undefined}
            onClick={() => onNodeClick(nodeId)}
            className={cn(
              'text-sm font-mono px-1 py-0.5 rounded transition-colors hover:bg-accent',
              isCurrent && 'bg-primary text-primary-foreground hover:bg-primary/90',
              !isCurrent && isVariation && !decoColor && 'text-muted-foreground',
              decoColor && 'font-bold',
            )}
            style={decoColor ? { color: decoColor } : undefined}
          >
            {node.san}
          </button>
          {/* Non-tactic blunder/mistake severity glyph (or the gem badge with its
              rule popover) stays inline with the SAN — it reads as standard move
              annotation (e.g. "Qh4 ??"). */}
          <MoveListMarker flaw={severityFlaw} className="h-4 w-4 inline-block shrink-0" />
        </span>
        {/* Tactic pill chips on a new line below the move (Quick w8k item 3). Extra
            vertical gap + bottom padding keep stacked chips from crowding each other
            and the next row (Quick 260628). */}
        {hasTacticChip && (flaw.missedMotif != null || flaw.allowedMotif != null) && (
          <span className="inline-flex items-center flex-wrap gap-1 pb-1">
            {flaw.missedMotif != null && (
              <FlawChip
                key={`flaw-inline-tag-missed-${nodeId}`}
                nodeId={nodeId}
                motif={flaw.missedMotif}
                orientation="missed"
                // The missed chip's fetch/fork ply is its flaw's ply, even though the
                // chip is rendered on the decision node one ply earlier (item 5).
                ply={flaw.missedPly ?? flaw.ply}
                depth={flaw.missedDepth}
                activePvKeys={activePvKeys}
                pvFetchPending={pvFetchPending}
                pvFetchError={pvFetchError}
                onPvChipClick={onPvChipClick}
              />
            )}
            {flaw.allowedMotif != null && (
              <FlawChip
                key={`flaw-inline-tag-allowed-${nodeId}`}
                nodeId={nodeId}
                motif={flaw.allowedMotif}
                orientation="allowed"
                ply={flaw.ply}
                depth={flaw.allowedDepth}
                activePvKeys={activePvKeys}
                pvFetchPending={pvFetchPending}
                pvFetchError={pvFetchError}
                onPvChipClick={onPvChipClick}
              />
            )}
          </span>
        )}
      </span>
    );
  };

  const renderDesktopRow = (
    row: DesktopRow,
    isVariation: boolean,
    rowBg = '',
  ): ReactNode => {
    const whiteLabel = `${row.moveNumber}.`;
    const blackLabel = `${row.moveNumber}...`;
    return (
      <div className={cn('flex items-start min-h-[28px]', rowBg)}>
        <span className="w-8 shrink-0 py-0.5 text-sm text-muted-foreground select-none">
          {row.moveNumber}.
        </span>
        <div className="flex-1 min-w-0">
          {row.whiteNodeId !== undefined &&
            renderMoveButton(row.whiteNodeId, whiteLabel, isVariation)}
        </div>
        <div className="flex-1 min-w-0">
          {row.blackNodeId !== undefined &&
            renderMoveButton(row.blackNodeId, blackLabel, isVariation)}
        </div>
      </div>
    );
  };

  // Render one flat sibling block (Quick 260703-kyb): a header (branch label +
  // × delete for a free-move block) followed by its move rows. Kept as a
  // separate helper (not inlined in the JSX below) to keep the return block's
  // logic LOC in check (CLAUDE.md function-size limits).
  const renderSiblingBlock = (block: SiblingBlock, rowBg: string): ReactNode => {
    const startPly = blockStartPly(nodes, block.forkParentId, rootPlyVal);
    const rows = buildRowsFromPly(block.chain, startPly);
    const showHeader = block.branchLabel != null || !block.isTactic;
    return (
      <div
        key={block.rootId}
        data-testid={block.isTactic ? 'variation-pv-section' : 'variation-freemove-section'}
        // The whole sideline inherits the fork row's zebra band (item 2).
        className={cn('ml-8 border-l-2 border-muted/40 pl-2', rowBg)}
      >
        {showHeader && (
          <div className="flex items-center justify-between min-h-[20px]">
            <span className="text-sm text-muted-foreground">
              {block.branchLabel != null ? `(after ${block.branchLabel})` : ''}
            </span>
            {!block.isTactic && (
              <button
                type="button"
                data-testid={`btn-delete-line-${block.rootId}`}
                aria-label="Delete variation"
                className="text-muted-foreground hover:text-foreground shrink-0 p-0.5"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteLine?.(block.rootId);
                }}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
        )}
        {rows.map((row, rowIdx) => (
          <Fragment key={rowIdx}>{renderDesktopRow(row, true)}</Fragment>
        ))}
      </div>
    );
  };

  return (
    <div
      data-testid="variation-tree-desktop"
      aria-label="Move list"
      role="navigation"
      // Absolute-fill the `relative` flex parent so the move list NEVER inflates the
      // outer row's intrinsic height (Quick w8k item 2 — the 4th alignment attempt).
      // Root cause measured in-browser: the outer row is lg:items-stretch and the left
      // board column (board + eval chart) is SHORTER than the right column; a
      // max-h/mb-capped flex-grow list still reports its content height as the row's
      // intrinsic height, so items-stretch stretched the left column past the eval
      // slider (42px dead space) while the controls pinned to the true bottom. Taking
      // the scroller out of flow (absolute inset-0) lets the board column drive the row
      // height, so the controls bottom-align with the eval-chart slider — no magic px.
      // pl-2 indents the move rows off the card's left edge (scrollbar stays flush right).
      className="absolute inset-0 overflow-y-auto thin-scrollbar pl-2"
    >
      {(blocksByRow.get(-1) ?? []).map((block) => renderSiblingBlock(block, ''))}
      {mainRows.map((row, rowIdx) => (
        <Fragment key={rowIdx}>
          {renderDesktopRow(row, false, zebraBg(rowIdx))}
          {(blocksByRow.get(rowIdx) ?? []).map((block) =>
            renderSiblingBlock(block, zebraBg(rowIdx)),
          )}
        </Fragment>
      ))}
    </div>
  );
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * VariationTree — navigable move list showing the main line + every open
 * sideline as a flat sibling block. Click any node to call onNodeClick(nodeId)
 * (→ goToNode).
 *
 * Quick 260703-kyb: pvNodeIds/flawMarkerByNodeId/onPvChipClick/activePvKeys/
 * onDeleteLine enable inline tactic chip expansion and free-move × deletion —
 * one indent level only, no recursive nesting, no promote-to-mainline. All new
 * props are optional so existing callers require no changes.
 */
export function VariationTree(props: VariationTreeProps) {
  // `variant='vertical'` forces the paired vertical list at every width (mobile
  // analysis Moves tab); the default `'responsive'` keeps the breakpoint split.
  if (props.variant === 'vertical') {
    return (
      <div
        data-testid="analysis-variation-tree"
        aria-label="Move list"
        role="navigation"
        className="relative flex min-h-0 flex-1 flex-col"
      >
        <DesktopTree {...props} />
      </div>
    );
  }
  return (
    <div
      data-testid="analysis-variation-tree"
      aria-label="Move list"
      role="navigation"
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* Mobile path — HorizontalMoveList with variation inline in parentheses */}
      <div className="sm:hidden">
        <MobileTree {...props} />
      </div>
      {/* Desktop path — vertical paired N. white black list, fills the column so the
          board controls below it bottom-align with the eval-chart slider. `relative`
          so DesktopTree's absolute-fill scroller anchors here (Quick w8k item 2). */}
      <div className="relative hidden min-h-0 flex-1 sm:flex sm:flex-col">
        <DesktopTree {...props} />
      </div>
    </div>
  );
}
