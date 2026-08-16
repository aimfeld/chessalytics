import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { SlidersHorizontal, Tags } from 'lucide-react';
import { SidebarLayout } from '@/components/layout/SidebarLayout';
import { Button } from '@/components/ui/button';
import { LoadError } from '@/components/ui/load-error';
import { EmptyState } from '@/components/ui/empty-state';
import { MobileFilterDrawer } from '@/components/filters/MobileFilterDrawer';
import {
  DEFAULT_FILTERS,
  areFiltersEqual,
  LIBRARY_FILTER_DOT_FIELDS,
  resetFilterState,
} from '@/components/filters/FilterPanel';
import { LibraryFilterPanel } from '@/components/filters/LibraryFilterPanel';
import { FlawFilterControl, TagFilterLogicInfo } from '@/components/filters/FlawFilterControl';
import { FilterActions } from '@/components/filters/FilterActions';
import { usePulseOnChange, ModifiedDot } from '@/components/filters/FilterModifiedDot';
import { FlawCard } from '@/components/library/FlawCard';
import { NoEngineAnalysisFlawsState } from '@/components/library/NoEngineAnalysisFlawsState';
import { EvalCoverageBadge } from '@/components/library/EvalCoverageBadge';
import { Pagination } from '@/components/results/Pagination';
import { useFilterStore } from '@/hooks/useFilterStore';
import {
  useFlawFilterStore,
  DEFAULT_FLAW_FILTER,
  isFlawFilterNonDefault,
} from '@/hooks/useFlawFilterStore';
import { useLibraryFlaws, useLibraryFlawStats } from '@/hooks/useLibrary';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useEvalCoverage } from '@/hooks/useEvalCoverage';
import type { FilterState } from '@/components/filters/FilterPanel';
import type { FlawFilterState } from '@/hooks/useFlawFilterStore';
import type { TacticFamily } from '@/lib/tacticComparisonMeta';
import type { FlawTag, TacticOrientation } from '@/types/library';
import type { TacticDepthValue } from '@/lib/tacticDepth';

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

// Filter-independent probe for "does the user have ANY engine-analyzed games":
// no date/TC/platform restriction, both opponent types, no flaw filter. Module
// level so the TanStack query key stays stable across renders.
const UNFILTERED_PROBE_FILTERS: FilterState = { ...DEFAULT_FILTERS, opponentType: 'both' };
const NO_FLAW_FILTER: FlawFilterState = { ...DEFAULT_FLAW_FILTER, severity: [], tags: [], tacticFamilies: [] };

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * FlawsTab — the Library Flaws subtab root.
 *
 * Composes two separate filter panels — "Filters" (game metadata, LibraryFilterPanel
 * with showFlawFilter=false) and "Flaw filters" (severity + tags, FlawFilterControl) —
 * + per-flaw miniboard list + Pagination, wiring useLibraryFlaws to the shared stores.
 *
 * URL sync (D-04): on mount, reads ?tag=&severity= from URL and initializes the
 * flaw filter store from them (only when params are present). On store change,
 * updates URL via replace-state (no history pollution).
 *
 * Desktop layout: SidebarLayout with two strip panels (game filters + flaw filters),
 * both applying live on change.
 * Mobile layout: two sticky buttons, each opening its own right Drawer; both apply on
 * close (the flaw filter buffers edits in pendingFlawFilter until its drawer closes).
 */
