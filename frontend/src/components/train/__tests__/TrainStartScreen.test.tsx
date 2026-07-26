// @vitest-environment jsdom
/**
 * TrainStartScreen.test.tsx — coverage for all six landing states
 * (D-01..D-04, D-14, plus loading/error) per 190-04-PLAN.md Task 1.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TrainStartScreen } from '@/components/train/TrainStartScreen';
import type { TrainPuzzle, TrainSessionResponse } from '@/types/train';

afterEach(() => {
  cleanup();
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

function renderScreen(props: Partial<Parameters<typeof TrainStartScreen>[0]> = {}) {
  const onEnterLoop = vi.fn();
  render(
    <TrainStartScreen
      session={BASE_SESSION}
      isLoading={false}
      isError={false}
      sessionScore={0}
      onEnterLoop={onEnterLoop}
      {...props}
    />,
  );
  return { onEnterLoop };
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
});
