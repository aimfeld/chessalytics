import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useLocation, useSearchParams, Navigate, Link } from 'react-router';
import { SlidersHorizontal, BarChart2Icon, SwordsIcon, Lightbulb, Cpu } from 'lucide-react';
import { SidebarLayout } from '@/components/layout/SidebarLayout';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { LoadError } from '@/components/ui/load-error';
import { EmptyState } from '@/components/ui/empty-state';
import { MobileFilterDrawer } from '@/components/filters/MobileFilterDrawer';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { InfoPopover } from '@/components/ui/info-popover';
import { FilterPanel, DEFAULT_FILTERS, areFiltersEqual, FILTER_DOT_FIELDS, resetFilterState } from '@/components/filters/FilterPanel';
import { FilterActions } from '@/components/filters/FilterActions';
import { useFilterStore } from '@/hooks/useFilterStore';
import { EndgameOverallPerformanceSection } from '@/components/charts/EndgameOverallPerformanceSection';
import { EndgameScoreOverTimeChart } from '@/components/charts/EndgameScoreOverTimeChart';
import { EndgameMetricsByTcSection } from '@/components/charts/EndgameMetricsByTcSection';
// EndgameMetricsSection removed in favour of EndgameMetricsByTcSection (Phase 97 Plan 03).
// The old component is deleted in Plan 04.
import { EndgameTypeBreakdownSection } from '@/components/charts/EndgameTypeBreakdownSection';
import {
  ENDGAME_CLASS_TO_SLUG,
  HIDDEN_ENDGAME_CLASSES,
} from '@/lib/endgameMetrics';
import { EndgameTimePressureSection } from '@/components/charts/EndgameTimePressureSection';
import { EndgameClockDiffOverTimeChart } from '@/components/charts/EndgameClockDiffOverTimeChart';
import { EndgameEloTimelineSection } from '@/components/charts/EndgameEloTimelineSection';
import { GameCardList } from '@/components/results/GameCardList';
import { PositionResultsPanel } from '@/components/charts/PositionResultsPanel';
import { useEndgameOverview, useEndgameGames } from '@/hooks/useEndgames';
import { EndgameInsightsBlock } from '@/components/insights/EndgameInsightsBlock';
import { EvalCoverageHeader } from '@/components/EvalCoverageHeader';
import { useCachedEndgameInsights, useEndgameInsights } from '@/hooks/useEndgameInsights';
import { useActiveJobs } from '@/hooks/useImport';
import { useReadiness } from '@/hooks/useReadiness';
import { EndgamesProcessingState } from '@/components/EndgamesProcessingState';
import type { FilterState } from '@/components/filters/FilterPanel';
import type { EndgameClass } from '@/types/endgames';
import type { EndgameInsightsResponse, SectionId } from '@/types/insights';

const PAGE_SIZE = 20;

const ENDGAME_CLASS_LABELS: Record<EndgameClass, string> = {
  mixed: 'Mixed',
  rook: 'Rook',
  minor_piece: 'Minor Piece',
  pawn: 'Pawn',
  queen: 'Queen',
  pawnless: 'Pawnless',
};

// HIDDEN_ENDGAME_CLASSES lifted to @/lib/endgameMetrics in Phase 87 Plan 03 so
// EndgameTypeBreakdownSection and this page share one source of truth (pawnless
// is hidden everywhere). Classification stays in the DB so re-enabling does
// not require a reimport.

const VISIBLE_ENDGAME_CLASS_ENTRIES = (
  Object.entries(ENDGAME_CLASS_LABELS) as [EndgameClass, string][]
).filter(([value]) => !HIDDEN_ENDGAME_CLASSES.has(value));

const DEFAULT_ENDGAME_CLASS: EndgameClass = 'mixed';

// Phase 87 (D-08, SEC3-02): inverse of ENDGAME_CLASS_TO_SLUG so the
// /endgames/games?type=<slug> deep-link can pre-seed the selected category on
// page load (shareable URLs, browser back/forward). Built once at module scope.
const SLUG_TO_ENDGAME_CLASS: Record<string, EndgameClass> = Object.fromEntries(
  (Object.entries(ENDGAME_CLASS_TO_SLUG) as [EndgameClass, string][]).map(
    ([cls, slug]) => [slug, cls],
  ),
);

const TAB_INFO: Record<'stats' | 'games', { aria: string; text: string }> = {
  stats: {
    aria: 'About Endgame Stats',
    text: 'Performance metrics, conversion and recovery rates, and time-pressure analysis for your endgames.',
  },
  games: {
    aria: 'About Endgame Games',
    text: 'A list of your games that reached the Endgame Phase, matching your current filter settings.',
  },
};

