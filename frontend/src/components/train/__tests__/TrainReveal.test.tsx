// @vitest-environment jsdom
/**
 * TrainReveal.test.tsx — 190.1-03 coverage, updated for UAT round 3: the
 * guess verdict line, the three steppable engine-line boxes with coincidence
 * merging (move SAN in the title, the move verdict as the Your-move box's
 * header mark, Best-move box first on a miss), D-11 outcome copy, D-12
 * mastered hint (countdown removed), and the "Game: TC · vs opponent (elo) ·
 * date" footer. The tactic opt-in stepper was removed (190.1 UAT round 4).
 * The Solution/Analyze/Next row moved to TrainSolveScreen (tested there).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ComponentProps } from 'react';
import { TrainReveal } from '@/components/train/TrainReveal';
import { formatScore } from '@/components/analysis/EngineLines';
import { formatDateWithYear } from '@/lib/utils';
import type { GradeResult, TrainEngineLine, TrainGradingEngine } from '@/hooks/useTrainGradingEngine';
import type { PuzzleRevealResponse, SolveResponse, TrainPuzzle } from '@/types/train';
import type { GameFlawCard } from '@/types/library';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ─── api/client mock ────────────────────────────────────────────────────────

const revealPuzzle = vi.fn<(sessionId: number, position: number) => Promise<PuzzleRevealResponse>>();
const getGame = vi.fn();

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    trainApi: {
      ...actual.trainApi,
      revealPuzzle: (sessionId: number, position: number) => revealPuzzle(sessionId, position),
    },
    libraryApi: {
      ...actual.libraryApi,
      getGame: (gameId: number) => getGame(gameId),
    },
  };
});

// 190.1 UAT round 4: the line steppers play move sounds — mocked so jsdom
// never touches real Audio machinery.
vi.mock('@/lib/sounds', () => ({
  playSound: vi.fn(),
}));

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makePuzzle(overrides: Partial<TrainPuzzle> = {}): TrainPuzzle {
  return {
    position: 5,
    game_id: 100,
    ply: 20,
    fen: START_FEN,
    side_to_move: 'white',
    last_move_uci: 'd7d5',
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<SolveResponse> = {}): SolveResponse {
  return {
    correct_guess: true,
    correct_move: true,
    puzzle_type: 'sharp',
    item_status: 'active',
    streak: 1,
    due_date: '2026-08-01',
    session_complete: false,
    ...overrides,
  };
}

function makeReveal(overrides: Partial<PuzzleRevealResponse> = {}): PuzzleRevealResponse {
  return {
    game_id: 100,
    ply: 20,
    fen: START_FEN,
    played_in_game_san: null,
    played_in_game_move_uci: null,
    puzzle_type: 'sharp',
    source: 'sr_item',
    has_tactic_lines: false,
    ...overrides,
  };
}

function makeEngineLine(overrides: Partial<TrainEngineLine> = {}): TrainEngineLine {
  return { moves: ['e2e4'], evalCp: 50, evalMate: null, ...overrides };
}

function makeGradeResult(overrides: Partial<GradeResult> = {}): GradeResult {
  return {
    correctMove: true,
    bestMoveUci: 'e2e4',
    esBefore: 0.5,
    esAfter: 0.5,
    bestLine: makeEngineLine(),
    playedLine: makeEngineLine(),
    fineMoves: [{ uci: 'e2e4', quality: 'good' }],
    ...overrides,
  };
}

/** Stub `TrainGradingEngine` (190.1-01) — only `startGameMoveSearch` matters
 * to TrainReveal; the other members are never called from this component. */
function makeGradingEngine(overrides: Partial<TrainGradingEngine> = {}): TrainGradingEngine {
  return {
    isReady: true,
    hasError: false,
    startGrading: vi.fn(),
    abortGrading: vi.fn(),
    restartEngine: vi.fn(),
    gradeMove: vi.fn(),
    startGameMoveSearch: vi.fn<(puzzleFen: string, gameMoveUci: string) => Promise<TrainEngineLine>>()
      .mockResolvedValue({ moves: [], evalCp: null, evalMate: null }),
    ...overrides,
  };
}

