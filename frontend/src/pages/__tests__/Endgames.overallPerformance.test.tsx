// @vitest-environment jsdom
/**
 * Phase 85 Plan 05 — page-level integration tests for the Endgames page after
 * `EndgameOverallPerformanceSection` (the 3-card composite) is wired in.
 *
 * Replaces Endgames.startVsEnd.test.tsx (Phase 81 Plan 04), which tested the
 * former two-section layout (EndgameStartVsEndSection + EndgameGamesWithWithoutSection).
 * The new composite section collapses both legacy sections into one mount,
 * gated on `scoreGapData && showPerfSection`.
 *
 * Strategy: full-page render of <EndgamesPage /> is heavy (15+ hooks), so
 * we mock the data hooks with a complete EndgameOverviewResponse fixture
 * and stub out chart sub-components that don't participate in the assertions
 * (Conv/Recov, Score Gap, Clock Pressure, Time Pressure, ELO timeline,
 * WDL chart, GameCardList, Insights block).
 *
 * EndgameOverallPerformanceSection and EndgameScoreOverTimeChart render for
 * real so DOM-order, accordion paragraph order, and negative-scope testid
 * presence can all be asserted directly against the rendered tree.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import { cloneElement, isValidElement } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import type {
  EndgameOverviewResponse,
  EndgamePerformanceResponse,
  EndgameWDLSummary,
} from '@/types/endgames';

// ── Recharts: jsdom has zero-size parents; ResponsiveContainer would refuse
// to render. Replace it with a fixed-size shim so EndgameScoreOverTimeChart
// (which renders inside the Endgames page when score-gap data has a timeline)
// produces its testids.
vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) => (
      <div style={{ width: 800, height: 400 }}>
        {isValidElement(children)
          ? cloneElement(
              children as ReactElement<{ width?: number; height?: number }>,
              { width: 800, height: 400 },
            )
          : children}
      </div>
    ),
  };
});

// ── Mock heavy chart components / hooks that don't participate in the
// assertions. Everything stubbed here renders a single <div> with a stable
// testid so we can still detect "the section was rendered" if needed.
vi.mock('@/components/charts/EndgameTypeBreakdownSection', () => ({
  EndgameTypeBreakdownSection: () => (
    <div data-testid="mock-endgame-type-breakdown-section" />
  ),
}));
vi.mock('@/components/charts/EndgameMetricsSection', () => ({
  EndgameMetricsSection: () => <div data-testid="mock-endgame-metrics-section" />,
}));
vi.mock('@/components/charts/EndgameTimePressureSection', () => ({
  EndgameTimePressureSection: () => <div data-testid="mock-endgame-time-pressure-section" />,
}));
vi.mock('@/components/charts/EndgameEloTimelineSection', () => ({
  EndgameEloTimelineSection: () => <div data-testid="mock-endgame-elo-timeline-section" />,
}));
vi.mock('@/components/results/GameCardList', () => ({
  GameCardList: () => <div data-testid="mock-game-card-list" />,
}));
vi.mock('@/components/insights/EndgameInsightsBlock', () => ({
  EndgameInsightsBlock: () => <div data-testid="mock-endgame-insights-block" />,
}));

// ── Mock data hooks.
const overviewState: { data: EndgameOverviewResponse | null } = { data: null };

vi.mock('@/hooks/useEndgames', () => ({
  useEndgameOverview: () => ({
    data: overviewState.data,
    isLoading: false,
    isError: false,
  }),
  useEndgameGames: () => ({
    data: { games: [], matched_count: 0, offset: 0, limit: 20 },
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('@/hooks/useEndgameInsights', () => ({
  useCachedEndgameInsights: () => ({ data: null, isLoading: false, isError: false }),
  useEndgameInsights: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock('@/hooks/useImport', () => ({
  useActiveJobs: () => ({ data: [], isLoading: false, isError: false }),
}));

// Phase 91: EvalCoverageHeader is now mounted in statisticsContent; mock the
// hook so the test does not need a QueryClientProvider.
vi.mock('@/hooks/useEvalCoverage', () => ({
  useEvalCoverage: () => ({
    pendingCount: 0,
    totalCount: 0,
    pct: 100,
    isPending: false,
    isLoading: false,
  }),
}));

// Phase 96: Endgames page gates its content on useReadiness().tier2. Mock the
// hook with tier2=true so the real statistics content renders (these tests
// assert against it) without needing a QueryClientProvider.
vi.mock('@/hooks/useReadiness', () => ({
  useReadiness: () => ({
    tier1: true,
    tier2: true,
    pendingCount: 0,
    totalCount: 0,
    isLoading: false,
    isError: false,
  }),
}));

// jsdom shims required by the existing component.
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
  if (!('scrollTo' in window) || typeof window.scrollTo !== 'function') {
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  }
});

afterEach(() => {
  cleanup();
});

// Import the page after the mocks above are registered.
import { EndgamesPage } from '../Endgames';

// ── Fixture builders ──────────────────────────────────────────────────────
function buildWdl(
  wins: number,
  draws: number,
  losses: number,
  total = wins + draws + losses,
): EndgameWDLSummary {
  const safeTotal = total === 0 ? 1 : total;
  return {
    wins,
    draws,
    losses,
    total,
    win_pct: (wins / safeTotal) * 100,
    draw_pct: (draws / safeTotal) * 100,
    loss_pct: (losses / safeTotal) * 100,
  };
}

function buildPerf(
  overrides?: Partial<EndgamePerformanceResponse>,
): EndgamePerformanceResponse {
  return {
    endgame_wdl: buildWdl(25, 10, 15),
    non_endgame_wdl: buildWdl(20, 8, 12),
    endgame_win_rate: 0.5,
    entry_eval_mean_pawns: 0.4,
    entry_eval_n: 50,
    entry_eval_p_value: 0.001,
    endgame_score_p_value: 0.001,
    non_endgame_score_p_value: 0.001,
    entry_eval_ci_low_pawns: 0.1,
    entry_eval_ci_high_pawns: 0.7,
    // Phase 83: in-band default; tests targeting the achievable bullet override.
    entry_expected_score: 0.5,
    entry_expected_score_n: 50,
    entry_expected_score_p_value: 1.0,
    entry_expected_score_ci_low: 0.45,
    entry_expected_score_ci_high: 0.55,
    ...overrides,
  };
}

function buildOverview(overrides?: {
  performance?: Partial<EndgamePerformanceResponse>;
}): EndgameOverviewResponse {
  return {
    stats: {
      total_games: 100,
      endgame_games: 50,
      categories: [
        {
          endgame_class: 'mixed',
          label: 'Mixed',
          wins: 25,
          draws: 10,
          losses: 15,
          total: 50,
          win_pct: 50,
          draw_pct: 20,
          loss_pct: 30,
          conversion: {
            conversion_pct: 60,
            conversion_games: 20,
            conversion_wins: 12,
            conversion_draws: 4,
            conversion_losses: 4,
            recovery_pct: 30,
            recovery_games: 10,
            recovery_saves: 3,
            recovery_wins: 1,
            recovery_draws: 2,
          },
        },
      ],
    },
    performance: buildPerf(overrides?.performance),
    timeline: { overall: [], per_type: {}, window: 100 },
    score_gap_material: {
      endgame_score: 0.55,
      non_endgame_score: 0.50,
      score_difference: 0.05,
      material_rows: [],
      timeline: [
        // Single timeline point is sufficient to make the score-over-time
        // chart render its outermost <div data-testid="endgame-score-timeline-chart">.
        {
          date: '2026-01-05',
          score_difference: 0.05,
          endgame_game_count: 25,
          non_endgame_game_count: 25,
          per_week_total_games: 50,
          endgame_score: 0.55,
          non_endgame_score: 0.50,
        },
      ],
      timeline_window: 100,
    },
    time_pressure_cards: {
      cards: [],
    },
    endgame_elo_timeline: {
      combos: [
        {
          combo_key: 'chess_com_blitz',
          platform: 'chess.com',
          time_control: 'blitz',
          points: [
            {
              // Midpoint property: 1620 + 1540 == 2 * 1580.
              date: '2026-01-05',
              endgame_elo: 1620,
              non_endgame_elo: 1540,
              actual_elo: 1580,
              endgame_games_in_window: 50,
              per_week_endgame_games: 4,
              per_week_total_games: 18,
            },
          ],
        },
      ],
      timeline_window: 100,
    },
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/endgames/stats']}>
      <TooltipProvider>
        <EndgamesPage />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe('Endgames page — Phase 85 Plan 05 single composite section', () => {
  it('renders EndgameOverallPerformanceSection mount(s) but no legacy section testids', () => {
    overviewState.data = buildOverview();
    const { container } = renderPage();
    // At least one composite section renders (desktop + mobile layouts each
    // render statisticsContent, so jsdom sees 2 mounts; that is expected).
    const sections = container.querySelectorAll(
      '[data-testid="endgame-overall-performance-section"]',
    );
    expect(sections.length).toBeGreaterThanOrEqual(1);
    // Legacy section testids must be absent.
    expect(
      container.querySelector('[data-testid="endgame-start-vs-end-section"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="endgame-games-with-without-section"]'),
    ).toBeNull();
  });

  it('does NOT render the composite section when no endgame games (showPerfSection false)', () => {
    overviewState.data = buildOverview({
      performance: { endgame_wdl: buildWdl(0, 0, 0) },
    });
    const { container } = renderPage();
    expect(
      container.querySelector('[data-testid="endgame-overall-performance-section"]'),
    ).toBeNull();
  });

  it('contains both accordion paragraphs ("Entry Eval" + "Endgame Score") (D-13)', () => {
    overviewState.data = buildOverview();
    const { container } = renderPage();
    // Open the first accordion trigger (radix collapses content when closed).
    openConceptsAccordion(container);
    expect(screen.getAllByText(/Entry Eval:/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Endgame Score:/).length).toBeGreaterThan(0);
  });

  it('places the 2 accordion paragraphs AFTER Recovery (D-14)', () => {
    overviewState.data = buildOverview();
    const { container } = renderPage();
    openConceptsAccordion(container);
    const accordionItem = container.querySelector(
      '[data-testid="endgame-concepts-trigger"]',
    );
    expect(accordionItem).not.toBeNull();
    const paragraphs = Array.from(
      accordionItem!.querySelectorAll('p'),
    ) as HTMLParagraphElement[];
    const text = paragraphs.map((p) => p.textContent ?? '');
    const recoveryIdx = text.findIndex((t) => /Recovery:/.test(t));
    const entryEvalIdx = text.findIndex((t) => /Entry Eval:/.test(t));
    const endgameScoreIdx = text.findIndex((t) => /Endgame Score:/.test(t));
    expect(recoveryIdx).toBeGreaterThanOrEqual(0);
    expect(entryEvalIdx).toBeGreaterThan(recoveryIdx);
    expect(endgameScoreIdx).toBeGreaterThan(entryEvalIdx);
    // The rating-changes caveat paragraph that previously followed these two
    // was removed in feec92cc (style: drop opponent-strength caveat from the
    // Endgame ELO popover), so the ordering assertion against it was dropped.
  });

  it('preserves the new Section 1 cards, Score Gap, and timeline chart (D-21 negative scope)', () => {
    overviewState.data = buildOverview();
    const { container } = renderPage();
    // The 3-card composite section includes all three card tiles and the score gap.
    expect(
      container.querySelector('[data-testid="tile-games-without-endgame"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="tile-at-endgame-entry"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="tile-games-with-endgame"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="endgame-score-differences"]'),
    ).not.toBeNull();
    // Timeline chart still renders.
    expect(
      container.querySelector('[data-testid="endgame-score-timeline-chart"]'),
    ).not.toBeNull();
    // Negative scope: old card testids are gone.
    expect(
      container.querySelector('[data-testid="endgame-start-vs-end-section"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="endgame-games-with-without-section"]'),
    ).toBeNull();
  });

  it('references the Opponent Strength filter as plain text in the accordion paragraphs (D-13)', () => {
    overviewState.data = buildOverview();
    const { container } = renderPage();
    openConceptsAccordion(container);
    expect(screen.getAllByText(/Opponent Strength filter/).length).toBeGreaterThan(0);
  });

  // Phase 87.5 (Plan 02 SC#2 / SC#9): the renamed Endgame ELO Timeline section
  // sits directly below the Score Gap over Time chart inside the "Endgame
  // Overall Performance" group. The mocked component renders a stub div with
  // the testid `mock-endgame-elo-timeline-section` and is mounted inside the
  // `endgame-elo-timeline-section` wrapper. The score chart renders for real
  // (its outermost wrapper carries `endgame-score-timeline-chart`). We assert
  // both DOM order (compareDocumentPosition) and the section grouping (the ELO
  // wrapper is a sibling of, not a descendant of, the metrics block).
  it('renders the Endgame ELO Timeline directly below EndgameScoreOverTimeChart in the Overall Performance section', () => {
    overviewState.data = buildOverview();
    const { container } = renderPage();
    // Both surfaces appear twice (desktop tabs + mobile tabs render the same
    // statisticsContent); pick the first of each — DOM order between siblings
    // inside the same wrapper is what matters.
    const scoreCharts = container.querySelectorAll(
      '[data-testid="endgame-score-timeline-chart"]',
    );
    const eloSections = container.querySelectorAll(
      '[data-testid="endgame-elo-timeline-section"]',
    );
    expect(scoreCharts.length).toBeGreaterThanOrEqual(1);
    expect(eloSections.length).toBeGreaterThanOrEqual(1);
    const scoreChart = scoreCharts[0];
    const eloSection = eloSections[0];
    expect(scoreChart).toBeTruthy();
    expect(eloSection).toBeTruthy();
    // ELO section appears AFTER score chart in DOM order.
    const relation = scoreChart!.compareDocumentPosition(eloSection!);
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // ELO section is NOT a descendant of the mocked metrics section.
    const metricsMounts = container.querySelectorAll(
      '[data-testid="mock-endgame-metrics-section"]',
    );
    for (const metrics of metricsMounts) {
      expect(metrics.contains(eloSection!)).toBe(false);
    }
  });

  // Phase 87.5 WR-01: the parent wrapper used to gate on
  // `eloTimelineData.combos.length > 0`, which made the component's own
  // empty/error/loading branches unreachable. The wrapper now renders the
  // section whenever overview data is present and delegates empty/error/loading
  // to the component itself.
  it('renders the Endgame ELO Timeline wrapper even when combos array is empty', () => {
    const overview = buildOverview();
    overview.endgame_elo_timeline = { combos: [], timeline_window: 100 };
    overviewState.data = overview;
    const { container } = renderPage();
    const eloSections = container.querySelectorAll(
      '[data-testid="endgame-elo-timeline-section"]',
    );
    expect(eloSections.length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Click the first concepts-accordion trigger so radix mounts its
 * AccordionContent into the DOM.
 */
function openConceptsAccordion(container: HTMLElement): void {
  const trigger = container.querySelector(
    '[data-testid="endgame-concepts-trigger"] [data-slot="accordion-trigger"]',
  ) as HTMLButtonElement | null;
  if (trigger) {
    act(() => {
      fireEvent.click(trigger);
    });
  }
}
