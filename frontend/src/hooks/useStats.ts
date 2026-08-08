import { useQuery } from '@tanstack/react-query';
import { statsApi } from '@/api/client';
import type { Platform, TimeControl, OpponentType, OpponentStrengthRange } from '@/types/api';
import { ANY_RANGE } from '@/lib/opponentStrength';
import { rangeToQueryParams } from '@/lib/opponentStrength';
import { resolveDateRange, dateRangeToWireParams } from '@/lib/recency';
import { DEFAULT_FILTERS } from '@/components/filters/FilterPanel';
import type { FilterState } from '@/components/filters/FilterPanel';
import type { BookmarkPhaseEntryQuery, BookmarkPhaseEntryResponse } from '@/types/stats';

export function useRatingHistory(
  filters: FilterState,
  platforms: Platform[] | null,
  opponentType: OpponentType,
  opponentStrength: OpponentStrengthRange,
) {
  const dateParams = dateRangeToWireParams(resolveDateRange(filters));
  // safe: length === 1 check guarantees index 0 exists
  const platform = platforms && platforms.length === 1 ? platforms[0]! : null;
  return useQuery({
    queryKey: ['ratingHistory', dateParams.from_date ?? null, dateParams.to_date ?? null, platform, opponentType, opponentStrength.min, opponentStrength.max],
    queryFn: () => statsApi.getRatingHistory(dateParams, platform, opponentType, opponentStrength),
  });
}

export function useGlobalStats(
  filters: FilterState,
  platforms: Platform[] | null,
  opponentType: OpponentType,
  opponentStrength: OpponentStrengthRange,
) {
  const dateParams = dateRangeToWireParams(resolveDateRange(filters));
  // safe: length === 1 check guarantees index 0 exists
  const platform = platforms && platforms.length === 1 ? platforms[0]! : null;
  const color = filters.playedAs === 'either' ? null : filters.playedAs;
  return useQuery({
    queryKey: ['globalStats', dateParams.from_date ?? null, dateParams.to_date ?? null, platform, opponentType, opponentStrength.min, opponentStrength.max, color],
    queryFn: () => statsApi.getGlobalStats(dateParams, platform, opponentType, opponentStrength, color),
  });
}

export function useMostPlayedOpenings(filters?: {
  recency: FilterState['recency'];
  customRange: FilterState['customRange'];
  timeControls: TimeControl[] | null;
  platforms: Platform[] | null;
  rated: boolean | null;
  opponentType: OpponentType;
  opponentStrength?: OpponentStrengthRange;
}) {
  // Spread DEFAULT_FILTERS as the base (rather than listing every FilterState key
  // by hand) so this construction can never drift from FilterState's shape as new
  // fields are added — the Library-only Pasted-chip field (D-14) stays at its
  // default without being named here; this hook never surfaces that chip.
  const resolvedFilters: FilterState = {
    ...DEFAULT_FILTERS,
    recency: filters?.recency ?? null,
    customRange: filters?.customRange ?? null,
    timeControls: filters?.timeControls ?? null,
    platforms: filters?.platforms ?? null,
    rated: filters?.rated ?? null,
    opponentType: filters?.opponentType ?? 'both',
    opponentStrength: filters?.opponentStrength ?? ANY_RANGE,
  };
  const dateParams = dateRangeToWireParams(resolveDateRange(resolvedFilters));
  const timeControl = filters?.timeControls ?? null;
  const platform = filters?.platforms ?? null;
  const rated = filters?.rated ?? null;
  const opponentType = filters?.opponentType ?? 'both';
  const opponentStrength = filters?.opponentStrength ?? ANY_RANGE;

  return useQuery({
    queryKey: ['mostPlayedOpenings', dateParams.from_date ?? null, dateParams.to_date ?? null, timeControl, platform, rated, opponentType, opponentStrength.min, opponentStrength.max],
    queryFn: () => statsApi.getMostPlayedOpenings({
      from_date: dateParams.from_date,
      to_date: dateParams.to_date,
      time_control: timeControl,
      platform: platform,
      rated: rated,
      opponent_type: opponentType,
      opponent_strength: opponentStrength,
    }),
  });
}

export function useBookmarkPhaseEntryMetrics(
  bookmarks: BookmarkPhaseEntryQuery[],
  filters: {
    recency: FilterState['recency'];
    customRange: FilterState['customRange'];
    timeControls: TimeControl[] | null;
    platforms: Platform[] | null;
    rated: boolean | null;
    opponentType: OpponentType;
    opponentStrength: OpponentStrengthRange;
  },
) {
  // Resolve from the full FilterState shape needed by resolveDateRange. Spread
  // DEFAULT_FILTERS as the base (see useMostPlayedOpenings above) so the
  // Library-only Pasted-chip field (D-14) stays at its default without being
  // named here.
  const resolvedFilters: FilterState = {
    ...DEFAULT_FILTERS,
    recency: filters.recency,
    customRange: filters.customRange,
    timeControls: filters.timeControls,
    platforms: filters.platforms,
    rated: filters.rated,
    opponentType: filters.opponentType,
    opponentStrength: filters.opponentStrength,
  };
  const dateParams = dateRangeToWireParams(resolveDateRange(resolvedFilters));
  const enabled = bookmarks.length > 0;
  // Sort by target_hash to keep query key stable across reorders.
  const hashKey = bookmarks.map(b => `${b.target_hash}:${b.match_side}:${b.color ?? ''}`).sort().join(',');
  const { opponent_gap_min, opponent_gap_max } = rangeToQueryParams(filters.opponentStrength);

  return useQuery<BookmarkPhaseEntryResponse>({
    queryKey: [
      'bookmarkPhaseEntryMetrics',
      hashKey,
      dateParams.from_date ?? null,
      dateParams.to_date ?? null,
      filters.timeControls,
      filters.platforms,
      filters.rated,
      filters.opponentType,
      filters.opponentStrength.min,
      filters.opponentStrength.max,
    ],
    queryFn: () => statsApi.getBookmarkPhaseEntryMetrics({
      bookmarks,
      from_date: dateParams.from_date,
      to_date: dateParams.to_date,
      time_control: filters.timeControls,
      platform: filters.platforms,
      rated: filters.rated,
      opponent_type: filters.opponentType,
      opponent_gap_min,
      opponent_gap_max,
    }),
    enabled,
  });
}