export function EndgamesPage() {
  const { tier2, pendingCount, totalCount } = useReadiness();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const needsRedirect =
    location.pathname === '/endgames' || location.pathname === '/endgames/';
  // Redirect old /endgames/statistics URL to /endgames/stats after tab rename
  const needsLegacyRedirect = location.pathname.endsWith('/statistics');
  const activeTab = location.pathname.includes('/games') ? 'games' : 'stats';

  // ── Filter state (shared across pages) — color and matchSide are not used for endgames ──
  // appliedFilters keys the backend query; pendingFilters tracks in-progress sidebar edits.
  // Queries only fire when the sidebar/drawer closes and commits pending -> applied.
  const [appliedFilters, setAppliedFilters] = useFilterStore();
  const [pendingFilters, setPendingFilters] = useState<FilterState>(appliedFilters);

  // ── Endgame Insights ────────────────────────────────────────────────────────
  // Mutation state lifted here so per-section slots in each H2 can observe the
  // same report without a context provider. No network request fires unless
  // the user clicks Generate.
  //
  // Cache shape: a list of (filter-state, response) pairs. A report is rendered
  // whenever the current filter state matches a cached entry (via
  // areFiltersEqual), so toggling among previously-generated filter states
  // brings back their reports without another click. New Generate calls
  // upsert into the list. Import-completion clears the whole list because new
  // games invalidate every cached report (findings_hash content-addresses the
  // aggregates on the server side, but the client list is coarse-invalidated
  // to avoid stale UI between an import landing and a regenerate click).
  const insightsMutation = useEndgameInsights();
  const [insightsCache, setInsightsCache] = useState<
    Array<{ filters: FilterState; response: EndgameInsightsResponse }>
  >([]);

  // Auto-load any previously-cached report for the current applied filters.
  // GET /insights/endgame/cached never invokes the LLM and never consumes
  // rate-limit budget, so it is safe to fire on mount and on every filter
  // change. On a 404 (no cache row), the hook resolves to null silently —
  // matchingInsights stays null and the user sees the pre-Generate state.
  const cachedInsights = useCachedEndgameInsights(appliedFilters);
  useEffect(() => {
    const result = cachedInsights.data;
    if (!result) return;
    setInsightsCache((prev) => {
      const idx = prev.findIndex((entry) => areFiltersEqual(entry.filters, appliedFilters));
      if (idx >= 0) {
        if (prev[idx]?.response === result) return prev;
        const next = [...prev];
        next[idx] = { filters: appliedFilters, response: result };
        return next;
      }
      return [...prev, { filters: appliedFilters, response: result }];
    });
  }, [cachedInsights.data, appliedFilters]);

  const handleGenerateInsights = useCallback(async () => {
    try {
      const result = await insightsMutation.mutateAsync(appliedFilters);
      setInsightsCache((prev) => {
        const idx = prev.findIndex((entry) => areFiltersEqual(entry.filters, appliedFilters));
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { filters: appliedFilters, response: result };
          return next;
        }
        return [...prev, { filters: appliedFilters, response: result }];
      });
    } catch {
      // Error is surfaced via insightsMutation.isError → EndgameInsightsBlock error state.
      // Global MutationCache.onError in lib/queryClient.ts captures Sentry; do not
      // add a local capture here (would double-report).
    }
  }, [insightsMutation, appliedFilters]);

  // The rendered report is whichever cached entry matches the current filter
  // state — switching back to a previously-generated filter set re-renders
  // that report without a network call.
  const matchingInsights: EndgameInsightsResponse | null = useMemo(() => {
    const hit = insightsCache.find((entry) => areFiltersEqual(entry.filters, appliedFilters));
    return hit?.response ?? null;
  }, [insightsCache, appliedFilters]);

  // Clear the cached insights when an import completes — new games change the
  // findings, so every cached report no longer reflects current data. We watch
  // the active-jobs count transition from >0 to 0 and invalidate on the edge.
  // No effect fires on initial mount because prevJobsCountRef is seeded with
  // the first observation.
  const { data: activeJobsForInsights } = useActiveJobs(true);
  const activeJobsCount = activeJobsForInsights?.length ?? 0;
  const prevJobsCountRef = useRef<number | null>(null);
  useEffect(() => {
    if (prevJobsCountRef.current === null) {
      prevJobsCountRef.current = activeJobsCount;
      return;
    }
    if (prevJobsCountRef.current > 0 && activeJobsCount === 0) {
      setInsightsCache([]);
    }
    prevJobsCountRef.current = activeJobsCount;
  }, [activeJobsCount]);

  // Build a lookup for O(1) per-slot access during render. Null for sections
  // the backend did not return — or whenever the cached report's filters no
  // longer match the applied filters (see matchingInsights above).
  const sectionBySection: Record<SectionId, { headline: string; bullets: string[] } | null> = {
    overall: null,
    metrics_elo: null,
    time_pressure: null,
    type_breakdown: null,
  };
  if (matchingInsights && !insightsMutation.isError) {
    for (const section of matchingInsights.report.sections) {
      sectionBySection[section.section_id] = {
        headline: section.headline,
        bullets: section.bullets,
      };
    }
  }

  // Sync pending -> applied when the filter store changes from another page/tab
  useEffect(() => {
    setPendingFilters(appliedFilters);
  }, [appliedFilters]);

  // ── Category selection state ─────────────────────────────────────────────────
  const [selectedCategory, setSelectedCategory] = useState<EndgameClass>(DEFAULT_ENDGAME_CLASS);
  const [gamesOffset, setGamesOffset] = useState(0);

  // ── Mobile collapsible state ───────────────────────────────────────────────
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  // ── Desktop sidebar state ───────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState<string | null>(null);

  // ── Modified-filters indicator state ────────────────────────────────────────
  // The dot reflects APPLIED filters (what the backend is filtering by), not pending.
  // When appliedFilters changes away from defaults via a commit, pulse once.
  const isModified = useMemo(
    () => !areFiltersEqual(appliedFilters, DEFAULT_FILTERS, FILTER_DOT_FIELDS),
    [appliedFilters],
  );
  const [isPulsing, setIsPulsing] = useState(false);
  const pulseTimeoutRef = useRef<number | null>(null);
  const prevAppliedRef = useRef(appliedFilters);

  useEffect(() => {
    // Pulse once whenever appliedFilters transitions to a new value (i.e. a commit fired).
    // On initial mount prevAppliedRef.current === appliedFilters so no pulse fires on load.
    // Subsequent changes to appliedFilters (via setAppliedFilters in handleSidebarOpenChange
    // or handleMobileFiltersOpenChange) will trigger the pulse.
    if (prevAppliedRef.current !== appliedFilters) {
      prevAppliedRef.current = appliedFilters;
      setIsPulsing(true);
      if (pulseTimeoutRef.current !== null) {
        window.clearTimeout(pulseTimeoutRef.current);
      }
      pulseTimeoutRef.current = window.setTimeout(() => {
        setIsPulsing(false);
        pulseTimeoutRef.current = null;
      }, 1000); // ~1s pulse duration
    }
    return () => {
      if (pulseTimeoutRef.current !== null) {
        window.clearTimeout(pulseTimeoutRef.current);
        pulseTimeoutRef.current = null;
      }
    };
  }, [appliedFilters]);

  const modifiedDotNode = isModified ? (
    <span
      className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5"
      data-testid="filters-modified-dot"
      aria-hidden="true"
    >
      {isPulsing && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-brown opacity-75" />
      )}
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-brown" />
    </span>
  ) : undefined;

  // ── Data ─────────────────────────────────────────────────────────────────────
  const {
    data: overviewData,
    isLoading: overviewLoading,
    isError: overviewError,
  } = useEndgameOverview(appliedFilters, { enabled: tier2 });

  const rawStatsData = overviewData?.stats;
  const statsData = useMemo(() => {
    if (!rawStatsData) return rawStatsData;
    return {
      ...rawStatsData,
      categories: rawStatsData.categories.filter(
        (c) => !HIDDEN_ENDGAME_CLASSES.has(c.endgame_class),
      ),
    };
  }, [rawStatsData]);
  const perfData = overviewData?.performance;
  const scoreGapData = overviewData?.score_gap_material;
  const timePressureCardsData = overviewData?.time_pressure_cards;
  const clockDiffTimelineData = overviewData?.clock_diff_timeline;
  const showClockDiffTimeline = !!(
    clockDiffTimelineData && clockDiffTimelineData.points.length > 0
  );
  const eloTimelineData = overviewData?.endgame_elo_timeline;

  const { data: gamesData, isLoading: gamesLoading, isError: gamesError } = useEndgameGames(
    selectedCategory,
    appliedFilters,
    gamesOffset,
    PAGE_SIZE,
  );

  // ── Desktop sidebar handler — staged Apply-only model ────────────────────────
  // On open: snapshot committed filters as pending draft.
  // On close without Apply: discard the draft (do NOT commit).
  const handleSidebarOpenChange = useCallback((panelId: string | null) => {
    if (sidebarOpen !== 'filters' && panelId === 'filters') {
      setPendingFilters(appliedFilters);
    }
    setSidebarOpen(panelId);
  }, [sidebarOpen, appliedFilters]);

  // ── Desktop Apply handler — commits pending to store, fires pulse, closes panel ──
  const handleDesktopFiltersApply = useCallback(() => {
    setAppliedFilters(pendingFilters);
    setGamesOffset(0);
    setSidebarOpen(null);
  }, [pendingFilters, setAppliedFilters, setGamesOffset]);

  // ── Mobile drawer handler — staged Apply-only model ───────────────────────────
  // On open: snapshot committed filters as pending draft.
  // On close without Apply: discard the draft (do NOT commit).
  const handleMobileFiltersOpenChange = useCallback((open: boolean) => {
    if (open && !mobileFiltersOpen) {
      setPendingFilters(appliedFilters);
    }
    setMobileFiltersOpen(open);
  }, [mobileFiltersOpen, appliedFilters]);

  // ── Mobile Apply handler — commits pending to store, fires pulse, closes drawer ──
  const handleMobileFiltersApply = useCallback(() => {
    setAppliedFilters(pendingFilters);
    setGamesOffset(0);
    setMobileFiltersOpen(false);
  }, [pendingFilters, setAppliedFilters, setGamesOffset]);

  // ── Category selection handler ──────────────────────────────────────────────

  const handleCategorySelect = useCallback((category: EndgameClass) => {
    setSelectedCategory(category);
    setGamesOffset(0);
    window.scrollTo(0, 0);
  }, []);

  // Phase 87 (D-08, SEC3-02): `?type=<slug>` URL hydration so shareable
  // deep-links into /endgames/games?type=rook pre-seed the type filter on page
  // load and on subsequent SPA navigations. Unknown / malformed slugs are
  // ignored (T-87-07 mitigation: validate against SLUG_TO_ENDGAME_CLASS).
  useEffect(() => {
    const slug = searchParams.get('type');
    if (!slug) return;
    const parsed = SLUG_TO_ENDGAME_CLASS[slug];
    if (parsed && parsed !== selectedCategory) {
      setSelectedCategory(parsed);
      setGamesOffset(0);
    }
    // selectedCategory intentionally omitted from deps: this effect only
    // *seeds* state from URL on mount + URL change; user-driven category
    // selection through handleCategorySelect should not retrigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ── Stats tab content ──────────────────────────────────────────────────────

  // Summary line + collapsible explaining endgame concepts and metric limitations
  const showPerfSection = !!(perfData && perfData.endgame_wdl.total > 0);
  const showTimePressureCards = !!(timePressureCardsData && timePressureCardsData.cards.length > 0);

  const statisticsContent = (
    <div className="flex flex-col gap-4">
      <EndgameInsightsBlock
        appliedFilters={appliedFilters}
        rendered={matchingInsights}
        mutation={insightsMutation}
        onGenerate={handleGenerateInsights}
      />
      {overviewLoading ? (
        <div className="charcoal-texture rounded-md p-12 flex items-center justify-center">
          <p className="text-muted-foreground">Loading endgame analytics...</p>
        </div>
      ) : statsData && statsData.categories.length > 0 ? (
        <>
          {/* ── Endgame Overall Performance ── */}
          {showPerfSection && (
            <>
              <Accordion type="single" collapsible>
                <AccordionItem value="concepts" className="charcoal-texture rounded-md overflow-hidden border-none" data-testid="endgame-concepts-trigger">
                  <AccordionTrigger band>
                    <span className="flex items-center gap-2 flex-1">
                      <h3 className="text-base font-semibold text-foreground">Endgame Statistics Concepts</h3>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground space-y-2 p-4">
                    <p>
                      <strong>FlawChess Benchmark:</strong> a stratified sample of Lichess players across rating
                      and time control buckets, used to calibrate the typical range for each metric. The latest
                      run is published as the {' '}
                      <a
                        href="https://github.com/flawchess/flawchess/blob/main/reports/benchmark/benchmarks-latest.md"
                        className="text-primary underline-offset-4 hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        FlawChess Benchmark
                      </a>
                      {' '}report and powers both the color zones on gauges/charts and the percentile badges shown
                      next to individual metrics.
                    </p>
                    <p>
                      <strong>Color Zones:</strong> the blue band on each gauge and chart marks the typical range,
                      defined by the middle 50% of benchmark players (interquartile range). Values inside the blue
                      zone are typical, while red and green zones flag below- and above-average performance relative
                      to the benchmark cohort.
                    </p>
                    <p>
                      <strong>Percentile Badges:</strong> the small badge next to a metric (e.g. a blue "23" or
                      green "82") shows where you rank against a peer cohort of benchmark players at your rating
                      and time control. Red ({'<'} 25), neutral (25-75), green ({'>'} 75). Computed in five steps:
                    </p>
                    <ol className="list-decimal pl-6 space-y-1">
                      <li>
                        <strong>Anchor your rating per time control.</strong> For each time control
                        (bullet/blitz/rapid/classical) we take your most recent 3000 rated games in that time
                        control over the last 36 months (the same pool used to compute your metrics in step 3,
                        excluding chess.com Daily), then compute the median of your rating at game time across
                        those games. chess.com ratings are converted to Lichess-equivalent via the{' '}
                        <a
                          href="https://chessgoals.com/rating-comparison"
                          className="text-primary underline-offset-4 hover:underline"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          ChessGoals rating conversion tables
                        </a>
                        {' '}so everyone is compared on the same scale.
                      </li>
                      <li>
                        <strong>Pick the matching peer cohort.</strong> From the FlawChess Benchmark, we select
                        all Lichess players within +/-200 Elo of your anchor in the same time control. A cell
                        only qualifies if at least 100 benchmark users fall in that window, otherwise the badge
                        is suppressed.
                      </li>
                      <li>
                        <strong>Compute your recent metric value.</strong> Your most recent 3000 rated games
                        per time control over the last 36 months, vs opponents within +/-100 Elo, are used to
                        compute the same metric (Endgame Score Gap, Conversion, Recovery, Eval Score Gap,
                        etc.) the same way it is computed for each benchmark user.
                      </li>
                      <li>
                        <strong>Look up your percentile in the cohort distribution, per time control.</strong>
                        {' '}Steps 1-3 are performed independently for each time control you play. For each TC,
                        the benchmark cell stores 99 precomputed percentile breakpoints for that metric; your
                        per-TC value is interpolated against those breakpoints to produce a per-TC percentile.
                        For page-level chips that span time controls (Endgame Score Gap, Eval Score Gap,
                        Conversion, Parity, Recovery), the per-TC percentiles are then combined into a single
                        chip value via a game-count-weighted mean, so the time controls you play most weigh
                        most heavily. Per-TC chips on the Time Pressure cards skip this aggregation step and
                        render their own TC's percentile directly.
                      </li>
                      <li>
                        <strong>Color and display.</strong> The integer percentile is rendered on the badge with
                        the red/neutral/green band described above. UI filters (color, opponent strength, recency)
                        do not affect the badge: it always reflects the standardized "recent rated games vs
                        near-peers" basis from step 3, so the comparison stays apples-to-apples.
                      </li>
                    </ol>
                    <p>
                      <strong>Endgame Phase:</strong> positions where the total count of major and minor pieces
                      (queens, rooks, bishops, knights) across both sides is at most 6. Kings and pawns are not
                      counted. This follows the Lichess definition. A game is only counted as having an Endgame
                      Phase if it spans at least 3 full moves (6 half-moves) in the endgame. Shorter tactical transitions from middlegame into a checkmate are treated as no endgame.
                    </p>
                    <p>
                      <strong>Endgame Types:</strong> Rook, Minor Piece (bishops/knights), Pawn (king and pawns only),
                      Queen, and Mixed (two or more piece types).
                    </p>
                    <p>
                      <strong>Endgame Sequence:</strong> a continuous stretch of at least 3 full moves (6 half-moves)
                      spent in a single Endgame Type. A single game can produce multiple sequences. For example,
                      a rook endgame where the rooks get traded becomes a pawn endgame, giving that game one rook
                      sequence and one pawn sequence. Sequences drive the Endgame Type Breakdown, so a game can appear
                      under more than one type.
                    </p>
                    <p>
                      <strong>Score:</strong> your result as a percentage, counting each win as a
                      full point and each draw as a half point (so 3 wins, 2 draws and 1 loss over
                      6 games is 67%). 50% is an even result against equally matched opponents.
                    </p>
                    <p>
                      <strong>Score Gap:</strong> the difference between two Scores. Positive means
                      the first Score is the higher of the two, negative means it is lower.
                    </p>
                    <p>
                      <Cpu className="inline h-4 w-4 -mt-0.5 mr-1" aria-hidden="true" />
                      <strong>Eval:</strong> the Stockfish evaluation of a position, in pawns and from
                      your perspective, where positive means you stand better (+1.0 is a one-pawn
                      advantage). Metrics that are based on the engine are marked with this chip icon.
                    </p>
                    <p>
                      <Cpu className="inline h-4 w-4 -mt-0.5 mr-1" aria-hidden="true" />
                      <strong>Eval Score:</strong> an Eval converted into a Score with the{' '}
                      <a
                        href="https://lichess.org/page/accuracy"
                        className="text-primary underline-offset-4 hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Lichess expected-score formula
                      </a>
                      , so engine evaluations and actual results sit on the same scale. A +1.0 Eval
                      is roughly a 60% Eval Score.
                    </p>
                    <p>
                      <Cpu className="inline h-4 w-4 -mt-0.5 mr-1" aria-hidden="true" />
                      <strong>Eval Score Gap:</strong> the gap between an Eval Score and another Score.
                      Across your overall endgames it is your Endgame Score minus your Entry Eval Score
                      (did you beat the engine's expectation for the positions you reached?); within an
                      Endgame Sequence it is the change in Eval Score from start to end. Positive means
                      you came out ahead of the engine's expectation, negative means you fell short.
                    </p>
                    <p>
                      <strong>Conversion:</strong> percentage of games where you entered the endgame with a
                      Stockfish evaluation of +1.0 or better (you ahead by at least one pawn of advantage)
                      and went on to win. Measures how well you close out winning endgames.
                    </p>
                    <p>
                      <strong>Parity:</strong> percentage of games where you entered the endgame with a
                      Stockfish evaluation between -1.0 and +1.0 (roughly balanced). Score counts draws as
                      half. Measures how well you handle balanced endgames.
                    </p>
                    <p>
                      <strong>Recovery:</strong> percentage of games where you entered the endgame with a
                      Stockfish evaluation of -1.0 or worse (you behind by at least one pawn of disadvantage)
                      and drew or won. Measures how well you defend losing endgames.
                    </p>
                    <p>
                      <Cpu className="inline h-4 w-4 -mt-0.5 mr-1" aria-hidden="true" />
                      <strong>Entry Eval:</strong> the average Stockfish evaluation of
                      the position where the endgame begins, measured in pawns from your perspective
                      (positive means you have the better position). Mate scores are excluded.
                    </p>
                    <p>
                      <Cpu className="inline h-4 w-4 -mt-0.5 mr-1" aria-hidden="true" />
                      <strong>Entry Eval Score:</strong> your Entry Eval converted to a Score with the{' '}
                      <a
                        href="https://lichess.org/page/accuracy"
                        className="text-primary underline-offset-4 hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Lichess expected-score formula
                      </a>
                      , i.e. what a strong player would expect to score from your endgame-entry
                      positions. The curve is fitted on 2300+ rapid games, so scoring a little below
                      it from positive evals is normal at lower ratings. Compare it against your
                      Endgame Score to see how well you convert the positions you reach.
                    </p>
                    <p>
                      <strong>Endgame Score:</strong> your win rate (with draws counted as half)
                      across all games that reach an endgame, tested against 50%, the baseline against rating-matched opponents. Use the Opponent Strength filter
                      to tighten the test against equal-rated opponents specifically.
                    </p>
                    <p>
                      <strong>Endgame Score Gap:</strong> the score difference between games that reach an endgame (Endgame Score) vs. games that end before (Non-Endgame Score). Positive means endgames are your strength; negative
                      means you perform worse once games reach an endgame.
                    </p>
                    <p>
                      <strong>Endgame ELO and Non-Endgame ELO:</strong> what your rating would be if your whole
                      game played at the level of just your endgame games, or just your non-endgame games. Both
                      sit symmetrically around your Actual ELO: we take your trailing-window score on each side
                      (S_E for endgame games, S_N for non-endgame games), convert the score gap into an ELO
                      spread via the Elo logistic, and split it across the two lines:
                      {' '}
                      <code>
                        spread = 400 · log₁₀((S_E / (1 − S_E)) / (S_N / (1 − S_N)))
                      </code>
                      , {' '}
                      <code>Endgame ELO = Actual ELO + spread / 2</code>, {' '}
                      <code>Non-Endgame ELO = Actual ELO − spread / 2</code>. The midpoint
                      equals your Actual ELO by construction. When Endgame ELO sits above Non-Endgame ELO your
                      endgame play is lifting your rating (green band); when it sits below, your endgame is
                      holding it back (red band).
                    </p>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
              <h2 className="text-lg font-semibold text-foreground mt-2">Endgame Overall Performance</h2>
              {scoreGapData && (
                <EndgameOverallPerformanceSection
                  data={perfData}
                  scoreGap={scoreGapData}
                />
              )}
              {scoreGapData && scoreGapData.timeline.length > 0 && (
                <div className="charcoal-texture rounded-md overflow-hidden">
                  <EndgameScoreOverTimeChart
                    timeline={scoreGapData.timeline}
                    window={scoreGapData.timeline_window}
                  />
                </div>
              )}
              {/* Phase 87.5 SC#2: Endgame ELO Timeline relocated here, directly
                  below the Score Gap timeline, inside the "Endgame Overall
                  Performance" section. The chart shares the same filter
                  plumbing (overviewData) as EndgameScoreOverTimeChart above. */}
              {eloTimelineData && (
                <div
                  className="charcoal-texture rounded-md overflow-hidden"
                  data-testid="endgame-elo-timeline-section"
                >
                  <EndgameEloTimelineSection
                    data={eloTimelineData}
                    isLoading={overviewLoading}
                    isError={overviewError}
                  />
                </div>
              )}
              <SectionInsightSlot sectionId="overall" data={sectionBySection.overall} />
              {perfData && (
                <>
                  <h2 className="text-lg font-semibold text-foreground mt-2">
                    Endgame Metrics
                  </h2>
                  {/* Phase 97 Plan 03: replaced aggregated EndgameMetricsSection with per-TC
                      cards fed by endgame_metrics_cards. The ?? fallback handles older server
                      responses where endgame_metrics_cards is absent. */}
                  <EndgameMetricsByTcSection
                    data={overviewData?.endgame_metrics_cards ?? { cards: [] }}
                    ratingAnchors={overviewData?.rating_anchors}
                    filterKey={JSON.stringify(appliedFilters)}
                  />
                  <SectionInsightSlot sectionId="metrics_elo" data={sectionBySection.metrics_elo} />
                </>
              )}
            </>
          )}

          {/* ── Time Pressure ── */}
          {/* Plan 88-13 A-1: no outer charcoal-texture wrap; each TC card carries
              its own charcoal container, matching the EndgameTypeBreakdownSection
              convention below. */}
          {showTimePressureCards && timePressureCardsData && (
            <>
              <h2 className="text-lg font-semibold text-foreground mt-2">Time Pressure</h2>
              {/* Plan 88-15 + post-UAT reorder (CONTEXT §2 A-2): restored
                  Average Clock Difference over Time line chart. Sits ABOVE the
                  per-TC cards so the user sees the trend story first, then
                  drills into per-TC breakdowns. Hides when no eligible points. */}
              {showClockDiffTimeline && clockDiffTimelineData && (
                <div className="charcoal-texture rounded-md overflow-hidden">
                  <EndgameClockDiffOverTimeChart timeline={clockDiffTimelineData.points} />
                </div>
              )}
              <EndgameTimePressureSection
                data={timePressureCardsData}
                ratingAnchors={overviewData?.rating_anchors}
                filterKey={JSON.stringify(appliedFilters)}
              />
              <SectionInsightSlot sectionId="time_pressure" data={sectionBySection.time_pressure} />
            </>
          )}

          {/* ── Endgame Type Breakdown ── */}
          <h2
            id="endgame-type-breakdown-heading"
            className="text-lg font-semibold text-foreground mt-2"
          >
            <span className="inline-flex items-center gap-1">
              Endgame Type Breakdown
              <InfoPopover
                ariaLabel="Endgame Type Breakdown info"
                testId="endgame-type-breakdown-info"
                side="bottom"
              >
                <div className="space-y-2">
                  <p>
                    <strong>Endgame Type Breakdown:</strong> how you perform across the different
                    kinds of endgames (rook, minor piece, pawn, queen, mixed).
                  </p>
                  <p>
                    Each card shows your win, draw, and loss rate for that endgame type.
                  </p>
                </div>
              </InfoPopover>
            </span>
          </h2>
          <EndgameTypeBreakdownSection
            categoriesByTc={statsData.categories_by_tc}
            filterKey={JSON.stringify(appliedFilters)}
            onCategorySelect={handleCategorySelect}
          />
          <SectionInsightSlot sectionId="type_breakdown" data={sectionBySection.type_breakdown} />
        </>
      ) : overviewError ? (
        <LoadError variant="centered" resource="endgame data" />
      ) : statsData && statsData.categories.length === 0 ? (
        <EmptyState
          layout="page"
          title="No endgame data yet"
          subtitle="No games have reached an Endgame Phase yet with the current filters. Try adjusting the time control or recency filters."
        />
      ) : (
        <EmptyState
          layout="page"
          title="No games imported yet"
          subtitle="Import your games from chess.com or lichess to see endgame analysis."
          action={
            <Button variant="outline" size="sm" asChild>
              <Link to="/library/import">Import Games</Link>
            </Button>
          }
        />
      )}
    </div>
  );

  // ── Games tab content ────────────────────────────────────────────────────────

  // ── Endgame type dropdown (used in Games tab) ──────────────────────────────
  const endgameTypeDropdown = (
    <div className="flex items-center gap-2">
      <p className="text-xs text-muted-foreground whitespace-nowrap">Endgame Type</p>
      <Select
        value={selectedCategory}
        onValueChange={(v) => {
          setSelectedCategory(v as EndgameClass);
          setGamesOffset(0);
        }}
      >
        <SelectTrigger size="sm" data-testid="filter-endgame-type" className="min-h-11 sm:min-h-0 w-full sm:w-[160px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {VISIBLE_ENDGAME_CLASS_ENTRIES.map(([value, label]) => (
            <SelectItem key={value} value={value}>{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const selectedCategoryStats = statsData?.categories.find(c => c.endgame_class === selectedCategory);

  const gamesContent = (
    <div className="flex flex-col gap-4">
      {selectedCategoryStats && (
        <PositionResultsPanel
          stats={selectedCategoryStats}
          evalBaselinePawns={selectedCategoryStats.eval_baseline_pawns}
          filterColor="white"
          label={`${ENDGAME_CLASS_LABELS[selectedCategory]} Endgame Results`}
          className=""
          evalContext="endgame-entry"
        />
      )}
      {endgameTypeDropdown}
      {gamesLoading ? (
        <div className="flex items-center justify-center py-12">
          <p className="text-muted-foreground">Loading games...</p>
        </div>
      ) : gamesError ? (
        <LoadError variant="centered" resource="games" />
      ) : gamesData && gamesData.games.length === 0 ? (
        <EmptyState
          layout="page"
          title="No games matched"
          subtitle="Try adjusting the time control, platform, or recency filters."
        />
      ) : gamesData ? (
        <GameCardList
          games={gamesData.games}
          matchedCount={gamesData.matched_count}
          totalGames={statsData?.endgame_games ?? gamesData.matched_count}
          offset={gamesOffset}
          limit={PAGE_SIZE}
          onPageChange={setGamesOffset}
          matchLabel={statsData ? (
            <>
              {gamesData.matched_count} of {statsData.endgame_games}{' '}
              ({(gamesData.matched_count / statsData.endgame_games * 100).toFixed(1)}%){' '}
              games with an endgame matched
            </>
          ) : undefined}
        />
      ) : null}
    </div>
  );

  // ── Render ───────────────────────────────────────────────────────────────────

  // Whole-page lock until Tier 2 (D-01/D-02): uniform for first-import and
  // incremental import — the nav link stays enabled but the page shows the
  // processing state. No forced navigation; unlock is reactive once tier2=true.
  if (!tier2) {
    return <EndgamesProcessingState pendingCount={pendingCount} totalCount={totalCount} />;
  }

  if (needsRedirect) {
    return <Navigate to="/endgames/stats" replace />;
  }

  if (needsLegacyRedirect) {
    return <Navigate to="/endgames/stats" replace />;
  }

  return (
    <div data-testid="endgames-page" className="flex min-h-0 flex-1 flex-col bg-background">
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-2 pb-20 md:py-6 md:pb-6 md:px-6">

        {/* Desktop: full-width subnav above the sidebar strip + content (Phase 111 —
            matches the Library page; the subnav spans both the strip and content
            instead of sitting only over the content column). Tabs wraps SidebarLayout
            so TabsContent keeps its Tabs context while TabsList renders full-width above. */}
        <Tabs
          value={activeTab}
          onValueChange={(val) => navigate(`/endgames/${val}`)}
          className="hidden md:flex"
        >
          <EvalCoverageHeader />
          <TabsList variant="brand" className="w-full mb-4" data-testid="endgames-tabs">
            <TabsTrigger value="stats" data-testid="tab-stats" className="flex-1">
              <BarChart2Icon className="mr-1.5 h-4 w-4" />
              Stats
              {activeTab === 'stats' && (
                <span className="ml-1.5 inline-flex items-center [&>span]:text-white! [&>span:hover]:text-white/80!" onClick={(e) => e.stopPropagation()}>
                  <InfoPopover ariaLabel={TAB_INFO.stats.aria} testId="tab-stats-info" side="bottom">
                    {TAB_INFO.stats.text}
                  </InfoPopover>
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="games" data-testid="tab-games" className="flex-1">
              <SwordsIcon className="mr-1.5 h-4 w-4" />
              Games
              {activeTab === 'games' && (
                <span className="ml-1.5 inline-flex items-center [&>span]:text-white! [&>span:hover]:text-white/80!" onClick={(e) => e.stopPropagation()}>
                  <InfoPopover ariaLabel={TAB_INFO.games.aria} testId="tab-games-info" side="bottom">
                    {TAB_INFO.games.text}
                  </InfoPopover>
                </span>
              )}
            </TabsTrigger>
          </TabsList>
          <SidebarLayout
            panels={[
              {
                id: 'filters',
                label: 'Filters',
                icon: <SlidersHorizontal className="h-5 w-5" />,
                notificationDot: modifiedDotNode,
                content: (
                  <div className="p-3">
                    {/* 'playedAs' omitted: endgame queries ignore color/playedAs entirely
                        (see useEndgames "no color per D-02"), so the control was a no-op here. */}
                    <FilterPanel
                      filters={pendingFilters}
                      onChange={setPendingFilters}
                      visibleFilters={['timeControl', 'platform', 'opponent', 'opponentStrength', 'rated', 'recency']}
                      hideReset
                    />
                  </div>
                ),
                // Reset/Apply pinned to the panel bottom, below the scrolling filters
                // (mirrors the mobile drawer's pinned footer).
                footer: (
                  <div className="px-3 pb-3">
                    <FilterActions
                      onReset={() => setPendingFilters(resetFilterState(pendingFilters))}
                      onApply={handleDesktopFiltersApply}
                    />
                  </div>
                ),
              },
            ]}
            activePanel={sidebarOpen}
            onActivePanelChange={handleSidebarOpenChange}
          >
            <TabsContent value="stats">
              {statisticsContent}
            </TabsContent>
            <TabsContent value="games">
              {gamesContent}
            </TabsContent>
          </SidebarLayout>
        </Tabs>

        {/* Mobile: single column */}
        <div className="md:hidden flex flex-col min-w-0">
          <EvalCoverageHeader />
          <Tabs value={activeTab} onValueChange={(val) => { navigate(`/endgames/${val}`); window.scrollTo({ top: 0 }); }}>
            {/* Full-width, non-sticky sub-navigation (like the Library page). The
                filter affordance is a sticky Filters button rendered just below. */}
            <div className="flex items-center gap-2 h-[40px] rounded-md" data-testid="endgames-mobile-control-row">
              <TabsList variant="brand" className="flex-1 !h-full !p-0" data-testid="endgames-tabs-mobile">
                <TabsTrigger value="stats" className="flex-1" data-testid="tab-stats-mobile">
                  <BarChart2Icon className="mr-1.5 h-4 w-4" />
                  Stats
                  {activeTab === 'stats' && (
                    <span className="ml-1.5 inline-flex items-center [&>span]:text-white! [&>span:hover]:text-white/80!" onClick={(e) => e.stopPropagation()}>
                      <InfoPopover ariaLabel={TAB_INFO.stats.aria} testId="tab-stats-info-mobile" side="bottom">
                        {TAB_INFO.stats.text}
                      </InfoPopover>
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="games" className="flex-1" data-testid="tab-games-mobile">
                  <SwordsIcon className="mr-1.5 h-4 w-4" />
                  Games
                  {activeTab === 'games' && (
                    <span className="ml-1.5 inline-flex items-center [&>span]:text-white! [&>span:hover]:text-white/80!" onClick={(e) => e.stopPropagation()}>
                      <InfoPopover ariaLabel={TAB_INFO.games.aria} testId="tab-games-info-mobile" side="bottom">
                        {TAB_INFO.games.text}
                      </InfoPopover>
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Sticky Filters button, styled like the Library page. The full-width
                subnav above is non-sticky; this button pins on scroll. */}
            <div className="sticky top-0 z-20 flex justify-end gap-2 py-2 bg-background/80 backdrop-blur-sm">
              <Button
                variant="brand-outline"
                className="relative"
                onClick={() => setMobileFiltersOpen(true)}
                data-testid="btn-open-filter-drawer"
                aria-label="Open filters"
              >
                <SlidersHorizontal className="mr-2 h-4 w-4" />
                Filters
                {modifiedDotNode}
              </Button>
            </div>

            {/* Filter drawer */}
            <MobileFilterDrawer
              open={mobileFiltersOpen}
              onOpenChange={handleMobileFiltersOpenChange}
              title="Filters"
              contentTestId="drawer-filter-sidebar"
              closeTestId="btn-close-filter-drawer"
              bodyClassName="space-y-4"
              footer={
                <FilterActions
                  onReset={() => setPendingFilters(resetFilterState(pendingFilters))}
                  onApply={handleMobileFiltersApply}
                />
              }
            >
              {/* 'playedAs' omitted — see desktop panel note (no-op for endgame queries). */}
              <FilterPanel
                filters={pendingFilters}
                onChange={setPendingFilters}
                visibleFilters={['timeControl', 'platform', 'opponent', 'opponentStrength', 'rated', 'recency']}
                hideReset
              />
            </MobileFilterDrawer>

            <TabsContent value="stats" className="mt-4">
              {statisticsContent}
            </TabsContent>
            <TabsContent value="games" className="mt-4">
              {gamesContent}
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  );
}

// ── SectionInsightSlot ──────────────────────────────────────────────────────
// Renders a per-section insight (headline + 0-2 bullets) above the first chart
// card of each H2 group when the backend returned a matching section_id. Returns
// null when no matching data exists, e.g. pre-generate state, or any section
// the LLM chose to omit (Phase 65 min=1/max=4).
function SectionInsightSlot({
  sectionId,
  data,
}: {
  sectionId: SectionId;
  data: { headline: string; bullets: string[] } | null;
}) {
  if (!data) return null;

  // Header band content shared by both the plain (headline-only) and the
  // collapsible (headline + bullets) variants.
  const headline = (
    <span className="flex items-center gap-2 flex-1 text-sm font-semibold text-foreground">
      <span className="insight-lightbulb shrink-0" aria-hidden="true">
        <Lightbulb className="size-4" />
      </span>
      {data.headline}
    </span>
  );

  // No bullets: nothing to fold, so render a plain header card without a
  // chevron rather than a collapsible with an empty body.
  if (data.bullets.length === 0) {
    return (
      <div
        data-testid={`insights-section-${sectionId}`}
        className="charcoal-texture rounded-md overflow-hidden border-none"
      >
        <div className="w-full flex items-center gap-2 px-4 py-3 bg-black/20">
          {headline}
        </div>
      </div>
    );
  }

  return (
    <Accordion type="single" collapsible defaultValue="insight">
      <AccordionItem
        value="insight"
        data-testid={`insights-section-${sectionId}`}
        className="charcoal-texture rounded-md overflow-hidden border-none"
      >
        <AccordionTrigger
          data-testid={`insights-section-${sectionId}-trigger`}
          band
        >
          {headline}
        </AccordionTrigger>
        <AccordionContent className="p-4">
          <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-muted-foreground">
            {data.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
