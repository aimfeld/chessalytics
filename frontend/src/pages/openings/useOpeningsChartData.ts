import { useMemo } from 'react';
import { Chess } from 'chess.js';
import { useBookmarkPhaseEntryMetrics } from '@/hooks/useStats';
import { useTimeSeries } from '@/hooks/usePositionBookmarks';
import { getArrowColor } from '@/lib/arrowColor';
import { rangeToQueryParams } from '@/lib/opponentStrength';
import { resolveDateRange, dateRangeToWireParams } from '@/lib/recency';
import { resolveMatchSide } from '@/types/api';
import type { BoardArrow } from '@/components/board/ChessBoard';
import type { FilterState } from '@/components/filters/FilterPanel';
import type { Color, NextMovesResponse } from '@/types/api';
import type {
  PositionBookmarkResponse,
  TimeSeriesRequest,
  TimeSeriesResponse,
} from '@/types/position_bookmarks';
import type { BookmarkPhaseEntryItem } from '@/types/stats';
import type { WdlStatsRow } from './StatsTab';
import type { HighlightedMove } from './useDeepLinkHighlight';

// localStorage helper for per-bookmark chart-enable toggle (default: enabled).
// Only consumed by chartEnabledMap below — the write side
// (setChartEnabledStorage) stays in Openings.tsx, called by handlers this
// hook doesn't own (handleChartEnabledChange, handleBookmarkSidebarOpenChange).
function getChartEnabled(bookmarkId: number): boolean {
  const stored = localStorage.getItem(`bookmark-chart-enabled-${bookmarkId}`);
  return stored === null ? true : stored === 'true';
}

export type UseOpeningsChartDataParams = {
  bookmarks: PositionBookmarkResponse[];
  /** Unnecessary-by-design dependency (pre-existing react-hooks/exhaustive-deps
   * warning) — bumped by handlers in Openings.tsx to force chartEnabledMap to
   * re-read localStorage after a chart-enable toggle. Must NOT be dropped from
   * the memo's dependency array; the app-wide react-hooks warning count is a
   * hard invariant in both directions. */
  chartToggleVersion: number;
  nextMovesData: NextMovesResponse | undefined;
  position: string;
  hoveredMove: string | null;
  highlightedMove: HighlightedMove | null;
  pulseActive: boolean;
  debouncedFilters: FilterState;
};

export type OpeningsChartData = {
  chartEnabledMap: Record<number, boolean>;
  boardArrows: BoardArrow[];
  chartBookmarks: PositionBookmarkResponse[];
  bookmarkPhaseEntryByHash: Map<string, BookmarkPhaseEntryItem>;
  tsData: TimeSeriesResponse | undefined;
  wdlStatsMap: Record<number, WdlStatsRow>;
};

/**
 * Query-derivation cluster for the Openings page: per-bookmark chart-enable
 * state, board arrows from next-move frequencies, the chart-enabled bookmark
 * subset, per-bookmark phase-entry metrics, and per-bookmark WDL stats from
 * the bookmark time series. Matches useOpeningsHandlers.ts's shape (one typed
 * params object in, one named data interface out).
 */
export function useOpeningsChartData(params: UseOpeningsChartDataParams): OpeningsChartData {
  const {
    bookmarks,
    chartToggleVersion,
    nextMovesData,
    position,
    hoveredMove,
    highlightedMove,
    pulseActive,
    debouncedFilters,
  } = params;

  const chartEnabledMap = useMemo(() => {
    const map: Record<number, boolean> = {};
    for (const b of bookmarks) {
      map[b.id] = getChartEnabled(b.id);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookmarks, chartToggleVersion]);

  // Board arrows derived from next move frequencies. The matching arrow on a
  // deep-link gets isHighlightPulse=true so its <path> pulses briefly. The
  // arrow's COLOR stays whatever getArrowColor returned (score zone) — pulse
  // only modulates opacity. Row tint comes from the score zone too, so a
  // highlighted row pulses through grey alpha levels and lands on the row's
  // natural score-zone color.
  const boardArrows = useMemo(() => {
    if (!nextMovesData?.moves.length) return [];

    const chessInstance = new Chess(position);
    const legalMoves = chessInstance.moves({ verbose: true });
    const moveMap = new Map(legalMoves.map(m => [m.san, { from: m.from, to: m.to }]));

    const moves = nextMovesData.moves;
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
  }, [nextMovesData, position, hoveredMove, highlightedMove, pulseActive]);

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

  return {
    chartEnabledMap,
    boardArrows,
    chartBookmarks,
    bookmarkPhaseEntryByHash,
    tsData,
    wdlStatsMap,
  };
}