export function FlawsTab() {
  // ── URL sync setup ───────────────────────────────────────────────────────────
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Filter state ─────────────────────────────────────────────────────────────
  const [appliedFilters, setAppliedFilters] = useFilterStore();
  const [pendingFilters, setPendingFilters] = useState<FilterState>(appliedFilters);

  // Sync pending -> applied when the filter store changes from another page/tab
  useEffect(() => {
    setPendingFilters(appliedFilters);
  }, [appliedFilters]);

  // ── Flaw filter (shared, URL-synced on this tab) ──────────────────────────────
  const [flawFilter, setFlawFilter] = useFlawFilterStore();

  // Mount: read URL params → initialize store (only when URL has params — D-04/OQ3)
  const didInitFromUrl = useRef(false);
  const initialSearchParams = useRef(searchParams);
  useEffect(() => {
    if (didInitFromUrl.current) return;
    didInitFromUrl.current = true;

    const urlTags = initialSearchParams.current.getAll('tag') as FlawTag[];
    const urlSeverity = initialSearchParams.current.getAll('severity') as ('blunder' | 'mistake')[];
    const urlTactic = initialSearchParams.current.getAll('tactic') as TacticFamily[];

    if (urlTags.length > 0 || urlSeverity.length > 0 || urlTactic.length > 0) {
      // Empty severity in the URL = both shown (the default narrowing-off state).
      // Preserve defaults for fields not present in the URL (Phase 129 additions).
      setFlawFilter((prev) => ({ ...prev, tags: urlTags, severity: urlSeverity, tacticFamilies: urlTactic }));
    }
  }, [setFlawFilter]);

  // Store change → update URL (replace, not push — avoids polluting history)
  useEffect(() => {
    const params = new URLSearchParams();
    flawFilter.tags.forEach((t) => params.append('tag', t));
    if (flawFilter.severity.length < 2) {
      flawFilter.severity.forEach((s) => params.append('severity', s));
    }
    (flawFilter.tacticFamilies ?? []).forEach((f) => params.append('tactic', f));
    setSearchParams(params, { replace: true });
  }, [flawFilter, setSearchParams]);

  // ── Pending flaw filter draft — shared buffer for desktop Tags panel and mobile drawer ──
  const [pendingFlawFilter, setPendingFlawFilter] = useState<FlawFilterState>(flawFilter);

  // Keep the pending buffer fresh whenever the committed store changes.
  useEffect(() => {
    setPendingFlawFilter(flawFilter);
  }, [flawFilter]);

  // ── Pagination state ─────────────────────────────────────────────────────────
  const [offset, setOffset] = useState(0);

  // ── Mobile drawer state ──────────────────────────────────────────────────────
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [mobileFlawFiltersOpen, setMobileFlawFiltersOpen] = useState(false);

  // ── Desktop sidebar state ────────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState<string | null>(null);

  // ── Modified-filters indicators (one per panel) ───────────────────────────────
  const isGameModified = useMemo(
    () => !areFiltersEqual(appliedFilters, DEFAULT_FILTERS, LIBRARY_FILTER_DOT_FIELDS),
    [appliedFilters],
  );
  const isFlawModified = useMemo(() => isFlawFilterNonDefault(flawFilter), [flawFilter]);

  const gamePulsing = usePulseOnChange(appliedFilters);
  const flawPulsing = usePulseOnChange(flawFilter);

  const gameDotNode = (
    <ModifiedDot active={isGameModified} pulsing={gamePulsing} testId="filters-modified-dot-flaws" />
  );
  const flawDotNode = (
    <ModifiedDot active={isFlawModified} pulsing={flawPulsing} testId="flaw-filters-modified-dot" />
  );

  // ── Handlers ─────────────────────────────────────────────────────────────────

  // Desktop sidebar: on open, snapshot committed state. Close without Apply = discard draft.
  const handleSidebarOpenChange = useCallback(
    (panelId: string | null) => {
      if (sidebarOpen !== panelId && panelId === 'filters') {
        setPendingFilters(appliedFilters);
      }
      if (sidebarOpen !== panelId && panelId === 'tags') {
        setPendingFlawFilter(flawFilter);
      }
      setSidebarOpen(panelId);
    },
    [sidebarOpen, appliedFilters, flawFilter],
  );

  // Desktop game-metadata Apply: commit and close.
  const handleDesktopFiltersApply = useCallback(() => {
    setAppliedFilters(pendingFilters);
    setOffset(0);
    setSidebarOpen(null);
  }, [pendingFilters, setAppliedFilters]);

  // Desktop Tags Apply: commit and close.
  const handleDesktopTagsApply = useCallback(() => {
    setFlawFilter(pendingFlawFilter);
    setOffset(0);
    setSidebarOpen(null);
  }, [pendingFlawFilter, setFlawFilter]);

  // Mobile game-filters drawer: on open snapshot committed; Apply commits + closes.
  const handleMobileFiltersOpenChange = useCallback(
    (open: boolean) => {
      if (open && !mobileFiltersOpen) {
        setPendingFilters(appliedFilters);
      }
      setMobileFiltersOpen(open);
    },
    [mobileFiltersOpen, appliedFilters],
  );

  const handleMobileFiltersApply = useCallback(() => {
    setAppliedFilters(pendingFilters);
    setOffset(0);
    setMobileFiltersOpen(false);
  }, [pendingFilters, setAppliedFilters]);

  // Mobile Tags drawer: on open snapshot committed; Apply commits + closes.
  const handleMobileFlawFiltersOpenChange = useCallback(
    (open: boolean) => {
      if (open && !mobileFlawFiltersOpen) {
        setPendingFlawFilter(flawFilter);
      }
      setMobileFlawFiltersOpen(open);
    },
    [mobileFlawFiltersOpen, flawFilter],
  );

  const handleMobileTagsApply = useCallback(() => {
    setFlawFilter(pendingFlawFilter);
    setOffset(0);
    setMobileFlawFiltersOpen(false);
  }, [pendingFlawFilter, setFlawFilter]);

  // ── Data queries ─────────────────────────────────────────────────────────────
  const {
    data: flawsData,
    isLoading: flawsLoading,
    isError: flawsError,
  } = useLibraryFlaws(appliedFilters, flawFilter, offset, PAGE_SIZE);

  const { data: profile } = useUserProfile();
  const totalImported =
    profile != null ? profile.chess_com_game_count + profile.lichess_game_count : 0;

  // Unfiltered flaw-stats probe — analyzed_n distinguishes "you have no
  // engine-analyzed games at all" from "your filters matched no flaws". It must
  // NOT inherit the applied filters: a filter set matching zero games would
  // yield analyzed_n=0 and falsely show the no-engine-analysis message to a
  // user who DOES have analyzed games (CLAUDE.md empty-state rule).
  const { data: statsData } = useLibraryFlawStats(UNFILTERED_PROBE_FILTERS, NO_FLAW_FILTER);

  // Eval coverage — drives NoEngineAnalysisFlawsState CTA props and the
  // EvalCoverageBadge in the match-count row.
  // trackFullAnalysis: keep polling while the background drain works through the
  // backlog so the "N of M analyzed" badge ticks up live (Phase 118 removed the
  // tier-2 auto-enqueue, so background work has no in-flight rows to poll on).
  const { analyzedCount, totalCount, isError: isCoverageError } = useEvalCoverage({
    trackFullAnalysis: true,
  });
  const isGuest = profile?.is_guest ?? false;

  // The flaw views don't poll, so once analysis finishes they stay frozen on
  // stale data (empty state or partial list) until a reload. Fire invalidateQueries
  // when analyzedCount increases (prev < current) so a finished analysis flips
  // the flaw list without a reload. Repointed from inFlightCount >0→0 transition
  // in Phase 119-03: tier-3 derived picks have no eval_jobs rows, so inFlightCount
  // was blind to the dominant backlog drain (119-RESEARCH-NOTES.md).
  const queryClient = useQueryClient();
  // Seed to null (not analyzedCount, which is the hook default 0 before the
  // eval-coverage fetch resolves). Skipping the first observed transition stops
  // a spurious invalidation on initial load for returning users who already have
  // analyzed games (prev=0 < first non-zero N would otherwise fire). The refresh
  // then only fires on a genuine increase after mount.
  const prevAnalyzedRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevAnalyzedRef.current;
    prevAnalyzedRef.current = analyzedCount;
    if (prev !== null && analyzedCount > prev) {
      void queryClient.invalidateQueries({ queryKey: ['library-flaws'] });
      void queryClient.invalidateQueries({ queryKey: ['library-flaw-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['library-flaw-comparison'] });
    }
  }, [analyzedCount, queryClient]);

  // ── Derived state ────────────────────────────────────────────────────────────
  // Bug fix: this used to be totalImported alone, which omits platform='flawchess'
  // bot games and platform='pgn' pasted games (it is an import-gate quantity, not a
  // game total — see the matching comment in GamesTab.tsx), so a bot-games-only user
  // saw "No games imported yet" above populated content. totalCount from
  // eval-coverage is account-wide; max keeps the profile fallback while that query
  // is loading or errored.
  const totalGames = Math.max(totalCount, totalImported);
  const matchedCount = flawsData?.matched_count ?? 0;
  const flaws = flawsData?.flaws ?? [];

  const noGamesImported = !flawsLoading && !flawsError && totalGames === 0;
  const noMatchedFlaws =
    !flawsLoading && !flawsError && totalGames > 0 && matchedCount === 0 && flawsData != null;
  // No engine-analyzed games at all → the big "engine analysis missing" state.
  // Defaults to true while stats are loading so users with zero analyzed games
  // (the common case for this state) don't flash the filter-hint message first.
  const noAnalyzedGames = statsData == null || statsData.analyzed_n === 0;

  // ── Filter panel content ─────────────────────────────────────────────────────

  // Game-metadata panel — staged: edits update pending only; Apply commits.
  // hideActions: the Reset/Apply row is pinned as the panel footer below.
  const gameFilterPanelContent = (
    <div className="p-4">
      <LibraryFilterPanel
        filters={pendingFilters}
        onChange={setPendingFilters}
        onApply={handleDesktopFiltersApply}
        showFlawFilter={false}
        hideActions
      />
    </div>
  );

  // Pinned game-filter footer — stays visible below the scrolling filters.
  const gameFilterPanelFooter = (
    <div className="px-4 pb-4">
      <FilterActions
        onReset={() => setPendingFilters(resetFilterState(pendingFilters))}
        onApply={handleDesktopFiltersApply}
      />
    </div>
  );

  // Tags (flaw-filter) panel — staged: edits update pendingFlawFilter only; Apply commits.
  const tagsFilterPanelContent = (
    <div className="p-4 space-y-3">
      <FlawFilterControl
        severity={pendingFlawFilter.severity}
        tags={pendingFlawFilter.tags}
        tacticFamilies={pendingFlawFilter.tacticFamilies}
        onSeverityChange={(severity) =>
          setPendingFlawFilter((prev) => ({ ...prev, severity }))
        }
        onTagChange={(tags) => setPendingFlawFilter((prev) => ({ ...prev, tags }))}
        onTacticFamiliesChange={(tacticFamilies) =>
          setPendingFlawFilter((prev) => ({ ...prev, tacticFamilies }))
        }
        showTacticFilter
        orientation={pendingFlawFilter.tacticOrientation}
        onOrientationChange={(tacticOrientation: TacticOrientation) =>
          setPendingFlawFilter((prev) => ({ ...prev, tacticOrientation }))
        }
        tacticDepth={{ min: pendingFlawFilter.tacticDepthMin, max: pendingFlawFilter.tacticDepthMax }}
        onTacticDepthChange={(next: TacticDepthValue) =>
          setPendingFlawFilter((prev) => ({ ...prev, tacticDepthMin: next.min, tacticDepthMax: next.max }))
        }
      />
    </div>
  );

  // Pinned tags footer — stays visible below the scrolling tag filters.
  const tagsFilterPanelFooter = (
    <div className="px-4 pb-4">
      <FilterActions
        resetTestId="btn-tags-reset"
        applyTestId="btn-tags-apply"
        onReset={() => setPendingFlawFilter(DEFAULT_FLAW_FILTER)}
        onApply={handleDesktopTagsApply}
      />
    </div>
  );

  const sidebarPanels = [
    {
      id: 'filters',
      label: 'Filters',
      icon: <SlidersHorizontal className="h-4 w-4" />,
      content: gameFilterPanelContent,
      footer: gameFilterPanelFooter,
      notificationDot: gameDotNode,
    },
    {
      id: 'tags',
      label: 'Tags',
      icon: <Tags className="h-4 w-4" />,
      headerExtra: <TagFilterLogicInfo />,
      content: tagsFilterPanelContent,
      footer: tagsFilterPanelFooter,
      notificationDot: flawDotNode,
    },
  ];

  // ── Main content ─────────────────────────────────────────────────────────────

  const mainContent = (
    <div className="flex flex-col gap-6 pb-20">
      {/* Error state — MANDATORY isError branch (CLAUDE.md) */}
      {flawsError && <LoadError resource="flaws" />}

      {/* No games imported empty state */}
      {noGamesImported && (
        <EmptyState
          title="No games imported yet"
          subtitle="Import your games from chess.com or lichess to start analyzing."
          action={
            <Button asChild variant="default" size="sm">
              <Link to="/library/import">Import Games</Link>
            </Button>
          }
        />
      )}

      {/* Flaw list — only when not errored */}
      {!flawsError && (
        <section aria-label="Flaw results" data-testid="flaw-list">
          {flawsData != null && (
            <div className="flex items-center justify-between gap-3 mb-4">
              <p className="text-sm text-muted-foreground">
                {matchedCount} flaw{matchedCount === 1 ? '' : 's'} matched
              </p>
              <EvalCoverageBadge
                analyzedN={analyzedCount}
                totalN={totalCount}
                isGuest={isGuest}
                isCoverageError={isCoverageError}
              />
            </div>
          )}

          {noMatchedFlaws &&
            (noAnalyzedGames ? (
              <NoEngineAnalysisFlawsState
                isGuest={isGuest}
              />
            ) : (
              <EmptyState
                title="No flaws matched"
                subtitle="Try adjusting the flaw filter or game filters."
              />
            ))}

          {matchedCount > 0 && (
            <div
              className="grid grid-cols-1 lg:grid-cols-2 gap-4"
              data-testid="flaw-grid"
            >
              {flaws.map((flaw) => (
                <FlawCard
                  key={`${flaw.game_id}-${flaw.ply}`}
                  flaw={flaw}
                  tacticOrientation={flawFilter.tacticOrientation}
                />
              ))}
            </div>
          )}

          {matchedCount > PAGE_SIZE && (
            <div className="mt-6">
              <Pagination
                currentPage={Math.floor(offset / PAGE_SIZE) + 1}
                totalPages={Math.ceil(matchedCount / PAGE_SIZE)}
                onPageChange={(page) => {
                  setOffset((page - 1) * PAGE_SIZE);
                  window.scrollTo({ top: 0 });
                }}
              />
            </div>
          )}
        </section>
      )}
    </div>
  );

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div data-testid="flaws-tab-content">
      {/* Desktop layout: SidebarLayout */}
      <SidebarLayout
        panels={sidebarPanels}
        activePanel={sidebarOpen}
        onActivePanelChange={handleSidebarOpenChange}
      >
        {mainContent}
      </SidebarLayout>

      {/* Mobile layout: sticky filter buttons + Drawers + stacked content */}
      <div className="md:hidden flex flex-col gap-4">
        {/* Sticky row with separate Filters + Tags buttons */}
        <div className="sticky top-0 z-20 flex justify-end gap-2 py-2 bg-background/80 backdrop-blur-sm">
          <Button
            variant="brand-outline"
            className="relative"
            onClick={() => handleMobileFiltersOpenChange(true)}
            aria-label="Open game filters"
            data-testid="btn-game-filters"
          >
            <SlidersHorizontal className="mr-2 h-4 w-4" />
            Filters
            {gameDotNode}
          </Button>
          <Button
            variant="brand-outline"
            className="relative"
            onClick={() => handleMobileFlawFiltersOpenChange(true)}
            aria-label="Open tags"
            data-testid="btn-flaw-filters"
          >
            <Tags className="mr-2 h-4 w-4" />
            Tags
            {flawDotNode}
          </Button>
        </div>

        {/* Game-filters drawer */}
        <MobileFilterDrawer
          open={mobileFiltersOpen}
          onOpenChange={handleMobileFiltersOpenChange}
          title="Filters"
          closeLabel="Close game filters"
          contentTestId="drawer-game-filter-sidebar"
          closeTestId="btn-close-game-filter-drawer"
          footer={
            <FilterActions
              onReset={() => setPendingFilters(resetFilterState(pendingFilters))}
              onApply={handleMobileFiltersApply}
            />
          }
        >
          <LibraryFilterPanel
            filters={pendingFilters}
            onChange={setPendingFilters}
            onApply={handleMobileFiltersApply}
            showFlawFilter={false}
            hideActions
          />
        </MobileFilterDrawer>

        {/* Tags (flaw-filter) drawer — staged Apply-only */}
        <MobileFilterDrawer
          open={mobileFlawFiltersOpen}
          onOpenChange={handleMobileFlawFiltersOpenChange}
          title="Tags"
          titleAccessory={<TagFilterLogicInfo />}
          contentTestId="drawer-flaw-filter-sidebar"
          closeTestId="btn-close-flaw-filter-drawer"
          footer={
            <FilterActions
              resetTestId="btn-tags-reset"
              applyTestId="btn-tags-apply"
              onReset={() => setPendingFlawFilter(DEFAULT_FLAW_FILTER)}
              onApply={handleMobileTagsApply}
            />
          }
        >
          <FlawFilterControl
            severity={pendingFlawFilter.severity}
            tags={pendingFlawFilter.tags}
            tacticFamilies={pendingFlawFilter.tacticFamilies}
            onSeverityChange={(severity) =>
              setPendingFlawFilter((prev) => ({ ...prev, severity }))
            }
            onTagChange={(tags) => setPendingFlawFilter((prev) => ({ ...prev, tags }))}
            onTacticFamiliesChange={(tacticFamilies) =>
              setPendingFlawFilter((prev) => ({ ...prev, tacticFamilies }))
            }
            showTacticFilter
            orientation={pendingFlawFilter.tacticOrientation}
            onOrientationChange={(tacticOrientation: TacticOrientation) =>
              setPendingFlawFilter((prev) => ({ ...prev, tacticOrientation }))
            }
            tacticDepth={{ min: pendingFlawFilter.tacticDepthMin, max: pendingFlawFilter.tacticDepthMax }}
            onTacticDepthChange={(next: TacticDepthValue) =>
              setPendingFlawFilter((prev) => ({ ...prev, tacticDepthMin: next.min, tacticDepthMax: next.max }))
            }
          />
        </MobileFilterDrawer>

        {/* Stacked main content (mobile) */}
        {mainContent}
      </div>
    </div>
  );
}
