import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
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
import { LibraryGameCardList } from '@/components/results/LibraryGameCardList';
import { useFilterStore } from '@/hooks/useFilterStore';
import {
  useFlawFilterStore,
  DEFAULT_FLAW_FILTER,
  isFlawFilterNonDefault,
} from '@/hooks/useFlawFilterStore';
import { useLibraryGames } from '@/hooks/useLibrary';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useEvalCoverage, LIBRARY_GAMES_POLL_INTERVAL_MS } from '@/hooks/useEvalCoverage';
import type { FilterState } from '@/components/filters/FilterPanel';
import type { FlawFilterState } from '@/hooks/useFlawFilterStore';
import type { TacticFamily } from '@/lib/tacticComparisonMeta';
import type { TacticOrientation } from '@/types/library';
import type { TacticDepthValue } from '@/lib/tacticDepth';

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

// Safety backstop for a user-initiated tier-1 analyze: if the job fails or never
// lands, drop the game from the in-flight set after this long so the card reverts
// to the Analyze button (and we stop polling) instead of pulsing "Analyzing…"
// forever. A single game evals in ~20s; queued behind a backlog it can take longer,
// so the timeout is generous.
const ANALYZE_INFLIGHT_TIMEOUT_MS = 120_000;

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * GamesTab — the Library Games subtab root.
 *
 * Composes two separate filter panels (game-metadata + Tags/flaw filter) +
 * LibraryGameCardList, wiring useLibraryGames to the shared filter + shared flaw
 * filter state. FlawStatsPanel lives on the Stats tab (GlobalStats.tsx).
 *
 * Desktop layout: SidebarLayout with two strip panels — "Filters" (game metadata,
 * LibraryFilterPanel) and "Tags" (severity + tags, FlawFilterControl + FilterActions).
 * Mobile layout: two sticky buttons each opening their own right Drawer, then the
 * game list.
 *
 * Filter interaction — staged Apply-only model:
 * - Edits mutate pending/draft state only; nothing commits to the shared store until Apply.
 * - Apply = commit pending to store + close panel (desktop strip / mobile drawer).
 * - Closing any other way (X, outside-click, strip toggle) discards the draft.
 *
 * State management:
 * - appliedFilters: drives useLibraryGames (committed store value).
 * - pendingFilters: tracks game-metadata draft edits.
 * - flawFilter: shared cross-tab committed state from useFlawFilterStore (D-04).
 * - pendingFlawFilter: Tags panel draft (both desktop and mobile).
 * - offset: page state, reset to 0 on any Apply.
 */
