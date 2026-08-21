import { useState, useMemo, useCallback, useRef, useEffect } from 'react';

// localStorage helpers for per-bookmark chart-enable toggle (default: enabled)
function getChartEnabled(bookmarkId: number): boolean {
  const stored = localStorage.getItem(`bookmark-chart-enabled-${bookmarkId}`);
  return stored === null ? true : stored === 'true';
}
function setChartEnabledStorage(bookmarkId: number, enabled: boolean): void {
  localStorage.setItem(`bookmark-chart-enabled-${bookmarkId}`, String(enabled));
}
import { useNavigate, useLocation, Navigate } from 'react-router';
import { useUserProfile } from '@/hooks/useUserProfile';
import { Chess } from 'chess.js';
import { useQuery } from '@tanstack/react-query';
import { Save, Sparkles, ArrowRightLeft, Swords, BarChart2, Lightbulb, SlidersHorizontal, BookMarked, Search } from 'lucide-react';
import { MobileFilterDrawer } from '@/components/filters/MobileFilterDrawer';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
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
  useTimeSeries,
} from '@/hooks/usePositionBookmarks';
import { useMostPlayedOpenings, useBookmarkPhaseEntryMetrics } from '@/hooks/useStats';
import { rangeToQueryParams } from '@/lib/opponentStrength';
import { resolveDateRange, dateRangeToWireParams } from '@/lib/recency';
import { ChessBoard } from '@/components/board/ChessBoard';
import { MoveList } from '@/components/board/MoveList';
import { BoardControls } from '@/components/board/BoardControls';
import { FilterPanel, DEFAULT_FILTERS, areFiltersEqual, FILTER_DOT_FIELDS, resetFilterState } from '@/components/filters/FilterPanel';
import { FilterActions } from '@/components/filters/FilterActions';
import { useFilterStore } from '@/hooks/useFilterStore';
import { PositionBookmarkList } from '@/components/position-bookmarks/PositionBookmarkList';
import { SuggestionsModal } from '@/components/position-bookmarks/SuggestionsModal';
import { SidebarLayout, type SidebarPanelConfig } from '@/components/layout/SidebarLayout';
import { getArrowColor } from '@/lib/arrowColor';
import { apiClient } from '@/api/client';
import { getBoardContainerClassName } from '@/lib/openingsBoardLayout';
import { buildAnalysisLineUrl } from '@/lib/analysisUrl';
import type { FilterState } from '@/components/filters/FilterPanel';
import type { Color, MatchSide } from '@/types/api';
import { resolveMatchSide } from '@/types/api';
import type { PositionBookmarkResponse, TimeSeriesRequest } from '@/types/position_bookmarks';
import { useDeepLinkHighlight } from './openings/useDeepLinkHighlight';
import { useSidebarState } from './openings/useSidebarState';
import { useTabReset } from './openings/useTabReset';
import { useOpeningsHandlers } from './openings/useOpeningsHandlers';
import { ExplorerTab } from './openings/ExplorerTab';
import { GamesTab } from './openings/GamesTab';
import { StatsTab, type WdlStatsRow } from './openings/StatsTab';
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

