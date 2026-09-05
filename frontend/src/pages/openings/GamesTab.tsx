import { Link } from 'react-router';
import type { UseQueryResult } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { LoadError } from '@/components/ui/load-error';
import { EmptyState } from '@/components/ui/empty-state';
import { NoHumanRatedGamesState } from '@/components/ui/no-human-rated-games-state';
import { PositionResultsPanel } from '@/components/charts/PositionResultsPanel';
import { GameCardList } from '@/components/results/GameCardList';
import type { OpeningsResponse } from '@/types/api';
import type { ReactNode } from 'react';

type GamesTabProps = {
  gamesQuery: UseQueryResult<OpeningsResponse>;
  hasNoGames: boolean;
  filtersMatchNothing: boolean;
  /** SEED-163 2d: true when the Human+Rated defaults alone emptied the population. */
  noHumanRatedGames: boolean;
  gameCount: number | null;
  positionResultsLabel: ReactNode;
  colorIconSquare: ReactNode;
  filterColor: 'white' | 'black';
  gamesOffset: number;
  pageSize: number;
  onPageChange: (offset: number) => void;
  /** Ply of the position shown on the opening board — seeds the Analyze deep-link. */
  analyzePly: number;
};

export function GamesTab({
  gamesQuery,
  hasNoGames,
  filtersMatchNothing,
  noHumanRatedGames,
  gameCount,
  positionResultsLabel,
  colorIconSquare,
  filterColor,
  gamesOffset,
  pageSize,
  onPageChange,
  analyzePly,
}: GamesTabProps) {
  const gamesData = gamesQuery.data;

  return (
    <div className="flex flex-col gap-4">
      {gamesQuery.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <p className="text-muted-foreground">Loading games...</p>
        </div>
      ) : hasNoGames ? (
        <EmptyState
          layout="page"
          title="No games imported yet"
          subtitle="Import your games from chess.com or lichess to start analyzing positions."
          action={
            <Button variant="outline" size="sm" asChild>
              <Link to="/library/import">Import Games</Link>
            </Button>
          }
        />
      ) : filtersMatchNothing ? (
        noHumanRatedGames ? (
          <NoHumanRatedGamesState totalGames={gameCount} />
        ) : (
          <EmptyState
            layout="page"
            title="No games matched"
            subtitle="Try adjusting the time control, opponent, rated, or recency filters."
          />
        )
      ) : gamesQuery.isError ? (
        <LoadError variant="centered" resource="games" />
      ) : gamesData ? (
        <>
          <PositionResultsPanel
            stats={gamesData.stats}
            evalBaselinePawns={gamesData.eval_baseline_pawns}
            filterColor={filterColor}
            label={positionResultsLabel}
            className=""
          />
          <GameCardList
            games={gamesData.games}
            matchedCount={gamesData.matched_count}
            totalGames={gameCount ?? gamesData.stats.total}
            offset={gamesOffset}
            limit={pageSize}
            onPageChange={onPageChange}
            analyzePly={analyzePly}
            hideMatchLabelOnMobile
            matchLabel={(() => {
              const total = gameCount ?? gamesData.stats.total;
              const pct = total > 0 ? (gamesData.matched_count / total * 100).toFixed(1) : '0.0';
              return (
                <>
                  {gamesData.matched_count} of {total} ({pct}%) games played as{' '}
                  <span className="inline-flex items-center gap-1 align-middle">
                    {colorIconSquare}
                    {filterColor}
                  </span>
                  {' '}matched
                </>
              );
            })()}
          />
        </>
      ) : null}
    </div>
  );
}
