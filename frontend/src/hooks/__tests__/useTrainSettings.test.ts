// @vitest-environment jsdom
/**
 * useTrainSettings.test.ts — CR-01 regression (203-REVIEW.md).
 *
 * `useReminderResurface` mounts this hook app-wide via `ProtectedLayout`
 * (App.tsx) with no gate, so a guest account got a guaranteed 403 from
 * `_reject_guest` on `GET /train/settings` on every protected page view and
 * window refocus, each captured by the global `QueryCache.onError` Sentry
 * reporter. Covers the fix: `options.enabled` gates the query off entirely,
 * mirroring `useTrainProgress`'s existing pattern (T-191-21).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { ReactNode } from 'react';

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    trainApi: {
      ...actual.trainApi,
      getSettings: vi.fn(),
    },
  };
});

import { trainApi } from '@/api/client';
import { useTrainSettings } from '@/hooks/useTrainSettings';
import type { TrainSettingsResponse } from '@/types/train';

const SETTINGS: TrainSettingsResponse = {
  timezone: 'UTC',
  weekday_mask: 5,
  puzzles_per_session: 12,
  reminder_enabled: false,
  reminder_hour: 18,
  reminder_intent_at: null,
};

function makeWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  return function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe('useTrainSettings — enabled gate (CR-01 regression)', () => {
  afterEach(() => {
    vi.mocked(trainApi.getSettings).mockReset();
  });

  it('does NOT fire GET /train/settings when enabled: false (the guest case)', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(SETTINGS);

    renderHook(() => useTrainSettings({ enabled: false }), { wrapper: makeWrapper() });

    // Give any accidental fetch a couple of ticks to have started.
    await Promise.resolve();
    await Promise.resolve();
    expect(trainApi.getSettings).not.toHaveBeenCalled();
  });

  it('fires GET /train/settings when enabled: true', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(SETTINGS);

    const { result } = renderHook(() => useTrainSettings({ enabled: true }), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(SETTINGS);
    });
    expect(trainApi.getSettings).toHaveBeenCalledTimes(1);
  });

  it('fires GET /train/settings when no options are passed at all (the two pre-existing call sites)', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(SETTINGS);

    const { result } = renderHook(() => useTrainSettings(), { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(result.current.data).toEqual(SETTINGS);
    });
    expect(trainApi.getSettings).toHaveBeenCalledTimes(1);
  });
});
