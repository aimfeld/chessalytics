import { useEffect, useMemo, useState } from 'react';
import { MoveStats } from '@/components/library/MoveStats';
import type { MoveStatsCellRef } from '@/components/library/MoveStats';
import type { MoveStatCategory, MoveStatSide } from '@/lib/moveStatsCounts';
import { TacticMotifGroup } from '@/components/library/TacticMotifGroup';
import { ChipColumn } from '@/components/library/ChipColumn';
import { TagChip, TagLegend } from '@/components/library/TagChip';
import { tacticMotifLabel, TACTIC_FAMILY_FOR_MOTIF } from '@/lib/tacticComparisonMeta';
import { moverColorAtPly } from '@/lib/plyOwnership';
import type { GameFlawCard, FlawTag } from '@/types/library';

/**
 * Flaw-tags panel for the /analysis page (game mode) — mirrors the Library game
 * card's MoveStats table + 3-column (Missed | Allowed | Context) tactic/context
 * chip block (Phase 179 Plan 03, migrated from the original per-badge-row layout
 * per quick-260702-nm8). A standalone component (does NOT import from or modify
 * LibraryGameCard, which stays untouched — the card is well-tested).
 *
 * Clicking a MoveStats cell or a tactic/context chip cycles the board through
 * that flaw's positions via `onCyclePly`, mirroring the Library card's
 * click-to-cycle behavior but WITHOUT the card's outlinedRef machinery (no
 * filter store on /analysis — resolved decision 3).
 */

// Re-declared locally (trivially safe copies from LibraryGameCard — not shared
// extractions, per the plan's resolved decision 4).
type TacticChipOrientation = 'missed' | 'allowed';
const TACTIC_ORIENTATIONS: readonly TacticChipOrientation[] = ['missed', 'allowed'];
const TACTIC_ORIENTATION_LABELS: Record<TacticChipOrientation, string> = {
  allowed: 'Allowed',
  missed: 'Missed',
};

type FlawRef =
  | { kind: 'tag'; tag: FlawTag }
  | { kind: 'motif'; motif: string; orientation: TacticChipOrientation }
  // Move Stats (category × side) cell (Phase 179 Plan 03, D-09) — replaces the
  // former separate 'severity'/'bestMove' kinds, mirroring LibraryGameCard's
  // identical rework (each file keeps its own copy per this component's
  // existing "trivially safe copies, not shared extractions" convention — see
  // the file header docstring). side is the literal board color of the mover
  // (moverColorAtPly), NOT user-relative — D-08 surfaces both players' cells.
  | { kind: 'category'; category: MoveStatCategory; side: MoveStatSide };

function sameFlawRef(a: FlawRef, b: FlawRef): boolean {
  if (a.kind === 'tag' && b.kind === 'tag') return a.tag === b.tag;
  if (a.kind === 'motif' && b.kind === 'motif')
    return a.motif === b.motif && a.orientation === b.orientation;
  if (a.kind === 'category' && b.kind === 'category')
    return a.category === b.category && a.side === b.side;
  return false;
}

function motifPliesKey(orientation: TacticChipOrientation, motifLabel: string): string {
  return `${orientation}:${motifLabel}`;
}

/** Composite key for the (category × side) plies map (categoryPlies). */
function categoryPliesKey(category: MoveStatCategory, side: MoveStatSide): string {
  return `${category}:${side}`;
}

interface AnalysisTagsPanelProps {
  game: GameFlawCard;
  /**
   * Cycles the board (+ synced move list + eval-chart crosshair) to a flaw's ply.
   * `orientation` is set only for a missed/allowed tactic-motif chip, so the caller can
   * unfold that flaw's sideline (and navigate to its decision fork) exactly as clicking
   * the chip in the move list does. Undefined for context tags and Move Stats cells,
   * which only navigate.
   */
  onCyclePly: (ply: number, orientation?: TacticChipOrientation) => void;
  /**
   * Optional desktop hover-highlight (Task 3, resolved decision 5): reports the set
   * of plies matching the hovered badge/chip so the caller can dim non-matching
   * eval-chart markers, mirroring LibraryGameCard's highlightedPlies. null clears the
   * highlight. Omitted on mobile (the chart lives on a different tab there).
   */
  onHighlightChange?: (plies: Set<number> | null) => void;
  /**
   * Which slice of the panel to render (UAT 179):
   * - `'panel'` (default) — MoveStats + the tags container stacked (mobile/mid,
   *   where they live together in one tab).
   * - `'stats'` — the MoveStats card only (desktop right column).
   * - `'tags'`  — the Missed/Allowed/Context tags charcoal container only
   *   (desktop, rendered below the eval chart in the board column).
   * The desktop layout renders one `'stats'` and one `'tags'` instance; each
   * keeps its own cycle/hover state, both driving `onCyclePly`/`onHighlightChange`.
   */
  section?: 'panel' | 'stats' | 'tags';
  className?: string;
}

