// @vitest-environment jsdom
/**
 * TrainProgressRow.test.tsx — coverage for the D-13 stats row (191-01-PLAN.md
 * Task 1 + Task 2). Mocks `@/api/client` the way `useReadiness.test.tsx` does,
 * wrapped in a QueryClientProvider with `retry: false`.
 */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
import { TrainProgressRow } from '@/components/train/TrainProgressRow';
import type { TrainProgressResponse } from '@/types/train';

afterEach(() => {
  cleanup();
  vi.mocked(trainApi.getProgress).mockReset();
});

function renderWithClient(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(<TrainProgressRow />, { wrapper: Wrapper });
}

const BASE: TrainProgressResponse = {
  settled_streak_weeks: 3,
  flame_state: 'medium',
  current_week_completed: 1,
  current_week_required: 2,
  streak_lost_last_week: false,
  mastered_count: 5,
  parked_count: 2,
};

describe('TrainProgressRow', () => {
  it('loading: renders the loading slot with no numeric text', () => {
    vi.mocked(trainApi.getProgress).mockReturnValue(new Promise(() => undefined));
    renderWithClient();

    expect(screen.getByTestId('train-progress-loading')).not.toBeNull();
    expect(screen.queryByTestId('train-stats-streak')).toBeNull();
    expect(screen.queryByText(/\d/)).toBeNull();
  });

  it('error: renders the exact CLAUDE.md copy, no numbers', async () => {
    vi.mocked(trainApi.getProgress).mockRejectedValue(new Error('boom'));
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('train-progress-error')).not.toBeNull();
    });
    expect(
      screen.getByText('Failed to load your progress. Something went wrong. Please try again in a moment.'),
    ).not.toBeNull();
  });

  it('populated: renders three chips with the expected counts', async () => {
    vi.mocked(trainApi.getProgress).mockResolvedValue(BASE);
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('train-stats-streak')).not.toBeNull();
    });
    expect(screen.getByText('3-week streak')).not.toBeNull();
    expect(screen.getByText('5 mastered')).not.toBeNull();
    expect(screen.getByText('2 parked')).not.toBeNull();
  });

  it('zero-one-many: a settled streak of 1 renders "1-week streak" (singular)', async () => {
    vi.mocked(trainApi.getProgress).mockResolvedValue({
      ...BASE,
      settled_streak_weeks: 1,
      flame_state: 'minimum',
    });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByText('1-week streak')).not.toBeNull();
    });
  });

  it('settled_streak_weeks 0 renders no streak number (D-03)', async () => {
    vi.mocked(trainApi.getProgress).mockResolvedValue({
      ...BASE,
      settled_streak_weeks: 0,
      flame_state: null,
    });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('train-stats-streak')).not.toBeNull();
    });
    expect(screen.queryByText(/week streak/)).toBeNull();
  });

  it('this-week hint (scheduled mode): "This week: N of M sessions"', async () => {
    vi.mocked(trainApi.getProgress).mockResolvedValue({
      ...BASE,
      current_week_completed: 1,
      current_week_required: 2,
    });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('train-this-week')).not.toBeNull();
    });
    expect(screen.getByText('This week: 1 of 2 sessions')).not.toBeNull();
  });

  it('this-week hint (train-anytime, singular): "This week: 1 session"', async () => {
    vi.mocked(trainApi.getProgress).mockResolvedValue({
      ...BASE,
      current_week_completed: 1,
      current_week_required: null,
    });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByText('This week: 1 session')).not.toBeNull();
    });
  });

  it('this-week hint (train-anytime, plural): "This week: 3 sessions"', async () => {
    vi.mocked(trainApi.getProgress).mockResolvedValue({
      ...BASE,
      current_week_completed: 3,
      current_week_required: null,
    });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByText('This week: 3 sessions')).not.toBeNull();
    });
  });

  it('streak-reset notice: present when streak_lost_last_week is true', async () => {
    vi.mocked(trainApi.getProgress).mockResolvedValue({
      ...BASE,
      streak_lost_last_week: true,
    });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('train-streak-reset-notice')).not.toBeNull();
    });
    expect(screen.getByText('Streak reset — start a new one this week.')).not.toBeNull();
  });

  it('streak-reset notice: absent when streak_lost_last_week is false', async () => {
    vi.mocked(trainApi.getProgress).mockResolvedValue({
      ...BASE,
      streak_lost_last_week: false,
    });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('train-this-week')).not.toBeNull();
    });
    expect(screen.queryByTestId('train-streak-reset-notice')).toBeNull();
  });
});
