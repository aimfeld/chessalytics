// @vitest-environment jsdom
/**
 * Phase 96 Plan 02 — Endgames page readiness gate tests.
 *
 * Verifies that the Endgames page whole-page tier2 lock works correctly:
 * - When tier2=false: EndgamesProcessingState renders, real Endgames content does not.
 * - When tier2=true: EndgamesProcessingState is absent, real content renders.
 * - Subtext shows the analysed/total counts (derived as totalCount - pendingCount).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';

// ── Mock useReadiness so tests control tier flags without a real endpoint.
const readinessState: {
  tier1: boolean;
  tier2: boolean;
  pendingCount: number;
  totalCount: number;
  isLoading: boolean;
} = {
  tier1: false,
  tier2: false,
  pendingCount: 0,
  totalCount: 0,
  isLoading: false,
};

vi.mock('@/hooks/useReadiness', () => ({
  useReadiness: () => ({ ...readinessState }),
}));

// ── Mock all heavy data hooks and chart components so the test renders quickly.
vi.mock('@/hooks/useEndgames', () => ({
  useEndgameOverview: () => ({ data: null, isLoading: false, isError: false }),
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

vi.mock('@/hooks/useEvalCoverage', () => ({
  useEvalCoverage: () => ({
    pendingCount: 0,
    totalCount: 0,
    pct: 100,
    isPending: false,
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useFilterStore', () => ({
  useFilterStore: () => [
    {
      platform: 'both',
      timeControl: 'all',
      rated: 'both',
      opponentType: 'human',
      color: 'both',
      matchSide: 'both',
      recentMonths: null,
    },
    vi.fn(),
  ],
}));

vi.mock('@/components/charts/EndgameOverallPerformanceSection', () => ({
  EndgameOverallPerformanceSection: () => (
    <div data-testid="mock-endgame-overall-performance-section" />
  ),
}));

vi.mock('@/components/charts/EndgameScoreOverTimeChart', () => ({
  EndgameScoreOverTimeChart: () => <div data-testid="mock-endgame-score-over-time-chart" />,
}));

vi.mock('@/components/charts/EndgameMetricsSection', () => ({
  EndgameMetricsSection: () => <div data-testid="mock-endgame-metrics-section" />,
}));

vi.mock('@/components/charts/EndgameTypeBreakdownSection', () => ({
  EndgameTypeBreakdownSection: () => (
    <div data-testid="mock-endgame-type-breakdown-section" />
  ),
}));

vi.mock('@/components/charts/EndgameTimePressureSection', () => ({
  EndgameTimePressureSection: () => <div data-testid="mock-endgame-time-pressure-section" />,
}));

vi.mock('@/components/charts/EndgameClockDiffOverTimeChart', () => ({
  EndgameClockDiffOverTimeChart: () => (
    <div data-testid="mock-endgame-clock-diff-chart" />
  ),
}));

vi.mock('@/components/charts/EndgameEloTimelineSection', () => ({
  EndgameEloTimelineSection: () => <div data-testid="mock-endgame-elo-timeline-section" />,
}));

vi.mock('@/components/results/GameCardList', () => ({
  GameCardList: () => <div data-testid="mock-game-card-list" />,
}));

vi.mock('@/components/charts/PositionResultsPanel', () => ({
  PositionResultsPanel: () => <div data-testid="mock-position-results-panel" />,
}));

vi.mock('@/components/insights/EndgameInsightsBlock', () => ({
  EndgameInsightsBlock: () => <div data-testid="mock-endgame-insights-block" />,
}));

// jsdom shims required by the component.
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

afterEach(() => {
  cleanup();
  // Reset to default locked state after each test.
  readinessState.tier1 = false;
  readinessState.tier2 = false;
  readinessState.pendingCount = 0;
  readinessState.totalCount = 0;
  readinessState.isLoading = false;
});

import { EndgamesPage } from '../Endgames';

// ── Render helper ──────────────────────────────────────────────────────────────
function renderEndgames(initialPath = '/endgames/stats') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <TooltipProvider>
        <EndgamesPage />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Endgames readiness gate', () => {
  it('renders EndgamesProcessingState when tier2=false', () => {
    readinessState.tier2 = false;
    readinessState.pendingCount = 400;
    readinessState.totalCount = 500;

    renderEndgames();

    expect(screen.getByTestId('endgames-processing-state')).toBeTruthy();
    // Real Endgames page content should not render.
    expect(screen.queryByTestId('endgames-page')).toBeNull();
  });

  it('does not render EndgamesProcessingState when tier2=true', () => {
    readinessState.tier1 = true;
    readinessState.tier2 = true;
    readinessState.pendingCount = 0;
    readinessState.totalCount = 500;

    renderEndgames();

    expect(screen.queryByTestId('endgames-processing-state')).toBeNull();
    // The real Endgames page container should render.
    expect(screen.getByTestId('endgames-page')).toBeTruthy();
  });

  it('shows correct analysed/total counts in processing state subtext', () => {
    readinessState.tier2 = false;
    readinessState.pendingCount = 200;
    readinessState.totalCount = 500;

    renderEndgames();

    // analysedCount = Math.max(500 - 200, 0) = 300
    const processingState = screen.getByTestId('endgames-processing-state');
    expect(processingState.textContent).toContain('300');
    expect(processingState.textContent).toContain('500');
    // The "Quick Scan" subtext pattern (banner reframed from "Stockfish")
    expect(processingState.textContent).toMatch(/Quick Scan.*300.*\/.*500.*games/);
  });

  it('shows 0 analysed when totalCount is 0', () => {
    readinessState.tier2 = false;
    // Edge case: totalCount not yet populated
    readinessState.pendingCount = 0;
    readinessState.totalCount = 0;

    renderEndgames();

    const processingState = screen.getByTestId('endgames-processing-state');
    // Both should show 0
    expect(processingState.textContent).toMatch(/Quick Scan.*0.*\/.*0.*games/);
  });
});
