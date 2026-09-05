import { useState, useEffect, useRef } from 'react';
import { ClipboardPaste } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ToggleChipButton } from '@/components/ui/toggle-chip-button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverAnchor } from '@/components/ui/popover';
import type { MatchSide, TimeControl, RecencyPreset, Color, Platform, OpponentType, OpponentStrengthRange } from '@/types/api';
import { ANY_RANGE } from '@/lib/opponentStrength';
import { PlatformIcon } from '@/components/icons/PlatformIcon';
import { TimeControlIcon } from '@/components/icons/TimeControlIcon';
import { Button } from '@/components/ui/button';
import { OpponentStrengthFilter } from './OpponentStrengthFilter';
import { CustomRangePopover, formatCustomRangeLabel } from './CustomRangePopover';
import { CustomRangeDrawer } from './CustomRangeDrawer';
import { FilterActions } from './FilterActions';

// ─── Mobile breakpoint detection ──────────────────────────────────────────────
// Same threshold as ScoreChart.tsx (768px = Tailwind `md`).
const MOBILE_BREAKPOINT_PX = 768;

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined'
      && window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
    const update = () => setIsMobile(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return isMobile;
}

export interface FilterState {
  matchSide: MatchSide;
  timeControls: TimeControl[] | null; // null = all
  platforms: Platform[] | null; // null = all
  rated: boolean | null; // null = all; default true = rated games only (SEED-163 2a)
  opponentType: OpponentType; // default 'human' = human opponents only (SEED-163 2a)
  /**
   * Opponent strength as a (gap_min, gap_max) range over opponent_rating - user_rating.
   * Default `{ min: null, max: null }` = no filter (Any preset).
   */
  opponentStrength: OpponentStrengthRange;
  recency: RecencyPreset | 'custom' | null; // null = all time; 'custom' = look at customRange
  /** Custom date range set by the user. Non-null only when recency === 'custom'. */
  customRange: { from?: Date; to?: Date } | null;
  color: Color;
  /** Tri-state color filter for Library surfaces (Either/White/Black). Default 'either' = no filter. */
  playedAs: 'either' | 'white' | 'black';
  /**
   * Phase 208 (D-11/D-14, PASTE-05/09): Library-only opt-in that reveals
   * `platform='pgn'` (pasted) games. Deliberately a SEPARATE field, not a
   * third value folded into `platforms` — `platforms` is module-level state
   * (useFilterStore.ts) that survives SPA navigation and is read by the
   * Openings, Endgames, GlobalStats and Insights queries, where pasted games
   * must never appear (D-14, ROADMAP locked constraint 4). This field is read
   * on the wire ONLY by `buildLibraryParams` (useLibrary.ts) and by nothing
   * else — see `showPastedChip` below for the render-side half of the same
   * containment guarantee.
   *
   * UAT (Phase 208): was a boolean, which made the chip purely additive — a
   * pasted game sorts by its own historical PGN date, so "with" buries it at
   * the end of a multi-thousand-game archive and there was no way to see
   * pasted games alone. 'only' is what deselecting both platform chips while
   * the Pasted chip is on now means, and it keeps `platforms` itself free of
   * a 'pgn' member (the containment guarantee above).
   */
  pasted: PastedFilter;
}

/**
 * Tri-state for the Library's Pasted chip (UAT follow-up to D-11):
 * 'off'  — pasted games hidden (the default everywhere)
 * 'with' — pasted games added to the selected platforms
 * 'only' — pasted games exclusively; no platform chip is active
 */
export type PastedFilter = 'off' | 'with' | 'only';

// SEED-163 2a: the analytics default population is Human + Rated (rated:
// true, opponentType: 'human') so it matches the percentile benchmark cohort
// (`g.rated AND NOT g.is_computer_game`). The store is module memory (no
// localStorage — useFilterStore.ts), so this reaches every user on next load
// with no migration. The filter stays visible (Opponent/Rated controls read
// Human/Rated) and reversible (switching back to Both/All restores the old
// population); the Library keeps native games reachable regardless via the
// backend's native_games_bypass_opponent_and_rated flag (SEED-163 2b).
export const DEFAULT_FILTERS: FilterState = {
  matchSide: 'both',
  timeControls: null,
  platforms: null,
  rated: true,
  opponentType: 'human',
  opponentStrength: ANY_RANGE,
  recency: null,
  customRange: null,
  color: 'white',
  playedAs: 'either',
  pasted: 'off',
};

