// @vitest-environment jsdom
/**
 * FlawChessAgreementVerdict tests (Phase 157-02, REVIEW-02). Mirrors
 * MaiaMoveQualityBar.test.tsx's prose-span fireEvent patterns (no
 * matchMedia/ResizeObserver stubs needed — same simpler setup). Covers the
 * <behavior> cases from 157-02-PLAN.md: D-02/D-03 muted prompt, D-06
 * null-verdict fallback, D-04/D-05/D-07 tier prose, D-09 hover-arrow
 * isolation, D-10 engine-labeled popover (two-line vs omitted-FC-line), and
 * D-11 reveal-then-play.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { FlawChessAgreementVerdict } from '../FlawChessAgreementVerdict';
import type { RankedLine } from '@/lib/engine/types';
import type { PvLine } from '@/hooks/uciParser';
import { FLAWCHESS_ENGINE_ARROW, BEST_MOVE_ARROW } from '@/lib/theme';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Minimal RankedLine fixture, mirroring flawChessVerdict.test.ts's fcLine helper. */
function fcLine(
  rootMove: string,
  objectiveEvalCp: number | null,
  practicalScore = 0.5,
  objectiveEvalMate: number | null = null,
): RankedLine {
  return {
    rootMove,
    practicalScore,
    objectiveEvalCp,
    objectiveEvalMate,
    modalPath: [rootMove],
    modalStats: [{ objectiveEvalCp, objectiveEvalMate, maiaProb: null }],
    visits: 1,
  };
}

/** Minimal PvLine fixture, mirroring flawChessVerdict.test.ts's sfLine helper. */
function sfLine(move: string, evalCp: number | null, evalMate: number | null = null): PvLine {
  return {
    multipv: 1,
    depth: 10,
    moves: [move],
    evalCp,
    evalMate,
  };
}

afterEach(cleanup);

