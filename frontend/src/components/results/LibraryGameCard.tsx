import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Chess } from 'chess.js';
import { BookOpen, Calendar, Clock, Equal, ExternalLink, Hash, Minus, Plus, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  MOVE_HIGHLIGHT_SQUARE,
  MOVE_HIGHLIGHT_BLUNDER,
  MOVE_HIGHLIGHT_MISTAKE,
  MOVE_HIGHLIGHT_GOOD,
  MOVE_HIGHLIGHT_GEM,
  MOVE_HIGHLIGHT_GREAT,
  WDL_BORDER_DRAW,
  WDL_BORDER_LOSS,
  WDL_BORDER_WIN,
  BEST_MOVE_ARROW,
  TAC_ALLOWED,
  TAC_ALLOWED_LABEL,
  TAC_MISSED,
  TAC_MISSED_LABEL,
} from '@/lib/theme';
import type { SquareMarker } from '@/components/board/boardMarkers';
import { uciToSquares } from '@/lib/sanToSquares';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import { PlatformIcon } from '@/components/icons/PlatformIcon';
import { LazyMiniBoard } from '@/components/board/LazyMiniBoard';
import { EvalChart } from '@/components/library/EvalChart';
import { MoveStats } from '@/components/library/MoveStats';
import type { MoveStatsCellRef } from '@/components/library/MoveStats';
import type { MoveStatCategory, MoveStatSide } from '@/lib/moveStatsCounts';
import { moverColorAtPly } from '@/lib/plyOwnership';
import { TagChip, TagLegend } from '@/components/library/TagChip';
import { TacticMotifGroup } from '@/components/library/TacticMotifGroup';
import { ChipColumn } from '@/components/library/ChipColumn';
import {
  tacticMotifLabel,
  TACTIC_FAMILY_FOR_MOTIF,
  tacticDepthBadge,
  resolveVisibleTactic,
} from '@/lib/tacticComparisonMeta';
import { NoAnalysisState } from '@/components/library/NoAnalysisState';
import { gamePlatformUrl, platformPlyUrl } from '@/lib/platformLinks';
import { buildGameAnalysisUrl } from '@/lib/analysisUrl';
import { plysToFullMoves } from '@/lib/chess';
import { useFlawFilterStore } from '@/hooks/useFlawFilterStore';
import { DEFAULT_TACTIC_DEPTH_VALUE } from '@/lib/tacticDepth';
import { useMiniBoardSize } from '@/hooks/useMiniBoardSize';
import { formatTimeControl } from '@/lib/formatTimeControl';
import { Button } from '@/components/ui/button';
import type { GameFlawCard, FlawSeverity, FlawTag } from '@/types/library';
import type { UserResult } from '@/types/api';

// Standalone component per D-05 — do NOT import from or modify GameCard.tsx.
// formatDate / formatTimeControl copied verbatim from GameCard.tsx (same display requirements).

interface LibraryGameCardProps {
  game: GameFlawCard;
  /**
   * When the card is opened from the Flaws subtab, the ply of the clicked flaw. The
   * eval-chart scrub slider opens parked on this ply (instead of the last eval'd ply)
   * so the board and crosshair land on the flawed move on open. Omitted on the Games
   * subtab, where the slider defaults to the last eval'd ply.
   */
  initialPly?: number | null;
  /**
   * Controlled tier-1 "Analyzing…" state. When `onInFlightChange` is provided the
   * card is controlled: the parent owns the in-flight set (the Games subtab lifts it
   * to GamesTab so it can keep the games-list poll alive until the eval lands — the
   * global eval-coverage poll backs off after a stall and cannot be relied on for an
   * on-demand analyze, see GamesTab). When omitted the card manages in-flight locally
   * (the FlawCard modal, which has no parent list to coordinate).
   */
  isInFlight?: boolean;
  onInFlightChange?: (gameId: number, inFlight: boolean) => void;
}

const MOBILE_BOARD_SIZE = 130;
const DESKTOP_BOARD_SIZE = 225;

// Severity-coded last-move square overlay on the hover miniboard (Quick 260627-r9g
// item 5): inaccuracy keeps the legacy yellow; blunder/mistake get red/orange at the
// same alpha. The flaw itself is now a severity glyph in the target-square corner
// (item 4) rather than a red/orange/yellow arrow.
const MOVE_HIGHLIGHT_SEVERITY: Record<FlawSeverity, string> = {
  blunder: MOVE_HIGHLIGHT_BLUNDER,
  mistake: MOVE_HIGHLIGHT_MISTAKE,
  inaccuracy: MOVE_HIGHLIGHT_SQUARE,
};

/** One reconstructed ply: the FEN after the move plus the move's from/to squares. */
interface PerPly {
  fen: string;
  from: string;
  to: string;
}

/**
 * Replay the SAN mainline once into per-ply {fen, to} entries (memoized per card).
 * moves[i] is the move at ply i, so perPly[i] is the position after that move —
 * matching eval_series[i].es (eval_cp is the post-move eval; see zobrist.py). The
 * moved piece sits at perPly[i].to, which the corner dot marks for M/B plies.
 * Stops early on a malformed SAN — earlier plies still scrub.
 */
function buildPerPly(moves: string[] | null): PerPly[] | null {
  if (!moves || moves.length === 0) return null;
  const chess = new Chess();
  const out: PerPly[] = [];
  for (const san of moves) {
    let mv;
    try {
      mv = chess.move(san);
    } catch {
      break;
    }
    if (!mv) break;
    out.push({ fen: chess.fen(), from: mv.from, to: mv.to });
  }
  return out.length > 0 ? out : null;
}

const RESULT_CLASSES: Record<UserResult, string> = {
  win: 'bg-green-600/20 text-green-400 border-green-600/30',
  draw: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  loss: 'bg-red-600/20 text-red-400 border-red-600/30',
};
const RESULT_ICONS: Record<UserResult, LucideIcon> = { win: Plus, draw: Equal, loss: Minus };
const BORDER_COLORS: Record<UserResult, string> = {
  win: WDL_BORDER_WIN,
  draw: WDL_BORDER_DRAW,
  loss: WDL_BORDER_LOSS,
};

// Flaw-tag families, mirroring the backend game-selection filter
// (build_flaw_filter_clauses in library_repository.py): OR within family, AND
// across families. The phase family is handled separately below — phase isn't
// stored in a marker's tag list, so it's derived from phase_transitions.
const TAG_FAMILIES: readonly (readonly FlawTag[])[] = [
  ['low-clock', 'hasty', 'unrushed'],
  ['miss', 'lucky'],
  ['reversed', 'squandered'],
];

// Phase family (Quick 260612-fow): a filterable family on the backend
// (game_flaws.phase). Markers don't carry a phase tag, so each ply's phase is
// derived from the game's phase_transitions to mirror the filter on the chart.
const PHASE_FILTER_TAGS: readonly FlawTag[] = ['opening', 'middlegame', 'endgame'];

/** Derive a ply's game phase from the transition plies (first ply of each phase). */
function plyPhase(
  ply: number,
  pt: { middlegame_ply: number | null; endgame_ply: number | null },
): FlawTag {
  if (pt.endgame_ply != null && ply >= pt.endgame_ply) return 'endgame';
  // Before middlegame starts = opening; otherwise middlegame (incl. when no
  // middlegame boundary was recorded for a short game).
  if (pt.middlegame_ply != null && ply < pt.middlegame_ply) return 'opening';
  return 'middlegame';
}