/**
 * Reset a FilterState to defaults, preserving the current `color` (Played-as piece
 * color is not part of the filter query — see FILTER_DOT_FIELDS) and clearing any
 * custom date range. Single source of truth for the Reset behavior shared by
 * FilterPanel's own footer, LibraryFilterPanel, and every mobile filter-drawer
 * footer (Stats / Openings / Endgames / Library tabs).
 */
export function resetFilterState(current: FilterState): FilterState {
  return { ...DEFAULT_FILTERS, color: current.color, customRange: null };
}

/**
 * FilterState keys used to compute the "modified filters" dot across all three pages
 * (Openings, Endgames, GlobalStats). Intentionally EXCLUDES `color` — changing
 * Played-as does not light the dot because the user's current piece color is not
 * considered part of "the filter query" for indicator purposes, and Reset preserves
 * it for the same reason.
 */
export const FILTER_DOT_FIELDS: ReadonlyArray<keyof FilterState> = [
  'matchSide',
  'timeControls',
  'platforms',
  'rated',
  'opponentType',
  'opponentStrength',
  'recency',
  'customRange',
  'playedAs',
] as const;

/**
 * FILTER_DOT_FIELDS plus the Library-only `pasted` field. Only the Library
 * tabs may use this: `pasted` is shared module state but ONLY the Library
 * applies it (D-14), so lighting the Openings/Endgames/GlobalStats dot for it
 * would flag a filter those pages don't honor. Conversely the Library must
 * light its dot — a 'only' selection can hide thousands of games, and a view
 * that small with no modified-dot reads as a broken archive.
 */
export const LIBRARY_FILTER_DOT_FIELDS: ReadonlyArray<keyof FilterState> = [
  ...FILTER_DOT_FIELDS,
  'pasted',
] as const;

/**
 * Compare two FilterState values for equality, treating array fields (timeControls, platforms)
 * as set-equal regardless of order. Used to detect "filters are modified from defaults" for
 * the sidebar modified-indicator dot.
 *
 * If `fields` is provided, only those FilterState keys are compared — used by GlobalStats
 * which only exposes platform + recency (other fields must be ignored even if non-default).
 */
export function areFiltersEqual(
  a: FilterState,
  b: FilterState,
  fields?: ReadonlyArray<keyof FilterState>,
): boolean {
  const keys = fields ?? (Object.keys(a) as (keyof FilterState)[]);
  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    if (av === bv) continue;
    // Both null already handled by === above; handle array set-equality
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (av.length !== bv.length) return false;
      const setB = new Set<string>(bv as readonly string[]);
      if (!(av as readonly string[]).every((v) => setB.has(v))) return false;
      continue;
    }
    // opponentStrength is an object-shaped field; compare structurally.
    if (key === 'opponentStrength') {
      const ar = av as OpponentStrengthRange;
      const br = bv as OpponentStrengthRange;
      if (ar.min === br.min && ar.max === br.max) continue;
      return false;
    }
    // customRange is an object-shaped field; compare by Date.getTime() to avoid
    // reference-equality mismatches when the same range is reconstructed.
    if (key === 'customRange') {
      const ar = av as FilterState['customRange'];
      const br = bv as FilterState['customRange'];
      if (ar === null && br === null) continue;
      if (ar === null || br === null) return false;
      if (ar.from?.getTime() === br.from?.getTime() && ar.to?.getTime() === br.to?.getTime()) continue;
      return false;
    }
    return false;
  }
  return true;
}

type FilterField = 'timeControl' | 'platform' | 'rated' | 'opponent' | 'opponentStrength' | 'recency' | 'playedAs';

interface FilterPanelProps {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
  /** Which filter sections to show. Defaults to all. */
  visibleFilters?: FilterField[];
  /**
   * When provided, renders FilterActions (Reset + Apply) footer below the filters.
   * Apply commits the current pending state (handled by caller); Reset clears to
   * DEFAULT_FILTERS while preserving `color` and `customRange: null`.
   * When omitted (and hideReset is false), renders a lone Reset button.
   */
  onApply?: () => void;
  /**
   * When true, hides the built-in Reset Filters button. Use when the parent
   * component (e.g. LibraryFilterPanel) owns the Reset button itself so it can
   * also clear non-FilterState fields (e.g. severityFilter).
   */
  hideReset?: boolean;
  /**
   * Phase 208 (D-14): when true AND the 'platform' section is visible, renders
   * one additional "Pasted" chip after the two platform chips. Default false.
   * LibraryFilterPanel is the ONLY caller that sets this — Openings, Endgames
   * and GlobalStats must never render it (D-14, ROADMAP locked constraint 4).
   */
  showPastedChip?: boolean;
}

