// @vitest-environment jsdom
/**
 * TrainScheduleSettings.test.tsx — coverage for the auto-saving weekday +
 * puzzles-per-session picker (191-04-PLAN.md Task 1, SCHD-01, D-09..D-12).
 * Mocks `@/api/client` (TrainProgressRow.test.tsx's precedent), wrapped in a
 * QueryClientProvider with `retry: false`.
 *
 * Uses REAL timers (not `vi.useFakeTimers()`): `waitFor`'s MutationObserver
 * polling and fake timers interact badly when this project has no global
 * `jest` shim (dom-testing-library's fake-timer detection requires it — see
 * `wait-for.js`'s `jestFakeTimersAreEnabled`), so the debounce window is
 * advanced by actually waiting past it in real time instead.
 */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    trainApi: {
      ...actual.trainApi,
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
    },
  };
});

import { trainApi } from '@/api/client';
import {
  TrainScheduleSettings,
  PUZZLES_PER_SESSION_PRESETS,
  TRAIN_SETTINGS_SAVE_DEBOUNCE_MS,
} from '@/components/train/TrainScheduleSettings';
import type { TrainSettingsResponse, TrainSettingsUpdate } from '@/types/train';

// Mon (bit 0) + Wed (bit 2) = 0b0000101 = 5.
const BASE_SETTINGS: TrainSettingsResponse = {
  timezone: 'UTC',
  weekday_mask: 5,
  puzzles_per_session: 12,
};

function renderWithClient(onSaved?: () => void): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(<TrainScheduleSettings onSaved={onSaved} />, { wrapper: Wrapper });
  return client;
}

/** Real-time wait past the debounce window, wrapped in `act` so the
 * resulting `save()` call's state updates are flushed. */
async function advanceDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, TRAIN_SETTINGS_SAVE_DEBOUNCE_MS + 100));
  });
}

afterEach(() => {
  cleanup();
  vi.mocked(trainApi.getSettings).mockReset();
  vi.mocked(trainApi.updateSettings).mockReset();
});