// A flaw chip/badge the user can hover (highlight) or click (cycle): a flaw-tag
// chip, a tactic-motif chip, or a severity badge. Shared by the hover-highlight
// and click-to-cycle paths.
// Quick 260620-pza: tactic chips carry orientation so "missed: fork" and
// "allowed: fork" are two distinct refs (separate chips, separate cycle keys).
type TacticChipOrientation = 'missed' | 'allowed';

// Quick 260620-sep: column render order (Missed before Allowed, per UAT) + the muted
// labels for the grouped tactic columns on the Games-tab card.
const TACTIC_ORIENTATIONS: readonly TacticChipOrientation[] = ['missed', 'allowed'];
const TACTIC_ORIENTATION_LABELS: Record<TacticChipOrientation, string> = {
  allowed: 'Allowed',
  missed: 'Missed',
};

type FlawRef =
  | { kind: 'tag'; tag: FlawTag }
  | { kind: 'motif'; motif: string; orientation: TacticChipOrientation }
  // Move Stats (category × side) cell (Phase 179 Plan 03, D-09) — replaces the
  // former separate 'severity'/'bestMove' kinds. category spans all 7 Move
  // Stats rows (severities + positive tiers); side is the literal board color
  // of the mover (moverColorAtPly), NOT user-relative — D-08 deliberately
  // surfaces both players' cells on this surface.
  | { kind: 'category'; category: MoveStatCategory; side: MoveStatSide };

function sameFlawRef(a: FlawRef, b: FlawRef): boolean {
  if (a.kind === 'tag' && b.kind === 'tag') return a.tag === b.tag;
  if (a.kind === 'motif' && b.kind === 'motif')
    return a.motif === b.motif && a.orientation === b.orientation;
  if (a.kind === 'category' && b.kind === 'category')
    return a.category === b.category && a.side === b.side;
  return false;
}

/** Composite key for the (category × side) plies map (categoryPlies). */
function categoryPliesKey(category: MoveStatCategory, side: MoveStatSide): string {
  return `${category}:${side}`;
}

// Composite key for the orientation-scoped motif → plies map (motifPlies).
function motifPliesKey(orientation: TacticChipOrientation, motifLabel: string): string {
  return `${orientation}:${motifLabel}`;
}

// Copied verbatim from GameCard.tsx — same display requirements (D-05 forbids shared import).
function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

/**
 * Analyzed game card for the Library Games subtab.
 *
 * Standalone component per D-05 — does NOT extend or modify GameCard. Borrows
 * GameCard's metadata/board/platform patterns but adds a full-width header, a
 * responsive body (1 column mobile, 2 columns tablet, 3 columns desktop), and a
 * flaw block on mobile.
 *
 * Flaw column branches on analysis_state:
 * - "analyzed"         → MoveStats (accuracies card + two-sided category table)
 *                        + Missed/Allowed/Context tags card
 * - "no_engine_analysis" → NoAnalysisState pill (never shows "0 Blunders")
 *
 * Security: all user-provided strings (usernames, opening name, platform_url) are
 * rendered as React children or href (auto-escaped). platform_url uses
 * target="_blank" rel="noopener noreferrer" to prevent reverse-tabnabbing (T-107-10).
 */