const ALL_FILTERS: FilterField[] = ['timeControl', 'platform', 'opponent', 'opponentStrength', 'rated', 'recency', 'playedAs'];

const TIME_CONTROLS: TimeControl[] = ['bullet', 'blitz', 'rapid', 'classical'];
const TIME_CONTROL_LABELS: Record<TimeControl, string> = {
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapid',
  classical: 'Classic',
};

const PLATFORMS: Platform[] = ['chess.com', 'lichess'];
const PLATFORM_LABELS: Record<Platform, string> = {
  'chess.com': 'Chess.com',
  lichess: 'Lichess',
};

/**
 * SEED-163 2c: the Library-only disclosure line below the Rated toggle (the last
 * of the two filters it describes; Opponent Type sits directly above it).
 * Extracted to its own component (rather than an inline `{show && (...)}` in
 * FilterPanel) so the added branch doesn't push FilterPanel's cyclomatic
 * complexity past the eslint `complexity` gate (frontend/CLAUDE.md).
 *
 * Gated on the same `showPastedChip` flag as the Pasted chip above —
 * LibraryFilterPanel is the only caller that sets it, so Openings, Endgames
 * and GlobalStats never render this hint, and the same component instance
 * covers both the desktop sidebar and the mobile drawer (see the
 * showPastedChip containment comment in LibraryFilterPanel.tsx). Discloses
 * the backend's native_games_bypass_opponent_and_rated exemption (SEED-163
 * 2b): flawchess/pgn rows ignore the Opponent and Rated filters here.
 */
function NativeGamesHint({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    // frontend/CLAUDE.md: text-sm is the floor for new UI copy (the text-xs
    // tooltip exception does not apply — this is a static disclosure line,
    // not a hover/tap popover), so this deviates from the plan's "text-xs
    // variant is fine" suggestion.
    <p data-testid="filter-native-games-hint" className="mt-1 text-sm text-muted-foreground">
      Opponent and Rated filters don&apos;t apply to FlawChess bot games or pasted games.
    </p>
  );
}

