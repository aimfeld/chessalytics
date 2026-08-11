// @vitest-environment jsdom
/**
 * Train.guestGate.test.tsx — FLAWCHESS-64: a guest reaching /train must issue
 * ZERO /train/* requests and see a sign-up CTA instead of TrainStartScreen
 * (whose progress/settings fetches are guaranteed 403s via the backend's
 * _reject_guest, app/routers/train.py:54, Phase 189 D-05 — correct and
 * unchanged). Covers the four <behavior> cases from the plan: guest (zero
 * calls, CTA renders, sign-up promotes in place), non-guest (session
 * composed exactly once, no CTA), and profile-unresolved (zero calls, no
 * premature guest/non-guest assumption).
 */
import { StrictMode } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { UserProfile } from '@/types/users';
import type { TrainSessionResponse, TrainProgressResponse } from '@/types/train';

// ─── ResizeObserver stub (jsdom has none; useFitBoardToViewport observes) ───

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// ─── Fake Worker (same shape as Train.solveLoop.test.tsx's FakeWorker) ─────
// The non-guest control case mounts the real grading engine, which creates a
// Worker on mount whenever `canTrain` is true.

class FakeWorker {
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  terminated = false;
  private width = 1;

  postMessage(msg: string): void {
    if (msg === 'uci') {
      this.emit('uciok');
    } else if (msg === 'isready') {
      this.emit('readyok');
    } else if (msg.startsWith('setoption name MultiPV value ')) {
      const width = parseInt(msg.slice('setoption name MultiPV value '.length), 10);
      this.width = Number.isFinite(width) && width > 0 ? width : 1;
    } else if (msg.startsWith('go ')) {
      queueMicrotask(() => {
        for (let rank = 1; rank <= this.width; rank++) {
          this.emit(`info depth 10 multipv ${rank} score cp ${20 - rank} nodes 1000 pv e2e4`);
        }
        this.emit('bestmove e2e4');
      });
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  private emit(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

// ─── useUserProfile mock (mutable per-test holder) ─────────────────────────

let userProfileMock: { data: UserProfile | undefined; isError: boolean } = {
  data: undefined,
  isError: false,
};
vi.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: () => userProfileMock,
}));

function makeProfile(overrides: Partial<UserProfile>): UserProfile {
  return {
    email: 'user@example.com',
    is_superuser: false,
    is_guest: false,
    chess_com_username: null,
    lichess_username: null,
    created_at: '2026-01-01T00:00:00Z',
    last_login: null,
    chess_com_game_count: 0,
    lichess_game_count: 0,
    chess_com_last_sync_at: null,
    lichess_last_sync_at: null,
    impersonation: null,
    beta_enabled: false,
    lichess_blitz_equivalent_rating: null,
    ...overrides,
  };
}

// ─── useAuth mock — logoutForPromotion spy, no AuthProvider needed ─────────

const logoutForPromotion = vi.fn();
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ logoutForPromotion }),
}));

// ─── trainApi mock (same shape as Train.solveLoop.test.tsx) ────────────────

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const SESSION_RESPONSE: TrainSessionResponse = {
  session_id: 1,
  session_date: '2026-07-25',
  expires_on: '2026-07-26',
  puzzle_count: 1,
  requested_count: 1,
  solved_count: 0,
  blob_pending_count: 0,
  puzzles: [
    { position: 1, game_id: 100, ply: 20, fen: START_FEN, side_to_move: 'white', last_move_uci: 'd7d5' },
  ],
  solved_results: [],
  is_warmup: false,
};

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

const composeOrResumeSession = vi.fn(async () => SESSION_RESPONSE);
const getProgress = vi.fn(async () => DEFAULT_TRAIN_PROGRESS);

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    trainApi: {
      composeOrResumeSession: () => composeOrResumeSession(),
      solvePuzzle: vi.fn(),
      revealPuzzle: vi.fn(),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      getProgress: () => getProgress(),
    },
  };
});

