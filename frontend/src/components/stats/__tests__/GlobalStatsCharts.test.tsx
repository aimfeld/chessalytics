// @vitest-environment jsdom
/**
 * Regression tests for GlobalStatsCharts TC-row filtering (#260606-jvg Task 2).
 *
 * Asserts that rows for disabled TCs are omitted from the "Results by Time Control"
 * panel when enabledTimeControls is a non-null array, and that all rows render
 * when enabledTimeControls is null. Also verifies the by-color panel is unaffected.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { GlobalStatsCharts } from '../GlobalStatsCharts';
import type { WDLByCategory } from '@/types/stats';

afterEach(() => {
  cleanup();
});

// WDLChartRow uses react-router Link and recharts — mock it to a simple testid div
// so the tests focus on filtering logic in GlobalStatsCharts itself.
vi.mock('@/components/charts/WDLChartRow', () => ({
  WDLChartRow: ({ testId, label }: { testId?: string; label?: ReactNode }) => (
    <div data-testid={testId}>{label}</div>
  ),
}));

// InfoPopover uses Radix Popover — stub to avoid portal/overlay complexity.
vi.mock('@/components/ui/info-popover', () => ({
  InfoPopover: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function makeCategory(label: string, total: number = 100): WDLByCategory {
  return {
    label,
    wins: 50,
    draws: 25,
    losses: 25,
    total,
    win_pct: 50,
    draw_pct: 25,
    loss_pct: 25,
  };
}

const ALL_TC_ROWS: WDLByCategory[] = [
  makeCategory('Bullet'),
  makeCategory('Blitz'),
  makeCategory('Rapid'),
  makeCategory('Classical'),
];

const COLOR_ROWS: WDLByCategory[] = [
  makeCategory('White'),
  makeCategory('Black'),
];

describe('GlobalStatsCharts TC-row filtering', () => {
  it('renders only Blitz and Rapid rows when enabledTimeControls=["blitz","rapid"]', () => {
    render(
      <GlobalStatsCharts
        byTimeControl={ALL_TC_ROWS}
        byColor={COLOR_ROWS}
        enabledTimeControls={['blitz', 'rapid']}
      />,
    );

    expect(screen.queryByTestId('global-stats-by-tc-bullet')).toBeNull();
    expect(screen.queryByTestId('global-stats-by-tc-classical')).toBeNull();
    expect(screen.queryByTestId('global-stats-by-tc-blitz')).not.toBeNull();
    expect(screen.queryByTestId('global-stats-by-tc-rapid')).not.toBeNull();
  });

  it('renders all four TC rows when enabledTimeControls is null', () => {
    render(
      <GlobalStatsCharts
        byTimeControl={ALL_TC_ROWS}
        byColor={COLOR_ROWS}
        enabledTimeControls={null}
      />,
    );

    expect(screen.queryByTestId('global-stats-by-tc-bullet')).not.toBeNull();
    expect(screen.queryByTestId('global-stats-by-tc-blitz')).not.toBeNull();
    expect(screen.queryByTestId('global-stats-by-tc-rapid')).not.toBeNull();
    expect(screen.queryByTestId('global-stats-by-tc-classical')).not.toBeNull();
  });

  it('renders all four TC rows when enabledTimeControls is undefined (default)', () => {
    render(
      <GlobalStatsCharts
        byTimeControl={ALL_TC_ROWS}
        byColor={COLOR_ROWS}
      />,
    );

    expect(screen.queryByTestId('global-stats-by-tc-bullet')).not.toBeNull();
    expect(screen.queryByTestId('global-stats-by-tc-blitz')).not.toBeNull();
    expect(screen.queryByTestId('global-stats-by-tc-rapid')).not.toBeNull();
    expect(screen.queryByTestId('global-stats-by-tc-classical')).not.toBeNull();
  });

  it('by-color rows are unaffected by enabledTimeControls', () => {
    render(
      <GlobalStatsCharts
        byTimeControl={ALL_TC_ROWS}
        byColor={COLOR_ROWS}
        enabledTimeControls={['blitz']}
      />,
    );

    // Only Blitz in by-TC
    expect(screen.queryByTestId('global-stats-by-tc-bullet')).toBeNull();
    expect(screen.queryByTestId('global-stats-by-tc-blitz')).not.toBeNull();

    // Both color rows still present
    expect(screen.queryByTestId('global-stats-by-color-white')).not.toBeNull();
    expect(screen.queryByTestId('global-stats-by-color-black')).not.toBeNull();
  });

  it('shows empty-state when enabledTimeControls filters out all TC rows', () => {
    // "bullet" only enabled but only blitz/rapid data available — all rows filtered out
    const sparseRows: WDLByCategory[] = [makeCategory('Blitz'), makeCategory('Rapid')];
    render(
      <GlobalStatsCharts
        byTimeControl={sparseRows}
        byColor={COLOR_ROWS}
        enabledTimeControls={['bullet']}
      />,
    );

    // No rows rendered — the WDLCategoryChart empty-state fires
    expect(screen.queryByTestId('global-stats-by-tc-blitz')).toBeNull();
    expect(screen.queryByTestId('global-stats-by-tc-rapid')).toBeNull();
  });
});