describe('FlawChessAgreementVerdict', () => {
  it('shows the muted prompt (not the classifier) when Stockfish is off (D-02/D-03)', () => {
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30)}
        stockfishLine={sfLine('e2e4', 30)}
        flawChessRankedLines={[fcLine('e2e4', 30)]}
        engineEnabled={false}
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{}}
        shownSans={[]}
      />,
    );
    expect(screen.getByTestId('flawchess-verdict-prompt').textContent).toBe('Turn on Stockfish to compare picks.');
    expect(screen.queryByTestId('flawchess-verdict-sentence')).toBeNull();
    expect(screen.queryByTestId('flawchess-verdict-move-e4')).toBeNull();
  });

  it('falls back to the same muted slot on a partial/null verdict (D-06)', () => {
    render(
      <FlawChessAgreementVerdict
        flawChessLine={null}
        stockfishLine={sfLine('e2e4', 30)}
        flawChessRankedLines={[]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{}}
        shownSans={[]}
      />,
    );
    expect(screen.getByTestId('flawchess-verdict-prompt').textContent).toBe('Turn on Stockfish to compare picks.');
    expect(screen.queryByTestId('flawchess-verdict-sentence')).toBeNull();
  });

  it('renders the aligned tier with a single named move (D-04)', () => {
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30)}
        stockfishLine={sfLine('e2e4', 30)}
        flawChessRankedLines={[fcLine('e2e4', 30)]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{}}
        shownSans={[]}
      />,
    );
    const sentence = screen.getByTestId('flawchess-verdict-sentence').textContent ?? '';
    expect(sentence).toMatch(/FlawChess and Stockfish agree on/);
    expect(sentence).not.toMatch(/best move/i);
    expect(screen.getByTestId('flawchess-verdict-move-e4')).toBeTruthy();
  });

  it('renders the safe-divergence tier naming both picks (D-05/D-07)', () => {
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30)}
        stockfishLine={sfLine('d2d4', 60)}
        flawChessRankedLines={[fcLine('e2e4', 30)]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{}}
        shownSans={[]}
      />,
    );
    const sentence = screen.getByTestId('flawchess-verdict-sentence').textContent ?? '';
    expect(sentence).toMatch(/Objectively/);
    expect(sentence).toMatch(/But for a human at 1500 ELO here, FlawChess plays/);
    expect(sentence).not.toMatch(/best move/i);
    expect(screen.getByTestId('flawchess-verdict-move-e4')).toBeTruthy();
    expect(screen.getByTestId('flawchess-verdict-move-d4')).toBeTruthy();
  });

  it('shows the findability claim when the gate passes (Phase 159 D-10): FC pick clears the margin AND is in the plotted set', () => {
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30)}
        stockfishLine={sfLine('d2d4', 60)}
        flawChessRankedLines={[fcLine('e2e4', 30)]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{ e4: 0.4, d4: 0.1 }}
        shownSans={['e4', 'd4']}
      />,
    );
    const sentence = screen.getByTestId('flawchess-verdict-sentence').textContent ?? '';
    expect(sentence).toMatch(/far easier to find and play/);
  });

  it('shows the D-11 fallback (no findability claim) when the gate fails: FC pick not in the plotted set', () => {
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30)}
        stockfishLine={sfLine('d2d4', 60)}
        flawChessRankedLines={[fcLine('e2e4', 30)]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{ e4: 0.4, d4: 0.1 }}
        shownSans={['d4']}
      />,
    );
    const sentence = screen.getByTestId('flawchess-verdict-sentence').textContent ?? '';
    expect(sentence).not.toMatch(/far easier to find and play/);
    expect(sentence).toMatch(/safer follow-ups/);
  });

  it('shows the D-11 fallback (no findability claim) when the gate fails: margin not exceeded', () => {
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30)}
        stockfishLine={sfLine('d2d4', 60)}
        flawChessRankedLines={[fcLine('e2e4', 30)]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{ e4: 0.12, d4: 0.1 }}
        shownSans={['e4', 'd4']}
      />,
    );
    const sentence = screen.getByTestId('flawchess-verdict-sentence').textContent ?? '';
    expect(sentence).not.toMatch(/far easier to find and play/);
    expect(sentence).toMatch(/safer follow-ups/);
  });

  it('renders the sharp-divergence tier naming both picks (D-05/D-07)', () => {
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 40)}
        stockfishLine={sfLine('g1f3', 300)}
        flawChessRankedLines={[fcLine('e2e4', 40)]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{}}
        shownSans={[]}
      />,
    );
    const sentence = screen.getByTestId('flawchess-verdict-sentence').textContent ?? '';
    expect(sentence).toMatch(/is objectively best/);
    expect(sentence).toMatch(/demands precise follow-ups/);
    expect(sentence).toMatch(/FlawChess expects better practical results from/);
    expect(sentence).not.toMatch(/best move/i);
    expect(screen.getByTestId('flawchess-verdict-move-e4')).toBeTruthy();
    expect(screen.getByTestId('flawchess-verdict-move-Nf3')).toBeTruthy();
  });

  it('renders sentence eval chips player-POV: a black-mover white-POV mate reads "-M4", not the raw "M4" (quick 260709-o72)', () => {
    const BLACK_TO_MOVE_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1';
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e7e5', null, 0.5, 4)}
        stockfishLine={sfLine('e7e5', null, 4)}
        flawChessRankedLines={[fcLine('e7e5', null, 0.5, 4)]}
        engineEnabled
        elo={1500}
        baseFen={BLACK_TO_MOVE_FEN}
        rawProbBySan={{}}
        shownSans={[]}
      />,
    );
    const sentence = screen.getByTestId('flawchess-verdict-sentence').textContent ?? '';
    expect(sentence).toMatch(/-M4/);
    expect(sentence).not.toMatch(/(?<!-)M4/);
  });

  it('isolates the hovered pick\'s board arrow in its tier color, restoring on leave (D-09)', () => {
    const onHover = vi.fn();
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30)}
        stockfishLine={sfLine('d2d4', 60)}
        flawChessRankedLines={[fcLine('e2e4', 30)]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{}}
        shownSans={[]}
        onHoverMovesChange={onHover}
      />,
    );

    const fcMove = screen.getByTestId('flawchess-verdict-move-e4');
    fireEvent.focus(fcMove);
    expect(onHover).toHaveBeenLastCalledWith([{ san: 'e4', color: FLAWCHESS_ENGINE_ARROW }]);
    fireEvent.blur(fcMove);
    expect(onHover).toHaveBeenLastCalledWith(null);

    const sfMove = screen.getByTestId('flawchess-verdict-move-d4');
    fireEvent.focus(sfMove);
    expect(onHover).toHaveBeenLastCalledWith([{ san: 'd4', color: BEST_MOVE_ARROW }]);
    fireEvent.blur(sfMove);
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it('shows all three unified engine-labeled lines in the FlawChess pick\'s popover (D-10 / quick 260708-qrr)', () => {
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30, 0.5)}
        stockfishLine={sfLine('d2d4', 60)}
        flawChessRankedLines={[fcLine('e2e4', 30, 0.5)]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{ e4: 0.82 }}
        shownSans={['e4']}
      />,
    );
    fireEvent.focus(screen.getByTestId('flawchess-verdict-move-e4'));
    const tooltip = screen.getByTestId('flawchess-verdict-tooltip-e4').textContent ?? '';
    expect(tooltip).toMatch(/FlawChess \(practical\)/);
    expect(tooltip).toMatch(/Stockfish \(objective\)/);
    expect(tooltip).toMatch(/Maia \(human\)82%/);
  });

  it('omits the Maia line from the popover when the pick has no Maia probability (quick 260708-qrr)', () => {
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30, 0.5)}
        stockfishLine={sfLine('d2d4', 60)}
        flawChessRankedLines={[fcLine('e2e4', 30, 0.5)]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{}}
        shownSans={[]}
      />,
    );
    fireEvent.focus(screen.getByTestId('flawchess-verdict-move-e4'));
    const tooltip = screen.getByTestId('flawchess-verdict-tooltip-e4').textContent ?? '';
    expect(tooltip).toMatch(/FlawChess \(practical\)/);
    expect(tooltip).toMatch(/Stockfish \(objective\)/);
    expect(tooltip).not.toMatch(/Maia \(human\)/);
  });

  it('omits the FlawChess line from the Stockfish pick\'s popover when not FlawChess-ranked (D-10)', () => {
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30)}
        stockfishLine={sfLine('d2d4', 60)}
        flawChessRankedLines={[fcLine('e2e4', 30)]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{}}
        shownSans={[]}
      />,
    );
    fireEvent.focus(screen.getByTestId('flawchess-verdict-move-d4'));
    const tooltip = screen.getByTestId('flawchess-verdict-tooltip-d4').textContent ?? '';
    expect(tooltip).not.toMatch(/FlawChess \(practical\)/);
    expect(tooltip).toMatch(/Stockfish \(objective\)/);
  });

  it('includes the FlawChess line in the Stockfish pick\'s popover when it WAS FlawChess-ranked (D-10)', () => {
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30)}
        stockfishLine={sfLine('d2d4', 60)}
        flawChessRankedLines={[fcLine('e2e4', 30), fcLine('d2d4', 50, 0.6)]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{}}
        shownSans={[]}
      />,
    );
    fireEvent.focus(screen.getByTestId('flawchess-verdict-move-d4'));
    const tooltip = screen.getByTestId('flawchess-verdict-tooltip-d4').textContent ?? '';
    expect(tooltip).toMatch(/FlawChess \(practical\)/);
    expect(tooltip).toMatch(/Stockfish \(objective\)/);
  });

  it('plays a verdict move as a free move when clicked while its popover is open (D-11)', () => {
    const onPlayMove = vi.fn();
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30)}
        stockfishLine={sfLine('d2d4', 60)}
        flawChessRankedLines={[fcLine('e2e4', 30)]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{}}
        shownSans={[]}
        onPlayMove={onPlayMove}
      />,
    );
    const move = screen.getByTestId('flawchess-verdict-move-e4');
    fireEvent.focus(move); // open it first
    fireEvent.pointerDown(move); // press begins while open
    fireEvent.click(move);
    expect(onPlayMove).toHaveBeenCalledWith('e4');
  });

  it('the first interaction reveals a verdict move without playing it (D-11)', () => {
    const onPlayMove = vi.fn();
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30)}
        stockfishLine={sfLine('d2d4', 60)}
        flawChessRankedLines={[fcLine('e2e4', 30)]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{}}
        shownSans={[]}
        onPlayMove={onPlayMove}
      />,
    );
    const move = screen.getByTestId('flawchess-verdict-move-e4');
    fireEvent.pointerDown(move); // press begins closed
    fireEvent.click(move);
    expect(onPlayMove).not.toHaveBeenCalled();
    expect(screen.getByTestId('flawchess-verdict-tooltip-e4')).toBeTruthy();
  });

  // ─── Phase 196 (INJECT-06): component-level proof — the lookup is a plain
  // `rootMove` find over whatever array it is handed, with no hidden top-N
  // assumption, no score comparison, and no provenance distinction. ─────────

  it('renders the FlawChess practical line for a Stockfish pick placed at index 3 of a 5-entry flawChessRankedLines (out-of-top-2 shape, INJECT-06)', () => {
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30)}
        stockfishLine={sfLine('d2d4', 60)}
        flawChessRankedLines={[
          fcLine('e2e4', 30),
          fcLine('c2c4', 20),
          fcLine('g1f3', 10),
          fcLine('d2d4', 50, 0.6), // Stockfish's pick — array index 3 (4th entry)
          fcLine('b2b3', 5),
        ]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{}}
        shownSans={[]}
      />,
    );
    // Guard against a vacuous pass: a null verdict never renders the popover at all.
    expect(screen.getByTestId('flawchess-verdict-sentence')).toBeTruthy();
    fireEvent.focus(screen.getByTestId('flawchess-verdict-move-d4'));
    const tooltip = screen.getByTestId('flawchess-verdict-tooltip-d4').textContent ?? '';
    expect(tooltip).toMatch(/FlawChess \(practical\)/);
  });

  it("renders the practical line even when the Stockfish pick's practicalScore exactly ties the top organic line's (lookup is by rootMove, never a score comparison)", () => {
    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30, 0.5)}
        stockfishLine={sfLine('d2d4', 60)}
        flawChessRankedLines={[
          fcLine('e2e4', 30, 0.5), // top organic line's practicalScore
          fcLine('c2c4', 20, 0.4),
          fcLine('g1f3', 10, 0.3),
          fcLine('d2d4', 50, 0.5), // Stockfish's pick — EXACT tie with the top line's practicalScore
          fcLine('b2b3', 5, 0.2),
        ]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{}}
        shownSans={[]}
      />,
    );
    expect(screen.getByTestId('flawchess-verdict-sentence')).toBeTruthy();
    fireEvent.focus(screen.getByTestId('flawchess-verdict-move-d4'));
    const tooltip = screen.getByTestId('flawchess-verdict-tooltip-d4').textContent ?? '';
    expect(tooltip).toMatch(/FlawChess \(practical\)/);
  });

  it('renders identical tooltip text regardless of the Stockfish pick\'s array position in flawChessRankedLines (no provenance distinction, D-01/D-02)', () => {
    const sfPickLine = fcLine('d2d4', 50, 0.6);
    const other0 = fcLine('e2e4', 30);
    const other1 = fcLine('c2c4', 20);
    const other2 = fcLine('g1f3', 10);
    const other3 = fcLine('b2b3', 5);

    const { unmount } = render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30)}
        stockfishLine={sfLine('d2d4', 60)}
        flawChessRankedLines={[other0, sfPickLine, other1, other2, other3]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{}}
        shownSans={[]}
      />,
    );
    expect(screen.getByTestId('flawchess-verdict-sentence')).toBeTruthy();
    fireEvent.focus(screen.getByTestId('flawchess-verdict-move-d4'));
    const textAtIndex1 = screen.getByTestId('flawchess-verdict-tooltip-d4').textContent ?? '';
    unmount();

    render(
      <FlawChessAgreementVerdict
        flawChessLine={fcLine('e2e4', 30)}
        stockfishLine={sfLine('d2d4', 60)}
        flawChessRankedLines={[other0, other1, other2, other3, sfPickLine]}
        engineEnabled
        elo={1500}
        baseFen={START_FEN}
        rawProbBySan={{}}
        shownSans={[]}
      />,
    );
    expect(screen.getByTestId('flawchess-verdict-sentence')).toBeTruthy();
    fireEvent.focus(screen.getByTestId('flawchess-verdict-move-d4'));
    const textAtIndex4 = screen.getByTestId('flawchess-verdict-tooltip-d4').textContent ?? '';

    expect(textAtIndex4).toBe(textAtIndex1);
  });
});
