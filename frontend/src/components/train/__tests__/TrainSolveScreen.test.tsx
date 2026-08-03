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
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Chess } from 'chess.js';
import { TrainSolveScreen } from '@/components/train/TrainSolveScreen';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TRAIN_STEP_HIGHLIGHT } from '@/lib/trainArrows';
import { TRAIN_BEST_MOVE_ARROW } from '@/lib/theme';
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

// ─── matchMedia stub (Phase 200: TrainReveal's useIsDesktop) ──────────────
// Controllable per test (mirrors Bots.test.tsx L221's jsdom shim precedent,
// but with a settable `matches` instead of a fixed `false`) — defaults to
// the desktop path so the pre-existing hover-spotlight coverage below needs
// no per-test override.
let matchMediaMatches = true;
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: matchMediaMatches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

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
    arrows?: { startSquare: string; endSquare: string; color: string }[];
    squareMarkers?: unknown[];
  }) => (
    <div
      data-testid="chessboard"
      data-position={position}
      data-flipped={flipped ? 'true' : 'false'}
      data-last-move={lastMove ? `${lastMove.from}${lastMove.to}` : ''}
      data-last-move-color={lastMoveColor ?? ''}
      data-arrows-count={String(arrows?.length ?? 0)}
      // Phase 200 UAT round 5: the free-play best-move arrow is only meaningful
      // as a specific move in a specific hue, so the mock exposes both — a bare
      // count can't tell the blue engine pointer from any other single arrow.
      data-arrow-ucis={(arrows ?? []).map((a) => `${a.startSquare}${a.endSquare}`).join(',')}
      data-arrow-colors={(arrows ?? []).map((a) => a.color).join(',')}
      data-markers-count={String(squareMarkers?.length ?? 0)}
    >
      <button data-testid="drop-e2e4" onClick={() => onPieceDrop('e2', 'e4')}>
        e2e4
      </button>
      <button data-testid="drop-d2d4" onClick={() => onPieceDrop('d2', 'd4')}>
        d2d4
      </button>
      {/* Phase 200 (D-12): a black-move drop, needed to prove exploration
          follows the live side to move rather than pinning to white. */}
      <button data-testid="drop-e7e5" onClick={() => onPieceDrop('e7', 'e5')}>
        e7e5
      </button>
      {/* Phase 200 UAT: a SECOND black move, so a test can jump back and play a
          divergent continuation — the fork the analysis move tree must keep. */}
      <button data-testid="drop-d7d5" onClick={() => onPieceDrop('d7', 'd5')}>
        d7d5
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
  // Phase 200 (EXPLORE-05): public so teardown is directly assertable —
  // flipped true by terminate() below, never reset back to false.
  terminated = false;

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

  terminate(): void {
    this.terminated = true;
  }

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

interface StubbedWorker {
  onmessage: unknown;
  onerror: unknown;
  postMessage: unknown;
  terminate: unknown;
  /** Phase 200 (EXPLORE-05): present on `FakeWorker`, absent on the
   * `HangingWorker`/`FailingWorker` fixtures that never reach teardown tests. */
  terminated?: boolean;
}

// Phase 200 (EXPLORE-05): every Worker instance `stubWorker`'s factory hands
// out, in construction order — lets a test assert instance COUNT (one
// grading engine vs. a second, distinct exploration engine) and each
// instance's own `terminated` flag. Reset in `beforeEach` below.
let stubbedWorkerInstances: StubbedWorker[] = [];

function stubWorker(factory: () => StubbedWorker): void {
  vi.stubGlobal(
    'Worker',
    vi.fn(function (this: unknown) {
      const instance = factory();
      stubbedWorkerInstances.push(instance);
      return instance;
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

// Phase 200 UAT round 7: the same harness, but the SOLVE SCREEN can be
// unmounted and remounted (with the next session's first puzzle) while
// `useTrainSession` — and therefore its solve mutation, holding the last
// verdict — stays alive above it. That is exactly the shape of a dev-clock
// time jump: `Train.tsx`'s `returnToLanding` drops back to the landing screen,
// a NEW session is composed, and pressing Start remounts this component.
// Deliberately does NOT call `resetSolve` on the toggle, so the test pins
// TrainSolveScreen's own mount guard rather than Train.tsx's cleanup.
function RemountHarness({
  puzzle,
  nextPuzzle,
}: {
  puzzle: TrainPuzzle;
  nextPuzzle: TrainPuzzle;
}): ReactElement {
  const trainSession = useTrainSession();
  const gradingEngine = useTrainGradingEngine({ enabled: true });
  const [visible, setVisible] = useState(true);
  const [remounted, setRemounted] = useState(false);
  const { startSession } = trainSession;
  useEffect(() => {
    startSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <button
        data-testid="toggle-loop"
        onClick={() => {
          setVisible((v) => !v);
          if (visible) setRemounted(true);
        }}
      >
        toggle
      </button>
      {visible && (
        <TrainSolveScreen
          puzzle={remounted ? nextPuzzle : puzzle}
          trainSession={trainSession}
          gradingEngine={gradingEngine}
        />
      )}
    </>
  );
}

async function renderScreen(puzzle: TrainPuzzle, session: TrainSessionResponse = makeSession()) {
  composeOrResumeSession.mockResolvedValue(session);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Harness puzzle={puzzle} />
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByTestId('chessboard')).not.toBeNull());
  return result;
}

describe('TrainSolveScreen — progress, last move, grading state, engine failure, solve retry', () => {
  beforeEach(() => {
    matchMediaMatches = true; // desktop by default — see the module-scope stub
    stubbedWorkerInstances = [];
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

  // Phase 200 UAT round 3: stepping a line back to its start must restore the
  // FULL solution — both the your-move and best-move arrows. The card being
  // stepped is still spotlit at that moment (the pointer never left it), which
  // used to leave the "restored" board showing that one move alone.
  it('stepping a spotlit line back to its start drops the spotlight, so the full solution overlay returns', async () => {
    stubWorker(() => new FakeWorker('e2e4', 'e2e4 e7e5'));
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-d2d4')); // non-best -> separate your/best boxes
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());

    const board = () => screen.getByTestId('chessboard');
    await waitFor(() =>
      expect(Number(board().getAttribute('data-arrows-count'))).toBeGreaterThan(1),
    );
    const fullArrowCount = Number(board().getAttribute('data-arrows-count'));

    // Hover the your-move card (what stepping inside it implies) and step in.
    const yourBox = screen.getByTestId('train-line-box-your-move');
    fireEvent.pointerEnter(yourBox);
    await waitFor(() => expect(board().getAttribute('data-arrows-count')).toBe('1'));
    fireEvent.click(within(yourBox).getByTestId('train-line-stepper-token-0'));
    await waitFor(() => expect(screen.getByTestId('btn-train-solution')).not.toBeNull());

    // Back to the start ply WITHOUT moving the pointer off the card.
    fireEvent.click(within(yourBox).getByTestId('btn-train-step-prev'));
    await waitFor(() => expect(screen.queryByTestId('btn-train-solution')).toBeNull());
    expect(board().getAttribute('data-position')).toBe(START_FEN);
    expect(Number(board().getAttribute('data-arrows-count'))).toBe(fullArrowCount);
  });

  // Phase 200 UAT round 9: while a line is stepped, clicking ANOTHER card used
  // to move only the card ring — the board stayed at the stepped position, so
  // the clicked card's own move was nowhere on screen. It must snap back to the
  // solution position and show that card's move.
  it('clicking a card while a line is stepped returns the board to the solution position and spotlights that card', async () => {
    stubWorker(() => new FakeWorker('e2e4', 'e2e4 e7e5'));
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-d2d4')); // non-best -> separate your/best boxes
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());

    const board = () => screen.getByTestId('chessboard');
    await waitFor(() =>
      expect(Number(board().getAttribute('data-arrows-count'))).toBeGreaterThan(1),
    );

    // Step two plies into the your-move box's line — the board now shows a
    // position that no other card describes.
    const yourBox = screen.getByTestId('train-line-box-your-move');
    fireEvent.click(within(yourBox).getByTestId('train-line-stepper-token-0'));
    await waitFor(() => expect(board().getAttribute('data-position')).not.toBe(START_FEN));

    // Click the best-move card's body (not one of its buttons).
    fireEvent.click(screen.getByTestId('train-line-box-best-move'));

    await waitFor(() => expect(board().getAttribute('data-position')).toBe(START_FEN));
    // The stepped line is over (no Solution button) and the board shows the
    // clicked card's move alone — the spotlight survived the reset.
    expect(screen.queryByTestId('btn-train-solution')).toBeNull();
    expect(board().getAttribute('data-arrows-count')).toBe('1');
    expect(screen.getByTestId('train-line-box-best-move').getAttribute('data-spotlight')).toBe(
      'true',
    );
  });

  // ─── Phase 200 (LEGEND-02): reveal legend hover spotlight, end to end ─────

  it('hovering the best-move legend box spotlights its own arrow on the shared board; pointer-leave restores the full overlay', async () => {
    // played_in_game_move_uci ('d2d4') coincides with the user's own played
    // move (also 'd2d4', a non-exact-match play against FakeWorker's fixed
    // bestmove 'e2e4') — merges your+game into one box and leaves 'best' as
    // its own standalone box (train-line-box-best-move), so the spotlight
    // target and its single arrow are unambiguous.
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
    stubWorker(() => new FakeWorker('e2e4', 'e2e4 e7e5'));
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    fireEvent.click(screen.getByTestId('drop-d2d4')); // non-exact -> separate your/best boxes
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());

    const board = () => screen.getByTestId('chessboard');
    await waitFor(() =>
      expect(Number(board().getAttribute('data-arrows-count'))).toBeGreaterThan(0),
    );
    const fullArrowCount = Number(board().getAttribute('data-arrows-count'));
    expect(fullArrowCount).toBeGreaterThan(1); // a genuinely multi-arrow reveal

    const bestBox = screen.getByTestId('train-line-box-best-move');
    fireEvent.pointerEnter(bestBox);
    await waitFor(() => expect(board().getAttribute('data-arrows-count')).toBe('1'));

    fireEvent.pointerLeave(bestBox);
    await waitFor(() =>
      expect(Number(board().getAttribute('data-arrows-count'))).toBe(fullArrowCount),
    );
  });

  it('the pristine board draws ONLY the your-move and best-move arrows — the played-in-game arrow appears only while its own box is hovered (Phase 200 UAT)', async () => {
    // A game move distinct from BOTH the user's played move (d2d4) and the
    // engine's best move (e2e4), so it gets its own standalone box.
    revealPuzzle.mockResolvedValueOnce({
      game_id: 100,
      ply: 20,
      fen: START_FEN,
      played_in_game_san: 'Nf3',
      played_in_game_move_uci: 'g1f3',
      puzzle_type: 'sharp',
      source: 'sr_item',
      has_tactic_lines: false,
    });
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-d2d4')); // non-exact -> your != best
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
    // The game box exists (so its arrow IS available to spotlight)...
    const gameBox = await waitFor(() => screen.getByTestId('train-line-box-game-move'));

    // ...but the pristine board carries exactly the two your/best arrows and
    // their two badges — never the third, thin white game-move arrow.
    const board = () => screen.getByTestId('chessboard');
    await waitFor(() => expect(board().getAttribute('data-arrows-count')).toBe('2'));
    expect(board().getAttribute('data-markers-count')).toBe('2');

    fireEvent.pointerEnter(gameBox);
    await waitFor(() => expect(board().getAttribute('data-arrows-count')).toBe('1'));

    fireEvent.pointerLeave(gameBox);
    await waitFor(() => expect(board().getAttribute('data-arrows-count')).toBe('2'));
  });

  // ─── Phase 200 (LEGEND-04): the "Also fine" row, end to end ───────────────

  /** A width-aware fake Stockfish worker whose MultiPV mount search returns a
   * DISTINCT move per rank (unlike the module's own `FakeWorker`, which
   * echoes the same move for every rank) — needed to exercise a soft
   * puzzle's multiple `alsoFineMoves` entries. Every rank's score differs by
   * only 1cp, so `deriveFineMoves` classifies every rank 'good' (no
   * meaningful drop) and every rank stays a legal opening move from the
   * shared board's starting position. */
  class MultiRankFakeWorker {
    onmessage: ((e: MessageEvent<string>) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    private width = 1;
    private readonly ranked = ['e2e4', 'd2d4', 'g1f3', 'c2c4'];

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
            const move = this.ranked[rank - 1] ?? this.ranked[this.ranked.length - 1];
            this.emit(`info depth 10 multipv ${rank} score cp ${20 - rank} nodes 1000 pv ${move}`);
          }
          this.emit(`bestmove ${this.ranked[0]}`);
        });
      }
    }

    terminate(): void {}

    private emit(data: string): void {
      this.onmessage?.(new MessageEvent('message', { data }));
    }
  }

  it('a soft puzzle with three drawn alternatives lists all three SANs in the guess card; the alternatives are OFF the pristine board and appear only while that card is hovered (Phase 200 UAT)', async () => {
    stubWorker(() => new MultiRankFakeWorker());
    solvePuzzle.mockResolvedValueOnce({ ...SOLVE_RESPONSE, puzzle_type: 'soft' });
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-several'));
    // Exact match to the mount search's rank-1 move (e2e4): merges into the
    // single blue best arrow. UAT round 4 — rank 1 no longer consumes an
    // alternative slot, so ALL of ranks 2/3/4 (d2d4/g1f3/c2c4) draw, matching
    // TRAIN_SOFT_ALT_MOVE_ARROWS = the mount search's full alternative width.
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());

    // UAT round 6: the list lives in the guess card's body, and the card (not
    // the list) is the spotlight target.
    const list = await waitFor(() => screen.getByTestId('train-reveal-also-fine'));
    expect(list.textContent).toContain('d4');
    expect(list.textContent).toContain('Nf3');
    expect(list.textContent).toContain('c4');
    const card = screen.getByTestId('train-verdict-guess');

    // Phase 200 UAT: the pristine board draws ONLY your/best — here they
    // coincide, so exactly one (blue) arrow. The three alternatives are listed
    // in the card above but drawn nowhere yet.
    const board = () => screen.getByTestId('chessboard');
    await waitFor(() => expect(board().getAttribute('data-arrows-count')).toBe('1'));

    fireEvent.pointerEnter(card);
    await waitFor(() => expect(board().getAttribute('data-arrows-count')).toBe('3'));

    fireEvent.pointerLeave(card);
    await waitFor(() => expect(board().getAttribute('data-arrows-count')).toBe('1'));
  });

  // ─── 190.1 UAT round 3: Solution/Analyze/Next row below the board ─────────

  it('the Analyze/Next row appears below the board only once the verdict lands; Solution joins it once the board departs the pristine reveal (Phase 200 D-11)', async () => {
    await renderScreen(makePuzzle({ ply: 20 }));
    expect(screen.queryByTestId('btn-train-solution')).toBeNull();
    expect(screen.queryByTestId('btn-train-analyze')).toBeNull();
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('btn-train-analyze')).not.toBeNull());
    // Phase 200 (D-11): Solution is absent on the pristine reveal — nothing
    // for it to do yet.
    expect(screen.queryByTestId('btn-train-solution')).toBeNull();

    // Step the merged your/best box's first move — the board departs the
    // pristine reveal, so Solution now has a job and joins the row.
    const yourBox = screen.getByTestId('train-line-box-your-move');
    fireEvent.click(within(yourBox).getByTestId('train-line-stepper-token-0'));
    await waitFor(() => expect(screen.getByTestId('btn-train-solution')).not.toBeNull());

    const solutionBtn = screen.getByTestId('btn-train-solution');
    const analyzeBtn = screen.getByTestId('btn-train-analyze');
    const nextBtn = screen.getByTestId('btn-train-next');
    expect(solutionBtn.closest('div')).toBe(analyzeBtn.closest('div'));
    expect(analyzeBtn.closest('div')).toBe(nextBtn.closest('div'));
    // The row lives in the board column (sibling of the board+eval-bar row —
    // round 7 wrapped the chessboard for the points-flash overlay, quick
    // 260803-iv6 added the eval-bar row around that wrapper), not in the
    // reveal panel.
    const boardEl = screen.getByTestId('chessboard');
    expect(solutionBtn.closest('div')?.parentElement).toBe(
      boardEl.parentElement?.parentElement?.parentElement,
    );
    // Analyze deep-links one ply BEFORE the mistake (ply 20 -> 19).
    expect(analyzeBtn.getAttribute('href')).toBe(buildGameAnalysisUrl(100, 19));

    // Pressing Solution restores the pristine reveal, which hides it again.
    fireEvent.click(solutionBtn);
    await waitFor(() => expect(screen.queryByTestId('btn-train-solution')).toBeNull());
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

  it('a REMOUNT (dev-clock time travel -> new session) replays neither the previous session’s result sound nor its points flash (Phase 200 UAT round 7)', async () => {
    const { playSound } = await import('@/lib/sounds');
    composeOrResumeSession.mockResolvedValue(makeSession());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <RemountHarness puzzle={makePuzzle()} nextPuzzle={makePuzzle({ position: 2 })} />
          </TooltipProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('chessboard')).not.toBeNull());

    // Solve the puzzle so the shared solve mutation holds a landed verdict.
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('train-points-flash')).not.toBeNull());

    // Leave the loop and come back on the next session's first puzzle. The
    // mutation still holds the OLD verdict at this mount — it must stay silent.
    vi.mocked(playSound).mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('toggle-loop'));
    });
    expect(screen.queryByTestId('chessboard')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('toggle-loop'));
    });
    await waitFor(() => expect(screen.getByTestId('chessboard')).not.toBeNull());
    expect(playSound).not.toHaveBeenCalled();
    expect(screen.queryByTestId('train-points-flash')).toBeNull();
  });

  // ─── D-09: Analyze hidden (not disabled) when game_id is null (Phase 192) ──

  it('hides the Analyze link when the source game link is null, but Next still renders (Solution joins once a line is stepped, Phase 200 D-11)', async () => {
    await renderScreen(makePuzzle({ game_id: null, ply: 20 }));
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('btn-train-next')).not.toBeNull());
    expect(screen.queryByTestId('btn-train-analyze')).toBeNull();
    expect(screen.queryByTestId('btn-train-solution')).toBeNull();
    const yourBox = screen.getByTestId('train-line-box-your-move');
    fireEvent.click(within(yourBox).getByTestId('train-line-stepper-token-0'));
    await waitFor(() => expect(screen.getByTestId('btn-train-solution')).not.toBeNull());
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

  // ─── Phase 200 (EXPLORE-01/02/04/05, D-12): inline sideline exploration ──

  it('a post-verdict drop starts a free-play sideline on the shared board; a further drop extends it; no second grading/solve attempt is ever issued', async () => {
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4')); // the single graded attempt
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
    expect(solvePuzzle).toHaveBeenCalledTimes(1);

    const board = () => screen.getByTestId('chessboard');
    const afterE4 = new Chess(START_FEN);
    afterE4.move('e4');

    // Post-verdict drop 1: starts exploration.
    fireEvent.click(screen.getByTestId('drop-e2e4'));
    await waitFor(() => expect(board().getAttribute('data-position')).toBe(afterE4.fen()));

    // Post-verdict drop 2: EXTENDS the chain (never restarts/resets it).
    const afterE4E5 = new Chess(START_FEN);
    afterE4E5.move('e4');
    afterE4E5.move('e5');
    fireEvent.click(screen.getByTestId('drop-e7e5'));
    await waitFor(() => expect(board().getAttribute('data-position')).toBe(afterE4E5.fen()));

    // Prohibition guard: neither exploration drop touched the graded/solve
    // path — exactly the ONE solvePuzzle call from the original graded move.
    expect(solvePuzzle).toHaveBeenCalledTimes(1);
  });

  it('a drop while grading is still pending (verdict not yet landed) is rejected and never starts exploration', async () => {
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    fireEvent.click(screen.getByTestId('drop-d2d4')); // non-exact -> grading in flight, verdict still null
    // Synchronously, before the FakeWorker's queueMicrotask-deferred result
    // lands, moveApplied is already true but verdict is still null — the
    // exploration branch's own gate must reject this drop.
    fireEvent.click(screen.getByTestId('drop-e2e4'));
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
    expect(solvePuzzle).toHaveBeenCalledTimes(1);
    // No exploration ever started: the pristine reveal shows no Solution
    // button (D-11) — if the rejected drop had started exploration, it would.
    expect(screen.queryByTestId('btn-train-solution')).toBeNull();
  });

  it('Phase 200 (D-12): the side to move follows the sideline, turn order stays fully enforced, and no move is ever auto-played onto the board', async () => {
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());

    const board = () => screen.getByTestId('chessboard');
    const afterE4 = new Chess(START_FEN);
    afterE4.move('e4');
    const afterE4E5 = new Chess(START_FEN);
    afterE4E5.move('e4');
    afterE4E5.move('e5');

    // Start exploration with a white drop — now black's turn.
    fireEvent.click(screen.getByTestId('drop-e2e4'));
    await waitFor(() => expect(board().getAttribute('data-position')).toBe(afterE4.fen()));

    // Turn order is still ENFORCED, not bypassed (the Analysis-board rule): a
    // WHITE drop while it's black's turn is rejected — a build that widens
    // the branch by skipping chess.js validation (instead of tracking
    // displayFen) would wrongly accept this.
    fireEvent.click(screen.getByTestId('drop-d2d4'));
    expect(board().getAttribute('data-position')).toBe(afterE4.fen());

    // The side to move FOLLOWS the sideline: a black drop is accepted here.
    // A build that validates against the frozen boardFen instead of
    // displayFen fails this — data-position would stay stuck after-e2e4.
    fireEvent.click(screen.getByTestId('drop-e7e5'));
    await waitFor(() => expect(board().getAttribute('data-position')).toBe(afterE4E5.fen()));
    expect(board().getAttribute('data-position')?.split(' ')[1]).toBe('w');

    // No auto-reply: the position stays byte-identical after flushing
    // pending microtasks/timers — one user drop appends exactly one move,
    // and no engine result ever plays a move onto the board.
    await act(async () => {
      await Promise.resolve();
    });
    expect(board().getAttribute('data-position')).toBe(afterE4E5.fen());
  });

  // ─── Phase 200 (EXPLORE-05): second Stockfish instance + teardown ────────
  //
  // Quick 260803-iv6 (Task 1) added a THIRD standalone `useStockfishEngine`
  // instance — the eval bar's own worker, enabled the moment the verdict
  // lands (`showEvalBar`) and disabled the moment exploration starts (it
  // defers to the free-play engine's own top line instead). So the ordering
  // below is: [0] grading (mount) -> [1] eval bar (verdict lands) -> [2]
  // free play (exploration starts, [1] terminates in the same commit).

  it('grading + eval-bar Workers exist once the verdict lands; a THIRD, distinct free-play Worker appears after the first post-verdict drop', async () => {
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
    await waitFor(() => expect(stubbedWorkerInstances.length).toBe(2)); // grading + eval bar

    fireEvent.click(screen.getByTestId('drop-e2e4')); // starts exploration
    await waitFor(() => expect(stubbedWorkerInstances.length).toBe(3));
    expect(stubbedWorkerInstances[0]).not.toBe(stubbedWorkerInstances[1]);
    expect(stubbedWorkerInstances[1]).not.toBe(stubbedWorkerInstances[2]);
    // The eval-bar Worker ([1]) is disabled the instant exploration starts.
    await waitFor(() => expect(stubbedWorkerInstances[1]!.terminated).toBe(true));
  });

  it('pressing Solution terminates the exploration Worker while the grading Worker stays alive', async () => {
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
    await waitFor(() => expect(stubbedWorkerInstances.length).toBe(2)); // grading + eval bar
    fireEvent.click(screen.getByTestId('drop-e2e4')); // starts exploration
    await waitFor(() => expect(stubbedWorkerInstances.length).toBe(3));
    const gradingWorker = stubbedWorkerInstances[0]!;
    const explorationWorker = stubbedWorkerInstances[2]!;
    expect(explorationWorker.terminated).not.toBe(true);

    await waitFor(() => expect(screen.getByTestId('btn-train-solution')).not.toBeNull());
    fireEvent.click(screen.getByTestId('btn-train-solution'));
    await waitFor(() => expect(explorationWorker.terminated).toBe(true));
    expect(gradingWorker.terminated).not.toBe(true);
  });

  it('a puzzle transition while exploring terminates the exploration Worker, clears isExploring, and the next puzzle renders the pristine reveal', async () => {
    composeOrResumeSession.mockResolvedValue(makeSession());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const puzzle1 = makePuzzle({ position: 1 });
    const { rerender } = render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Harness puzzle={puzzle1} />
          </TooltipProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('chessboard')).not.toBeNull());

    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
    await waitFor(() => expect(stubbedWorkerInstances.length).toBe(2)); // grading + eval bar
    fireEvent.click(screen.getByTestId('drop-e2e4')); // starts exploration
    await waitFor(() => expect(stubbedWorkerInstances.length).toBe(3));
    const explorationWorker = stubbedWorkerInstances[2]!;
    expect(explorationWorker.terminated).not.toBe(true);
    await waitFor(() => expect(screen.getByTestId('btn-train-solution')).not.toBeNull());

    // Transition to a new puzzle (Train.tsx hands TrainSolveScreen a new
    // `puzzle` prop on the SAME component instance — never a remount). The
    // per-puzzle reset effect is keyed on puzzle.fen, so the fixture needs a
    // genuinely DIFFERENT fen, not just a different position/ply.
    const puzzle2 = makePuzzle({
      position: 2,
      ply: 30,
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
    });
    rerender(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Harness puzzle={puzzle2} />
          </TooltipProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(explorationWorker.terminated).toBe(true));
    // The new puzzle renders the pristine reveal — no Solution button, no
    // sideline carried forward.
    expect(screen.queryByTestId('btn-train-solution')).toBeNull();
  });

  it("while exploring the board carries exactly the free-play engine's blue best-move arrow, and the reveal arrows return after Solution", async () => {
    // Second Worker = the free-play engine; its PV must be a LEGAL move from
    // the exploration position (after 1.e4, black to move), so 'e7e5'.
    let workerCallCount = 0;
    stubWorker(() => {
      workerCallCount += 1;
      return workerCallCount === 1 ? new FakeWorker() : new FakeWorker('e7e5', 'e7e5');
    });
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() =>
      expect(Number(screen.getByTestId('chessboard').getAttribute('data-arrows-count'))).toBeGreaterThan(
        0,
      ),
    );
    const revealArrowCount = Number(screen.getByTestId('chessboard').getAttribute('data-arrows-count'));
    const revealMarkerCount = Number(screen.getByTestId('chessboard').getAttribute('data-markers-count'));
    expect(revealMarkerCount).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('drop-e2e4')); // starts exploration
    // Phase 200 UAT round 5 reversed the "no arrows while exploring" half of
    // EXPLORE-03: free play now shows the engine's top move as a blue arrow,
    // exactly like the analysis board. Exactly ONE arrow — the reveal overlay
    // (your/best/game/alternatives) stays off.
    const board = () => screen.getByTestId('chessboard');
    await waitFor(() => expect(board().getAttribute('data-arrows-count')).toBe('1'));
    expect(board().getAttribute('data-arrow-ucis')).toBe('e7e5');
    expect(board().getAttribute('data-arrow-colors')).toBe(TRAIN_BEST_MOVE_ARROW);
    // The "no markers while exploring" half was reversed in an earlier UAT
    // round: the freely played move carries its own live quality badge, and
    // the seeded parent eval makes the FIRST one resolve without waiting for
    // the free-play engine.
    await waitFor(() => expect(board().getAttribute('data-markers-count')).toBe('1'));

    fireEvent.click(screen.getByTestId('btn-train-solution'));
    await waitFor(() =>
      expect(Number(screen.getByTestId('chessboard').getAttribute('data-arrows-count'))).toBe(
        revealArrowCount,
      ),
    );
    expect(Number(screen.getByTestId('chessboard').getAttribute('data-markers-count'))).toBe(
      revealMarkerCount,
    );
  });

  it('the Analyze link href is unchanged while exploring (EXPLORE-06)', async () => {
    await renderScreen(makePuzzle({ game_id: 100, ply: 20 }));
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('btn-train-analyze')).not.toBeNull());
    const hrefBefore = screen.getByTestId('btn-train-analyze').getAttribute('href');
    expect(hrefBefore).toBe(buildGameAnalysisUrl(100, 19));

    fireEvent.click(screen.getByTestId('drop-e2e4')); // starts exploration
    await waitFor(() => expect(screen.getByTestId('btn-train-solution')).not.toBeNull());
    expect(screen.getByTestId('btn-train-analyze').getAttribute('href')).toBe(hrefBefore);
  });

  // ─── Phase 200 plan 04 (D-10/D-13/D-14): exploration engine card + move
  // list swap, PV click-to-play ─────────────────────────────────────────────

  it('starting exploration swaps in the engine card + move list; clicking a PV move plays it into the exploration line and moves the board', async () => {
    let workerCallCount = 0;
    stubWorker(() => {
      workerCallCount += 1;
      // First Worker = the session-scoped grading engine (default FakeWorker,
      // 'e2e4' exact-match bestmove, matching every other test in this file).
      // Second Worker = the exploration engine — its PV must be a LEGAL move
      // from the exploration position (after 1.e4, black to move), so 'e7e5'.
      return workerCallCount === 1 ? new FakeWorker() : new FakeWorker('e7e5', 'e7e5');
    });

    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());

    fireEvent.click(screen.getByTestId('drop-e2e4')); // starts exploration
    await waitFor(() => expect(screen.getByTestId('train-reveal-exploration')).not.toBeNull());
    expect(screen.getByTestId('train-exploration-engine-card')).not.toBeNull();
    // Phase 200 UAT: the move list is the Analysis page's VariationTree, and
    // the drop that started free play is already in it.
    const moveList = () => screen.getByTestId('train-exploration-moves-card');
    expect(within(moveList()).getByText('e4')).not.toBeNull();

    await waitFor(() => expect(screen.getByTestId('engine-line-0-move-0')).not.toBeNull());
    const board = () => screen.getByTestId('chessboard');
    const positionBeforeClick = board().getAttribute('data-position');

    fireEvent.click(screen.getByTestId('engine-line-0-move-0'));
    await waitFor(() => expect(board().getAttribute('data-position')).not.toBe(positionBeforeClick));
    expect(within(moveList()).getByText('e5')).not.toBeNull();
  });

  // ─── Phase 200 UAT: free-play sidelines + move quality ────────────────────

  it('a move played from a jumped-back position FORKS a sideline instead of truncating it — both continuations stay in the move list', async () => {
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());

    fireEvent.click(screen.getByTestId('drop-e2e4')); // 1. e4 — starts free play
    await waitFor(() => expect(screen.getByTestId('train-reveal-exploration')).not.toBeNull());
    fireEvent.click(screen.getByTestId('drop-e7e5')); // 1... e5
    const moveList = () => screen.getByTestId('train-exploration-moves-card');
    await waitFor(() => expect(within(moveList()).getByText('e5')).not.toBeNull());

    // Jump back to the position after 1.e4 and play a DIFFERENT black move.
    fireEvent.click(within(moveList()).getByText('e4'));
    fireEvent.click(screen.getByTestId('drop-d7d5')); // 1... d5

    // The analysis board's fork semantics: e5 survives alongside d5.
    await waitFor(() => expect(within(moveList()).getByText('d5')).not.toBeNull());
    expect(within(moveList()).getByText('e5')).not.toBeNull();
  });

  it('the free-play move list badges the played move with its quality — never a gem/great glyph, since Train runs no Maia', async () => {
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());

    // e2e4 is the stubbed grading engine's own best move, so the seeded parent
    // eval grades this free-play repeat of it as 'best' — which the move list
    // renders as the BEST badge, not the gem/great badge the Analysis page
    // would reach for with a Maia overlay available.
    fireEvent.click(screen.getByTestId('drop-e2e4'));
    const moveList = () => screen.getByTestId('train-exploration-moves-card');
    await waitFor(() => expect(within(moveList()).getByText('e4')).not.toBeNull());
    // The badge icons carry an SVG <title> as their accessible name.
    const badgeTitles = (): string[] =>
      [...moveList().querySelectorAll('svg > title')].map((t) => t.textContent ?? '');
    await waitFor(() => expect(badgeTitles()).toContain('Best move'));
    expect(badgeTitles()).not.toContain('Gem move');
    expect(badgeTitles()).not.toContain('Great move');
  });

  // ─── Phase 200 UAT round 5: free-play board controls ──────────────────────

  /** Enters free play with 1.e4 played and returns board/move-list accessors. */
  async function startFreePlay() {
    await renderScreen(makePuzzle());
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
    fireEvent.click(screen.getByTestId('drop-e2e4')); // starts free play
    await waitFor(() => expect(screen.getByTestId('train-reveal-exploration')).not.toBeNull());
    return {
      board: () => screen.getByTestId('chessboard'),
      moveList: () => screen.getByTestId('train-exploration-moves-card'),
    };
  }

  it('the free-play strip steps back and forward through the line, and Reset returns to the puzzle position without leaving free play', async () => {
    const { board, moveList } = await startFreePlay();
    const afterE4 = board().getAttribute('data-position');
    fireEvent.click(screen.getByTestId('drop-e7e5'));
    await waitFor(() => expect(within(moveList()).getByText('e5')).not.toBeNull());
    const afterE5 = board().getAttribute('data-position');

    fireEvent.click(screen.getByTestId('board-btn-back'));
    await waitFor(() => expect(board().getAttribute('data-position')).toBe(afterE4));
    fireEvent.click(screen.getByTestId('board-btn-forward'));
    await waitFor(() => expect(board().getAttribute('data-position')).toBe(afterE5));

    // Reset lands on the puzzle position but keeps the tree AND free play —
    // leaving free play is Solution's job, and the move list proves the
    // difference (the line is still listed, the exploration panel still up).
    fireEvent.click(screen.getByTestId('board-btn-reset'));
    await waitFor(() => expect(board().getAttribute('data-position')).toBe(START_FEN));
    expect(screen.getByTestId('train-reveal-exploration')).not.toBeNull();
    expect(within(moveList()).getByText('e5')).not.toBeNull();
  });

  it('Reset and Back are disabled at the puzzle position, Forward is disabled at the tip', async () => {
    const { board } = await startFreePlay();
    // At the tip of the line: nothing to advance into.
    expect(screen.getByTestId('board-btn-forward')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('board-btn-back')).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByTestId('board-btn-reset'));
    await waitFor(() => expect(board().getAttribute('data-position')).toBe(START_FEN));
    expect(screen.getByTestId('board-btn-reset')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('board-btn-back')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('board-btn-forward')).toHaveProperty('disabled', false);
  });

  it('the flip button toggles board orientation, and a puzzle transition restores the solver-color default', async () => {
    composeOrResumeSession.mockResolvedValue(makeSession());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const renderTree = (puzzle: TrainPuzzle): ReactElement => (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Harness puzzle={puzzle} />
          </TooltipProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
    const { rerender } = render(renderTree(makePuzzle({ position: 1 })));
    await waitFor(() => expect(screen.getByTestId('chessboard')).not.toBeNull());

    const board = () => screen.getByTestId('chessboard');
    expect(board().getAttribute('data-flipped')).toBe('false'); // white to move
    fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('drop-e2e4'));
    });
    await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
    fireEvent.click(screen.getByTestId('drop-e2e4')); // starts free play
    await waitFor(() => expect(screen.getByTestId('train-reveal-exploration')).not.toBeNull());

    fireEvent.click(screen.getByTestId('board-btn-flip'));
    await waitFor(() => expect(board().getAttribute('data-flipped')).toBe('true'));

    // Orientation is a per-position affordance, not a session preference — the
    // next puzzle starts at its own solver-color default again.
    rerender(
      renderTree(
        makePuzzle({
          position: 2,
          ply: 30,
          fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
        }),
      ),
    );
    await waitFor(() => expect(board().getAttribute('data-flipped')).toBe('false'));
  });

  // ─── Quick 260803-iv6 (Task 1): live Stockfish eval bar beside the board ──

  describe('live Stockfish eval bar', () => {
    it('is absent while the guess buttons are on screen and while grading is in flight, and present with a real evaluation once the reveal opens', async () => {
      await renderScreen(makePuzzle());
      expect(screen.queryByTestId('train-eval-bar')).toBeNull();

      fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
      expect(screen.queryByTestId('train-eval-bar')).toBeNull(); // T-iv6-01: guess committed, no move yet

      // Non-exact move -> a second grading search runs. Checked SYNCHRONOUSLY
      // (no intervening `await`/`waitFor`) — the FakeWorker's response is
      // already microtask-queued by the time `fireEvent.click` returns, so an
      // `await` here would let it drain before this assertion runs.
      fireEvent.click(screen.getByTestId('drop-d2d4'));
      expect(screen.getByTestId('train-grading-indicator')).not.toBeNull();
      expect(screen.queryByTestId('train-eval-bar')).toBeNull(); // T-iv6-01: verdict not landed yet

      await waitFor(() => expect(screen.getByTestId('train-verdict-guess')).not.toBeNull());
      await waitFor(() => expect(screen.getByTestId('train-eval-bar')).not.toBeNull());
      // aria-label reflects a real engine evaluation, not the 0.00 neutral
      // reading a still-idle bar would show.
      await waitFor(() => {
        const label = screen.getByTestId('train-eval-bar').getAttribute('aria-label') ?? '';
        expect(label).not.toBe('Engine evaluation: 0.00');
      });
    });

    it('follows the board through reveal-line stepping — the SAME FEN the ChessBoard renders drives the bar', async () => {
      stubWorker(() => new FakeWorker('e2e4', 'e2e4 e7e5'));
      await renderScreen(makePuzzle({ last_move_uci: 'd7d5' }));
      fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('drop-e2e4')); // exact match -> played IS best
      });
      await waitFor(() => expect(screen.getByTestId('train-eval-bar')).not.toBeNull());

      const board = () => screen.getByTestId('chessboard');
      const positionAtSolution = board().getAttribute('data-position');

      // Step into the merged your/best box's line — the board moves off the
      // puzzle position, and the bar must stay mounted and keep tracking it
      // (never disappear just because the position is no longer the puzzle's).
      const yourBox = screen.getByTestId('train-line-box-your-move');
      fireEvent.click(within(yourBox).getByTestId('train-line-stepper-token-0'));
      await waitFor(() => expect(board().getAttribute('data-position')).not.toBe(positionAtSolution));
      expect(screen.getByTestId('train-eval-bar')).not.toBeNull();
      await waitFor(() => {
        const label = screen.getByTestId('train-eval-bar').getAttribute('aria-label') ?? '';
        expect(label).not.toBe('Engine evaluation: 0.00');
      });
    });

    it('while exploring, the bar reads the free-play engine\'s own top line instead of running a second concurrent search', async () => {
      let workerCallCount = 0;
      stubWorker(() => {
        workerCallCount += 1;
        // [0] grading, [1] eval bar (verdict lands before exploring), [2] free
        // play — all three legal from their respective positions.
        return workerCallCount <= 2 ? new FakeWorker() : new FakeWorker('e7e5', 'e7e5');
      });
      await renderScreen(makePuzzle());
      fireEvent.click(screen.getByTestId('btn-train-guess-critical'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('drop-e2e4'));
      });
      await waitFor(() => expect(screen.getByTestId('train-eval-bar')).not.toBeNull());
      await waitFor(() => expect(stubbedWorkerInstances.length).toBe(2)); // grading + eval bar

      fireEvent.click(screen.getByTestId('drop-e2e4')); // starts exploration
      await waitFor(() => expect(stubbedWorkerInstances.length).toBe(3)); // + free play
      // The eval bar's OWN worker (index 1) is torn down — exploration never
      // runs a second concurrent search alongside the free-play engine's.
      await waitFor(() => expect(stubbedWorkerInstances[1]!.terminated).toBe(true));
      // The bar keeps rendering, fed by the free-play engine's top line.
      expect(screen.getByTestId('train-eval-bar')).not.toBeNull();
    });
  });
});
