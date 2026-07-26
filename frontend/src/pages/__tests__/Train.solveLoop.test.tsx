// @vitest-environment jsdom
/**
 * Train.solveLoop.test.tsx — the end-to-end gate for Phase 190 Plan 01's
 * tracer slice (SOLV-01/SOLV-03): start a session, guess-lock the board,
 * play exactly one move, and see server-verified guess + client-graded move
 * verdicts.
 *
 * `ChessBoard` is mocked (mirrors Bots.test.tsx's precedent) so the test
 * drives the real `onPieceDrop` prop directly via a stub button instead of
 * fighting react-chessboard's drag/click internals — the mock exposes the
 * `position` prop it received via a data attribute so the board-lock
 * assertion (drop before guess leaves position unchanged) is a real
 * behavioral check, not a DOM-drag simulation.
 *
 * A fake `globalThis.Worker` answers `uci`->`uciok`, `isready`->`readyok`,
 * and every `go` with `info ... score cp 20 ... pv e2e4` then
 * `bestmove e2e4` — the test always plays e2e4, so grading takes the D-06
 * exact-match fast path (no second search needed to reach a verdict).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { saveTrainRevealCache } from '@/lib/trainRevealCache';
import type { CachedTrainReveal } from '@/lib/trainRevealCache';
import type { TrainSessionResponse, SolveResponse } from '@/types/train';

// ─── ChessBoard mock ────────────────────────────────────────────────────────

vi.mock('@/components/board/ChessBoard', () => ({
  ChessBoard: ({
    position,
    onPieceDrop,
  }: {
    position: string;
    onPieceDrop: (source: string, target: string) => boolean;
  }) => (
    <div data-testid="chessboard" data-position={position}>
      <button data-testid="test-drop-e2e4" onClick={() => onPieceDrop('e2', 'e4')}>
        drop e2e4
      </button>
    </div>
  ),
}));

// ─── trainApi mock ──────────────────────────────────────────────────────────

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
};

const SOLVE_RESPONSE: SolveResponse = {
  correct_guess: true,
  correct_move: true,
  puzzle_type: 'sharp',
  item_status: 'active',
  streak: 1,
  due_date: '2026-07-28',
  session_complete: true,
};

const composeOrResumeSession = vi.fn(async () => SESSION_RESPONSE);
const solvePuzzle = vi.fn(async () => SOLVE_RESPONSE);
const revealPuzzle = vi.fn(async () => ({
  game_id: 100,
  ply: 20,
  fen: START_FEN,
  played_in_game_san: null,
  played_in_game_move_uci: null,
  puzzle_type: 'sharp' as const,
  source: 'sr_item' as const,
  has_tactic_lines: false,
}));

// 190-05: TrainReveal (mounted once the verdict lands) also fetches the
// game card via libraryApi.getGame — mocked to reject deterministically
// (fast, no real network call) since this tracer doesn't exercise the game
// card itself (that's TrainReveal.test.tsx's job).
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    trainApi: {
      composeOrResumeSession: () => composeOrResumeSession(),
      solvePuzzle: (sessionId: number, body: unknown) => solvePuzzle(sessionId, body),
      revealPuzzle: (sessionId: number, position: number) => revealPuzzle(sessionId, position),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
    },
    libraryApi: {
      ...actual.libraryApi,
      getGame: vi.fn().mockRejectedValue(new Error('not exercised by this tracer')),
      getTacticLines: vi.fn().mockRejectedValue(new Error('not exercised by this tracer')),
    },
  };
});

// ─── Fake Worker ────────────────────────────────────────────────────────────

// 190.1-02: tracks the width from the last `setoption name MultiPV value N`
// message and emits one `info ... multipv K ...` line per requested rank on
// a mount search, still emitting a single rank for width-1 searches.
class FakeWorker {
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  terminated = false;
  goCount = 0;
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
      this.goCount += 1;
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

let fakeWorker: FakeWorker;

// ─── Render helper ──────────────────────────────────────────────────────────

async function renderTrainPage() {
  const TrainPage = (await import('@/pages/Train')).default;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <TrainPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('Train solve loop (end-to-end tracer)', () => {
  beforeEach(() => {
    fakeWorker = new FakeWorker();
    vi.stubGlobal(
      'Worker',
      vi.fn(function (this: unknown) {
        return fakeWorker;
      }),
    );
    composeOrResumeSession.mockClear();
    solvePuzzle.mockClear();
    revealPuzzle.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  // Per-test timeout: this end-to-end tracer transforms/mounts the whole Train
  // page and flakes past Vitest's 5s default under the full parallel `vitest
  // run` on a loaded machine (passes alone in ~1s) — same failure shape as the
  // openings.tsv SAN-parity test, fixed the same way (timeout, not less
  // coverage).
  it('locks the board until a guess is committed, then grades exactly one move end to end', async () => {
    await renderTrainPage();

    // 190-04: Train.tsx now fires the session status fetch automatically on
    // mount (D-01 forbids auto-entering the LOOP, not this read — there is no
    // separate preview endpoint, see useTrainSession.ts). The landing screen
    // shows its loading state until that resolves.
    await waitFor(() => expect(screen.getByTestId('btn-train-start')).not.toBeNull());
    fireEvent.click(screen.getByTestId('btn-train-start'));

    await waitFor(() => expect(screen.getByTestId('chessboard')).not.toBeNull());
    // Exactly one call total: the automatic mount-time status fetch IS the
    // one call — pressing Start only reveals the already-loaded loop.
    expect(composeOrResumeSession).toHaveBeenCalledTimes(1);

    // Board-lock: a drop attempt BEFORE any guess is committed leaves the
    // rendered position unchanged.
    expect(screen.getByTestId('chessboard').getAttribute('data-position')).toBe(START_FEN);
    fireEvent.click(screen.getByTestId('test-drop-e2e4'));
    expect(screen.getByTestId('chessboard').getAttribute('data-position')).toBe(START_FEN);
    // No answer-key data requested before the attempt.
    expect(revealPuzzle).not.toHaveBeenCalled();

    // Commit the "critical" guess — the board unlocks.
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));

    // The drop is accepted (board-lock coverage for "after the guess" lives
    // in TrainSolveScreen.test.tsx; this tracer only proves the end-to-end
    // wire-up, not every intermediate board-position transition).
    await act(async () => {
      fireEvent.click(screen.getByTestId('test-drop-e2e4'));
    });

    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
    expect(screen.getByTestId('train-verdict-guess').textContent).toContain('✓');
    // UAT round 3: the move verdict is the Your-move box's header mark, not a
    // separate row.
    expect(screen.getByTestId('train-line-box-your-move').textContent).toContain('✓');
    expect(screen.getByTestId('btn-train-next')).not.toBeNull();

    // 190-05 D-08: once the reveal opens, the board snaps back to the puzzle
    // position — the played move is reported in the verdict text above, not
    // left on the board.
    expect(screen.getByTestId('chessboard').getAttribute('data-position')).toBe(START_FEN);

    expect(solvePuzzle).toHaveBeenCalledTimes(1);
    const [sessionId, body] = solvePuzzle.mock.calls[0] as [number, Record<string, unknown>];
    expect(sessionId).toBe(1);
    expect(body).toMatchObject({ position: 1, guess: 'critical', played_move: 'e2e4', correct_move: true });

    // 190-05/SOLV-05: the reveal's own best-line fetch DOES fire once the
    // verdict has landed — gated on the solve response being present, never
    // before it (T-190-16). This supersedes Plan 01's "zero reveal calls
    // ever" assertion, which predated the reveal panel this plan builds.
    await waitFor(() => expect(revealPuzzle).toHaveBeenCalledTimes(1));
    expect(revealPuzzle).toHaveBeenCalledWith(1, 1);
  }, 15000);

  it('resume: clicking "Resume session" enters the loop at the next unsolved puzzle (190-06 UAT bug repro)', async () => {
    const REMAINING_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    // Bug repro (190-06 UAT): the backend's resume path (load_session_puzzles)
    // returns ONLY the not-yet-attempted puzzles, ordered by position — NOT a
    // full 12-entry array with the first 7 already solved. A frontend that
    // seeds currentIndex from solved_count (7) indexes past the end of this
    // 1-entry array and never finds a puzzle, so the Resume click renders
    // nothing.
    composeOrResumeSession.mockResolvedValueOnce({
      session_id: 2,
      session_date: '2026-07-25',
      expires_on: '2026-07-26',
      puzzle_count: 12,
      requested_count: 12,
      solved_count: 7,
      blob_pending_count: 0,
      puzzles: [
        { position: 8, game_id: 200, ply: 30, fen: REMAINING_FEN, side_to_move: 'white', last_move_uci: 'c8e6' },
      ],
    });

    await renderTrainPage();

    await waitFor(() => expect(screen.getByTestId('btn-train-resume')).not.toBeNull());
    expect(screen.getByTestId('btn-train-resume').textContent).toBe('Resume session — 7 of 12 done');
    fireEvent.click(screen.getByTestId('btn-train-resume'));

    // The click must actually enter the solve loop on the first remaining puzzle.
    await waitFor(() => expect(screen.getByTestId('chessboard')).not.toBeNull());
    expect(screen.getByTestId('chessboard').getAttribute('data-position')).toBe(REMAINING_FEN);
    // The progress indicator must count the 7 already-solved puzzles too.
    expect(screen.getByTestId('train-progress').textContent).toBe('8 of 12');
  });

  it('a resumed session with a stored score tally shows the resumed score and max, not a restart from zero (190.1-04 D-04)', async () => {
    const REMAINING_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    const RESUMED_SESSION_ID = 3;
    // Seed the localStorage-backed tally (useTrainSession.ts's persistScore
    // key format) as if 10 points were already accumulated on this device
    // before the reload — the resumed sessionSolvedCount denominator (7 x
    // TRAIN_POINTS_PER_PUZZLE = 14) must combine with this stored score,
    // never restart from 0.
    localStorage.setItem(`train_score:${RESUMED_SESSION_ID}`, '10');
    composeOrResumeSession.mockResolvedValueOnce({
      session_id: RESUMED_SESSION_ID,
      session_date: '2026-07-25',
      expires_on: '2026-07-26',
      puzzle_count: 12,
      requested_count: 12,
      solved_count: 7,
      blob_pending_count: 0,
      puzzles: [
        { position: 8, game_id: 200, ply: 30, fen: REMAINING_FEN, side_to_move: 'white', last_move_uci: 'c8e6' },
      ],
    });

    await renderTrainPage();

    await waitFor(() => expect(screen.getByTestId('btn-train-resume')).not.toBeNull());
    fireEvent.click(screen.getByTestId('btn-train-resume'));

    await waitFor(() => expect(screen.getByTestId('train-session-score')).not.toBeNull());
    const text = screen.getByTestId('train-session-score').textContent ?? '';
    expect(text).toContain('10');
    expect(text).toContain('14'); // 7 already-solved x TRAIN_POINTS_PER_PUZZLE (2)

    localStorage.removeItem(`train_score:${RESUMED_SESSION_ID}`);
  });

  // ─── 190.1 UAT round 5: Analyze -> browser back restores the solved reveal ──

  const SOLVED_FEN = START_FEN;
  const RESTORE_REMAINING_FEN =
    'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';

  function makeCachedReveal(sessionId: number): CachedTrainReveal {
    return {
      sessionId,
      puzzle: {
        position: 1,
        game_id: 100,
        ply: 20,
        fen: SOLVED_FEN,
        side_to_move: 'white',
        last_move_uci: 'd7d5',
      },
      verdict: {
        correct_guess: true,
        correct_move: false,
        puzzle_type: 'sharp',
        item_status: 'active',
        streak: 0,
        due_date: null,
        session_complete: false,
      },
      guess: 'critical',
      playedMoveUci: 'g1f3',
      gradeResult: {
        correctMove: false,
        bestMoveUci: 'e2e4',
        esBefore: 0.55,
        esAfter: 0.48,
        bestLine: { moves: ['e2e4', 'e7e5'], evalCp: 30, evalMate: null },
        playedLine: { moves: ['g1f3', 'd7d5'], evalCp: -10, evalMate: null },
        goodMoveUcis: ['e2e4'],
      },
    };
  }

  it('mounts straight into the cached solved reveal after Analyze -> back, then Next continues the resumed loop (190.1 UAT round 5)', async () => {
    const SESSION_ID = 4;
    saveTrainRevealCache(makeCachedReveal(SESSION_ID));
    // The resumed session no longer contains the solved puzzle — only the
    // remaining one — exactly the state a real back-navigation lands in.
    composeOrResumeSession.mockResolvedValueOnce({
      session_id: SESSION_ID,
      session_date: '2026-07-25',
      expires_on: '2026-07-26',
      puzzle_count: 2,
      requested_count: 2,
      solved_count: 1,
      blob_pending_count: 0,
      puzzles: [
        { position: 2, game_id: 200, ply: 30, fen: RESTORE_REMAINING_FEN, side_to_move: 'white', last_move_uci: 'c8e6' },
      ],
    });

    await renderTrainPage();

    // No start/resume press — the reveal restores directly from the cache.
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
    expect(screen.getByTestId('chessboard').getAttribute('data-position')).toBe(SOLVED_FEN);
    // The restored puzzle is the most recently SOLVED one (1 of 2), not the
    // next unsolved (which the general formula would report as 2 of 2).
    expect(screen.getByTestId('train-progress').textContent).toBe('1 of 2');
    // Verdicts render from the cache: guess correct, move incorrect.
    expect(screen.getByTestId('train-verdict-guess').textContent).toContain('✓');
    expect(screen.getByTestId('train-line-box-your-move').textContent).toContain('✗');
    // No mount grading search for an already-solved puzzle — the engine
    // handshakes but never receives a `go`.
    expect(fakeWorker.goCount).toBe(0);

    // Next leaves restore mode: cache cleared, loop continues at the resumed
    // queue's head, and the fresh puzzle gets its own mount search.
    fireEvent.click(screen.getByTestId('btn-train-next'));
    await waitFor(() => expect(screen.getByTestId('train-guess-prompt')).not.toBeNull());
    expect(screen.getByTestId('chessboard').getAttribute('data-position')).toBe(RESTORE_REMAINING_FEN);
    expect(screen.getByTestId('train-progress').textContent).toBe('2 of 2');
    expect(sessionStorage.getItem('train_reveal_cache')).toBeNull();
    await waitFor(() => expect(fakeWorker.goCount).toBe(1));
  }, 15000);

  it('drops a cached reveal from a different session and shows the start screen instead', async () => {
    saveTrainRevealCache(makeCachedReveal(999));

    await renderTrainPage();

    // SESSION_RESPONSE's session_id is 1 — the 999 cache must be discarded.
    await waitFor(() => expect(screen.getByTestId('btn-train-start')).not.toBeNull());
    expect(screen.queryByTestId('train-verdict-guess')).toBeNull();
    expect(sessionStorage.getItem('train_reveal_cache')).toBeNull();
  });
});
