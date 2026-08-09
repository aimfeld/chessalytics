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
import { MemoryRouter } from 'react-router';
import type { ComponentProps } from 'react';
import { TrainReveal } from '@/components/train/TrainReveal';
import { TooltipProvider } from '@/components/ui/tooltip';
import { formatScore } from '@/components/analysis/EngineLines';
import { formatDateWithYear } from '@/lib/utils';
import { guessFeedbackProse } from '@/lib/trainGuessLabels';
import type { GradeResult, TrainEngineLine, TrainGradingEngine } from '@/hooks/useTrainGradingEngine';
import type { TrainFreePlayState } from '@/hooks/useTrainFreePlay';
import type { PvLine } from '@/hooks/uciParser';
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

// ─── matchMedia stub (Phase 200: useIsDesktop) ─────────────────────────────
// Controllable per test (Bots.test.tsx L221 jsdom-shim precedent, with a
// settable `matches` instead of a fixed `false`) so both the desktop-hover
// (D-06) and mobile-tap (D-08) paths are exercisable in the same file.
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
    move_quality: 'good',
    puzzle_type: 'sharp',
    // Phase 206 (D-19): defaults to 'sr_item' so pre-existing callers that
    // only override `puzzle_type` keep exercising the "own game" branch at
    // all three D-19 sites exactly as before this field existed.
    source: 'sr_item',
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
    motif: null,
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

/** Stub `TrainFreePlayState` (Phase 200 plan 04, reworked per Phase 200 UAT) —
 * a fixed one-node tree, since none of this file's free-play-swap tests
 * exercise the hook's own navigation/grading logic (that's
 * `useTrainFreePlay.test.ts`'s job). */
function makeFreePlayState(overrides: Partial<TrainFreePlayState> = {}): TrainFreePlayState {
  return {
    isExploring: true,
    fen: START_FEN,
    lastMove: null,
    lastMoveColor: undefined,
    boardMarkers: [],
    nodes: new Map(),
    mainLine: [],
    currentNodeId: null,
    rootPly: 0,
    moveListMarkers: new Map(),
    pvLines: [],
    isAnalyzing: false,
    start: vi.fn(),
    playMove: vi.fn(),
    playLine: vi.fn(),
    goToNode: vi.fn(),
    deleteLine: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}

function makePvLine(overrides: Partial<PvLine> = {}): PvLine {
  return { multipv: 1, depth: 12, moves: ['e7e5', 'g1f3'], evalCp: 30, evalMate: null, ...overrides };
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
        <TooltipProvider>
          <TrainReveal {...fullProps} />
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...result, client, props: fullProps };
}