/** Minimal `GameFlawCard` fixture (Task 2's footer only reads
 * user_color/white_username/black_username/played_at). */
function makeGame(overrides: Partial<GameFlawCard> = {}): GameFlawCard {
  return {
    game_id: 100,
    user_result: 'win',
    played_at: '2026-07-20T12:00:00Z',
    time_control_bucket: 'blitz',
    platform: 'lichess',
    platform_url: null,
    white_username: 'alice',
    black_username: 'bob',
    white_rating: 1500,
    black_rating: 1500,
    opening_name: null,
    opening_eco: null,
    user_color: 'white',
    ply_count: 40,
    termination: 'checkmate',
    time_control_str: '5+0',
    result_fen: null,
    severity_counts: null,
    white_accuracy: null,
    black_accuracy: null,
    chips: [],
    analysis_state: 'no_engine_analysis',
    eval_series: null,
    flaw_markers: null,
    phase_transitions: null,
    moves: null,
    active_eval_status: null,
    opening_ply_count: 0,
    ...overrides,
  };
}

function renderReveal(
  props: Partial<ComponentProps<typeof TrainReveal>> = {},
  queryClient?: QueryClient,
) {
  const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fullProps: ComponentProps<typeof TrainReveal> = {
    puzzle: makePuzzle(),
    sessionId: 1,
    verdict: makeVerdict(),
    isSolveError: false,
    onRetrySolve: vi.fn(),
    onNext: vi.fn(),
    onFenChange: vi.fn(),
    gradingEngine: makeGradingEngine(),
    guess: null,
    playedMoveUci: null,
    gradeResult: null,
    ...props,
  };
  const result = render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <TrainReveal {...fullProps} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...result, client, props: fullProps };
}

