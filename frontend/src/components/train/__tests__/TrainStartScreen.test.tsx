// @vitest-environment jsdom
/**
 * TrainStartScreen.test.tsx — coverage for all six landing states
 * (D-01..D-04, D-14, plus loading/error) per 190-04-PLAN.md Task 1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// 191-01/191-06: TrainStartScreen calls useTrainProgress() directly (for the
// PROG-05/D-16 tailored empty states) AND renders <TrainStreakCard /> +
// <TrainStatsCard /> internally, which call the SAME hook — mocked once here
// with a mutable module-level object so every call site reads the identical
// resolved value per test, mirroring App.test.tsx's `trainProgressData`
// pattern (TrainStreakCard.test.tsx / TrainStatsCard.test.tsx cover the
// hook's own loading/error/populated states in isolation).
const DEFAULT_TRAIN_PROGRESS: TrainProgressResponse = {
  session_streak_count: 0,
  shield_level: 0,
  current_week_completed: 0,
  current_week_required: null,
  streak_reset_notice: false,
  mastered_count: 0,
  parked_count: 0,
  waiting_count: 0,
  pool_state: 'available',
  next_due_date: null,
  badge_visible: false,
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

// Phase 202 Plan 02: TrainScheduleSettings now also calls usePushCapability(),
// which internally calls useQuery() — mocked here for the same reason as
// useTrainSettings above (a real hook call would throw "No QueryClient set"
// without a QueryClientProvider this file deliberately does not add).
// `available: false` keeps the reminder block absent, matching this file's
// six pre-existing landing-state assertions exactly as they were before this
// phase (TrainScheduleSettings.test.tsx covers the reminder block itself).
//
// WR-01 (203-REVIEW.md) made this mutable: TrainReminderResurfaceBanner now
// gates on the capability probe too, so a banner test asserting the CTA
// renders must ALSO say push is available. The default stays `available:
// false` so the six landing-state assertions are untouched; only the
// banner-ordering block below opts in.
let capabilityMock = {
  isResolved: true,
  available: false,
  vapidPublicKey: null as string | null,
  permission: 'default' as NotificationPermission,
};

vi.mock('@/hooks/usePushCapability', () => ({
  usePushCapability: () => capabilityMock,
}));

// Phase 203 Plan 04 (OFFER-05): TrainStartScreen mounts
// <TrainReminderResurfaceBanner /> as an ADDITIVE first element, never a
// seventh `resolveLandingState` branch — mocked here so the six pre-existing
// landing-state assertions below stay unaffected (`shouldResurface: false`
// by default renders nothing, matching today's behavior exactly).
let resurfaceMock: { shouldResurface: boolean } = { shouldResurface: false };

vi.mock('@/hooks/useReminderResurface', () => ({
  useReminderResurface: () => ({
    shouldResurface: resurfaceMock.shouldResurface,
    dismiss: vi.fn(),
    isResolved: true,
    markSubscribed: vi.fn(),
  }),
  TRAIN_RESURFACE_DISMISSED_KEY: 'train-resurface-dismissed',
}));

import { TrainStartScreen } from '@/components/train/TrainStartScreen';
import { TRAIN_SETTINGS_SAVE_DEBOUNCE_MS } from '@/components/train/TrainScheduleSettings';
import type { TrainProgressResponse, TrainPuzzle, TrainSessionResponse } from '@/types/train';

afterEach(() => {
  cleanup();
  trainProgressMock = { data: DEFAULT_TRAIN_PROGRESS, isPending: false, isError: false };
  saveMock.mockClear();
  mockTrainSettingsData = { timezone: 'UTC', weekday_mask: 127, puzzles_per_session: 6 };
  resurfaceMock = { shouldResurface: false };
  // WR-01: restore the file-wide default so the banner block's opt-in cannot
  // leak into the six landing-state assertions above it.
  capabilityMock = {
    isResolved: true,
    available: false,
    vapidPublicKey: null,
    permission: 'default' as NotificationPermission,
  };
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
  solved_results: [],
  is_warmup: false,
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

  // 193 UAT round 3: the puzzle count moved off its own loose line INTO the
  // button label, matching the shape 'resume' already used. The state
  // distinction that used to live in two different count sentences ("waiting"
  // vs. "ready") is now carried solely by the still-being-analyzed notice.
  it('fresh: full session with zero pending blobs labels Start with the count, no notice', () => {
    const { onEnterLoop } = renderScreen({
      session: { ...BASE_SESSION, puzzle_count: 10, requested_count: 10, blob_pending_count: 0 },
    });
    const btn = screen.getByTestId('btn-train-start');
    expect(btn.textContent).toBe('Start session — 10 puzzles');
    expect(screen.queryByText(/still being analyzed/)).toBeNull();
    expect(screen.getByTestId('train-streak-card')).not.toBeNull();
    btn.click();
    expect(onEnterLoop).toHaveBeenCalledTimes(1);
  });

  it('fresh: a one-puzzle session says "1 puzzle" (singular)', () => {
    renderScreen({
      session: { ...BASE_SESSION, puzzle_count: 1, requested_count: 1, blob_pending_count: 0 },
    });
    expect(screen.getByTestId('btn-train-start').textContent).toBe('Start session — 1 puzzle');
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
    // 193 UAT round 2: the max is puzzle_count * TRAIN_POINTS_PER_PUZZLE (3),
    // not the stale hardcoded * 2 this assertion used to bake in.
    expect(screen.getByTestId('train-stats-today-score').textContent).toBe('Scored today9 of 18 points');
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
    expect(screen.getByTestId('train-stats-today-score').textContent).toBe('Scored today7 of 18 points');
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

describe('TrainStartScreen — Phase 206 D-06/D-08/D-09 warm-up banner (replaces the dead "short" state)', () => {
  it('is_warmup true, solved_count 0: renders exactly one warm-up banner with the locked title', () => {
    renderScreen({
      session: { ...BASE_SESSION, puzzle_count: 8, requested_count: 8, is_warmup: true },
    });
    expect(screen.getAllByTestId('train-warmup-banner')).toHaveLength(1);
    expect(screen.getByTestId('train-warmup-banner-title').textContent).toBe('Warm-up session');
    expect(screen.getByTestId('btn-train-start').textContent).toBe('Start session — 8 puzzles');
  });

  it('is_warmup false: renders no warm-up banner', () => {
    renderScreen({
      session: { ...BASE_SESSION, puzzle_count: 8, requested_count: 8, is_warmup: false },
    });
    expect(screen.queryByTestId('train-warmup-banner')).toBeNull();
  });

  it('next_due_date set: the caught-up body renders and ends with the "Next review: {date}." clause', () => {
    trainProgressMock = {
      data: { ...DEFAULT_TRAIN_PROGRESS, next_due_date: '2026-08-20' },
      isPending: false,
      isError: false,
    };
    renderScreen({ session: { ...BASE_SESSION, is_warmup: true } });
    const body = screen.getByTestId('train-warmup-banner-body').textContent ?? '';
    expect(body).toBe(
      "You're all caught up on your own mistakes. In the meantime, here are some practice puzzles. Next review: Aug 20, 2026.",
    );
  });

  it('next_due_date null: the cold-start body renders and the clause is omitted entirely — no "Next review" text, no dangling artifact', () => {
    trainProgressMock = {
      data: { ...DEFAULT_TRAIN_PROGRESS, next_due_date: null },
      isPending: false,
      isError: false,
    };
    renderScreen({ session: { ...BASE_SESSION, is_warmup: true } });
    const body = screen.getByTestId('train-warmup-banner-body').textContent ?? '';
    expect(body).toBe(
      "We're analyzing your games to find your blunders. In the meantime, here are some practice puzzles.",
    );
    expect(body).not.toContain('Next review');
  });

  // 206 UAT round 1: the two warm-up causes get DIFFERENT body copy, branched
  // on next_due_date. The pair below is the mutation guard — collapsing the
  // branch back to one shared string turns both assertions red at once.
  it('the two warm-up causes render different body copy, and neither leaks the other’s claim', () => {
    trainProgressMock = {
      data: { ...DEFAULT_TRAIN_PROGRESS, next_due_date: null },
      isPending: false,
      isError: false,
    };
    renderScreen({ session: { ...BASE_SESSION, is_warmup: true } });
    const coldStartBody = screen.getByTestId('train-warmup-banner-body').textContent ?? '';
    cleanup();

    trainProgressMock = {
      data: { ...DEFAULT_TRAIN_PROGRESS, next_due_date: '2026-08-20' },
      isPending: false,
      isError: false,
    };
    renderScreen({ session: { ...BASE_SESSION, is_warmup: true } });
    const caughtUpBody = screen.getByTestId('train-warmup-banner-body').textContent ?? '';

    expect(coldStartBody).not.toBe(caughtUpBody);
    // A caught-up user has nothing being analyzed — that claim must never appear.
    expect(caughtUpBody).not.toContain('analyzing your games');
    // A cold-start user is not "caught up" — they have never had material.
    expect(coldStartBody).not.toContain('caught up');
  });

  it('resumed warm-up session (solved_count > 0, is_warmup true): the banner still renders alongside the Resume CTA', () => {
    renderScreen({
      session: {
        ...BASE_SESSION,
        puzzle_count: 8,
        solved_count: 3,
        is_warmup: true,
        puzzles: [STUB_PUZZLE],
      },
    });
    expect(screen.getByTestId('train-warmup-banner')).not.toBeNull();
    expect(screen.getByTestId('btn-train-resume')).not.toBeNull();
  });

  it('loading, error, empty, and completed states render zero warm-up banners', () => {
    renderScreen({ isLoading: true, session: null });
    expect(screen.queryByTestId('train-warmup-banner')).toBeNull();
    cleanup();

    renderScreen({ isError: true, session: null });
    expect(screen.queryByTestId('train-warmup-banner')).toBeNull();
    cleanup();

    renderScreen({ session: EMPTY_SESSION });
    expect(screen.queryByTestId('train-warmup-banner')).toBeNull();
    cleanup();

    renderScreen({
      session: { ...BASE_SESSION, puzzle_count: 6, solved_count: 6, is_warmup: true },
      sessionScore: 6,
    });
    expect(screen.queryByTestId('train-warmup-banner')).toBeNull();
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
    expect(screen.queryByTestId('train-streak-card')).toBeNull();
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
    expect(screen.getByTestId('train-streak-card')).not.toBeNull();
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

describe('TrainStartScreen — OFFER-05/D-16 re-surface banner (additive, not a seventh state)', () => {
  // WR-01: the banner also gates on the push-capability probe, so every
  // "banner renders" assertion here needs push to actually be available.
  // Without this the block would be asserting that a push CTA appears while
  // claiming push is unavailable — the inconsistency WR-01's fix exposed.
  beforeEach(() => {
    capabilityMock = {
      isResolved: true,
      available: true,
      vapidPublicKey: 'test-vapid-key',
      permission: 'default' as NotificationPermission,
    };
  });

  it('shouldResurface false (default): the banner never mounts, in any landing state', () => {
    renderScreen();
    expect(screen.queryByTestId('resurface-banner')).toBeNull();
  });

  it('shouldResurface true but the capability probe unresolved: still nothing (WR-01)', () => {
    resurfaceMock = { shouldResurface: true };
    capabilityMock = {
      isResolved: false,
      available: false,
      vapidPublicKey: null,
      permission: 'default' as NotificationPermission,
    };
    renderScreen();
    expect(screen.queryByTestId('resurface-banner')).toBeNull();
  });

  it('shouldResurface true: the banner renders before the streak card in DOM order within the landing container', () => {
    resurfaceMock = { shouldResurface: true };
    renderScreen();

    const banner = screen.getByTestId('resurface-banner');
    const streakCard = screen.getByTestId('train-streak-card');
    expect(banner.compareDocumentPosition(streakCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shouldResurface true: the banner also renders ahead of the Start CTA (first element in the landing content)', () => {
    resurfaceMock = { shouldResurface: true };
    renderScreen();

    const banner = screen.getByTestId('resurface-banner');
    const startButton = screen.getByTestId('btn-train-start');
    expect(banner.compareDocumentPosition(startButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shouldResurface true in the completed state: the banner still renders ahead of the streak card', () => {
    resurfaceMock = { shouldResurface: true };
    renderScreen({
      session: { ...BASE_SESSION, puzzle_count: 6, solved_count: 6, expires_on: '2026-08-01' },
      sessionScore: 6,
    });

    const banner = screen.getByTestId('resurface-banner');
    const streakCard = screen.getByTestId('train-streak-card');
    expect(banner.compareDocumentPosition(streakCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
