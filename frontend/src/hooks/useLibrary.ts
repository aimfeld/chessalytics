import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { libraryApi } from '@/api/client';
import { resolveDateRange, dateRangeToWireParams } from '@/lib/recency';
import type { FilterState } from '@/components/filters/FilterPanel';
import type { FlawTag, TacticLinesResponse } from '@/types/library';
import { isFlawFilterNonDefault } from '@/hooks/useFlawFilterStore';
import type { FlawFilterState } from '@/hooks/useFlawFilterStore';
import type { GameFlawCard } from '@/types/library';
import type { TacticFamily } from '@/lib/tacticComparisonMeta';
import { depthToQueryParams } from '@/lib/tacticDepth';
import { LIBRARY_GAMES_POLL_INTERVAL_MS } from '@/hooks/useEvalCoverage';

// Library queries are similar in cost to endgame queries (GROUP BY on FlawRecords).
// 5 minutes staleTime + no refetch-on-focus prevents redundant DB load
// from alt-tabbing or component re-mounts. Data only changes on new imports.
const LIBRARY_STALE_TIME = 5 * 60 * 1000;

// The wire value of games.platform for a pasted game (backend
// normalization._PASTE_PLATFORM_VALUE). Not part of the frontend `Platform`
// union on purpose — it is never a member of FilterState.platforms, only the
// single-element platform list the 'only' pasted state sends.
const PASTED_PLATFORM = 'pgn';

// Runaway guard (Quick 260714-rj5, T-RJ5-03) for useLibraryGame's live poll:
// stop polling an unanalyzed game after this much wall-clock time.
//
// This is deliberately NOT GamesTab's ANALYZE_INFLIGHT_TIMEOUT_MS (120s). That
// constant bounds only GamesTab's *optimistic* pill; the card there still
// refreshes via a separate UNBOUNDED poll (analyzedCount < totalCount), so the
// library recovers whenever the job lands. This hook is the analysis board's
// ONLY refresh driver, so a 120s cap would strand the board on "Analyzing…"
// for any tier-1 job slower than two minutes — and a job waits on a worker
// leasing it, which can easily exceed that when the fleet is busy or idle.
// Sized instead to comfortably exceed a realistic tier-1 turnaround; it exists
// only to stop a permanently-stuck job (e.g. one that ends `failed` — see the
// deferred item in PLAN.md) from polling forever while the user sits on the page.
export const LIBRARY_GAME_POLL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Pure poll-interval decision for useLibraryGame's `live` mode (Quick 260714-rj5).
 *
 * Returns LIBRARY_GAMES_POLL_INTERVAL_MS while the card is unanalyzed and the
 * stall backstop hasn't tripped yet; `false` (no more polling) once the card
 * is analyzed, when there is no data yet, or once elapsedMs exceeds the
 * backstop. Exported for direct unit testing.
 */
export function libraryGamePollInterval(
  data: GameFlawCard | undefined,
  elapsedMs: number,
): number | false {
  if (data == null) return false;
  if (data.analysis_state !== 'no_engine_analysis') return false;
  if (elapsedMs >= LIBRARY_GAME_POLL_TIMEOUT_MS) return false;
  return LIBRARY_GAMES_POLL_INTERVAL_MS;
}

/**
 * Build shared query params for library endpoints from a FilterState.
 *
 * Mirrors buildEndgameParams from useEndgames.ts but drops color/matchSide
 * (the Games subtab shows all colors) and adds optional severity + tag filters.
 * severity and tag are omitted from the params object entirely when empty.
 *
 * hasGem/hasGreat (FILT-01, Phase 175) mirror rated's conditional-inclusion
 * pattern: included as has_gem/has_great only when true, omitted when false
 * so a default (unfiltered) call sends nothing. Only useLibraryGames passes
 * these — GET /library/games is the only endpoint that accepts them (Plan
 * 01); every other buildLibraryParams caller (flaw-stats, flaw-comparison,
 * tactic-comparison, flaws) omits them by leaving the params at their false
 * default, which is a no-op for those endpoints' param types.
 *
 * include_pasted (Phase 208, D-11/D-12): every Library surface accepts this
 * param, so it is threaded unconditionally here (unlike hasGem/hasGreat,
 * which are Games-tab-only args). Omitted when off, matching the
 * has_gem/has_great convention — this is the ONLY place FilterState.pasted
 * is read on the wire (D-14 containment).
 *
 * The 'only' state (UAT follow-up) does NOT use include_pasted at all: it
 * sends `platform=['pgn']`, which the backend's resolve_library_platforms
 * already honors as an explicit caller selection on every Library surface.
 * `filters.platforms` is deliberately ignored in that state — the chip group
 * shows no platform as active, so sending one would contradict the UI.
 */