export function LibraryGameCard({
  game,
  initialPly,
  isInFlight: isInFlightProp,
  onInFlightChange,
}: LibraryGameCardProps) {
  // Live miniboard: hovering the eval chart sets the ply; the board scrubs to
  // that position and (on M/B plies) marks the moved piece. At rest the board
  // shows result_fen, as before.
  const [hoverPly, setHoverPly] = useState<number | null>(null);

  // In-flight state for the tier-1 analyze button (D-118-11 — only the clicked game
  // shows "Analyzing…", not a global spinner across all cards). Controlled when the
  // parent passes onInFlightChange (Games subtab); otherwise managed locally
  // (FlawCard modal). See LibraryGameCardProps.isInFlight.
  const isControlled = onInFlightChange !== undefined;
  const [localInFlight, setLocalInFlight] = useState(false);
  const isInFlight = isControlled ? (isInFlightProp ?? false) : localInFlight;
  const setInFlight = (next: boolean): void => {
    if (isControlled) onInFlightChange(game.game_id, next);
    else setLocalInFlight(next);
  };

  const isAnalyzed = game.analysis_state === 'analyzed';

  // Narrowed user color (game.user_color is typed `string`). Used to scope the
  // gem/great surfaces to the user's OWN plies — best_move_tier is position-scoped,
  // so gems/greats exist on the opponent's moves too and must be excluded (Plan 06 fix).
  const userColor: 'white' | 'black' | undefined =
    game.user_color === 'white' || game.user_color === 'black' ? game.user_color : undefined;

  // Clear in-flight state when the games list refetches and the game flips to
  // analyzed — prevents the card staying stuck in "Analyzing…" after the eval
  // completes and the query refreshes (D-118-11).
  useEffect(() => {
    if (isAnalyzed && isInFlight) {
      if (isControlled) onInFlightChange(game.game_id, false);
      else setLocalInFlight(false);
    }
  }, [isAnalyzed, isInFlight, isControlled, onInFlightChange, game.game_id]);

  const perPly = useMemo(() => buildPerPly(game.moves), [game.moves]);
  // Last eval'd ply = the eval-chart slider's max (and its default resting position
  // on the Games subtab). The chart trims trailing eval-less plies (trimToEvalRange),
  // so this is the last point with a non-null es. Used to decide whether the header
  // platform link deep-links to the scrubbed move or just opens the game (below).
  const lastEvalPly = useMemo<number | null>(() => {
    const series = game.eval_series;
    if (!series) return null;
    for (let i = series.length - 1; i >= 0; i--) {
      const p = series[i];
      if (p && p.es != null) return p.ply;
    }
    return null;
  }, [game.eval_series]);
  // All flaw severities (blunder/mistake/inaccuracy) get a corner dot on the
  // hover miniboard, colored by severity. One marker per ply (a ply is a single
  // half-move), so the map key never collides.
  const flawByPly = useMemo(() => {
    const m = new Map<number, FlawSeverity>();
    for (const fm of game.flaw_markers ?? []) {
      m.set(fm.ply, fm.severity);
    }
    return m;
  }, [game.flaw_markers]);


  // Per-ply tactic-depth badges (1-based display). missed → blue best-move arrow,
  // allowed → colored flaw-move arrow. Null when the tactic's motif chip is hidden.
  // Allowed is decision-anchored (+1 vs missed): the opponent's refutation line
  // starts one ply after the shared decision board (Quick 260621-qz9).
  const tacticDepthByPly = useMemo(() => {
    const m = new Map<number, { missed?: string; allowed?: string }>();
    for (const fm of game.flaw_markers ?? []) {
      // tacticDepthBadge returns null for family-less motifs (promotion (28),
      // self-interference (14)), so their depth never leaks onto the board as a
      // bare number with no chip to explain it (D-09).
      // anchored=false (Quick 260628-1t5 DECISION 2): on the navigable miniboard the
      // missed and allowed depths are no longer co-anchored on one decision board, so the
      // allowed +1 offset is dropped — allowed reads on the same plain scale as missed.
      const missed = tacticDepthBadge(fm.missed_tactic_motif, fm.missed_tactic_depth, 'missed', false);
      const allowed = tacticDepthBadge(
        fm.allowed_tactic_motif,
        fm.allowed_tactic_depth,
        'allowed',
        false,
      );
      if (missed != null || allowed != null)
        m.set(fm.ply, { missed: missed ?? undefined, allowed: allowed ?? undefined });
    }
    return m;
  }, [game.flaw_markers]);

  // Per-tag occurrence counts shown on the chips. Scoped to the user's M/B markers
  // (is_user) so a chip count matches the user-only `chips`/`severity_counts` the
  // card already shows, and so the count equals the number of dots that highlight
  // on hover. Inaccuracy markers carry no tags, so they never contribute.
  const tagCounts = useMemo(() => {
    const m = new Map<FlawTag, number>();
    for (const fm of game.flaw_markers ?? []) {
      if (!fm.is_user) continue;
      for (const t of fm.tags) m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }, [game.flaw_markers]);

  // Per-tag ascending list of the user's marker plies, for click-to-cycle: clicking
  // a tag chip steps the eval-chart slider through these plies (showing each
  // flaw's tooltip). Scoped to is_user M/B markers, matching the chip counts.
  const tagPlies = useMemo(() => {
    const m = new Map<FlawTag, number[]>();
    for (const fm of game.flaw_markers ?? []) {
      if (!fm.is_user) continue;
      for (const t of fm.tags) {
        const arr = m.get(t);
        if (arr) arr.push(fm.ply);
        else m.set(t, [fm.ply]);
      }
    }
    for (const arr of m.values()) arr.sort((a, b) => a - b);
    return m;
  }, [game.flaw_markers]);

  // Set of the user's marker plies that pass the active context-tag filter
  // (low-clock/hasty/unrushed, miss/lucky, reversed/squandered) + phase family, under
  // the SAME predicate used to select games (OR within family, AND across families —
  // build_flaw_filter_clauses). Returns null when no context/phase filter is active.
  //
  // Quick 260702-mnd: this is now the eval chart's ONLY consumer — the persistent
  // white marker outline (passed as `outlinedPlies`, mirroring the TagChip ring).
  // It no longer gates the tactic-motif chip derivations below (motifPlies,
  // tacticMotifs, highlightedPlies) — those now render/highlight unconditionally,
  // consistent with the context chips (which never gated on this set either).
  const [flawFilter] = useFlawFilterStore();
  const filterTags = flawFilter.tags;
  const outlinedPlies = useMemo(() => {
    const filterSet = new Set<FlawTag>(filterTags);
    // Per family with ≥1 selected tag, keep the selected subset (the OR-within group).
    const requiredGroups = TAG_FAMILIES.map((fam) => fam.filter((t) => filterSet.has(t))).filter(
      (sel) => sel.length > 0,
    );
    // Phase family is derived per-ply (markers carry no phase tag), AND-ed across.
    const phaseSel = PHASE_FILTER_TAGS.filter((t) => filterSet.has(t));
    if (requiredGroups.length === 0 && phaseSel.length === 0) return null; // no tag filter → no outline
    const pt = game.phase_transitions;
    const set = new Set<number>();
    for (const fm of game.flaw_markers ?? []) {
      if (!fm.is_user) continue;
      const markerTags = new Set<FlawTag>(fm.tags);
      // AND across families: every selected family group must be satisfied by ≥1 tag.
      if (!requiredGroups.every((sel) => sel.some((t) => markerTags.has(t)))) continue;
      // AND the phase family (OR within): the ply's derived phase must be selected.
      if (phaseSel.length > 0 && (!pt || !phaseSel.includes(plyPhase(fm.ply, pt)))) continue;
      set.add(fm.ply);
    }
    return set;
  }, [filterTags, game.flaw_markers, game.phase_transitions]);

  // Per-tactic-motif ascending list of the user's marker plies, for click-to-cycle
  // on the tactic-motif chips (Phase 126 UAT). Quick 260620-pza: keyed by
  // orientation + display label (motifPliesKey) so the missed and allowed chips for
  // the same motif cycle through their own plies independently. Keying on the display
  // label (not raw motif) collapses every mate subtype to the single "checkmate" key
  // so one chip cycles through all checkmate plies (Quick 260620-onv).
  // Quick 260702-mnd: tactic chips now render unconditionally on every analyzed
  // card, independent of the active context/tactic filter — a selected card is a
  // complete picture of its own flaws (consistent with context chips, which never
  // pruned by filter). outlinedPlies keeps its ONE remaining role: driving the
  // eval-chart white marker outline (below); it no longer gates tactic derivations.
  const motifPlies = useMemo(() => {
    const m = new Map<string, number[]>();
    const push = (key: string, ply: number): void => {
      const arr = m.get(key);
      if (arr) arr.push(ply);
      else m.set(key, [ply]);
    };
    for (const fm of game.flaw_markers ?? []) {
      if (!fm.is_user) continue;
      if (fm.allowed_tactic_motif != null)
        push(motifPliesKey('allowed', tacticMotifLabel(fm.allowed_tactic_motif)), fm.ply);
      if (fm.missed_tactic_motif != null)
        push(motifPliesKey('missed', tacticMotifLabel(fm.missed_tactic_motif)), fm.ply);
    }
    for (const arr of m.values()) arr.sort((a, b) => a - b);
    return m;
  }, [game.flaw_markers]);

  // Move Stats (category × side) ascending ply lists (Phase 179 Plan 03, D-09),
  // for the MoveStats cells' click-to-cycle. Folds BOTH flaw_markers (I/M/B
  // severities) and eval_series (gem/great/best/good tiers) into one map keyed
  // by (category, side) via moverColorAtPly — NOT is_user/isUserPly, since D-08
  // deliberately surfaces both players' cells here (replaces the former
  // user-only severityPlies/bestMovePlies memos).
  const categoryPlies = useMemo(() => {
    const m = new Map<string, number[]>();
    const push = (category: MoveStatCategory, side: MoveStatSide, ply: number): void => {
      const key = categoryPliesKey(category, side);
      const arr = m.get(key);
      if (arr) arr.push(ply);
      else m.set(key, [ply]);
    };
    for (const fm of game.flaw_markers ?? []) {
      push(fm.severity, moverColorAtPly(fm.ply), fm.ply);
    }
    for (const pt of game.eval_series ?? []) {
      if (pt.best_move_tier == null) continue;
      push(pt.best_move_tier, moverColorAtPly(pt.ply), pt.ply);
    }
    for (const arr of m.values()) arr.sort((a, b) => a - b);
    return m;
  }, [game.flaw_markers, game.eval_series]);

  // Gem/great/best/good tier per ply — drives the scrubbed-miniboard corner badge
  // (below). Sourced from eval_series.best_move_tier, which is POSITION-scoped
  // (both players' tiers stored). Deliberately NOT user-scoped: the miniboard
  // corner badge mirrors the flaw corner dots (flawByPly above), which show BOTH
  // players' blunders/mistakes/inaccuracies — so scrubbing onto an opponent's
  // gem/great/best/good shows its icon too. MoveStats' own count/cycling
  // (categoryPlies above) is ALSO both-sided now (D-08) — this map and that one
  // now share the same "show everyone" scoping. Keyed by ply for the O(1) lookup
  // the squareMarkers memo needs.
  // Quick 260717-rbn widened this to carry 'best'/'good'; the both-players change
  // (opponent tiers on the miniboard) followed the flaw-dot precedent.
  const bestTierByPly = useMemo(() => {
    const m = new Map<number, 'gem' | 'great' | 'best' | 'good'>();
    for (const pt of game.eval_series ?? []) {
      if (
        pt.best_move_tier === 'gem' ||
        pt.best_move_tier === 'great' ||
        pt.best_move_tier === 'best' ||
        pt.best_move_tier === 'good'
      ) {
        m.set(pt.ply, pt.best_move_tier);
      }
    }
    return m;
  }, [game.eval_series]);

  // Transient hover highlight: hovering a tag chip or a severity badge in the flaw
  // column emphasizes the matching markers on this card's eval chart. Inaccuracy is
  // included — its markers are off-chart by default and get revealed on its hover.
  const [highlight, setHighlight] = useState<FlawRef | null>(null);
  // Click-to-cycle state, declared here so the highlight derivation below can keep a
  // clicked tag/severity's markers lit. `cycle` holds the active ref + index;
  // `commandSeq` is the chart-scrub nonce (see handleActivate).
  const [cycle, setCycle] = useState<{ ref: FlawRef; pos: number } | null>(null);
  const [commandSeq, setCommandSeq] = useState(0);

  // A clicked tag/severity (cycle) keeps its markers lit even after the pointer
  // leaves the chip — matching touch, where no mouse-leave fires to clear the hover
  // highlight. A live hover (`highlight`) takes precedence over the locked cycle ref.
  const highlightedPlies = useMemo(() => {
    const ref = highlight ?? cycle?.ref ?? null;
    if (!ref) return null;
    // Move Stats (category × side) plies come straight from the categoryPlies
    // map (D-09) — both sides, not gated by is_user (D-08).
    if (ref.kind === 'category')
      return new Set(categoryPlies.get(categoryPliesKey(ref.category, ref.side)) ?? []);
    const set = new Set<number>();
    for (const fm of game.flaw_markers ?? []) {
      if (!fm.is_user) continue;
      let matches: boolean;
      if (ref.kind === 'tag')
        matches = fm.tags.includes(ref.tag); // inaccuracies have no tags → never match a tag hover
      else {
        // Quick 260620-pza: match the orientation the chip represents.
        const col =
          ref.orientation === 'missed' ? fm.missed_tactic_motif : fm.allowed_tactic_motif;
        // Quick 260702-mnd: no longer gated by outlinedPlies (context filter) — hovering
        // or cycling a tactic chip highlights ALL of its plies, matching the
        // now-unconditional tactic-chip rendering (motifPlies/tacticMotifs above).
        matches = col != null && tacticMotifLabel(col) === ref.motif;
      }
      if (matches) set.add(fm.ply);
    }
    return set;
  }, [highlight, cycle, game.flaw_markers, categoryPlies]);

  // Mobile (<sm) miniboard spans 50% of the viewport width; sm+ keeps the fixed size.
  const mobileBoardSize = useMiniBoardSize(MOBILE_BOARD_SIZE);

  // Tactic motifs: collect unique (orientation, motif-label) pairs from user flaw
  // markers so the chip row shows one chip per distinct orientation+label
  // (D-10). Quick 260620-pza: BOTH orientations are surfaced — "missed: fork" and
  // "allowed: fork" are separate chips. Deduping on the display label (not the raw
  // motif) collapses named-mate subtypes to a single "checkmate" chip per orientation
  // (Quick 260620-onv). The label doubles as the chip's motif prop and FlawRef key —
  // TACTIC_FAMILY_FOR_MOTIF resolves "checkmate" via its alias. Allowed chips are
  // listed before missed chips (stable grouping).
  const tacticMotifs = useMemo<{ motif: string; orientation: TacticChipOrientation }[]>(() => {
    const seen = new Set<string>();
    const out: { motif: string; orientation: TacticChipOrientation }[] = [];
    const collect = (raw: string | null, orientation: TacticChipOrientation): void => {
      if (raw == null) return;
      // Skip family-less motifs (clearance, deflection, en-passant, …): they render
      // no chip and no legend row, so including them left an empty tactic row with a
      // stray legend tooltip icon (Quick 260620: empty tag tooltip icons).
      const label = tacticMotifLabel(raw);
      if (TACTIC_FAMILY_FOR_MOTIF[label] == null) return;
      const key = motifPliesKey(orientation, label);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ motif: label, orientation });
    };
    const markers = game.flaw_markers ?? [];
    // Quick 260702-mnd: surface every user tactic chip unconditionally — no longer
    // gated by the active context/tactic filter (matching motifPlies above).
    const passesContext = (fm: (typeof markers)[number]): boolean => fm.is_user;
    for (const fm of markers) if (passesContext(fm)) collect(fm.allowed_tactic_motif, 'allowed');
    for (const fm of markers) if (passesContext(fm)) collect(fm.missed_tactic_motif, 'missed');
    return out;
  }, [game.flaw_markers]);

  // Quick 260702-mnd (D-2): depth-aware active-filter ring. Since every tactic chip
  // now renders regardless of the filter, the ring must independently reflect the
  // full active filter (family + orientation + depth) so a same-family chip whose
  // plies fall OUTSIDE the depth range does NOT light up — "highlighted === actually
  // matches the active filter". True only when a tactic axis (not context tags or
  // severity) is non-default.
  const tacticFilterActive =
    flawFilter.tacticFamilies.length > 0 ||
    flawFilter.tacticOrientation !== 'either' ||
    flawFilter.tacticDepthMin !== DEFAULT_TACTIC_DEPTH_VALUE.min ||
    flawFilter.tacticDepthMax !== DEFAULT_TACTIC_DEPTH_VALUE.max;

  // Set of motifPlies-style keys (orientation:label) whose raw slot fully matches the
  // active filter on ALL axes via the shared resolveVisibleTactic predicate (the same
  // one the backend's tactic_slot_visible mirrors) — used to gate the ring per chip.
  const matchingFilterKeys = useMemo(() => {
    const set = new Set<string>();
    for (const fm of game.flaw_markers ?? []) {
      if (!fm.is_user) continue;
      const allowedMotif = fm.allowed_tactic_motif;
      if (
        allowedMotif != null &&
        resolveVisibleTactic('allowed', allowedMotif, fm.allowed_tactic_depth, flawFilter)
      ) {
        set.add(motifPliesKey('allowed', tacticMotifLabel(allowedMotif)));
      }
      const missedMotif = fm.missed_tactic_motif;
      if (
        missedMotif != null &&
        resolveVisibleTactic('missed', missedMotif, fm.missed_tactic_depth, flawFilter)
      ) {
        set.add(motifPliesKey('missed', tacticMotifLabel(missedMotif)));
      }
    }
    return set;
  }, [game.flaw_markers, flawFilter]);

  // Click-to-cycle: clicking a tag chip advances through that tag's flaw plies,
  // commanding the eval chart to scrub to each and show its tooltip. `cycle`/
  // `commandSeq` are declared above (the highlight derivation reads `cycle`). The
  // nonce re-fires the chart command on re-click or a single-ply tag; clicking a
  // different tag restarts at 0.
  const pliesForRef = (ref: FlawRef): number[] => {
    if (ref.kind === 'tag') return tagPlies.get(ref.tag) ?? [];
    if (ref.kind === 'category')
      return categoryPlies.get(categoryPliesKey(ref.category, ref.side)) ?? [];
    return motifPlies.get(motifPliesKey(ref.orientation, ref.motif)) ?? [];
  };
  const handleActivate = (ref: FlawRef) => {
    const plies = pliesForRef(ref);
    if (plies.length === 0) return;
    const pos = cycle && sameFlawRef(cycle.ref, ref) ? (cycle.pos + 1) % plies.length : 0;
    setCycle({ ref, pos });
    setCommandSeq((s) => s + 1);
    // Also emphasize this ref's markers (dim others) so the click reads as a focus.
    setHighlight(ref);
  };
  const commandedPly = cycle ? (pliesForRef(cycle.ref)[cycle.pos] ?? null) : null;

  // MoveStats (category × side) wiring (Phase 179 Plan 03, D-09/D-10) — shared by
  // both the mobile (collapsible) and desktop MoveStats renders below. Cell
  // activate/hover route straight through the existing tag/motif handleActivate/
  // setHighlight machinery via the unified 'category' FlawRef kind.
  const handleMoveStatsCellActivate = (ref: MoveStatsCellRef): void =>
    handleActivate({ kind: 'category', category: ref.category, side: ref.side });
  const handleMoveStatsCellHover = (ref: MoveStatsCellRef | null): void =>
    setHighlight(ref ? { kind: 'category', category: ref.category, side: ref.side } : null);
  const activeCellRef: MoveStatsCellRef | null =
    cycle && cycle.ref.kind === 'category'
      ? { kind: 'category', category: cycle.ref.category, side: cycle.ref.side }
      : null;
  // D-10: the global filter stays user-scoped and rings ONLY the player-side cell
  // of the matching row (never an opponent cell) — mirrors SeverityBadge's own
  // isActive semantic (severity narrowed to exactly one of blunder/mistake;
  // inaccuracy is not a filterable severity, so it never rings, matching
  // SeverityBadge's existing behavior).
  const outlinedCellRef: MoveStatsCellRef | null = useMemo(() => {
    if (userColor == null || flawFilter.severity.length !== 1) return null;
    const sev = flawFilter.severity[0];
    if (sev == null) return null;
    return { kind: 'category', category: sev, side: userColor };
  }, [flawFilter.severity, userColor]);
  // D-06 (UAT 179): mobile default shows the accuracy card + the compact
  // single-line summary row (user-side counts + chevron); tapping the chevron
  // (move-stats-expand-toggle) reveals the full two-sided 7-row table.
  const [mobileMoveStatsExpanded, setMobileMoveStatsExpanded] = useState(false);

  // End an active click-to-cycle highlight when the user clicks/taps anywhere that
  // isn't this card's eval chart or its flaw chips/badges. `cycle` is a LOCKED
  // highlight — it intentionally survives the pointer leaving the chip (touch has no
  // mouse-leave to clear it, see the highlightedPlies derivation), so without this an
  // outside tap dismissed the eval-chart tooltip but left every non-matching flaw
  // marker dimmed with no way to undim them. Protected regions are scoped to THIS
  // game so the chips (which advance the cycle — pointerdown fires before their click
  // handler, so they must not clear) and chart scrub stay live, while a tap on any
  // neutral area (elsewhere in this card, another card, or the page) clears the lock.
  useEffect(() => {
    if (cycle == null) return;
    // Listen for BOTH pointerdown (desktop click) and touchstart: on mobile the
    // touch-originated pointerdown does not reliably reach document, so we mirror
    // EvalChart's own outside-touch dismissal (which uses touchstart) to undim on
    // tap. Idempotent, so the duplicate fire on devices that emit both is harmless.
    const handleOutside = (e: Event): void => {
      const target = e.target;
      const isProtected =
        target instanceof Element &&
        (target.closest(`[data-testid="eval-chart-${game.game_id}"]`) != null ||
          target.closest(`[data-testid="flaw-controls-${game.game_id}"]`) != null);
      if (isProtected) return;
      setCycle(null);
      setHighlight(null);
    };
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('touchstart', handleOutside);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
    };
  }, [cycle, game.game_id]);

  const activePly =
    hoverPly != null && perPly ? Math.min(Math.max(hoverPly, 0), perPly.length - 1) : null;
  const hoverEntry = activePly != null ? perPly?.[activePly] : undefined;
  const boardFen = hoverEntry?.fen ?? game.result_fen ?? null;
  const hoverSeverity = activePly != null ? flawByPly.get(activePly) : undefined;
  // Highlight the scrubbed move's from/to squares (only while hovering — at rest
  // the board shows the final position with no single "last move" to mark).
  const lastMove = hoverEntry ? { from: hoverEntry.from, to: hoverEntry.to } : undefined;

  // Engine best move FROM the scrubbed position, as a blue arrow that updates while
  // scrubbing — i.e. what the engine would play NEXT in the position the board shows.
  // The scrubbed board perPly[activePly] is the position AFTER move activePly, so its
  // best move lives on the NEXT eval-series row: best_move[activePly+1] (best move from
  // that position). best_move[activePly] is the move that *led into* the shown position,
  // which drew the arrow one ply behind (UAT thl item 2). Null for lichess-eval-only
  // games (no PV), at rest, and at the final position.
  const bestMoveByPly = useMemo(() => {
    const m = new Map<number, string>();
    for (const pt of game.eval_series ?? []) {
      if (pt.best_move) m.set(pt.ply, pt.best_move);
    }
    return m;
  }, [game.eval_series]);
  const bestMoveSquares =
    activePly != null ? uciToSquares(bestMoveByPly.get(activePly + 1) ?? null) : null;
  // Board arrows: just the blue best-move arrow (the flaw shows as a corner glyph). No
  // depth label — the arrow is the best continuation from here, not the missed tactic at
  // the prior decision (that depth still rides the played-move corner glyph below).
  // Should-have-played (teal, TAC_MISSED) arrow source: the engine best move FROM the pre-flaw
  // DECISION position perPly[activePly-1], which the eval series stores at
  // bestMoveByPly.get(activePly) — because best_move[j] = best move from perPly[j-1] (the
  // blue following-best uses get(activePly+1) = best from the displayed perPly[activePly]).
  // This get(k) vs get(k+1) distinction is the recurring off-by-one; it renders the SAME
  // move FlawCard's blue should-have-played arrow shows for the same flaw (Quick 260628-1t5).
  const shouldHaveSquares =
    activePly != null ? uciToSquares(bestMoveByPly.get(activePly) ?? null) : null;
  const boardArrows = useMemo(() => {
    const arrows: { from: string; to: string; color: string; label?: string; labelColor?: string }[] =
      [];
    if (bestMoveSquares) {
      // Following-best arrow: the missed-tactic depth rides the teal should-have-played arrow
      // below (Quick 260628-1t5, reverting cfaa7856). When the scrubbed flaw allowed a tactic,
      // this arrow IS the opponent's refuting response, so it carries the allowed-tactic crimson
      // AND the allowed depth label — the label belongs on the response's target square, not the
      // played flaw square (Quick 260628-pu2 UAT round 2). Otherwise it stays the neutral
      // best-continuation blue with no label.
      const allowedDepth = activePly != null ? tacticDepthByPly.get(activePly)?.allowed : undefined;
      arrows.push({
        from: bestMoveSquares.from,
        to: bestMoveSquares.to,
        color: allowedDepth != null ? TAC_ALLOWED : BEST_MOVE_ARROW,
        label: allowedDepth,
        labelColor: allowedDepth != null ? TAC_ALLOWED_LABEL : undefined,
      });
    }
    // Teal (TAC_MISSED) should-have-played arrow at a missed-tactic flaw ply (DECISION 1): a
    // counterfactual arrow on the post-flaw miniboard, mirroring the analysis board.
    const missedDepth = activePly != null ? tacticDepthByPly.get(activePly)?.missed : undefined;
    if (shouldHaveSquares && missedDepth != null) {
      arrows.push({
        from: shouldHaveSquares.from,
        to: shouldHaveSquares.to,
        color: TAC_MISSED,
        label: missedDepth,
        labelColor: TAC_MISSED_LABEL,
      });
    }
    return arrows.length > 0 ? arrows : undefined;
  }, [bestMoveSquares, shouldHaveSquares, activePly, tacticDepthByPly]);

  // Severity glyph marker on the played (flawed) move's target square (item 4). The allowed
  // depth label now rides the crimson opponent-response arrow (its target square), not this
  // played-flaw square (Quick 260628-pu2 UAT round 2 — the label was on the wrong square).
  const squareMarkers = useMemo<SquareMarker[] | undefined>(() => {
    if (!hoverEntry) return undefined;
    // Severity wins (matches the eval-chart tooltip, where a flaw marker suppresses the
    // gem/great row, and the analysis board's "severity > gem/great" precedence).
    if (hoverSeverity) {
      return [{ square: hoverEntry.to, severity: hoverSeverity }];
    }
    // Bug fix: the miniboard previously read ONLY flaw_markers, so a scrubbed gem/great
    // ply showed no glyph even though the tooltip labelled it "Gem"/"Great". Mirror the
    // tooltip (EvalChart best_move_tier) and analysis board by rendering the tier badge
    // on the played move's target square when there's no flaw here.
    const tier = activePly != null ? bestTierByPly.get(activePly) : undefined;
    if (tier === 'gem') return [{ square: hoverEntry.to, gem: true }];
    if (tier === 'great') return [{ square: hoverEntry.to, great: true }];
    // Quick 260717-rbn: best/good corner badges, same "no flaw here" gate as
    // gem/great above.
    if (tier === 'best') return [{ square: hoverEntry.to, best: true }];
    if (tier === 'good') return [{ square: hoverEntry.to, good: true }];
    return undefined;
  }, [hoverEntry, hoverSeverity, activePly, bestTierByPly]);

  // Severity/tier-coded last-move overlay (item 5): a scrubbed flaw move gets its
  // red/orange/yellow tint; a gem move reads violet and a great ("best") move reads
  // blue, matching their corner badges; any other clean scrubbed move reads green. At
  // rest there is no lastMove, so the color is unused.
  const lastMoveTier = activePly != null ? bestTierByPly.get(activePly) : undefined;
  const lastMoveColor = !hoverEntry
    ? undefined
    : hoverSeverity
      ? MOVE_HIGHLIGHT_SEVERITY[hoverSeverity]
      : lastMoveTier === 'gem'
        ? MOVE_HIGHLIGHT_GEM
        : lastMoveTier === 'great'
          ? MOVE_HIGHLIGHT_GREAT
          : MOVE_HIGHLIGHT_GOOD;

  const whiteName = game.white_username ?? '?';
  const blackName = game.black_username ?? '?';
  const whiteRating = game.white_rating !== null ? `(${game.white_rating})` : '';
  const blackRating = game.black_rating !== null ? `(${game.black_rating})` : '';

  // Result indicator: small colored chip with +/=/− icon.
  const ResultIcon = RESULT_ICONS[game.user_result];
  const resultIndicator = (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded border h-3.5 w-3.5 shrink-0',
        RESULT_CLASSES[game.user_result],
      )}
      aria-label={game.user_result}
    >
      <ResultIcon className="h-2.5 w-2.5" strokeWidth={3} />
    </span>
  );

  // Platform link follows the eval-chart scrub (matching the Flaws card's per-move
  // deep link): when the slider sits anywhere but the last eval'd ply, deep-link to
  // that move's resulting position; at the end-of-game resting position, open the
  // game itself. hoverPly is the chart's active scrub ply (slider or hover), reported
  // even at rest; null until the chart mounts → game-level link.
  // lichess links open from the user's side (board flipped for black); chess.com has
  // no orientation URL param, so it is unchanged (see lib/platformLinks.ts). T-107-10.
  const isScrubbedBack =
    hoverPly != null && lastEvalPly != null && hoverPly !== lastEvalPly;
  const gameUrl = isScrubbedBack
    ? platformPlyUrl(game.platform, game.platform_url, hoverPly, game.user_color)
    : gamePlatformUrl(game.platform, game.platform_url, game.user_color);
  const linkLabel = isScrubbedBack ? 'Open at this move on platform' : 'Open game on platform';

  // Analyze deep-link ply (Quick 260628-qta UAT): when the slider rests on the game's
  // end position (not scrubbed back), omit the ply so the analysis board opens the game
  // at ply 0. When scrubbed to an earlier move, deep-link to that move's ply. isScrubbedBack
  // already means "slider is somewhere other than the last eval'd (end) ply".
  const analyzePly = isScrubbedBack ? hoverPly : null;
  const analyzeTo = buildGameAnalysisUrl(game.game_id, analyzePly);
  const platformIconAndLink = (
    <span className="ml-auto shrink-0 flex items-center gap-1.5 text-muted-foreground">
      <PlatformIcon platform={game.platform} className="h-4 w-4" />
      {gameUrl ? (
        <Tooltip content={linkLabel}>
          <a
            href={gameUrl}
            data-umami-event="outbound-platform-game"
            data-umami-event-platform={game.platform}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-brown-light hover:text-brand-brown-highlight transition-colors"
            aria-label={linkLabel}
            data-testid={`game-card-link-${game.game_id}`}
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        </Tooltip>
      ) : null}
      {/* Phase 208 (D-13): a pasted game has no registered PlatformIcon and no
          gameUrl, so this slot renders empty today — the badge drops straight
          in with no layout change. A text badge (not an icon-only glyph)
          because it must read as "this is not a game you played". The explicit
          text-sm override is mandatory: Badge's base class is text-xs (below
          the CLAUDE.md 14px floor), and cn() (tailwind-merge) resolves the
          conflict correctly because className is passed last. variant="outline"
          — a neutral label, not a status/severity signal, and specifically not
          brand-brown (UI-SPEC reserves that for the paste modal's one accent
          slot elsewhere in this phase). */}
      {game.platform === 'pgn' && (
        <Badge
          variant="outline"
          className="text-sm"
          data-testid={`library-pasted-badge-${game.game_id}`}
        >
          Pasted
        </Badge>
      )}
    </span>
  );

  // HEADER — banded title bar via the shared CardHeader (compact size). rounded-t-md
  // so the band's top corners match the card's outer border radius.
  // Desktop: single line "■ White (rating) vs □ Black (rating)"; mobile: two stacked
  // lines, no "vs". The CardHeader is always flex, so the responsive switch lives on
  // the two inner blocks rather than on the header element.
  const header = (
    <CardHeader as="h4" size="compact" className="rounded-t-md">
      <span className="hidden lg:flex lg:items-center lg:gap-0 lg:min-w-0 lg:flex-1 text-foreground">
        <span className="truncate min-w-0">
          ■ {whiteName} {whiteRating}
          <span className="mx-1.5 text-muted-foreground font-normal">vs</span>□ {blackName}{' '}
          {blackRating}
        </span>
      </span>
      <div className="flex lg:hidden min-w-0 flex-1 flex-col text-foreground">
        <span className="truncate">■ {whiteName} {whiteRating}</span>
        <span className="truncate">□ {blackName} {blackRating}</span>
      </div>
      {platformIconAndLink}
    </CardHeader>
  );

  // Opening line
  const openingLine = (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <BookOpen className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        {game.opening_name ?? <span className="italic">Unknown Opening</span>}
      </span>
    </div>
  );

  // Metadata items
  const dateItem = game.played_at && (
    <span className="inline-flex items-center gap-1">
      <Calendar className="h-3.5 w-3.5" />
      {formatDate(game.played_at)}
    </span>
  );

  const timeControlItem = game.time_control_bucket && (
    <span className="inline-flex items-center gap-1">
      <Clock className="h-3.5 w-3.5" />
      <span className="capitalize">{game.time_control_bucket}</span>
      {game.time_control_str ? ` ${formatTimeControl(game.time_control_str)}` : ''}
    </span>
  );

  const moveCountItem = game.ply_count !== null && (
    <span className="inline-flex items-center gap-1">
      <Hash className="h-3.5 w-3.5" />
      {plysToFullMoves(game.ply_count)} Moves
    </span>
  );

  const terminationItem = game.termination && game.termination !== 'unknown' && (
    <span className="inline-flex items-center gap-1 capitalize">
      {resultIndicator}
      {game.termination}
    </span>
  );

  // Shared game-info block (same order on every game card):
  //   line 1: "<TC name> <base>[+inc]"
  //   line 2: "# n Moves" — on its own line below TC (plan 260610-vru)
  //   line 3: date
  //   line 4: termination (result chip + reason)
  const metadata = (
    <div className="flex flex-col gap-1 text-sm text-muted-foreground">
      {timeControlItem}
      {moveCountItem}
      {dateItem}
      {terminationItem}
    </div>
  );

  // Desktop-only one-line metadata strip: opening · TC · moves · date · result.
  // Spans the full card width on top of the board (Quick 260622-fdh follow-up); the date
  // lives here (not the header) so it isn't duplicated on adjacent rows.
  // Used only by the desktop body; does not affect the shared `metadata` or mobile rendering.
  const desktopMetaStrip = (
    <div className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
      <BookOpen className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate min-w-0">
        {game.opening_name ?? <span className="italic">Unknown Opening</span>}
      </span>
      {timeControlItem && <span className="shrink-0">·</span>}
      {timeControlItem && <span className="shrink-0">{timeControlItem}</span>}
      {moveCountItem && <span className="shrink-0">·</span>}
      {moveCountItem && <span className="shrink-0">{moveCountItem}</span>}
      {dateItem && <span className="shrink-0">·</span>}
      {dateItem && <span className="shrink-0">{dateItem}</span>}
      {terminationItem && <span className="shrink-0">·</span>}
      {terminationItem && <span className="shrink-0">{terminationItem}</span>}
    </div>
  );

  // Context flaw-tag chips (miss/lucky/low-clock/unrushed/phase…). Reused by both the
  // columned beta layout and the non-beta full-width row. The explanatory legend is split
  // out into `contextLegend` so the columned layout can pin it to the right of the
  // "Context" label (Quick 260620: per-column legend icons next to the labels) instead of
  // trailing the chips inline.
  const contextChips =
    game.chips.length > 0 ? (
      <>
        {game.chips.map((tag) => (
          <TagChip
            key={tag}
            tag={tag}
            gameId={game.game_id}
            count={tagCounts.get(tag)}
            definition={false}
            onHover={(active) => setHighlight(active ? { kind: 'tag', tag } : null)}
            onActivate={() => handleActivate({ kind: 'tag', tag })}
          />
        ))}
      </>
    ) : null;
  const contextLegend =
    game.chips.length > 0 ? (
      <TagLegend variant="icon" tags={game.chips} tacticMotifs={[]} gameId={game.game_id} />
    ) : null;

  // Whether this game has any Missed/Allowed/Context tags to show. When false the
  // tags card is omitted entirely (rather than rendering an empty charcoal box) —
  // e.g. a flawless game with no tactic motifs or context chips.
  const hasTags = tacticMotifs.length > 0 || contextChips != null;

  // Tags block (UAT 179): the Missed / Allowed / Context tags rendered as label|chips
  // rows (ChipColumn `inline` — the label sits left of its chips, matching the mobile
  // layout), wrapped in a charcoal card. Shared by mobile (below the eval chart) and
  // desktop (filling the gap under the eval chart). Only rendered when `hasTags`.
  const renderTagsBlock = () => (
    <div
      className="charcoal-texture rounded-md p-2 flex flex-col gap-y-2"
      data-testid={`flaw-chip-columns-${game.game_id}`}
    >
      {TACTIC_ORIENTATIONS.map((orientation) => {
        const groupMotifs = tacticMotifs.filter((t) => t.orientation === orientation);
        return (
          <TacticMotifGroup
            key={orientation}
            orientation={orientation}
            label={TACTIC_ORIENTATION_LABELS[orientation]}
            gameId={game.game_id}
            inline
            motifs={groupMotifs.map(({ motif }) => ({
              motif,
              count: motifPlies.get(motifPliesKey(orientation, motif))?.length ?? 0,
              // Quick 260702-mnd (D-2): ring lights only when a tactic filter is active
              // AND this chip's slot(s) actually match it on every axis (depth-aware).
              filterRingActive:
                tacticFilterActive && matchingFilterKeys.has(motifPliesKey(orientation, motif)),
            }))}
            onChipHover={(motif, active) =>
              setHighlight(active ? { kind: 'motif', motif, orientation } : null)
            }
            onChipActivate={(motif) => handleActivate({ kind: 'motif', motif, orientation })}
            // Each orientation carries its own legend (explaining only its motifs), pinned
            // to the right of its label. TagLegend self-hides when the group has no motifs,
            // so empty columns show no stray icon.
            legend={
              <TagLegend
                variant="icon"
                tags={[]}
                tacticMotifs={groupMotifs.map((t) => t.motif)}
                gameId={game.game_id}
                testId={`tag-legend-tactic-${orientation}-${game.game_id}`}
              />
            }
          />
        );
      })}
      <ChipColumn
        label="Context"
        testId={`context-column-${game.game_id}`}
        isEmpty={contextChips == null}
        labelTrailing={contextLegend}
        inline
      >
        {contextChips}
      </ChipColumn>
    </div>
  );

  // Mobile flaw block (full-width, stacked): the MoveStats accuracy card + compact
  // summary row (chevron expands the full two-sided table), then the tags card.
  // Desktop renders its own MoveStats + tags card in the two-column body below. The
  // display:contents wrapper marks the cycle-driving controls so the outside-pointer
  // handler keeps the locked highlight alive while the user clicks chips/cells, yet
  // undims when they click anywhere else.
  const flawContent =
    game.analysis_state === 'analyzed' ? (
      <div data-testid={`flaw-controls-${game.game_id}`} className="contents">
        {/* UAT 179: accuracy card + compact 8-column summary row; the chevron
            (move-stats-expand-toggle) reveals the full two-sided 7-row table. */}
        <MoveStats
          game={game}
          gameId={game.game_id}
          collapsed={!mobileMoveStatsExpanded}
          showCompactRow
          onToggleCollapse={() => setMobileMoveStatsExpanded((v) => !v)}
          activeRef={activeCellRef}
          outlinedRef={outlinedCellRef}
          onCellActivate={handleMoveStatsCellActivate}
          onCellHover={handleMoveStatsCellHover}
        />
        {hasTags && renderTagsBlock()}
      </div>
    ) : (
      <NoAnalysisState
        gameId={game.game_id}
        isAnalyzed={isAnalyzed}
        isInFlight={isInFlight}
        onInFlightChange={setInFlight}
        activeEvalStatus={game.active_eval_status}
      />
    );

  // D-06/D-08: Unified Analyze button — analyzed games only. Replaces the old Explore +
  // Analyze-position pair. Opens /analysis?game_id=X&ply=Y; ply is the current slider
  // position (hoverPly) falling back to the last eval'd ply then 0.
  const renderDesktopExploreButton = () =>
    isAnalyzed ? (
      <Button asChild variant="brand-outline" className="w-full">
        {/* Real <a> via Link for middle-click / cmd-click new-tab support. */}
        <Link
          to={analyzeTo}
          data-testid="btn-library-game-analyze"
          aria-label="Analyze game"
        >
          <Search className="h-4 w-4 mr-1" />
          Analyze
        </Link>
      </Button>
    ) : null;

  return (
    // The docked readout and slider live inside the card, so overflowVisible and
    // the z-30 hover hack (previously needed for the escaping tooltip) are removed.
    <Card
      as="article"
      data-testid={`library-game-card-${game.game_id}`}
      accentColor={BORDER_COLORS[game.user_result]}
      className="border border-border/20"
    >
      {/* Banded header (desktop single-line, mobile two-line) */}
      {header}

      {/* Mobile body: board+info row, eval chart block, flaw block. Switches to the
          desktop two-column body at lg (1024px) — one breakpoint later than the previous
          md so tablets/narrow desktops keep the stacked layout and the eval chart isn't
          compressed in the three-lane desktop row. */}
      <div className="flex flex-col gap-2 lg:hidden px-4 py-4">
        <div className="flex gap-3 items-start">
          {boardFen && (
            <LazyMiniBoard
              fen={boardFen}
              flipped={game.user_color === 'black'}
              size={mobileBoardSize}
              arrows={boardArrows}
              squareMarkers={squareMarkers}
              lastMove={lastMove}
              lastMoveColor={lastMoveColor}
            />
          )}
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            {openingLine}
            {metadata}
          </div>
        </div>
        {/* Eval chart — full-width, analyzed games only (mobile parity with desktop col 2) */}
        {game.analysis_state === 'analyzed' &&
          game.eval_series &&
          game.flaw_markers &&
          game.phase_transitions && (
            <EvalChart
              gameId={game.game_id}
              evalSeries={game.eval_series}
              flawMarkers={game.flaw_markers}
              phaseTransitions={game.phase_transitions}
              moves={game.moves ?? []}
              flipped={game.user_color === 'black'}
              userColor={userColor}
              onHoverPlyChange={setHoverPly}
              highlightedPlies={highlightedPlies}
              outlinedPlies={outlinedPlies}
              initialPly={initialPly}
              commandedPly={commandedPly}
              commandSeq={commandSeq}
              // Chart + 16px slider row = MOBILE_BOARD_SIZE (130px), so the eval
              // block matches the miniboard height. Literal arbitrary value so
              // Tailwind's JIT scanner emits the class.
              heightClass="h-[114px]"
            />
          )}
        {/* Full-width flaw block on mobile */}
        <div className="flex flex-col gap-2">
          {flawContent}
        </div>
        {/* D-06/D-08: Unified Analyze button — mobile, below eval chart. Analyzed games only. */}
        {isAnalyzed && (
          <div className="lg:hidden flex gap-2">
            <Button asChild variant="brand-outline" className="w-full">
              {/* Real <a> via Link for middle-click / cmd-click new-tab support. */}
              <Link
                to={analyzeTo}
                data-testid="btn-library-game-analyze"
                aria-label="Analyze game"
              >
                <Search className="h-4 w-4 mr-1" />
                Analyze
              </Link>
            </Button>
          </div>
        )}
      </div>

      {/* Desktop body (Quick 260622-fdh): full-width metadata strip on top, then a
          two-column row — board-only left column at DESKTOP_BOARD_SIZE, right column
          stacking eval chart + severity badges + tactic chips. The date lives in the
          strip (opening · TC · moves · date · result). Mobile keeps the simpler stacked
          body above. */}
      <div className="hidden lg:flex lg:flex-col lg:gap-2 px-4 py-4">
        {/* Full-width metadata strip spanning the whole card, above the board. */}
        {desktopMetaStrip}
        {/* Board + right-column row. */}
        <div className="flex gap-3 items-stretch">
          {/* LEFT column: board only, fixed size, full-height of the right column. */}
          <div className="shrink-0">
            {boardFen && (
              <LazyMiniBoard
                fen={boardFen}
                flipped={game.user_color === 'black'}
                size={DESKTOP_BOARD_SIZE}
                arrows={boardArrows}
                squareMarkers={squareMarkers}
                lastMove={lastMove}
                lastMoveColor={lastMoveColor}
              />
            )}
          </div>
          {/* RIGHT column: a two-lane row — the eval chart + tags card stacked on the
              left, the MoveStats column (accuracies card + charcoal table) on the right.
              items-stretch so the tags card fills the gap under the (short) eval chart,
              matching the taller MoveStats column height (UAT 179). flex-1 fills the
              remaining card width. */}
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            {game.analysis_state === 'analyzed' ? (
            <div className="flex gap-3 items-stretch">
              {/* Left lane: eval chart on top, tags card filling the gap below it. */}
              <div className="flex-1 min-w-0 flex flex-col gap-2">
                <div
                  className="flex items-center justify-center"
                  data-testid={`card-col2-${game.game_id}`}
                >
                  {game.eval_series && game.flaw_markers && game.phase_transitions ? (
                    <EvalChart
                      gameId={game.game_id}
                      evalSeries={game.eval_series}
                      flawMarkers={game.flaw_markers}
                      phaseTransitions={game.phase_transitions}
                      moves={game.moves ?? []}
                      flipped={game.user_color === 'black'}
                      userColor={userColor}
                      onHoverPlyChange={setHoverPly}
                      highlightedPlies={highlightedPlies}
                      outlinedPlies={outlinedPlies}
                      initialPly={initialPly}
                      commandedPly={commandedPly}
                      commandSeq={commandSeq}
                      // Chart + 16px slider row = 104px.
                      heightClass="h-[104px]"
                    />
                  ) : (
                    <NoAnalysisState
                      gameId={game.game_id}
                      isAnalyzed={isAnalyzed}
                      isInFlight={isInFlight}
                      onInFlightChange={setInFlight}
                      activeEvalStatus={game.active_eval_status}
                    />
                  )}
                </div>
                {/* Tags card fills the gap under the eval chart (flex-1). Marked as
                    flaw-controls for the outside-pointer highlight guard. */}
                {hasTags && (
                  <div className="flex-1" data-testid={`flaw-controls-${game.game_id}`}>
                    {renderTagsBlock()}
                  </div>
                )}
              </div>
              {/* MoveStats column: accuracies card + charcoal category table, ~256px
                  fixed width beside the miniboard — wide enough that the strip's
                  "Accuracies" label + two pills never squeeze the shared grid, so the
                  table's count columns stay aligned under the pills. Marked as
                  flaw-controls for the outside-pointer highlight guard. */}
              <div className="shrink-0 w-64" data-testid={`flaw-controls-${game.game_id}`}>
                <MoveStats
                  game={game}
                  gameId={game.game_id}
                  activeRef={activeCellRef}
                  outlinedRef={outlinedCellRef}
                  onCellActivate={handleMoveStatsCellActivate}
                  onCellHover={handleMoveStatsCellHover}
                />
              </div>
            </div>
          ) : (
            <div className="shrink-0" data-testid={`card-col2-${game.game_id}`}>
              <NoAnalysisState
                gameId={game.game_id}
                isAnalyzed={isAnalyzed}
                isInFlight={isInFlight}
                onInFlightChange={setInFlight}
                activeEvalStatus={game.active_eval_status}
              />
            </div>
          )}
          </div>
        </div>
        {/* D-01 Explore + D-02 Analyze position button row (Quick 260625-2):
            own full-width row below the board + right-column row, spanning the whole card. */}
        {renderDesktopExploreButton()}
      </div>
    </Card>
  );
}