describe('TrainReveal', () => {
  beforeEach(() => {
    matchMediaMatches = true; // desktop by default — see the module-scope stub
    revealPuzzle.mockReset();
    getGame.mockReset();
    revealPuzzle.mockResolvedValue(makeReveal());
    getGame.mockResolvedValue(makeGame());
  });

  afterEach(() => {
    cleanup();
  });

  // ─── Verdict rows (190.1-03 D-03) ─────────────────────────────────────────

  // Phase 200 UAT round 3: the ✓/✗ marks became score chips stating the
  // points actually earned (guess: 1 or 0).
  it('verdict-guess row states the spelled-out critical-option wording and a +0 chip for a wrong critical guess', () => {
    renderReveal({ guess: 'critical', verdict: makeVerdict({ correct_guess: false }) });
    const text = screen.getByTestId('train-verdict-guess').textContent ?? '';
    expect(text).toContain('One critical move');
    expect(text).not.toContain('✗');
    expect(screen.getByTestId('train-verdict-guess-points').textContent).toBe('+0');
  });

  it('verdict-guess row states the spelled-out several-fine wording with a +1 chip for a correct guess', () => {
    renderReveal({ guess: 'several', verdict: makeVerdict({ correct_guess: true }) });
    const text = screen.getByTestId('train-verdict-guess').textContent ?? '';
    expect(text).toContain('Several fine moves');
    expect(text).not.toContain('✓');
    expect(screen.getByTestId('train-verdict-guess-points').textContent).toBe('+1');
  });

  it('the move verdict renders as the Your-move box header: SAN (not raw UCI) plus the earned-points chip (UAT round 3)', async () => {
    // A correct-but-not-best move (soft puzzle): the Your-move box stands
    // alone, so the header is exactly "Your move: <san> [+2]".
    const gradeResult = makeGradeResult({
      bestLine: makeEngineLine({ moves: ['e2e4'] }),
      playedLine: makeEngineLine({ moves: ['d2d4'] }),
    });
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult,
      verdict: makeVerdict({ correct_move: true, move_quality: 'good', puzzle_type: 'soft' }),
    });
    const yourBox = await waitFor(() => screen.getByTestId('train-line-box-your-move'));
    const title =
      yourBox.querySelector('[data-testid="train-line-stepper-title"]')?.textContent ?? '';
    expect(title).toContain('Your move: d4');
    expect(title.includes('d2d4')).toBe(false);
    expect(title).not.toContain('✓');
    expect(
      yourBox.querySelector('[data-testid="train-line-stepper-points"]')?.textContent,
    ).toBe('+2');
    // The old standalone move-verdict row is gone.
    expect(screen.queryByTestId('train-verdict-move')).toBeNull();
  });

  // Phase 200 UAT round 3: the chip reads the three-way scoring tier, so an
  // inaccuracy scores +1 — the boolean correct_move could not express that.
  it('an inaccuracy scores +1 on the Your-move chip, not the 0 its correct_move=false would suggest', async () => {
    const gradeResult = makeGradeResult({
      correctMove: false,
      bestLine: makeEngineLine({ moves: ['e2e4'] }),
      playedLine: makeEngineLine({ moves: ['d2d4'] }),
    });
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult,
      verdict: makeVerdict({ correct_move: false, move_quality: 'inaccuracy' }),
    });
    const yourBox = await waitFor(() => screen.getByTestId('train-line-box-your-move'));
    expect(
      yourBox.querySelector('[data-testid="train-line-stepper-points"]')?.textContent,
    ).toBe('+1');
  });

  it('an incorrect move keeps the Your-move box FIRST and chips it +0 (UAT round 5, reversing round 3)', async () => {
    const gradeResult = makeGradeResult({
      correctMove: false,
      bestLine: makeEngineLine({ moves: ['e2e4'] }),
      playedLine: makeEngineLine({ moves: ['d2d4'] }),
    });
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult,
      verdict: makeVerdict({ correct_move: false, move_quality: 'wrong' }),
    });
    await waitFor(() => expect(screen.getByTestId('train-line-box-your-move')).not.toBeNull());
    const bestBox = screen.getByTestId('train-line-box-best-move');
    const yourBox = screen.getByTestId('train-line-box-your-move');
    // DOM order: Your move on top of Best move, even on a miss.
    expect(yourBox.compareDocumentPosition(bestBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      yourBox.querySelector('[data-testid="train-line-stepper-points"]')?.textContent,
    ).toBe('+0');
    const bestTitle =
      bestBox.querySelector('[data-testid="train-line-stepper-title"]')?.textContent ?? '';
    expect(bestTitle).toContain('Best move: e4');
    // The best-move box carries no chip at all — only the user's own move
    // scored anything.
    expect(bestBox.querySelector('[data-testid="train-line-stepper-points"]')).toBeNull();
  });

  // Phase 200 UAT round 8: the Your-move box leads the whole panel, above the
  // guess card, on both viewports (one component serves both).
  it('the Your-move box renders ABOVE the guess card', async () => {
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult: makeGradeResult({
        correctMove: false,
        bestLine: makeEngineLine({ moves: ['e2e4'] }),
        playedLine: makeEngineLine({ moves: ['d2d4'] }),
      }),
    });
    const yourBox = await waitFor(() => screen.getByTestId('train-line-box-your-move'));
    const guessCard = screen.getByTestId('train-verdict-guess');
    expect(
      yourBox.compareDocumentPosition(guessCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // ...and the best-move box still follows the guess card, where the rest of
    // the line boxes live.
    expect(
      guessCard.compareDocumentPosition(screen.getByTestId('train-line-box-best-move')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // ─── Outcome copy — fully retired (Phase 200 UAT round 7) ─────────────────
  // Round 3 retired the miss sentence; round 7 retired the last one standing,
  // the herring "You handled this well in the game" line. The guess card's
  // body now holds the Also fine list or nothing at all.

  it('a herring renders no outcome sentence — the herring sentence is retired too', async () => {
    renderReveal({
      verdict: makeVerdict({
        correct_move: false,
        puzzle_type: 'herring',
        source: 'red_herring',
        item_status: null,
        due_date: null,
        streak: null,
      }),
    });
    await waitFor(() => expect(getGame).toHaveBeenCalled());
    expect(screen.queryByTestId('train-outcome-copy')).toBeNull();
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

  // ─── Flaw fixed banner (PROG-03/D-14, Phase 191 Plan 03 — supersedes the
  // D-12 plain "Mastered — retired." comeback hint) ─────────────────────────

  it('item_status "mastered" renders the flaw-fixed banner', () => {
    renderReveal({ verdict: makeVerdict({ item_status: 'mastered', due_date: null }) });
    expect(screen.getByTestId('train-flaw-fixed-banner')).not.toBeNull();
  });

  // Quick 260803-iv6 (Task 2): the banner is the FIRST card in the panel —
  // above both the Your-move box and the guess card — on a mastered,
  // non-herring verdict. Asserted via `compareDocumentPosition`, not index
  // into a hand-built list, so a reordering elsewhere in the panel can't
  // accidentally make this pass for the wrong reason.
  it('the flaw-fixed banner is the FIRST card in the panel — above the Your-move box and the guess card', async () => {
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult: makeGradeResult({
        correctMove: false,
        bestLine: makeEngineLine({ moves: ['e2e4'] }),
        playedLine: makeEngineLine({ moves: ['d2d4'] }),
      }),
      verdict: makeVerdict({ item_status: 'mastered', due_date: null }),
    });
    const banner = screen.getByTestId('train-flaw-fixed-banner');
    const yourBox = await waitFor(() => screen.getByTestId('train-line-box-your-move'));
    const guessCard = screen.getByTestId('train-verdict-guess');
    expect(
      banner.compareDocumentPosition(yourBox) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      banner.compareDocumentPosition(guessCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('item_status "active" renders neither the banner nor a comeback line', () => {
    renderReveal({ verdict: makeVerdict({ item_status: 'active', due_date: '2026-07-28' }) });
    expect(screen.queryByTestId('train-flaw-fixed-banner')).toBeNull();
    expect(screen.queryByTestId('train-comeback-hint')).toBeNull();
  });

  it('item_status "parked" renders neither the banner nor a comeback line', () => {
    renderReveal({ verdict: makeVerdict({ item_status: 'parked', due_date: '2026-07-28' }) });
    expect(screen.queryByTestId('train-flaw-fixed-banner')).toBeNull();
    expect(screen.queryByTestId('train-comeback-hint')).toBeNull();
  });

  it('a herring (item_status null) renders neither the banner nor a comeback line', () => {
    renderReveal({
      verdict: makeVerdict({
        puzzle_type: 'herring',
        source: 'red_herring',
        item_status: null,
        due_date: null,
        streak: null,
      }),
    });
    expect(screen.queryByTestId('train-flaw-fixed-banner')).toBeNull();
    expect(screen.queryByTestId('train-comeback-hint')).toBeNull();
  });

  it('two mastered reveals in sequence (a new puzzle each time) each render their own single, un-pluralized banner', () => {
    const { rerender, client, props } = renderReveal({
      verdict: makeVerdict({ item_status: 'mastered', due_date: null }),
    });
    expect(screen.getAllByTestId('train-flaw-fixed-banner')).toHaveLength(1);
    expect(screen.getByText('Flaw fixed!')).not.toBeNull();

    rerender(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <TooltipProvider>
            <TrainReveal
              {...props}
              puzzle={makePuzzle({ position: 6 })}
              verdict={makeVerdict({ item_status: 'mastered', due_date: null })}
            />
          </TooltipProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    // Still exactly one banner with the same singular heading — a second
    // mastery in the SAME session never batches into a "2 fixed" count.
    expect(screen.getAllByTestId('train-flaw-fixed-banner')).toHaveLength(1);
    expect(screen.getByText('Flaw fixed!')).not.toBeNull();
  });

  // ─── Steppable engine-line boxes (190.1-03 D-03) ──────────────────────────

  it('no engine data at all renders no line box', async () => {
    revealPuzzle.mockResolvedValue(makeReveal());
    renderReveal();
    await waitFor(() => expect(getGame).toHaveBeenCalled());
    expect(screen.queryByTestId('train-line-stepper')).toBeNull();
  });

  // Phase 200 UAT: a line box shows at most 12 plies (six full moves — raised
  // from 10 in UAT round 3).
  it('a long engine line is capped at 12 SAN tokens — the deep tail of the PV never renders', async () => {
    const longLine = [
      'e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5',
      'c2c3', 'g8f6', 'd2d3', 'd7d6', 'b1d2', 'c8e6',
      'c4b3', 'd8d7',
    ];
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'e2e4',
      gradeResult: makeGradeResult({
        bestLine: makeEngineLine({ moves: longLine }),
        playedLine: makeEngineLine({ moves: longLine }),
      }),
    });
    const box = await waitFor(() => screen.getByTestId('train-line-box-your-move'));
    const tokens = within(box).getAllByTestId(/^train-line-stepper-token-/);
    expect(tokens).toHaveLength(12);
    // The cap slices the HEAD of the line, so the last token is the 12th ply
    // (Be6) and the 13th/14th (Bb3, Qd7) are gone.
    expect(tokens.at(-1)?.textContent).toBe('Be6');
    expect(box.textContent).not.toContain('Bb3');
  });

  // Phase 200 UAT item 2: exactly one line box owns the board position, so
  // exactly one may paint a move cursor. Stepping box B used to leave box A's
  // brown badge lit, showing two cursors for one board.
  it('only the box currently stepped shows the brown move cursor — stepping a second box clears the first one', async () => {
    revealPuzzle.mockResolvedValue(
      makeReveal({ played_in_game_san: 'Nf3', played_in_game_move_uci: 'g1f3' }),
    );
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult: makeGradeResult({
        bestLine: makeEngineLine({ moves: ['e2e4', 'e7e5'] }),
        playedLine: makeEngineLine({ moves: ['d2d4', 'd7d5'] }),
      }),
    });
    const yourBox = await waitFor(() => screen.getByTestId('train-line-box-your-move'));
    const bestBox = screen.getByTestId('train-line-box-best-move');
    const cursors = (): Element[] => [...document.querySelectorAll('[data-active="true"]')];

    // Nothing stepped yet — no cursor anywhere.
    expect(cursors()).toHaveLength(0);

    fireEvent.click(within(yourBox).getByTestId('train-line-stepper-token-0'));
    expect(cursors()).toHaveLength(1);
    expect(within(yourBox).getByTestId('train-line-stepper-token-0').dataset.active).toBe('true');

    // Stepping the OTHER box hands the cursor over — never a second one.
    fireEvent.click(within(bestBox).getByTestId('train-line-stepper-token-0'));
    expect(cursors()).toHaveLength(1);
    expect(within(bestBox).getByTestId('train-line-stepper-token-0').dataset.active).toBe('true');
    expect(within(yourBox).getByTestId('train-line-stepper-token-0').dataset.active).toBeUndefined();
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

  // ─── Phase 200 (LEGEND-01/D-01): one glyph per box, Card/CardHeader shell ──

  it('a coincidence-merged played==best box renders exactly ONE glyph button, matching the single blue arrow actually drawn', async () => {
    const gradeResult = makeGradeResult({
      bestLine: makeEngineLine({ moves: ['e2e4'], evalCp: 50, evalMate: null }),
      playedLine: makeEngineLine({ moves: ['e2e4'], evalCp: 50, evalMate: null }),
    });
    renderReveal({ guess: 'critical', playedMoveUci: 'e2e4', gradeResult });
    await waitFor(() => expect(screen.getByTestId('train-line-box-your-move')).not.toBeNull());
    const box = screen.getByTestId('train-line-box-your-move');
    const glyphButtons = box.querySelectorAll('[data-testid^="train-reveal-glyph-"]');
    expect(glyphButtons).toHaveLength(1);
    expect(glyphButtons[0]?.getAttribute('data-testid')).toBe('train-reveal-glyph-your');
  });

  it('every rendered line box exposes exactly one glyph button and one title', async () => {
    revealPuzzle.mockResolvedValue(
      makeReveal({ played_in_game_san: 'Nf3', played_in_game_move_uci: 'g1f3' }),
    );
    const gradeResult = makeGradeResult({
      bestLine: makeEngineLine({ moves: ['e2e4'], evalCp: 50, evalMate: null }),
      playedLine: makeEngineLine({ moves: ['d2d4'], evalCp: 10, evalMate: null }),
    });
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult,
      gradingEngine: makeGradingEngine({
        startGameMoveSearch: vi
          .fn()
          .mockResolvedValue(makeEngineLine({ moves: ['g1f3'], evalCp: -20, evalMate: null })),
      }),
    });
    await waitFor(() => expect(screen.getByTestId('train-line-box-your-move')).not.toBeNull());
    await waitFor(() => expect(screen.getByTestId('train-line-box-game-move')).not.toBeNull());
    for (const testid of ['train-line-box-your-move', 'train-line-box-best-move', 'train-line-box-game-move']) {
      const box = screen.getByTestId(testid);
      expect(box.querySelectorAll('[data-testid^="train-reveal-glyph-"]')).toHaveLength(1);
      expect(box.querySelectorAll('[data-testid="train-line-stepper-title"]')).toHaveLength(1);
    }
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

  // ─── Sharp filler motif line (Phase 206, D-20) ────────────────────────────

  it('a non-null motif renders exactly one Motif row inside the guess card', async () => {
    revealPuzzle.mockResolvedValue(
      makeReveal({ source: 'sharp_filler', puzzle_type: 'sharp', motif: 'Fork' }),
    );
    renderReveal({ verdict: makeVerdict({ puzzle_type: 'sharp', source: 'sharp_filler' }) });
    await waitFor(() => expect(screen.getByTestId('train-reveal-motif')).not.toBeNull());
    expect(screen.getByTestId('train-reveal-motif').textContent).toBe('Motif: Fork');
    expect(screen.getAllByTestId('train-reveal-motif')).toHaveLength(1);
  });

  it('a null motif (the normal SR/herring case) renders no Motif row, no placeholder, no dash', async () => {
    revealPuzzle.mockResolvedValue(makeReveal({ motif: null }));
    // guess set (-> non-null guessProse) so the guess CardBody itself
    // renders regardless of motif — otherwise this test would trivially
    // pass whenever the whole card is absent, never actually exercising
    // the motif row's own null guard.
    renderReveal({ guess: 'several' });
    await waitFor(() => expect(getGame).toHaveBeenCalled());
    expect(screen.getByTestId('train-verdict-guess-prose')).not.toBeNull();
    expect(screen.queryByTestId('train-reveal-motif')).toBeNull();
  });

  it('the motif row text size is text-sm, never text-xs', async () => {
    revealPuzzle.mockResolvedValue(
      makeReveal({ source: 'sharp_filler', puzzle_type: 'sharp', motif: 'Skewer' }),
    );
    renderReveal({ verdict: makeVerdict({ puzzle_type: 'sharp', source: 'sharp_filler' }) });
    const motifRow = await screen.findByTestId('train-reveal-motif');
    expect(motifRow.className).toContain('text-sm');
    expect(motifRow.className).not.toContain('text-xs');
  });

  // ─── Opponent-and-date footer (190.1-03 D-03, Task 2) ─────────────────────

  it('the game-card query is disabled while the solve response is absent, and enabled once it is present', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender, props } = renderReveal({ verdict: null, isSolveError: false }, client);
    expect(getGame).not.toHaveBeenCalled();

    rerender(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <TooltipProvider>
            <TrainReveal {...props} verdict={makeVerdict()} />
          </TooltipProvider>
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

  // ─── D-07: herring reveal omits the game info line entirely (Phase 192) ──

  it('renders no game footer for a herring reveal', async () => {
    getGame.mockResolvedValue(makeGame());
    const { client } = renderReveal({
      verdict: makeVerdict({
        puzzle_type: 'herring',
        source: 'red_herring',
        item_status: null,
        due_date: null,
        streak: null,
      }),
    });
    // Waits for the game query to actually SETTLE (not just be dispatched) —
    // otherwise this test would pass trivially before the success branch
    // ever had a chance to render the footer.
    await waitFor(() =>
      expect(client.getQueryState(['library-game', 100])?.status).toBe('success'),
    );
    expect(screen.queryByTestId('train-reveal-footer')).toBeNull();
  });

  it('renders no game-load error for a herring reveal', async () => {
    getGame.mockRejectedValue(new Error('boom'));
    const { client } = renderReveal({
      verdict: makeVerdict({
        puzzle_type: 'herring',
        source: 'red_herring',
        item_status: null,
        due_date: null,
        streak: null,
      }),
    });
    // T-192-12: a herring's game query can still reject (game_id non-null,
    // per D-08 — the in-game move survives independently of the game row's
    // existence) — the error branch must be gated on the SAME puzzle_type
    // condition as the success branch, not just the success branch.
    await waitFor(() =>
      expect(client.getQueryState(['library-game', 100])?.status).toBe('error'),
    );
    expect(screen.queryByTestId('train-gamecard-error')).toBeNull();
  });

  it('still renders the game footer for an SR reveal (positive control)', async () => {
    getGame.mockResolvedValue(makeGame());
    renderReveal({ verdict: makeVerdict({ puzzle_type: 'sharp' }) });
    await waitFor(() => expect(screen.getByTestId('train-reveal-footer')).not.toBeNull());
  });

  // ─── Phase 206 D-19: source === 'sr_item' replaces puzzle_type !== 'herring' ──

  it('a sharp_filler verdict (puzzle_type "sharp", same as a real SR puzzle) suppresses the mastery banner, the game footer, and the own-game guess prose all together', async () => {
    getGame.mockResolvedValue(makeGame());
    const { client } = renderReveal({
      guess: 'several',
      verdict: makeVerdict({
        puzzle_type: 'sharp',
        source: 'sharp_filler',
        correct_guess: true,
        item_status: null,
        due_date: null,
        streak: null,
      }),
    });
    // No mastery banner (item_status is null anyway, but the source gate
    // must ALSO suppress it independently of item_status).
    expect(screen.queryByTestId('train-flaw-fixed-banner')).toBeNull();
    // The non-own-game guess prose renders — same sentence a herring gets —
    // never the SR "not the one you played in the game" variant.
    expect(screen.getByTestId('train-verdict-guess-prose').textContent).toBe(
      'Indeed, several moves are fine here.',
    );
    // No game footer, and no game-load error either — a sharp filler has no
    // game at all (game_id is structurally null server-side).
    await waitFor(() =>
      expect(client.getQueryState(['library-game', 100])?.status).toBe('success'),
    );
    expect(screen.queryByTestId('train-reveal-footer')).toBeNull();
  });

  it('an sr_item verdict with puzzle_type "sharp" (the exact literal a sharp_filler also carries) still renders all three D-19 sites — proves the predicate reads source, not puzzle_type', async () => {
    getGame.mockResolvedValue(makeGame());
    renderReveal({
      guess: 'several',
      verdict: makeVerdict({
        puzzle_type: 'sharp',
        source: 'sr_item',
        correct_guess: true,
        item_status: 'mastered',
        due_date: null,
      }),
    });
    expect(screen.getByTestId('train-flaw-fixed-banner')).not.toBeNull();
    expect(screen.getByTestId('train-verdict-guess-prose').textContent).toBe(
      'Several moves are fine here, but not the one you played in the game.',
    );
    await waitFor(() => expect(screen.getByTestId('train-reveal-footer')).not.toBeNull());
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

  it('a played inaccuracy renders the GOOD quality icon in the CardHeader, never the severity glyph — the fifth D-05 recolor site (LEGEND-03)', async () => {
    const gradeResult = makeGradeResult({
      bestLine: makeEngineLine({ moves: ['e2e4'] }),
      playedLine: makeEngineLine({ moves: ['d2d4'] }),
    });
    renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult,
      playedMoveQuality: 'inaccuracy',
    });
    await waitFor(() => expect(screen.getByTestId('train-line-box-your-move')).not.toBeNull());
    const yourIcon = screen
      .getByTestId('train-line-box-your-move')
      .querySelector('[data-testid="train-line-stepper-quality"]');
    expect(yourIcon?.getAttribute('data-quality')).toBe('good');
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
      // Phase 200 (EXPLORE-02): the reveal-level prefix is the complete chain
      // already played from puzzle.fen — here, exactly the first move itself.
      prefixUci: ['d2d4'],
    });

    // Deeper into the line: an engine continuation, reported as 'good' so the
    // square highlight reads green, not the gem-adjacent blue (UAT round 3).
    fireEvent.click(within(yourBox).getByTestId('btn-train-step-next'));
    expect(onLineStep).toHaveBeenLastCalledWith({
      lastMoveUci: 'd7d5',
      quality: 'good',
      nextMoveUci: null,
      isFirstMove: false,
      prefixUci: ['d2d4', 'd7d5'],
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
          <TooltipProvider>
            <TrainReveal {...props} solutionNonce={1} />
          </TooltipProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    // The steppers' own index-0 reports land back on the puzzle position.
    expect(onLineStep).toHaveBeenLastCalledWith(null);
    expect(onFenChange).toHaveBeenLastCalledWith(makePuzzle().fen);
  });

  // ─── Phase 200 (D-06/D-07/D-08/D-09): desktop hover vs mobile tap split ───

  /** Renders three genuinely distinct line boxes (your/best/game all
   * separate UCIs) — the shared fixture for the spotlight interaction tests
   * below, mirroring the "three distinct moves" coverage above. */
  async function renderThreeBoxReveal(
    onSpotlightChange = vi.fn(),
    spotlightKey: string | null = null,
    extraProps: Partial<ComponentProps<typeof TrainReveal>> = {},
  ) {
    revealPuzzle.mockResolvedValue(
      makeReveal({ played_in_game_san: 'Nf3', played_in_game_move_uci: 'g1f3' }),
    );
    const gradeResult = makeGradeResult({
      bestLine: makeEngineLine({ moves: ['e2e4'], evalCp: 50, evalMate: null }),
      playedLine: makeEngineLine({ moves: ['d2d4'], evalCp: 10, evalMate: null }),
    });
    const result = renderReveal({
      guess: 'critical',
      playedMoveUci: 'd2d4',
      gradeResult,
      gradingEngine: makeGradingEngine({
        startGameMoveSearch: vi
          .fn()
          .mockResolvedValue(makeEngineLine({ moves: ['g1f3'], evalCp: -20, evalMate: null })),
      }),
      spotlightKey,
      onSpotlightChange,
      ...extraProps,
    });
    await waitFor(() => expect(screen.getByTestId('train-line-box-your-move')).not.toBeNull());
    await waitFor(() => expect(screen.getByTestId('train-line-box-game-move')).not.toBeNull());
    return result;
  }

  it('desktop: hovering a card reports its own spotlight entry and clears on pointer-leave', async () => {
    matchMediaMatches = true; // desktop path
    const onSpotlightChange = vi.fn();
    await renderThreeBoxReveal(onSpotlightChange);
    const bestBox = screen.getByTestId('train-line-box-best-move');

    fireEvent.pointerEnter(bestBox);
    expect(onSpotlightChange).toHaveBeenLastCalledWith({
      key: 'train-line-box-best-move',
      ucis: ['e2e4'],
    });

    fireEvent.pointerLeave(bestBox);
    expect(onSpotlightChange).toHaveBeenLastCalledWith(null);
  });

  it('desktop: the spotlit card (spotlightKey prop) carries data-spotlight="true", and only that card', async () => {
    matchMediaMatches = true;
    await renderThreeBoxReveal(vi.fn(), 'train-line-box-best-move');
    const bestBox = screen.getByTestId('train-line-box-best-move');
    const yourBox = screen.getByTestId('train-line-box-your-move');
    expect(bestBox.getAttribute('data-spotlight')).toBe('true');
    expect(yourBox.getAttribute('data-spotlight')).toBeNull();
  });

  it('mobile: pointer-enter/leave on the card do nothing — only the glyph tap drives the spotlight', async () => {
    matchMediaMatches = false;
    const onSpotlightChange = vi.fn();
    await renderThreeBoxReveal(onSpotlightChange);
    const bestBox = screen.getByTestId('train-line-box-best-move');
    fireEvent.pointerEnter(bestBox);
    fireEvent.pointerLeave(bestBox);
    expect(onSpotlightChange).not.toHaveBeenCalled();
  });

  it('mobile: tapping a glyph sets the spotlight, tapping it again clears it, and tapping a different glyph switches it — never more than one active at once (D-08/D-09)', async () => {
    matchMediaMatches = false;
    const onSpotlightChange = vi.fn();
    const { rerender, client, props } = await renderThreeBoxReveal(onSpotlightChange, null);

    function withSpotlight(key: string | null) {
      rerender(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <TrainReveal {...props} spotlightKey={key} onSpotlightChange={onSpotlightChange} />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    }

    // Tap the best-move glyph: sets it.
    fireEvent.click(screen.getByTestId('train-reveal-glyph-best'));
    expect(onSpotlightChange).toHaveBeenLastCalledWith({
      key: 'train-line-box-best-move',
      ucis: ['e2e4'],
    });
    withSpotlight('train-line-box-best-move');
    expect(
      document.querySelectorAll('[data-testid="train-reveal"] [data-spotlight="true"]'),
    ).toHaveLength(1);

    // Tap it again: clears.
    fireEvent.click(screen.getByTestId('train-reveal-glyph-best'));
    expect(onSpotlightChange).toHaveBeenLastCalledWith(null);
    withSpotlight(null);
    expect(
      document.querySelectorAll('[data-testid="train-reveal"] [data-spotlight="true"]'),
    ).toHaveLength(0);

    // Tap a DIFFERENT glyph: switches directly (never two active).
    fireEvent.click(screen.getByTestId('train-reveal-glyph-your'));
    expect(onSpotlightChange).toHaveBeenLastCalledWith({
      key: 'train-line-box-your-move',
      ucis: ['d2d4'],
    });
    withSpotlight('train-line-box-your-move');
    const active = document.querySelectorAll('[data-testid="train-reveal"] [data-spotlight="true"]');
    expect(active).toHaveLength(1);
    expect(active[0]).toBe(screen.getByTestId('train-line-box-your-move'));
  });

  // WR-01 regression. A real tap is focus-THEN-click, not click alone: the
  // browser focuses the glyph button on pointer-down and React's onFocus
  // (focusin) BUBBLES to the tabIndex={0} Card. When the Card's onFocus was
  // ungated it set the spotlight before click fired, and the glyph's own
  // toggle then read that fresh state and turned it straight back OFF — the
  // first tap on every glyph was silently swallowed. Every other mobile test
  // here uses fireEvent.click alone, which never synthesizes the preceding
  // focus, so the whole suite was structurally blind to it.
  it('mobile: the FIRST tap on a glyph sets the spotlight even though the tap focuses the card first (WR-01)', async () => {
    matchMediaMatches = false;
    const onSpotlightChange = vi.fn();
    await renderThreeBoxReveal(onSpotlightChange, null);

    const glyph = screen.getByTestId('train-reveal-glyph-best');

    // The focus a real tap produces, bubbling up to the card.
    fireEvent.focus(glyph);
    // On mobile this must be inert — the glyph's tap toggle is the only driver.
    expect(onSpotlightChange).not.toHaveBeenCalled();

    fireEvent.click(glyph);
    expect(onSpotlightChange).toHaveBeenCalledTimes(1);
    expect(onSpotlightChange).toHaveBeenLastCalledWith({
      key: 'train-line-box-best-move',
      ucis: ['e2e4'],
    });
  });

  it('desktop: focus still drives the spotlight, so keyboard tabbing keeps working (WR-01 guard is desktop-only)', async () => {
    matchMediaMatches = true;
    const onSpotlightChange = vi.fn();
    await renderThreeBoxReveal(onSpotlightChange, null);

    fireEvent.focus(screen.getByTestId('train-reveal-glyph-best'));
    expect(onSpotlightChange).toHaveBeenLastCalledWith({
      key: 'train-line-box-best-move',
      ucis: ['e2e4'],
    });

    fireEvent.blur(screen.getByTestId('train-reveal-glyph-best'));
    expect(onSpotlightChange).toHaveBeenLastCalledWith(null);
  });

  // ─── Phase 200 UAT: the WHOLE card is the mobile tap target ───────────────

  it('mobile: tapping the card body (not just the glyph) toggles the spotlight', async () => {
    matchMediaMatches = false;
    const onSpotlightChange = vi.fn();
    await renderThreeBoxReveal(onSpotlightChange, null);

    // A tap on the card's own title text, well away from the glyph button.
    const bestBox = screen.getByTestId('train-line-box-best-move');
    fireEvent.click(within(bestBox).getByTestId('train-line-stepper-title'));
    expect(onSpotlightChange).toHaveBeenLastCalledWith({
      key: 'train-line-box-best-move',
      ucis: ['e2e4'],
    });

    // Already spotlit: the same tap clears it (same toggle as the glyph).
    cleanup();
    onSpotlightChange.mockClear();
    await renderThreeBoxReveal(onSpotlightChange, 'train-line-box-best-move');
    fireEvent.click(
      within(screen.getByTestId('train-line-box-best-move')).getByTestId('train-line-stepper-title'),
    );
    expect(onSpotlightChange).toHaveBeenLastCalledWith(null);
  });

  // ─── Phase 200 UAT round 9: a card click brings the board back ────────────

  it('a card click while the board has departed the solution asks for the solution board and keeps its own spotlight — on both viewports', async () => {
    for (const isDesktop of [true, false]) {
      matchMediaMatches = isDesktop;
      const onSpotlightChange = vi.fn();
      const onReturnToSolution = vi.fn();
      // Already spotlit: the departed branch must NOT toggle it off, or the
      // board would come back showing everything except the clicked card.
      await renderThreeBoxReveal(onSpotlightChange, 'train-line-box-best-move', {
        isBoardDeparted: true,
        onReturnToSolution,
      });

      const bestBox = screen.getByTestId('train-line-box-best-move');
      fireEvent.click(within(bestBox).getByTestId('train-line-stepper-title'));

      expect(onReturnToSolution).toHaveBeenCalledTimes(1);
      expect(onSpotlightChange).toHaveBeenLastCalledWith({
        key: 'train-line-box-best-move',
        ucis: ['e2e4'],
      });
      cleanup();
    }
  });

  it('a click on a move control inside the card never asks for the solution board — stepping is its own job', async () => {
    matchMediaMatches = true;
    const onReturnToSolution = vi.fn();
    await renderThreeBoxReveal(vi.fn(), null, { isBoardDeparted: true, onReturnToSolution });

    const bestBox = screen.getByTestId('train-line-box-best-move');
    fireEvent.click(within(bestBox).getByTestId('btn-train-step-next'));
    expect(onReturnToSolution).not.toHaveBeenCalled();
  });

  // Phase 200 UAT round 8: interacting with a card's move controls highlights
  // that card, so the user can see which box owns the board while stepping.
  it('mobile: tapping a move control INSIDE the card highlights the card', async () => {
    matchMediaMatches = false;
    const onSpotlightChange = vi.fn();
    await renderThreeBoxReveal(onSpotlightChange, null);
    const bestBox = screen.getByTestId('train-line-box-best-move');
    const entry = { key: 'train-line-box-best-move', ucis: ['e2e4'] };

    fireEvent.click(within(bestBox).getByTestId('train-line-stepper-token-0'));
    expect(onSpotlightChange).toHaveBeenLastCalledWith(entry);

    onSpotlightChange.mockClear();
    fireEvent.click(within(bestBox).getByTestId('btn-train-step-next'));
    expect(onSpotlightChange).toHaveBeenLastCalledWith(entry);
  });

  it('mobile: a move control on an ALREADY spotlit card never toggles it off — stepping must not strobe the highlight', async () => {
    matchMediaMatches = false;
    const onSpotlightChange = vi.fn();
    await renderThreeBoxReveal(onSpotlightChange, 'train-line-box-best-move');
    const bestBox = screen.getByTestId('train-line-box-best-move');

    fireEvent.click(within(bestBox).getByTestId('btn-train-step-next'));
    fireEvent.click(within(bestBox).getByTestId('btn-train-step-prev'));
    fireEvent.click(within(bestBox).getByTestId('train-line-stepper-token-0'));
    expect(onSpotlightChange).not.toHaveBeenCalled();
  });

  // Phase 200 UAT item 1: the arrow glyph used to be a button that TOGGLED the
  // spotlight. On desktop the card is spotlit simply by being hovered, so
  // clicking the glyph immediately un-spotlit the card under the pointer.
  it('desktop: clicking the arrow glyph on a hovered (spotlit) card does NOT unselect it — the glyph carries no handler of its own', async () => {
    matchMediaMatches = true;
    const onSpotlightChange = vi.fn();
    await renderThreeBoxReveal(onSpotlightChange, null);
    const bestBox = screen.getByTestId('train-line-box-best-move');

    fireEvent.pointerEnter(bestBox);
    expect(onSpotlightChange).toHaveBeenLastCalledWith({
      key: 'train-line-box-best-move',
      ucis: ['e2e4'],
    });
    onSpotlightChange.mockClear();

    fireEvent.click(screen.getByTestId('train-reveal-glyph-best'));
    expect(onSpotlightChange).not.toHaveBeenCalled();
  });

  it('mobile: tapping the arrow glyph selects the card exactly like tapping the card body — one toggle, never two', async () => {
    matchMediaMatches = false;
    const onSpotlightChange = vi.fn();
    await renderThreeBoxReveal(onSpotlightChange, null);

    fireEvent.click(screen.getByTestId('train-reveal-glyph-best'));
    expect(onSpotlightChange).toHaveBeenCalledTimes(1);
    expect(onSpotlightChange).toHaveBeenLastCalledWith({
      key: 'train-line-box-best-move',
      ucis: ['e2e4'],
    });
  });

  it('desktop: a card tap is inert — hover is the only spotlight driver there, so a click must not undo the hover that just fired', async () => {
    matchMediaMatches = true;
    const onSpotlightChange = vi.fn();
    await renderThreeBoxReveal(onSpotlightChange, 'train-line-box-best-move');
    onSpotlightChange.mockClear();

    fireEvent.click(
      within(screen.getByTestId('train-line-box-best-move')).getByTestId('train-line-stepper-title'),
    );
    expect(onSpotlightChange).not.toHaveBeenCalled();
  });

  it('mobile: a pointerdown outside the reveal panel clears the spotlight (D-08 tap-away)', async () => {
    matchMediaMatches = false;
    const onSpotlightChange = vi.fn();
    await renderThreeBoxReveal(onSpotlightChange, 'train-line-box-best-move');

    fireEvent.pointerDown(document.body);
    expect(onSpotlightChange).toHaveBeenCalledWith(null);
  });

  it('mobile: a pointerdown INSIDE the reveal panel (e.g. the glyph tap itself) does not clear the spotlight', async () => {
    matchMediaMatches = false;
    const onSpotlightChange = vi.fn();
    await renderThreeBoxReveal(onSpotlightChange, 'train-line-box-best-move');
    onSpotlightChange.mockClear();

    const panel = screen.getByTestId('train-reveal');
    fireEvent.pointerDown(panel);
    expect(onSpotlightChange).not.toHaveBeenCalledWith(null);
  });

  // ─── Also fine, inside the guess card (Phase 200 LEGEND-04/D-02/D-03; UAT
  // round 6 folded the standalone row into the guess card) ──────────────────

  it('renders no Also fine list — and no green legend glyph — when alsoFineMoves is empty (the default)', () => {
    renderReveal();
    expect(screen.queryByTestId('train-reveal-also-fine')).toBeNull();
    expect(screen.queryByTestId('train-reveal-glyph-also-fine')).toBeNull();
  });

  it('renders the Also fine list in the guess card body, listing the SAN of every entry, with a single non-interactive glyph in the card header', () => {
    renderReveal({
      alsoFineMoves: [
        { uci: 'd2d4', quality: 'good' },
        { uci: 'g1f3', quality: 'inaccuracy' },
      ],
    });
    const card = screen.getByTestId('train-verdict-guess');
    const list = within(card).getByTestId('train-reveal-also-fine');
    expect(list.textContent).toContain('d4');
    expect(list.textContent).toContain('Nf3');
    expect(within(card).getByTestId('train-reveal-glyph-also-fine')).not.toBeNull();
    // Phase 200 UAT: NO button anywhere in the card — the card itself is the
    // single spotlight target (D-02: no per-token granularity), and the glyph
    // carries no handler of its own so it can never toggle the card off.
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
  });

  it('the guess card keeps the verdict and its score chip in the header, and only the Also fine list in the body (round 7: the herring sentence is gone)', async () => {
    renderReveal({
      verdict: makeVerdict({
        correct_guess: true,
        correct_move: false,
        puzzle_type: 'herring',
        source: 'red_herring',
        item_status: null,
        due_date: null,
        streak: null,
      }),
      alsoFineMoves: [{ uci: 'd2d4', quality: 'good' }],
    });
    const card = screen.getByTestId('train-verdict-guess');
    expect(card.textContent).toContain('Guess:');
    expect(within(card).getByTestId('train-verdict-guess-points').textContent).toBe('+1');
    await waitFor(() => expect(getGame).toHaveBeenCalled());
    expect(within(card).queryByTestId('train-outcome-copy')).toBeNull();
    expect(within(card).getByTestId('train-reveal-also-fine').textContent).toContain('d4');
  });

  it('desktop: hovering the guess card reports ONE spotlight entry covering ALL the Also fine UCIs together, and clears on pointer-leave', () => {
    matchMediaMatches = true;
    const onSpotlightChange = vi.fn();
    renderReveal({
      alsoFineMoves: [
        { uci: 'd2d4', quality: 'good' },
        { uci: 'g1f3', quality: 'good' },
      ],
      onSpotlightChange,
    });
    const card = screen.getByTestId('train-verdict-guess');
    fireEvent.pointerEnter(card);
    expect(onSpotlightChange).toHaveBeenLastCalledWith({
      key: 'train-reveal-also-fine',
      ucis: ['d2d4', 'g1f3'],
    });
    fireEvent.pointerLeave(card);
    expect(onSpotlightChange).toHaveBeenLastCalledWith(null);
  });

  it('desktop: a guess card with no alternatives never spotlights — an empty UCI set would filter every arrow off the board', () => {
    matchMediaMatches = true;
    const onSpotlightChange = vi.fn();
    renderReveal({ alsoFineMoves: [], onSpotlightChange });
    fireEvent.pointerEnter(screen.getByTestId('train-verdict-guess'));
    expect(onSpotlightChange).not.toHaveBeenCalled();
  });

  it('mobile: tapping the Also fine glyph toggles the spotlight, and the guess card carries data-spotlight="true" while active', () => {
    matchMediaMatches = false;
    const onSpotlightChange = vi.fn();
    const { rerender, client, props } = renderReveal({
      alsoFineMoves: [{ uci: 'd2d4', quality: 'good' }],
      onSpotlightChange,
    });

    fireEvent.click(screen.getByTestId('train-reveal-glyph-also-fine'));
    expect(onSpotlightChange).toHaveBeenLastCalledWith({
      key: 'train-reveal-also-fine',
      ucis: ['d2d4'],
    });

    rerender(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <TooltipProvider>
            <TrainReveal
              {...props}
              spotlightKey="train-reveal-also-fine"
              onSpotlightChange={onSpotlightChange}
            />
          </TooltipProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('train-verdict-guess').getAttribute('data-spotlight')).toBe('true');

    fireEvent.click(screen.getByTestId('train-reveal-glyph-also-fine'));
    expect(onSpotlightChange).toHaveBeenLastCalledWith(null);
  });

  // ─── Guess-feedback prose (Quick 260803-iv6, Task 3) ──────────────────────
  // One prose sentence stating what the guess verdict MEANS, in the guess
  // card body above the Also fine line. The six combinations are LOCKED
  // wording — exact string equality, never a substring/regex match.

  describe('guessFeedbackProse', () => {
    it('critical + wrong guess + herring, regardless of the move played', () => {
      expect(guessFeedbackProse('critical', false, false, 'wrong')).toBe(
        'Several moves are fine here.',
      );
      expect(guessFeedbackProse('critical', false, false, 'good')).toBe(
        'Several moves are fine here.',
      );
    });

    // Same fix as the correct-`several` soft branch below, one branch over: a
    // bare "Several moves are fine here." read as "nothing happened here" at
    // one of the user's own blunders. Both guesses share the sentence — the
    // position fact is independent of what the user guessed about it.
    it('critical + wrong guess + one of the user own blunders (soft)', () => {
      expect(guessFeedbackProse('critical', false, true, 'wrong')).toBe(
        'Several moves are fine here, but not the one you played in the game.',
      );
      expect(guessFeedbackProse('critical', false, true, 'good')).toBe(
        'Several moves are fine here, but not the one you played in the game.',
      );
    });

    // The 2026-08-03 fix: a correct `critical` guess no longer claims the user
    // PLAYED the critical move — only a `good` move earns the praise clause.
    it('critical + correct + a good move', () => {
      expect(guessFeedbackProse('critical', true, true, 'good')).toBe(
        'Right, and you found it: only one move works here.',
      );
    });

    it('critical + correct + a non-good move never claims the move was found', () => {
      expect(guessFeedbackProse('critical', true, true, 'inaccuracy')).toBe(
        "Right, only one move works here, but that wasn't it.",
      );
      expect(guessFeedbackProse('critical', true, true, 'wrong')).toBe(
        "Right, only one move works here, but that wasn't it.",
      );
    });

    it('several + wrong', () => {
      expect(guessFeedbackProse('several', false, true, 'wrong')).toBe(
        'One move is clearly better than the alternatives.',
      );
    });

    it('several + correct + NOT one of the user own blunders (herring)', () => {
      expect(guessFeedbackProse('several', true, false, 'good')).toBe(
        'Indeed, several moves are fine here.',
      );
    });

    // The other 2026-08-03 fix: this branch is reachable ONLY on a `soft`
    // puzzle, i.e. one of the user's own blunders — it used to congratulate
    // them ("You handled this fine in your game.") at the exact position where
    // they blundered.
    it('several + correct + one of the user own blunders (soft)', () => {
      expect(guessFeedbackProse('several', true, true, 'good')).toBe(
        'Several moves are fine here, but not the one you played in the game.',
      );
    });
  });

  it('renders the exact locked prose sentence in the guess card body, above the Also fine line', () => {
    renderReveal({
      guess: 'critical',
      verdict: makeVerdict({ correct_guess: true, puzzle_type: 'sharp', move_quality: 'good' }),
      alsoFineMoves: [{ uci: 'd2d4', quality: 'good' }],
    });
    const card = screen.getByTestId('train-verdict-guess');
    const prose = within(card).getByTestId('train-verdict-guess-prose');
    expect(prose.textContent).toBe('Right, and you found it: only one move works here.');
    const alsoFine = within(card).getByTestId('train-reveal-also-fine');
    expect(
      prose.compareDocumentPosition(alsoFine) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('several + correct + herring (not a played game) renders the "Indeed" sentence', () => {
    renderReveal({
      guess: 'several',
      verdict: makeVerdict({
        correct_guess: true,
        puzzle_type: 'herring',
        source: 'red_herring',
        item_status: null,
        due_date: null,
        streak: null,
      }),
    });
    expect(screen.getByTestId('train-verdict-guess-prose').textContent).toBe(
      'Indeed, several moves are fine here.',
    );
  });

  it('several + correct + soft (one of the user own blunders) renders the "not the one you played" sentence', () => {
    renderReveal({
      guess: 'several',
      verdict: makeVerdict({ correct_guess: true, puzzle_type: 'soft' }),
    });
    expect(screen.getByTestId('train-verdict-guess-prose').textContent).toBe(
      'Several moves are fine here, but not the one you played in the game.',
    );
  });

  // The reported bug, end to end: guessed "One critical move" correctly but
  // played a losing move. The prose used to read "You identified the one
  // critical move.", contradicting the zero-point Your-move chip above it.
  it('a correct critical guess with a wrong move never claims the move was identified', () => {
    renderReveal({
      guess: 'critical',
      verdict: makeVerdict({
        correct_guess: true,
        correct_move: false,
        move_quality: 'wrong',
        puzzle_type: 'sharp',
      }),
    });
    const prose = screen.getByTestId('train-verdict-guess-prose');
    expect(prose.textContent).toBe("Right, only one move works here, but that wasn't it.");
  });

  it('several + wrong renders the "one move is clearly better" sentence', () => {
    renderReveal({
      guess: 'several',
      verdict: makeVerdict({ correct_guess: false, puzzle_type: 'sharp' }),
    });
    expect(screen.getByTestId('train-verdict-guess-prose').textContent).toBe(
      'One move is clearly better than the alternatives.',
    );
  });

  // Both fixtures below are server-consistent: a missed `critical` guess means
  // the puzzle was NOT sharp (`_compute_correct_guess`), so only herring/soft
  // can reach this prose — the pair that `fromOwnBlunder` splits.
  it('critical + wrong + herring renders the bare "several moves are fine" sentence', () => {
    renderReveal({
      guess: 'critical',
      verdict: makeVerdict({
        correct_guess: false,
        puzzle_type: 'herring',
        source: 'red_herring',
        item_status: null,
        due_date: null,
        streak: null,
      }),
    });
    expect(screen.getByTestId('train-verdict-guess-prose').textContent).toBe(
      'Several moves are fine here.',
    );
  });

  it('critical + wrong + soft renders the "not the one you played" sentence', () => {
    renderReveal({
      guess: 'critical',
      verdict: makeVerdict({ correct_guess: false, puzzle_type: 'soft' }),
    });
    expect(screen.getByTestId('train-verdict-guess-prose').textContent).toBe(
      'Several moves are fine here, but not the one you played in the game.',
    );
  });

  it('renders no prose element when guess is null', () => {
    renderReveal({ guess: null });
    expect(screen.queryByTestId('train-verdict-guess-prose')).toBeNull();
  });

  it('the guess card body still mounts (for the prose alone) even with no Also fine alternatives', () => {
    renderReveal({
      guess: 'critical',
      verdict: makeVerdict({ correct_guess: true, puzzle_type: 'sharp' }),
      alsoFineMoves: [],
    });
    expect(screen.getByTestId('train-verdict-guess-prose').textContent).toBe(
      'Right, and you found it: only one move works here.',
    );
    expect(screen.queryByTestId('train-reveal-also-fine')).toBeNull();
  });

  // Quick 260803-iv6: the prose must NOT extend the spotlight/cursor-pointer
  // contract — a guess card that carries prose but no Also-fine alternatives
  // stays genuinely inert (no hover affordance it hasn't got).
  it('a prose-only guess card (no Also fine) attaches no spotlight handlers and carries no cursor-pointer class', () => {
    const onSpotlightChange = vi.fn();
    renderReveal({
      guess: 'critical',
      verdict: makeVerdict({ correct_guess: true, puzzle_type: 'sharp' }),
      alsoFineMoves: [],
      onSpotlightChange,
    });
    const card = screen.getByTestId('train-verdict-guess');
    expect(card.className).not.toContain('cursor-pointer');
    fireEvent.pointerEnter(card);
    expect(onSpotlightChange).not.toHaveBeenCalled();
  });

  // ─── Free-play swap (Phase 200 D-10/D-13/D-14, reworked per Phase 200 UAT) ──

  it('while exploring, the line boxes and the Also fine list are absent and the free-play surface renders instead', async () => {
    renderReveal({
      isExploring: true,
      freePlay: makeFreePlayState(),
      alsoFineMoves: [{ uci: 'd2d4', quality: 'good' }],
    });
    expect(screen.queryByTestId('train-line-box-your-move')).toBeNull();
    expect(screen.queryByTestId('train-line-box-best-move')).toBeNull();
    expect(screen.queryByTestId('train-line-box-game-move')).toBeNull();
    expect(screen.queryByTestId('train-reveal-also-fine')).toBeNull();
    expect(screen.getByTestId('train-reveal-exploration')).not.toBeNull();
    expect(screen.getByTestId('train-exploration-engine-card')).not.toBeNull();
    // Phase 200 UAT: the bespoke single-chain stepper is gone — the move list
    // is the Analysis page's own VariationTree.
    expect(screen.getByTestId('train-exploration-moves-card')).not.toBeNull();
    expect(screen.getByTestId('analysis-variation-tree')).not.toBeNull();
  });

  // Quick 260809-g0n: below `sm` the fixed bottom bar carries these controls
  // instead (MobileBottomBar swap, published by TrainSolveScreen) — the
  // in-card strip stays in the DOM (so its wiring is still exercised by the
  // tests above) but is hidden below `sm` and only visible from `sm` up.
  it('the exploration control strip renders while exploring, hidden below sm and shown at sm and up', () => {
    renderReveal({ isExploring: true, freePlay: makeFreePlayState() });
    const strip = screen.getByTestId('train-exploration-board-controls');
    expect(strip.className).toMatch(/\bhidden\b/);
    expect(strip.className).toMatch(/\bsm:block\b/);
  });

  // Phase 200 UAT item 6: the × in the Stockfish header is a second, always-
  // in-reach route back to the solution (the Solution button lives below the
  // board, which can be scrolled away on mobile).
  it('the × in the Stockfish card header calls onExitExploration', () => {
    const onExitExploration = vi.fn();
    renderReveal({ isExploring: true, freePlay: makeFreePlayState(), onExitExploration });
    fireEvent.click(screen.getByTestId('btn-train-exploration-close'));
    expect(onExitExploration).toHaveBeenCalledTimes(1);
  });

  it('D-10: the game footer stays pinned while exploring', async () => {
    renderReveal({ isExploring: true, freePlay: makeFreePlayState() });
    await waitFor(() => expect(screen.getByTestId('train-reveal-footer')).not.toBeNull());
  });

  // The guess card used to be pinned alongside the footer. It is hidden now:
  // by the time free play is running the board shows the user's own
  // exploration, so neither the guess verdict nor the Also fine legend inside
  // the card has anything left on screen to describe.
  it('hides the guess card while exploring, on both viewports', async () => {
    for (const isDesktop of [true, false]) {
      matchMediaMatches = isDesktop;
      renderReveal({
        isExploring: true,
        freePlay: makeFreePlayState(),
        guess: 'critical',
        alsoFineMoves: [{ uci: 'g1f3', quality: 'good' }],
      });
      await waitFor(() => expect(screen.getByTestId('train-reveal-exploration')).not.toBeNull());
      expect(screen.queryByTestId('train-verdict-guess')).toBeNull();
      expect(screen.queryByTestId('train-reveal-also-fine')).toBeNull();
      cleanup();
    }
  });

  it('restores the guess card the moment exploration ends', async () => {
    const { rerender, client, props } = renderReveal({
      isExploring: true,
      freePlay: makeFreePlayState(),
      guess: 'critical',
    });
    await waitFor(() => expect(screen.getByTestId('train-reveal-exploration')).not.toBeNull());
    expect(screen.queryByTestId('train-verdict-guess')).toBeNull();

    rerender(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <TooltipProvider>
            <TrainReveal {...props} isExploring={false} />
          </TooltipProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('train-verdict-guess')).not.toBeNull();
  });

  it('shows the engine-lines skeleton when the free-play PV lines are empty, and EngineLines once they are not', async () => {
    const { rerender, client, props } = renderReveal({
      isExploring: true,
      freePlay: makeFreePlayState({ pvLines: [] }),
    });
    expect(screen.getByLabelText('Loading engine lines')).not.toBeNull();
    expect(screen.queryByTestId('analysis-engine-lines')).toBeNull();

    rerender(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <TooltipProvider>
            <TrainReveal
              {...props}
              freePlay={makeFreePlayState({ pvLines: [makePvLine()] })}
            />
          </TooltipProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('analysis-engine-lines')).not.toBeNull();
    expect(screen.queryByLabelText('Loading engine lines')).toBeNull();
  });

  it('PV lines render in the supplied multipv order (best line first)', async () => {
    // Black to move (after 1.e4) so 'e7e5'/'c7c5' are legal SAN e5/c5 —
    // START_FEN itself is white-to-move, which would fall back to raw UCI.
    const afterE4Fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    renderReveal({
      isExploring: true,
      freePlay: makeFreePlayState({
        fen: afterE4Fen,
        pvLines: [
          makePvLine({ multipv: 1, moves: ['e7e5'], evalCp: 40 }),
          makePvLine({ multipv: 2, moves: ['c7c5'], evalCp: 10 }),
        ],
      }),
    });
    expect(screen.getByTestId('engine-line-0-move-0').textContent).toBe('e5');
    expect(screen.getByTestId('engine-line-1-move-0').textContent).toBe('c5');
  });
});