export function buildLibraryParams(
  filters: FilterState,
  severity: ('blunder' | 'mistake')[],
  tags: FlawTag[] = [],
  hasGem = false,
  hasGreat = false,
) {
  const dateParams = dateRangeToWireParams(resolveDateRange(filters));
  const pastedOnly = filters.pasted === 'only';
  return {
    time_control: filters.timeControls,
    platform: pastedOnly ? [PASTED_PLATFORM] : filters.platforms,
    ...dateParams,
    rated: filters.rated,
    opponent_type: filters.opponentType,
    opponent_strength: filters.opponentStrength,
    severity: severity.length > 0 ? severity : undefined,
    tag: tags.length > 0 ? tags : undefined,
    color: filters.playedAs === 'either' ? undefined : filters.playedAs,
    has_gem: hasGem ? true : undefined,
    has_great: hasGreat ? true : undefined,
    include_pasted: filters.pasted === 'with' ? true : undefined,
  };
}

/**
 * Fetch the paginated library game archive for the current filter + flaw filter.
 *
 * Accepts a full FlawFilterState (severity + tags) so both filter dimensions are
 * included in the query key and passed to the endpoint (D-04).
 *
 * Query key: ['library-games', params, offset, limit]
 * Both offset and limit are part of the key so page changes trigger a new fetch.
 *
 * @param refetchIntervalMs - when > 0, re-polls at this interval so per-game
 *   analysis_state transitions (no_engine_analysis → analyzed) are picked up
 *   automatically without a page reload. Pass 0 or omit when idle.
 */
export function useLibraryGames(
  filters: FilterState,
  flawFilter: FlawFilterState,
  offset: number,
  limit: number,
  refetchIntervalMs: number = 0,
) {
  // Bug fix: the default flaw filter (severity = blunder+mistake, no tags) used
  // to be sent to GET /library/games, where the backend's severity EXISTS
  // excludes every game without engine analysis — users with only unanalyzed
  // games saw "0 games matched" with no filters set. The default state means
  // "no flaw filtering" on the Games tab (matching the modified-dot logic), so
  // only send severity/tags when the user actively changed the flaw filter.
  const isFiltering = isFlawFilterNonDefault(flawFilter);
  // has_gem/has_great are threaded unconditionally (not gated on isFiltering like
  // severity/tags above): they already default to false, so buildLibraryParams
  // omits them the same way as an inactive filter — no separate gate needed.
  const params = buildLibraryParams(
    filters,
    isFiltering ? flawFilter.severity : [],
    isFiltering ? flawFilter.tags : [],
    flawFilter.hasGem,
    flawFilter.hasGreat,
  );
  // Quick 260620-pza / 260621-sm8: tactic filters on the Games tab (mirrors
  // useLibraryFlaws). Depth + orientation are now independently meaningful, so they
  // are ALWAYS sent — gating them behind a selected family meant a depth-only or
  // orientation-only filter never reached the backend (the bug being fixed). The
  // family group is sent only when ≥1 is selected. The backend treats the
  // all-inclusive default (no family, either, full range) as a no-op.
  // Optional-chained: defensive against partial filter objects (older persisted/mocked
  // state predating the tacticFamilies field), matching isFlawFilterNonDefault.
  const tacticFamily =
    (flawFilter.tacticFamilies?.length ?? 0) > 0 ? flawFilter.tacticFamilies : undefined;
  const tacticOrientation = flawFilter.tacticOrientation ?? 'either';
  const depthParam = depthToQueryParams(flawFilter.tacticDepthMin, flawFilter.tacticDepthMax);
  return useQuery({
    queryKey: ['library-games', params, tacticFamily, tacticOrientation, depthParam, offset, limit],
    queryFn: () =>
      libraryApi.getGames({
        ...params,
        tactic_family: tacticFamily,
        tactic_orientation: tacticOrientation,
        ...depthParam,
        offset,
        limit,
      }),
    staleTime: LIBRARY_STALE_TIME,
    refetchOnWindowFocus: false,
    refetchInterval: refetchIntervalMs > 0 ? refetchIntervalMs : false,
  });
}

