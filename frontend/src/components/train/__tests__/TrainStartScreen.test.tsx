// @vitest-environment jsdom
/**
 * TrainStartScreen.test.tsx — coverage for all six landing states
 * (D-01..D-04, D-14, plus loading/error) per 190-04-PLAN.md Task 1.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// 191-01/191-06: TrainStartScreen calls useTrainProgress() directly (for the
// PROG-05/D-16 tailored empty states) AND renders <TrainProgressRow />
// internally, which calls the SAME hook — mocked once here with a mutable
// module-level object so both call sites read the identical resolved value
// per test, mirroring App.test.tsx's `trainProgressData` pattern
// (TrainProgressRow.test.tsx covers the hook's own loading/error/populated
// states in isolation).
const DEFAULT_TRAIN_PROGRESS: TrainProgressResponse = {
  settled_streak_weeks: 0,
  flame_state: null,
  current_week_completed: 0,
  current_week_required: null,
  streak_lost_last_week: false,
  mastered_count: 0,
  parked_count: 0,
  waiting_count: 0,
  pool_state: 'available',
  next_due_date: null,
};

let trainProgressMock: {
  data: TrainProgressResponse | undefined;
  isPending: boolean;
  isError: boolean;
} = {
  data: DEFAULT_TRAIN_PROGRESS,
  isPending: false,
  isError: false,
};

vi.mock('@/hooks/useTrainProgress', () => ({
  useTrainProgress: () => trainProgressMock,
}));

// 191-04: TrainStartScreen renders <TrainScheduleSettings /> internally,
// which calls useTrainSettings() — mocked here with a resolved stub
// (TrainScheduleSettings.test.tsx covers the hook's own loading/error/save
// states in isolation) so the six pre-existing landing-state assertions keep
// passing without a QueryClientProvider.
// 191-06: `save` synchronously invokes its `onSuccess` callback AND updates
// `mockTrainSettingsData` in place, mirroring the real hook's "writes the
// fresh row into its own cache on success" behavior (191-04-SUMMARY.md) —
// this lets the "onSettingsSaved wiring" test below exercise the real
// TrainScheduleSettings -> TrainStartScreen -> caller callback chain without
// a QueryClientProvider or real network mock. Without this, the mock's
// `data` would keep reporting stale values forever after a save, and
// TrainScheduleSettings's "already matches what the server confirmed" guard
// would never trip — re-firing `save()` on every unrelated re-render.
let mockTrainSettingsData = { timezone: 'UTC', weekday_mask: 127, puzzles_per_session: 6 };

const saveMock = vi.fn(
  (
    body: { weekdayMask: number; puzzlesPerSession: number },
    opts?: { onSuccess?: () => void },
  ) => {
    mockTrainSettingsData = {
      ...mockTrainSettingsData,
      weekday_mask: body.weekdayMask,
      puzzles_per_session: body.puzzlesPerSession,
    };
    opts?.onSuccess?.();
  },
);

vi.mock('@/hooks/useTrainSettings', () => ({
  useTrainSettings: () => ({
    data: mockTrainSettingsData,
    isPending: false,
    isError: false,
    save: saveMock,
    isSaving: false,
    isSaveError: false,
    isSaveSuccess: false,
  }),
}));

import { TrainStartScreen } from '@/components/train/TrainStartScreen';
import { TRAIN_SETTINGS_SAVE_DEBOUNCE_MS } from '@/components/train/TrainScheduleSettings';
import type { TrainProgressResponse, TrainPuzzle, TrainSessionResponse } from '@/types/train';

afterEach(() => {
  cleanup();
  trainProgressMock = { data: DEFAULT_TRAIN_PROGRESS, isPending: false, isError: false };
  saveMock.mockClear();
  mockTrainSettingsData = { timezone: 'UTC', weekday_mask: 127, puzzles_per_session: 6 };
});

const STUB_PUZZLE: TrainPuzzle = {
  position: 4,
  game_id: 1,
  ply: 10,
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  side_to_move: 'white',
  last_move_uci: null,
};

const BASE_SESSION: TrainSessionResponse = {
  session_id: 1,
  session_date: '2026-07-25',
  expires_on: '2026-07-26',
  puzzle_count: 10,
  requested_count: 10,
  solved_count: 0,
  blob_pending_count: 0,
  puzzles: [],
};

// D-04: session_id null and puzzle_count 0 is the shape that reaches the
// 'empty' landing state, which the PROG-05/D-16 tailored bodies branch from.
const EMPTY_SESSION: TrainSessionResponse = {
  ...BASE_SESSION,
  session_id: null,
  puzzle_count: 0,
  solved_count: 0,
  blob_pending_count: 0,
};

function renderScreen(props: Partial<Parameters<typeof TrainStartScreen>[0]> = {}) {
  const onEnterLoop = vi.fn();
  const onSettingsSaved = vi.fn();
  render(
    <MemoryRouter>
      <TrainStartScreen
        session={BASE_SESSION}
        isLoading={false}
        isError={false}
        sessionScore={0}
        onEnterLoop={onEnterLoop}
        onSettingsSaved={onSettingsSaved}
        {...props}
      />
    </MemoryRouter>,
  );
  return { onEnterLoop, onSettingsSaved };
}

describe('TrainStartScreen — six landing states', () => {
  it('loading: renders the muted text-only loading node, nothing else', () => {
    renderScreen({ isLoading: true, session: null });
    expect(screen.getByTestId('train-session-loading')).not.toBeNull();
    expect(screen.queryByTestId('train-start-screen')).toBeNull();
  });

  it('error: shows the shared LoadError text, never the empty-state heading', () => {
    renderScreen({ isError: true, session: null });
    expect(screen.getByText(/Failed to load your training session/)).not.toBeNull();
    expect(screen.queryByText('No puzzles available yet')).toBeNull();
    expect(screen.queryByTestId('train-session-loading')).toBeNull();
  });

  it('empty: session_id null and puzzle_count 0 renders the plain D-04 placeholder, no crash, no action button', () => {
    renderScreen({
      session: { ...BASE_SESSION, session_id: null, puzzle_count: 0, solved_count: 0, blob_pending_count: 0 },
    });
    expect(screen.getByText('No puzzles available yet')).not.toBeNull();
    expect(screen.getByText('Analyze more games to build your training pool.')).not.toBeNull();
    expect(screen.queryByTestId('btn-train-start')).toBeNull();
  });

  it('fresh: full session with zero pending blobs shows "N puzzles waiting" + Start', () => {
    const { onEnterLoop } = renderScreen({
      session: { ...BASE_SESSION, puzzle_count: 10, requested_count: 10, blob_pending_count: 0 },
    });
    expect(screen.getByText('10 puzzles waiting')).not.toBeNull();
    expect(screen.queryByText(/still being analyzed/)).toBeNull();
    expect(screen.getByTestId('train-progress-row')).not.toBeNull();
    const btn = screen.getByTestId('btn-train-start');
    btn.click();
    expect(onEnterLoop).toHaveBeenCalledTimes(1);
  });

  it('short (positive case): pending blobs AND puzzle_count below requested shows "N puzzles ready" + the notice', () => {
    renderScreen({
      session: { ...BASE_SESSION, puzzle_count: 4, requested_count: 10, blob_pending_count: 3 },
    });
    expect(screen.getByText('4 puzzles ready')).not.toBeNull();
    expect(screen.getByText('More of your games are still being analyzed.')).not.toBeNull();
    expect(screen.getByTestId('btn-train-start')).not.toBeNull();
  });

  it('short negative case 1: pending blobs but a FULL session shows no notice (fresh copy instead)', () => {
    renderScreen({
      session: { ...BASE_SESSION, puzzle_count: 10, requested_count: 10, blob_pending_count: 5 },
    });
    expect(screen.getByText('10 puzzles waiting')).not.toBeNull();
    expect(screen.queryByText(/still being analyzed/)).toBeNull();
  });

  it('short negative case 2: puzzle_count below requested but zero pending blobs shows the FRESH copy, no notice', () => {
    renderScreen({
      session: { ...BASE_SESSION, puzzle_count: 4, requested_count: 10, blob_pending_count: 0 },
    });
    expect(screen.getByText('4 puzzles waiting')).not.toBeNull();
    expect(screen.queryByText(/still being analyzed/)).toBeNull();
    expect(screen.queryByText('4 puzzles ready')).toBeNull();
  });

  it('resume: an open session with solved > 0 and solved < total shows the Resume button labelled with counts', () => {
    // A real resume response always carries the remaining unsolved puzzles
    // (load_session_puzzles) — an empty array with progress means completed.
    const { onEnterLoop } = renderScreen({
      session: { ...BASE_SESSION, puzzle_count: 12, solved_count: 4, puzzles: [STUB_PUZZLE] },
    });
    const btn = screen.getByTestId('btn-train-resume');
    expect(btn.textContent).toBe('Resume session — 4 of 12 done');
    expect(screen.queryByTestId('btn-train-start')).toBeNull();
    btn.click();
    expect(onEnterLoop).toHaveBeenCalledTimes(1);
  });

  it('completed: solved === puzzle_count shows the score recap + next-session date, no Start/Resume button', () => {
    renderScreen({
      session: { ...BASE_SESSION, puzzle_count: 6, solved_count: 6, expires_on: '2026-08-01' },
      sessionScore: 9,
    });
    expect(screen.getByText('You scored 9/12 today.')).not.toBeNull();
    expect(screen.getByText('Next session: Aug 1, 2026')).not.toBeNull();
    expect(screen.queryByTestId('btn-train-start')).toBeNull();
    expect(screen.queryByTestId('btn-train-resume')).toBeNull();
  });

  it('completed (lazy-eviction shape): solved < puzzle_count but no puzzles left still shows the recap, never a dead Resume button', () => {
    // WR-02: a session can be marked completed with an unsolved lazily-evicted
    // row, so the completed-in-window response carries solved_count <
    // puzzle_count and an empty puzzles array.
    renderScreen({
      session: { ...BASE_SESSION, puzzle_count: 6, solved_count: 5, expires_on: '2026-08-01' },
      sessionScore: 7,
    });
    expect(screen.getByText('You scored 7/12 today.')).not.toBeNull();
    expect(screen.getByText('Next session: Aug 1, 2026')).not.toBeNull();
    expect(screen.queryByTestId('btn-train-start')).toBeNull();
    expect(screen.queryByTestId('btn-train-resume')).toBeNull();
  });

  it('every state shares the "Train" heading text sizing floor (no text-xs/sub-floor usage)', () => {
    renderScreen();
    expect(screen.getByText('Train')).not.toBeNull();
  });

  it('D-13: the schedule settings block renders after the Start CTA in the fresh state', () => {
    renderScreen();
    const btn = screen.getByTestId('btn-train-start');
    const settings = screen.getByTestId('train-schedule-settings');
    expect(btn.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('191-06 UAT bug fix: a persisted schedule-settings edit calls onSettingsSaved, so the stale mount-time session gets re-fetched', async () => {
    const { onSettingsSaved } = renderScreen();
    expect(onSettingsSaved).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('filter-weekday-fr'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, TRAIN_SETTINGS_SAVE_DEBOUNCE_MS + 100));
    });

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(onSettingsSaved).toHaveBeenCalledTimes(1);
  });
});

describe('TrainStartScreen — PROG-05/D-16 tailored cold/exhausted empty states (191-06)', () => {
  it('no_material: renders the cold-start heading/subtitle and an Import games link to /library/import, with no progress row', () => {
    trainProgressMock = {
      data: { ...DEFAULT_TRAIN_PROGRESS, pool_state: 'no_material' },
      isPending: false,
      isError: false,
    };
    renderScreen({ session: EMPTY_SESSION });
    expect(screen.getByTestId('train-empty-no-material')).not.toBeNull();
    expect(screen.getByText('Import & analyze your games to start training')).not.toBeNull();
    expect(screen.getByText("Train drills your own blunders once they're analyzed.")).not.toBeNull();
    const link = screen.getByTestId('btn-train-import-games');
    expect(link.getAttribute('href')).toBe('/library/import');
    expect(screen.queryByTestId('train-progress-row')).toBeNull();
  });

  it('exhausted: renders "All caught up!", the mastered count, a Next review line, and the progress row', () => {
    trainProgressMock = {
      data: { ...DEFAULT_TRAIN_PROGRESS, pool_state: 'exhausted', mastered_count: 7, next_due_date: '2026-08-03' },
      isPending: false,
      isError: false,
    };
    renderScreen({ session: EMPTY_SESSION });
    const emptyBlock = screen.getByTestId('train-empty-exhausted');
    expect(emptyBlock).not.toBeNull();
    expect(within(emptyBlock).getByText('All caught up!')).not.toBeNull();
    expect(within(emptyBlock).getByText(/7 mastered/)).not.toBeNull();
    expect(within(emptyBlock).getByText(/Next review:/)).not.toBeNull();
    expect(screen.getByTestId('train-progress-row')).not.toBeNull();
  });

  it('exhausted with no next-due date: renders the "Nothing due right now" copy and no "Next review:" text', () => {
    trainProgressMock = {
      data: { ...DEFAULT_TRAIN_PROGRESS, pool_state: 'exhausted', mastered_count: 3, next_due_date: null },
      isPending: false,
      isError: false,
    };
    renderScreen({ session: EMPTY_SESSION });
    const emptyBlock = screen.getByTestId('train-empty-exhausted');
    expect(within(emptyBlock).getByText(/Nothing due right now — nice work\./)).not.toBeNull();
    expect(within(emptyBlock).queryByText(/Next review:/)).toBeNull();
  });

  it('pending progress query: falls back to the generic Phase-190 empty copy, neither tailored testid appears', () => {
    trainProgressMock = { data: undefined, isPending: true, isError: false };
    renderScreen({ session: EMPTY_SESSION });
    expect(screen.getByText('No puzzles available yet')).not.toBeNull();
    expect(screen.queryByTestId('train-empty-no-material')).toBeNull();
    expect(screen.queryByTestId('train-empty-exhausted')).toBeNull();
  });

  it('errored progress query: falls back to the generic Phase-190 empty copy, neither tailored testid appears', () => {
    trainProgressMock = { data: undefined, isPending: false, isError: true };
    renderScreen({ session: EMPTY_SESSION });
    expect(screen.getByText('No puzzles available yet')).not.toBeNull();
    expect(screen.queryByTestId('train-empty-no-material')).toBeNull();
    expect(screen.queryByTestId('train-empty-exhausted')).toBeNull();
  });

  it('pool_state available: falls back to the generic Phase-190 empty copy', () => {
    trainProgressMock = {
      data: { ...DEFAULT_TRAIN_PROGRESS, pool_state: 'available' },
      isPending: false,
      isError: false,
    };
    renderScreen({ session: EMPTY_SESSION });
    expect(screen.getByText('No puzzles available yet')).not.toBeNull();
    expect(screen.queryByTestId('train-empty-no-material')).toBeNull();
    expect(screen.queryByTestId('train-empty-exhausted')).toBeNull();
  });

  it('a non-empty (fresh) session renders no empty state at all, even with a resolved no_material pool_state', () => {
    trainProgressMock = {
      data: { ...DEFAULT_TRAIN_PROGRESS, pool_state: 'no_material' },
      isPending: false,
      isError: false,
    };
    renderScreen();
    expect(screen.queryByTestId('train-empty-no-material')).toBeNull();
    expect(screen.queryByTestId('train-empty-exhausted')).toBeNull();
    expect(screen.queryByText('No puzzles available yet')).toBeNull();
  });
});
