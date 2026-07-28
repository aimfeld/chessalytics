// @vitest-environment jsdom
/**
 * TrainSolveScreen.test.tsx — Phase 190 Plan 04 Task 2/Task 3 coverage:
 * progress indicator (frozen count, not the remaining-array length),
 * last-move highlight, the in-place "Checking your move…" state (exact-match
 * skips it, non-exact shows it, no board flicker across the transition), the
 * engine-failure fallback, and block-and-retry solve persistence (T-190-12).
 *
 * `ChessBoard` is mocked (mirrors Train.solveLoop.test.tsx's precedent) so
 * tests drive `onPieceDrop` directly and read `position`/`flipped`/`lastMove`
 * back via data attributes. Both `useTrainSession` (against a mocked
 * `trainApi`) and `useTrainGradingEngine` (against a fake global `Worker`) run
 * FOR REAL — this exercises the actual block-and-retry gate rather than a
 * hand-stubbed approximation of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { TrainSolveScreen } from '@/components/train/TrainSolveScreen';
import { TRAIN_STEP_HIGHLIGHT } from '@/lib/trainArrows';
import { buildGameAnalysisUrl } from '@/lib/analysisUrl';
import { useTrainSession } from '@/hooks/useTrainSession';
import { useTrainGradingEngine } from '@/hooks/useTrainGradingEngine';
import type {
  SolveRequest,
  SolveResponse,
  SolvedResult,
  TrainPuzzle,
  TrainSessionResponse,
} from '@/types/train';

// ─── ResizeObserver stub ────────────────────────────────────────────────────
// jsdom has no ResizeObserver; TrainSolveScreen's useFitBoardToViewport
// observes its board column with one (same per-file stub precedent as
// Bots.test.tsx / Analysis.test.tsx).

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// ─── ChessBoard mock ────────────────────────────────────────────────────────

vi.mock('@/components/board/ChessBoard', () => ({
  ChessBoard: ({
    position,
    flipped,
    lastMove,
    lastMoveColor,
    onPieceDrop,
    arrows,
    squareMarkers,
  }: {
    position: string;
    flipped?: boolean;
    lastMove?: { from: string; to: string } | null;
    lastMoveColor?: string;
    onPieceDrop: (source: string, target: string) => boolean;
    arrows?: unknown[];
    squareMarkers?: unknown[];
  }) => (
    <div
      data-testid="chessboard"
      data-position={position}
      data-flipped={flipped ? 'true' : 'false'}
      data-last-move={lastMove ? `${lastMove.from}${lastMove.to}` : ''}
      data-last-move-color={lastMoveColor ?? ''}
      data-arrows-count={String(arrows?.length ?? 0)}
      data-markers-count={String(squareMarkers?.length ?? 0)}
    >
      <button data-testid="drop-e2e4" onClick={() => onPieceDrop('e2', 'e4')}>
        e2e4
      </button>
      <button data-testid="drop-d2d4" onClick={() => onPieceDrop('d2', 'd4')}>
        d2d4
      </button>
    </div>
  ),
}));

// ─── trainApi mock ──────────────────────────────────────────────────────────

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const composeOrResumeSession = vi.fn<() => Promise<TrainSessionResponse>>();
const solvePuzzle = vi.fn<(sessionId: number, body: SolveRequest) => Promise<SolveResponse>>();
// 190-05/190.1-01: TrainReveal (mounted here once a verdict lands) fires its
// own reveal/game-card/tactic-lines queries. Exposed at module scope (rather
// than inlined in the mock factory) so individual tests can override the
// default fixture via `mockResolvedValueOnce` — e.g. the 190.1-01 game-move-
// box test below needs a non-null `played_in_game_move_uci`.
const revealPuzzle = vi.fn(async () => ({
  game_id: 100,
  ply: 20,
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  played_in_game_san: null,
  played_in_game_move_uci: null,
  puzzle_type: 'sharp' as const,
  source: 'sr_item' as const,
  has_tactic_lines: false,
}));

// Mocked to resolve/reject deterministically so this file's pre-existing
// assertions never depend on a real network call (libraryApi.getGame /
// getTacticLines would otherwise hit the real apiClient).
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    trainApi: {
      composeOrResumeSession: () => composeOrResumeSession(),
      solvePuzzle: (sessionId: number, body: SolveRequest) => solvePuzzle(sessionId, body),
      revealPuzzle: () => revealPuzzle(),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
    },
    libraryApi: {
      ...actual.libraryApi,
      getGame: vi.fn().mockRejectedValue(new Error('not needed for this test file')),
      getTacticLines: vi.fn().mockRejectedValue(new Error('not needed for this test file')),
    },
  };
});

// ─── sounds mock ────────────────────────────────────────────────────────────

// 190.1 UAT round 4: reveal-line stepping plays sounds and the button row
// carries the shared mute toggle — mocked (same approach as useBotGame.test)
// so jsdom never touches real Audio machinery.
const mockSetMuted = vi.fn();
vi.mock('@/lib/sounds', () => ({
  playSound: vi.fn(),
  useMuted: () => false,
  setMuted: (muted: boolean) => mockSetMuted(muted),
}));

// ─── Fake Worker ────────────────────────────────────────────────────────────

// 190.1-02: tracks the width from the last `setoption name MultiPV value N`
// message and emits one `info ... multipv K ...` line per requested rank on
// a mount search, still emitting a single rank for width-1 searches (the
// after-move/reveal-time searches).
class FakeWorker {
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private width = 1;

  /** `pv` defaults to the bare best move; the 190.1 UAT stepping test hands
   * in a longer line so the reveal stepper has something to step through. */
  constructor(
    private bestMove = 'e2e4',
    private pv = bestMove,
  ) {}

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
          this.emit(`info depth 10 multipv ${rank} score cp ${20 - rank} nodes 1000 pv ${this.pv}`);
        }
        this.emit(`bestmove ${this.bestMove}`);
      });
    }
  }

  terminate(): void {}

  private emit(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

/** Never responds to the UCI handshake — isReady never becomes true and the
 * worker never errors either; used only alongside fake timers for the
 * readiness-timeout path. */
class HangingWorker {
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  postMessage(): void {
    /* never responds */
  }
  terminate(): void {}
}

/** Fails the UCI handshake immediately via the Worker's onerror path. */
class FailingWorker {
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  postMessage(msg: string): void {
    if (msg === 'uci') {
      queueMicrotask(() => this.onerror?.(new Event('error')));
    }
  }
  terminate(): void {}
}

function stubWorker(factory: () => { onmessage: unknown; onerror: unknown; postMessage: unknown; terminate: unknown }): void {
  vi.stubGlobal(
    'Worker',
    vi.fn(function (this: unknown) {
      return factory();
    }),
  );
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

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
    puzzles: [],
    solved_results: [],
    ...overrides,
  };
}

