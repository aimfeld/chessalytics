// @vitest-environment jsdom
/**
 * useTrainSession.test.ts — 190.1-04 (D-04) coverage: `sessionSolvedCount`,
 * the session score's denominator. Computed as the session response's
 * FROZEN `solved_count` plus the size of the internally tracked
 * solved-positions set, updating on exactly the same tick as `sessionScore`
 * (the solve mutation's success path) — never `currentIndex`.
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
import type { SolveRequest, SolveResponse, TrainPuzzle, TrainSessionResponse } from '@/types/train';

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
    ...overrides,
  };
}

const SOLVE_RESPONSE: SolveResponse = {
  correct_guess: true,
  correct_move: true,
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

  it('is the session\'s frozen solved_count before any solve', async () => {
    vi.mocked(trainApi.composeOrResumeSession).mockResolvedValue(
      makeSession({ solved_count: 3 }),
    );
    const { result } = renderHook(() => useTrainSession(), { wrapper: makeWrapper() });
    act(() => result.current.startSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());
    expect(result.current.sessionSolvedCount).toBe(3);
  });

  it('increases by one after a successful solve mutation', async () => {
    vi.mocked(trainApi.composeOrResumeSession).mockResolvedValue(makeSession({ solved_count: 0 }));
    vi.mocked(trainApi.solvePuzzle).mockResolvedValue(SOLVE_RESPONSE);
    const { result } = renderHook(() => useTrainSession(), { wrapper: makeWrapper() });
    act(() => result.current.startSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());
    expect(result.current.sessionSolvedCount).toBe(0);

    const body: SolveRequest = { position: 1, guess: 'critical', played_move: 'e2e4', correct_move: true };
    await act(async () => {
      await result.current.solvePuzzle(body);
    });
    expect(result.current.sessionSolvedCount).toBe(1);
    // Updates on the SAME tick as sessionScore (both in the solve mutation's
    // success path), never derived from currentIndex.
    expect(result.current.sessionScore).toBe(2);
  });

  it('a failed solve mutation does not increase sessionSolvedCount', async () => {
    vi.mocked(trainApi.composeOrResumeSession).mockResolvedValue(makeSession({ solved_count: 0 }));
    vi.mocked(trainApi.solvePuzzle).mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useTrainSession(), { wrapper: makeWrapper() });
    act(() => result.current.startSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());

    const body: SolveRequest = { position: 1, guess: 'critical', played_move: 'e2e4', correct_move: true };
    await act(async () => {
      await expect(result.current.solvePuzzle(body)).rejects.toThrow();
    });
    expect(result.current.sessionSolvedCount).toBe(0);
  });
});
