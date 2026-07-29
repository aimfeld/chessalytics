import { useState, useCallback, useMemo, useEffect } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { SidebarLayout } from '@/components/layout/SidebarLayout';
import { Button } from '@/components/ui/button';
import { MobileFilterDrawer } from '@/components/filters/MobileFilterDrawer';
import { InfoPopover } from '@/components/ui/info-popover';
import { Card, CardHeader, CardBody } from '@/components/ui/card';
import { FilterPanel, DEFAULT_FILTERS, areFiltersEqual, FILTER_DOT_FIELDS, resetFilterState } from '@/components/filters/FilterPanel';
import { FilterActions } from '@/components/filters/FilterActions';
import { usePulseOnChange, ModifiedDot } from '@/components/filters/FilterModifiedDot';
import { useFilterStore } from '@/hooks/useFilterStore';
import { useGlobalStats, useRatingHistory } from '@/hooks/useStats';
import { useLibraryFlawStats } from '@/hooks/useLibrary';
import { DEFAULT_FLAW_FILTER } from '@/hooks/useFlawFilterStore';
import { FlawStatsPanel } from '@/components/library/FlawStatsPanel';
import { EvalCoverageBadge } from '@/components/library/EvalCoverageBadge';
import { GlobalStatsCharts } from '@/components/stats/GlobalStatsCharts';
import { EvalCoverageHeader } from '@/components/EvalCoverageHeader';
import { useEvalCoverage } from '@/hooks/useEvalCoverage';
import { RatingChart } from '@/components/stats/RatingChart';
import { useUserProfile } from '@/hooks/useUserProfile';
import type { FilterState } from '@/components/filters/FilterPanel';

