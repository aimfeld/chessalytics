// @vitest-environment jsdom
/**
 * useTrainSession.test.ts — 190.1-04 (D-04) coverage: `sessionSolvedCount`,
 * the session score's denominator. Computed as the session response's
 * `solved_results.length` plus the size of the internally tracked
 * solved-positions set, updating on exactly the same tick as `sessionScore`
 * (the solve mutation's success path) — never `currentIndex`.
 *
 * 260728-tgc (BUGFIX-TRAIN-SCORE-CROSSDEVICE): `sessionScore` and
 * `sessionSolvedCount` both now seed from `solved_results` on the session
 * response — server data, not a device-local localStorage tally.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { ReactNode } from 'react';

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    trainApi: {
      ...actual.trainApi,
      composeOrResumeSession: vi.fn(),
      solvePuzzle: vi.fn(),
    },
  };
});

import { trainApi } from '@/api/client';
import { useTrainSession } from '@/hooks/useTrainSession';
import { TRAIN_PROGRESS_QUERY_KEY } from '@/hooks/useTrainProgress';
import type {
  SolveRequest,
  SolveResponse,
  SolvedResult,
  TrainPuzzle,
  TrainSessionResponse,
} from '@/types/train';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function makePuzzle(overrides: Partial<TrainPuzzle> = {}): TrainPuzzle {
  return {
    position: 1,
    game_id: 100,
    ply: 20,
    fen: START_FEN,
    side_to_move: 'white',
    last_move_uci: 'd7d5',
    ...overrides,
  };
}

function makeSolvedResult(overrides: Partial<SolvedResult> = {}): SolvedResult {
  return { correct_guess: true, move_quality: 'good', ...overrides };
}

function makeSession(overrides: Partial<TrainSessionResponse> = {}): TrainSessionResponse {
  return {
    session_id: 1,
    session_date: '2026-07-25',
    expires_on: '2026-07-26',
    puzzle_count: 5,
    requested_count: 5,
    solved_count: 0,
    blob_pending_count: 0,
    puzzles: [makePuzzle()],
    solved_results: [],
    ...overrides,
  };
}

const SOLVE_RESPONSE: SolveResponse = {
  correct_guess: true,
  correct_move: true,
  move_quality: 'good',
  puzzle_type: 'sharp',
  item_status: 'active',
  streak: 1,
  due_date: '2026-07-28',
  session_complete: false,
};

function makeWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  return function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe('useTrainSession — sessionSolvedCount (190.1-04 D-04)', () => {
  beforeEach(() => {
    vi.mocked(trainApi.composeOrResumeSession).mockReset();
    vi.mocked(trainApi.solvePuzzle).mockReset();
  });

  it('is the session\'s frozen solved_results.length before any solve', async () => {
    vi.mocked(trainApi.composeOrResumeSession).mockResolvedValue(
      makeSession({
        solved_count: 3,
        solved_results: [makeSolvedResult(), makeSolvedResult(), makeSolvedResult()],
      }),
    );
    const { result } = renderHook(() => useTrainSession(), { wrapper: makeWrapper() });
    act(() => result.current.startSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());
    expect(result.current.sessionSolvedCount).toBe(3);
  });

  it('seeds sessionScore and sessionSolvedCount from solved_results, not a device-local tally', async () => {
    // 260728-tgc regression coverage: with no localStorage read anywhere in
    // the hook, this is server data only. Three entries, each 1 (correct
    // guess) + 2 (good move) = 3 points -> total 9.
    vi.mocked(trainApi.composeOrResumeSession).mockResolvedValue(
      makeSession({
        solved_count: 3,
        solved_results: [
          makeSolvedResult({ correct_guess: true, move_quality: 'good' }),
          makeSolvedResult({ correct_guess: false, move_quality: 'inaccuracy' }),
          makeSolvedResult({ correct_guess: true, move_quality: 'wrong' }),
        ],
      }),
    );
    const { result } = renderHook(() => useTrainSession(), { wrapper: makeWrapper() });
    act(() => result.current.startSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());
    // (1+2) + (0+1) + (1+0) = 5.
    expect(result.current.sessionScore).toBe(5);
    expect(result.current.sessionSolvedCount).toBe(3);

    // A subsequent solve still increments both live, on top of the seeded base.
    vi.mocked(trainApi.solvePuzzle).mockResolvedValue(SOLVE_RESPONSE);
    const body: SolveRequest = {
      position: 1,
      guess: 'critical',
      played_move: 'e2e4',
      move_quality: 'good',
    };
    await act(async () => {
      await result.current.solvePuzzle(body);
    });
    expect(result.current.sessionScore).toBe(8);
    expect(result.current.sessionSolvedCount).toBe(4);
  });

  it('increases by one after a successful solve mutation', async () => {
    vi.mocked(trainApi.composeOrResumeSession).mockResolvedValue(makeSession({ solved_count: 0 }));
    vi.mocked(trainApi.solvePuzzle).mockResolvedValue(SOLVE_RESPONSE);
    const { result } = renderHook(() => useTrainSession(), { wrapper: makeWrapper() });
    act(() => result.current.startSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());
    expect(result.current.sessionSolvedCount).toBe(0);

    const body: SolveRequest = { position: 1, guess: 'critical', played_move: 'e2e4', move_quality: 'good' };
    await act(async () => {
      await result.current.solvePuzzle(body);
    });
    expect(result.current.sessionSolvedCount).toBe(1);
    // Updates on the SAME tick as sessionScore (both in the solve mutation's
    // success path), never derived from currentIndex. SEED-119: correct
    // guess (1) + good move (2) = 3.
    expect(result.current.sessionScore).toBe(3);
  });

  it('a failed solve mutation does not increase sessionSolvedCount', async () => {
    vi.mocked(trainApi.composeOrResumeSession).mockResolvedValue(makeSession({ solved_count: 0 }));
    vi.mocked(trainApi.solvePuzzle).mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useTrainSession(), { wrapper: makeWrapper() });
    act(() => result.current.startSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());

    const body: SolveRequest = { position: 1, guess: 'critical', played_move: 'e2e4', move_quality: 'good' };
    await act(async () => {
      await expect(result.current.solvePuzzle(body)).rejects.toThrow();
    });
    expect(result.current.sessionSolvedCount).toBe(0);
  });
});

/**
 * 193 UAT: every solve moves the nav badge. Server-side `waiting_count` is
 * `puzzle_count - solved_count` (get_waiting_puzzle_count branch 1), so it
 * decreases by one per solve and hits 0 on the last one — which is also the
 * tick that flips the session row to 'completed' and settles the
 * streak/shield. The nav badge dot and the progress row both read the cached
 * `TRAIN_PROGRESS_QUERY_KEY`, which nothing else on the Train page
 * invalidates, so it must be invalidated on EVERY solve. Gating it on
 * `session_complete` alone froze the counter at its start-of-session value
 * until the final puzzle, then jumped it straight to 0.
 */