export function AnalysisTagsPanel({
  game,
  onCyclePly,
  onHighlightChange,
  section = 'panel',
  className,
}: AnalysisTagsPanelProps) {
  const markers = game.flaw_markers ?? [];

  // Per-tag ascending list of the user's marker plies (context chips).
  const tagPlies = useMemo(() => {
    const m = new Map<FlawTag, number[]>();
    for (const fm of markers) {
      if (!fm.is_user) continue;
      for (const t of fm.tags) {
        const arr = m.get(t);
        if (arr) arr.push(fm.ply);
        else m.set(t, [fm.ply]);
      }
    }
    for (const arr of m.values()) arr.sort((a, b) => a - b);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.flaw_markers]);

  // Per-tag occurrence counts.
  const tagCounts = useMemo(() => {
    const m = new Map<FlawTag, number>();
    for (const fm of markers) {
      if (!fm.is_user) continue;
      for (const t of fm.tags) m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.flaw_markers]);

  // Per-tactic-motif ascending list of the user's marker plies, keyed by orientation +
  // display label (motifPliesKey collapses named-mate subtypes to "checkmate").
  const motifPlies = useMemo(() => {
    const m = new Map<string, number[]>();
    const push = (key: string, ply: number): void => {
      const arr = m.get(key);
      if (arr) arr.push(ply);
      else m.set(key, [ply]);
    };
    for (const fm of markers) {
      if (!fm.is_user) continue;
      if (fm.allowed_tactic_motif != null)
        push(motifPliesKey('allowed', tacticMotifLabel(fm.allowed_tactic_motif)), fm.ply);
      if (fm.missed_tactic_motif != null)
        push(motifPliesKey('missed', tacticMotifLabel(fm.missed_tactic_motif)), fm.ply);
    }
    for (const arr of m.values()) arr.sort((a, b) => a - b);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.flaw_markers]);

  // Distinct (orientation, display-label) tactic motifs; family-less motifs are
  // skipped; named-mate subtypes collapse to a single "checkmate" chip per orientation.
  // Allowed motifs collected before missed (stable grouping, mirrors LibraryGameCard).
  const tacticMotifs = useMemo<{ motif: string; orientation: TacticChipOrientation }[]>(() => {
    const seen = new Set<string>();
    const out: { motif: string; orientation: TacticChipOrientation }[] = [];
    const collect = (raw: string | null, orientation: TacticChipOrientation): void => {
      if (raw == null) return;
      const label = tacticMotifLabel(raw);
      if (TACTIC_FAMILY_FOR_MOTIF[label] == null) return;
      const key = motifPliesKey(orientation, label);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ motif: label, orientation });
    };
    for (const fm of markers) if (fm.is_user) collect(fm.allowed_tactic_motif, 'allowed');
    for (const fm of markers) if (fm.is_user) collect(fm.missed_tactic_motif, 'missed');
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    for (const fm of markers) {
      push(fm.severity, moverColorAtPly(fm.ply), fm.ply);
    }
    for (const pt of game.eval_series ?? []) {
      if (pt.best_move_tier == null) continue;
      push(pt.best_move_tier, moverColorAtPly(pt.ply), pt.ply);
    }
    for (const arr of m.values()) arr.sort((a, b) => a - b);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.flaw_markers, game.eval_series]);

  // Click-to-cycle state: clicking a ref advances through its ply list, wrapping;
  // clicking a different ref restarts at position 0.
  const [cycle, setCycle] = useState<{ ref: FlawRef; pos: number } | null>(null);
  // Transient hover state (desktop only — Task 3, resolved decision 5).
  const [highlight, setHighlight] = useState<FlawRef | null>(null);

  const pliesForRef = (ref: FlawRef): number[] => {
    if (ref.kind === 'tag') return tagPlies.get(ref.tag) ?? [];
    if (ref.kind === 'category')
      return categoryPlies.get(categoryPliesKey(ref.category, ref.side)) ?? [];
    return motifPlies.get(motifPliesKey(ref.orientation, ref.motif)) ?? [];
  };

  const handleActivate = (ref: FlawRef): void => {
    const plies = pliesForRef(ref);
    if (plies.length === 0) return;
    const pos = cycle && sameFlawRef(cycle.ref, ref) ? (cycle.pos + 1) % plies.length : 0;
    setCycle({ ref, pos });
    const ply = plies[pos];
    if (ply === undefined) return;
    // Missed/allowed motif chips carry their orientation so the caller can unfold the
    // matching sideline; context tags and Move Stats cells navigate only (single-arg).
    if (ref.kind === 'motif') onCyclePly(ply, ref.orientation);
    else onCyclePly(ply);
    // A click also emphasizes this ref's markers, matching LibraryGameCard.
    setHighlight(ref);
  };

  // A cycled ref keeps its markers lit even after the pointer leaves (mirrors
  // LibraryGameCard: touch has no mouse-leave to clear the hover highlight).
  const highlightedPlies = useMemo(() => {
    const ref = highlight ?? cycle?.ref ?? null;
    if (!ref) return null;
    // Move Stats (category × side) plies come straight from the categoryPlies
    // map (D-09) — both sides, not gated by is_user (D-08).
    if (ref.kind === 'category')
      return new Set(categoryPlies.get(categoryPliesKey(ref.category, ref.side)) ?? []);
    const set = new Set<number>();
    for (const fm of markers) {
      if (!fm.is_user) continue;
      let matches: boolean;
      if (ref.kind === 'tag') matches = fm.tags.includes(ref.tag);
      else {
        const col = ref.orientation === 'missed' ? fm.missed_tactic_motif : fm.allowed_tactic_motif;
        matches = col != null && tacticMotifLabel(col) === ref.motif;
      }
      if (matches) set.add(fm.ply);
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight, cycle, game.flaw_markers, categoryPlies]);

  useEffect(() => {
    onHighlightChange?.(highlightedPlies);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedPlies]);

  // D-03/Pitfall 2: mount condition is exactly analysis_state === 'analyzed' — no
  // markers/tiers emptiness clause. A flawless analyzed game (zero flaw markers
  // AND zero gem/great plies) now renders the full all-zero 7-row MoveStats
  // table instead of returning null. Belt-and-suspenders: the Analysis page
  // already gates mounting this component on evalChartReady (which implies
  // flaw_markers/eval_series present), but the guard stays here too.
  if (game.analysis_state !== 'analyzed') return null;

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

  // MoveStats (category × side) wiring — always the full (non-collapsed) table
  // on /analysis (no mobile collapse per SEED-112), no filter ring (no filter
  // store on /analysis, resolved decision 3 — mirrors the tactic chips'
  // `filterRingActive: false` below).
  const handleMoveStatsCellActivate = (ref: MoveStatsCellRef): void =>
    handleActivate({ kind: 'category', category: ref.category, side: ref.side });
  const handleMoveStatsCellHover = (ref: MoveStatsCellRef | null): void =>
    setHighlight(ref ? { kind: 'category', category: ref.category, side: ref.side } : null);
  const activeCellRef: MoveStatsCellRef | null =
    cycle && cycle.ref.kind === 'category'
      ? { kind: 'category', category: cycle.ref.category, side: cycle.ref.side }
      : null;

  // Whether this game has any Missed/Allowed/Context tags to show — when false the
  // charcoal tags container is omitted (no empty box).
  const hasTags = tacticMotifs.length > 0 || contextChips != null;

  const statsBlock = (
    <MoveStats
      game={game}
      gameId={game.game_id}
      activeRef={activeCellRef}
      onCellActivate={handleMoveStatsCellActivate}
      onCellHover={handleMoveStatsCellHover}
      accuracyInsideCard
    />
  );

  // Tags in a charcoal container, 2-column label|chips rows (ChipColumn `inline` —
  // the label sits left of its chips), mirroring the Library game card (UAT 179).
  const tagsBlock = hasTags ? (
    <div
      className="charcoal-texture rounded-md p-2 flex flex-col gap-y-2"
      data-testid={`analysis-tags-block-${game.game_id}`}
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
              // No filter store on /analysis (resolved decision 3) — never ring.
              filterRingActive: false,
            }))}
            onChipHover={(motif, active) =>
              setHighlight(active ? { kind: 'motif', motif, orientation } : null)
            }
            onChipActivate={(motif) => handleActivate({ kind: 'motif', motif, orientation })}
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
  ) : null;

  if (section === 'stats') {
    return (
      <div data-testid="analysis-move-stats-section" className={className}>
        {statsBlock}
      </div>
    );
  }
  if (section === 'tags') {
    return (
      <div data-testid="analysis-tags-section" className={className}>
        {tagsBlock}
      </div>
    );
  }
  return (
    <div data-testid="analysis-tags-panel" className={className}>
      {statsBlock}
      {tagsBlock && <div className="mt-2">{tagsBlock}</div>}
    </div>
  );
}
