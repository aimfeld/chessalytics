import { useState, useMemo, useCallback, useRef, useEffect } from 'react';

// localStorage helper for per-bookmark chart-enable toggle (default: enabled).
// The read side (getChartEnabled) moved into useOpeningsChartData.ts along
// with the memo that's its only consumer; this write side stays here since
// it's called by handlers useOpeningsChartData doesn't own.
function setChartEnabledStorage(bookmarkId: number, enabled: boolean): void {
  localStorage.setItem(`bookmark-chart-enabled-${bookmarkId}`, String(enabled));
}
import { useNavigate, useLocation, Navigate } from 'react-router';
import { useUserProfile } from '@/hooks/useUserProfile';
import { ArrowRightLeft, Swords, BarChart2, Lightbulb, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InfoPopover } from '@/components/ui/info-popover';
import { EvalCoverageHeader } from '@/components/EvalCoverageHeader';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { useChessGame } from '@/hooks/useChessGame';
import { useNextMoves } from '@/hooks/useNextMoves';
import { useOpeningsPositionQuery } from '@/hooks/useOpenings';
import { useDebounce } from '@/hooks/useDebounce';
import {
  usePositionBookmarks,
  useCreatePositionBookmark,
  useUpdateMatchSide,
} from '@/hooks/usePositionBookmarks';
import { useMostPlayedOpenings } from '@/hooks/useStats';
import { ChessBoard } from '@/components/board/ChessBoard';
import { MoveList } from '@/components/board/MoveList';
import { BoardControls } from '@/components/board/BoardControls';
import { DEFAULT_FILTERS, areFiltersEqual, FILTER_DOT_FIELDS } from '@/components/filters/FilterPanel';
import { useFilterStore } from '@/hooks/useFilterStore';
import { useGameCount } from '@/hooks/useGameCount';
import {
  shouldShowNoHumanRatedGames,
} from '@/components/ui/no-human-rated-games-state';
import { SuggestionsModal } from '@/components/position-bookmarks/SuggestionsModal';
import { getBoardContainerClassName } from '@/lib/openingsBoardLayout';
import { buildAnalysisLineUrl } from '@/lib/analysisUrl';
import type { FilterState } from '@/components/filters/FilterPanel';
import type { Color, MatchSide } from '@/types/api';
import type { PositionBookmarkResponse } from '@/types/position_bookmarks';
import { useDeepLinkHighlight } from './openings/useDeepLinkHighlight';
import { useSidebarState } from './openings/useSidebarState';
import { useTabReset } from './openings/useTabReset';
import { useOpeningsHandlers } from './openings/useOpeningsHandlers';
import { OpeningsDesktopSidebar } from './openings/OpeningsDesktopSidebar';
import { OpeningsMobileDrawers } from './openings/OpeningsMobileDrawers';
import { useOpeningsChartData } from './openings/useOpeningsChartData';
import { ChessboardInfoCopy } from './openings/ChessboardInfoCopy';
import { OpeningsMobileBoardPanel } from './openings/OpeningsMobileBoardPanel';
import { ExplorerTab } from './openings/ExplorerTab';
import { GamesTab } from './openings/GamesTab';
import { StatsTab } from './openings/StatsTab';
import { InsightsTab } from './openings/InsightsTab';

const PAGE_SIZE = 20;
// Number of most-played openings per color to use as default chart data when no bookmarks exist

const TAB_INFO: Record<'explorer' | 'games' | 'stats' | 'insights', { aria: string; text: string }> = {
  explorer: {
    aria: 'About Opening Moves',
    text: 'Interactive opening explorer with win/draw/loss charts and statistical analysis for each move.',
  },
  games: {
    aria: 'About Opening Games',
    text: 'A list of your games that reached the position on the board, matching your current filter settings.',
  },
  stats: {
    aria: 'About Opening Stats',
    text: 'Shows the performance of your bookmarked and most played openings, with win/draw/loss charts and Stockfish evaluation at the transition from opening to middlegame.',
  },
  insights: {
    aria: 'About Opening Insights',
    text: 'Your weakest and strongest opening positions, based on a systematic scan of all your games up to 16 half-moves.',
  },
};