/**
 * Fetch the Flaw-Stats panel data for the current filter + flaw filter.
 *
 * Query key: ['library-flaw-stats', params]
 * No offset — the stats panel aggregates over all matching games, not just
 * the current page.
 */
export function useLibraryFlawStats(
  filters: FilterState,
  flawFilter: FlawFilterState,
) {
  const params = buildLibraryParams(filters, flawFilter.severity, flawFilter.tags);
  return useQuery({
    queryKey: ['library-flaw-stats', params],
    queryFn: () => libraryApi.getFlawStats(params),
    staleTime: LIBRARY_STALE_TIME,
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch the 15-bullet flaw comparison for the current filter + flaw filter.
 *
 * Query key: ['library-flaw-comparison', params]
 * Independent of ['library-flaw-stats', params] — separate endpoint, separate type.
 * Same buildLibraryParams + LIBRARY_STALE_TIME + refetchOnWindowFocus:false as
 * useLibraryFlawStats (exact analog).
 */
export function useLibraryFlawComparison(
  filters: FilterState,
  flawFilter: FlawFilterState,
) {
  const params = buildLibraryParams(filters, flawFilter.severity, flawFilter.tags);
  return useQuery({
    queryKey: ['library-flaw-comparison', params],
    queryFn: () => libraryApi.getFlawComparison(params),
    staleTime: LIBRARY_STALE_TIME,
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch the 6-family tactic-motif comparison for the current filter + flaw filter.
 *
 * Self-fetch for TacticComparisonGrid (Phase 126). Mirrors useLibraryFlawComparison
 * exactly but adds the tactic_families dimension to the query key so filter changes
 * trigger a re-fetch.
 *
 * Query key: ['library-tactic-comparison', params, tacticFamilies]
 * Do NOT add a manual Sentry.captureException — TanStack Query errors are captured
 * globally (CLAUDE.md).
 */
export function useTacticComparison(
  filters: FilterState,
  flawFilter: FlawFilterState,
  tacticFamilies: TacticFamily[],
) {
  const params = buildLibraryParams(filters, flawFilter.severity, flawFilter.tags);
  return useQuery({
    queryKey: ['library-tactic-comparison', params, tacticFamilies],
    queryFn: () =>
      libraryApi.getTacticComparison({
        ...params,
        tactic_families: tacticFamilies.length > 0 ? tacticFamilies : undefined,
      }),
    staleTime: LIBRARY_STALE_TIME,
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch a single game by id for the "View game" modal.
 *
 * Query key: ['library-game', gameId]
 * Disabled when gameId is null — no fetch fires until the modal opens.
 * Returns the full GameFlawCard for rendering in LibraryGameCard.
 *
 * Quick 260702-mnd (D-3): the single-game card is now filter-independent — its
 * content (which tactic + context tags render) no longer changes with the active
 * flaw filter (the backend endpoint no longer accepts filter params at all; the
 * filter only affects which games are SELECTED on the Games list). Dropped the
 * flawFilter param and every derived query param.
 *
 * Quick 260714-rj5: opt-in `live` polling. When `live` is true and the card is
 * unanalyzed, refetches every LIBRARY_GAMES_POLL_INTERVAL_MS (via
 * libraryGamePollInterval) until analysis lands or the stall backstop trips —
 * this is what lets the Analysis game-mode board pick up a completed eval job
 * in place, no navigation/remount. `startedAtRef` seeds once per gameId so the
 * backstop measures from this hook's mount, not from a shared clock.
 * `refetchOnWindowFocus: true` under `live` catches a backgrounded tab up on
 * focus; the default (non-live) "View game" modal path is untouched.
 */
export function useLibraryGame(
  gameId: number | null,
  options?: { live?: boolean },
): ReturnType<typeof useQuery<GameFlawCard>> {
  const live = options?.live ?? false;
  // Date.now() is an impure call and must not run during render (react-hooks
  // purity rule) — seed/reset the ref in an effect instead of inline during
  // the render pass. refetchInterval is only invoked by TanStack Query's
  // internal scheduler (async, always after mount), so the effect has
  // already run by the time it reads startedAtRef.
  const startedAtRef = useRef<number | null>(null);
  useEffect(() => {
    startedAtRef.current = Date.now();
  }, [gameId]);

  return useQuery<GameFlawCard>({
    queryKey: ['library-game', gameId],
    queryFn: () => libraryApi.getGame(gameId!),
    enabled: gameId !== null,
    staleTime: live ? 0 : LIBRARY_STALE_TIME,
    refetchOnWindowFocus: live,
    refetchInterval: live
      ? (query) =>
          libraryGamePollInterval(query.state.data, Date.now() - (startedAtRef.current ?? Date.now()))
      : false,
  });
}

/**
 * Lazy-fetch the tactic PV walk for a specific flaw (game_id + ply).
 *
 * Query key: ['tactic-lines', gameId, ply]
 * Enabled only when `enabled` is true AND gameId/ply are non-null — gates the
 * network request until the TacticLineExplorer opens (lazy fetch on open).
 * Phase 135, Plan 03 — consumed by TacticLineExplorer.
 */
export function useTacticLines(
  gameId: number | null,
  ply: number | null,
  enabled: boolean,
): ReturnType<typeof useQuery<TacticLinesResponse>> {
  return useQuery<TacticLinesResponse>({
    queryKey: ['tactic-lines', gameId, ply],
    queryFn: () => libraryApi.getTacticLines(gameId!, ply!),
    enabled: enabled && gameId != null && ply != null,
    staleTime: LIBRARY_STALE_TIME,
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch the paginated per-flaw list for the current filter + flaw filter.
 *
 * Query key: ['library-flaws', params, tacticFamily, tacticOrientation, depthParam, offset, limit]
 * Both offset and limit are part of the key so page changes trigger a new fetch.
 * Phase 129: tactic_orientation + max_tactic_depth appended to key so changing either
 * triggers a refetch (pitfall 4 prevention).
 */
export function useLibraryFlaws(
  filters: FilterState,
  flawFilter: FlawFilterState,
  offset: number,
  limit: number,
) {
  const params = buildLibraryParams(filters, flawFilter.severity, flawFilter.tags);
  // Phase 126: tactic-motif family filter is a flaw-level Tags-panel filter (off by
  // default; applied only when ≥1 family is selected), so it lives on flawFilter, not
  // the game-metadata FilterState. Sent to /library/flaws as repeated tactic_family.
  const tacticFamily = flawFilter.tacticFamilies.length > 0 ? flawFilter.tacticFamilies : undefined;
  // Phase 129: orientation (omit when 'either'). Quick 260620-l5k: depth is a
  // [min, max] range in depth units — both bounds always sent.
  const tacticOrientation = flawFilter.tacticOrientation ?? 'either';
  const depthParam = depthToQueryParams(flawFilter.tacticDepthMin, flawFilter.tacticDepthMax);
  return useQuery({
    queryKey: ['library-flaws', params, tacticFamily, tacticOrientation, depthParam, offset, limit],
    queryFn: () =>
      libraryApi.getFlaws({
        ...params,
        tactic_family: tacticFamily,
        tactic_orientation: tacticOrientation,
        ...depthParam,
        offset,
        limit,
      }),
    staleTime: LIBRARY_STALE_TIME,
    refetchOnWindowFocus: false,
  });
}
