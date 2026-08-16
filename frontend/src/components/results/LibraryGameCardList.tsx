import { LibraryGameCard } from '@/components/results/LibraryGameCard';
import { Pagination } from '@/components/results/Pagination';
import { EvalCoverageBadge } from '@/components/library/EvalCoverageBadge';
import type { GameFlawCard } from '@/types/library';

// Page size matches the API default (limit=20 per UI-SPEC §Pagination).
const PAGE_SIZE = 20;

interface LibraryGameCardListProps {
  games: GameFlawCard[];
  matchedCount: number;
  offset: number;
  limit: number;
  onPageChange: (offset: number) => void;
  /** Whether the current user is a guest — passed to EvalCoverageBadge for CTA gating. */
  isGuest: boolean;
  /** Games with engine analysis — passed to EvalCoverageBadge. */
  analyzedN: number;
  /** Total games in scope — passed to EvalCoverageBadge. */
  totalN: number;
  /** Whether the eval-coverage query failed — passed to EvalCoverageBadge. */
  isCoverageError: boolean;
  /** Game ids with a tier-1 analyze request in flight (lifted to GamesTab). */
  inFlightIds: ReadonlySet<number>;
  /** Report a card's in-flight transition up to GamesTab (drives list polling). */
  onInFlightChange: (gameId: number, inFlight: boolean) => void;
}

/**
 * Paginated list of LibraryGameCard for the Library Games subtab.
 *
 * Renders a matched-count row ("{matchedCount} games matched"), the card stack,
 * and the shared Pagination control. Page changes convert the 1-based Pagination
 * page number back to an offset and scroll the list container into view.
 *
 * The row deliberately carries NO "of {total}" denominator: the account-wide game
 * total belongs to EvalCoverageBadge on the right of the same row, which is
 * account-scoped by design (global backlog progress, filter-independent). Mixing a
 * filter-scoped numerator with an account-scoped denominator on the left made the
 * two halves of the row silently answer different questions. Matches the Flaws
 * tab's "{n} flaws matched" row.
 *
 * The empty-games case renders nothing in the card stack — GamesTab owns the
 * full empty-state UI (no-games-imported, no-matches, no-analyzed-games copy).
 */
export function LibraryGameCardList({
  games,
  matchedCount,
  offset,
  limit,
  onPageChange,
  isGuest,
  analyzedN,
  totalN,
  isCoverageError,
  inFlightIds,
  onInFlightChange,
}: LibraryGameCardListProps) {
  // Derive pagination state; use PAGE_SIZE as the canonical page size constant.
  const pageSize = limit > 0 ? limit : PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(matchedCount / pageSize));
  const currentPage = Math.floor(offset / pageSize) + 1;

  // Convert 1-based page number (from Pagination) back to offset, call parent, scroll.
  const handlePageChange = (page: number) => {
    const newOffset = (page - 1) * pageSize;
    onPageChange(newOffset);
    // Scroll the library list into view — uses the LIBRARY testid, not "game-card-list"
    // (distinct scroll target from GameCardList per UI-SPEC §Pagination).
    document
      .querySelector('[data-testid="library-game-card-list"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <section aria-label="Game results" data-testid="library-game-card-list" className="space-y-3">
      {/* Matched-count row with coverage badge top-right */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {matchedCount} game{matchedCount === 1 ? '' : 's'} matched
        </p>
        <EvalCoverageBadge
          analyzedN={analyzedN}
          totalN={totalN}
          isGuest={isGuest}
          isCoverageError={isCoverageError}
        />
      </div>

      {/* Card stack — 2-column grid on md+; analyzed cards span full width, unanalyzed half-width.
          Wrapping div per card carries the span class so LibraryGameCard stays layout-agnostic. */}
      {games.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {games.map((game) => (
            <div
              key={game.game_id}
              className={game.analysis_state === 'analyzed' ? 'md:col-span-2' : 'md:col-span-1'}
            >
              <LibraryGameCard
                game={game}
                isInFlight={inFlightIds.has(game.game_id)}
                onInFlightChange={onInFlightChange}
              />
            </div>
          ))}
        </div>
      )}

      {/* Pagination row */}
      <Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={handlePageChange}
      />
    </section>
  );
}
