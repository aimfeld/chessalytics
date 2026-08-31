// @vitest-environment jsdom
/**
 * MoveStats vitest suite (Phase 179 Plan 02, SEED-112) — covers D-01 (accuracy
 * strip canonical-or-muted), D-03 (all 7 rows always render), D-05 (counts
 * derive from flaw_markers/eval_series), D-08 (opponent tiers surfaced), and
 * the player-first column reorder.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MoveStats } from '../MoveStats';
import type { EvalPoint, FlawMarker, GameFlawCard } from '@/types/library';

afterEach(() => {
  cleanup();
});

const GAME_ID = 123;

function makeGame(overrides: Partial<GameFlawCard> = {}): GameFlawCard {
  return {
    game_id: GAME_ID,
    user_result: 'win',
    played_at: '2026-01-15T10:00:00Z',
    time_control_bucket: 'rapid',
    platform: 'lichess',
    platform_url: 'https://lichess.org/abc',
    white_username: 'Alice',
    black_username: 'Bob',
    white_rating: 1850,
    black_rating: 1720,
    opening_name: 'Sicilian Defense',
    opening_eco: 'B20',
    user_color: 'white',
    ply_count: 80,
    termination: 'checkmate',
    time_control_str: '10+5',
    result_fen: null,
    severity_counts: { inaccuracy: 0, mistake: 0, blunder: 0 },
    white_accuracy: null,
    black_accuracy: null,
    chips: [],
    analysis_state: 'analyzed',
    eval_series: [],
    flaw_markers: [],
    phase_transitions: { middlegame_ply: null, endgame_ply: null },
    moves: [],
    active_eval_status: null,
    opening_ply_count: 0,
    ...overrides,
  };
}

function marker(overrides: Partial<FlawMarker> & Pick<FlawMarker, 'ply' | 'severity'>): FlawMarker {
  return {
    tags: [],
    is_user: false,
    move_san: null,
    allowed_tactic_motif: null,
    allowed_tactic_confidence: null,
    allowed_tactic_depth: null,
    missed_tactic_motif: null,
    missed_tactic_confidence: null,
    missed_tactic_depth: null,
    ...overrides,
  };
}

function point(overrides: Partial<EvalPoint> & Pick<EvalPoint, 'ply'>): EvalPoint {
  return {
    es: null,
    eval_cp: null,
    eval_mate: null,
    clock_seconds: null,
    move_seconds: null,
    best_move: null,
    best_move_tier: null,
    maia_prob: null,
    ...overrides,
  };
}

const ALL_CATEGORIES = ['gem', 'great', 'best', 'good', 'inaccuracy', 'mistake', 'blunder'] as const;

describe('MoveStats — D-03 all 7 rows always render', () => {
  it('renders exactly 7 category rows with muted 0s for an all-zero analyzed game', () => {
    render(<MoveStats game={makeGame()} />);
    for (const category of ALL_CATEGORIES) {
      expect(screen.getByTestId(`move-stats-row-${category}`)).toBeTruthy();
      const white = screen.getByTestId(`move-stats-cell-${category}-white`);
      const black = screen.getByTestId(`move-stats-cell-${category}-black`);
      expect(white.textContent).toBe('0');
      expect(black.textContent).toBe('0');
      // Zero cells are inert — no button role, no interactive tag.
      expect(white.tagName).not.toBe('BUTTON');
      expect(black.tagName).not.toBe('BUTTON');
    }
  });
});

describe('MoveStats — D-01/D-02 accuracy strip', () => {
  it('renders a numeric white cell and a muted em-dash black cell when black_accuracy is null', () => {
    render(<MoveStats game={makeGame({ white_accuracy: 87.4, black_accuracy: null })} />);
    const white = screen.getByTestId('move-stats-accuracy-white');
    const black = screen.getByTestId('move-stats-accuracy-black');
    // Pills carry a leading color swatch span (aria-hidden, no text content).
    expect(white.textContent).toBe('87%');
    expect(black.textContent).toBe('—');
  });

  it('never renders an ACPL value or literal "_imported" text', () => {
    const { container } = render(
      <MoveStats game={makeGame({ white_accuracy: 92, black_accuracy: 88 })} />,
    );
    expect(container.textContent).not.toContain('ACPL');
    expect(container.textContent).not.toContain('imported');
  });
});

describe('MoveStats — D-05/D-09 non-zero cell interaction', () => {
  it('dispatches { kind: "category", category, side } on click for a non-zero cell', () => {
    const onCellActivate = vi.fn();
    const game = makeGame({
      flaw_markers: [marker({ ply: 0, severity: 'blunder', is_user: true })],
    });
    render(<MoveStats game={game} onCellActivate={onCellActivate} />);
    const cell = screen.getByTestId('move-stats-cell-blunder-white');
    expect(cell.tagName).toBe('BUTTON');
    fireEvent.click(cell);
    expect(onCellActivate).toHaveBeenCalledWith({ kind: 'category', category: 'blunder', side: 'white' });
  });

  it('reads inaccuracy count from flaw_markers, not severity_counts', () => {
    const game = makeGame({
      severity_counts: { inaccuracy: 99, mistake: 0, blunder: 0 },
      flaw_markers: [marker({ ply: 0, severity: 'inaccuracy' })],
    });
    render(<MoveStats game={game} />);
    // flaw_markers has exactly 1 inaccuracy on ply 0 (white) — must read 1, not 99.
    expect(screen.getByTestId('move-stats-cell-inaccuracy-white').textContent).toBe('1');
  });
});

describe('MoveStats — D-08 opponent positive tiers surfaced', () => {
  it('shows an opponent-ply gem in the opponent column', () => {
    // user_color=white, so ply 1 (odd=black) is the opponent.
    const game = makeGame({
      user_color: 'white',
      eval_series: [point({ ply: 1, best_move_tier: 'gem' })],
    });
    render(<MoveStats game={game} />);
    expect(screen.getByTestId('move-stats-cell-gem-black').textContent).toBe('1');
    expect(screen.getByTestId('move-stats-cell-gem-white').textContent).toBe('0');
  });
});

describe('MoveStats — player-first column order', () => {
  it('flips column order with game.user_color while cell background stays literal-color', () => {
    const whiteUserGame = makeGame({ user_color: 'white' });
    const { container: c1 } = render(<MoveStats game={whiteUserGame} />);
    // children[0] is the "Accuracies" label; the player pill comes right after.
    const strip1 = c1.querySelector('[data-testid="move-stats-accuracy-strip"]');
    expect(strip1?.children[1]?.getAttribute('data-testid')).toBe('move-stats-accuracy-white');
    cleanup();

    const blackUserGame = makeGame({ user_color: 'black' });
    const { container: c2 } = render(<MoveStats game={blackUserGame} />);
    const strip2 = c2.querySelector('[data-testid="move-stats-accuracy-strip"]');
    expect(strip2?.children[1]?.getAttribute('data-testid')).toBe('move-stats-accuracy-black');

    // Literal color background is unchanged regardless of column order.
    const whiteCell = screen.getByTestId('move-stats-accuracy-white');
    expect((whiteCell as HTMLElement).style.backgroundColor).not.toBe('');
  });
});

describe('MoveStats — Best/Good rows render the new circular icons', () => {
  it('renders BestMoveIcon and GoodMoveIcon svg titles in their respective rows', () => {
    render(<MoveStats game={makeGame()} />);
    const bestRow = screen.getByTestId('move-stats-row-best');
    const goodRow = screen.getByTestId('move-stats-row-good');
    expect(bestRow.querySelector('title')?.textContent).toBe('Best move');
    expect(goodRow.querySelector('title')?.textContent).toBe('Good move');
  });
});