export function GlobalStatsPage() {
  // Filter state shared across pages — full filter set exposed on the Stats tab.
  // `filters` is the committed store value that queries read.
  // `pendingFilters` is the draft for both desktop sidebar and mobile drawer.
  const [filters, setFilters] = useFilterStore();
  const [pendingFilters, setPendingFilters] = useState<FilterState>(filters);

  // Sync pending -> committed when the filter store changes from another page/tab.
  useEffect(() => {
    setPendingFilters(filters);
  }, [filters]);

  const selectedPlatforms = filters.platforms;

  const { data: ratingData, isLoading: ratingLoading } = useRatingHistory(
    filters, selectedPlatforms, filters.opponentType, filters.opponentStrength,
  );
  const { data: globalStats, isLoading: statsLoading } = useGlobalStats(
    filters, selectedPlatforms, filters.opponentType, filters.opponentStrength,
  );

  const isLoading = ratingLoading || statsLoading;

  // ── Flaw stats (empty severity — severity scoped to Games tab only) ────────
  const {
    data: flawStatsData,
    isLoading: flawStatsLoading,
    isError: flawStatsError,
  } = useLibraryFlawStats(filters, DEFAULT_FLAW_FILTER);

  // ── EvalCoverageBadge source ────────────────────────────────────────────────
  // Repointed from useLibraryFlawStats (analyzed_n / total_n) to useEvalCoverage,
  // the SAME source the Games and Flaws subtab badges use. The flaw-stats numbers
  // are filter-scoped (and drop flawchess bot-practice games via
  // DEFAULT_EXCLUDED_PLATFORMS), so the identical-looking badge read "2845 of
  // 2847" here while the sibling tabs read "2848 of 2848".
  //
  // Numbers and error signal still come from ONE query, which is the invariant
  // the previous comment protected: decoupling them let the badge render a
  // full-width "failed to load" while valid numbers were available, or mask a
  // real failure. flawStatsError now only drives FlawStatsPanel.
  //
  // trackFullAnalysis mirrors the Games/Flaws tabs so the count ticks up live as
  // the background drain works through the backlog.
  const {
    analyzedCount,
    totalCount,
    isError: isCoverageError,
  } = useEvalCoverage({ trackFullAnalysis: true });

  const { data: profile } = useUserProfile();
  const isGuest = profile?.is_guest ?? false;

  // ── Mobile collapsible state ───────────────────────────────────────────────
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  // ── Desktop sidebar state ───────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState<string | null>(null);

  // Desktop sidebar open-change: snapshot committed filters as pending draft on open.
  const handleSidebarOpenChange = useCallback((panel: string | null) => {
    if (panel === 'filters' && sidebarOpen !== 'filters') {
      setPendingFilters(filters);
    }
    setSidebarOpen(panel);
  }, [sidebarOpen, filters]);

  // Desktop Apply: commit pending to store and close panel.
  const handleDesktopFiltersApply = useCallback(() => {
    setFilters(pendingFilters);
    setSidebarOpen(null);
  }, [pendingFilters, setFilters]);

  // Mobile drawer: snapshot committed on open; close without Apply discards draft.
  const handleMobileFiltersOpenChange = useCallback((open: boolean) => {
    if (open && !mobileFiltersOpen) {
      setPendingFilters(filters);
    }
    setMobileFiltersOpen(open);
  }, [mobileFiltersOpen, filters]);

  // Mobile Apply: commit pending to store and close drawer.
  const handleMobileFiltersApply = useCallback(() => {
    setFilters(pendingFilters);
    setMobileFiltersOpen(false);
  }, [pendingFilters, setFilters]);

  // Modified-dot uses the uniform FILTER_DOT_FIELDS comparison (all FilterState keys except
  // `color`). The dot reflects the shared filter store — if the user set e.g. timeControls
  // on Openings, the Stats dot lights up, and clicking Reset here will clear those too
  // (global reset semantics).
  const isFiltersModified = useMemo(
    () => !areFiltersEqual(filters, DEFAULT_FILTERS, FILTER_DOT_FIELDS),
    [filters],
  );

  const filterPulsing = usePulseOnChange(filters);
  const filterDotNode = (
    <ModifiedDot
      active={isFiltersModified}
      pulsing={filterPulsing}
      testId="filters-modified-dot-mobile"
    />
  );

  const content = isLoading ? (
    <div className="text-muted-foreground">Loading...</div>
  ) : (
    <div className="space-y-8">
      {/* ── Flaw Statistics (top of page, UAT) ── */}
      <section data-testid="flaw-stats-section">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground mt-2">Flaw Stats</h2>
          <EvalCoverageBadge
            analyzedN={analyzedCount}
            totalN={totalCount}
            isGuest={isGuest}
            isCoverageError={isCoverageError}
          />
        </div>
        {/* Shared filters, empty severity (severity is scoped to Games tab) */}
        <FlawStatsPanel
          stats={flawStatsData}
          isLoading={flawStatsLoading}
          isError={flawStatsError}
          filters={filters}
          flawFilter={DEFAULT_FLAW_FILTER}
        />
      </section>

      {/* ── ELO Ratings ── */}
      {(selectedPlatforms === null ||
        selectedPlatforms.includes('chess.com') ||
        selectedPlatforms.includes('lichess')) && (
        <section data-testid="elo-ratings-section">
          <h2 className="text-lg font-semibold text-foreground mt-2">ELO Ratings</h2>
          <div className="space-y-8 mt-3">
            {(selectedPlatforms === null || selectedPlatforms.includes('chess.com')) && (
              <Card as="section" data-testid="rating-section-chess-com">
                <CardHeader data-testid="rating-chess-com-header">
                  Chess.com Rating
                  <InfoPopover ariaLabel="Chess.com rating info" testId="rating-chess-com-info" side="top">
                    Your Chess.com rating over time by time control. Granularity adapts automatically: daily for shorter spans, weekly or monthly for longer ones.
                  </InfoPopover>
                </CardHeader>
                <CardBody>
                  <RatingChart data={ratingData?.chess_com ?? []} platform="Chess.com" enabledTimeControls={filters.timeControls} />
                </CardBody>
              </Card>
            )}

            {(selectedPlatforms === null || selectedPlatforms.includes('lichess')) && (
              <Card as="section" data-testid="rating-section-lichess">
                <CardHeader data-testid="rating-lichess-header">
                  Lichess Rating
                  <InfoPopover ariaLabel="Lichess rating info" testId="rating-lichess-info" side="top">
                    Your Lichess rating over time by time control. Granularity adapts automatically: daily for shorter spans, weekly or monthly for longer ones. Lichess uses Glicko-2 ratings which start at 1500 and tend to run 200-400 points higher than Chess.com, so the two are not directly comparable.
                  </InfoPopover>
                </CardHeader>
                <CardBody>
                  <RatingChart data={ratingData?.lichess ?? []} platform="Lichess" enabledTimeControls={filters.timeControls} />
                </CardBody>
              </Card>
            )}
          </div>
        </section>
      )}

      {/* ── Results Breakdown (Results by Time Control + Results by Color) ── */}
      <section data-testid="results-breakdown-section">
        <h2 className="text-lg font-semibold text-foreground mt-2">Results Breakdown</h2>
        <div className="mt-3">
          {/* WDL charts — each card owns its own shell inside GlobalStatsCharts */}
          <GlobalStatsCharts
            byTimeControl={globalStats?.by_time_control ?? []}
            byColor={globalStats?.by_color ?? []}
            enabledTimeControls={filters.timeControls}
          />
        </div>
      </section>
    </div>
  );

  return (
    // No own max-width/padding/main wrapper: this page only renders as the Library
    // "Stats" subtab, nested inside LibraryPage's max-w-7xl container and App's <main>.
    // Wrapping again would double the horizontal padding (narrower than the Games/Flaws
    // subtabs) and nest a second <main> landmark. Plain div = same width as Games/Flaws.
    <div data-testid="global-stats-page">

        {/* Desktop: sidebar strip + filter panel + content */}
        <SidebarLayout
          panels={[
            {
              id: 'filters',
              label: 'Filters',
              icon: <SlidersHorizontal className="h-5 w-5" />,
              notificationDot: isFiltersModified ? (
                <span
                  className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5"
                  data-testid="filters-modified-dot"
                  aria-hidden="true"
                >
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-brown" />
                </span>
              ) : undefined,
              content: (
                <div className="p-3">
                  <FilterPanel filters={pendingFilters} onChange={setPendingFilters} visibleFilters={['playedAs', 'timeControl', 'platform', 'opponent', 'opponentStrength', 'rated', 'recency']} hideReset />
                </div>
              ),
              // Reset/Apply pinned to the panel bottom, below the scrolling filters
              // (mirrors the mobile drawer's pinned footer).
              footer: (
                <div className="px-3 pb-3">
                  <FilterActions
                    onReset={() => setPendingFilters(resetFilterState(pendingFilters))}
                    onApply={handleDesktopFiltersApply}
                  />
                </div>
              ),
            },
          ]}
          activePanel={sidebarOpen}
          onActivePanelChange={handleSidebarOpenChange}
        >
          <EvalCoverageHeader />
          {content}
        </SidebarLayout>

        {/* Mobile: single column */}
        <div className="md:hidden flex flex-col gap-4 min-w-0">
          <EvalCoverageHeader />
          {/* Sticky filter button (top right) */}
          <div className="sticky top-0 z-20 flex justify-end gap-2 py-2 bg-background/80 backdrop-blur-sm">
            <Button
              variant="brand-outline"
              className="relative"
              onClick={() => handleMobileFiltersOpenChange(true)}
              aria-label="Open filters"
              data-testid="btn-filters"
            >
              <SlidersHorizontal className="mr-2 h-4 w-4" />
              Filters
              {filterDotNode}
            </Button>
          </div>

          {/* Filter drawer — staged Apply-only */}
          <MobileFilterDrawer
            open={mobileFiltersOpen}
            onOpenChange={handleMobileFiltersOpenChange}
            title="Filters"
            contentTestId="drawer-filter-sidebar"
            closeTestId="btn-close-filter-drawer"
            bodyClassName="space-y-4"
            footer={
              <FilterActions
                onReset={() => setPendingFilters(resetFilterState(pendingFilters))}
                onApply={handleMobileFiltersApply}
              />
            }
          >
            <FilterPanel filters={pendingFilters} onChange={setPendingFilters} visibleFilters={['playedAs', 'timeControl', 'platform', 'opponent', 'opponentStrength', 'rated', 'recency']} hideReset />
          </MobileFilterDrawer>

          {content}
        </div>
    </div>
  );
}