describe('TrainReveal', () => {
  beforeEach(() => {
    revealPuzzle.mockReset();
    getGame.mockReset();
    revealPuzzle.mockResolvedValue(makeReveal());
    getGame.mockResolvedValue(makeGame());
  });

  afterEach(() => {
    cleanup();
  });

  // ─── Verdict rows (190.1-03 D-03) ─────────────────────────────────────────

  it('verdict-guess row states the spelled-out critical-option wording and the incorrect mark for a wrong critical guess', () => {
    renderReveal({ guess: 'critical', verdict: makeVerdict({ correct_guess: false }) });
    const text = screen.getByTestId('train-verdict-guess').textContent ?? '';
    expect(text).toContain('One critical move');
    expect(text).toContain('✗');
    expect(text).not.toContain('+1 point');
  });

  it('verdict-guess row states the spelled-out several-fine wording without a points suffix (UAT round 3)', () => {
    renderReveal({ guess: 'several', verdict: makeVerdict({ correct_guess: true }) });
    const text = screen.getByTestId('train-verdict-guess').textContent ?? '';
    expect(text).toContain('Several fine moves');
    expect(text).toContain('✓');
    expect(text).not.toContain('+1 point');
  });

  it('the move verdict renders as the Your-move box header: SAN (not raw UCI) plus the check mark (UAT round 3)', async () => {
    // A correct-but-not-best move (soft puzzle): the Your-move box stands
    // alone, so the header is exactly "Your move: <san> ✓".
    const gradeResult = makeGradeResult({
      bestLine: makeEngineLine({ moves: ['e2e4'] }),
      playedLine: makeEngineLine({ moves: ['d2d4'] }),
    });
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult,
      verdict: makeVerdict({ correct_move: true, puzzle_type: 'soft' }),
    });
    await waitFor(() => expect(screen.getByTestId('train-line-box-your-move')).not.toBeNull());
    const title =
      screen
        .getByTestId('train-line-box-your-move')
        .querySelector('[data-testid="train-line-stepper-title"]')?.textContent ?? '';
    expect(title).toContain('Your move: d4');
    expect(title.includes('d2d4')).toBe(false);
    expect(title).toContain('✓');
    // The old standalone move-verdict row is gone.
    expect(screen.queryByTestId('train-verdict-move')).toBeNull();
  });

  it('an incorrect move keeps the Your-move box FIRST and marks it with the cross (UAT round 5, reversing round 3)', async () => {
    const gradeResult = makeGradeResult({
      correctMove: false,
      bestLine: makeEngineLine({ moves: ['e2e4'] }),
      playedLine: makeEngineLine({ moves: ['d2d4'] }),
    });
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult,
      verdict: makeVerdict({ correct_move: false }),
    });
    await waitFor(() => expect(screen.getByTestId('train-line-box-your-move')).not.toBeNull());
    const bestBox = screen.getByTestId('train-line-box-best-move');
    const yourBox = screen.getByTestId('train-line-box-your-move');
    // DOM order: Your move on top of Best move, even on a miss.
    expect(yourBox.compareDocumentPosition(bestBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const yourTitle =
      yourBox.querySelector('[data-testid="train-line-stepper-title"]')?.textContent ?? '';
    expect(yourTitle).toContain('✗');
    const bestTitle =
      bestBox.querySelector('[data-testid="train-line-stepper-title"]')?.textContent ?? '';
    expect(bestTitle).toContain('Best move: e4');
    expect(bestTitle).not.toContain('✗');
  });

  // ─── Outcome copy (D-11, 190.1-03 assumption-delta) ───────────────────────

  it('a herring renders the herring sentence, never a miss sentence', async () => {
    renderReveal({
      verdict: makeVerdict({
        correct_move: false,
        puzzle_type: 'herring',
        item_status: null,
        due_date: null,
        streak: null,
      }),
    });
    await waitFor(() => expect(screen.getByTestId('train-outcome-copy')).not.toBeNull());
    expect(screen.getByTestId('train-outcome-copy').textContent).toBe(
      'You handled this well in the game — several moves are fine.',
    );
  });

  it('a genuine miss (non-herring) renders no outcome sentence at all — the miss sentence is retired', async () => {
    renderReveal({ verdict: makeVerdict({ correct_move: false, puzzle_type: 'sharp' }) });
    await waitFor(() => expect(getGame).toHaveBeenCalled());
    expect(screen.queryByTestId('train-outcome-copy')).toBeNull();
  });

  it('a correct, non-herring solve renders no outcome sentence at all', async () => {
    renderReveal({ verdict: makeVerdict({ correct_move: true, puzzle_type: 'sharp' }) });
    await waitFor(() => expect(getGame).toHaveBeenCalled());
    expect(screen.queryByTestId('train-outcome-copy')).toBeNull();
  });

  // ─── Comeback hint (D-12, countdown removed per UAT round 3) ──────────────

  it('an active spaced-repetition item renders NO comeback countdown (removed in UAT round 3)', () => {
    renderReveal({ verdict: makeVerdict({ item_status: 'active', due_date: '2026-07-28' }) });
    expect(screen.queryByTestId('train-comeback-hint')).toBeNull();
  });

  it('a mastered item renders the plain retired text, not a celebration', () => {
    renderReveal({ verdict: makeVerdict({ item_status: 'mastered', due_date: null }) });
    expect(screen.getByTestId('train-comeback-hint').textContent).toBe('Mastered — retired.');
  });

  it('a herring renders no comeback line at all', () => {
    renderReveal({
      verdict: makeVerdict({ puzzle_type: 'herring', item_status: null, due_date: null, streak: null }),
    });
    expect(screen.queryByTestId('train-comeback-hint')).toBeNull();
  });

  // ─── Steppable engine-line boxes (190.1-03 D-03) ──────────────────────────

  it('no engine data at all renders no line box', async () => {
    revealPuzzle.mockResolvedValue(makeReveal());
    renderReveal();
    await waitFor(() => expect(getGame).toHaveBeenCalled());
    expect(screen.queryByTestId('train-line-stepper')).toBeNull();
  });

  it('three distinct moves render all three line boxes, each with its own eval', async () => {
    revealPuzzle.mockResolvedValue(
      makeReveal({ played_in_game_san: 'Nf3', played_in_game_move_uci: 'g1f3' }),
    );
    const gradeResult = makeGradeResult({
      bestLine: makeEngineLine({ moves: ['e2e4'], evalCp: 50, evalMate: null }),
      playedLine: makeEngineLine({ moves: ['d2d4'], evalCp: 10, evalMate: null }),
    });
    const startGameMoveSearch = vi
      .fn()
      .mockResolvedValue(makeEngineLine({ moves: ['g1f3'], evalCp: -20, evalMate: null }));
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult,
      gradingEngine: makeGradingEngine({ startGameMoveSearch }),
    });

    await waitFor(() => expect(screen.getByTestId('train-line-box-your-move')).not.toBeNull());
    expect(screen.getByTestId('train-line-box-best-move')).not.toBeNull();
    await waitFor(() => expect(screen.getByTestId('train-line-box-game-move')).not.toBeNull());

    const yourEval = screen
      .getByTestId('train-line-box-your-move')
      .querySelector('[data-testid="train-line-stepper-eval"]');
    expect(yourEval?.textContent).toBe(formatScore(10, null));

    const bestEval = screen
      .getByTestId('train-line-box-best-move')
      .querySelector('[data-testid="train-line-stepper-eval"]');
    expect(bestEval?.textContent).toBe(formatScore(50, null));

    await waitFor(() => {
      const gameEval = screen
        .getByTestId('train-line-box-game-move')
        .querySelector('[data-testid="train-line-stepper-eval"]');
      expect(gameEval?.textContent).toBe(formatScore(-20, null));
    });
    expect(startGameMoveSearch).toHaveBeenCalledWith(START_FEN, 'g1f3');
  });

  it('played move equals best move merges into a single box under train-line-box-your-move', async () => {
    const gradeResult = makeGradeResult({
      bestLine: makeEngineLine({ moves: ['e2e4'], evalCp: 50, evalMate: null }),
      playedLine: makeEngineLine({ moves: ['e2e4'], evalCp: 50, evalMate: null }),
    });
    renderReveal({ guess: 'critical', playedMoveUci: 'e2e4', gradeResult });
    await waitFor(() => expect(screen.getByTestId('train-line-box-your-move')).not.toBeNull());
    const box = screen.getByTestId('train-line-box-your-move');
    expect(box.textContent).toContain('Your move');
    expect(box.textContent).toContain('Best move');
    expect(screen.queryByTestId('train-line-box-best-move')).toBeNull();
  });

  it('game move equals best move merges into a single box under train-line-box-best-move with no reveal-time search dispatched', async () => {
    revealPuzzle.mockResolvedValue(
      makeReveal({ played_in_game_san: 'e4', played_in_game_move_uci: 'e2e4' }),
    );
    const gradeResult = makeGradeResult({
      bestLine: makeEngineLine({ moves: ['e2e4'], evalCp: 50, evalMate: null }),
      playedLine: makeEngineLine({ moves: ['d2d4'], evalCp: 10, evalMate: null }),
    });
    const startGameMoveSearch = vi.fn();
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult,
      gradingEngine: makeGradingEngine({ startGameMoveSearch }),
    });
    // Waits for the MERGED text specifically (not just the box's initial,
    // pre-reveal-fetch render) — the reveal GET resolves asynchronously, so
    // the box exists (best-alone) before it exists (best+game merged).
    await waitFor(() =>
      expect(screen.getByTestId('train-line-box-best-move').textContent).toContain('Played in game'),
    );
    expect(screen.getByTestId('train-line-box-best-move').textContent).toContain('Best move');
    expect(screen.queryByTestId('train-line-box-game-move')).toBeNull();
    expect(startGameMoveSearch).not.toHaveBeenCalled();
  });

  it('game move equals played move merges into a single box under train-line-box-your-move with no reveal-time search dispatched', async () => {
    revealPuzzle.mockResolvedValue(
      makeReveal({ played_in_game_san: 'd4', played_in_game_move_uci: 'd2d4' }),
    );
    const gradeResult = makeGradeResult({
      bestLine: makeEngineLine({ moves: ['e2e4'], evalCp: 50, evalMate: null }),
      playedLine: makeEngineLine({ moves: ['d2d4'], evalCp: 10, evalMate: null }),
    });
    const startGameMoveSearch = vi.fn();
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult,
      gradingEngine: makeGradingEngine({ startGameMoveSearch }),
    });
    // Waits for the MERGED text specifically — see the sibling test's comment.
    await waitFor(() =>
      expect(screen.getByTestId('train-line-box-your-move').textContent).toContain('Played in game'),
    );
    expect(screen.getByTestId('train-line-box-your-move').textContent).toContain('Your move');
    expect(screen.queryByTestId('train-line-box-game-move')).toBeNull();
    expect(startGameMoveSearch).not.toHaveBeenCalled();
  });

  it('onGameMoveUciChange reports the resolved game-move UCI, and null on unmount (190.1-04)', async () => {
    revealPuzzle.mockResolvedValue(
      makeReveal({ played_in_game_san: 'e4', played_in_game_move_uci: 'e2e4' }),
    );
    const onGameMoveUciChange = vi.fn();
    const { unmount } = renderReveal({
      gradingEngine: makeGradingEngine({ startGameMoveSearch: vi.fn().mockResolvedValue(makeEngineLine()) }),
      onGameMoveUciChange,
    });
    await waitFor(() => expect(onGameMoveUciChange).toHaveBeenCalledWith('e2e4'));
    unmount();
    expect(onGameMoveUciChange).toHaveBeenLastCalledWith(null);
  });

  it('onGameMoveLineChange reports the reveal-time search result, and null on unmount (190.1 UAT)', async () => {
    revealPuzzle.mockResolvedValue(
      makeReveal({ played_in_game_san: 'e4', played_in_game_move_uci: 'e2e4' }),
    );
    const searchedLine = makeEngineLine({ moves: ['e2e4', 'e7e5'], evalCp: -120 });
    const onGameMoveLineChange = vi.fn();
    const { unmount } = renderReveal({
      gradingEngine: makeGradingEngine({
        startGameMoveSearch: vi.fn().mockResolvedValue(searchedLine),
      }),
      onGameMoveLineChange,
    });
    await waitFor(() => expect(onGameMoveLineChange).toHaveBeenCalledWith(searchedLine));
    unmount();
    expect(onGameMoveLineChange).toHaveBeenLastCalledWith(null);
  });

  it('a non-null played_in_game_move_uci dispatches the reveal-time search on the puzzle fen and renders its eval', async () => {
    revealPuzzle.mockResolvedValue(
      makeReveal({ played_in_game_san: 'e4', played_in_game_move_uci: 'e2e4' }),
    );
    const startGameMoveSearch = vi
      .fn()
      .mockResolvedValue({ moves: ['e2e4', 'e7e5'], evalCp: 35, evalMate: null });
    renderReveal({ gradingEngine: makeGradingEngine({ startGameMoveSearch }) });
    await waitFor(() => expect(screen.getByTestId('train-line-box-game-move')).not.toBeNull());
    await waitFor(() =>
      expect(screen.getByTestId('train-line-stepper-eval').textContent).toBe(formatScore(35, null)),
    );
    expect(startGameMoveSearch).toHaveBeenCalledWith(START_FEN, 'e2e4');
  });

  it('a game-move search that never settles renders the loading state, and the verdict rows still render (190.1-01 Task 2)', async () => {
    revealPuzzle.mockResolvedValue(
      makeReveal({ played_in_game_san: 'e4', played_in_game_move_uci: 'e2e4' }),
    );
    const startGameMoveSearch = vi.fn().mockReturnValue(new Promise(() => {})); // never settles
    renderReveal({ gradingEngine: makeGradingEngine({ startGameMoveSearch }) });
    await waitFor(() => expect(screen.getByTestId('train-game-line-loading')).not.toBeNull());
    expect(screen.getByTestId('train-verdict-guess')).not.toBeNull();
  });

  it('a rejecting game-move search renders the error state with no eval, and the other reveal blocks still render (190.1-01 Task 2)', async () => {
    revealPuzzle.mockResolvedValue(
      makeReveal({ played_in_game_san: 'e4', played_in_game_move_uci: 'e2e4' }),
    );
    const startGameMoveSearch = vi.fn().mockRejectedValue(new Error('search failed'));
    // bestLine deliberately distinct from BOTH the played move and the game
    // move ('e2e4') — otherwise the coincidence-merge guard would skip the
    // reveal-time search this test exists to exercise.
    const gradeResult = makeGradeResult({
      bestLine: makeEngineLine({ moves: ['g1f3'] }),
      playedLine: makeEngineLine({ moves: ['d2d4'] }),
    });
    renderReveal({
      playedMoveUci: 'd2d4',
      gradeResult,
      gradingEngine: makeGradingEngine({ startGameMoveSearch }),
    });
    await waitFor(() => expect(screen.getByTestId('train-game-line-error')).not.toBeNull());
    const gameMoveBox = screen.getByTestId('train-line-box-game-move');
    expect(gameMoveBox.querySelector('[data-testid="train-line-stepper-eval"]')).toBeNull();
    // The other reveal blocks (verdict rows, your-move line) still render normally.
    expect(screen.getByTestId('train-verdict-guess')).not.toBeNull();
    expect(screen.getByTestId('train-line-box-your-move')).not.toBeNull();
  });

  // ─── Tactic opt-in (SOLV-06) — REMOVED per 190.1 UAT round 4 ──────────────

  it('a tactic-tagged reveal renders NO tactic opt-in trigger (removed, UAT round 4)', async () => {
    revealPuzzle.mockResolvedValue(makeReveal({ has_tactic_lines: true }));
    renderReveal();
    await waitFor(() => expect(getGame).toHaveBeenCalled());
    expect(screen.queryByTestId('btn-train-tactic-step')).toBeNull();
  });

  // ─── Opponent-and-date footer (190.1-03 D-03, Task 2) ─────────────────────

  it('the game-card query is disabled while the solve response is absent, and enabled once it is present', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender, props } = renderReveal({ verdict: null, isSolveError: false }, client);
    expect(getGame).not.toHaveBeenCalled();

    rerender(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <TrainReveal {...props} verdict={makeVerdict()} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(getGame).toHaveBeenCalledTimes(1));
  });

  it('footer reads "Game: TC · vs OPPONENT (elo) · date" with the BLACK side as opponent for a user_color: white fixture', async () => {
    getGame.mockResolvedValue(
      makeGame({
        user_color: 'white',
        black_username: 'bob',
        black_rating: 1622,
        time_control_bucket: 'blitz',
        time_control_str: '300',
        played_at: '2026-07-20T12:00:00Z',
      }),
    );
    renderReveal();
    await waitFor(() => expect(screen.getByTestId('train-reveal-footer')).not.toBeNull());
    const text = screen.getByTestId('train-reveal-footer').textContent ?? '';
    expect(text).toContain('Game:');
    expect(text).toContain('blitz');
    expect(text).toContain('vs bob (1622)');
    expect(text).toContain(formatDateWithYear('2026-07-20T12:00:00Z'));
  });

  it('footer names the WHITE username and rating for a user_color: black fixture', async () => {
    getGame.mockResolvedValue(
      makeGame({ user_color: 'black', white_username: 'alice', white_rating: 1480 }),
    );
    renderReveal();
    await waitFor(() => expect(screen.getByTestId('train-reveal-footer')).not.toBeNull());
    expect(screen.getByTestId('train-reveal-footer').textContent).toContain('vs alice (1480)');
  });

  it('the game fetch failing renders train-gamecard-error while the rest of the reveal still renders', async () => {
    getGame.mockRejectedValue(new Error('boom'));
    renderReveal();
    await waitFor(() => expect(screen.getByTestId('train-gamecard-error')).not.toBeNull());
    expect(screen.getByTestId('train-verdict-guess')).not.toBeNull();
  });

  // ─── Line-box quality icons + stepping reports (190.1 UAT) ────────────────

  it('line-box headers carry the quality icon: star quality on the best box, the played quality on the your-move box', async () => {
    const gradeResult = makeGradeResult({
      bestLine: makeEngineLine({ moves: ['e2e4'] }),
      playedLine: makeEngineLine({ moves: ['d2d4'] }),
    });
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult,
      playedMoveQuality: 'mistake',
    });
    await waitFor(() => expect(screen.getByTestId('train-line-box-your-move')).not.toBeNull());
    const yourIcon = screen
      .getByTestId('train-line-box-your-move')
      .querySelector('[data-testid="train-line-stepper-quality"]');
    expect(yourIcon?.getAttribute('data-quality')).toBe('mistake');
    const bestIcon = screen
      .getByTestId('train-line-box-best-move')
      .querySelector('[data-testid="train-line-stepper-quality"]');
    expect(bestIcon?.getAttribute('data-quality')).toBe('best');
  });

  it('stepping a line reports the stepped move with its quality (first move = box quality, deeper = good/green), and back-to-start reports null', async () => {
    const gradeResult = makeGradeResult({
      bestLine: makeEngineLine({ moves: ['e2e4'] }),
      playedLine: makeEngineLine({ moves: ['d2d4', 'd7d5'] }),
    });
    const onLineStep = vi.fn();
    const onFenChange = vi.fn();
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult,
      playedMoveQuality: 'blunder',
      onLineStep,
      onFenChange,
    });
    await waitFor(() => expect(screen.getByTestId('train-line-box-your-move')).not.toBeNull());
    const yourBox = screen.getByTestId('train-line-box-your-move');

    fireEvent.click(within(yourBox).getByTestId('btn-train-step-next'));
    expect(onLineStep).toHaveBeenLastCalledWith({
      lastMoveUci: 'd2d4',
      quality: 'blunder',
      nextMoveUci: 'd7d5',
      isFirstMove: true,
    });

    // Deeper into the line: an engine continuation, reported as 'good' so the
    // square highlight reads green, not the gem-adjacent blue (UAT round 3).
    fireEvent.click(within(yourBox).getByTestId('btn-train-step-next'));
    expect(onLineStep).toHaveBeenLastCalledWith({
      lastMoveUci: 'd7d5',
      quality: 'good',
      nextMoveUci: null,
      isFirstMove: false,
    });

    fireEvent.click(within(yourBox).getByTestId('btn-train-step-prev'));
    fireEvent.click(within(yourBox).getByTestId('btn-train-step-prev'));
    expect(onLineStep).toHaveBeenLastCalledWith(null);
  });

  it('bumping the solutionNonce prop resets stepped lines to the puzzle position and reports a null step (UAT round 3 — the Solution button lives in TrainSolveScreen)', async () => {
    const gradeResult = makeGradeResult({
      bestLine: makeEngineLine({ moves: ['e2e4'] }),
      playedLine: makeEngineLine({ moves: ['d2d4', 'd7d5'] }),
    });
    const onLineStep = vi.fn();
    const onFenChange = vi.fn();
    const { rerender, client, props } = renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult,
      playedMoveQuality: 'blunder',
      onLineStep,
      onFenChange,
    });
    await waitFor(() => expect(screen.getByTestId('train-line-box-your-move')).not.toBeNull());
    const yourBox = screen.getByTestId('train-line-box-your-move');
    fireEvent.click(within(yourBox).getByTestId('btn-train-step-next'));
    expect(onLineStep).toHaveBeenLastCalledWith(expect.objectContaining({ lastMoveUci: 'd2d4' }));

    onFenChange.mockClear();
    rerender(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <TrainReveal {...props} solutionNonce={1} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    // The steppers' own index-0 reports land back on the puzzle position.
    expect(onLineStep).toHaveBeenLastCalledWith(null);
    expect(onFenChange).toHaveBeenLastCalledWith(makePuzzle().fen);
  });
});