export function OpeningsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: profile } = useUserProfile();
  const hasGames = (profile?.chess_com_game_count ?? 0) + (profile?.lichess_game_count ?? 0) > 0;

  const needsRedirect = location.pathname === '/openings' || location.pathname === '/openings/';
  // Redirect old /openings/compare and /openings/statistics URLs to /openings/stats after tab rename
  const needsLegacyRedirect = location.pathname.endsWith('/statistics') || location.pathname.endsWith('/compare');

  const activeTab = location.pathname.includes('/games')
    ? 'games'
    : location.pathname.includes('/stats')
      ? 'stats'
      : location.pathname.includes('/insights')
        ? 'insights'
        : 'explorer';

  // ── Board state ─────────────────────────────────────────────────────────────
  const chess = useChessGame();
  // Destructured out of `chess` before use: react-hooks/refs taints every
  // property read off an object once one of them is used as a JSX `ref`, which
  // would flag all ~30 other `chess.*` reads on this page.
  const { desktopBoardRef, mobileBoardRef } = chess;
  const [boardFlipped, setBoardFlipped] = useState(false);

  // ── Filter state (shared across pages) ───────────────────────────────────────
  // `filters` is the committed store value that queries read.
  // `localFilters` is the single draft for both desktop sidebar and mobile drawer.
  // Edits always go to localFilters; Apply commits localFilters → filters (store).
  const [filters, setFilters] = useFilterStore();
  const debouncedFilters = useDebounce(filters, 300);

  // ── Board arrows (hovered move) ─────────────────────────────────────────────
  const [hoveredMove, setHoveredMove] = useState<string | null>(null);

  // ── Deep-link highlight (Insights → MoveExplorer / quick-task 260427-j41) ──
  const { highlightedMove, setHighlightedMove, pulseActive } = useDeepLinkHighlight(
    activeTab,
    filters,
  );

  // ── Sidebar / drawer state + onboarding hint dismissal ──────────────────────
  const sidebar = useSidebarState();

  // ── Mobile sidebar deferred-apply local state ───────────────────────────────
  const [localChartEnabled, setLocalChartEnabled] = useState<Record<number, boolean>>({});
  const [localMatchSides, setLocalMatchSides] = useState<Record<number, MatchSide>>({});
  const [localFilters, setLocalFilters] = useState<FilterState>(filters);

  // ── Games tab pagination + tab-switch resets ────────────────────────────────
  const { gamesOffset, setGamesOffset } = useTabReset(activeTab);

  // ── Bookmarks ───────────────────────────────────────────────────────────────
  const { data: bookmarks = [] } = usePositionBookmarks();
  const createBookmark = useCreatePositionBookmark();
  const [bookmarkDialogOpen, setBookmarkDialogOpen] = useState(false);
  const [bookmarkLabel, setBookmarkLabel] = useState('');
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);

  // Onboarding hint progression (only one red dot visible at a time):
  // played-as → filters → bookmarks. Each step unlocks the next once used.
  const showPlayedAsHint = hasGames && !sidebar.playedAsHintDismissed;
  const showFiltersHint = hasGames && sidebar.playedAsHintDismissed && !sidebar.filtersHintDismissed;
  const showBookmarksHint =
    hasGames && sidebar.playedAsHintDismissed && sidebar.filtersHintDismissed && bookmarks.length === 0;

  // ── Modified-filters indicator ─────────────────────────────────────────────
  // Desktop: filters apply immediately, so the dot tracks `filters` directly.
  // Mobile drawer: defers apply until drawer close, so the dot also tracks `filters`
  // (the committed state), and we add a one-shot pulse on drawer close when
  // localFilters differed from filters at close time.
  const justCommittedFromDrawerRef = useRef(false);
  const isFiltersModified = useMemo(
    () => !areFiltersEqual(filters, DEFAULT_FILTERS, FILTER_DOT_FIELDS),
    [filters],
  );
  const [isFiltersPulsing, setIsFiltersPulsing] = useState(false);
  const filtersPulseTimeoutRef = useRef<number | null>(null);
  const prevFiltersRef = useRef(filters);

  useEffect(() => {
    if (prevFiltersRef.current !== filters) {
      prevFiltersRef.current = filters;
      // On Openings desktop, `filters` changes live as the user toggles — pulsing on every
      // change would be noisy. Only pulse when the mobile drawer JUST closed AND committed
      // a change. We guard via `justCommittedFromDrawerRef` set inside handleFilterSidebarOpenChange.
      if (justCommittedFromDrawerRef.current) {
        justCommittedFromDrawerRef.current = false;
        setIsFiltersPulsing(true);
        if (filtersPulseTimeoutRef.current !== null) {
          window.clearTimeout(filtersPulseTimeoutRef.current);
        }
        filtersPulseTimeoutRef.current = window.setTimeout(() => {
          setIsFiltersPulsing(false);
          filtersPulseTimeoutRef.current = null;
        }, 1000);
      }
    }
    return () => {
      if (filtersPulseTimeoutRef.current !== null) {
        window.clearTimeout(filtersPulseTimeoutRef.current);
        filtersPulseTimeoutRef.current = null;
      }
    };
  }, [filters]);

  // ── Chart-enable toggle (persisted per bookmark in localStorage) ─────────────
  // Version counter to force chartEnabledMap recompute when a toggle changes
  const [chartToggleVersion, setChartToggleVersion] = useState(0);

  // ── Moves data ──────────────────────────────────────────────────────
  const nextMoves = useNextMoves(chess.hashes.fullHash, debouncedFilters);

  // ── Games tab data ──────────────────────────────────────────────────────────
  const targetHash = chess.getHashForOpenings(filters.matchSide, filters.color);
  const gamesQuery = useOpeningsPositionQuery({
    targetHash,
    filters: debouncedFilters,
    offset: gamesOffset,
    limit: PAGE_SIZE,
  });

  // Total game count — fetched on load to drive empty-state messaging
  const { data: gameCountData } = useGameCount();
  const gameCount = gameCountData?.count ?? null;

  // ── Stats tab data ─────────────────────────────────────────────────────────────

  // Most played openings — filter params applied to show top openings per color
  const {
    data: mostPlayedData,
    isLoading: mostPlayedLoading,
    isError: mostPlayedError,
  } = useMostPlayedOpenings({
    recency: debouncedFilters.recency,
    customRange: debouncedFilters.customRange,
    timeControls: debouncedFilters.timeControls,
    platforms: debouncedFilters.platforms,
    rated: debouncedFilters.rated,
    opponentType: debouncedFilters.opponentType,
    opponentStrength: debouncedFilters.opponentStrength,
  });

  // Query-derivation cluster — chart-enable map, board arrows (from next-move
  // frequencies), chart-enabled bookmark subset, per-bookmark phase-entry
  // metrics, and per-bookmark WDL stats. Extracted to useOpeningsChartData.ts.
  const {
    chartEnabledMap,
    boardArrows,
    chartBookmarks,
    bookmarkPhaseEntryByHash,
    tsData,
    wdlStatsMap,
  } = useOpeningsChartData({
    bookmarks,
    chartToggleVersion,
    nextMovesData: nextMoves.data,
    position: chess.position,
    hoveredMove,
    highlightedMove,
    pulseActive,
    debouncedFilters,
  });

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleChartEnabledChange = useCallback((id: number, enabled: boolean) => {
    setChartEnabledStorage(id, enabled);
    setChartToggleVersion(v => v + 1);
    if (activeTab !== 'stats') navigate('/openings/stats');
  }, [activeTab, navigate]);

  // ── Desktop sidebar filter panel Apply handler ────────────────────────────────
  // Commits localFilters to the store, fires the pulse, closes the panel, and
  // handles color/matchSide-driven navigation + board flip.
  const handleDesktopFiltersApply = useCallback(() => {
    // Set the ref BEFORE setFilters so the existing useEffect detects the commit.
    if (!areFiltersEqual(localFilters, filters)) {
      justCommittedFromDrawerRef.current = true;
    }
    setFilters(localFilters);
    setGamesOffset(0);
    sidebar.setFiltersHintDismissed(true);
    setBoardFlipped(localFilters.color === 'black');
    if ((localFilters.color !== filters.color || localFilters.matchSide !== filters.matchSide)
        && activeTab !== 'explorer' && activeTab !== 'games') {
      navigate('/openings/explorer');
    }
    sidebar.setSidebarOpen(null);
  }, [localFilters, filters, setFilters, setGamesOffset, sidebar, activeTab, navigate]);

  const openBookmarkDialog = useCallback(() => {
    // Use currentPly, not full moveHistory length — user may have navigated back
    const defaultLabel = chess.openingName?.name ?? `Position (${chess.currentPly} moves)`;
    setBookmarkLabel(defaultLabel);
    setBookmarkDialogOpen(true);
  }, [chess]);

  const handleBookmarkSave = useCallback(async () => {
    const label = bookmarkLabel.trim();
    if (!label) return;

    const matchSide = filters.matchSide;
    const targetHashLocal = chess.getHashForOpenings(matchSide, filters.color);
    const data = {
      label,
      target_hash: targetHashLocal,
      fen: chess.position,
      // Truncate to currentPly — bookmark saves the displayed position, not moves played after it
      moves: chess.moveHistory.slice(0, chess.currentPly),
      color: filters.color,
      match_side: matchSide,
      is_flipped: boardFlipped,
    };
    try {
      await createBookmark.mutateAsync(data);
      setBookmarkDialogOpen(false);
      if (activeTab !== 'stats') navigate('/openings/stats');
      sidebar.setSidebarOpen('bookmarks');
    } catch {
      toast.error('Failed to save bookmark');
    }
  }, [chess, filters, boardFlipped, bookmarkLabel, createBookmark, activeTab, navigate, sidebar]);

  // Navigation handlers (deep-link / open-from-{X}) bundled into a single hook.
  // All handlers preserve original behavior exactly: chess.loadMoves → flip board
  // → update filters → navigate → scrollTo top.
  const {
    handleOpenChartBookmarkGames,
    handleOpenGames,
    handleOpenMoves,
    handleOpenFinding,
    handleOpenFindingGames,
    handleLoadBookmark,
    handleReorder,
  } = useOpeningsHandlers({
    chess,
    navigate,
    activeTab,
    setBoardFlipped,
    setFilters,
    setHighlightedMove,
    mostPlayedData,
  });

  // ── Desktop sidebar panel-change handler ─────────────────────────────────────
  // Wraps sidebar.setSidebarOpen so we can snapshot localFilters when the filters
  // panel opens (discard-on-close: do NOT commit when it closes without Apply).
  const handleDesktopSidebarOpenChange = useCallback((panel: string | null) => {
    if (panel === 'filters' && sidebar.sidebarOpen !== 'filters') {
      // Filters panel opening — snapshot committed state as the new draft.
      setLocalFilters({ ...filters });
    }
    sidebar.setSidebarOpen(panel as 'filters' | 'bookmarks' | null);
  }, [sidebar, filters]);

  // ── Mobile sidebar handlers ──────────────────────────────────────────────────

  const openFilterSidebar = useCallback(() => {
    setLocalFilters({ ...filters });
    sidebar.setFilterSidebarOpen(true);
  }, [filters, sidebar]);

  const handleFilterSidebarOpenChange = useCallback((open: boolean) => {
    if (open && !sidebar.filterSidebarOpen) {
      // Snapshot committed state on open.
      setLocalFilters({ ...filters });
    }
    // Close without Apply: do NOT commit. The draft is discarded (re-snapshotted on next open).
    sidebar.setFilterSidebarOpen(open);
  }, [sidebar, filters]);

  // Mobile Apply handler: commits localFilters to store, fires pulse, closes drawer,
  // handles navigation + board flip.
  const handleMobileFiltersApply = useCallback(() => {
    if (!areFiltersEqual(localFilters, filters)) {
      justCommittedFromDrawerRef.current = true;
    }
    setFilters(localFilters);
    setGamesOffset(0);
    sidebar.setFiltersHintDismissed(true);
    setBoardFlipped(localFilters.color === 'black');
    if ((localFilters.color !== filters.color || localFilters.matchSide !== filters.matchSide)
        && activeTab !== 'explorer' && activeTab !== 'games') {
      navigate('/openings/explorer');
    }
    sidebar.setFilterSidebarOpen(false);
  }, [localFilters, filters, setFilters, setGamesOffset, sidebar, activeTab, navigate]);

  const updateMatchSide = useUpdateMatchSide();

  const openBookmarkSidebar = useCallback(() => {
    setLocalChartEnabled({ ...chartEnabledMap });
    setLocalMatchSides({});
    sidebar.setBookmarkSidebarOpen(true);
  }, [chartEnabledMap, sidebar]);

  const handleBookmarkSidebarOpenChange = useCallback((open: boolean) => {
    if (!open && sidebar.bookmarkSidebarOpen) {
      // Commit deferred chart toggle changes on close
      for (const [idStr, enabled] of Object.entries(localChartEnabled)) {
        const id = Number(idStr);
        if (chartEnabledMap[id] !== enabled) {
          setChartEnabledStorage(id, enabled);
        }
      }
      // Commit deferred match side changes on close
      for (const [idStr, matchSide] of Object.entries(localMatchSides)) {
        const id = Number(idStr);
        updateMatchSide.mutate({ id, data: { match_side: matchSide } });
      }
      // Bump chart toggle version to refresh chartEnabledMap
      const chartChanged = Object.keys(localChartEnabled).some(idStr => chartEnabledMap[Number(idStr)] !== localChartEnabled[Number(idStr)]);
      if (chartChanged) {
        setChartToggleVersion(v => v + 1);
        if (activeTab !== 'stats') navigate('/openings/stats');
      }
    }
    sidebar.setBookmarkSidebarOpen(open);
  }, [sidebar, localChartEnabled, localMatchSides, chartEnabledMap, updateMatchSide, activeTab, navigate]);

  const handleLocalChartEnabledChange = useCallback((id: number, enabled: boolean) => {
    setLocalChartEnabled(prev => ({ ...prev, [id]: enabled }));
  }, []);

  const handleLocalMatchSideChange = useCallback((id: number, matchSide: MatchSide) => {
    setLocalMatchSides(prev => ({ ...prev, [id]: matchSide }));
  }, []);

  // Bookmarks with local match_side overrides applied for visual feedback in mobile drawer
  const localBookmarks = useMemo(() => {
    if (Object.keys(localMatchSides).length === 0) return bookmarks;
    return bookmarks.map(b => {
      const localSide = localMatchSides[b.id];
      return localSide ? { ...b, match_side: localSide } : b;
    });
  }, [bookmarks, localMatchSides]);

  const handleLoadBookmarkFromSidebar = useCallback((bkm: PositionBookmarkResponse) => {
    handleLoadBookmark(bkm);
    sidebar.setBookmarkSidebarOpen(false);
  }, [handleLoadBookmark, sidebar]);

  const handleLoadBookmarkFromDesktopSidebar = useCallback((bkm: PositionBookmarkResponse) => {
    handleLoadBookmark(bkm);
    sidebar.setSidebarOpen(null);
  }, [handleLoadBookmark, sidebar]);

  // Send the explorer's opening moves (up to the current cursor) to the analysis
  // board as a `?line=` main line — so the user can step all the way back to move
  // 1 there — rather than a bare snapshot FEN (which lost the move history).
  const handleAnalyzePosition = useCallback(() => {
    navigate(buildAnalysisLineUrl(chess.moveHistory.slice(0, chess.currentPly)));
  }, [navigate, chess.moveHistory, chess.currentPly]);

  // Analyze-position button shows on the board-bearing subtabs (Moves + Games),
  // where the chessboard position is the thing worth sending to the analysis page.
  const showAnalyzeButton = activeTab === 'explorer' || activeTab === 'games';

  // ── Tab content ─────────────────────────────────────────────────────────────

  const hasNoGames = gameCount !== null && gameCount === 0;
  const gamesData = gamesQuery.data;
  const filtersMatchNothing = gamesData !== undefined && gamesData.matched_count === 0 && !hasNoGames;
  // SEED-163 2d: true only when the Human+Rated defaults alone (no other
  // filter) are what emptied the population.
  const noHumanRatedGames = shouldShowNoHumanRatedGames(filters, gameCount);

  // Color icon + name reused in Position Results labels and the matched-games summary
  const colorIconSquare = (
    <span className={`inline-block h-3 w-3 rounded-xs border border-muted-foreground ${filters.color === 'white' ? 'bg-white' : 'bg-zinc-900'}`} />
  );
  const colorName = filters.color === 'white' ? 'White' : 'Black';
  const pieceFilterLabel = filters.matchSide === 'both' ? null : `(Piece filter: ${filters.matchSide === 'mine' ? 'Mine' : 'Opponent'})`;
  const positionResultsLabel = (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span>Results played as</span>
      {colorIconSquare}
      <span>{colorName}</span>
      {pieceFilterLabel && <span className="basis-full md:basis-auto text-muted-foreground">{pieceFilterLabel}</span>}
    </span>
  );

  const hasOpenings = !!mostPlayedData &&
    (mostPlayedData.white.length > 0 || mostPlayedData.black.length > 0);

  const explorerTabEl = (
    <ExplorerTab
      gamesData={gamesData}
      filterColor={filters.color}
      positionResultsLabel={positionResultsLabel}
      nextMoves={nextMoves}
      position={chess.position}
      onMoveClick={(from, to) => chess.makeMove(from, to)}
      onMoveHover={setHoveredMove}
      highlightedMove={highlightedMove}
      pulseActive={pulseActive}
      onHighlightConsumed={() => setHighlightedMove(null)}
    />
  );

  const gamesTabEl = (
    <GamesTab
      gamesQuery={gamesQuery}
      hasNoGames={hasNoGames}
      filtersMatchNothing={filtersMatchNothing}
      noHumanRatedGames={noHumanRatedGames}
      gameCount={gameCount}
      positionResultsLabel={positionResultsLabel}
      colorIconSquare={colorIconSquare}
      filterColor={filters.color}
      gamesOffset={gamesOffset}
      pageSize={PAGE_SIZE}
      onPageChange={setGamesOffset}
      analyzePly={chess.currentPly}
    />
  );

  const statsTabEl = (
    <StatsTab
      bookmarks={bookmarks}
      chartBookmarks={chartBookmarks}
      wdlStatsMap={wdlStatsMap}
      bookmarkPhaseEntryByHash={bookmarkPhaseEntryByHash}
      mostPlayedData={mostPlayedData}
      mostPlayedLoading={mostPlayedLoading}
      mostPlayedError={mostPlayedError}
      tsData={tsData}
      onOpenMoves={handleOpenMoves}
      onOpenChartBookmarkGames={handleOpenChartBookmarkGames}
      onOpenGames={handleOpenGames}
      onOpenSuggestions={() => setSuggestionsOpen(true)}
    />
  );

  const insightsTabEl = (
    <InsightsTab
      hasOpenings={hasOpenings}
      debouncedFilters={debouncedFilters}
      onFindingClick={handleOpenFinding}
      onOpenGames={handleOpenFindingGames}
    />
  );

  // Shared filter notification dot for the mobile filter affordances: the board
  // settings-column button (Moves/Games subtabs) and the sticky Filters button
  // (Stats/Insights subtabs). Mirrors the desktop SidebarLayout notificationDot.
  const mobileFiltersDot = showFiltersHint ? (
    <span
      className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5"
      data-testid="filters-notification-dot-mobile"
    >
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
    </span>
  ) : isFiltersModified ? (
    <span
      className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5"
      data-testid="filters-modified-dot-mobile"
      aria-hidden="true"
    >
      {isFiltersPulsing && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-brown opacity-75" />
      )}
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-brown" />
    </span>
  ) : null;

  // ── Render ──────────────────────────────────────────────────────────────────

  if (needsRedirect) {
    return <Navigate to="/openings/explorer" replace />;
  }

  if (needsLegacyRedirect) {
    return <Navigate to="/openings/stats" replace />;
  }

  return (
    <div data-testid="openings-page" className="flex min-h-0 flex-1 flex-col bg-background">
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-2 md:py-6 md:px-6">
        {/* Desktop: full-width subnav above the sidebar strip + board/content row (Phase 111 —
            matches the Library page). Tabs wraps SidebarLayout so the subnav spans both the
            strip and the content; TabsContent stays inside SidebarLayout to keep Tabs context. */}
        <Tabs
          value={activeTab}
          onValueChange={(val) => { navigate(`/openings/${val}`); window.scrollTo({ top: 0 }); }}
          className="hidden lg:flex"
        >
          <EvalCoverageHeader />
          <TabsList variant="brand" className="w-full mb-4" data-testid="openings-tabs">
            <TabsTrigger value="explorer" data-testid="tab-move-explorer" className="flex-1">
              <ArrowRightLeft className="mr-1.5 h-4 w-4" />
              Moves
              {activeTab === 'explorer' && (
                <span className="ml-1.5 inline-flex items-center [&>span]:text-white! [&>span:hover]:text-white/80!" onClick={(e) => e.stopPropagation()}>
                  <InfoPopover ariaLabel={TAB_INFO.explorer.aria} testId="tab-explorer-info" side="bottom">
                    {TAB_INFO.explorer.text}
                  </InfoPopover>
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="games" data-testid="tab-games" className="flex-1">
              <Swords className="mr-1.5 h-4 w-4" />
              Games
              {activeTab === 'games' && (
                <span className="ml-1.5 inline-flex items-center [&>span]:text-white! [&>span:hover]:text-white/80!" onClick={(e) => e.stopPropagation()}>
                  <InfoPopover ariaLabel={TAB_INFO.games.aria} testId="tab-games-info" side="bottom">
                    {TAB_INFO.games.text}
                  </InfoPopover>
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="stats" data-testid="tab-stats" className="flex-1">
              <BarChart2 className="mr-1.5 h-4 w-4" />
              Stats
              {activeTab === 'stats' && (
                <span className="ml-1.5 inline-flex items-center [&>span]:text-white! [&>span:hover]:text-white/80!" onClick={(e) => e.stopPropagation()}>
                  <InfoPopover ariaLabel={TAB_INFO.stats.aria} testId="tab-stats-info" side="bottom">
                    {TAB_INFO.stats.text}
                  </InfoPopover>
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="insights" data-testid="tab-insights" className="flex-1">
              <Lightbulb className="mr-1.5 h-4 w-4" />
              Insights
              {activeTab === 'insights' && (
                <span className="ml-1.5 inline-flex items-center [&>span]:text-white! [&>span:hover]:text-white/80!" onClick={(e) => e.stopPropagation()}>
                  <InfoPopover ariaLabel={TAB_INFO.insights.aria} testId="tab-insights-info" side="bottom">
                    {TAB_INFO.insights.text}
                  </InfoPopover>
                </span>
              )}
            </TabsTrigger>
          </TabsList>
        <OpeningsDesktopSidebar
          localFilters={localFilters}
          setLocalFilters={setLocalFilters}
          onApplyFilters={handleDesktopFiltersApply}
          showFiltersHint={showFiltersHint}
          isFiltersModified={isFiltersModified}
          isFiltersPulsing={isFiltersPulsing}
          bookmarks={bookmarks}
          onReorderBookmarks={handleReorder}
          onLoadBookmark={handleLoadBookmarkFromDesktopSidebar}
          chartEnabledMap={chartEnabledMap}
          onChartEnabledChange={handleChartEnabledChange}
          onOpenSuggestions={() => setSuggestionsOpen(true)}
          onOpenBookmarkDialog={openBookmarkDialog}
          showBookmarksHint={showBookmarksHint}
          activePanel={sidebar.sidebarOpen}
          onActivePanelChange={handleDesktopSidebarOpenChange}
          showAnalyzeButton={showAnalyzeButton}
          onAnalyzePosition={handleAnalyzePosition}
          filterColor={filters.color}
          onToggleColor={() => {
            const next = filters.color === 'white' ? 'black' : 'white';
            setFilters(prev => ({ ...prev, color: next as Color }));
            setBoardFlipped(next === 'black');
            sidebar.dismissPlayedAsHint();
          }}
          showPlayedAsHint={showPlayedAsHint}
        >
            <div className="flex flex-row items-start gap-6">
              <div className={getBoardContainerClassName(activeTab)} data-testid="openings-board-container">
                {/* Wraps the board only (not BoardControls): this ref scopes wheel
                    navigation to the board surface — see useBoardNavigationInput. */}
                <div ref={desktopBoardRef}>
                  <ChessBoard
                    position={chess.position}
                    onPieceDrop={chess.makeMove}
                    flipped={boardFlipped}
                    lastMove={chess.lastMove}
                    arrows={boardArrows}
                  />
                </div>
                <BoardControls
                  onBack={chess.goBack}
                  onForward={chess.goForward}
                  onReset={() => { chess.reset(); setGamesOffset(0); }}
                  onFlip={() => setBoardFlipped((f) => !f)}
                  canGoBack={chess.currentPly > 0}
                  canGoForward={chess.currentPly < chess.moveHistory.length}
                  infoSlot={
                    <InfoPopover ariaLabel="Chessboard info" testId="chessboard-info" side="top">
                      <ChessboardInfoCopy />
                    </InfoPopover>
                  }
                />
                <div className="flex items-center gap-2 px-1 text-sm min-h-[1.25rem]">
                  {chess.openingName ? (
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{chess.openingName.eco}</span>
                      <span className="text-foreground">{chess.openingName.name}</span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground italic">Play some moves</span>
                  )}
                </div>
                <MoveList
                  moveHistory={chess.moveHistory}
                  currentPly={chess.currentPly}
                  onMoveClick={chess.goToMove}
                />
              </div>
              <div className="flex-1 min-w-0">
                <TabsContent value="explorer">{explorerTabEl}</TabsContent>
                <TabsContent value="games">{gamesTabEl}</TabsContent>
                <TabsContent value="stats">{statsTabEl}</TabsContent>
                <TabsContent value="insights">{insightsTabEl}</TabsContent>
              </div>
            </div>
          </OpeningsDesktopSidebar>
        </Tabs>

        {/* Mobile: sticky subnav + non-sticky board (matches Endgames pattern, 71.1-02) */}
        <div className="lg:hidden flex flex-col min-w-0">
          <EvalCoverageHeader />
        <Tabs value={activeTab} onValueChange={(val) => { navigate(`/openings/${val}`); window.scrollTo({ top: 0 }); }} className="flex flex-col gap-2 min-w-0">
          {/* Full-width, non-sticky sub-navigation (like the Library page). The filter
              affordance lives in the board settings column on Moves/Games, and as a
              sticky Filters button on Stats/Insights (rendered just below). */}
          <div
            className="flex items-center gap-2 h-[40px] rounded-md"
            data-testid="openings-mobile-subnav"
          >
            <TabsList variant="brand" className="flex-1 !h-full !p-0" data-testid="openings-tabs-mobile">
              <TabsTrigger value="explorer" className="flex-1" data-testid="tab-move-explorer-mobile">
                Moves
                {activeTab === 'explorer' && (
                  <span className="ml-1.5 inline-flex items-center [&>span]:text-white! [&>span:hover]:text-white/80!" onClick={(e) => e.stopPropagation()}>
                    <InfoPopover ariaLabel={TAB_INFO.explorer.aria} testId="tab-explorer-info-mobile" side="bottom">
                      {TAB_INFO.explorer.text}
                    </InfoPopover>
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="games" className="flex-1" data-testid="tab-games-mobile">
                Games
                {activeTab === 'games' && (
                  <span className="ml-1.5 inline-flex items-center [&>span]:text-white! [&>span:hover]:text-white/80!" onClick={(e) => e.stopPropagation()}>
                    <InfoPopover ariaLabel={TAB_INFO.games.aria} testId="tab-games-info-mobile" side="bottom">
                      {TAB_INFO.games.text}
                    </InfoPopover>
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="stats" className="flex-1" data-testid="tab-stats-mobile">
                Stats
                {activeTab === 'stats' && (
                  <span className="ml-1.5 inline-flex items-center [&>span]:text-white! [&>span:hover]:text-white/80!" onClick={(e) => e.stopPropagation()}>
                    <InfoPopover ariaLabel={TAB_INFO.stats.aria} testId="tab-stats-info-mobile" side="bottom">
                      {TAB_INFO.stats.text}
                    </InfoPopover>
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="insights" className="flex-1" data-testid="tab-insights-mobile">
                Insights
                {activeTab === 'insights' && (
                  <span className="ml-1.5 inline-flex items-center [&>span]:text-white! [&>span:hover]:text-white/80!" onClick={(e) => e.stopPropagation()}>
                    <InfoPopover ariaLabel={TAB_INFO.insights.aria} testId="tab-insights-info-mobile" side="bottom">
                      {TAB_INFO.insights.text}
                    </InfoPopover>
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Sticky Filters button on the non-board subtabs (Stats/Insights), styled
              like the Library page. On Moves/Games the filter button lives in the
              board settings column instead, so it is not rendered here. */}
          {(activeTab === 'stats' || activeTab === 'insights') && (
            <div className="sticky top-0 z-20 flex justify-end gap-2 py-2 bg-background/80 backdrop-blur-sm">
              <Button
                variant="brand-outline"
                className="relative"
                onClick={openFilterSidebar}
                data-testid="subnav-filter-button"
                aria-label="Open filters"
              >
                <SlidersHorizontal className="mr-2 h-4 w-4" />
                Filters
                {mobileFiltersDot}
              </Button>
            </div>
          )}

          {/* Non-sticky board block — only visible on Moves + Games subtabs (D-07, D-08, D-09) */}
          <OpeningsMobileBoardPanel
            activeTab={activeTab}
            mobileBoardRef={mobileBoardRef}
            position={chess.position}
            onPieceDrop={chess.makeMove}
            flipped={boardFlipped}
            lastMove={chess.lastMove}
            arrows={boardArrows}
            onBack={chess.goBack}
            onForward={chess.goForward}
            onReset={() => { chess.reset(); setGamesOffset(0); }}
            onFlip={() => setBoardFlipped((f) => !f)}
            canGoBack={chess.currentPly > 0}
            canGoForward={chess.currentPly < chess.moveHistory.length}
            onOpenFilterSidebar={openFilterSidebar}
            filtersNotificationDot={mobileFiltersDot}
            filterColor={filters.color}
            onTogglePlayedAs={() => {
              const newColor: Color = filters.color === 'white' ? 'black' : 'white';
              // Change color without dismissing the filters hint — only the
              // Played-as hint advances when the color toggle is used.
              setFilters({ ...filters, color: newColor });
              setGamesOffset(0);
              setBoardFlipped(newColor === 'black');
              sidebar.dismissPlayedAsHint();
              if (activeTab !== 'explorer' && activeTab !== 'games') navigate('/openings/explorer');
            }}
            showPlayedAsHint={showPlayedAsHint}
            onOpenBookmarkSidebar={openBookmarkSidebar}
            showBookmarksHint={showBookmarksHint}
            showAnalyzeButton={showAnalyzeButton}
            onAnalyzePosition={handleAnalyzePosition}
            openingName={chess.openingName}
            moveHistory={chess.moveHistory}
            currentPly={chess.currentPly}
            onMoveClick={chess.goToMove}
          />

          <OpeningsMobileDrawers
            filterSidebarOpen={sidebar.filterSidebarOpen}
            onFilterSidebarOpenChange={handleFilterSidebarOpenChange}
            localFilters={localFilters}
            setLocalFilters={setLocalFilters}
            onApplyMobileFilters={handleMobileFiltersApply}
            bookmarkSidebarOpen={sidebar.bookmarkSidebarOpen}
            onBookmarkSidebarOpenChange={handleBookmarkSidebarOpenChange}
            localBookmarks={localBookmarks}
            onReorderBookmarks={handleReorder}
            onLoadBookmark={handleLoadBookmarkFromSidebar}
            localChartEnabled={localChartEnabled}
            onLocalChartEnabledChange={handleLocalChartEnabledChange}
            onLocalMatchSideChange={handleLocalMatchSideChange}
            onOpenSuggestions={() => setSuggestionsOpen(true)}
            onOpenBookmarkDialog={openBookmarkDialog}
          />

          <TabsContent value="explorer" className="mt-2">{explorerTabEl}</TabsContent>
          <TabsContent value="games" className="mt-2">{gamesTabEl}</TabsContent>
          <TabsContent value="stats" className="mt-2">{statsTabEl}</TabsContent>
          <TabsContent value="insights" className="mt-2">{insightsTabEl}</TabsContent>
        </Tabs>
        </div>
      </main>

      {/* Bookmark label dialog */}
      <Dialog open={bookmarkDialogOpen} onOpenChange={setBookmarkDialogOpen}>
        <DialogContent data-testid="bookmark-dialog">
          <DialogHeader>
            <DialogTitle>Save Bookmark</DialogTitle>
            <DialogDescription>
              Enter a label for this opening bookmark.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={bookmarkLabel}
            onChange={(e) => setBookmarkLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleBookmarkSave();
            }}
            placeholder="Bookmark label"
            autoFocus
            data-testid="bookmark-label-input"
          />
          <DialogFooter>
            <Button
              onClick={handleBookmarkSave}
              disabled={!bookmarkLabel.trim() || createBookmark.isPending}
              data-testid="btn-bookmark-save"
            >
              {createBookmark.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SuggestionsModal
        open={suggestionsOpen}
        onOpenChange={setSuggestionsOpen}
        mostPlayedData={mostPlayedData}
        bookmarks={bookmarks}
        onSaved={() => {
          if (activeTab !== 'stats') navigate('/openings/stats');
          sidebar.setSidebarOpen('bookmarks');
        }}
      />
    </div>
  );
}
