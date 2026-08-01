// @vitest-environment jsdom
/**
 * TrainLineStepper.test.tsx — Phase 190 Plan 05 Task 1 coverage: forward/back
 * stepping order, end-disable behavior, the one-move degenerate case, the
 * array-index-equivalence proof (token click === N next presses, not a
 * character-offset bug), step sounds (190.1 UAT round 4), and the long-line
 * scroll cap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Chess } from 'chess.js';
import { TrainLineStepper, TRAIN_LINE_STEPPER_MAX_HEIGHT_PX } from '@/components/train/TrainLineStepper';

// 190.1 UAT round 4: stepping plays move sounds — mocked (same approach as
// useBotGame.test.ts) so jsdom never touches real Audio machinery.
const mockPlaySound = vi.fn();
vi.mock('@/lib/sounds', () => ({
  playSound: (...args: unknown[]) => mockPlaySound(...args),
}));

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const OPENING_MOVES = ['e4', 'e5', 'Nf3', 'Nc6'];

/** Independent replay (not importing the component's own helper) so the test
 * proves the component against a second, trusted computation of the same
 * FENs. */
function expectedFens(moves: string[], startFen: string): string[] {
  const chess = new Chess(startFen);
  const fens = [startFen];
  for (const san of moves) {
    chess.move(san);
    fens.push(chess.fen());
  }
  return fens;
}

