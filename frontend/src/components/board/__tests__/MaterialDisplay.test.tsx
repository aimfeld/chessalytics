// @vitest-environment jsdom
/**
 * MaterialDisplay.test.tsx (Quick 260809-jzz, D-04/D-06) — icon+number
 * rendering per side, mobile-hidden icon group, and the malformed-FEN
 * fail-closed path (T-260809-jzz-01).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MaterialDisplay } from '../MaterialDisplay';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// Black's queen removed — White up a queen (9 points).
const WHITE_UP_QUEEN_FEN = 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// White up a rook, Black up two pawns (D-06: only White carries a number).
const MIXED_IMBALANCE_FEN = '1nbqkbnr/pppppppp/8/8/8/8/PPPPPP2/RNBQKBNR w - - 0 1';
const MALFORMED_FEN = 'not-a-fen-at-all';

describe('MaterialDisplay', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders +9 for White and nothing for Black when White is up a queen', () => {
    render(<MaterialDisplay fen={WHITE_UP_QUEEN_FEN} side="white" />);
    render(<MaterialDisplay fen={WHITE_UP_QUEEN_FEN} side="black" />);
    expect(screen.getByTestId('material-white').textContent).toContain('+9');
    // Black has no surplus at all here — nothing to show, so no DOM node.
    expect(screen.queryByTestId('material-black')).toBeNull();
  });

  it('renders nothing for either side at the starting position', () => {
    render(<MaterialDisplay fen={START_FEN} side="white" />);
    render(<MaterialDisplay fen={START_FEN} side="black" />);
    expect(screen.queryByTestId('material-white')).toBeNull();
    expect(screen.queryByTestId('material-black')).toBeNull();
  });

  it('gives White +3 and Black icons-only (no number) on a mixed imbalance (D-06)', () => {
    render(<MaterialDisplay fen={MIXED_IMBALANCE_FEN} side="white" />);
    render(<MaterialDisplay fen={MIXED_IMBALANCE_FEN} side="black" />);
    expect(screen.getByTestId('material-white').textContent).toContain('+3');
    const blackText = screen.getByTestId('material-black').textContent ?? '';
    expect(blackText).not.toMatch(/\+\d/);
  });

  it('hides the icon group below the sm breakpoint and keeps the number outside it (D-04)', () => {
    render(<MaterialDisplay fen={MIXED_IMBALANCE_FEN} side="white" />);
    const container = screen.getByTestId('material-white');
    const iconGroup = screen.getByTestId('material-white-icons');
    expect(iconGroup.className).toContain('hidden');
    expect(iconGroup.className).toContain('sm:flex');
    expect(iconGroup.textContent).not.toContain('+3');
    expect(container.textContent).toContain('+3');
  });

  it('renders nothing for a malformed FEN without throwing', () => {
    expect(() => render(<MaterialDisplay fen={MALFORMED_FEN} side="white" />)).not.toThrow();
    expect(screen.queryByTestId('material-white')).toBeNull();
  });
});