describe('useTrainSession — progress invalidation on every solve (193 UAT)', () => {
  beforeEach(() => {
    vi.mocked(trainApi.composeOrResumeSession).mockReset();
    vi.mocked(trainApi.solvePuzzle).mockReset();
  });

  function makeClientWrapper(): {
    client: QueryClient;
    wrapper: ({ children }: { children: ReactNode }) => ReactNode;
  } {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return {
      client,
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    };
  }

  const BODY: SolveRequest = {
    position: 1,
    guess: 'critical',
    played_move: 'e2e4',
    move_quality: 'good',
  };

  it('invalidates the train progress query when the solve completes the session', async () => {
    vi.mocked(trainApi.composeOrResumeSession).mockResolvedValue(makeSession());
    vi.mocked(trainApi.solvePuzzle).mockResolvedValue({ ...SOLVE_RESPONSE, session_complete: true });
    const { client, wrapper } = makeClientWrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useTrainSession(), { wrapper });
    act(() => result.current.startSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());

    await act(async () => {
      await result.current.solvePuzzle(BODY);
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: TRAIN_PROGRESS_QUERY_KEY });
  });

  it('invalidates the train progress query on a mid-session solve too', async () => {
    // The badge counter must tick down as the user works through the session,
    // not sit frozen until the last puzzle. This is the case that regressed
    // when the invalidation was gated on `session_complete`.
    vi.mocked(trainApi.composeOrResumeSession).mockResolvedValue(makeSession());
    vi.mocked(trainApi.solvePuzzle).mockResolvedValue({
      ...SOLVE_RESPONSE,
      session_complete: false,
    });
    const { client, wrapper } = makeClientWrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useTrainSession(), { wrapper });
    act(() => result.current.startSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());

    await act(async () => {
      await result.current.solvePuzzle(BODY);
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: TRAIN_PROGRESS_QUERY_KEY });
  });

  it('invalidates once per solve across a multi-puzzle session', async () => {
    // Guards the shape of the fix rather than a single call: three
    // consecutive mid-session solves must each refresh the counter, so a
    // future "only invalidate sometimes" optimisation cannot silently
    // re-freeze it.
    vi.mocked(trainApi.composeOrResumeSession).mockResolvedValue(makeSession());
    vi.mocked(trainApi.solvePuzzle).mockResolvedValue({
      ...SOLVE_RESPONSE,
      session_complete: false,
    });
    const { client, wrapper } = makeClientWrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useTrainSession(), { wrapper });
    act(() => result.current.startSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());

    for (const position of [1, 2, 3]) {
      await act(async () => {
        await result.current.solvePuzzle({ ...BODY, position });
      });
    }

    const progressInvalidations = invalidate.mock.calls.filter(
      ([arg]) => arg?.queryKey === TRAIN_PROGRESS_QUERY_KEY,
    );
    expect(progressInvalidations).toHaveLength(3);
  });
});