describe('TrainLineStepper', () => {
  beforeEach(() => {
    mockPlaySound.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('stepping forward changes the derived FEN in the expected order', () => {
    const onFenChange = vi.fn();
    const fens = expectedFens(OPENING_MOVES, START_FEN);
    render(<TrainLineStepper moves={OPENING_MOVES} startFen={START_FEN} onFenChange={onFenChange} />);

    onFenChange.mockClear();
    fireEvent.click(screen.getByTestId('btn-train-step-next'));
    expect(onFenChange).toHaveBeenCalledWith(fens[1]);

    onFenChange.mockClear();
    fireEvent.click(screen.getByTestId('btn-train-step-next'));
    expect(onFenChange).toHaveBeenCalledWith(fens[2]);
  });

  it('stepping backward changes the derived FEN in the expected order', () => {
    const onFenChange = vi.fn();
    const fens = expectedFens(OPENING_MOVES, START_FEN);
    render(<TrainLineStepper moves={OPENING_MOVES} startFen={START_FEN} onFenChange={onFenChange} />);

    fireEvent.click(screen.getByTestId('btn-train-step-next'));
    fireEvent.click(screen.getByTestId('btn-train-step-next'));
    onFenChange.mockClear();

    fireEvent.click(screen.getByTestId('btn-train-step-prev'));
    expect(onFenChange).toHaveBeenCalledWith(fens[1]);
  });

  it('prev is disabled at index zero (initial mount)', () => {
    render(<TrainLineStepper moves={OPENING_MOVES} startFen={START_FEN} />);
    expect((screen.getByTestId('btn-train-step-prev') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('btn-train-step-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('next is disabled at the last index', () => {
    render(<TrainLineStepper moves={OPENING_MOVES} startFen={START_FEN} />);
    for (let i = 0; i < OPENING_MOVES.length; i++) {
      fireEvent.click(screen.getByTestId('btn-train-step-next'));
    }
    expect((screen.getByTestId('btn-train-step-next') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('btn-train-step-prev') as HTMLButtonElement).disabled).toBe(false);
  });

  // Phase 200 UAT round 3 (bug fix): a one-element line used to disable BOTH
  // controls while its token stayed clickable — stepping into the move left
  // the user stranded at ply 1 with no way back to the solution position.
  it('a one-element line steps forward into its move and back out again', () => {
    const onFenChange = vi.fn();
    render(<TrainLineStepper moves={['e4']} startFen={START_FEN} onFenChange={onFenChange} />);
    const prev = () => screen.getByTestId('btn-train-step-prev') as HTMLButtonElement;
    const next = () => screen.getByTestId('btn-train-step-next') as HTMLButtonElement;
    expect(prev().disabled).toBe(true); // already at the start
    expect(next().disabled).toBe(false);

    fireEvent.click(next());
    expect(onFenChange).toHaveBeenLastCalledWith(expectedFens(['e4'], START_FEN)[1]);
    expect(next().disabled).toBe(true); // end of the line
    expect(prev().disabled).toBe(false);

    fireEvent.click(prev());
    expect(onFenChange).toHaveBeenLastCalledWith(START_FEN);
  });

  it('a token click on a one-element line is reversible via prev (the ply-1 trap)', () => {
    const onStepChange = vi.fn();
    render(<TrainLineStepper moves={['e4']} startFen={START_FEN} onStepChange={onStepChange} />);
    fireEvent.click(screen.getByTestId('train-line-stepper-token-0'));
    expect(onStepChange).toHaveBeenLastCalledWith(expect.objectContaining({ index: 1 }));
    fireEvent.click(screen.getByTestId('btn-train-step-prev'));
    expect(onStepChange).toHaveBeenLastCalledWith(expect.objectContaining({ index: 0 }));
  });

  it('clicking a token derives the same FEN as the equivalent number of successive next presses (array indexing, not a character offset)', () => {
    const onFenChangeViaToken = vi.fn();
    const fens = expectedFens(OPENING_MOVES, START_FEN);
    const { unmount } = render(
      <TrainLineStepper moves={OPENING_MOVES} startFen={START_FEN} onFenChange={onFenChangeViaToken} />,
    );
    onFenChangeViaToken.mockClear();
    // Token at moves-array index 2 ('Nf3', the 3rd move) — clicking it must
    // land on the same position as 3 successive "next" presses.
    fireEvent.click(screen.getByTestId('train-line-stepper-token-2'));
    expect(onFenChangeViaToken).toHaveBeenCalledWith(fens[3]);
    unmount();

    const onFenChangeViaNext = vi.fn();
    render(<TrainLineStepper moves={OPENING_MOVES} startFen={START_FEN} onFenChange={onFenChangeViaNext} />);
    fireEvent.click(screen.getByTestId('btn-train-step-next'));
    fireEvent.click(screen.getByTestId('btn-train-step-next'));
    onFenChangeViaNext.mockClear();
    fireEvent.click(screen.getByTestId('btn-train-step-next'));
    expect(onFenChangeViaNext).toHaveBeenCalledWith(fens[3]);
  });

  it('a re-render with a NEW moves array of identical content keeps the stepped position (190.1 UAT: parent re-renders must not reset the line)', () => {
    // Regression: callers build `moves` inline, so every parent re-render
    // hands in a fresh array identity. Stepping fires onFenChange -> the
    // parent's fen state updates -> the parent re-renders -> before the fix,
    // the identity-keyed reset effect snapped the index (and the board) back
    // to the puzzle position, making every token click appear to do nothing.
    const onFenChange = vi.fn();
    const fens = expectedFens(OPENING_MOVES, START_FEN);
    const { rerender } = render(
      <TrainLineStepper moves={[...OPENING_MOVES]} startFen={START_FEN} onFenChange={onFenChange} />,
    );
    fireEvent.click(screen.getByTestId('train-line-stepper-token-1'));
    expect(onFenChange).toHaveBeenLastCalledWith(fens[2]);

    onFenChange.mockClear();
    rerender(
      <TrainLineStepper moves={[...OPENING_MOVES]} startFen={START_FEN} onFenChange={onFenChange} />,
    );
    // Same content, new identity: no reset back to the start position.
    expect(onFenChange).not.toHaveBeenCalledWith(START_FEN);
    fireEvent.click(screen.getByTestId('btn-train-step-next'));
    expect(onFenChange).toHaveBeenLastCalledWith(fens[3]);
  });

  it('a re-render with genuinely DIFFERENT moves resets to the start of the new line', () => {
    const onFenChange = vi.fn();
    const { rerender } = render(
      <TrainLineStepper moves={OPENING_MOVES} startFen={START_FEN} onFenChange={onFenChange} />,
    );
    fireEvent.click(screen.getByTestId('btn-train-step-next'));
    onFenChange.mockClear();
    rerender(<TrainLineStepper moves={['d4', 'd5']} startFen={START_FEN} onFenChange={onFenChange} />);
    expect(onFenChange).toHaveBeenLastCalledWith(START_FEN);
  });

  it('stepping forward plays the arrived-at move sound (capture/check take precedence over move) and stepping back plays the plain move sound (190.1 UAT round 4)', () => {
    // Scholar's mate: Qxf7# is a capture AND checkmate — check outranks
    // capture, mirroring useBotGame's precedence.
    const line = ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7'];
    render(<TrainLineStepper moves={line} startFen={START_FEN} />);

    fireEvent.click(screen.getByTestId('btn-train-step-next'));
    expect(mockPlaySound).toHaveBeenLastCalledWith('move');

    // Jump straight to the mating move (a capture too — check wins).
    fireEvent.click(screen.getByTestId(`train-line-stepper-token-${line.length - 1}`));
    expect(mockPlaySound).toHaveBeenLastCalledWith('check');

    fireEvent.click(screen.getByTestId('btn-train-step-prev'));
    expect(mockPlaySound).toHaveBeenLastCalledWith('move');
  });

  it('a plain pawn capture plays the capture sound', () => {
    render(<TrainLineStepper moves={['e4', 'd5', 'exd5']} startFen={START_FEN} />);
    fireEvent.click(screen.getByTestId('train-line-stepper-token-2'));
    expect(mockPlaySound).toHaveBeenLastCalledWith('capture');
  });

  it('mounting and a resetNonce reset play no sound (only user steps do)', () => {
    const { rerender } = render(
      <TrainLineStepper moves={OPENING_MOVES} startFen={START_FEN} resetNonce={0} />,
    );
    expect(mockPlaySound).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('btn-train-step-next'));
    mockPlaySound.mockClear();
    rerender(<TrainLineStepper moves={OPENING_MOVES} startFen={START_FEN} resetNonce={1} />);
    expect(mockPlaySound).not.toHaveBeenCalled();
  });

  it('onStepChange reports index, last-move UCI, and next-move UCI at each step (190.1 UAT)', () => {
    const onStepChange = vi.fn();
    const fens = expectedFens(OPENING_MOVES, START_FEN);
    render(
      <TrainLineStepper moves={OPENING_MOVES} startFen={START_FEN} onStepChange={onStepChange} />,
    );
    // Mount report: at the start position, no last move, first move is next.
    expect(onStepChange).toHaveBeenLastCalledWith({
      fen: START_FEN,
      index: 0,
      lastMoveUci: null,
      nextMoveUci: 'e2e4',
      prefixUci: [],
    });
    fireEvent.click(screen.getByTestId('btn-train-step-next'));
    expect(onStepChange).toHaveBeenLastCalledWith({
      fen: fens[1],
      index: 1,
      lastMoveUci: 'e2e4',
      nextMoveUci: 'e7e5',
      prefixUci: [],
    });
    // Jump to the end: the last step has no next move.
    fireEvent.click(screen.getByTestId(`train-line-stepper-token-${OPENING_MOVES.length - 1}`));
    expect(onStepChange).toHaveBeenLastCalledWith({
      fen: fens[OPENING_MOVES.length],
      index: OPENING_MOVES.length,
      lastMoveUci: 'b8c6',
      nextMoveUci: null,
      // Phase 200 (EXPLORE-02): prefixUci is the ordered UCIs BEFORE
      // lastMoveUci — the first 3 of the 4-move OPENING_MOVES line.
      prefixUci: ['e2e4', 'e7e5', 'g1f3'],
    });
  });

  it('Phase 200 (EXPLORE-02): prefixUci has length 0 at stepper index 1, and replaying prefixUci + lastMoveUci from startFen reproduces the reported FEN at every index', () => {
    const onStepChange = vi.fn();
    render(
      <TrainLineStepper moves={OPENING_MOVES} startFen={START_FEN} onStepChange={onStepChange} />,
    );
    for (let i = 0; i < OPENING_MOVES.length; i++) {
      fireEvent.click(screen.getByTestId('btn-train-step-next'));
      const step = onStepChange.mock.calls[onStepChange.mock.calls.length - 1]?.[0] as {
        fen: string;
        index: number;
        lastMoveUci: string | null;
        prefixUci: string[];
      };
      if (step.index === 1) {
        expect(step.prefixUci).toEqual([]);
      }
      // Round-trip invariant (EXPLORE-02's provable seeding): replaying
      // prefixUci then lastMoveUci from startFen must reproduce exactly the
      // reported step.fen — this is what makes exploration's seed correct
      // rather than plausible-looking.
      const chess = new Chess(START_FEN);
      for (const uci of step.prefixUci) {
        chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
      }
      if (step.lastMoveUci !== null) {
        chess.move({
          from: step.lastMoveUci.slice(0, 2),
          to: step.lastMoveUci.slice(2, 4),
          promotion: step.lastMoveUci.slice(4, 5) || undefined,
        });
      }
      expect(chess.fen()).toBe(step.fen);
    }
  });

  it('bumping resetNonce snaps the stepper back to the start position (190.1 UAT Solution button)', () => {
    const onStepChange = vi.fn();
    const { rerender } = render(
      <TrainLineStepper
        moves={OPENING_MOVES}
        startFen={START_FEN}
        resetNonce={0}
        onStepChange={onStepChange}
      />,
    );
    fireEvent.click(screen.getByTestId('btn-train-step-next'));
    fireEvent.click(screen.getByTestId('btn-train-step-next'));
    onStepChange.mockClear();
    rerender(
      <TrainLineStepper
        moves={OPENING_MOVES}
        startFen={START_FEN}
        resetNonce={1}
        onStepChange={onStepChange}
      />,
    );
    expect(onStepChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ fen: START_FEN, index: 0, lastMoveUci: null }),
    );
  });

  it('a long line renders every token inside the height-capped scrolling block, never growing the container past the cap', () => {
    const deepLine = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3'];
    render(<TrainLineStepper moves={deepLine} startFen={START_FEN} />);
    const block = screen.getByTestId('train-line-stepper-moves');
    expect(block.style.maxHeight).toBe(`${TRAIN_LINE_STEPPER_MAX_HEIGHT_PX}px`);
    expect(block.querySelectorAll('button').length).toBe(deepLine.length);
  });
});
