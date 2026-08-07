import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { pgnToSanArray } from '@/lib/pgn';
import { useReorderPositionBookmarks } from '@/hooks/usePositionBookmarks';
import type { FilterState } from '@/components/filters/FilterPanel';
import type { MatchSide } from '@/types/api';
import type { PositionBookmarkResponse } from '@/types/position_bookmarks';
import type { OpeningWDL, MostPlayedOpeningsResponse } from '@/types/stats';
import type { OpeningInsightFinding } from '@/types/insights';
import type { HighlightedMove } from './useDeepLinkHighlight';

type ChessLike = {
  loadMoves: (sans: string[]) => void;
};

type SetFilters = (next: FilterState | ((prev: FilterState) => FilterState)) => void;

type UseOpeningsHandlersParams = {
  chess: ChessLike;
  navigate: ReturnType<typeof useNavigate>;
  activeTab: 'explorer' | 'games' | 'stats' | 'insights';
  setBoardFlipped: (flipped: boolean) => void;
  setFilters: SetFilters;
  setHighlightedMove: (m: HighlightedMove | null) => void;
  mostPlayedData: MostPlayedOpeningsResponse | undefined;
};

type OpeningsNavHandlers = {
  handleOpenChartBookmarkGames: (bookmark: PositionBookmarkResponse) => void;
  handleOpenGames: (pgn: string, color: 'white' | 'black') => void;
  handleOpenMoves: (opening: OpeningWDL, color: 'white' | 'black') => void;
  handleOpenFinding: (finding: OpeningInsightFinding) => void;
  handleOpenFindingGames: (finding: OpeningInsightFinding) => void;
  handleLoadBookmark: (bkm: PositionBookmarkResponse) => void;
  handleReorder: (orderedIds: number[]) => void;
};

/**
 * Bundles the deep-link / open-from-{X} navigation callbacks used by
 * StatsTab, InsightsTab, and the bookmark sidebars. All handlers preserve the
 * original OpeningsPage behavior exactly:
 *  - mutate the chess board (loadMoves), update boardFlipped + filters, then
 *    navigate to the appropriate subtab and scroll to top.
 *  - handleOpenFinding additionally sets the deep-link highlight BEFORE
 *    navigation so MoveExplorer paints with the highlight on first render.
 */
export function useOpeningsHandlers(params: UseOpeningsHandlersParams): OpeningsNavHandlers {
  const {
    chess,
    navigate,
    activeTab,
    setBoardFlipped,
    setFilters,
    setHighlightedMove,
    mostPlayedData,
  } = params;
  const reorder = useReorderPositionBookmarks();

  const handleOpenChartBookmarkGames = useCallback((bookmark: PositionBookmarkResponse) => {
    if (bookmark.moves.length > 0) {
      // Real bookmark — load its moves
      chess.loadMoves(bookmark.moves);
    } else if (mostPlayedData) {
      // Default chart entry — find PGN from most-played data
      const allOpenings = [...(mostPlayedData.white ?? []), ...(mostPlayedData.black ?? [])];
      const opening = allOpenings.find(o => o.full_hash === bookmark.target_hash);
      if (opening) {
        chess.loadMoves(pgnToSanArray(opening.pgn));
      }
    }
    const color = bookmark.color ?? 'white';
    setBoardFlipped(color === 'black');
    setFilters(prev => ({ ...prev, color, matchSide: bookmark.match_side }));
    navigate('/openings/games');
    window.scrollTo({ top: 0 });
  }, [chess, navigate, mostPlayedData, setFilters, setBoardFlipped]);

  const handleOpenGames = useCallback((pgn: string, color: 'white' | 'black') => {
    chess.loadMoves(pgnToSanArray(pgn));
    setBoardFlipped(color === 'black');
    setFilters(prev => ({ ...prev, color, matchSide: 'both' as MatchSide }));
    navigate('/openings/games');
    window.scrollTo({ top: 0 });
  }, [chess, navigate, setFilters, setBoardFlipped]);

  const handleOpenMoves = useCallback((opening: OpeningWDL, color: 'white' | 'black') => {
    chess.loadMoves(pgnToSanArray(opening.pgn));
    setBoardFlipped(color === 'black');
    setFilters(prev => ({ ...prev, color, matchSide: 'both' as MatchSide }));
    navigate('/openings/explorer');
    window.scrollTo({ top: 0 });
  }, [chess, navigate, setFilters, setBoardFlipped]);

  const handleOpenFinding = useCallback(
    (finding: OpeningInsightFinding) => {
      chess.loadMoves(finding.entry_san_sequence);
      // Set the deep-link highlight BEFORE navigation so MoveExplorer renders
      // with the highlight on its first paint after the route change.
      setHighlightedMove({ san: finding.candidate_move_san });
      setBoardFlipped(finding.color === 'black');
      setFilters((prev) => ({
        ...prev,
        color: finding.color,
        matchSide: 'both' as MatchSide,
      }));
      navigate('/openings/explorer');
      window.scrollTo({ top: 0 });
    },
    [chess, navigate, setFilters, setHighlightedMove, setBoardFlipped],
  );

  const handleOpenFindingGames = useCallback(
    (finding: OpeningInsightFinding) => {
      chess.loadMoves([...finding.entry_san_sequence, finding.candidate_move_san]);
      setBoardFlipped(finding.color === 'black');
      setFilters((prev) => ({
        ...prev,
        color: finding.color,
        matchSide: 'both' as MatchSide,
      }));
      navigate('/openings/games');
      window.scrollTo({ top: 0 });
    },
    [chess, navigate, setFilters, setBoardFlipped],
  );

  const handleLoadBookmark = useCallback((bkm: PositionBookmarkResponse) => {
    chess.loadMoves(bkm.moves);
    setBoardFlipped(bkm.is_flipped ?? false);
    setFilters(prev => ({ ...prev, color: bkm.color ?? 'white', matchSide: bkm.match_side }));
    if (activeTab !== 'explorer' && activeTab !== 'games') navigate('/openings/explorer');
    window.scrollTo({ top: 0 });
  }, [chess, setFilters, activeTab, navigate, setBoardFlipped]);

  const handleReorder = useCallback((orderedIds: number[]) => {
    reorder.mutate(orderedIds);
  }, [reorder]);

  return {
    handleOpenChartBookmarkGames,
    handleOpenGames,
    handleOpenMoves,
    handleOpenFinding,
    handleOpenFindingGames,
    handleLoadBookmark,
    handleReorder,
  };
}