describe('TrainScheduleSettings', () => {
  it('loading: every weekday chip and puzzles preset renders disabled', () => {
    vi.mocked(trainApi.getSettings).mockReturnValue(new Promise(() => undefined));
    renderWithClient();

    expect(screen.getByTestId('filter-weekday-mo').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('filter-weekday-su').hasAttribute('disabled')).toBe(true);
    for (const n of PUZZLES_PER_SESSION_PRESETS) {
      expect(screen.getByTestId(`filter-puzzles-${n}`).hasAttribute('disabled')).toBe(true);
    }
  });

  it('populated: Mo and We chips are pressed, the other five are not (weekday_mask = 5)', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    renderWithClient();

    // Weekday chips are ToggleChipButton (plain <button aria-pressed>), not
    // the Radix ToggleGroup (which would expose data-state) — 191-06 restyle
    // to match FilterPanel's "Time control" multi-select pattern.
    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-mo').getAttribute('aria-pressed')).toBe('true');
    });
    expect(screen.getByTestId('filter-weekday-we').getAttribute('aria-pressed')).toBe('true');
    for (const testId of [
      'filter-weekday-tu',
      'filter-weekday-th',
      'filter-weekday-fr',
      'filter-weekday-sa',
      'filter-weekday-su',
    ]) {
      expect(screen.getByTestId(testId).getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('mount with no interaction issues zero updateSettings calls', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-mo').hasAttribute('disabled')).toBe(false);
    });
    await advanceDebounce();
    expect(trainApi.updateSettings).not.toHaveBeenCalled();
  });

  it('clicking the Fr chip issues exactly one updateSettings call after the debounce window, with weekday_mask = previous mask + bit 4', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, weekday_mask: 21 });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-fr').hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByTestId('filter-weekday-fr'));
    await advanceDebounce();

    expect(trainApi.updateSettings).toHaveBeenCalledTimes(1);
    const call = vi.mocked(trainApi.updateSettings).mock.calls[0];
    expect(call).toBeDefined();
    const body = call?.[0] as TrainSettingsUpdate;
    expect(body.weekday_mask).toBe(5 | (1 << 4)); // 21
  });

  it('deselecting the last remaining chip issues an updateSettings call with weekday_mask: 0 and renders no validation error', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue({ ...BASE_SETTINGS, weekday_mask: 1 }); // Mon only
    vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, weekday_mask: 0 });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-mo').getAttribute('aria-pressed')).toBe('true');
    });
    fireEvent.click(screen.getByTestId('filter-weekday-mo'));
    await advanceDebounce();

    expect(trainApi.updateSettings).toHaveBeenCalledTimes(1);
    const call = vi.mocked(trainApi.updateSettings).mock.calls[0];
    const body = call?.[0] as TrainSettingsUpdate;
    expect(body.weekday_mask).toBe(0);
    expect(screen.queryByText(/required|invalid|must select/i)).toBeNull();
  });

  it('selecting the 15 preset issues one updateSettings call with puzzles_per_session: 15', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, puzzles_per_session: 15 });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('filter-puzzles-15').hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByTestId('filter-puzzles-15'));
    await advanceDebounce();

    expect(trainApi.updateSettings).toHaveBeenCalledTimes(1);
    const call = vi.mocked(trainApi.updateSettings).mock.calls[0];
    const body = call?.[0] as TrainSettingsUpdate;
    expect(body.puzzles_per_session).toBe(15);
  });

  it('every captured updateSettings body carries a non-empty timezone, never rendered in the output', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, weekday_mask: 21 });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-fr').hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByTestId('filter-weekday-fr'));
    await advanceDebounce();

    const call = vi.mocked(trainApi.updateSettings).mock.calls[0];
    const body = call?.[0] as TrainSettingsUpdate;
    expect(body.timezone.length).toBeGreaterThan(0);
    expect(screen.queryByText(body.timezone)).toBeNull();
    expect(screen.queryByText(/UTC|GMT|\//)).toBeNull();
  });

  it('a rejected updateSettings renders "Couldn\'t save. Try again." and the clicked chip stays pressed', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(trainApi.updateSettings).mockRejectedValue(new Error('network down'));
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-fr').hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByTestId('filter-weekday-fr'));
    await advanceDebounce();

    await waitFor(() => {
      expect(screen.getByText("Couldn't save. Try again.")).not.toBeNull();
    });
    expect(screen.getByTestId('filter-weekday-fr').getAttribute('aria-pressed')).toBe('true');
  });

  it('a resolved updateSettings renders "Saved"', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, weekday_mask: 21 });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-fr').hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByTestId('filter-weekday-fr'));
    await advanceDebounce();

    await waitFor(() => {
      expect(screen.getByTestId('train-settings-saved')).not.toBeNull();
    });
    expect(screen.getByText('Saved')).not.toBeNull();
  });

  it('191-06 UAT bug fix: a resolved updateSettings calls onSaved exactly once', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, weekday_mask: 21 });
    const onSaved = vi.fn();
    renderWithClient(onSaved);

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-fr').hasAttribute('disabled')).toBe(false);
    });
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('filter-weekday-fr'));
    await advanceDebounce();

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });

  it('191-06: a rejected updateSettings never calls onSaved', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(trainApi.updateSettings).mockRejectedValue(new Error('network down'));
    const onSaved = vi.fn();
    renderWithClient(onSaved);

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-fr').hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByTestId('filter-weekday-fr'));
    await advanceDebounce();

    await waitFor(() => {
      expect(screen.getByText("Couldn't save. Try again.")).not.toBeNull();
    });
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('a rejected settings query renders the load-error block and no chips', async () => {
    vi.mocked(trainApi.getSettings).mockRejectedValue(new Error('boom'));
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByText(/Failed to load your training schedule/)).not.toBeNull();
    });
    expect(screen.queryByTestId('filter-weekday-mo')).toBeNull();
  });
});