// Shared body for the chessboard info popover. Device-agnostic copy ("click or
// tap", "hover or tap") so the same prose works on desktop and mobile.
function ChessboardInfoCopy() {
  return (
    <div className="space-y-2">
      <p>
        Play moves by clicking or tapping squares, dragging pieces, or selecting a row in the Moves tab.
      </p>
      <p>
        The arrows show the next moves from your games. Bigger means more frequent. Color reflects the score, but only when there are enough games to trust it:
      </p>
      <ul className="list-disc pl-5 space-y-1">
        <li>Green: Score ≥ 55%</li>
        <li>Red: Score ≤ 45%</li>
        <li>Faint grey: Score between 45% and 55%, or too few games / low confidence to call it</li>
      </ul>
    </div>
  );
}

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

  const chartEnabledMap = useMemo(() => {
    const map: Record<number, boolean> = {};
    for (const b of bookmarks) {
      map[b.id] = getChartEnabled(b.id);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookmarks, chartToggleVersion]);

  // ── Moves data ──────────────────────────────────────────────────────
  const nextMoves = useNextMoves(chess.hashes.fullHash, debouncedFilters);

  // Board arrows derived from next move frequencies. The matching arrow on a
  // deep-link gets isHighlightPulse=true so its <path> pulses briefly. The
  // arrow's COLOR stays whatever getArrowColor returned (score zone) — pulse
  // only modulates opacity. Row tint comes from the score zone too, so a
  // highlighted row pulses through grey alpha levels and lands on the row's
  // natural score-zone color.
  const boardArrows = useMemo(() => {
    if (!nextMoves.data?.moves.length) return [];

    const chessInstance = new Chess(chess.position);
    const legalMoves = chessInstance.moves({ verbose: true });
    const moveMap = new Map(legalMoves.map(m => [m.san, { from: m.from, to: m.to }]));

    const moves = nextMoves.data.moves;
    const maxCount = Math.max(...moves.map(m => m.game_count), 1);

    return moves
      .map(entry => {
        const squares = moveMap.get(entry.move_san);
        if (!squares) return null;
        const isHovered = entry.move_san === hoveredMove;
        const isHighlightPulse = pulseActive && highlightedMove !== null && entry.move_san === highlightedMove.san;
        return {
          startSquare: squares.from,
          endSquare: squares.to,
          color: getArrowColor(entry.score, entry.game_count, entry.confidence),
          width: entry.game_count / maxCount,
          isHovered,
          isHighlightPulse,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);
  }, [nextMoves.data, chess.position, hoveredMove, highlightedMove, pulseActive]);

  // ── Games tab data ──────────────────────────────────────────────────────────
  const targetHash = chess.getHashForOpenings(filters.matchSide, filters.color);
  const gamesQuery = useOpeningsPositionQuery({
    targetHash,
    filters: debouncedFilters,
    offset: gamesOffset,
    limit: PAGE_SIZE,
  });

  // Total game count — fetched on load to drive empty-state messaging
  const { data: gameCountData } = useQuery<{ count: number }>({
    queryKey: ['gameCount'],
    queryFn: async () => {
      const response = await apiClient.get<{ count: number }>('/users/games/count');
      return response.data;
    },
    staleTime: 30_000,
  });
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

  // Chart entries: real bookmarks filtered by chart-enable toggle.
  // Memoized so the array identity is stable across renders that don't change
  // the underlying bookmarks or toggle map — keeps `timeSeriesRequest` (which
  // depends on this) from being rebuilt on every parent tick.
  const chartBookmarks = useMemo(
    () => bookmarks.filter(b => chartEnabledMap[b.id] !== false),
    [bookmarks, chartEnabledMap],
  );

  // Phase 80 fix: per-bookmark MG/EG entry eval + clock-diff metrics.
  // Without this, bookmark rows in the Stats subtab tables permanently render with
  // eval_n=0 / "low" / "0 games" because buildBookmarkRows hardcoded those fields.
  const bookmarkMetricsRequest = useMemo(
    () =>
      chartBookmarks.map((b) => ({
        target_hash: b.target_hash,
        match_side: resolveMatchSide(b.match_side, (b.color ?? 'white') as Color),
        color: b.color,
      })),
    [chartBookmarks],
  );
  const { data: bookmarkPhaseEntryData } = useBookmarkPhaseEntryMetrics(
    bookmarkMetricsRequest,
    {
      recency: debouncedFilters.recency,
      customRange: debouncedFilters.customRange,
      timeControls: debouncedFilters.timeControls,
      platforms: debouncedFilters.platforms,
      rated: debouncedFilters.rated,
      opponentType: debouncedFilters.opponentType,
      opponentStrength: debouncedFilters.opponentStrength,
    },
  );
  const bookmarkPhaseEntryByHash = useMemo(() => {
    const map = new Map<string, NonNullable<typeof bookmarkPhaseEntryData>['items'][number]>();
    for (const item of bookmarkPhaseEntryData?.items ?? []) {
      map.set(item.target_hash, item);
    }
    return map;
  }, [bookmarkPhaseEntryData]);

  const timeSeriesRequest: TimeSeriesRequest | null = useMemo(() => {
    if (chartBookmarks.length === 0) return null;
    return {
      bookmarks: chartBookmarks.map((b) => ({
        bookmark_id: b.id,
        target_hash: b.target_hash,
        match_side: resolveMatchSide(b.match_side, (b.color ?? 'white') as Color),
        color: b.color,
      })),
      time_control: debouncedFilters.timeControls,
      platform: debouncedFilters.platforms,
      rated: debouncedFilters.rated,
      opponent_type: debouncedFilters.opponentType,
      ...rangeToQueryParams(debouncedFilters.opponentStrength),
      // D-19 amendment: recency now flows as resolved date bounds (from_date/to_date)
      // so the bookmark card WDL bar, game count, and Score % respond to the filter.
      ...dateRangeToWireParams(resolveDateRange(debouncedFilters)),
    };
  }, [chartBookmarks, debouncedFilters]);

  const { data: tsData } = useTimeSeries(timeSeriesRequest);

  // Derive WDL stats per bookmark using aggregate fields (not rolling sub-counts)
  const wdlStatsMap = useMemo(() => {
    const map: Record<number, WdlStatsRow> = {};
    for (const s of tsData?.series ?? []) {
      map[s.bookmark_id] = {
        wins: s.total_wins,
        draws: s.total_draws,
        losses: s.total_losses,
        total: s.total_games,
        last_played_at: s.last_played_at ?? null,
      };
    }
    return map;
  }, [tsData]);

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

  // ── Desktop sidebar panel content ───────────────────────────────────────────

  const desktopFilterPanelContent = (
    <div className="p-3 space-y-3">
      {/* Piece filter — staged: updates localFilters draft only (committed on Apply) */}
      <div className="space-y-3">
        <div>
          <div className="mb-1 flex items-center gap-1">
            <p className="text-sm text-muted-foreground">Piece filter</p>
            <InfoPopover ariaLabel="Piece filter info" testId="piece-filter-info" side="top">
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
            data-testid="filter-piece-filter"
          >
            <ToggleGroupItem value="mine" className="flex-1 text-sm" data-testid="filter-piece-filter-mine">Mine</ToggleGroupItem>
            <ToggleGroupItem value="opponent" className="flex-1 text-sm" data-testid="filter-piece-filter-opponent">Opponent</ToggleGroupItem>
            <ToggleGroupItem value="both" className="flex-1 text-sm" data-testid="filter-piece-filter-both">Both</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <div className="border-t border-border/20" />
      {/* FilterPanel — reads/writes localFilters (draft). Apply is handled by onApply.
          'playedAs' is omitted: Openings uses the dedicated white/black color button
          (no "either" option) above, so the tri-state Played-as belongs to Library only. */}
      <FilterPanel
        filters={localFilters}
        onChange={setLocalFilters}
        visibleFilters={['timeControl', 'platform', 'opponent', 'opponentStrength', 'rated', 'recency']}
        hideReset
      />
    </div>
  );

  // Pinned filter-panel footer — Reset/Apply stays visible below the scrolling
  // filters (mirrors the mobile drawer's pinned footer).
  const desktopFilterPanelFooter = (
    <div className="px-3 pb-3">
      <FilterActions
        onReset={() => setLocalFilters(resetFilterState(localFilters))}
        onApply={handleDesktopFiltersApply}
      />
    </div>
  );

  const desktopBookmarkPanelContent = (
    <div className="p-3">
      <PositionBookmarkList
        bookmarks={bookmarks}
        onReorder={handleReorder}
        onLoad={handleLoadBookmarkFromDesktopSidebar}
        chartEnabledMap={chartEnabledMap}
        onChartEnabledChange={handleChartEnabledChange}
      />
    </div>
  );

  // Pinned panel footer — Suggest (secondary, left) + Save (primary, right),
  // mirroring the mobile drawer footer. Stays visible below the scrolling list.
  const desktopBookmarkPanelFooter = (
    <div className="border-t border-border/40 p-3">
      <div className="flex items-center gap-2">
        <Button
          size="lg"
          variant="brand-outline"
          className="flex-1"
          onClick={() => setSuggestionsOpen(true)}
          data-testid="btn-suggest-bookmarks"
        >
          <Sparkles className="h-4 w-4" />
          Suggest
        </Button>
        <Button
          size="lg"
          className="flex-1"
          onClick={openBookmarkDialog}
          data-testid="btn-bookmark"
        >
          <Save className="h-4 w-4" />
          Save
        </Button>
      </div>
    </div>
  );

  // ── Tab content ─────────────────────────────────────────────────────────────

  const hasNoGames = gameCount !== null && gameCount === 0;
  const gamesData = gamesQuery.data;
  const filtersMatchNothing = gamesData !== undefined && gamesData.matched_count === 0 && !hasNoGames;

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
        <SidebarLayout
          breakpoint="lg"
          panels={[
            {
              id: 'filters',
              label: 'Filters',
              icon: <SlidersHorizontal className="h-5 w-5" />,
              content: desktopFilterPanelContent,
              footer: desktopFilterPanelFooter,
              notificationDot: showFiltersHint ? (
                <span className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5" data-testid="filters-notification-dot">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                </span>
              ) : isFiltersModified ? (
                <span
                  className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5"
                  data-testid="filters-modified-dot"
                  aria-hidden="true"
                >
                  {isFiltersPulsing && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-brown opacity-75" />
                  )}
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-brown" />
                </span>
              ) : undefined,
            },
            {
              id: 'bookmarks',
              label: 'Bookmarks',
              icon: <BookMarked className="h-5 w-5" />,
              content: desktopBookmarkPanelContent,
              footer: desktopBookmarkPanelFooter,
              headerExtra: (
                <InfoPopover ariaLabel="Opening bookmarks info" testId="position-bookmarks-info" side="top">
                  <div className="space-y-2">
                    <p>
                      Save the current position on the chess board as an opening bookmark.
                      Bookmarked openings appear in the Stats tab, showing your win/draw/loss breakdown and win rate over time for each bookmark.
                    </p>
                    <p>
                      Each bookmark has a Piece filter setting (Mine/Opponent/Both) that controls how positions are matched. You can change the Piece filter directly on each bookmark card.
                    </p>
                    <p>
                      Use the chart toggle on each bookmark to include or exclude it from the Bookmarked Openings charts.
                    </p>
                  </div>
                </InfoPopover>
              ),
              notificationDot: showBookmarksHint ? (
                <span className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5" data-testid="bookmarks-notification-dot">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                </span>
              ) : undefined,
            },
          ] satisfies SidebarPanelConfig[]}
          activePanel={sidebar.sidebarOpen}
          onActivePanelChange={handleDesktopSidebarOpenChange}
          stripExtra={
            <>
              {showAnalyzeButton && (
                <Tooltip content="Analyze position" side="right">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleAnalyzePosition}
                    aria-label="Analyze position"
                    data-testid="sidebar-strip-btn-analyze"
                  >
                    <Search className="h-5 w-5" />
                  </Button>
                </Tooltip>
              )}
              <Tooltip content={`Played as: ${filters.color === 'white' ? 'White' : 'Black'}`} side="right">
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative"
                  onClick={() => {
                    const next = filters.color === 'white' ? 'black' : 'white';
                    setFilters(prev => ({ ...prev, color: next as Color }));
                    setBoardFlipped(next === 'black');
                    sidebar.dismissPlayedAsHint();
                  }}
                  aria-label={`Switch to ${filters.color === 'white' ? 'black' : 'white'}`}
                  data-testid="sidebar-strip-btn-color"
                >
                  <span className={`inline-block h-3.5 w-3.5 rounded-xs border border-muted-foreground ${filters.color === 'white' ? 'bg-white' : 'bg-zinc-900'}`} />
                  {showPlayedAsHint && (
                    <span className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5" data-testid="played-as-notification-dot">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                    </span>
                  )}
                </Button>
              </Tooltip>
            </>
          }
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
          </SidebarLayout>
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
          {(activeTab === 'explorer' || activeTab === 'games') && (
            <>
              <div className="flex items-stretch gap-1 px-1">
                {/* Cap the board column at the board's max render width (400px, the
                    ChessBoard default maxWidth — same value the desktop container uses).
                    Without this, `flex-1` stretched the column past the (capped) board on
                    tablet/narrow-desktop widths below `lg`, so BoardControls rendered wider
                    than the board and the settings column was pushed far to the right. */}
                <div className="flex-1 min-w-0 max-w-[400px] flex flex-col gap-1">
                  {/* Same board-only wheel scoping as the desktop layout above. Both
                      layouts stay mounted (one is CSS-hidden), hence a ref each. */}
                  <div ref={mobileBoardRef}>
                    <ChessBoard
                      position={chess.position}
                      onPieceDrop={chess.makeMove}
                      flipped={boardFlipped}
                      lastMove={chess.lastMove}
                      arrows={boardArrows}
                    />
                  </div>
                  {/* Board controls aligned to chessboard width (excludes settings column) */}
                  <BoardControls
                    onBack={chess.goBack}
                    onForward={chess.goForward}
                    onReset={() => { chess.reset(); setGamesOffset(0); }}
                    onFlip={() => setBoardFlipped((f) => !f)}
                    canGoBack={chess.currentPly > 0}
                    canGoForward={chess.currentPly < chess.moveHistory.length}
                  />
                </div>
                {/* Settings column: stacked 44px buttons — filters, played-as, bookmarks,
                    analyze (Moves + Games subtabs), info */}
                <div className="flex flex-col gap-1 w-11" data-testid="openings-mobile-settings-column">
                  <Tooltip content="Open filters" side="left">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 shrink-0 bg-toggle-active text-toggle-active-foreground hover:bg-toggle-active/80 relative"
                      onClick={openFilterSidebar}
                      data-testid="subnav-filter-button"
                      aria-label="Open filters"
                    >
                      <SlidersHorizontal className="h-4 w-4" />
                      {mobileFiltersDot}
                    </Button>
                  </Tooltip>
                  <Tooltip content={`Playing as ${filters.color}`} side="left">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="relative h-11 w-11 shrink-0 !bg-toggle-active text-toggle-active-foreground hover:!bg-toggle-active"
                      onClick={() => {
                        const newColor: Color = filters.color === 'white' ? 'black' : 'white';
                        // Change color without dismissing the filters hint — only the
                        // Played-as hint advances when the color toggle is used.
                        setFilters({ ...filters, color: newColor });
                        setGamesOffset(0);
                        setBoardFlipped(newColor === 'black');
                        sidebar.dismissPlayedAsHint();
                        if (activeTab !== 'explorer' && activeTab !== 'games') navigate('/openings/explorer');
                      }}
                      data-testid="btn-toggle-played-as"
                      aria-label={`Playing as ${filters.color}, tap to switch`}
                    >
                      <span className={`inline-block h-4 w-4 rounded-xs border border-muted-foreground ${filters.color === 'white' ? 'bg-white' : 'bg-zinc-900'}`} />
                      {showPlayedAsHint && (
                        <span
                          className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5"
                          data-testid="played-as-notification-dot-mobile"
                        >
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                        </span>
                      )}
                    </Button>
                  </Tooltip>
                  <Tooltip content="Open bookmarks" side="left">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 shrink-0 bg-toggle-active text-toggle-active-foreground hover:bg-toggle-active/80 relative"
                      onClick={openBookmarkSidebar}
                      data-testid="btn-open-bookmark-sidebar"
                      aria-label="Open bookmarks"
                    >
                      <BookMarked className="h-4 w-4" />
                      {showBookmarksHint && (
                        <span
                          className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5"
                          data-testid="bookmarks-notification-dot-mobile"
                        >
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                        </span>
                      )}
                    </Button>
                  </Tooltip>
                  {showAnalyzeButton && (
                    <Tooltip content="Analyze position" side="left">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-11 w-11 shrink-0 bg-toggle-active text-toggle-active-foreground hover:bg-toggle-active/80"
                        onClick={handleAnalyzePosition}
                        data-testid="btn-analyze-position-mobile"
                        aria-label="Analyze position"
                      >
                        <Search className="h-4 w-4" />
                      </Button>
                    </Tooltip>
                  )}
                  <div className="flex h-11 w-11 items-center justify-center">
                    <InfoPopover ariaLabel="Chessboard info" testId="chessboard-info-mobile" side="left">
                      <ChessboardInfoCopy />
                    </InfoPopover>
                  </div>
                </div>
              </div>
              {/* Opening name line (always visible on Moves/Games subtabs) */}
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
            </>
          )}

          {/* Filter sidebar (D-04, D-05, D-06, D-10, D-12) */}
          <MobileFilterDrawer
            open={sidebar.filterSidebarOpen}
            onOpenChange={handleFilterSidebarOpenChange}
            title="Filters"
            contentTestId="drawer-filter-sidebar"
            closeTestId="btn-close-filter-sidebar"
            bodyClassName="space-y-4"
            footer={
              <FilterActions
                onReset={() => setLocalFilters(resetFilterState(localFilters))}
                onApply={handleMobileFiltersApply}
              />
            }
          >
            {/* Piece filter — spans full drawer width. Played-as is intentionally NOT here:
                it's always accessible via btn-toggle-played-as in the sticky mobile header. */}
            <div>
              <div className="mb-1 flex items-center gap-1">
                <p className="text-sm text-muted-foreground">Piece filter</p>
                <InfoPopover ariaLabel="Piece filter info" testId="piece-filter-info-sidebar" side="top">
                  Use the option "Mine" to find games with a specific formation (e.g. the London System) regardless of the opponent's moves. "Mine" matches only your pieces, "Opponent" only theirs, and "Both" requires an exact match of all pieces. The Moves tab always uses "Both".
                </InfoPopover>
              </div>
              <ToggleGroup
                type="single"
                value={localFilters.matchSide}
                onValueChange={(v) => {
                  if (!v) return;
                  setLocalFilters(prev => ({ ...prev, matchSide: v as MatchSide }));
                }}
                variant="outline"
                size="sm"
                data-testid="filter-piece-filter-sidebar"
                className="w-full"
              >
                <ToggleGroupItem value="mine" data-testid="filter-piece-filter-mine-sidebar" className="flex-1 min-h-11 text-sm">Mine</ToggleGroupItem>
                <ToggleGroupItem value="opponent" data-testid="filter-piece-filter-opponent-sidebar" className="flex-1 min-h-11 text-sm">Opponent</ToggleGroupItem>
                <ToggleGroupItem value="both" data-testid="filter-piece-filter-both-sidebar" className="flex-1 min-h-11 text-sm">Both</ToggleGroupItem>
              </ToggleGroup>
            </div>

            {/* Remaining filters — 'playedAs' omitted (Openings uses the dedicated
                white/black color button above, no "either" option). */}
            <FilterPanel
              filters={localFilters}
              onChange={setLocalFilters}
              visibleFilters={['timeControl', 'platform', 'opponent', 'opponentStrength', 'rated', 'recency']}
              hideReset
            />
          </MobileFilterDrawer>

          {/* Bookmark sidebar (D-04, D-05, D-06, D-13, D-14) */}
          <MobileFilterDrawer
            open={sidebar.bookmarkSidebarOpen}
            onOpenChange={handleBookmarkSidebarOpenChange}
            title="Opening Bookmarks"
            titleAccessory={
              <InfoPopover ariaLabel="Opening bookmarks info" testId="position-bookmarks-info-sidebar" side="top">
                <div className="space-y-2">
                  <p>
                    Save the current position on the chess board as an opening bookmark.
                    Bookmarked openings appear in the Stats tab, showing your win/draw/loss breakdown and win rate over time for each bookmark.
                  </p>
                  <p>
                    Each bookmark has a Piece filter setting (Mine/Opponent/Both) that controls how positions are matched. You can change the Piece filter directly on each bookmark card.
                  </p>
                  <p>
                    Use the chart toggle on each bookmark to include or exclude it from the Bookmarked Openings charts.
                  </p>
                </div>
              </InfoPopover>
            }
            closeLabel="Close bookmarks"
            contentTestId="drawer-bookmark-sidebar"
            closeTestId="btn-close-bookmark-sidebar"
            footer={
              <div className="pt-2 border-t border-border/40">
                <div className="flex gap-2">
                  <Button
                    size="lg"
                    variant="brand-outline"
                    className="flex-1"
                    onClick={() => setSuggestionsOpen(true)}
                    data-testid="btn-suggest-bookmarks-sidebar"
                  >
                    <Sparkles className="h-4 w-4" />
                    Suggest
                  </Button>
                  <Button
                    size="lg"
                    className="flex-1"
                    onClick={openBookmarkDialog}
                    data-testid="btn-bookmark-sidebar"
                  >
                    <Save className="h-4 w-4" />
                    Save
                  </Button>
                </div>
              </div>
            }
          >
            <PositionBookmarkList
              bookmarks={localBookmarks}
              onReorder={handleReorder}
              onLoad={handleLoadBookmarkFromSidebar}
              chartEnabledMap={localChartEnabled}
              onChartEnabledChange={handleLocalChartEnabledChange}
              onMatchSideChange={handleLocalMatchSideChange}
            />
          </MobileFilterDrawer>

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
