import type { Dispatch, SetStateAction } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { InfoPopover } from '@/components/ui/info-popover';
import { FilterPanel, type FilterState } from '@/components/filters/FilterPanel';
import type { MatchSide } from '@/types/api';

export type OpeningsFilterFieldsProps = {
  localFilters: FilterState;
  setLocalFilters: Dispatch<SetStateAction<FilterState>>;
  /**
   * Desktop call site uses no suffix (`filter-piece-filter`, ...); the mobile
   * drawer call site uses `-sidebar` (`filter-piece-filter-sidebar`, ...).
   * The two testid sets are an intentional browser-automation contract — both
   * DOM nodes can be present simultaneously (desktop panel + mobile drawer
   * both open), so they must never collapse to one string.
   */
  testIdSuffix: '' | '-sidebar';
  /**
   * Desktop panel renders a divider between the piece filter and FilterPanel;
   * the mobile drawer does not (its spacing comes from MobileFilterDrawer's
   * own `bodyClassName="space-y-4"` instead). Defaults to false (mobile).
   */
  showDivider?: boolean;
  /**
   * Mobile drawer uses a taller (min-h-11) 44px tap target for the piece-filter
   * toggle group; desktop does not. A layout decision, kept independent of
   * `testIdSuffix` (215 code review WR-06) — that prop is purely a
   * browser-automation contract, so a future testid change (or a third call
   * site with its own suffix) must not silently change tap-target sizing.
   * Defaults to false (desktop).
   */
  tallTapTargets?: boolean;
};

/**
 * Shared piece-filter ToggleGroup + <FilterPanel> block consumed by BOTH the
 * desktop sidebar panel (OpeningsDesktopSidebar) and the mobile filter
 * drawer (OpeningsMobileDrawers). Before this component the two call sites
 * duplicated byte-identical <FilterPanel> props and near-identical
 * ToggleGroup markup, differing only in testid suffix and tap-target sizing.
 */
export function OpeningsFilterFields({
  localFilters,
  setLocalFilters,
  testIdSuffix,
  showDivider = false,
  tallTapTargets = false,
}: OpeningsFilterFieldsProps) {
  // Mobile drawer uses a taller (min-h-11) tap target; desktop does not.
  // Preserved exactly from the two pre-split call sites (not a new choice) —
  // now driven by the explicit tallTapTargets prop rather than testIdSuffix
  // (215 code review WR-06).
  const toggleItemClassName = tallTapTargets ? 'flex-1 min-h-11 text-sm' : 'flex-1 text-sm';

  return (
    <>
      <div>
        <div className="mb-1 flex items-center gap-1">
          <p className="text-sm text-muted-foreground">Piece filter</p>
          <InfoPopover ariaLabel="Piece filter info" testId={`piece-filter-info${testIdSuffix}`} side="top">
            Use the option "Mine" to find games with a specific formation (e.g. the London System) regardless of the opponent's moves. "Mine" matches only your pieces, "Opponent" only theirs, and "Both" requires an exact match of all pieces. The Moves tab always uses "Both".
          </InfoPopover>
        </div>
        <ToggleGroup
          type="single"
          value={localFilters.matchSide}
          onValueChange={(v) => {
            if (!v) return;
            setLocalFilters((prev) => ({ ...prev, matchSide: v as MatchSide }));
          }}
          variant="outline"
          size="sm"
          className="w-full"
          data-testid={`filter-piece-filter${testIdSuffix}`}
        >
          <ToggleGroupItem value="mine" className={toggleItemClassName} data-testid={`filter-piece-filter-mine${testIdSuffix}`}>Mine</ToggleGroupItem>
          <ToggleGroupItem value="opponent" className={toggleItemClassName} data-testid={`filter-piece-filter-opponent${testIdSuffix}`}>Opponent</ToggleGroupItem>
          <ToggleGroupItem value="both" className={toggleItemClassName} data-testid={`filter-piece-filter-both${testIdSuffix}`}>Both</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {showDivider && <div className="border-t border-border/20" />}
      {/* 'playedAs' is omitted: Openings uses the dedicated white/black color
          button (no "either" option), so the tri-state Played-as belongs to
          Library only. */}
      <FilterPanel
        filters={localFilters}
        onChange={setLocalFilters}
        visibleFilters={['timeControl', 'platform', 'opponent', 'opponentStrength', 'rated', 'recency']}
        hideReset
      />
    </>
  );
}
