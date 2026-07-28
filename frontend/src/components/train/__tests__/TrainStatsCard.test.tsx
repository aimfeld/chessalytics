// @vitest-environment jsdom
/**
 * TrainStatsCard.test.tsx — coverage for the drill-pool statistics card
 * (193 UAT round 2; mastered/parked split out of the old TrainProgressRow,
 * plus the completed state's "Scored today" row). Mocks `@/api/client` the
 * way TrainStreakCard.test.tsx does.
 */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    trainApi: {
      ...actual.trainApi,
      getProgress: vi.fn(),
    },
  };
});

import { trainApi } from '@/api/client';
import { TrainStatsCard } from '@/components/train/TrainStatsCard';
import type { TrainProgressResponse } from '@/types/train';

afterEach(() => {
  cleanup();
  vi.mocked(trainApi.getProgress).mockReset();
});

function renderWithClient(todayScore?: { total: number; max: number }): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(<TrainStatsCard todayScore={todayScore} />, { wrapper: Wrapper });
}

const BASE: TrainProgressResponse = {
  session_streak_count: 3,
  shield_level: 5,
  current_week_completed: 1,
  current_week_required: 2,
  streak_reset_notice: false,
  mastered_count: 5,
  parked_count: 2,
  waiting_count: 0,
  pool_state: 'available',
  next_due_date: null,
  badge_visible: false,
};

describe('TrainStatsCard', () => {
  it('loading: renders the card shell with no numeric text', () => {
    vi.mocked(trainApi.getProgress).mockReturnValue(new Promise(() => undefined));
    renderWithClient();

    expect(screen.getByTestId('train-stats-loading')).not.toBeNull();
    expect(screen.queryByTestId('train-stats-mastered')).toBeNull();
    expect(screen.queryByText(/\d/)).toBeNull();
  });

  it('error: renders the exact CLAUDE.md copy, no numbers', async () => {
    vi.mocked(trainApi.getProgress).mockRejectedValue(new Error('boom'));
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('train-stats-error')).not.toBeNull();
    });
    expect(
      screen.getByText('Failed to load your progress. Something went wrong. Please try again in a moment.'),
    ).not.toBeNull();
    expect(screen.queryByTestId('train-stats-mastered')).toBeNull();
  });

  it('populated: renders mastered/parked as label-value rows under a "Puzzle pool" header', async () => {
    vi.mocked(trainApi.getProgress).mockResolvedValue(BASE);
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('train-stats-mastered')).not.toBeNull();
    });
    // 193 UAT round 3: "Statistics" said nothing about what the numbers are.
    expect(screen.getByText('Puzzle pool')).not.toBeNull();
    expect(screen.queryByText('Statistics')).toBeNull();
    expect(screen.getByTestId('train-stats-mastered').textContent).toBe('Mastered5');
    expect(screen.getByTestId('train-stats-parked').textContent).toBe('Parked2');
  });

  describe('jargon popovers (193 UAT round 3)', () => {
    it('both SR terms carry an info trigger — neither is defined anywhere else on the page', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue(BASE);
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-stats-mastered')).not.toBeNull();
      });
      expect(screen.getByTestId('train-mastered-info').getAttribute('aria-label')).toBe(
        'What mastered means',
      );
      expect(screen.getByTestId('train-parked-info').getAttribute('aria-label')).toBe(
        'What parked means',
      );
    });

    it('the explainers stay OUT of the card body until the trigger is opened', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue(BASE);
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-stats-parked')).not.toBeNull();
      });
      expect(screen.queryByText(/set aside so they stop resurfacing/)).toBeNull();

      fireEvent.click(screen.getByTestId('train-parked-info'));
      await waitFor(() => {
        expect(screen.getByText(/set aside so they stop resurfacing/)).not.toBeNull();
      });
    });
  });

  it('omits the score row when no todayScore is passed (session not completed)', async () => {
    vi.mocked(trainApi.getProgress).mockResolvedValue(BASE);
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('train-stats-mastered')).not.toBeNull();
    });
    expect(screen.queryByTestId('train-stats-today-score')).toBeNull();
  });

  it('spells out "points" in the score row — a bare N/M reads as a puzzle count', async () => {
    vi.mocked(trainApi.getProgress).mockResolvedValue(BASE);
    renderWithClient({ total: 4, max: 9 });

    await waitFor(() => {
      expect(screen.getByTestId('train-stats-today-score')).not.toBeNull();
    });
    expect(screen.getByTestId('train-stats-today-score').textContent).toBe('Scored today4 of 9 points');
  });

  it('renders a zero score rather than hiding it (0 of 9 is a real result)', async () => {
    vi.mocked(trainApi.getProgress).mockResolvedValue(BASE);
    renderWithClient({ total: 0, max: 9 });

    await waitFor(() => {
      expect(screen.getByTestId('train-stats-today-score')).not.toBeNull();
    });
    expect(screen.getByText('0 of 9 points')).not.toBeNull();
  });
});