// ─── Harness: mounts the REAL hooks against the mocked trainApi + fake Worker ─

function Harness({ puzzle }: { puzzle: TrainPuzzle }): ReactElement {
  const trainSession = useTrainSession();
  const gradingEngine = useTrainGradingEngine({ enabled: true });
  const { startSession } = trainSession;
  useEffect(() => {
    startSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <TrainSolveScreen puzzle={puzzle} trainSession={trainSession} gradingEngine={gradingEngine} />;
}

async function renderScreen(puzzle: TrainPuzzle, session: TrainSessionResponse = makeSession()) {
  composeOrResumeSession.mockResolvedValue(session);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Harness puzzle={puzzle} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByTestId('chessboard')).not.toBeNull());
  return result;
}

describe('TrainSolveScreen — progress, last move, grading state, engine failure, solve retry', () => {
  beforeEach(() => {
    stubWorker(() => new FakeWorker());
    composeOrResumeSession.mockReset();
    solvePuzzle.mockReset();
    solvePuzzle.mockResolvedValue(SOLVE_RESPONSE);
    revealPuzzle.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('progress: shows "i of N" using the FROZEN session puzzle_count, not puzzles.length', async () => {
    // solved_count seeds currentIndex=2 (Pitfall 5); puzzles stays empty on
    // purpose — the denominator must come from puzzle_count (12), never
    // puzzles.length (0 here).
    await renderScreen(makePuzzle(), makeSession({ puzzle_count: 12, solved_count: 2 }));
    expect(screen.getByTestId('train-progress').textContent).toBe('3 of 12');
  });

  it('progress bar: fill width reflects the completed fraction for a mid-session puzzle', async () => {
    await renderScreen(makePuzzle(), makeSession({ puzzle_count: 12, solved_count: 3 }));
    const fill = screen.getByTestId('train-progress-bar').firstElementChild as HTMLElement;
    // i=4, N=12 -> completed fraction (i-1)/N = 3/12 = 25%.
    expect(fill.style.width).toBe('25%');
  });

  it('orientation: flipped for a black-to-move puzzle, not flipped for white', async () => {
    await renderScreen(makePuzzle({ side_to_move: 'black' }));
    expect(screen.getByTestId('chessboard').getAttribute('data-flipped')).toBe('true');
  });

  it('orientation: white-to-move puzzle is not flipped', async () => {
    await renderScreen(makePuzzle({ side_to_move: 'white' }));
    expect(screen.getByTestId('chessboard').getAttribute('data-flipped')).toBe('false');
  });

  it('last-move highlight: derived from the arriving-move UCI', async () => {
    await renderScreen(makePuzzle({ last_move_uci: 'd7d5' }));
    expect(screen.getByTestId('chessboard').getAttribute('data-last-move')).toBe('d7d5');
  });

  it('last-move highlight: a null arriving move renders no highlight', async () => {
    await renderScreen(makePuzzle({ last_move_uci: null }));
    expect(screen.getByTestId('chessboard').getAttribute('data-last-move')).toBe('');
  });

  it('exact-match move never shows the checking indicator', async () => {
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4')); // matches FakeWorker's default bestmove
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
    expect(screen.queryByTestId('train-grading-indicator')).toBeNull();
  });

  it('non-exact move shows the checking indicator before the verdict', async () => {
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    fireEvent.click(screen.getByTestId('drop-d2d4')); // does not match bestmove e2e4 -> second search
    await waitFor(() => expect(screen.getByTestId('train-grading-indicator')).not.toBeNull());
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
  });

  it('board holds the played-move position through grading (no flicker/remount), then snaps back to the puzzle position once the reveal opens (190-05 D-08)', async () => {
    const puzzle = makePuzzle();
    await renderScreen(puzzle);
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    fireEvent.click(screen.getByTestId('drop-d2d4'));
    await waitFor(() => expect(screen.getByTestId('train-grading-indicator')).not.toBeNull());
    const positionAtIndicator = screen.getByTestId('chessboard').getAttribute('data-position');
    // No flicker/remount during grading itself: still showing the played move.
    expect(positionAtIndicator).not.toBe(puzzle.fen);
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
    const positionAtVerdict = screen.getByTestId('chessboard').getAttribute('data-position');
    // 190-05 D-08: as the reveal opens, the board snaps BACK to the puzzle
    // position — the played move is reported in the verdict text, not left
    // on the board.
    expect(positionAtVerdict).toBe(puzzle.fen);
  });

  it('engine failure (Worker error): checking indicator is gone, retry affordance present', async () => {
    stubWorker(() => new FailingWorker());
    await renderScreen(makePuzzle());
    await waitFor(() => expect(screen.getByTestId('train-engine-error')).not.toBeNull());
    expect(screen.queryByTestId('train-grading-indicator')).toBeNull();
    expect(screen.queryByTestId('btn-train-guess-critical')).toBeNull();
    expect(screen.getByTestId('btn-train-engine-retry')).not.toBeNull();
  });

  it('retrying after an onerror engine failure lets a subsequent move actually grade instead of hanging forever (WR-01)', async () => {
    let handedOutFailingWorker = false;
    stubWorker(() => {
      if (!handedOutFailingWorker) {
        handedOutFailingWorker = true;
        return new FailingWorker();
      }
      return new FakeWorker();
    });
    await renderScreen(makePuzzle());
    await waitFor(() => expect(screen.getByTestId('train-engine-error')).not.toBeNull());

    fireEvent.click(screen.getByTestId('btn-train-engine-retry'));

    // The restarted (healthy) Worker becomes ready — the guess/move UI must
    // reappear rather than staying stuck on the error fallback.
    await waitFor(() => expect(screen.getByTestId('btn-train-guess-critical')).not.toBeNull());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });

    // Before the WR-01 fix, `handleRetryEngine` called `startGrading`
    // synchronously against the STALE (still-erroring) refs — permanently
    // rejecting this puzzle's grading, so every subsequent move surfaced
    // `train-grading-error` forever instead of ever reaching a verdict.
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
    expect(screen.queryByTestId('train-grading-error')).toBeNull();
  });

  it('engine failure (readiness timeout): surfaces the same fallback when the Worker never reports ready', async () => {
    vi.useFakeTimers();
    stubWorker(() => new HangingWorker());
    composeOrResumeSession.mockResolvedValue(makeSession());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <Harness puzzle={makePuzzle()} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(screen.getByTestId('train-engine-error')).not.toBeNull();
  });

  // ─── Task 3: block-and-retry solve persistence (T-190-12/T-190-15) ────────

  it('a forced solve-POST failure blocks Next and never advances; retry re-submits the identical payload and then enables Next', async () => {
    solvePuzzle.mockRejectedValueOnce(new Error('network down'));
    await renderScreen(makePuzzle());

    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });

    await waitFor(() => expect(screen.getByTestId('train-solve-error')).not.toBeNull());
    expect(screen.getByText("Couldn't save your result.")).not.toBeNull();

    const nextBtn = screen.getByTestId('btn-train-next') as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);

    // Pressing Next while disabled must not change the puzzle index — the
    // hook's own gate (not just the disabled attribute) is what's asserted.
    fireEvent.click(nextBtn);
    expect(screen.queryByTestId('train-verdict-guess')).toBeNull();

    expect(solvePuzzle).toHaveBeenCalledTimes(1);
    const firstAttemptBody = solvePuzzle.mock.calls[0]?.[1];

    // Retry re-submits — this time it resolves (mockResolvedValue default).
    fireEvent.click(screen.getByTestId('btn-train-solve-retry'));

    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
    expect(screen.queryByTestId('train-solve-error')).toBeNull();

    expect(solvePuzzle).toHaveBeenCalledTimes(2);
    const retryBody = solvePuzzle.mock.calls[1]?.[1];
    expect(retryBody).toEqual(firstAttemptBody);

    const nextBtnAfterRetry = screen.getByTestId('btn-train-next') as HTMLButtonElement;
    expect(nextBtnAfterRetry.disabled).toBe(false);
  });

  // ─── 190.1-01: end-to-end game-move reveal line, real hook + real Worker ──

  it('the game-move box surfaces a live eval from the REAL grading engine, not a stub, once the reveal lands', async () => {
    // played_in_game_move_uci ('d2d4') is deliberately DISTINCT from the
    // played/best move ('e2e4', FakeWorker's fixed bestmove) — 190.1-03's
    // coincidence-merge rule only skips the reveal-time search (and folds
    // the game-move box into the your/best box) when the game move matches
    // one of the other two; this test exercises the independent search path.
    revealPuzzle.mockResolvedValueOnce({
      game_id: 100,
      ply: 20,
      fen: START_FEN,
      played_in_game_san: 'd4',
      played_in_game_move_uci: 'd2d4',
      puzzle_type: 'sharp',
      source: 'sr_item',
      has_tactic_lines: false,
    });
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('train-line-box-game-move')).not.toBeNull());
    // Scoped to the game-move box specifically — the exact-match played move
    // also renders its own (merged your/best) stepper with the SAME
    // train-line-stepper-eval testid, so an unscoped query would be ambiguous.
    await waitFor(() => {
      const evalEl = screen
        .getByTestId('train-line-box-game-move')
        .querySelector('[data-testid="train-line-stepper-eval"]');
      expect(evalEl?.textContent).not.toBe('');
    });
  });

  // ─── 190.1-04: reveal-board arrows (D-02) ─────────────────────────────────

  it('the arrows prop handed to the board is empty before the verdict and non-empty afterwards', async () => {
    await renderScreen(makePuzzle());
    expect(screen.getByTestId('chessboard').getAttribute('data-arrows-count')).toBe('0');

    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    // exact-match move (FakeWorker's fixed bestmove e2e4) — still no arrows
    // while grading/solving is in flight.
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
    await waitFor(() =>
      expect(Number(screen.getByTestId('chessboard').getAttribute('data-arrows-count'))).toBeGreaterThan(0),
    );
  });

  it('quality badges (squareMarkers) land on the board alongside the arrows once the verdict has settled (190.1 UAT)', async () => {
    await renderScreen(makePuzzle());
    expect(screen.getByTestId('chessboard').getAttribute('data-markers-count')).toBe('0');
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4')); // exact match -> played IS best
    });
    await waitFor(() =>
      expect(Number(screen.getByTestId('chessboard').getAttribute('data-markers-count'))).toBeGreaterThan(0),
    );
  });

  // ─── 190.1 UAT: reveal-line stepping clears the overlay; Solution restores ─

  it('stepping a reveal line clears the overlay, highlights the stepped move in its quality color with a blue next-move arrow, and Solution restores everything', async () => {
    // A two-move PV so the merged your/best box actually has a next move to
    // point at after the first step.
    stubWorker(() => new FakeWorker('e2e4', 'e2e4 e7e5'));
    await renderScreen(makePuzzle({ last_move_uci: 'd7d5' }));
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4')); // exact match -> played IS best
    });
    await waitFor(() =>
      expect(Number(screen.getByTestId('chessboard').getAttribute('data-markers-count'))).toBeGreaterThan(0),
    );

    // Step to the line's first move (the merged your/best box's first token).
    const yourBox = screen.getByTestId('train-line-box-your-move');
    fireEvent.click(within(yourBox).getByTestId('train-line-stepper-token-0'));

    const board = () => screen.getByTestId('chessboard');
    // UAT round 4: the FIRST move of a stepped line keeps exactly its own
    // quality badge (the rest of the solution overlay's markers are cleared).
    await waitFor(() => expect(board().getAttribute('data-markers-count')).toBe('1'));
    // The stepped move is highlighted in its quality color (played IS best ->
    // the engine-blue highlight), and the only arrow is the blue next-move
    // pointer for the rest of the Stockfish line.
    expect(board().getAttribute('data-last-move')).toBe('e2e4');
    expect(board().getAttribute('data-last-move-color')).toBe(TRAIN_STEP_HIGHLIGHT.best);
    expect(board().getAttribute('data-arrows-count')).toBe('1');

    // Deeper into the line (an engine continuation): no quality badge at all.
    fireEvent.click(within(yourBox).getByTestId('train-line-stepper-token-1'));
    await waitFor(() => expect(board().getAttribute('data-markers-count')).toBe('0'));

    // Solution: board back at the puzzle position, full overlay + the
    // arrival-move highlight restored.
    fireEvent.click(screen.getByTestId('btn-train-solution'));
    await waitFor(() =>
      expect(Number(board().getAttribute('data-markers-count'))).toBeGreaterThan(0),
    );
    expect(board().getAttribute('data-position')).toBe(START_FEN);
    expect(board().getAttribute('data-last-move')).toBe('d7d5');
    expect(board().getAttribute('data-last-move-color')).toBe('');
  });

  // ─── 190.1 UAT round 3: Solution/Analyze/Next row below the board ─────────

  it('the Solution/Analyze/Next row appears below the board only once the verdict lands, all three in one row', async () => {
    await renderScreen(makePuzzle({ ply: 20 }));
    expect(screen.queryByTestId('btn-train-solution')).toBeNull();
    expect(screen.queryByTestId('btn-train-analyze')).toBeNull();
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('btn-train-solution')).not.toBeNull());
    const solutionBtn = screen.getByTestId('btn-train-solution');
    const analyzeBtn = screen.getByTestId('btn-train-analyze');
    const nextBtn = screen.getByTestId('btn-train-next');
    expect(solutionBtn.closest('div')).toBe(analyzeBtn.closest('div'));
    expect(analyzeBtn.closest('div')).toBe(nextBtn.closest('div'));
    // The row lives in the board column (sibling of the board's relative
    // wrapper — round 7 wrapped the chessboard for the points-flash overlay),
    // not in the reveal panel.
    const boardEl = screen.getByTestId('chessboard');
    expect(solutionBtn.closest('div')?.parentElement).toBe(boardEl.parentElement?.parentElement);
    // Analyze deep-links one ply BEFORE the mistake (ply 20 -> 19).
    expect(analyzeBtn.getAttribute('href')).toBe(buildGameAnalysisUrl(100, 19));
  });

  it('the button row carries the shared mute toggle and pressing it flips the persisted preference (190.1 UAT round 4)', async () => {
    await renderScreen(makePuzzle());
    expect(screen.queryByTestId('board-btn-mute')).toBeNull();
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('board-btn-mute')).not.toBeNull());
    // useMuted is mocked to false -> pressing mutes.
    fireEvent.click(screen.getByTestId('board-btn-mute'));
    expect(mockSetMuted).toHaveBeenCalledWith(true);
  });

  it('a live 3-point solve plays the WinChime (game-win) sound and pops the "Points: +3" flash over the board (190.1 UAT round 7, SEED-119 max)', async () => {
    const { playSound } = await import('@/lib/sounds');
    vi.mocked(playSound).mockClear();
    await renderScreen(makePuzzle());
    expect(screen.queryByTestId('train-points-flash')).toBeNull();
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4')); // matches bestmove -> good tier, 2 move points
    });
    await waitFor(() => expect(screen.getByTestId('train-points-flash')).not.toBeNull());
    expect(screen.getByTestId('train-points-flash').textContent).toBe('Points: +3');
    // Round 7: the perfect-score sound is the gentle WinChime, not the
    // Victory fanfare (that SoundEvent no longer exists).
    expect(playSound).toHaveBeenCalledWith('game-win');
  });

  // ─── D-09: Analyze hidden (not disabled) when game_id is null (Phase 192) ──

  it('hides the Analyze link when the source game link is null, but Solution and Next still render', async () => {
    await renderScreen(makePuzzle({ game_id: null, ply: 20 }));
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('btn-train-solution')).not.toBeNull());
    expect(screen.queryByTestId('btn-train-analyze')).toBeNull();
    expect(screen.getByTestId('btn-train-next')).not.toBeNull();
  });

  it('renders the Analyze link when the source game is present', async () => {
    await renderScreen(makePuzzle({ game_id: 100, ply: 20 }));
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('btn-train-analyze')).not.toBeNull());
    expect(screen.getByTestId('btn-train-analyze').getAttribute('href')).toBe(
      buildGameAnalysisUrl(100, 19),
    );
  });

  it('btn-train-analyze carries no ply query parameter when puzzle.ply is 0', async () => {
    await renderScreen(makePuzzle({ ply: 0 }));
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('btn-train-analyze')).not.toBeNull());
    const href = screen.getByTestId('btn-train-analyze').getAttribute('href');
    expect(href).toBe(buildGameAnalysisUrl(100, null));
    expect(href).not.toContain('ply=');
  });

  // ─── 190.1 UAT: post-guess move prompt ────────────────────────────────────

  it('committing a guess replaces the guess buttons with the "Now play a move for {color}" prompt, which disappears once the move lands', async () => {
    await renderScreen(makePuzzle({ side_to_move: 'white' }));
    expect(screen.queryByTestId('train-move-prompt')).toBeNull();
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    expect(screen.getByTestId('train-move-prompt').textContent).toBe('Now play a move for white');
    expect(screen.queryByTestId('btn-train-guess-critical')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.queryByTestId('train-move-prompt')).toBeNull());
  });

  it('the move prompt states black for a black-to-move puzzle', async () => {
    await renderScreen(makePuzzle({ side_to_move: 'black' }));
    fireEvent.click(screen.getByTestId('btn-train-guess-several'));
    expect(screen.getByTestId('train-move-prompt').textContent).toBe('Now play a move for black');
  });

  // ─── 190.1-04: running session score on the progress bar (D-04) ──────────

  it('train-session-score is absent on the first puzzle of a fresh session before any solve', async () => {
    await renderScreen(makePuzzle(), makeSession({ solved_count: 0 }));
    expect(screen.queryByTestId('train-session-score')).toBeNull();
  });

  it('driving one puzzle to a correct-guess good-move verdict shows the accumulated score and a max of one times TRAIN_POINTS_PER_PUZZLE (SEED-119: 3)', async () => {
    await renderScreen(makePuzzle(), makeSession({ solved_count: 0 }));
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4')); // exact match -> guess + good move
    });
    await waitFor(() => expect(screen.getByTestId('train-session-score')).not.toBeNull());
    const text = screen.getByTestId('train-session-score').textContent ?? '';
    expect(text).toContain('3'); // score: correct_guess (1) + good move (2) = 3 points
    expect(text).toContain('3'); // max: 1 puzzle x TRAIN_POINTS_PER_PUZZLE (3) = 3
  });

  it('train-session-score and train-progress are siblings in the same row, with train-progress-bar below them', async () => {
    // sessionSolvedCount (260728-tgc) derives from solved_results.length, not
    // solved_count — seed one entry so the score row actually renders.
    await renderScreen(
      makePuzzle(),
      makeSession({ solved_count: 1, solved_results: [makeSolvedResult()] }),
    );
    const score = screen.getByTestId('train-session-score');
    const progress = screen.getByTestId('train-progress');
    expect(score.parentElement).toBe(progress.parentElement);
    const bar = screen.getByTestId('train-progress-bar');
    // The row containing progress/score is the bar's previous sibling.
    expect(bar.previousElementSibling).toBe(progress.parentElement);
  });
});