export function FilterPanel({
  filters,
  onChange,
  visibleFilters = ALL_FILTERS,
  onApply,
  hideReset = false,
  showPastedChip = false,
}: FilterPanelProps) {
  const update = (partial: Partial<FilterState>) => {
    onChange({ ...filters, ...partial });
  };

  // Custom range popover/drawer state.
  const [customOpen, setCustomOpen] = useState(false);
  // Tracks a pending "custom" pick so we can suppress Select's restore-focus on
  // close — otherwise focus snaps back to the SelectTrigger right after the
  // popover opens, and the popover's focusOutside dismiss closes it (UAT bug:
  // calendar flashed open then disappeared).
  const pendingCustomRef = useRef(false);
  // In-progress custom-range edits live here while the popover is open; they
  // are committed to the filter only when the popover closes (Done button,
  // outside click, or Escape).
  const [pendingCustomRange, setPendingCustomRange] = useState<{ from?: Date; to?: Date } | null>(
    filters.customRange,
  );
  // Sync pending → committed each time the popover opens (and on external
  // changes like Reset Filters). Derive-during-render avoids the useEffect
  // cascade.
  const [prevCustomOpen, setPrevCustomOpen] = useState(customOpen);
  if (prevCustomOpen !== customOpen) {
    setPrevCustomOpen(customOpen);
    if (customOpen) setPendingCustomRange(filters.customRange);
  }
  // Single handler for both Radix-driven dismiss (outside click, Escape) and
  // explicit Done click. Radix Popover only fires onOpenChange on internal
  // dismisses; setting `open=false` externally would skip the commit, so we
  // route Done through here too.
  const handleCustomOpenChange = (open: boolean) => {
    if (!open && customOpen) {
      // Closing — commit pendingCustomRange. Empty edit reverts recency.
      if (pendingCustomRange?.from || pendingCustomRange?.to) {
        update({ recency: 'custom', customRange: pendingCustomRange });
      } else {
        update({ recency: null, customRange: null });
      }
    }
    setCustomOpen(open);
  };
  const isMobile = useIsMobile();

  const toggleTimeControl = (tc: TimeControl) => {
    const current = filters.timeControls ?? TIME_CONTROLS;
    if (current.includes(tc)) {
      const next = current.filter((t) => t !== tc);
      update({ timeControls: next.length === TIME_CONTROLS.length ? null : next.length === 0 ? [tc] : next });
    } else {
      const next = [...current, tc];
      update({ timeControls: next.length === TIME_CONTROLS.length ? null : next });
    }
  };

  const isTimeControlActive = (tc: TimeControl) => {
    if (filters.timeControls === null) return true;
    return filters.timeControls.includes(tc);
  };

  const togglePlatform = (p: Platform) => {
    // In 'only' mode no platform chip is active, so a click can only mean
    // "bring this platform back" — which drops out of only-mode.
    if (filters.pasted === 'only') {
      update({ platforms: [p], pasted: 'with' });
      return;
    }
    const current = filters.platforms ?? PLATFORMS;
    if (!current.includes(p)) {
      const next = [...current, p];
      update({ platforms: next.length === PLATFORMS.length ? null : next });
      return;
    }
    const next = current.filter((x) => x !== p);
    if (next.length > 0) {
      update({ platforms: next });
      return;
    }
    // Deselecting the last platform is only meaningful when the Pasted chip is
    // on — it means "pasted games only" (UAT: previously impossible, the chip
    // was additive and this branch bounced the selection back to [p]).
    // `platforms` stays null so the shared state other pages read never
    // becomes an empty (match-nothing) list.
    if (filters.pasted === 'with') {
      update({ platforms: null, pasted: 'only' });
      return;
    }
    update({ platforms: [p] });
  };

  const isPlatformActive = (p: Platform) => {
    if (filters.pasted === 'only') return false;
    if (filters.platforms === null) return true;
    return filters.platforms.includes(p);
  };

  // 'only' → 'off' leaves `platforms` at its (untouched) value, so turning the
  // chip off from only-mode restores the platform population it hid.
  const togglePasted = () => {
    update({ pasted: filters.pasted === 'off' ? 'with' : 'off' });
  };

  const show = (field: FilterField) => visibleFilters.includes(field);

  return (
    <div className="space-y-3">
      {/* Played as */}
      {show('playedAs') && (
        <div>
          <p className="mb-1 text-sm text-muted-foreground">Played as</p>
          <ToggleGroup
            type="single"
            value={filters.playedAs}
            onValueChange={(v) => {
              if (!v) return;
              update({ playedAs: v as FilterState['playedAs'] });
            }}
            variant="outline"
            size="sm"
            data-testid="filter-played-as"
            className="w-full"
          >
            <ToggleGroupItem value="either" data-testid="filter-played-as-either" className="min-h-11 sm:min-h-0 flex-1 text-sm">Either</ToggleGroupItem>
            <ToggleGroupItem value="white" data-testid="filter-played-as-white" className="min-h-11 sm:min-h-0 flex-1 text-sm">White</ToggleGroupItem>
            <ToggleGroupItem value="black" data-testid="filter-played-as-black" className="min-h-11 sm:min-h-0 flex-1 text-sm">Black</ToggleGroupItem>
          </ToggleGroup>
        </div>
      )}

      {/* Recency */}
      {show('recency') && (
        <div>
          <p className="mb-1 text-sm text-muted-foreground">Recency</p>
          {/*
            Desktop: Popover anchored to the Select trigger via PopoverAnchor asChild (D-03).
            Mobile:  Popover is never open; CustomRangeDrawer handles the nested sheet (D-06).
            queueMicrotask defers setCustomOpen so the Select close animation completes
            before the popover/drawer open animation begins (RESEARCH.md §Pitfall 6).
          */}
          <Popover
            open={customOpen && !isMobile}
            onOpenChange={handleCustomOpenChange}
          >
            <Select
              value={filters.recency === 'custom' ? 'custom' : (filters.recency ?? 'all')}
              onValueChange={(v) => {
                // 'custom' is handled by the SelectItem's onClick below so that
                // re-clicking "custom" while it's already the active value
                // still reopens the calendar (Radix Select doesn't fire
                // onValueChange when the value is unchanged).
                if (v !== 'custom') {
                  // Any preset clears the custom range (D-08).
                  update({ recency: v === 'all' ? null : (v as RecencyPreset), customRange: null });
                }
              }}
            >
              {/*
                PopoverAnchor must wrap a real DOM element. Select Root is a virtual
                Radix primitive (no DOM) — wrapping it leaves the anchor ref null and
                the popover gets no positioning reference (off-screen/zero-rect).
                Anchor the SelectTrigger (<button>) instead.
              */}
              <PopoverAnchor asChild>
                <SelectTrigger size="sm" data-testid="filter-recency" className="min-h-11 sm:min-h-0 w-full">
                  {/* Render resolved range label when custom is active (D-04); preset label otherwise. */}
                  {filters.recency === 'custom'
                    ? formatCustomRangeLabel(filters.customRange)
                    : <SelectValue />}
                </SelectTrigger>
              </PopoverAnchor>
              <SelectContent
                // position="popper" anchors the menu below the trigger. The
                // default "item-aligned" mode aligns the *selected* item with
                // the trigger, so once "custom" (last item) is selected the
                // menu opens upward and shifted left next time.
                position="popper"
                onCloseAutoFocus={(e) => {
                  // When the user picked "custom", suppress Select's focus
                  // restore so it doesn't steal focus from the about-to-open
                  // popover and trigger Radix's focusOutside dismiss.
                  if (pendingCustomRef.current) {
                    e.preventDefault();
                    pendingCustomRef.current = false;
                  }
                }}
              >
                <SelectItem value="all">All time</SelectItem>
                <SelectItem value="week">Past week</SelectItem>
                <SelectItem value="month">Past month</SelectItem>
                <SelectItem value="3months">3 months</SelectItem>
                <SelectItem value="6months">6 months</SelectItem>
                <SelectItem value="year">1 year</SelectItem>
                <SelectItem value="3years">3 years</SelectItem>
                <SelectItem value="5years">5 years</SelectItem>
                <SelectItem
                  value="custom"
                  data-testid="filter-recency-custom"
                  // Radix triggers selection on pointerup for mouse and on
                  // click for keyboard/touch — and unmounts the item once
                  // selection runs, so onClick alone misses mouse clicks.
                  // Hook both to cover every input type. Idempotent: setting
                  // the same state twice is a no-op.
                  onPointerUp={() => {
                    pendingCustomRef.current = true;
                    queueMicrotask(() => setCustomOpen(true));
                  }}
                  onClick={() => {
                    pendingCustomRef.current = true;
                    queueMicrotask(() => setCustomOpen(true));
                  }}
                >
                  Custom range…
                </SelectItem>
              </SelectContent>
            </Select>

            {/* Desktop: Calendar in a Popover anchored to the Select trigger.
                Edits pendingCustomRange only; commit happens via
                handleCustomOpenChange — used for both Radix dismiss paths and
                the Done button below. */}
            <CustomRangePopover
              value={pendingCustomRange}
              onChange={setPendingCustomRange}
              onOpenChange={handleCustomOpenChange}
            />
          </Popover>

          {/* Mobile: Calendar in a nested Drawer layered over the FilterPanel drawer.
              The drawer handles its own close via onOpenChange after Apply. */}
          <CustomRangeDrawer
            value={filters.customRange}
            onChange={(range) => {
              if (range) update({ recency: 'custom', customRange: range });
            }}
            open={customOpen && isMobile}
            onOpenChange={setCustomOpen}
          />
        </div>
      )}

      {/* Time controls */}
      {show('timeControl') && (
        <div>
          <p className="mb-1 text-sm text-muted-foreground">Time control</p>
          <div className="grid grid-cols-4 gap-1">
            {TIME_CONTROLS.map((tc) => (
              <ToggleChipButton
                key={tc}
                onClick={() => toggleTimeControl(tc)}
                testId={`filter-time-control-${tc}`}
                ariaLabel={`${TIME_CONTROL_LABELS[tc]} time control`}
                active={isTimeControlActive(tc)}
              >
                <TimeControlIcon timeControl={tc} className="h-3.5 w-3.5" />
                {TIME_CONTROL_LABELS[tc]}
              </ToggleChipButton>
            ))}
          </div>
        </div>
      )}

      {/* Platform */}
      {show('platform') && (
        <div>
          <p className="mb-1 text-sm text-muted-foreground">Platform</p>
          {/* Phase 208 (D-14/UI-SPEC §7): a third chip (Pasted, Library-only) joins
              the grid when showPastedChip is set — grid-cols-3 keeps all three
              chips evenly sized instead of orphaning a third chip in a half-width
              row of a 2-col grid. */}
          <div className={`grid gap-1 ${showPastedChip ? 'grid-cols-3' : 'grid-cols-2'}`}>
            {PLATFORMS.map((p) => (
              <ToggleChipButton
                key={p}
                onClick={() => togglePlatform(p)}
                testId={`filter-platform-${p === 'chess.com' ? 'chess-com' : p}`}
                ariaLabel={`${PLATFORM_LABELS[p]} platform`}
                active={isPlatformActive(p)}
              >
                <PlatformIcon platform={p} className="h-3.5 w-3.5" />
                {PLATFORM_LABELS[p]}
              </ToggleChipButton>
            ))}
            {showPastedChip && (
              <ToggleChipButton
                onClick={togglePasted}
                testId="filter-platform-pasted"
                ariaLabel="Pasted games"
                active={filters.pasted !== 'off'}
              >
                <ClipboardPaste className="h-3.5 w-3.5" />
                Pasted
              </ToggleChipButton>
            )}
          </div>
        </div>
      )}

      {/* Opponent Strength */}
      {show('opponentStrength') && (
        <OpponentStrengthFilter
          value={filters.opponentStrength}
          onChange={(opponentStrength) => update({ opponentStrength })}
        />
      )}

      {/* Opponent Type */}
      {show('opponent') && (
        <div>
          <p className="mb-1 text-sm text-muted-foreground">Opponent Type</p>
          <ToggleGroup
            type="single"
            value={filters.opponentType}
            onValueChange={(v) => {
              if (!v) return;
              update({ opponentType: v as OpponentType });
            }}
            variant="outline"
            size="sm"
            data-testid="filter-opponent"
            className="w-full"
          >
            <ToggleGroupItem value="human" data-testid="filter-opponent-human" className="min-h-11 sm:min-h-0 flex-1 text-sm">Human</ToggleGroupItem>
            <ToggleGroupItem value="bot" data-testid="filter-opponent-bot" className="min-h-11 sm:min-h-0 flex-1 text-sm">Bot</ToggleGroupItem>
            <ToggleGroupItem value="both" data-testid="filter-opponent-both" className="min-h-11 sm:min-h-0 flex-1 text-sm">Both</ToggleGroupItem>
          </ToggleGroup>
        </div>
      )}

      {/* Rated */}
      {show('rated') && (
        <div>
          <p className="mb-1 text-sm text-muted-foreground">Rated</p>
          <ToggleGroup
            type="single"
            value={filters.rated === null ? 'all' : filters.rated ? 'rated' : 'casual'}
            onValueChange={(v) => {
              if (!v) return;
              update({ rated: v === 'all' ? null : v === 'rated' });
            }}
            variant="outline"
            size="sm"
            data-testid="filter-rated"
            className="w-full"
          >
            <ToggleGroupItem value="all" data-testid="filter-rated-all" className="min-h-11 sm:min-h-0 flex-1 text-sm">All</ToggleGroupItem>
            <ToggleGroupItem value="rated" data-testid="filter-rated-rated" className="min-h-11 sm:min-h-0 flex-1 text-sm">Rated</ToggleGroupItem>
            <ToggleGroupItem value="casual" data-testid="filter-rated-casual" className="min-h-11 sm:min-h-0 flex-1 text-sm">Casual</ToggleGroupItem>
          </ToggleGroup>
          <NativeGamesHint show={showPastedChip} />
        </div>
      )}

      {/* Reset + Apply footer — full panel width, below the last filter row.
          When onApply is provided: renders FilterActions (Reset left / Apply right).
          When onApply is absent: renders a lone Reset button (backward-compat for callers
          that do not yet pass onApply). Suppress entirely with hideReset=true when the
          parent owns the footer (e.g. LibraryFilterPanel).
          GLOBAL RESET: clears every FilterState field to DEFAULT_FILTERS EXCEPT `color`
          (Played-as), which is preserved at its current value. Because the modified-dot
          also ignores `color` (see FILTER_DOT_FIELDS), Reset is guaranteed to drop the
          dot on every page. */}
      {!hideReset && (
        onApply != null ? (
          <FilterActions
            onReset={() => onChange(resetFilterState(filters))}
            onApply={onApply}
          />
        ) : (
          <div className="pt-2 border-t border-border/40">
            <Button
              type="button"
              variant="brand-outline"
              size="lg"
              className="w-full min-h-11 sm:min-h-0"
              data-testid="btn-reset-filters"
              onClick={() => {
                onChange(resetFilterState(filters));
              }}
            >
              Reset Filters
            </Button>
          </div>
        )
      )}
    </div>
  );
}