export function GamesTab() {
  // ── Filter state ─────────────────────────────────────────────────────────────
  const [appliedFilters, setAppliedFilters] = useFilterStore();
  const [pendingFilters, setPendingFilters] = useState<FilterState>(appliedFilters);

  // Sync pending -> applied when the filter store changes from another page/tab
  useEffect(() => {
    setPendingFilters(appliedFilters);
  }, [appliedFilters]);

  // ── Flaw filter (shared cross-tab state — D-04) ───────────────────────────────
  const [flawFilter, setFlawFilter] = useFlawFilterStore();

  // Pending flaw filter draft — shared buffer for desktop Tags panel and mobile drawer.
  const [pendingFlawFilter, setPendingFlawFilter] = useState<FlawFilterState>(flawFilter);
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
    <ModifiedDot active={isGameModified} pulsing={gamePulsing} testId="filters-modified-dot" />
  );
  const flawDotNode = (
    <ModifiedDot active={isFlawModified} pulsing={flawPulsing} testId="flaw-filters-modified-dot" />
  );

  // ── Handlers ─────────────────────────────────────────────────────────────────

  // Desktop sidebar: on open, snapshot committed filters as pending. On close
  // without Apply (strip toggle / outside-click), do NOT commit — discard the draft
  // by re-syncing pending to committed on the next open.
  const handleSidebarOpenChange = useCallback(
    (panelId: string | null) => {
      if (sidebarOpen !== panelId && panelId === 'filters') {
        // Filters panel opening: snapshot committed state
        setPendingFilters(appliedFilters);
      }
      if (sidebarOpen !== panelId && panelId === 'tags') {
        // Tags panel opening: snapshot committed flaw state
        setPendingFlawFilter(flawFilter);
      }
      setSidebarOpen(panelId);
    },
    [sidebarOpen, appliedFilters, flawFilter],
  );

  // Desktop game-metadata Apply: commit pending to store and close the panel.
  const handleDesktopFiltersApply = useCallback(() => {
    setAppliedFilters(pendingFilters);
    setOffset(0);
    setSidebarOpen(null);
  }, [pendingFilters, setAppliedFilters]);

  // Desktop Tags Apply: commit pending flaw filter to store and close the panel.
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

  // Mobile flaw-filters drawer: on open snapshot committed; Apply commits + closes.
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

  // Poll eval-coverage so the badge and games list update when analysis completes.
  // trackFullAnalysis: keep polling while the background drain works through the
  // backlog so the "N of M analyzed" badge ticks up live (no tier-2 in-flight rows
  // exist for background work — Phase 118 removed the auto-enqueue).
  const { analyzedCount, totalCount, isError: isCoverageError } = useEvalCoverage({
    trackFullAnalysis: true,
  });

  // Tier-1 "Analyzing…" state lifted out of the cards (Option A). Owning the set
  // here lets us keep the games-list poll alive until an on-demand analyze lands —
  // the global eval-coverage poll backs off after a stall (~15s) which is shorter
  // than a single-game eval (~20s), so a card relying on it alone could pulse
  // forever (the eval-coverage hook has no per-job in-flight signal since Phase
  // 119-03 removed in_flight_count). A per-game timeout backstops failed/lost jobs.
  const [inFlightIds, setInFlightIds] = useState<ReadonlySet<number>>(() => new Set());
  const inFlightTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const handleInFlightChange = useCallback((gameId: number, inFlight: boolean) => {
    const timers = inFlightTimers.current;
    const existing = timers.get(gameId);
    if (existing !== undefined) {
      clearTimeout(existing);
      timers.delete(gameId);
    }
    setInFlightIds((prev) => {
      if (prev.has(gameId) === inFlight) return prev;
      const next = new Set(prev);
      if (inFlight) next.add(gameId);
      else next.delete(gameId);
      return next;
    });
    if (inFlight) {
      timers.set(
        gameId,
        setTimeout(() => {
          timers.delete(gameId);
          setInFlightIds((prev) => {
            if (!prev.has(gameId)) return prev;
            const next = new Set(prev);
            next.delete(gameId);
            return next;
          });
        }, ANALYZE_INFLIGHT_TIMEOUT_MS),
      );
    }
  }, []);

  // Clear any pending in-flight timers on unmount.
  useEffect(() => {
    const timers = inFlightTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const {
    data: gamesData,
    isLoading: gamesLoading,
    isError: gamesError,
  } = useLibraryGames(
    appliedFilters,
    flawFilter,
    offset,
    PAGE_SIZE,
    // Poll the games list while full analysis is incomplete so cards flip from
    // "Analyzing…" to the analyzed view within a few seconds, no page reload.
    // Repointed from inFlightCount > 0 to analyzedCount < totalCount in Phase
    // 119-03: tier-3 derived picks have no eval_jobs rows, so inFlightCount was
    // blind to the dominant backlog drain (119-RESEARCH-NOTES.md). Also poll while
    // any on-demand analyze is in flight (Option A) so its card flips reliably even
    // when the eval-coverage poll has already backed off.
    analyzedCount < totalCount || inFlightIds.size > 0 ? LIBRARY_GAMES_POLL_INTERVAL_MS : 0,
  );

  // Refresh the games list when a tier-1 (or any) analysis completes — the
  // per-game pill only clears once analysis_state flips to 'analyzed', which
  // needs one more refetch after analyzedCount rises. Fire invalidateQueries on
  // the analyzedCount increase (prev < current) so a finished analysis flips the
  // card without a reload. Repointed from inFlightCount >0→0 transition in Phase
  // 119-03 (same rationale: inFlightCount was blind to tier-3 backlog).
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
      void queryClient.invalidateQueries({ queryKey: ['library-games'] });
    }
  }, [analyzedCount, queryClient]);

  const { data: profile } = useUserProfile();
  const isGuest = profile?.is_guest ?? false;
  const totalImported =
    profile != null ? profile.chess_com_game_count + profile.lichess_game_count : 0;

  // ── Derived state for empty-state decisions ───────────────────────────────────
  // Bug fix: this used to be totalImported alone. The profile's chess.com+lichess
  // sum is an IMPORT-GATE quantity (App.tsx IMPORT_EXEMPT_ROUTES / Phase 208 D-10 —
  // a bot or pasted game must not unlock the import-gated nav), so it omits
  // platform='flawchess' bot games and platform='pgn' pasted games. Using it as a
  // game total made a user whose only games are bot games see "No games imported
  // yet" rendered ABOVE their populated game list. eval-coverage's totalCount is
  // the account-wide count across all four platforms. Max, not a straight swap:
  // totalCount is 0 while the coverage query is loading or errored, and falling
  // back to the profile sum there keeps the empty state from flashing.
  const totalGames = Math.max(totalCount, totalImported);
  const matchedCount = gamesData?.matched_count ?? 0;
  const games = gamesData?.games ?? [];

  const noGamesImported = !gamesLoading && !gamesError && totalGames === 0;
  const noMatchedGames = !gamesLoading && !gamesError && totalGames > 0 && matchedCount === 0;

  // ── Sidebar panel config (SidebarLayout) ────────────────────────────────────

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
        onTacticFamiliesChange={(tacticFamilies: TacticFamily[]) =>
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
        hasGem={pendingFlawFilter.hasGem}
        hasGreat={pendingFlawFilter.hasGreat}
        onHasGemToggle={() => setPendingFlawFilter((prev) => ({ ...prev, hasGem: !prev.hasGem }))}
        onHasGreatToggle={() => setPendingFlawFilter((prev) => ({ ...prev, hasGreat: !prev.hasGreat }))}
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
    <div className="flex flex-col gap-8 pb-20">
      {gamesError && <LoadError resource="games" />}

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

      {noMatchedGames && (
        <EmptyState title="No games matched" subtitle="Try adjusting the filters." />
      )}

      {!gamesError && matchedCount > 0 && (
        <LibraryGameCardList
          games={games}
          matchedCount={matchedCount}
          offset={offset}
          limit={PAGE_SIZE}
          onPageChange={setOffset}
          isGuest={isGuest}
          analyzedN={analyzedCount}
          totalN={totalCount}
          isCoverageError={isCoverageError}
          inFlightIds={inFlightIds}
          onInFlightChange={handleInFlightChange}
        />
      )}
    </div>
  );

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div data-testid="games-tab-content">
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
            aria-label="Open filters"
            data-testid="btn-filters"
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
          contentTestId="drawer-filter-sidebar"
          closeTestId="btn-close-filter-drawer"
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
            onTacticFamiliesChange={(tacticFamilies: TacticFamily[]) =>
              setPendingFlawFilter((prev) => ({ ...prev, tacticFamilies }))
            }
            showTacticFilter
            orientation={pendingFlawFilter.tacticOrientation}
            onOrientationChange={(tacticOrientation: TacticOrientation) =>
              setPendingFlawFilter((prev) => ({ ...prev, tacticOrientation }))
            }
            tacticDepth={{ min: pendingFlawFilter.tacticDepthMin, max: pendingFlawFilter.tacticDepthMax }}
            onTacticDepthChange={(next: TacticDepthValue) =>
              setPendingFlawFilter((prev) => ({
                ...prev,
                tacticDepthMin: next.min,
                tacticDepthMax: next.max,
              }))
            }
            hasGem={pendingFlawFilter.hasGem}
            hasGreat={pendingFlawFilter.hasGreat}
            onHasGemToggle={() => setPendingFlawFilter((prev) => ({ ...prev, hasGem: !prev.hasGem }))}
            onHasGreatToggle={() => setPendingFlawFilter((prev) => ({ ...prev, hasGreat: !prev.hasGreat }))}
          />
        </MobileFilterDrawer>

        {/* Stacked main content (mobile).
            Isolate into its own stacking context (relative z-0) so a card's
            hover/touch state (z-30 in LibraryGameCard) can't paint over the
            sticky z-20 Filters/Tags bar above while scrolling. */}
        <div className="relative z-0">{mainContent}</div>
      </div>
    </div>
  );
}