// ─── window.location stub (same precedent as useEvalCoverage.test.tsx) ────

const originalLocation = window.location;
beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, href: '' },
  });
});
afterAll(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
  });
});

// ─── Render helper ──────────────────────────────────────────────────────────

async function renderTrainPage({ strict = false }: { strict?: boolean } = {}) {
  const TrainPage = (await import('@/pages/Train')).default;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <TrainPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
  // `strict` mirrors main.tsx:55 — the real app renders inside <StrictMode>,
  // so its dev double-mount is production-equivalent behavior for this page,
  // not a test artifact. See the StrictMode case below.
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

describe('Train guest gate (FLAWCHESS-64)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'Worker',
      vi.fn(function (this: unknown) {
        return new FakeWorker();
      }),
    );
    composeOrResumeSession.mockClear();
    getProgress.mockClear();
    logoutForPromotion.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('guest: zero /train/* requests, CTA renders, TrainStartScreen does not', async () => {
    userProfileMock = { data: makeProfile({ is_guest: true }), isError: false };

    await renderTrainPage();

    await waitFor(() => expect(screen.getByTestId('train-guest-gate')).not.toBeNull());
    expect(screen.queryByTestId('train-start-screen')).toBeNull();
    expect(composeOrResumeSession).not.toHaveBeenCalled();
    expect(getProgress).not.toHaveBeenCalled();
  });

  it('guest: pressing the sign-up button calls logoutForPromotion() then navigates to /login?tab=register', async () => {
    userProfileMock = { data: makeProfile({ is_guest: true }), isError: false };

    await renderTrainPage();

    await waitFor(() => expect(screen.getByTestId('btn-signup-for-train')).not.toBeNull());
    fireEvent.click(screen.getByTestId('btn-signup-for-train'));

    expect(logoutForPromotion).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe('/login?tab=register');
  });

  it('non-guest: composeOrResumeSession is called exactly once, the guest gate does not render', async () => {
    userProfileMock = { data: makeProfile({ is_guest: false }), isError: false };

    await act(async () => {
      await renderTrainPage();
    });

    await waitFor(() => expect(composeOrResumeSession).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('train-guest-gate')).toBeNull();
  });

  it('non-guest under StrictMode: the landing screen resolves instead of hanging on "Loading…"', async () => {
    // Regression, dev-only symptom with a production-shaped cause (main.tsx:55
    // wraps the app in <StrictMode>). A "fire only once per mount" ref latch in
    // Train.tsx's mount effect suppressed the second StrictMode effect pass.
    // That is fatal because TanStack's MutationObserver.onUnsubscribe detaches
    // the observer from the in-flight mutation when the simulated unmount drops
    // its last listener, and re-subscribing never re-attaches: isPending froze
    // at true, onSuccess never fired, and the page sat on "Loading…" forever
    // (a reload did not help). The second startSession() call is the recovery.
    userProfileMock = { data: makeProfile({ is_guest: false }), isError: false };

    await act(async () => {
      await renderTrainPage({ strict: true });
    });

    await waitFor(() => expect(screen.getByTestId('train-start-screen')).not.toBeNull());
    expect(screen.queryByTestId('train-session-loading')).toBeNull();
  });

  it('profile unresolved (still loading): zero /train/* requests, loading state renders', async () => {
    userProfileMock = { data: undefined, isError: false };

    await renderTrainPage();

    await waitFor(() => expect(screen.getByTestId('train-profile-loading')).not.toBeNull());
    expect(composeOrResumeSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId('train-guest-gate')).toBeNull();
  });

  it('profile unresolved (errored): zero /train/* requests, error state renders', async () => {
    userProfileMock = { data: undefined, isError: true };

    await renderTrainPage();

    await waitFor(() => expect(screen.getByTestId('train-profile-error')).not.toBeNull());
    expect(composeOrResumeSession).not.toHaveBeenCalled();
  });
});
